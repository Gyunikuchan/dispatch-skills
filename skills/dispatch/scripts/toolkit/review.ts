import fs from "node:fs";
import path from "node:path";

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
import { confirmGate, foldLedger, latest, levelGate } from "./ledger.ts";
import { withLockFile } from "./lock.ts";
import { isLevel, present } from "./narrow.ts";
import { ToolError } from "./output.ts";
import { loadPlan } from "./plan-view.ts";
import { CODE_TARGETS, specHashFor } from "./review-capture.ts";
import { runReviewRound } from "./review-round.ts";
import { INTEGRATION_REVIEW, reviewDirectory } from "./review-state.ts";

const REVIEW_KINDS = ["code", "plan", "design"] as const;

// oxlint-disable-next-line eslint/complexity -- review dispatch validates one branch per target, kind, level, and gate; refactor deferred to avoid behavior drift.
export const reviewRun = async (ctx: HandlerContext) => {
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
  const fold = foldLedger(session);

  const requestedLevel: unknown =
    ctx.values["level"] ?? latest(fold, "level")?.data["level"] ?? "medium";

  if (!isLevel(requestedLevel)) {
    throw new ToolError(1, "invalid-input", "Unknown level");
  }

  const level = requestedLevel;
  const gate = levelGate(fold, level);

  if (!gate.allowed) {
    throw new ToolError(4, gate.reason, gate.reason);
  }

  const confirmInput: unknown =
    ctx.values["spec"] ?? latest(fold, "bind")?.data["spec"];

  if (kind !== "code") {
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

  const directory = reviewDirectory(session, review);
  fs.mkdirSync(directory, { recursive: true });

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
