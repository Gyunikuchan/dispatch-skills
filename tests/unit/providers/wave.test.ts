import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ResultEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { createWaveHandler, createWaveStartHandler, createWaveFinishHandler, finishWave, runWaveWorker, startWave, type WaveDeps, type WaveContext, type WorkerDeps } from '../../../skills/dispatch/scripts/effects/wave.ts';
import type { LinkFs } from '../../../skills/dispatch/scripts/lib/fs-ext.ts';
import { SPECS } from '../../../skills/dispatch/scripts/providers/index.ts';
import type { DelegateRequest, ModeId, ProviderId, RunOutcome } from '../../../skills/dispatch/scripts/providers/types.ts';
import { fakePorts } from '../../helpers/fake-ports.ts';

const CLEAN = JSON.stringify({ status: 'CLEAN', findings: [] });
const FINDING = JSON.stringify({ status: 'FINDINGS', findings: [{ severity: 'MUST', locus: 'src/a.ts:L3', tag: 'correctness', defect: 'loop never ends', requiredChange: 'bound it' }] });
const ok = (text: string): RunOutcome => ({ status: 'ok', text, sessionId: null, resume: null });
const fail = (cls: Extract<RunOutcome, { status: 'fail' }>['cls']): RunOutcome => ({ status: 'fail', cls, detail: cls });

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

type Script = Record<string, RunOutcome[]>; // key `<provider>:<model>:<mode>`

function setup(script: Script, roster: Record<string, unknown>[], orchestrator: ProviderId | null = null) {
  const fs = memLinkFs();
  const calls: string[] = [];
  const requests: DelegateRequest[] = [];
  const workers: Promise<unknown>[] = [];
  const worker: WorkerDeps = {
    fs, proc: { pid: 10, host: 'h' }, clock: { now: () => 1000, every: () => () => {} }, specs: SPECS,
    modes: (provider) => (provider === 'agy' ? ['cli', 'desktop'] : ['cli']) as ModeId[],
    run: async (provider: ProviderId, req: DelegateRequest, mode: ModeId) => {
      const key = `${provider}:${req.model ?? '-'}:${mode}`;
      calls.push(key);
      requests.push(req);
      return script[key]?.shift() ?? fail('not-found');
    },
  };
  const context: WaveContext = {
    review: 'code', orchestratorPlatform: orchestrator, cwd: '/repo',
    paths: Object.fromEntries(roster.map((slot) => [slot['slot'] as string, { promptPath: '/run/p.md', logPath: `/run/${String(slot['slot'])}.log`, attachments: [] }])),
  };
  const deps: WaveDeps = {
    fs, proc: { host: 'h', isAlive: () => true }, clock: { now: () => 1000 }, context: () => context,
    launchWorker: (runDir, id, n) => { workers.push(runWaveWorker(runDir, id, n, worker)); },
    awaitWorker: async () => { await Promise.all(workers); },
  };
  const effect = { kind: 'wave' as const, id: 'e1', round: 1, roster, timeoutMs: 60000 };
  return { fs, calls, requests, deps, effect, context };
}

const slot = (name: string, provider: string, extra: Record<string, unknown> = {}) => ({ slot: name, provider, index: 0, native: false, reserve: false, ...extra });
const done = (events: readonly ResultEvent[]) => {
  const last = events.at(-1);
  assert.equal(last?.type, 'WAVE_DONE');
  assert.equal(events.filter((event) => event.type === 'WAVE_DONE').length, 1);
  return last?.type === 'WAVE_DONE' ? last : assert.fail('no WAVE_DONE');
};
const states = (events: readonly ResultEvent[]) => done(events).slots.map((row) => [row['slot'], row['state']]);

test('ask-native-empty: sanitized-empty captures fail and usable neighbors survive', async () => {
  for (const text of ['   ', '```\n```', '```ts\nconst answer = 1;\n```']) {
    const w = setup({}, [slot('claude[0]', 'claude', { native: true }), slot('claude[1]', 'claude', { native: true })]);
    const start = startWave(w.effect, { runDir: '/run', attempt: 1 }, w.deps);
    const events = await finishWave(w.effect, { runDir: '/run', attempt: 1 }, start,
      [{ sourceKey: 'claude[0]', text }, { sourceKey: 'claude[1]', text: 'Useful answer\n```ts\nhidden\n```' }], { ...w.deps, review: 'ask' });
    const rows = done(events).slots;
    assert.deepEqual([rows[0]?.['state'], rows[0]?.['cls']], ['failed', 'empty-output']);
    assert.deepEqual([rows[1]?.['state'], rows[1]?.['claim']], ['native', 'Useful answer']);
  }
});

test('delegates-slots-reconciled: direct success, model cascade, mode cascade, and named failure; progress then one WAVE_DONE', async () => {
  const roster = [
    slot('codex[0]', 'codex', { model: 'gpt-5' }),
    slot('claude[0]', 'claude', { model: ['opus', 'sonnet'] }),
    slot('agy[0]', 'agy', { model: 'gemini' }),
    slot('copilot[0]', 'copilot'),
  ];
  const w = setup({
    'codex:gpt-5:cli': [ok(FINDING)],
    'claude:opus:cli': [fail('model-not-found')], 'claude:sonnet:cli': [ok(CLEAN)],
    'agy:gemini:cli': [fail('quota')], 'agy:gemini:desktop': [ok(CLEAN)],
    'copilot:-:cli': [fail('auth')],
  }, roster);
  const events = await createWaveHandler(w.deps)(w.effect, fakePorts(), { runDir: '/run', attempt: 1 });
  assert.deepEqual(events.slice(0, 4).map((event) => event.type), ['WAVE_PROGRESS', 'WAVE_PROGRESS', 'WAVE_PROGRESS', 'WAVE_PROGRESS']);
  assert.deepEqual(states(events), [['codex[0]', 'success'], ['claude[0]', 'success'], ['agy[0]', 'success'], ['copilot[0]', 'failed']]);
  const wave = done(events);
  assert.equal(wave.slots[1]?.['model'], 'sonnet');
  assert.equal(wave.slots[2]?.['mode'], 'desktop');
  assert.match(String(wave.slots[3]?.['reason']), /^auth/);
  assert.deepEqual(wave.findings.map((finding) => [finding['id'], finding['locus']]), [['R1-F001', 'src/a.ts:L3']]);
});

test('delegates-slots-reconciled: a reserve substitutes once per wave with its recorded reason', async () => {
  const roster = [slot('codex[0]', 'codex'), slot('codex[1]', 'codex'), slot('claude[9]', 'claude', { reserve: true, model: 'opus' })];
  const w = setup({ 'codex:-:cli': [fail('quota'), fail('quota')], 'claude:opus:cli': [ok(CLEAN)] }, roster);
  const events = await createWaveHandler(w.deps)(w.effect, fakePorts(), { runDir: '/run', attempt: 1 });
  assert.deepEqual(states(events), [['codex[0]', 'reserve'], ['codex[1]', 'failed']]);
  assert.match(String(done(events).slots[0]?.['record']), /^codex\[0\] → claude\[9\]: quota/);
  assert.deepEqual(w.calls.filter((call) => call.startsWith('claude')), ['claude:opus:cli']);
});

test('effect folder: a slot spills beside its log and a reserve logs beside the slot it replaces', async () => {
  const roster = [slot('codex[0]', 'codex'), slot('claude[9]', 'claude', { reserve: true, model: 'opus' })];
  const w = setup({ 'codex:-:cli': [fail('quota')], 'claude:opus:cli': [ok(CLEAN)] }, roster);
  Object.assign(w.context.paths, Object.fromEntries(roster.map((row) => [row.slot, { promptPath: `/run/e0/${row.slot}.prompt.md`, logPath: `/run/e0/${row.slot}.log`, attachments: [] }])));
  await createWaveHandler(w.deps)(w.effect, fakePorts(), { runDir: '/run', attempt: 1 });
  assert.deepEqual(w.requests.map((req) => [req.logPath, req.briefPath]), [
    ['/run/e0/codex[0].log', '/run/e0/codex[0].spill.md'],
    ['/run/e0/codex[0].claude-9.log', '/run/e0/codex[0].claude-9.spill.md'],
  ]);
});

test('delegates-fallback-triggers: refusal, truncation, empty, uncovered scope, and loose locus each cascade', async () => {
  const texts = [ok("I'm unable to help with reviewing this."), fail('truncated'), ok(''), ok('Looks fine.'),
    ok(JSON.stringify({ status: 'FINDINGS', findings: [{ severity: 'MUST', locus: 'src/a.ts', tag: 'correctness', defect: 'd', requiredChange: 'r' }] }))];
  for (const first of texts) {
    const w = setup({ 'claude:a:cli': [first], 'claude:b:cli': [ok(CLEAN)] }, [slot('claude[0]', 'claude', { model: ['a', 'b'] })]);
    const events = await createWaveHandler(w.deps)(w.effect, fakePorts(), { runDir: '/run', attempt: 1 });
    assert.deepEqual(states(events), [['claude[0]', 'success']]);
    assert.deepEqual(w.calls, ['claude:a:cli', 'claude:b:cli']);
  }
});

test('the single-shot handler rejects native slots and names an unserved runtime native fallback', async () => {
  const w = setup({}, [slot('claude[0]', 'claude', { native: true })]);
  const rejected = await createWaveHandler(w.deps)(w.effect, fakePorts(), { runDir: '/run', attempt: 1 });
  assert.equal(rejected[0]?.type === 'EFFECT_FAILED' && rejected[0].cls, 'config');
  const n = setup({ 'claude:-:cli': [fail('timeout')] }, [slot('claude[0]', 'claude')], 'claude');
  const events = await createWaveHandler(n.deps)(n.effect, fakePorts(), { runDir: '/run', attempt: 1 });
  assert.deepEqual(states(events), [['claude[0]', 'failed']]);
  assert.match(String(done(events).slots[0]?.['reason']), /native fallback unavailable/);
});

test('delegates-early-fallbacks: startWave returns progress, nativeSubagentsOnly and early descriptors; finishWave reconciles captures', async () => {
  const roster = [slot('claude[0]', 'claude', { model: 'opus' }), slot('claude[1]', 'claude', { native: true, model: 'sonnet' }), slot('codex[0]', 'codex'), slot('claude[2]', 'claude')];
  const w = setup({ 'claude:opus:cli': [fail('quota')], 'codex:-:cli': [ok(CLEAN)], 'claude:-:cli': [ok(CLEAN)] }, roster, 'claude');
  const ctx = { runDir: '/run', attempt: 1 };
  const start = startWave(w.effect, ctx, w.deps);
  assert.deepEqual(start.progress.map((event) => event.type === 'WAVE_PROGRESS' && [event.slot, event.status]),
    [['claude[0]', 'launched'], ['claude[1]', 'native-pending'], ['codex[0]', 'launched'], ['claude[2]', 'launched']]);
  assert.deepEqual(start.native.map((d) => [d.sourceKey, d.substitutesFor, d.model]), [['claude[1]', null, 'sonnet']]);
  assert.deepEqual(start.early.map((d) => [d.sourceKey, d.cascadePosition]), [['claude[0]#fallback', 0], ['claude[2]#fallback', 0]]);
  const events = await finishWave(w.effect, ctx, start, [{ sourceKey: 'claude[1]', text: FINDING }, { sourceKey: 'claude[0]#fallback', text: CLEAN }], { ...w.deps, review: 'code' });
  assert.equal(events.length, 1);
  assert.deepEqual(states(events), [['claude[0]', 'native'], ['claude[1]', 'native'], ['codex[0]', 'success'], ['claude[2]', 'success']]);
  assert.equal(done(events).findings.length, 1);
  const missing = setup({}, [slot('claude[1]', 'claude', { native: true })], 'claude');
  const bare = startWave(missing.effect, ctx, missing.deps);
  assert.deepEqual(states(await finishWave(missing.effect, ctx, bare, [], { ...missing.deps, review: 'code' })), [['claude[1]', 'failed']]);
});


test('rewrite SC3 start exposes native and early fallback before CLI completes and reconciles once', async () => {
  const w = setup({ 'codex:gpt:cli': [ok(CLEAN)] }, [slot('codex[0]', 'codex', { model: 'gpt' }), slot('claude[0]', 'claude', { native: true })], 'codex');
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const original = w.deps.awaitWorker;
  w.deps.awaitWorker = async (...args) => { await barrier; await original(...args); };
  const events = await createWaveStartHandler(w.deps)({ ...w.effect, kind: 'wave-start' }, fakePorts(), { runDir: '/run', attempt: 1 });
  const started = events[0]; assert.equal(started?.type, 'WAVE_STARTED');
  if (started?.type !== 'WAVE_STARTED') return;
  assert.equal(started.native.length, 1); assert.equal(started.early.length, 1);
  const finish = { ...w.effect, kind: 'wave-finish' as const, id: 'finish', waveKey: started.waveKey, attempt: started.attempt, captures: [{ sourceKey: 'claude[0]', text: CLEAN }, { sourceKey: 'codex[0]#fallback', text: FINDING }] };
  const result = createWaveFinishHandler(w.deps)(finish, fakePorts(), { runDir: '/run', attempt: 1 });
  release(); const completed = done(await result);
  assert.deepEqual(completed.slots.map((row) => row['state']), ['success', 'native']); assert.equal(completed.findings.length, 0);
  const replay = await createWaveStartHandler(w.deps)({ ...w.effect, kind: 'wave-start' }, fakePorts(), { runDir: '/run', attempt: 2 });
  assert.equal(replay[0]?.type === 'WAVE_STARTED' && replay[0].attempt, started.attempt); assert.equal(w.calls.length, 1);
});


test('rewrite SC4 worker requests preserve injected native config launch selectors', async () => {
  const w = setup({}, [slot('opencode[0]', 'opencode', { model: 'local/qwen' })]);
  let request: DelegateRequest | undefined;
  const worker: WorkerDeps = { configSelectors: { OPENCODE_CONFIG: '/selected/config.json', OPENCODE_CONFIG_DIR: '/selected/native' }, fs: w.fs, proc: { pid: 10, host: 'h' }, clock: { now: () => 1000, every: () => () => {} }, specs: SPECS, modes: () => ['cli'], run: async (_provider, req) => { request = req; return ok(CLEAN); } };
  w.deps.launchWorker = (dir, id, attempt) => { void runWaveWorker(dir, id, attempt, worker); };
  const start = startWave(w.effect, { runDir: '/run', attempt: 1 }, w.deps); await start.attempt; await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(request?.model, 'local/qwen'); assert.deepEqual(request?.configSelectors, { OPENCODE_CONFIG: '/selected/config.json', OPENCODE_CONFIG_DIR: '/selected/native' }); assert.equal(request?.timeoutMs, 60000);
});
