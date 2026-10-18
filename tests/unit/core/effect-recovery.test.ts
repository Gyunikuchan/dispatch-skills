import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { descriptorHash } from '../../../skills/dispatch/scripts/core/effect-recovery.ts';
import { send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { readJournal } from '../../../skills/dispatch/scripts/core/journal.ts';
import type { Handler } from '../../../skills/dispatch/scripts/core/types.ts';
import { startWave, waveRecovery, type WaveDeps } from '../../../skills/dispatch/scripts/effects/wave.ts';
import type { LinkFs } from '../../../skills/dispatch/scripts/lib/fs-ext.ts';
import { runPaths } from '../../../skills/dispatch/scripts/lib/session.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { memoryRunFs } from '../../helpers/memory-run-fs.ts';
import { awaitingMachine, fakeHandlers, RUN_STARTED, waveMachine } from './fixtures/machines.ts';

// SECTION: Terminal uncertainty and recovery disposition

test('recovery-effect: missing terminal record cannot relaunch an uncertain writer', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
  memoryRunFs(ports, runDir);
  let launches = 0;
  const handlers = { wave: async () => { launches++; throw new Error('external command interrupted'); } };
  await start({ machine: waveMachine, ports, runDir, handlers, runStarted: RUN_STARTED });
  const resumed = await send({ machine: waveMachine, ports, runDir, handlers });
  assert.equal(launches, 1);
  assert.equal(resumed.frame?.await, 'decide');
  assert.equal(resumed.frame?.data['kind'], 'effect-recovery');
  assert.equal([...readJournal(ports, runDir).records].filter((line) => line.type === 'EFFECT_STARTED').length, 1);
});

test('recovery-effect: explicit retry or stop binds the exact uncertain attempt', async () => {
  for (const action of ['retry', 'stop'] as const) {
    const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
    memoryRunFs(ports, runDir);
    let launches = 0;
    const handlers = {
      wave: async (effect: Parameters<Handler>[0]) => {
        if (++launches === 1) throw new Error('uncertain');
        return [{ type: 'WAVE_DONE' as const, effectId: effect.id, round: 1, slots: [], findings: [] }];
      },
    };
    await start({ ports, runDir, machine: waveMachine, handlers, runStarted: RUN_STARTED });
    const effect = { kind: 'wave' as const, id: 'fixture.wave.1', round: 1, roster: [], timeoutMs: 1000 };
    const result = await send({
      ports,
      runDir,
      machine: waveMachine,
      handlers,
      rawEvent: {
        type: 'EFFECT_RECOVERY',
        effectId: effect.id,
        attempt: 1,
        descriptorHash: descriptorHash(effect),
        action,
        rationale: 'Checked worker and selected disposition',
      },
    });
    assert.equal(result.exitCode, action === 'retry' ? 0 : 2);
    assert.equal(launches, action === 'retry' ? 2 : 1);
    const records = [...readJournal(ports, runDir).records];
    assert.equal(records.filter((line) => line.type === 'EFFECT_RECOVERY').length, 1);
    assert.equal(records.filter((line) => line.type === 'WAVE_DONE').length, action === 'retry' ? 1 : 0);
  }
});

test('recovery-effect: a proof-free terminal assertion and stale identity cannot fabricate success', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
  memoryRunFs(ports, runDir);
  let launches = 0;
  const handlers = { wave: async () => { launches++; throw new Error('uncertain'); } };
  await start({ ports, runDir, machine: waveMachine, handlers, runStarted: RUN_STARTED });
  for (const rawEvent of [
    { type: 'WAVE_DONE', effectId: 'fixture.wave.1', round: 1, slots: [], findings: [] },
    { type: 'EFFECT_RECOVERY', effectId: 'fixture.wave.1', attempt: 99, descriptorHash: 'forged', action: 'retry', rationale: 'forged' },
  ]) {
    const result = await send({ ports, runDir, machine: waveMachine, handlers, rawEvent });
    assert.match(result.frame?.error ?? '', /effect-recovery/);
  }
  assert.equal(launches, 1);
  assert.equal([...readJournal(ports, runDir).records].filter((line) => line.type === 'WAVE_DONE').length, 0);
});

// SECTION: Sealed output and evidence recovery

test('recovery-effect: actual sealed handler output survives result publication failure without repeat', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
  memoryRunFs(ports, runDir);
  await start({ ports, runDir, machine: awaitingMachine, handlers: fakeHandlers, runStarted: RUN_STARTED });
  let calls = 0;
  const handlers = {
    ...fakeHandlers,
    verify: async (effect: Parameters<NonNullable<typeof fakeHandlers.verify>>[0]) => {
      calls++;
      return fakeHandlers.verify!(effect, ports, { runDir, attempt: 1 });
    },
  };
  const publish = ports.fs.publishExclusive;
  ports.fs.publishExclusive = (file, text) => {
    if (file.includes('checkpoints') && text.includes('"tag":"done"')) throw new Error('checkpoint failed after command');
    return publish(file, text);
  };
  assert.equal((await send({ ports, runDir, machine: awaitingMachine, handlers, rawEvent: { type: 'AUTHORED', path: 'p.md' } })).exitCode, 2);
  ports.fs.publishExclusive = publish;
  assert.equal((await send({ ports, runDir, machine: awaitingMachine, handlers })).frame?.await, 'done');
  assert.equal(calls, 1);
  assert.equal([...readJournal(ports, runDir).records].filter((line) => line.type === 'VERIFY_DONE').length, 1);
});

test('recovery-effect: handler evidence modes respect attempt and descriptor identity', async () => {
  for (const mode of ['complete', 'live', 'read', 'foreign'] as const) {
    const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
    memoryRunFs(ports, runDir);
    let calls = 0, attachments = 0;
    const handler: Handler<Extract<Parameters<Handler>[0], { kind: 'wave' }>> = async (effect) => {
      calls++;
      if (calls === 1) throw new Error('interrupted');
      return [{ type: 'WAVE_DONE', effectId: effect.id, round: 1, slots: [], findings: [] }];
    };
    await start({ ports, runDir, machine: waveMachine, handlers: { wave: handler }, runStarted: RUN_STARTED });
    handler.recovery = mode === 'read' ? { repeat: 'deterministic-read' } : {
      probe: async (effect, _ports, ctx) => {
        const identity = { effectId: effect.id, attempt: mode === 'foreign' ? 2 : ctx.attempt, descriptorHash: descriptorHash(effect) };
        const results = [{ type: 'WAVE_DONE' as const, effectId: effect.id, round: 1, slots: [], findings: [] }];
        return mode === 'live'
          ? { ...identity, status: 'live', handle: 'actual-host-handle', resume: async () => { attachments++; return results; } }
          : { ...identity, status: 'complete', evidence: 'actual immutable worker outcome', results };
      },
    };
    const resumed = await send({ ports, runDir, machine: waveMachine, handlers: { wave: handler } });
    assert.equal(resumed.exitCode, mode === 'foreign' ? 2 : 0);
    assert.equal(calls, mode === 'read' ? 2 : 1);
    assert.equal(attachments, mode === 'live' ? 1 : 0);
  }
});

test('recovery-effect: actual worker claim reattaches without crossing its launch fence twice', async () => {
  const ports = fakePorts(), runDir = tempDir(), files = new Map<string, string>();
  let launches = 0, attachments = 0;
  const fs: LinkFs = {
    readText: (file) => files.get(file) ?? null,
    writeAtomic: (file, text) => { files.set(file, text); },
    writeTemp: (file, text) => { files.set(`${file}.tmp`, text); return `${file}.tmp`; },
    link: (from, to) => {
      if (files.has(to)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      files.set(to, files.get(from)!);
    },
    remove: (file) => { files.delete(file); },
    list: (dir) => [...files.keys()].filter((file) => path.dirname(file) === dir).map((file) => path.basename(file)),
  };
  const deps: WaveDeps = {
    fs,
    proc: { ...ports.proc, isAlive: () => true },
    clock: ports.clock,
    context: () => ({
      review: 'code',
      orchestratorPlatform: 'codex',
      cwd: '/repo',
      nativeHost: true,
      paths: { 'codex[0]': { promptPath: '/prompt', logPath: '/log', attachments: [] } },
    }),
    launchWorker: (_run, id, attempt) => {
      launches++;
      fs.writeAtomic(runPaths(runDir).claim(id, attempt), JSON.stringify({ pid: 17, host: ports.proc.host, startedAt: ports.clock.now() }));
    },
    awaitWorker: async () => { attachments++; },
  };
  const effect = {
    kind: 'wave-start' as const,
    id: 'worker.wave-start.1',
    round: 1,
    timeoutMs: 1000,
    roster: [{ slot: 'codex[0]', provider: 'codex', index: 0, native: false, reserve: false }],
  };
  assert.equal(await startWave(effect, { runDir, attempt: 1 }, deps).attempt, 1);
  const proof = await waveRecovery(deps).probe!(effect, ports, { runDir, attempt: 1 });
  assert.equal(proof.status, 'live');
  if (proof.status !== 'live') assert.fail('live claim missing');
  const result = (await proof.resume()).at(-1)!;
  assert.equal(result.type, 'WAVE_STARTED');
  assert.equal(result.effectId, effect.id);
  assert.equal(launches, 1);
  assert.equal(attachments, 1);
  const wrong = await waveRecovery(deps).probe!({ ...effect, round: 2 }, ports, { runDir, attempt: 1 });
  assert.equal(wrong.status, 'unresolved');
  assert.equal(launches, 1);
});

// SECTION: Dry run verification

test('recovery-effect: recovery dry-run reports validity without mutation', async () => {
  for (const valid of [false, true]) {
    const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
    memoryRunFs(ports, runDir);
    let launches = 0;
    const handlers = { wave: async () => { launches++; throw new Error('uncertain external command'); } };
    await start({ ports, runDir, machine: waveMachine, handlers, runStarted: RUN_STARTED });
    const effect = { kind: 'wave' as const, id: 'fixture.wave.1', round: 1, roster: [], timeoutMs: 1000 };
    const before = ports.fs.listFiles(runDir).map((file) => [file, ports.fs.readBase64(path.join(runDir, file))]);
    const result = await send({
      ports,
      runDir,
      machine: waveMachine,
      handlers,
      dryRun: true,
      rawEvent: {
        type: 'EFFECT_RECOVERY',
        effectId: effect.id,
        attempt: 1,
        descriptorHash: valid ? descriptorHash(effect) : 'stale',
        action: 'retry',
        rationale: 'Inspected the retained attempt',
      },
    });
    assert.equal(result.verdict?.valid, valid);
    assert.equal(result.exitCode, valid ? 0 : 1);
    if (!valid) assert.match(result.verdict?.error ?? '', /stale effect identity/);
    assert.equal(launches, 1);
    assert.deepEqual(ports.fs.listFiles(runDir).map((file) => [file, ports.fs.readBase64(path.join(runDir, file))]), before);
  }
});
