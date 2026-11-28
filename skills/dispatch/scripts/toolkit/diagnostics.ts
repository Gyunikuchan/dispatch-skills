import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isRecord } from "../lib/config.ts";
import type { JsonObject, JsonValue } from "../lib/config.ts";
import { nodeErrorCode, stripBom } from "../lib/fs-ext.ts";
import type { ProviderKey } from "../lib/platform.ts";
import { loadPricing } from "../lib/pricing.ts";
import type { Pricer } from "../lib/pricing.ts";
import { readHostUsage, nodeHostUsageFs } from "../lib/usage/index.ts";
import { readErrorReason } from "../lib/usage/read.ts";
import type {
  HostUsageFacts,
  Milestone,
  PhaseMilestone,
} from "../lib/usage/rows.ts";
import type { CliDeps, HandlerContext } from "./cli.ts";
import {
  CAPTURE_FAILURE_SUFFIX,
  captureDirectory,
  diagnosticSubject,
  diagnosticsEnabled,
  hostThreadId,
} from "./diagnostics-capture.ts";
import { recoveryRef } from "./domain/diagnostics-gates.ts";
import { completeDelegateResponses } from "./domain/diagnostics-types.ts";
import {
  addYield,
  billedTokens,
  renderDiagnostics,
  retroObservations,
  sanitizeFacts,
} from "./domain/diagnostics.ts";
import type {
  InvocationFacts,
  RoundWorkload,
  RunFacts,
  SlotYieldFacts,
} from "./domain/diagnostics.ts";
import { stableValue } from "./domain/stable-value.ts";
import { ROUND_CAUSES } from "./domain/types.ts";
import { foldLedger, latest } from "./ledger.ts";
import type { Fold } from "./ledger.ts";
import { present } from "./narrow.ts";
import { ToolError } from "./output.ts";
import {
  reviewDirectory,
  reviewFindingsFile,
  reviewGenerationDirectory,
  reviewRoot,
  reviewRoundDirectory,
  reviewRoundFile,
} from "./review-state.ts";
import {
  entriesOrEmpty,
  readReviewJson,
  reviewDirectories,
  reviewSlotEntries,
  reviewSlotsDirectory,
} from "./review-storage.ts";
import type {
  FindingsFile,
  ReviewRound,
  RoundFile,
  SlotOutcome,
} from "./review-storage.ts";
import { launches } from "./writers.ts";

// oxlint-disable-next-line eslint/complexity -- responder/model fallback chain spans slot state, roster entry, and configured model.
const invocation = (round: ReviewRound, slot: SlotOutcome) => {
  const target = round.roster.find((row) => row.slot === slot.slot);

  let responder:
    | NonNullable<Extract<SlotOutcome, { state: "done" }>["responder"]>
    | {
        provider: string;
        model: string | null;
        native: true;
        effort?: string;
      }
    | undefined;

  if (slot.state === "done") {
    ({ responder } = slot);
  } else if (
    slot.state === "native" &&
    slot.provider !== undefined &&
    slot.provider !== ""
  ) {
    const nativeModel =
      typeof slot.model === "string" ? slot.model : (slot.model?.[0] ?? null);

    responder = {
      provider: slot.provider,
      model: nativeModel,
      native: true,
      ...(slot.effort !== undefined && { effort: slot.effort }),
    };
  } else {
    responder = undefined;
  }

  const provider = responder?.provider ?? target?.provider ?? "unavailable";
  const responderModel = responder?.model;
  const configured = target?.model;

  const primary: unknown = Array.isArray(configured)
    ? configured[0]
    : configured;

  const targetModel = typeof primary === "string" ? primary : "unavailable";

  // A recorded responder names its own model: a null model means the reserve
  // ran unconfigured, never the logical target's model. The target fallback
  // applies only when no responder data exists.
  let model = targetModel;

  if (responder) {
    model =
      typeof responderModel === "string" && responderModel.trim()
        ? responderModel
        : "unavailable";
  }

  let surface: "native" | "cli";

  if (slot.state === "done") {
    if (responder) {
      surface = responder.native ? "native" : "cli";
    } else {
      surface = target?.native === true ? "native" : "cli";
    }
  } else if (slot.state === "native" || target?.native === true) {
    surface = "native";
  } else {
    surface = "cli";
  }

  const base = {
    phase: round.review,
    provider,
    model,
    launched: false,
    surface,
    slot: slot.slot,
    ...(surface === "native" &&
      responder?.effort !== undefined && { effort: responder.effort }),
  };

  if (slot.state === "done") {
    return { ...base, outcome: "ok" };
  }

  if (slot.state === "native") {
    return { ...base, outcome: "native-pending" };
  }

  return {
    ...base,
    outcome: typeof slot.cls === "string" ? slot.cls : "unknown",
  };
};

const reviewFacts = (round: ReviewRound, fold: Fold) => {
  const findings = round.findings?.findings;

  if (!findings) {
    return null;
  }

  let accepted = 0;
  let rejected = 0;
  const reraised = new Set<string>();
  let recurring = 0;

  for (const finding of findings) {
    const ruling = fold.records.findLast(
      (record) =>
        record.kind === "ruling" &&
        record.data["subject"] === `review:${round.review}:${finding.id}`
    );

    if (ruling?.data["ruling"] === "accepted") {
      accepted += 1;
    }

    if (ruling?.data["ruling"] === "rejected") {
      rejected += 1;
    }

    if (finding.recurrence || finding.unresolved) {
      recurring += 1;
    }

    if (typeof finding.recurrence?.of === "string") {
      reraised.add(finding.recurrence.of);
    }

    if (typeof finding.unresolved?.of === "string") {
      reraised.add(finding.unresolved.of);
    }
  }

  const cause = ROUND_CAUSES.find(
    (primary) => primary === round.findings?.cause?.primary
  );

  return {
    phase: round.review,
    round: round.round,
    cap: round.cap,
    accepted,
    rejected,
    recurring,
    ...(reraised.size && { reraised: [...reraised] }),
    ...(cause && { cause }),
  };
};

/** A round plus every generation directory, so superseded invocations still map to their review. */
type YieldRound = ReviewRound & {
  generations: { generation: number; subject: string }[];
};

const emptyRaised = () => ({ MUST: 0, SHOULD: 0, CONSIDER: 0 });

/** Per-responder yield from current-generation findings, rulings and slot token cost. */
// oxlint-disable-next-line eslint/complexity -- yield fold branches per ruling value, generation subject, and slot/roster match.
const slotYieldFacts = (
  rounds: readonly YieldRound[],
  invocations: readonly InvocationFacts[],
  fold: Fold
) => {
  const rows = new Map<string, SlotYieldFacts>();

  const add = (value: SlotYieldFacts) => {
    const key = [value.kind, value.provider, value.model ?? ""].join("\0");
    const current = rows.get(key);

    if (!current) {
      rows.set(key, value);

      return;
    }

    addYield(current, value);
  };

  const tally = (
    target: {
      accepted: number;
      rejected: number;
      deferred: number;
      duplicate: number;
      unruled: number;
    },
    subject: string
  ) => {
    const value: unknown = fold.records.findLast(
      (record) => record.kind === "ruling" && record.data["subject"] === subject
    )?.data["ruling"];

    if (value === "accepted") {
      target.accepted += 1;
    } else if (value === "rejected") {
      target.rejected += 1;
    } else if (value === "deferred") {
      target.deferred += 1;
    } else if (value === "duplicate") {
      target.duplicate += 1;
    } else {
      target.unruled += 1;
    }
  };

  const tool = {
    raised: emptyRaised(),
    accepted: 0,
    rejected: 0,
    deferred: 0,
    duplicate: 0,
    unruled: 0,
  };

  for (const round of rounds) {
    const current = round.generations.find(
      (entry) => entry.generation === round.generation
    )?.subject;

    const slots = new Map(round.slots.map((slot) => [slot.slot, slot]));
    // NOTE: a reserve logs its own slot but serves its target slot; map per invocation.
    const logical = new Map<string, InvocationFacts[]>();

    for (const row of invocations) {
      if (!round.generations.some((entry) => entry.subject === row.subject)) {
        continue;
      }

      const target = row.targetSlot ?? row.slot;

      if (target !== undefined && target !== "") {
        logical.set(target, [...(logical.get(target) ?? []), row]);
      }
    }

    for (const source of new Set([...slots.keys(), ...logical.keys()])) {
      const outcome = slots.get(source);
      const roster = round.roster.find((slot) => slot.slot === source);

      const attempts = logical.get(source) ?? [];
      const recent = attempts.filter((row) => row.subject === current);

      const last = (recent.length ? recent : attempts).at(-1);

      const responder =
        outcome?.state === "done" ? outcome.responder : undefined;

      const native =
        responder?.native === true ||
        (!responder &&
          (outcome?.state === "native" || roster?.native === true));

      const provider =
        responder?.provider ?? last?.provider ?? roster?.provider;

      if (provider === undefined || provider === "") {
        continue;
      }

      const rosterModel =
        typeof roster?.model === "string"
          ? roster.model
          : (roster?.model?.[0] ?? null);

      const recentCli = recent.filter(
        (row) => row.surface === "cli" && row.launched
      );

      const priorLaunches = attempts.filter(
        (row) =>
          row.subject !== current && row.surface === "cli" && row.launched
      ).length;

      const value: SlotYieldFacts = {
        kind: native ? "native" : "provider",
        provider,
        model: native ? null : (responder?.model ?? last?.model ?? rosterModel),
        raised: emptyRaised(),
        accepted: 0,
        rejected: 0,
        deferred: 0,
        duplicate: 0,
        unruled: 0,
        measured: recentCli.filter((row) => row.usage).length,
        launched: recentCli.length,
        ...(priorLaunches && { priorLaunches }),
        ...(recentCli.length && {
          attempts: recentCli.map(
            ({
              provider: providerName,
              model,
              effort,
              usage,
              usageSource,
              reportedModels,
              reportedModelAmbiguous,
              coverage,
            }) => ({
              provider: providerName,
              model,
              effort: effort ?? null,
              ...(usage && { usage }),
              ...(usageSource && { usageSource }),
              ...(reportedModels && { reportedModels }),
              ...(reportedModelAmbiguous && { reportedModelAmbiguous }),
              ...(coverage && { coverage }),
            })
          ),
        }),
      };

      let fixInduced = 0;
      let tokens: number | undefined;

      for (const row of recentCli) {
        if (!row.usage) {
          continue;
        }

        tokens =
          (tokens ?? 0) +
          billedTokens(row.usage, row.provider, row.usage.reasoningInOutput);
      }

      if (tokens !== undefined) {
        value.tokens = tokens;
      }

      for (const item of round.findings?.findings ?? []) {
        if (item.sources?.includes(source) !== true) {
          continue;
        }

        if (
          item.severity === "MUST" ||
          item.severity === "SHOULD" ||
          item.severity === "CONSIDER"
        ) {
          value.raised[item.severity] += 1;
        }

        if (item.origin === "fix-induced") {
          fixInduced += 1;
        }

        tally(value, `review:${round.review}:${item.id}`);
      }

      if (fixInduced) {
        value.fixInduced = fixInduced;
      }

      add(value);
    }

    for (const item of round.findings?.findings ?? []) {
      if (item.sources?.includes("tool") !== true) {
        continue;
      }

      if (
        item.severity === "MUST" ||
        item.severity === "SHOULD" ||
        item.severity === "CONSIDER"
      ) {
        tool.raised[item.severity] += 1;
      }

      tally(tool, `review:${round.review}:${item.id}`);
    }
  }

  if (
    tool.accepted +
      tool.rejected +
      tool.deferred +
      tool.duplicate +
      tool.unruled >
    0
  ) {
    add({
      kind: "tool",
      provider: "tool",
      model: null,
      ...tool,
      measured: 0,
      launched: 0,
    });
  }

  return [...rows.values()].toSorted(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.provider.localeCompare(b.provider) ||
      (a.model ?? "").localeCompare(b.model ?? "")
  );
};

const REVIEW_STAGES = [
  "ask",
  "design review",
  "plan review",
  "code review",
] as const;

const isReviewStage = (name: string): name is (typeof REVIEW_STAGES)[number] =>
  REVIEW_STAGES.some((stage) => stage === name);

const captureStart = (run: RunFacts) =>
  present(run.capture, "capture clock").start;

export const stageMilestones = (
  fold: Fold,
  captures: readonly RunFacts[],
  startMs: number
): Milestone[] => {
  const capturesOf = (name: string) =>
    captures.filter(
      (c) =>
        c.phases.some((p) => p.name === name) && c.capture?.start !== undefined
    );

  const [confirm] = fold.records
    .filter((r) => r.kind === "confirm")
    .map((r) => Date.parse(r.at))
    .filter(Number.isFinite)
    .toSorted((a, b) => a - b);

  if (confirm === undefined) {
    const [first] = captures
      .filter(
        (c) =>
          c.capture !== undefined && c.phases.some((p) => isReviewStage(p.name))
      )
      .toSorted((a, b) => captureStart(a) - captureStart(b));

    return [
      {
        stage: first?.phases.map((p) => p.name).find(isReviewStage) ?? "spec",
        atMs: startMs,
      },
    ];
  }

  const designs = capturesOf("design review");
  const plans = capturesOf("plan review");

  const stages: Milestone[] = [
    { stage: "spec", atMs: startMs },
    { stage: designs.length ? "design" : "plan", atMs: confirm },
  ];

  for (const name of ["design review", "plan review", "code review"] as const) {
    const [first] = capturesOf(name).toSorted(
      (a, b) => captureStart(a) - captureStart(b)
    );

    if (first) {
      stages.push({ stage: name, atMs: captureStart(first) });
    }
  }

  if (
    designs.length &&
    (plans.length ||
      fold.records.some(
        (r) => r.kind === "bind" && typeof r.data["plan"] === "string"
      ))
  ) {
    const ends = designs.flatMap((c) =>
      c.capture?.end === undefined ? [] : [c.capture.end]
    );

    if (ends.length) {
      stages.push({ stage: "plan", atMs: Math.max(...ends) });
    }
  }

  const [implementation] = fold.records
    .filter(
      (r) =>
        r.kind === "approval" ||
        (r.kind === "writer" && r.data["phase"] === "launched")
    )
    .map((r) => Date.parse(r.at))
    .filter(Number.isFinite)
    .toSorted((a, b) => a - b);

  if (implementation !== undefined) {
    stages.push({ stage: "implementation", atMs: implementation });
  }

  return stages.toSorted((a, b) => a.atMs - b.atMs);
};

// Host milestone name for a round; the review hash keeps it within the phase key gate.
const roundPhase = (review: string, round: number) =>
  `round-${review.slice(7)}-${round}`;

interface CaptureHost {
  host?: string;
  hostThread?: string;
}

// Raw `tool-action[-kind]` key; a killed capture has invocations but no phases yet.
const callKey = (capture: RunFacts) =>
  // oxlint-disable-next-line typescript/prefer-nullish-coalescing, typescript/strict-boolean-expressions -- empty phase keys fall through to the invocation phase.
  capture.phases[0]?.key || capture.invocations[0]?.phase || undefined;

/**
 * Each window closes at its last run, ruling or fix-review-lite note, before the next round starts.
 * A capture belongs to the window holding its start, so closed windows never change on a later render.
 */
const roundTimeline = (
  rounds: readonly YieldRound[],
  measured: readonly RunFacts[],
  reviewKeys: ReadonlyMap<string, string>,
  records: Fold["records"],
  invocations: readonly InvocationFacts[]
) => {
  const owner = new Map<
    string,
    { key: string; review: string; round: number }
  >();

  for (const round of rounds) {
    for (const generation of round.generations) {
      const key = present(reviewKeys.get(round.review), "review key");
      owner.set(generation.subject, {
        key,
        review: round.review,
        round: round.round,
      });
    }
  }

  const reviewRuns = measured.flatMap((capture) =>
    capture.capture !== undefined &&
    callKey(capture)?.startsWith("review-run-") === true
      ? [{ capture, start: capture.capture.start }]
      : []
  );

  const starts = new Map<
    string,
    { key: string; review: string; round: number; start: number }
  >();

  for (const { capture, start } of reviewRuns) {
    for (const entry of capture.invocations) {
      const who =
        entry.subject !== undefined && entry.subject !== ""
          ? owner.get(entry.subject)
          : undefined;

      if (!who) {
        continue;
      }

      const id = `${who.key}#${who.round}`;
      const known = starts.get(id);

      if (!known || start < known.start) {
        starts.set(id, { ...who, start });
      }
    }
  }

  const timeline = [...starts.values()].toSorted(
    (a, b) =>
      a.start - b.start || a.key.localeCompare(b.key) || a.round - b.round
  );

  const closes = timeline.map((round, index) => {
    const nextStart = timeline[index + 1]?.start ?? Infinity;
    let close = round.start;

    for (const { capture, start } of reviewRuns) {
      if (start < round.start || start >= nextStart) {
        continue;
      }

      const matched = capture.invocations.filter((candidate) => {
        const who =
          candidate.subject !== undefined && candidate.subject !== ""
            ? owner.get(candidate.subject)
            : undefined;

        return who?.key === round.key && who.round === round.round;
      });

      if (matched.length) {
        close = Math.max(
          close,
          capture.capture?.end ?? start,
          ...matched.map((hit) => hit.endMs ?? start)
        );
      }
    }

    for (const record of records) {
      const at = Date.parse(record.at);

      if (!(at >= round.start && at < nextStart)) {
        continue;
      }

      const subject: unknown = record.data["subject"];

      if (
        (record.kind === "ruling" &&
          typeof subject === "string" &&
          subject.startsWith(`review:${round.review}:`)) ||
        (record.kind === "note" &&
          record.key.startsWith(
            `fix-review-lite:${round.review}:${round.round}:`
          ))
      ) {
        close = Math.max(close, at);
      }
    }

    return Math.min(close, nextStart - 1);
  });

  const activity = new Map<
    number,
    { calls: Map<string, number>; captures: RunFacts[] }
  >();

  for (const capture of measured) {
    const start = capture.capture?.start;

    if (start === undefined) {
      continue;
    }

    const index = timeline.findLastIndex((round) => round.start <= start);

    if (index === -1 || start > present(closes[index], "window close")) {
      continue;
    }

    const entry = activity.get(index) ?? {
      calls: new Map<string, number>(),
      captures: [],
    };

    entry.captures.push(capture);
    const key = callKey(capture);

    if (key !== undefined) {
      entry.calls.set(key, (entry.calls.get(key) ?? 0) + 1);
    }

    activity.set(index, entry);
  }

  const reviewerTurnsFor = (round: YieldRound) => {
    const activeSlots = round.roster.filter((s) => s.reserve !== true);

    const currentSubject = round.generations.find(
      (g) => g.generation === round.generation
    )?.subject;

    let total = 0;
    let observedSlots = 0;
    let partial = false;

    for (const s of activeSlots) {
      const isNative =
        s.native === true ||
        round.slots.some(
          (o) =>
            o.slot === s.slot &&
            (o.state === "native" ||
              (o.state === "done" && o.responder?.native === true))
        ) ||
        invocations.some(
          (i) =>
            i.subject === currentSubject &&
            i.surface === "native" &&
            (i.targetSlot ?? i.slot) === s.slot
        );

      const cliInvocations = invocations.filter(
        (i) =>
          i.subject === currentSubject &&
          i.surface === "cli" &&
          i.launched &&
          (i.targetSlot ?? i.slot) === s.slot
      );

      let slotTurns = 0;
      let cliObserved = cliInvocations.length > 0;

      for (const inv of cliInvocations) {
        const turns =
          inv.usage?.turns ??
          completeDelegateResponses(inv)?.reduce(
            (sum, response) => sum + response.observed,
            0
          );

        if (turns === undefined) {
          cliObserved = false;
          break;
        }

        slotTurns += turns;
      }

      if (cliObserved) {
        total += slotTurns;
        observedSlots += 1;
      }

      if (isNative || !cliObserved) {
        partial = true;
      }
    }

    if (!observedSlots) {
      return {};
    }

    return {
      reviewerTurns: total,
      ...(partial && { reviewerTurnsPartial: true as const }),
    };
  };

  const capturesByRound = new Map<string, CaptureHost[]>();

  const rows = rounds.map((round) => {
    const review = present(reviewKeys.get(round.review), "review key");

    const index = timeline.findIndex(
      (t) => t.key === review && t.round === round.round
    );

    const kind = (["plan", "design", "code"] as const).find((name) =>
      round.review.startsWith(`${name}-`)
    );

    const row: RoundWorkload = {
      review,
      ...(kind && { kind }),
      round: round.round,
      ...reviewerTurnsFor(round),
    };

    if (index === -1) {
      return row;
    }

    const entry = activity.get(index);
    capturesByRound.set(`${review}#${round.round}`, entry?.captures ?? []);

    const phases = [...(entry?.calls ?? [])]
      .map(([key, count]) => ({ key, count }))
      .toSorted((a, b) => b.count - a.count || a.key.localeCompare(b.key));

    return {
      ...row,
      calls: { total: phases.reduce((sum, p) => sum + p.count, 0), phases },
    };
  });

  const close = closes.at(-1);

  if (close === undefined) {
    return { rows, capturesByRound };
  }

  return {
    rows,
    capturesByRound,
    window: {
      startMs: present(timeline[0], "first round window").start,
      endMs: close,
      milestones: timeline.flatMap((t, i) => [
        { phase: roundPhase(t.key, t.round), atMs: t.start },
        { phase: "outside", atMs: present(closes[i], "window close") + 1 },
      ]),
    },
  };
};

const hostUsageRead = (
  deps: CliDeps,
  platform: ProviderKey | null,
  input: {
    startMs: number;
    endMs: number;
    stages: readonly Milestone[];
    phases: readonly PhaseMilestone[];
  }
): HostUsageFacts => {
  const home =
    (process.platform === "win32"
      ? (deps.env["USERPROFILE"] ?? deps.env["HOME"])
      : (deps.env["HOME"] ?? deps.env["USERPROFILE"])) ?? os.homedir();

  return readHostUsage(
    platform,
    { ...input, home, env: (name) => deps.env[name] },
    deps.hostUsageFs ?? nodeHostUsageFs
  );
};

interface RetroRead {
  retroState: NonNullable<RunFacts["retroState"]>;
  observations?: unknown;
}

const readRetro = (file: string): RetroRead => {
  try {
    const observations: unknown = JSON.parse(
      stripBom(fs.readFileSync(file, "utf-8"))
    );

    let retroState: RetroRead["retroState"] = "invalid";

    if (Array.isArray(observations)) {
      retroState = observations.length ? "collected" : "empty";
    }

    return { retroState, observations };
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      return { retroState: "missing" };
    }

    return {
      retroState: error instanceof SyntaxError ? "malformed" : "unreadable",
    };
  }
};

// SECTION: Saved review shapes; a failed guard counts the file as corrupt

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

const isSlotEntry = (row: unknown) =>
  isRecord(row) && typeof row["slot"] === "string";

const isRoundFile = (
  value: JsonValue | undefined
): value is JsonObject & RoundFile =>
  isRecord(value) &&
  isPositiveInteger(value["round"]) &&
  isPositiveInteger(value["generation"]) &&
  Number.isSafeInteger(value["cap"]) &&
  Array.isArray(value["roster"]) &&
  value["roster"].every(isSlotEntry);

const isSavedSlot = (
  value: JsonValue | undefined
): value is JsonObject & SlotOutcome =>
  isRecord(value) &&
  (value["state"] === "done" ||
    value["state"] === "native" ||
    value["state"] === "failed");

const isFindingsFile = (
  value: JsonValue | undefined
): value is JsonObject & FindingsFile =>
  isRecord(value) &&
  Array.isArray(value["findings"]) &&
  value["findings"].every(
    (finding) => isRecord(finding) && typeof finding["id"] === "string"
  );

const aggregateOutcome = (values: (string | undefined)[]) => {
  const known = [
    ...new Set(values.filter((v): v is string => v !== undefined)),
  ].toSorted();

  let outcome: string | undefined;

  const [only] = known;

  if (known.length === 1) {
    outcome = only;
  } else if (known.length) {
    outcome = "mixed";
  } else {
    outcome = undefined;
  }

  return outcome;
};

const nativeRank = (row: InvocationFacts) => {
  if (row.nativeState === "completed") {
    return 3;
  }

  if (row.nativeState === "invalid" || row.nativeState === "failed") {
    return 2;
  }

  return 1;
};

const matchesPhysical = (
  capture: InvocationFacts | undefined,
  row: InvocationFacts
) =>
  capture?.surface === "native" &&
  capture.provider === row.provider &&
  capture.model === row.model &&
  capture.effort === row.effort;

/** Builds optional facts independently of the strict walkthrough reader. */
// oxlint-disable-next-line eslint/complexity -- collection branches per review-directory walk, read failure class, and host-context presence.
export const sessionFacts = (
  session: string,
  fold: Fold,
  outcome: string,
  hostContext?: { manifest: HandlerContext["manifest"]; deps: CliDeps }
): RunFacts => {
  const collection = {
    completed: 0,
    partial: 0,
    corrupt: 0,
    unreadable: 0,
    incomplete: 0,
    storageFailed: 0,
  };

  const issue = (key: keyof typeof collection) => {
    collection[key] = Math.min(1_000_000, collection[key] + 1);
  };

  const entries = (directory: string) => {
    try {
      return entriesOrEmpty(directory).toSorted((a, b) =>
        a.name.localeCompare(b.name)
      );
    } catch {
      issue("unreadable");

      return [];
    }
  };

  const read = (file: string) => {
    try {
      return readReviewJson<JsonValue>(file);
    } catch (error) {
      issue(
        error instanceof ToolError && error.reason === "review-corrupt"
          ? "corrupt"
          : "unreadable"
      );

      // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the parsed and unreadable branches.
      return undefined;
    }
  };

  const rounds: YieldRound[] = [];
  const root = reviewRoot(session);

  for (const review of reviewDirectories(root, entries)) {
    const reviewDir = reviewDirectory(session, review.name);

    for (const entry of reviewDirectories(reviewDir, entries)) {
      const roundRoot = path.join(reviewDir, entry.name);
      const value = read(reviewRoundFile(roundRoot));

      if (value === undefined) {
        continue;
      }

      if (!isRoundFile(value)) {
        issue("corrupt");
        continue;
      }

      const round = value;
      const slots: SlotOutcome[] = [];

      const slotDir = reviewSlotsDirectory(roundRoot, round.generation);

      for (const file of reviewSlotEntries(slotDir, entries)) {
        const slot = read(path.join(slotDir, file.name));

        if (slot === undefined) {
          continue;
        }

        if (
          !isSavedSlot(slot) ||
          !round.roster.some((r) => r.slot === slot.slot)
        ) {
          issue("corrupt");
          continue;
        }

        slots.push(slot);
      }

      const findings = read(reviewFindingsFile(roundRoot));

      if (
        findings !== undefined &&
        findings !== null &&
        !isFindingsFile(findings)
      ) {
        issue("corrupt");
      }

      const generations = [
        ...new Set(
          reviewDirectories(roundRoot, entries)
            .filter((e) => /^gen-\d+$/u.test(e.name))
            .map((e) => Number(e.name.slice(4)))
        ),
      ];

      if (!generations.includes(round.generation)) {
        generations.push(round.generation);
      }

      rounds.push({
        review: review.name,
        round: round.round,
        cap: round.cap,
        generation: round.generation,
        roster: round.roster,
        slots,
        findings: isFindingsFile(findings) ? findings : null,
        generations: generations
          .toSorted((a, b) => a - b)
          .map((generation) => ({
            generation,
            subject: diagnosticSubject(
              reviewGenerationDirectory(roundRoot, generation)
            ),
          })),
      });
    }
  }

  rounds.sort((a, b) => a.review.localeCompare(b.review) || a.round - b.round);
  const measured: RunFacts[] = [];
  const storageFailures = new Map<string, number>();
  const recoverySelections: NonNullable<RunFacts["recoverySelections"]> = [];
  const recoveryExecutions: NonNullable<RunFacts["recoveryExecutions"]> = [];
  const directory = captureDirectory(session);

  for (const entry of entries(directory).filter(
    (e) => e.isFile() && e.name.endsWith(".json")
  )) {
    const raw = read(path.join(directory, entry.name));

    if (raw === undefined) {
      continue;
    }

    if (
      isRecord(raw) &&
      raw["kind"] === "storage-failure" &&
      entry.name.endsWith(`.json${CAPTURE_FAILURE_SUFFIX}`)
    ) {
      const failures = raw["count"];

      if (isPositiveInteger(failures)) {
        const captureName = entry.name.slice(0, -CAPTURE_FAILURE_SUFFIX.length);
        storageFailures.set(
          captureName,
          Math.max(
            storageFailures.get(captureName) ?? 0,
            Math.min(1_000_000, failures)
          )
        );
      } else {
        issue("corrupt");
      }

      continue;
    }

    if (
      !isRecord(raw) ||
      !Array.isArray(raw["phases"]) ||
      !Array.isArray(raw["invocations"]) ||
      !Array.isArray(raw["reviews"])
    ) {
      issue("corrupt");
      continue;
    }

    const capture = sanitizeFacts(raw);
    measured.push(capture);

    if (
      !capture.capture ||
      capture.capture.state !== "completed" ||
      capture.capture.end === undefined
    ) {
      issue("incomplete");
    } else {
      issue("completed");
      const ref = entry.name.slice(0, -5);

      if (
        capture.recoverySelection &&
        recoveryRef(ref) &&
        capture.phases.some(
          (p) => p.key === "status-show" && p.outcome === "ok"
        )
      ) {
        recoverySelections.push({ ...capture.recoverySelection, ref });
      }

      if (capture.recoveryExecution) {
        recoveryExecutions.push(capture.recoveryExecution);
      }
    }

    storageFailures.set(
      entry.name,
      Math.max(
        storageFailures.get(entry.name) ?? 0,
        capture.capture?.storageFailed ?? 0
      )
    );
  }

  // Capture filenames are random; order by capture clock so a retry's later attempt wins, then by content for determinism.
  measured.sort(
    (a, b) =>
      (a.capture?.start ?? 0) - (b.capture?.start ?? 0) ||
      stableValue(a).localeCompare(stableValue(b))
  );
  const phases = new Map<string, RunFacts["phases"][number]>();
  const phaseBySubject = new Map<string, string>();
  const reviewKeys = new Map<string, string>();
  const superseded = new Set<string>();

  for (const round of rounds) {
    const key =
      reviewKeys.get(round.review) ??
      `review-${diagnosticSubject(reviewDirectory(session, round.review))}`;

    reviewKeys.set(round.review, key);

    for (const generation of round.generations) {
      phaseBySubject.set(generation.subject, key);

      if (generation.generation !== round.generation) {
        superseded.add(generation.subject);
      }
    }

    let name = "code review";

    if (round.review.startsWith("plan-")) {
      name = "plan review";
    } else if (round.review.startsWith("design-")) {
      name = "design review";
    }

    if (!phases.has(key)) {
      phases.set(key, { key, name });
    }
  }

  const phaseMilestones: PhaseMilestone[] = [];

  for (const capture of measured) {
    let lastKey: string | undefined;

    for (const original of capture.phases) {
      const subjects = [
        ...new Set(
          capture.invocations
            .filter((row) => row.phase === original.key)
            .flatMap((row) => {
              const mapped =
                row.subject !== undefined && row.subject !== ""
                  ? phaseBySubject.get(row.subject)
                  : undefined;

              return mapped === undefined ? [] : [mapped];
            })
        ),
      ];

      const [only] = subjects;

      const key =
        subjects.length === 1 && only !== undefined ? only : original.key;

      lastKey = key;
      const phase = { ...original, key };
      const previous = phases.get(phase.key);
      const result = aggregateOutcome([previous?.outcome, phase.outcome]);
      phases.set(phase.key, {
        ...phase,
        ...(result !== undefined && result !== "" && { outcome: result }),
        ...(!(previous?.wallMs === undefined && phase.wallMs === undefined) && {
          wallMs: (previous?.wallMs ?? 0) + (phase.wallMs ?? 0),
        }),
      });
    }

    if (lastKey !== undefined && capture.capture?.start !== undefined) {
      phaseMilestones.push({ phase: lastKey, atMs: capture.capture.start });
    }
  }

  phaseMilestones.sort((a, b) => a.atMs - b.atMs);
  const invocations: InvocationFacts[] = [];
  const native = new Map<string, { row: InvocationFacts; atMs: number }>();

  const add = (
    { superseded: _superseded, ...row }: InvocationFacts,
    atMs = Infinity
  ) => {
    const phase =
      row.subject === undefined || row.subject === ""
        ? undefined
        : phaseBySubject.get(row.subject);

    const supersededSubject =
      row.subject === undefined || row.subject === "" ? undefined : row.subject;

    const isSuperseded =
      supersededSubject !== undefined && superseded.has(supersededSubject);

    const value = {
      ...row,
      ...(phase !== undefined && phase !== "" && { phase }),
      ...(isSuperseded && { superseded: true as const }),
    };

    if (value.surface !== "native") {
      invocations.push(value);

      return;
    }

    const key = [value.subject ?? value.phase, value.slot ?? ""].join("|");
    const previous = native.get(key);

    // Later captures and saved descriptors replace settings; tied captures preserve terminal evidence.
    if (
      !previous ||
      atMs > previous.atMs ||
      (atMs === previous.atMs && nativeRank(value) >= nativeRank(previous.row))
    ) {
      native.set(key, { row: value, atMs });
    }
  };

  for (const capture of measured) {
    for (const row of capture.invocations) {
      add(row, capture.capture?.start ?? 0);
    }
  }

  for (const round of rounds) {
    for (const slot of round.slots) {
      const row = invocation(round, slot);

      const subject = diagnosticSubject(
        reviewGenerationDirectory(
          reviewRoundDirectory(
            reviewDirectory(session, round.review),
            round.round
          ),
          round.generation
        )
      );

      const key = [subject, slot.slot].join("|");
      const captured = native.get(key)?.row;

      if (slot.state === "done" && slot.responder && !slot.responder.native) {
        continue;
      }

      const descriptor =
        slot.state === "native" && typeof slot.provider === "string";

      const responder =
        slot.state === "done" && slot.responder?.native === true;

      if (
        !descriptor &&
        !responder &&
        row.surface !== "native" &&
        captured?.surface !== "native"
      ) {
        continue;
      }

      const physical = descriptor || responder;
      const matchingCapture = matchesPhysical(captured, row);

      let settings: InvocationFacts = row;

      if (!physical && captured?.surface === "native") {
        settings = captured;
      }

      let nativeState: InvocationFacts["nativeState"];

      if (slot.state === "done") {
        nativeState = "completed";
      } else if (slot.state === "failed") {
        nativeState = "failed";
      } else if (slot.state === "native" && slot.cliFallback === true) {
        nativeState = "failed";
      } else if (slot.state === "native" && slot.error !== undefined) {
        nativeState = "invalid";
      } else {
        nativeState = "pending";
      }

      let projectedOutcome =
        nativeState === "completed" ? "ok" : `native-${nativeState}`;

      // A matching descriptor can outlive its terminal capture if the final slot save was interrupted.
      if (
        descriptor &&
        slot.cliFallback !== true &&
        matchingCapture &&
        captured?.nativeState !== undefined &&
        captured.nativeState !== "pending" &&
        (slot.error === undefined || captured.nativeState === "completed")
      ) {
        ({ nativeState } = captured);
        ({ outcome: projectedOutcome } = captured);
      }

      nativeState ??= "pending";

      let attemptValue: InvocationFacts["attempt"] | undefined;

      if (physical) {
        if (matchingCapture && captured?.attempt !== undefined) {
          attemptValue = captured.attempt;
        }
      } else if (
        captured?.surface === "native" &&
        captured.attempt !== undefined
      ) {
        attemptValue = captured.attempt;
      }

      const projected: InvocationFacts = {
        ...row,
        provider: settings.provider,
        model: settings.model,
        surface: "native",
        outcome: projectedOutcome,
        nativeState,
        ...(attemptValue !== undefined && { attempt: attemptValue }),
        ...(!(settings.effort === undefined) && { effort: settings.effort }),
        phase: present(reviewKeys.get(round.review), "review key"),
        subject,
      };

      if (settings.effort === undefined) {
        delete projected.effort;
      }

      // Descriptors own physical settings; descriptor-less failures retain the latest captured actor.
      add(projected);
    }
  }

  invocations.push(...[...native.values()].map((value) => value.row));
  const retro = readRetro(path.join(session, ".state", "retro.json"));

  const provenance = new Map<
    string,
    NonNullable<RunFacts["provenance"]>[number]
  >();

  for (const row of measured) {
    const snapshot = {
      ...(row.version !== undefined &&
        row.version !== "" && {
          version: row.version,
        }),
      ...(row.build !== undefined &&
        row.build !== "" && {
          build: row.build,
        }),
      ...(row.config !== undefined && { config: row.config }),
    };

    provenance.set(stableValue(snapshot), snapshot);
  }

  const tasks = [
    ...new Set(
      fold.records.flatMap((r) => {
        const task: unknown = r.data["task"];

        return r.kind === "writer" && typeof task === "string" ? [task] : [];
      })
    ),
  ];

  const relaunches = tasks.reduce(
    (sum, task) =>
      sum +
      Math.max(
        0,
        new Set(launches(fold, task).map((row) => row.record.key)).size - 1
      ),
    0
  );

  collection.storageFailed = Math.min(
    1_000_000,
    [...storageFailures.values()].reduce((sum, n) => sum + n, 0)
  );
  collection.partial = Math.min(
    1_000_000,
    collection.corrupt +
      collection.unreadable +
      collection.incomplete +
      collection.storageFailed
  );
  const level: unknown = latest(fold, "level")?.data["level"];

  const host = measured.find(
    (row) => row.host !== undefined && row.host !== ""
  )?.host;

  const hosts = [
    ...new Set(
      measured.flatMap((row) =>
        typeof row.host === "string" && row.host.length > 0 ? [row.host] : []
      )
    ),
  ];

  const starts = measured.flatMap((c) => {
    const start = c.capture?.start;

    return typeof start === "number" &&
      Number.isFinite(start) &&
      start > 0 &&
      start <= 8_640_000_000_000_000
      ? [start]
      : [];
  });

  let createdAt: unknown = hostContext?.manifest.createdAt;

  if (createdAt === undefined) {
    try {
      createdAt = readReviewJson<{ createdAt?: unknown }>(
        path.join(session, "manifest.json")
      )?.createdAt;
    } catch {
      void 0;
      /* ignore */
    }
  }

  const createdMs =
    typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;

  let startMsForDate: number | undefined;

  if (starts.length) {
    startMsForDate = Math.min(...starts);
  } else if (
    Number.isFinite(createdMs) &&
    Math.abs(createdMs) <= 8_640_000_000_000_000
  ) {
    startMsForDate = createdMs;
  } else {
    startMsForDate = undefined;
  }

  const startedAt =
    startMsForDate === undefined
      ? undefined
      : new Date(startMsForDate).toISOString().slice(0, 10);

  const slotYield = slotYieldFacts(rounds, invocations, fold);

  const roundTiming = rounds.map((round) => {
    const subject = round.generations.find(
      (g) => g.generation === round.generation
    )?.subject;

    return {
      review: present(reviewKeys.get(round.review), "review key"),
      round: round.round,
      cap: round.cap,
      slots: round.roster
        .filter((slot) => slot.reserve !== true)
        .map((slot) => {
          const slotOutcome = round.slots.find(
            (value) => value.slot === slot.slot
          );

          const slotNative =
            slotOutcome?.state === "native" ||
            (slotOutcome?.state === "done" &&
              slotOutcome.responder?.native === true) ||
            invocations.some(
              (i) =>
                i.subject === subject &&
                i.surface === "native" &&
                (i.targetSlot ?? i.slot) === slot.slot
            );

          const attempts = invocations.flatMap((i) =>
            i.subject === subject &&
            i.launched &&
            (i.targetSlot ?? i.slot) === slot.slot
              ? [
                  {
                    surface: i.surface,
                    ...(!(i.startMs === undefined) && { startMs: i.startMs }),
                    ...(!(i.endMs === undefined) && { endMs: i.endMs }),
                  },
                ]
              : []
          );

          // A saved done outcome is authoritative; invocation history only fills in when none exists.
          const served = invocations.findLast(
            (i) =>
              i.subject === subject &&
              i.launched &&
              (i.targetSlot ?? i.slot) === slot.slot
          );

          const historyResponder =
            served?.targetSlot === undefined ? undefined : served.slot;

          const responder =
            slotOutcome?.state === "done"
              ? slotOutcome.responder?.slot
              : historyResponder;

          return {
            slot: slot.slot,
            ...(responder !== undefined &&
              responder !== slot.slot && { responder }),
            attempts: slotNative
              ? [...attempts, { surface: "native" as const }]
              : attempts,
          };
        }),
    };
  });

  const workload = roundTimeline(
    rounds,
    measured,
    reviewKeys,
    fold.records,
    invocations
  );

  let hostUsage: RunFacts["hostUsage"];

  if (hostContext) {
    const { manifest, deps } = hostContext;
    const platform = deps.orchestrator?.platform ?? null;

    const startMs = Date.parse(manifest.createdAt);

    try {
      hostUsage = Number.isFinite(startMs)
        ? hostUsageRead(deps, platform, {
            startMs,
            endMs: deps.clock(),
            stages: stageMilestones(fold, measured, startMs),
            phases: phaseMilestones,
          })
        : { platform, rows: [], unavailable: "invalid session start" };
    } catch (error) {
      hostUsage = { platform, rows: [], unavailable: readErrorReason(error) };
    }
  }

  // Second read: host rows attributed to each round window; a failure leaves the host tokens unavailable and never gates rendering.
  let roundWorkload = workload.rows;

  if (hostContext && workload.window) {
    const { deps } = hostContext;
    const platform = deps.orchestrator?.platform ?? null;

    const measuredThread = hostThreadId(platform, deps.env, session);
    const hasThreadTracking = measured.some((c) => c.hostThread !== undefined);
    let windowRead: HostUsageFacts;

    try {
      windowRead = hostUsageRead(deps, platform, {
        startMs: workload.window.startMs,
        endMs: workload.window.endMs,
        stages: [],
        phases: workload.window.milestones,
      });
    } catch (error) {
      windowRead = { platform, rows: [], unavailable: readErrorReason(error) };
    }

    if (!windowRead.unavailable) {
      const tokens = new Map<string, number>();
      const turns = new Map<string, number>();
      const missingTurns = new Set<string>();

      for (const row of windowRead.rows) {
        if (row.role !== "host" || row.phase === undefined) {
          continue;
        }

        tokens.set(
          row.phase,
          (tokens.get(row.phase) ?? 0) +
            billedTokens(row, windowRead.platform ?? "", row.reasoningInOutput)
        );

        if (row.turns === undefined) {
          missingTurns.add(row.phase);
        } else {
          turns.set(row.phase, (turns.get(row.phase) ?? 0) + row.turns);
        }
      }

      roundWorkload = roundWorkload.map((row) => {
        if (!row.calls) {
          return row;
        }

        const captures =
          workload.capturesByRound.get(`${row.review}#${row.round}`) ?? [];

        const mismatch = captures.some(
          (c) =>
            (c.host !== undefined && c.host !== windowRead.platform) ||
            (c.hostThread !== undefined &&
              (measuredThread === undefined ||
                measuredThread === "" ||
                c.hostThread !== measuredThread)) ||
            (hosts.length > 1 && c.host === undefined) ||
            (hasThreadTracking && c.hostThread === undefined)
        );

        if (mismatch) {
          return row;
        }

        const phase = roundPhase(row.review, row.round);

        return {
          ...row,
          hostTokens: tokens.get(phase) ?? 0,
          ...(!Object.keys(windowRead.notes?.host ?? {}).length &&
            !missingTurns.has(phase) && { hostTurns: turns.get(phase) ?? 0 }),
        };
      });
    }
  }

  // NOTE: the ledger records no verb; only writer records identify one, so other runs omit it rather than guess.
  return {
    ...(typeof level === "string" && { level }),
    ...(tasks.length && { verb: "implement" }),
    outcome,
    timingScope: "tool-calls",
    os: process.platform,
    ...(host !== undefined && host !== "" && { host }),
    ...(hosts.length && { hosts }),
    ...(startedAt !== undefined && startedAt !== "" && { startedAt }),
    phases: [...phases.values()].toSorted((a, b) => a.key.localeCompare(b.key)),
    invocations,
    reviews: rounds.flatMap((round) => {
      const row = reviewFacts(round, fold);

      return row
        ? [
            {
              ...row,
              phase: present(reviewKeys.get(round.review), "review key"),
            },
          ]
        : [];
    }),
    ...(slotYield.length && { slotYield }),
    ...(roundTiming.length && { roundTiming }),
    ...(roundWorkload.length && { roundWorkload }),
    ...(hostUsage && { hostUsage }),
    ...retro,
    collection,
    provenance: [...provenance.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([, v]) => v),
    ...(recoverySelections.length && { recoverySelections }),
    ...(recoveryExecutions.length && { recoveryExecutions }),
    rejectedTools: measured.flatMap((row) => row.rejectedTools ?? []),
    relaunches,
  };
};

/** Writes the compact diagnostics report with a rename so readers never see a partial file. */
export const writeDiagnostics = (
  session: string,
  facts: RunFacts,
  pricer?: Pricer
) => {
  const output = path.join(session, "diagnostics.md");
  const temp = `${output}.${crypto.randomUUID()}.tmp`;

  try {
    fs.writeFileSync(temp, renderDiagnostics([facts], pricer).text, {
      mode: 0o600,
    });
    fs.renameSync(temp, output);
  } finally {
    fs.rmSync(temp, { force: true });
  }

  return output;
};

export const optionalDiagnostics = (
  session: string,
  fold: Fold,
  outcome: string,
  host?: { manifest: HandlerContext["manifest"]; deps: CliDeps }
) => {
  try {
    return writeDiagnostics(
      session,
      sessionFacts(session, fold, outcome, host),
      host && loadPricing(host.deps.skillRoot)
    );
  } catch {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the written and failed branches.
    return undefined;
  }
};

export const retroWarning = (session: string) => {
  const file = path.join(session, ".state", "retro.json");
  const { retroState, observations } = readRetro(file);

  if (retroState === "missing") {
    return `Host retro missing: merge retro notes into ${file} (write [] when none), then run diagnostics render.`;
  }

  if (!Array.isArray(observations)) {
    return "Host retro uncollected. Write a JSON array [{id,component,category,evidence,impact,proposedFix}] to .state/retro.json, then run diagnostics render.";
  }

  if (
    retroObservations(observations).values.some((item) =>
      item.id.startsWith("grounding-")
    )
  ) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the ungrounded and warning branches.
    return undefined;
  }

  const results = path.join(session, ".state", "results");
  let entries: fs.Dirent[];

  try {
    entries = entriesOrEmpty(results);
  } catch {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the unreadable and warning branches.
    return undefined;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !/^brief-explorer-.*\.json$/u.test(entry.name)) {
      continue;
    }

    let result: { kind?: unknown } | null;

    try {
      result = readReviewJson<{ kind?: unknown }>(
        path.join(results, entry.name)
      );
    } catch {
      continue;
    }

    if (result?.kind === "map") {
      return "Map explorer brief recorded. Add a valid grounding-<phase> item to .state/retro.json, then run diagnostics render.";
    }
  }

  // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the warning and ungrounded branches.
  return undefined;
};

// NOTE: Render is not captured as a tool observation, so it cannot describe its own run.
// oxlint-disable-next-line eslint/require-await -- handler signature requires async; render builds synchronously.
export const diagnosticsRender = async ({
  session,
  args,
  deps,
  manifest,
}: HandlerContext) => {
  if (args.length) {
    throw new ToolError(
      1,
      "invalid-input",
      "diagnostics render takes no positional arguments"
    );
  }

  if (!diagnosticsEnabled(deps.skillRoot)) {
    return {
      ok: true,
      exit: 0,
      summary: "diagnostics off",
      value: { path: null },
    };
  }

  const file = optionalDiagnostics(session, foldLedger(session), "rendered", {
    manifest,
    deps,
  });

  if (file === undefined) {
    return {
      ok: false,
      exit: 4,
      reason: "diagnostics-failed",
      summary: "diagnostics render failed; existing diagnostics.md unchanged",
      value: { path: null },
    };
  }

  const warning = retroWarning(session);

  return {
    ok: true,
    exit: 0,
    summary: `diagnostics rendered: ${file}${warning === undefined || warning === "" ? "" : `; ${warning}`}`,
    value: {
      path: file,
      ...(warning !== undefined && warning !== "" && { warning }),
    },
  };
};
