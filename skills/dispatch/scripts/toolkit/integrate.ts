import crypto from "node:crypto";

import { isRecord } from "../lib/config.ts";
import type { HandlerContext } from "./cli.ts";
import { stableValue } from "./domain/stable-value.ts";
import {
  cleanupEvidence,
  matchesDeclared,
  strictEvidence,
} from "./evidence.ts";
import { git, gitOk, gitPaths, changedPaths } from "./git.ts";
import { readJsonPayload, readRequiredReason } from "./input.ts";
import { pendingIntegration } from "./integration-state.ts";
import { ensureIntegration } from "./integration.ts";
import { withPostFold, gate, currentHashes, latest } from "./ledger.ts";
import type { Fold, LedgerTransaction } from "./ledger.ts";
import { present, textValue } from "./narrow.ts";
import { result, refuse, ToolError } from "./output.ts";
import { checks, loadPlan, taskSection } from "./plan-view.ts";
import { validateReviewFix } from "./records.ts";
import {
  dataTrailers,
  reviewFixFromCommit,
  reviewFixTrailers,
} from "./review-fix.ts";
import { candidate, isStale, abandonedRef } from "./writers.ts";

const readReviewFix = (ctx: HandlerContext) => {
  let parsed: unknown;

  try {
    parsed = readJsonPayload(ctx, {
      fileFlag: "review-fix",
      inlineFlag: "review-fix-json",
      optional: true,
      label: "review-fix",
    });
  } catch (error) {
    // NOTE: only the unreadable-file refusal gets the inline hint; malformed JSON keeps its own message.
    if (
      error instanceof ToolError &&
      error.message.startsWith("Cannot read review-fix file")
    ) {
      throw new ToolError(
        error.exit,
        error.reason,
        `${error.message}; --review-fix expects a file path, so pass inline JSON with --review-fix-json`
      );
    }

    throw error;
  }

  if (parsed === undefined) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the absent and validated branches.
    return undefined;
  }

  return validateReviewFix(parsed);
};

const TRAILER = "Dispatch-Test-Cleanup-Data: ";

const invalidCleanup = () =>
  new ToolError(
    1,
    "invalid-input",
    'input requires a readable test-cleanup JSON object: {"removed": ["SC<n>"], "deleted": <count>, "merged": <count>}'
  );

const isCount = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

const isCriterionId = (id: unknown): id is string =>
  typeof id === "string" && !!id.trim();

const readTestCleanup = (ctx: HandlerContext) => {
  const value = readJsonPayload(ctx, {
    fileFlag: "test-cleanup",
    inlineFlag: "test-cleanup-json",
    optional: true,
    label: "test-cleanup",
  });

  if (value === undefined) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the absent and validated branches.
    return undefined;
  }

  if (
    !isRecord(value) ||
    Object.keys(value).toSorted().join(",") !== "deleted,merged,removed"
  ) {
    throw invalidCleanup();
  }

  const removed: unknown = value["removed"];
  const deleted: unknown = value["deleted"];
  const merged: unknown = value["merged"];

  if (
    !Array.isArray(removed) ||
    !removed.every(isCriterionId) ||
    new Set(removed).size !== removed.length ||
    !isCount(deleted) ||
    !isCount(merged)
  ) {
    throw invalidCleanup();
  }

  if (!removed.length && !deleted && !merged) {
    refuse("test-cleanup-empty");
  }

  return { removed, deleted, merged };
};

const task = (ctx: HandlerContext) => {
  if (ctx.args.length !== 1) {
    throw new ToolError(1, "invalid-input", "One task ID is required");
  }

  const id = present(ctx.args[0], "the task ID argument");
  taskSection(loadPlan(ctx.session, ctx.manifest), id);

  return id;
};

const checkGate = (ctx: HandlerContext, fold: Fold) => {
  const checked = gate(
    fold,
    currentHashes(ctx.manifest.repositoryRoot, latest(fold, "bind"))
  );

  if (!checked.allowed) {
    refuse(checked.reason, JSON.stringify(checked));
  }
};

const cherryHead = async (ctx: HandlerContext, cwd: string) => {
  const picked = await git(ctx.deps, cwd, [
    "rev-parse",
    "--verify",
    "CHERRY_PICK_HEAD",
  ]);

  return picked.exit === 0 ? picked.stdout.trim() : undefined;
};

const pickedCommit = async (ctx: HandlerContext, cwd: string, hash: string) => {
  const head = await gitOk(ctx.deps, cwd, ["rev-parse", "HEAD"]);
  const message = await gitOk(ctx.deps, cwd, ["log", "-1", "--format=%B"]);

  if (message.includes(`(cherry picked from commit ${hash})`)) {
    return head;
  }

  const patchId = async (commit: string) => {
    const patch = await gitOk(ctx.deps, cwd, [
      "show",
      "--format=",
      "--no-ext-diff",
      commit,
    ]);

    const value = await ctx.deps.run(["git", "patch-id", "--stable"], {
      cwd,
      stdin: `${patch}\n`,
    });

    if (value.exit) {
      throw new ToolError(2, "fault", value.stderr);
    }

    return value.stdout.split(/\s/u)[0];
  };

  const expected = await patchId(hash);

  return expected !== undefined &&
    expected !== "" &&
    expected === (await patchId(head))
    ? head
    : undefined;
};

const done = async (tx: LedgerTransaction, id: string, commit: string) => {
  await tx.append({
    kind: "integrate",
    by: "tool",
    data: { phase: "done", task: id, commit },
  });

  return result({ task: id, commit });
};

// NOTE: a 16-hex prefix separates the conflict sets of one attempt.
const pathsDigest = (paths: readonly string[]) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(paths.toSorted()))
    .digest("hex")
    .slice(0, 16);

const conflicts = async (
  ctx: HandlerContext,
  tx: LedgerTransaction,
  cwd: string,
  id: string
) => {
  const paths = await gitPaths(ctx.deps, cwd, [
    "diff",
    "--name-only",
    "--diff-filter=U",
    "-z",
  ]);

  // NOTE: the started seq and paths digest keep relaunch and rerun conflicts from hitting key-conflict.
  const attempt = present(
    pendingIntegration(tx.fold),
    "the started integration"
  );

  await tx.append({
    kind: "integrate",
    by: "tool",
    key: `integrate:conflict:${id}:${attempt.seq}:${pathsDigest(paths)}`,
    data: { phase: "conflict", task: id, paths },
  });

  return {
    ok: false,
    exit: 0,
    reason: "conflict",
    summary: JSON.stringify({ task: id, paths }),
    value: { task: id, paths, reason: "conflict" },
  };
};

export const integrate = async (ctx: HandlerContext) => {
  const id = task(ctx);

  return await withPostFold(
    ctx.session,
    "worktree integrate",
    ctx.deps,
    async (tx) => {
      checkGate(ctx, tx.fold);
      const active = pendingIntegration(tx.fold);

      if (active && active.data["task"] !== id) {
        refuse("integration-pending", textValue(active.data["task"]));
      }

      const launch = candidate(tx.fold, id);

      if (!launch) {
        refuse("no-candidate");
      }

      const hash = textValue(
        present(launch.finished, "the finished launch").data["candidate"]
      );

      const integration = await ensureIntegration(tx, ctx);
      const cwd = integration.path;

      const cherry = await cherryHead(ctx, cwd);

      if (active && cherry === hash) {
        return await conflicts(ctx, tx, cwd, id);
      }

      if (cherry !== undefined && cherry !== "") {
        refuse("integration-dirty");
      }

      if (active) {
        const commit = await pickedCommit(ctx, cwd, hash);

        if (commit !== undefined && commit !== "") {
          return await done(tx, id, commit);
        }
      }

      const headPaths = await changedPaths(ctx.deps, cwd, "HEAD");

      if (headPaths.length) {
        refuse("integration-dirty");
      }

      if (
        isStale(
          tx.fold,
          launch.record,
          taskSection(loadPlan(ctx.session, ctx.manifest), id)
        )
      ) {
        const ack = ctx.values["ack-stale"];

        if (typeof ack !== "string" || !ack.trim()) {
          refuse("stale-candidate");
        }

        await tx.append({
          kind: "ruling",
          by: "orchestrator",
          key: `ack-stale:${hash}`,
          data: {
            subject: `stale-candidate ${id} ${hash}`,
            ruling: "accept",
            rationale: ack,
          },
        });
      }

      if (!active) {
        await tx.append({
          kind: "integrate",
          by: "tool",
          key: `integrate-started:${id}:${launch.launch}:${hash}`,
          data: { phase: "started", task: id, candidate: hash },
        });
      }

      const picked = await git(ctx.deps, cwd, ["cherry-pick", "-x", hash]);

      if (picked.exit) {
        const paths = await gitOk(ctx.deps, cwd, [
          "diff",
          "--name-only",
          "--diff-filter=U",
        ]);

        if (paths) {
          return await conflicts(ctx, tx, cwd, id);
        }

        throw new ToolError(2, "fault", picked.stderr || picked.stdout);
      }

      await ctx.deps.hook?.("integrate:after-pick");

      return await done(
        tx,
        id,
        await gitOk(ctx.deps, cwd, ["rev-parse", "HEAD"])
      );
    }
  );
};

export const continueIntegration = async (ctx: HandlerContext) => {
  const id = task(ctx);

  return await withPostFold(
    ctx.session,
    "worktree continue",
    ctx.deps,
    async (tx) => {
      checkGate(ctx, tx.fold);
      const active = pendingIntegration(tx.fold);

      const integration = await ensureIntegration(tx, ctx);
      const cwd = integration.path;

      const cherry = await cherryHead(ctx, cwd);

      if (
        cherry !== undefined &&
        cherry !== "" &&
        active?.data["task"] !== id
      ) {
        refuse("wrong-task");
      }

      if (!active || active.data["task"] !== id) {
        refuse("no-pending-integration");
      }

      const hash = textValue(active.data["candidate"]);

      if (cherry !== undefined && cherry !== "") {
        if (cherry !== hash) {
          refuse("wrong-task");
        }

        if (
          await gitOk(ctx.deps, cwd, ["diff", "--name-only", "--diff-filter=U"])
        ) {
          refuse("unresolved-conflict");
        }

        await gitOk(ctx.deps, cwd, ["add", "-A"]);
        await gitOk(
          ctx.deps,
          cwd,
          ["-c", "core.editor=true", "cherry-pick", "--continue"],
          { GIT_EDITOR: "true" }
        );
        await ctx.deps.hook?.("continue:after-commit");

        return await done(
          tx,
          id,
          await gitOk(ctx.deps, cwd, ["rev-parse", "HEAD"])
        );
      }

      const commit = await pickedCommit(ctx, cwd, hash);

      if (commit !== undefined && commit !== "") {
        return await done(tx, id, commit);
      }

      return refuse("no-pending-integration");
    }
  );
};

export const commit = async (ctx: HandlerContext) => {
  if (ctx.args.length) {
    throw new ToolError(1, "invalid-input", "commit takes no task");
  }

  const why = readRequiredReason(ctx);

  const hasReviewFix =
    ctx.values["review-fix"] !== undefined ||
    ctx.values["review-fix-json"] !== undefined;

  const hasTestCleanup =
    ctx.values["test-cleanup"] !== undefined ||
    ctx.values["test-cleanup-json"] !== undefined;

  if (hasReviewFix && hasTestCleanup) {
    throw new ToolError(
      1,
      "invalid-input",
      "--test-cleanup and --review-fix are mutually exclusive"
    );
  }

  let reviewFix = readReviewFix(ctx);
  const cleanup = readTestCleanup(ctx);

  return await withPostFold(
    ctx.session,
    "worktree commit",
    ctx.deps,
    // oxlint-disable-next-line eslint/complexity -- integrate branches per pending state, cleanup set, and plan/check gate.
    async (tx) => {
      const active = pendingIntegration(tx.fold);

      if (active) {
        refuse("integration-pending", textValue(active.data["task"]));
      }

      const integration = await ensureIntegration(tx, ctx);
      const cwd = integration.path;

      let hash = await gitOk(ctx.deps, cwd, ["rev-parse", "HEAD"]);
      const changedPathsNow = await changedPaths(ctx.deps, cwd, "HEAD");
      const dirty = changedPathsNow.length > 0;

      const message = dirty
        ? ""
        : await gitOk(ctx.deps, cwd, ["log", "-1", "--format=%B"]);

      const lines = message.split("\n");
      const cleanupTrailers = lines.filter((line) => line.startsWith(TRAILER));

      if (cleanup) {
        // SECTION: test cleanup commit; a clean tree recovers an interrupted commit from its trailer
        if (
          tx.fold.records.some(
            (r) => r.kind === "integrate" && r.data["phase"] === "test-cleanup"
          )
        ) {
          refuse("test-cleanup-recorded");
        }

        const header = `fix(dispatch): ${why
          .replaceAll(/\s+/gu, " ")
          .slice(0, 85)
          .replace(/[\uD800-\uDBFF]$/u, "")
          .trimEnd()}`;

        const canonical = stableValue(cleanup);

        if (!dirty) {
          const encoded = cleanupTrailers
            .map((line) => line.slice(TRAILER.length))
            .join("");

          if (
            lines[0] !== header ||
            !lines.includes(`Dispatch-Fix: ${ctx.manifest.safeSessionId}`) ||
            !/^[A-Za-z0-9_-]+$/u.test(encoded) ||
            Buffer.from(encoded, "base64url").toString("utf-8") !== canonical
          ) {
            refuse("no-changes");
          }
        }

        const from = dirty
          ? hash
          : await gitOk(ctx.deps, cwd, ["rev-parse", "HEAD^"]);

        const fromTree = await gitOk(ctx.deps, cwd, [
          "rev-parse",
          `${from}^{tree}`,
        ]);

        const plan = loadPlan(ctx.session, ctx.manifest);
        const planChecks = checks(plan);
        const checkById = new Map(planChecks.map((c) => [c.criterion, c]));
        const diffs = new Map<string, string[]>();

        for (const id of cleanup.removed) {
          if (!plan.criteria.some((c) => c.id === id)) {
            continue;
          }

          const check = checkById.get(id);

          if (!check) {
            continue;
          }

          const row = strictEvidence(tx.fold, check);

          if (!row) {
            continue;
          }

          // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
          const tree = String(row.data["tree"]);

          if (tree === fromTree || diffs.has(tree)) {
            continue;
          }

          diffs.set(
            tree,
            // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
            await gitPaths(ctx.deps, cwd, [
              "diff",
              "--name-only",
              "--no-renames",
              "-z",
              tree,
              fromTree,
              "--",
            ])
          );
        }

        const evidence = cleanupEvidence(
          tx.fold,
          planChecks,
          plan.criteria,
          cleanup.removed,
          fromTree,
          diffs
        );

        if (!evidence.ok) {
          refuse(
            "test-cleanup-evidence-required",
            `Stale or missing evidence on pre-cleanup tree for: ${evidence.stale.join(
              ", "
            )}`
          );
        }

        const changed = await gitPaths(
          ctx.deps,
          cwd,
          dirty
            ? ["diff", "-z", "--name-only", "--no-renames", "HEAD", "--"]
            : ["diff", "-z", "--name-only", "--no-renames", from, "HEAD", "--"]
        );

        const untouched = cleanup.removed.filter(
          (id) =>
            !changed.some((file) =>
              matchesDeclared(
                file,
                present(
                  plan.criteria.find((c) => c.id === id),
                  "the removed criterion"
                ).tests
              )
            )
        );

        if (untouched.length) {
          refuse(
            "test-cleanup-paths-unchanged",
            `No declared Tests path changed for ${untouched.join(", ")}`
          );
        }

        if (dirty) {
          const trailer = dataTrailers(
            TRAILER,
            Buffer.from(canonical).toString("base64url")
          ).join("\n");

          await gitOk(ctx.deps, cwd, ["add", "-A"]);
          await gitOk(ctx.deps, cwd, [
            "commit",
            "-m",
            header,
            "-m",
            `Dispatch-Fix: ${ctx.manifest.safeSessionId}`,
            "-m",
            trailer,
          ]);
          await ctx.deps.hook?.("commit:after-commit");
          hash = await gitOk(ctx.deps, cwd, ["rev-parse", "HEAD"]);
        }

        await tx.append({
          kind: "integrate",
          by: "tool",
          data: {
            phase: "test-cleanup",
            from,
            fromTree,
            to: hash,
            ...cleanup,
            trees: evidence.trees,
          },
        });

        return result({
          commit: hash,
          reason: why,
          from,
          ...cleanup,
          trees: evidence.trees,
        });
      }

      if (dirty) {
        const identity = reviewFix ? ["-m", reviewFixTrailers(reviewFix)] : [];
        await gitOk(ctx.deps, cwd, ["add", "-A"]);
        await gitOk(ctx.deps, cwd, [
          "commit",
          "-m",
          `fix(dispatch): ${why}`,
          "-m",
          `Dispatch-Fix: ${ctx.manifest.safeSessionId}`,
          ...identity,
        ]);
        await ctx.deps.hook?.("commit:after-commit");
        hash = await gitOk(ctx.deps, cwd, ["rev-parse", "HEAD"]);
      } else {
        if (
          cleanupTrailers.length ||
          tx.fold.records.some(
            (r) =>
              r.kind === "integrate" &&
              r.data["phase"] === "test-cleanup" &&
              r.data["to"] === hash
          )
        ) {
          refuse("no-changes");
        }

        if (
          lines[0] !== `fix(dispatch): ${why}` ||
          !lines.includes(`Dispatch-Fix: ${ctx.manifest.safeSessionId}`) ||
          tx.fold.records.some(
            (r) =>
              r.kind === "integrate" &&
              r.data["phase"] === "fix" &&
              r.data["commit"] === hash
          )
        ) {
          refuse("no-changes");
        }

        const recorded = reviewFixFromCommit(message);

        if (
          recorded &&
          reviewFix &&
          stableValue(recorded) !== stableValue(reviewFix)
        ) {
          refuse("no-changes");
        }

        if (recorded) {
          reviewFix = recorded;
        } else if (reviewFix) {
          refuse("no-changes");
        }
      }

      await tx.append({
        kind: "integrate",
        by: "tool",
        data: {
          phase: "fix",
          commit: hash,
          reason: why,
          ...(reviewFix && { reviewFix }),
        },
      });

      return result({ commit: hash, reason: why });
    }
  );
};

export const abort = async (ctx: HandlerContext) => {
  const id = task(ctx);
  const why = readRequiredReason(ctx);

  return await withPostFold(
    ctx.session,
    "worktree abort",
    ctx.deps,
    async (tx) => {
      const active = pendingIntegration(tx.fold);
      const launch = candidate(tx.fold, id);

      const integration = await ensureIntegration(tx, ctx);
      const cwd = integration.path;

      const cherry = await cherryHead(ctx, cwd);

      if (
        cherry !== undefined &&
        cherry !== "" &&
        active?.data["task"] !== id
      ) {
        refuse("wrong-task");
      }

      if (!launch) {
        refuse("no-candidate");
      }

      const hash = textValue(
        present(launch.finished, "the finished launch").data["candidate"]
      );

      if (cherry !== undefined && cherry !== "" && cherry !== hash) {
        refuse("wrong-task");
      }

      if (
        (cherry === undefined || cherry === "") &&
        active?.data["task"] === id
      ) {
        const picked = await pickedCommit(ctx, cwd, hash);

        if (picked !== undefined && picked !== "") {
          await done(tx, id, picked);
          refuse("already-integrated");
        }
      }

      if (cherry !== undefined && cherry !== "") {
        await gitOk(ctx.deps, cwd, ["cherry-pick", "--abort"]);
      }

      await gitOk(ctx.deps, cwd, [
        "update-ref",
        abandonedRef(ctx.manifest.safeSessionId, id, launch.launch),
        hash,
      ]);
      await tx.append({
        kind: "integrate",
        by: "tool",
        key: `integrate-abandoned:${id}:${launch.launch}:${hash}`,
        data: { phase: "abandoned", task: id, candidate: hash, reason: why },
      });

      return result({ task: id, candidate: hash, abandoned: true });
    }
  );
};
