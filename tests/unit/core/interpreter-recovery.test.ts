import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fold, send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { appendEvent, journalPath, readJournal } from '../../../skills/dispatch/scripts/core/journal.ts';
import { fakePorts, tempDir, type FakePorts } from '../../helpers/fake-ports.ts';
import { awaitingMachine, fakeHandlers, RUN_STARTED, waveMachine } from './fixtures/machines.ts';

async function startAwaiting(ports: FakePorts) {
  const runDir = path.join(tempDir(), 'runs', '001-ask');
  const result = await start({ runDir, runRel: 'runs/001-ask', machine: awaitingMachine, handlers: fakeHandlers, ports, runStarted: RUN_STARTED });
  return { runDir, result };
}

// Split from interpreter.test.ts to stay under the 1 s per-file budget: replay, recovery, and engine faults.

function waveJournal(ports: FakePorts, withProgress: boolean): string {
  const runDir = tempDir();
  appendEvent(ports, runDir, 'RUN_STARTED', { ...RUN_STARTED, type: undefined });
  appendEvent(ports, runDir, 'EFFECT_STARTED', { effectId: 'fixture.wave.1', kind: 'wave', attempt: 1 });
  if (withProgress) appendEvent(ports, runDir, 'WAVE_PROGRESS', { effectId: 'fixture.wave.1', slot: 'claude[0]', status: 'running' });
  return runDir;
}

test('an effect with only non-terminal results is in flight', () => {
  const ports = fakePorts();
  const runDir = waveJournal(ports, true);
  const folded = fold(waveMachine, readJournal(ports, runDir).lines);
  assert.deepEqual(folded.inFlight, { effect: { kind: 'wave', id: 'fixture.wave.1', round: 1, roster: [], timeoutMs: 1000 }, attempt: 1 });
});

test('a started effect without a result relaunches as attempt 2 with exactly one terminal result', async () => {
  const ports = fakePorts();
  const runDir = waveJournal(ports, false);
  const result = await send({ runDir, machine: waveMachine, handlers: fakeHandlers, ports });
  assert.equal(result.frame?.await, 'done');
  const lines = readJournal(ports, runDir).lines;
  const starts = lines.filter((line) => line.type === 'EFFECT_STARTED').map((line) => line.data['attempt']);
  assert.deepEqual(starts, [1, 2]);
  assert.equal(lines.filter((line) => line.type === 'WAVE_DONE').length, 1);
});

test('a torn tail is dropped and its effect re-executed', async () => {
  const ports = fakePorts();
  const { runDir } = await startAwaiting(ports);
  await send({ runDir, machine: awaitingMachine, handlers: fakeHandlers, ports, rawEvent: { type: 'AUTHORED', path: 'p.md' } });
  const text = fs.readFileSync(journalPath(runDir), 'utf8');
  fs.writeFileSync(journalPath(runDir), text.slice(0, text.length - 10));
  const result = await send({ runDir, machine: awaitingMachine, handlers: fakeHandlers, ports });
  assert.equal(result.frame?.await, 'done');
  const starts = readJournal(ports, runDir).lines.filter((line) => line.type === 'EFFECT_STARTED').map((line) => line.data['attempt']);
  assert.deepEqual(starts, [1, 1, 2]);
});

