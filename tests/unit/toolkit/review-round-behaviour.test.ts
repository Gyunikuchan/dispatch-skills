import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { artifactHash } from "../../../skills/dispatch/scripts/toolkit/artifacts.ts";
import { main } from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import type { Finding } from "../../../skills/dispatch/scripts/toolkit/domain/types.ts";
import { appendRecord } from "../../../skills/dispatch/scripts/toolkit/ledger.ts";
import { defined } from "../../helpers/guards.ts";
import {
  CLEAN,
  CONTEXT_MAP,
  fixture,
  report,
} from "../../helpers/review-fixture.ts";
import {
  anything,
  flag,
  listOf,
  narrow,
  numeric,
  readJson,
  withFields,
  text,
} from "./helpers/json.ts";

test("review rounds capture dedupe clusters scope caps and design prompts", async () => {
  const f = await fixture();

  try {
    const reviewedSource = fs.readFileSync(f.plan, "utf-8");
    const first = await f.call();
    assert.equal(first.exit, 0);

    const round = narrow(
      f.read(1, "round.json"),
      withFields({ generation: numeric, cap: numeric, target: text })
    );

    const findings = narrow(
      f.read(1, "findings.json"),
      withFields({
        findings: listOf(withFields({ id: text, sources: listOf(anything) })),
        clusters: listOf(withFields({ file: text })),
      })
    );

    assert.equal(round.generation, 1);
    assert.equal(round.cap, 2);
    assert.match(round.target, /^sha256:/u);
    assert.equal(
      fs.readFileSync(
        path.join(f.directory, "round-1/target.snapshot.md"),
        "utf-8"
      ),
      reviewedSource
    );
    assert.equal(findings.findings[0]?.id, "R1-F001");
    assert.equal(findings.clusters.length, 1);
    assert.equal(findings.clusters[0]?.file, f.plan);
    assert.ok((findings.findings[0]?.sources.length ?? 0) >= 2);
    assert.match(first.output.summary, /round 1\/2/u);
    assert.match(first.output.summary, /1 SHOULD/u);
    assert.match(
      fs.readFileSync(defined(f.launches[0]).request.promptPath, "utf-8"),
      /Full review/u
    );
    await f.add("ruling", {
      subject: "review:plan-work.plan:R1-F001",
      ruling: "accepted",
      rationale: "Fixed the race",
    });
    fs.appendFileSync(f.plan, "\n## New work\nChanged.\n");
    const callResult = await f.call();

    assert.equal(callResult.exit, 0);

    const prompt = fs.readFileSync(
      defined(f.launches.at(-1)).request.promptPath,
      "utf-8"
    );

    assert.match(prompt, /changed: New work/u);
    assert.match(prompt, /Settled in earlier rounds/u);
    assert.match(prompt, /accepted/u);
    assert.doesNotMatch(
      defined(defined(prompt.split("- Scope: ")[1]).split("\n")[0]),
      /Review Findings & Resolutions/u
    );
    const callResult2 = await f.call();

    assert.equal(callResult2.output.reason, "round-cap");

    const design = f.artifact(
      "strategy.design.md",
      "# Strategy\n## Boundaries\nA boundary.\n"
    );

    f.artifact("strategy.design.context.md", CONTEXT_MAP);
    const callResult3 = await f.call("design", design);

    assert.equal(callResult3.exit, 0);
    assert.match(
      fs.readFileSync(defined(f.launches.at(-1)).request.promptPath, "utf-8"),
      /Design Path:|Design:/u
    );
  } finally {
    f.cleanup();
  }
});

test("review rounds gate skip native pending and all failed slots", async () => {
  const f = await fixture();

  const callResult4 = await f.call("plan", f.plan, "max");

  try {
    assert.equal(callResult4.output.reason, "level-unapproved");
    assert.equal(f.launches.length, 0);
    const low = await f.call("plan", f.plan, "low");
    assert.equal(low.exit, 0);
    assert.equal(low.output.summary, "review skipped at low");
    assert.equal(fs.existsSync(path.join(f.directory, "round-1")), false);
    f.config(true);
    f.deps.liveness = {};
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
    f.deps.orchestrator = {
      platform: "codex",
      model: "native",
    } as typeof f.deps.orchestrator;
    const pending = await f.call();
    assert.equal(pending.exit, 4);
    assert.equal(pending.output.reason, "native-pending");
    assert.equal(f.launches.length, 0);

    const pendingSlots = narrow(
      pending.value,
      withFields({ pending: listOf(withFields({ replyPath: text })) })
    ).pending;

    assert.ok(pendingSlots.length > 0);
    assert.equal(
      fs.existsSync(path.join(f.directory, "round-1/pending.json")),
      false
    );

    for (const slot of pendingSlots) {
      fs.writeFileSync(slot.replyPath, CLEAN);
    }

    const callResult = await f.call();
    assert.equal(callResult.exit, 0);
    assert.equal(f.launches.length, 0);
  } finally {
    f.cleanup();
  }

  const failed = await fixture();

  try {
    failed.deps.orchestrator = null;
    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    failed.deps.delegate = () =>
      Promise.resolve({
        outcome: { status: "fail", cls: "config", detail: "Invalid launch" },
        invocations: [],
      });
    const result = await failed.call();
    assert.equal(result.exit, 2);
    assert.equal(result.output.reason, "review-failed");
    assert.equal(
      fs.existsSync(path.join(failed.directory, "round-1/findings.json")),
      false
    );
  } finally {
    failed.cleanup();
  }
});

test("review rounds reuse slots supersede generations and reject moving targets", async () => {
  const f = await fixture();

  try {
    let crash = true;
    f.deps.hook = (point) => {
      if (point === "fanout:after-slot" && crash) {
        crash = false;
        throw new Error("Interrupted");
      }
    };

    const callResult6 = await f.call();

    assert.equal(callResult6.exit, 2);
    const count = f.launches.length;
    delete f.deps.hook;
    const slots = path.join(f.directory, "round-1/gen-1/slots");
    fs.unlinkSync(path.join(slots, defined(fs.readdirSync(slots)[0])));
    const callResult7 = await f.call();

    assert.equal(callResult7.exit, 0);
    assert.equal(f.launches.length, count + 1);
  } finally {
    f.cleanup();
  }

  for (const moved of ["plan", "spec"]) {
    // oxlint-disable-next-line eslint/no-shadow, eslint/no-await-in-loop -- local fixture binding intentionally mirrors shared name; sequential awaits build and observe fixture state
    const f = await fixture();

    try {
      let edit = true;
      const specBefore = artifactHash("spec", fs.readFileSync(f.spec, "utf-8"));
      const { delegate } = f.deps;
      f.deps.delegate = async (...args) => {
        const value = await delegate(...args);

        if (edit) {
          edit = false;
          fs.appendFileSync(
            moved === "plan" ? f.plan : f.spec,
            "\n## Added\nMoved.\n"
          );
        }

        return value;
      };

      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const result = await f.call();
      assert.equal(result.output.reason, "target-moved");
      assert.equal(
        fs.existsSync(path.join(f.directory, "round-1/findings.json")),
        false
      );

      const gen1 = fs.readdirSync(
        path.join(f.directory, "round-1/gen-1/slots")
      );

      if (moved === "spec") {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await f.add("edit", {
          artifact: "spec",
          before: specBefore,
          after: artifactHash("spec", fs.readFileSync(f.spec, "utf-8")),
          class: "non-intent",
          affects: [],
          rationale: "Record the spec revision",
          diffRef: "test diff",
        });
      }

      const reviewedSource = fs.readFileSync(f.plan, "utf-8");
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const callResult8 = await f.call();

      assert.equal(callResult8.exit, 0);
      assert.equal(
        narrow(f.read(1, "round.json"), withFields({ generation: numeric }))
          .generation,
        2
      );

      if (moved === "spec") {
        assert.equal(
          narrow(
            f.read(1, "round.json"),
            withFields({ spec: withFields({ hash: text }) })
          ).spec.hash,
          artifactHash("spec", fs.readFileSync(f.spec, "utf-8"))
        );
      }

      assert.deepEqual(
        fs.readdirSync(path.join(f.directory, "round-1/gen-1/slots")),
        gen1
      );
      assert.equal(
        fs.readFileSync(
          path.join(f.directory, "round-1/target.snapshot.md"),
          "utf-8"
        ),
        reviewedSource
      );
      assert.ok(
        !fs
          .readdirSync(path.join(f.directory, "round-1"))
          .some((name) => name.startsWith("superseded-"))
      );
    } finally {
      f.cleanup();
    }
  }
});

test("review rounds code review prompt uses intent and raw task markdown and refuses a design-stage rebind", async () => {
  const f = await fixture();

  try {
    fs.writeFileSync(
      f.plan,
      `# Work
## Task Map
| ID | Title | Outcome | Prerequisites | Criteria |
| --- | --- | --- | --- | --- |
| T1 | First | Works | none | SC1 |
## Proposed Changes
### T1 — First
#### [NEW] src/first.ts
- Purpose: Keep captured work recoverable.
## Success Criteria
- [SC1] Works
  - Changes: src/first.ts
  - Check: \`node check\`
  - Evidence: check
## Verification Plan
### Automated Tests
- \`node check\`
`
    );
    await f.add("writer", {
      phase: "launched",
      task: "T1",
      path: ".state/worktrees/T1-1",
      base: {
        commit: "a".repeat(40),
        taskSection: `sha256:${"b".repeat(64)}`,
        seq: 1,
      },
    });
    await f.add("writer", {
      phase: "finished",
      task: "T1",
      launch: 1,
      candidate: "c".repeat(40),
    });
    f.deps.run = async () => {
      await Promise.resolve();

      return { exit: 0, stdout: "src/first.ts\0src/second.ts\0", stderr: "" };
    };

    f.deps.delegate = async (provider, request, mode) => {
      await Promise.resolve();
      f.launches.push({ provider, request, mode });

      // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
      const text = report(
        provider === "claude" ? "src/first.ts:L1" : "src/second.ts:L1"
      );

      return {
        outcome: { status: "ok", text, resume: null, sessionId: null },
        invocations: [],
      };
    };

    const result = await f.call("code", "T1");
    assert.equal(result.exit, 0);

    const prompt = fs.readFileSync(
      defined(f.launches[0]).request.promptPath,
      "utf-8"
    );

    const summary = defined(
      defined(prompt.split("- Task: ")[1]).split("\n- Spec Path:")[0]
    );

    assert.doesNotMatch(prompt, /absent or unfilled table/u);
    assert.match(prompt, /selected diff and tests/u);
    assert.match(
      prompt,
      /does not establish that verification commands ran or final gates passed/u
    );
    assert.equal(
      summary,
      "Keep captured work recoverable.\n\n### T1 — First\n#### [NEW] src/first.ts\n- Purpose: Keep captured work recoverable.\n\n- [SC1] Works\n  - Changes: src/first.ts\n  - Check: `node check`\n  - Evidence: check"
    );
    assert.doesNotMatch(summary, /sha256:/u);
    const resultPath = narrow(result.value, withFields({ path: text })).path;

    const findings = readJson(
      resultPath,
      withFields({ clusters: listOf(withFields({ file: text })) })
    );

    assert.deepEqual(
      findings.clusters.map((cluster) => cluster.file),
      ["src/first.ts", "src/second.ts"]
    );
    f.deps.delegate = async (provider, request, mode) => {
      await Promise.resolve();
      f.launches.push({ provider, request, mode });

      return provider === "agy"
        ? await Promise.resolve({
            outcome: { status: "fail", cls: "auth", detail: "No access" },
            invocations: [],
          })
        : await Promise.resolve({
            outcome: {
              status: "ok",
              text: CLEAN,
              resume: null,
              sessionId: null,
            },
            invocations: [],
          });
    };

    const callResult9 = await f.call();

    assert.equal(callResult9.exit, 0);
    assert.equal(
      narrow(
        f.read(1, "findings.json"),
        withFields({ failed: listOf(anything) })
      ).failed.length,
      1
    );
    f.artifact("strategy.design.md", "# Strategy\n");
    let rebind = true;
    f.deps.delegate = async () => {
      if (rebind) {
        rebind = false;
        await f.add("bind", {
          spec: "mission.spec.md",
          design: "strategy.design.md",
        });
      }

      return {
        outcome: { status: "ok", text: CLEAN, resume: null, sessionId: null },
        invocations: [],
      };
    };

    const moved = await f.call("code", "T1");
    assert.equal(moved.exit, 4);
    assert.equal(moved.output.reason, "lint-errors");
  } finally {
    f.cleanup();
  }
});

test("review voices receive prompts rotated by roster position", async () => {
  const f = await fixture();

  try {
    fs.writeFileSync(
      f.plan,
      `# Work
## Task Map
| ID | Title | Outcome | Prerequisites | Criteria |
| --- | --- | --- | --- | --- |
| T1 | First | Works | none | SC1 |
## Proposed Changes
### T1 — First
#### [NEW] src/first.ts
- Purpose: Keep captured work recoverable.
## Success Criteria
- [SC1] Works
  - Changes: src/first.ts
  - Check: \`node check\`
  - Evidence: check
## Verification Plan
### Automated Tests
- \`node check\`
`
    );
    await f.add("writer", {
      phase: "launched",
      task: "T1",
      path: ".state/worktrees/T1-1",
      base: {
        commit: "a".repeat(40),
        taskSection: `sha256:${"b".repeat(64)}`,
        seq: 1,
      },
    });
    await f.add("writer", {
      phase: "finished",
      task: "T1",
      launch: 1,
      candidate: "c".repeat(40),
    });
    f.deps.run = async () => {
      await Promise.resolve();

      return { exit: 0, stdout: "src/first.ts\0src/second.ts\0", stderr: "" };
    };

    f.deps.delegate = async (provider, request, mode) => {
      await Promise.resolve();
      f.launches.push({ provider, request, mode });

      return {
        outcome: { status: "ok", text: CLEAN, resume: null, sessionId: null },
        invocations: [],
      };
    };

    const callResult10 = await f.call("code", "T1");

    assert.equal(callResult10.exit, 0);
    assert.equal(f.launches.length, 2);

    const roundFile = path.resolve(
      path.dirname(defined(f.launches[0]).request.promptPath),
      "..",
      "..",
      "round.json"
    );

    const round = readJson(
      roundFile,
      withFields({
        roster: listOf(
          withFields({
            slot: text,
            provider: text,
            index: numeric,
            reserve: flag,
          })
        ),
      })
    );

    const targets = round.roster.filter((slot) => !slot.reserve);
    assert.equal(targets.length, 2);
    assert.deepEqual(
      targets.map((slot) => slot.index),
      [0, 0]
    );

    for (const [position, slot] of targets.entries()) {
      const launch = f.launches.find((item) => item.provider === slot.provider);
      assert.ok(launch, `missing launch for ${slot.provider}`);
      const prompt = fs.readFileSync(launch.request.promptPath, "utf-8");

      const tagsLines = defined(
        defined(prompt.split("### Tags\n")[1]).split("\n### ")[0]
      )
        .trim()
        .split("\n");

      assert.equal(
        tagsLines.length,
        1,
        `roster position ${position} (${slot.slot}): one Tags line`
      );
      const firstFamily = /^- \*\*(?<g1>[^*]+)\*\* —/mu.exec(prompt)?.[1];
      assert.equal(
        firstFamily,
        ["intent", "maintainability"][position],
        `roster position ${position} (${slot.slot})`
      );
    }
  } finally {
    f.cleanup();
  }
});

test("review rounds exclusive claim and late native replies stay isolated", async () => {
  const f = await fixture();

  try {
    let release!: () => void;
    let started!: () => void;

    // oxlint-disable-next-line promise/avoid-new -- deferred gate releases the delegate from the test driver
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });

    // oxlint-disable-next-line promise/avoid-new -- deferred gate releases the delegate from the test driver
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    f.deps.delegate = async () => {
      started();
      await held;

      return {
        outcome: { status: "ok", text: CLEAN, resume: null, sessionId: null },
        invocations: [],
      };
    };

    f.deps.isAlive = () => true;

    const first = main(
      [
        "review",
        "run",
        f.plan,
        "--kind",
        "plan",
        "--session",
        f.session,
        "--host",
        "opencode",
      ],
      {
        ...f.deps,
        stdout: () => {},
      }
    );

    assert.equal(
      await Promise.race([ready.then(() => true), first.then(() => false)]),
      true
    );
    const other = await f.call();
    assert.equal(other.exit, 3);
    assert.equal(other.output.reason, "lock-held");
    release();
    assert.equal(await first, 0);
  } finally {
    f.cleanup();
  }

  const n = await fixture();

  try {
    n.config(true);
    n.deps.liveness = {};
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
    n.deps.orchestrator = {
      platform: "codex",
      model: "native",
    } as typeof n.deps.orchestrator;
    const first = await n.call();

    const old = defined(
      narrow(
        first.value,
        withFields({ pending: listOf(withFields({ replyPath: text })) })
      ).pending[0]
    ).replyPath;

    fs.appendFileSync(n.plan, "\n## Added\nNew generation.\n");
    const second = await n.call();
    assert.equal(second.output.reason, "native-pending");
    fs.writeFileSync(old, CLEAN);
    const third = await n.call();
    assert.equal(third.output.reason, "native-pending");
    assert.equal(
      narrow(n.read(1, "round.json"), withFields({ generation: numeric }))
        .generation,
      2
    );
    assert.ok(
      narrow(
        third.value,
        withFields({ pending: listOf(withFields({ replyPath: text })) })
      ).pending.every((slot) => slot.replyPath.includes("gen-2"))
    );
  } finally {
    n.cleanup();
  }
});

const underfillFixture = async () => {
  const f = await fixture();
  fs.writeFileSync(
    path.join(f.deps.skillRoot, "config.jsonc"),
    JSON.stringify({
      "read-delegates": {
        codex: {
          nativeSubagentsOnly: true,
          targets: [{ low: { model: "native" } }],
        },
        agy: { targets: [{ low: { model: "fake" } }] },
        copilot: {
          nativeSubagentsOnly: true,
          targets: [{ low: { model: "other" } }],
        },
      },
      phases: {
        "plan-review": {
          targets: { low: 0, medium: 2 },
          rounds: { low: 0, medium: 2 },
        },
        "code-review": { targets: { low: 2 }, rounds: { low: 2 } },
      },
    })
  );
  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
  f.deps.orchestrator = {
    platform: "codex",
    model: "native",
  } as typeof f.deps.orchestrator;

  return f;
};

const underfilled = {
  host: "codex",
  configured: 2,
  resolved: 2,
  excluded: ["copilot"],
};

test("review native-pending and resumed final results report and retain underfill for excluded native-only providers", async () => {
  const f = await underfillFixture();

  try {
    const pending = await f.call();
    assert.equal(pending.exit, 4);
    assert.equal(pending.output.reason, "native-pending");
    assert.deepEqual(
      narrow(pending.value, withFields({ underfill: anything })).underfill,
      underfilled
    );
    assert.match(
      pending.output.summary,
      /; underfill 2\/2 targets, host codex, excluded native-only: copilot; first 1: launch: model native, no effort set$/u
    );

    fs.writeFileSync(
      path.join(f.deps.skillRoot, "config.jsonc"),
      JSON.stringify({
        "read-delegates": {
          codex: {
            nativeSubagentsOnly: true,
            targets: [{ low: { model: "native" } }],
          },
          agy: { targets: [{ low: { model: "fake" } }] },
        },
        phases: {
          "plan-review": {
            targets: { low: 0, medium: 2 },
            rounds: { low: 0, medium: 2 },
          },
          "code-review": { targets: { low: 2 }, rounds: { low: 2 } },
        },
      })
    );

    for (const slot of narrow(
      pending.value,
      withFields({ pending: listOf(withFields({ replyPath: text })) })
    ).pending) {
      fs.writeFileSync(slot.replyPath, CLEAN);
    }

    const done = await f.call();
    assert.equal(done.exit, 0);
    assert.deepEqual(
      narrow(done.value, withFields({ underfill: anything })).underfill,
      underfilled
    );
    assert.match(
      done.output.summary,
      /failed slots; .*underfill 2\/2 targets, host codex, excluded native-only: copilot, repository check unavailable: Unit tests must not spawn processes; first 1: R1-F\d{3} SHOULD/u
    );
  } finally {
    f.cleanup();
  }
});

test("review run summary lists first findings by severity", async () => {
  const f = await fixture();

  try {
    const rating = {
      MUST: { impact: "blocks", trigger: "realistic" },
      SHOULD: { impact: "degrades", trigger: "realistic" },
      CONSIDER: { impact: "minor", trigger: "contrived" },
    } as const;

    const finding = (severity: keyof typeof rating, i: number) => ({
      ...rating[severity],
      tag: "reliability",
      locus: `§ Work ${i}`,
      defect: `${severity} defect ${i}`,
      requiredChange: `Fix defect ${i}`,
    });

    const findings = [
      finding("CONSIDER", 1),
      finding("SHOULD", 2),
      finding("MUST", 3),
      finding("SHOULD", 4),
      finding("CONSIDER", 5),
      finding("SHOULD", 6),
      finding("MUST", 7),
    ];

    // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
    const text = JSON.stringify({ status: "FINDINGS", findings });
    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.delegate = () =>
      Promise.resolve({
        outcome: { status: "ok", text, resume: null, sessionId: null },
        invocations: [],
      });
    const first = await f.call();
    assert.equal(first.exit, 0, JSON.stringify(first));
    assert.match(
      first.output.summary,
      /round 1\/2: 2 MUST, 3 SHOULD, 2 CONSIDER, /u
    );

    const listed = [
      ...first.output.summary.matchAll(
        /R1-F\d{3} (?<g2>MUST|SHOULD|CONSIDER): /gu
      ),
    ].map((match) => match[1]);

    assert.deepEqual(listed, ["MUST", "MUST", "SHOULD", "SHOULD", "SHOULD"]);
    assert.match(first.output.summary, /; \+2 more in result$/u);
    assert.ok(Buffer.byteLength(first.output.summary, "utf-8") <= 1024);
  } finally {
    f.cleanup();
  }
});

test("review run reports native-pending for the recorded host when env carries no platform marker", async () => {
  const f = await fixture();

  try {
    fs.writeFileSync(
      path.join(f.deps.skillRoot, "config.jsonc"),
      JSON.stringify({
        "read-delegates": {
          copilot: {
            nativeSubagentsOnly: true,
            targets: [
              { low: { model: "native-a" } },
              { low: { model: "native-b" } },
            ],
          },
        },
        phases: {
          "plan-review": {
            targets: { low: 0, medium: 2 },
            rounds: { low: 0, medium: 2 },
          },
        },
      })
    );
    const manifestFile = path.join(f.session, "manifest.json");
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(manifestFile, "utf-8")),
        host: "copilot",
      })
    );
    f.deps.orchestrator = null;
    f.deps.env = {};
    const pending = await f.call();
    assert.equal(pending.exit, 4, JSON.stringify(pending.output));
    assert.equal(pending.output.reason, "native-pending");
    assert.equal(f.launches.length, 0);
    assert.deepEqual(
      narrow(
        pending.value,
        withFields({ pending: listOf(withFields({ slot: text })) })
      ).pending.map((slot) => slot.slot),
      ["copilot[0]", "copilot[1]"]
    );
  } finally {
    f.cleanup();
  }
});

test("review run forwards round 2 on repository-rerun with empty settled", async () => {
  const f = await fixture();

  try {
    f.deps.delegate = async (provider, request, mode) => {
      await Promise.resolve();
      f.launches.push({ provider, request, mode });

      return {
        outcome: { status: "ok", text: CLEAN, resume: null, sessionId: null },
        invocations: [],
      };
    };

    const first = await f.call();
    assert.equal(first.exit, 0, JSON.stringify(first.output));

    const firstPrompt = fs.readFileSync(
      defined(f.launches[0]).request.promptPath,
      "utf-8"
    );

    assert.doesNotMatch(firstPrompt, /On re-review,/u);
    assert.doesNotMatch(firstPrompt, /Settled in earlier rounds/u);
    const round1Dir = path.join(f.directory, "round-1/gen-1");
    fs.mkdirSync(round1Dir, { recursive: true });
    fs.writeFileSync(
      path.join(round1Dir, "checkout-report.json"),
      JSON.stringify({
        repositoryCheck: { state: "unavailable", reason: "test" },
        asOfSeq: 0,
      })
    );
    await appendRecord(
      f.session,
      {
        kind: "note",
        by: "user",
        quote: "Rerun after inspection",
        key: "repository-rerun:plan-work.plan:1:0",
        data: { text: "rerun" },
      },
      f.deps
    );
    const second = await f.call();
    assert.equal(second.exit, 0, JSON.stringify(second.output));
    assert.equal(narrow(second.value, withFields({ round: numeric })).round, 2);

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const round2 = JSON.parse(
      fs.readFileSync(path.join(f.directory, "round-2/round.json"), "utf-8")
    );

    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(round2.round, 2);
    // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.match(round2.scope, /^Full review/u);

    const secondPrompt = fs.readFileSync(
      defined(f.launches.at(-1)).request.promptPath,
      "utf-8"
    );

    assert.equal(secondPrompt.split("On re-review,").length - 1, 1);
  } finally {
    f.cleanup();
  }
});

test("findings file: completed review writes raw Markdown and a JSON template beside findings.json", async () => {
  const f = await fixture();

  try {
    const result = await f.call();
    assert.equal(result.exit, 0, result.output.summary);
    const round = ".state/reviews/plan-work.plan/round-1";

    const findingsFile = `${round}/findings.md`;
    const rulingsFile = `${round}/rulings.json`;

    const resultValue = narrow(
      result.value,
      withFields({ findingsFile: text, rulingsFile: text })
    );

    assert.equal(resultValue.findingsFile, findingsFile);
    assert.equal(resultValue.rulingsFile, rulingsFile);
    assert.ok(
      result.output.summary.includes(
        `; findings ${findingsFile}; rulings ${rulingsFile}`
      )
    );

    const markdown = fs.readFileSync(
      path.join(f.session, findingsFile),
      "utf-8"
    );

    assert.match(
      markdown,
      /^### R1-F001 SHOULD\n- Rating: degrades\/realistic; category reliability; scope in; origin original\n/u
    );
    assert.match(
      markdown,
      /\n- Defect: Concurrent writes overwrite captured results\n/u
    );
    assert.deepEqual(f.read(1, "rulings.json"), [
      {
        kind: "ruling",
        by: "orchestrator",
        key: "ruling:plan-work.plan:1:R1-F001",
        data: {
          subject: "review:plan-work.plan:R1-F001",
          ruling: "",
          rationale: "",
        },
      },
    ]);
  } finally {
    f.cleanup();
  }
});

test("findings file: an all-failed round publishes neither file", async () => {
  const f = await fixture();

  try {
    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.delegate = () =>
      Promise.resolve({
        outcome: { status: "fail", cls: "config", detail: "Invalid launch" },
        invocations: [],
      });
    const result = await f.call();
    assert.equal(result.output.reason, "review-failed");

    for (const file of ["findings.md", "rulings.json"]) {
      assert.equal(
        fs.existsSync(path.join(f.directory, "round-1", file)),
        false,
        file
      );
    }
  } finally {
    f.cleanup();
  }
});

test("findings file: long review IDs and trailing notices retain both paths in the capped summary", async () => {
  const f = await fixture(false);

  try {
    const planName = `${"a".repeat(245)}.plan`;
    const review = `plan-${planName}`;
    assert.equal(Buffer.byteLength(review), 255);
    const plan = f.artifact(`${planName}.md`, fs.readFileSync(f.plan, "utf-8"));
    f.artifact(`${planName}.context.md`, CONTEXT_MAP);
    await f.add("bind", { spec: "mission.spec.md", plan: `${planName}.md` });
    const directory = path.join(f.session, ".state", "reviews", review);

    for (let round = 1; round <= 3; round += 1) {
      // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
      f.deps.delegate = () =>
        Promise.resolve({
          outcome: {
            status: "ok",
            text: report("§ Work", `Defect ${round}`, "MUST"),
            resume: null,
            sessionId: null,
          },
          invocations: [],
        });
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const result = await f.call("plan", plan);
      assert.equal(result.exit, 0, result.output.summary);
      assert.match(result.output.summary, /1 MUST/u);

      const { findings } = readJson(
        narrow(result.value, withFields({ path: text })).path,
        withFields({ findings: listOf(withFields({ id: text })) })
      );

      assert.equal(findings.length, 1, result.output.summary);
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await f.add("ruling", {
        subject: `review:${review}:${defined(findings[0]).id}`,
        ruling: "accepted",
        rationale: "Fix the defect",
      });
      fs.appendFileSync(plan, `\n## New work ${round}\nChanged.\n`);
    }

    await f.add("ruling", {
      subject: `review:${review}:R4-F001`,
      ruling: "accepted",
      rationale: "Fix the defect",
    });
    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.delegate = (provider) =>
      Promise.resolve({
        outcome: {
          status: "ok",
          text:
            provider === "agy"
              ? JSON.stringify({
                  status: "BLOCKED",
                  reason: `Denied ${"x".repeat(170)}`,
                })
              : report("§ Work", "Defect four", "MUST"),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      });
    const pendingFile = path.join(directory, "round-4", "pending.json");
    f.deps.hook = (point) => {
      if (point === "review:after-pending") {
        throw new Error("Interrupted after writing pending findings");
      }
    };

    const callResult11 = await f.call("plan", plan);

    assert.equal(callResult11.exit, 2);
    delete f.deps.hook;

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const pending = JSON.parse(fs.readFileSync(pendingFile, "utf-8"));
    // eslint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-member-access -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    const first: Finding = pending.findings[0];
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    pending.findings = (["MUST", "SHOULD", "CONSIDER"] as const).flatMap(
      (severity, group) =>
        Array.from({ length: 100 }, (_, i) => ({
          ...first,
          severity,
          id: `R4-F${String(group * 100 + i + 1).padStart(3, "0")}`,
          ...(group === 0 && {
            locus: "unresolved-locus: missing",
            origin: "fix-induced",
            recurrence: { of: "R3-F001" },
          }),
        }))
    );
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    pending.failed = Array.from({ length: 100 }, (_, i) => ({
      slot: `agy[${i}]`,
      reason: "blocked",
    }));
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    pending.repositoryChanges = [
      {
        paths: Array.from(
          { length: 5 },
          (_, i) => `src/${"p".repeat(220)}${i}`
        ),
      },
    ];
    fs.writeFileSync(pendingFile, JSON.stringify(pending));

    const result = await f.call("plan", plan);
    assert.equal(result.exit, 0, result.output.summary);

    const resultValue = narrow(
      result.value,
      withFields({
        budget: withFields({ state: text }),
        blocked: listOf(anything),
        repositoryChanges: listOf(withFields({ paths: listOf(text) })),
      })
    );

    assert.equal(resultValue.budget.state, "requires-ceiling-resolution");
    assert.match(
      result.output.summary,
      /100 MUST, 100 SHOULD, 100 CONSIDER, 300 recurrences, .*100 failed slots, 100 unresolved loci, 100 fix-induced/u
    );
    assert.ok(resultValue.blocked.length);
    assert.equal(defined(resultValue.repositoryChanges[0]).paths.length, 5);
    assert.ok(Buffer.byteLength(result.output.summary) <= 1024);
    const round = `.state/reviews/${review}/round-4`;
    assert.ok(
      result.output.summary.includes(
        `; findings ${round}/findings.md; rulings ${round}/rulings.json;`
      )
    );
  } finally {
    f.cleanup();
  }
});
