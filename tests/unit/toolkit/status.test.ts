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
    assert.equal(report.recordCount, 6);
    assert.equal(report.tornTail, false);
    fs.writeFileSync(plan, 'changed');
    fs.appendFileSync(path.join(f.session, 'ledger.jsonl'), '{torn');
    const changed = await run();
    assert.deepEqual(changed.gate, { allowed: false, reason: 'unrecorded-change', artifact: 'plan' });
    assert.equal(changed.tornTail, true);
    assert.equal(changed.recordCount, 6);
    assert.equal(fs.existsSync(path.join(f.session, '.state', 'lock')), false);
    assert.ok(fs.readFileSync(path.join(f.session, 'ledger.jsonl'), 'utf8').endsWith('{torn'));
  } finally { f.cleanup(); }
});

test('recovery status refuses transient success without a validated transition', async () => {
  const PLAN = [
    '# Work',
    '## Task Map',
    '| ID | Title | Outcome | Prerequisites | Criteria |',
    '| --- | --- | --- | --- | --- |',
    '| T1 | File | Works | none | SC1 |',
    '## Proposed Changes',
    '### T1 \u2014 File',
    '#### [NEW] src/file.ts',
    '- Purpose: behavior.',
    '## Success Criteria',
    '- [SC1] Works',
    '  - Changes: src/file.ts',
    '  - Verify: `node check`',
    '  - Evidence: verify',
    '## Verification Plan',
    '### Automated Tests',
    '- `node contract`',
  ].join('\n');
  const { fakeGit } = await import('./helpers/fake-git.ts');
  const f = sessionFixture();
  try {
    f.artifact('mission.spec.md', 'mission');
    f.artifact('work.plan.md', PLAN.replace('  - Evidence: verify', '  - Retain: transient\n  - Covered by: FINAL\n  - Evidence: verify'));
    await appendRecord(f.session, { kind: 'bind', by: 'tool', key: 'bind', data: { spec: 'mission.spec.md', plan: 'work.plan.md' } }, f.deps);
    const cwd = path.join(f.session, '.state/worktrees/integration');
    fs.mkdirSync(cwd, { recursive: true });
    const head = 'a'.repeat(40), tree = 'b'.repeat(40);
    f.deps.run = fakeGit({ session: f.session, head, tree, testedTree: tree, changes: [], calls: [] });
    await appendRecord(f.session, { kind: 'integrate', by: 'tool', data: { phase: 'opened', path: '.state/worktrees/integration', branch: 'integration', base: head, dest: { path: f.root, branch: 'main' } } }, f.deps);
    await main(['status', 'show', '--session', f.session], f.deps);
    const value = JSON.parse(fs.readFileSync(f.output().path!, 'utf8'));
    assert.ok(value.criteria.includes('SC1'));
    assert.deepEqual(value.criterionStatuses.map((row: { state: string; reason: string }) => [row.state, row.reason]), [['missing', 'pruning-required'], ['missing', 'pruning-required']]);
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

for (const damage of ['broken', 'missing'] as const) {
  test('status retains recovery status with ' + damage + ' plan', async () => {
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
      f.lines.length = 0;
      if (damage === 'missing') fs.rmSync(plan); else fs.writeFileSync(plan, '# Broken plan\n');
      const exit = await main(['status', 'show', '--session', f.session], f.deps);
      assert.equal(exit, 0);
      const s = JSON.parse(fs.readFileSync(f.output().path!, 'utf8'));
      for (const field of ['level', 'bound', 'escalations', 'recordCount']) assert.deepEqual(s[field], before[field], field);
      assert.equal(s.writers.state, 'unavailable');
      assert.equal(s.criteria.state, 'unavailable');
      assert.ok(s.writers.reason.length > 0);
      if (damage === 'missing') { assert.equal(s.current.plan, null); assert.match(s.criteria.reason, /unreadable/); }
      else assert.match(s.criteria.reason, /defect|missing|required|task|section/i);
    } finally { f.cleanup(); }
  });
}

test('uncommitted consumers report source with a null destination commit',async()=>{
 const {fakeGit}=await import('./helpers/fake-git.ts');const f=sessionFixture();try{
 f.artifact('mission.spec.md','mission');f.artifact('work.plan.md',PLAN);
 await appendRecord(f.session,{kind:'bind',by:'tool',key:'bind',data:{spec:'mission.spec.md',plan:'work.plan.md'}},f.deps);
 const source='a'.repeat(40),dest={path:f.root,branch:'main'},relative='.state/worktrees/integration';fs.mkdirSync(path.join(f.session,relative),{recursive:true});
 const state={session:f.session,head:source,tree:'b'.repeat(40),testedTree:'b'.repeat(40),changes:[],calls:[]};f.deps.run=fakeGit(state);
 await appendRecord(f.session,{kind:'integrate',by:'tool',data:{phase:'opened',path:relative,branch:'integration',base:'f'.repeat(40),dest}},f.deps);
 await appendRecord(f.session,{kind:'integrate',by:'tool',data:{phase:'delivered',mode:'uncommitted',dest,from:'f'.repeat(40),source}},f.deps);
 f.lines.length=0;assert.equal(await main(['status','show','--session',f.session],f.deps),0);const integration=JSON.parse(fs.readFileSync(f.output().path!,'utf8')).integration;
 assert.equal(integration.source,source);assert.equal(integration.to,null);assert.equal(integration.undelivered,false);
 }finally{f.cleanup();}
});
