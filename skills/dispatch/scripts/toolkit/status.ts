import fs from "node:fs";
import path from "node:path";

import { isRecord } from "../lib/config.ts";
import type { JsonObject } from "../lib/config.ts";
import { nodeErrorCode } from "../lib/fs-ext.ts";
import { readManifest } from "../lib/session.ts";
import type { CliDeps, HandlerContext } from "./cli.ts";
import { applicableReviewIds, loadRejections } from "./confirmations.ts";
import { safeRelativePath } from "./domain/context.ts";
import { parsePlan } from "./domain/plan.ts";
import { effectiveSeverity } from "./domain/severity.ts";
import type { ParsedPlan } from "./domain/types.ts";
import {
  cleanupBinding,
  latestCleanup,
  criterionStatuses,
  eligibility,
  strictEvidence,
} from "./evidence.ts";
import type { CriterionStatus } from "./evidence.ts";
import { parsePinsFlag } from "./fanout.ts";
import type { SlotOutcome } from "./fanout.ts";
import type { FanoutState } from "./fanout/state.ts";
import {
  admission,
  contentReports,
  closingNotesFor,
  rerunNotesFor,
  rerunCoverSeq,
  coversReport,
} from "./findings.ts";
import type { ReviewBudget, FindingsValue } from "./findings.ts";
import { gitOk, headTree, testedTree } from "./git.ts";
import {
  currentRuntimeVerification,
  integrationEnded,
  integrationRecord,
} from "./integration-state.ts";
import {
  containedSessionPath,
  currentHashes,
  foldLedger,
  gate,
  gitObjectId,
  hasCleanupCheckpoint,
  latest,
  levelGate,
} from "./ledger.ts";
import type { Fold } from "./ledger.ts";
import { isLevel, present, textValue } from "./narrow.ts";
import { ToolError } from "./output.ts";
import { checks, taskCriteria } from "./plan-view.ts";
import { captureReviewTarget } from "./review-capture.ts";
import { reviewIdentity } from "./review-identity.ts";
import {
  INTEGRATION_REVIEW as REVIEW,
  recoveryTargetHash,
  reviewDirectory,
  reviewRoot,
  reviewRoundDirectory,
  reviewRoundFile,
  reviewFindingsFile,
  reviewGenerationDirectory,
  reviewPointer,
  sameReviewCapture,
  reviewRulingSnapshot,
  reviewRoundEntries,
  reviewRoundNumber,
} from "./review-state.ts";
import type { RecoverySelection, Round } from "./review-state.ts";
import { writerStates } from "./writers.ts";

interface Unavailable {
  state: string;
  reason: string;
}

interface IntegrationView {
  source: unknown;
  to: null;
  path: unknown;
  branch: unknown;
  head: string | null;
  state: string;
  pendingConflict: unknown;
  undelivered: boolean;
  closed: boolean;
}

interface StatusSections {
  writers: ReturnType<typeof writerStates> | Unavailable;
  integration: IntegrationView | Unavailable | null;
  criteria: string[] | Unavailable;
  criterionStatuses: CriterionStatus[];
}

type StoredPathCheck =
  | { ok: true; cwd: string; exists: boolean }
  | { ok: false; reason: string };

const isContainedInside = (
  base: string,
  target: string,
  allowSelf: boolean
) => {
  const remainder = path.relative(base, target);

  if (remainder === "") {
    return allowSelf;
  }

  return (
    remainder !== ".." &&
    !remainder.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(remainder)
  );
};

const unreadablePath = (label: string, error: unknown): StoredPathCheck => ({
  ok: false,
  reason: `${label}: ${error instanceof Error ? error.message : String(error)}`,
});

// Check lexical bounds and realpath containment before any Git call; ENOENT means absent, not an escape, unless a symlink exists.
const inspectStoredPath = (
  session: string,
  relative: string
): StoredPathCheck => {
  if (
    !safeRelativePath(relative) ||
    relative !== path.posix.normalize(relative)
  ) {
    return {
      ok: false,
      reason: `Stored path escapes session: ${relative}`,
    };
  }

  const resolvedSession = path.resolve(session);
  const resolved = path.resolve(resolvedSession, relative);

  if (!isContainedInside(resolvedSession, resolved, false)) {
    return {
      ok: false,
      reason: `Stored path escapes session: ${relative}`,
    };
  }

  let realSession: string;

  try {
    realSession = fs.realpathSync(resolvedSession);
  } catch (error) {
    return unreadablePath(`Session path unreadable for ${relative}`, error);
  }

  try {
    const realTarget = fs.realpathSync(resolved);

    if (!isContainedInside(realSession, realTarget, false)) {
      return {
        ok: false,
        reason: `Stored path escapes session: ${relative}`,
      };
    }

    return { ok: true, cwd: resolved, exists: true };
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") {
      return unreadablePath(`Stored path unreadable (${relative})`, error);
    }
  }

  // A broken symlink fails realpath with ENOENT while lstat still sees the link entry.
  for (
    let probe = resolved;
    probe !== resolvedSession &&
    isContainedInside(resolvedSession, probe, false);
    probe = path.dirname(probe)
  ) {
    if (probe !== resolved) {
      try {
        const realAncestor = fs.realpathSync(probe);

        if (!isContainedInside(realSession, realAncestor, true)) {
          return {
            ok: false,
            reason: `Stored path escapes session: ${relative}`,
          };
        }

        break;
      } catch (error) {
        if (nodeErrorCode(error) !== "ENOENT") {
          return unreadablePath(`Stored path unreadable (${relative})`, error);
        }
      }
    }

    try {
      fs.lstatSync(probe);

      return {
        ok: false,
        reason: `Stored path is a broken symlink: ${relative}`,
      };
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") {
        return unreadablePath(`Stored path unreadable (${relative})`, error);
      }
    }
  }

  return { ok: true, cwd: resolved, exists: false };
};

interface CriteriaResult {
  criteria: string[] | Unavailable;
  criterionStatuses: CriterionStatus[];
}

interface DerivedSections {
  plan: ParsedPlan | undefined;
  sections: Omit<StatusSections, "criteria" | "criterionStatuses"> | undefined;
  writerPathRejected: boolean;
  integrationPathRejected: boolean;
  loadCriteria: () => Promise<CriteriaResult> | CriteriaResult;
}

// oxlint-disable-next-line eslint/complexity -- shared section derivation validates stored paths and observes writer, integration, and criteria state.
const deriveStatusSections = async (
  session: string,
  repositoryRoot: string,
  deps: CliDeps,
  fold: Fold
): Promise<DerivedSections> => {
  const opened = integrationRecord(fold);
  const hasWriters = fold.records.some((record) => record.kind === "writer");

  if (!opened && !hasWriters) {
    return {
      plan: undefined,
      sections: undefined,
      writerPathRejected: false,
      integrationPathRejected: false,
      loadCriteria: () => ({ criteria: [], criterionStatuses: [] }),
    };
  }

  const bound = latest(fold, "bind")?.data ?? {};
  let plan: ParsedPlan | undefined;
  let reason = "No bound plan";

  if (typeof bound["plan"] === "string" && bound["plan"] !== "") {
    try {
      const planPath = path.resolve(repositoryRoot, textValue(bound["plan"]));
      const parsed = parsePlan(fs.readFileSync(planPath, "utf-8"));

      if (parsed.ok) {
        ({ plan } = parsed);
      } else {
        reason = JSON.stringify(parsed.defects);
      }
    } catch (error) {
      reason = `Bound plan unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  const unavailable = { state: "unavailable", reason };

  const checkedWriters = new Map<string, StoredPathCheck>();
  let rejectedWriterReason: string | undefined;

  for (const record of fold.records) {
    if (record.kind !== "writer" || record.data["phase"] !== "launched") {
      continue;
    }

    const relative = textValue(record.data["path"]);

    if (checkedWriters.has(relative)) {
      continue;
    }

    const checked = inspectStoredPath(session, relative);
    checkedWriters.set(relative, checked);

    if (!checked.ok && rejectedWriterReason === undefined) {
      rejectedWriterReason = checked.reason;
    }
  }

  const observations = new Map<
    string,
    { exists: boolean; dirty: boolean; head: string }
  >();

  if (plan && rejectedWriterReason === undefined) {
    for (const [relative, checked] of checkedWriters) {
      if (!checked.ok) {
        continue;
      }

      const { cwd, exists } = checked;
      observations.set(relative, {
        exists,
        dirty: exists
          ? // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
            !!(await gitOk(deps, cwd, ["status", "--porcelain"]))
          : false,
        // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
        head: exists ? await gitOk(deps, cwd, ["rev-parse", "HEAD"]) : "",
      });
    }
  }

  let writers: ReturnType<typeof writerStates> | Unavailable;

  if (rejectedWriterReason !== undefined) {
    writers = { state: "unavailable", reason: rejectedWriterReason };
  } else if (plan) {
    writers = writerStates(
      fold,
      plan.tasks.map((task) => task.id),
      (relative) =>
        present(observations.get(relative), "the observed writer worktree")
    );
  } else {
    writers = unavailable;
  }

  let integration: IntegrationView | Unavailable | null = null;
  let integrationPathRejected = false;

  let loadCriteria: () => Promise<CriteriaResult> | CriteriaResult = () => ({
    criteria: plan ? checks(plan).map((check) => check.criterion) : unavailable,
    criterionStatuses: [],
  });

  if (opened) {
    const checkedIntegration = inspectStoredPath(
      session,
      textValue(opened.data["path"])
    );

    if (checkedIntegration.ok) {
      const { cwd, exists } = checkedIntegration;

      const head = exists
        ? await gitOk(deps, cwd, ["rev-parse", "HEAD"])
        : null;

      const started = fold.records.findLast(
        (record) =>
          record.kind === "integrate" && record.data["phase"] === "started"
      );

      const pending =
        started !== undefined &&
        !integrationEnded(fold, textValue(started.data["task"]), started.seq);

      const conflict = pending
        ? (fold.records.findLast(
            (record) =>
              record.kind === "integrate" &&
              record.data["phase"] === "conflict" &&
              record.seq > started.seq
          )?.data ?? null)
        : null;

      const delivered = fold.records.findLast(
        (record) =>
          record.kind === "integrate" && record.data["phase"] === "delivered"
      );

      integration = {
        source: delivered?.data["source"] ?? null,
        to: null,
        path: opened.data["path"],
        branch: opened.data["branch"],
        head,
        state: exists ? "present" : "missing",
        pendingConflict: conflict,
        undelivered:
          head !== null &&
          head !== (delivered?.data["source"] ?? opened.data["base"]),
        closed: fold.records.some(
          (record) =>
            record.kind === "integrate" &&
            record.data["phase"] === "closed" &&
            record.seq > opened.seq
        ),
      };

      if (exists && plan) {
        const activePlan = plan;

        loadCriteria = async () => {
          try {
            const tree = {
              headTree: await headTree(deps, cwd),
              testedTree: await testedTree(deps, session, cwd),
            };

            const cleanup = cleanupBinding(fold);
            const all = checks(activePlan);

            const evidenceStatuses = criterionStatuses(
              fold,
              all,
              tree,
              cleanup
            );

            const kept = eligibility(
              fold,
              all.filter(
                (check) => cleanup?.removed.includes(check.criterion) !== true
              ),
              tree
            );

            const criteria = all
              .map(
                (check) =>
                  evidenceStatuses.find(
                    (row) =>
                      row.criterion === check.criterion &&
                      cleanup?.removed.includes(check.criterion) === true
                  ) ??
                  present(
                    kept.find((row) => row.criterion === check.criterion),
                    "the criterion eligibility"
                  )
              )
              .filter((row) => row.state !== "verified")
              .map((row) => row.criterion);

            return { criteria, criterionStatuses: evidenceStatuses };
          } catch {
            return {
              criteria: checks(activePlan).map((c) => c.criterion),
              criterionStatuses: [],
            };
          }
        };
      }
    } else {
      integrationPathRejected = true;

      const unavailableIntegration = {
        state: "unavailable",
        reason: checkedIntegration.reason,
      };

      integration = unavailableIntegration;

      loadCriteria = () => ({
        criteria: unavailableIntegration,
        criterionStatuses: [],
      });
    }
  }

  return {
    plan,
    sections: { writers, integration },
    writerPathRejected: rejectedWriterReason !== undefined,
    integrationPathRejected,
    loadCriteria,
  };
};

// oxlint-disable-next-line eslint/complexity -- status assembly branches per ledger-record kind, review directory entry, and admission outcome.
export const statusReport = async (
  session: string,
  repositoryRoot: string,
  deps: CliDeps,
  fold: Fold = foldLedger(session)
) => {
  const level = textValue(latest(fold, "level")?.data["level"] ?? "medium");
  const bound = latest(fold, "bind")?.data ?? {};
  const current = currentHashes(repositoryRoot, bound);
  const escalations = new Map<string, JsonObject>();

  for (const record of fold.records) {
    if (record.kind === "escalation") {
      escalations.set(textValue(record.data["id"]), record.data);
    }
  }

  // Advisory and recomputed from the latest ledger by the launch admission policy; it opens and grants nothing.
  const root = reviewRoot(session);
  const reviews: Record<string, ReviewBudget> = {};

  const openRepositoryChanges: {
    review: string;
    round: number;
    reportSeq: number;
    repositoryChanges?: unknown;
    repositoryCheck?: unknown;
    rerunPending?: true;
  }[] = [];

  for (const entry of fs.existsSync(root)
    ? fs.readdirSync(root, { withFileTypes: true })
    : []) {
    if (!entry.isDirectory()) {
      continue;
    }

    const review = entry.name;

    const { budget, rounds } = admission(
      session,
      fold,
      review,
      0,
      applicableReviewIds(readManifest(session), fold).get(review)
    );

    if (rounds) {
      reviews[review] = budget;
    }

    const reviewDir = path.join(root, review);
    let roundDirs: string[];

    try {
      roundDirs = fs.readdirSync(reviewDir);
    } catch {
      continue;
    }

    const readRoundMeta = (round: number) => {
      try {
        const meta: unknown = JSON.parse(
          fs.readFileSync(
            reviewRoundFile(reviewRoundDirectory(reviewDir, round)),
            "utf-8"
          )
        );

        if (
          !isRecord(meta) ||
          typeof meta["startSeq"] !== "number" ||
          !Array.isArray(meta["roster"])
        ) {
          // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the invalid-meta and parsed branches.
          return undefined;
        }

        return {
          startSeq: meta["startSeq"],
          roster: meta["roster"].flatMap((slot) =>
            isRecord(slot) &&
            (slot["reserve"] === undefined ||
              slot["reserve"] === null ||
              slot["reserve"] === false ||
              slot["reserve"] === "" ||
              slot["reserve"] === 0)
              ? [textValue(slot["slot"])]
              : []
          ),
          ...(typeof meta["scope"] === "string" && { scope: meta["scope"] }),
          ...(meta["coverage"] !== undefined && { coverage: meta["coverage"] }),
        };
      } catch {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the parsed and unreadable branches.
        return undefined;
      }
    };

    for (const roundName of roundDirs) {
      const round = reviewRoundNumber(roundName);

      if (round === undefined) {
        continue;
      }

      // Every content report carries its own identity; covered reports drop
      // out before the merge, so one map accumulates every unacknowledged
      // attempt and generation together with the finalized findings report.
      const contents = contentReports(session, review, round);

      if (!contents.length) {
        continue;
      }

      const covered = (seq: number) =>
        closingNotesFor(fold, review, round).some((note) =>
          coversReport(note, seq)
        );

      const satisfiedFor = (seq: number) => {
        if (
          !rerunNotesFor(fold, review, round).some(
            (note) => rerunCoverSeq(session, review, round, note) === seq
          )
        ) {
          return false;
        }

        if (
          !fs.existsSync(
            reviewFindingsFile(reviewRoundDirectory(reviewDir, round + 1))
          )
        ) {
          return false;
        }

        const opened = readRoundMeta(round + 1);
        const required = readRoundMeta(round)?.roster;

        const wholeTarget =
          opened?.scope?.startsWith("Full review") === true ||
          opened?.coverage !== undefined;

        return (
          opened !== undefined &&
          required !== undefined &&
          wholeTarget &&
          opened.startSeq >=
            Math.max(
              ...rerunNotesFor(fold, review, round)
                .filter(
                  (note) => rerunCoverSeq(session, review, round, note) === seq
                )
                .map((note) => note.seq)
            ) &&
          required.every((target) => opened.roster.includes(target))
        );
      };

      const uncovered = contents.filter(
        (report) => !covered(report.seq) && !satisfiedFor(report.seq)
      );

      if (!uncovered.length) {
        continue;
      }

      const pathsByCwd = new Map<string, Set<string>>();

      for (const report of uncovered) {
        if (!Array.isArray(report.repositoryChanges)) {
          continue;
        }

        // SAFETY: the Array.isArray guard above narrows repositoryChanges to an array; the assertion only names the element fields validated below.
        for (const change of report.repositoryChanges as {
          cwd?: unknown;
          paths?: unknown;
        }[]) {
          if (
            typeof change?.cwd !== "string" ||
            !Array.isArray(change?.paths)
          ) {
            continue;
          }

          const paths = pathsByCwd.get(change.cwd) ?? new Set<string>();

          for (const file of change.paths) {
            if (typeof file === "string") {
              paths.add(file);
            }
          }

          pathsByCwd.set(change.cwd, paths);
        }
      }

      let check: unknown;

      for (const report of uncovered) {
        if (report.repositoryCheck) {
          check = report.repositoryCheck;
        }
      }

      const reportSeq = Math.max(...uncovered.map((report) => report.seq));

      // A rerun decision binds only its covered report, and only while round
      // r+1 is unfinalized: past that window the report stays open for a
      // repository-changes note, with no lingering rerunPending.
      const nextOpen = !fs.existsSync(
        reviewFindingsFile(reviewRoundDirectory(reviewDir, round + 1))
      );

      const covering =
        nextOpen &&
        rerunNotesFor(fold, review, round).some(
          (note) => rerunCoverSeq(session, review, round, note) === reportSeq
        );

      const rerunPending = covering ? { rerunPending: true as const } : {};
      openRepositoryChanges.push({
        review,
        round,
        reportSeq,
        ...(pathsByCwd.size && {
          repositoryChanges: [...pathsByCwd].map(([cwd, paths]) => ({
            cwd,
            paths: [...paths].toSorted(),
          })),
        }),
        ...(Boolean(check) && { repositoryCheck: check }),
        ...rerunPending,
      });
    }
  }

  openRepositoryChanges.sort((left, right) => {
    if (left.review < right.review) {
      return -1;
    }

    if (left.review > right.review) {
      return 1;
    }

    return left.round - right.round;
  });

  const derived = await deriveStatusSections(
    session,
    repositoryRoot,
    deps,
    fold
  );

  const sections: StatusSections | undefined = derived.sections
    ? { ...derived.sections, ...(await derived.loadCriteria()) }
    : undefined;

  return {
    level,
    bound,
    current,
    approved: latest(fold, "approval")?.data ?? {},
    gate: gate(fold, current, level),
    escalations: [...escalations.values()].filter(
      (record) => record["state"] === "open"
    ),
    reviews,
    recordCount: fold.records.length,
    tornTail: fold.torn !== null,
    ...(openRepositoryChanges.length && { openRepositoryChanges }),
    testCleanup: (() => {
      const row = latestCleanup(fold);

      return row
        ? {
            from: row.data["from"],
            trees: row.data["trees"],
            removed: row.data["removed"],
            deleted: row.data["deleted"],
            merged: row.data["merged"],
          }
        : null;
    })(),
    ...sections,
  };
};

export const RESUME_ROUTES = {
  // pre-integration
  "plan-pending": { next: "continue", action: "plan" },
  "approval-pending": { next: "inspect", action: "approval" },
  "baseline-pending": { next: "continue", action: "check run" },
  // open integration, no review round (task reasons append " <task>")
  "integration-conflict": { next: "inspect", action: "worktree continue" },
  "integration-abandoned": { next: "inspect", action: "worktree create" },
  "task-check-pending": { next: "inspect", action: "check run --task" },
  "candidate-ready": { next: "continue", action: "worktree land" },
  "worktree-missing": { next: "continue", action: "worktree create" },
  "writer-open": { next: "inspect", action: "writer" },
  "task-ready": { next: "continue", action: "worktree create" },
  "checks-pending": { next: "continue", action: "check run" },
  "verification-pending": { next: "continue", action: "brief verifier" },
  "cleanup-pending": { next: "continue", action: "test-cleanup" },
  "review-pending": { next: "review", action: "review run" },
  // integration ended
  "delivery-pending": { next: "continue", action: "worktree deliver" },
  delivered: { next: "continue", action: "report complete" },
  closed: { next: "inspect", action: "worktree cleanup" },
  // existing reasons: next unchanged
  "state-unreadable": { next: "inspect", action: "status show" },
  "gate-blocked": { next: "inspect", action: "status show" },
  "native-pending": { next: "inspect", action: "review run" },
  "arguments-unavailable": { next: "inspect", action: "arguments" },
  "findings-pending": { next: "adjudicate", action: "adjudicate" },
  "review-settled": { next: "continue", action: "re-check" },
  "round-pending": { next: "review", action: "review run" },
  "target-moved": { next: "review", action: "review run" },
  "review-required": { next: "review", action: "review run" },
} as const;

export type ResumeReason = keyof typeof RESUME_ROUTES;

interface ResumeView {
  next: "inspect" | "adjudicate" | "continue" | "review";
  reason: ResumeReason;
  action: string;
  evidence?: string;
  round?: string;
  cleanup?: "checkpoint" | "unbound";
}

const existingRecoveryPath = (
  session: string,
  relative: string,
  kind: "file" | "directory" = "file"
) => {
  try {
    fs.lstatSync(path.join(session, relative));
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the missing-path and resolved branches.
      return undefined;
    }

    throw error;
  }

  const file = containedSessionPath(session, relative);
  const info = fs.statSync(file);

  if (
    Buffer.byteLength(JSON.stringify(relative)) > 512 ||
    !(kind === "directory" ? info.isDirectory() : info.isFile())
  ) {
    throw new Error("Invalid recovery pointer");
  }

  return file;
};

// A saved file that fails its guard is unreadable state, which the caller's catch reports.
const readOptional = <T>(
  session: string,
  relative: string,
  guard: (value: unknown) => value is T
) => {
  const file = existingRecoveryPath(session, relative);

  if (file === undefined || file === "") {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the missing-file and guarded branches.
    return undefined;
  }

  const value: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));

  if (!guard(value)) {
    throw new Error("Invalid recovery state");
  }

  return value;
};

// SECTION: Recovery state guards
const isRoundRecord = (value: unknown): value is Round =>
  isRecord(value) && isRecord(value["spec"]);

// oxlint-disable-next-line eslint/complexity -- round shape-guard branches per generation, cap, spec, target, and roster entry.
const isSavedRound = (value: unknown): value is Round => {
  if (!isRecord(value)) {
    return false;
  }

  const { generation, cap, startSeq, spec, target, roster } = value;

  return (
    typeof generation === "number" &&
    Number.isSafeInteger(generation) &&
    generation >= 1 &&
    isLevel(value["level"]) &&
    typeof cap === "number" &&
    Number.isSafeInteger(cap) &&
    cap >= 0 &&
    typeof startSeq === "number" &&
    Number.isSafeInteger(startSeq) &&
    startSeq >= 0 &&
    typeof value["scope"] === "string" &&
    isRecord(spec) &&
    typeof spec["hash"] === "string" &&
    typeof spec["path"] === "string" &&
    isRecord(target) &&
    gitObjectId(target["base"]) &&
    gitObjectId(target["head"]) &&
    Array.isArray(roster) &&
    roster.length > 0 &&
    roster.every(
      (slot) =>
        isRecord(slot) &&
        typeof slot["slot"] === "string" &&
        /^[A-Za-z0-9_-]+\[\d+\]$/u.test(slot["slot"])
    )
  );
};

const isFindingsValue = (value: unknown): value is FindingsValue =>
  isRecord(value) &&
  Array.isArray(value["findings"]) &&
  Array.isArray(value["failed"]) &&
  value["findings"].every(
    (finding) => isRecord(finding) && typeof finding["id"] === "string"
  );

const isSlotOutcome = (value: unknown): value is SlotOutcome =>
  isRecord(value) &&
  typeof value["slot"] === "string" &&
  (value["state"] === "native" ||
    value["state"] === "done" ||
    value["state"] === "failed");

const isFanoutState = (value: unknown): value is FanoutState => isRecord(value);

const keptAutomatedChecks = (fold: Fold, plan: ParsedPlan) => {
  const removed = new Set(cleanupBinding(fold)?.removed);

  return checks(plan).filter(
    (check) => check.evidenceClass !== "review" && !removed.has(check.criterion)
  );
};

// oxlint-disable-next-line eslint/complexity -- task phase precedence scans seven ordered tiers across plan tasks.
const taskPhaseReason = (
  fold: Fold,
  plan: ParsedPlan,
  writers: ReturnType<typeof writerStates>,
  integration: IntegrationView
): { reason: ResumeReason; task: string } | "state-unreadable" | undefined => {
  const latestByTask = new Map<string, (typeof writers)[number]>();

  for (const row of writers) {
    latestByTask.set(row.task, row);
  }

  if (
    plan.tasks.every(
      (task) => latestByTask.get(task.id)?.state === "integrated"
    )
  ) {
    return undefined;
  }

  const conflictTask = isRecord(integration.pendingConflict)
    ? textValue(integration.pendingConflict["task"])
    : "";

  for (const task of plan.tasks) {
    if (conflictTask === task.id) {
      return { reason: "integration-conflict", task: task.id };
    }
  }

  for (const task of plan.tasks) {
    if (latestByTask.get(task.id)?.state === "integration-abandoned") {
      return { reason: "integration-abandoned", task: task.id };
    }
  }

  const checkById = new Map(
    keptAutomatedChecks(fold, plan).map((check) => [check.criterion, check])
  );

  for (const task of plan.tasks) {
    if (latestByTask.get(task.id)?.state !== "integrated") {
      continue;
    }

    const latestDone = fold.records.findLast(
      (record) =>
        record.kind === "integrate" &&
        record.data["phase"] === "done" &&
        record.data["task"] === task.id
    );

    if (!latestDone) {
      return "state-unreadable";
    }

    const taskChecks = taskCriteria(plan, task.id).flatMap((id) => {
      const check = checkById.get(id);

      return check ? [check] : [];
    });

    const missingEvidence = taskChecks.some((check) => {
      const row = strictEvidence(fold, check);

      return !row || row.seq <= latestDone.seq;
    });

    if (missingEvidence) {
      return { reason: "task-check-pending", task: task.id };
    }
  }

  for (const task of plan.tasks) {
    if (latestByTask.get(task.id)?.state === "candidate-unintegrated") {
      return { reason: "candidate-ready", task: task.id };
    }
  }

  for (const task of plan.tasks) {
    if (latestByTask.get(task.id)?.state === "missing-worktree") {
      return { reason: "worktree-missing", task: task.id };
    }
  }

  for (const task of plan.tasks) {
    const state = latestByTask.get(task.id)?.state;

    if (state === "no-progress" || state === "ready-to-submit") {
      return { reason: "writer-open", task: task.id };
    }
  }

  for (const task of plan.tasks) {
    const state = latestByTask.get(task.id)?.state;

    if (
      (state === "unlaunched" || state === "launch-abandoned") &&
      task.prerequisites.every(
        (prereq) => latestByTask.get(prereq)?.state === "integrated"
      )
    ) {
      return { reason: "task-ready", task: task.id };
    }
  }

  return "state-unreadable";
};

// oxlint-disable-next-line eslint/complexity -- resume branches per fold tear, integration open state, and checkpoint ancestry.
export const resumeStatus = async (ctx: HandlerContext) => {
  const { session, manifest, deps } = ctx;
  let cleanup: ResumeView["cleanup"];
  let postFold: Fold | undefined;

  const result = (
    reason: ResumeReason,
    options: Pick<ResumeView, "round" | "evidence"> & {
      task?: string;
      recoverySelection?: RecoverySelection | undefined;
    } = {}
  ) => {
    const route = RESUME_ROUTES[reason];
    const { task, recoverySelection, ...fields } = options;

    const action =
      task !== undefined && task !== ""
        ? `${route.action} ${task}`
        : route.action;

    return {
      value: {
        next: route.next,
        reason,
        action,
        ...fields,
        ...(cleanup && { cleanup }),
      },
      ...(recoverySelection !== undefined && { recoverySelection }),
      ...(postFold && { postFold }),
    };
  };

  try {
    // An absent ledger folds empty; a present ledger must remain contained and a regular file.
    existingRecoveryPath(session, "ledger.jsonl");
    const fold = foldLedger(session);

    postFold = fold;

    if (fold.torn) {
      return result("state-unreadable");
    }

    const opened = integrationRecord(fold);

    if (!opened) {
      const bind = latest(fold, "bind");

      if (typeof bind?.data["plan"] !== "string" || bind.data["plan"] === "") {
        return result("plan-pending");
      }

      const current = currentHashes(manifest.repositoryRoot, bind);

      return result(
        gate(fold, current).allowed ? "baseline-pending" : "approval-pending"
      );
    }

    cleanup = "unbound";

    const postOpenIntegrate = fold.records.filter(
      (row) => row.seq > opened.seq && row.kind === "integrate"
    );

    if (postOpenIntegrate.some((row) => row.data["phase"] === "closed")) {
      return result("closed");
    }

    if (
      postOpenIntegrate.some(
        (row) =>
          row.data["phase"] === "delivered" || row.data["phase"] === "committed"
      )
    ) {
      return result("delivered");
    }

    if (
      postOpenIntegrate.some((row) => row.data["phase"] === "deliver-started")
    ) {
      return result("delivery-pending");
    }

    const derived = await deriveStatusSections(
      session,
      manifest.repositoryRoot,
      deps,
      fold
    );

    const integrationView = derived.sections?.integration;

    if (
      derived.integrationPathRejected ||
      derived.writerPathRejected ||
      !integrationView ||
      !("head" in integrationView) ||
      integrationView.state !== "present"
    ) {
      return result("state-unreadable");
    }

    const { head } = integrationView;
    const base: unknown = opened.data["base"];

    if (!gitObjectId(head) || !gitObjectId(base)) {
      return result("state-unreadable");
    }

    const cwd = path.resolve(session, textValue(opened.data["path"]));

    if (await hasCleanupCheckpoint(session, fold, deps, cwd, head)) {
      cleanup = "checkpoint";
    }

    if (!derived.plan) {
      return result("state-unreadable");
    }

    const reviewDir = reviewDirectory(session, REVIEW);

    const directory = existingRecoveryPath(
      session,
      reviewPointer(session, reviewDir),
      "directory"
    );

    const numbers =
      directory !== undefined && directory !== ""
        ? reviewRoundEntries(fs.readdirSync(directory), "canonical").map(
            (entry) => entry.number
          )
        : [];

    const last = numbers.at(-1);

    if (last === undefined) {
      const current = currentHashes(
        manifest.repositoryRoot,
        latest(fold, "bind")
      );

      if (!gate(fold, current).allowed) {
        return result("gate-blocked");
      }

      if (!Array.isArray(derived.sections?.writers)) {
        return result("state-unreadable");
      }

      const taskOutcome = taskPhaseReason(
        fold,
        derived.plan,
        derived.sections.writers,
        integrationView
      );

      if (taskOutcome === "state-unreadable") {
        return result("state-unreadable");
      }

      if (taskOutcome) {
        return result(taskOutcome.reason, { task: taskOutcome.task });
      }

      const { criteria } = await derived.loadCriteria();

      if (!Array.isArray(criteria)) {
        return result("state-unreadable");
      }

      const keptAutomated = new Set(
        keptAutomatedChecks(fold, derived.plan).map((check) => check.criterion)
      );

      if (criteria.some((criterion) => keptAutomated.has(criterion))) {
        return result("checks-pending");
      }

      if (!currentRuntimeVerification(fold, opened.seq)) {
        return result("verification-pending");
      }

      if (cleanup !== "checkpoint") {
        return result("cleanup-pending");
      }

      return result("review-pending");
    }

    const roundDir = reviewRoundDirectory(reviewDir, last);
    const round = reviewPointer(session, reviewRoundFile(roundDir));
    const saved = readOptional(session, round, isSavedRound);

    if (!saved || !Number.isSafeInteger(last) || saved.round !== last) {
      return result("state-unreadable");
    }

    const legacy = !Object.hasOwn(saved, "pins");

    if (!legacy && saved.pins !== null && typeof saved.pins !== "string") {
      return result("state-unreadable");
    }

    parsePinsFlag(saved.pins);
    const evidence = reviewPointer(session, reviewFindingsFile(roundDir));
    const findings = readOptional(session, evidence, isFindingsValue);

    const bind = latest(fold, "bind");
    const current = currentHashes(manifest.repositoryRoot, bind);

    if (
      typeof bind?.data["plan"] !== "string" ||
      bind.data["plan"] === "" ||
      current.plan === undefined ||
      current.plan === null ||
      current.plan === "" ||
      current.spec === undefined ||
      current.spec === null ||
      current.spec === "" ||
      !gate(fold, current).allowed ||
      !levelGate(fold, saved.level).allowed
    ) {
      return result("gate-blocked");
    }

    const applies = applicableReviewIds(manifest, fold).get(REVIEW);
    const { budget } = admission(session, fold, REVIEW, saved.cap, applies);

    if (budget.coverage?.state === "unreadable") {
      return result("state-unreadable");
    }

    const rejections = loadRejections(session, fold, [REVIEW]);

    if (
      rejections.some((state) => state.state === "escalated") ||
      budget.state === "escalation-open"
    ) {
      return result("gate-blocked");
    }

    const target = { base, head };

    const capture = await captureReviewTarget(
      ctx,
      "code",
      "integration",
      "integration",
      false,
      false
    );

    if (JSON.stringify(capture.target) !== JSON.stringify(target)) {
      return result("state-unreadable");
    }

    const prior = numbers
      .filter((n) => n < last)
      .flatMap((n) => {
        const priorRoundDir = reviewRoundDirectory(reviewDir, n);

        const pointer = reviewPointer(
          session,
          reviewFindingsFile(priorRoundDir)
        );

        const value = readOptional(session, pointer, isFindingsValue);

        const metadata =
          value &&
          readOptional(
            session,
            reviewPointer(session, reviewRoundFile(priorRoundDir)),
            isRoundRecord
          );

        return value && metadata ? [{ value, metadata, pointer }] : [];
      });

    const rulingRows = fold.records.filter(
      (row) =>
        row.kind === "ruling" &&
        textValue(row.data["subject"]).startsWith(`review:${REVIEW}:`)
    );

    const moved =
      !sameReviewCapture(saved, capture) ||
      (!findings &&
        saved.rulingSnapshot !== undefined &&
        saved.rulingSnapshot !==
          reviewRulingSnapshot(
            REVIEW,
            prior.map((row) => row.value),
            rulingRows
          ));

    const incomplete = budget.nextRound === last;

    const selection = (): RecoverySelection => ({
      review: REVIEW,
      targetHash: recoveryTargetHash(target),
      round: budget.nextRound,
      generation: incomplete ? saved.generation + (moved ? 1 : 0) : 1,
    });

    if (incomplete && !moved && budget.state === "allowed") {
      const generation = reviewPointer(
        session,
        reviewGenerationDirectory(roundDir, saved.generation)
      );

      const slots = `${generation}/slots`;
      const slotsDir = existingRecoveryPath(session, slots, "directory");

      if (slotsDir !== undefined && slotsDir !== "") {
        const names = fs.readdirSync(slotsDir).toSorted();

        for (const name of names) {
          if (!/^[A-Za-z0-9_-]+\[\d+\]\.json$/u.test(name)) {
            continue;
          }

          const pointer = `${slots}/${name}`;
          const slot = readOptional(session, pointer, isSlotOutcome);

          if (!slot || slot.slot !== name.slice(0, -5)) {
            return result("state-unreadable");
          }

          if (slot.state !== "native" || slot.cliFallback) {
            continue;
          }

          const reply =
            typeof slot.replyPath === "string" &&
            path.isAbsolute(slot.replyPath)
              ? path.relative(session, slot.replyPath).split(path.sep).join("/")
              : "";

          const parent = `${generation}/replies`;

          const attempt =
            typeof slot.attempt === "string"
              ? /^(?<cap1>[A-Za-z0-9_-]+\[\d+\])#(?<cap2>[a-f0-9]{6})$/u.exec(
                  slot.attempt
                )
              : null;

          const physical = saved.roster.find(
            (entry) => entry.slot === attempt?.[1]
          );

          const logical = saved.roster.find(
            (entry) => entry.slot === slot.slot && !entry.reserve
          );

          if (
            !attempt ||
            !logical ||
            !physical ||
            physical.provider !== slot.provider ||
            (physical !== logical &&
              (physical !== saved.roster.find((entry) => entry.reserve) ||
                readOptional(
                  session,
                  `${generation}/fanout.json`,
                  isFanoutState
                )?.reserveUsedBy !== slot.slot)) ||
            path.posix.dirname(reply) !== parent ||
            ![`${slot.slot}.${attempt[2]}.md`, `${slot.slot}.md`].includes(
              path.posix.basename(reply)
            )
          ) {
            return result("state-unreadable");
          }

          containedSessionPath(session, parent);
          existingRecoveryPath(session, reply);

          return result("native-pending", {
            round,
            evidence: pointer,
            recoverySelection: legacy ? undefined : selection(),
          });
        }
      }
    }

    if ((!findings || moved) && legacy && budget.state === "allowed") {
      return result("arguments-unavailable", { round });
    }

    const published = findings
      ? [...prior, { value: findings, metadata: saved, pointer: evidence }]
      : prior;

    const pending = published.findLast(
      ({ value, metadata }) =>
        applies?.(metadata) === true &&
        metadata.spec.hash === current.spec &&
        value.findings.some((finding) => {
          const history = rulingRows.filter(
            (row) => row.data["subject"] === `review:${REVIEW}:${finding.id}`
          );

          const ruling = history.at(-1);

          if (!ruling || !textValue(ruling.data["rationale"] ?? "").trim()) {
            return true;
          }

          return (
            metadata.round === last &&
            !moved &&
            ruling.data["ruling"] === "accepted" &&
            (finding.severity !== "CONSIDER" ||
              effectiveSeverity(finding, history) !== "CONSIDER")
          );
        })
    );

    if (pending) {
      return result("findings-pending", { evidence: pending.pointer });
    }

    if (findings) {
      try {
        await reviewIdentity(ctx, fold, cwd, head, base);

        return result("review-settled");
      } catch (error) {
        if (
          !(error instanceof ToolError && error.reason === "review-required")
        ) {
          throw error;
        }
      }
    }

    if (budget.state !== "allowed") {
      return result("gate-blocked");
    }

    if (legacy) {
      return result("arguments-unavailable", { round });
    }

    let finding: ResumeView["reason"];

    if (moved) {
      finding = "target-moved";
    } else if (incomplete) {
      finding = "round-pending";
    } else {
      finding = "review-required";
    }

    return result(finding, { round, recoverySelection: selection() });
  } catch (error) {
    if (
      error instanceof ToolError &&
      ["nothing-to-review", "review-confirmation-required"].includes(
        error.reason
      )
    ) {
      return result("gate-blocked");
    }

    return result("state-unreadable");
  }
};
