import { memoryRunFs } from '../../helpers/memory-run-fs.ts';
import { loadRecovery } from '../../../skills/dispatch/scripts/effects/recovery-manifest.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import * as checkpoint from '../../../skills/dispatch/scripts/core/checkpoint.ts';
import { start, send } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { appendEvent, readJournal } from '../../../skills/dispatch/scripts/core/journal.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { awaitingMachine, fakeHandlers, RUN_STARTED } from './fixtures/machines.ts';
import { rootMachine } from '../../../skills/dispatch/scripts/machines/root.ts';
import { run } from '../machines/fixtures/design.ts';
import { fixture, checkpointProof } from './fixtures/restore.ts';
import { checkoutRecovery, createCheckout, worktreePath } from '../../../skills/dispatch/scripts/effects/checkout.ts';
import { pausedReview } from './fixtures/review-manifest.ts';

function mutateCheckpoint(ports: ReturnType<typeof fakePorts>, runDir: string, change: (saved: any) => void): void {
  const rows = [...readJournal(ports, runDir).records], line = [...rows].reverse().find((row) => row.checkpoint)!;
  const saved = JSON.parse(ports.fs.readText(path.join(runDir, line.checkpoint!.path))); change(saved);
  const text = `${JSON.stringify(saved)}\n`, hash = checkpoint.sha256(text), relative = `checkpoints/${hash}.json`;
  ports.fs.publishExclusive(path.join(runDir, relative), text);
  line.checkpoint = { ...line.checkpoint!, path: relative, sha256: hash, bytes: Buffer.byteLength(text) };
  ports.fs.writeAtomic(path.join(runDir, 'events.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

for (const redirect of ['symlink', 'resolved-directory'] as const)
test(`recovery-guard: ${redirect} checkpoint destination rejects publication before journal advancement`, async () => {
  const ports = fakePorts(), root = tempDir(), runDir = path.join(root, 'run');
  const candidate = path.join(root, 'candidate.txt'); fs.writeFileSync(candidate, 'retained');
  const inspect = ports.fs.inspectPath;
  ports.fs.inspectPath = file => path.resolve(file) === path.join(runDir, 'checkpoints')
    ? { kind: redirect === 'symlink' ? 'symlink' : 'directory', mode: 0o700, linkTarget: null, realPath: redirect === 'symlink' ? null : path.join(root, 'external') }
    : inspect(file);
  let publications = 0;
  ports.fs.publishExclusive = () => { publications++; throw new Error('publication crossed redirected destination'); };
  await assert.rejects(start({ ports, runDir, machine: awaitingMachine, handlers: fakeHandlers, runStarted: RUN_STARTED }), /Recovery artifact path escape/);
  assert.equal(publications, 0);
  assert.equal(ports.fs.exists(path.join(runDir, 'events.jsonl')), false);
  assert.equal(fs.readFileSync(candidate, 'utf8'), 'retained');
  assert.equal(fs.existsSync(path.join(root, 'external')), false);
});

test('recovery-guard: corrupt committed checkpoint preserves the journal and candidates', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
  await start({ ports, runDir, machine: awaitingMachine, handlers: fakeHandlers, runStarted: RUN_STARTED });
  const ref = readJournal(ports, runDir).checkpoint!.line.checkpoint!;
  fs.writeFileSync(path.join(runDir, ref.path), '{}');
  const before = fs.readFileSync(path.join(runDir, 'events.jsonl'));
  const candidate = path.join(runDir, 'candidate.txt'); fs.writeFileSync(candidate, 'retained');
  const result = await (checkpoint as typeof checkpoint & { rebind: Function }).rebind({ machine: awaitingMachine, handlers: fakeHandlers, ports, runDir, reason: 'Local repair' });
  assert.equal(result.exitCode, 2);
  assert.match(result.frame?.error ?? '', /checkpoint-invalid/);
  assert.deepEqual(fs.readFileSync(path.join(runDir, 'events.jsonl')), before);
  assert.equal(fs.readFileSync(candidate, 'utf8'), 'retained');
});

for (const field of ['priorManifest', 'targetManifest'] as const) for (const defect of ['missing', 'rewrite'] as const) for (const route of ['status', 'rebind', 'receipt'] as const)
test(`review-manifest: ${route} rejects ${defect} ${field} without advancing accepted work`, async () => {
  const f = await pausedReview(), state = f.state();
  if (!('c' in state)) throw new Error('review context');
  const manifest = state.c[field]!;
  const id = (f.first.frame!.data['findings'] as { id: string }[])[0]!.id;
  if (defect === 'missing') f.ports.fs.remove(manifest);
  else {
    const prior = JSON.parse(f.ports.fs.readText(manifest));
    prior.working['src/outside.ts'] = 'forged';
    f.ports.fs.writeAtomic(manifest, JSON.stringify(prior));
  }
  const before = f.ports.fs.listFiles(f.runDir).map(file => [file, f.ports.fs.readBase64(path.join(f.runDir, file))]);
  const result = route === 'rebind' ? await checkpoint.rebind({ ...f.options, reason: 'Compatible fix' })
    : await send({ ...f.options, ...(route === 'status' ? { dryRun: true } : { rawEvent: { type: 'RULINGS', rulings: { [id]: { ruling: 'accept', fix: { affectedPaths: ['src/a.ts'], dependsOn: [], verification: ['check'] } } } } }) });
  assert.equal(result.exitCode, 2, JSON.stringify(result));
  assert.match(result.frame?.error ?? '', /immutable review manifest/);
  assert.deepEqual(f.ports.fs.listFiles(f.runDir).map(file => [file, f.ports.fs.readBase64(path.join(f.runDir, file))]), before);
});

test('review-manifest: a schema-valid rewritten baseline cannot authorize FIXES_APPLIED', async () => {
  const f = await pausedReview(), id = (f.first.frame!.data['findings'] as { id: string }[])[0]!.id;
  const fix = await send({ ...f.options, rawEvent: { type: 'RULINGS', rulings: { [id]: { ruling: 'accept', fix: { affectedPaths: ['src/a.ts'], dependsOn: [], verification: ['check'] } } } } });
  assert.equal(fix.frame?.await, 'fix');
  f.edit();
  const state = f.state(); if (!('c' in state)) throw new Error('review context');
  const file = state.c.targetManifest!, prior = JSON.parse(f.ports.fs.readText(file)); prior.working['src/outside.ts'] = 'b1';
  f.ports.fs.writeAtomic(file, JSON.stringify(prior));
  const before = f.ports.fs.readText(path.join(f.runDir, 'events.jsonl'));
  const result = await send({ ...f.options, rawEvent: { type: 'FIXES_APPLIED', clusters: (fix.frame!.data['clusters'] as { clusterId: string }[]).map(cluster => ({ clusterId: cluster.clusterId, status: 'applied' })) } });
  assert.equal(result.exitCode, 2); assert.match(result.frame?.error ?? '', /immutable review manifest/);
  assert.equal(f.ports.fs.readText(path.join(f.runDir, 'events.jsonl')), before);
});

for (const defect of ['state-schema', 'prefix', 'effect-attempt', 'repository', 'reference'] as const) test(`recovery-guard: ${defect} rejects rebind without changing retained artifacts`, async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
  memoryRunFs(ports, runDir);
  await start({ ports, runDir, machine: awaitingMachine, handlers: { snapshot: async () => { throw new Error('interrupted'); } }, runStarted: RUN_STARTED });
  mutateCheckpoint(ports, runDir, (saved) => {
    if (defect === 'state-schema') saved.codec.version = 999;
    if (defect === 'prefix') saved.prefix.priorHash = '0'.repeat(64);
    if (defect === 'effect-attempt') saved.open = ['foreign'];
    if (defect === 'repository') saved.binding.repo = { root: 'foreign' };
    if (defect === 'reference') saved.state.proof = { version: 1, path: `recovery-manifests/${'a'.repeat(64)}.json`, sha256: 'a'.repeat(64), bytes: 1 };
  });
  const before = ports.fs.readBase64(path.join(runDir, 'events.jsonl'));
  assert.equal((await checkpoint.rebind({ ports, runDir, machine: awaitingMachine, handlers: fakeHandlers, reason: 'Local repair' })).exitCode, 2);
  assert.deepEqual(ports.fs.readBase64(path.join(runDir, 'events.jsonl')), before);
});

for (const defect of ['required-field', 'embedded-repository'] as const) test(`recovery-guard: root ${defect} fails even with a matching checkpoint digest`, async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
  memoryRunFs(ports, runDir);
  await start({ ports, runDir, machine: rootMachine, handlers: { 'parse-artifact': async () => { throw new Error('uncertain parse'); } }, runStarted: { ...run('implement'), argument: 'x.design.md' } });
  mutateCheckpoint(ports, runDir, (saved) => { if (defect === 'required-field') delete saved.state.child.effectId; else saved.state.child.c.run.repo = { root: 'foreign' }; });
  const before = ports.fs.readBase64(path.join(runDir, 'events.jsonl'));
  const result = await checkpoint.rebind({ ports, runDir, machine: rootMachine, handlers: {}, reason: 'Local repair' });
  assert.equal(result.exitCode, 2, result.frame?.error);
  assert.match(result.frame?.error ?? '', /checkpoint-(?:state-)?invalid/);
  assert.deepEqual(ports.fs.readBase64(path.join(runDir, 'events.jsonl')), before);
});

test('recovery-guard: corrupt immutable recovery bytes reject rebind before epoch publication', async () => {
  const f = fixture();
  const machine = { ...awaitingMachine, step: (state: Parameters<typeof awaitingMachine.step>[0], event: Parameters<typeof awaitingMachine.step>[1]) => { const result = awaitingMachine.step(state, event); return event.type === 'RUN_STARTED' ? result : { ...result, state: { ...result.state, proof: f.effect.to['recovery'] } }; } };
  const runDir = path.join(tempDir(), 'run');
  const handlers = { ...fakeHandlers, snapshot: async (effect: Parameters<NonNullable<typeof fakeHandlers.snapshot>>[0]) => {
    for (const folder of ['recovery-manifests', 'recovery-contents']) fs.cpSync(path.join(f.runDir, folder), path.join(runDir, folder), { recursive: true });
    return fakeHandlers.snapshot!(effect, f.ports, { runDir, attempt: 1 });
  } };
  assert.equal((await start({ ports: f.ports, runDir, machine, handlers, runStarted: RUN_STARTED })).exitCode, 0);
  const blobs = fs.readdirSync(path.join(runDir, 'recovery-contents')); fs.writeFileSync(path.join(runDir, 'recovery-contents', blobs[0]!), 'corrupt');
  const before = fs.readFileSync(path.join(runDir, 'events.jsonl'));
  assert.equal((await checkpoint.rebind({ ports: f.ports, runDir, machine, handlers: fakeHandlers, reason: 'Local repair' })).exitCode, 2);
  assert.deepEqual(fs.readFileSync(path.join(runDir, 'events.jsonl')), before);
});

test('recovery-guard: delivery recovery and explicit retry preserve every caller path before a later collision', async () => {
  const ports = fakePorts(), cwd = tempDir(), runDir = tempDir(), root = worktreePath(runDir, 'integration');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'before-a'); fs.writeFileSync(path.join(cwd, 'z.txt'), 'new caller z');
  fs.writeFileSync(path.join(root, 'a.txt'), 'candidate-a'); fs.writeFileSync(path.join(root, 'z.txt'), 'candidate-z');
  ports.git.run = async (args) => {
    if (args[0] === 'rev-parse') return 'candidate';
    if (args[0] === 'status') return '';
    if (args[0] === 'diff') return 'a.txt\0z.txt\0';
    if (args[0] === 'config') return 'false';
    if (args[0] === 'hash-object') return args.at(-1) === 'a.txt' ? 'a'.repeat(40) : 'c'.repeat(40);
    if (args[0] === 'ls-tree') { const file = args.at(-1)!; return `100644 blob ${(args[2] === 'base' ? 'a' : 'b').repeat(40)}\t${file}\0`; }
    return '';
  };
  const deps = { cwd, links: { create: () => {}, remove: () => {} } };
  const effect = { kind: 'checkout' as const, id: 'deliver.1', op: 'deliver' as const, input: { base: 'base', revision: 'candidate' } };
  assert.equal((await checkoutRecovery(deps).probe!(effect, ports, { runDir, attempt: 1 })).status, 'unresolved');
  const result = (await createCheckout(deps)(effect, ports, { runDir, attempt: 2 }))[0]!;
  assert.equal(result.type, 'CHECKOUT_DONE');
  if (result.type === 'CHECKOUT_DONE') assert.deepEqual(result.result['conflicts'], ['z.txt']);
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'before-a');
  assert.equal(fs.readFileSync(path.join(cwd, 'z.txt'), 'utf8'), 'new caller z');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'candidate-a');
});

test('recovery-guard: incomplete restore retry checks all live destinations before overwriting any path', async () => {
  const f = fixture(), write = f.ports.fs.writeBase64Atomic; let calls = 0;
  f.ports.fs.writeBase64Atomic = (file, text) => { if (++calls === 2) throw new Error('interrupted restore'); write(file, text); };
  assert.equal((await f.invoke())[0]?.type, 'EFFECT_FAILED');
  f.ports.fs.writeBase64Atomic = write;
  fs.writeFileSync(path.join(f.cwd, 'untracked'), 'new caller content');
  const before = fs.readFileSync(path.join(f.cwd, 'dirty'));
  assert.equal((await f.invoke())[0]?.type, 'EFFECT_FAILED');
  assert.deepEqual(fs.readFileSync(path.join(f.cwd, 'dirty')), before);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'untracked'), 'utf8'), 'new caller content');
  assert.equal(fs.readFileSync(path.join(f.cwd, 'outside'), 'utf8'), 'caller outside edit');
});

test('recovery-guard: a continuation cannot expand retained private write scope even with a matching blob digest', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
  memoryRunFs(ports, runDir);
  await start({ ports, runDir, machine: awaitingMachine, handlers: fakeHandlers, runStarted: RUN_STARTED });
  const changed = { ...awaitingMachine, codec: { ...awaitingMachine.codec!, runtime: () => 'fixed-runtime' } };
  assert.equal((await checkpoint.rebind({ ports, runDir, machine: changed, handlers: {}, reason: 'Local repair' })).exitCode, 0);
  mutateCheckpoint(ports, runDir, (saved) => { saved.state.permitted = ['outside-original-scope']; });
  const before = ports.fs.readBase64(path.join(runDir, 'events.jsonl'));
  const result = await checkpoint.rebind({ ports, runDir, machine: changed, handlers: {}, reason: 'Further repair' });
  assert.equal(result.exitCode, 2); assert.match(result.frame?.error ?? '', /continuation changed state/);
  assert.deepEqual(ports.fs.readBase64(path.join(runDir, 'events.jsonl')), before);
});

for (const location of ['state', 'queue'] as const) for (const defect of ['manifest', 'content', 'delta'] as const) for (const route of ['send', 'status', 'event-dry-run'] as const)
test(`recovery-guard: ${route} rejects corrupt ${location} ${defect} before advancement`, async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run'); let calls = 0;
  memoryRunFs(ports, runDir);
  let proof: ReturnType<typeof checkpointProof>;
  const machine = { ...awaitingMachine, step: (state: Parameters<typeof awaitingMachine.step>[0], event: Parameters<typeof awaitingMachine.step>[1]) => {
    if (event.type === 'SNAPSHOT') return { state: { tag: 'verifying' as const, counters: state.counters, path: 'plan.md', ...(location === 'state' ? { proof } : {}) },
      effects: [{ kind: 'verify' as const, id: 'retained.verify.1', purpose: 'final', commands: [], ...(location === 'queue' ? { proof } : {}) }] };
    return awaitingMachine.step(state, event);
  } };
  const handlers = { snapshot: async (effect: Parameters<NonNullable<typeof fakeHandlers.snapshot>>[0]) => { calls++; proof = checkpointProof(ports, runDir); return [{ type: 'SNAPSHOT' as const, effectId: effect.id, fingerprint: {}, diff: {} }]; },
    verify: async () => { calls++; throw new Error('uncertain command'); } };
  assert.equal((await start({ ports, runDir, machine, handlers, runStarted: RUN_STARTED })).exitCode, 2);
  const manifest = loadRecovery(ports, runDir, proof!.recovery);
  const target = defect === 'manifest' ? proof!.recovery.path : defect === 'delta' ? proof!.delta.path : `recovery-contents/${Object.values(manifest.contents)[0]}`;
  ports.fs.writeAtomic(path.join(runDir, target), 'corrupt');
  ports.fs.writeAtomic(path.join(runDir, 'candidate.txt'), 'retained candidate');
  const before = ports.fs.listFiles(runDir).map(file => [file, ports.fs.readBase64(path.join(runDir, file))]);
  const result = await send({ ports, runDir, machine, handlers, ...(route !== 'send' ? { dryRun: true } : {}),
    ...(route === 'event-dry-run' ? { rawEvent: { type: 'AUTHORED', path: 'plan.md' } } : {}) });
  assert.equal(result.exitCode, 2, JSON.stringify(result));
  assert.match(result.frame?.error ?? '', /(?:recovery manifest|immutable recovery content|immutable evidence bytes)/i);
  assert.equal(calls, 2);
  assert.deepEqual(ports.fs.listFiles(runDir).map(file => [file, ports.fs.readBase64(path.join(runDir, file))]), before);
});

test('recovery-guard: hydration verifies retained plan revision without requiring mutable external plan bytes', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run'), externalPlan = path.join(tempDir(), 'external.plan.md');
  memoryRunFs(ports, runDir);
  const governedText = '# Retained external plan', planHash = `sha256:${checkpoint.sha256(governedText)}`;
  const machine = { ...awaitingMachine, step: (state: Parameters<typeof awaitingMachine.step>[0], event: Parameters<typeof awaitingMachine.step>[1]) => {
    const result = awaitingMachine.step(state, event);
    return { ...result, state: { ...result.state, plan: { governedText }, planHash, planPath: externalPlan } };
  } };
  assert.equal((await start({ ports, runDir, machine, handlers: fakeHandlers, runStarted: RUN_STARTED })).exitCode, 0);
  assert.equal(ports.fs.exists(externalPlan), false);
  assert.equal((await send({ ports, runDir, machine, handlers: fakeHandlers, dryRun: true })).exitCode, 0);
});

for (const route of ['send', 'status', 'event-dry-run'] as const)
test(`recovery-guard: ${route} rejects corrupt references introduced by an operational tail`, async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run'); let calls = 0;
  memoryRunFs(ports, runDir);
  let proof: ReturnType<typeof checkpointProof>;
  const machine = { ...awaitingMachine, step: (state: Parameters<typeof awaitingMachine.step>[0], event: Parameters<typeof awaitingMachine.step>[1]) => {
    if (event.type === 'SNAPSHOT') return { state: { tag: 'verifying' as const, counters: state.counters, path: 'plan.md', proof },
      effects: [{ kind: 'verify' as const, id: 'tail.verify.1', purpose: 'final', commands: [] }] };
    return awaitingMachine.step(state, event);
  } };
  const handlers = { snapshot: async () => { calls++; throw new Error('interrupted snapshot'); }, verify: async () => { calls++; return []; } };
  assert.equal((await start({ ports, runDir, machine, handlers, runStarted: RUN_STARTED })).exitCode, 2);
  proof = checkpointProof(ports, runDir);
  const snapshot = readJournal(ports, runDir).checkpoint!.line;
  const saved = JSON.parse(ports.fs.readText(path.join(runDir, snapshot.checkpoint!.path)));
  appendEvent(ports, runDir, 'SNAPSHOT', { effectId: saved.open[0], fingerprint: {}, diff: {} });
  ports.fs.writeAtomic(path.join(runDir, proof.recovery.path), 'corrupt');
  const before = ports.fs.listFiles(runDir).map(file => [file, ports.fs.readBase64(path.join(runDir, file))]);
  const result = await send({ ports, runDir, machine, handlers, ...(route !== 'send' ? { dryRun: true } : {}),
    ...(route === 'event-dry-run' ? { rawEvent: { type: 'AUTHORED', path: 'plan.md' } } : {}) });
  assert.equal(result.exitCode, 2, JSON.stringify(result));
  assert.match(result.frame?.error ?? '', /recovery manifest/i);
  assert.equal(calls, 1);
  assert.deepEqual(ports.fs.listFiles(runDir).map(file => [file, ports.fs.readBase64(path.join(runDir, file))]), before);
});

for (const defect of ['missing', 'rewrite'] as const) for (const route of ['status', 'rebind', 'receipt'] as const)
test(`review-manifest: ${route} rejects ${defect} fixCandidate before verification recovery`, async () => {
  const f = await pausedReview(), id = (f.first.frame!.data['findings'] as { id: string }[])[0]!.id;
  const fix = await send({ ...f.options, rawEvent: { type: 'RULINGS', rulings: { [id]: { ruling: 'accept', fix: { affectedPaths: ['src/a.ts'], dependsOn: [], verification: ['check'] } } } } });
  let launches = 0;
  const handlers = { ...f.handlers, verify: async () => { launches++; throw Error('interrupted verification'); } };
  const interrupted = await send({ ...f.options, handlers, rawEvent: { type: 'FIXES_APPLIED', clusters: (fix.frame!.data['clusters'] as { clusterId: string }[]).map(cluster => ({ clusterId: cluster.clusterId, status: 'applied' })) } });
  assert.equal(interrupted.exitCode, 2);
  const state = f.state(); assert.equal(state.tag, 'fix-verify');
  if (!('c' in state)) throw Error('missing context');
  const manifest = state.c.fixCandidate!;
  if (defect === 'missing') f.ports.fs.remove(manifest);
  else { const value = JSON.parse(f.ports.fs.readText(manifest)); value.working['src/outside.ts'] = 'forged'; f.ports.fs.writeAtomic(manifest, JSON.stringify(value)); }
  const before = f.ports.fs.listFiles(f.runDir).map(file => [file, f.ports.fs.readBase64(path.join(f.runDir, file))]);
  const result = route === 'rebind' ? await checkpoint.rebind({ ...f.options, handlers, reason: 'compatible repair' }) : await send({ ...f.options, handlers, ...(route === 'status' ? { dryRun: true } : {}) });
  assert.equal(result.exitCode, 2); assert.match(result.frame?.error ?? '', /immutable review manifest/);
  assert.equal(launches, 1);
  assert.deepEqual(f.ports.fs.listFiles(f.runDir).map(file => [file, f.ports.fs.readBase64(path.join(f.runDir, file))]), before);
});
