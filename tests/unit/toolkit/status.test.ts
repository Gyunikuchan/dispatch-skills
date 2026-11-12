import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { main, type CliDeps } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { appendRecord, currentHashes, foldLedger, latest } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { memoryNodeFs } from '../../helpers/memory-node-fs.ts';

function sessionFixture() {
  const root = path.join(path.parse(os.tmpdir()).root, 'status-' + crypto.randomUUID());
  const cleanup = memoryNodeFs(root);
  const session = path.join(root, '.scratch/dispatch-skills/20261023T0000Z-test');
  fs.mkdirSync(session, { recursive: true });
  fs.writeFileSync(path.join(session, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, folderName: path.basename(session), sessionId: 'test', safeSessionId: 'test', repositoryRoot: fs.realpathSync(root),
  }));
  const lines: string[] = [];
  const deps: CliDeps = {
    run: async () => { throw new Error('Unit tests must not spawn processes'); },
    delegate: async () => { throw new Error('Unscripted delegate'); },
    modes: () => ['cli'], orchestrator: null, liveness: { claude: true, agy: true, codex: true, copilot: true, opencode: true },
    stdout: (line) => lines.push(line), env: {}, clock: () => 0,
    sleep: async () => {}, pid: 42, host: 'test-host', isAlive: () => false,
    skillRoot: path.resolve('skills/dispatch'),
  };
  return {
    root, session, lines, deps, cleanup,
    artifact: (name: string, source: string) => { const file = path.join(root, name); fs.writeFileSync(file, source); return file; },
    output: () => { if (lines.length !== 1) throw new Error('Expected one output line'); return JSON.parse(lines[0]!) as { ok: boolean; summary: string; path: string | null; reason?: string }; },
  };
}

test('status report exposes bindings approval gate open escalations and torn tail without locking', async () => {
  const f = sessionFixture();
  try {
    f.artifact('mission.spec.md', 'mission');
    const plan = f.artifact('work.plan.md', 'plan');
    const append = (kind: string, key: string, data: unknown, by = 'orchestrator') => appendRecord(f.session, { kind, key, data, by, ...(by === 'user' ? { quote: 'approved' } : {}) }, f.deps);
    await append('bind', 'bind', { spec: 'mission.spec.md', plan: 'work.plan.md' });
    const hashes = currentHashes(f.root, latest(foldLedger(f.session), 'bind'));
    await append('confirm', 'confirm', { spec: hashes.spec }, 'user');
    await append('approval', 'approval', hashes, 'user');
    await append('level', 'level', { level: 'high' });
    await append('escalation', 'open-a', { id: 'a', state: 'open', summary: 'first' });
    await append('escalation', 'close-a', { id: 'a', state: 'resolved', summary: 'done' });
    await append('escalation', 'open-b', { id: 'b', state: 'open', summary: 'pending' });
    const run = async () => {
      f.lines.length = 0;
      assert.equal(await main(['status', 'show', '--session', f.session], f.deps), 0);
      return JSON.parse(fs.readFileSync(f.output().path!, 'utf8'));
    };
    const report = await run();
    assert.equal(report.level, 'high');
    assert.deepEqual(report.bound, { spec: 'mission.spec.md', plan: 'work.plan.md' });
    assert.deepEqual(report.current, hashes);
    assert.deepEqual(report.approved, hashes);
    assert.deepEqual(report.gate, { allowed: true });
    assert.deepEqual(report.escalations, [{ id: 'b', state: 'open', summary: 'pending' }]);
    assert.equal(report.recordCount, 7);
    assert.equal(report.tornTail, false);
    fs.writeFileSync(plan, 'changed');
    fs.appendFileSync(path.join(f.session, 'ledger.jsonl'), '{torn');
    const changed = await run();
    assert.deepEqual(changed.gate, { allowed: false, reason: 'unrecorded-change', artifact: 'plan' });
    assert.equal(changed.tornTail, true);
    assert.equal(changed.recordCount, 7);
    assert.equal(fs.existsSync(path.join(f.session, '.state', 'lock')), false);
    assert.ok(fs.readFileSync(path.join(f.session, 'ledger.jsonl'), 'utf8').endsWith('{torn'));
  } finally { f.cleanup(); }
});

const PLAN = [
  '# Work',
  '## Task Map',
  '| ID | Title | Outcome | Prerequisites | Criteria |',
  '| --- | --- | --- | --- | --- |',
  '| T1 | File | Works | none | SC1, SC2 |',
  '## Proposed Changes',
  '### T1 \u2014 File',
  '#### [NEW] src/file.ts',
  '- Purpose: behavior.',
  '## Success Criteria',
  '- [SC1] Works',
  '  - Changes: src/file.ts',
  '  - Verify: `node check`',
  '  - Evidence: verify',
  '- [SC2] Also works',
  '  - Changes: src/file.ts',
  '  - Verify: `node check2`',
  '  - Evidence: verify2',
  '## Verification Plan',
  '### Automated Tests',
  '- `node contract`',
].join('\n');


test('status retains missing automated criteria for manual completions and waivers', async () => {
  const { fakeGit } = await import('./helpers/fake-git.ts');
  const f = sessionFixture();
  try {
    f.artifact('mission.spec.md', 'mission');
    f.artifact('work.plan.md', PLAN);
    await appendRecord(f.session, { kind: 'bind', key: 'bind', by: 'tool', data: { spec: 'mission.spec.md', plan: 'work.plan.md' } }, f.deps);
    const cwd = path.join(f.session, '.state/worktrees/integration');
    fs.mkdirSync(cwd, { recursive: true });
    const head = 'a'.repeat(40), tree = 'b'.repeat(40);
    f.deps.run = fakeGit({ session: f.session, head, tree, testedTree: tree, changes: [], calls: [] });
    await appendRecord(f.session, { kind: 'integrate', key: 'opened', by: 'tool', data: { phase: 'opened', path: '.state/worktrees/integration', branch: 'integration', base: head, dest: { path: f.root, branch: 'main' } } }, f.deps);
    await appendRecord(f.session, { kind: 'manual-complete', key: 'manual-complete', by: 'user', quote: 'accepted', data: { criterion: 'SC1', evidence: 'reviewed' } }, f.deps);
    await appendRecord(f.session, { kind: 'waiver', key: 'waiver', by: 'user', quote: 'accepted', data: { criterion: 'SC2', reason: 'accepted risk' } }, f.deps);
    await main(['status', 'show', '--session', f.session], f.deps);
    const value = JSON.parse(fs.readFileSync(f.output().path!, 'utf8'));
    assert.ok(value.criteria.includes('SC1'), JSON.stringify(value));
    assert.ok(value.criteria.includes('SC2'), JSON.stringify(value));
    assert.equal(value.criterionStatuses.find((row: { criterion: string }) => row.criterion === 'SC1').state, 'manual');
    assert.equal(value.criterionStatuses.find((row: { criterion: string }) => row.criterion === 'SC2').state, 'waived');
  } finally { f.cleanup(); }
});

test('status retains recovery status with broken and missing plan', async () => {
  const { fakeGit } = await import('./helpers/fake-git.ts');
  const f = sessionFixture();
  try {
    f.artifact('mission.spec.md', 'mission');
    const plan = f.artifact('work.plan.md', PLAN);
    await appendRecord(f.session, { kind: 'bind', key: 'bind', by: 'tool', data: { spec: 'mission.spec.md', plan: 'work.plan.md' } }, f.deps);
    await appendRecord(f.session, { kind: 'level', key: 'level', by: 'orchestrator', data: { level: 'low' } }, f.deps);
    const cwd = path.join(f.session, '.state/worktrees/integration');
    fs.mkdirSync(cwd, { recursive: true });
    const head = 'a'.repeat(40), tree = 'b'.repeat(40);
    f.deps.run = fakeGit({ session: f.session, head, tree, testedTree: tree, changes: [], calls: [] });
    await appendRecord(f.session, { kind: 'integrate', key: 'opened', by: 'tool', data: { phase: 'opened', path: '.state/worktrees/integration', branch: 'integration', base: head, dest: { path: f.root, branch: 'main' } } }, f.deps);
    await appendRecord(f.session, { kind: 'writer', key: 'writer', by: 'tool', data: { phase: 'launched', task: 'T1', path: '.state/worktrees/T1-1', base: { commit: head, seq: 1, taskSection: 'sha256:' + 'a'.repeat(64) } } }, f.deps);
    await appendRecord(f.session, { kind: 'escalation', key: 'blocked', by: 'orchestrator', data: { id: 'E1', state: 'open', summary: 'Recovery needed' } }, f.deps);
    await main(['status', 'show', '--session', f.session], f.deps);
    const before = JSON.parse(fs.readFileSync(f.output().path!, 'utf8'));

    // Check broken plan behavior
    f.lines.length = 0;
    fs.writeFileSync(plan, '# Broken plan\n');
    assert.equal(await main(['status', 'show', '--session', f.session], f.deps), 0);
    const broken = JSON.parse(fs.readFileSync(f.output().path!, 'utf8'));
    for (const field of ['level', 'bound', 'escalations', 'recordCount']) assert.deepEqual(broken[field], before[field], field);
    assert.equal(broken.writers.state, 'unavailable');
    assert.equal(broken.criteria.state, 'unavailable');
    assert.ok(broken.writers.reason.length > 0);
    assert.match(broken.criteria.reason, /defect|missing|required|task|section/i);

    // Check missing plan behavior
    f.lines.length = 0;
    fs.rmSync(plan);
    assert.equal(await main(['status', 'show', '--session', f.session], f.deps), 0);
    const missing = JSON.parse(fs.readFileSync(f.output().path!, 'utf8'));
    for (const field of ['level', 'bound', 'escalations', 'recordCount']) assert.deepEqual(missing[field], before[field], field);
    assert.equal(missing.writers.state, 'unavailable');
    assert.equal(missing.criteria.state, 'unavailable');
    assert.ok(missing.writers.reason.length > 0);
    assert.equal(missing.current.plan, null);
    assert.match(missing.criteria.reason, /unreadable/);
  } finally { f.cleanup(); }
});

test('uncommitted consumers report the delivery source as not yet delivered', async () => {
 const { fakeGit } = await import('./helpers/fake-git.ts');
 const f = sessionFixture();
 try {
 f.artifact('mission.spec.md', 'mission');
 f.artifact('work.plan.md', PLAN);
 await appendRecord(f.session, { kind: 'bind', by: 'tool', key: 'bind', data: { spec: 'mission.spec.md', plan: 'work.plan.md' } }, f.deps);
 const source = 'a'.repeat(40), dest = { path: f.root, branch: 'main' }, relative = '.state/worktrees/integration';
 fs.mkdirSync(path.join(f.session, relative), { recursive: true });
 const state = { session: f.session, head: source, tree: 'b'.repeat(40), testedTree: 'b'.repeat(40), changes: [], calls: [] };
 f.deps.run = fakeGit(state);
 await appendRecord(f.session, { kind: 'integrate', by: 'tool', data: { phase: 'opened', path: relative, branch: 'integration', base: 'f'.repeat(40), dest } }, f.deps);
 await appendRecord(f.session, { kind: 'integrate', by: 'tool', data: { phase: 'delivered', mode: 'uncommitted', dest, from: 'f'.repeat(40), source } }, f.deps);
 f.lines.length = 0;
 assert.equal(await main(['status', 'show', '--session', f.session], f.deps), 0);
 const integration = JSON.parse(fs.readFileSync(f.output().path!, 'utf8')).integration;
 assert.equal(integration.source, source);
 assert.equal(integration.undelivered, false);
 } finally { f.cleanup(); }
});

test('status budget reflects rulings after completion', async () => {
  const f = sessionFixture();
  try {
    const review = 'plan-work.plan', directory = path.join(f.session, '.state/reviews', review);
    for (const round of [1, 2]) {
      fs.mkdirSync(path.join(directory, 'round-' + round), { recursive: true });
      fs.writeFileSync(path.join(directory, 'round-' + round, 'round.json'), JSON.stringify({ round, cap: 2, startSeq: 0 }));
      fs.writeFileSync(path.join(directory, 'round-' + round, 'findings.json'), JSON.stringify({ review, round, cap: 2, findings: round === 2 ? [{ id: 'R2-F001', severity: 'MUST', sources: [] }] : [] }));
    }
    const budget = async () => {
      f.lines.length = 0;
      assert.equal(await main(['status', 'show', '--session', f.session], f.deps), 0);
      return JSON.parse(fs.readFileSync(f.output().path!, 'utf8')).reviews[review];
    };
    assert.deepEqual(await budget(), { cap: 2, ceiling: 4, nextRound: 3, asOfSeq: 0, state: 'requires-continuation' });
    await appendRecord(f.session, { kind: 'ruling', by: 'orchestrator', key: 'ruling-accepted', data: { subject: 'review:' + review + ':R2-F001', ruling: 'accepted', rationale: 'Fixed' } }, f.deps);
    assert.deepEqual(await budget(), { cap: 2, ceiling: 4, nextRound: 3, asOfSeq: 1, state: 'allowed' });
  } finally { f.cleanup(); }
});

test('status reports coverage admission for open and unreadable slots', async () => {
  const f = sessionFixture();
  try {
    const review = 'code-integration', directory = path.join(f.session, '.state/reviews', review, 'round-1');
    const write = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
    const roster = ['codex[0]', 'opencode[1]'].map((slot, index) => ({ slot, provider: 'codex', index, reserve: false }));
    write(path.join(directory, 'round.json'), { round: 1, generation: 1, cap: 1, scope: 'Full review', startSeq: 0, spec: { path: '/spec.md', hash: 'sha256:' + 'a'.repeat(64) }, target: { base: 'b', head: 'h' }, roster });
    write(path.join(directory, 'gen-1/slots/opencode[1].json'), { slot: 'opencode[1]', state: 'done', text: 'report' });
    write(path.join(directory, 'gen-1/slots/codex[0].json'), { slot: 'codex[0]', state: 'failed', cls: 'timeout', reason: 'slow' });
    write(path.join(directory, 'findings.json'), { review, round: 1, cap: 1, findings: [] });
    const budget = async () => {
      f.lines.length = 0;
      assert.equal(await main(['status', 'show', '--session', f.session], f.deps), 0);
      return JSON.parse(fs.readFileSync(f.output().path!, 'utf8')).reviews[review];
    };
    // An entry-less failure cannot be ordered, so coverage is unreadable but status still answers.
    assert.deepEqual(await budget(), { cap: 1, ceiling: 3, nextRound: 2, asOfSeq: 0, state: 'requires-continuation', coverage: { state: 'unreadable' } });
    write(path.join(directory, 'gen-1/attempts.json'), [{ slot: 'codex[0]', seq: 0, wholeTarget: true, outcome: 'timeout' }]);
    assert.deepEqual(await budget(), { cap: 1, ceiling: 3, nextRound: 2, asOfSeq: 0, state: 'allowed',
      coverage: { state: 'readable', open: ['codex[0]'], decision: 'rerun', use: 'free' } });
  } finally { f.cleanup(); }
});
