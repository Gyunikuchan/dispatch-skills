import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { artifactHash } from "../../../skills/dispatch/scripts/toolkit/artifacts.ts";
import { main } from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import { foldLedger } from "../../../skills/dispatch/scripts/toolkit/ledger.ts";
import { defined } from "../../helpers/guards.ts";
import { CLEAN, CONTEXT_MAP, fixture } from "../../helpers/review-fixture.ts";
import {
  anything,
  listOf,
  narrow,
  readJson,
  withFields,
  text,
} from "./helpers/json.ts";
import { useMemoryAtomicWrite } from "./helpers/session.ts";

// SECTION: Ceiling helpers shared with review.test.ts (duplicated for split)

test("plan and design review rounds update the bound findings section", async () => {
  const f = await fixture();
  const restoreWrite = useMemoryAtomicWrite();

  try {
    const design = f.artifact(
      "strategy.design.md",
      "# Strategy\n## Boundaries\nA boundary.\n## Review Findings & Resolutions\nDriver notes.\n"
    );

    f.artifact("strategy.design.context.md", CONTEXT_MAP);
    await f.add("bind", {
      spec: "mission.spec.md",
      plan: "work.plan.md",
      design: "strategy.design.md",
    });

    for (const [kind, target, review] of [
      ["plan", f.plan, "plan-work.plan"],
      ["design", design, "design-strategy.design"],
    ] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const first = await f.call(kind, target);
      assert.equal(first.exit, 0, JSON.stringify(first));
      assert.equal(
        narrow(first.value, withFields({ findingsSection: text }))
          .findingsSection,
        "updated",
        JSON.stringify(first.value)
      );
      assert.match(
        fs.readFileSync(target, "utf-8"),
        new RegExp(`Round 1 \\(${review}\\): 1 findings`, "u")
      );

      fs.appendFileSync(target, "\n## Follow-up\nChanged for round two.\n");
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const second = await f.call(kind, target);
      assert.equal(second.exit, 0, JSON.stringify(second));
      assert.equal(
        narrow(second.value, withFields({ findingsSection: text }))
          .findingsSection,
        "updated"
      );
      const source = fs.readFileSync(target, "utf-8");
      assert.match(
        source,
        new RegExp(`Round 1 \\(${review}\\): 1 findings`, "u")
      );
      assert.match(
        source,
        new RegExp(`Round 2 \\(${review}\\): 1 findings`, "u")
      );
    }
  } finally {
    restoreWrite();
    f.cleanup();
  }
});

test("standalone review targets accept spec overrides and stable Git snapshots", async () => {
  const ACCEPTED =
    "code targets are integration, a bound-plan task ID, worktree, <a>..<b> or <rev>";

  const f = await fixture(false);

  try {
    f.config(true);
    f.deps.liveness = {};
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
    f.deps.orchestrator = {
      platform: "codex",
      model: "native",
    } as typeof f.deps.orchestrator;
    const calls: { argv: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];

    let feature = "feature-id";
    let missing = false;
    let tree = "tree-one";
    let unrelated = false;
    let heads: string[] = [];
    let head = "head-id";

    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.run = (argv, options) => {
      calls.push({ argv, env: options.env });
      const [, op] = argv;

      if (op === "rev-parse") {
        let stdout: string;
        const rev = argv.at(-1);

        if (rev === "HEAD^{commit}") {
          stdout = heads.shift() ?? head;
        } else if (rev === "feature^{commit}") {
          stdout = feature;
        } else {
          stdout = "main-id";
        }

        return Promise.resolve({
          exit: missing || rev === "T1^{commit}" ? 1 : 0,
          stdout,
          stderr: "unknown revision",
        });
      }

      if (op === "merge-base") {
        return Promise.resolve({
          exit: unrelated ? 1 : 0,
          stdout: "ancestor-id",
          stderr: "no common ancestor",
        });
      }

      let stdout: string;

      if (op === "write-tree") {
        stdout = tree;
      } else if (op === "commit-tree") {
        stdout = `snapshot-${tree}`;
      } else if (op === "diff") {
        stdout = "src.ts\0";
      } else {
        stdout = "";
      }

      return Promise.resolve({
        exit: 0,
        stdout,
        stderr: "",
      });
    };

    const call = async (
      kind: string,
      target: string,
      spec: string | null = "mission.spec.md"
    ) => {
      f.lines.length = 0;

      const exit = await main(
        [
          "review",
          "run",
          target,
          "--kind",
          kind,
          "--level",
          "medium",
          "--session",
          f.session,
          "--host",
          "codex",
          ...(spec === null ? [] : ["--spec", spec]),
        ],
        f.deps
      );

      const output = f.output();

      return {
        exit,
        output,
        // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
        value:
          (output.path ?? "").length > 0
            ? JSON.parse(fs.readFileSync(defined(output.path), "utf-8"))
            : null,
      };
    };

    const finish = async (
      result: Awaited<ReturnType<typeof call>>,
      kind: string,
      target: string,
      spec?: string
    ) => {
      assert.equal(result.exit, 4);
      assert.equal(result.output.reason, "native-pending");

      for (const slot of narrow(
        result.value,
        withFields({ pending: listOf(withFields({ replyPath: text })) })
      ).pending) {
        fs.writeFileSync(slot.replyPath, CLEAN);
      }

      const done = await call(kind, target, spec);
      assert.equal(done.exit, 0, JSON.stringify(done));
      const donePath = narrow(done.value, withFields({ path: text })).path;
      assert.deepEqual(
        readJson(donePath, withFields({ findings: listOf(anything) })).findings,
        []
      );

      return done;
    };

    const design = f.artifact(
      "strategy.design.md",
      "# Strategy\n## Boundaries\nA boundary.\n"
    );

    f.artifact("strategy.design.context.md", CONTEXT_MAP);
    const pending = await call("design", design);
    assert.ok(
      pending.output.summary.includes("launch: model native, no effort set")
    );
    await finish(pending, "design", design, f.spec);

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const designRound = JSON.parse(
      fs.readFileSync(
        path.join(
          f.session,
          ".state/reviews/design-strategy.design/round-1/round.json"
        ),
        "utf-8"
      )
    );

    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(designRound.spec.path, fs.realpathSync.native(f.spec));
    await finish(await call("plan", f.plan), "plan", f.plan);
    const callResult = await call("code", "integration");

    assert.equal(callResult.output.reason, "lint-errors");
    const work = await call("code", "worktree");
    await finish(work, "code", "worktree");
    const commit = defined(calls.find((row) => row.argv[1] === "commit-tree"));
    assert.deepEqual(commit.argv.slice(2), [
      "tree-one",
      "-p",
      "head-id",
      "-m",
      "dispatch review snapshot",
    ]);

    for (const role of ["AUTHOR", "COMMITTER"]) {
      assert.equal(defined(commit.env)[`GIT_${role}_NAME`], "Dispatch Review");
      assert.equal(
        defined(commit.env)[`GIT_${role}_EMAIL`],
        "dispatch-review@localhost"
      );
      assert.equal(
        defined(commit.env)[`GIT_${role}_DATE`],
        "1970-01-01T00:00:00Z"
      );
    }

    assert.ok(
      calls.some(
        (row) => row.argv[1] === "read-tree" && row.argv[2] === "head-id"
      )
    );
    assert.ok(
      calls.some(
        (row) =>
          row.argv[1] === "reset" &&
          row.argv.at(-1) ===
            `:(top,literal)${path
              .relative(fs.realpathSync(f.root), fs.realpathSync(f.session))
              .split(path.sep)
              .join("/")}`
      )
    );
    tree = "tree-two";
    const callResult2 = await call("code", "worktree");

    assert.equal(callResult2.output.reason, "native-pending");
    tree = "tree-three";
    const callResult3 = await call("code", "worktree");

    assert.equal(callResult3.output.reason, "native-pending");

    const workDir = defined(
      fs
        .readdirSync(path.join(f.session, ".state/reviews"))
        .find((name) => name.startsWith("code-worktree-"))
    );

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const moved = JSON.parse(
      fs.readFileSync(
        path.join(f.session, ".state/reviews", workDir, "round-2/round.json"),
        "utf-8"
      )
    );

    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.deepEqual(moved.target, {
      base: "head-id",
      head: "snapshot-tree-three",
    });
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(moved.generation, 2);
    heads = ["fresh-head"];
    head = "moved-head";
    const callResult4 = await call("code", "worktree");

    assert.equal(callResult4.output.reason, "target-moved");
    head = "head-id";

    for (const target of ["feat/x", "feat-x", "main..feature", "main"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const callResult5 = await call("code", target);

      assert.equal(callResult5.output.reason, "native-pending");
    }

    feature = "moved-feature";
    const callResult6 = await call("code", "main..feature");

    assert.equal(callResult6.output.reason, "native-pending");

    const rangeDir = defined(
      fs
        .readdirSync(path.join(f.session, ".state/reviews"))
        .find((name) => name.startsWith("code-main..feature-"))
    );

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const range = JSON.parse(
      fs.readFileSync(
        path.join(f.session, ".state/reviews", rangeDir, "round-1/round.json"),
        "utf-8"
      )
    );

    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.deepEqual(range.target, { base: "main-id", head: "moved-feature" });
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(range.generation, 2);

    const dirs = fs
      .readdirSync(path.join(f.session, ".state/reviews"))
      .filter((name) => name.startsWith("code-feat-x-"));

    assert.equal(dirs.length, 2);
    assert.notEqual(dirs[0], dirs[1]);
    assert.ok(
      calls.some(
        (row) =>
          JSON.stringify(row.argv) ===
          JSON.stringify([
            "git",
            "rev-parse",
            "--verify",
            "--end-of-options",
            "feature^{commit}",
          ])
      )
    );
    assert.ok(
      calls.some(
        (row) =>
          JSON.stringify(row.argv) ===
          JSON.stringify(["git", "merge-base", "main-id", "head-id"])
      )
    );
    const unresolved = await call("code", "T1");
    assert.equal(unresolved.output.reason, "invalid-input");
    assert.equal(
      unresolved.output.summary,
      `Cannot resolve revision T1; ${ACCEPTED}`
    );
    f.lines.length = 0;
    assert.equal(
      await main(
        ["review", "run", "--session", f.session, "--host", "codex"],
        f.deps
      ),
      1
    );
    assert.equal(f.output().reason, "invalid-input");
    assert.equal(
      f.output().summary,
      `One review target is required: ${ACCEPTED}; plan and design targets are artifact paths`
    );
    unrelated = true;
    const orphan = await call("code", "orphan");
    assert.equal(orphan.output.reason, "invalid-input");
    assert.match(orphan.output.summary, /common ancestor/u);
    unrelated = false;
    missing = true;
    const headUnresolved = await call("code", "worktree");
    assert.equal(headUnresolved.output.reason, "invalid-input");
    assert.equal(
      headUnresolved.output.summary,
      `Cannot resolve revision HEAD; ${ACCEPTED}`
    );
    missing = false;
    const callResult7 = await call("plan", f.plan, "absent.spec.md");

    assert.equal(callResult7.output.reason, "invalid-input");
    const noSpec = await call("plan", f.plan, null);
    assert.equal(noSpec.exit, 4);
    assert.equal(noSpec.output.reason, "lint-errors");
    await f.add("bind", { spec: "mission.spec.md", plan: "work.plan.md" });

    const override = f.artifact(
      "override.spec.md",
      "# Override\n## Requirements\n### REQ-1 — Override\n"
    );

    await f.confirm(override);
    const callResult8 = await call("design", design, override);

    assert.equal(callResult8.output.reason, "native-pending");

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const overridden = JSON.parse(
      fs.readFileSync(
        path.join(
          f.session,
          ".state/reviews/design-strategy.design/round-2/round.json"
        ),
        "utf-8"
      )
    );

    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(overridden.spec.path, fs.realpathSync.native(override));
  } finally {
    f.cleanup();
  }
});

test("standalone Git reviews survive invalid or missing bound plans", async () => {
  const f = await fixture();

  try {
    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.delegate = () =>
      Promise.resolve({
        outcome: { status: "ok", text: CLEAN, resume: null, sessionId: null },
        invocations: [],
      });
    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.run = (argv) => {
      const [, command] = argv;
      let stdout: string;

      if (command === "diff") {
        stdout = "src.ts\0";
      } else if (command === "write-tree") {
        stdout = "tree-id";
      } else if (command === "commit-tree") {
        stdout = "snapshot-id";
      } else {
        stdout = "commit-id";
      }

      return Promise.resolve({
        exit: 0,
        stdout,
        stderr: "",
      });
    };

    for (const state of ["invalid", "missing"]) {
      if (state === "invalid") {
        fs.writeFileSync(f.plan, "# Broken plan\n");
      } else {
        fs.unlinkSync(f.plan);
      }

      for (const target of ["worktree", "main..feature", "main"]) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        const result = await f.call("code", target);
        assert.equal(
          result.exit,
          0,
          `${state} ${target} ${result.output.summary}`
        );

        const resultPath = narrow(
          result.value,
          withFields({ path: text })
        ).path;

        assert.deepEqual(
          readJson(resultPath, withFields({ findings: listOf(anything) }))
            .findings,
          []
        );
      }
    }
  } finally {
    f.cleanup();
  }
});

test("standalone Git reviews explain unsupported three dot ranges", async () => {
  const f = await fixture(false);

  try {
    f.deps.run = async () => {
      await Promise.resolve();

      return { exit: 1, stdout: "", stderr: "unknown revision" };
    };

    f.lines.length = 0;

    const exit = await main(
      [
        "review",
        "run",
        "main...feature",
        "--kind",
        "code",
        "--spec",
        f.spec,
        "--session",
        f.session,
        "--host",
        "opencode",
      ],
      f.deps
    );

    const output = f.output();
    assert.equal(exit, 1);
    assert.equal(output.reason, "invalid-input");
    assert.match(output.summary, /three-dot.*not supported.*a\.\.b/iu);
  } finally {
    f.cleanup();
  }
});

test("design-stage review binds its spec and preserves an in-place revision without a plan", async () => {
  const f = await fixture(false);

  try {
    const design = f.artifact(
      "strategy.design.md",
      "# Strategy\n## Approach\nOne boundary.\n"
    );

    f.artifact("strategy.design.context.md", CONTEXT_MAP);
    await f.add("bind", {
      spec: "mission.spec.md",
      design: "strategy.design.md",
    });
    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.delegate = () =>
      Promise.resolve({
        outcome: { status: "ok", text: CLEAN, resume: null, sessionId: null },
        invocations: [],
      });
    const callResult9 = await f.call("design", design);

    assert.equal(callResult9.exit, 0);
    const before = artifactHash("design", fs.readFileSync(design, "utf-8"));
    fs.appendFileSync(design, "\n## Risks\nRetain the original boundary.\n");
    await f.add("edit", {
      artifact: "design",
      before,
      after: artifactHash("design", fs.readFileSync(design, "utf-8")),
      class: "non-intent",
      affects: [],
      rationale: "Clarify risk",
      diffRef: "design diff",
    });
    const callResult10 = await f.call("design", design);

    assert.equal(callResult10.exit, 0);
    assert.equal(
      foldLedger(f.session).records.filter((row) => row.kind === "edit").length,
      1
    );
  } finally {
    f.cleanup();
  }
});

test("review native-pending summary lists distinct summaryLaunch items within 1024 bytes", async () => {
  const f = await fixture(false);

  try {
    const targets = Array.from({ length: 7 }, (_, i) => ({
      medium: {
        model: [`prov/model-${i}`, `prov/fallback-${i}`],
        effort: "high",
      },
    }));

    fs.writeFileSync(
      path.join(f.deps.skillRoot, "config.jsonc"),
      JSON.stringify({ "read-delegates": { opencode: { targets } } })
    );
    f.deps.liveness = { opencode: true };
    f.deps.orchestrator = { platform: "opencode", model: null };

    const design = f.artifact(
      "seven.design.md",
      "# Strategy\n## Boundaries\nA boundary.\n"
    );

    f.artifact("seven.design.context.md", CONTEXT_MAP);

    const exit = await main(
      [
        "review",
        "run",
        design,
        "--kind",
        "design",
        "--level",
        "medium",
        "--pins",
        "(all)",
        "--spec",
        f.spec,
        "--session",
        f.session,
        "--host",
        "opencode",
      ],
      f.deps
    );

    const output = f.output();

    const value = readJson(
      defined(output.path),
      withFields({ pending: listOf(anything) })
    );

    assert.equal(exit, 4);
    assert.equal(output.reason, "native-pending");
    assert.equal(value.pending.length, 7);
    const { summary } = output;
    assert.ok(
      Buffer.byteLength(summary, "utf-8") <= 1024,
      `summary exceeded 1024 bytes: ${Buffer.byteLength(summary, "utf-8")}`
    );
    assert.ok(
      summary.includes(
        'launch: `subagent` with `model: "prov/model-0#high"` (user-configured; set it despite the tool\'s default guidance) (+1 fallbacks in result)'
      )
    );
    assert.match(summary, /; \+\d+ more in result$/u);

    const body = summary.slice(
      summary.indexOf("; first ") + 2,
      summary.lastIndexOf("; +")
    );

    const shown = body.slice(body.indexOf(": ") + 2).split(/; (?=launch: )/u);

    for (const item of shown) {
      assert.match(
        item,
        /^launch: `subagent` with `model: "prov\/model-\d+#high"` \(user-configured; set it despite the tool's default guidance\) \(\+1 fallbacks in result\)$/u
      );
    }
  } finally {
    f.cleanup();
  }
});
