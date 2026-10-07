import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fold, send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { appendEvent, journalPath, readJournal } from '../../../skills/dispatch/scripts/core/journal.ts';
import { fakePorts, tempDir, type FakePorts } from '../../helpers/fake-ports.ts';
import { awaitingMachine, fakeHandlers, RUN_STARTED, waveMachine } from './fixtures/machines.ts';
import { rootMachine } from '../../../skills/dispatch/scripts/machines/root.ts';
import type { Handlers } from '../../../skills/dispatch/scripts/core/types.ts';
import { design, hash, run } from '../machines/fixtures/design.ts';

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


// SECTION: Effect-folder layout

const WORKER_FILES = ['claim.json', 'heartbeat.json', 'claim.a2.json', 'done.a2.json', 'launch.json'];

function seedWorkerFiles(runDir: string): string {
  const effect = path.join(runDir, 'fixture.wave.1');
  fs.mkdirSync(effect, { recursive: true });
  for (const name of [...WORKER_FILES, 'input.json', 'codex-0.log']) fs.writeFileSync(path.join(effect, name), '{}');
  return effect;
}

test('prune at done: worker claim, heartbeat, done and launch files leave each effect folder', async () => {
  const ports = fakePorts();
  const runDir = waveJournal(ports, false);
  const effect = seedWorkerFiles(runDir);
  const result = await send({ runDir, machine: waveMachine, handlers: fakeHandlers, ports });
  assert.equal(result.frame?.await, 'done');
  assert.deepEqual(fs.readdirSync(effect).sort(), ['codex-0.log', 'input.json']);
});

test('prune at done: an unlink failure warns and keeps the done outcome', async () => {
  const ports = fakePorts();
  const runDir = waveJournal(ports, false);
  const effect = seedWorkerFiles(runDir);
  ports.fs.remove = () => { throw new Error('EBUSY'); };
  const result = await send({ runDir, machine: waveMachine, handlers: fakeHandlers, ports });
  assert.deepEqual([result.frame?.await, result.exitCode], ['done', 0]);
  assert.ok(ports.stderrLines.some((line) => /could not remove fixture\.wave\.1\/claim\.json: .*EBUSY/.test(line)));
  assert.ok(fs.existsSync(path.join(effect, 'claim.json')));
});

test('legacy layout: a revision-4 run is refused with exit 1 by send and status', async () => {
  const ports = fakePorts();
  const runDir = tempDir();
  appendEvent(ports, runDir, 'RUN_STARTED', { ...RUN_STARTED, type: undefined, protocolRevision: 4 });
  const before = fs.readFileSync(journalPath(runDir));
  for (const dryRun of [false, true]) {
    const result = await send({ runDir, runRel: 'runs/legacy', machine: waveMachine, handlers: fakeHandlers, ports, dryRun });
    assert.deepEqual([result.frame, result.exitCode, result.message], [null, 1, 'layout-unsupported: runs/legacy']);
  }
  assert.deepEqual(fs.readFileSync(journalPath(runDir)), before);
});

test('legacy layout: a revision-4 design run in the session does not block starting a design implementation', async () => {
  const ports = fakePorts(), runs = path.join(tempDir(), '.state', 'runs');
  appendEvent(ports, path.join(runs, '001-design'), 'RUN_STARTED', { ...run(), type: undefined, protocolRevision: 4 });
  const handlers: Handlers = {
    'parse-artifact': async (effect) => [{ type: 'ARTIFACT_PARSED', effectId: effect.id, kind: 'design', hash, parsed: design, defects: [] }],
    snapshot: async (effect) => [{ type: 'SNAPSHOT', effectId: effect.id, fingerprint: { head: 'a'.repeat(40), index: 'i', worktree: 'w' }, diff: { paths: [] } }],
  };
  const result = await start({ ports, machine: rootMachine, handlers, runDir: path.join(runs, '002-implement'), runStarted: { ...run('implement'), argument: './x.design.md', overrides: { designRevision: hash } } });
  assert.equal(result.exitCode, 0);
  assert.notEqual(result.frame?.at, 'fault', JSON.stringify(result.frame));
});

test('event path: a dry-run config refresh still names the boundary event path', async () => {
  const ports = fakePorts();
  const { runDir } = await startAwaiting(ports);
  const result = await send({ runDir, runRel: 'runs/001-ask', machine: awaitingMachine, handlers: fakeHandlers, ports, dryRun: true, refreshConfig: true, configSource: () => ({}) });
  assert.match(result.frame?.reply ?? '', /@runs\/001-ask\/events\/\d+-author\.json$/);
});

test('event path: a stale-lock break keeps the reply path for rejection and correction', async () => {
  const ports = fakePorts();
  const { runDir, result } = await startAwaiting(ports);
  fs.writeFileSync(path.join(runDir, 'lock'), JSON.stringify({ pid: 2147483647, host: ports.proc.host, startedAt: new Date(0).toISOString() }));
  const rejected = await send({ runDir, runRel: 'runs/001-ask', machine: awaitingMachine, handlers: fakeHandlers, ports, rawEvent: { type: 'AUTHORED' } });
  assert.ok(readJournal(ports, runDir).lines.some((line) => line.type === 'LOCK_BROKEN'));
  assert.ok(rejected.frame?.error);
  assert.equal(rejected.frame.reply, result.frame?.reply);
  const again = await send({ runDir, runRel: 'runs/001-ask', machine: awaitingMachine, handlers: fakeHandlers, ports, rawEvent: { type: 'AUTHORED' } });
  assert.equal(again.frame?.reply, result.frame?.reply);
});
