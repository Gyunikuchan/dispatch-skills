import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { main } from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import {
  appendRecord,
  currentHashes,
  foldLedger,
  gate,
  latest,
} from "../../../skills/dispatch/scripts/toolkit/ledger.ts";
import { defined } from "../../helpers/guards.ts";
import type { JsonObject } from "./helpers/json.ts";
import { narrow, refusal } from "./helpers/json.ts";
import { sessionFixture } from "./helpers/session.ts";

test("design-stage bindings retain revisions and block plan-dependent effects until a complete rebind", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const skill = path.join(f.root, "skill");
    fs.mkdirSync(skill);
    fs.writeFileSync(
      path.join(skill, "config.jsonc"),
      JSON.stringify({
        diagnostics: false,
        "read-delegates": { codex: { targets: [{ low: { model: "fake" } }] } },
        phases: { "code-review": { targets: { low: 1 }, rounds: { low: 1 } } },
      })
    );
    f.deps.skillRoot = skill;

    let effects = 0;
    let key = 0;

    f.deps.run = async () => {
      await Promise.resolve();
      effects += 1;

      throw new Error("Design-only work must not run Git");
    };

    f.deps.delegate = async () => {
      await Promise.resolve();
      effects += 1;

      throw new Error("No delegate without a usable review target");
    };

    const add = async (
      kind: string,
      data: JsonObject,
      extra: JsonObject = {}
    ) =>
      await appendRecord(
        f.session,
        {
          kind,
          data,
          by: "orchestrator",
          key: `design-${(key += 1) - 1}`,
          ...extra,
        },
        f.deps
      );

    f.artifact("mission.spec.md", "# Mission\n");
    const design = f.artifact("strategy.design.md", "# Strategy\n");
    await add("bind", {
      spec: "mission.spec.md",
      design: "strategy.design.md",
    });
    await add("level", { level: "low" });

    const hashes = () =>
      currentHashes(f.root, latest(foldLedger(f.session), "bind"));

    await add(
      "confirm",
      { spec: hashes().spec },
      { by: "user", quote: "Approved the mission" }
    );
    const before = hashes().design;
    fs.appendFileSync(
      design,
      "\n## Approach\nPreserve independent increments.\n"
    );

    const edit = {
      kind: "edit",
      key: "design-revision",
      by: "orchestrator",
      data: {
        artifact: "design",
        before,
        after: hashes().design,
        class: "non-intent",
        affects: [],
        rationale: "Clarify strategy",
        diffRef: "design diff",
      },
    };

    const saved = await appendRecord(f.session, edit, f.deps);
    assert.deepEqual(await appendRecord(f.session, edit, f.deps), {
      ...saved,
      deduped: true,
    });
    assert.equal(hashes().plan, undefined);
    await assert.rejects(
      add("bind", { spec: "mission.spec.md", design: "missing.design.md" }),
      {
        reason: "invalid-record",
      }
    );

    const call = async (args: string[]) => {
      f.lines.length = 0;

      const hostSensitive =
        (args[0] === "doctor" && args[1] === "run") ||
        (args[0] === "review" && args[1] === "run") ||
        (args[0] === "ask" && args[1] === "run") ||
        (args[0] === "brief" &&
          (args[1] === "render" ||
            args[1] === "explorer" ||
            args[1] === "test-cleanup"));

      const withHost =
        hostSensitive && !args.includes("--host")
          ? [...args, "--host", "codex"]
          : args;

      const exit = await main([...withHost, "--session", f.session], f.deps);

      return { exit, output: f.output() };
    };

    for (const args of [
      ["worktree", "create", "T1"],
      ["brief", "render", "T1"],
      ["worktree", "integrate", "T1"],
      ["worktree", "commit", "--reason", "repair"],
      ["check", "run"],
      ["report", "render"],
      ["review", "run", "integration", "--kind", "code", "--level", "low"],
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const result = await call(args);
      assert.equal(result.exit, 4, args.join(" "));
      assert.equal(result.output.reason, "lint-errors", args.join(" "));
    }

    const callResult = await call(["worktree", "deliver"]);

    assert.equal(callResult.output.reason, "no-integration");
    const callResult2 = await call(["status", "show"]);

    assert.equal(callResult2.exit, 0);
    const git = "a".repeat(40);
    await add("integrate", {
      phase: "opened",
      path: ".state/worktrees/integration",
      branch: "dispatch/test/integration",
      base: git,
      dest: { branch: "main", path: f.root },
    });
    await add("integrate", { phase: "done", task: "T1", commit: git });
    await add("bind", {
      spec: "mission.spec.md",
      design: "strategy.design.md",
    });

    for (const args of [
      ["worktree", "commit", "--reason", "repair"],
      ["review", "run", "integration", "--kind", "code", "--level", "low"],
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const result = await call(args);
      assert.equal(result.output.reason, "lint-errors");
    }

    assert.equal(effects, 0);
    f.artifact("work.plan.md", "# Work\n");
    await add("bind", {
      spec: "mission.spec.md",
      plan: "work.plan.md",
      design: "strategy.design.md",
    });
    await add("approval", hashes(), {
      by: "user",
      quote: "Approve the complete tuple",
    });
    assert.equal(gate(foldLedger(f.session), hashes(), "medium").allowed, true);
    assert.equal(
      foldLedger(f.session).records.filter((row) => row.key === edit.key)
        .length,
      1
    );
  } finally {
    f.cleanup();
  }
});

test("approval survives formatting-only artifact rewrites and refuses meaning changes", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const names = {
      spec: "s.spec.md",
      plan: "p.plan.md",
      design: "d.design.md",
    } as const;

    const kinds = ["spec", "plan", "design"] as const;

    const plain = {
      spec: [
        "# Formatter Spec",
        "",
        "## Intent & Problem",
        "",
        "Keep _approved_ artifacts stable while **formatters** run.",
        "",
        "## Requirements",
        "",
        "### REQ-1 — Stable hash",
        "",
        "- Acceptance: formatting-only rewrites keep the gate allowed.",
        "",
      ].join("\n"),
      plan: [
        "# Formatter Plan",
        "",
        "## Task Map",
        "",
        "| ID | Title |",
        "| --- | --- |",
        "| T1 | Canonical form |",
        "",
        "## Tasks",
        "",
        "### T1 — Canonical form",
        "",
        "Run the checks before handoff.",
        "",
        "```text",
        "node --version",
        "```",
        "",
      ].join("\n"),
      design: [
        "# Formatter Design",
        "",
        "## Approach",
        "",
        "Hash canonical Markdown with one shared form.",
        "",
        "---",
        "",
        "## Architecture & Boundaries",
        "",
        "- lib owns the canonical form.",
        "",
      ].join("\n"),
    };

    const formatted = {
      spec: [
        "# Formatter Spec",
        "",
        "",
        "## Intent & Problem ##",
        "",
        "Keep *approved* artifacts stable while **formatters** run.  ",
        "",
        "",
        "## Requirements",
        "",
        "### REQ-1 — Stable hash",
        "",
        "- Acceptance: formatting-only rewrites keep the gate allowed.",
        "",
      ].join("\n"),
      plan: [
        "# Formatter Plan",
        "",
        "## Task Map",
        "",
        "|ID|Title|",
        "|---|---|",
        "|T1|Canonical form|",
        "",
        "## Tasks",
        "",
        "### T1 — Canonical form",
        "",
        "Run the checks before handoff.",
        "",
        "~~~~text",
        "node --version",
        "~~~~",
        "",
      ].join("\n"),
      design: [
        "# Formatter Design",
        "",
        "## Approach",
        "",
        "Hash canonical Markdown with one shared form.",
        "",
        "***",
        "",
        "## Architecture & Boundaries",
        "",
        "- lib owns the canonical form.",
        "",
      ].join("\n"),
    };

    const wordChanges = {
      spec: ["formatters", "editors"],
      plan: ["before handoff", "after handoff"],
      design: ["lib owns", "tool owns"],
    } as const;

    const verdict = () => {
      const fold = foldLedger(f.session);

      return gate(fold, currentHashes(f.root, latest(fold, "bind")));
    };

    for (const kind of kinds) {
      f.artifact(names[kind], plain[kind]);
    }

    const appendRecordResult = await appendRecord(
      f.session,
      { kind: "bind", key: "bind", by: "orchestrator", data: names },
      f.deps
    );

    assert.equal(appendRecordResult.seq > 0, true);

    const approved = currentHashes(
      f.root,
      latest(foldLedger(f.session), "bind")
    );

    await appendRecord(
      f.session,
      {
        kind: "confirm",
        key: "confirm",
        by: "user",
        quote: "yes",
        data: { spec: approved.spec },
      },
      f.deps
    );
    await appendRecord(
      f.session,
      {
        kind: "approval",
        key: "approval",
        by: "user",
        quote: "yes",
        data: approved,
      },
      f.deps
    );
    assert.deepEqual(verdict(), { allowed: true });

    for (const kind of kinds) {
      f.artifact(names[kind], formatted[kind]);
    }

    assert.deepEqual(
      currentHashes(f.root, latest(foldLedger(f.session), "bind")),
      approved
    );
    assert.deepEqual(verdict(), { allowed: true });

    for (const kind of kinds) {
      const [from, to] = wordChanges[kind];
      f.artifact(names[kind], formatted[kind].replace(from, to));
      assert.deepEqual(
        verdict(),
        kind === "spec"
          ? { allowed: false, reason: "missing-confirmation" }
          : { allowed: false, reason: "unrecorded-change", artifact: kind }
      );
      f.artifact(names[kind], formatted[kind]);
      assert.deepEqual(verdict(), { allowed: true });
    }
  } finally {
    f.cleanup();
  }
});

const boundPlan = async () => {
  const f = sessionFixture({ memory: true });
  let n = 0;

  const add = async (kind: string, data: JsonObject, extra: JsonObject = {}) =>
    await appendRecord(
      f.session,
      {
        kind,
        data,
        by: "orchestrator",
        key: `approval-chain-${(n += 1) - 1}`,
        ...extra,
      },
      f.deps
    );

  const hashes = () =>
    currentHashes(f.root, latest(foldLedger(f.session), "bind"));

  const edit = async (
    before: string,
    after: string,
    editClass = "non-intent"
  ) =>
    await add("edit", {
      artifact: "plan",
      before,
      after,
      class: editClass,
      affects: [],
      rationale: "Record the plan edit",
      diffRef: "test diff",
    });

  const approve = async (data: JsonObject) =>
    await add("approval", data, {
      by: "user",
      quote: "I approve the plan I reviewed",
    });

  f.artifact("s.spec.md", "Spec");
  f.artifact("p.plan.md", "A");
  await add("bind", { spec: "s.spec.md", plan: "p.plan.md" });
  await add(
    "confirm",
    { spec: hashes().spec },
    { by: "user", quote: "I confirm the spec" }
  );

  return { f, hashes, edit, approve };
};

const assertStale = async (
  append: () => Promise<{ seq: number }>,
  current: ReturnType<typeof currentHashes>
) => {
  await assert.rejects(append(), (error: unknown) => {
    const failure = narrow(error, refusal);
    assert.equal(failure.reason, "approval-stale");

    for (const [artifact, hash] of Object.entries(current)) {
      assert.ok(
        failure.message?.includes(`current: ${artifact} ${hash}`) === true,
        failure.message
      );
    }

    return true;
  });
};

const scenario = async (
  exercise: (context: Awaited<ReturnType<typeof boundPlan>>) => Promise<void>
) => {
  const context = await boundPlan();

  try {
    await exercise(context);
  } finally {
    context.f.cleanup();
  }
};

test("approval accepts a recorded non-intent chain and stale approvals list current hashes", async () => {
  await scenario(async ({ f, hashes, edit, approve }) => {
    const approved = hashes();
    f.artifact("p.plan.md", "B");
    const afterEdit = hashes();
    await edit(defined(approved.plan), defined(afterEdit.plan));
    await approve(approved);
    assert.deepEqual(gate(foldLedger(f.session), hashes()), { allowed: true });

    f.artifact("p.plan.md", "D");
    const afterPostApprovalEdit = hashes();
    await edit(defined(afterEdit.plan), defined(afterPostApprovalEdit.plan));
    assert.deepEqual(gate(foldLedger(f.session), hashes()), { allowed: true });
    f.artifact("p.plan.md", "unrecorded");
    assert.deepEqual(gate(foldLedger(f.session), hashes()), {
      allowed: false,
      reason: "unrecorded-change",
      artifact: "plan",
    });
  });

  await scenario(async ({ f, hashes, edit, approve }) => {
    const approved = hashes();
    f.artifact("p.plan.md", "B");
    const changed = hashes();
    await edit(defined(approved.plan), defined(changed.plan), "intent");
    f.artifact("p.plan.md", "A");
    const reverted = hashes();
    await edit(defined(changed.plan), defined(reverted.plan));
    await approve(approved);
    assert.deepEqual(gate(foldLedger(f.session), hashes()), { allowed: true });
  });

  await scenario(async ({ f, hashes, edit, approve }) => {
    const originallySeen = hashes();
    f.artifact("p.plan.md", "B");
    const recorded = hashes();
    await edit(defined(originallySeen.plan), defined(recorded.plan));
    f.artifact("p.plan.md", "C");
    const current = hashes();
    await approve(current);
    assert.deepEqual(gate(foldLedger(f.session), hashes()), { allowed: true });
  });

  await scenario(async ({ f, hashes, edit, approve }) => {
    const approvedA = hashes();
    f.artifact("p.plan.md", "C");
    const hashC = defined(hashes().plan);
    f.artifact("p.plan.md", "A");
    const hashA = defined(hashes().plan);
    await edit(hashC, hashA);
    f.artifact("p.plan.md", "B");
    const hashB = defined(hashes().plan);
    await edit(hashA, hashB);
    f.artifact("p.plan.md", "C");
    const current = hashes();
    await edit(hashB, defined(current.plan));
    await approve(approvedA);
    assert.deepEqual(gate(foldLedger(f.session), hashes()), { allowed: true });
  });

  await scenario(async ({ f, hashes, edit, approve }) => {
    const approved = hashes();
    f.artifact("p.plan.md", "B");
    const current = hashes();
    await edit(defined(approved.plan), defined(current.plan), "intent");
    await assertStale(async () => await approve(approved), hashes());
  });

  await scenario(async ({ f, hashes, edit, approve }) => {
    const approved = hashes();
    f.artifact("p.plan.md", "B");
    const hashB = defined(hashes().plan);
    await edit(defined(approved.plan), hashB);
    f.artifact("p.plan.md", "unrelated");
    const unrelated = defined(hashes().plan);
    f.artifact("p.plan.md", "C");
    const current = hashes();
    await edit(unrelated, defined(current.plan));
    await assertStale(async () => await approve(approved), current);
  });
});

test("integrate verification records validate outcomes and cycle identity", async () => {
  const f = sessionFixture({ memory: true });

  try {
    let n = 0;

    const add = async (kind: string, data: JsonObject) =>
      await appendRecord(
        f.session,
        { kind, data, by: "orchestrator", key: `verification-${(n += 1) - 1}` },
        f.deps
      );

    const valid = {
      phase: "verification",
      cycle: 1,
      outcome: "proved",
      head: "a".repeat(40),
      reason: "exercised",
      open: [],
      report: "verification/report.md",
    };

    await add("integrate", valid);

    for (const change of [
      { outcome: "bad" },
      { head: "bad" },
      { open: undefined },
      { report: "/absolute" },
      { open: ["1:V1"] },
      { report: undefined },
      { open: ["bad"] },
      { cycle: undefined },
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await assert.rejects(add("integrate", { ...valid, ...change }), {
        reason: "invalid-record",
      });
    }

    await assert.rejects(
      add("integrate", { ...valid, outcome: "no-op", open: ["1:V1"] }),
      {
        reason: "invalid-record",
      }
    );
    await assert.rejects(
      add("integrate", { ...valid, outcome: "partial", report: undefined }),
      {
        reason: "invalid-record",
      }
    );

    for (const cycle of [1, 2]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await add("ruling", {
        subject: `verification:${cycle}:V1`,
        ruling: "accepted",
        rationale: "valid",
      });
    }

    await assert.rejects(
      add("ruling", {
        subject: "verification:1:V1",
        ruling: "unknown",
        rationale: "invalid",
      }),
      {
        reason: "invalid-record",
      }
    );
  } finally {
    f.cleanup();
  }
});
