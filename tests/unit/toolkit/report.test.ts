import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { appendRecord, currentHashes, foldLedger, latest } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { reviewFixIdentity } from '../../../skills/dispatch/scripts/toolkit/review-fix.ts';
import { checks, loadPlan } from '../../../skills/dispatch/scripts/toolkit/plan-view.ts';
import { readManifest } from '../../../skills/dispatch/scripts/lib/session.ts';
import { fakeGit } from './helpers/fake-git.ts';
import { sessionFixture } from './helpers/session.ts';
import {
  anything,
  flag,
  listOf,
  nullable,
  optional,
  parseJson,
  readJson,
  shape,
  text as jsonText,
} from './helpers/json.ts';
import type { JsonObject } from './helpers/json.ts';

const gitOutput = (stdout = '') => ({ exit: 0, stdout, stderr: '' });

const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value) + '\n');
}

function planSource(count = 4): string {
  const ids = Array.from({ length: count }, (_, index) => `SC${index + 1}`);
  const lines = [
    '# Report fixture',
    '',
    '## Task Map',
    '| ID | Title | Outcome | Prerequisites | Criteria |',
    '| --- | --- | --- | --- | --- |',
    ...ids.map((id, index) => `| T${index + 1} | Task ${index + 1} | Works | none | ${id} |`),
    '',
    '## Proposed Changes',
  ];
  ids.forEach((_id, index) =>
    lines.push(
      `### T${index + 1} — Task ${index + 1}`,
      `#### [NEW] src/task-${index + 1}.ts`,
      '- Purpose: implements the fixture behavior.',
      '',
    ),
  );
  lines.push('## Success Criteria');
  ids.forEach((id, index) =>
    lines.push(
      `- [${id}] Criterion ${index + 1} works`,
      `  - Changes: src/task-${index + 1}.ts`,
      `  - Check: \`node verify-${index + 1}.js\``,
      '  - Evidence: check',
    ),
  );
  lines.push(
    '',
    '## Verification Plan',
    '### Automated Tests',
    ...ids.map((_id, index) => `- \`node verify-${index + 1}.js\``),
    '- `node contract-check.js`',
    '',
  );
  return lines.join('\n');
}

async function fixture(count = 4, source = planSource(count)) {
  const f = sessionFixture({ memory: true });
  const skillRoot = path.join(f.root, 'isolated-skill');
  fs.mkdirSync(skillRoot);
  f.deps.skillRoot = skillRoot;
  f.artifact('brief.spec.md', '# Brief\n');
  f.artifact('report.plan.md', source);
  await appendRecord(
    f.session,
    {
      kind: 'bind',
      by: 'tool',
      key: 'bind:report',
      data: { spec: 'brief.spec.md', plan: 'report.plan.md' },
    },
    f.deps,
  );
  return { ...f, skillRoot };
}

async function invoke(f: ReturnType<typeof sessionFixture>, tool: string, action: string, ...args: Array<string>) {
  f.lines.splice(0);
  const exit = await main([tool, action, ...args, '--session', f.session], f.deps);
  assert.equal(f.lines.length, 1);
  return {
    exit,
    output: parseJson(
      f.lines[0]!,
      shape({ ok: flag, reason: optional(jsonText), summary: jsonText, path: nullable(jsonText) }),
    ),
  };
}

async function completeFixture(f: Awaited<ReturnType<typeof fixture>>, head = HEAD, tree = TREE) {
  const worktree = path.join(f.session, '.state', 'worktrees', 'integration');
  fs.mkdirSync(worktree, { recursive: true });
  const dest = { path: f.root, branch: 'main' };
  const state = {
    session: f.session,
    head,
    tree,
    testedTree: tree,
    changes: [] as Array<{ status: string; path: string }>,
    calls: [] as Array<{ argv: Array<string>; locked: boolean }>,
  };
  f.deps.run = fakeGit(state);
  await appendRecord(
    f.session,
    {
      kind: 'integrate',
      by: 'tool',
      key: 'integrate:opened',
      data: {
        phase: 'opened',
        path: '.state/worktrees/integration',
        branch: 'dispatch/test/integration',
        base: 'c'.repeat(40),
        dest,
      },
    },
    f.deps,
  );
  const plan = loadPlan(f.session, readManifest(f.session));
  for (const check of checks(plan)) {
    await appendRecord(
      f.session,
      {
        kind: 'waiver',
        by: 'user',
        quote: `approved ${check.criterion}`,
        data: { criterion: check.criterion, reason: 'fixture completion' },
      },
      f.deps,
    );
  }
  await appendRecord(
    f.session,
    {
      kind: 'integrate',
      by: 'tool',
      key: 'integrate:delivered',
      data: { phase: 'delivered', mode: 'uncommitted', dest, from: head, source: head },
    },
    f.deps,
  );
  return state;
}

test('report render writes every missing criterion without Git and rewrites the same walkthrough', async () => {
  const f = await fixture();
  try {
    const first = await invoke(f, 'report', 'render');
    assert.equal(first.exit, 0);
    const walkthrough = path.join(f.session, 'report.walkthrough.md');
    const initial = fs.readFileSync(walkthrough, 'utf8');
    assert.match(initial, /## Runtime Proof\n\nNot recorded\./);
    const verification = initial.slice(
      initial.indexOf('## Verification'),
      initial.indexOf('## Deviations & Follow-ups'),
    );
    for (const id of ['SC1', 'SC2', 'SC3', 'SC4', 'contract']) {
      assert.match(verification, new RegExp(`- ${id} · no eligible evidence`));
    }
    assert.match(initial, /### Missing/);
    assert.match(initial, /## Behaviour Changes\n\n### T1 — Task 1/);
    assert.match(initial, /<details>\n\nNone\.\n\n<\/details>/);
    assert.equal(f.lines.length, 1);
    fs.writeFileSync(walkthrough, 'stale');
    const second = await invoke(f, 'report', 'render');
    assert.equal(second.exit, 0);
    assert.equal(fs.readFileSync(walkthrough, 'utf8'), initial);
  } finally {
    f.cleanup();
  }
});

test('report deferral renders only the latest ceiling deferrals as follow-ups', async () => {
  // report deferral: renders only the latest deferred escalations as follow-ups
  {
    const f = await fixture();
    try {
      const deferId = 'ceiling:plan-report.plan:1';
      const settledId = 'ceiling:plan-report.plan:2';
      for (const [id, step, summary] of [
        [deferId, 'initial', 're-author: separate the change'],
        [deferId, 'final', 'defer: revisit next release'],
        [settledId, 'initial', 'defer: revisit the split'],
        [settledId, 'final', 're-author: split the change'],
        ['ceiling:plan-report.plan:3', 'final', 'close: proceed with fixes'],
      ]) {
        await appendRecord(
          f.session,
          {
            kind: 'escalation',
            by: 'user',
            quote: summary,
            key: `${id}:${step}`,
            data: { id, state: 'resolved', summary },
          },
          f.deps,
        );
      }
      const result = await invoke(f, 'report', 'render');
      assert.equal(result.exit, 0, result.output.summary);
      const walkthrough = fs.readFileSync(path.join(f.session, 'report.walkthrough.md'), 'utf8');
      assert.match(walkthrough, /; 1 deferred escalations;/);
      assert.deepEqual(walkthrough.match(/^- Follow-up: deferred escalation .*$/gm), [
        `- Follow-up: deferred escalation ${deferId}: defer: revisit next release`,
      ]);
    } finally {
      f.cleanup();
    }
  }

  // report deferral: excludes non-ceiling defer escalations
  {
    const f = await fixture();
    try {
      const id = 'review-readiness';
      await appendRecord(
        f.session,
        {
          kind: 'escalation',
          by: 'user',
          quote: 'Revisit later',
          key: id + ':resolved',
          data: { id, state: 'resolved', summary: 'defer: revisit later' },
        },
        f.deps,
      );
      const result = await invoke(f, 'report', 'render');
      assert.equal(result.exit, 0, result.output.summary);
      const walkthrough = fs.readFileSync(path.join(f.session, 'report.walkthrough.md'), 'utf8');
      assert.doesNotMatch(walkthrough, /^- Follow-up: deferred escalation /m);
    } finally {
      f.cleanup();
    }
  }
});

test('report edit scope: reports the bound plan and spec edits when plans share a hash', async () => {
  const f = await fixture();
  try {
    const hashes = () => currentHashes(f.root, latest(foldLedger(f.session), 'bind'));
    const edit = (artifact: 'spec' | 'plan', before: string, after: string, rationale: string) =>
      appendRecord(
        f.session,
        {
          kind: 'edit',
          by: 'tool',
          key: `edit:${rationale}`,
          data: { artifact, before, after, class: 'intent', rationale, diffRef: 'edit.diff', affects: [] },
        },
        f.deps,
      );
    const initial = hashes();
    const editedPlan = planSource().replace('# Report fixture', '# First plan edited');
    f.artifact('report.plan.md', editedPlan);
    f.artifact('brief.spec.md', '# Brief updated\n');
    const updated = hashes();
    await edit('plan', initial.plan!, updated.plan!, 'updated the first plan');
    await edit('spec', initial.spec!, updated.spec!, 'updated the shared spec');

    f.artifact('next.plan.md', editedPlan);
    await appendRecord(
      f.session,
      {
        kind: 'bind',
        by: 'tool',
        key: 'bind:next',
        data: { spec: './brief.spec.md', plan: 'next.plan.md' },
      },
      f.deps,
    );
    assert.equal(hashes().plan, updated.plan);
    f.artifact('next.plan.md', editedPlan.replace('# First plan edited', '# Next plan edited'));
    await edit('plan', updated.plan!, hashes().plan!, 'updated the second plan');

    const result = await invoke(f, 'report', 'render');
    assert.equal(result.exit, 0, result.output.summary);
    const walkthrough = fs.readFileSync(path.join(f.session, 'next.walkthrough.md'), 'utf8');
    assert.match(walkthrough, /Deviation: spec edit .*updated the shared spec/);
    assert.match(walkthrough, /Deviation: plan edit .*updated the second plan/);
    assert.doesNotMatch(walkthrough, /Deviation: plan edit .*updated the first plan/);
    assert.match(walkthrough, /; 2 recorded edits;/);
  } finally {
    f.cleanup();
  }
});

test('report render keeps tool evidence for review criteria in the missing section', async () => {
  const source = planSource(1).replace(
    '  - Evidence: check',
    '  - Evidence: review\n  - Review: artifact: src/task-1.ts; scenario: inspect the change; pass: the user records review evidence',
  );
  const f = await fixture(1, source);
  try {
    fs.mkdirSync(path.join(f.session, '.state', 'worktrees', 'integration'), { recursive: true });
    const state = { session: f.session, head: HEAD, tree: TREE, testedTree: TREE, changes: [], calls: [] };
    f.deps.run = fakeGit(state);
    await appendRecord(
      f.session,
      {
        kind: 'integrate',
        by: 'tool',
        key: 'integrate:opened:review-report',
        data: {
          phase: 'opened',
          path: '.state/worktrees/integration',
          branch: 'dispatch/test/integration',
          base: 'c'.repeat(40),
          dest: { path: f.root, branch: 'main' },
        },
      },
      f.deps,
    );

    for (const check of checks(loadPlan(f.session, readManifest(f.session)))) {
      await appendRecord(
        f.session,
        {
          kind: 'evidence',
          by: 'tool',
          key: `review-report:${check.criterion}`,
          data: {
            criterion: check.criterion,
            commandDigest: check.commandDigest,
            tree: TREE,
            clean: true,
            before: TREE,
            after: TREE,
            exit: 0,
            path: `.state/evidence/${check.criterion}.json`,
          },
        },
        f.deps,
      );
    }

    const result = await invoke(f, 'report', 'render');
    assert.match(result.output.summary, /SC verified 1, manual 0, waived 0, missing 1/);
    const walkthrough = fs.readFileSync(path.join(f.session, 'report.walkthrough.md'), 'utf8');
    assert.match(walkthrough, /- SC1 · no eligible evidence/);
  } finally {
    f.cleanup();
  }
});

test('report render shows each completed review round link', async () => {
  const f = await fixture();
  try {
    for (const [round, id] of [
      [1, 'F001'],
      [2, 'F002'],
    ] as const) {
      const roundDir = path.join(f.session, '.state', 'reviews', 'review-alpha', `round-${round}`);
      writeJson(path.join(roundDir, 'round.json'), { round, generation: 1, cap: 4, roster: [] });
      writeJson(path.join(roundDir, 'findings.json'), { findings: [{ id, severity: 'SHOULD' }] });
    }

    const result = await invoke(f, 'report', 'render');
    assert.equal(result.exit, 0, result.output.summary);
    const walkthrough = fs.readFileSync(path.join(f.session, 'report.walkthrough.md'), 'utf8');
    assert.match(walkthrough, /\| review-alpha \| F001 \| 1 \| SHOULD \| — \| Open \|/);
    assert.match(walkthrough, /\| review-alpha \| F002 \| 2 \| SHOULD \| — \| Open \|/);
    assert.deepEqual(walkthrough.match(/^- Round \d+.*$/gm), [
      '- Round 1 (review-alpha): 1 findings — [findings](.state/reviews/review-alpha/round-1/findings.json)',
      '- Round 2 (review-alpha): 1 findings — [findings](.state/reviews/review-alpha/round-2/findings.json)',
    ]);
    assert.doesNotMatch(walkthrough, /^Findings:/m);
  } finally {
    f.cleanup();
  }
});

test('report render rejects early complete, unbound and positional input cases', async () => {
  const f = await fixture();
  try {
    const complete = await invoke(f, 'report', 'complete');
    assert.equal(complete.exit, 4);
    assert.equal(complete.output.reason, 'no-integration');
    assert.equal(fs.existsSync(path.join(f.session, 'report.walkthrough.md')), false);

    const unbound = sessionFixture({ memory: true });
    try {
      unbound.deps.skillRoot = f.skillRoot;
      const result = await invoke(unbound, 'report', 'render');
      assert.equal(result.exit, 4);
      assert.equal(result.output.reason, 'lint-errors');
    } finally {
      unbound.cleanup();
    }

    const positional = await invoke(f, 'report', 'render', 'unexpected');
    assert.equal(positional.exit, 1);
    assert.equal(positional.output.reason, 'invalid-input');
  } finally {
    f.cleanup();
  }
});

test('report render diagnostics toggle honors config setting for render and complete', async () => {
  // Diagnostics enabled
  const fEnabled = await fixture(1);
  try {
    fs.writeFileSync(path.join(fEnabled.skillRoot, 'config.local.jsonc'), '{"diagnostics": true}\n');
    const rendered = await invoke(fEnabled, 'report', 'render');
    assert.equal(rendered.exit, 0);
    assert.equal(fs.existsSync(path.join(fEnabled.session, 'diagnostics.md')), true);

    fs.rmSync(path.join(fEnabled.session, 'diagnostics.md'));
    await completeFixture(fEnabled);
    const completed = await invoke(fEnabled, 'report', 'complete');
    assert.equal(completed.exit, 0);
    assert.equal(fs.existsSync(path.join(fEnabled.session, 'diagnostics.md')), true);
  } finally {
    fEnabled.cleanup();
  }

  // Diagnostics disabled or absent
  const fDisabled = await fixture();
  try {
    fs.writeFileSync(path.join(fDisabled.skillRoot, 'config.local.jsonc'), '{"diagnostics": false}\n');
    const result = await invoke(fDisabled, 'report', 'render');
    assert.equal(result.exit, 0);
    assert.equal(fs.existsSync(path.join(fDisabled.session, 'diagnostics.md')), false);
    assert.equal('diagnostics' in JSON.parse(fs.readFileSync(result.output.path!, 'utf8')), false);
    await completeFixture(fDisabled);
    const complete = await invoke(fDisabled, 'report', 'complete');
    assert.equal(complete.exit, 0, complete.output.summary);
    assert.equal(fs.existsSync(path.join(fDisabled.session, 'diagnostics.md')), false);
  } finally {
    fDisabled.cleanup();
  }
});

test('report render maps invalid or unreadable config to config-invalid', async () => {
  const f = await fixture();
  try {
    // Malformed JSON and type errors
    for (const config of ['{"diagnostics":"yes"}\n', '{broken']) {
      fs.writeFileSync(path.join(f.skillRoot, 'config.local.jsonc'), config);
      const result = await invoke(f, 'report', 'render');
      assert.equal(result.exit, 2);
      assert.equal(result.output.reason, 'config-invalid');
      assert.equal(fs.existsSync(path.join(f.session, 'report.walkthrough.md')), false);
    }
    // Higher-precedence config read error does not fall through
    fs.rmSync(path.join(f.skillRoot, 'config.local.jsonc'));
    fs.mkdirSync(path.join(f.skillRoot, 'config.local.jsonc'));
    fs.writeFileSync(path.join(f.skillRoot, 'config.jsonc'), '{"diagnostics": true}\n');
    const result = await invoke(f, 'report', 'render');
    assert.equal(result.exit, 2);
    assert.equal(result.output.reason, 'config-invalid');
    assert.equal(fs.existsSync(path.join(f.session, 'diagnostics.md')), false);
  } finally {
    f.cleanup();
  }
});

test('diagnostics damage cannot suppress successful report completion', async () => {
  const f = await fixture(1);
  try {
    fs.writeFileSync(path.join(f.skillRoot, 'config.local.jsonc'), '{"diagnostics":true}');
    await completeFixture(f);
    fs.writeFileSync(path.join(f.session, '.state', 'retro.json'), '{bad');
    fs.mkdirSync(path.join(f.session, '.state', 'diagnostics'), { recursive: true });
    fs.writeFileSync(path.join(f.session, '.state', 'diagnostics', 'broken.json'), '{bad');
    const rendered = await invoke(f, 'report', 'render');
    assert.equal(rendered.exit, 0);
    assert.match(fs.readFileSync(path.join(f.session, 'diagnostics.md'), 'utf8'), /Collection health: partial/);
    fs.rmSync(path.join(f.session, 'diagnostics.md'));
    fs.mkdirSync(path.join(f.session, 'diagnostics.md'));
    const result = await invoke(f, 'report', 'complete');
    assert.equal(result.exit, 0, result.output.summary);
    assert.equal(result.output.ok, true);
    const value = JSON.parse(fs.readFileSync(result.output.path!, 'utf8'));
    assert.equal('diagnostics' in value, false);
    assert.ok(fs.existsSync(path.join(f.session, 'report.walkthrough.md')));
  } finally {
    f.cleanup();
  }
});

test('uncommitted consumers render the working-tree delivery from source with its retained ref', async () => {
  const f = await fixture(1);
  try {
    await completeFixture(f);
    const { appendRecord } = await import('../../../skills/dispatch/scripts/toolkit/ledger.ts');
    await appendRecord(
      f.session,
      {
        kind: 'integrate',
        by: 'tool',
        data: {
          phase: 'delivered',
          mode: 'uncommitted',
          dest: { path: f.root, branch: 'main' },
          from: 'c'.repeat(40),
          source: HEAD,
        },
      },
      f.deps,
    );
    const result = await invoke(f, 'report', 'render');
    assert.equal(result.exit, 0);
    const text = fs.readFileSync(path.join(f.session, 'report.walkthrough.md'), 'utf8');
    assert.match(
      text,
      /uncommitted changes from source aaaaaaaaaaaa in main working tree; ref refs\/dispatch\/[^\s/]+\/delivered-source/,
    );
    assert.doesNotMatch(text, /delivered [0-9a-f]{12} to main/);
  } finally {
    f.cleanup();
  }
});

test('review fix status: no current verification leaves the fix not verified', async () => {
  const f = await fixture(1);
  try {
    await completeFixture(f);
    stubReviewFixGit(f);
    const reviewFix = {
      review: 'code-integration',
      round: 3,
      generation: 1,
      findings: ['R3-F001'],
      from: 'c'.repeat(40),
    };
    await appendRecord(
      f.session,
      {
        kind: 'integrate',
        by: 'tool',
        data: { phase: 'fix', commit: 'd'.repeat(40), reason: 'repair accepted SHOULD', reviewFix },
      },
      f.deps,
    );
    const result = await invoke(f, 'report', 'render');
    assert.equal(result.exit, 0);
    const value = readJson(
      result.output.path!,
      shape({
        reviewFixes: listOf(shape({ commit: jsonText, metadata: anything, status: jsonText })),
        reviewedCodeBaseline: optional(jsonText),
      }),
    );
    assert.equal(value.reviewFixes.length, 1);
    assert.equal(value.reviewFixes[0]!.commit, 'd'.repeat(40));
    assert.deepEqual(value.reviewFixes[0]!.metadata, reviewFix);
    assert.equal(value.reviewFixes[0]!.status, 'not verified');
    assert.equal(value.reviewedCodeBaseline, undefined);
    const text = fs.readFileSync(path.join(f.session, 'report.walkthrough.md'), 'utf8');
    assert.match(text, /R3-F001/);
    assert.match(text, /not verified/i);
    assert.doesNotMatch(text, /verified but not re-reviewed/i);
  } finally {
    f.cleanup();
  }
});

test('review fix status: completed re-review retains earlier fixes and their paths after cleanup', async () => {
  const f = await fixture(1);
  try {
    const source = planSource(1).replace(
      '# Report fixture',
      [
        '# Report fixture',
        '',
        '> **Parent:** `brief.spec.md` · sha256:' + 'a'.repeat(64),
        '> **Decide:** none',
        '> **Risk:** med — inspect the delivered behavior',
        '> **Scope:** src',
        '',
        '## At a Glance',
        '- **What:** Plan output is delivered without a legacy summary.',
        '- **How it works:** The renderer joins the bound plan with ledger facts.',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(f.root, 'report.plan.md'), source);
    f.artifact(
      'parent.design.md',
      [
        '# Parent design',
        '',
        '## At a Glance',
        '- **What:** Requests pass through the gateway to storage.',
        '- **How it works:** The gateway validates requests before storage.',
        '',
        '- Text summary: The map shows the request boundary.',
        '',
        '| Component | Boundary |',
        '| --- | --- |',
        '| Gateway | Validates requests |',
        '| Store | Persists responses |',
        '',
        '```mermaid',
        'flowchart LR',
        '  Gateway --> Store',
        '```',
        '',
      ].join('\n'),
    );
    await appendRecord(
      f.session,
      {
        kind: 'bind',
        by: 'tool',
        key: 'bind:report:design',
        data: { spec: 'brief.spec.md', plan: 'report.plan.md', design: 'parent.design.md' },
      },
      f.deps,
    );
    await appendRecord(
      f.session,
      {
        kind: 'focus',
        by: 'orchestrator',
        key: 'focus:report',
        data: { bullets: [{ text: 'Inspect the delivered retry boundary.', evidence: 'evidence/retry-boundary.md' }] },
      },
      f.deps,
    );
    const priorReview = path.join(f.session, '.state/reviews/review-alpha/round-1');
    writeJson(path.join(priorReview, 'round.json'), {
      round: 1,
      generation: 1,
      cap: 3,
      spec: { path: '/work.spec.md', hash: 'x' },
      target: { base: 'c'.repeat(40), head: 'd'.repeat(40) },
      roster: [],
    });
    writeJson(path.join(priorReview, 'findings.json'), {
      review: 'review-alpha',
      round: 1,
      findings: [
        { id: 'R1-F001', severity: 'SHOULD' },
        { id: 'R1-F002', severity: 'SHOULD' },
      ],
      failed: [],
    });
    await appendRecord(
      f.session,
      {
        kind: 'ruling',
        by: 'orchestrator',
        key: 'reject-prior-should',
        data: { subject: 'review:review-alpha:R1-F001', ruling: 'rejected', rationale: 'The change is not needed' },
      },
      f.deps,
    );
    await appendRecord(
      f.session,
      {
        kind: 'ruling',
        by: 'orchestrator',
        key: 'defer-prior-should',
        data: { subject: 'review:review-alpha:R1-F002', ruling: 'deferred', rationale: 'More evidence is needed' },
      },
      f.deps,
    );
    const state = await completeFixture(f),
      baseline = state.head,
      commit = 'd'.repeat(40),
      tree = 'e'.repeat(40),
      reason = 'repair accepted SHOULD';
    state.head = commit;
    state.tree = tree;
    state.testedTree = tree;
    state.changes = [
      { status: 'M', path: 'src/task-1.ts' },
      { status: 'A', path: 'src/shared.ts' },
    ];
    const fold = foldLedger(f.session),
      artifacts = currentHashes(f.root, latest(fold, 'bind'));
    const reviewFix = { review: 'code-integration', round: 3, generation: 1, findings: ['R3-F001'], from: baseline };
    const reviewDir = path.join(f.session, '.state/reviews/code-integration/round-3');
    const finding = {
      id: 'R3-F001',
      severity: 'SHOULD',
      category: 'correctness',
      locus: 'src/task-1.ts:L1',
      defect: 'The assertion is wrong',
      requiredChange: 'Correct the assertion',
      sources: ['reviewer'],
      scope: 'in',
    };
    writeJson(path.join(reviewDir, 'round.json'), {
      round: 3,
      generation: 1,
      cap: 3,
      startSeq: fold.lastSeq,
      target: { base: 'c'.repeat(40), head: baseline },
      scope: 'Full review',
      artifacts,
      spec: { path: '/work.spec.md', hash: artifacts.spec },
      roster: [{ slot: 'reviewer', reserve: false }],
    });
    writeJson(path.join(reviewDir, 'findings.json'), {
      review: 'code-integration',
      round: 3,
      findings: [finding],
      failed: [],
    });
    writeJson(path.join(reviewDir, 'gen-1/slots/reviewer.json'), {
      slot: 'reviewer',
      state: 'done',
      text: JSON.stringify({
        status: 'FINDINGS',
        findings: [
          {
            impact: 'degrades',
            trigger: 'realistic',
            locus: 'src/task-1.ts:L1',
            tag: 'correctness',
            defect: finding.defect,
            requiredChange: finding.requiredChange,
          },
        ],
      }),
    });
    await appendRecord(
      f.session,
      {
        kind: 'ruling',
        by: 'orchestrator',
        key: 'accept-bounded-should',
        data: {
          subject: 'review:code-integration:R3-F001',
          ruling: 'accepted',
          rationale: 'The bounded correction is needed',
          paths: ['src/task-1.ts', 'src/shared.ts'],
        },
      },
      f.deps,
    );
    await appendRecord(
      f.session,
      { kind: 'integrate', by: 'tool', data: { phase: 'fix', commit, reason, reviewFix } },
      f.deps,
    );
    for (const check of checks(loadPlan(f.session, readManifest(f.session)))) {
      await appendRecord(
        f.session,
        {
          kind: 'evidence',
          by: 'tool',
          data: {
            criterion: check.criterion,
            commandDigest: check.commandDigest,
            tree,
            clean: true,
            before: tree,
            after: tree,
            exit: 0,
            path: '.state/evidence/' + check.criterion + '.json',
          },
        },
        f.deps,
      );
    }
    const metadata = reviewFixIdentity(reviewFix),
      message = [
        `fix(dispatch): ${reason}`,
        '',
        `Dispatch-Fix: ${readManifest(f.session).safeSessionId}`,
        `Dispatch-Review-Fix: ${metadata.digest}`,
        `Dispatch-Review-Fix-Data: ${metadata.data}`,
        '',
      ].join('\n');
    const git = fakeGit(state);
    f.deps.run = async (argv, options) => {
      const args = argv.slice(1);
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        assert.equal(options?.cwd, readManifest(f.session).repositoryRoot);
        return { exit: args[2] === args[3] ? 0 : 1, stdout: '', stderr: '' };
      }
      if (args[0] === 'rev-list' && args[1] === '--reverse' && args[2] === '--parents') {
        return gitOutput(`${commit} ${baseline}\n`);
      }
      if (args[0] === 'diff-tree' && args.includes(commit)) {
        return gitOutput('src/task-1.ts\0src/shared.ts\0');
      }
      if (args[0] === 'log' && args[1] === '-1' && args[2] === '--format=%B' && args[3] === commit) {
        return gitOutput(message);
      }
      return git(argv);
    };
    const result = await invoke(f, 'report', 'render');
    assert.equal(result.exit, 0);
    const value = readJson(
      result.output.path!,
      shape({
        reviewedCodeBaseline: optional(jsonText),
        reviewFixes: listOf(
          shape({
            status: jsonText,
            verification: optional(shape({ criteria: listOf(jsonText), contract: listOf(jsonText), tree: jsonText })),
          }),
        ),
      }),
    );
    assert.equal(value.reviewedCodeBaseline, baseline);
    assert.equal(value.reviewFixes[0]!.status, 'verified but not re-reviewed');
    assert.deepEqual(value.reviewFixes[0]!.verification?.criteria, ['SC1']);
    assert.deepEqual(value.reviewFixes[0]!.verification?.contract, ['contract']);
    assert.equal(value.reviewFixes[0]!.verification?.tree, tree);
    const text = fs.readFileSync(path.join(f.session, 'report.walkthrough.md'), 'utf8');
    assert.match(text, /- \*\*What:\*\* Plan output is delivered without a legacy summary\./);
    const focus = text.slice(text.indexOf('## Review Focus'), text.indexOf('## Behaviour Changes'));
    assert.match(focus, /Risk: med/);
    assert.match(focus, /Rejected SHOULD finding review-alpha:R1-F001/);
    assert.match(focus, /Deferred finding review-alpha:R1-F002 — see Deviations & Follow-ups/);
    assert.doesNotMatch(focus, /More evidence is needed/i);
    assert.match(
      focus,
      /Inspect the delivered retry boundary\. — Evidence: \[evidence\/retry-boundary\.md\]\(evidence\/retry-boundary\.md\)/,
    );
    const deviations = text.slice(
      text.indexOf('## Deviations & Follow-ups'),
      text.indexOf('## Review Findings & Resolutions'),
    );
    assert.match(deviations, /- Follow-up: deferred review-alpha:R1-F002/);
    const visuals = text.slice(text.indexOf('## Visuals'), text.indexOf('## Review Focus'));
    assert.match(visuals, /\[design visuals\]\(/);
    assert.doesNotMatch(visuals, /\| Component \| Boundary \|/);
    const bind = latest(foldLedger(f.session), 'bind')!;
    const hashes = currentHashes(f.root, bind),
      appendix = text.slice(text.indexOf('## Appendix'));
    assert.ok(
      appendix.indexOf(
        `Spec: [brief.spec.md](${path.relative(f.session, path.join(f.root, 'brief.spec.md')).replaceAll('\\', '/')}) · sha256:${hashes.spec!.slice(7, 19)}`,
      ) !== -1,
    );
    assert.ok(
      appendix.indexOf(
        `Plan: [report.plan.md](${path.relative(f.session, path.join(f.root, 'report.plan.md')).replaceAll('\\', '/')}) · sha256:${hashes.plan!.slice(7, 19)}`,
      ) !== -1,
    );
    assert.doesNotMatch(appendix, /Review Fixes/);
    const nextDir = path.join(f.session, '.state/reviews/code-integration/round-4');
    writeJson(path.join(nextDir, 'round.json'), {
      round: 4,
      generation: 1,
      cap: 3,
      startSeq: foldLedger(f.session).lastSeq,
      target: { base: 'c'.repeat(40), head: commit },
      scope: 'Re-review round 4 (full)',
      artifacts,
      spec: { path: '/work.spec.md', hash: artifacts.spec },
      roster: [{ slot: 'reviewer', reserve: false }],
    });
    writeJson(path.join(nextDir, 'findings.json'), { review: 'code-integration', round: 4, findings: [], failed: [] });
    writeJson(path.join(nextDir, 'gen-1/slots/reviewer.json'), {
      slot: 'reviewer',
      state: 'done',
      text: JSON.stringify({ status: 'CLEAN', findings: [] }),
    });
    const reviewed = await invoke(f, 'report', 'render');
    assert.equal(reviewed.exit, 0);
    const reviewedValue = JSON.parse(fs.readFileSync(reviewed.output.path!, 'utf8'));
    assert.equal(
      reviewedValue.reviewFixes[0]?.status,
      're-reviewed',
      'Retain the fix after the integration review starts after it',
    );
    assert.match(focus, /Review fix R3-F001: verified but not re-reviewed — see Deviations & Follow-ups/);
    assert.match(
      deviations,
      /- Deviation: review fix R3-F001: verified but not re-reviewed; commit dddddddddddd; paths src\/task-1\.ts, src\/shared\.ts/,
    );
    const unfinished = path.join(f.session, '.state/reviews/code-integration/round-5');
    writeJson(path.join(unfinished, 'round.json'), {
      round: 5,
      generation: 2,
      target: { head: commit },
      scope: 'Re-review round 5 (full)',
    });
    for (const removed of [false, true]) {
      if (removed) {
        fs.rmSync(path.join(f.session, '.state/worktrees/integration'), { recursive: true });
      }
      const rendered = await invoke(f, 'report', 'render');
      assert.equal(rendered.exit, 0, rendered.output.summary);
      const value = JSON.parse(fs.readFileSync(rendered.output.path!, 'utf8'));
      assert.equal(value.reviewedCodeBaseline, undefined);
      const fix = value.reviewFixes[0];
      assert.equal(fix?.status, 're-reviewed');
      assert.deepEqual(fix?.paths, ['src/task-1.ts', 'src/shared.ts']);
      const text = fs.readFileSync(path.join(f.session, 'report.walkthrough.md'), 'utf8');
      assert.doesNotMatch(
        text.slice(text.indexOf('## Review Focus'), text.indexOf('## Behaviour Changes')),
        /Review fix R3-F001/,
      );
      assert.match(
        text,
        /- Deviation: review fix R3-F001: re-reviewed; commit dddddddddddd; paths src\/task-1\.ts, src\/shared\.ts/,
      );
    }
    assert.doesNotMatch(
      fs.readFileSync(path.join(f.session, 'report.walkthrough.md'), 'utf8'),
      /Code Review Corrections/,
    );
  } finally {
    f.cleanup();
  }
});

function stubReviewFixGit(f: Awaited<ReturnType<typeof fixture>>, ancestor = false) {
  const git = f.deps.run;
  f.deps.run = async (argv, options) => {
    if (argv[1] === 'diff-tree' || argv[1] === 'merge-base') {
      assert.equal(options?.cwd, readManifest(f.session).repositoryRoot);
      if (argv[1] === 'diff-tree') {
        assert.deepEqual(argv.slice(2, 7), ['--no-commit-id', '--name-only', '--no-renames', '-r', '-z']);
        return { exit: 0, stdout: 'src/task-1.ts\0', stderr: '' };
      }
      return { exit: ancestor && argv[4] === HEAD ? 0 : 1, stdout: '', stderr: '' };
    }
    return git(argv, options);
  };
}

for (const roundKind of ['unfinished', 'all-failed', 'confirmation-only'] as const) {
  test('review fix status: ' + roundKind + ' rounds do not count as re-review', async () => {
    const f = await fixture(1);
    try {
      await completeFixture(f);
      stubReviewFixGit(f, true);
      const commit = 'd'.repeat(40),
        reviewFix = {
          review: 'code-integration',
          round: 1,
          generation: 1,
          findings: ['R1-F001'],
          from: 'c'.repeat(40),
        };
      await appendRecord(
        f.session,
        { kind: 'integrate', by: 'tool', data: { phase: 'fix', commit, reason: 'repair', reviewFix } },
        f.deps,
      );
      for (const check of checks(loadPlan(f.session, readManifest(f.session)))) {
        await appendRecord(
          f.session,
          {
            kind: 'evidence',
            by: 'tool',
            data: {
              criterion: check.criterion,
              commandDigest: check.commandDigest,
              tree: TREE,
              clean: true,
              before: TREE,
              after: TREE,
              exit: 0,
              path: '.state/evidence/' + check.criterion + '.json',
            },
          },
          f.deps,
        );
      }
      const dir = path.join(f.session, '.state/reviews/code-integration/round-2');
      const roster = [
        { slot: 'codex[0]', reserve: false },
        { slot: 'codex[1]', reserve: true },
      ];
      writeJson(path.join(dir, 'round.json'), {
        round: 2,
        generation: 2,
        target: { head: HEAD },
        scope: roundKind === 'confirmation-only' ? 'Re-review round 2 (confirmation-only)' : 'Re-review round 2 (full)',
        roster,
      });
      if (roundKind !== 'unfinished') {
        writeJson(path.join(dir, 'findings.json'), { findings: [], failed: [] });
      }
      for (const generation of [1, 2]) {
        const outcome =
          generation === 2 && roundKind === 'all-failed'
            ? { slot: 'codex[0]', state: 'failed', cls: 'timeout', reason: 'timeout' }
            : { slot: 'codex[0]', state: 'done', text: '{}' };
        writeJson(path.join(dir, 'gen-' + generation, 'slots/codex[0].json'), outcome);
      }
      const status = async () => {
        const result = await invoke(f, 'report', 'render');
        assert.equal(result.exit, 0, result.output.summary);
        return readJson(result.output.path!, shape({ reviewFixes: listOf(shape({ status: jsonText })) })).reviewFixes[0]
          ?.status;
      };
      assert.equal(await status(), 'verified but not re-reviewed');
      if (roundKind === 'unfinished') {
        fs.rmSync(path.join(f.session, '.state/worktrees/integration'), { recursive: true });
        assert.equal(await status(), 'not verified');
      }
      if (roundKind === 'all-failed') {
        writeJson(path.join(dir, 'gen-2/slots/codex[0].json'), {
          slot: 'codex[0]',
          state: 'done',
          text: '{}',
          responder: { slot: 'codex[1]' },
        });
        assert.equal(await status(), 're-reviewed');
      }
    } finally {
      f.cleanup();
    }
  });
}

test('walkthrough reports coverage unreadable state and open slots beside review-fix records', async () => {
  const f = await fixture(1);
  try {
    await completeFixture(f);
    stubReviewFixGit(f);
    const reviewFix = {
      review: 'code-integration',
      round: 1,
      generation: 1,
      findings: ['R1-F001'],
      from: 'c'.repeat(40),
    };
    await appendRecord(
      f.session,
      {
        kind: 'integrate',
        by: 'tool',
        data: { phase: 'fix', commit: 'd'.repeat(40), reason: 'repair accepted SHOULD', reviewFix },
      },
      f.deps,
    );
    const dir = path.join(f.session, '.state/reviews/code-integration/round-1'),
      slots = path.join(dir, 'gen-1/slots');
    writeJson(path.join(dir, 'round.json'), {
      round: 1,
      generation: 1,
      cap: 3,
      startSeq: 0,
      scope: 'Full review',
      target: { base: 'c'.repeat(40), head: HEAD },
      spec: { path: path.join(f.root, 'brief.spec.md'), hash: 'sha256:' + 'a'.repeat(64) },
      roster: [
        { slot: 'codex[0]', reserve: false },
        { slot: 'opencode[1]', reserve: false },
      ],
    });
    writeJson(path.join(dir, 'findings.json'), { review: 'code-integration', round: 1, findings: [], failed: [] });
    writeJson(path.join(slots, 'opencode[1].json'), { slot: 'opencode[1]', state: 'done', text: '{}' });
    writeJson(path.join(slots, 'codex[0].json'), { slot: 'codex[0]', state: 'failed', cls: 'timeout', reason: 'slow' });
    const render = async () => {
      const result = await invoke(f, 'report', 'render');
      assert.equal(result.exit, 0, result.output.summary);
      return fs.readFileSync(path.join(f.session, 'report.walkthrough.md'), 'utf8');
    };
    // A failed slot file with no failure entry cannot be trusted, yet the report still renders.
    const unreadable = await render();
    assert.match(unreadable, /^- Coverage state unreadable$/m);
    assert.match(unreadable, /R1-F001/);
    writeJson(path.join(dir, 'gen-1/attempts.json'), [
      { slot: 'codex[0]', seq: 1, wholeTarget: true, outcome: 'timeout' },
    ]);
    assert.match(await render(), /^- Open coverage slots: codex\[0\]$/m);
  } finally {
    f.cleanup();
  }
});

test('report render shows runtime proof', async () => {
  const f = await fixture();
  try {
    await completeFixture(f);
    const add = (data: JsonObject) => appendRecord(f.session, { kind: 'integrate', by: 'orchestrator', data }, f.deps);
    await add({
      phase: 'verification',
      cycle: 1,
      outcome: 'proved',
      head: HEAD,
      reason: 'exercised',
      open: [],
      report: 'verification/report.md',
      artifacts: ['verification/proof.png'],
      dirty: true,
    });
    assert.equal((await invoke(f, 'report', 'render')).exit, 0);
    const first = fs.readFileSync(path.join(f.session, 'report.walkthrough.md'), 'utf8');
    assert.ok(!first.includes('Not recorded.'));
    assert.ok(first.includes('- **Outcome:** proved'));
    assert.ok(first.includes(`- **HEAD:** \`${HEAD}\` plus uncommitted changes`));
    assert.ok(first.includes('- **Reason:** exercised'));
    assert.ok(first.includes('- [verification/report.md](verification/report.md)'));
    assert.ok(first.includes('- [verification/proof.png](verification/proof.png)'));
    const cleanupCommit = 'f'.repeat(40);
    await add({
      phase: 'test-cleanup',
      from: HEAD,
      fromTree: TREE,
      to: cleanupCommit,
      removed: ['SC1'],
      deleted: 1,
      merged: 0,
      trees: { SC1: TREE },
    });
    await add({ phase: 'fix', commit: TREE, reason: 'repair' });
    await add({
      phase: 'verification',
      cycle: 2,
      outcome: 'partial',
      head: TREE,
      reason: 'limited',
      open: [],
      report: 'verification/report.md',
    });
    assert.equal((await invoke(f, 'report', 'render')).exit, 0);
    const text = fs.readFileSync(path.join(f.session, 'report.walkthrough.md'), 'utf8');
    assert.ok(text.includes('- **Outcome:** partial'));
    assert.ok(!text.includes('- **Outcome:** proved'));
    assert.ok(text.includes(`- **HEAD:** \`${TREE}\``));
    assert.ok(text.includes('- **Reason:** limited'));
    assert.ok(text.includes('- [verification/report.md](verification/report.md)'));
    assert.ok(text.includes(`- Fix \`${TREE}\`: repair (before latest re-check; see report)`));
    assert.ok(!text.includes(cleanupCommit));
  } finally {
    f.cleanup();
  }
});

test('report carries cleanup evidence trees into the walkthrough view', async () => {
  const f = await fixture();
  try {
    await completeFixture(f);
    const cleanupFrom = 'd'.repeat(40);
    const earlyTree = 'c'.repeat(40);
    const cleanupCommit = 'f'.repeat(40);
    const check = checks(loadPlan(f.session, readManifest(f.session))).find((row) => row.criterion === 'SC1')!;
    await appendRecord(
      f.session,
      {
        kind: 'evidence',
        by: 'tool',
        key: 'early-sc1',
        data: {
          criterion: 'SC1',
          commandDigest: check.commandDigest,
          tree: earlyTree,
          clean: true,
          before: earlyTree,
          after: earlyTree,
          exit: 0,
          path: '.state/evidence/early-sc1.json',
        },
      },
      f.deps,
    );
    await appendRecord(
      f.session,
      {
        kind: 'integrate',
        by: 'tool',
        data: {
          phase: 'test-cleanup',
          from: cleanupFrom,
          fromTree: TREE,
          to: cleanupCommit,
          removed: ['SC1'],
          deleted: 1,
          merged: 0,
          trees: { SC1: earlyTree },
        },
      },
      f.deps,
    );
    assert.equal((await invoke(f, 'report', 'render')).exit, 0);
    const text = fs.readFileSync(path.join(f.session, 'report.walkthrough.md'), 'utf8');
    assert.ok(
      text.includes(
        `- **Test cleanup:** deleted 1 · merged 0 tests; criteria with tests removed: SC1 at ${earlyTree.slice(0, 12)}`,
      ),
    );
    assert.ok(text.includes(`verified at ${earlyTree}; tests removed in cleanup`));
    assert.ok(!text.includes(cleanupFrom.slice(0, 12)));
  } finally {
    f.cleanup();
  }
});

test('reportFacts reports missing after a later failure on the same tree', async () => {
  const f = await fixture(1);
  try {
    fs.mkdirSync(path.join(f.session, '.state', 'worktrees', 'integration'), { recursive: true });
    const state = {
      session: f.session,
      head: HEAD,
      tree: TREE,
      testedTree: TREE,
      changes: [] as Array<{ status: string; path: string }>,
      calls: [] as Array<{ argv: Array<string>; locked: boolean }>,
    };
    f.deps.run = fakeGit(state);
    await appendRecord(
      f.session,
      {
        kind: 'integrate',
        by: 'tool',
        key: 'integrate:opened:report-strict',
        data: {
          phase: 'opened',
          path: '.state/worktrees/integration',
          branch: 'dispatch/test/integration',
          base: 'c'.repeat(40),
          dest: { path: f.root, branch: 'main' },
        },
      },
      f.deps,
    );
    const planChecks = checks(loadPlan(f.session, readManifest(f.session)));
    const sc1 = planChecks.find((row) => row.criterion === 'SC1')!;
    const contract = planChecks.find((row) => row.criterion === 'contract')!;
    await appendRecord(
      f.session,
      {
        kind: 'evidence',
        by: 'tool',
        key: 'ev-contract-pass',
        data: {
          criterion: 'contract',
          commandDigest: contract.commandDigest,
          tree: TREE,
          clean: true,
          before: TREE,
          after: TREE,
          exit: 0,
          path: '.state/evidence/contract.json',
        },
      },
      f.deps,
    );
    await appendRecord(
      f.session,
      {
        kind: 'evidence',
        by: 'tool',
        key: 'ev-sc1-pass',
        data: {
          criterion: 'SC1',
          commandDigest: sc1.commandDigest,
          tree: TREE,
          clean: true,
          before: TREE,
          after: TREE,
          exit: 0,
          path: '.state/evidence/sc1-pass.json',
        },
      },
      f.deps,
    );

    const passed = await invoke(f, 'report', 'render');
    assert.equal(passed.exit, 0);
    assert.match(passed.output.summary, /SC verified 2, manual 0, waived 0, missing 0/);

    await appendRecord(
      f.session,
      {
        kind: 'evidence',
        by: 'tool',
        key: 'ev-sc1-fail',
        data: {
          criterion: 'SC1',
          commandDigest: sc1.commandDigest,
          tree: TREE,
          clean: true,
          before: TREE,
          after: TREE,
          exit: 1,
          path: '.state/evidence/sc1-fail.json',
        },
      },
      f.deps,
    );

    const failed = await invoke(f, 'report', 'render');
    assert.equal(failed.exit, 0);
    assert.match(failed.output.summary, /SC verified 1, manual 0, waived 0, missing 1/);
    const walkthrough = fs.readFileSync(path.join(f.session, 'report.walkthrough.md'), 'utf8');
    assert.match(walkthrough, /- SC1 · no eligible evidence/);
  } finally {
    f.cleanup();
  }
});
