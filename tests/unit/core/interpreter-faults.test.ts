import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { MAX_STEPS, send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { appendEvent, journalPath } from '../../../skills/dispatch/scripts/core/journal.ts';
import { LOCK_FILE } from '../../../skills/dispatch/scripts/core/lock.ts';
import type { Handlers } from '../../../skills/dispatch/scripts/core/types.ts';
import { fakePorts, tempDir, type FakePorts } from '../../helpers/fake-ports.ts';
import { awaitingMachine, fakeHandlers, neverAwaitingMachine, RUN_STARTED } from './fixtures/machines.ts';

async function startAwaiting(ports: FakePorts) {
  const runDir = path.join(tempDir(), 'runs', '001-ask');
  const result = await start({ runDir, runRel: 'runs/001-ask', machine: awaitingMachine, handlers: fakeHandlers, ports, runStarted: RUN_STARTED });
  return { runDir, result };
}

const bytes = (runDir: string) => fs.readFileSync(journalPath(runDir));

// Split from interpreter.test.ts to stay under the 1 s per-file budget: replay, recovery, and engine faults.

test('a never-awaiting machine faults at MAX_STEPS with exit 2, a byte-identical journal, and no lock', async () => {
  const ports = fakePorts();
  const runDir = tempDir();
  appendEvent(ports, runDir, 'RUN_STARTED', { ...RUN_STARTED, type: undefined });
  const journal = bytes(runDir);
  const result = await send({ runDir, machine: neverAwaitingMachine, handlers: fakeHandlers, ports });
  assert.equal(result.exitCode, 2);
  assert.equal(result.frame?.await, 'done');
  assert.deepEqual(result.frame?.data, { outcome: 'fault' });
  assert.match(result.frame?.error ?? '', new RegExp(`MAX_STEPS \\(${MAX_STEPS}\\)`));
  assert.deepEqual(bytes(runDir), journal);
  assert.equal(fs.existsSync(path.join(runDir, LOCK_FILE)), false);
  assert.equal(ports.timers, 0);
});

test('a handler exception faults with a byte-identical journal and no lock', async () => {
  const ports = fakePorts();
  const { runDir } = await startAwaiting(ports);
  const journal = bytes(runDir);
  const handlers: Handlers = { ...fakeHandlers, verify: async () => { throw new Error('boom'); } };
  const result = await send({ runDir, machine: awaitingMachine, handlers, ports, rawEvent: { type: 'AUTHORED', path: 'p.md' } });
  assert.equal(result.exitCode, 2);
  assert.match(result.frame?.error ?? '', /boom/);
  assert.deepEqual(bytes(runDir), journal);
  assert.equal(fs.existsSync(path.join(runDir, LOCK_FILE)), false);
});

test('a handler returning no terminal result is an engine fault', async () => {
  const ports = fakePorts();
  const runDir = tempDir();
  appendEvent(ports, runDir, 'RUN_STARTED', { ...RUN_STARTED, type: undefined });
  const handlers: Handlers = { snapshot: async (effect) => [{ type: 'WAVE_PROGRESS', effectId: effect.id, slot: 's', status: 'x' }] };
  const result = await send({ runDir, machine: awaitingMachine, handlers, ports });
  assert.equal(result.exitCode, 2);
  assert.match(result.frame?.error ?? '', /exactly one terminal result/);
});
