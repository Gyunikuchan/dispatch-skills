import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { isRecord } from "../lib/config.ts";
import { nodeErrorCode } from "../lib/fs-ext.ts";
import { SESSION_WORKTREES } from "../lib/session-paths.ts";
import type { HandlerContext, CliDeps } from "./cli.ts";
import { loadRejections, applicableReviewIds } from "./confirmations.ts";
import { coverageState } from "./coverage.ts";
import { admission } from "./findings.ts";
import {
  git,
  gitOk,
  gitRaw,
  gitPaths,
  splitPaths,
  changedPaths,
  testedTree,
} from "./git.ts";
import { readRequiredReason, readTextPayload } from "./input.ts";
import {
  currentRuntimeVerification,
  integrationRecord,
  pendingIntegration,
} from "./integration-state.ts";
import { withPostFold } from "./ledger.ts";
import { present, textValue } from "./narrow.ts";
import { ToolError, capSummary, result, refuse } from "./output.ts";
import { INTEGRATION_REVIEW } from "./review-state.ts";
import {
  terminalWorktrees,
  launches,
  launchBase,
  candidateRef,
  abandonedRef,
  deliveredSourceRef,
} from "./writers.ts";

const overlaps = (p: string, q: string) =>
  p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`);

interface Destination {
  path: string;
  branch: string;
}

const isDestination = (value: unknown): value is Destination =>
  isRecord(value) &&
  typeof value["path"] === "string" &&
  typeof value["branch"] === "string";

const destinationOf = (value: unknown) => {
  if (!isDestination(value)) {
    throw new TypeError("Missing the delivery destination");
  }

  return value;
};

const matchesDestination = (value: unknown, dest: Destination) =>
  isDestination(value) &&
  value.path === dest.path &&
  value.branch === dest.branch;

const settledValue = <T>(row: PromiseSettledResult<T>) => {
  if (row.status === "rejected") {
    throw row.reason;
  }

  return row.value;
};

const blockedRecovery = (message: string): never =>
  refuse(
    "recovery-blocked",
    `${
      message
    }; preserve session refs and worktrees, inspect recovery evidence or start a new run`
  );

const isRegistered = (paths: string[], cwd: string) =>
  paths.some((p) => samePath(p, cwd));

const locks = (env?: NodeJS.ProcessEnv) => ({
  GIT_OPTIONAL_LOCKS: "0",
  ...env,
});

const tempIndexFile = (session: string, name: string) => {
  const file = path.join(session, ".state", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  for (const f of [file, `${file}.lock`]) {
    fs.rmSync(f, { force: true });
  }

  return file;
};

// Paths of `subset` whose working-tree state equals `tree`, judged by Git through a session-owned temporary index.
const pathsEqualTo = async (
  deps: CliDeps,
  session: string,
  destPath: string,
  tree: string,
  subset: string[]
) => {
  if (!subset.length) {
    return new Set();
  }

  const index = tempIndexFile(session, "deliver-check-index");
  const env = { GIT_INDEX_FILE: index };

  try {
    await gitRaw(deps, destPath, ["read-tree", tree], locks(env));
    await gitRaw(
      deps,
      destPath,
      ["update-index", "-q", "--refresh"],
      locks(env)
    );

    const differing = new Set(
      await gitPaths(
        deps,
        destPath,
        ["diff-files", "--name-only", "-z"],
        locks(env)
      )
    );

    const others = await gitPaths(
      deps,
      destPath,
      ["ls-files", "--others", "-z"],
      locks(env)
    );

    return new Set(
      subset.filter(
        (p) =>
          !differing.has(p) &&
          !others.some((o) => o === p || o.startsWith(`${p}/`))
      )
    );
  } finally {
    for (const f of [index, `${index}.lock`]) {
      fs.rmSync(f, { force: true });
    }
  }
};

export const deliver = async (ctx: HandlerContext) => {
  if (ctx.args.length) {
    throw new ToolError(1, "invalid-input", "deliver takes no task");
  }

  if (
    ctx.values["commit"] !== undefined ||
    ctx.values["message"] !== undefined
  ) {
    return await commitDelivered(ctx);
  }

  return await withPostFold(
    ctx.session,
    "worktree deliver",
    ctx.deps,
    // oxlint-disable-next-line eslint/complexity -- worktree-deliver guard branches per pending integration, git refs, and recorded entries.
    async (tx) => {
      const active = pendingIntegration(tx.fold);

      if (active) {
        refuse("integration-pending", textValue(active.data["task"]));
      }

      const opened = integrationRecord(tx.fold);

      if (!opened) {
        refuse("no-integration");
      }

      const cwd = path.resolve(ctx.session, textValue(opened.data["path"]));
      const dest = destinationOf(opened.data["dest"]);

      const read = async (root: string, args: string[]) =>
        await gitOk(ctx.deps, root, args, { GIT_OPTIONAL_LOCKS: "0" });

      const rawOut = async (
        root: string,
        args: string[],
        env?: NodeJS.ProcessEnv,
        stdin?: string
      ) => await gitRaw(ctx.deps, root, args, locks(env), stdin);

      const names = async (
        root: string,
        args: string[],
        env?: NodeJS.ProcessEnv
      ) => await gitPaths(ctx.deps, root, args, locks(env));

      const from = textValue(opened.data["base"]);
      // Cleanup may have removed the integration worktree after a completed delivery; the retry then relies on recorded identities.
      const integrationPresent = fs.existsSync(cwd);

      const source = integrationPresent
        ? await read(cwd, ["rev-parse", "HEAD"])
        : undefined;

      const ref = deliveredSourceRef(ctx.manifest.safeSessionId);

      const last = tx.fold.records.findLast(
        (r) =>
          r.kind === "integrate" &&
          r.data["phase"] === "delivered" &&
          matchesDestination(r.data["dest"], dest)
      );

      // Recursive raw diff: every delivered path is a leaf entry (blob, symlink or gitlink) or absent.
      const entriesOf = async (root: string, target: string) => {
        const tokens = splitPaths(
          await rawOut(root, [
            "diff",
            "--raw",
            "-z",
            "--no-renames",
            "--no-abbrev",
            from,
            target,
            "--",
          ])
        );

        const rows: {
          path: string;
          modes: [string, string];
          sourceOid: string;
        }[] = [];

        for (let i = 0; i + 1 < tokens.length; i += 2) {
          const [oldMode, newMode, , sourceOid] = present(
            tokens[i],
            "raw diff metadata"
          )
            .slice(1)
            .split(" ");

          rows.push({
            path: present(tokens[i + 1], "raw diff path"),
            modes: [
              present(oldMode, "raw diff old mode"),
              present(newMode, "raw diff new mode"),
            ],
            sourceOid: present(sourceOid, "raw diff object id"),
          });
        }

        return rows;
      };

      if (last) {
        const recorded = textValue(last.data["source"]);

        if (source !== undefined && recorded !== source) {
          blockedRecovery(
            "Integration source changed after completed delivery"
          );
        }

        const recordedPaths = await entriesOf(dest.path, recorded);

        return result({
          mode: "uncommitted",
          dest,
          from: textValue(last.data["from"]),
          source: recorded,
          ref,
          paths: recordedPaths.map((e) => e.path),
          delivered: false,
          ...(last.data["noop"] === true && { noop: true }),
        });
      }

      if (source === undefined) {
        refuse(
          "no-integration",
          "Integration worktree is missing and no completed delivery is recorded"
        );
      }

      const checkSource = async () => {
        if (
          loadRejections(
            ctx.session,
            tx.fold,
            applicableReviewIds(ctx.manifest, tx.fold)
          ).some((state) => state.state !== "confirmed")
        ) {
          refuse("review-confirmation-required");
        }

        const [head, dirty, cached] = await Promise.allSettled([
          read(cwd, ["rev-parse", "HEAD"]),
          changedPaths(ctx.deps, cwd, "HEAD"),
          names(cwd, [
            "diff",
            "--cached",
            "--name-only",
            "--no-renames",
            "-z",
            "HEAD",
            "--",
          ]),
        ]);

        if (settledValue(head) !== source) {
          blockedRecovery("Integration source changed during delivery");
        }

        if (settledValue(dirty).length || settledValue(cached).length) {
          refuse("integration-dirty");
        }
      };

      await checkSource();

      const noop =
        (await read(cwd, ["rev-parse", `${source}^{tree}`])) ===
        (await read(cwd, ["rev-parse", `${from}^{tree}`]));

      const entries = await entriesOf(cwd, source);
      const paths = entries.map((e) => e.path);

      const started = tx.fold.records.findLast(
        (r) =>
          r.kind === "integrate" &&
          r.data["phase"] === "deliver-started" &&
          matchesDestination(r.data["dest"], dest)
      );

      if (
        started &&
        (started.data["source"] !== source || started.data["from"] !== from)
      ) {
        blockedRecovery(
          "Unfinished delivery has a different source or caller base"
        );
      }

      // A started delivery recovers under existing rules; a new one needs settled coverage before any caller write.
      if (!started) {
        if (!currentRuntimeVerification(tx.fold, opened.seq)) {
          refuse("verification-required");
        }

        const applies = applicableReviewIds(ctx.manifest, tx.fold).get(
          INTEGRATION_REVIEW
        );

        const c = coverageState(
          ctx.session,
          tx.fold,
          INTEGRATION_REVIEW,
          applies
        );

        // The message follows launch admission, which can stop a rerun for a user decision once the coverage round is used.
        const budget = c.open.length
          ? admission(ctx.session, tx.fold, INTEGRATION_REVIEW, 0, applies)
              .budget
          : null;

        const user = budget?.state === "requires-coverage-decision";

        if (c.decision === "rerun" || c.decision === "user") {
          refuse(
            "coverage-required",
            `Review coverage: ${
              c.open.length
                ? `open slots ${c.open.join(", ")}${
                    user
                      ? `; needs a user decision: accept reduced coverage${
                          budget.nextRound > budget.ceiling
                            ? ""
                            : " or grant one more coverage round"
                        }`
                      : "; rerun them"
                  }`
                : `round ${c.incomplete} is incomplete`
            }`
          );
        }
      }

      const retained = await git(
        ctx.deps,
        cwd,
        ["rev-parse", "--verify", "--quiet", ref],
        { GIT_OPTIONAL_LOCKS: "0" }
      );

      if (retained.exit === 0 && retained.stdout.trim() !== source) {
        blockedRecovery("Delivered-source ref points to a different commit");
      }

      const zero = "0".repeat(source.length);

      // SECTION: path state against a tree, judged by Git through a session-owned temporary index
      const tempIndex = (name: string) => tempIndexFile(ctx.session, name);

      const equalTo = async (tree: string, subset: string[]) =>
        await pathsEqualTo(ctx.deps, ctx.session, dest.path, tree, subset);

      // SECTION: caller guard
      const named = (blocked: string[]): never =>
        refuse(
          "caller-dirty",
          `Caller paths overlap delivered paths: ${blocked.join(
            ", "
          )}; restore with git restore --source=${
            ref
          } -- <path>, or move or discard them`
        );

      const checkCaller = async (resuming: boolean) => {
        const observed = await Promise.allSettled([
          git(
            ctx.deps,
            dest.path,
            ["symbolic-ref", "--quiet", "--short", "HEAD"],
            { GIT_OPTIONAL_LOCKS: "0" }
          ),
          read(dest.path, ["rev-parse", "HEAD"]),
          names(dest.path, [
            "diff",
            "--cached",
            "--ita-visible-in-index",
            "--name-only",
            "--no-renames",
            "-z",
            "--",
          ]),
          git(ctx.deps, dest.path, ["config", "--bool", "core.sparseCheckout"]),
        ]);

        const branch = settledValue(observed[0]);

        if (
          branch.exit ||
          branch.stdout.trim() !== dest.branch ||
          settledValue(observed[1]) !== from
        ) {
          refuse("caller-moved");
        }

        if (settledValue(observed[3]).stdout.trim() === "true") {
          refuse("unsupported-sparse");
        }

        if (entries.some((e) => e.modes.includes("160000"))) {
          refuse("unsupported-entry");
        }

        if (settledValue(observed[2]).length) {
          refuse("caller-dirty");
        }

        const dirty = [
          ...new Set([
            ...(await names(dest.path, [
              "diff",
              "--name-only",
              "--no-renames",
              "-z",
              "HEAD",
              "--",
            ])),
            ...(await names(dest.path, [
              "ls-files",
              "--others",
              "--exclude-standard",
              "-z",
            ])),
            ...(await names(dest.path, [
              "ls-files",
              "--others",
              "--ignored",
              "--exclude-standard",
              "-z",
            ])),
          ]),
        ].filter((p) => paths.some((q) => overlaps(p, q)));

        if (!dirty.length) {
          return;
        }

        if (!resuming) {
          named(dirty);
        }

        // Resuming: an earlier attempt may have written some delivered paths; only exact delivered paths still at `from` or `source` are ours.
        const known = new Set(paths);

        if (dirty.some((p) => !known.has(p))) {
          named(dirty.filter((p) => !known.has(p)));
        }

        const ours = new Set([
          ...(await equalTo(from, dirty)),
          ...(await equalTo(source, dirty)),
        ]);

        if (dirty.some((p) => !ours.has(p))) {
          named(dirty.filter((p) => !ours.has(p)));
        }
      };

      // SECTION: apply through Git's two-tree merge so bytes, modes, symlinks, deletions and dir/file swaps are Git's own
      const apply = async () => {
        if (!paths.length) {
          return;
        }

        const index = tempIndex("deliver-index");
        const env = { GIT_INDEX_FILE: index };

        try {
          await rawOut(dest.path, ["read-tree", from], env);
          let mergeBase = from;
          // Paths a crashed attempt already wrote must enter the merge as `source`, or Git sees them as locally modified.
          const atSource = await equalTo(source, paths);

          if (atSource.size) {
            const applied = entries.filter((entry) => atSource.has(entry.path));

            const removed = applied
              .filter((entry) => entry.sourceOid === zero)
              .map((entry) => `0 ${zero}\t${entry.path}\0`);

            const added = applied
              .filter((entry) => entry.sourceOid !== zero)
              .map(
                (entry) =>
                  `${entry.modes[1]} ${entry.sourceOid}\t${entry.path}\0`
              );

            await rawOut(
              dest.path,
              ["update-index", "-z", "--index-info"],
              env,
              [...removed, ...added].join("")
            );
            // Git checks directory/file conflicts against the merge base as well as the index.
            const writtenTree = await rawOut(dest.path, ["write-tree"], env);
            mergeBase = writtenTree.trim();
          }

          await rawOut(dest.path, ["update-index", "-q", "--refresh"], env);

          const merged = await git(
            ctx.deps,
            dest.path,
            ["read-tree", "-m", "-u", mergeBase, source],
            {
              GIT_OPTIONAL_LOCKS: "0",
              ...env,
            }
          );

          if (merged.exit) {
            if (
              /overwritten|not uptodate|untracked|Entry '/iu.test(merged.stderr)
            ) {
              refuse("caller-dirty");
            }

            throw new ToolError(
              2,
              "fault",
              merged.stderr || merged.stdout || "Git read-tree failed"
            );
          }
        } finally {
          for (const f of [index, `${index}.lock`]) {
            fs.rmSync(f, { force: true });
          }
        }
      };

      const verifyApplied = async () => {
        const [branch, head, cached] = await Promise.all([
          git(ctx.deps, dest.path, [
            "symbolic-ref",
            "--quiet",
            "--short",
            "HEAD",
          ]),
          read(dest.path, ["rev-parse", "HEAD"]),
          names(dest.path, [
            "diff",
            "--cached",
            "--ita-visible-in-index",
            "--name-only",
            "-z",
            "--",
          ]),
        ]);

        if (
          branch.exit ||
          branch.stdout.trim() !== dest.branch ||
          head !== from ||
          cached.length
        ) {
          refuse("caller-dirty");
        }

        const callerTree = await equalTo(source, paths);

        if (callerTree.size !== paths.length) {
          refuse("caller-dirty");
        }
      };

      // SECTION: delivery sequence
      await checkCaller(!!started);

      if (retained.exit !== 0) {
        await gitOk(ctx.deps, cwd, ["update-ref", ref, source, zero]);
      }

      await ctx.deps.hook?.("deliver:after-preserve");
      const data = { mode: "uncommitted", dest, from, source };

      if (!started) {
        await tx.append({
          kind: "integrate",
          by: "tool",
          data: { phase: "deliver-started", ...data },
        });
      }

      await ctx.deps.hook?.("deliver:after-started");
      await ctx.deps.hook?.("deliver:before-apply");
      await checkSource();
      await checkCaller(true);
      await apply();
      await ctx.deps.hook?.("deliver:after-apply");
      await checkSource();
      await verifyApplied();
      await tx.append({
        kind: "integrate",
        by: "tool",
        data: { phase: "delivered", ...data, ...(noop && { noop: true }) },
      });
      await ctx.deps.hook?.("deliver:after-delivered");

      return result({
        ...data,
        ref,
        paths,
        delivered: true,
        ...(noop && { noop: true }),
      });
    }
  );
};

// SECTION: commit phase; one caller commit for a delivered increment, or a record of the user's own commit
const commitDelivered = async (ctx: HandlerContext) => {
  const message = readTextPayload(ctx, {
    fileFlag: "commit",
    inlineFlag: "message",
    label: "commit message",
  });

  return await withPostFold(
    ctx.session,
    "worktree deliver",
    ctx.deps,
    // oxlint-disable-next-line eslint/complexity -- commit branches per delivered record, recorded commit, and differing payload.
    async (tx) => {
      const delivered = tx.fold.records.findLast(
        (r) => r.kind === "integrate" && r.data["phase"] === "delivered"
      );

      if (!delivered) {
        return refuse("not-delivered", "No delivered record in this session");
      }

      const dest = destinationOf(delivered.data["dest"]);
      const from = textValue(delivered.data["from"]);
      const source = textValue(delivered.data["source"]);

      const recorded = tx.fold.records.findLast(
        (r) =>
          r.kind === "integrate" &&
          r.seq > delivered.seq &&
          r.data["phase"] === "committed" &&
          r.data["source"] === source
      );

      if (recorded) {
        const recordedDiffering: unknown = recorded.data["differing"];

        return result({
          commit: textValue(recorded.data["commit"]),
          source,
          from,
          dest,
          committed: false,
          recordOnly: true,
          ...(Boolean(recordedDiffering) && { differing: recordedDiffering }),
        });
      }

      const run = async (args: string[]) =>
        await git(ctx.deps, dest.path, args, { GIT_OPTIONAL_LOCKS: "0" });

      const read = async (args: string[]) =>
        await gitOk(ctx.deps, dest.path, args, { GIT_OPTIONAL_LOCKS: "0" });

      const names = async (args: string[]) =>
        await gitPaths(ctx.deps, dest.path, args, { GIT_OPTIONAL_LOCKS: "0" });

      const state = async () => {
        const branch = await run([
          "symbolic-ref",
          "--quiet",
          "--short",
          "HEAD",
        ]);

        return {
          branch: branch.exit ? "" : branch.stdout.trim(),
          head: await read(["rev-parse", "HEAD"]),
        };
      };

      const indexTree = async () => {
        const out = await git(ctx.deps, dest.path, ["write-tree"]);

        if (out.exit) {
          refuse(
            "staged-changes",
            `Git cannot write the index tree: ${capSummary(
              out.stderr || out.stdout
            )}`
          );
        }

        return out.stdout.trim();
      };

      const isAncestor = async (ancestor: string, descendant: string) => {
        const out = await run([
          "merge-base",
          "--is-ancestor",
          ancestor,
          descendant,
        ]);

        if (out.exit > 1) {
          throw new ToolError(
            2,
            "fault",
            out.stderr || out.stdout || `Git exited ${out.exit}`
          );
        }

        return out.exit === 0;
      };

      const paths = await names([
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        from,
        source,
        "--",
      ]);

      const known = new Set(paths);
      const overlap = (p: string) => paths.some((q) => overlaps(p, q));

      const caller = await state();

      if (caller.branch !== dest.branch) {
        refuse(
          "caller-moved",
          `Checked-out branch is not the delivered branch ${dest.branch}`
        );
      }

      let commit = caller.head;
      let recordOnly = true;
      let differing: string[];

      const warnings: string[] = [];

      if (caller.head === from) {
        // SECTION: commit; preconditions block, checks after the commit warn
        const flags = [
          "--cached",
          "--ita-visible-in-index",
          "--name-only",
          "--no-renames",
          "-z",
        ];

        const staged = await names(["diff", ...flags, "HEAD", "--"]);

        const stagedVsSource = new Set(
          await names(["diff", ...flags, source, "--"])
        );

        const stray = staged.filter(
          (p) => !known.has(p) || stagedVsSource.has(p)
        );

        if (stray.length) {
          refuse(
            "staged-changes",
            `Staged changes block the commit: ${stray.join(
              ", "
            )}; unstage or commit them first`
          );
        }

        const equal = await pathsEqualTo(
          ctx.deps,
          ctx.session,
          dest.path,
          source,
          paths
        );

        const changed = paths.filter((p) => !equal.has(p));

        if (changed.length) {
          refuse(
            "delivered-content-changed",
            `Caller content differs from the delivered source at: ${changed.join(
              ", "
            )}`
          );
        }

        const before = await indexTree();
        await ctx.deps.hook?.("deliver:before-commit");
        // NOTE: Git has no lock spanning read-tree and commit; the checks after the commit cover the remaining window.
        const now = await state();

        if (now.branch !== caller.branch || now.head !== caller.head) {
          refuse(
            "caller-moved",
            "Caller branch or HEAD changed before the commit"
          );
        }

        if ((await indexTree()) !== before) {
          refuse("staged-changes", "The index changed before the commit");
        }

        const empty =
          (await read(["rev-parse", `${source}^{tree}`])) ===
          (await read(["rev-parse", `${from}^{tree}`]));

        await gitOk(ctx.deps, dest.path, ["read-tree", source]);

        const made = await git(
          ctx.deps,
          dest.path,
          ["commit", "-q", ...(empty ? ["--allow-empty"] : []), "-F", "-"],
          undefined,
          message
        );

        if (made.exit) {
          await gitOk(ctx.deps, dest.path, ["read-tree", before]);
          refuse(
            "commit-failed",
            `git commit failed: ${capSummary(
              made.stderr || made.stdout
            )}; the prior index is restored`
          );
        }

        await ctx.deps.hook?.("deliver:after-commit");
        const after = await state();
        commit = after.head;
        recordOnly = false;

        if (
          after.branch !== dest.branch ||
          !(await isAncestor(commit, `refs/heads/${dest.branch}`))
        ) {
          refuse(
            "caller-moved",
            `Commit ${commit} is not on branch ${
              dest.branch
            }; a hook moved the caller`
          );
        }

        const parentLine = await read([
          "rev-list",
          "--parents",
          "-n",
          "1",
          commit,
        ]);

        const parents = parentLine.split(" ").slice(1);

        if (parents.length !== 1 || parents[0] !== from) {
          warnings.push(
            `Commit ${commit} has parent ${parents.join(", ")} instead of ${
              from
            }; another process committed in the caller`
          );
        }

        const settled = await pathsEqualTo(
          ctx.deps,
          ctx.session,
          dest.path,
          source,
          paths
        );

        differing = [
          ...new Set([
            ...(await names([
              "diff",
              "--name-only",
              "--no-renames",
              "-z",
              source,
              commit,
              "--",
            ])),
            ...paths.filter((p) => !settled.has(p)),
          ]),
        ];
      } else {
        // SECTION: record-only; the user committed the delivered paths
        if (!(await isAncestor(from, caller.head))) {
          refuse(
            "head-not-descendant",
            `HEAD does not descend from the delivery base ${from}`
          );
        }

        const dirty = [
          ...new Set([
            ...(await names([
              "diff",
              "--name-only",
              "--no-renames",
              "-z",
              "HEAD",
              "--",
            ])),
            ...(await names([
              "ls-files",
              "--others",
              "--exclude-standard",
              "-z",
            ])),
            ...(await names([
              "ls-files",
              "--others",
              "--ignored",
              "--exclude-standard",
              "-z",
            ])),
          ]),
        ].filter(overlap);

        if (dirty.length) {
          refuse(
            "delivered-uncommitted",
            `Delivered paths have uncommitted changes: ${dirty.join(
              ", "
            )}; commit or discard them`
          );
        }

        // Later user commits may change other paths; only paths that overlap the delivered paths count.
        const nameOutput = await names([
          "diff",
          "--name-only",
          "--no-renames",
          "-z",
          source,
          caller.head,
          "--",
        ]);

        differing = nameOutput.filter(overlap);
      }

      if (differing.length) {
        warnings.push(
          `Delivered source differs from the caller at: ${differing.join(", ")}`
        );
      }

      await tx.append({
        kind: "integrate",
        by: "tool",
        data: {
          phase: "committed",
          commit,
          source,
          ...(differing.length && { differing }),
        },
      });

      return result({
        commit,
        source,
        from,
        dest,
        committed: true,
        recordOnly,
        ...(differing.length && { differing }),
        ...(warnings.length && { warning: warnings.join("; ") }),
      });
    }
  );
};

export const close = async (ctx: HandlerContext) => {
  const why = readRequiredReason(ctx);

  if (ctx.args.length) {
    throw new ToolError(1, "invalid-input", "close takes no task");
  }

  return await withPostFold(
    ctx.session,
    "worktree close",
    ctx.deps,
    async (tx) => {
      await tx.append({
        kind: "integrate",
        by: "tool",
        data: { phase: "closed", reason: why },
      });

      return result({ closed: true, reason: why });
    }
  );
};

interface RemovalRefusal {
  exit: number;
  message: string;
}

interface RemoveExit {
  exit: number;
  stdout: string;
  stderr: string;
}

const rmWorktreeDir = async (
  dir: string,
  deps: CliDeps,
  attempts = 20,
  delayMs = 100
) => {
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });

      return;
    } catch (error: unknown) {
      const code = nodeErrorCode(error);

      if ((code === "EPERM" || code === "EBUSY") && i < attempts - 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
        await (deps.sleep === undefined ? delay(delayMs) : deps.sleep(delayMs));
        continue;
      }

      throw error;
    }
  }
};

const samePath = (a: string, b: string) => {
  const left = path.resolve(a).replace(/^\\\\\?\\/u, "");
  const right = path.resolve(b).replace(/^\\\\\?\\/u, "");

  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
};

const recoverySibling = (cwd: string) =>
  path.join(path.dirname(cwd), `.${path.basename(cwd)}.cleanup-recovery`);

const hasPathEntry = (file: string) => {
  try {
    fs.lstatSync(file);

    return true;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      return false;
    }

    throw error;
  }
};

// oxlint-disable-next-line eslint/complexity -- worktree control branches per directory entry, path containment, and admin match.
const worktreeControl = async (
  root: string,
  cwd: string,
  deps: CliDeps,
  linkCwd = cwd,
  restoreMissing = true
) => {
  const common = fs.realpathSync(
    path.resolve(
      root,
      await gitOk(deps, root, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])
    )
  );

  const worktrees = path.join(common, "worktrees");
  const registeredLink = path.join(cwd, ".git");
  const linkFile = path.join(linkCwd, ".git");
  const matches: string[] = [];

  for (const entry of fs.readdirSync(worktrees, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const admin = fs.realpathSync(path.join(worktrees, entry.name));
      const relative = path.relative(worktrees, admin);

      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        continue;
      }

      const commonText = fs
        .readFileSync(path.join(admin, "commondir"), "utf-8")
        .trim();

      if (!samePath(path.resolve(admin, commonText), common)) {
        continue;
      }

      const target = fs
        .readFileSync(path.join(admin, "gitdir"), "utf-8")
        .trim();

      if (
        target &&
        samePath(path.resolve(admin, target), registeredLink) &&
        fs.existsSync(path.join(admin, "HEAD"))
      ) {
        matches.push(admin);
      }
    } catch {
      continue;
    }
  }

  const [admin] = matches;

  if (matches.length !== 1 || admin === undefined) {
    throw Object.assign(
      new Error("Git worktree control metadata is missing or ambiguous"),
      {
        code: "CONTROL_METADATA_UNVERIFIABLE",
      }
    );
  }

  const file = linkFile;
  let link: string | undefined;

  try {
    if (!fs.lstatSync(file).isFile()) {
      throw Object.assign(
        new Error("Git worktree control link is not a regular file"),
        {
          code: "CONTROL_METADATA_UNVERIFIABLE",
        }
      );
    }

    link = fs.readFileSync(file, "utf-8");
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }

  if (link === undefined) {
    if (!restoreMissing) {
      throw Object.assign(
        new Error("Recovery directory has no registered Git control link"),
        {
          code: "CONTROL_METADATA_UNVERIFIABLE",
        }
      );
    }

    link = `gitdir: ${path.relative(linkCwd, admin).replaceAll("\\", "/")}\n`;
    fs.writeFileSync(file, link, { flag: "wx" });
  } else {
    const linked = /^gitdir:\s*(?<cap1>.+?)\s*$/mu.exec(link)?.[1];

    if (
      linked === undefined ||
      linked === "" ||
      !samePath(path.resolve(linkCwd, linked), admin)
    ) {
      throw Object.assign(
        new Error(
          "Git worktree control link does not match registered metadata"
        ),
        {
          code: "CONTROL_METADATA_UNVERIFIABLE",
        }
      );
    }
  }
};

const probeWorktreeMove = (cwd: string) => {
  const probe = recoverySibling(cwd);

  if (hasPathEntry(probe)) {
    throw Object.assign(
      new Error(`A cleanup recovery path already exists: ${probe}`),
      {
        code: "WORKTREE_RECOVERY_PATH_OCCUPIED",
        recoveryPath: probe,
      }
    );
  }

  // Keep a failed rename round trip at one deterministic sibling for retry discovery.
  fs.renameSync(cwd, probe);

  try {
    fs.renameSync(probe, cwd);
  } catch (error) {
    try {
      fs.renameSync(probe, cwd);
    } catch (restoreError) {
      throw Object.assign(
        new Error(
          `Could not restore worktree path after removal preflight; recovery path: ${
            probe
          }; ${String(restoreError)}`
        ),
        { code: "WORKTREE_RESTORE_FAILED", recoveryPath: probe }
      );
    }

    throw error;
  }
};

export const cleanup = async (ctx: HandlerContext) => {
  if (ctx.args.length) {
    throw new ToolError(1, "invalid-input", "cleanup takes no task");
  }

  return await withPostFold(
    ctx.session,
    "worktree cleanup",
    ctx.deps,
    // oxlint-disable-next-line eslint/complexity -- cleanup branches per registered worktree, recovery path, and boundary containment.
    async (tx) => {
      const root = ctx.manifest.repositoryRoot;
      const boundary = path.resolve(ctx.session, SESSION_WORKTREES);

      const physicalBoundary = path.join(
        fs.realpathSync(ctx.session),
        SESSION_WORKTREES
      );

      const listRegistered = async () => {
        const porcelain = await gitOk(ctx.deps, root, [
          "worktree",
          "list",
          "--porcelain",
        ]);

        return porcelain
          .split(/\r?\n\r?\n/u)
          .map((block) =>
            block
              .split(/\r?\n/u)
              .find((l) => l.startsWith("worktree "))
              ?.slice(9)
          )
          .filter((v): v is string => v !== undefined && v !== "")
          .map((p) => path.resolve(p));
      };

      const registered = await listRegistered();

      const verifyRecovery = async (cwd: string, recovery: string) => {
        if (!samePath(recovery, recoverySibling(cwd))) {
          throw Object.assign(
            new Error(
              "Cleanup recovery path does not match its owned worktree"
            ),
            {
              code: "WORKTREE_RECOVERY_UNVERIFIABLE",
            }
          );
        }

        const stat = fs.lstatSync(recovery);

        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw Object.assign(
            new Error("Cleanup recovery path is not a regular directory"),
            {
              code: "WORKTREE_RECOVERY_UNVERIFIABLE",
            }
          );
        }

        const parent = fs.realpathSync(path.dirname(recovery));
        const parentRelative = path.relative(physicalBoundary, parent);

        if (
          parentRelative.startsWith("..") ||
          path.isAbsolute(parentRelative)
        ) {
          throw Object.assign(
            new Error(
              "Cleanup recovery parent resolves outside the worktree boundary"
            ),
            {
              code: "WORKTREE_RECOVERY_OUTSIDE_BOUNDARY",
            }
          );
        }

        const real = fs.realpathSync(recovery);
        const physical = path.relative(physicalBoundary, real);

        if (
          !physical ||
          physical.startsWith("..") ||
          path.isAbsolute(physical)
        ) {
          throw Object.assign(
            new Error(
              "Cleanup recovery path resolves outside the worktree boundary"
            ),
            {
              code: "WORKTREE_RECOVERY_OUTSIDE_BOUNDARY",
            }
          );
        }

        if (!isRegistered(registered, cwd)) {
          throw Object.assign(
            new Error(
              "Git no longer registers the worktree for this recovery path"
            ),
            {
              code: "WORKTREE_RECOVERY_UNREGISTERED",
            }
          );
        }

        await worktreeControl(root, cwd, ctx.deps, recovery, false);
        await gitOk(ctx.deps, recovery, ["rev-parse", "HEAD"]);
      };

      const opened = integrationRecord(tx.fold);

      const tasks = [
        ...new Set(
          tx.fold.records
            .filter((r) => r.kind === "writer")
            .map((r) => textValue(r.data["task"]))
        ),
      ];

      const writers = tasks.flatMap((t) => launches(tx.fold, t));

      const owned = [
        ...new Set([
          ...writers.map((w) => textValue(w.record.data["path"])),
          ...(opened ? [textValue(opened.data["path"])] : []),
        ]),
      ];

      const removed: string[] = [];

      const kept: {
        path: string;
        reason: string;
        paths?: string[];
        code?: string;
        message?: string;
        recoveryPath?: string;
      }[] = [];

      const ready: string[] = [];
      const missing: string[] = [];
      const deregistered: string[] = [];

      const failed = new Set<string>();

      const fail = (relative: string, reason: string, error: unknown) => {
        // SAFETY: the typeof and null guards narrow error to a non-null object; the assertion only names its optional diagnostic fields.
        const row =
          typeof error === "object" && error !== null
            ? (error as {
                code?: unknown;
                exit?: unknown;
                message?: unknown;
                stderr?: unknown;
                stdout?: unknown;
                recoveryPath?: unknown;
              })
            : {};

        const { code: rowCode, exit: rowExit } = row;

        let code: string;

        if (typeof rowCode === "string" && rowCode !== "") {
          code = rowCode;
        } else if (typeof rowExit === "number" && Number.isInteger(rowExit)) {
          code = `GIT_EXIT_${rowExit}`;
        } else {
          code = "CLEANUP_FAILED";
        }

        const detail = [row.message, row.stderr, row.stdout].find(
          (value): value is string =>
            typeof value === "string" && !!value.trim()
        );

        const recoveryPath =
          typeof row.recoveryPath === "string"
            ? path.relative(ctx.session, row.recoveryPath).replaceAll("\\", "/")
            : undefined;

        const message = capSummary(
          `Close processes using this path or fix its permissions, then retry cleanup. ${
            detail ?? String(error)
          }${
            recoveryPath !== undefined && recoveryPath !== ""
              ? ` Recovery path: ${recoveryPath}.`
              : ""
          }`
        );

        kept.push({
          path: relative,
          reason,
          code,
          message,
          ...(recoveryPath !== undefined &&
            recoveryPath !== "" && { recoveryPath }),
        });
        failed.add(relative);
      };

      const observed: Record<string, { head: string }> = {};

      const integrated = (w: (typeof writers)[number]) => {
        const { finished } = w;

        return (
          !!finished &&
          tx.fold.records.some(
            (r) =>
              r.kind === "integrate" &&
              r.seq > finished.seq &&
              r.data["phase"] === "done" &&
              r.data["task"] === w.record.data["task"]
          )
        );
      };

      const delivered = tx.fold.records.findLast(
        (r) => r.kind === "integrate" && r.data["phase"] === "delivered"
      );

      const finishGone = async (relative: string, cwd: string) => {
        let refusal: RemovalRefusal | undefined;
        let thrown: unknown;

        try {
          let current = await listRegistered();

          if (isRegistered(current, cwd)) {
            try {
              const remove = await git(ctx.deps, root, [
                "worktree",
                "remove",
                "--force",
                cwd,
              ]);

              if (remove.exit) {
                refusal = {
                  exit: remove.exit,
                  message:
                    remove.stderr ||
                    remove.stdout ||
                    "Git refused to deregister the removed worktree",
                };
              }
            } catch (error) {
              thrown = error;
            }
          }

          // Prune is global, so it would also delete admin metadata for a stranded recovery worktree.
          if (
            !kept.some(
              (row) => row.recoveryPath !== undefined && row.recoveryPath !== ""
            )
          ) {
            const prune = await git(ctx.deps, root, ["worktree", "prune"]);

            if (prune.exit) {
              fail(relative, "prune-failed", {
                exit: prune.exit,
                message:
                  prune.stderr || prune.stdout || "Git worktree prune failed",
              });

              return;
            }
          }

          current = await listRegistered();

          if (isRegistered(current, cwd)) {
            fail(
              relative,
              "deregister-failed",
              refusal ??
                thrown ??
                Object.assign(
                  new Error(
                    "Git still lists the worktree after its path was removed"
                  ),
                  {
                    code: "WORKTREE_STILL_REGISTERED",
                  }
                )
            );
          }
        } catch (error) {
          fail(relative, "deregister-failed", error);
        }
      };

      const missingIntegrationIsSafe = async (relative: string) => {
        if (
          !opened ||
          relative !== opened.data["path"] ||
          !delivered ||
          writers.some((w) => !w.abandoned && !w.superseded && !w.finished) ||
          writers.some((w) => w.finished !== undefined && !integrated(w))
        ) {
          return false;
        }

        let branch: { exit: number; stdout: string; stderr: string };

        try {
          branch = await git(ctx.deps, root, [
            "rev-parse",
            "--verify",
            "--quiet",
            // oxlint-disable-next-line typescript/restrict-template-expressions, typescript/no-base-to-string -- branch is a validated record string field; interpolation renders its scalar text.
            `refs/heads/${opened.data["branch"]}`,
          ]);
        } catch (error) {
          fail(relative, "registration-check-failed", error);

          return false;
        }

        if (branch.exit === 1) {
          return true;
        }

        if (branch.exit === 0) {
          return branch.stdout.trim() === delivered.data["source"];
        }

        fail(relative, "registration-check-failed", {
          exit: branch.exit,
          message:
            branch.stderr ||
            branch.stdout ||
            "Could not verify the delivered integration branch",
        });

        return false;
      };

      for (const relative of owned) {
        const cwd = path.resolve(ctx.session, relative);
        const local = path.relative(boundary, cwd);

        if (!local || local.startsWith("..") || path.isAbsolute(local)) {
          fail(
            relative,
            "containment-unverifiable",
            Object.assign(
              new Error("Owned worktree is outside the cleanup boundary"),
              {
                code: "WORKTREE_OUTSIDE_BOUNDARY",
              }
            )
          );
          continue;
        }

        const recovery = recoverySibling(cwd);
        let recoveryExists: boolean;

        try {
          recoveryExists = hasPathEntry(recovery);
        } catch (error) {
          fail(
            relative,
            "recovery-failed",
            Object.assign(new Error(String(error)), {
              code: "WORKTREE_RECOVERY_UNVERIFIABLE",
              recoveryPath: recovery,
            })
          );
          continue;
        }

        if (recoveryExists) {
          try {
            if (hasPathEntry(cwd)) {
              throw Object.assign(
                new Error(
                  "Both the worktree path and its cleanup recovery path exist"
                ),
                {
                  code: "WORKTREE_RECOVERY_PATH_CONFLICT",
                }
              );
            }

            // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
            await verifyRecovery(cwd, recovery);
            fs.renameSync(recovery, cwd);
          } catch (error) {
            // SAFETY: the typeof and null guards narrow error to a non-null object; the assertion only names its optional code and message fields.
            const row =
              typeof error === "object" && error !== null
                ? (error as { code?: unknown; message?: unknown })
                : {};

            fail(relative, "recovery-failed", {
              code:
                typeof row.code === "string"
                  ? row.code
                  : "WORKTREE_RECOVERY_FAILED",
              message:
                typeof row.message === "string" ? row.message : String(error),
              recoveryPath: recovery,
            });
            continue;
          }
        }

        if (!fs.existsSync(cwd)) {
          continue;
        }

        let real: string;

        try {
          real = fs.realpathSync(cwd);
        } catch (error) {
          fail(relative, "containment-unverifiable", error);
          continue;
        }

        const physical = path.relative(physicalBoundary, real);

        if (
          !physical ||
          physical.startsWith("..") ||
          path.isAbsolute(physical)
        ) {
          fail(
            relative,
            "containment-unverifiable",
            Object.assign(
              new Error("Owned worktree resolves outside the cleanup boundary"),
              {
                code: "WORKTREE_OUTSIDE_BOUNDARY",
              }
            )
          );
          continue;
        }

        if (isRegistered(registered, cwd)) {
          try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
            await worktreeControl(root, cwd, ctx.deps);
          } catch (error) {
            fail(relative, "control-metadata-unverifiable", error);
            continue;
          }

          try {
            observed[relative] = {
              // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
              head: await gitOk(ctx.deps, cwd, ["rev-parse", "HEAD"]),
            };
          } catch (error) {
            fail(relative, "head-check-failed", error);
            continue;
          }
        } else if (fs.existsSync(path.join(cwd, ".git"))) {
          fail(
            relative,
            "control-metadata-unverifiable",
            Object.assign(
              new Error(
                "Git control link exists but this path is not registered"
              ),
              {
                code: "WORKTREE_REGISTRATION_UNVERIFIABLE",
              }
            )
          );
        } else {
          deregistered.push(relative);
        }
      }

      const terminal = new Set(terminalWorktrees(tx.fold, observed));

      // Git cannot report a deregistered directory's state (e.g. after an interrupted removal), so only ledger-merged remnants are removed.
      const remnants = deregistered.filter((relative) => {
        const writer = writers.findLast(
          (w) => w.record.data["path"] === relative
        );

        const merged = writer
          ? integrated(writer)
          : !!delivered &&
            !tx.fold.records.some(
              (r) =>
                r.kind === "integrate" &&
                r.seq > delivered.seq &&
                r.data["phase"] !== "closed" &&
                r.data["phase"] !== "committed"
            ) &&
            terminalWorktrees(tx.fold, {
              [relative]: { head: textValue(delivered.data["source"]) },
            }).includes(relative);

        if (!merged) {
          kept.push({ path: relative, reason: "unpreserved" });
        }

        return merged;
      });

      for (const cwd of registered) {
        const relative = owned.find((p) =>
          samePath(path.resolve(ctx.session, p), cwd)
        );

        if (relative === undefined || relative === "") {
          kept.push({ path: cwd, reason: "unowned" });
          continue;
        }

        if (!fs.existsSync(cwd)) {
          if (failed.has(relative)) {
            continue;
          }

          if (terminal.has(relative)) {
            missing.push(relative);
          } else {
            // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
            const safe = await missingIntegrationIsSafe(relative);

            if (safe) {
              missing.push(relative);
            } else if (!failed.has(relative)) {
              kept.push({ path: relative, reason: "non-terminal" });
            }
          }

          continue;
        }

        if (!observed[relative]) {
          if (!failed.has(relative)) {
            kept.push({ path: relative, reason: "unverified" });
          }

          continue;
        }

        if (!terminal.has(relative)) {
          kept.push({ path: relative, reason: "non-terminal" });
          continue;
        }

        const writer = writers.findLast(
          (w) => w.record.data["path"] === relative
        );

        // Merged work already lives in the integration branch or the caller, so its worktree needs no restoration.
        if (
          writer
            ? integrated(writer)
            : !!delivered &&
              observed[relative].head === delivered.data["source"]
        ) {
          ready.push(relative);
          continue;
        }

        try {
          // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
          const ignored = await gitPaths(ctx.deps, cwd, [
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "-z",
          ]);

          let snapshot = observed[relative].head;

          if (writer) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
            const preserved = await git(ctx.deps, root, [
              "rev-parse",
              "--verify",
              "--quiet",
              abandonedRef(
                ctx.manifest.safeSessionId,
                textValue(writer.record.data["task"]),
                writer.launch
              ),
            ]);

            if (writer.finished) {
              snapshot = textValue(writer.finished.data["candidate"]);
            } else if (preserved.exit === 0) {
              snapshot = preserved.stdout.trim();
            } else if (preserved.exit === 1) {
              snapshot = textValue(launchBase(writer.record)["commit"]);
            } else {
              throw new ToolError(
                2,
                "fault",
                preserved.stderr ||
                  preserved.stdout ||
                  `Git exited ${preserved.exit}`
              );
            }
          }

          // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
          const tree = await testedTree(ctx.deps, ctx.session, cwd);

          // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
          const expected = await gitOk(ctx.deps, root, [
            "rev-parse",
            `${snapshot}^{tree}`,
          ]);

          const needsPreservationCheck =
            tree !== expected || ignored.length > 0;

          const cachedDiff = needsPreservationCheck
            ? []
            : // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
              await gitPaths(ctx.deps, cwd, [
                "diff",
                "--cached",
                "--name-only",
                "--no-renames",
                "-z",
                "HEAD",
                "--",
              ]);

          if (needsPreservationCheck || cachedDiff.length) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
            const differing = await gitPaths(ctx.deps, cwd, [
              "diff",
              "--name-only",
              "--no-renames",
              "-z",
              expected,
              tree,
            ]);

            kept.push({
              path: relative,
              reason: "unpreserved",
              paths: [...new Set([...differing, ...ignored])],
            });
          } else {
            ready.push(relative);
          }
        } catch (error) {
          fail(relative, "preservation-check-failed", error);
          continue;
        }
      }

      // Preserve all snapshots until every worktree has passed its preservation check.
      for (const relative of remnants) {
        const cwd = path.resolve(ctx.session, relative);

        try {
          // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
          await rmWorktreeDir(cwd, ctx.deps);

          if (fs.existsSync(cwd)) {
            throw Object.assign(
              new Error("Worktree path remains after removal"),
              { code: "WORKTREE_REMAINS" }
            );
          }

          removed.push(relative);
        } catch (error) {
          if (fs.existsSync(cwd)) {
            fail(relative, "removal-failed", error);
          } else {
            removed.push(relative);
          }
        }
      }

      for (const relative of missing) {
        const cwd = path.resolve(ctx.session, relative);
        removed.push(relative);
        // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
        await finishGone(relative, cwd);
      }

      for (const relative of ready) {
        const cwd = path.resolve(ctx.session, relative);

        const writer = writers.findLast(
          (w) => w.record.data["path"] === relative
        );

        const preservedWriter = !!writer && !integrated(writer);

        if (preservedWriter) {
          // Keep Git's recovery metadata registered until the preserved directory is gone.
          try {
            if (process.platform === "win32") {
              probeWorktreeMove(cwd);
            }

            // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
            await rmWorktreeDir(cwd, ctx.deps);

            if (fs.existsSync(cwd)) {
              throw Object.assign(
                new Error("Worktree path remains after removal"),
                { code: "WORKTREE_REMAINS" }
              );
            }
          } catch (error) {
            if (fs.existsSync(cwd)) {
              try {
                // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
                if (isRegistered(await listRegistered(), cwd)) {
                  // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
                  await worktreeControl(root, cwd, ctx.deps);
                }
              } catch (controlError) {
                fail(relative, "control-metadata-unverifiable", controlError);
                continue;
              }

              fail(relative, "removal-failed", error);
              continue;
            }

            const recovery = recoverySibling(cwd);
            let recoveryExists: boolean;

            try {
              recoveryExists = hasPathEntry(recovery);
            } catch (recoveryError) {
              fail(relative, "recovery-failed", {
                code: "WORKTREE_RECOVERY_UNVERIFIABLE",
                message: String(recoveryError),
                recoveryPath: recovery,
              });
              continue;
            }

            if (recoveryExists) {
              try {
                // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
                await verifyRecovery(cwd, recovery);
              } catch (recoveryError) {
                // SAFETY: the typeof and null guards narrow recoveryError to a non-null object; the assertion only names its optional code and message fields.
                const row =
                  typeof recoveryError === "object" && recoveryError !== null
                    ? (recoveryError as { code?: unknown; message?: unknown })
                    : {};

                fail(relative, "recovery-failed", {
                  code:
                    typeof row.code === "string"
                      ? row.code
                      : "WORKTREE_RECOVERY_FAILED",
                  message:
                    typeof row.message === "string"
                      ? row.message
                      : String(recoveryError),
                  recoveryPath: recovery,
                });
                continue;
              }

              // SAFETY: the typeof and null guards narrow error to a non-null object; the assertion only names its optional code and message fields.
              const row =
                typeof error === "object" && error !== null
                  ? (error as { code?: unknown; message?: unknown })
                  : {};

              fail(relative, "removal-failed", {
                code:
                  typeof row.code === "string"
                    ? row.code
                    : "WORKTREE_RESTORE_FAILED",
                message:
                  typeof row.message === "string" ? row.message : String(error),
                recoveryPath: recovery,
              });
              continue;
            }

            fail(relative, "removal-failed", error);
            continue;
          }
        } else {
          let remove: RemoveExit;
          let removeError: unknown;

          try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
            remove = await git(ctx.deps, root, [
              "worktree",
              "remove",
              "--force",
              cwd,
            ]);
          } catch (error) {
            removeError = error;
            remove = { exit: 1, stdout: "", stderr: String(error) };
          }

          let after: string[];

          try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
            after = await listRegistered();
          } catch (error) {
            fail(relative, "registration-check-failed", error);
            continue;
          }

          if (isRegistered(after, cwd) && fs.existsSync(cwd)) {
            try {
              // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
              await worktreeControl(root, cwd, ctx.deps);
            } catch (error) {
              fail(relative, "control-metadata-unverifiable", error);
              continue;
            }

            const reason = remove.exit
              ? "removal-failed"
              : "registration-check-failed";

            fail(
              relative,
              reason,
              removeError ?? {
                exit: remove.exit,
                message:
                  remove.stderr ||
                  remove.stdout ||
                  "Git still registers the worktree after removal",
              }
            );
            continue;
          }

          if (fs.existsSync(cwd)) {
            try {
              // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
              await rmWorktreeDir(cwd, ctx.deps);
            } catch (error) {
              fail(relative, "removal-failed", error);
              continue;
            }
          }

          if (fs.existsSync(cwd)) {
            fail(
              relative,
              "removal-failed",
              Object.assign(new Error("Worktree path remains after removal"), {
                code: "WORKTREE_REMAINS",
              })
            );
            continue;
          }
        }

        removed.push(relative);
        // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
        await finishGone(relative, cwd);
      }

      for (const writer of writers) {
        const relative = textValue(writer.record.data["path"]);

        if (integrated(writer) && !kept.some((row) => row.path === relative)) {
          try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
            await gitOk(ctx.deps, root, [
              "update-ref",
              "-d",
              candidateRef(
                ctx.manifest.safeSessionId,
                textValue(writer.record.data["task"]),
                writer.launch
              ),
            ]);
          } catch (error) {
            fail(relative, "ref-release-failed", error);
          }
        }
      }

      const openedPath = opened && textValue(opened.data["path"]);

      if (
        opened &&
        openedPath !== undefined &&
        (removed.includes(openedPath) ||
          !isRegistered(registered, path.resolve(ctx.session, openedPath))) &&
        delivered &&
        !kept.some((k) => owned.includes(k.path))
      ) {
        try {
          const branch = await git(ctx.deps, root, [
            "rev-parse",
            "--verify",
            "--quiet",
            // oxlint-disable-next-line typescript/restrict-template-expressions, typescript/no-base-to-string -- branch is a validated record string field; interpolation renders its scalar text.
            `refs/heads/${opened.data["branch"]}`,
          ]);

          if (
            branch.exit === 0 &&
            branch.stdout.trim() === delivered.data["source"]
          ) {
            try {
              await gitOk(ctx.deps, root, [
                "branch",
                "-D",
                textValue(opened.data["branch"]),
              ]);
            } catch (error) {
              fail(openedPath, "ref-release-failed", error);
            }
          } else if (branch.exit !== 0 && branch.exit !== 1) {
            fail(openedPath, "ref-release-failed", {
              exit: branch.exit,
              message:
                branch.stderr ||
                branch.stdout ||
                "Could not verify the integration branch before cleanup",
            });
          }
        } catch (error) {
          fail(openedPath, "ref-release-failed", error);
        }
      }

      const value = { removed, kept };

      return failed.size
        ? {
            ok: false,
            value,
            exit: 2,
            reason: "cleanup-incomplete",
            summary: capSummary(JSON.stringify(value)),
          }
        : result(value);
    }
  );
};
