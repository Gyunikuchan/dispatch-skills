import fs from "node:fs";
import path from "node:path";

import type { ConfirmationRound } from "./confirmations.ts";
import type { SlotOutcome } from "./fanout.ts";
import type { Fold } from "./ledger.ts";
import { present } from "./narrow.ts";
import { ToolError } from "./output.ts";
import { coverageDecision } from "./records.ts";
import {
  readStoredJson,
  reviewDirectory,
  reviewRoundFile,
  reviewFindingsFile,
  reviewGenerationDirectory,
  reviewSlotFile,
  reviewRoundEntries,
} from "./review-state.ts";

export type CoverageDecision = "none" | "rerun" | "majority" | "user";

export interface CoverageState {
  targets: string[];
  completed: string[];
  open: string[];
  overridden: { slot: string; quote: string; seq: number }[];
  coverageRounds: number[];
  freeUsed: boolean;
  unusedGrant: boolean;
  incomplete: number | null;
  decision: CoverageDecision;
}

export type CoverageApplies = (
  metadata: ConfirmationRound["metadata"]
) => boolean;

type Metadata = ConfirmationRound["metadata"] & {
  scope?: string;
  coverage?: "open" | "full";
  coverageUse?: "free" | "grant";
};

interface Attempt {
  slot: string;
  seq: number;
  wholeTarget: boolean;
}

interface Tracked {
  complete: boolean;
  failures: { seq: number; whole: boolean }[];
  last: number;
}

const numbered = (names: string[], pattern: RegExp) =>
  names
    .filter((name) => pattern.test(name))
    .toSorted(
      (a, b) =>
        Number(a.replaceAll(/\D/gu, "")) - Number(b.replaceAll(/\D/gu, ""))
    );

/**
 * Folds saved round files and user records into per-slot coverage. Failures come from every generation's attempts.json;
 * completions come from the current generation of a finalized round. It writes nothing; unreadable files fail closed.
 */
export const coverageState = (
  session: string,
  fold: Fold,
  review: string,
  applies: CoverageApplies = () => true
) => {
  const root = reviewDirectory(session, review);

  const unreadable = (file: string): never => {
    throw new ToolError(
      4,
      "coverage-required",
      `Cannot establish coverage for ${review}: ${path.relative(root, file)}`
    );
  };

  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- callers instantiate T explicitly (load<Metadata>); the parameter forwards to the typed boundary reader.
  const load = <T>(file: string) => {
    try {
      return readStoredJson<T>(file);
    } catch {
      return unreadable(file);
    }
  };

  const rounds = reviewRoundEntries(
    fs.existsSync(root) ? fs.readdirSync(root) : []
  ).flatMap(({ name, number }) => {
    const dir = path.join(root, name);
    const metadata = load<Metadata>(reviewRoundFile(dir));

    if (!metadata) {
      return [];
    }

    if (
      metadata.spec?.path === undefined ||
      metadata.spec?.path === "" ||
      metadata.target === "" ||
      !Array.isArray(metadata.roster) ||
      !Number.isSafeInteger(metadata.generation)
    ) {
      unreadable(reviewRoundFile(dir));
    }

    if (!applies(metadata)) {
      return [];
    }

    const attempts = numbered(fs.readdirSync(dir), /^gen-\d+$/u).flatMap(
      (gen) => {
        const list =
          load<Attempt[]>(path.join(dir, gen, "attempts.json")) ?? [];

        if (
          !Array.isArray(list) ||
          list.some(
            (item) =>
              typeof item?.slot !== "string" ||
              !Number.isSafeInteger(item.seq) ||
              typeof item.wholeTarget !== "boolean"
          )
        ) {
          unreadable(path.join(dir, gen, "attempts.json"));
        }

        return list.map((item) => ({ ...item, gen }));
      }
    );

    const slots = metadata.roster
      .filter((slot) => !slot.reserve)
      .map((slot) => slot.slot);

    const saved = slots.map(
      (slot) =>
        [
          slot,
          load<SlotOutcome>(
            reviewSlotFile(
              reviewGenerationDirectory(dir, metadata.generation),
              slot
            )
          ),
        ] as const
    );

    for (const [slot, outcome] of saved) {
      if (
        outcome?.state === "failed" &&
        !attempts.some(
          (item) =>
            item.slot === slot && item.gen === `gen-${metadata.generation}`
        )
      ) {
        unreadable(
          reviewSlotFile(
            reviewGenerationDirectory(dir, metadata.generation),
            slot
          )
        );
      }
    }

    return [
      {
        number,
        metadata,
        slots,
        attempts,
        saved,
        finalized: fs.existsSync(reviewFindingsFile(dir)),
        whole:
          (metadata.scope?.startsWith("Full review") ?? false) ||
          metadata.coverage !== undefined,
        allFailed:
          saved.length > 0 &&
          saved.every(([, outcome]) => outcome?.state === "failed"),
      },
    ];
  });

  const targets = [...new Set(rounds.flatMap((round) => round.slots))];
  const tracked = new Map<string, Tracked>();

  const slotOf = (slot: string) => {
    const found = tracked.get(slot);

    if (found) {
      return found;
    }

    const created: Tracked = { complete: false, failures: [], last: -1 };
    tracked.set(slot, created);

    return created;
  };

  for (const round of rounds) {
    for (const item of round.attempts) {
      Object.assign(slotOf(item.slot), {
        complete: false,
        failures: [
          ...slotOf(item.slot).failures,
          { seq: item.seq, whole: item.wholeTarget },
        ],
        last: Math.max(slotOf(item.slot).last, item.seq),
      });
    }

    if (round.finalized && round.whole) {
      for (const [slot, outcome] of round.saved) {
        if (outcome?.state === "done") {
          Object.assign(slotOf(slot), { complete: true, failures: [] });
        }
      }
    }
  }

  const decisions = fold.records
    .filter(
      (row) =>
        row.kind === "escalation" &&
        row.by === "user" &&
        row.data["state"] === "resolved" &&
        row.quote !== undefined &&
        row.quote.trim() !== "" &&
        // oxlint-disable-next-line typescript/no-base-to-string -- escalation ids are JSON scalars; String() renders their text identically.
        String(row.data["id"]).startsWith(`coverage:${review}:`)
    )
    .map((row) => ({ row, decision: coverageDecision(row.data["summary"]) }));

  const open: string[] = [];
  const overridden: CoverageState["overridden"] = [];

  for (const slot of targets) {
    const item = slotOf(slot);

    if (!item.failures.length) {
      continue;
    }

    const cover = decisions.findLast(
      ({ row, decision }) =>
        row.seq > item.last &&
        !!decision &&
        "accept" in decision &&
        decision.accept.includes(slot)
    );

    if (cover) {
      overridden.push({
        slot,
        quote: present(cover.row.quote, "override quote"),
        seq: cover.row.seq,
      });
    } else {
      open.push(slot);
    }
  }

  const latest = rounds.at(-1);

  const incomplete =
    latest && !latest.finalized && !latest.allFailed ? latest.number : null;

  const completed = targets.filter((slot) => slotOf(slot).complete);

  const rerun = (slot: string) =>
    slotOf(slot)
      .failures.slice(1)
      .some((failure) => failure.whole);

  let decision: CoverageDecision = "rerun";

  if (incomplete === null) {
    if (open.length === 0) {
      decision = "none";
    } else if (open.every(rerun)) {
      decision = completed.length * 2 > targets.length ? "majority" : "user";
    }
  }

  return {
    targets,
    completed,
    open,
    overridden,
    coverageRounds: rounds
      .filter((round) => round.metadata.coverage !== undefined)
      .map((round) => round.number),
    decision,
    incomplete,
    freeUsed: rounds.some(
      (round) =>
        round.metadata.coverageUse === "free" && round.number !== incomplete
    ),
    unusedGrant:
      decisions.filter(
        ({ decision: outcome }) => !!outcome && "grant" in outcome
      ).length >
      rounds.filter((round) => round.metadata.coverageUse === "grant").length,
  };
};
