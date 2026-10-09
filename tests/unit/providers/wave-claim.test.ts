import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  arbitrate, listWorkerClaims, runWaveWorker, safeSlot, STALE_GRACE_MS, startWave, type ClaimDeps, type WaveDeps, type WaveInput, type WorkerDeps,
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

test('a live pid with a heartbeat stale past startedAt + timeoutMs + 30 s → attempt n+1 without a kill', () => {
  const fs = seeded();
  claim(fs, 1, { pid: 77, host: 'h', startedAt: 0 });
  const past = TIMEOUT + STALE_GRACE_MS + 1;
  fs.writeAtomic(heartbeatPath(RUN, 'e1', 1), JSON.stringify({ heartbeatAt: past - 40000 }));
  const deps = claims(fs, new Set([77]), past);
  assert.deepEqual(arbitrate(deps, RUN, 'e1', 1, TIMEOUT), { action: 'launch', attempt: 2 });
  // A fresh heartbeat keeps it live even past the deadline.
  fs.writeAtomic(heartbeatPath(RUN, 'e1', 1), JSON.stringify({ heartbeatAt: past - 1000 }));
  assert.deepEqual(arbitrate(deps, RUN, 'e1', 1, TIMEOUT), { action: 'reattach', attempt: 1 });
  // Before the deadline plus grace a live pid is live even without a heartbeat.
  fs.remove(heartbeatPath(RUN, 'e1', 1));
  assert.deepEqual(arbitrate(claims(fs, new Set([77]), TIMEOUT), RUN, 'e1', 1, TIMEOUT), { action: 'reattach', attempt: 1 });
});

test('earlier attempts’ files are ignored; the worker self-enforces its deadline', async () => {
  const fs = seeded();
  fs.writeAtomic(outcomePath(RUN, 'e1', 1, 'codex[0]'), JSON.stringify({ state: 'failed', slot: 'codex[0]', cls: 'quota', reason: 'old', records: [] }));
  const fresh = worker(fs);
  const result = await runWaveWorker(RUN, 'e1', 2, fresh);
  assert.equal(result.launched && result.finals[0]?.state, 'success');
  assert.equal(JSON.parse(fs.readText(outcomePath(RUN, 'e1', 1, 'codex[0]')) ?? '{}').reason, 'old');
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
