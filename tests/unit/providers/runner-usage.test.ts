import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeUsage, renderDiagnostics } from '../../../skills/dispatch/scripts/toolkit/domain/diagnostics.ts';

import { agy } from '../../../skills/dispatch/scripts/providers/agy.ts';
import { claude } from '../../../skills/dispatch/scripts/providers/claude.ts';
import { codex } from '../../../skills/dispatch/scripts/providers/codex.ts';
import { opencode } from '../../../skills/dispatch/scripts/providers/opencode.ts';
import type { HostUsageFs } from '../../../skills/dispatch/scripts/lib/usage/rows.ts';
import { readOpencodeMessages } from '../../../skills/dispatch/scripts/lib/opencode-db.ts';
import {
  CONTINUE_PROMPT,
  IDLE_TIMEOUT_MS,
  buildAttachmentBlock, findSensitiveMatch, formatSafetyPrompt, GUARDRAIL_HEADER, runDelegate, type RunnerFs, type RunnerPorts,
} from '../../../skills/dispatch/scripts/providers/runner.ts';
import { batchInvocation, killArgv, mustSpill, sanitizeEnv } from '../../../skills/dispatch/scripts/providers/process-policy.ts';
import type { DelegateRequest, Launch, PlatformEnv, ProcessResult, ProviderUsageContext } from '../../../skills/dispatch/scripts/providers/types.ts';

const posix: PlatformEnv = { os: 'linux', arch: 'x64', wsl: false, bubblewrap: true, argvLimit: 100000, home: '/h', path: [], pathExt: [] };
const windows: PlatformEnv = { ...posix, os: 'win32', bubblewrap: false, argvLimit: 24000 };
const req: DelegateRequest = {
  promptPath: '/r/p.md', model: null, effort: null, sandbox: false, schemaPath: null, resume: null, cwd: '/repo', timeoutMs: 5000, outputCapBytes: 100,
  attachments: [], logPath: '/r/log', briefPath: '/r/brief.md',
};
const ok = (over: Partial<ProcessResult> = {}): ProcessResult =>
  ({ exit: 0, signal: null, stdout: '{"result":"R"}', stdoutPath: '/r/log', stderrTail: '', durationMs: 1, timedOut: false, truncated: false, ...over });

function memFs(files: Record<string, string>, links: Record<string, string> = {}): RunnerFs & { files: Map<string, string> } {
  const map = new Map(Object.entries(files));
  return {
    files: map,
    readText: (f) => map.get(f) ?? '',
    writeText: (f, t) => { map.set(f, t); },
    realpath: (f) => links[f] ?? (map.has(f) ? f : null),
  readdir: () => [],
    size: (f) => (map.has(f) ? Buffer.byteLength(map.get(f) ?? '') : null),
    readPrefix: (f, n) => Buffer.from(map.get(f) ?? '').subarray(0, n).toString('utf8'),
  };
}

/** Manual clock: timers fire only when the test advances time. */
function manualClock() {
  let now = 0;
  const timers: { at: number; ms: number; fn: () => void; live: boolean }[] = [];
  return {
    now: () => now,
    every: (ms: number, fn: () => void) => { const t = { at: now + ms, ms, fn, live: true }; timers.push(t); return () => { t.live = false; }; },
    advance(ms: number) {
      now += ms;
      for (const t of [...timers]) while (t.live && t.at <= now) { t.at += t.ms; t.fn(); }
    },
  };
}

function harness(platform: PlatformEnv, files: Record<string, string> = { '/r/p.md': 'Review it' }) {
  const launches: Launch[] = [];
  const signals: string[] = [];
  const clock = manualClock();
  let finish: (r: ProcessResult) => void = () => {};
  let activity: () => void = () => {};
  let line: (value: string, fragment?: boolean) => void = () => {};
  const fs = memFs(files);
  const ports: RunnerPorts = {
    process: {
      start: (launch, io) => {
        launches.push(launch);
        if (io.onActivity) activity = io.onActivity;
        if (io.onLine) line = io.onLine;
        if (launch.argv[0] === 'taskkill') return { pid: 99, done: Promise.resolve(ok()) };
        return { pid: 50, done: new Promise<ProcessResult>((resolve) => { finish = resolve; }) };
      },
      signal: (pid, sig) => { signals.push(`${pid}:${sig}`); },
    },
    clock, fs, usageFs: memUsageFs({}), platform, binary: 'claude', nonce: () => 'N0NCE',
    env: { PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-1', GITHUB_TOKEN: 'ghp', AWS_SECRET_ACCESS_KEY: 'x', HTTPS_PROXY: 'http://p' },
  };
  return { ports, launches, signals, clock, fs, finish: (r: ProcessResult) => finish(r), activity: () => activity(), line: (value: string, fragment?: boolean) => { activity(); line(value, fragment); } };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

























const makeNudgeSpec = (sessionId: string | null): any => ({
  ...claude,
  id: 'codex',
  silentUntilExit: undefined,
  attemptSession: () => sessionId,
  parse: (out: ProcessResult) =>
    out.stdout.includes('FINAL')
      ? { status: 'ok' as const, text: 'FINAL', sessionId: 'sess1', resume: null }
      : { status: 'fail' as const, cls: 'empty-output' as const, detail: 'empty' },
  argv: (r: any) => ({ argv: ['bin', r.resume ? `resume:${r.resume}` : 'fresh', r.prompt], stdin: null, env: {}, cwd: r.cwd }),
});

const makeCapacitySpec = (retryAfterMs?: number): any => ({
  ...makeNudgeSpec('sess1'),
  parse: (out: ProcessResult) =>
    out.stdout.includes('FINAL')
      ? { status: 'ok' as const, text: 'FINAL', sessionId: 'sess1', resume: null }
      : { status: 'fail' as const, cls: 'capacity' as const, detail: 'at capacity', ...(retryAfterMs === undefined ? {} : { retryAfterMs }) },
});



























const opencodeText = (text: string) => JSON.stringify({ type: 'text', sessionID: 'ses', part: { text } });









function memUsageFs(files: Record<string, string | Buffer> = {}, extra: Partial<HostUsageFs> = {}): HostUsageFs {
  const find = (file: string): Buffer | undefined => {
    const norm = file.replaceAll('\\', '/');
    const val = files[norm] ?? files[file];
    return val === undefined ? undefined : typeof val === 'string' ? Buffer.from(val, 'utf8') : val;
  };
  return {
    list: (dir) => {
      const prefix = dir.replaceAll('\\', '/').replace(/\/$/, '') + '/';
      const names = new Set<string>();
      for (const rawKey of Object.keys(files)) {
        const k = rawKey.replaceAll('\\', '/');
        if (k.startsWith(prefix)) {
          const rest = k.slice(prefix.length);
          const seg = rest.split('/')[0];
          if (seg) names.add(seg);
        }
      }
      return [...names];
    },
    stat: (file) => {
      const buf = find(file);
      return buf ? { size: buf.length, mtimeMs: 0 } : null;
    },
    read: (file, maxBytes) => {
      const buf = find(file);
      if (!buf) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return buf.subarray(0, maxBytes);
    },
    decompress: null,
    ...extra,
  };
}

const claudeEntry = (atMs: number, input: number, output: number, model = 'claude-haiku-5-5') =>
  JSON.stringify({ type: 'assistant', timestamp: new Date(atMs).toISOString(), effort: 'low', message: { id: `m_${atMs}`, model, usage: { input_tokens: input, output_tokens: output } } });










// T2 wrap-up RED: deadline notice, stop/resume, budget, fallback.

test('resumed launch usage follows proven per-launch semantics', async () => {
  { // a per-launch provider records resumed usage
    const h = harness(posix);
    const usage = { input: 3, output: 2, inputSemantics: 'uncached' as const, scope: 'invocation' as const, provenance: 'fixture' };
    const spec = { ...claude, resumeUsage: 'per-launch' as const, usage: () => usage };
    const pending = runDelegate(spec, { ...req, collectUsage: true, resume: 'session' }, 'cli', h.ports);
    await flush(); h.finish(ok());
    assert.deepEqual((await pending).invocations[0]?.usage, { ...usage, provenance: 'stdout' });
  }
  { // no usage is recorded without proven semantics and the parser is never called
    const h = harness(posix);
    let calls = 0;
    const spec = { ...claude, resumeUsage: undefined, usage: () => { calls++; return undefined; } };
    const pending = runDelegate(spec, { ...req, collectUsage: true, resume: 'session' }, 'cli', h.ports);
    await flush(); h.finish(ok());
    assert.equal((await pending).invocations[0]?.usage, undefined);
    assert.equal(calls, 0);
  }
});

test('OpenCode invocation rows attribute measured or launch model, effort, and window', async () => {
  const h = harness(posix);
  let context: ProviderUsageContext | undefined;
  const usage = {
    input: 12, output: 4, scope: 'invocation' as const, provenance: 'opencode.db.messages', inputSemantics: 'uncached' as const,
    actualModels: ['measured/model'], actualEffort: 'max', models: { 'measured/model#max': { input: 12, output: 4 } },
  };
  const spec = { ...opencode, usage: (_raw: string, seen?: ProviderUsageContext) => { context = seen; return usage; } };
  const pending = runDelegate(spec, { ...req, collectUsage: true, model: 'launch/model', effort: 'high', agent: 'explore', readOnlyVerified: true }, 'cli', h.ports);
  await flush();
  h.clock.advance(25);
  h.finish(ok({ stdout: opencodeText('R') }));
  const done = await pending;
  assert.equal(done.invocations[0]?.model, 'measured/model');
  assert.equal(done.invocations[0]?.effort, 'max');
  assert.equal(context?.launchStartMs, 0);
  assert.equal(context?.launchEndMs, 25);
  assert.equal(context?.readOpencodeMessages, readOpencodeMessages);
  { // launch model and effort are kept when usage reports none
    const fallback = harness(posix);
    const fallbackUsage = { input: 3, output: 1, scope: 'invocation' as const, provenance: 'opencode.step.finish', inputSemantics: 'uncached' as const };
    const fallbackPending = runDelegate({ ...opencode, usage: () => fallbackUsage }, { ...req, collectUsage: true, model: 'launch/model', effort: 'high', agent: 'explore', readOnlyVerified: true }, 'cli', fallback.ports);
    await flush(); fallback.finish(ok({ stdout: opencodeText('R') }));
    const fallbackDone = await fallbackPending;
    assert.equal(fallbackDone.invocations[0]?.model, 'launch/model');
    assert.equal(fallbackDone.invocations[0]?.effort, 'high');
  }
});

test('OpenCode resumed launch receives its own launch window', async () => {
  const h = harness(posix);
  const contexts: ProviderUsageContext[] = [];
  const spec = {
    ...opencode,
    attemptSession: () => 'sess1',
    usage: (_raw: string, seen?: ProviderUsageContext) => { contexts.push(seen!); return undefined; },
    parse: (out: ProcessResult) => out.stdout.includes('FINAL')
      ? { status: 'ok' as const, text: 'FINAL', sessionId: 'sess1', resume: null }
      : { status: 'fail' as const, cls: 'empty-output' as const, detail: 'empty' },
  };
  const pending = runDelegate(spec, { ...req, collectUsage: true }, 'cli', h.ports);
  await flush();
  h.clock.advance(40);
  h.finish(ok({ exit: 1, stdout: '' }));
  await flush(); await flush();
  h.clock.advance(60);
  h.finish(ok({ stdout: 'FINAL' }));
  await pending;
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0]?.launchStartMs, 0);
  assert.equal(contexts[0]?.launchEndMs, 40);
  assert.equal(contexts[1]?.launchStartMs, 41);
  assert.equal(contexts[1]?.launchEndMs, 100);
});

test('OpenCode resumed launch keeps a shared boundary millisecond in the earlier launch', async () => {
  const windows = async (firstMs: number, pauseMs: number) => {
    const h = harness(posix);
    const contexts: ProviderUsageContext[] = [];
    const spec = {
      ...opencode,
      attemptSession: () => 'sess1',
      usage: (_raw: string, seen?: ProviderUsageContext) => { contexts.push(seen!); return undefined; },
      parse: (out: ProcessResult) => out.stdout.includes('FINAL')
        ? { status: 'ok' as const, text: 'FINAL', sessionId: 'sess1', resume: null }
        : { status: 'fail' as const, cls: 'empty-output' as const, detail: 'empty' },
    };
    const pending = runDelegate(spec, { ...req, collectUsage: true, onResume: () => h.clock.advance(pauseMs) }, 'cli', h.ports);
    await flush();
    h.clock.advance(firstMs);
    h.finish(ok({ exit: 1, stdout: '' }));
    await flush(); await flush();
    h.finish(ok({ stdout: 'FINAL' }));
    await pending;
    return contexts;
  };
  const sameMillisecond = await windows(0, 0);
  assert.equal(sameMillisecond[0]?.launchEndMs, 0);
  assert.equal(sameMillisecond[1]?.launchStartMs, 1);
  const advanced = await windows(40, 20);
  assert.equal(advanced[1]?.launchStartMs, 60);
});

test('Claude resume records per-launch fallback usage alongside cumulative model usage', async () => {
  const h = harness(posix);
  const priorUsage = { input: 10, output: 5, scope: 'invocation' as const, provenance: 'claude.result.modelUsage', inputSemantics: 'uncached' as const };
  const pending = runDelegate(claude, { ...req, collectUsage: true, resume: 'session', priorUsage }, 'cli', h.ports);
  await flush();
  h.finish(ok({ stdout: JSON.stringify({ type: 'result', result: 'answer', session_id: 'session', usage: { input_tokens: 2, output_tokens: 3 } }) }));
  const usage = (await pending).invocations[0]?.usage;
  assert.deepEqual(usage, { input: 2, output: 3, scope: 'invocation', provenance: 'stdout', inputSemantics: 'uncached' });
});

test('resumed launch subtracts usage already recorded for its session', async () => {
  const h = harness(posix);
  const prior = { input: 10, output: 5, scope: 'invocation' as const, provenance: 'fixture', inputSemantics: 'uncached' as const, models: { m: { input: 10, output: 5 } } };
  const spec = { ...claude, id: 'agy' as const, resumeUsage: 'cumulative' as const, usage: () => ({ ...prior, input: 14, output: 8, models: { m: { input: 14, output: 8 } } }) };
  const pending = runDelegate(spec, { ...req, collectUsage: true, resume: 'session', priorUsage: prior }, 'cli', h.ports);
  await flush(); h.finish(ok());
  const usage = (await pending).invocations[0]?.usage;
  assert.equal(usage?.input, 4); assert.equal(usage?.output, 3); assert.equal(usage?.scope, 'invocation');
  assert.deepEqual({ ...usage?.models }, { m: { input: 4, output: 3 } });
  const rows = [prior, usage!].map(value => ({ phase: 'ask-run', provider: 'agy', model: 'm', surface: 'cli' as const, launched: true, outcome: 'ok', usage: normalizeUsage(value, value.inputSemantics)! }));
  const report = renderDiagnostics([{ phases: [], reviews: [], invocations: rows }]).text;
  assert.match(report, /^\| agy \| 14 \| — \| — \| 8 \| — \| delegates 2\/2 \|/m);
  assert.match(report, /^\| CLI delegates \| ██████████ 100% \| — \| 22 \| .*2 legacy source unknown/m);
});

test('session usage sums optional counters once and preserves model keys safely', async () => {
  const { sumSessionUsage } = await import('../../../skills/dispatch/scripts/providers/runner.ts');
  const models = Object.fromEntries([['__proto__', { input: 2, output: 1, cacheRead: 3 }]]);
  const first = { input: 2, output: 1, cacheRead: 3, cacheWrite: 4, reasoning: 5, scope: 'invocation' as const, provenance: 'fixture', inputSemantics: 'uncached' as const, models };
  const later = { ...first, input: 7, output: 2, cacheRead: 6, cacheWrite: 8, reasoning: 9, models: Object.fromEntries([['__proto__', { input: 7, output: 2, cacheRead: 6 }]]) };
  const sum = sumSessionUsage([first, later])!;
  assert.deepEqual([sum.input, sum.output, sum.cacheRead, sum.cacheWrite, sum.reasoning], [9, 3, 9, 12, 14]);
  assert.deepEqual(sum.models?.['__proto__'], { input: 9, output: 3, cacheRead: 9 });
  assert.equal(Object.hasOwn(sum.models!, '__proto__'), true);
  assert.equal(sumSessionUsage([first, { ...later, models: undefined } as unknown as typeof later])?.models, undefined);
});

test('failed cumulative normalization never records the raw total', async () => {
  const h = harness(posix);
  const spec = { ...claude, id: 'agy' as const, resumeUsage: 'cumulative' as const, usage: () => ({ input: 9, output: 3, scope: 'invocation' as const, provenance: 'fixture', inputSemantics: 'uncached' as const, models: new Proxy({}, { ownKeys() { throw new Error('bad models'); } }) }) };
  const pending = runDelegate(spec, { ...req, collectUsage: true, resume: 'session' }, 'cli', h.ports);
  await flush(); h.finish(ok());
  const result = await pending;
  assert.equal(result.outcome.status, 'ok'); assert.equal(result.invocations[0]?.usage, undefined);
});

test('cumulative resumes subtract prior usage and earlier deltas in the same session', async () => {
  const h = harness(posix);
  const base = { input: 10, output: 5, cacheRead: 20, cacheWrite: 30, reasoning: 4, scope: 'invocation' as const, provenance: 'fixture', inputSemantics: 'uncached' as const };
  const values = [{ ...base, input: 12, output: 7, cacheRead: 23, cacheWrite: 34, reasoning: 5 }, { ...base, input: 15, output: 9, cacheRead: 29, cacheWrite: 41, reasoning: 7 }];
  let index = 0;
  const spec = { ...makeNudgeSpec('session'), resumeUsage: 'cumulative' as const, usage: () => values[index++] };
  const pending = runDelegate(spec, { ...req, collectUsage: true, resume: 'session', priorUsage: base }, 'cli', h.ports);
  await flush(); h.finish(ok({ exit: 1, stdout: 'empty' }));
  await flush(); await flush(); h.finish(ok({ stdout: 'FINAL answer' }));
  const rows = (await pending).invocations;
  assert.deepEqual(rows.map(row => [row.usage?.input, row.usage?.output, row.usage?.cacheRead, row.usage?.cacheWrite, row.usage?.reasoning]), [[2, 2, 3, 4, 1], [3, 2, 6, 7, 2]]);
});

test('runner reports each attempt and each resume as it happens', async () => {
  const h=harness(posix), events: unknown[]=[];
  const run=runDelegate(makeNudgeSpec('sess1'),{...req,onInvocation: row=>events.push(row),onResume:(id,count)=>events.push([id,count])},'cli',h.ports);
  await flush();h.finish(ok({exit:null,signal:'SIGTERM',stdout:'partial',timedOut:true,idleMs:IDLE_TIMEOUT_MS}));
  await flush();await flush();
  assert.equal(events.length,2);assert.deepEqual(events[1],['sess1',1]);
  h.finish(ok({stdout:'FINAL'}));const done=await run;
  assert.equal(events[0],done.invocations[0]);assert.equal(events[2],done.invocations[1]);
  const failed=harness(posix);failed.ports.process.start=()=>{throw new Error('launch');};
  const rows: unknown[]=[];
  await assert.rejects(runDelegate(makeNudgeSpec('sess1'),{...req,onInvocation:row=>{rows.push(row);throw new Error('observer');}},'cli',failed.ports),/launch/);
  assert.equal(rows.length,1);assert.equal((rows[0] as {outcome:string}).outcome,'launch-failed');
});

test('cumulative session usage reaches the observer without diagnostics', async () => {
  const h=harness(posix),rows: any[]=[];
  const spec={...makeNudgeSpec('sess1'),resumeUsage:'cumulative' as const,usage:()=>({input:9,output:3,scope:'invocation' as const,provenance:'fixture',inputSemantics:'uncached' as const})};
  const run=runDelegate(spec,{...req,collectUsage:false,onInvocation:row=>rows.push(row)},'cli',h.ports);
  await flush();h.finish(ok({stdout:'partial'}));await flush();await flush();
  assert.equal(rows[0].usage.input,9);
  h.finish(ok({stdout:'FINAL'}));await run;
  assert.equal(rows[1].usage.input,0);
});

test('agy session usage unions models and effort over a table', async () => {
  const { sumSessionUsage } = await import('../../../skills/dispatch/scripts/providers/runner.ts');
  const row = (model: string, effort: string | null) => ({
    input: 100, output: 10, scope: 'invocation' as const, provenance: 'fixture', inputSemantics: 'uncached' as const,
    actualModels: [model], actualEffort: effort, models: { [model]: { input: 100, output: 10 } },
  });
  for (const [efforts, expected, models] of [
    [['medium', 'medium'], 'medium', ['model-a', 'model-b']],
    [['medium', 'high'], null, ['model-a', 'model-b']],
    [['medium', null], null, ['model-a', 'model-b']],
  ] as const) {
    const united = sumSessionUsage!([row('model-a', efforts[0]), row('model-b', efforts[1])]);
    assert.deepEqual(united?.actualModels, models);
    assert.equal(united?.actualEffort, expected);
    assert.deepEqual(united?.models?.['model-a'], { input: 100, output: 10 });
  }
  const noEffort = sumSessionUsage!([
    (({ actualEffort: _a, ...r }) => r)(row('model-a', 'medium') as Record<string, unknown>) as never,
    (({ actualEffort: _b, ...r }) => r)(row('model-b', 'high') as Record<string, unknown>) as never,
  ]);
  assert.equal(noEffort?.actualEffort, undefined);
});

async function runAgyResumed(usages: Record<string, unknown>[], opts: Record<string, unknown> = {}) {
  const h = harness(posix);
  let call = 0;
  const spec = {
    ...makeNudgeSpec('sess-agy'), id: agy.id, resumeUsage: agy.resumeUsage, invocationAttribution: agy.invocationAttribution,
    usage: () => usages[Math.min(call++, usages.length - 1)],
  };
  const pending = runDelegate(spec, { ...req, collectUsage: true, model: 'launch-model', effort: 'low', ...opts }, 'cli', h.ports);
  await flush(); h.finish(ok({ exit: 1, stdout: 'empty' }));
  await flush(); await flush(); h.finish(ok({ stdout: 'FINAL' }));
  return pending;
}

test('agy resumed delta attributes only the newly observed model and effort', async () => {
  const base = { scope: 'invocation' as const, provenance: 'fixture', inputSemantics: 'uncached' as const };
  const u1 = { ...base, input: 100, output: 10, actualModels: ['model-a'], actualEffort: 'medium', models: { 'model-a': { input: 100, output: 10 } } };
  const u2 = { ...base, input: 300, output: 30, actualModels: ['model-a', 'model-b'], actualEffort: 'high', models: { 'model-a': { input: 100, output: 10 }, 'model-b': { input: 200, output: 20 } } };
  const done = await runAgyResumed([u1, u2]);
  assert.equal(done.invocations[0]?.model, 'model-a');
  assert.equal(done.invocations[0]?.effort, 'medium');
  assert.equal(done.invocations[1]?.model, 'model-b');
  assert.equal(done.invocations[1]?.effort, 'high');
  assert.deepEqual(done.invocations[1]?.usage?.models?.['model-b'], { input: 200, output: 20 });
  const unchanged = await runAgyResumed([u1, u1]);
  assert.equal(unchanged.invocations[1]?.model, 'launch-model');
  assert.equal(unchanged.invocations[1]?.usage?.models, undefined);
  const h = harness(posix);
  const multi = { ...base, input: 100, output: 20, actualModels: ['first-model', 'second-model'], actualEffort: 'medium', models: { 'first-model': { input: 60, output: 10 }, 'second-model': { input: 40, output: 10 } } };
  const spec = { ...makeNudgeSpec('sess-multi'), id: agy.id, resumeUsage: agy.resumeUsage, invocationAttribution: agy.invocationAttribution, usage: () => multi };
  const pending = runDelegate(spec, { ...req, collectUsage: true, model: 'launch-model', effort: 'low' }, 'cli', h.ports);
  await flush(); h.finish(ok({ stdout: 'FINAL' }));
  assert.equal((await pending).invocations[0]?.model, 'first-model');
});

test('agy resumed effort distinguishes Tag 1.21 null from Tag 1.19 missing', async () => {
  const base = { scope: 'invocation' as const, provenance: 'fixture', inputSemantics: 'uncached' as const };
  const u1 = { ...base, input: 100, output: 10, actualModels: ['model-a'], actualEffort: 'medium', models: { 'model-a': { input: 100, output: 10 } } };
  const nullEffort = { ...base, input: 300, output: 30, actualModels: ['model-a', 'model-b'], actualEffort: null, models: { 'model-a': { input: 100, output: 10 }, 'model-b': { input: 200, output: 20 } } };
  const doneNull = await runAgyResumed([u1, nullEffort]);
  assert.equal(doneNull.invocations[1]?.effort, null);
  assert.equal(doneNull.invocations[1]?.usage?.actualEffort, null);
  const undefEffort = { ...base, input: 300, output: 30, actualModels: ['model-a', 'model-b'], actualEffort: undefined, models: { 'model-a': { input: 100, output: 10 }, 'model-b': { input: 200, output: 20 } } };
  const doneUndef = await runAgyResumed([u1, undefEffort]);
  assert.equal(doneUndef.invocations[1]?.effort, 'low');
  assert.equal(doneUndef.invocations[1]?.usage?.actualEffort, undefined);
});

test('agy resumed envelope keeps explicit attribution and drops it without a DB', async () => {
  const base = { scope: 'invocation' as const, inputSemantics: 'uncached' as const };
  const envelope = { ...base, input: 50, output: 10, provenance: 'agy.usage.envelope', actualModels: ['envelope-model'], actualEffort: 'high', models: { 'envelope-model': { input: 50, output: 10 } } };
  const prior = { input: 20, output: 5, scope: 'invocation' as const, provenance: 'agy.usage', inputSemantics: 'uncached' as const };
  const kept = await runAgyResumed([envelope], { resume: 'sess-env', priorUsage: prior });
  assert.equal(kept.invocations[0]?.model, 'envelope-model');
  assert.equal(kept.invocations[0]?.effort, 'high');
  assert.deepEqual(kept.invocations[0]?.usage?.actualModels, ['envelope-model']);
  const nonEnvelope = { ...base, input: 50, output: 10, provenance: 'agy.usage' };
  const dropped = await runAgyResumed([nonEnvelope], { resume: 'sess-non-env', priorUsage: prior, model: 'launch-model-trial' });
  assert.equal(dropped.invocations[0]?.model, 'launch-model');
  assert.equal(dropped.invocations[0]?.effort, 'low');
  assert.equal(dropped.invocations[0]?.usage?.actualModels, undefined);
  const multiEnvelope = { ...base, input: 150, output: 30, provenance: 'agy.usage.envelope', actualModels: ['model-x', 'model-y'], actualEffort: 'medium', models: { 'model-x': { input: 100, output: 20 }, 'model-y': { input: 50, output: 10 } } };
  const multi = await runAgyResumed([multiEnvelope], { resume: 'sess-env-multi', priorUsage: prior });
  assert.equal(multi.invocations[0]?.usage?.models, undefined);
  assert.deepEqual(multi.invocations[0]?.usage?.actualModels, ['model-x', 'model-y']);
});

test('session window: complete session read records session provenance, bands, and skips cumulative delta', async () => {
  const h = harness(posix);
  const sessionPath = '/h/.claude/projects/-repo/sess-win-1.jsonl';
  const files: Record<string, string> = {};
  h.ports.usageFs = memUsageFs(files);
  h.ports.clock.elapsed = () => { h.clock.advance(1); return 1; };
  const claudeStdout = (input: number, output: number, result = '') => JSON.stringify({
    type: 'result', result, session_id: 'sess-win-1',
    modelUsage: { 'claude-haiku-5-5': { inputTokens: input, outputTokens: output } },
  });
  const pending = runDelegate(claude, { ...req, collectUsage: true, model: 'haiku' }, 'cli', h.ports);
  await flush();
  h.clock.advance(10);
  files[sessionPath] = [claudeEntry(5, 90_000, 10), claudeEntry(8, 110_000, 20)].join('\n');
  h.finish(ok({ exit: 1, stdout: claudeStdout(200_000, 30) }));
  await flush(); await flush();
  h.clock.advance(10);
  files[sessionPath] += '\n' + claudeEntry(15, 500, 5);
  h.finish(ok({ stdout: claudeStdout(200_500, 35, 'FINAL') }));
  const done = await pending;
  assert.equal(done.invocations.length, 2);
  assert.equal(done.invocations[0]?.usage?.provenance, 'session');
  assert.equal(done.invocations[0]?.usage?.input, 200_000);
  assert.equal(done.invocations[0]?.usage?.models?.['claude-haiku-5-5#low']?.bands?.le100k?.input, 90_000);
  assert.equal(done.invocations[0]?.usage?.models?.['claude-haiku-5-5#low']?.bands?.le200k?.input, 110_000);
  assert.equal(done.invocations[0]?.usageBaseline, 'none');
  assert.equal(done.invocations[0]?.usageWindowEndMs, 10);
  assert.equal(done.invocations[0]?.coverage, undefined);

  assert.equal(done.invocations[1]?.usage?.provenance, 'session');
  assert.equal(done.invocations[1]?.usage?.input, 500);
  assert.equal(done.invocations[1]?.usageBaseline, 'none');
  assert.equal(done.invocations[1]?.usageWindowEndMs, 21);
});

test('session window: incomplete read falls back to stdout with transcript unavailable', async () => {
  {
    const h = harness(posix);
    (h.ports as RunnerPorts & { usageFs?: HostUsageFs }).usageFs = memUsageFs({});
    const stdout = [
      JSON.stringify({ type: 'text', sessionID: 'ses_oc_1', part: { text: 'FINAL' } }),
      JSON.stringify({ type: 'step_finish', sessionID: 'ses_oc_1', part: { tokens: { input: 12, output: 4 } } }),
    ].join('\n');
    const pending = runDelegate(opencode, { ...req, collectUsage: true }, 'cli', h.ports);
    await flush(); h.finish(ok({ stdout }));
    const done = await pending;
    assert.equal(done.invocations[0]?.usage?.provenance, 'stdout');
    assert.equal(done.invocations[0]?.usage?.input, 12);
    assert.deepEqual(done.invocations[0]?.coverage, ['transcript unavailable']);
    assert.equal((done.invocations[0] as { usageBaseline?: string }).usageBaseline, 'none');
  }
  {
    const h = harness(posix);
    let fsReadCalled = false;
    (h.ports as RunnerPorts & { usageFs?: HostUsageFs }).usageFs = memUsageFs({}, {
      stat: () => { fsReadCalled = true; return null; },
    });
    const stdout = JSON.stringify({ result: 'FINAL', session_id: 'sess-no-diag', modelUsage: { m: { inputTokens: 10, outputTokens: 2 } } });
    const pending = runDelegate(claude, { ...req, collectUsage: false, onInvocation: () => {} }, 'cli', h.ports);
    await flush(); h.finish(ok({ stdout }));
    const done = await pending;
    assert.equal(fsReadCalled, false);
    assert.equal(done.invocations[0]?.coverage, undefined);
    assert.equal(done.invocations[0]?.responses, undefined);
  }
});

test('usage baseline: Claude three-launch chain (session, result.usage, modelUsage) leaves third launch unmeasured', async () => {
  const h = harness(posix);
  const sessionPath = '/h/.claude/projects/-repo/sess-chain.jsonl';
  const files: Record<string, string> = {};
  h.ports.usageFs = memUsageFs(files);
  const pending = runDelegate(claude, { ...req, collectUsage: true }, 'cli', h.ports);
  await flush();
  h.clock.advance(10);
  files[sessionPath] = claudeEntry(5, 100, 10);
  h.finish(ok({ exit: 1, stdout: JSON.stringify({ type: 'result', result: '', session_id: 'sess-chain', modelUsage: { m: { inputTokens: 100, outputTokens: 10 } } }) }));
  await flush(); await flush();
  h.clock.advance(10);
  files[sessionPath] = ''; // missing/empty transcript -> incomplete read
  h.finish(ok({ exit: 1, stdout: JSON.stringify({ type: 'result', result: '', session_id: 'sess-chain', usage: { input_tokens: 20, output_tokens: 3 } }) }));
  await flush(); await flush();
  h.clock.advance(10);
  h.finish(ok({ stdout: JSON.stringify({ type: 'result', result: 'FINAL', session_id: 'sess-chain', modelUsage: { m: { inputTokens: 999, outputTokens: 99 } } }) }));
  const done = await pending;
  assert.equal(done.invocations[0]?.usage?.provenance, 'session');
  assert.equal(done.invocations[0]?.usageBaseline, 'none');
  assert.equal(done.invocations[1]?.usage?.provenance, 'stdout');
  assert.equal(done.invocations[1]?.usage?.input, 20);
  assert.deepEqual(done.invocations[1]?.coverage, ['transcript unavailable']);
  assert.equal(done.invocations[1]?.usageBaseline, 'none');
  assert.equal(done.invocations[2]?.usage, undefined);
  assert.deepEqual(done.invocations[2]?.coverage, ['transcript unavailable']);
  assert.equal(done.invocations[2]?.usageBaseline, 'none');
});

test('usage baseline: unmeasured middle or first launch leaves later cumulative launch unmeasured', async () => {
  {
    const h = harness(posix);
    h.ports.usageFs = memUsageFs({});
    const pending = runDelegate(claude, { ...req, collectUsage: true }, 'cli', h.ports);
    await flush(); h.clock.advance(10);
    h.finish(ok({ exit: 1, stdout: JSON.stringify({ type: 'result', result: '', session_id: 'sess-mid', modelUsage: { m: { inputTokens: 50, outputTokens: 5 } } }) }));
    await flush(); await flush(); h.clock.advance(10);
    h.finish(ok({ exit: 1, stdout: JSON.stringify({ type: 'result', result: '', session_id: 'sess-mid' }) })); // unmeasured middle
    await flush(); await flush(); h.clock.advance(10);
    h.finish(ok({ stdout: JSON.stringify({ type: 'result', result: 'FINAL', session_id: 'sess-mid', modelUsage: { m: { inputTokens: 120, outputTokens: 12 } } }) }));
    const done = await pending;
    assert.equal(done.invocations[0]?.usage?.provenance, 'stdout');
    assert.equal(done.invocations[0]?.usageBaseline, 'cumulative');
    assert.equal(done.invocations[1]?.usage, undefined);
    assert.equal(done.invocations[1]?.usageBaseline, 'none');
    assert.equal(done.invocations[2]?.usage, undefined);
    assert.equal(done.invocations[2]?.usageBaseline, 'none');
  }
  {
    const h = harness(posix);
    h.ports.usageFs = memUsageFs({});
    const pending = runDelegate(claude, { ...req, collectUsage: true }, 'cli', h.ports);
    await flush(); h.clock.advance(10);
    h.finish(ok({ exit: 1, stdout: JSON.stringify({ type: 'result', result: '', session_id: 'sess-first' }) })); // unmeasured first
    await flush(); await flush(); h.clock.advance(10);
    h.finish(ok({ stdout: JSON.stringify({ type: 'result', result: 'FINAL', session_id: 'sess-first', modelUsage: { m: { inputTokens: 80, outputTokens: 8 } } }) }));
    const done = await pending;
    assert.equal(done.invocations[0]?.usage, undefined);
    assert.equal(done.invocations[0]?.usageBaseline, 'none');
    assert.equal(done.invocations[1]?.usage, undefined);
    assert.equal(done.invocations[1]?.usageBaseline, 'none');
  }
});

test('usage baseline: Claude result.usage fallback chain on resume stays per-launch', async () => {
  const h = harness(posix);
  h.ports.usageFs = memUsageFs({});
  const pending = runDelegate(claude, { ...req, collectUsage: true }, 'cli', h.ports);
  await flush(); h.clock.advance(10);
  h.finish(ok({ exit: 1, stdout: JSON.stringify({ type: 'result', result: '', session_id: 'sess-res', usage: { input_tokens: 15, output_tokens: 3 } }) }));
  await flush(); await flush(); h.clock.advance(10);
  h.finish(ok({ stdout: JSON.stringify({ type: 'result', result: 'FINAL', session_id: 'sess-res', usage: { input_tokens: 25, output_tokens: 4 } }) }));
  const done = await pending;
  assert.equal(done.invocations[0]?.usage?.provenance, 'stdout');
  assert.equal(done.invocations[0]?.usage?.input, 15);
  assert.equal(done.invocations[1]?.usage?.provenance, 'stdout');
  assert.equal(done.invocations[1]?.usage?.input, 25);
});

test('Delegate response counts exclude resumed overlap at the launch boundary', async () => {
  const h = harness(posix);
  const sessionPath = '/h/.claude/projects/-repo/sess-wait.jsonl';
  const files: Record<string, string> = {};
  h.ports.usageFs = memUsageFs(files);
  let clockTime = 1000;
  let waitChecks = 0;
  h.ports.clock.now = () => clockTime;
  let elapsed = 0;
  h.ports.clock.elapsed = () => {
    waitChecks++;
    if (waitChecks >= 3) clockTime = 1001;
    return (elapsed += 0.5);
  };
  const pending = runDelegate(claude, { ...req, collectUsage: true }, 'cli', h.ports);
  await flush();
  files[sessionPath] = claudeEntry(1000, 100, 10);
  h.finish(ok({ exit: 1, stdout: JSON.stringify({ type: 'result', result: '', session_id: 'sess-wait', modelUsage: { m: { inputTokens: 100, outputTokens: 10 } } }) }));
  await flush(); await flush();
  // The last streaming update for the first message arrives during the resume.
  const replay = claudeEntry(1001, 100, 10).replace('m_1001', 'm_1000');
  files[sessionPath] += '\n' + [replay, claudeEntry(1002, 200, 20)].join('\n');
  clockTime = 1005;
  h.finish(ok({ stdout: JSON.stringify({ type: 'result', result: 'FINAL', session_id: 'sess-wait', modelUsage: { m: { inputTokens: 300, outputTokens: 30 } } }) }));
  const done = await pending;
  assert.equal(done.invocations[0]?.usage?.input, 100);
  assert.deepEqual(done.invocations.map(i => i.responses?.map(r => [r.observed, r.uncachedInput])), [[[1, 100]], [[1, 200]]]);
  assert.equal(done.invocations[1]?.usage?.input, 300);
  assert.equal(done.invocations[1]?.usage?.provenance, 'session');

  // Saved usageWindowEndMs across a new runner call
  const h2 = harness(posix);
  h2.ports.usageFs = memUsageFs({
    '/h/.claude/projects/-repo/sess-wait2.jsonl': [claudeEntry(2000, 100, 10), claudeEntry(2001, 300, 30)].join('\n'),
  });
  let c2 = 2000;
  h2.ports.clock.now = () => c2;
  let e2 = 0;
  h2.ports.clock.elapsed = () => {
    e2 += 0.5;
    if (e2 >= 1 && c2 < 2001) c2 = 2001;
    return e2;
  };
  const p2 = runDelegate(claude, { ...req, collectUsage: true, resume: 'sess-wait2', usageWindowEndMs: 2000, usageBaseline: 'none' }, 'cli', h2.ports);
  c2 = 2005;
  await flush(); h2.finish(ok({ stdout: JSON.stringify({ type: 'result', result: 'FINAL', session_id: 'sess-wait2' }) }));
  const d2 = await p2;
  assert.equal(d2.invocations[0]?.usage?.input, 300);
  assert.equal(d2.invocations[0]?.usage?.provenance, 'session');
});

test('session window: clock behind past 5 ms launches before deadline with incomplete read', async () => {
  const h = harness(posix);
  const sessionPath = '/h/.claude/projects/-repo/sess-behind.jsonl';
  h.ports.usageFs = memUsageFs({
    [sessionPath]: claudeEntry(1001, 50, 5),
  });
  h.ports.clock.now = () => 1000;
  let elapsed = 0;
  h.ports.clock.elapsed = () => (elapsed += 2);
  const pending = runDelegate(claude, { ...req, collectUsage: true, resume: 'sess-behind', usageWindowEndMs: 1000, usageBaseline: 'cumulative' }, 'cli', h.ports);
  await flush();
  h.finish(ok({ stdout: JSON.stringify({ type: 'result', result: 'FINAL', session_id: 'sess-behind', modelUsage: { m: { inputTokens: 70, outputTokens: 7 } } }) }));
  const done = await pending;
  assert.equal(done.outcome.status, 'ok');
  assert.equal(done.invocations[0]?.usage?.provenance, 'stdout');
  assert.deepEqual(done.invocations[0]?.coverage, ['transcript unavailable']);
});

test('session window: second-resolution row counts on fresh launch and makes resumed read incomplete', async () => {
  const h = harness(posix);
  const sessionPath = '/h/.claude/projects/-repo/sess-sec.jsonl';
  const files: Record<string, string> = {};
  h.ports.usageFs = memUsageFs(files);
  const wholeSecSpec = {
    ...claude,
    sessionUsage: (raw: string, ctx: ProviderUsageContext) => {
      const base = claude.sessionUsage!(raw, ctx);
      if (ctx.resumed && base?.complete) return { complete: false };
      return base;
    },
  };
  const pending = runDelegate(wholeSecSpec, { ...req, collectUsage: true }, 'cli', h.ports);
  await flush(); h.clock.advance(10);
  files[sessionPath] = claudeEntry(5, 40, 4);
  h.finish(ok({ exit: 1, stdout: JSON.stringify({ type: 'result', result: '', session_id: 'sess-sec', modelUsage: { m: { inputTokens: 40, outputTokens: 4 } } }) }));
  await flush(); await flush(); h.clock.advance(10);
  files[sessionPath] += '\n' + claudeEntry(15, 60, 6);
  h.finish(ok({ stdout: JSON.stringify({ type: 'result', result: 'FINAL', session_id: 'sess-sec', modelUsage: { m: { inputTokens: 100, outputTokens: 10 } } }) }));
  const done = await pending;
  assert.equal(done.invocations[0]?.usage?.provenance, 'session');
  assert.equal(done.invocations[1]?.usage, undefined);
  assert.deepEqual(done.invocations[1]?.coverage, ['transcript unavailable']);
});

test('session window: agy stdout usage shares per-launch ReadBudget with sessionUsage and skips SQLite when spent', async () => {
  const h = harness(posix);
  let usageBudget: { remaining: number } | undefined;
  let sessionBudget: { remaining: number } | undefined;
  let initialRemaining = 0;
  let sqliteCalls = 0;
  const spec = {
    ...agy,
    usage(raw: string, context?: ProviderUsageContext) {
      usageBudget = context?.transcripts?.budget;
      initialRemaining = usageBudget?.remaining ?? 0;
      return agy.usage!(raw, {
        ...context!,
        readSqliteGenMetadata: () => { sqliteCalls++; return [new Uint8Array(64)]; },
      });
    },
    sessionUsage(raw: string, context: ProviderUsageContext) {
      sessionBudget = context.transcripts?.budget;
      return agy.sessionUsage!(raw, context);
    },
  };
  const stdout = JSON.stringify({
    conversation_id: 'conv-budget-1',
    response: 'FINAL',
    usage: { input_tokens: 10, output_tokens: 2 },
  });
  const pending = runDelegate(spec, { ...req, collectUsage: true }, 'cli', h.ports);
  await flush(); h.finish(ok({ stdout }));
  const done = await pending;
  assert.equal(done.outcome.status, 'ok');
  assert.ok(usageBudget !== undefined);
  assert.equal(usageBudget, sessionBudget);
  assert.equal(sqliteCalls, 1);
  assert.equal(usageBudget.remaining, initialRemaining - 64);

  // When budget is exhausted before agy.usage runs, SQLite is skipped.
  let sqliteCallsSpent = 0;
  const spentSpec = {
    ...agy,
    usage(raw: string, context?: ProviderUsageContext) {
      if (context?.transcripts?.budget) context.transcripts.budget.remaining = 0;
      return agy.usage!(raw, {
        ...context!,
        readSqliteGenMetadata: () => { sqliteCallsSpent++; return [new Uint8Array(64)]; },
      });
    },
  };
  const h2 = harness(posix);
  const p2 = runDelegate(spentSpec, { ...req, collectUsage: true }, 'cli', h2.ports);
  await flush(); h2.finish(ok({ stdout }));
  await p2;
  assert.equal(sqliteCallsSpent, 0);
});

test('Valid fallback survives an invalid transcript', async () => {
  const h = harness(posix);
  const spec = {
    ...claude,
    sessionUsage: () => ({
      complete: true,
      usage: { input: 1.5, output: 3, scope: 'invocation', provenance: 'session', inputSemantics: 'uncached' } as const,
    }),
  };
  const pending = runDelegate(spec, { ...req, collectUsage: true }, 'cli', h.ports);
  await flush();
  h.finish(ok({ stdout: JSON.stringify({ type: 'result', result: 'FINAL', usage: { input_tokens: 40, output_tokens: 4 } }) }));
  const done = await pending;
  assert.equal(done.invocations[0]?.usage?.provenance, 'stdout');
  assert.equal(done.invocations[0]?.usage?.input, 40);
  assert.deepEqual(done.invocations[0]?.coverage, ['transcript unavailable', 'invalid counters']);
  assert.deepEqual(done.invocations[0]?.responses, [{ role: 'delegate', basis: 'unavailable', coverage: 'unknown' }]);
});

for (const fixture of [
  { name: 'failed zero without a response stays unavailable', exit: 1, input: 0, answer: 'rate limit exceeded', measured: undefined },
  { name: 'failed nonzero stays measured', exit: 1, input: 7, answer: 'rate limit exceeded', measured: 7 },
  { name: 'a successful per-launch zero stays measured', exit: 0, input: 0, answer: 'FINAL', measured: 0 },
]) {
  test(fixture.name, async () => {
    const h = harness(posix);
    h.ports.usageFs = memUsageFs();
    const pending = runDelegate(claude, { ...req, collectUsage: true }, 'cli', h.ports);
    await flush();
    h.finish(ok({ exit: fixture.exit, stdout: JSON.stringify({
      type: 'result', result: fixture.answer, usage: { input_tokens: fixture.input, output_tokens: 0 },
    }) }));
    const done = await pending;
    assert.equal(done.invocations[0]?.outcome, fixture.exit === 1 ? 'quota' : 'ok');
    assert.equal(done.invocations[0]?.usage?.input, fixture.measured);
    assert.deepEqual(done.invocations[0]?.coverage, fixture.measured === undefined ? ['transcript unavailable', 'unverified zero'] : ['transcript unavailable']);
  });
}

test('a valid launch-window response measures zero even on failure', async () => {
  const h = harness(posix);
  h.ports.usageFs = memUsageFs({ '/h/.claude/projects/-repo/sess-zero.jsonl': claudeEntry(5, 0, 0) });
  const pending = runDelegate(claude, { ...req, collectUsage: true }, 'cli', h.ports);
  await flush();
  h.clock.advance(10);
  h.finish(ok({ exit: 1, stdout: JSON.stringify({
    type: 'result', session_id: 'sess-zero', result: 'rate limit exceeded',
  }) }));
  const done = await pending;
  assert.equal(done.invocations[0]?.outcome, 'quota');
  assert.equal(done.invocations[0]?.usage?.provenance, 'session');
  assert.equal(done.invocations[0]?.usage?.input, 0);
  assert.equal(done.invocations[0]?.usage?.output, 0);
  assert.equal(done.invocations[0]?.coverage, undefined);
});

test('an unchanged cumulative report retains its resume baseline without proving zero usage', async () => {
  const h = harness(posix);
  const usage = { input: 9, output: 3, scope: 'invocation', provenance: 'fixture', inputSemantics: 'uncached' } as const;
  const spec = { ...makeNudgeSpec('sess1'), resumeUsage: 'cumulative' as const, usage: () => usage };
  const pending = runDelegate(spec, { ...req, collectUsage: true, resume: 'sess1', priorUsage: usage }, 'cli', h.ports);
  await flush();
  h.finish(ok({ stdout: 'FINAL' }));
  const done = await pending;
  assert.equal(done.invocations[0]?.usage, undefined);
  assert.equal(done.invocations[0]?.usageBaseline, 'cumulative');
  assert.deepEqual(done.invocations[0]?.coverage, ['transcript unavailable', 'unverified zero']);
});
