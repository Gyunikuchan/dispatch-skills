import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { hashes } from '../../../scripts/generate-hashes.ts';
import { collectRunFacts } from '../../../skills/dispatch/scripts/core/diagnostics.ts';
import { fold, send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { journalPath, readJournal } from '../../../skills/dispatch/scripts/core/journal.ts';
import type { Event, Handlers, JournalLine, Machine } from '../../../skills/dispatch/scripts/core/types.ts';
import { renderDiagnostics } from '../../../skills/dispatch/scripts/domain/diagnostics.ts';
import { createWaveHandler, finishWave, runWaveWorker, startWave, type WaveContext, type WaveDeps, type WorkerDeps } from '../../../skills/dispatch/scripts/effects/wave.ts';
import { claudeUsage } from '../../../skills/dispatch/scripts/lib/diagnostic-usage.ts';
import type { LinkFs } from '../../../skills/dispatch/scripts/lib/fs-ext.ts';
import { checkIntegrity, generateSkillHashes, MANIFEST_NAME, readVersion } from '../../../skills/dispatch/scripts/lib/integrity.ts';
import { SPECS } from '../../../skills/dispatch/scripts/providers/index.ts';
import { runDelegate, type RunnerPorts } from '../../../skills/dispatch/scripts/providers/runner.ts';
import type { DelegateRequest, Invocation, LaunchRequest, ModeId, ProcessResult, ProviderId, ProviderSpec, RunOutcome, RunResult } from '../../../skills/dispatch/scripts/providers/types.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { awaitingMachine, fakeHandlers, RUN_STARTED, waveMachine } from './fixtures/machines.ts';

const CLEAN = JSON.stringify({ status: 'CLEAN', findings: [] });
const ok = (text = CLEAN): RunOutcome => ({ status: 'ok', text, sessionId: null, resume: null });
const fail = (cls: Extract<RunOutcome, { status: 'fail' }>['cls']): RunOutcome => ({ status: 'fail', cls, detail: cls });
const attempt = (provider: ProviderId, model: string | null, outcome: string, extra: Partial<Invocation> = {}): Invocation =>
  ({ provider, model, mode: 'cli', effort: null, launched: true, durationMs: 5, outcome, ...extra });
const unlaunched = (provider: ProviderId, model: string | null, outcome: string, effort: string | null = null): Invocation => ({ provider, model, mode: 'cli', effort, launched: false, outcome });
const result = (outcome: RunOutcome, ...invocations: Invocation[]): RunResult => ({ outcome, invocations });
/** A launch error as the runner throws it: the original error with the attempts it already holds. */
const thrown = (...invocations: Invocation[]) => Object.assign(new Error('spawn EACCES'), { invocations });

// SECTION: Wave harness — scripted worker runs, single-shot handler, slot rows from WAVE_DONE.

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
    list: (dir) => { const root = `${dir.replace(/\\/g, '/')}/`; return [...files.keys()].map((key) => key.replace(/\\/g, '/')).filter((key) => key.startsWith(root)).map((key) => key.slice(root.length).split('/')[0]!).filter((name, i, all) => all.indexOf(name) === i); },
    remove: (file) => { files.delete(file); },
  };
}

const slot = (name: string, provider: string, extra: Record<string, unknown> = {}) => ({ slot: name, provider, index: 0, native: false, reserve: false, ...extra });

/** `modes` overrides the launchable modes; `unpathed` slots get no prompt paths in the wave input. */
function setupWave(script: Record<string, Array<RunResult | Error>>, roster: Record<string, unknown>[], orchestrator: ProviderId | null = null, options: { modes?: WorkerDeps['modes']; unpathed?: readonly string[] } = {}) {
  const linkFs = memLinkFs();
  const workers: Promise<unknown>[] = [];
  const worker: WorkerDeps = {
    fs: linkFs, proc: { pid: 10, host: 'h' }, clock: { now: () => 1000, every: () => () => {} }, specs: SPECS, modes: options.modes ?? (() => ['cli'] as ModeId[]),
    run: async (provider, req, mode) => {
      const next = script[`${provider}:${req.model ?? '-'}:${mode}`]?.shift();
      if (next instanceof Error) throw next;
      return next ?? result(fail('not-found'), unlaunched(provider, req.model, 'not-found'));
    },
  };
  const context: WaveContext = {
    review: 'code', orchestratorPlatform: orchestrator, cwd: '/repo',
    paths: Object.fromEntries(roster.filter((row) => !options.unpathed?.includes(row['slot'] as string)).map((row) => [row['slot'] as string, { promptPath: '/run/p.md', logPath: `/run/${String(row['slot'])}.log`, attachments: [] }])),
  };
  const deps: WaveDeps = {
    fs: linkFs, proc: { host: 'h', isAlive: () => true }, clock: { now: () => 1000 }, context: () => context,
    launchWorker: (runDir, id, n) => { workers.push(runWaveWorker(runDir, id, n, worker)); },
    // A throwing worker still leaves its outcome files, which the handler reads like a crashed worker's.
    awaitWorker: async () => { await Promise.allSettled(workers); },
  };
  const effect = { kind: 'wave' as const, id: 'e1', round: 1, roster, timeoutMs: 60000 };
  const rows = async () => {
    const events = await createWaveHandler(deps)(effect, fakePorts(), { runDir: '/run', attempt: 1 });
    const last = events.at(-1);
    return last?.type === 'WAVE_DONE' ? last.slots : assert.fail(`no WAVE_DONE: ${JSON.stringify(events)}`);
  };
  return { deps, effect, rows };
}

// SECTION: Runner harness — scripted processes, no spawn.

const processResult = (over: Partial<ProcessResult> = {}): ProcessResult =>
  ({ exit: 0, signal: null, stdout: '{"result":"R"}', stdoutPath: '/r/log', stderrTail: '', durationMs: 7, timedOut: false, truncated: false, ...over });
const request: DelegateRequest = {
  promptPath: '/r/p.md', model: 'sonnet', effort: 'high', sandbox: false, schemaPath: null, resume: null, cwd: '/repo', timeoutMs: 5000, outputCapBytes: 100000,
  attachments: [], logPath: '/r/log', briefPath: '/r/brief.md',
};
function runnerPorts(starts: Array<ProcessResult | Error>): RunnerPorts {
  const files = new Map<string, string>([['/r/p.md', 'Review it']]);
  return {
    process: {
      start: () => { const next = starts.shift(); if (!next || next instanceof Error) throw next ?? new Error('no launch scripted'); return { pid: 50, done: Promise.resolve(next) }; },
      signal: () => {},
    },
    clock: { now: () => 0, every: () => () => {} },
    fs: { readText: (f) => files.get(f) ?? '', writeText: (f, t) => { files.set(f, t); }, realpath: (f) => files.has(f) ? f : null, size: (f) => files.has(f) ? Buffer.byteLength(files.get(f) ?? '') : null, readPrefix: (f, n) => (files.get(f) ?? '').slice(0, n) },
    platform: { os: 'linux', arch: 'x64', wsl: false, bubblewrap: true, argvLimit: 100000, home: '/h', path: [], pathExt: [] },
    binary: 'claude', nonce: () => 'N0NCE', env: { PATH: '/bin' },
  };
}
/** Rejects an effort on the first launch, so the runner relaunches once without it. */
const effortSpec: ProviderSpec = {
  ...SPECS.claude,
  parse: (_out: ProcessResult, launch: LaunchRequest): RunOutcome => launch.effort ? { status: 'fail', cls: 'config', detail: 'effort unsupported', retryWithoutEffort: true } : ok(),
};

// SECTION: Attempts on slot rows

test('SC4 records effort retry attempts', async () => {
  const run = await runDelegate(effortSpec, request, 'cli', runnerPorts([processResult({ durationMs: 7 }), processResult({ durationMs: 9 })]));
  assert.deepEqual(run.invocations, [
    attempt('claude', 'sonnet', 'config', { effort: 'high', durationMs: 7 }),
    attempt('claude', 'sonnet', 'ok', { durationMs: 9 }),
  ]);
  const w = setupWave({ 'claude:sonnet:cli': [result(run.outcome, ...run.invocations)] }, [slot('claude[0]', 'claude', { model: 'sonnet' })]);
  const [row] = await w.rows();
  assert.equal(row?.['state'], 'success');
  assert.deepEqual(row?.['invocations'], run.invocations);
});

test('SC4 records model cascade attempts', async () => {
  const w = setupWave({
    'claude:opus:cli': [result(fail('model-not-found'), attempt('claude', 'opus', 'model-not-found'))],
    'claude:sonnet:cli': [result(ok(), attempt('claude', 'sonnet', 'ok'))],
  }, [slot('claude[0]', 'claude', { model: ['opus', 'sonnet'] })]);
  const [row] = await w.rows();
  assert.deepEqual([row?.['state'], row?.['model']], ['success', 'sonnet']);
  assert.deepEqual(row?.['invocations'], [attempt('claude', 'opus', 'model-not-found'), attempt('claude', 'sonnet', 'ok')]);
});

test('SC4 records reserve substitute attempts', async () => {
  const w = setupWave({
    'codex:-:cli': [result(fail('quota'), attempt('codex', null, 'quota'))],
    'claude:opus:cli': [result(ok(), attempt('claude', 'opus', 'ok'))],
  }, [slot('codex[0]', 'codex'), slot('claude[9]', 'claude', { reserve: true, model: 'opus' })]);
  const [row] = await w.rows();
  assert.deepEqual([row?.['state'], row?.['by']], ['reserve', 'claude[9]']);
  assert.deepEqual(row?.['invocations'], [attempt('codex', null, 'quota'), attempt('claude', 'opus', 'ok')]);
});

test('SC4 keeps failed attempts on native fallback', async () => {
  const w = setupWave({ 'claude:primary:cli': [result(fail('quota'), attempt('claude', 'primary', 'quota'))] }, [slot('claude[0]', 'claude', { model: 'primary' })], 'claude');
  const ctx = { runDir: '/run', attempt: 1 };
  const begun = startWave(w.effect, ctx, w.deps);
  const events = await finishWave(w.effect, ctx, begun, [{ sourceKey: 'claude[0]#fallback', text: CLEAN }], { ...w.deps, review: 'code' });
  const last = events.at(-1);
  const row = last?.type === 'WAVE_DONE' ? last.slots[0] : assert.fail(JSON.stringify(events));
  assert.equal(row?.['state'], 'native');
  assert.deepEqual(row?.['invocations'], [attempt('claude', 'primary', 'quota')]);
});

test('SC4 records prelaunch failure', async () => {
  const spec: ProviderSpec = { ...SPECS.claude, prepare: async () => ({ kind: 'fail', outcome: { status: 'fail', cls: 'model-not-loaded', detail: 'offline' } }) };
  const ports = { ...runnerPorts([]), prepare: { fetchModels: async () => null, acquireGpuLock: async () => () => {} } };
  const run = await runDelegate(spec, request, 'cli', ports);
  assert.equal(run.outcome.status === 'fail' && run.outcome.cls, 'model-not-loaded');
  assert.deepEqual(run.invocations, [{ provider: 'claude', model: 'sonnet', mode: 'cli', effort: 'high', launched: false, outcome: 'model-not-loaded' }]);
});

const noCodex = (provider: ProviderId): ModeId[] => provider === 'codex' ? [] : ['cli'];

test('SC4 records prelaunch failure without launchable mode or prompt paths', async () => {
  const modeless = setupWave({}, [slot('codex[0]', 'codex', { model: ['gpt-6-sol', 'gpt-6-mini'], effort: 'high' })], null, { modes: noCodex });
  const [missing] = await modeless.rows();
  assert.deepEqual([missing?.['state'], missing?.['invocations']], ['failed', [unlaunched('codex', 'gpt-6-sol', 'not-found', 'high')]]);
  const pathless = setupWave({}, [slot('claude[0]', 'claude', { model: 'sonnet' })], null, { unpathed: ['claude[0]'] });
  const [config] = await pathless.rows();
  assert.deepEqual([config?.['state'], config?.['invocations']], ['failed', [unlaunched('claude', 'sonnet', 'config')]]);
});

test('SC4 reserve after prelaunch failure journals both records once and H1 counts it', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), '.state/runs/001-wave');
  const w = setupWave({ 'claude:opus:cli': [result(ok(), attempt('claude', 'opus', 'ok'))] },
    [slot('codex[0]', 'codex', { model: 'gpt-6-sol' }), slot('claude[9]', 'claude', { reserve: true, model: 'opus' })], null, { modes: noCodex });
  const handlers: Handlers = { wave: async (effect, effectPorts, ctx) => createWaveHandler(w.deps)({ ...effect, roster: w.effect.roster }, effectPorts, ctx) };
  assert.equal((await start({ ports, runDir, machine: waveMachine, handlers, runStarted: RUN_STARTED, diagnosticToggle: () => false })).frame?.await, 'done');
  const wave = [...readJournal(ports, runDir).records].find((line) => line.type === 'WAVE_DONE');
  const [row] = wave?.data['slots'] as Record<string, unknown>[];
  assert.deepEqual([row?.['state'], row?.['by']], ['reserve', 'claude[9]']);
  assert.deepEqual(row?.['invocations'], [unlaunched('codex', 'gpt-6-sol', 'not-found'), attempt('claude', 'opus', 'ok')]);
  const facts = collectRunFacts(ports, runDir, {}, (lines) => { fold(waveMachine, lines); return { steps: [], orchestratorBytes: 0 }; });
  const report = renderDiagnostics([facts]).text;
  assert.ok(report.includes('- Evidence: `not-found`: 1 of 2 CLI attempts failed (codex ×1).'), report);
});

test('SC4 ok launch with refused output journals the refusal and H1 counts it', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), '.state/runs/001-wave');
  const usage = { input: 10, output: 2, scope: 'invocation' as const, provenance: 'claude.result.usage', inputSemantics: 'uncached' as const };
  const w = setupWave({
    'claude:opus:cli': [result(ok("I can't help with that review."), attempt('claude', 'opus', 'ok', { usage }))],
    'claude:sonnet:cli': [result(ok(), attempt('claude', 'sonnet', 'ok'))],
  }, [slot('claude[0]', 'claude', { model: ['opus', 'sonnet'] })]);
  const handlers: Handlers = { wave: async (effect, effectPorts, ctx) => createWaveHandler(w.deps)({ ...effect, roster: w.effect.roster }, effectPorts, ctx) };
  assert.equal((await start({ ports, runDir, machine: waveMachine, handlers, runStarted: RUN_STARTED, diagnosticToggle: () => false })).frame?.await, 'done');
  const wave = [...readJournal(ports, runDir).records].find((line) => line.type === 'WAVE_DONE');
  const [row] = wave?.data['slots'] as Record<string, unknown>[];
  assert.deepEqual([row?.['state'], row?.['model']], ['success', 'sonnet']);
  assert.deepEqual(row?.['invocations'], [attempt('claude', 'opus', 'refusal', { usage }), attempt('claude', 'sonnet', 'ok')], 'the refused attempt keeps its duration and usage');
  const facts = collectRunFacts(ports, runDir, {}, (lines) => { fold(waveMachine, lines); return { steps: [], orchestratorBytes: 0 }; });
  const report = renderDiagnostics([facts]).text;
  assert.ok(report.includes('`refusal`: 1 of 2 CLI attempts failed (claude ×1)'), report);
});

test('SC4 measured attempt then throwing launch keeps both records', async () => {
  const error = await runDelegate(effortSpec, request, 'cli', runnerPorts([processResult({ durationMs: 7 }), new Error('spawn EACCES')])).then(() => null, (value: unknown) => value as { invocations?: Invocation[] });
  assert.deepEqual(error?.invocations, [
    attempt('claude', 'sonnet', 'config', { effort: 'high', durationMs: 7 }),
    { provider: 'claude', model: 'sonnet', mode: 'cli', effort: null, launched: false, outcome: 'launch-failed' },
  ]);
  const w = setupWave({
    'claude:opus:cli': [result(fail('model-not-found'), attempt('claude', 'opus', 'model-not-found'))],
    'claude:sonnet:cli': [thrown(unlaunched('claude', 'sonnet', 'launch-failed'))],
  }, [slot('claude[0]', 'claude', { model: ['opus', 'sonnet'] })]);
  const [row] = await w.rows();
  assert.deepEqual([row?.['state'], row?.['cls']], ['failed', 'worker']);
  assert.deepEqual(row?.['invocations'], [attempt('claude', 'opus', 'model-not-found'), unlaunched('claude', 'sonnet', 'launch-failed')]);
});

test('SC4 measured primary then throwing reserve keeps all records once', async () => {
  const w = setupWave({
    'codex:-:cli': [result(fail('quota'), attempt('codex', null, 'quota'))],
    'claude:opus:cli': [thrown(unlaunched('claude', 'opus', 'launch-failed'))],
  }, [slot('codex[0]', 'codex'), slot('claude[9]', 'claude', { reserve: true, model: 'opus' })]);
  const [row] = await w.rows();
  assert.equal(row?.['state'], 'failed');
  assert.deepEqual(row?.['invocations'], [attempt('codex', null, 'quota'), unlaunched('claude', 'opus', 'launch-failed')]);
});

test('SC4 worker result carries invocations into runVoice', async () => {
  const usage = { input: 10, output: 2, cacheRead: 30, scope: 'invocation' as const, provenance: 'claude.result.usage', inputSemantics: 'uncached' as const };
  const w = setupWave({ 'codex:gpt-5:cli': [result(ok(), attempt('codex', 'gpt-5', 'ok', { usage }))] }, [slot('codex[0]', 'codex', { model: 'gpt-5' })]);
  const [row] = await w.rows();
  assert.deepEqual(row?.['invocations'], [attempt('codex', 'gpt-5', 'ok', { usage })]);
});

// SECTION: Journal and host protocol

test('SC4 journals invocations when disabled', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), '.state/runs/001-wave');
  const w = setupWave({ 'codex:-:cli': [result(ok(), attempt('codex', null, 'ok'))] }, [slot('codex[0]', 'codex')]);
  const handlers: Handlers = { wave: async (effect, effectPorts, ctx) => createWaveHandler(w.deps)({ ...effect, roster: w.effect.roster }, effectPorts, ctx) };
  const done = await start({ ports, runDir, machine: waveMachine, handlers, runStarted: RUN_STARTED, diagnosticToggle: () => false });
  assert.equal(done.frame?.await, 'done');
  assert.equal(done.frame?.data['diagnostics'], undefined);
  const wave = [...readJournal(ports, runDir).records].find((line) => line.type === 'WAVE_DONE');
  assert.deepEqual((wave?.data['slots'] as Record<string, unknown>[])[0]?.['invocations'], [attempt('codex', null, 'ok')]);
  assert.equal(fs.existsSync(path.join(path.dirname(path.dirname(path.dirname(runDir))), 'diagnostics.md')), false);
});

type HostState = { tag: 'booting' | 'native' | 'write' | 'done' };
/** Awaits `native`, then `write`, then completes; exercises receipt shapes without a full workflow. */
const hostMachine: Machine<HostState> = {
  initial: () => ({ tag: 'booting' }),
  step(state, event) {
    if (event.type === 'RUN_STARTED') return { state: { tag: 'native' }, effects: [] };
    if (event.type === 'NATIVE_RESULTS' && state.tag === 'native') return { state: { tag: 'write' }, effects: [] };
    if (event.type === 'WRITE_ENVELOPE' && state.tag === 'write') return { state: { tag: 'done' }, effects: [] };
    return { state, effects: [] };
  },
  awaitOf: (state) => state.tag === 'booting' ? null : state.tag,
  project: (state) => ({ at: `host › ${state.tag}`, data: state.tag === 'done' ? { outcome: 'complete' } : { kind: state.tag } }),
  transitions: [{ from: 'native', on: 'NATIVE_RESULTS', to: 'write' }, { from: 'write', on: 'WRITE_ENVELOPE', to: 'done' }],
};

test('SC4 accepts native and receipt attestation', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
  const base = { ports, runDir, machine: hostMachine, handlers: {} };
  assert.equal((await start({ ...base, runStarted: RUN_STARTED })).frame?.await, 'native');
  const native = await send({ ...base, rawEvent: { type: 'NATIVE_RESULTS', slots: [{ slot: 'claude[0]', model: 'haiku', tokens: 1200, durationMs: 3000 }] } });
  assert.equal(native.frame?.await, 'write', native.frame?.error);
  const receipt = { type: 'WRITE_ENVELOPE', envelopePath: 'e.json', task: 'T1', attempt: 1, signature: 's', handle: 'h', tokens: 900, durationMs: 4000 };
  assert.equal((await send({ ...base, rawEvent: receipt })).frame?.await, 'done');
  const lines = [...readJournal(ports, runDir).records];
  assert.deepEqual(lines.find((line) => line.type === 'NATIVE_RESULTS')?.data['slots'], [{ slot: 'claude[0]', model: 'haiku', tokens: 1200, durationMs: 3000 }]);
  assert.deepEqual([lines.find((line) => line.type === 'WRITE_ENVELOPE')?.data['tokens'], lines.find((line) => line.type === 'WRITE_ENVELOPE')?.data['durationMs']], [900, 4000]);
});

const notes = (lines: Iterable<JournalLine>) => [...lines].filter((line) => line.type === 'DIAGNOSTIC_NOTE');

test('SC4 journals rejected event note without moving reply seq', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
  const base = { ports, runDir, machine: awaitingMachine, handlers: fakeHandlers };
  const begun = await start({ ...base, runStarted: RUN_STARTED });
  const rejected = await send({ ...base, rawEvent: { type: 'AUTHORED', path: '../escape.md' } });
  assert.match(rejected.frame?.error ?? '', /inside the session/);
  assert.equal(rejected.frame?.reply, begun.frame?.reply);
  const [note] = notes(readJournal(ports, runDir).records);
  assert.deepEqual([note?.seq, note?.data['kind'], note?.data['eventType']], [readJournal(ports, runDir).count, 'event-rejected', 'AUTHORED']);
  assert.equal(note?.data['reason'], 'invalid-value at event.path');
  const malformed = await send({ ...base, rawEvent: '{' });
  assert.equal(malformed.frame?.reply, begun.frame?.reply);
  assert.equal(notes(readJournal(ports, runDir).records)[1]?.data['eventType'], 'UNKNOWN');
  const done = await send({ ...base, rawEvent: { type: 'AUTHORED', path: 'plan.md' } });
  assert.equal(done.frame?.await, 'done');
  const seqs = [...readJournal(ports, runDir).records].map((line) => line.seq);
  assert.deepEqual(seqs, seqs.map((_seq, index) => index + 1));
});

test('SC4 note keeps dry-run and status reply boundary', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
  const base = { ports, runDir, machine: awaitingMachine, handlers: fakeHandlers };
  const begun = await start({ ...base, runStarted: RUN_STARTED });
  await send({ ...base, rawEvent: { type: 'SNAPSHOT' } });
  const bytes = fs.readFileSync(journalPath(runDir));
  const status = await send({ ...base, dryRun: true });
  const preview = await send({ ...base, dryRun: true, rawEvent: { type: 'AUTHORED', path: 'plan.md' } });
  assert.equal(status.frame?.reply, begun.frame?.reply);
  assert.deepEqual(preview.verdict, { valid: true });
  assert.deepEqual(fs.readFileSync(journalPath(runDir)), bytes);
});

test('SC4 note bypasses machine apply', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
  const seen: string[] = [];
  let renders = 0;
  const machine: Machine<ReturnType<typeof awaitingMachine.initial>> = {
    ...awaitingMachine,
    step: (state, event: Event) => { seen.push(event.type); return awaitingMachine.step(state, event); },
    render: () => { renders++; },
  };
  const base = { ports, runDir, machine, handlers: fakeHandlers };
  await start({ ...base, runStarted: RUN_STARTED });
  renders = 0;
  await send({ ...base, rawEvent: { type: 'VERIFY_DONE' } });
  assert.equal(renders, 0);
  assert.equal(notes(readJournal(ports, runDir).records).length, 1);
  assert.equal(fold(machine, readJournal(ports, runDir).records).state.tag, 'authoring');
  assert.equal((await send({ ...base, rawEvent: { type: 'AUTHORED', path: 'plan.md' } })).frame?.await, 'done');
  assert.equal(seen.includes('DIAGNOSTIC_NOTE'), false);
});

// SECTION: Usage and build identity

test('SC4 claude usage keeps per-model counters', () => {
  const usage = claudeUsage(JSON.stringify({ type: 'result', modelUsage: {
    'claude-sonnet-4-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40 },
    'claude-haiku-4-5': { inputTokens: 5, outputTokens: 1 },
  } }));
  assert.deepEqual(usage?.models, { 'claude-sonnet-4-5': { input: 100, output: 20, cacheRead: 300, cacheWrite: 40 }, 'claude-haiku-4-5': { input: 5, output: 1 } });
  assert.deepEqual([usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite], [105, 21, 300, 40]);
  assert.deepEqual(usage?.actualModels, ['claude-sonnet-4-5', 'claude-haiku-4-5']);
});

test('SC4 integrity ignores version key', () => {
  const root = tempDir(), skill = path.join(root, 'skills/dispatch');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# skill\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.7.1' }));
  assert.deepEqual(hashes(root), []);
  const manifest = JSON.parse(fs.readFileSync(path.join(skill, MANIFEST_NAME), 'utf8')) as Record<string, string>;
  assert.deepEqual(manifest, { $version: '0.7.1', ...generateSkillHashes(skill) });
  assert.deepEqual(checkIntegrity(skill), { status: 'ok' });
  assert.equal(readVersion(skill), '0.7.1');
  assert.deepEqual(hashes(root, true), []);
});
