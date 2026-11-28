import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import type { JsonValue } from "../../skills/dispatch/scripts/lib/config.ts";
import {
  appendRecord,
  foldLedger,
} from "../../skills/dispatch/scripts/toolkit/ledger.ts";
import {
  abandonedRef,
  candidateRef,
} from "../../skills/dispatch/scripts/toolkit/writers.ts";
import {
  arrayOf,
  defined,
  isBoolean,
  isNumber,
  isString,
  maybe,
  narrow,
  objectWith,
} from "./helpers/json.ts";
import {
  planSource,
  setupTestSkill,
  toolkitRepo,
} from "./helpers/toolkit-repo.ts";

type Repo = Awaited<ReturnType<typeof toolkitRepo>>;

const createdGuard = objectWith({ path: isString, launch: maybe(isNumber) });

const reviewGuard = objectWith({
  pending: arrayOf(objectWith({ promptPath: isString, replyPath: isString })),
});

const deliverGuard = objectWith({
  delivered: isBoolean,
  mode: maybe(isString),
  source: maybe(isString),
  from: maybe(isString),
  ref: maybe(isString),
  noop: maybe(isBoolean),
  paths: maybe(arrayOf(isString)),
});

const cleanupGuard = objectWith({
  removed: arrayOf(isString),
  kept: arrayOf(
    objectWith({
      path: isString,
      reason: isString,
      code: maybe(isString),
      message: maybe(isString),
      recoveryPath: maybe(isString),
      paths: maybe(arrayOf(isString)),
    })
  ),
});

const rows = (r: Repo, phase: string) =>
  foldLedger(r.session).records.filter(
    (record) => record.kind === "integrate" && record.data["phase"] === phase
  );

const ref = "refs/dispatch/test/delivered-source";

const base = {
  "keep.txt": "keep\n",
  "del.txt": "del\n",
  "exec.sh": "#!/bin/sh\n",
  "swap-a": "file\n",
  "swap-b/inner.txt": "inner\n",
};

const binary = Buffer.from([0, 255, 254, 10, 32, 32, 13, 10, 32, 32]);

const prepared = async (files: Record<string, string> = base) => {
  const r = await toolkitRepo(planSource, files);

  await r.level();

  const made = await r.run(["worktree", "create", "T1"]);

  const writer = path.join(r.session, narrow(made.value, createdGuard).path);

  fs.writeFileSync(path.join(writer, "src/file.ts"), "delivered\n");

  const submitted = await r.run(["worktree", "submit", "T1"]);

  assert.equal(submitted.exit, 0);

  const integrated = await r.run(["worktree", "integrate", "T1"]);

  assert.equal(integrated.exit, 0);

  return { r, writer };
};

// Integration fix touching add, edit, delete, mode, binary bytes and both directory/file swaps.
const change = async (r: Repo) => {
  const w = r.integration;

  fs.writeFileSync(path.join(w, "src/file.ts"), "final\n");
  fs.mkdirSync(path.join(w, "bin"));
  fs.writeFileSync(path.join(w, "bin/blob.bin"), binary);
  fs.rmSync(path.join(w, "del.txt"));
  fs.rmSync(path.join(w, "swap-a"));
  fs.mkdirSync(path.join(w, "swap-a"));
  fs.writeFileSync(path.join(w, "swap-a/child"), "child\n");
  fs.rmSync(path.join(w, "swap-b"), { recursive: true });
  fs.writeFileSync(path.join(w, "swap-b"), "now a file\n");

  if (process.platform === "win32") {
    r.git(["update-index", "--chmod=+x", "exec.sh"], w);
  } else {
    fs.chmodSync(path.join(w, "exec.sh"), 0o755);
  }

  const committed = await r.run(["worktree", "commit", "--reason", "final"]);

  assert.equal(committed.exit, 0);

  return r.git(["rev-parse", "HEAD"], r.integration);
};

const caller = (r: Repo) => ({
  head: r.git(["rev-parse", "HEAD"]),
  branch: r.git(["symbolic-ref", "--short", "HEAD"]),
  index: r.git(["ls-files", "--stage", "-z"]),
  keep: fs.existsSync(path.join(r.root, "keep.txt"))
    ? fs.readFileSync(path.join(r.root, "keep.txt"))
    : null,
});

const cat = (r: Repo, spec: string) => {
  const t = spawnSync("git", ["cat-file", "-t", spec], {
    cwd: r.root,
    encoding: "utf-8",
  });

  if (t.status !== 0 && t.status !== null) {
    return null;
  }

  const type = t.stdout.trim();

  return type === "blob"
    ? spawnSync("git", ["cat-file", "blob", spec], { cwd: r.root }).stdout
    : type;
};

const pathKey = (value: string) => {
  const resolved = path.resolve(value).replace(/^\\\\\?\\/u, "");

  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const registered = (r: Repo, cwd: string) =>
  r
    .git(["worktree", "list", "--porcelain"])
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "))
    .some((line) => pathKey(line.slice(9)) === pathKey(cwd));

const assertMatchesSource = (r: Repo, from: string, source: string) => {
  const names = r
    .git(["diff", "--name-only", "--no-renames", "-z", from, source])
    .split("\0")
    .filter(Boolean);

  assert.ok(names.length >= 6, names.join(","));

  for (const name of names) {
    const want = cat(r, `${source}:${name}`);

    const file = path.join(r.root, name);

    if (want === null) {
      assert.equal(fs.existsSync(file), false, name);
    } else if (want === "tree") {
      assert.ok(fs.statSync(file).isDirectory(), name);
    } else {
      assert.ok(fs.statSync(file).isFile(), name);
      assert.deepEqual(fs.readFileSync(file), want, name);
    }
  }
};

// Cases use independent repositories, so run them concurrently and name the failing case.
const each = async (modes: string[], fn: (mode: string) => Promise<void>) =>
  await Promise.all(
    modes.map(async (mode) => {
      try {
        await fn(mode);
      } catch (error) {
        throw Object.assign(new Error(`${mode}: ${String(error)}`), {
          cause: error,
        });
      }
    })
  );

const holdCwd = async (cwd: string) => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      String.raw`process.stdout.write('ready\n');setInterval(()=>{},1000)`,
    ],
    {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  await once(defined(child.stdout, "stdout"), "data");

  const exited = once(child, "exit");

  return {
    release: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }

      await exited;
    },
  };
};

const integrate = async (r: Repo, mode: string) => {
  const from = r.git(["rev-parse", "HEAD"]);

  const w = r.integration;

  if (mode === "gitlink") {
    fs.mkdirSync(path.join(w, "sub"));
    r.git(["update-index", "--add", "--cacheinfo", `160000,${from},sub`], w);
    r.git(["commit", "-m", "gitlink"], w);

    return;
  }

  if (mode === "descendant") {
    fs.mkdirSync(path.join(w, "new-file"));
    fs.writeFileSync(path.join(w, "new-file/child"), "new");
  } else {
    fs.writeFileSync(path.join(w, "new-file"), "new");
  }

  fs.writeFileSync(path.join(w, "src/file.ts"), "final\n");

  const committed = await r.run(["worktree", "commit", "--reason", "add"]);

  assert.equal(committed.exit, 0);
};

const dirtyForRefusal = (
  r: Repo,
  mode: string,
  file: string,
  keep: string,
  exclude: string
) => {
  if (mode === "tracked-edit") {
    fs.writeFileSync(file, "caller");
  }

  if (mode === "untracked") {
    fs.writeFileSync(path.join(r.root, "new-file"), "caller");
  }

  if (mode === "ignored") {
    fs.appendFileSync(exclude, "\nnew-file\n");
    fs.writeFileSync(path.join(r.root, "new-file"), "caller");
  }

  if (mode === "ancestor") {
    fs.mkdirSync(path.join(r.root, "new-file"));
    fs.writeFileSync(path.join(r.root, "new-file/child"), "caller");
  }

  if (mode === "descendant") {
    fs.writeFileSync(path.join(r.root, "new-file"), "caller");
  }

  if (mode === "staged") {
    fs.writeFileSync(keep, "staged");
    r.git(["add", "keep.txt"]);
  }

  if (mode === "intent-to-add") {
    fs.writeFileSync(path.join(r.root, "extra.txt"), "x");
    r.git(["add", "-N", "extra.txt"]);
  }

  if (mode === "moved") {
    r.git(["commit", "--allow-empty", "-m", "moved"]);
  }

  if (mode === "other-branch") {
    r.git(["switch", "-c", "other"]);
  }

  if (mode === "sparse") {
    r.git(["config", "core.sparseCheckout", "true"]);
  }
};

const restoreAfterRefusal = (
  r: Repo,
  mode: string,
  ctx: {
    from: string;
    initialBranch: string;
    file: string;
    keep: string;
    exclude: string;
    srcBytes: Buffer;
    keepBytes: Buffer;
    excludeBytes: Buffer;
  }
) => {
  if (mode === "staged" || mode === "late-index") {
    r.git(["reset", "-q", "--", ctx.keep]);
  }

  if (mode === "intent-to-add") {
    r.git(["rm", "-q", "--cached", "extra.txt"]);
  }

  if (mode === "moved") {
    r.git(["reset", "-q", "--soft", ctx.from]);
  }

  if (mode === "other-branch") {
    r.git(["switch", "-q", ctx.initialBranch]);
    r.git(["branch", "-q", "-D", "other"]);
  }

  if (mode === "sparse") {
    r.git(["config", "--unset", "core.sparseCheckout"]);
  }

  for (const extra of ["new-file", "extra.txt"]) {
    fs.rmSync(path.join(r.root, extra), { recursive: true, force: true });
  }

  fs.writeFileSync(ctx.file, ctx.srcBytes);
  fs.writeFileSync(ctx.keep, ctx.keepBytes);
  fs.writeFileSync(ctx.exclude, ctx.excludeBytes);
};

const refuses = async (r: Repo, mode: string) => {
  const from = r.git(["rev-parse", "HEAD"]);

  const file = path.join(r.root, "src/file.ts");

  const keep = path.join(r.root, "keep.txt");

  const exclude = path.join(r.root, ".git/info/exclude");

  const initial = caller(r);

  const srcBytes = fs.readFileSync(file);

  const keepBytes = fs.readFileSync(keep);

  const excludeBytes = fs.readFileSync(exclude);

  dirtyForRefusal(r, mode, file, keep, exclude);

  const before = caller(r);

  const result = await r.run(["worktree", "deliver"], (p) => {
    if (p !== "deliver:before-apply") {
      return;
    }

    if (mode === "late-edit") {
      fs.writeFileSync(file, "late");
    }

    if (mode === "late-index") {
      fs.writeFileSync(keep, "late");
      r.git(["add", "keep.txt"]);
    }

    if (mode === "late-untracked") {
      fs.writeFileSync(path.join(r.root, "new-file"), "late");
    }
  });

  assert.equal(result.exit, 4, mode + JSON.stringify(result));

  let expected = "caller-dirty";

  if (mode === "moved" || mode === "other-branch") {
    expected = "caller-moved";
  } else if (mode === "sparse") {
    expected = "unsupported-sparse";
  } else if (mode === "gitlink") {
    expected = "unsupported-entry";
  }

  assert.equal(result.output.reason, expected, mode);

  const after = caller(r);

  assert.equal(after.head, before.head);
  assert.equal(after.branch, before.branch);

  if (!mode.startsWith("late-")) {
    assert.deepEqual(after, before);
  }

  if (mode === "tracked-edit") {
    assert.deepEqual(fs.readFileSync(file), Buffer.from("caller"));
  }

  if (mode === "late-edit") {
    assert.equal(fs.readFileSync(file, "utf-8"), "late");
  }

  assert.equal(rows(r, "delivered").length, 0, mode);

  if (mode === "descendant" || mode === "gitlink") {
    return;
  }

  // Undo the caller state so the next shared case starts from the same caller.
  restoreAfterRefusal(r, mode, {
    from,
    initialBranch: initial.branch,
    file,
    keep,
    exclude,
    srcBytes,
    keepBytes,
    excludeBytes,
  });
  assert.deepEqual(caller(r), initial, `${mode} undo`);
};

const sharedUncommittedSafety = async () => {
  const { r } = await prepared();

  try {
    await integrate(r, "shared");

    const modes = [
      "tracked-edit",
      "untracked",
      "ignored",
      "ancestor",
      "staged",
      "intent-to-add",
      "moved",
      "other-branch",
      "sparse",
      "late-edit",
      "late-index",
      "late-untracked",
    ];

    const runSeries = async (
      remaining: string[],
      fn: (mode: string) => Promise<void>
    ) => {
      const [mode, ...rest] = remaining;

      if (mode === undefined) {
        return;
      }

      try {
        await fn(mode);
      } catch (error) {
        throw Object.assign(new Error(`${mode}: ${String(error)}`), {
          cause: error,
        });
      }

      await runSeries(rest, fn);
    };

    await runSeries(modes, async (mode) => {
      await refuses(r, mode);
    });
  } finally {
    r.cleanup();
  }
};

describe("toolkit delivery and cleanup", () => {
  it("pending MUST rejection blocks caller writes and delivered records until native agreement", async () => {
    const { r } = await prepared();

    try {
      r.deps.skillRoot = setupTestSkill(
        r.deps,
        r.session,
        "confirmation-skill",
        {
          "read-delegates": {
            codex: {
              nativeSubagentsOnly: true,
              targets: [{ low: { model: "native" } }],
            },
          },
          phases: {
            "code-review": { targets: { low: 1 }, rounds: { low: 1 } },
          },
        }
      );
      r.deps.orchestrator = { platform: "codex", model: "native" };
      r.deps.liveness = {};

      const review = async () =>
        await r.run([
          "review",
          "run",
          "integration",
          "--kind",
          "code",
          "--level",
          "low",
          "--host",
          "codex",
        ]);

      const first = await review();

      assert.equal(first.output.reason, "native-pending");

      const firstPending = defined(
        narrow(first.value, reviewGuard).pending[0],
        "pending"
      );

      fs.writeFileSync(
        firstPending.replyPath,
        JSON.stringify({
          status: "FINDINGS",
          findings: [
            {
              impact: "blocks",
              trigger: "realistic",
              tag: "correctness",
              locus: "src/file.ts:L1",
              defect: "Unbounded writes",
              proposedFix: "Bound writes",
            },
          ],
        })
      );

      const secondReview = await review();

      assert.equal(secondReview.exit, 0);

      await appendRecord(
        r.session,
        {
          kind: "ruling",
          by: "orchestrator",
          key: "reject-delivery",
          data: {
            subject: "review:code-integration:R1-F001",
            ruling: "rejected",
            rationale: "Captured writes have a bound",
          },
        },
        r.deps
      );

      const before = caller(r);

      const bytes = fs.readFileSync(path.join(r.root, "src/file.ts"));

      const blocked = await r.run(["worktree", "deliver"]);

      assert.equal(blocked.output.reason, "review-confirmation-required");
      assert.deepEqual(caller(r), before);
      assert.deepEqual(
        fs.readFileSync(path.join(r.root, "src/file.ts")),
        bytes
      );
      assert.equal(rows(r, "delivered").length, 0);
      assert.equal(rows(r, "deliver-started").length, 0);

      const id = "rejection:code-integration:R1-F001";

      await appendRecord(
        r.session,
        {
          kind: "escalation",
          by: "tool",
          key: "delivery-dispute",
          data: { id, state: "open", summary: "Reviewer disputes rejection" },
        },
        r.deps
      );

      const reblocked = await r.run(["worktree", "deliver"]);

      assert.equal(reblocked.output.reason, "review-confirmation-required");
      assert.deepEqual(caller(r), before);

      await appendRecord(
        r.session,
        {
          kind: "escalation",
          by: "orchestrator",
          key: "delivery-resolution",
          data: {
            id,
            state: "resolved",
            summary:
              "User decided the bounded writes evidence must be rechecked",
          },
        },
        r.deps
      );

      const confirm = await review();

      assert.equal(confirm.output.reason, "native-pending");

      const confirmPending = defined(
        narrow(confirm.value, reviewGuard).pending[0],
        "pending"
      );

      const prompt = fs.readFileSync(confirmPending.promptPath, "utf-8");

      const requestMatch = defined(
        /Request ID: `(?<request>[^`]+)`/u.exec(prompt),
        "request"
      );

      const requestId = defined(requestMatch.groups?.["request"], "requestId");

      fs.writeFileSync(
        confirmPending.replyPath,
        JSON.stringify({
          status: "CLEAN",
          findings: [],
          confirmations: [
            {
              requestId,
              decision: "agree",
              rationale: "The captured implementation bounds each write",
            },
          ],
        })
      );

      const finalReview = await review();

      assert.equal(finalReview.exit, 0);

      const delivered = await r.run(["worktree", "deliver"]);

      assert.equal(delivered.exit, 0);
      assert.equal(rows(r, "delivered").length, 1);
      assert.deepEqual(caller(r), before);
    } finally {
      r.cleanup();
    }
  });

  it("uncommitted delivery restores the verified tree as unstaged changes and retains the source ref", async () => {
    const { r, writer } = await prepared();

    try {
      const from = r.git(["rev-parse", "HEAD"]);

      const source = await change(r);

      fs.writeFileSync(path.join(r.root, "keep.txt"), "dirty keep");
      fs.writeFileSync(path.join(r.root, "scratch"), "scratch");
      fs.writeFileSync(path.join(r.root, "ignored"), "ignored");

      const before = caller(r);

      const first = await r.run(["worktree", "deliver"]);

      assert.equal(first.exit, 0, JSON.stringify(first));

      const firstValue = narrow(first.value, deliverGuard);

      assert.equal(firstValue.mode, "uncommitted");
      assert.equal(firstValue.source, source);
      assert.equal(firstValue.from, from);
      assert.equal(firstValue.ref, ref);
      assert.equal(firstValue.delivered, true);
      assert.deepEqual(caller(r), before);
      assert.equal(r.git(["rev-parse", ref]), source);
      assertMatchesSource(r, from, source);
      assert.equal(r.git(["diff", "--cached", "--name-only"]), "");
      assert.ok(
        r.git(["status", "--porcelain", "-uall"]).includes("src/file.ts")
      );
      assert.equal(r.git(["rev-parse", "HEAD"], r.integration), source);

      if (process.platform !== "win32") {
        let executable = false;

        try {
          fs.accessSync(path.join(r.root, "exec.sh"), fs.constants.X_OK);
          executable = true;
        } catch {
          executable = false;
        }

        assert.equal(executable, true);
      }

      assert.equal(
        fs.readFileSync(path.join(r.root, "scratch"), "utf-8"),
        "scratch"
      );
      assert.equal(
        fs.readFileSync(path.join(r.root, "ignored"), "utf-8"),
        "ignored"
      );

      const started = defined(rows(r, "deliver-started")[0], "started").data;

      const done = defined(rows(r, "delivered")[0], "done").data;

      assert.deepEqual(Object.keys(started).toSorted(), [
        "dest",
        "from",
        "mode",
        "phase",
        "source",
      ]);
      assert.equal(done["mode"], "uncommitted");

      fs.writeFileSync(path.join(r.root, "src/file.ts"), "later edit");
      fs.unlinkSync(path.join(r.root, "bin/blob.bin"));

      const again = await r.run(["worktree", "deliver"]);

      assert.equal(again.exit, 0);
      assert.equal(narrow(again.value, deliverGuard).delivered, false);
      assert.equal(
        fs.readFileSync(path.join(r.root, "src/file.ts"), "utf-8"),
        "later edit"
      );
      assert.equal(rows(r, "delivered").length, 1);

      const unowned = path.join(r.root, "outside");

      r.git(["worktree", "add", "--detach", unowned, "HEAD"]);

      const beforeCleanup = caller(r);

      const { run } = r.deps;

      let interrupted = 0;

      const faultingRun: Repo["deps"]["run"] = async (argv, opts) => {
        const result = await run(argv, opts);

        if (argv[1] === "branch" && argv[2] === "-D" && result.exit === 0) {
          interrupted += 1;
          throw new Error("interrupted after branch deletion");
        }

        return result;
      };

      const failedCleanup = await r.run(
        ["worktree", "cleanup"],
        undefined,
        true,
        faultingRun
      );

      assert.equal(interrupted, 1, JSON.stringify(failedCleanup));
      assert.equal(failedCleanup.exit, 2);
      assert.equal(
        r.git(["branch", "--list", "dispatch/test/integration"]),
        ""
      );
      assert.equal(r.git(["rev-parse", ref]), source);

      const cleaned = await r.run(["worktree", "cleanup"]);

      assert.equal(cleaned.exit, 0);
      assert.deepEqual(caller(r), beforeCleanup);
      assert.ok(!fs.existsSync(writer));
      assert.ok(!fs.existsSync(r.integration));
      assert.ok(fs.existsSync(unowned));
      assert.equal(
        r.git(["branch", "--list", "dispatch/test/integration"]),
        ""
      );
      assert.equal(r.git(["rev-parse", ref]), source);
      assert.equal(
        r.git(["rev-parse", "--verify", `${source}^{commit}`]),
        source
      );
    } finally {
      r.cleanup();
    }
  });

  it("uncommitted delivery of a same-tree integration retains the source ref without touching the caller", async () => {
    const r = await toolkitRepo();

    try {
      await r.level();

      const checked = await r.run(["check", "run"]);

      assert.equal(checked.exit, 0);

      const from = r.git(["rev-parse", "HEAD"]);

      r.git(["commit", "--allow-empty", "-m", "internal empty"], r.integration);

      const source = r.git(["rev-parse", "HEAD"], r.integration);

      fs.writeFileSync(path.join(r.root, "src/file.ts"), "caller edit");

      const before = caller(r);

      const first = await r.run(["worktree", "deliver"]);

      assert.equal(first.exit, 0, JSON.stringify(first));

      const firstValue = narrow(first.value, deliverGuard);

      assert.equal(firstValue.noop, true);
      assert.equal(firstValue.source, source);
      assert.equal(firstValue.from, from);
      assert.deepEqual(firstValue.paths, []);
      assert.deepEqual(caller(r), before);
      assert.equal(
        fs.readFileSync(path.join(r.root, "src/file.ts"), "utf-8"),
        "caller edit"
      );
      assert.equal(r.git(["rev-parse", ref]), source);
      assert.equal(
        defined(rows(r, "delivered")[0], "delivered").data["noop"],
        true
      );

      const repeat = await r.run(["worktree", "deliver"]);

      assert.equal(narrow(repeat.value, deliverGuard).delivered, false);
      assert.equal(rows(r, "delivered").length, 1);

      const cleaned = await r.run(["worktree", "cleanup"]);

      assert.equal(cleaned.exit, 0);
      assert.equal(r.git(["rev-parse", ref]), source);
      assert.equal(
        r.git(["branch", "--list", "dispatch/test/integration"]),
        ""
      );
    } finally {
      r.cleanup();
    }
  });

  it("uncommitted safety refuses overlapping caller state and keeps the caller unchanged", async () => {
    await Promise.all([
      sharedUncommittedSafety(),
      each(["descendant", "gitlink"], async (mode) => {
        const { r } = await prepared();

        try {
          await integrate(r, mode);
          await refuses(r, mode);
        } finally {
          r.cleanup();
        }
      }),
    ]);
  });

  it("uncommitted safety preserves unrelated dirty and untracked files byte for byte", async () => {
    const { r } = await prepared();

    try {
      await change(r);

      const dirty = Buffer.from([1, 2, 0, 255, 13, 10]);

      fs.writeFileSync(path.join(r.root, "keep.txt"), dirty);
      fs.writeFileSync(path.join(r.root, "extra-untracked"), "u");

      const result = await r.run(["worktree", "deliver"]);

      assert.equal(result.exit, 0, JSON.stringify(result));
      assert.deepEqual(fs.readFileSync(path.join(r.root, "keep.txt")), dirty);
      assert.equal(
        fs.readFileSync(path.join(r.root, "extra-untracked"), "utf-8"),
        "u"
      );
      assert.equal(r.git(["diff", "--cached", "--name-only"]), "");
      assert.match(r.git(["status", "--porcelain"]), /^ M keep\.txt$/mu);
    } finally {
      r.cleanup();
    }
  });

  it("uncommitted recovery resumes every durable boundary to the same caller state", async () => {
    await each(
      ["after-preserve", "before-apply", "after-delivered"],
      async (boundary) => {
        const { r } = await prepared();

        try {
          const from = r.git(["rev-parse", "HEAD"]);

          const source = await change(r);

          let fired = 0;

          fs.writeFileSync(path.join(r.root, "keep.txt"), "caller edit");
          fs.writeFileSync(path.join(r.root, "extra-untracked"), "caller file");

          const beforeRetry = caller(r);

          const crash = await r.run(["worktree", "deliver"], (p) => {
            if (p === `deliver:${boundary}`) {
              fired += 1;

              if (boundary === "before-apply") {
                fs.writeFileSync(path.join(r.root, "src/file.ts"), "final\n");
                fs.mkdirSync(path.join(r.root, "bin"));
                fs.writeFileSync(path.join(r.root, "bin/blob.bin"), binary);
                fs.rmSync(path.join(r.root, "del.txt"));
                fs.rmSync(path.join(r.root, "swap-b"), { recursive: true });
                fs.writeFileSync(path.join(r.root, "swap-b"), "now a file\n");
                fs.rmSync(path.join(r.root, "swap-a"));
                fs.mkdirSync(path.join(r.root, "swap-a"));
                fs.writeFileSync(path.join(r.root, "swap-a/child"), "child\n");
              }

              throw new Error(`injected ${boundary}`);
            }
          });

          assert.equal(fired, 1, JSON.stringify(crash));
          assert.equal(crash.exit, 2);

          if (boundary === "before-apply") {
            fs.writeFileSync(path.join(r.root, "src/file.ts"), "user edit");

            const before = caller(r);

            const refusedDelivery = await r.run(["worktree", "deliver"]);

            assert.equal(
              refusedDelivery.exit,
              4,
              JSON.stringify(refusedDelivery)
            );
            assert.equal(refusedDelivery.output.reason, "caller-dirty");
            assert.match(
              JSON.stringify(refusedDelivery.output),
              /src\/file\.ts/u
            );
            assert.deepEqual(caller(r), before);
            assert.equal(
              fs.readFileSync(path.join(r.root, "src/file.ts"), "utf-8"),
              "user edit"
            );
            assert.equal(rows(r, "delivered").length, 0);
            fs.writeFileSync(path.join(r.root, "src/file.ts"), "final\n");
          }

          const retry = await r.run(["worktree", "deliver"]);

          assert.equal(retry.exit, 0, boundary + JSON.stringify(retry));
          assert.equal(
            narrow(retry.value, deliverGuard).delivered,
            boundary !== "after-delivered"
          );
          assertMatchesSource(r, from, source);
          assert.deepEqual(caller(r), beforeRetry);
          assert.equal(
            fs.readFileSync(path.join(r.root, "extra-untracked"), "utf-8"),
            "caller file"
          );
          assert.equal(r.git(["rev-parse", ref]), source);
          assert.equal(rows(r, "deliver-started").length, 1);
          assert.equal(rows(r, "delivered").length, 1);

          const repeat = await r.run(["worktree", "deliver"]);

          assert.equal(narrow(repeat.value, deliverGuard).delivered, false);
          assert.equal(rows(r, "delivered").length, 1);
        } finally {
          r.cleanup();
        }
      }
    );
  });

  it("uncommitted recovery blocks conflicting refs, unfinished deliveries and changed sources", async () => {
    await each(
      ["conflicting-ref", "other-source", "changed-completed"],
      async (mode) => {
        const { r } = await prepared();

        try {
          const from = r.git(["rev-parse", "HEAD"]);

          const dest = {
            path: r.root,
            branch: r.git(["symbolic-ref", "--short", "HEAD"]),
          };

          if (mode === "conflicting-ref") {
            r.git(["update-ref", ref, from]);
          }

          if (mode === "other-source") {
            await appendRecord(
              r.session,
              {
                kind: "integrate",
                by: "tool",
                data: {
                  phase: "deliver-started",
                  mode: "uncommitted",
                  dest,
                  from,
                  source: from,
                },
              },
              r.deps
            );
          }

          if (mode === "changed-completed") {
            const delivered = await r.run(["worktree", "deliver"]);

            assert.equal(delivered.exit, 0);
            fs.writeFileSync(path.join(r.integration, "src/file.ts"), "later");

            const committed = await r.run([
              "worktree",
              "commit",
              "--reason",
              "later",
            ]);

            assert.equal(committed.exit, 0);
          }

          const before = caller(r);

          const bytes = fs.readFileSync(path.join(r.root, "src/file.ts"));

          const retry = await r.run(["worktree", "deliver"]);

          assert.equal(retry.exit, 4, mode + JSON.stringify(retry));
          assert.equal(retry.output.reason, "recovery-blocked");
          assert.deepEqual(caller(r), before);
          assert.deepEqual(
            fs.readFileSync(path.join(r.root, "src/file.ts")),
            bytes
          );

          if (mode === "conflicting-ref") {
            assert.equal(r.git(["rev-parse", ref]), from);
          }

          await r.run(["worktree", "cleanup"]);
          assert.ok(fs.existsSync(r.integration));
          assert.ok(r.git(["branch", "--list", "dispatch/test/integration"]));
        } finally {
          r.cleanup();
        }
      }
    );
  });

  it("keeps open writers and undelivered integration work until close", async () => {
    const r = await toolkitRepo();

    try {
      const made = await r.run(["worktree", "create", "T1"]);

      const writer = path.join(
        r.session,
        narrow(made.value, createdGuard).path
      );

      const firstCleanup = await r.run(["worktree", "cleanup"]);

      assert.equal(firstCleanup.exit, 0);
      assert.ok(fs.existsSync(writer));
      assert.ok(fs.existsSync(r.integration));

      fs.writeFileSync(path.join(r.integration, "src/file.ts"), "fix\n");

      const committed = await r.run(["worktree", "commit", "--reason", "fix"]);

      assert.equal(committed.exit, 0);

      const secondCleanup = await r.run(["worktree", "cleanup"]);

      assert.equal(secondCleanup.exit, 0);
      assert.ok(fs.existsSync(r.integration));

      const closed = await r.run(["worktree", "close", "--reason", "stop"]);

      assert.equal(closed.exit, 0);

      const finalCleanup = await r.run(["worktree", "cleanup"]);

      assert.equal(finalCleanup.exit, 0);
      assert.ok(!fs.existsSync(r.integration));
      assert.ok(r.git(["branch", "--list", "dispatch/test/integration"]));
    } finally {
      r.cleanup();
    }
  });

  it(
    "cleanup continues after an owned removal fault and retains recovery refs",
    { skip: process.platform !== "win32" },
    async () => {
      const { r, writer } = await prepared();

      let holder: Awaited<ReturnType<typeof holdCwd>> | undefined;

      try {
        const next = await r.run(["worktree", "create", "T1"]);

        const nextPath = narrow(next.value, createdGuard).path;

        const other = path.join(r.session, nextPath);

        fs.writeFileSync(path.join(other, "src/file.ts"), "second delivered\n");

        const submitted = await r.run(["worktree", "submit", "T1"]);

        assert.equal(submitted.exit, 0);

        const integrated = await r.run(["worktree", "integrate", "T1"]);

        assert.equal(integrated.exit, 0);

        const delivered = await r.run(["worktree", "deliver"]);

        assert.equal(delivered.exit, 0, JSON.stringify(delivered));

        const unrelated = path.join(r.root, "outside-worktree");

        const unrelatedRef = "refs/dispatch/unrelated";

        r.git(["worktree", "add", "--detach", unrelated, "HEAD"]);
        r.git(["update-ref", unrelatedRef, "HEAD"]);
        // Model Git deregistering the integrated path before a held directory handle blocks cleanup.
        r.git(["worktree", "remove", "--force", writer]);
        fs.mkdirSync(writer);
        fs.writeFileSync(
          path.join(writer, "interrupted.tmp"),
          "retained until retry"
        );

        holder = await holdCwd(writer);

        const partial = await r.run(["worktree", "cleanup"]);

        assert.equal(partial.exit, 2, JSON.stringify(partial));
        assert.equal(partial.output.ok, false);
        assert.equal(partial.output.reason, "cleanup-incomplete");

        const partialValue = narrow(partial.value, cleanupGuard);

        assert.ok(
          partialValue.removed.includes(nextPath),
          JSON.stringify(partialValue)
        );

        const writerRelative = path
          .relative(r.session, writer)
          .replaceAll("\\", "/");

        const blocked = defined(
          partialValue.kept.find((row) => row.path === writerRelative),
          "blocked"
        );

        assert.equal(blocked.reason, "removal-failed");

        const code = defined(blocked.code, "code");

        assert.ok(code.length > 0);

        const message = defined(blocked.message, "message");

        assert.ok(message.length > 0);
        assert.ok(Buffer.byteLength(message, "utf-8") <= 1024);
        assert.match(message, /permission|busy|in use|remove/iu);
        assert.ok(fs.existsSync(writer));

        const listed = registered(r, writer);

        assert.equal(fs.existsSync(path.join(writer, ".git")), listed);
        assert.equal(
          r.git(["rev-parse", candidateRef("test", "T1", 1)]).length,
          40
        );
        assert.notEqual(
          spawnSync(
            "git",
            ["show-ref", "--verify", "--quiet", candidateRef("test", "T1", 2)],
            { cwd: r.root }
          ).status,
          0
        );
        assert.ok(r.git(["branch", "--list", "dispatch/test/integration"]));
        assert.equal(r.git(["rev-parse", ref]).length, 40);
        assert.ok(fs.existsSync(unrelated));
        assert.equal(
          r.git(["rev-parse", unrelatedRef]),
          r.git(["rev-parse", "HEAD"])
        );

        await defined(holder, "holder").release();

        const retry = await r.run(["worktree", "cleanup"]);

        assert.equal(retry.exit, 0, JSON.stringify(retry));
        assert.ok(!fs.existsSync(writer));
        assert.equal(
          r.git(["branch", "--list", "dispatch/test/integration"]),
          ""
        );
        assert.notEqual(
          spawnSync(
            "git",
            ["show-ref", "--verify", "--quiet", candidateRef("test", "T1", 1)],
            { cwd: r.root }
          ).status,
          0
        );
        assert.equal(r.git(["rev-parse", ref]).length, 40);
        assert.ok(fs.existsSync(unrelated));
        assert.equal(
          r.git(["rev-parse", unrelatedRef]),
          r.git(["rev-parse", "HEAD"])
        );
      } finally {
        await holder?.release();
        r.cleanup();
      }
    }
  );

  it("keeps registered control metadata when Git refuses an owned removal", async () => {
    const { r, writer } = await prepared();

    try {
      const next = await r.run(["worktree", "create", "T1"]);

      const other = path.join(r.session, narrow(next.value, createdGuard).path);

      fs.writeFileSync(path.join(other, "src/file.ts"), "second delivered\n");

      const submitted = await r.run(["worktree", "submit", "T1"]);

      assert.equal(submitted.exit, 0);

      const integrated = await r.run(["worktree", "integrate", "T1"]);

      assert.equal(integrated.exit, 0);

      const delivered = await r.run(["worktree", "deliver"]);

      assert.equal(delivered.exit, 0);

      const { run } = r.deps;

      let refusals = 0;

      const faultingRun: Repo["deps"]["run"] = async (argv, opts) => {
        if (
          argv[1] === "worktree" &&
          argv[2] === "remove" &&
          path.resolve(defined(argv[4], "arg")) === path.resolve(writer)
        ) {
          refusals += 1;

          return {
            exit: 1,
            stdout: "",
            stderr: "fatal: simulated permission refusal",
          };
        }

        return await run(argv, opts);
      };

      const partial = await r.run(
        ["worktree", "cleanup"],
        undefined,
        true,
        faultingRun
      );

      assert.equal(refusals, 1);
      assert.equal(partial.exit, 2, JSON.stringify(partial));
      assert.equal(partial.output.reason, "cleanup-incomplete");

      const relative = path.relative(r.session, writer).replaceAll("\\", "/");

      const blocked = defined(
        narrow(partial.value, cleanupGuard).kept.find(
          (row) => row.path === relative
        ),
        "blocked"
      );

      assert.equal(blocked.reason, "removal-failed");
      assert.ok(fs.existsSync(path.join(writer, ".git")));
      assert.ok(registered(r, writer));
      assert.equal(
        r.git(["rev-parse", candidateRef("test", "T1", 1)]).length,
        40
      );
      assert.ok(r.git(["branch", "--list", "dispatch/test/integration"]));

      const retry = await r.run(["worktree", "cleanup"]);

      assert.equal(retry.exit, 0, JSON.stringify(retry));
      assert.ok(!fs.existsSync(writer));
      assert.equal(
        r.git(["branch", "--list", "dispatch/test/integration"]),
        ""
      );
    } finally {
      r.cleanup();
    }
  });

  it("restores a missing registered control link before cleanup checks", async () => {
    const { r, writer } = await prepared();

    try {
      const relative = path.relative(r.session, writer).replaceAll("\\", "/");

      fs.rmSync(path.join(writer, ".git"));

      const cleaned = await r.run(["worktree", "cleanup"]);

      assert.equal(cleaned.exit, 0, JSON.stringify(cleaned));
      assert.ok(narrow(cleaned.value, cleanupGuard).removed.includes(relative));
      assert.ok(!fs.existsSync(writer));
    } finally {
      r.cleanup();
    }
  });

  it("finishes deregistration after an interrupted directory removal", async () => {
    const r = await toolkitRepo();

    try {
      await r.level();

      const made = await r.run(["worktree", "create", "T1"]);

      const madeValue = narrow(made.value, createdGuard);

      const relative = madeValue.path;

      const writer = path.join(r.session, relative);

      fs.writeFileSync(path.join(writer, "src/file.ts"), "preserved\n");

      const abandoned = await r.run([
        "worktree",
        "abandon",
        "T1",
        "--reason",
        "preserve snapshot",
      ]);

      assert.equal(abandoned.exit, 0);

      const closed = await r.run(["worktree", "close", "--reason", "stop"]);

      assert.equal(closed.exit, 0);

      fs.rmSync(writer, { recursive: true, force: true });
      assert.ok(registered(r, writer));

      const cleaned = await r.run(["worktree", "cleanup"]);

      assert.equal(cleaned.exit, 0, JSON.stringify(cleaned));
      assert.ok(narrow(cleaned.value, cleanupGuard).removed.includes(relative));
      assert.ok(!registered(r, writer));
    } finally {
      r.cleanup();
    }
  });

  it("retains work when registered control metadata cannot be verified", async () => {
    const { r, writer } = await prepared();

    try {
      const control = fs.readFileSync(path.join(writer, ".git"), "utf-8");

      const target = defined(
        /^gitdir:\s*(?<link>.+?)\s*$/mu.exec(control)?.groups?.["link"],
        "link"
      );

      const admin = path.resolve(writer, target);

      fs.rmSync(path.join(writer, ".git"));
      fs.writeFileSync(
        path.join(admin, "commondir"),
        "../missing-common-dir\n"
      );

      const result = await r.run(["worktree", "cleanup"]);

      const relative = path.relative(r.session, writer).replaceAll("\\", "/");

      assert.equal(result.exit, 2, JSON.stringify(result));
      assert.equal(result.output.reason, "cleanup-incomplete");
      assert.ok(fs.existsSync(writer));
      assert.ok(
        narrow(result.value, cleanupGuard).kept.some(
          (row) =>
            row.path === relative &&
            row.reason === "control-metadata-unverifiable"
        )
      );
      assert.equal(
        r.git(["rev-parse", candidateRef("test", "T1", 1)]).length,
        40
      );
      assert.ok(registered(r, writer));
    } finally {
      r.cleanup();
    }
  });

  it(
    "keeps a preserved non-integrated writer registered across a lock and retries after release",
    { skip: process.platform !== "win32" },
    async () => {
      const r = await toolkitRepo();

      let holder: Awaited<ReturnType<typeof holdCwd>> | undefined;

      try {
        await r.level();

        const made = await r.run(["worktree", "create", "T1"]);

        const madeValue = narrow(made.value, createdGuard);

        const relative = madeValue.path;

        const writer = path.join(r.session, relative);

        fs.writeFileSync(path.join(writer, "src/file.ts"), "preserved\n");

        const abandoned = await r.run([
          "worktree",
          "abandon",
          "T1",
          "--reason",
          "preserve snapshot",
        ]);

        assert.equal(abandoned.exit, 0);

        const closed = await r.run(["worktree", "close", "--reason", "stop"]);

        assert.equal(closed.exit, 0);

        const abandonedRefName = abandonedRef("test", "T1", 1);

        const saved = r.git(["rev-parse", abandonedRefName]);

        holder = await holdCwd(writer);

        const partial = await r.run(["worktree", "cleanup"]);

        assert.equal(partial.exit, 2, JSON.stringify(partial));
        assert.equal(partial.output.reason, "cleanup-incomplete");
        assert.ok(
          narrow(partial.value, cleanupGuard).kept.some(
            (row) => row.path === relative && row.reason === "removal-failed"
          )
        );
        assert.ok(fs.existsSync(writer));
        assert.ok(fs.existsSync(path.join(writer, ".git")));
        assert.ok(registered(r, writer));
        assert.equal(r.git(["rev-parse", abandonedRefName]), saved);

        await defined(holder, "holder").release();

        const retry = await r.run(["worktree", "cleanup"]);

        assert.equal(retry.exit, 0, JSON.stringify(retry));
        assert.ok(!fs.existsSync(writer));
        assert.ok(!registered(r, writer));
        assert.equal(r.git(["rev-parse", abandonedRefName]), saved);
      } finally {
        await holder?.release();
        r.cleanup();
      }
    }
  );

  it("reports a path-specific Git read fault and removes independent writers", async () => {
    await each(["head", "tree-diff"], async (failure) => {
      const r = await toolkitRepo();

      try {
        await r.level();

        const abandoned = async () => {
          const made = await r.run(["worktree", "create", "T1"]);

          const madeValue = narrow(made.value, createdGuard);

          assert.equal(made.exit, 0, JSON.stringify(made));
          assert.ok(madeValue.launch !== undefined);

          const writer = path.join(r.session, madeValue.path);

          fs.writeFileSync(
            path.join(writer, "src/file.ts"),
            `preserved ${defined(madeValue.launch, "launch")}\n`
          );

          const result = await r.run([
            "worktree",
            "abandon",
            "T1",
            "--reason",
            "preserve snapshot",
          ]);

          assert.equal(result.exit, 0, JSON.stringify(result));

          const abandonedRefName = abandonedRef(
            "test",
            "T1",
            defined(madeValue.launch, "launch")
          );

          return {
            writer,
            relative: madeValue.path,
            ref: abandonedRefName,
            saved: r.git(["rev-parse", abandonedRefName]),
          };
        };

        const blocked = await abandoned();

        const other = await abandoned();

        const closed = await r.run(["worktree", "close", "--reason", "stop"]);

        assert.equal(closed.exit, 0, JSON.stringify(closed));

        if (failure === "tree-diff") {
          fs.writeFileSync(
            path.join(blocked.writer, "ignored"),
            "ignored while checking preservation"
          );
        }

        const snapshotTree = r.git(["rev-parse", `${blocked.saved}^{tree}`]);

        const { run } = r.deps;

        let faults = 0;

        const matches = (
          argv: string[],
          opts: { cwd: string; env?: NodeJS.ProcessEnv }
        ) => {
          const inBlocked =
            path.resolve(opts.cwd) === path.resolve(blocked.writer);

          const inRoot = path.resolve(opts.cwd) === path.resolve(r.root);

          if (failure === "head") {
            return inBlocked && argv[1] === "rev-parse" && argv[2] === "HEAD";
          }

          if (failure === "tested-tree") {
            return (
              inBlocked &&
              argv[1] === "read-tree" &&
              argv[2] === "HEAD" &&
              opts.env?.["GIT_INDEX_FILE"] !== undefined
            );
          }

          if (failure === "snapshot-tree") {
            return (
              inRoot &&
              argv[1] === "rev-parse" &&
              argv[2] === `${blocked.saved}^{tree}`
            );
          }

          return (
            failure === "tree-diff" &&
            inBlocked &&
            argv[1] === "diff" &&
            argv[2] === "--name-only" &&
            argv.includes(snapshotTree)
          );
        };

        const faultingRun: Repo["deps"]["run"] = async (argv, opts) => {
          if (faults === 0 && matches(argv, opts)) {
            faults += 1;

            return {
              exit: 1,
              stdout: "",
              stderr: `fatal: simulated ${failure} read failure`,
            };
          }

          return await run(argv, opts);
        };

        const partial = await r.run(
          ["worktree", "cleanup"],
          undefined,
          true,
          faultingRun
        );

        assert.equal(faults, 1, failure);
        assert.equal(partial.exit, 2, JSON.stringify(partial));
        assert.equal(partial.output.reason, "cleanup-incomplete");

        const partialValue = narrow(partial.value, cleanupGuard);

        const row = defined(
          partialValue.kept.find((entry) => entry.path === blocked.relative),
          "row"
        );

        assert.equal(
          row.reason,
          failure === "head" ? "head-check-failed" : "preservation-check-failed"
        );
        assert.equal(row.code, "GIT_EXIT_2");

        const message = defined(row.message, "message");

        assert.match(message, /simulated/u);
        assert.ok(fs.existsSync(blocked.writer));
        assert.ok(registered(r, blocked.writer));
        assert.equal(r.git(["rev-parse", blocked.ref]), blocked.saved);
        assert.ok(
          partialValue.removed.includes(other.relative),
          JSON.stringify(partialValue)
        );
        assert.ok(!fs.existsSync(other.writer));
        assert.ok(!registered(r, other.writer));

        if (failure === "tree-diff") {
          fs.rmSync(path.join(blocked.writer, "ignored"), { force: true });
        }

        const retry = await r.run(["worktree", "cleanup"]);

        assert.equal(retry.exit, 0, JSON.stringify(retry));
        assert.ok(!fs.existsSync(blocked.writer));
        assert.ok(!registered(r, blocked.writer));
        assert.equal(r.git(["rev-parse", blocked.ref]), blocked.saved);
      } finally {
        r.cleanup();
      }
    });
  });

  it("continues cleanup when the missing integration branch probe throws", async () => {
    const { r, writer } = await prepared();

    try {
      const delivered = await r.run(["worktree", "deliver"]);

      assert.equal(delivered.exit, 0, JSON.stringify(delivered));

      const branch = r.git(["symbolic-ref", "--short", "HEAD"], r.integration);

      const integrationRelative = path
        .relative(r.session, r.integration)
        .replaceAll("\\", "/");

      const saved = r.git(["rev-parse", ref]);

      fs.rmSync(r.integration, { recursive: true, force: true });

      const { run } = r.deps;

      let probes = 0;

      const faultingRun: Repo["deps"]["run"] = async (argv, opts) => {
        if (
          path.resolve(opts.cwd) === path.resolve(r.root) &&
          argv[1] === "rev-parse" &&
          argv[2] === "--verify" &&
          argv[3] === "--quiet" &&
          argv[4] === `refs/heads/${branch}`
        ) {
          probes += 1;
          throw new Error("simulated integration branch verification failure");
        }

        return await run(argv, opts);
      };

      const partial = await r.run(
        ["worktree", "cleanup"],
        undefined,
        true,
        faultingRun
      );

      assert.equal(probes, 1);
      assert.equal(partial.exit, 2, JSON.stringify(partial));
      assert.equal(partial.output.reason, "cleanup-incomplete");

      const partialValue = narrow(partial.value, cleanupGuard);

      const row = defined(
        partialValue.kept.find((entry) => entry.path === integrationRelative),
        "row"
      );

      assert.equal(row.reason, "registration-check-failed");
      assert.equal(row.code, "CLEANUP_FAILED");

      const message = defined(row.message, "message");

      assert.match(
        message,
        /simulated integration branch verification failure/u
      );
      assert.ok(
        partialValue.removed.includes(
          path.relative(r.session, writer).replaceAll("\\", "/")
        )
      );
      assert.ok(!fs.existsSync(writer));
      assert.ok(r.git(["branch", "--list", branch]));
      assert.equal(r.git(["rev-parse", ref]), saved);
    } finally {
      r.cleanup();
    }
  });

  it(
    "reports and recovers a stranded cleanup preflight path",
    { skip: process.platform !== "win32" },
    async (t) => {
      const r = await toolkitRepo();

      let restoreFailures = 0;

      try {
        await r.level();

        const made = await r.run(["worktree", "create", "T1"]);

        const madeValue = narrow(made.value, createdGuard);

        const relative = madeValue.path;

        const writer = path.join(r.session, relative);

        fs.writeFileSync(path.join(writer, "src/file.ts"), "preserved\n");

        const abandoned = await r.run([
          "worktree",
          "abandon",
          "T1",
          "--reason",
          "preserve snapshot",
        ]);

        assert.equal(abandoned.exit, 0);

        const closed = await r.run(["worktree", "close", "--reason", "stop"]);

        assert.equal(closed.exit, 0);

        const recovery = path.join(
          path.dirname(writer),
          `.${path.basename(writer)}.cleanup-recovery`
        );

        const abandonedRefName = abandonedRef("test", "T1", 1);

        const saved = r.git(["rev-parse", abandonedRefName]);

        const originalRename = fs.renameSync;

        const rename = t.mock.method(
          fs,
          "renameSync",
          (from: fs.PathLike, to: fs.PathLike) => {
            const source = path.resolve(from.toString());

            const target = path.resolve(to.toString());

            if (
              target === path.resolve(writer) &&
              path
                .basename(source)
                .startsWith(`.${path.basename(writer)}.cleanup-`) &&
              restoreFailures < 2
            ) {
              restoreFailures += 1;
              throw Object.assign(new Error("simulated restore refusal"), {
                code: "EPERM",
              });
            }

            originalRename(from, to);
          }
        );

        const partial = await (async () => {
          try {
            return await r.run(["worktree", "cleanup"]);
          } finally {
            rename.mock.restore();
          }
        })();

        assert.equal(restoreFailures, 2);
        assert.equal(partial.exit, 2, JSON.stringify(partial));
        assert.equal(partial.output.reason, "cleanup-incomplete");

        const blocked = defined(
          narrow(partial.value, cleanupGuard).kept.find(
            (row) => row.path === relative
          ),
          "blocked"
        );

        assert.equal(blocked.reason, "removal-failed");
        assert.equal(blocked.code, "WORKTREE_RESTORE_FAILED");
        assert.equal(
          blocked.recoveryPath,
          path.relative(r.session, recovery).replaceAll("\\", "/")
        );
        assert.ok(fs.existsSync(recovery));
        assert.ok(!fs.existsSync(writer));
        assert.ok(registered(r, writer));
        assert.equal(r.git(["rev-parse", abandonedRefName]), saved);

        const retry = await r.run(["worktree", "cleanup"]);

        assert.equal(retry.exit, 0, JSON.stringify(retry));
        assert.ok(!fs.existsSync(writer));
        assert.ok(!fs.existsSync(recovery));
        assert.ok(!registered(r, writer));
        assert.equal(r.git(["rev-parse", abandonedRefName]), saved);
      } finally {
        r.cleanup();
      }
    }
  );

  it("refuses a colliding cleanup recovery symlink without following it", async () => {
    const r = await toolkitRepo();

    try {
      await r.level();

      const made = await r.run(["worktree", "create", "T1"]);

      const madeValue = narrow(made.value, createdGuard);

      const relative = madeValue.path;

      const writer = path.join(r.session, relative);

      fs.writeFileSync(path.join(writer, "src/file.ts"), "preserved\n");

      const abandoned = await r.run([
        "worktree",
        "abandon",
        "T1",
        "--reason",
        "preserve snapshot",
      ]);

      assert.equal(abandoned.exit, 0);

      const closed = await r.run(["worktree", "close", "--reason", "stop"]);

      assert.equal(closed.exit, 0);

      const recovery = path.join(
        path.dirname(writer),
        `.${path.basename(writer)}.cleanup-recovery`
      );

      const outside = path.join(r.root, "outside-recovery-target");

      const sentinel = path.join(outside, "keep.txt");

      fs.mkdirSync(outside);
      fs.writeFileSync(sentinel, "keep\n");
      fs.symlinkSync(
        outside,
        recovery,
        process.platform === "win32" ? "junction" : "dir"
      );

      const abandonedRefName = abandonedRef("test", "T1", 1);

      const saved = r.git(["rev-parse", abandonedRefName]);

      const result = await r.run(["worktree", "cleanup"]);

      assert.equal(result.exit, 2, JSON.stringify(result));
      assert.equal(result.output.reason, "cleanup-incomplete");

      const blocked = defined(
        narrow(result.value, cleanupGuard).kept.find(
          (row) => row.path === relative
        ),
        "blocked"
      );

      assert.equal(blocked.reason, "recovery-failed");
      assert.equal(blocked.code, "WORKTREE_RECOVERY_PATH_CONFLICT");
      assert.equal(
        blocked.recoveryPath,
        path.relative(r.session, recovery).replaceAll("\\", "/")
      );
      assert.ok(fs.existsSync(writer));
      assert.equal(fs.lstatSync(recovery).isSymbolicLink(), true);
      assert.equal(fs.readFileSync(sentinel, "utf-8"), "keep\n");
      assert.ok(registered(r, writer));
      assert.equal(r.git(["rev-parse", abandonedRefName]), saved);
    } finally {
      r.cleanup();
    }
  });

  it("keeps changed writer bytes after a locked cleanup retry", async () => {
    const r = await toolkitRepo();

    let holder: Awaited<ReturnType<typeof holdCwd>> | undefined;

    try {
      await r.level();

      const made = await r.run(["worktree", "create", "T1"]);

      const madeValue = narrow(made.value, createdGuard);

      const relative = madeValue.path;

      const writer = path.join(r.session, relative);

      fs.writeFileSync(path.join(writer, "src/file.ts"), "preserved\n");

      const abandoned = await r.run([
        "worktree",
        "abandon",
        "T1",
        "--reason",
        "preserve snapshot",
      ]);

      assert.equal(abandoned.exit, 0);

      const closed = await r.run(["worktree", "close", "--reason", "stop"]);

      assert.equal(closed.exit, 0);

      const abandonedRefName = abandonedRef("test", "T1", 1);

      const saved = r.git(["rev-parse", abandonedRefName]);

      holder = await holdCwd(writer);

      const locked = await r.run(["worktree", "cleanup"]);

      assert.equal(locked.exit, 2);

      await defined(holder, "holder").release();

      fs.writeFileSync(
        path.join(writer, "src/file.ts"),
        "changed after interruption\n"
      );

      const retry = await r.run(["worktree", "cleanup"]);

      assert.equal(retry.exit, 0, JSON.stringify(retry));
      assert.ok(fs.existsSync(writer));
      assert.equal(
        fs.readFileSync(path.join(writer, "src/file.ts"), "utf-8"),
        "changed after interruption\n"
      );
      assert.ok(
        narrow(retry.value, cleanupGuard).kept.some(
          (row) =>
            row.path === relative &&
            row.reason === "unpreserved" &&
            (row.paths ?? []).includes("src/file.ts")
        )
      );
      assert.equal(r.git(["rev-parse", abandonedRefName]), saved);
      assert.ok(registered(r, writer));
    } finally {
      await holder?.release();
      r.cleanup();
    }
  });

  it("reports incomplete cleanup when Git prune fails after a worktree is removed", async () => {
    const { r, writer } = await prepared();

    try {
      const { run } = r.deps;

      let prunes = 0;

      const faultingRun: Repo["deps"]["run"] = async (argv, opts) => {
        if (argv[1] === "worktree" && argv[2] === "prune") {
          prunes += 1;

          if (prunes === 1) {
            return {
              exit: 1,
              stdout: "",
              stderr: "fatal: simulated prune failure",
            };
          }
        }

        return await run(argv, opts);
      };

      const partial = await r.run(
        ["worktree", "cleanup"],
        undefined,
        true,
        faultingRun
      );

      assert.equal(prunes, 1);
      assert.equal(partial.exit, 2, JSON.stringify(partial));
      assert.equal(partial.output.reason, "cleanup-incomplete");

      const relative = path.relative(r.session, writer).replaceAll("\\", "/");

      const partialValue = narrow(partial.value, cleanupGuard);

      assert.ok(
        partialValue.removed.includes(relative),
        JSON.stringify(partial)
      );
      assert.ok(
        partialValue.kept.some(
          (row) =>
            row.path === relative &&
            row.reason === "prune-failed" &&
            row.code === "GIT_EXIT_1"
        )
      );
      assert.equal(
        r.git(["rev-parse", candidateRef("test", "T1", 1)]).length,
        40
      );
      assert.ok(r.git(["branch", "--list", "dispatch/test/integration"]));

      const retry = await r.run(["worktree", "cleanup"]);

      assert.equal(retry.exit, 0, JSON.stringify(retry));
      assert.notEqual(
        spawnSync(
          "git",
          ["show-ref", "--verify", "--quiet", candidateRef("test", "T1", 1)],
          { cwd: r.root }
        ).status,
        0
      );
    } finally {
      r.cleanup();
    }
  });

  it("removes merged worktrees without preservation checks", async () => {
    await each(["writer", "delivered"], async (mode) => {
      const { r, writer } = await prepared();

      try {
        let dir = writer;

        const target = path.join(r.session, "link-target");

        if (mode === "writer") {
          fs.writeFileSync(path.join(writer, "src/file.ts"), "later\n");
          fs.mkdirSync(target);
          fs.writeFileSync(path.join(target, "keep"), "keep");
          fs.symlinkSync(target, path.join(writer, "ignored"), "junction");
        } else {
          const delivered = await r.run(["worktree", "deliver"]);

          assert.equal(delivered.exit, 0);

          dir = r.integration;
          fs.writeFileSync(path.join(dir, "src/file.ts"), "later\n");
          fs.writeFileSync(path.join(dir, "ignored"), "later\n");
        }

        const cleaned = await r.run(["worktree", "cleanup"]);

        assert.equal(cleaned.exit, 0);
        assert.ok(!fs.existsSync(dir));
        assert.ok(!JSON.stringify(cleaned.value).includes("unpreserved"));

        if (mode === "writer") {
          assert.equal(
            fs.readFileSync(path.join(target, "keep"), "utf-8"),
            "keep"
          );
        }

        if (mode === "delivered") {
          assert.equal(
            r.git(["branch", "--list", "dispatch/test/integration"]),
            ""
          );
        }
      } finally {
        r.cleanup();
      }
    });
  });

  it("retries removal of a deregistered worktree remnant without following links", async () => {
    const { r, writer } = await prepared();

    try {
      const target = path.join(r.session, "link-target");

      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, "keep"), "keep");
      // Simulate a cleanup interrupted after Git deregistered the worktree but before the directory was removed.
      r.git(["worktree", "remove", "--force", writer]);
      fs.mkdirSync(writer);
      fs.writeFileSync(path.join(writer, "unlinked.tmp"), "held");
      fs.symlinkSync(target, path.join(writer, "ignored"), "junction");

      const cleaned = await r.run(["worktree", "cleanup"]);

      assert.equal(cleaned.exit, 0);
      assert.ok(!fs.existsSync(writer));
      assert.equal(fs.readFileSync(path.join(target, "keep"), "utf-8"), "keep");
      assert.ok(
        JSON.stringify(narrow(cleaned.value, cleanupGuard).removed).includes(
          path.basename(writer)
        )
      );
    } finally {
      r.cleanup();
    }
  });

  it("keeps deregistered remnants of unmerged work", async () => {
    await each(["active-writer", "moved-integration"], async (mode) => {
      const r = await toolkitRepo(planSource, base);

      try {
        await r.level();

        let dir: string;

        if (mode === "active-writer") {
          const created = await r.run(["worktree", "create", "T1"]);

          dir = path.join(r.session, narrow(created.value, createdGuard).path);
        } else {
          const made = await r.run(["worktree", "create", "T1"]);

          fs.writeFileSync(
            path.join(
              r.session,
              narrow(made.value, createdGuard).path,
              "src/file.ts"
            ),
            "delivered\n"
          );

          const submitted = await r.run(["worktree", "submit", "T1"]);

          assert.equal(submitted.exit, 0);

          const integrated = await r.run(["worktree", "integrate", "T1"]);

          assert.equal(integrated.exit, 0);

          const delivered = await r.run(["worktree", "deliver"]);

          assert.equal(delivered.exit, 0);

          fs.writeFileSync(path.join(r.integration, "src/file.ts"), "after\n");

          const committed = await r.run([
            "worktree",
            "commit",
            "--reason",
            "after",
          ]);

          assert.equal(committed.exit, 0);

          dir = r.integration;
        }

        r.git(["worktree", "remove", "--force", dir]);
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, "work"), "kept");

        const cleaned = await r.run(["worktree", "cleanup"]);

        assert.equal(cleaned.exit, 0);
        assert.equal(fs.readFileSync(path.join(dir, "work"), "utf-8"), "kept");
        assert.ok(
          JSON.stringify(narrow(cleaned.value, cleanupGuard).kept).includes(
            "unpreserved"
          )
        );
      } finally {
        r.cleanup();
      }
    });
  });

  it("removes abandoned launches and rejected candidates after close", async () => {
    const r = await toolkitRepo();

    try {
      await r.level();

      const firstCreated = await r.run(["worktree", "create", "T1"]);

      const firstPath = narrow(firstCreated.value, createdGuard).path;

      fs.writeFileSync(
        path.join(r.session, firstPath, "src/file.ts"),
        "abandoned\n"
      );

      const abandoned = await r.run([
        "worktree",
        "abandon",
        "T1",
        "--reason",
        "discard",
      ]);

      assert.equal(abandoned.exit, 0);

      const secondCreated = await r.run(["worktree", "create", "T1"]);

      const secondPath = narrow(secondCreated.value, createdGuard).path;

      fs.writeFileSync(
        path.join(r.session, secondPath, "src/file.ts"),
        "rejected\n"
      );

      const submitted = await r.run(["worktree", "submit", "T1"]);

      assert.equal(submitted.exit, 0);

      const aborted = await r.run([
        "worktree",
        "abort",
        "T1",
        "--reason",
        "reject",
      ]);

      assert.equal(aborted.exit, 0);

      const closed = await r.run(["worktree", "close", "--reason", "stop"]);

      assert.equal(closed.exit, 0);

      const clean = await r.run(["worktree", "cleanup"]);

      assert.equal(clean.exit, 0);
      assert.ok(!fs.existsSync(path.join(r.session, firstPath)));
      assert.ok(!fs.existsSync(path.join(r.session, secondPath)));
      assert.ok(!fs.existsSync(r.integration));
    } finally {
      r.cleanup();
    }
  });
});

// SECTION: coverage gate over saved code-integration rounds
const [slotA, slotB, slotC, slotD] = [
  "codex[0]",
  "opencode[1]",
  "claude[2]",
  "agy[3]",
];

interface RoundInput {
  n: number;
  roster: string[];
  done?: string[];
  failed?: string[];
  coverage?: "open" | "full";
  generation?: number;
  unfinished?: boolean;
  // Failure entries per generation; the current generation defaults to one entry per failed slot.
  attempts?: Record<number, { slot: string; seq: number }[]>;
}

const writeJsonFile = (file: string, value: JsonValue) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};

// Writes a round as `review run` leaves it, replacing any earlier copy of the same number.
const coverageRound = (r: Repo, input: RoundInput) => {
  const dir = path.join(
    r.session,
    ".state/reviews/code-integration",
    `round-${input.n}`
  );

  const generation = input.generation ?? 1;

  fs.rmSync(dir, { recursive: true, force: true });

  const records = foldLedger(r.session);

  const opener = defined(
    records.records.find((record) => record.data["phase"] === "opened"),
    "opened"
  );

  const baseValue = defined(opener.data["base"], "base");

  const seq = records.lastSeq;

  const roundFields = {
    round: input.n,
    generation,
    cap: 3,
    level: "low",
    startSeq: 0,
    scope:
      input.n === 1
        ? "Full review"
        : `Re-review round ${input.n} (coverage) — changed paths: src/file.ts`,
    spec: {
      path: path.join(r.root, "work.spec.md"),
      hash: `sha256:${"a".repeat(64)}`,
    },
    target: {
      base: baseValue,
      head: r.git(["rev-parse", "HEAD"], r.integration),
    },
    roster: input.roster.map((slot) => ({
      slot,
      provider: "codex",
      index: 0,
      reserve: false,
    })),
  };

  if (input.coverage === undefined) {
    writeJsonFile(path.join(dir, "round.json"), roundFields);
  } else {
    writeJsonFile(path.join(dir, "round.json"), {
      ...roundFields,
      coverage: input.coverage,
    });
  }

  for (const slot of input.done ?? []) {
    writeJsonFile(
      path.join(dir, `gen-${generation}`, "slots", `${slot}.json`),
      {
        slot,
        state: "done",
        text: '{"status":"CLEAN","findings":[]}',
      }
    );
  }

  for (const slot of input.failed ?? []) {
    writeJsonFile(
      path.join(dir, `gen-${generation}`, "slots", `${slot}.json`),
      {
        slot,
        state: "failed",
        cls: "timeout",
        reason: "slow",
      }
    );
  }

  const entryMap = new Map([
    [`${generation}`, (input.failed ?? []).map((slot) => ({ slot, seq }))],
  ]);

  for (const [gen, list] of Object.entries(input.attempts ?? {})) {
    entryMap.set(gen, list);
  }

  for (const [gen, list] of entryMap) {
    writeJsonFile(
      path.join(dir, `gen-${gen}`, "attempts.json"),
      list.map((item) => ({ wholeTarget: true, outcome: "timeout", ...item }))
    );
  }

  if (input.unfinished !== true) {
    writeJsonFile(path.join(dir, "findings.json"), {
      review: "code-integration",
      round: input.n,
      findings: [],
      failed: input.failed ?? [],
    });
  }

  return dir;
};

const userCoverage = async (r: Repo, summary: string, quote: string) => {
  const seq = foldLedger(r.session).lastSeq;

  return await appendRecord(
    r.session,
    {
      kind: "escalation",
      by: "user",
      quote,
      key: `coverage:code-integration:${seq}`,
      data: {
        id: `coverage:code-integration:${seq}`,
        state: "resolved",
        summary,
      },
    },
    r.deps
  );
};

// A refusal must leave the caller and the ledger untouched.
const refused = async (r: Repo, expected: RegExp) => {
  const before = caller(r);

  const bytes = fs.readFileSync(path.join(r.root, "src/file.ts"));

  const result = await r.run(["worktree", "deliver"]);

  assert.equal(result.exit, 4, JSON.stringify(result));
  assert.equal(result.output.reason, "coverage-required");
  assert.match(result.output.summary, expected);
  assert.deepEqual(caller(r), before);
  assert.deepEqual(fs.readFileSync(path.join(r.root, "src/file.ts")), bytes);
  assert.equal(rows(r, "deliver-started").length, 0);
  assert.equal(rows(r, "delivered").length, 0);
};

describe("deliver coverage gate", () => {
  it("deliver coverage gate refuses open slots, a user decision, an incomplete round and unreadable state", async () => {
    const { r } = await prepared();

    try {
      // A slot with no whole-target rerun after its failure.
      coverageRound(r, {
        n: 1,
        roster: [slotA, slotB, slotC, slotD],
        done: [slotC, slotD],
        failed: [slotA, slotB],
      });
      await refused(r, /codex\[0\].*opencode\[1\]/u);

      // Rerun failed again with half of the targets completed: only the user can proceed.
      coverageRound(r, {
        n: 2,
        roster: [slotA, slotB],
        failed: [slotA, slotB],
        coverage: "open",
      });
      await refused(
        r,
        /codex\[0\].*opencode\[1\].*accept reduced coverage.*one more coverage round/u
      );

      // A failed slot file without a failure entry cannot be trusted.
      coverageRound(r, {
        n: 2,
        roster: [slotA, slotB],
        failed: [slotA, slotB],
        coverage: "open",
      });
      fs.rmSync(
        path.join(
          r.session,
          ".state/reviews/code-integration/round-2/gen-1/attempts.json"
        )
      );
      await refused(r, /Cannot establish coverage.*round-2/u);
      fs.rmSync(
        path.join(r.session, ".state/reviews/code-integration/round-2"),
        {
          recursive: true,
        }
      );

      // A round still in flight can still publish a failure.
      coverageRound(r, {
        n: 1,
        roster: [slotA, slotB],
        done: [slotA],
        unfinished: true,
      });
      await refused(r, /round 1 is incomplete/u);
    } finally {
      r.cleanup();
    }
  });

  it("deliver coverage gate continues when a majority completed after the rerun", async () => {
    const { r } = await prepared();

    try {
      coverageRound(r, {
        n: 1,
        roster: [slotA, slotB, slotC],
        done: [slotB, slotC],
        failed: [slotA],
      });
      coverageRound(r, {
        n: 2,
        roster: [slotA],
        failed: [slotA],
        coverage: "open",
      });

      const result = await r.run(["worktree", "deliver"]);

      assert.equal(result.exit, 0, JSON.stringify(result));
      assert.equal(narrow(result.value, deliverGuard).delivered, true);
      assert.equal(rows(r, "delivered").length, 1);
    } finally {
      r.cleanup();
    }
  });

  it("deliver coverage gate honours an override until a later failure reopens the slot", async () => {
    const { r } = await prepared();

    try {
      coverageRound(r, {
        n: 1,
        roster: [slotA, slotB],
        done: [slotB],
        failed: [slotA],
      });
      await userCoverage(r, `accept: ${slotA}`, "ship without codex");

      // The rerun fails after the override while the other slot is still in flight.
      coverageRound(r, {
        n: 2,
        roster: [slotA, slotB],
        coverage: "full",
        unfinished: true,
        failed: [slotA],
      });
      await refused(r, /codex\[0\]/u);

      // A target-moved retry keeps the superseded generation's failure while its slots are pending.
      coverageRound(r, {
        n: 2,
        roster: [slotA, slotB],
        coverage: "full",
        unfinished: true,
        generation: 2,
        attempts: { 1: [{ slot: slotA, seq: foldLedger(r.session).lastSeq }] },
      });
      await refused(r, /codex\[0\]/u);

      // Without the later failure the override covers the slot.
      fs.rmSync(
        path.join(r.session, ".state/reviews/code-integration/round-2"),
        {
          recursive: true,
        }
      );

      const result = await r.run(["worktree", "deliver"]);

      assert.equal(result.exit, 0, JSON.stringify(result));
      assert.equal(narrow(result.value, deliverGuard).delivered, true);
    } finally {
      r.cleanup();
    }
  });

  it("deliver coverage gate leaves a started delivery to existing recovery", async () => {
    const { r } = await prepared();

    try {
      const crash = await r.run(["worktree", "deliver"], (p) => {
        if (p === "deliver:after-started") {
          throw new Error("injected");
        }
      });

      assert.equal(crash.exit, 2);
      assert.equal(rows(r, "deliver-started").length, 1);

      coverageRound(r, {
        n: 1,
        roster: [slotA, slotB, slotC],
        done: [slotB, slotC],
        failed: [slotA],
      });

      await appendRecord(
        r.session,
        {
          kind: "integrate",
          by: "orchestrator",
          data: {
            phase: "verification",
            cycle: 2,
            outcome: "partial",
            head: r.git(["rev-parse", "HEAD"], r.integration),
            reason: "re-check",
            open: ["2:V0"],
            report: "verification/report.md",
          },
        },
        r.deps
      );

      const retry = await r.run(["worktree", "deliver"]);

      assert.equal(retry.exit, 0, JSON.stringify(retry));
      assert.equal(narrow(retry.value, deliverGuard).delivered, true);
    } finally {
      r.cleanup();
    }
  });
});

it("deliver verification gate refuses an absent outcome before caller writes", async () => {
  const { r } = await prepared();

  try {
    const before = caller(r);

    const result = await r.run(["worktree", "deliver"], undefined, false);

    assert.equal(result.output.reason, "verification-required");
    assert.deepEqual(caller(r), before);
    assert.equal(rows(r, "deliver-started").length, 0);
  } finally {
    r.cleanup();
  }
});

it("deliver verification gate follows latest outcome and later rulings", async () => {
  const { r } = await prepared();

  try {
    let n = 0;

    const head = r.git(["rev-parse", "HEAD"], r.integration);

    const proof = async (cycle: number, outcome: string, open: string[]) => {
      const key = `proof-${n}`;

      n += 1;

      if (outcome === "no-op") {
        return await appendRecord(
          r.session,
          {
            kind: "integrate",
            by: "orchestrator",
            key,
            data: {
              phase: "verification",
              cycle,
              outcome,
              head,
              reason: "test",
              open,
            },
          },
          r.deps
        );
      }

      return await appendRecord(
        r.session,
        {
          kind: "integrate",
          by: "orchestrator",
          key,
          data: {
            phase: "verification",
            cycle,
            outcome,
            head,
            reason: "test",
            open,
            report: "verification/report.md",
          },
        },
        r.deps
      );
    };

    const ruling = async () => {
      const key = `ruling-${n}`;

      n += 1;

      return await appendRecord(
        r.session,
        {
          kind: "ruling",
          by: "orchestrator",
          key,
          data: {
            subject: "verification:2:V1",
            ruling: "accepted",
            rationale: "valid",
          },
        },
        r.deps
      );
    };

    const refuse = async () => {
      const before = caller(r);

      const result = await r.run(["worktree", "deliver"], undefined, false);

      assert.equal(result.output.reason, "verification-required");
      assert.deepEqual(caller(r), before);
      assert.equal(rows(r, "deliver-started").length, 0);
    };

    await proof(1, "proved", []);
    await proof(2, "partial", ["2:V1"]);
    await refuse();
    await proof(2, "partial", []);
    await ruling();
    await refuse();
    await proof(3, "partial", ["3:V0"]);
    await refuse();
    await proof(3, "partial", []);

    const delivered = await r.run(["worktree", "deliver"], undefined, false);

    assert.equal(delivered.exit, 0);
  } finally {
    r.cleanup();
  }
});
