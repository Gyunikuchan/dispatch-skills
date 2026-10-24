import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { appendRecord } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { checks, loadPlan } from '../../../skills/dispatch/scripts/toolkit/plan-view.ts';
import { readManifest } from '../../../skills/dispatch/scripts/lib/session.ts';
import { fakeGit } from './helpers/fake-git.ts';
import { sessionFixture } from './helpers/session.ts';

const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(value) + '\n');
}

function planSource(count = 4): string {
  const ids = Array.from({ length: count }, (_, index) => `SC${index + 1}`);
  const lines = [
    '# Report fixture', '',
    '## Task Map',
    '| ID | Title | Outcome | Prerequisites | Criteria |',
    '| --- | --- | --- | --- | --- |',
    ...ids.map((id, index) => `| T${index + 1} | Task ${index + 1} | Works | none | ${id} |`),
    '', '## Proposed Changes',
  ];
  ids.forEach((_id, index) => lines.push(
    `### T${index + 1} — Task ${index + 1}`,
    `#### [NEW] src/task-${index + 1}.ts`,
    '- Purpose: implements the fixture behavior.', '',
  ));
  lines.push('## Success Criteria');
  ids.forEach((id, index) => lines.push(
    `- [${id}] Criterion ${index + 1} works`,
    `  - Changes: src/task-${index + 1}.ts`,
    `  - Verify: \`node verify-${index + 1}.js\``,
    '  - Evidence: verify',
  ));
  lines.push('', '## Verification Plan', '### Automated Tests',
    ...ids.map((_id, index) => `- \`node verify-${index + 1}.js\``),
    '- `node contract-check.js`', '');
  return lines.join('\n');
}

async function fixture(count = 4) {
  const f = sessionFixture();
  const skillRoot = path.join(f.root, 'isolated-skill');
  fs.mkdirSync(skillRoot);
  f.deps.skillRoot = skillRoot;
  f.artifact('brief.spec.md', '# Brief\n');
  f.artifact('report.plan.md', planSource(count));
  await appendRecord(f.session, {
    kind: 'bind', by: 'tool', key: 'bind:report',
    data: { spec: 'brief.spec.md', plan: 'report.plan.md' },
  }, f.deps);
  return { ...f, skillRoot };
}

async function invoke(f: ReturnType<typeof sessionFixture>, tool: string, action: string, ...args: string[]) {
  f.lines.splice(0);
  const exit = await main([tool, action, ...args, '--session', f.session], f.deps);
  assert.equal(f.lines.length, 1);
  return { exit, output: JSON.parse(f.lines[0]!) as { ok: boolean; reason?: string; summary: string; path: string | null } };
}

async function completeFixture(f: Awaited<ReturnType<typeof fixture>>, head = HEAD, tree = TREE) {
  const worktree = path.join(f.session, '.state', 'worktrees', 'integration');
  fs.mkdirSync(worktree, { recursive: true });
  const dest = { path: f.root, branch: 'main' };
  const state = { session: f.session, head, tree, testedTree: tree, changes: [] as { status: string; path: string }[], calls: [] as { argv: string[]; locked: boolean }[] };
  f.deps.run = fakeGit(state);
  await appendRecord(f.session, {
    kind: 'integrate', by: 'tool', key: 'integrate:opened',
    data: { phase: 'opened', path: '.state/worktrees/integration', branch: 'dispatch/test/integration', base: 'c'.repeat(40), dest },
  }, f.deps);
  const plan = loadPlan(f.session, readManifest(f.session));
  for (const check of checks(plan)) {
    await appendRecord(f.session, {
      kind: 'waiver', by: 'user', quote: `approved ${check.criterion}`,
      data: { criterion: check.criterion, reason: 'fixture completion' },
    }, f.deps);
  }
  await appendRecord(f.session, {
    kind: 'integrate', by: 'tool', key: 'integrate:delivered',
    data: { phase: 'delivered', dest, to: head },
  }, f.deps);
  return state;
}

test('report render writes every missing criterion without Git and rewrites the same walkthrough', async () => {
  const f = await fixture();
  try {
    const first = await invoke(f, 'report', 'render');
    assert.equal(first.exit, 0);
    const walkthrough = path.join(f.session, 'report.walkthrough.md');
    const initial = fs.readFileSync(walkthrough, 'utf8');
    for (const id of ['SC1', 'SC2', 'SC3', 'SC4', 'contract']) {
      assert.match(initial, new RegExp(`\\| ${id} \\| no eligible evidence \\|`));
    }
    assert.match(initial, /### Missing/);
    assert.match(initial, /## Changes Made\n\nNone\./);
    assert.equal(f.lines.length, 1);
    fs.writeFileSync(walkthrough, 'stale');
    const second = await invoke(f, 'report', 'render');
    assert.equal(second.exit, 0);
    assert.equal(fs.readFileSync(walkthrough, 'utf8'), initial);
  } finally { f.cleanup(); }
});

test('report render keeps historical review rows and links only the latest findings file', async () => {
  const f = await fixture();
  try {
    for (const [round, id] of [[1, 'F001'], [2, 'F002']] as const) {
      const roundDir = path.join(f.session, '.state', 'reviews', 'review-alpha', `round-${round}`);
      writeJson(path.join(roundDir, 'round.json'), {round, generation: 1, cap: 4, roster: []});
      writeJson(path.join(roundDir, 'findings.json'), {findings: [{id, severity: 'SHOULD'}]});
    }

    const result = await invoke(f, 'report', 'render');
    assert.equal(result.exit, 0, result.output.summary);
    const walkthrough = fs.readFileSync(path.join(f.session, 'report.walkthrough.md'), 'utf8');
    assert.match(walkthrough, /\| review-alpha \| F001 \| 1 \| SHOULD \| Open \|/);
    assert.match(walkthrough, /\| review-alpha \| F002 \| 2 \| SHOULD \| Open \|/);
    assert.deepEqual(walkthrough.match(/^Findings: .*$/gm), [
      'Findings: .state/reviews/review-alpha/round-2/findings.json',
    ]);
  } finally { f.cleanup(); }
});

test('report render rejects early complete, unbound and positional input cases', async () => {
  const f = await fixture();
  try {
    const complete = await invoke(f, 'report', 'complete');
    assert.equal(complete.exit, 4);
    assert.equal(complete.output.reason, 'no-integration');
    assert.equal(fs.existsSync(path.join(f.session, 'report.walkthrough.md')), false);

    const unbound = sessionFixture();
    try {
      unbound.deps.skillRoot = f.skillRoot;
      const result = await invoke(unbound, 'report', 'render');
      assert.equal(result.exit, 4);
      assert.equal(result.output.reason, 'lint-errors');
    } finally { unbound.cleanup(); }

    const positional = await invoke(f, 'report', 'render', 'unexpected');
    assert.equal(positional.exit, 1);
    assert.equal(positional.output.reason, 'invalid-input');
  } finally { f.cleanup(); }
});

test('report render diagnostics toggle writes only when enabled for render and complete', async () => {
  const f = await fixture(1);
  try {
    fs.writeFileSync(path.join(f.skillRoot, 'config.local.jsonc'), '{"diagnostics": true}\n');
    const rendered = await invoke(f, 'report', 'render');
    assert.equal(rendered.exit, 0);
    assert.equal(fs.existsSync(path.join(f.session, 'diagnostics.md')), true);

    fs.rmSync(path.join(f.session, 'diagnostics.md'));
    await completeFixture(f);
    const completed = await invoke(f, 'report', 'complete');
    assert.equal(completed.exit, 0);
    assert.equal(fs.existsSync(path.join(f.session, 'diagnostics.md')), true);
  } finally { f.cleanup(); }
});

test('report render diagnostics false and absent config do not write diagnostics', async () => {
  for (const config of ['{"diagnostics": false}\n', null]) {
    const f = await fixture();
    try {
      if (config !== null) fs.writeFileSync(path.join(f.skillRoot, 'config.local.jsonc'), config);
      const result = await invoke(f, 'report', 'render');
      assert.equal(result.exit, 0);
      assert.equal(fs.existsSync(path.join(f.session, 'diagnostics.md')), false);
      await completeFixture(f);
      const complete = await invoke(f, 'report', 'complete');
      assert.equal(complete.exit, 0, complete.output.summary);
      assert.equal(fs.existsSync(path.join(f.session, 'diagnostics.md')), false);
    } finally { f.cleanup(); }
  }
});

test('report render maps invalid diagnostics config to config-invalid', async () => {
  for (const config of ['{"diagnostics":"yes"}\n', '{broken', '[]\n']) {
    const f = await fixture();
    try {
      fs.writeFileSync(path.join(f.skillRoot, 'config.local.jsonc'), config);
      const result = await invoke(f, 'report', 'render');
      assert.equal(result.exit, 2);
      assert.equal(result.output.reason, 'config-invalid');
      assert.equal(fs.existsSync(path.join(f.session, 'report.walkthrough.md')), false);
    } finally { f.cleanup(); }
  }
});

test('report render does not fall through after a higher-precedence config read error', async () => {
  const f = await fixture();
  try {
    fs.mkdirSync(path.join(f.skillRoot, 'config.local.jsonc'));
    fs.writeFileSync(path.join(f.skillRoot, 'config.jsonc'), '{"diagnostics": true}\n');
    const result = await invoke(f, 'report', 'render');
    assert.equal(result.exit, 2);
    assert.equal(result.output.reason, 'config-invalid');
    assert.equal(fs.existsSync(path.join(f.session, 'diagnostics.md')), false);
  } finally { f.cleanup(); }
});
