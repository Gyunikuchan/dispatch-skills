import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  arbitrate, HEARTBEAT_MS, listWorkerClaims, runWaveWorker, safeSlot, STALE_GRACE_MS, WORKER_BUDGETS, startWave, type ClaimDeps, type WaveDeps, type WaveInput, type WorkerDeps,
} from '../../../skills/dispatch/scripts/effects/wave.ts';
import { runPaths } from '../../../skills/dispatch/scripts/lib/session.ts';
import { publishExclusive, type LinkFs } from '../../../skills/dispatch/scripts/lib/fs-ext.ts';
import { SPECS } from '../../../skills/dispatch/scripts/providers/index.ts';

function memLinkFs(): LinkFs {
  const files = new Map<string, string>();
  let seq = 0;
  return {
    writeTemp: (near, text) => { const temp = `${near}.tmp${seq++}`; files.set(temp, text); return temp; },
    link: (temp, final) => {
      if (files.has(final)) throw Object.assign(new Error(`EEXIST: ${final}`), { code: 'EEXIST' });
      files.set(final, files.get(temp) ?? '');
    },
    writeAtomic: (file, text) => { files.set(file, text); },
    readText: (file) => files.get(file) ?? null,
    // Like readdir: one separator on every platform, and child folders appear as names.
    list: (dir) => { const root = `${dir.replace(/\\/g, '/')}/`; return [...files.keys()].map((key) => key.replace(/\\/g, '/')).filter((key) => key.startsWith(root)).map((key) => key.slice(root.length).split('/')[0]!).filter((name, i, all) => all.indexOf(name) === i); },
    remove: (file) => { files.delete(file); },
  };
}

const RUN = '/run';
const inputPath = (run: string, id: string) => runPaths(run).input(id);
const claimPath = (run: string, id: string, n: number) => runPaths(run).claim(id, n);
const heartbeatPath = (run: string, id: string, n: number) => runPaths(run).heartbeat(id, n);
const outcomePath = (run: string, id: string, n: number, slot: string) => runPaths(run).slotOutcome(id, safeSlot(slot), n);
const TIMEOUT = 60000;
const input: WaveInput = {
  effectId: 'e1', round: 1, timeoutMs: TIMEOUT, review: 'code', orchestratorPlatform: null, cwd: '/repo',
  roster: [{ slot: 'codex[0]', provider: 'codex', index: 0, native: false, reserve: false }],
  paths: { 'codex[0]': { promptPath: '/run/p.md', logPath: '/run/codex.log', attachments: [] } },
};

function worker(fs: LinkFs, now: () => number = () => 0): WorkerDeps & { launched: number } {
  const state = { launched: 0 };
  return Object.assign(state, {
    fs, proc: { pid: 10, host: 'h' }, clock: { now, every: () => () => {} }, specs: SPECS, modes: () => ['cli' as const],
    run: async () => { state.launched++; return { outcome: { status: 'ok' as const, text: '{"status":"CLEAN","findings":[]}', sessionId: null, resume: null }, invocations: [] }; },
  });
}

function claims(fs: LinkFs, alive: Set<number>, now = 0): ClaimDeps {
  return { fs, proc: { host: 'h', isAlive: (pid) => alive.has(pid) }, clock: { now: () => now } };
}

const seeded = () => { const fs = memLinkFs(); fs.writeAtomic(inputPath(RUN, 'e1'), JSON.stringify(input)); return fs; };
const claim = (fs: LinkFs, n: number, value: object) => fs.writeAtomic(claimPath(RUN, 'e1', n), JSON.stringify(value));

test('quota decisions survive worker recovery boundaries', async (t) => {
  for (const boundary of ['input', 'claim', 'slot outcome']) {
    await t.test(`retained input survives ${boundary} without refreshing quota`, async () => {
      const fs = seeded();
      const key = { provider: 'codex', model: null, mode: 'cli' };
      const retained = { ...input, quota: { schemaVersion: 1, policyVersion: 1, decidedAt: 0, decisions: [{ key, generation: '00000000-0000-4000-8000-000000000001', skipped: true, reason: 'quota-cooldown', observedAt: 0, expiresAt: 3600000 }] } };
      fs.writeAtomic(inputPath(RUN, 'e1'), JSON.stringify(retained));
      if (boundary !== 'input') claim(fs, 1, { pid: 1, host: 'h', startedAt: 0 });
      if (boundary === 'slot outcome') fs.writeAtomic(outcomePath(RUN, 'e1', 1, 'codex[0]'), JSON.stringify({ state: 'success', slot: 'codex[0]', drafts: [], records: [] }));
      assert.deepEqual(arbitrate(claims(fs, new Set(), 7200000), RUN, 'e1', 1, TIMEOUT), { action: 'launch', attempt: 2 });
      const fresh = worker(fs, () => 7200000);
      const result = await runWaveWorker(RUN, 'e1', 2, fresh);
      assert.equal(fresh.launched, 0);
      assert.equal(result.launched && result.finals[0]?.state, 'failed');
      assert.equal(fs.readText(inputPath(RUN, 'e1')), JSON.stringify(retained));
    });
  }
  for (const completed of [false, true]) await t.test(`${completed ? 'completed publication' : 'live claim'} reattaches without preparing another snapshot`, async () => {
    const f = orphanRecovery();
    const bytes = f.fs.readText(inputPath(RUN, 'e1'));
    claim(f.fs, 1, { pid: 10, host: 'h', startedAt: 0 });
    f.deps.proc.isAlive = () => true;
    if (completed) f.fs.writeAtomic(runPaths(RUN).done('e1', 1), '{"at":0,"slots":1}');
    Object.assign(f.deps, { quota: { modes: () => ['cli'], snapshot: () => assert.fail('retained input must not consult mutable quota state') } });
    assert.equal(await startWave(f.effect, { runDir: RUN, attempt: 2 }, f.deps).attempt, 1);
    assert.deepEqual(f.launches, []);
    assert.equal(f.fs.readText(inputPath(RUN, 'e1')), bytes);
  });
  await t.test('reprobe and a quota observation cannot alter not-yet-started combinations or sibling slots', async () => {
    const fs = seeded();
    const generation = '00000000-0000-4000-8000-000000000001';
    const keys = ['first', 'next'].map((model) => ({ provider: 'codex', model, mode: 'cli' }));
    const frozen = { ...input, roster: [{ ...input.roster[0]!, model: ['first', 'next'] }, { ...input.roster[0]!, slot: 'codex[1]', model: ['first', 'next'] }], paths: { ...input.paths, 'codex[1]': input.paths['codex[0]']! }, quota: { schemaVersion: 1, policyVersion: 1, decidedAt: 0, decisions: keys.map((key) => ({ key, generation, skipped: false, reason: null })) } };
    fs.writeAtomic(inputPath(RUN, 'e1'), JSON.stringify(frozen));
    const w = worker(fs);
    const calls: (string | null)[] = [], observations: unknown[] = [];
    let mutableGeneration = generation;
    Object.assign(w, {
      run: async (_provider: unknown, req: { model: string | null }) => {
        calls.push(req.model);
        if (req.model === 'first') { mutableGeneration = '00000000-0000-4000-8000-000000000002'; return { outcome: { status: 'fail', cls: 'quota', detail: 'quota' }, invocations: [] }; }
        return { outcome: { status: 'ok', text: '{"status":"CLEAN","findings":[]}', sessionId: null, resume: null }, invocations: [] };
      },
      quotaFailure: (key: unknown, captured: string) => { observations.push({ key, captured, current: mutableGeneration }); },
    });
    const result = await runWaveWorker(RUN, 'e1', 1, w);
    assert.deepEqual(calls.sort(), ['first', 'first', 'next', 'next']);
    assert.equal(observations.length, 2);
    for (const row of observations as { captured: string; current: string }[]) { assert.equal(row.captured, generation); assert.notEqual(row.current, generation); }
    assert.deepEqual(result.launched && result.finals.map((row) => row.state), ['success', 'success']);
    assert.equal(fs.readText(inputPath(RUN, 'e1')), JSON.stringify(frozen));
  });
  await t.test('already published concurrent waves keep their eligible decisions', async () => {
    const fs = seeded();
    const key = { provider: 'codex', model: null, mode: 'cli' };
    const quota = { schemaVersion: 1, policyVersion: 1, decidedAt: 0, decisions: [{ key, generation: '00000000-0000-4000-8000-000000000001', skipped: false, reason: null }] };
    for (const id of ['e1', 'e2']) fs.writeAtomic(inputPath(RUN, id), JSON.stringify({ ...input, effectId: id, quota }));
    const w = worker(fs);
    await Promise.all(['e1', 'e2'].map((id) => runWaveWorker(RUN, id, 1, w)));
    assert.equal(w.launched, 2);
  });
  await t.test('crash after quota publication keeps captured input for a fenced replacement', async () => {
    const fs = seeded(), key = { provider: 'codex', model: null, mode: 'cli' };
    const generation = '00000000-0000-4000-8000-000000000001';
    const retained = JSON.stringify({ ...input, quota: { schemaVersion: 1, policyVersion: 1, decidedAt: 0, decisions: [{ key, generation, skipped: false, reason: null }] } });
    fs.writeAtomic(inputPath(RUN, 'e1'), retained);
    let published = 0, crash = true;
    const w = worker({ ...fs, writeAtomic: (file, text) => {
      if (crash && file.endsWith('.outcome.json')) { crash = false; throw new Error('crash after observation'); }
      fs.writeAtomic(file, text);
    } });
    Object.assign(w, { run: async () => ({ outcome: { status: 'fail', cls: 'quota', detail: 'quota' }, invocations: [] }), quotaFailure: (_key: unknown, captured: string) => { assert.equal(captured, generation); published++; } });
    await assert.rejects(runWaveWorker(RUN, 'e1', 1, w), /crash after observation/);
    assert.equal(published, 1);
    assert.equal(fs.readText(runPaths(RUN).done('e1', 1)), null);
    assert.deepEqual(arbitrate(claims(fs, new Set()), RUN, 'e1', 1, TIMEOUT), { action: 'launch', attempt: 2 });
    const result = await runWaveWorker(RUN, 'e1', 2, w);
    assert.equal(result.launched && result.finals[0]?.state, 'failed');
    assert.equal(published, 2);
    assert.equal(fs.readText(inputPath(RUN, 'e1')), retained);
  });
});

test('a tombstone fences a late worker in both link orderings', async () => {
  // Tombstone first: the worker's link fails, so no slot launches.
  const fs = seeded();
  assert.deepEqual(arbitrate(claims(fs, new Set()), RUN, 'e1', 1, TIMEOUT), { action: 'launch', attempt: 2 });
  const late = worker(fs);
  assert.deepEqual(await runWaveWorker(RUN, 'e1', 1, late), { launched: false });
  assert.equal(late.launched, 0);
  // Worker first: the tombstone link fails, the live claim wins, and the send reattaches.
  const second = seeded();
  const early = worker(second);
  await runWaveWorker(RUN, 'e1', 1, early);
  assert.equal(early.launched, 1);
  assert.deepEqual(arbitrate(claims(second, new Set([10])), RUN, 'e1', 1, TIMEOUT), { action: 'reattach', attempt: 1 });
});

test('a crash between temp write and link leaves no claim', () => {
  const fs = seeded();
  const crashing: LinkFs = { ...fs, link: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } };
  assert.throws(() => publishExclusive(crashing, claimPath(RUN, 'e1', 1), '{}'), /EIO/);
  assert.equal(fs.readText(claimPath(RUN, 'e1', 1)), null);
  assert.deepEqual(fs.list(runPaths(RUN).effectDir('e1')), ['input.json']);
});

test('EEXIST: tombstone or dead pid → attempt n+1; live pid → reattach; foreign host → engine fault naming the file', () => {
  const fs = seeded();
  claim(fs, 1, { fenced: true, by: 'send', at: 0 });
  assert.deepEqual(arbitrate(claims(fs, new Set()), RUN, 'e1', 1, TIMEOUT), { action: 'launch', attempt: 2 });
  claim(fs, 2, { pid: 77, host: 'h', startedAt: 0 });
  assert.deepEqual(arbitrate(claims(fs, new Set()), RUN, 'e1', 2, TIMEOUT), { action: 'launch', attempt: 3 });
  assert.deepEqual(arbitrate(claims(fs, new Set([77])), RUN, 'e1', 2, TIMEOUT), { action: 'reattach', attempt: 2 });
  claim(fs, 3, { pid: 77, host: 'other', startedAt: 0 });
  assert.throws(() => arbitrate(claims(fs, new Set([77])), RUN, 'e1', 3, TIMEOUT), (error: Error) => error.message.includes(claimPath(RUN, 'e1', 3)) && error.message.includes('other'));
});

test('a live pid with a heartbeat stale past the worker ceiling + 30 s → attempt n+1 without a kill', () => {
  const fs = seeded();
  claim(fs, 1, { pid: 77, host: 'h', startedAt: 0 });
  const past = WORKER_BUDGETS * TIMEOUT + STALE_GRACE_MS + 1;
  fs.writeAtomic(heartbeatPath(RUN, 'e1', 1), JSON.stringify({ heartbeatAt: past - 2 * HEARTBEAT_MS - 1 }));
  const deps = claims(fs, new Set([77]), past);
  assert.deepEqual(arbitrate(deps, RUN, 'e1', 1, TIMEOUT), { action: 'launch', attempt: 2 });
  // A fresh heartbeat keeps it live even past the deadline.
  fs.writeAtomic(heartbeatPath(RUN, 'e1', 1), JSON.stringify({ heartbeatAt: past - 1000 }));
  assert.deepEqual(arbitrate(deps, RUN, 'e1', 1, TIMEOUT), { action: 'reattach', attempt: 1 });
  // Before the deadline plus grace a live pid is live even without a heartbeat.
  fs.remove(heartbeatPath(RUN, 'e1', 1));
  assert.deepEqual(arbitrate(claims(fs, new Set([77]), TIMEOUT), RUN, 'e1', 1, TIMEOUT), { action: 'reattach', attempt: 1 });
});

test('past the worker ceiling, one late heartbeat stays live and a missed second beat is stale', () => {
  const fs = seeded();
  claim(fs, 1, { pid: 77, host: 'h', startedAt: 0 });
  const now = WORKER_BUDGETS * TIMEOUT + STALE_GRACE_MS + 1;
  fs.writeAtomic(heartbeatPath(RUN, 'e1', 1), JSON.stringify({ heartbeatAt: now - HEARTBEAT_MS - 15 }));
  assert.deepEqual(arbitrate(claims(fs, new Set([77]), now), RUN, 'e1', 1, TIMEOUT), { action: 'reattach', attempt: 1 });
  fs.writeAtomic(heartbeatPath(RUN, 'e1', 1), JSON.stringify({ heartbeatAt: now - 2 * HEARTBEAT_MS - 1 }));
  assert.deepEqual(arbitrate(claims(fs, new Set([77]), now), RUN, 'e1', 1, TIMEOUT), { action: 'launch', attempt: 2 });
});

test('a worker running a reserve between the slot deadline and the worker ceiling stays live without a heartbeat', () => {
  const fs = seeded();
  claim(fs, 1, { pid: 77, host: 'h', startedAt: 0 });
  assert.deepEqual(arbitrate(claims(fs, new Set([77]), TIMEOUT + STALE_GRACE_MS + 60_000), RUN, 'e1', 1, TIMEOUT), { action: 'reattach', attempt: 1 });
});

test('a new worker attempt ignores earlier outcome files', async () => {
  const fs = seeded();
  fs.writeAtomic(outcomePath(RUN, 'e1', 1, 'codex[0]'), JSON.stringify({ state: 'failed', slot: 'codex[0]', cls: 'quota', reason: 'old', records: [] }));
  const fresh = worker(fs);
  const result = await runWaveWorker(RUN, 'e1', 2, fresh);
  assert.equal(result.launched && result.finals[0]?.state, 'success');
  assert.equal(JSON.parse(fs.readText(outcomePath(RUN, 'e1', 1, 'codex[0]')) ?? '{}').reason, 'old');
});

test('an expired worker deadline prevents delegate launches', async () => {
  let now = 0;
  const late = worker(seeded(), () => { const value = now; now += TIMEOUT; return value; });
  const timed = await runWaveWorker(RUN, 'e1', 1, late);
  assert.equal(late.launched, 0);
  assert.equal(timed.launched && timed.finals[0]?.state === 'failed' && timed.finals[0].cls, 'timeout');
});

// SECTION: Effect folders

test('effect folder: a worker writes claim, heartbeat, outcome, and done inside its effect folder', async () => {
  const fs = seeded();
  const result = await runWaveWorker(RUN, 'e1', 1, worker(fs));
  assert.equal(result.launched, true);
  const paths = runPaths(RUN);
  for (const file of [paths.claim('e1', 1), paths.heartbeat('e1', 1), paths.slotOutcome('e1', 'codex-0', 1), paths.done('e1', 1)]) assert.notEqual(fs.readText(file), null, file);
  assert.deepEqual(fs.list(RUN), ['e1']);
});

test('effect folder: two concurrent first sends publish one launch fence and launch one worker', async () => {
  const fs = memLinkFs();
  let launches = 0;
  const deps: WaveDeps = {
    fs, proc: { host: 'h', isAlive: () => true }, clock: { now: () => 0 }, context: () => ({ review: 'code', orchestratorPlatform: null, cwd: '/repo', paths: input.paths }),
    launchWorker: () => { launches++; }, awaitWorker: async () => {},
  };
  const effect = { kind: 'wave' as const, id: 'e1', round: 1, roster: input.roster as unknown as Record<string, unknown>[], timeoutMs: TIMEOUT };
  const [first, second] = [startWave(effect, { runDir: RUN, attempt: 1 }, deps), startWave(effect, { runDir: RUN, attempt: 1 }, deps)];
  assert.deepEqual([await first.attempt, await second.attempt], [1, 1]);
  assert.equal(launches, 1);
  assert.notEqual(fs.readText(runPaths(RUN).launch('e1')), null);
});

test('effect folder: status discovery finds first and later attempts across effect folders', () => {
  const fs = seeded();
  claim(fs, 1, { pid: 1, host: 'h', startedAt: 0 });
  claim(fs, 2, { pid: 2, host: 'h', startedAt: 0 });
  fs.writeAtomic(runPaths(RUN).claim('review.wave.2', 1), '{}');
  fs.writeAtomic(runPaths(RUN).heartbeat('review.wave.2', 1), '{}');
  assert.deepEqual(listWorkerClaims(fs, RUN), [{ effect: 'e1', attempt: 1 }, { effect: 'e1', attempt: 2 }, { effect: 'review.wave.2', attempt: 1 }]);
});

function orphanRecovery(launchWorker: WaveDeps['launchWorker'] = () => {}) {
  const fs = seeded();
  const launches: number[] = [];
  const deps: WaveDeps = {
    ...claims(fs, new Set()),
    context: () => ({ review: 'code', orchestratorPlatform: null, cwd: '/repo', paths: input.paths }),
    launchWorker: (run, id, attempt) => { launches.push(attempt); launchWorker(run, id, attempt); },
    awaitWorker: async () => {},
  };
  const effect = { kind: 'wave' as const, id: 'e1', round: 1, roster: input.roster as unknown as Record<string, unknown>[], timeoutMs: TIMEOUT };
  return { fs, launches, deps, effect };
}

test('effect folder: resumed orphan-fence recovery launches a replacement', async () => {
  const w = orphanRecovery();
  w.fs.writeAtomic(runPaths(RUN).launch('e1'), JSON.stringify({ attempt: 1, host: 'h', at: 0 }));
  const resumed = startWave(w.effect, { runDir: RUN, attempt: 2 }, w.deps);
  assert.equal(await resumed.attempt, 2);
  assert.deepEqual(w.launches, [2]);
  assert.deepEqual(JSON.parse(w.fs.readText(claimPath(RUN, 'e1', 1))!), { fenced: true, by: 'send', at: 0 });
});

test('effect folder: late orphan worker is fenced by the attempt-1 tombstone', async () => {
  const w = orphanRecovery();
  w.fs.writeAtomic(runPaths(RUN).launch('e1'), '{}');
  await startWave(w.effect, { runDir: RUN, attempt: 2 }, w.deps).attempt;
  const late = worker(w.fs);
  assert.deepEqual(await runWaveWorker(RUN, 'e1', 1, late), { launched: false });
  assert.equal(late.launched, 0);
  const replacement = worker(w.fs);
  assert.equal((await runWaveWorker(RUN, 'e1', 2, replacement)).launched, true);
  assert.equal(replacement.launched, 1);
});

test('effect folder: synchronous spawn failure permits resumed recovery', async () => {
  const w = orphanRecovery((_run, _id, attempt) => { if (attempt === 1) throw new Error('spawn failed'); });
  assert.throws(() => startWave(w.effect, { runDir: RUN, attempt: 1 }, w.deps), /spawn failed/);
  assert.notEqual(w.fs.readText(runPaths(RUN).launch('e1')), null);
  assert.equal(await startWave(w.effect, { runDir: RUN, attempt: 2 }, w.deps).attempt, 2);
  assert.deepEqual(w.launches, [1, 2]);
});
