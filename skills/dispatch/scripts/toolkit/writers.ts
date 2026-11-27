import fs from "node:fs";
import path from "node:path";

import { isRecord } from "../lib/config.ts";
import { SESSION_WORKTREES } from "../lib/session-paths.ts";
import type { HandlerContext } from "./cli.ts";
import { gitOk, gitPaths, changedPaths, testedTree, headTree } from "./git.ts";
import { integrationEnded, integrationRecord } from "./integration-state.ts";
import { ensureIntegration } from "./integration.ts";
import { withPostFold } from "./ledger.ts";
import type { Fold } from "./ledger.ts";
import { present, textValue } from "./narrow.ts";
import { result, refuse, ToolError } from "./output.ts";
import { loadPlan, ownedPaths, taskSection } from "./plan-view.ts";
import type { LedgerRecord } from "./records.ts";

interface Launch {
  launch: number;
  record: LedgerRecord;
  finished?: LedgerRecord;
  abandoned?: LedgerRecord;
  superseded: boolean;
}

export const launches = (fold: Fold, task: string) => {
  const rows: Launch[] = [];

  for (const record of fold.records) {
    if (record.kind !== "writer" || record.data["task"] !== task) {
      continue;
    }

    if (record.data["phase"] === "launched") {
      const previous = rows.at(-1);

      if (previous && !previous.finished && !previous.abandoned) {
        previous.superseded = true;
      }

      rows.push({ launch: rows.length + 1, record, superseded: false });
    } else {
      const launch = rows.find((r) => r.launch === record.data["launch"]);

      if (launch && record.data["phase"] === "finished") {
        launch.finished = record;
      }

      if (launch && record.data["phase"] === "abandoned") {
        launch.abandoned = record;
      }
    }
  }

  return rows;
};

export const candidate = (fold: Fold, id: string) => {
  const launch = launches(fold, id).at(-1);

  if (!launch?.finished) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the unfinished and launch branches.
    return undefined;
  }

  if (integrationEnded(fold, id, launch.finished.seq)) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the ended and launch branches.
    return undefined;
  }

  return launch;
};

/** The commit, task section and seq a writer launch recorded. */
export const launchBase = (record: LedgerRecord) => {
  const base: unknown = record.data["base"];

  if (!isRecord(base)) {
    throw new TypeError("Missing the writer launch base");
  }

  return base;
};

export const isStale = (
  fold: Fold,
  launch: LedgerRecord,
  currentTaskSection: string
) =>
  launchBase(launch)["taskSection"] !== currentTaskSection ||
  fold.records.some((r) => {
    if (r.kind !== "edit" || r.seq <= Number(launchBase(launch)["seq"])) {
      return false;
    }

    const affects: unknown = r.data["affects"];

    return Array.isArray(affects) && affects.includes(launch.data["task"]);
  });

const open = (launch: Launch | undefined): launch is Launch =>
  !!launch && !launch.finished && !launch.abandoned && !launch.superseded;

export const completion = (fold: Fold, launch: Launch) => {
  const { finished } = launch;

  return (
    finished &&
    fold.records.findLast(
      (r) =>
        r.kind === "integrate" &&
        r.seq > finished.seq &&
        r.data["task"] === launch.record.data["task"] &&
        (r.data["phase"] === "done" ||
          (r.data["phase"] === "abandoned" &&
            r.data["candidate"] === finished.data["candidate"]))
    )
  );
};

interface Observation {
  exists: boolean;
  dirty: boolean;
  head: string;
}

export const writerStates = (
  fold: Fold,
  tasks: string[],
  observe: (path: string) => Observation
) =>
  tasks.flatMap((task) => {
    const rows = launches(fold, task);

    if (!rows.length) {
      return [{ task, state: "unlaunched", liveness: "unknown" }];
    }

    return rows.map((launch) => {
      const { record, finished } = launch;
      const done = completion(fold, launch);
      let state: string;

      if (launch.abandoned || launch.superseded) {
        state = "launch-abandoned";
      } else if (done) {
        state =
          done.data["phase"] === "done"
            ? "integrated"
            : "integration-abandoned";
      } else if (finished) {
        state = "candidate-unintegrated";
      } else {
        const observed = observe(textValue(record.data["path"]));

        if (!observed.exists) {
          state = "missing-worktree";
        } else if (
          observed.dirty ||
          observed.head !== launchBase(record)["commit"]
        ) {
          state = "ready-to-submit";
        } else {
          state = "no-progress";
        }
      }

      return {
        task,
        state,
        path: textValue(record.data["path"]),
        launch: launch.launch,
        ...(finished && { candidate: textValue(finished.data["candidate"]) }),
        liveness: "unknown",
      };
    });
  });

export const terminalWorktrees = (
  fold: Fold,
  observed: Record<string, { head: string }>
) => {
  const tasks = [
    ...new Set(
      fold.records
        .filter((r) => r.kind === "writer")
        .map((r) => textValue(r.data["task"]))
    ),
  ];

  const all = tasks.flatMap((task) => launches(fold, task));
  const paths = [...new Set(all.map((r) => textValue(r.record.data["path"])))];

  const terminal = paths.filter((p) => {
    const launch = present(
      all.findLast((r) => r.record.data["path"] === p),
      "the launch of a writer worktree"
    );

    return !!launch.abandoned || !!completion(fold, launch);
  });

  const integration = integrationRecord(fold);

  const delivered = fold.records.findLast(
    (r) => r.kind === "integrate" && r.data["phase"] === "delivered"
  );

  const closed = fold.records.some(
    (r) =>
      r.kind === "integrate" &&
      r.data["phase"] === "closed" &&
      r.seq > (integration?.seq ?? 0)
  );

  if (integration) {
    const integrationPath = textValue(integration.data["path"]);

    if (
      closed ||
      (!all.some(open) &&
        !all.some((r) => r.finished !== undefined && !completion(fold, r)) &&
        delivered &&
        observed[integrationPath]?.head === delivered.data["source"])
    ) {
      terminal.push(integrationPath);
    }
  }

  return terminal;
};

export const taskId = (ctx: HandlerContext) => {
  if (ctx.args.length !== 1) {
    throw new ToolError(1, "invalid-input", "One task ID is required");
  }

  const id = present(ctx.args[0], "the task ID argument");
  const plan = loadPlan(ctx.session, ctx.manifest);
  const paths = ownedPaths(plan, id);

  return {
    id,
    paths,
    section: taskSection(plan, id),
    prerequisites: present(
      plan.tasks.find((task) => task.id === id),
      "the planned task"
    ).prerequisites,
  };
};

export const candidateRef = (sid: string, task: string, launch: number) =>
  `refs/dispatch/${sid}/candidates/${task}-${launch}`;

export const abandonedRef = (sid: string, task: string, launch: number) =>
  `refs/dispatch/${sid}/abandoned/${task}-${launch}`;

export const deliveredSourceRef = (session: string) =>
  `refs/dispatch/${session}/delivered-source`;

export const create = async (ctx: HandlerContext) => {
  const { id, section, prerequisites } = taskId(ctx);

  return await withPostFold(
    ctx.session,
    "worktree create",
    ctx.deps,
    async (tx) => {
      const rows = launches(tx.fold, id);
      const previous = rows.at(-1);

      if (ctx.values["relaunch"] === true) {
        if (!open(previous)) {
          refuse("no-open-launch");
        }

        const worktreePath = textValue(previous.record.data["path"]);
        const cwd = path.resolve(ctx.session, worktreePath);

        if (!fs.existsSync(cwd)) {
          refuse("missing-worktree");
        }

        if (
          (await gitOk(ctx.deps, cwd, ["rev-parse", "HEAD"])) !==
          launchBase(previous.record)["commit"]
        ) {
          refuse("submit-pending");
        }

        await tx.append({
          kind: "writer",
          by: "tool",
          data: {
            phase: "launched",
            task: id,
            path: worktreePath,
            base: {
              ...launchBase(previous.record),
              taskSection: section,
              seq: tx.fold.lastSeq,
            },
          },
        });

        return result({
          task: id,
          launch: rows.length + 1,
          path: worktreePath,
          relaunch: true,
        });
      }

      if (!open(previous)) {
        const pending = prerequisites.filter(
          (task) =>
            !tx.fold.records.some(
              (r) =>
                r.kind === "integrate" &&
                r.data["phase"] === "done" &&
                r.data["task"] === task
            )
        );

        if (pending.length) {
          refuse(
            "prerequisite-pending",
            `Prerequisites not integrated: ${pending.join(
              ", "
            )}. Integrate them, then rerun worktree create ${id}.`
          );
        }
      }

      const integration = await ensureIntegration(tx, ctx);

      if (previous?.finished && !completion(tx.fold, previous)) {
        refuse("candidate-pending");
      }

      if (open(previous)) {
        const worktreePath = textValue(previous.record.data["path"]);
        const cwd = path.resolve(ctx.session, worktreePath);

        if (fs.existsSync(cwd)) {
          refuse("writer-open");
        }

        await gitOk(ctx.deps, ctx.manifest.repositoryRoot, [
          "worktree",
          "prune",
        ]);
        await gitOk(ctx.deps, ctx.manifest.repositoryRoot, [
          "worktree",
          "add",
          "--detach",
          cwd,
          textValue(launchBase(previous.record)["commit"]),
        ]);

        return result({
          task: id,
          launch: previous.launch,
          path: worktreePath,
          restored: true,
        });
      }

      const n = rows.length + 1;
      const relative = `${SESSION_WORKTREES}/${id}-${n}`;
      const cwd = path.resolve(ctx.session, relative);

      const listed = await gitOk(ctx.deps, ctx.manifest.repositoryRoot, [
        "worktree",
        "list",
        "--porcelain",
      ]);

      const registered = listed
        .split(/\r?\n/u)
        .filter((l) => l.startsWith("worktree "))
        .some((l) => path.resolve(l.slice(9)) === cwd);

      let base: string;

      if (
        registered &&
        !tx.fold.records.some(
          (r) => r.kind === "writer" && r.data["path"] === relative
        )
      ) {
        base = await gitOk(ctx.deps, cwd, ["rev-parse", "HEAD"]);

        for (const r of tx.fold.records) {
          if (r.kind !== "integrate" || r.data["phase"] !== "done") {
            continue;
          }

          const prerequisite = textValue(r.data["task"]);

          if (!prerequisites.includes(prerequisite)) {
            continue;
          }

          const commit = textValue(r.data["commit"]);

          if (
            // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
            (await gitOk(ctx.deps, cwd, ["merge-base", commit, base])) !==
            commit
          ) {
            refuse(
              "stale-worktree",
              `Unlaunched worktree ${relative} predates prerequisite ${
                prerequisite
              }. Preserve any untracked or ignored files it holds, remove it, then rerun worktree create ${
                id
              }.`
            );
          }
        }
      } else {
        base = await gitOk(ctx.deps, integration.path, ["rev-parse", "HEAD"]);
        await gitOk(ctx.deps, ctx.manifest.repositoryRoot, [
          "worktree",
          "add",
          "--detach",
          cwd,
          base,
        ]);
        await ctx.deps.hook?.("create:after-add");
      }

      await tx.append({
        kind: "writer",
        by: "tool",
        data: {
          phase: "launched",
          task: id,
          path: relative,
          base: { commit: base, taskSection: section, seq: tx.fold.lastSeq },
        },
      });

      return result({ task: id, launch: n, path: relative });
    }
  );
};

export const submit = async (ctx: HandlerContext) => {
  const { id, paths } = taskId(ctx);

  return await withPostFold(
    ctx.session,
    "worktree submit",
    ctx.deps,
    async (tx) => {
      const launch = launches(tx.fold, id).at(-1);

      if (!open(launch)) {
        refuse("no-open-launch");
      }

      const cwd = path.resolve(
        ctx.session,
        textValue(launch.record.data["path"])
      );

      const base = textValue(launchBase(launch.record)["commit"]);
      let head = await gitOk(ctx.deps, cwd, ["rev-parse", "HEAD"]);

      if (head === base) {
        const changed = await changedPaths(ctx.deps, cwd, base);
        const outside = changed.filter((p) => !paths.includes(p));

        if (outside.length) {
          refuse("out-of-scope", JSON.stringify({ paths: outside }));
        }

        if (!changed.length) {
          refuse("no-changes");
        }

        await gitOk(ctx.deps, cwd, ["add", "-A"]);
        // NOTE: plumbing skips host hooks, which may stage unowned generated files; integration commits still run them.
        head = await gitOk(ctx.deps, cwd, [
          "commit-tree",
          await gitOk(ctx.deps, cwd, ["write-tree"]),
          "-p",
          base,
          "-m",
          `chore(dispatch): ${id} launch ${launch.launch}`,
        ]);
        await gitOk(ctx.deps, cwd, ["reset", "--soft", head]);
        await ctx.deps.hook?.("submit:after-commit");
      } else {
        const parent = await gitOk(ctx.deps, cwd, ["rev-parse", "HEAD^"]);

        if (parent !== base) {
          refuse(
            "submit-pending",
            "Writer HEAD is not one commit beyond its base"
          );
        }

        const diff = await gitPaths(ctx.deps, cwd, [
          "diff",
          "--name-only",
          "--no-renames",
          "-z",
          base,
          head,
          "--",
        ]);

        const outside = diff.filter((p) => !paths.includes(p));

        if (outside.length) {
          await gitOk(ctx.deps, cwd, ["reset", "--soft", base]);
          refuse("out-of-scope", JSON.stringify({ paths: outside }));
        }
      }

      await gitOk(ctx.deps, cwd, [
        "update-ref",
        candidateRef(ctx.manifest.safeSessionId, id, launch.launch),
        head,
      ]);
      await tx.append({
        kind: "writer",
        by: "tool",
        data: {
          phase: "finished",
          task: id,
          launch: launch.launch,
          candidate: head,
        },
      });

      return result({
        task: id,
        launch: launch.launch,
        candidate: head,
        uncommitted: await changedPaths(ctx.deps, cwd, head),
      });
    }
  );
};

export const abandon = async (ctx: HandlerContext) => {
  const { id } = taskId(ctx);
  const { reason } = ctx.values;

  if (typeof reason !== "string" || !reason.trim()) {
    throw new ToolError(1, "invalid-input", "A non-blank --reason is required");
  }

  return await withPostFold(
    ctx.session,
    "worktree abandon",
    ctx.deps,
    async (tx) => {
      const launch = launches(tx.fold, id).at(-1);

      if (!open(launch)) {
        refuse("no-open-launch");
      }

      const worktreePath = textValue(launch.record.data["path"]);
      const cwd = path.resolve(ctx.session, worktreePath);
      const head = await gitOk(ctx.deps, cwd, ["rev-parse", "HEAD"]);

      if (head !== launchBase(launch.record)["commit"]) {
        refuse("submit-pending");
      }

      const tree = await testedTree(ctx.deps, ctx.session, cwd);

      if (tree !== (await headTree(ctx.deps, cwd))) {
        const commit = await gitOk(ctx.deps, cwd, [
          "commit-tree",
          tree,
          "-p",
          head,
          "-m",
          `dispatch abandoned: ${id}`,
        ]);

        await gitOk(ctx.deps, cwd, [
          "update-ref",
          abandonedRef(ctx.manifest.safeSessionId, id, launch.launch),
          commit,
        ]);
      }

      await tx.append({
        kind: "writer",
        by: "tool",
        data: { phase: "abandoned", task: id, launch: launch.launch, reason },
      });

      return result({
        task: id,
        launch: launch.launch,
        path: worktreePath,
        abandoned: true,
      });
    }
  );
};
