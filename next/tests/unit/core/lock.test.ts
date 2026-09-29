import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { send } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { appendEvent, journalPath, readJournal } from '../../../skills/dispatch/scripts/core/journal.ts';
import { acquireLock, LOCK_FILE, LockHeld, releaseLock } from '../../../skills/dispatch/scripts/core/lock.ts';
import { FAKE_HOST, FAKE_PID, fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { awaitingMachine, fakeHandlers, RUN_STARTED } from './fixtures/machines.ts';

const writeLock = (runDir: string, pid: number, host = FAKE_HOST) =>
  fs.writeFileSync(path.join(runDir, LOCK_FILE), JSON.stringify({ pid, startedAt: '2026-01-01T00:00:00.000Z', host }));

test('acquires exclusively and releases only its own lock', () => {
  const ports = fakePorts();
  const runDir = tempDir();
  assert.deepEqual(acquireLock(ports, runDir), { broken: null });
  const held = JSON.parse(fs.readFileSync(path.join(runDir, LOCK_FILE), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(held, { pid: FAKE_PID, startedAt: '2026-01-01T00:00:00.000Z', host: FAKE_HOST });
  assert.throws(() => acquireLock(ports, runDir), LockHeld);
  releaseLock(ports, runDir);
  assert.equal(fs.existsSync(path.join(runDir, LOCK_FILE)), false);
});

function runWithJournal() {
  const ports = fakePorts();
  const runDir = tempDir();
  appendEvent(ports, runDir, 'RUN_STARTED', { ...RUN_STARTED, type: undefined });
  appendEvent(ports, runDir, 'EFFECT_STARTED', { effectId: 'fixture.snapshot.1', kind: 'snapshot', attempt: 1 });
  appendEvent(ports, runDir, 'SNAPSHOT', { effectId: 'fixture.snapshot.1', fingerprint: {}, diff: {} });
  return { ports, runDir };
}

test('a dead-pid lock on this host is broken and LOCK_BROKEN is appended', async () => {
  const { ports, runDir } = runWithJournal();
  writeLock(runDir, 999);
  const result = await send({ runDir, machine: awaitingMachine, handlers: fakeHandlers, ports });
  assert.equal(result.exitCode, 0);
  const last = readJournal(ports, runDir).lines.at(-1);
  assert.deepEqual([last?.type, last?.data], ['LOCK_BROKEN', { stalePid: 999 }]);
  assert.equal(fs.existsSync(path.join(runDir, LOCK_FILE)), false);
});

test('a live lock exits 3 naming the pid', async () => {
  const { ports, runDir } = runWithJournal();
  ports.alive.add(555);
  writeLock(runDir, 555);
  const journal = fs.readFileSync(journalPath(runDir));
  const result = await send({ runDir, machine: awaitingMachine, handlers: fakeHandlers, ports });
  assert.deepEqual([result.exitCode, result.frame], [3, null]);
  assert.match(result.message ?? '', /pid 555/);
  assert.deepEqual(fs.readFileSync(journalPath(runDir)), journal);
  assert.equal(fs.existsSync(path.join(runDir, LOCK_FILE)), true);
});

test('a foreign-host lock exits 3 without LOCK_BROKEN', async () => {
  const { ports, runDir } = runWithJournal();
  writeLock(runDir, 999, 'other-host');
  const result = await send({ runDir, machine: awaitingMachine, handlers: fakeHandlers, ports });
  assert.equal(result.exitCode, 3);
  assert.match(result.message ?? '', /other-host/);
  assert.equal(readJournal(ports, runDir).lines.some((line) => line.type === 'LOCK_BROKEN'), false);
});
