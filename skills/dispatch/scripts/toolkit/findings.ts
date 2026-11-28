import fs from "node:fs";
import path from "node:path";

import { nodeErrorCode } from "../lib/fs-ext.ts";
import { loadRejections, rejectionState } from "./confirmations.ts";
import type {
  RejectionRequest,
  RejectionReply,
  ConfirmationRound,
} from "./confirmations.ts";
import { coverageState } from "./coverage.ts";
import type {
  CoverageApplies,
  CoverageDecision,
  CoverageState,
} from "./coverage.ts";
import { structuralLines } from "./domain/markdown-structure.ts";
import {
  collectFindings,
  isUnresolvedLocus,
  matchFinding,
  parseReport,
} from "./domain/report.ts";
import { effectiveSeverity } from "./domain/severity.ts";
import type {
  Finding,
  ReviewKind,
  RoundCause,
  StepBack,
} from "./domain/types.ts";
import type { SlotOutcome } from "./fanout.ts";
import type { Fold } from "./ledger.ts";
import { parseRepositoryNoteKey } from "./ledger.ts";
import { present, textValue } from "./narrow.ts";
import { ToolError } from "./output.ts";
import type { LedgerRecord, RecordInput } from "./records.ts";
import {
  INTEGRATION_REVIEW,
  reviewDirectory,
  reviewRoundDirectory,
  reviewRoundFile,
  reviewFindingsFile,
  readStoredJson,
  reviewRoundEntries,
} from "./review-state.ts";
import type { ReviewTarget } from "./review-state.ts";

type ReviewedFinding = Finding & {
  recurrence?: { of: string };
  unresolved?: { of: string };
};

export interface RepositoryChange {
  cwd: string;
  paths: string[];
}

export interface RepositoryCheckState {
  state: "unavailable";
  reason: string;
}

export interface FindingsValue {
  review: string;
  round: number;
  cap: number;
  level: string;
  findings: ReviewedFinding[];
  units: FindingUnit[];
  clusters: { file: string; findings: string[] }[];
  failed: Extract<SlotOutcome, { state: "failed" }>[];
  // Set only for round 2 and later, after the missing-RED gaps join the findings.
  cause?: RoundCause;
  stepBack?: StepBack;
  confirmations?: RejectionReply[];
  repositoryChanges?: RepositoryChange[];
  repositoryCheck?: RepositoryCheckState;
}

export type Finalized = FindingsValue & { escalations: RecordInput[] };

const key = (finding: Finding) => ({
  locus: finding.locus,
  category: finding.category,
  text: `${finding.defect} ${finding.proposedFix}`,
});

// oxlint-disable-next-line eslint/complexity -- finalization branches per reply state, report parse outcome, and confirmation class.
export const finalizeRound = (input: {
  review: string;
  round: number;
  generation: number;
  cap: number;
  level: string;
  startSeq: number;
  replies: readonly SlotOutcome[];
  redGaps?: readonly Finding[];
  prior: readonly FindingsValue[];
  priorTargets: Record<number, ReviewTarget>;
  changedSince?: Record<number, readonly string[]>;
  owners?: Record<string, readonly string[]>;
  escalationRecords?: readonly LedgerRecord[];
  rulings: readonly LedgerRecord[];
  kind: ReviewKind;
  artifact: string;
  target: ReviewTarget;
  requests?: readonly RejectionRequest[];
  confirmationRounds?: readonly ConfirmationRound[];
  spec?: { path: string; hash: string };
  roster?: ConfirmationRound["metadata"]["roster"];
  repositoryChanges?: RepositoryChange[];
  repositoryCheck?: RepositoryCheckState;
}) => {
  const confirmations: RejectionReply[] = [];

  const drafts = input.replies.flatMap((reply) => {
    if (reply.state !== "done") {
      return [];
    }

    const requests = (input.requests ?? []).filter((request) =>
      request.sourceSlots.includes(reply.slot)
    );

    const parsed = parseReport({
      kind: input.kind,
      source: reply.slot,
      text: reply.text,
      expectedRequestIds: requests.map((request) => request.requestId),
    });

    if (!parsed.ok) {
      throw new Error(`Saved report is invalid: ${parsed.failure.detail}`);
    }

    for (const confirmation of parsed.confirmations ?? []) {
      const request = present(
        requests.find(
          (candidate) => candidate.requestId === confirmation.requestId
        ),
        "rejection request"
      );

      confirmations.push({
        ...request,
        sourceSlot: reply.slot,
        responder: reply.responder,
        decision: confirmation.decision,
        replyRationale: confirmation.rationale,
      });
    }

    return parsed.findings;
  });

  const findings: ReviewedFinding[] = [
    ...collectFindings(input.round, drafts).filter(
      (finding) => finding.dupOf === undefined || finding.dupOf === ""
    ),
    ...(input.redGaps ?? []),
  ];

  const escalations: RecordInput[] = [];

  if (input.spec && input.roster) {
    const current: ConfirmationRound = {
      review: input.review,
      metadata: {
        round: input.round,
        cap: input.cap,
        generation: input.generation,
        startSeq: input.startSeq,
        target: input.target,
        spec: input.spec,
        roster: input.roster,
        requests: input.requests ?? [],
      },
      findings: {
        review: input.review,
        round: input.round,
        cap: input.cap,
        level: input.level,
        findings: [],
        clusters: [],
        units: [],
        failed: [],
        confirmations,
      },
    };

    for (const state of rejectionState(
      [...(input.confirmationRounds ?? []), current],
      input.rulings,
      input.escalationRecords ?? []
    )) {
      if (
        state.state !== "confirmed" &&
        (state.noResponses >= 2 ||
          (state.disagreements >= 2 &&
            confirmations.some(
              (reply) =>
                reply.finding === state.request.finding &&
                reply.decision === "disagree"
            )))
      ) {
        const id = `rejection:${input.review}:${state.request.finding}`;
        escalations.push({
          kind: "escalation",
          by: "tool",
          key: `${id}:R${input.round}:g${input.generation}`,
          data: {
            id,
            state: "open",
            summary:
              state.noResponses >= 2
                ? `An assigned source did not reply to MUST rejection ${
                    state.request.finding
                  } in two consecutive past-cap rounds`
                : `Reviewer disputed MUST rejection ${state.request.finding} ${
                    state.disagreements
                  } consecutive times`,
          },
        });
      }
    }
  }

  for (const finding of findings) {
    const previous = [...input.prior]
      .toReversed()
      .flatMap((round) =>
        round.findings.map((value) => ({ round: round.round, value }))
      )
      .find((prior) => matchFinding(key(prior.value), key(finding)));

    if (!previous) {
      continue;
    }

    const ruling = input.rulings.findLast(
      (row) =>
        row.seq <= input.startSeq &&
        row.data["subject"] === `review:${input.review}:${previous.value.id}`
    );

    const priorTarget = input.priorTargets[previous.round];

    let changed =
      typeof input.target === "string"
        ? input.target !== priorTarget
        : typeof priorTarget !== "string" &&
          input.target.head !== priorTarget?.head;

    if (input.kind === "code" && input.artifact === "integration") {
      const file = finding.locus.replace(/:L\d+$/u, "");

      const owned = Object.values(input.owners ?? {}).find((paths) =>
        paths.includes(file)
      ) ?? [file];

      changed = (input.changedSince?.[previous.round] ?? []).some((candidate) =>
        owned.includes(candidate)
      );
    }

    if (changed && ruling?.data["ruling"] === "accepted") {
      finding.recurrence = { of: previous.value.id };

      const id = `recurrence:${input.review}:${finding.id}:g${
        input.generation
      }`;

      escalations.push({
        kind: "escalation",
        by: "tool",
        key: id,
        data: { id, state: "open", summary: finding.defect },
      });
    } else {
      finding.unresolved = { of: previous.value.id };
    }
  }

  const clusters = new Map<string, string[]>();

  for (const finding of findings) {
    const file =
      input.kind === "code"
        ? finding.locus.replace(/:L\d+$/u, "")
        : input.artifact;

    clusters.set(file, [...(clusters.get(file) ?? []), finding.id]);
  }

  return {
    review: input.review,
    round: input.round,
    cap: input.cap,
    level: input.level,
    findings,
    units: [],
    clusters: [...clusters].map(([file, items]) => ({ file, findings: items })),
    failed: input.replies.filter(
      (reply): reply is Extract<SlotOutcome, { state: "failed" }> =>
        reply.state === "failed"
    ),
    confirmations,
    escalations,
    ...(input.repositoryChanges && {
      repositoryChanges: input.repositoryChanges,
    }),
    ...(input.repositoryCheck && { repositoryCheck: input.repositoryCheck }),
  };
};

// SECTION: Round cause

// Each finding counts once, so the counts partition the saved findings and the primary follows ROUND_CAUSES order.
export type RoundCauseScope = "standard" | "confirmation" | "coverage";

export const roundCause = (input: {
  scope: RoundCauseScope;
  findings: readonly ReviewedFinding[];
  replies: readonly SlotOutcome[];
}): RoundCause => {
  const counts = {
    fixInduced: 0,
    recurring: 0,
    unknownOrigin: 0,
    new: 0,
    failed: input.replies.filter((reply) => reply.state === "failed").length,
  };

  for (const finding of input.findings) {
    if (finding.origin === "fix-induced") {
      counts.fixInduced += 1;
    } else if (finding.recurrence || finding.unresolved) {
      counts.recurring += 1;
    } else if (finding.origin === undefined || finding.origin === "unknown") {
      counts.unknownOrigin += 1;
    } else {
      counts.new += 1;
    }
  }

  const unanswered =
    !input.replies.some((reply) => reply.state === "done") ||
    input.findings.length === 0;

  const primary = (): RoundCause["primary"] => {
    if (counts.failed > 0 && unanswered) {
      return "failed";
    }

    if (input.scope !== "standard") {
      return input.scope;
    }

    if (counts.fixInduced > 0) {
      return "fix-induced";
    }

    if (counts.recurring > 0) {
      return "recurring";
    }

    if (counts.new > 0) {
      return "new";
    }

    return counts.unknownOrigin > 0 ? "unknown-origin" : "clean";
  };

  return { primary: primary(), counts };
};

// SECTION: Step-back marker

export const stepBackMark = (input: {
  round: number;
  units: readonly { unit: string; hotStreak: number }[];
  cause: { counts: { fixInduced: number } } | undefined;
  total: number;
}): StepBack | undefined => {
  if (input.round < 2) {
    return undefined;
  }

  const units = input.units
    .filter((entry) => entry.hotStreak >= 2)
    .map((entry) => entry.unit);

  const count = input.cause?.counts.fixInduced ?? 0;

  const fixInduced: StepBack["fixInduced"] =
    count >= 2 && count * 2 > input.total ? [count, input.total] : undefined;

  return units.length > 0 || fixInduced
    ? { units, ...(fixInduced && { fixInduced }) }
    : undefined;
};

interface FindingUnit {
  unit: string;
  findings: string[];
  hot: boolean;
  hotStreak: number;
  bytes?: number;
  delta?: number;
  growthStreak?: number;
}

interface UnitFinding {
  id: string;
  locus: string;
  defect?: string;
}

interface UnitRound {
  findings: readonly UnitFinding[];
  text?: string;
  startSeq: number;
}

const normalizeHeading = (s: string) =>
  s.toLowerCase().replaceAll(/[–—]/gu, "-").replaceAll(/\s+/gu, " ").trim();

const markdownSections = (text: string | undefined) => {
  if (text === undefined) {
    return [];
  }

  const lines = text.split(/(?<=\n)/u);

  const headings = structuralLines(text).flatMap((line) => {
    const m = /^(?<cap1>#{2,3})\s+(?<cap2>.+?)\s*#*\s*$/u.exec(line.text);

    if (!m) {
      return [];
    }

    // Both groups are mandatory in the pattern.
    const [, marks = "", title = ""] = m;

    const id =
      marks === "###"
        ? /^(?<cap1>T\d+|AD-\d+|I\d+)\b/iu.exec(title)?.[1]?.toUpperCase()
        : undefined;

    return [{ level: marks.length, title, id, line: line.line - 1 }];
  });

  return headings.map((h, i) => ({
    ...h,
    unit: h.id ?? `§ ${h.title}`,
    bytes: Buffer.byteLength(
      lines
        .slice(
          h.line,
          headings.slice(i + 1).find((next) => next.level <= h.level)?.line ??
            lines.length
        )
        .join("")
    ),
  }));
};

export const findingUnits = (input: {
  kind: ReviewKind;
  round: number;
  rounds: readonly UnitRound[];
  planPath: string;
  ruling: (id: string, seq: number) => string | undefined;
}) => {
  const allSections = input.rounds.map((r) => markdownSections(r.text));

  const classify = (finding: UnitFinding, index: number) => {
    if (input.kind === "code") {
      if (finding.defect?.startsWith("missing-red:") === true) {
        return input.planPath.replaceAll("\\", "/");
      }

      if (
        isUnresolvedLocus(finding.locus) ||
        !finding.locus.trim() ||
        finding.locus === "(none)"
      ) {
        return "unresolved";
      }

      return finding.locus.replace(/:L\d+$/u, "").replaceAll("\\", "/");
    }

    const locus = finding.locus
      .replace(/^unresolved-locus:\s*/iu, "")
      .replace(/^§\s*/u, "");

    const spec = /\b(?<cap1>REQ-\d+|DEC-\d+)\b/iu.exec(locus);

    if (spec) {
      return `spec:${String(spec[1]).toUpperCase()}`;
    }

    const namedSpec = /\bSpec:\s*(?<cap1>.+)/iu.exec(locus);

    if (namedSpec) {
      return `spec:${String(namedSpec[1]).trim()}`;
    }

    const headings = allSections[index] ?? [];

    for (const match of locus.matchAll(/\b(?<cap1>T\d+|AD-\d+|I\d+)\b/giu)) {
      const heading = headings.find(
        (h) => h.id === String(match[1]).toUpperCase()
      );

      if (heading) {
        return heading.unit;
      }
    }

    if (/\bSC\d+\b/iu.test(locus)) {
      return "§ Success Criteria";
    }

    const folded = normalizeHeading(locus.replace(/^#{2,3}\s+/u, ""));

    const heading = headings.find((h) => {
      const title = normalizeHeading(h.title);

      const short =
        h.id !== undefined && h.id !== ""
          ? title.replace(/^(?:t\d+|ad-\d+|i\d+)\s*-\s*/u, "")
          : title;

      return !!folded && (folded === title || (!!short && folded === short));
    });

    return heading?.unit ?? "artifact";
  };

  const grouped = input.rounds.map((r, i) => {
    const units = new Map<string, string[]>();

    for (const f of r.findings) {
      const unit = classify(f, i);
      units.set(unit, [...(units.get(unit) ?? []), f.id]);
    }

    return units;
  });

  const hot = (unit: string, index: number) =>
    index > 0 &&
    unit !== "artifact" &&
    unit !== "unresolved" &&
    grouped[index]?.has(unit) === true &&
    (grouped[index - 1]?.get(unit) ?? []).some(
      (id) =>
        input.ruling(
          id,
          present(input.rounds[index], "review round").startSeq
        ) === "accepted"
    );

  const size = (unit: string, index: number) => {
    const text = input.rounds[index]?.text;

    if (text === undefined) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the missing-text and sized branches.
      return undefined;
    }

    return unit === "artifact"
      ? Buffer.byteLength(text)
      : (allSections[index]?.find(
          (h) => h.unit.toLowerCase() === unit.toLowerCase()
        )?.bytes ?? 0);
  };

  const index = input.round - 1;

  return [...(grouped[index] ?? new Map<string, string[]>())].map(
    ([unit, findings]) => {
      let hotStreak = 0;

      for (let i = index; i >= 0 && hot(unit, i); i -= 1) {
        hotStreak += 1;
      }

      const result: FindingUnit = {
        unit,
        findings,
        hot: hotStreak > 0,
        hotStreak,
      };

      if (input.kind !== "code" && !unit.startsWith("spec:")) {
        const bytes = size(unit, index);

        if (bytes !== undefined) {
          result.bytes = bytes;
          const previous = index > 0 ? size(unit, index - 1) : undefined;

          if (previous !== undefined) {
            result.delta = bytes - previous;
          }

          let growth = 0;

          for (let i = index; i > 0; i -= 1) {
            const a = size(unit, i);
            const b = size(unit, i - 1);

            if (a === undefined || b === undefined || a <= b) {
              break;
            }

            growth += 1;
          }

          result.growthStreak = growth;
        }
      }

      return result;
    }
  );
};

// SECTION: Review budget
const CEILING_GRANT = /^(?:re-author|model-effort|relax-split):/u;

/**
 * cap₁ + 2 + 2 × R, where R counts ceiling ids that a tool opened and a later quoted user grant resolved.
 * Close and defer grant nothing and apply only to the current ceiling id.
 */
const ceilingState = (
  records: readonly LedgerRecord[],
  review: string,
  cap1: number
) => {
  const prefix = `ceiling:${review}:`;

  const opened = new Map<string, number>();
  const state = new Map<string, string>();
  const grants = new Set<string>();
  const defers = new Set<string>();

  for (const row of records) {
    if (row.kind !== "escalation") {
      continue;
    }

    const id: unknown = row.data["id"];

    if (typeof id !== "string" || !id.startsWith(prefix)) {
      continue;
    }

    state.set(id, textValue(row.data["state"]));

    if (row.by === "tool" && row.data["state"] === "open" && !opened.has(id)) {
      opened.set(id, row.seq);
    }

    if (
      row.by !== "user" ||
      row.data["state"] !== "resolved" ||
      row.quote?.trim() === undefined ||
      row.quote.trim() === "" ||
      row.seq <= (opened.get(id) ?? Infinity)
    ) {
      continue;
    }

    // oxlint-disable-next-line typescript/no-base-to-string -- summary is an unvalidated JSON field; String coerces nullish to text.
    const summary = String(row.data["summary"] ?? "");

    if (CEILING_GRANT.test(summary)) {
      grants.add(id);
    } else if (summary.startsWith("close:") || summary.startsWith("defer:")) {
      defers.add(id);
    }
  }

  const ceiling = cap1 + 2 + 2 * grants.size;

  return {
    ceiling,
    deferred: defers.has(prefix + ceiling),
    open: [...state.values()].includes("open"),
  };
};

type BudgetCoverage =
  | {
      state: "readable";
      open: string[];
      decision: CoverageDecision;
      use?: "free" | "grant";
    }
  | { state: "unreadable" };

export interface ReviewBudget {
  cap: number;
  ceiling: number;
  nextRound: number;
  asOfSeq: number;
  state:
    | "allowed"
    | "requires-continuation"
    | "requires-ceiling-resolution"
    | "escalation-open"
    | "requires-coverage-decision";
  coverage?: BudgetCoverage;
}

/** The single admission policy: launch refuses by `state`; status and summaries only report it, opening and granting nothing. */
// Every content report for a round with its durable identity: findings.json
// first, then each generation in numeric order and each attempt file in
// numeric order. A clean generation contributes no identity. A report without
// a numeric asOfSeq keeps identity 0.
interface ReportContent {
  seq: number;
  repositoryChanges?: RepositoryChange[];
  repositoryCheck?: RepositoryCheckState;
}

const genNumber = (name: string) => Number(name.slice(4));

// oxlint-disable-next-line eslint/complexity -- content scan branches per generation directory, findings presence, and checkout fallback.
export const contentReports = (
  session: string,
  review: string,
  round: number
) => {
  const out: ReportContent[] = [];
  const dir = reviewRoundDirectory(reviewDirectory(session, review), round);

  const findings = readStoredJson<
    FindingsValue & { asOfSeq?: number; budget?: { asOfSeq?: number } }
  >(reviewFindingsFile(dir));

  const findingsHas =
    (Array.isArray(findings?.repositoryChanges) &&
      findings.repositoryChanges.length > 0) ||
    !!findings?.repositoryCheck;

  // The finalized findings copy carries the same durable identity as its
  // per-generation checkout report: finalize persists asOfSeq into
  // findings.json, so one per-report decision closes both copies. The budget
  // fallback covers older and hand-written files.
  let findingsSeq = 0;

  if (typeof findings?.asOfSeq === "number") {
    findingsSeq = findings.asOfSeq;
  } else if (typeof findings?.budget?.asOfSeq === "number") {
    findingsSeq = findings.budget.asOfSeq;
  }

  if (findingsHas) {
    out.push({
      seq: findingsSeq,
      ...(findings?.repositoryChanges && {
        repositoryChanges: findings.repositoryChanges,
      }),
      ...(findings?.repositoryCheck && {
        repositoryCheck: findings.repositoryCheck,
      }),
    });
  }

  let entries: string[];

  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }

  for (const entry of entries
    .filter((name) => /^gen-\d+$/u.test(name))
    .toSorted((left, right) => genNumber(left) - genNumber(right))) {
    for (const report of checkoutReportsFor(dir, entry)) {
      const reportHas =
        (Array.isArray(report?.repositoryChanges) &&
          report.repositoryChanges.length > 0) ||
        !!report?.repositoryCheck;

      if (!reportHas) {
        continue;
      }

      out.push({
        seq: typeof report?.asOfSeq === "number" ? report.asOfSeq : 0,
        ...(Array.isArray(report?.repositoryChanges) &&
          report.repositoryChanges.length > 0 && {
            repositoryChanges: report.repositoryChanges,
          }),
        ...(report?.repositoryCheck && {
          repositoryCheck: report.repositoryCheck,
        }),
      });
    }
  }

  return out;
};

/** Numeric identities of every content report for a round, ascending. */
export const reportSeqs = (session: string, review: string, round: number) =>
  [
    ...new Set(
      contentReports(session, review, round).map((report) => report.seq)
    ),
  ].toSorted((left, right) => left - right);

/** Closing decisions for a round: per-report suffixed keys. */
export const closingNotesFor = (fold: Fold, review: string, round: number) => {
  const out: { seq: number; reportSeq: number }[] = [];

  for (const row of fold.records) {
    if (row.kind !== "note" || typeof row.key !== "string") {
      continue;
    }

    const parsed = parseRepositoryNoteKey(row.key);

    if (
      !parsed ||
      parsed.kind !== "changes" ||
      parsed.review !== review ||
      parsed.round !== round
    ) {
      continue;
    }

    out.push({ seq: row.seq, reportSeq: parsed.reportSeq });
  }

  return out;
};

/** Quoted user rerun decisions for a round, per-report suffixed. */
export const rerunNotesFor = (fold: Fold, review: string, round: number) => {
  const out: { seq: number; reportSeq: number }[] = [];

  for (const row of fold.records) {
    if (row.kind !== "note" || typeof row.key !== "string") {
      continue;
    }

    const parsed = parseRepositoryNoteKey(row.key);

    if (
      !parsed ||
      parsed.kind !== "rerun" ||
      parsed.review !== review ||
      parsed.round !== round
    ) {
      continue;
    }

    if (
      row.by !== "user" ||
      row.quote?.trim() === undefined ||
      row.quote.trim() === ""
    ) {
      continue;
    }

    out.push({ seq: row.seq, reportSeq: parsed.reportSeq });
  }

  return out;
};

// A suffixed note covers only its named report and needs a strictly later
// note sequence, so an equal-seq report under a reused number stays open.
export const coversReport = (
  note: { seq: number; reportSeq: number },
  seq: number
) => note.reportSeq === seq && note.seq > seq;

/** A round is closed only when every content report has a covering decision. */
export const isReportsClosed = (
  fold: Fold,
  review: string,
  round: number,
  seqs: readonly number[]
) => {
  if (!seqs.length) {
    return false;
  }

  const notes = closingNotesFor(fold, review, round);

  return seqs.every((seq) => notes.some((note) => coversReport(note, seq)));
};

// The report a rerun decision acknowledges is its explicit suffix. A later
// report under the same number matches no stale decision.
export const rerunCoverSeq = (
  session: string,
  review: string,
  round: number,
  note: { seq: number; reportSeq: number }
) => note.reportSeq;

/** A rerun decision grants only the latest uncovered report of its round: a
 * quoted decision for an earlier or already-closed report grants
 * nothing for the still-open one. */
export const rerunGranted = (
  session: string,
  fold: Fold,
  review: string,
  round: number
) => {
  const seqs = reportSeqs(session, review, round);

  if (!seqs.length) {
    return false;
  }

  const notes = closingNotesFor(fold, review, round);

  const uncovered = seqs.filter(
    (seq) => !notes.some((note) => coversReport(note, seq))
  );

  if (!uncovered.length) {
    return false;
  }

  const current = Math.max(...uncovered);

  return rerunNotesFor(fold, review, round).some(
    (note) => rerunCoverSeq(session, review, round, note) === current
  );
};

// Rerun admission counts per-report suffixed decisions: the shared
// repository-note parser recognizes the suffixed key form, so a documented
// suffixed decision grants its round. The pre-gate stays because admission
// and isRerunRound scope the grant to one named round before binding it to
// the current report via rerunGranted.
export const repositoryRerunRounds = (fold: Fold, review: string) => {
  const rounds: number[] = [];

  for (const row of fold.records) {
    if (row.kind !== "note" || typeof row.key !== "string") {
      continue;
    }

    const parsed = parseRepositoryNoteKey(row.key);

    if (!parsed || parsed.kind !== "rerun" || parsed.review !== review) {
      continue;
    }

    if (
      row.by !== "user" ||
      row.quote?.trim() === undefined ||
      row.quote.trim() === ""
    ) {
      continue;
    }

    rounds.push(parsed.round);
  }

  return rounds;
};

// Every unacknowledged report file of one generation: the first write lands in
// checkout-report.json and each retry in checkout-report-<k>.json, so a later
// clean comparison never erases an earlier report. Numeric attempt order.
// The tool writes these files, so the stored read trusts their field shapes as it does findings.json.
interface CheckoutReportRead {
  repositoryChanges?: RepositoryChange[];
  repositoryCheck?: RepositoryCheckState;
  asOfSeq?: number;
}

const attemptNumber = (file: string) =>
  file === "checkout-report.json"
    ? 1
    : Number(file.slice("checkout-report-".length, -".json".length));

export const checkoutReportsFor = (dir: string, gen: string) => {
  let files: string[];

  try {
    files = fs.readdirSync(path.join(dir, gen));
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") {
      throw error;
    }

    return [];
  }

  return files
    .filter((file) => /^checkout-report(?<cap1>-\d+)?\.json$/u.test(file))
    .toSorted((left, right) => attemptNumber(left) - attemptNumber(right))
    .map((file) =>
      readStoredJson<CheckoutReportRead>(path.join(dir, gen, file))
    )
    .filter((report): report is CheckoutReportRead => report !== null);
};

// oxlint-disable-next-line eslint/complexity -- admission branches per review state, cap bound, coverage decision, and continuation window.
export const admission = (
  session: string,
  fold: Fold,
  review: string,
  cap: number,
  applies?: CoverageApplies
) => {
  const directory = reviewDirectory(session, review);
  const roundDir = (round: number) => reviewRoundDirectory(directory, round);

  const numbers = reviewRoundEntries(fs.readdirSync(directory)).map(
    (entry) => entry.number
  );

  const last = numbers.at(-1) ?? 0;
  // An all-failed round has no findings.json but keeps its failed report: a
  // quoted rerun note naming it completes its number, so the next call starts
  // the authorized fresh whole-target rerun instead of retrying failed fan-out.
  let completed = last > 0 && fs.existsSync(reviewFindingsFile(roundDir(last)));

  if (
    !completed &&
    last > 0 &&
    repositoryRerunRounds(fold, review).includes(last)
  ) {
    const seqs = reportSeqs(session, review, last);

    if (
      seqs.length &&
      !isReportsClosed(fold, review, last, seqs) &&
      rerunGranted(session, fold, review, last)
    ) {
      completed = true;
    }
  }

  const n = completed ? last + 1 : last || 1;

  const cap1 =
    readStoredJson<{ cap: number }>(reviewRoundFile(roundDir(1)))?.cap ?? cap;

  const ceiling = ceilingState(fold.records, review, cap1);

  const rulings = fold.records.filter((row) => row.kind === "ruling");

  const startSeq =
    readStoredJson<{ startSeq?: number }>(reviewRoundFile(roundDir(n - 1)))
      ?.startSeq ?? 0;

  const rejections = loadRejections(session, fold, [review]);
  const pending = rejections.some((state) => state.state === "pending");

  const fixed = numbers.some(
    (number) =>
      readStoredJson<FindingsValue>(
        reviewFindingsFile(roundDir(number))
      )?.findings.some((finding) => {
        const history = rulings.filter(
          (row) => row.data["subject"] === `review:${review}:${finding.id}`
        );

        const ruling = history.at(-1);

        return (
          effectiveSeverity(finding, history) === "MUST" &&
          ruling?.data["ruling"] === "accepted" &&
          (number === n - 1 || ruling.seq > startSeq)
        );
      }) === true
  );

  const past = completed && n > ceiling.ceiling;

  // Close and defer grant no rounds; a pending MUST rejection keeps its confirmation round.
  let state: ReviewBudget["state"] = "allowed";

  if (
    rejections.some((rejection) => rejection.state === "escalated") ||
    (completed && ceiling.open)
  ) {
    state = "escalation-open";
  } else if (
    n > cap1 &&
    ((!fixed && !pending) || (past && ceiling.deferred && !pending))
  ) {
    state = "requires-continuation";
  } else if (past && !ceiling.deferred) {
    state = "requires-ceiling-resolution";
  }

  // A user rerun note admits its named round + 1 once above the cap and below the
  // ceiling. Escalation and ceiling checks above stay first; other rounds keep no grant.
  if (state === "requires-continuation" && n > cap1 && n <= ceiling.ceiling) {
    const reruns = repositoryRerunRounds(fold, review);
    const seqs = reportSeqs(session, review, n - 1);

    if (
      reruns.includes(n - 1) &&
      seqs.length > 0 &&
      !isReportsClosed(fold, review, n - 1, seqs) &&
      rerunGranted(session, fold, review, n - 1)
    ) {
      state = "allowed";
    }
  }

  // SECTION: Coverage rows (code-integration only); escalation, ceiling and accepted-MUST rules stay first.
  let coverage: BudgetCoverage | undefined;
  let folded: CoverageState | undefined;
  let use: "free" | "grant" | undefined;

  if (review === INTEGRATION_REVIEW) {
    try {
      folded = coverageState(session, fold, review, applies);
    } catch (error) {
      if (
        !(error instanceof ToolError && error.reason === "coverage-required")
      ) {
        throw error;
      }

      coverage = { state: "unreadable" };
    }
  }

  if (folded) {
    const saved =
      folded.incomplete === n
        ? readStoredJson<{ coverageUse?: "free" | "grant" }>(
            reviewRoundFile(roundDir(n))
          )?.coverageUse
        : undefined;

    if ((state === "allowed" || state === "requires-continuation") && !past) {
      if (saved) {
        state = "allowed";
        use = saved;
      } else if (!fixed && !pending && folded.open.length && n !== last) {
        const grant = folded.unusedGrant ? ("grant" as const) : undefined;

        if (folded.decision === "user") {
          [state, use] = grant
            ? ["allowed", grant]
            : ["requires-coverage-decision", undefined];
        } else if (n <= cap1) {
          state = "allowed";
        } else if (!folded.freeUsed) {
          [state, use] = ["allowed", "free"];
        } else if (grant) {
          [state, use] = ["allowed", grant];
        } else if (folded.decision === "rerun") {
          state = "requires-coverage-decision";
        }
      }
    }
    // NOTE: past the ceiling no round can run, so only the user's accept can settle a slot that delivery refuses.
    else if (
      state === "requires-continuation" &&
      past &&
      folded.open.length &&
      folded.decision !== "majority"
    ) {
      state = "requires-coverage-decision";
    }

    if (folded.open.length || folded.incomplete !== null) {
      coverage = {
        state: "readable",
        open: folded.open,
        decision: folded.decision,
        ...(use && { use }),
      };
    }
  }

  return {
    budget: {
      cap: cap1,
      ceiling: ceiling.ceiling,
      nextRound: n,
      asOfSeq: fold.lastSeq,
      state,
      ...(coverage && { coverage }),
    },
    rounds: numbers.length,
  };
};

export const renderBudget = (budget: ReviewBudget) => {
  let coverageSuffix = "";

  if (budget.coverage) {
    coverageSuffix =
      budget.coverage.state === "unreadable"
        ? "; coverage unreadable"
        : `; coverage ${budget.coverage.decision}, open: ${budget.coverage.open.join(", ") || "none"}`;
  }

  return `next round ${budget.nextRound} ${budget.state} (cap ${budget.cap}, ceiling ${budget.ceiling})${coverageSuffix}`;
};
