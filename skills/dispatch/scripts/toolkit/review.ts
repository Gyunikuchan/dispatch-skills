import fs from "node:fs";
import path from "node:path";

import { isRecord } from "../lib/config.ts";
import { nodeErrorCode } from "../lib/fs-ext.ts";
import { artifactKind } from "./artifacts.ts";
import type { HandlerContext } from "./cli.ts";
import {
  applicableReviewIds,
  loadRejections,
  reviewId,
} from "./confirmations.ts";
import type { ReviewKind } from "./domain/types.ts";
import {
  assertHostNotSandboxed,
  parsePinsFlag,
  resolveSlots,
} from "./fanout.ts";
import { git } from "./git.ts";
import { readJsonPayload } from "./input.ts";
import {
  appendRecord,
  confirmGate,
  foldLedger,
  latest,
  levelGate,
} from "./ledger.ts";
import { withLockFile } from "./lock.ts";
import { isLevel, present } from "./narrow.ts";
import { ToolError } from "./output.ts";
import { loadPlan } from "./plan-view.ts";
import { CODE_TARGETS, specHashFor } from "./review-capture.ts";
import { runReviewRound } from "./review-round.ts";
import {
  canonical,
  INTEGRATION_REVIEW,
  reviewDirectory,
  reviewFindingsFile,
  reviewPendingFile,
  reviewRoundDirectory,
  reviewRoundEntries,
  reviewRoundFile,
  readStoredJson,
} from "./review-state.ts";

const REVIEW_KINDS = ["code", "plan", "design"] as const;

// SECTION: stale saved findings
const lacksProposedFix = (file: string) =>
  (readStoredJson<{ findings?: unknown[] }>(file)?.findings ?? []).some(
    (finding) =>
      !isRecord(finding) || typeof finding["proposedFix"] !== "string"
  );

/** Read-only preflight over every completed and pending payload, so the refusal precedes each write of the handler. */
const refuseStaleFindings = (directory: string) => {
  const names = fs.existsSync(directory) ? fs.readdirSync(directory) : [];

  for (const { name } of reviewRoundEntries(names)) {
    const round = path.join(directory, name);

    if (
      [reviewFindingsFile(round), reviewPendingFile(round)].some(
        lacksProposedFix
      )
    ) {
      throw new ToolError(
        4,
        "stale-findings",
        `Saved findings in ${path.basename(directory)} come from an earlier Dispatch version; finish that review on the version that started it`
      );
    }
  }
};

// SECTION: fix-review-lite note
/** Names the failing step; `detail` is the durable receipt and leads the message. A raw fault becomes a stepped `fault`; an already stepped error passes through. */
export const inStep = (error: unknown, step: string, detail?: string) => {
  if (error instanceof ToolError && error.step !== undefined) {
    return error;
  }

  const [exit, reason, message] =
    error instanceof ToolError
      ? [error.exit, error.reason, error.message]
      : [2, "fault", error instanceof Error ? error.message : String(error)];

  // The receipt leads so the 1,024 B summary cap clips only the underlying message.
  const rest =
    error instanceof ToolError && message === reason ? "" : `; ${message}`;

  return new ToolError(
    exit,
    reason,
    detail === undefined ? message : detail + rest,
    step
  );
};

const NOTE_KEY = /^(?<round>[1-9]\d*):(?<ordinal>[1-9]\d*)$/u;

const recordsArtifact = (roundDir: string, target: string) => {
  const recorded = readStoredJson<{ artifactPath?: unknown }>(
    reviewRoundFile(roundDir)
  )?.artifactPath;

  return typeof recorded === "string" && canonical(recorded) === target;
};

// NOTE: same selection as `brief fix-review-lite`: the newest completed round recorded for this artifact path, so a same-basename artifact never matches.
const latestRound = (reviewDir: string, artifact: string) => {
  const names = fs.existsSync(reviewDir) ? fs.readdirSync(reviewDir) : [];
  const target = canonical(artifact);

  return reviewRoundEntries(names)
    .toReversed()
    .find(({ name }) => {
      const dir = path.join(reviewDir, name);

      return (
        recordsArtifact(dir, target) &&
        Array.isArray(
          readStoredJson<{ findings?: unknown }>(reviewFindingsFile(dir))
            ?.findings
        )
      );
    })?.number;
};

/** Appends the settled batch note when it belongs to this review and its latest completed round; the append dedupes an exact retry. */
const appendNote = async (
  ctx: HandlerContext,
  review: string,
  artifact: string
) => {
  const note = readJsonPayload(ctx, {
    fileFlag: "note",
    label: "--note record",
  });

  if (
    !isRecord(note) ||
    note["kind"] !== "note" ||
    note["by"] !== "orchestrator"
  ) {
    throw new ToolError(
      1,
      "invalid-input",
      "--note takes one note record by orchestrator"
    );
  }

  const prefix = `fix-review-lite:${review}:`;
  const key = typeof note["key"] === "string" ? note["key"] : "";

  const parts = key.startsWith(prefix)
    ? NOTE_KEY.exec(key.slice(prefix.length))?.groups
    : undefined;

  if (parts === undefined) {
    throw new ToolError(
      1,
      "invalid-input",
      `--note key must be ${prefix}<round>:<n> with a positive <n>`
    );
  }

  const reviewDir = reviewDirectory(ctx.session, review);

  // An existing record for the key dedupes or conflicts in the append, so a retry after the next round completed still succeeds; the key's own round must still record this artifact.
  if (foldLedger(ctx.session).records.some((row) => row.key === key)) {
    const roundDir = reviewRoundDirectory(reviewDir, parts["round"] ?? "");

    if (!recordsArtifact(roundDir, canonical(artifact))) {
      throw new ToolError(
        1,
        "invalid-input",
        `--note round ${parts["round"]} of ${review} does not record this artifact path`
      );
    }

    return await appendRecord(ctx.session, note, ctx.deps);
  }

  const round = latestRound(reviewDir, artifact);

  if (round === undefined || Number(parts["round"]) !== round) {
    throw new ToolError(
      1,
      "invalid-input",
      `--note round must be the latest completed round of ${review} for this artifact (${round ?? "none"})`
    );
  }

  return await appendRecord(ctx.session, note, ctx.deps);
};

interface NoteOutcome {
  appended?: { seq: number; deduped: boolean };
}

// oxlint-disable-next-line eslint/complexity -- review dispatch validates one branch per target, kind, level, and gate; refactor deferred to avoid behavior drift.
const runReview = async (ctx: HandlerContext, noted: NoteOutcome) => {
  const { session, manifest, deps } = ctx;

  if (ctx.args.length !== 1) {
    throw new ToolError(
      1,
      "invalid-input",
      `One review target is required: ${
        CODE_TARGETS
      }; plan and design targets are artifact paths`
    );
  }

  const requested = present(ctx.args[0], "the review target");
  const inferred = artifactKind(requested);

  const requestedKind: unknown =
    ctx.values["kind"] ??
    (inferred === "plan" || inferred === "design" ? inferred : "code");

  const knownKind = REVIEW_KINDS.find((value) => value === requestedKind);

  if (!knownKind) {
    throw new ToolError(
      1,
      "invalid-input",
      "Review kind must be code, plan or design"
    );
  }

  const kind: ReviewKind = knownKind;
  let fold = foldLedger(session);

  const requestedLevel: unknown =
    ctx.values["level"] ?? latest(fold, "level")?.data["level"] ?? "medium";

  if (!isLevel(requestedLevel)) {
    throw new ToolError(1, "invalid-input", "Unknown level");
  }

  const level = requestedLevel;

  // SECTION: target and stale-findings preflight
  const artifact =
    kind === "code"
      ? requested
      : path.resolve(manifest.repositoryRoot, requested);

  const bound = latest(fold, "bind");
  let taskTarget = false;

  if (
    kind === "code" &&
    bound &&
    requested !== "integration" &&
    requested !== "worktree" &&
    !requested.includes("..")
  ) {
    try {
      taskTarget = loadPlan(session, manifest).tasks.some(
        (task) => task.id === requested
      );
    } catch (error) {
      // An unusable plan cannot classify tasks, but standalone revision review still works.
      if (
        !(error instanceof ToolError && error.reason === "lint-errors") &&
        !["ENOENT", "EACCES", "EPERM", "EISDIR"].includes(
          nodeErrorCode(error) ?? ""
        )
      ) {
        throw error;
      }
    }
  }

  const gitTarget =
    kind === "code" && requested !== "integration" && !taskTarget;

  // Worktree rounds count per HEAD, so a commit starts a new series instead of inheriting an older change's cap.
  let series = "";

  if (requested === "worktree") {
    const head = await git(deps, manifest.repositoryRoot, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      "HEAD^{commit}",
    ]);

    if (head.exit) {
      throw new ToolError(
        1,
        "invalid-input",
        `Cannot resolve revision HEAD; ${CODE_TARGETS}`
      );
    }

    series = `@${head.stdout.trim()}`;
  }

  const review = reviewId(kind, artifact, gitTarget ? series : undefined);

  const directory = reviewDirectory(session, review);
  refuseStaleFindings(directory);

  // SECTION: --note append
  // The note lands after pure argument validation and before every gate, so a later refusal leaves it durable.
  if (ctx.values["note"] !== undefined) {
    // Pins validate before the durable append; a run without --note keeps its gate-first refusal order.
    parsePinsFlag(ctx.values["pins"]);

    try {
      if (kind === "code") {
        throw new ToolError(
          1,
          "invalid-input",
          "--note applies to plan and design review"
        );
      }

      noted.appended = await appendNote(ctx, review, artifact);
    } catch (error) {
      throw inStep(error, "note");
    }

    fold = foldLedger(session);
  }

  const gate = levelGate(fold, level);

  if (!gate.allowed) {
    throw new ToolError(4, gate.reason, gate.reason);
  }

  const confirmInput: unknown =
    ctx.values["spec"] ?? latest(fold, "bind")?.data["spec"];

  if (kind !== "code") {
    // Refuse before the zero-round skip so plan/design review never bypasses confirmation.
    if (typeof confirmInput !== "string") {
      throw new ToolError(
        4,
        "lint-errors",
        "Review needs --spec or a bound spec"
      );
    }

    const confirmation = confirmGate(
      fold,
      specHashFor(manifest.repositoryRoot, confirmInput)
    );

    if (!confirmation.allowed) {
      throw new ToolError(4, confirmation.reason, confirmation.reason);
    }
  }

  const pins = parsePinsFlag(ctx.values["pins"]);
  const roster = resolveSlots(kind, level, deps, pins);
  const cap = roster.rounds;

  const nativeFailures = ctx.nativeFailures ?? [];
  assertHostNotSandboxed(deps, roster, nativeFailures.length > 0);

  const rejectionStates = () =>
    loadRejections(session, foldLedger(session), [review]);

  const initialRejections = rejectionStates();

  if (initialRejections.some((state) => state.state === "escalated")) {
    throw new ToolError(
      4,
      "escalation-open",
      "Resolve the disputed MUST rejection before another confirmation round"
    );
  }

  fs.mkdirSync(directory, { recursive: true });

  // Coverage applies to the integration review alone; every admission caller passes the same predicate.
  const applies =
    review === INTEGRATION_REVIEW
      ? applicableReviewIds(manifest, fold).get(review)
      : undefined;

  return await withLockFile(
    path.join(directory, "claim"),
    "review",
    deps,
    0,
    async () =>
      await runReviewRound({
        ctx,
        session,
        manifest,
        deps,
        kind,
        level,
        review,
        cap,
        roster,
        pins,
        directory,
        artifact,
        requested,
        taskTarget,
        gitTarget,
        series,
        applies,
      })
  );
};

export const reviewRun = async (ctx: HandlerContext) => {
  const noted: NoteOutcome = {};

  try {
    return await runReview(ctx, noted);
  } catch (error) {
    const { appended } = noted;

    throw appended === undefined
      ? error
      : inStep(
          error,
          "review",
          `note seq ${appended.seq} ${appended.deduped ? "deduped" : "appended"}`
        );
  }
};
