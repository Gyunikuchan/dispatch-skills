import assert from 'node:assert/strict';
import { pausedReview } from './fixtures/review-manifest.ts';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import * as checkpoint from '../../../skills/dispatch/scripts/core/checkpoint.ts';
import { start, send, loadExecution } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { readJournal } from '../../../skills/dispatch/scripts/core/journal.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { awaitingMachine, fakeHandlers, RUN_STARTED } from './fixtures/machines.ts';
import { rootMachine, type RootState } from '../../../skills/dispatch/scripts/machines/root.ts';
import { taskFailure } from '../machines/fixtures/implement-recovery.ts';

test('rebind-runtime: local parser fix preserves accepted work without relaunch', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
  await start({ ports, runDir, machine: awaitingMachine, handlers: fakeHandlers, runStarted: RUN_STARTED });
  const prior = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8');
  const changed = { ...awaitingMachine, codec: { ...awaitingMachine.codec!, runtime: () => 'runtime-fixed' }, step: (state: Parameters<typeof awaitingMachine.step>[0], event: Parameters<typeof awaitingMachine.step>[1]) => {
    assert.notEqual(event.type, 'RUN_STARTED', 'accepted prefix replayed');
    return awaitingMachine.step(state, event);
  } };
  const rebound = await (checkpoint as typeof checkpoint & { rebind: Function }).rebind({ machine: changed, handlers: fakeHandlers, ports, runDir, reason: 'Parser fixed with the same state schema' });
  assert.equal(rebound.exitCode, 0, rebound.frame?.error);
  assert.equal(rebound.frame?.await, 'author');
  assert.ok(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').startsWith(prior));
  const lines = [...readJournal(ports, runDir).records];
  assert.equal(lines.at(-1)?.type, 'RUNTIME_REBOUND');
  assert.equal(lines.at(-1)?.data['oldRuntime'], 'fixture-runtime-1');
  assert.equal(lines.at(-1)?.data['newRuntime'], 'runtime-fixed');
  assert.equal(loadExecution(changed, ports, runDir).folder.state.tag, 'authoring');
  assert.equal((await send({ machine: changed, handlers: fakeHandlers, ports, runDir, rawEvent: { type: 'AUTHORED', path: 'accepted.plan.md' } })).frame?.await, 'done');
  assert.equal([...readJournal(ports, runDir).records].filter((line) => line.type === 'SNAPSHOT').length, 1);
});

test('rebind-runtime: root accepted tasks plan evidence candidates and handle history stay unchanged', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run'), f = taskFailure(2);
  const task = { ...f.c.tasks['T1']!, status: 'accepted' as const, handle: 'host-writer-17', candidate: 'candidate-commit', integrated: 'integrated-commit' };
  const state: RootState = { tag: 'implement', run: { verb: 'implement', argument: 'feature', slug: 'feature' }, child: { tag: 'tasks', c: { ...f.c, planHash: `sha256:${checkpoint.sha256(f.c.plan!.governedText)}`, planPath: path.join(runDir, 'feature.plan.md'), startFingerprint: null, lastFingerprint: null, tasks: { T1: task } } } };
  const machine = { ...rootMachine, initial: () => state, render: () => {} };
  assert.equal((await start({ ports, runDir, machine, handlers: {}, runStarted: { ...RUN_STARTED, verb: 'implement' } })).exitCode, 0);
  const before = loadExecution(machine, ports, runDir).folder.state;
  const changed = { ...machine, codec: { ...machine.codec!, runtime: () => 'root-runtime-fixed' }, step: () => { throw new Error('old decisions replayed'); } };
  const result = await checkpoint.rebind({ ports, runDir, machine: changed, handlers: {}, reason: 'Local parser fix' });
  assert.equal(result.exitCode, 0, result.frame?.error);
  assert.deepEqual(loadExecution(changed, ports, runDir).folder.state, before);
  assert.equal([...readJournal(ports, runDir).records].filter((line) => line.type === 'EFFECT_STARTED').length, 0);
});

test('rebind-runtime: parser repair validates the new input without replaying its old rejection', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
  await start({ ports, runDir, machine: awaitingMachine, handlers: fakeHandlers, runStarted: RUN_STARTED });
  const rawEvent = { type: 'AUTHORED', path: '../fixed.plan.md' };
  assert.ok((await send({ ports, runDir, machine: awaitingMachine, handlers: fakeHandlers, rawEvent })).frame?.error);
  const changed = { ...awaitingMachine, codec: { ...awaitingMachine.codec!, runtime: () => 'parser-fixed' }, validate: () => null };
  const result = await checkpoint.rebind({ ports, runDir, machine: changed, handlers: {}, reason: 'Parser corrected', rawEvent });
  assert.equal(result.exitCode, 0); assert.equal(result.frame?.data['eventValidated'], true);
  assert.equal(result.frame?.await, 'author');
  assert.equal((await send({ ports, runDir, machine: changed, handlers: fakeHandlers, rawEvent })).frame?.await, 'done');
  assert.equal([...readJournal(ports, runDir).records].filter((line) => line.type === 'AUTHORED').length, 1);
});

test('rebind-runtime: open queue identities survive repeated epochs and rebind launches no handler', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run'); let calls = 0;
  const handlers = { snapshot: async () => { calls++; throw new Error('interrupted'); } };
  await start({ ports, runDir, machine: awaitingMachine, handlers, runStarted: RUN_STARTED });
  const before = loadExecution(awaitingMachine, ports, runDir).folder;
  for (const runtime of ['runtime-2', 'runtime-3']) {
    const changed = { ...awaitingMachine, codec: { ...awaitingMachine.codec!, runtime: () => runtime } };
    const rebound = await checkpoint.rebind({ ports, runDir, machine: changed, handlers, reason: 'Local repair' });
    assert.equal(rebound.exitCode, 0); assert.equal(rebound.frame?.data['kind'], 'effect-recovery');
    const current = loadExecution(changed, ports, runDir).folder;
    assert.deepEqual(current.queue, before.queue); assert.deepEqual(current.attempts, before.attempts); assert.deepEqual(current.open, before.open);
  }
  assert.equal(calls, 1);
  assert.deepEqual([...readJournal(ports, runDir).records].filter((line) => line.type === 'RUNTIME_REBOUND').map((line) => line.data['epoch']), [1, 2]);
});

for (const point of ['torn-append', 'after-append'] as const) test(`rebind-runtime: ${point} retains only the durably published epoch`, async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
  await start({ ports, runDir, machine: awaitingMachine, handlers: fakeHandlers, runStarted: RUN_STARTED });
  const before = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8'), append = ports.fs.appendDurable;
  ports.fs.appendDurable = (file, text) => { if (text.includes('RUNTIME_REBOUND')) { append(file, point === 'torn-append' ? text.slice(0, 40) : text); throw new Error(point); } append(file, text); };
  const changed = { ...awaitingMachine, codec: { ...awaitingMachine.codec!, runtime: () => 'runtime-fixed' } };
  assert.equal((await checkpoint.rebind({ ports, runDir, machine: changed, handlers: {}, reason: 'Local repair' })).exitCode, 2);
  ports.fs.appendDurable = append;
  const after = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8'); assert.ok(after.startsWith(before));
  assert.equal([...readJournal(ports, runDir).records].filter((line) => line.type === 'RUNTIME_REBOUND').length, point === 'after-append' ? 1 : 0);
  assert.equal(loadExecution(changed, ports, runDir).folder.state.tag, 'authoring');
});

for (const corruption of ['none', 'missing', 'rewrite', 'projection'] as const) test(`rebind-review-manifest: legacy canonical identity migration ${corruption}`, async () => {
  const f = await pausedReview(true), before = readJournal(f.ports, f.runDir);
  const blob = JSON.parse(f.ports.fs.readText(path.join(f.runDir, before.checkpoint!.line.checkpoint!.path)));
  const baseline = corruption === 'projection' ? blob.state.c.priorManifest : blob.state.c.targetManifest;
  if (corruption === 'missing') f.ports.fs.remove(baseline);
  if (corruption === 'rewrite' || corruption === 'projection') {
    const value = JSON.parse(f.ports.fs.readText(baseline));
    if (corruption === 'projection') value.governedPaths = ['invented.ts'];
    else value.working['src/outside.ts'] = 'forged';
    f.ports.fs.writeAtomic(baseline, JSON.stringify(value));
  }
  const machine = { ...f.machine, codec: { ...f.machine.codec!, runtime: () => 'fixture-review-v3', encode: (value: Parameters<typeof f.machine.step>[0]) => structuredClone(value) } };
  const journal = f.ports.fs.readText(path.join(f.runDir, 'events.jsonl'));
  const dry = await send({ ...f.options, rawEvent: { type: 'RULINGS', rulings: {} }, dryRun: true });
  assert.equal(dry.exitCode, 2, 'ordinary hydration cannot silently add identity');
  let launches = 0;
  const handlers = Object.fromEntries(Object.keys(f.handlers).map(key => [key, async () => { launches++; throw Error('rebind launched a handler'); }])) as typeof f.handlers;
  const result = await checkpoint.rebind({ ...f.options, machine, handlers, reason: 'Bind authenticated legacy review manifests' });
  assert.equal(launches, 0);
  if (corruption !== 'none') {
    assert.equal(result.exitCode, 2, result.frame?.error);
    assert.equal(f.ports.fs.readText(path.join(f.runDir, 'events.jsonl')), journal);
    return;
  }
  assert.equal(result.exitCode, 0, result.frame?.error);
  const state = loadExecution(machine, f.ports, f.runDir).folder.state;
  assert.ok('c' in state && state.c.priorManifestRef && state.c.targetManifestRef);
  assert.equal(state.tag, 'fix');
  assert.equal(readJournal(f.ports, f.runDir).checkpoint!.line.data['migration'], 'review-manifest-v1');
  assert.ok(f.ports.fs.readText(path.join(f.runDir, 'events.jsonl')).startsWith(journal));
});
