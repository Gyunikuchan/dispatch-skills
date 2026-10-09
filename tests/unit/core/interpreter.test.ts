import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { journalPath, readJournal } from '../../../skills/dispatch/scripts/core/journal.ts';
import { LOCK_FILE } from '../../../skills/dispatch/scripts/core/lock.ts';
import { fakePorts, tempDir, type FakePorts } from '../../helpers/fake-ports.ts';
import { awaitingMachine, fakeHandlers, RUN_STARTED } from './fixtures/machines.ts';

async function startAwaiting(ports: FakePorts) {
  const runDir = path.join(tempDir(), 'runs', '001-ask');
  const result = await start({ runDir, runRel: 'runs/001-ask', machine: awaitingMachine, handlers: fakeHandlers, ports, runStarted: RUN_STARTED });
  return { runDir, result };
}

const bytes = (runDir: string) => fs.readFileSync(journalPath(runDir));
const types = (ports: FakePorts, runDir: string) => Array.from(readJournal(ports, runDir).records).map((line) => line.type);

test('start drives the machine to its await and returns one frame', async () => {
  const ports = fakePorts();
  const { runDir, result } = await startAwaiting(ports);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(Object.keys(result.frame ?? {}), ['v', 'run', 'at', 'await', 'data', 'reply', 'events']);
  assert.equal(result.frame?.await, 'author');
  assert.match(result.frame?.reply ?? '', /send --run runs\/001-ask --event @/);
  assert.deepEqual(types(ports, runDir), ['RUN_STARTED', 'EFFECT_STARTED', 'SNAPSHOT']);
  assert.equal(fs.existsSync(path.join(runDir, LOCK_FILE)), false);
});

test('start refuses an existing run folder', async () => {
  const ports = fakePorts();
  const { runDir } = await startAwaiting(ports);
  await assert.rejects(start({ runDir, machine: awaitingMachine, handlers: fakeHandlers, ports, runStarted: RUN_STARTED }), /EEXIST/);
});

test('a valid host event is appended and the loop runs to the next await', async () => {
  const ports = fakePorts();
  const { runDir } = await startAwaiting(ports);
  const result = await send({ runDir, machine: awaitingMachine, handlers: fakeHandlers, ports, rawEvent: '{"type":"AUTHORED","path":"plan.md"}' });
  assert.equal(result.frame?.await, 'done');
  assert.deepEqual(result.frame?.data, { outcome: 'complete', path: 'plan.md' });
  assert.deepEqual(types(ports, runDir).slice(3), ['AUTHORED', 'EFFECT_STARTED', 'VERIFY_DONE']);
});

test('a bad event re-emits the same frame with a one-line error and appends only an event-rejected note', async () => {
  const ports = fakePorts();
  const { runDir, result: before } = await startAwaiting(ports);
  const journal = bytes(runDir);
  for (const raw of [{ type: 'RULINGS', rulings: {} }, { type: 'AUTHORED' }, { type: 'AUTHORED', path: '../x' }, '{nope']) {
    const result = await send({ runDir, machine: awaitingMachine, handlers: fakeHandlers, ports, rawEvent: raw, runRel: 'runs/001-ask' });
    assert.equal(result.exitCode, 0);
    const { error, ...frame } = result.frame ?? { error: undefined };
    assert.deepEqual(frame, before.frame);
    assert.match(error ?? '', /^event[.:]/);
    assert.doesNotMatch(error ?? '', /\n/);
  }
  // Notes keep the operational prefix and never move the reply boundary, so every frame above matched the first.
  const after = bytes(runDir);
  assert.deepEqual(after.subarray(0, journal.length), journal);
  const notes = after.subarray(journal.length).toString('utf8').trim().split('\n').map((line) => JSON.parse(line) as { seq: number; type: string; data: Record<string, unknown> });
  assert.deepEqual(notes.map((note) => [note.seq, note.type, note.data['kind'], note.data['eventType']]), [
    [4, 'DIAGNOSTIC_NOTE', 'event-rejected', 'RULINGS'], [5, 'DIAGNOSTIC_NOTE', 'event-rejected', 'AUTHORED'],
    [6, 'DIAGNOSTIC_NOTE', 'event-rejected', 'AUTHORED'], [7, 'DIAGNOSTIC_NOTE', 'event-rejected', 'UNKNOWN'],
  ]);
});

test('dry-run validates and appends nothing', async () => {
  const ports = fakePorts();
  const { runDir } = await startAwaiting(ports);
  const journal = bytes(runDir);
  const good = await send({ runDir, machine: awaitingMachine, handlers: fakeHandlers, ports, rawEvent: { type: 'AUTHORED', path: 'p.md' }, dryRun: true });
  const bad = await send({ runDir, machine: awaitingMachine, handlers: fakeHandlers, ports, rawEvent: { type: 'AUTHORED', path: 1 }, dryRun: true });
  assert.equal(good.frame?.error, undefined);
  assert.match(bad.frame?.error ?? '', /event\.path: expected non-empty string/);
  assert.deepEqual(bytes(runDir), journal);
});

