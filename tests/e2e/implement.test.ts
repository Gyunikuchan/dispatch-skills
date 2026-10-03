import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from '../helpers/e2e.ts';
test('implementation happy path runs real CLI approval, writer receipt, verification, review and terminal handoff', async () => {
  const f = fixture();
  try {
    const session = await f.initialize();
    const plan = path.join(f.repo, 'fixture.plan.md');
    fs.writeFileSync(plan, `# Normalize values

> **TL;DR:** Normalize values before use.
> **Parent:** user request
> **Decide:** none
> **Risk:** low — isolated helper
> **Scope:** src/a.ts

## Key Decisions & Context
- Preserve case.

## Technical-Design Traceability
- Approved revision: none

## Success Criteria
- [SC1] Values are normalized
  - Changes: src/a.ts
  - Verify: \`node -e "process.exit(0)"\`
  - Evidence: verify
  - Test rationale: Run the isolated verification command to establish the scoped gate behavior.

## Proposed Changes
### T1 — Normalize values
Values are normalized before use so downstream comparisons agree.
- Prerequisites: none
- Criteria: SC1

#### [MODIFY] src/a.ts
- Normalize the value.

## Verification Plan
### Automated Tests
- \`node -e "console.log('final gate')"\`
### Manual Verification
- Observe normalized output.

## Review Findings & Resolutions
*No reviews conducted yet.*
`);
    f.git('add', 'fixture.plan.md'); f.git('commit', '-qm', 'plan');
    let frame = await f.begin('implement', session, plan); const run = f.absoluteRun(frame.run);
    assert.equal(frame.await, 'decide', JSON.stringify(frame)); assert.equal(frame.data['kind'], 'approval', JSON.stringify(frame));
    frame = await f.reply(run, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed with implementation' } });
    assert.equal(frame.await, 'write', JSON.stringify(frame));
    const [slot] = frame.data['tasks'] as { task: string; action: string; briefPath: string; briefSha256: string; envelopePath: string; worktree: string }[];
    assert.deepEqual([slot?.task, slot?.action], ['T1', 'launch']);
    const brief = fs.readFileSync(slot!.briefPath); assert.equal(`sha256:${crypto.createHash('sha256').update(brief).digest('hex')}`, slot!.briefSha256);
    frame = await f.reply(run, { type: 'WRITE_LAUNCHED', tasks: [{ task: 'T1', handle: 'agent-1' }] });
    assert.equal((frame.data['tasks'] as { action: string }[])[0]?.action, 'running', JSON.stringify(frame));
    fs.writeFileSync(path.join(slot!.worktree, 'src/a.ts'), 'export const value = 2;\n');
    assert.notEqual(fs.readFileSync(path.join(f.repo, 'src/a.ts'), 'utf8'), 'export const value = 2;\n');
    const envelopePath = slot!.envelopePath;
    const previewEvent = fs.readdirSync(run).find((file) => file.endsWith('.self-check.event.json'))!;
    assert.match(brief.toString('utf8'), /send --run .*--event .*self-check.event.json.*--dry-run/);
    const beforePreview = fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8');
    fs.writeFileSync(envelopePath, '{"schemaVersion":1,"status":"DONE","stage":"COMPLETE","summary":""}');
    const invalidReceipt = await f.cli(['send', '--run', run, '--event', `@${path.join(run, previewEvent)}`, '--dry-run']);
    assert.match(invalidReceipt.error ?? '', /summary|evidence/i); assert.equal(fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8'), beforePreview);
    fs.writeFileSync(envelopePath, JSON.stringify({ schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: 'Values normalized', evidence: ['CRITERION SC1 | src/a.ts | normalizes value before use'], files: [{ path: 'src/a.ts', note: 'Normalizes values.' }] }));
    const validReceipt = await f.cli(['send', '--run', run, '--event', `@${path.join(run, previewEvent)}`, '--dry-run']); assert.equal(validReceipt.error, undefined);
    frame = await f.reply(run, { type: 'WRITE_ENVELOPE', task: 'T1', envelopePath }); assert.equal(frame.await, 'evidence', JSON.stringify(frame));
    assert.equal(fs.readFileSync(path.join(f.repo, 'src/a.ts'), 'utf8').replace(/\r\n/g, '\n'), 'export const value = 2;\n');
    assert.equal(fs.existsSync(slot!.worktree), false);
    frame = await f.reply(run, { type: 'EVIDENCE', criteria: { SC1: { outcome: 'pass', evidence: 'The scoped verification passed after mutation.' } } });
    assert.equal(frame.await, 'done', JSON.stringify(frame)); assert.equal(frame.data['outcome'], 'complete');
    const published = String(frame.data['handoff']); assert.equal(published, session); assert.ok(fs.existsSync(session));
    assert.ok(fs.readdirSync(published).some((file) => file.endsWith('.walkthrough.md')));
    const journal = fs.readFileSync(path.join(frame.run, 'events.jsonl'), 'utf8'); const launches = f.launches().length;
    const replay = await f.cli(['send', '--run', frame.run, '--dry-run']); assert.equal(replay.data['outcome'], 'complete');
    assert.equal(fs.readFileSync(path.join(frame.run, 'events.jsonl'), 'utf8'), journal); assert.equal(f.launches().length, launches);
    fs.rmSync(published, { recursive: true, force: true });
  } finally { f.cleanup(); }
});

test('reuses settled plan from session journal and rejects stale or failed candidates', async () => {
  const f = fixture();
  try {
    let session = await f.initialize();
    const plan = path.join(f.repo, 'reuse.plan.md');
    fs.writeFileSync(plan, `# Normalize values

> **TL;DR:** Normalize values before use.
> **Parent:** user request
> **Decide:** none
> **Risk:** low — isolated helper
> **Scope:** src/a.ts

## Key Decisions & Context
- Preserve case.

## Technical-Design Traceability
- Approved revision: none

## Success Criteria
- [SC1] Values are normalized
  - Changes: src/a.ts
  - Verify: \`node -e "process.exit(0)"\`
  - Evidence: verify
  - Test rationale: Run the isolated verification command.

## Proposed Changes
### T1 — Normalize values
Values are normalized before use so downstream comparisons agree.
- Prerequisites: none
- Criteria: SC1

#### [MODIFY] src/a.ts
- Normalize the value.

## Verification Plan
### Automated Tests
- \`node -e "console.log('final gate')"\`
### Manual Verification
- Observe normalized output.

## Review Findings & Resolutions
*No reviews conducted yet.*
`);
    f.git('add', 'reuse.plan.md'); f.git('commit', '-qm', 'plan');

    // 1. Unsettled plan in implement runs plan review
    const unreviewedFrame = await f.begin('implement', session, plan);
    const unreviewedJournal = fs.readFileSync(path.join(f.absoluteRun(unreviewedFrame.run), 'events.jsonl'), 'utf8');
    assert.match(unreviewedJournal, /"effectId":"implement\.plan-review/);

    // 2. Run plan to settlement
    let planFrame = await f.begin('plan', session, plan);
    const planRun = f.absoluteRun(planFrame.run);
    assert.equal(planFrame.await, 'author');
    planFrame = await f.reply(planRun, { type: 'AUTHORED', path: plan });
    assert.equal(planFrame.await, 'done');
    assert.equal(planFrame.data['outcome'], 'complete');
    if (typeof planFrame.data['handoff'] === 'string') session = planFrame.data['handoff'];

    // 3. Reusing settled plan in implement skips review directly to approval decision
    const reuseFrame = await f.begin('implement', session, plan);
    const reuseJournal = fs.readFileSync(path.join(f.absoluteRun(reuseFrame.run), 'events.jsonl'), 'utf8');
    assert.equal(reuseFrame.await, 'decide');
    assert.equal(reuseFrame.data['kind'], 'approval');
    assert.doesNotMatch(reuseJournal, /"effectId":"implement\.plan-review/);
    session = path.resolve(f.absoluteRun(reuseFrame.run), '../../..');

    // 3b. Reusing settled plan with differing drive/path case matches via designPathIdentity
    const casedPlan = process.platform === 'win32'
      ? (/^[a-z]:/i.test(plan) ? (plan[0] === plan[0]?.toLowerCase() ? plan[0]!.toUpperCase() : plan[0]!.toLowerCase()) + plan.slice(1) : plan)
      : plan;
    const casedReuseFrame = await f.begin('implement', session, casedPlan);
    const casedReuseJournal = fs.readFileSync(path.join(f.absoluteRun(casedReuseFrame.run), 'events.jsonl'), 'utf8');
    assert.equal(casedReuseFrame.await, 'decide');
    assert.equal(casedReuseFrame.data['kind'], 'approval');
    assert.doesNotMatch(casedReuseJournal, /"effectId":"implement\.plan-review/);

    // 4. Stale hash: modify plan on disk so hash differs from settled run
    fs.writeFileSync(plan, fs.readFileSync(plan, 'utf8').replace('- Preserve case.', '- Preserve case and format.'));
    const staleFrame = await f.begin('implement', session, plan);
    const staleJournal = fs.readFileSync(path.join(f.absoluteRun(staleFrame.run), 'events.jsonl'), 'utf8');
    assert.match(staleJournal, /"effectId":"implement\.plan-review/);

    // 5. Unfinished plan run in a fresh session is rejected
    const session2 = await f.initialize();
    await f.begin('plan', session2, plan);
    const rejectUnfinished = await f.begin('implement', session2, plan);
    const rejectJournal = fs.readFileSync(path.join(f.absoluteRun(rejectUnfinished.run), 'events.jsonl'), 'utf8');
    assert.match(rejectJournal, /"effectId":"implement\.plan-review/);

    // 6. Failed plan run in a fresh session is rejected
    const session3 = await f.initialize();
    const failedPlanFrame = await f.begin('plan', session3, plan);
    const replyFrame = await f.reply(f.absoluteRun(failedPlanFrame.run), { type: 'AUTHORED', path: path.join(f.repo, 'does-not-exist.plan.md') });
    const session3Active = typeof replyFrame.data?.['handoff'] === 'string' ? replyFrame.data['handoff'] : session3;
    const rejectFailed = await f.begin('implement', session3Active, plan);
    const rejectFailedJournal = fs.readFileSync(path.join(f.absoluteRun(rejectFailed.run), 'events.jsonl'), 'utf8');
    assert.match(rejectFailedJournal, /"effectId":"implement\.plan-review/);
  } finally {
    f.cleanup();
  }
});


// SECTION: Private checkout ops

async function checkoutRepo() {

  const { nodePorts } = await import('../../skills/dispatch/scripts/core/ports.ts');
  const { createCheckout } = await import('../../skills/dispatch/scripts/effects/checkout.ts');
  const repo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dispatch-checkout-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.autocrlf', 'false');
  const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); };
  write('.gitignore', '.scratch/\nnode_modules/\n.env\n'); write('src/a.ts', 'a1\n'); write('src/b.ts', 'b1\n'); write('src/gone.ts', 'gone\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const runDir = path.join(repo, '.scratch/run'); fs.mkdirSync(runDir, { recursive: true });
  const ports = nodePorts();
  const handler = createCheckout({ cwd: repo, links: { create: (target, link) => fs.symlinkSync(target, link, 'junction'), remove: (link) => fs.unlinkSync(link) } });
  let id = 0;
  const op = async (name: string, input: Record<string, unknown> = {}) => {
    const [event] = await handler({ kind: 'checkout', id: `c.${++id}`, op: name as never, input }, ports, { runDir, attempt: 1 });
    assert.ok(event?.type === 'CHECKOUT_DONE', JSON.stringify(event));
    return event.result as Record<string, unknown>;
  };
  return { repo, git, write, runDir, op, read: (root: string, file: string) => fs.readFileSync(path.join(root, file), 'utf8') };
}

test('checkout: baseline reproduces caller dirt and links ignored dependencies without deleting them on cleanup', async () => {
  const c = await checkoutRepo();
  c.write('src/a.ts', 'a-dirty\n'); c.write('src/new.ts', 'new\n'); fs.rmSync(path.join(c.repo, 'src/gone.ts')); c.write('node_modules/dep/index.js', 'dep'); c.write('.env', 'X=1');
  const baseline = await c.op('init'), root = String(baseline['path']);
  assert.equal(c.read(root, 'src/a.ts'), 'a-dirty\n'); assert.equal(c.read(root, 'src/new.ts'), 'new\n'); assert.equal(fs.existsSync(path.join(root, 'src/gone.ts')), false);
  assert.equal(c.read(root, 'node_modules/dep/index.js'), 'dep'); assert.equal(c.read(root, '.env'), 'X=1');
  assert.deepEqual((await c.op('init'))['base'], baseline['base']);
  const task = String((await c.op('task', { name: 't1', revision: baseline['base'], links: ['node_modules'], ignored: ['.env'] }))['path']);
  assert.equal(c.read(task, '.env'), 'X=1'); assert.equal(c.read(task, 'node_modules/dep/index.js'), 'dep');
  assert.deepEqual((await c.op('cleanup', { names: ['integration', 't1'], links: ['node_modules'] }))['removed'], ['integration', 't1']);
  assert.equal(c.read(c.repo, 'node_modules/dep/index.js'), 'dep'); assert.equal(c.read(c.repo, 'src/a.ts'), 'a-dirty\n');
});

test('checkout: task worktrees are isolated and integration is idempotent and resets on conflict', async () => {
  const c = await checkoutRepo();
  const base = String((await c.op('init'))['base']);
  const t1 = String((await c.op('task', { name: 't1', revision: base }))['path']), t2 = String((await c.op('task', { name: 't2', revision: base }))['path']);
  fs.writeFileSync(path.join(t1, 'src/a.ts'), 't1\n'); fs.writeFileSync(path.join(t2, 'src/a.ts'), 't2\n');
  assert.equal(c.read(t2, 'src/a.ts'), 't2\n'); assert.equal(c.read(c.repo, 'src/a.ts'), 'a1\n');
  const one = await c.op('commit', { name: 't1', base }), two = await c.op('commit', { name: 't2', base });
  assert.deepEqual(one['paths'], ['src/a.ts']); assert.equal((await c.op('commit', { name: 't1', base }))['revision'], one['revision']);
  const merged = await c.op('integrate', { task: 'T1', candidate: one['revision'], expected: base });
  assert.equal(merged['conflict'], false);
  assert.deepEqual(await c.op('integrate', { task: 'T1', candidate: one['revision'], expected: base }), { revision: merged['revision'], conflict: false, reused: true });
  const conflict = await c.op('integrate', { task: 'T2', candidate: two['revision'], expected: merged['revision'] });
  assert.equal(conflict['conflict'], true); assert.deepEqual(conflict['paths'], ['src/a.ts']); assert.equal(conflict['revision'], merged['revision']);
  assert.equal(c.read(path.join(c.runDir, 'wt/integration'), 'src/a.ts'), 't1\n');
});

test('checkout: RED replay applies approved checkpoint files at the input revision and rejects others', async () => {
  const c = await checkoutRepo();
  const base = String((await c.op('init'))['base']), out = path.join(c.runDir, 'red.json');
  const t1 = String((await c.op('task', { name: 't1', revision: base }))['path']);
  fs.mkdirSync(path.join(t1, 'tests')); fs.writeFileSync(path.join(t1, 'tests/a.test.ts'), 'red'); fs.rmSync(path.join(t1, 'src/b.ts'));
  const candidate = (await c.op('commit', { name: 't1', base }))['revision'];
  fs.writeFileSync(out, JSON.stringify({ schemaVersion: 1, files: { 'tests/a.test.ts': Buffer.from('red').toString('base64'), 'src/b.ts': null } }));
  const rejected = await c.op('red', { name: 't1-red', base, candidate, checkpointPath: out, permitted: ['tests/a.test.ts'] });
  assert.match(String(rejected['defects']), /not an approved task test path: src\/b\.ts/);
  const replay = await c.op('red', { name: 't1-red', base, candidate, checkpointPath: out, permitted: ['tests/a.test.ts', 'src/b.ts'] });
  assert.deepEqual(replay['defects'], []); assert.equal(c.read(String(replay['path']), 'tests/a.test.ts'), 'red'); assert.equal(fs.existsSync(path.join(String(replay['path']), 'src/b.ts')), false);
});

test('checkout: delivery transfers integrated changes and refuses caller drift without writing', async () => {
  const c = await checkoutRepo();
  const base = String((await c.op('init'))['base']);
  const t1 = String((await c.op('task', { name: 't1', revision: base }))['path']);
  fs.writeFileSync(path.join(t1, 'src/a.ts'), 'a2\n'); fs.rmSync(path.join(t1, 'src/gone.ts'));
  const candidate = await c.op('commit', { name: 't1', base });
  const revision = (await c.op('integrate', { task: 'T1', candidate: candidate['revision'], expected: base }))['revision'];
  c.write('src/a.ts', 'caller drift\n');
  assert.deepEqual(await c.op('deliver', { base, revision }), { conflicts: ['src/a.ts'], transferred: [], already: [] });
  assert.equal(c.read(c.repo, 'src/a.ts'), 'caller drift\n'); assert.equal(fs.existsSync(path.join(c.repo, 'src/gone.ts')), true);
  c.write('src/a.ts', 'a1\n');
  assert.deepEqual(await c.op('deliver', { base, revision }), { conflicts: [], transferred: ['src/a.ts', 'src/gone.ts'], already: [] });
  assert.equal(c.read(c.repo, 'src/a.ts'), 'a2\n');
  assert.deepEqual(await c.op('deliver', { base, revision }), { conflicts: [], transferred: [], already: ['src/a.ts', 'src/gone.ts'] });
});

test('checkout: RED replay rejects a submitted test that differs from its checkpoint', async () => {
  const c = await checkoutRepo();
  const base = String((await c.op('init'))['base']), out = path.join(c.runDir, 'red.json');
  const t1 = String((await c.op('task', { name: 't1', revision: base }))['path']);
  fs.mkdirSync(path.join(t1, 'tests')); fs.writeFileSync(path.join(t1, 'tests/a.test.ts'), 'passing stub');
  const candidate = (await c.op('commit', { name: 't1', base }))['revision'];
  fs.writeFileSync(out, JSON.stringify({ schemaVersion: 1, files: { 'tests/a.test.ts': Buffer.from('failing assertion').toString('base64') } }));
  const replay = await c.op('red', { name: 't1-red', base, candidate, checkpointPath: out, permitted: ['tests/a.test.ts'] });
  assert.match(String(replay['defects']), /Submitted test differs from its RED checkpoint: tests\/a\.test\.ts/);
});

test('checkout: integration discards an interrupted uncommitted cherry-pick before replaying the candidate', async () => {
  const c = await checkoutRepo();
  const base = String((await c.op('init'))['base']);
  const t1 = String((await c.op('task', { name: 't1', revision: base }))['path']);
  fs.writeFileSync(path.join(t1, 'src/a.ts'), 't1\n');
  const candidate = String((await c.op('commit', { name: 't1', base }))['revision']);
  const integration = path.join(c.runDir, 'wt/integration');
  execFileSync('git', ['cherry-pick', '--no-commit', candidate], { cwd: integration, windowsHide: true });
  const merged = await c.op('integrate', { task: 'T1', candidate, expected: base });
  assert.equal(merged['conflict'], false); assert.equal(c.read(integration, 'src/a.ts'), 't1\n');
});

test('checkout: delivery refuses a caller ancestor directory replaced by an external link', async () => {
  const c = await checkoutRepo();
  const base = String((await c.op('init'))['base']);
  const t1 = String((await c.op('task', { name: 't1', revision: base }))['path']);
  fs.writeFileSync(path.join(t1, 'src/a.ts'), 'a2\n');
  const candidate = await c.op('commit', { name: 't1', base });
  const revision = (await c.op('integrate', { task: 'T1', candidate: candidate['revision'], expected: base }))['revision'];
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dispatch-outside-'));
  fs.cpSync(path.join(c.repo, 'src'), outside, { recursive: true }); fs.rmSync(path.join(c.repo, 'src'), { recursive: true }); fs.symlinkSync(outside, path.join(c.repo, 'src'), 'junction');
  assert.deepEqual((await c.op('deliver', { base, revision }))['conflicts'], ['src/a.ts']);
  assert.equal(fs.readFileSync(path.join(outside, 'a.ts'), 'utf8'), 'a1\n');
});

test('checkout: baseline and delivery preserve executable modes', { skip: process.platform === 'win32' && 'POSIX file modes' }, async () => {
  const c = await checkoutRepo();
  c.write('bin/run.sh', 'echo\n'); fs.chmodSync(path.join(c.repo, 'bin/run.sh'), 0o755);
  const base = String((await c.op('init'))['base']);
  assert.equal(fs.statSync(path.join(c.runDir, 'wt/integration/bin/run.sh')).mode & 0o111, 0o111);
  const t1 = String((await c.op('task', { name: 't1', revision: base }))['path']);
  fs.chmodSync(path.join(t1, 'src/a.ts'), 0o755);
  const candidate = await c.op('commit', { name: 't1', base });
  const revision = (await c.op('integrate', { task: 'T1', candidate: candidate['revision'], expected: base }))['revision'];
  assert.deepEqual((await c.op('deliver', { base, revision }))['transferred'], ['src/a.ts']);
  assert.equal(fs.statSync(path.join(c.repo, 'src/a.ts')).mode & 0o111, 0o111);
});
