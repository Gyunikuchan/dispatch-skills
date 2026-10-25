import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { readManifest } from '../../../skills/dispatch/scripts/lib/session.ts';
import { currentHashes, foldLedger, latest } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { checks, loadPlan } from '../../../skills/dispatch/scripts/toolkit/plan-view.ts';
import { stableValue } from '../../../skills/dispatch/scripts/toolkit/domain/stable-value.ts';
import { fakeGit, type FakeGitState } from './helpers/fake-git.ts';
import { sessionFixture } from './helpers/session.ts';

const HEAD_A = 'a'.repeat(40);
const TREE_A = 'b'.repeat(40);
const HEAD_B = 'c'.repeat(40);
const TREE_B = 'd'.repeat(40);
const DIRTY_TREE = 'e'.repeat(40);

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

let eventNumber = 0;

async function fixture(count = 4) {
  const f = sessionFixture();
  const skillRoot = path.join(f.root, 'isolated-skill');
  fs.mkdirSync(skillRoot);
  fs.writeFileSync(path.join(skillRoot, 'config.local.jsonc'), '{"diagnostics": false}\n');
  f.deps.skillRoot = skillRoot;
  f.artifact('brief.spec.md', '# Brief\n');
  f.artifact('report.plan.md', planSource(count));
  await append(f, {
    kind: 'bind', by: 'tool', key: `bind:${++eventNumber}`,
    data: { spec: 'brief.spec.md', plan: 'report.plan.md' },
  });
  return { ...f, skillRoot };
}

async function invoke(f: ReturnType<typeof sessionFixture>, tool: string, action: string, ...args: string[]) {
  f.lines.splice(0);
  const exit = await main([tool, action, ...args, '--session', f.session], f.deps);
  assert.equal(f.lines.length, 1);
  return { exit, output: JSON.parse(f.lines[0]!) as { ok: boolean; reason?: string; summary: string; path: string | null } };
}

async function append(f: ReturnType<typeof sessionFixture>, record: Record<string, unknown>) {
  const file = f.artifact(`event-${++eventNumber}.json`, JSON.stringify(record));
  const result = await invoke(f, 'ledger', 'append', file);
  assert.equal(result.exit, 0, result.output.summary);
  return result.output;
}

async function integrate(f: ReturnType<typeof sessionFixture>, state: FakeGitState, dest = { path: f.root, branch: 'main' }) {
  const worktree = path.join(f.session, '.state', 'worktrees', 'integration');
  fs.mkdirSync(worktree, { recursive: true });
  state.session = f.session;
  f.deps.run = fakeGit(state);
  await append(f, {
    kind: 'integrate', by: 'tool', key: `integrate:opened:${++eventNumber}`,
    data: { phase: 'opened', path: '.state/worktrees/integration', branch: 'dispatch/test/integration', base: 'f'.repeat(40), dest },
  });
  return worktree;
}

async function evidence(f: ReturnType<typeof sessionFixture>, criterion: string, commandDigest: string, tree: string) {
  const data = { criterion, commandDigest, tree, clean: true, before: tree, after: tree, exit: 0 };
  const digest = crypto.createHash('sha256').update(stableValue(data)).digest('hex');
  const evidencePath = `.state/evidence/${digest}.json`;
  const evidenceFile = path.join(f.session, evidencePath);
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  fs.writeFileSync(evidenceFile, JSON.stringify(data));
  await append(f, {
    kind: 'evidence', by: 'tool', key: `evidence:${digest}`,
    data: { ...data, path: evidencePath },
  });
  return evidencePath;
}

async function evidenceForPlan(f: ReturnType<typeof sessionFixture>, tree: string, criteria?: string[]) {
  const plan = loadPlan(f.session, readManifest(f.session));
  const rows = checks(plan).filter((check) => !criteria || criteria.includes(check.criterion));
  const paths = new Map<string, string>();
  for (const row of rows) paths.set(row.criterion, await evidence(f, row.criterion, row.commandDigest, tree));
  return paths;
}

function gitState(session: string, head = HEAD_A, tree = TREE_A, testedTree = tree): FakeGitState {
  return { session, head, tree, testedTree, changes: [], calls: [] };
}

async function deliver(f: ReturnType<typeof sessionFixture>, head: string, dest = { path: f.root, branch: 'main' }) {
  await append(f, {
    kind: 'integrate', by: 'tool', key: `integrate:delivered:${++eventNumber}`,
    data: { phase: 'delivered', dest, to: head },
  });
}

test('report complete statuses enforces user records and counts unique integrated tasks', async () => {
  const f = await fixture(4);
  try {
    const state = gitState(f.session);
    await integrate(f, state);
    const producerPath = (await evidenceForPlan(f, TREE_A, ['SC1'])).get('SC1')!;
    for (const criterion of ['SC4', 'contract']) {
      await append(f, { kind: 'waiver', by: 'user', quote: `${criterion} approved`, data: { criterion, reason: 'accepted exception' } });
    }
    const malformedReview = path.join(f.session, '.state', 'reviews', 'malformed-review', 'round-1', 'round.json');
    fs.mkdirSync(path.dirname(malformedReview), {recursive: true});
    fs.writeFileSync(malformedReview, '{invalid');

    let result = await invoke(f, 'report', 'complete');
    assert.equal(result.exit, 4);
    assert.equal(result.output.reason, 'criteria-unmet');
    assert.match(result.output.summary, /SC2/);
    assert.match(result.output.summary, /SC3/);
    assert.equal(state.calls.some(({argv}) => argv[1] === 'diff'), false);
    assert.equal(fs.existsSync(path.join(f.session, 'report.walkthrough.md')), false);
    fs.rmSync(path.dirname(malformedReview), {recursive: true, force: true});

    const bad = await invoke(f, 'ledger', 'append', f.artifact(`event-${++eventNumber}.json`, JSON.stringify({
      kind: 'manual-complete', by: 'orchestrator', data: { criterion: 'SC3', evidence: 'manual/path.md' },
    })));
    assert.equal(bad.exit, 1);
    assert.equal(bad.output.reason, 'user-only');

    result = await invoke(f, 'report', 'complete');
    assert.equal(result.exit, 4);
    assert.equal(result.output.reason, 'criteria-unmet');
    assert.match(result.output.summary, /SC3/);

    await append(f, { kind: 'waiver', by: 'user', quote: 'SC2 approved', data: { criterion: 'SC2', reason: 'approved exception' } });
    await append(f, { kind: 'manual-complete', by: 'user', quote: 'SC3 completed by hand', data: { criterion: 'SC3', evidence: 'manual/sc3.md' } });
    result = await invoke(f, 'report', 'complete');
    assert.equal(result.exit, 4);
    assert.equal(result.output.reason, 'undelivered');

    for (const task of ['T1', 'T2', 'T1', 'T99']) {
      await append(f, { kind: 'integrate', by: 'tool', key: `done:${task}:${++eventNumber}`, data: { phase: 'done', task, commit: HEAD_A } });
    }
    await append(f, { kind: 'integrate', by: 'tool', key: `started:${++eventNumber}`, data: { phase: 'started', task: 'T3', candidate: HEAD_A } });
    await append(f, { kind: 'integrate', by: 'tool', key: `fix:${++eventNumber}`, data: { phase: 'fix', commit: HEAD_A, reason: 'fixture repair' } });
    await append(f, { kind: 'integrate', by: 'tool', key: `abandoned:${++eventNumber}`, data: { phase: 'abandoned', task: 'T4', candidate: HEAD_A, reason: 'fixture abandoned' } });
    await deliver(f, HEAD_A);
    const recordCount = foldLedger(f.session).records.length;
    result = await invoke(f, 'report', 'complete');
    assert.equal(result.exit, 0, result.output.summary);
    assert.equal(foldLedger(f.session).records.length, recordCount);

    const walkthrough = fs.readFileSync(path.join(f.session, 'report.walkthrough.md'), 'utf8');
    assert.match(walkthrough, /### Verified[\s\S]*?\| SC1 \| \.state\/evidence\/[a-f0-9]+\.json \|/);
    assert.ok(walkthrough.includes(producerPath));
    assert.match(walkthrough, /### Manual[\s\S]*?\| SC3 \| User evidence: manual\/sc3\.md; quote: SC3 completed by hand \|/);
    assert.match(walkthrough, /### Waived[\s\S]*?\| SC2 \| Reason: approved exception; quote: SC2 approved \|/);
    assert.match(walkthrough, new RegExp(`Delivered:\\*\\* 2 of 4 tasks integrated; delivered ${HEAD_A.slice(0, 12)} to main`));
  } finally { f.cleanup(); }
});

test('report complete delivery binds evidence and delivery to the locked tree and HEAD', async () => {
  const f = await fixture(1);
  try {
    const state = gitState(f.session, HEAD_A, TREE_A);
    const worktree = await integrate(f, state);
    await evidenceForPlan(f, TREE_A);
    await deliver(f, HEAD_A);
    assert.equal((await invoke(f, 'report', 'complete')).exit, 0);

    state.head = HEAD_B;
    state.tree = TREE_B;
    state.testedTree = TREE_B;
    await append(f, { kind: 'integrate', by: 'tool', key: `fix-tree:${++eventNumber}`, data: { phase: 'fix', commit: HEAD_B, reason: 'new integrated commit' } });
    let result = await invoke(f, 'report', 'complete');
    assert.equal(result.exit, 4);
    assert.equal(result.output.reason, 'criteria-unmet');

    await evidenceForPlan(f, TREE_B);
    result = await invoke(f, 'report', 'complete');
    assert.equal(result.exit, 4);
    assert.equal(result.output.reason, 'undelivered');
    await deliver(f, HEAD_B);
    assert.equal((await invoke(f, 'report', 'complete')).exit, 0);

    state.testedTree = DIRTY_TREE;
    result = await invoke(f, 'report', 'complete');
    assert.equal(result.exit, 4);
    assert.equal(result.output.reason, 'criteria-unmet');
    assert.match(result.output.summary, /dirty checkout/i);

    const beforeMissingWorktree = state.calls.length;
    fs.rmSync(worktree, { recursive: true, force: true });
    result = await invoke(f, 'report', 'complete');
    assert.equal(result.exit, 4);
    assert.equal(result.output.reason, 'no-integration');
    assert.equal(state.calls.length, beforeMissingWorktree);

    fs.mkdirSync(worktree, { recursive: true });
    const expanded = f.artifact('expanded.plan.md', planSource(2));
    await append(f, {
      kind: 'bind', by: 'tool', key: `rebind:${++eventNumber}`,
      data: { spec: 'brief.spec.md', plan: path.relative(f.root, expanded) },
    });
    state.testedTree = TREE_B;
    result = await invoke(f, 'report', 'complete');
    assert.equal(result.exit, 4);
    assert.equal(result.output.reason, 'criteria-unmet');
    assert.match(result.output.summary, /SC2/);

    const calls = state.calls;
    for (const call of calls.filter(({ argv }) =>
      (argv[1] === 'rev-parse' && ['HEAD', 'HEAD^{tree}'].includes(argv[2]!)) ||
      ['read-tree', 'add', 'write-tree'].includes(argv[1]!))) {
      assert.equal(call.locked, true, JSON.stringify(call.argv));
    }
    for (const call of calls.filter(({ argv }) => argv[1] === 'diff')) assert.equal(call.locked, false, JSON.stringify(call.argv));
  } finally { f.cleanup(); }
});

test('report complete low session accepts bound evidence and a user contract waiver without approval', async () => {
  const f = await fixture(1);
  try {
    const state = gitState(f.session);
    await integrate(f, state);
    await append(f, { kind: 'level', by: 'tool', key: `level:${++eventNumber}`, data: { level: 'low' } });
    const evidencePaths = await evidenceForPlan(f, TREE_A, ['SC1']);
    await append(f, { kind: 'waiver', by: 'user', quote: 'contract waiver quote', data: { criterion: 'contract', reason: 'manual contract acceptance' } });
    await append(f, {
      kind: 'edit', by: 'tool', key: `edit:${++eventNumber}`,
      data: {
        artifact: 'plan', before: 'sha256:' + '1'.repeat(64), after: 'sha256:' + '2'.repeat(64), class: 'intent',
        affects: ['SC1'], rationale: 'clarified the acceptance boundary', diffRef: 'plan-edit.diff',
      },
    });
    const hashes = currentHashes(f.root, latest(foldLedger(f.session), 'bind'));
    await deliver(f, HEAD_A);

    const result = await invoke(f, 'report', 'complete');
    assert.equal(result.exit, 0, result.output.summary);
    const walkthrough = fs.readFileSync(path.join(f.session, 'report.walkthrough.md'), 'utf8');
    assert.ok(walkthrough.includes(`**Spec:** brief.spec.md · ${hashes.spec}`));
    assert.ok(walkthrough.includes('**Plan:** report.plan.md'));
    assert.ok(walkthrough.includes(`| SC1 | ${evidencePaths.get('SC1')} |`));
    assert.match(walkthrough, /\| contract \| Reason: manual contract acceptance; quote: contract waiver quote \|/);
    assert.match(walkthrough, /- Deviation: plan edit \(intent\) seq \d+: clarified the acceptance boundary; diff plan-edit\.diff; affects SC1/);
    assert.equal(foldLedger(f.session).records.some((record) => record.kind === 'approval'), false);
  } finally { f.cleanup(); }
});

test('completion requires verified pruned delivery',async()=>{const f=await fixture(1);try{const file=path.join(f.root,'report.plan.md');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('  - Evidence: verify','  - Retain: transient\n  - Covered by: FINAL\n  - Evidence: verify'));const state=gitState(f.session);await integrate(f,state);await evidenceForPlan(f,TREE_A);await deliver(f,HEAD_A);const completed=await invoke(f,'report','complete');assert.equal(completed.output.reason,'criteria-unmet');}finally{f.cleanup();}});
