import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { resolvePricing } from "../../../skills/dispatch/scripts/lib/pricing.ts";
import { readManifest } from "../../../skills/dispatch/scripts/lib/session.ts";
import { readDelegateSession } from "../../../skills/dispatch/scripts/lib/usage/delegate.ts";
import { readHostUsage } from "../../../skills/dispatch/scripts/lib/usage/index.ts";
import { main } from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import {
  optionalDiagnostics,
  sessionFacts,
  writeDiagnostics,
} from "../../../skills/dispatch/scripts/toolkit/diagnostics.ts";
import {
  renderDiagnostics,
  unitsOf,
} from "../../../skills/dispatch/scripts/toolkit/domain/diagnostics-render.ts";
import {
  normalizeUsage,
  sanitizeFacts,
} from "../../../skills/dispatch/scripts/toolkit/domain/diagnostics.ts";
import { stableValue } from "../../../skills/dispatch/scripts/toolkit/domain/stable-value.ts";
import type { RoundCausePrimary } from "../../../skills/dispatch/scripts/toolkit/domain/types.ts";
import {
  checks,
  loadPlan,
} from "../../../skills/dispatch/scripts/toolkit/plan-view.ts";
import { defined } from "../../helpers/guards.ts";
import { lines, memoryFs, query } from "../lib/usage/helpers/memory-fs.ts";
import { fakeGit } from "./helpers/fake-git.ts";
import type { FakeGitState } from "./helpers/fake-git.ts";
import {
  flag,
  nullable,
  optional,
  parseJson,
  readJson,
  withFields,
  text,
} from "./helpers/json.ts";
import type { JsonObject } from "./helpers/json.ts";
import { sessionFixture } from "./helpers/session.ts";

const copilotCalls = (model: string) => {
  // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
  const fs = memoryFs({
    "/home/.copilot/session-state/host/events.jsonl": lines(
      {
        type: "subagent.started",
        agentId: "child",
        data: { toolCallId: "child-call" },
      },
      ...[undefined, "child"].map((agentId, sequence) => ({
        type: "session.usage_record",
        timestamp: new Date(1000 + sequence).toISOString(),
        agentId,
        data: {
          usage: {
            accounting: {
              sourceSessionId: "source",
              sequence,
              usageId: `receipt-${sequence}`,
            },
            model,
            reasoningEffort: "high",
            inputTokens: 100,
            outputTokens: 20,
            copilotUsage: { totalNanoAiu: 200 },
            cost: 1,
            aiCreditsStatus: "complete",
          },
        },
      }))
    ),
  });

  const hostUsage = readHostUsage(
    "copilot",
    { ...query, env: () => "host" },
    fs
  );

  const read = readDelegateSession({
    ...query,
    platform: "copilot",
    fs,
    resumed: false,
    collectResponses: true,
  });

  assert.ok(read.usage);
  assert.ok(read.usage.actualModels);
  assert.ok(read.responses);

  const invocation = {
    phase: "implementation",
    provider: "copilot",
    model,
    surface: "cli" as const,
    launched: true,
    outcome: "ok",
    usageSource: "session" as const,
    usage: defined(normalizeUsage(read.usage, "uncached")),
    reportedModels: read.usage.actualModels,
    responses: read.responses.map((r, i) => ({
      ...r,
      stage: "implementation" as const,
      agent: `delegate-${r.role === "subagent" ? "child-" : ""}${String(i + 1).padStart(16, "0")}`,
    })),
  };

  return { hostUsage, invocation };
};

test("Copilot qualified models survive public collection gates rendering and exact rates", () => {
  const model = "11111111-1111-1111-1111-111111111111/bedrock.claude-haiku-5-5";
  const { hostUsage, invocation } = copilotCalls(model);
  const rates = { [model]: { rates: { input: 1_000_000, output: 2_000_000 } } };

  const facts = sanitizeFacts({
    phases: [],
    reviews: [],
    invocations: [invocation],
    hostUsage,
    config: { pricing: rates },
  });

  assert.equal(facts.hostUsage?.rows[0]?.model, model);
  assert.deepEqual(facts.invocations[0]?.reportedModels, [model]);
  assert.ok(
    facts.invocations[0]?.usage?.actors?.every((a) => a.model === model) ===
      true
  );
  assert.ok(
    Object.keys(facts.invocations[0]?.usage?.models ?? {}).every(
      (key) => key === `${model}#high`
    )
  );
  assert.deepEqual(facts.config?.["pricing"], rates);

  const pricer = resolvePricing(
    { asOf: "2026-11-24", source: [], models: {} },
    facts.config?.["pricing"]
  );

  assert.ok(pricer);
  assert.ok(
    unitsOf(facts, pricer).every(
      (u) => u.cost?.high === 140 && u.cost.rateBasis?.match === "qualified"
    )
  );
  assert.match(renderDiagnostics([facts], pricer).text, new RegExp(model, "u"));

  for (const bad of [
    "11111111-1111-1111-1111-111111111111",
    "11111111-1111-1111-1111-111111111111/",
    `${model}/11111111-1111-1111-1111-111111111111`,
    "/home/private",
    "https://host.test/model",
    "private@example.com",
  ]) {
    const rejected = sanitizeFacts({
      phases: [],
      reviews: [],
      invocations: [
        {
          phase: "implementation",
          provider: "copilot",
          model: bad,
          surface: "cli",
          launched: true,
          outcome: "ok",
          reportedModels: [bad],
        },
      ],
    });

    assert.equal(rejected.invocations[0]?.model, "—");
    assert.equal(rejected.invocations[0]?.reportedModels, undefined);
  }
});

test("Copilot child receipt turns are not supplemented twice in summary role or stage", () => {
  const { invocation } = copilotCalls("custom/model");

  // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
  const { text } = renderDiagnostics([
    {
      phases: [{ key: "implementation", name: "implementation" }],
      reviews: [],
      invocations: [invocation],
    },
  ]);

  assert.match(text, /- Turns: User — · LLM 2 \(partial\)/u);

  const cells = (label: string) =>
    defined(text.split("\n").find((line) => line.startsWith(`| ${label} |`)))
      .split("|")
      .map((v) => v.trim());

  assert.equal(cells("Subagents")[7], "1");
  assert.equal(cells("CLI delegates")[7], "1");
  assert.equal(cells("implementation")[7], "2");
});

test("Copilot accounting detail folds before the report cap with closed markup and exact rollups", () => {
  const { hostUsage } = copilotCalls(`model-${"x".repeat(88)}`);
  hostUsage.rows = Array.from({ length: 900 }, (_, i) => ({
    ...defined(hostUsage.rows[1]),
    phase: `phase-${i}`,
    input: 1,
    output: 1,
    turns: 1,
  }));

  for (const crowded of [false, true]) {
    const phases = crowded
      ? Array.from({ length: 1000 }, (_, i) => ({
          key: `phase-${i}-${"x".repeat(110)}`,
          name: "implementation",
        }))
      : [];

    // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
    const { text } = renderDiagnostics([
      { phases, reviews: [], invocations: [], hostUsage },
    ]);

    assert.ok(Buffer.byteLength(text) <= 131_072);
    assert.equal(
      (text.match(/<details>/gu) ?? []).length,
      (text.match(/<\/details>/gu) ?? []).length
    );
    assert.doesNotMatch(text, /Truncated at the report size limit/u);
    assert.equal(text.trim().endsWith("</details>"), true);
    assert.match(text, /\| Subagents \|[^\n]*\| 1,800 \|/u);

    const note = defined(
      text
        .split("\n")
        .find((line) => line.startsWith("Detail coverage partial:"))
    );

    assert.match(
      note,
      new RegExp(
        `Detail coverage partial: ${crowded ? 900 : 868} accounting rows omitted`,
        "u"
      )
    );
    assert.match(note, /868 beyond the 32-row detail cap/u);

    if (crowded) {
      assert.match(
        note,
        /32 additional rows omitted at the report size limit/u
      );
    } else {
      assert.doesNotMatch(note, /report size limit/u);
    }
  }
});

test("Copilot reports separate billing coverage from USD estimates", () => {
  // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
  const { text } = renderDiagnostics([
    {
      phases: [],
      reviews: [],
      invocations: [
        {
          phase: "implementation",
          provider: "copilot",
          model: "custom/model",
          surface: "cli",
          launched: true,
          outcome: "ok",
          configuredEffort: "high",
          usage: {
            input: 70,
            output: 40,
            copilot: {
              tokenCoverage: "complete",
              lineageCoverage: "unknown",
              actorCoverage: "complete",
              billing: {
                coverage: "partial",
                totalNanoAiu: 200,
                statuses: ["pending"],
                multipliers: [2],
              },
            },
          },
        },
        {
          phase: "implementation",
          provider: "copilot",
          model: "custom/model",
          surface: "native",
          launched: false,
          outcome: "ok",
          effort: "max",
        },
      ],
    },
  ]);

  assert.match(text, /nano-AI units/u);
  assert.match(text, /200/u);
  assert.match(text, /partial/u);
  assert.match(text, /Configured effort/u);
  assert.match(text, /USD estimate/u);
});

const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
};

const captureRuns = (session: string, invocations: unknown[]) => {
  writeJson(path.join(session, ".state", "diagnostics", "run-1.json"), {
    capture: { state: "completed", start: 0, end: 1 },
    phases: [],
    invocations,
    reviews: [],
  });
};

const hostTest_HEAD = "a".repeat(40);
const hostTest_TREE = "b".repeat(40);

const hostTest_planSource = () =>
  [
    "# Report fixture",
    "",
    "## Task Map",
    "| ID | Title | Outcome | Prerequisites | Criteria |",
    "| --- | --- | --- | --- | --- |",
    "| T1 | Task 1 | Works | none | SC1 |",
    "",
    "## Proposed Changes",
    "",
    "### T1 — Task 1",
    "#### [NEW] src/task-1.ts",
    "- Purpose: implements the fixture behavior.",
    "",
    "## Success Criteria",
    "- [SC1] Criterion works",
    "  - Changes: src/task-1.ts",
    "  - Check: `node verify-1.js`",
    "  - Evidence: check",
    "",
    "## Verification Plan",
    "### Automated Tests",
    "- `node verify-1.js`",
    "- `node contract-check.js`",
    "",
  ].join("\n");

let hostTest_eventNumber = 0;

async function hostTest_append(
  f: ReturnType<typeof sessionFixture>,
  record: JsonObject
) {
  const file = f.artifact(
    `event-${(hostTest_eventNumber += 1)}.json`,
    JSON.stringify(record)
  );

  const result = await hostTest_invoke(f, "ledger", "append", file);
  assert.equal(result.exit, 0, result.output.summary);

  return result.output;
}

const hostTest_fixture = async () => {
  const f = sessionFixture({ memory: true });
  const skillRoot = path.join(f.root, "isolated-skill");
  fs.mkdirSync(skillRoot);
  fs.writeFileSync(
    path.join(skillRoot, "config.local.jsonc"),
    '{"diagnostics": false}\n'
  );
  f.deps.skillRoot = skillRoot;
  f.artifact("brief.spec.md", "# Brief\n");
  f.artifact("report.plan.md", hostTest_planSource());
  await hostTest_append(f, {
    kind: "bind",
    by: "tool",
    key: `bind:${(hostTest_eventNumber += 1)}`,
    data: { spec: "brief.spec.md", plan: "report.plan.md" },
  });

  return { ...f, skillRoot };
};

const hostTest_invoke = async (
  f: ReturnType<typeof sessionFixture>,
  tool: string,
  action: string,
  ...args: string[]
) => {
  f.lines.splice(0);

  const exit = await main(
    [tool, action, ...args, "--session", f.session],
    f.deps
  );

  assert.equal(f.lines.length, 1);

  return {
    exit,
    output: parseJson(
      defined(f.lines[0]),
      withFields({
        ok: flag,
        reason: optional(text),
        summary: text,
        path: nullable(text),
      })
    ),
  };
};

const hostTest_integrate = async (
  f: ReturnType<typeof sessionFixture>,
  state: FakeGitState,
  dest?: { path: string; branch: string }
) => {
  const target = dest ?? { path: f.root, branch: "main" };
  const worktree = path.join(f.session, ".state", "worktrees", "integration");
  fs.mkdirSync(worktree, { recursive: true });
  state.session = f.session;
  f.deps.run = fakeGit(state);
  await hostTest_append(f, {
    kind: "integrate",
    by: "tool",
    key: `integrate:opened:${(hostTest_eventNumber += 1)}`,
    data: {
      phase: "opened",
      path: ".state/worktrees/integration",
      branch: "dispatch/test/integration",
      base: "f".repeat(40),
      dest: target,
    },
  });

  return worktree;
};

const hostTest_evidence = async (
  f: ReturnType<typeof sessionFixture>,
  criterion: string,
  commandDigest: string,
  tree: string
) => {
  const data = {
    criterion,
    commandDigest,
    tree,
    clean: true,
    before: tree,
    after: tree,
    exit: 0,
  };

  const digest = crypto
    .createHash("sha256")
    .update(stableValue(data))
    .digest("hex");

  const evidencePath = `.state/evidence/${digest}.json`;
  const evidenceFile = path.join(f.session, evidencePath);
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  fs.writeFileSync(evidenceFile, JSON.stringify(data));
  await hostTest_append(f, {
    kind: "evidence",
    by: "tool",
    key: `evidence:${digest}`,
    data: { ...data, path: evidencePath },
  });

  return evidencePath;
};

const hostTest_evidenceForPlan = async (
  f: ReturnType<typeof sessionFixture>,
  tree: string,
  criteria?: string[]
) => {
  const plan = loadPlan(f.session, readManifest(f.session));

  const rows = checks(plan).filter(
    (check) => !criteria || criteria.includes(check.criterion)
  );

  const paths = new Map<string, string>();

  for (const row of rows) {
    paths.set(
      row.criterion,
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await hostTest_evidence(f, row.criterion, row.commandDigest, tree)
    );
  }

  return paths;
};

const hostTest_gitState = (
  session: string,
  head = hostTest_HEAD,
  tree = hostTest_TREE,
  testedTree = tree
) => ({ session, head, tree, testedTree, changes: [], calls: [] });

const hostTest_deliver = async (
  f: ReturnType<typeof sessionFixture>,
  head: string,
  dest?: { path: string; branch: string }
) => {
  const target = dest ?? { path: f.root, branch: "main" };
  await hostTest_append(f, {
    kind: "integrate",
    by: "tool",
    key: `integrate:delivered:${(hostTest_eventNumber += 1)}`,
    data: {
      phase: "delivered",
      mode: "uncommitted",
      dest: target,
      from: head,
      source: head,
    },
  });
};

// oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
const stageRow = (text: string) =>
  defined(
    defined(text.split("### Tokens by stage")[1])
      .split("\n")
      .find((line) =>
        line.startsWith("| — | claude | delegate | claude-sonnet-5-5")
      )
  );

test("diagnostics render honors the enabled toggle across render, cost, failure and retro paths", async (t) => {
  // diagnostics render writes the session report when enabled and reports off when disabled
  {
    const f = sessionFixture({ memory: true });

    try {
      const skill = path.join(f.root, "skill");
      fs.mkdirSync(skill);
      f.deps.skillRoot = skill;
      writeJson(path.join(skill, "config.jsonc"), { diagnostics: false });
      assert.equal(
        await main(["diagnostics", "render", "--session", f.session], f.deps),
        0
      );
      assert.deepEqual(
        [f.output().ok, f.output().summary],
        [true, "diagnostics off"]
      );
      assert.equal(
        fs.existsSync(path.join(f.session, "diagnostics.md")),
        false
      );

      writeJson(path.join(skill, "config.jsonc"), { diagnostics: true });
      f.lines.length = 0;
      assert.equal(
        await main(["diagnostics", "render", "--session", f.session], f.deps),
        0
      );
      const output = f.output();
      assert.equal(output.ok, true);
      assert.deepEqual(
        f.launches,
        [],
        "rendering diagnostics does not invoke an inference delegate"
      );
      // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
      const result = JSON.parse(fs.readFileSync(defined(output.path), "utf-8"));
      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      assert.equal(result.path, path.join(f.session, "diagnostics.md"));
      //oxlint-disable-next-line eslint/no-shadow, typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- local fixture binding intentionally mirrors shared name; test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      const text = fs.readFileSync(result.path, "utf-8");
      assert.match(text, /### Spend & Turns by Role/u);
      assert.match(
        text,
        /^\| Host \| — \| — \| — \| — \| — \| — \| — \| host usage unavailable/mu
      );
      assert.match(
        text,
        /^\| CLI delegates \| — \| — \| — \| — \| — \| — \| — \| no recorded launches/mu
      );
      assert.equal(
        fs.existsSync(path.join(f.session, ".state", "diagnostics")),
        false,
        "render is not captured as a tool observation"
      );

      writeJson(path.join(skill, "references", "pricing.json"), {
        asOf: "2026-11-19",
        source: ["https://example.test/pricing"],
        models: {
          alpha: { rates: { input: 1, output: 1 } },
          "actual/alpha": { rates: { input: 3, output: 3 } },
        },
      });
      captureRuns(f.session, [
        {
          phase: "plan-review",
          provider: "opencode",
          model: "configured/alpha",
          surface: "cli",
          launched: true,
          outcome: "ok",
          reportedModels: ["actual/alpha"],
          usageSource: "stdout",
          coverage: ["transcript unavailable"],
          usage: { input: 1_000_000, output: 0 },
        },
      ]);
      f.lines.length = 0;
      assert.equal(
        await main(["diagnostics", "render", "--session", f.session], f.deps),
        0
      );
      // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      const priced = fs.readFileSync(result.path, "utf-8");
      assert.match(
        priced,
        /^\| CLI delegates \| ██████████ 100% \| ~\$3\.00 \| 1,000,000 \| — \| — \| — \| — \| 1 stdout fallback, transcript unavailable \|$/mu
      );
      assert.match(priced, /1 qualified, 0 wildcard, 0 generic/u);
    } finally {
      f.cleanup();
    }
  }

  // cost cells render from the skill rate table and fall back to not estimated without a host or table
  {
    const f = sessionFixture({ memory: true });

    try {
      captureRuns(f.session, [
        {
          phase: "plan-review",
          attempt: 1,
          provider: "claude",
          model: "claude-sonnet-5-5",
          effort: "high",
          mode: "cli",
          surface: "cli",
          launched: true,
          outcome: "ok",
          usage: { input: 1_000_000, output: 0 },
        },
      ]);
      const fold = { records: [], lastSeq: 0, torn: null };
      const skill = path.join(f.root, "skill");
      fs.mkdirSync(skill);
      f.deps.skillRoot = skill;
      const host = { manifest: readManifest(f.session), deps: f.deps };

      const render = (withHost: boolean) =>
        fs.readFileSync(
          defined(
            optionalDiagnostics(
              f.session,
              fold,
              "complete",
              withHost ? host : undefined
            )
          ),
          "utf-8"
        );

      const table = path.join(skill, "references", "pricing.json");

      const shipped = fs.readFileSync(
        new URL(
          "../../../skills/dispatch/references/pricing.json",
          import.meta.url
        ),
        "utf-8"
      );

      assert.match(
        render(true),
        /^- Estimated cost not estimated \(rate table unavailable\)/mu,
        "missing table"
      );
      assert.ok(stageRow(render(true)).endsWith("| 1/1 | — | — |"));
      fs.mkdirSync(path.dirname(table), { recursive: true });
      fs.writeFileSync(table, "{ not json");
      assert.match(render(true), /not estimated/u, "unreadable table");
      fs.writeFileSync(table, shipped);
      assert.match(render(false), /not estimated/u, "no host");
      // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
      const text = render(true);
      assert.match(
        text,
        /^- Estimated cost ~\$2\.00 \(partial\) · priced 1 · unpriced 0/mu
      );
      assert.ok(
        stageRow(text).endsWith("| 1/1 | — | ~$2.00 |"),
        stageRow(text)
      );
      assert.match(
        text,
        /^\| CLI delegates \| ██████████ 100% \| ~\$2\.00 \| 1,000,000 \| — \| — \| — \| — \| 1 legacy source unknown \|$/mu
      );
      assert.match(text, /table 2026-11-28 · UTC day .*1 shipped, 0 override/u);

      writeJson(path.join(skill, "config.local.jsonc"), {
        pricing: {
          "claude-sonnet-5-5": { rates: { input: 1, output: 1 } },
          bad: "x",
        },
      });
      assert.match(
        render(true),
        /^- Estimated cost ~\$1\.00/mu,
        "override replaces the shipped rate and a malformed entry is ignored"
      );
    } finally {
      f.cleanup();
    }
  }

  // diagnostics render keeps an older report when the write fails
  {
    const f = sessionFixture({ memory: true });

    try {
      const skill = path.join(f.root, "skill");
      fs.mkdirSync(skill);
      writeJson(path.join(skill, "config.jsonc"), { diagnostics: true });
      f.deps.skillRoot = skill;
      const file = path.join(f.session, "diagnostics.md");
      fs.writeFileSync(file, "older report\n");
      const rename = fs.renameSync;
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
      t.mock.method(fs, "renameSync", ((from: fs.PathLike, to: fs.PathLike) => {
        if (String(to) === file) {
          throw new Error("rename failure");
        }

        rename(from, to);
      }) as typeof fs.renameSync);
      assert.equal(
        await main(["diagnostics", "render", "--session", f.session], f.deps),
        4
      );
      const output = f.output();
      assert.equal(output.reason, "diagnostics-failed");
      assert.equal(
        output.summary,
        "diagnostics render failed; existing diagnostics.md unchanged"
      );
      assert.equal(
        // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
        JSON.parse(fs.readFileSync(defined(output.path), "utf-8")).path ?? null,
        null
      );
      assert.equal(fs.readFileSync(file, "utf-8"), "older report\n");
    } finally {
      t.mock.restoreAll();
      f.cleanup();
    }
  }

  // diagnostics render reads host usage only while enabled
  {
    const f = sessionFixture({ memory: true });

    try {
      const skill = path.join(f.root, "skill");
      fs.mkdirSync(skill);
      const config = path.join(skill, "config.local.jsonc");
      f.deps.skillRoot = skill;
      const manifestPath = path.join(f.session, "manifest.json");
      // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      manifest.createdAt = new Date(1000).toISOString();
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      f.deps.orchestrator = { platform: "claude", model: null };
      f.deps.env = { CLAUDE_CODE_SESSION_ID: "thread" };
      f.deps.clock = () => 2000;

      const line = Buffer.from(
        [
          JSON.stringify({
            type: "assistant",
            timestamp: new Date(500).toISOString(),
            message: {
              id: "old",
              model: "m",
              usage: { input_tokens: 99, output_tokens: 3 },
            },
          }),
          JSON.stringify({
            type: "assistant",
            timestamp: new Date(1500).toISOString(),
            message: {
              id: "one",
              model: "m",
              usage: { input_tokens: 12, output_tokens: 3 },
              text: "secret transcript",
            },
          }),
          JSON.stringify({
            type: "assistant",
            timestamp: new Date(2500).toISOString(),
            message: {
              id: "late",
              model: "m",
              usage: { input_tokens: 99, output_tokens: 3 },
            },
          }),
        ].join("\n")
      );

      let reads = 0;
      f.deps.hostUsageFs = {
        list: (dir) => (dir.endsWith("projects") ? ["project"] : []),
        stat: () => ({ size: line.length, mtimeMs: 2000 }),
        read: () => {
          reads += 1;

          return line;
        },
        decompress: null,
      };
      fs.writeFileSync(config, '{"diagnostics":false}');
      assert.equal(
        await main(["diagnostics", "render", "--session", f.session], f.deps),
        0
      );
      assert.equal(reads, 0);
      f.lines.splice(0);
      fs.writeFileSync(config, '{"diagnostics":true}');
      assert.equal(
        await main(["diagnostics", "render", "--session", f.session], f.deps),
        0
      );

      const rendered = fs.readFileSync(
        path.join(f.session, "diagnostics.md"),
        "utf-8"
      );

      assert.equal(reads, 1);
      assert.match(rendered, /\| claude \| 12 \|/u);
      assert.match(
        rendered,
        /^\| spec \| claude \| host \| m \| — \| 12 \| — \| — \| 3 \| — \| — \| — \| — \|$/mu
      );
      assert.doesNotMatch(rendered, /secret transcript/u);
      f.lines.splice(0);
      f.deps.hostUsageFs.list = () => {
        throw Object.assign(new Error("private"), { code: "EACCES" });
      };

      assert.equal(
        await main(["diagnostics", "render", "--session", f.session], f.deps),
        0
      );
      assert.match(
        fs.readFileSync(path.join(f.session, "diagnostics.md"), "utf-8"),
        /host unavailable: read-error:EACCES/u
      );
      f.lines.splice(0);
      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      manifest.createdAt = "invalid";
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      assert.equal(
        await main(["diagnostics", "render", "--session", f.session], f.deps),
        0
      );
      assert.equal(reads, 1);
      assert.match(
        fs.readFileSync(path.join(f.session, "diagnostics.md"), "utf-8"),
        /host unavailable: invalid session start/u
      );
    } finally {
      f.cleanup();
    }
  }

  // report render and complete collect host usage without gating outcomes
  {
    const f = await hostTest_fixture();

    try {
      const manifestPath = path.join(f.session, "manifest.json");
      // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      manifest.createdAt = new Date(1000).toISOString();
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      f.deps.clock = () => 2000;
      f.deps.orchestrator = { platform: "claude", model: null };
      f.deps.env = { CLAUDE_CODE_SESSION_ID: "thread" };

      const line = Buffer.from(
        JSON.stringify({
          type: "assistant",
          timestamp: new Date(1500).toISOString(),
          message: {
            id: "one",
            model: "m",
            usage: { input_tokens: 12, output_tokens: 3 },
          },
        })
      );

      let reads = 0;
      f.deps.hostUsageFs = {
        list: (dir) => (dir.endsWith("projects") ? ["project"] : []),
        stat: () => ({ size: line.length, mtimeMs: 2000 }),
        read: () => {
          reads += 1;

          return line;
        },
        decompress: null,
      };
      await hostTest_integrate(f, hostTest_gitState(f.session));
      await hostTest_evidenceForPlan(f, hostTest_TREE);
      await hostTest_deliver(f, hostTest_HEAD);
      fs.writeFileSync(
        path.join(f.skillRoot, "config.local.jsonc"),
        '{"diagnostics":false}'
      );

      const hostTest_invokeResult = await hostTest_invoke(
        f,
        "report",
        "render"
      );

      assert.equal(hostTest_invokeResult.exit, 0);

      const hostTest_invokeResult2 = await hostTest_invoke(
        f,
        "report",
        "complete"
      );

      assert.equal(hostTest_invokeResult2.exit, 0);
      assert.equal(reads, 0);
      fs.writeFileSync(
        path.join(f.skillRoot, "config.local.jsonc"),
        '{"diagnostics":true}'
      );

      const hostTest_invokeResult3 = await hostTest_invoke(
        f,
        "report",
        "render"
      );

      assert.equal(hostTest_invokeResult3.exit, 0);
      assert.match(
        fs.readFileSync(path.join(f.session, "diagnostics.md"), "utf-8"),
        /\| claude \| 12 \|/u
      );

      const hostTest_invokeResult4 = await hostTest_invoke(
        f,
        "report",
        "complete"
      );

      assert.equal(hostTest_invokeResult4.exit, 0);
      assert.match(
        fs.readFileSync(path.join(f.session, "diagnostics.md"), "utf-8"),
        /\| claude \| 12 \|/u
      );
      f.deps.hostUsageFs.list = () => {
        throw Object.assign(new Error("private"), { code: "EACCES" });
      };

      const hostTest_invokeResult5 = await hostTest_invoke(
        f,
        "report",
        "render"
      );

      assert.equal(hostTest_invokeResult5.exit, 0);
      assert.match(
        fs.readFileSync(path.join(f.session, "diagnostics.md"), "utf-8"),
        /host unavailable: read-error:EACCES/u
      );

      const hostTest_invokeResult6 = await hostTest_invoke(
        f,
        "report",
        "complete"
      );

      assert.equal(hostTest_invokeResult6.exit, 0);
      assert.match(
        fs.readFileSync(path.join(f.session, "diagnostics.md"), "utf-8"),
        /host unavailable: read-error:EACCES/u
      );
    } finally {
      f.cleanup();
    }
  }

  // diagnostics render warns on missing host retro only when enabled
  {
    const f = sessionFixture({ memory: true });

    try {
      const skill = path.join(f.root, "skill");
      fs.mkdirSync(skill);
      const config = path.join(skill, "config.local.jsonc");
      f.deps.skillRoot = skill;
      const retroPath = path.join(f.session, ".state", "retro.json");

      fs.writeFileSync(config, '{"diagnostics": true}\n');
      assert.equal(
        await main(["diagnostics", "render", "--session", f.session], f.deps),
        0
      );
      let output = f.output();
      assert.equal(output.ok, true);

      let value = readJson(
        defined(output.path),
        withFields({ path: nullable(text), warning: optional(text) })
      );

      assert.ok(value.warning?.includes(retroPath) === true);
      assert.ok(value.warning?.includes("merge retro notes"));
      assert.ok(output.summary.includes(retroPath));
      assert.ok(output.summary.includes("merge retro notes"));

      f.lines.splice(0);
      writeJson(retroPath, []);
      assert.equal(
        await main(["diagnostics", "render", "--session", f.session], f.deps),
        0
      );
      output = f.output();
      assert.equal(output.ok, true);
      value = readJson(
        defined(output.path),
        withFields({ path: nullable(text), warning: optional(text) })
      );
      assert.equal(value.warning, undefined);
      assert.ok(!output.summary.includes("merge retro notes"));
    } finally {
      f.cleanup();
    }
  }
});

const groundingItem = {
  id: "grounding-spec",
  component: "references/grounding.md",
  category: "information-access",
  evidence:
    "map 1, nested 0, research 0, not-covered 0, yield 0/0, tokens unavailable",
  impact: "Keep the map scope.",
  proposedFix: "Keep the current discovery bounds.",
};

const retroWarningCases = [
  {
    name: "non-array retro",
    setup: (file: string) => {
      writeJson(file, {});
    },
    warning: "array",
  },
  {
    name: "malformed retro",
    setup: (file: string) => {
      fs.writeFileSync(file, "{");
    },
    warning: "array",
  },
  {
    name: "unreadable retro",
    setup: (file: string) => {
      fs.mkdirSync(file);
    },
    warning: "array",
  },
  {
    name: "map without grounding",
    setup: (file: string) => {
      writeJson(file, []);
    },
    kind: "map",
    warning: "grounding",
  },
  {
    name: "map with rejected grounding",
    setup: (file: string) => {
      writeJson(file, [{ id: groundingItem.id }]);
    },
    kind: "map",
    warning: "grounding",
  },
  {
    name: "map with accepted grounding",
    setup: (file: string) => {
      writeJson(file, [groundingItem]);
    },
    kind: "map",
  },
  {
    name: "research only",
    setup: (file: string) => {
      writeJson(file, []);
    },
    kind: "research",
  },
];

test("retro warning handles malformed, missing-grounding and clean retros", async () => {
  for (const { name, setup, kind, warning } of retroWarningCases) {
    const f = sessionFixture({ memory: true });

    try {
      f.deps.skillRoot = path.join(f.root, "skill");
      writeJson(path.join(f.deps.skillRoot, "config.local.jsonc"), {
        diagnostics: true,
      });
      const state = path.join(f.session, ".state");
      fs.mkdirSync(state, { recursive: true });
      setup(path.join(state, "retro.json"));

      if ((kind ?? "") !== "") {
        writeJson(path.join(state, "results", "brief-explorer-0001.json"), {
          kind,
        });
      }

      assert.equal(
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await main(["diagnostics", "render", "--session", f.session], f.deps),
        0,
        name
      );
      const output = f.output();
      assert.equal(output.ok, true, name);

      const value = readJson(
        defined(output.path),
        withFields({ warning: optional(text) })
      );

      if ((warning ?? "") === "") {
        assert.equal(value.warning, undefined, name);
      } else {
        assert.ok(
          (value.warning ?? "") !== "",
          `${name}: expected a non-blocking retro warning`
        );
        assert.ok(defined(value.warning).includes(".state/retro.json"));
        assert.ok(
          defined(value.warning).includes(
            warning === "array"
              ? "[{id,component,category,evidence,impact,proposedFix}]"
              : "grounding-<phase>"
          )
        );
        assert.ok(Buffer.byteLength(defined(value.warning)) <= 240);
        assert.ok(output.summary.includes(defined(value.warning)));
      }
    } finally {
      f.cleanup();
    }
  }
});

test("Overview lists each zero-invocation phase without folding", () => {
  const f = sessionFixture({ memory: true });

  try {
    writeJson(path.join(f.session, ".state", "diagnostics", "run-1.json"), {
      capture: { state: "completed", start: 1000, end: 5000 },
      phases: [
        {
          key: "ledger-append",
          name: "implementation",
          outcome: "ok",
          wallMs: 1000,
        },
        {
          key: "lint-run",
          name: "implementation",
          outcome: "ok",
          wallMs: 2000,
        },
        {
          key: "check-run",
          name: "implementation",
          outcome: "ok",
          wallMs: 1000,
        },
      ],
      invocations: [
        {
          phase: "check-run",
          attempt: 1,
          provider: "claude",
          model: "m",
          mode: "cli",
          surface: "cli",
          launched: true,
          outcome: "ok",
          usage: { input: 10, output: 5 },
        },
      ],
      reviews: [],
    });
    const fold = { records: [], lastSeq: 0, torn: null };

    const facts = sessionFacts(f.session, fold, "complete", {
      manifest: readManifest(f.session),
      deps: f.deps,
    });

    // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
    const text = fs.readFileSync(writeDiagnostics(f.session, facts), "utf-8");

    const overviewSection = defined(
      defined(text.split("### Phases")[1]).split("</details>")[0]
    );

    assert.match(overviewSection, /\| implementation · check-run \|/u);
    assert.match(
      overviewSection,
      /\| implementation · ledger-append \| ok \| 1s \|/u
    );
    assert.match(
      overviewSection,
      /\| implementation · lint-run \| ok \| 2s \|/u
    );
    assert.match(overviewSection, /\| all phases \|/u);

    // Driver, Host, User wait columns omitted when no row has a value; Wall is kept
    const header = defined(
      overviewSection.split("\n").find((l) => l.startsWith("| Phase |"))
    );

    assert.ok(
      header.includes("| Wall |") &&
        !header.includes("| Driver |") &&
        !header.includes("| Host |") &&
        !header.includes("| User wait |"),
      header
    );
  } finally {
    f.cleanup();
  }
});

test("legend defines symbols and units, and empty Grounding and Top findings are omitted", () => {
  const f = sessionFixture({ memory: true });

  try {
    const fold = { records: [], lastSeq: 0, torn: null };

    const facts = sessionFacts(f.session, fold, "complete", {
      manifest: readManifest(f.session),
      deps: f.deps,
    });

    // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
    const text = fs.readFileSync(writeDiagnostics(f.session, facts), "utf-8");
    assert.match(text, /`—` unavailable/u);
    assert.match(text, /`~` USD estimate/u);
    assert.match(text, /bars show cost-midpoint share/iu);
    assert.doesNotMatch(text, /### Grounding/u);
    assert.doesNotMatch(text, /Top findings:/u);
    assert.match(text, /## Findings\n\nNo findings\./u);

    const overviewSection = defined(
      defined(text.split("### Phases")[1]).split("</details>")[0]
    );

    const table = overviewSection.split("\n").filter((l) => l.startsWith("|"));
    assert.equal(
      table[0],
      "| Phase | Outcome | Invocations | Input | Cache read | Cache write | Output | Coverage | Cost |"
    );
    assert.equal(
      table[1],
      "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
    );
  } finally {
    f.cleanup();
  }
});

test("round workload render rereads host usage for started rounds and flags over-budget turns", async () => {
  // round workload render reads host usage again only for rounds with a start
  {
    const f = sessionFixture({ memory: true });

    try {
      const skill = path.join(f.root, "skill");
      fs.mkdirSync(skill);
      f.deps.skillRoot = skill;
      fs.writeFileSync(
        path.join(skill, "config.local.jsonc"),
        '{"diagnostics":true}'
      );
      const manifestPath = path.join(f.session, "manifest.json");
      // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      manifest.createdAt = new Date(1000).toISOString();
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));

      const roundDir = path.join(
        f.session,
        ".state",
        "reviews",
        "plan-w",
        "round-1"
      );

      writeJson(path.join(roundDir, "round.json"), {
        round: 1,
        generation: 1,
        cap: 4,
        roster: [],
      });
      fs.mkdirSync(path.join(roundDir, "gen-1"), { recursive: true });

      const subject = crypto
        .createHash("sha256")
        .update(path.join(roundDir, "gen-1"))
        .digest("hex")
        .slice(0, 16);

      const label = crypto
        .createHash("sha256")
        .update(path.join(f.session, ".state", "reviews", "plan-w"))
        .digest("hex")
        .slice(0, 16);

      f.deps.orchestrator = { platform: "claude", model: null };
      f.deps.env = { CLAUDE_CODE_SESSION_ID: "thread" };
      f.deps.clock = () => 4000;

      const line = Buffer.from(
        JSON.stringify({
          type: "assistant",
          timestamp: new Date(1550).toISOString(),
          message: {
            id: "one",
            model: "m",
            usage: { input_tokens: 12, output_tokens: 3 },
          },
        })
      );

      let reads = 0;
      f.deps.hostUsageFs = {
        list: (dir: string) => (dir.endsWith("projects") ? ["project"] : []),
        stat: () => ({ size: line.length, mtimeMs: 2000 }),
        read: () => {
          reads += 1;

          return line;
        },
        decompress: null,
      };

      const writeRun = () => {
        writeJson(path.join(f.session, ".state", "diagnostics", "run.json"), {
          capture: { state: "completed", start: 1500, end: 1600 },
          phases: [{ key: "review-run-plan", name: "plan review" }],
          invocations: [
            {
              phase: "review-run-plan",
              subject,
              attempt: 1,
              provider: "claude",
              model: "m",
              surface: "cli",
              launched: true,
              outcome: "ok",
            },
          ],
          reviews: [],
        });
      };

      assert.equal(
        await main(["diagnostics", "render", "--session", f.session], f.deps),
        0
      );
      assert.equal(reads, 1);
      assert.match(
        fs.readFileSync(path.join(f.session, "diagnostics.md"), "utf-8"),
        new RegExp(`\\| subject ${label} \\| 1 \\| — \\| — \\| — \\|`, "u")
      );

      writeRun();
      f.lines.splice(0);
      assert.equal(
        await main(["diagnostics", "render", "--session", f.session], f.deps),
        0
      );
      assert.equal(reads, 3);
      assert.match(
        fs.readFileSync(path.join(f.session, "diagnostics.md"), "utf-8"),
        new RegExp(
          `\\| subject ${label} \\| 1 \\| 1: review-run-plan 1 \\| 15 \\| 1 \\|`,
          "u"
        )
      );
    } finally {
      f.cleanup();
    }
  }

  // round turns: renders observed turns and flags only plan and design rounds over budget
  {
    const f = sessionFixture({ memory: true });

    try {
      // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
      const text = fs.readFileSync(
        writeDiagnostics(f.session, {
          outcome: "complete",
          phases: [],
          invocations: [],
          reviews: [],
          roundWorkload: [
            {
              review: "review-aaaaaaaaaaaaaaaa",
              kind: "plan",
              round: 1,
              calls: { total: 6, phases: [] },
              hostTurns: 26,
            },
            {
              review: "review-bbbbbbbbbbbbbbbb",
              kind: "design",
              round: 2,
              calls: { total: 6, phases: [] },
            },
            {
              review: "review-cccccccccccccccc",
              kind: "code",
              round: 3,
              calls: { total: 7, phases: [] },
              hostTurns: 30,
            },
          ],
        }),
        "utf-8"
      );

      for (const row of [
        "| subject aaaaaaaaaaaaaaaa | 1 | 6 | — | 26 |",
        "| subject bbbbbbbbbbbbbbbb | 2 | 6 | — | — |",
        "| subject cccccccccccccccc | 3 | 7 | — | 30 |",
      ]) {
        assert.ok(text.includes(row), row);
      }

      const budget = text
        .split("\n")
        .find((line) => line.startsWith("Advisory budget"));

      assert.equal(
        budget,
        "Advisory budget (lightweight fix review): <=6 toolkit calls, <=25 host turns; over: subject aaaaaaaaaaaaaaaa round 1"
      );
    } finally {
      f.cleanup();
    }
  }

  // round turns: renders code review workloads without the advisory budget
  {
    const f = sessionFixture({ memory: true });

    try {
      // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
      const text = fs.readFileSync(
        writeDiagnostics(f.session, {
          outcome: "complete",
          phases: [],
          invocations: [],
          reviews: [],
          roundWorkload: [
            {
              review: "review-cccccccccccccccc",
              kind: "code",
              round: 1,
              calls: { total: 7, phases: [] },
              hostTurns: 30,
            },
          ],
        }),
        "utf-8"
      );

      assert.match(
        text,
        /\| subject cccccccccccccccc \| 1 \| 7 \| — \| 30 \|/u
      );
      assert.doesNotMatch(text, /Advisory budget per round/u);
    } finally {
      f.cleanup();
    }
  }
});

test("reports linked restart work and unavailable coverage beside retry metrics", () => {
  const ref = "01234567-89ab-4def-8123-0123456789ab";

  const facts = {
    phases: [],
    invocations: [],
    reviews: [],
    recoverySelections: [
      {
        ref,
        review: "code-integration" as const,
        targetHash: "a".repeat(64),
        round: 2,
        generation: 1,
      },
    ],
    recoveryExecutions: [{ ref, reused: 1, unresolved: 0 }],
  };

  // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
  const { text } = renderDiagnostics([facts]);
  assert.match(text, /Explicit review recovery/u);
  assert.match(
    text,
    /Code integration R2.*reused 1.*launched uncollected.*unresolved 0/u
  );
  assert.match(
    renderDiagnostics([{ ...facts, recoveryExecutions: [] }]).text,
    /Execution uncollected/u
  );
});

// SECTION: Rounds past cap

const pastCapReview = "review-1234567890abcdef";

const pastCapLines = (report: string) =>
  report.split("\n").filter((line) => line.startsWith("- Rounds past cap:"));

const pastCapRow = (
  round: number,
  extra: { cap?: number; cause?: RoundCausePrimary } = {}
) => ({
  phase: pastCapReview,
  round,
  accepted: 0,
  rejected: 0,
  ...extra,
});

const pastCapRun = (cause: "failed" | "clean") => ({
  phases: [],
  invocations: [],
  reviews: [pastCapRow(1, { cap: 1 }), pastCapRow(2, { cap: 1, cause })],
});

const pastCapCause = (cause: unknown) => ({ ...pastCapRow(2), cause });

const subjectKey = (index: number) =>
  `review-${index.toString(16).padStart(16, "0")}`;

test("the rounds-past-cap bullet survives the review-health row fold", () => {
  // 30 reviews of 100 rounds exceed the report cap, so the health rows fold.
  const keys = Array.from({ length: 30 }, (_, i) => subjectKey(i));

  const { text: report } = renderDiagnostics([
    {
      phases: [],
      invocations: [],
      reviews: [
        {
          phase: defined(keys[0]),
          round: 99,
          accepted: 1,
          rejected: 0,
          cause: "recurring",
        },
      ],
      roundTiming: keys.flatMap((review) =>
        Array.from({ length: 100 }, (_, i) => ({
          review,
          round: i + 1,
          cap: 98,
          slots: [
            { slot: "codex[0]", attempts: [{ startMs: 0, endMs: 1000 }] },
          ],
        }))
      ),
    },
  ]);

  assert.match(report, /\d+ review round rows omitted\./u);
  assert.doesNotMatch(report, /\| subject 000000000000001d \| 100\/100 \|/u);

  const bullets = pastCapLines(report);
  assert.equal(bullets.length, 30);
  assert.equal(
    bullets[0],
    "- Rounds past cap: subject 0000000000000000 (cap 98): R99 recurring, R100 unrecorded"
  );
  assert.equal(
    bullets[29],
    "- Rounds past cap: subject 000000000000001d (cap 98): R99 unrecorded, R100 unrecorded"
  );
});

test("no rounds-past-cap bullet without a recorded cap or a round above it", () => {
  for (const reviews of [
    [pastCapRow(1), pastCapRow(2), pastCapRow(3)],
    [1, 2, 3].map((round) => pastCapRow(round, { cap: 3 })),
  ]) {
    const { text: report } = renderDiagnostics([
      { phases: [], invocations: [], reviews },
    ]);

    assert.match(report, /## Review health/u);
    assert.doesNotMatch(report, /Rounds past cap/u);
  }
});

test("a multi-run report prefixes each rounds-past-cap bullet with its run number", () => {
  assert.deepEqual(
    pastCapLines(
      renderDiagnostics([pastCapRun("failed"), pastCapRun("clean")]).text
    ),
    [
      "- Rounds past cap: run 1 subject 1234567890abcdef (cap 1): R2 failed",
      "- Rounds past cap: run 2 subject 1234567890abcdef (cap 1): R2 clean",
    ]
  );
});

test("the diagnostics allow-list keeps only known round causes and positive in-range caps", () => {
  const kept = sanitizeFacts({
    phases: [],
    invocations: [],
    reviews: [
      pastCapCause("fix-induced"),
      pastCapCause("unknown-origin"),
      pastCapCause("bogus"),
      pastCapCause({ primary: "recurring" }),
      pastCapCause(undefined),
    ],
  }).reviews.map((review) => review.cause);

  assert.deepEqual(kept, [
    "fix-induced",
    "unknown-origin",
    undefined,
    undefined,
    undefined,
  ]);

  const caps = sanitizeFacts({
    phases: [],
    invocations: [],
    reviews: [],
    roundTiming: [3, 0, -1, 1.5, 1001, "2"].map((cap, i) => ({
      review: pastCapReview,
      round: i + 1,
      cap,
      slots: [],
    })),
  }).roundTiming?.map((timing) => timing.cap);

  assert.deepEqual(caps, [
    3,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});
