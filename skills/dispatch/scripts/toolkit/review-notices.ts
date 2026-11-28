import fs from "node:fs";

import type { RosterSlot, StepBack } from "./domain/types.ts";
import type { BlockedAttempt, SlotOutcome } from "./fanout.ts";
import { present } from "./narrow.ts";
import { clipBytes } from "./output.ts";
import type { LedgerRecord } from "./records.ts";
import {
  readStoredJson,
  reviewRoundDirectory,
  reviewRoundFile,
  reviewFindingsFile,
  reviewGenerationDirectory,
  reviewRoundEntries,
  reviewSlotFile,
} from "./review-state.ts";

type BlockedEntry = { slot: string } & BlockedAttempt;

interface BlockerEntry {
  slot: string;
  reason: string;
  rounds: [number, number];
}

export interface BlockedState {
  blocked: BlockedEntry[];
  blockers: BlockerEntry[];
}

// Leaves the summary room for counts and at least one finding.
const BLOCKED_NOTICE_BYTES = 400;

/** Blocked attempts of one round, read from its current generation so a resumed pending run keeps them. */
const blockedEntries = (directory: string, number: number) => {
  const root = reviewRoundDirectory(directory, number);

  const metadata = readStoredJson<{
    generation: number;
    roster: RosterSlot[];
  }>(reviewRoundFile(root));

  if (!metadata) {
    return [];
  }

  const generation = reviewGenerationDirectory(root, metadata.generation);

  return metadata.roster.flatMap((slot) =>
    (
      readStoredJson<SlotOutcome>(reviewSlotFile(generation, slot.slot))
        ?.blocked ?? []
    ).map((entry) => ({
      slot: slot.slot,
      ...entry,
    }))
  );
};

/** Same slot and reason identity in the nearest earlier round that has findings; a narrowed slot has no partner. */
const blockersFor = (
  directory: string,
  number: number,
  blocked: readonly BlockedEntry[]
) => {
  const previous = reviewRoundEntries(fs.readdirSync(directory)).findLast(
    ({ number: candidate }) =>
      candidate < number &&
      fs.existsSync(
        reviewFindingsFile(reviewRoundDirectory(directory, candidate))
      )
  )?.number;

  if (previous === undefined) {
    return [];
  }

  const prior = new Set(
    blockedEntries(directory, previous).map(
      (entry) => `${entry.slot}\0${entry.reasonHash}`
    )
  );

  const seen = new Set<string>();
  const blockers: BlockerEntry[] = [];

  for (const entry of blocked) {
    const key = `${entry.slot}\0${entry.reasonHash}`;

    if (!prior.has(key) || seen.has(key)) {
      continue;
    }

    seen.add(key);
    blockers.push({
      slot: entry.slot,
      reason: entry.reason,
      rounds: [previous, number],
    });
  }

  return blockers;
};

/** Blockers first, then blocked attempts, within the summary budget; the result keeps every entry. */
export const blockedNotice = (
  blocked: readonly BlockedEntry[],
  blockers: readonly BlockerEntry[]
) => {
  const items = [
    ...blockers.map(
      (entry) =>
        `orchestrator blocker ${entry.slot}: ${entry.reason} (rounds ${entry.rounds[0]}-${entry.rounds[1]})`
    ),
    ...blocked.map((entry) => `blocked ${entry.slot}: ${entry.reason}`),
  ];

  const reserve = Buffer.byteLength(`; +${items.length} more blocked`, "utf-8");
  const shown: string[] = [];

  let bytes = 0;

  for (const item of items) {
    const text = clipBytes(item, 160);
    const size = Buffer.byteLength(text, "utf-8") + 2;

    if (shown.length && bytes + size + reserve > BLOCKED_NOTICE_BYTES) {
      break;
    }

    shown.push(text);
    bytes += size;
  }

  const omitted = items.length - shown.length;

  return shown.join("; ") + (omitted ? `; +${omitted} more blocked` : "");
};

const listed = (all: readonly string[], shown: number, pointer: string) =>
  all.slice(0, shown).join(", ") +
  (shown === all.length
    ? ""
    : `${shown ? ", " : ""}+${all.length - shown} more in findings.json ${pointer}`);

// Drops names until the text fits `room`; the text at zero names stays.
const fitNames = (
  count: number,
  text: (shown: number) => string,
  room: number
) => {
  let shown = count;

  while (shown > 0 && Buffer.byteLength(text(shown), "utf-8") > room) {
    shown -= 1;
  }

  return text(shown);
};

// NOTE: names take only the bytes the rest of the head leaves; the counts, the `step-back due` words and the pointers stay even when the suffixes overflow, so the CLI cap cuts the suffixes first.
export const hotUnitsNotice = (
  units: readonly {
    unit: string;
    hot: boolean;
    hotStreak: number;
    delta?: number;
  }[],
  restBytes: number,
  stepBack?: StepBack
) => {
  const hot = units.filter((unit) => unit.hot);

  const names = hot.map(
    (unit) =>
      `${clipBytes(unit.unit, 40)} ×${unit.hotStreak}${
        unit.delta === undefined
          ? ""
          : ` ${unit.delta < 0 ? "-" : "+"}${Math.abs(unit.delta)} B`
      }`
  );

  const dueNames = (stepBack?.units ?? []).map((unit) => clipBytes(unit, 40));

  const hotText = (shown: number) =>
    `; ${hot.length} hot unit${hot.length === 1 ? "" : "s"}: ${listed(names, shown, "units")}`;

  const dueText = (shown: number) =>
    `; step-back due: ${[
      ...(dueNames.length ? [listed(dueNames, shown, "stepBack")] : []),
      ...(stepBack?.fixInduced
        ? [`fix-induced ${stepBack.fixInduced[0]} of ${stepBack.fixInduced[1]}`]
        : []),
    ].join("; ")}`;

  const room = 1024 - restBytes;
  // The hot-unit list yields to the clause: reserve the clause at its shortest.
  const hotRoom = stepBack ? room - Buffer.byteLength(dueText(0)) : room;
  const hotPart = hot.length ? fitNames(names.length, hotText, hotRoom) : "";

  return (
    hotPart +
    (stepBack
      ? fitNames(
          dueNames.length,
          dueText,
          room - Buffer.byteLength(hotPart, "utf-8")
        )
      : "")
  );
};

// Ids are `<kind>:<review>:<tail>`; only a later open record of the same id reopens a decision, so tool resolutions neither list nor remove one.
export const userDecisions = (
  records: readonly LedgerRecord[],
  review: string,
  startSeq: number
) => {
  const ofReview = records.filter(
    (row) =>
      row.kind === "escalation" &&
      row.seq <= startSeq &&
      // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
      String(row.data["id"]).split(":")[1] === review
  );

  // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
  return [...new Set(ofReview.map((row) => String(row.data["id"])))].flatMap(
    (id) => {
      // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
      const rows = ofReview.filter((row) => String(row.data["id"]) === id);

      const decision = rows.findLast(
        (row) =>
          row.by === "user" &&
          row.data["state"] === "resolved" &&
          row.quote?.trim() !== undefined &&
          row.quote.trim() !== ""
      );

      if (
        !decision ||
        rows.some(
          (row) => row.seq > decision.seq && row.data["state"] === "open"
        )
      ) {
        return [];
      }

      return [
        {
          id,
          // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
          summary: String(decision.data["summary"]),
          quote: present(decision.quote, "the user quote"),
        },
      ];
    }
  );
};

export const blockedStateFor = (directory: string, number: number) => {
  const blocked = blockedEntries(directory, number);

  return { blocked, blockers: blockersFor(directory, number, blocked) };
};
