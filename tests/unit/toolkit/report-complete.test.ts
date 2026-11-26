import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { readManifest } from "../../../skills/dispatch/scripts/lib/session.ts";
import { main } from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import { loadRejections } from "../../../skills/dispatch/scripts/toolkit/confirmations.ts";
import { stableValue } from "../../../skills/dispatch/scripts/toolkit/domain/stable-value.ts";
import {
  currentHashes,
  foldLedger,
  latest,
} from "../../../skills/dispatch/scripts/toolkit/ledger.ts";
import {
  checks,
  loadPlan,
} from "../../../skills/dispatch/scripts/toolkit/plan-view.ts";
import { defined } from "../../helpers/guards.ts";
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

const HEAD_A = "a".repeat(40);
const TREE_A = "b".repeat(40);
const HEAD_B = "c".repeat(40);
const TREE_B = "d".repeat(40);
const DIRTY_TREE = "e".repeat(40);

const planSource = (count = 4, risk?: string) => {
  const ids = Array.from({ length: count }, (_, index) => `SC${index + 1}`);

  const lines = [
    "# Report fixture",
    "",
    ...(risk === undefined
      ? []
      : [
          `> **Parent:** \`brief.spec.md\` · sha256:${"a".repeat(64)}`,
          "> **Decide:** none",
          `> **Risk:** ${risk} — completion gate fixture`,
          "> **Scope:** report tests",
          "",
        ]),
    "## Task Map",
    "| ID | Title | Outcome | Prerequisites | Criteria |",
    "| --- | --- | --- | --- | --- |",
    ...ids.map(
      (id, index) =>
        `| T${index + 1} | Task ${index + 1} | Works | none | ${id} |`
    ),
    "",
    "## Proposed Changes",
  ];

  for (const index of ids.keys()) {
    lines.push(
      `### T${index + 1} - Task ${index + 1}`,
      `#### [NEW] src/task-${index + 1}.ts`,
      "- Purpose: implements the fixture behavior.",
      ""
    );
  }

  lines.push("## Success Criteria");

  for (const [index, id] of ids.entries()) {
    lines.push(
      `- [${id}] Criterion ${index + 1} works`,
      `  - Changes: src/task-${index + 1}.ts`,
      `  - Check: \`node verify-${index + 1}.js\``,
      "  - Evidence: check"
    );
  }

  lines.push(
    "",
    "## Verification Plan",
    "### Automated Tests",
    ...ids.map((_id, index) => `- \`node verify-${index + 1}.js\``),
    "- `node contract-check.js`",
    ""
  );

  return lines.join("\n");
};

let eventNumber = 0;

const invoke = async (
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

async function append(
  f: ReturnType<typeof sessionFixture>,
  record: JsonObject
) {
  const file = f.artifact(
    `event-${(eventNumber += 1)}.json`,
    JSON.stringify(record)
  );

  const result = await invoke(f, "ledger", "append", file);
  assert.equal(result.exit, 0, result.output.summary);

  return result.output;
}

const fixture = async (
  count = 4,
  risk?: string,
  source = planSource(count, risk)
) => {
  const f = sessionFixture({ memory: true });
  const skillRoot = path.join(f.root, "isolated-skill");
  fs.mkdirSync(skillRoot);
  fs.writeFileSync(
    path.join(skillRoot, "config.local.jsonc"),
    '{"diagnostics": false}\n'
  );
  f.deps.skillRoot = skillRoot;
  f.artifact("brief.spec.md", "# Brief\n");
  f.artifact("report.plan.md", source);
  await append(f, {
    kind: "bind",
    by: "tool",
    key: `bind:${(eventNumber += 1)}`,
    data: { spec: "brief.spec.md", plan: "report.plan.md" },
  });

  return { ...f, skillRoot };
};

const integrate = async (
  f: ReturnType<typeof sessionFixture>,
  state: FakeGitState,
  dest?: { path: string; branch: string }
) => {
  const target = dest ?? { path: f.root, branch: "main" };
  const worktree = path.join(f.session, ".state", "worktrees", "integration");
  fs.mkdirSync(worktree, { recursive: true });
  state.session = f.session;
  f.deps.run = fakeGit(state);
  await append(f, {
    kind: "integrate",
    by: "tool",
    key: `integrate:opened:${(eventNumber += 1)}`,
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

const evidence = async (
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
  await append(f, {
    kind: "evidence",
    by: "tool",
    key: `evidence:${digest}`,
    data: { ...data, path: evidencePath },
  });

  return evidencePath;
};

const evidenceForPlan = async (
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
      await evidence(f, row.criterion, row.commandDigest, tree)
    );
  }

  return paths;
};

const gitState = (
  session: string,
  head = HEAD_A,
  tree = TREE_A,
  testedTree = tree
): FakeGitState => ({
  session,
  head,
  tree,
  testedTree,
  changes: [],
  calls: [],
});

const deliver = async (
  f: ReturnType<typeof sessionFixture>,
  head: string,
  dest?: { path: string; branch: string }
) => {
  const target = dest ?? { path: f.root, branch: "main" };
  await append(f, {
    kind: "integrate",
    by: "tool",
    key: `integrate:delivered:${(eventNumber += 1)}`,
    data: {
      phase: "delivered",
      mode: "uncommitted",
      dest: target,
      from: head,
      source: head,
    },
  });
};

test("review tool rows do not complete a report, while manual evidence does", async () => {
  const source = planSource(1).replace(
    "  - Evidence: check",
    "  - Evidence: review\n  - Review: artifact: src/task-1.ts; scenario: inspect the delivered source; pass: the user records review evidence"
  );

  const f = await fixture(1, undefined, source);

  try {
    await integrate(f, gitState(f.session));
    await evidenceForPlan(f, TREE_A);
    await deliver(f, HEAD_A);

    const rendered = await invoke(f, "report", "render");
    assert.match(
      rendered.output.summary,
      /SC verified 1, manual 0, waived 0, missing 1/u
    );
    const blocked = await invoke(f, "report", "complete");
    assert.equal(blocked.output.reason, "criteria-unmet");

    await append(f, {
      kind: "manual-complete",
      by: "user",
      quote: "I reviewed the delivered source against the scenario.",
      data: { criterion: "SC1", evidence: "manual/SC1-review.md" },
    });
    const invokeResult = await invoke(f, "report", "complete");

    assert.equal(invokeResult.exit, 0);
  } finally {
    f.cleanup();
  }
});

test("pending MUST rejection prevents report completion until attributed agreement", async () => {
  const f = await fixture(1);

  try {
    await integrate(f, gitState(f.session));
    await evidenceForPlan(f, TREE_A);
    await deliver(f, HEAD_A);
    const dir = path.join(f.session, ".state/reviews/plan-report.plan/round-1");
    fs.mkdirSync(dir, { recursive: true });

    const metadata = {
      round: 1,
      generation: 1,
      startSeq: 0,
      target: "captured",
      spec: { path: path.join(f.root, "brief.spec.md"), hash: "original" },
      artifactPath: path.join(f.root, "report.plan.md"),
      roster: [
        {
          slot: "claude[0]",
          provider: "claude",
          index: 0,
          reserve: false,
          native: false,
        },
      ],
    };

    const finding = {
      id: "R1-F001",
      severity: "MUST",
      category: "correctness",
      locus: "§ Work",
      defect: "Unbounded writes",
      requiredChange: "Bound writes",
      sources: ["claude[0]"],
      scope: "in",
    };

    fs.writeFileSync(path.join(dir, "round.json"), JSON.stringify(metadata));
    fs.writeFileSync(
      path.join(dir, "findings.json"),
      JSON.stringify({
        review: "plan-report.plan",
        round: 1,
        findings: [finding],
        failed: [],
      })
    );
    await append(f, {
      kind: "ruling",
      by: "orchestrator",
      key: "rejection-test",
      data: {
        subject: "review:plan-report.plan:R1-F001",
        ruling: "rejected",
        rationale: "Writes have a bound",
      },
    });
    const invokeResult2 = await invoke(f, "report", "complete");

    assert.equal(invokeResult2.output.reason, "review-confirmation-required");
    fs.writeFileSync(path.join(dir, "round.json"), "{invalid");
    const rendered = await invoke(f, "report", "render");
    assert.equal(rendered.exit, 0, JSON.stringify(rendered));
    assert.match(rendered.output.summary, /confirmation unavailable/u);
    const invokeResult3 = await invoke(f, "report", "complete");

    assert.equal(invokeResult3.output.reason, "review-confirmation-required");
    fs.writeFileSync(path.join(dir, "round.json"), JSON.stringify(metadata));
    await append(f, {
      kind: "ruling",
      by: "orchestrator",
      key: "duplicate-original",
      data: {
        subject: "review:plan-report.plan:R1-F001",
        ruling: "duplicate",
        rationale: "Same issue as R1-F999",
      },
    });
    const invokeResult4 = await invoke(f, "report", "complete");

    assert.equal(
      invokeResult4.output.reason,
      "review-confirmation-required",
      "a duplicate ruling cannot discard the pending original rejection"
    );
    await append(f, {
      kind: "escalation",
      by: "tool",
      key: "open-rejection",
      data: {
        id: "rejection:plan-report.plan:R1-F001",
        state: "open",
        summary: "Reviewer disputes rejection",
      },
    });
    const invokeResult5 = await invoke(f, "report", "complete");

    assert.equal(invokeResult5.output.reason, "review-confirmation-required");
    await append(f, {
      kind: "escalation",
      by: "orchestrator",
      key: "resolved-rejection",
      data: {
        id: "rejection:plan-report.plan:R1-F001",
        state: "resolved",
        summary: "User asks to recheck bounded write evidence",
      },
    });

    const { request } = defined(
      loadRejections(f.session, foldLedger(f.session), ["plan-report.plan"])[0]
    );

    const second = path.join(
      f.session,
      ".state/reviews/plan-report.plan/round-2"
    );

    fs.mkdirSync(second);
    fs.writeFileSync(
      path.join(second, "round.json"),
      JSON.stringify({
        ...metadata,
        round: 2,
        startSeq: foldLedger(f.session).lastSeq,
        requests: [request],
      })
    );

    const save = (confirmation: {
      requestId: string;
      decision: string;
      replyRationale: string;
      responder?: unknown;
    }) => {
      fs.writeFileSync(
        path.join(second, "findings.json"),
        JSON.stringify({
          review: "plan-report.plan",
          round: 2,
          findings: [],
          failed: [],
          confirmations: [confirmation],
        })
      );
      const slots = path.join(second, "gen-1/slots");
      fs.mkdirSync(slots, { recursive: true });
      fs.writeFileSync(
        path.join(slots, "claude[0].json"),
        JSON.stringify({
          slot: "claude[0]",
          state: "done",
          responder: confirmation.responder,
          text: JSON.stringify({
            status: "CLEAN",
            findings: [],
            confirmations: [
              {
                requestId: confirmation.requestId,
                decision: confirmation.decision,
                rationale: confirmation.replyRationale,
              },
            ],
          }),
        })
      );
    };

    const reply = {
      ...request,
      sourceSlot: "claude[0]",
      decision: "agree",
      replyRationale: "The captured implementation has a bound",
    };

    save(reply);
    const invokeResult6 = await invoke(f, "report", "complete");

    assert.equal(invokeResult6.output.reason, "review-confirmation-required");
    save({
      ...reply,
      responder: {
        slot: "agy[0]",
        provider: "agy",
        model: null,
        native: false,
      },
    });
    const invokeResult7 = await invoke(f, "report", "complete");

    assert.equal(invokeResult7.output.reason, "review-confirmation-required");
    save({
      ...reply,
      replyRationale: " ",
      responder: {
        slot: "claude[0]",
        provider: "claude",
        model: null,
        native: false,
      },
    });
    const invokeResult8 = await invoke(f, "report", "complete");

    assert.equal(invokeResult8.output.reason, "review-confirmation-required");
    fs.writeFileSync(
      path.join(second, "findings.json"),
      JSON.stringify({
        review: "plan-report.plan",
        round: 2,
        findings: [],
        failed: [
          {
            slot: "claude[0]",
            state: "failed",
            cls: "auth",
            reason: "No reply",
          },
        ],
      })
    );
    const invokeResult9 = await invoke(f, "report", "complete");

    assert.equal(invokeResult9.output.reason, "review-confirmation-required");
    save({
      ...reply,
      responder: {
        slot: "claude[0]",
        provider: "claude",
        model: null,
        native: false,
      },
    });
    const invokeResult10 = await invoke(f, "report", "complete");

    assert.equal(invokeResult10.exit, 0);
  } finally {
    f.cleanup();
  }
});

test("report complete statuses enforces user records and counts unique integrated tasks", async () => {
  const f = await fixture(4);

  try {
    const state = gitState(f.session);
    await integrate(f, state);
    const evidenceForPlanResult = await evidenceForPlan(f, TREE_A, ["SC1"]);
    const producerPath = defined(evidenceForPlanResult.get("SC1"));

    for (const criterion of ["SC4", "contract"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await append(f, {
        kind: "waiver",
        by: "user",
        quote: `${criterion} approved`,
        data: { criterion, reason: "accepted exception" },
      });
    }

    const malformedReview = path.join(
      f.session,
      ".state",
      "reviews",
      "malformed-review",
      "round-1",
      "round.json"
    );

    fs.mkdirSync(path.dirname(malformedReview), { recursive: true });
    fs.writeFileSync(malformedReview, "{invalid");

    let result = await invoke(f, "report", "complete");
    assert.equal(result.exit, 4);
    assert.equal(result.output.reason, "criteria-unmet");
    assert.match(result.output.summary, /SC2/u);
    assert.match(result.output.summary, /SC3/u);
    assert.equal(
      state.calls.some(({ argv }) => argv[1] === "diff"),
      false
    );
    assert.equal(
      fs.existsSync(path.join(f.session, "report.walkthrough.md")),
      false
    );
    fs.rmSync(path.dirname(malformedReview), { recursive: true, force: true });

    const bad = await invoke(
      f,
      "ledger",
      "append",
      f.artifact(
        `event-${(eventNumber += 1)}.json`,
        JSON.stringify({
          kind: "manual-complete",
          by: "orchestrator",
          data: { criterion: "SC3", evidence: "manual/path.md" },
        })
      )
    );

    assert.equal(bad.exit, 1);
    assert.equal(bad.output.reason, "user-only");

    result = await invoke(f, "report", "complete");
    assert.equal(result.exit, 4);
    assert.equal(result.output.reason, "criteria-unmet");
    assert.match(result.output.summary, /SC3/u);

    await append(f, {
      kind: "waiver",
      by: "user",
      quote: "SC2 approved",
      data: { criterion: "SC2", reason: "approved exception" },
    });
    await append(f, {
      kind: "manual-complete",
      by: "user",
      quote: "SC3 completed by hand",
      data: { criterion: "SC3", evidence: "manual/sc3.md" },
    });
    result = await invoke(f, "report", "complete");
    assert.equal(result.exit, 4);
    assert.equal(result.output.reason, "undelivered");

    for (const task of ["T1", "T2", "T1", "T99"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await append(f, {
        kind: "integrate",
        by: "tool",
        key: `done:${task}:${(eventNumber += 1)}`,
        data: { phase: "done", task, commit: HEAD_A },
      });
    }

    await append(f, {
      kind: "integrate",
      by: "tool",
      key: `started:${(eventNumber += 1)}`,
      data: { phase: "started", task: "T3", candidate: HEAD_A },
    });
    await append(f, {
      kind: "integrate",
      by: "tool",
      key: `fix:${(eventNumber += 1)}`,
      data: { phase: "fix", commit: HEAD_A, reason: "fixture repair" },
    });
    await append(f, {
      kind: "integrate",
      by: "tool",
      key: `abandoned:${(eventNumber += 1)}`,
      data: {
        phase: "abandoned",
        task: "T4",
        candidate: HEAD_A,
        reason: "fixture abandoned",
      },
    });
    await deliver(f, HEAD_A);
    const recordCount = foldLedger(f.session).records.length;
    result = await invoke(f, "report", "complete");
    assert.equal(result.exit, 0, result.output.summary);
    assert.equal(foldLedger(f.session).records.length, recordCount);

    const walkthrough = fs.readFileSync(
      path.join(f.session, "report.walkthrough.md"),
      "utf-8"
    );

    assert.match(
      walkthrough,
      /### Verified Evidence[\s\S]*?\| SC1 \| \.state\/evidence\/[a-f0-9]+\.json \|/u
    );
    assert.ok(walkthrough.includes(producerPath));
    assert.match(
      walkthrough,
      /### Manual[\s\S]*?- SC3 · User evidence: manual\/sc3\.md; quote: SC3 completed by hand/u
    );
    assert.match(
      walkthrough,
      /### Waived[\s\S]*?- SC2 · Reason: approved exception; quote: SC2 approved/u
    );
    assert.match(
      walkthrough,
      new RegExp(
        `What:\\*\\* 2 of 4 tasks integrated; uncommitted changes from source ${HEAD_A.slice(0, 12)} in main working tree`,
        "u"
      )
    );
  } finally {
    f.cleanup();
  }
});

test("report complete delivery binds evidence and delivery to the locked tree and HEAD", async () => {
  const f = await fixture(1);

  try {
    const state = gitState(f.session, HEAD_A, TREE_A);
    const worktree = await integrate(f, state);
    await evidenceForPlan(f, TREE_A);
    await deliver(f, HEAD_A);
    const invokeResult11 = await invoke(f, "report", "complete");

    assert.equal(invokeResult11.exit, 0);

    state.head = HEAD_B;
    state.tree = TREE_B;
    state.testedTree = TREE_B;
    await append(f, {
      kind: "integrate",
      by: "tool",
      key: `fix-tree:${(eventNumber += 1)}`,
      data: { phase: "fix", commit: HEAD_B, reason: "new integrated commit" },
    });
    let result = await invoke(f, "report", "complete");
    assert.equal(result.exit, 4);
    assert.equal(result.output.reason, "criteria-unmet");

    await evidenceForPlan(f, TREE_B);
    result = await invoke(f, "report", "complete");
    assert.equal(result.exit, 4);
    assert.equal(result.output.reason, "undelivered");
    await deliver(f, HEAD_B);
    const invokeResult12 = await invoke(f, "report", "complete");

    assert.equal(invokeResult12.exit, 0);

    state.testedTree = DIRTY_TREE;
    result = await invoke(f, "report", "complete");
    assert.equal(result.exit, 4);
    assert.equal(result.output.reason, "criteria-unmet");
    assert.match(result.output.summary, /dirty checkout/iu);

    const beforeMissingWorktree = state.calls.length;
    fs.rmSync(worktree, { recursive: true, force: true });
    result = await invoke(f, "report", "complete");
    assert.equal(result.exit, 4);
    assert.equal(result.output.reason, "no-integration");
    assert.equal(state.calls.length, beforeMissingWorktree);

    fs.mkdirSync(worktree, { recursive: true });
    const expanded = f.artifact("expanded.plan.md", planSource(2));
    await append(f, {
      kind: "bind",
      by: "tool",
      key: `rebind:${(eventNumber += 1)}`,
      data: { spec: "brief.spec.md", plan: path.relative(f.root, expanded) },
    });
    state.testedTree = TREE_B;
    result = await invoke(f, "report", "complete");
    assert.equal(result.exit, 4);
    assert.equal(result.output.reason, "criteria-unmet");
    assert.match(result.output.summary, /SC2/u);

    const { calls } = state;

    for (const call of calls.filter(
      ({ argv }) =>
        (argv[1] === "rev-parse" &&
          ["HEAD", "HEAD^{tree}"].includes(defined(argv[2]))) ||
        ["read-tree", "add", "write-tree"].includes(defined(argv[1]))
    )) {
      assert.equal(call.locked, true, JSON.stringify(call.argv));
    }

    for (const call of calls.filter(({ argv }) => argv[1] === "diff")) {
      assert.equal(call.locked, false, JSON.stringify(call.argv));
    }
  } finally {
    f.cleanup();
  }
});

test("report complete low session accepts bound evidence and a user contract waiver without approval", async () => {
  const f = await fixture(1);

  try {
    const state = gitState(f.session);
    await integrate(f, state);
    await append(f, {
      kind: "level",
      by: "tool",
      key: `level:${(eventNumber += 1)}`,
      data: { level: "low" },
    });
    const evidencePaths = await evidenceForPlan(f, TREE_A, ["SC1"]);
    await append(f, {
      kind: "waiver",
      by: "user",
      quote: "contract waiver quote",
      data: { criterion: "contract", reason: "manual contract acceptance" },
    });
    await append(f, {
      kind: "edit",
      by: "tool",
      key: `edit:${(eventNumber += 1)}`,
      data: {
        artifact: "plan",
        before: `sha256:${"1".repeat(64)}`,
        after: `sha256:${"2".repeat(64)}`,
        class: "intent",
        affects: ["SC1"],
        rationale: "clarified the acceptance boundary",
        diffRef: "plan-edit.diff",
      },
    });
    const hashes = currentHashes(f.root, latest(foldLedger(f.session), "bind"));
    await deliver(f, HEAD_A);

    const result = await invoke(f, "report", "complete");
    assert.equal(result.exit, 0, result.output.summary);

    const walkthrough = fs.readFileSync(
      path.join(f.session, "report.walkthrough.md"),
      "utf-8"
    );

    assert.ok(
      walkthrough.includes(
        `- Spec: [brief.spec.md](${path.relative(f.session, path.join(f.root, "brief.spec.md")).replaceAll("\\", "/")}) · sha256:${defined(hashes.spec).slice(7, 19)}`
      )
    );
    assert.ok(
      walkthrough.includes(
        `- Plan: [report.plan.md](${path.relative(f.session, path.join(f.root, "report.plan.md")).replaceAll("\\", "/")}) · sha256:${defined(hashes.plan).slice(7, 19)}`
      )
    );
    assert.ok(walkthrough.includes(`| SC1 | ${evidencePaths.get("SC1")} |`));
    assert.match(
      walkthrough,
      /- contract · Reason: manual contract acceptance; quote: contract waiver quote/u
    );
    assert.match(
      walkthrough,
      /- Deviation: plan edit \(intent\) seq \d+: clarified the acceptance boundary; diff plan-edit\.diff; affects SC1/u
    );
    assert.equal(
      foldLedger(f.session).records.some(
        (record) => record.kind === "approval"
      ),
      false
    );
  } finally {
    f.cleanup();
  }
});

test("report complete enforces review focus rules based on plan risk level", async () => {
  // Med/high risk requires review focus
  const fMed = await fixture(1, "med");

  try {
    const state = gitState(fMed.session);
    await integrate(fMed, state);
    let result = await invoke(fMed, "report", "complete");
    assert.equal(result.output.reason, "criteria-unmet");
    await evidenceForPlan(fMed, TREE_A);
    result = await invoke(fMed, "report", "complete");
    assert.equal(result.output.reason, "undelivered");
    await deliver(fMed, HEAD_A);
    result = await invoke(fMed, "report", "complete");
    assert.equal(result.exit, 4);
    assert.equal(result.output.reason, "focus-required");
    assert.equal(
      fs.existsSync(path.join(fMed.session, "report.walkthrough.md")),
      false
    );

    const focus = async (key: string, count: number) =>
      await append(fMed, {
        kind: "focus",
        by: "orchestrator",
        key,
        data: {
          bullets: Array.from({ length: count }, (_, index) => ({
            text: `Review point ${index + 1}`,
            evidence: `src/task-${index + 1}.ts`,
          })),
        },
      });

    await focus("focus:med:sufficient", 3);
    const invokeResult13 = await invoke(fMed, "report", "complete");

    assert.equal(invokeResult13.exit, 0);
    await focus("focus:med:superseding-short", 2);
    result = await invoke(fMed, "report", "complete");
    assert.equal(
      result.output.reason,
      "focus-required",
      "the latest short record must supersede earlier sufficient focus"
    );
    await focus("focus:med:latest-sufficient", 3);
    const invokeResult14 = await invoke(fMed, "report", "complete");

    assert.equal(invokeResult14.exit, 0);
  } finally {
    fMed.cleanup();
  }

  // Low/unspecified risk completes without review focus
  const fLow = await fixture(1, "low");

  try {
    await integrate(fLow, gitState(fLow.session));
    await evidenceForPlan(fLow, TREE_A);
    await deliver(fLow, HEAD_A);
    const result = await invoke(fLow, "report", "complete");
    assert.equal(result.exit, 0, result.output.summary);
    assert.equal(
      foldLedger(fLow.session).records.some(
        (record) => record.kind === "focus"
      ),
      false
    );
  } finally {
    fLow.cleanup();
  }
});

test("uncommitted consumers complete by source and ignore later caller history", async () => {
  const f = await fixture(1);

  try {
    const state = gitState(f.session);
    await integrate(f, state);
    await evidenceForPlan(f, TREE_A);
    await append(f, {
      kind: "integrate",
      by: "tool",
      data: {
        phase: "delivered",
        mode: "uncommitted",
        dest: { path: f.root, branch: "main" },
        from: "f".repeat(40),
        source: HEAD_A,
      },
    });
    const { run } = f.deps;
    f.deps.run = async (argv, options) =>
      options.cwd === f.root
        ? { exit: 0, stdout: "9".repeat(40), stderr: "" }
        : await run(argv, options);
    const invokeResult15 = await invoke(f, "report", "complete");

    assert.equal(invokeResult15.exit, 0);
    state.head = HEAD_B;
    const invokeResult16 = await invoke(f, "report", "complete");

    assert.equal(invokeResult16.output.reason, "undelivered");
  } finally {
    f.cleanup();
  }
});

test("report complete warns on missing host retro only when diagnostics are enabled", async () => {
  const f = await fixture(1);

  try {
    await integrate(f, gitState(f.session));
    await evidenceForPlan(f, TREE_A);
    await deliver(f, HEAD_A);
    const retroPath = path.join(f.session, ".state", "retro.json");

    let result = await invoke(f, "report", "complete");
    assert.equal(result.exit, 0, result.output.summary);

    let value = readJson(
      defined(result.output.path),
      withFields({ warning: optional(text) })
    );

    assert.equal(value.warning, undefined);
    assert.ok(!result.output.summary.includes("merge retro notes"));

    fs.writeFileSync(
      path.join(f.skillRoot, "config.local.jsonc"),
      '{"diagnostics": true}\n'
    );
    result = await invoke(f, "report", "complete");
    assert.equal(result.exit, 0, result.output.summary);
    value = readJson(
      defined(result.output.path),
      withFields({ warning: optional(text) })
    );
    assert.ok(value.warning?.includes(retroPath) === true);
    assert.ok(value.warning?.includes("merge retro notes"));
    assert.ok(result.output.summary.includes(retroPath));
    assert.ok(result.output.summary.includes("merge retro notes"));
  } finally {
    f.cleanup();
  }
});
