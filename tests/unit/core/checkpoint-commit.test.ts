import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { readJournal } from '../../../skills/dispatch/scripts/core/journal.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { memoryRunFs } from '../../helpers/memory-run-fs.ts';
import fs from 'node:fs';
import { awaitingMachine, fakeHandlers, RUN_STARTED } from './fixtures/machines.ts';

test('checkpoint-commit: a later render fault retains earlier accepted effect', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
  memoryRunFs(ports, runDir);
  await start({ runDir, ports, machine: awaitingMachine, handlers: fakeHandlers, runStarted: RUN_STARTED });
  const failing = { ...awaitingMachine, render: (state: ReturnType<typeof awaitingMachine.initial>) => { if (state.tag === 'done') throw new Error('render failed'); } };
  const result = await send({ runDir, ports, machine: failing, handlers: fakeHandlers, rawEvent: { type: 'AUTHORED', path: 'p.md' } });
  assert.equal(result.exitCode, 2);
  const lines = [...readJournal(ports, runDir).records];
  assert.ok(lines.some((line) => line.type === 'VERIFY_DONE'), 'accepted verification result must survive render failure');
  const restored = await send({ runDir, ports, machine: awaitingMachine, handlers: fakeHandlers, dryRun: true });
  assert.equal(restored.frame?.await, 'done');
});

test('checkpoint-commit: handler failure retains the accepted host event and open attempt', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
  memoryRunFs(ports, runDir);
  await start({ runDir, ports, machine: awaitingMachine, handlers: fakeHandlers, runStarted: RUN_STARTED });
  await send({ runDir, ports, machine: awaitingMachine, handlers: { verify: async () => { throw new Error('after external effect'); } }, rawEvent: { type: 'AUTHORED', path: 'p.md' } });
  const lines = [...readJournal(ports, runDir).records];
  assert.equal(lines.filter((line) => line.type === 'AUTHORED').length, 1);
  assert.equal(lines.filter((line) => line.type === 'EFFECT_STARTED' && line.data['kind'] === 'verify').length, 1);
  assert.equal(lines.filter((line) => line.type === 'VERIFY_DONE').length, 0);
});

for (const point of ['before-blob', 'before-append', 'torn-append', 'after-append', 'result-blob'] as const) {
  test(`checkpoint-commit: ${point} preserves only the committed transition prefix`, async () => {
    const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
    memoryRunFs(ports, runDir);
    await start({ runDir, ports, machine: awaitingMachine, handlers: fakeHandlers, runStarted: RUN_STARTED });
    const publish = ports.fs.publishExclusive, append = ports.fs.appendDurable;
    let completed = 0;
    const handlers = { ...fakeHandlers, verify: async (effect: Parameters<NonNullable<typeof fakeHandlers.verify>>[0]) => { completed++; return fakeHandlers.verify!(effect, ports, { runDir, attempt: 1 }); } };
    ports.fs.publishExclusive = (file, text) => {
      if (file.includes('checkpoints') && (point === 'before-blob' || point === 'result-blob' && text.includes('"tag":"done"'))) throw new Error(point);
      return publish(file, text);
    };
    ports.fs.appendDurable = (file, text) => {
      if (file.endsWith('events.jsonl') && text.includes('"type":"AUTHORED"') && ['before-append', 'torn-append', 'after-append'].includes(point)) {
        if (point === 'torn-append') append(file, text.slice(0, 40));
        if (point === 'after-append') append(file, text);
        throw new Error(point);
      }
      append(file, text);
    };
    assert.equal((await send({ runDir, ports, machine: awaitingMachine, handlers, rawEvent: { type: 'AUTHORED', path: 'p.md' } })).exitCode, 2);
    ports.fs.appendDurable = append; ports.fs.publishExclusive = publish;
    const lines = [...readJournal(ports, runDir).records];
    assert.equal(lines.some((line) => line.type === 'AUTHORED'), point === 'after-append' || point === 'result-blob');
    assert.equal(lines.some((line) => line.type === 'VERIFY_DONE'), false);
    assert.equal(completed, point === 'result-blob' ? 1 : 0);
    const status = await send({ runDir, ports, machine: { ...awaitingMachine, step: () => { throw new Error('replay'); } }, handlers, dryRun: true });
    assert.equal(status.exitCode, 0, status.frame?.error);
    assert.equal(status.frame?.await, point === 'result-blob' ? 'decide' : point === 'after-append' ? 'done' : 'author');
    if (point === 'result-blob') {
      assert.equal(status.frame?.data['kind'], 'effect-recovery');
      assert.equal((status.frame?.data['effect'] as { id: string }).id, lines.find((line) => line.type === 'EFFECT_STARTED' && line.data['kind'] === 'verify')?.data['effectId']);
      assert.equal(status.frame?.data['attempt'], 1);
    }
    if (point === 'before-append' || point === 'torn-append') assert.ok(ports.fs.listFiles(path.join(runDir, 'checkpoints')).length > lines.filter((line) => line.checkpoint).length, 'unreferenced blob stays unused');
  });
}

test('checkpoint-commit: frame publication fault preserves completed state', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
  memoryRunFs(ports, runDir);
  await start({ runDir, ports, machine: awaitingMachine, handlers: fakeHandlers, runStarted: RUN_STARTED });
  const mkdir = ports.fs.mkdir;
  ports.fs.mkdir = (dir, options) => { if (dir.endsWith('events')) throw new Error('frame directory failed'); return mkdir(dir, options); };
  assert.equal((await send({ runDir, ports, machine: awaitingMachine, handlers: fakeHandlers })).exitCode, 2);
  ports.fs.mkdir = mkdir;
  assert.equal((await send({ runDir, ports, machine: awaitingMachine, handlers: fakeHandlers, dryRun: true })).frame?.await, 'author');
});
