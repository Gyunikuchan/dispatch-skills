import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { send, start, loadExecution } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { encodePrivate, decodePrivate, sha256 } from '../../../skills/dispatch/scripts/core/checkpoint.ts';
import { readJournal } from '../../../skills/dispatch/scripts/core/journal.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { awaitingMachine, fakeHandlers, RUN_STARTED } from './fixtures/machines.ts';
import { rootStateCodec } from '../../../skills/dispatch/scripts/machines/checkpoint.ts';
import { start as startTasks } from '../machines/fixtures/implement-tasks.ts';

test('checkpoint-state: pin continuation rejects empty and mismatched effect identities', () => {
 const begun = beginReview({ kind: 'plan', target: 'x.plan.md', cap: 1, breadth: 1, context: '', roster: [], timeoutMs: 1000, governingSpec: { path: 'x.spec.md', hash: 'sha256:' + 'a'.repeat(64) } }, 'review', {});
 assert.ok(begun.state.tag === 'pin-check');
 const initial = { tag: 'review', run: { verb: 'review', argument: 'x.plan.md', slug: 'x' }, child: begun.state };
 assert.deepEqual(rootStateCodec.decode(rootStateCodec.encode(initial as never)), initial);
 for (const child of [{ ...begun.state, effectId: '' }, { ...begun.state, c: { ...begun.state.c, effectId: '' } }, { ...begun.state, pending: { ...begun.state.pending, id: 'other.prepare-review.1' } }]) {
 assert.throws(() => rootStateCodec.decode(encodePrivate({ ...initial, child })), /review pin/);
 }
});

test('checkpoint-state: accepted prefix does not call the changed reducer', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
  assert.equal((await start({ runDir, ports, machine: awaitingMachine, handlers: fakeHandlers, runStarted: RUN_STARTED })).exitCode, 0);
  const changed = { ...awaitingMachine, step: () => { throw new Error('accepted prefix was replayed'); } };
  const restored = await send({ runDir, ports, machine: changed, handlers: fakeHandlers, dryRun: true });
  assert.equal(restored.exitCode, 0, restored.frame?.error);
  assert.equal(restored.frame?.await, 'author');
});

test('checkpoint-state: failed replay retains source binding and rejects incomplete continuation identity', () => {
  const begun = startTasks(1).result;
  assert.ok('c' in begun.state && begun.state.c);
  const pendingReplay = { input: { rebase: true as const, archivedName: 'integration-archive', replay: { base: 'b0', head: 'accepted-head' } }, sources: ['retired-head', 'accepted-head'] };
  const initial: RootState = { tag: 'implement', run: { verb: 'implement', argument: 'x.plan.md', slug: 'implement' }, child: { tag: 'failure', c: { ...begun.state.c, pendingReplay }, reason: 'replay interrupted', changedPaths: [] } };
  assert.equal(initial.child.tag, 'failure');
  if (initial.child.tag !== 'failure') throw new Error('failure required');
  assert.deepEqual(rootStateCodec.decode(rootStateCodec.encode(initial)), initial);
  for (const changed of [
    { ...pendingReplay, sources: ['retired-head'] },
    { ...pendingReplay, sources: ['accepted-head', 'accepted-head'] },
    { ...pendingReplay, input: { ...pendingReplay.input, replay: { base: '', head: 'accepted-head' } } },
    { ...pendingReplay, conflict: { replay: { archivedName: 'foreign-archive', base: 'b0', head: 'accepted-head' } } },
  ]) {
    const invalid = { ...initial, child: { ...initial.child, c: { ...initial.child.c, pendingReplay: changed } } };
    assert.throws(() => rootStateCodec.decode(encodePrivate(invalid)), /pending delivery replay/);
  }
});

test('checkpoint-state: referenced checkpoint corruption fails closed', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
  await start({ runDir, ports, machine: awaitingMachine, handlers: fakeHandlers, runStarted: RUN_STARTED });
  const last = [...readJournal(ports, runDir).records].at(-1)!;
  const ref = (last as unknown as { checkpoint?: { path: string } }).checkpoint;
  assert.ok(ref, 'accepted result must reference its private checkpoint');
  fs.writeFileSync(path.join(runDir, ref.path), '{}');
  assert.equal((await send({ runDir, ports, machine: awaitingMachine, handlers: fakeHandlers, dryRun: true })).exitCode, 2);
});

test('checkpoint-state: private nested containers and ordered open effect attempts round-trip', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
  const privateData = { handles: new Map([['T1', { handle: 'host-17', integrated: 'commit-1' }]]), retired: new Set(['T0']), optional: undefined, binding: { planHash: 'revision-1', config: { writer: 'configured-model' }, revision: 3 } };
  const machine = { ...awaitingMachine, initial: () => ({ ...awaitingMachine.initial(), privateData }), step: (state: ReturnType<typeof awaitingMachine.initial>, event: Parameters<typeof awaitingMachine.step>[1]) => {
    const result = awaitingMachine.step(state, event);
    if (event.type === 'RUN_STARTED') return { state: { ...result.state, privateData }, effects: [...result.effects, { kind: 'verify' as const, id: 'fixture.verify.99', purpose: 'queued', commands: [] }] };
    return { state: { ...result.state, privateData }, effects: result.effects };
  } };
  assert.equal((await start({ runDir, ports, machine, handlers: { snapshot: async () => { throw new Error('external effect unresolved'); } }, runStarted: RUN_STARTED })).exitCode, 2);
  const folder = loadExecution(machine, ports, runDir).folder;
  assert.deepEqual((folder.state as unknown as { privateData: unknown }).privateData, privateData);
  assert.deepEqual(folder.queue.map((effect) => effect.id), ['fixture.snapshot.1', 'fixture.verify.99']);
  assert.deepEqual([...folder.attempts], [['fixture.snapshot.1', 1]]);
  assert.deepEqual([...folder.open], ['fixture.snapshot.1']);
  assert.deepEqual(decodePrivate(encodePrivate(privateData)), privateData);
});

test('checkpoint-state: runtime mismatch blocks mutation and permits a read-only retained-state view', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
  await start({ runDir, ports, machine: awaitingMachine, handlers: fakeHandlers, runStarted: RUN_STARTED });
  const changed = { ...awaitingMachine, codec: { ...awaitingMachine.codec!, runtime: () => 'new-runtime' }, step: () => { throw new Error('accepted reducer replay'); } };
  const before = fs.readFileSync(path.join(runDir, 'events.jsonl'));
  assert.match((await send({ runDir, ports, machine: changed, handlers: fakeHandlers })).frame?.error ?? '', /runtime-mismatch/);
  assert.deepEqual(fs.readFileSync(path.join(runDir, 'events.jsonl')), before);
  assert.equal((await send({ runDir, ports, machine: changed, handlers: fakeHandlers, dryRun: true })).frame?.await, 'author');
});

for (const defect of ['schema', 'prefix', 'queue', 'open', 'attempt', 'run', 'repository'] as const) {
  test(`checkpoint-state: ${defect} corruption is rejected even with a matching blob digest`, async () => {
    const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
    await start({ runDir, ports, machine: awaitingMachine, handlers: fakeHandlers, runStarted: RUN_STARTED });
    const file = path.join(runDir, 'events.jsonl'), lines = [...readJournal(ports, runDir).records], last = lines.at(-1)!;
    const saved = JSON.parse(ports.fs.readText(path.join(runDir, last.checkpoint!.path)));
    if (defect === 'schema') saved.codec.version = 999;
    if (defect === 'prefix') saved.prefix.priorHash = '0'.repeat(64);
    if (defect === 'queue') saved.queue = encodePrivate([{ kind: 'snapshot', id: 'duplicate', since: null }, { kind: 'snapshot', id: 'duplicate', since: null }]);
    if (defect === 'open') saved.open = ['unknown'];
    if (defect === 'attempt') saved.attempts = [['unknown', 2]];
    if (defect === 'run') saved.binding.run = 'foreign-run';
    if (defect === 'repository') saved.binding.repo = { root: 'foreign' };
    const text = `${JSON.stringify(saved)}\n`, digest = sha256(text), relative = `checkpoints/${digest}.json`;
    ports.fs.publishExclusive(path.join(runDir, relative), text);
    last.checkpoint = { ...last.checkpoint!, path: relative, sha256: digest, bytes: Buffer.byteLength(text) };
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    assert.equal((await send({ runDir, ports, machine: awaitingMachine, handlers: fakeHandlers, dryRun: true })).exitCode, 2);
  });
}
import type { RosterSlot } from '../../../skills/dispatch/scripts/domain/types.ts';
import { beginReview } from '../../../skills/dispatch/scripts/machines/review.ts';
import { rootMachine, type RootState } from '../../../skills/dispatch/scripts/machines/root.ts';
import type { Handlers } from '../../../skills/dispatch/scripts/core/types.ts';

for (const variant of ['native-zero', 'negative', 'cli-zero'] as const) test(`checkpoint-state: ${variant} wave finish retains valid native binding and rejects malformed attempts`, async () => {
  const runDir = path.join(tempDir(), 'run'), ports = fakePorts();
  const roster = [{ provider: 'codex', native: variant !== 'cli-zero', model: 'configured', sandbox: true, slot: 'codex[0]', index: 0, reserve: false }] as RosterSlot[];
  const begun = beginReview({ kind: 'code', target: '', cap: 1, breadth: 1, context: null, roster, timeoutMs: 1000 }, 'review', {});
  const initial: RootState = { tag: 'review', run: { verb: 'review', argument: '', slug: 'review' }, child: begun.state };
  const machine = { ...rootMachine, initial: () => initial, step: (state: RootState, event: Parameters<typeof rootMachine.step>[1]) => event.type === 'RUN_STARTED' ? { state, effects: begun.effects } : rootMachine.step(state, event), render: () => {} };
  let finishes = 0;
  const handlers: Handlers = {
    'prepare-review': async (effect) => [{ type: 'REVIEW_PREPARED', effectId: effect.id, scope: { scope: 'full' }, promptPaths: { 'codex[0]': 'prompt.md' } }],
    'wave-start': async (effect) => [{ type: 'WAVE_STARTED', effectId: effect.id, waveKey: effect.id, attempt: variant === 'negative' ? -1 : 0, roster, native: [], early: [], claimPath: null, inputPath: 'input.json' }],
    'wave-finish': async () => { finishes++; throw new Error('Interrupted before result publication'); },
  };
  const result = await start({ ports, runDir, machine, handlers, runStarted: { ...RUN_STARTED, verb: 'review' } });
  assert.equal(result.exitCode, 2);
  if (variant === 'native-zero') {
    assert.equal(finishes, 1, result.frame?.error);
    const loaded = loadExecution(machine, ports, runDir).folder;
    assert.equal(loaded.queue[0]?.kind, 'wave-finish');
    assert.equal(loaded.queue[0]?.kind === 'wave-finish' && loaded.queue[0].attempt, 0);
    const recovered = await send({ ports, runDir, machine, handlers, dryRun: true });
    assert.equal(recovered.exitCode, 0); assert.equal(recovered.frame?.data['kind'], 'effect-recovery');
    assert.equal(finishes, 1, 'read-only status cannot relaunch the finish');
  } else {
    assert.equal(finishes, 0);
    assert.match(result.frame?.error ?? '', /checkpoint-invalid: effect descriptors/);
  }
});
