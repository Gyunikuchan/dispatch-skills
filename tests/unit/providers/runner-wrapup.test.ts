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
  batchInvocation, buildAttachmentBlock, findSensitiveMatch, formatSafetyPrompt, GUARDRAIL_HEADER, killArgv, mustSpill, runDelegate, sanitizeEnv, type RunnerFs, type RunnerPorts,
} from '../../../skills/dispatch/scripts/providers/runner.ts';
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

test('fresh and resumed launches state the same run deadline', async () => {
  const h = harness(posix);
  const run = runDelegate(claude, { ...req, timeoutMs: 1_800_000 }, 'cli', h.ports);
  await flush();
  const prompt = String(h.launches[0]?.argv[2] ?? '');
  const deadlineIso = new Date(1_800_000).toISOString();
  const wrapUpIso = new Date(1_500_000).toISOString();
  assert.ok(prompt.includes(`[DEADLINE]: ${deadlineIso} (30m remaining; wrap-up at ${wrapUpIso})`), `unexpected deadline notice in: ${prompt}`);
  h.finish(ok({ stdout: JSON.stringify({ type: 'result', result: 'R', session_id: 'sess-1' }) }));
  await run;
  { // resumed launch prompt states the same run deadline
    const resumed = harness(posix);
    const resumedRun = runDelegate(makeNudgeSpec('sess1'), { ...req, timeoutMs: 1_800_000 }, 'cli', resumed.ports);
    await flush();
    resumed.finish(ok({ exit: 1, stdout: 'empty' }));
    await flush(); await flush();
    const iso = new Date(1_800_000).toISOString();
    assert.ok(String(resumed.launches[0]?.argv[2] ?? '').includes('[DEADLINE]:'));
    assert.ok(String(resumed.launches[0]?.argv[2] ?? '').includes(iso));
    assert.ok(String(resumed.launches[1]?.argv[2] ?? '').includes('[DEADLINE]:'));
    assert.ok(String(resumed.launches[1]?.argv[2] ?? '').includes(iso));
    resumed.finish(ok({ stdout: 'FINAL' }));
    await resumedRun;
  }
});

test('wrap-up stop: Claude preset launch stops at deadline minus five and resumes with wrap-up', async () => {
  const h = harness(posix);
  const run = runDelegate(claude, { ...req, timeoutMs: 1_800_000 }, 'cli', h.ports);
  await flush();
  assert.ok((h.launches[0]?.argv ?? []).includes('--session-id'));
  h.clock.advance(1_500_000);
  await flush();
  assert.deepEqual(h.signals, ['-50:SIGTERM']);
  h.finish(ok({ exit: null, signal: 'SIGTERM', stdout: 'partial' }));
  await flush(); await flush();
  assert.equal(h.launches.length, 2);
  const resumeArgv = h.launches[1]?.argv ?? [];
  assert.ok(resumeArgv.includes('--resume'));
  assert.ok(!resumeArgv.includes('--session-id'));
  const wrapPrompt = (h.launches[1]?.argv ?? []).join('\n');
  const deadlineIso = new Date(1_800_000).toISOString();
  assert.ok(wrapPrompt.includes('Make no further tool calls'), 'wrap-up prompt must forbid further tool calls');
  assert.ok(wrapPrompt.includes(`[DEADLINE]: ${deadlineIso} (5m remaining)`), 'wrap-up launch must show 5m remaining');
  assert.ok(!wrapPrompt.includes('wrap-up at'), 'wrap-up launch must omit wrap-up timestamp');
  h.finish(ok({ stdout: JSON.stringify({ type: 'result', result: 'FINAL', session_id: 'sess-1' }) }));
  const done = await run;
  assert.equal(done.outcome.status, 'ok');
  assert.equal(done.outcome.status === 'ok' && done.outcome.text, 'FINAL');
});

test('deadline notice: continue-resume omits wrap-up time once wrap-up instant has passed', async () => {
  const h = harness(posix);
  const spec = { ...makeNudgeSpec('sess-late'), attemptSession: (out: any) => String(typeof out === 'string' ? out : out?.stdout ?? '').includes('partial') ? 'sess-late' : null };
  const run = runDelegate(spec, { ...req, timeoutMs: 2_100_000 }, 'cli', h.ports);
  await flush();
  for (let t = 0; t < 1_920_000; t += 60_000) { h.clock.advance(60_000); h.activity(); await flush(); }
  h.finish(ok({ exit: 1, stdout: 'partial' }));
  await flush(); await flush();
  assert.equal(h.launches.length, 2);
  const resumePrompt = String(h.launches[1]?.argv[2] ?? '');
  assert.ok(resumePrompt.includes(CONTINUE_PROMPT), 'second launch must use CONTINUE_PROMPT');
  assert.ok(!resumePrompt.includes('Make no further tool calls'), 'second launch must not use WRAP_UP_PROMPT');
  assert.ok(resumePrompt.includes('(3m remaining)'), 'continue-resume must show 3m remaining');
  assert.ok(!resumePrompt.includes('wrap-up at'), 'continue-resume must omit past wrap-up timestamp');
  h.finish(ok({ stdout: 'FINAL' }));
  const done = await run;
  assert.equal(done.outcome.status, 'ok');
});

test('wrap-up stop: Codex thread event stops and resumes with wrap-up inside five minutes', async () => {
  const h = harness(posix);
  const run = runDelegate(codex, { ...req, timeoutMs: 1_800_000 }, 'cli', h.ports);
  await flush();
  h.fs.writeText('/r/log', '{"type":"thread.started","thread_id":"thread-abc123"}\npartial');
  for (let t = 0; t < 1_500_000; t += 60_000) { h.clock.advance(60_000); h.activity(); await flush(); }
  assert.ok(h.signals.length > 0, 'expected wrap-up stop signal');
  h.finish(ok({ exit: null, signal: 'SIGTERM', stdout: '{"type":"thread.started","thread_id":"thread-abc123"}\npartial' }));
  await flush(); await flush();
  assert.equal(h.launches.length, 2);
  assert.ok((h.launches[1]?.argv ?? []).join('\n').includes('Wrap up'));
  h.finish(ok({ exit: 0, stdout: '{"type":"thread.started","thread_id":"thread-abc123"}\n{"type":"item.completed","item":{"type":"agent_message","text":"FINAL"}}' }));
  const done = await run;
  assert.equal(done.outcome.status, 'ok');
});

test('wrap-up stop: unstoppable runs never stop early', async () => {
  { // launch without a nameable session runs to the deadline kill
    const h = harness(posix);
    const run = runDelegate(codex, { ...req, timeoutMs: 1_800_000 }, 'cli', h.ports);
    await flush();
    h.fs.writeText('/r/log', '');
    for (let t = 0; t < 1_500_000; t += 60_000) { h.clock.advance(60_000); h.activity(); await flush(); }
    assert.deepEqual(h.signals, []);
    assert.ok((h.launches[0]?.argv ?? []).join('\n').includes('[DEADLINE]:'));
    h.clock.advance(300_000);
    await flush();
    assert.ok(h.signals.length > 0);
    h.finish(ok({ exit: null, signal: 'SIGTERM', stdout: 'partial', timedOut: true }));
    const done = await run;
    assert.equal(h.launches.length, 1);
    assert.equal(done.outcome.status === 'fail' && done.outcome.cls, 'timeout');
  }
  { // run under ten minutes never stops early
    const h = harness(posix);
    const run = runDelegate(codex, { ...req, timeoutMs: 9 * 60_000 }, 'cli', h.ports);
    await flush();
    h.fs.writeText('/r/log', '{"type":"thread.started","thread_id":"thread-abc123"}');
    for (let t = 0; t < 4 * 60_000; t += 60_000) { h.clock.advance(60_000); h.activity(); await flush(); }
    assert.deepEqual(h.signals, []);
    const shortPrompt = (h.launches[0]?.argv ?? []).join('\n');
    assert.ok(shortPrompt.includes(`[DEADLINE]: ${new Date(9 * 60_000).toISOString()} (9m remaining)`));
    assert.ok(!shortPrompt.includes('wrap-up at'), 'short run under floor must omit wrap-up timestamp');
    h.clock.advance(5 * 60_000);
    await flush();
    h.finish(ok({ exit: null, signal: 'SIGTERM', stdout: 'partial', timedOut: true }));
    const done = await run;
    assert.equal(h.launches.length, 1);
    assert.equal(done.outcome.status === 'fail' && done.outcome.cls, 'timeout');
  }
  { // Antigravity fresh launch never stops early
    const h = harness(posix);
    const run = runDelegate(agy, { ...req, timeoutMs: 1_800_000 }, 'cli', h.ports);
    await flush();
    h.fs.writeText('/r/log', '');
    h.clock.advance(1_500_000);
    await flush();
    assert.deepEqual(h.signals, []);
    assert.ok(String(h.launches[0]?.argv[2] ?? h.launches[0]?.argv.join(' ') ?? '').includes('[DEADLINE]:'));
    h.clock.advance(300_000);
    await flush();
    h.finish(ok({ exit: null, signal: 'SIGTERM', stdout: 'partial', timedOut: true }));
    const done = await run;
    assert.equal(h.launches.length, 1);
    assert.equal(done.outcome.status === 'fail' && done.outcome.cls, 'timeout');
  }
  { // stall-resumed Antigravity is never stopped for wrap-up
    const h = harness(posix);
    let calls = 0;
    const spec: any = {
      ...agy,
      attemptSession: () => (calls++ === 0 ? 'conv-stall-1' : null),
      parse: (out: ProcessResult) => out.stdout.includes('FINAL')
        ? { status: 'ok' as const, text: 'FINAL', sessionId: 'c', resume: null }
        : { status: 'fail' as const, cls: 'empty-output' as const, detail: 'empty' },
      argv: (r: any) => ({ argv: ['bin', r.resume ? `resume:${r.resume}` : 'fresh', r.prompt], stdin: null, env: {}, cwd: r.cwd }),
    };
    const run = runDelegate(spec, { ...req, timeoutMs: 1_800_000 }, 'cli', h.ports);
    await flush();
    h.finish(ok({ exit: 1, stdout: 'empty one' }));
    await flush(); await flush();
    assert.equal(h.launches.length, 2);
    h.fs.writeText('/r/log', '');
    h.clock.advance(1_500_000 - h.clock.now());
    await flush();
    assert.deepEqual(h.signals, []);
    h.clock.advance(300_000);
    await flush();
    h.finish(ok({ exit: null, signal: 'SIGTERM', stdout: 'partial', timedOut: true }));
    const finished = await run;
    assert.equal(h.launches.length, 2);
    assert.equal(finished.outcome.status === 'fail' && finished.outcome.cls, 'timeout');
  }
});

test('wrap-up stop: stall-resumed launch reuses resume id when partial log names no session', async () => {
  for (const base of [claude, codex, opencode] as const) {
    const h = harness(posix);
    let calls = 0;
    const spec: any = {
      ...base,
      attemptSession: () => (calls++ === 0 ? 'sess-stall-1' : null),
      parse: (out: ProcessResult) => out.stdout.includes('FINAL')
        ? { status: 'ok' as const, text: 'FINAL', sessionId: 's', resume: null }
        : { status: 'fail' as const, cls: 'empty-output' as const, detail: 'empty' },
      argv: (r: any) => ({ argv: ['bin', r.resume ? `resume:${r.resume}` : 'fresh', r.prompt], stdin: null, env: {}, cwd: r.cwd }),
    };
    const run = runDelegate(spec, { ...req, timeoutMs: 1_800_000 }, 'cli', h.ports);
    await flush();
    h.finish(ok({ exit: 1, stdout: 'empty one' }));
    await flush(); await flush();
    assert.match(String(h.launches[1]?.argv[1] ?? ''), /resume:sess-stall-1/);
    h.fs.writeText('/r/log', '');
    for (let t = h.clock.now(); t < 1_500_000; t += 60_000) { h.clock.advance(60_000); h.activity(); await flush(); }
    assert.deepEqual(h.signals, ['-50:SIGTERM']);
    h.finish(ok({ exit: null, signal: 'SIGTERM', stdout: '' }));
    await flush(); await flush();
    assert.equal(h.launches.length, 3);
    assert.match(String(h.launches[2]?.argv[1] ?? ''), /resume:sess-stall-1/);
    assert.ok(String(h.launches[2]?.argv[2] ?? '').includes('Wrap up'));
    h.finish(ok({ stdout: 'FINAL' }));
    assert.equal((await run).outcome.status, 'ok');
  }
});

test('wrap-up budget: wrap-up happens at most once per run', async () => {
  const h = harness(posix);
  const spec = makeNudgeSpec('sess1');
  (spec as any).attemptSession = () => 'sess1';
  const run = runDelegate(spec, { ...req, timeoutMs: 1_800_000 }, 'cli', h.ports);
  await flush();
  for (let t = 0; t < 1_500_000; t += 60_000) { h.clock.advance(60_000); h.activity(); await flush(); }
  h.finish(ok({ exit: null, signal: 'SIGTERM', stdout: 'partial' }));
  await flush(); await flush();
  assert.equal(h.launches.length, 2);
  assert.ok(String(h.launches[1]?.argv[2] ?? '').includes('Wrap up'));
  h.clock.advance(300_000);
  await flush();
  h.finish(ok({ exit: null, signal: 'SIGTERM', stdout: 'partial', timedOut: true }));
  const done = await run;
  assert.equal(h.launches.length, 2);
  assert.equal(done.outcome.status === 'fail' && done.outcome.cls, 'timeout');
});

test('wrap-up budget: wrap-up after three stall resumes records nudge and wrapUp without consuming stall budget', async () => {
  const h = harness(posix);
  let resumes: string[] = [];
  const spec = makeNudgeSpec('sess1');
  const run = runDelegate(spec, { ...req, timeoutMs: 1_800_000, onResume: (id: string) => { resumes.push(id); } }, 'cli', h.ports);
  await flush();
  for (let i = 0; i < 3; i++) {
    h.finish(ok({ exit: 1, stdout: `empty ${i}` }));
    await flush(); await flush();
  }
  assert.equal(h.launches.length, 4);
  assert.deepEqual(resumes, ['sess1', 'sess1', 'sess1']);
  h.fs.writeText('/r/log', 'partial');
  for (let t = h.clock.now(); t < 1_500_000; t += 60_000) { h.clock.advance(60_000); h.activity(); await flush(); }
  h.finish(ok({ exit: null, signal: 'SIGTERM', stdout: 'partial' }));
  await flush(); await flush();
  assert.equal(h.launches.length, 5);
  assert.deepEqual(resumes, ['sess1', 'sess1', 'sess1']);
  h.finish(ok({ stdout: 'FINAL' }));
  const done = await run;
  assert.equal(done.outcome.status, 'ok');
  assert.equal((done.invocations[4] as any)?.nudge, true);
  assert.equal((done.invocations[4] as any)?.wrapUp, true);
});

test('wrap-up fallback: failed wrap-up resume launch returns timeout with partial path', async () => {
  const h = harness(posix);
  const spec: any = {
    ...claude,
    parse: (out: ProcessResult, r: any) => r.resume
      ? { status: 'fail' as const, cls: 'empty-output' as const, detail: 'resume empty' }
      : { status: 'fail' as const, cls: 'config' as const, detail: 'first config' },
    argv: (r: any) => ({ argv: ['bin', r.resume ? `resume:${r.resume}` : 'fresh', r.prompt], stdin: null, env: {}, cwd: r.cwd }),
    attemptSession: () => 'sess1',
  };
  const run = runDelegate(spec, { ...req, timeoutMs: 1_800_000 }, 'cli', h.ports);
  await flush();
  h.clock.advance(1_500_000);
  await flush();
  h.finish(ok({ exit: 1, stdout: 'first config' }));
  await flush(); await flush();
  assert.equal(h.launches.length, 2);
  h.finish(ok({ exit: 1, stdout: 'resume empty' }));
  const done = await run;
  assert.equal(h.launches.length, 2);
  assert.equal(done.outcome.status === 'fail' && done.outcome.cls, 'timeout');
  assert.match(done.outcome.status === 'fail' ? done.outcome.detail : '', /partial output at/);
  { // wrap-up resume argv build failure also returns timeout with partial path
    const argvBoom = harness(posix);
    const argvSpec: any = {
      ...claude,
      parse: () => ({ status: 'fail' as const, cls: 'config' as const, detail: 'first config' }),
      argv: (r: any) => { if (r.resume) throw new Error('argv boom'); return { argv: ['bin', 'fresh', r.prompt], stdin: null, env: {}, cwd: r.cwd }; },
      attemptSession: () => 'sess1',
    };
    const argvRun = runDelegate(argvSpec, { ...req, timeoutMs: 1_800_000 }, 'cli', argvBoom.ports);
    await flush();
    argvBoom.clock.advance(1_500_000);
    await flush();
    argvBoom.finish(ok({ exit: 1, stdout: 'first config' }));
    const argvDone = await argvRun;
    assert.equal(argvDone.outcome.status === 'fail' && argvDone.outcome.cls, 'timeout');
    assert.match(argvDone.outcome.status === 'fail' ? argvDone.outcome.detail : '', /partial output at/);
  }
});

test('wrap-up stop: Copilot with streamed output stops and resumes with wrap-up', async () => {
  const { copilot } = await import('../../../skills/dispatch/scripts/providers/copilot.ts');
  const h = harness(posix);
  (h.ports as any).nonce = () => 'preset123';
  const run = runDelegate(copilot, { ...req, timeoutMs: 1_800_000 }, 'cli', h.ports);
  await flush();
  assert.ok((h.launches[0]?.argv ?? []).includes('--session-id'));
  h.fs.writeText('/r/log', 'streamed partial output');
  for (let t = 0; t < 1_500_000; t += 60_000) { h.clock.advance(60_000); h.activity(); await flush(); }
  assert.deepEqual(h.signals, ['-50:SIGTERM']);
  h.finish(ok({ exit: null, signal: 'SIGTERM', stdout: 'streamed partial output' }));
  await flush(); await flush();
  assert.equal(h.launches.length, 2);
  const resumeArgv = h.launches[1]?.argv ?? [];
  assert.ok(resumeArgv.includes('--resume'));
  assert.ok(!resumeArgv.includes('--session-id'));
  const wrapPrompt = (h.launches[1]?.argv ?? []).join('\n');
  const deadlineIso = new Date(1_800_000).toISOString();
  assert.ok(wrapPrompt.includes('Make no further tool calls'), 'wrap-up prompt must forbid further tool calls');
  assert.ok(wrapPrompt.includes(`[DEADLINE]: ${deadlineIso} (5m remaining)`), 'wrap-up launch must show 5m remaining');
  assert.ok(!wrapPrompt.includes('wrap-up at'), 'wrap-up launch must omit wrap-up timestamp');
  h.finish(ok({ exit: 0, stdout: 'FINAL answer', stderrTail: '' }));
  const finished = await run;
  assert.equal(finished.outcome.status, 'ok');
});

test('wrap-up stop: Copilot without streamed output runs to the deadline kill', async () => {
  const { copilot } = await import('../../../skills/dispatch/scripts/providers/copilot.ts');
  const h = harness(posix);
  const run = runDelegate(copilot, { ...req, timeoutMs: 1_800_000 }, 'cli', h.ports);
  await flush();
  h.fs.writeText('/r/log', '');
  for (let t = 0; t < 1_500_000; t += 60_000) { h.clock.advance(60_000); h.activity(); await flush(); }
  assert.deepEqual(h.signals, []);
  h.clock.advance(300_000);
  await flush();
  h.finish(ok({ exit: null, signal: 'SIGTERM', stdout: '', timedOut: true }));
  const finished = await run;
  assert.equal(h.launches.length, 1);
  assert.equal(finished.outcome.status === 'fail' && finished.outcome.cls, 'timeout');
});

test('wrap-up stop: OpenCode session event stops and resumes with wrap-up', async () => {
  const h = harness(posix);
  const run = runDelegate(opencode, { ...req, timeoutMs: 1_800_000 }, 'cli', h.ports);
  await flush();
  h.fs.writeText('/r/log', '{"sessionID":"sess-op-123","type":"text","part":{"text":"hi"}}\n');
  for (let t = 0; t < 1_500_000; t += 60_000) { h.clock.advance(60_000); h.activity(); await flush(); }
  assert.ok(h.signals.length > 0, 'expected wrap-up stop signal');
  h.finish(ok({ exit: null, signal: 'SIGTERM', stdout: '{"sessionID":"sess-op-123"}' }));
  await flush(); await flush();
  assert.equal(h.launches.length, 2);
  assert.ok((h.launches[1]?.argv ?? []).join('\n').includes('Wrap up'));
  h.finish(ok({ exit: 0, stdout: '{"sessionID":"sess-op-123","type":"text","part":{"text":"FINAL"}}' }));
  const finished = await run;
  assert.equal(finished.outcome.status, 'ok');
});

test('wrap-up fallback: wrap-up resume that reaches the deadline returns timeout', async () => {
  const h = harness(posix);
  const spec: any = {
    ...claude,
    parse: (out: ProcessResult, r: any) => r.resume
      ? { status: 'fail' as const, cls: 'empty-output' as const, detail: 'resume empty' }
      : { status: 'fail' as const, cls: 'config' as const, detail: 'first config' },
    argv: (r: any) => ({ argv: ['bin', r.resume ? `resume:${r.resume}` : 'fresh', r.prompt], stdin: null, env: {}, cwd: r.cwd }),
    attemptSession: () => 'sess1',
  };
  const run = runDelegate(spec, { ...req, timeoutMs: 1_800_000 }, 'cli', h.ports);
  await flush();
  h.clock.advance(1_500_000);
  await flush();
  h.finish(ok({ exit: 1, stdout: 'first config' }));
  await flush(); await flush();
  assert.equal(h.launches.length, 2);
  h.clock.advance(300_000);
  await flush();
  h.finish(ok({ exit: null, signal: 'SIGTERM', stdout: 'partial', timedOut: true }));
  const finished = await run;
  assert.equal(h.launches.length, 2);
  assert.equal(finished.outcome.status === 'fail' && finished.outcome.cls, 'timeout');
  assert.match(finished.outcome.status === 'fail' ? finished.outcome.detail : '', /partial output at/);
});

test('wrap-up stop: failed tree kill keeps the deadline kill and returns timeout with no resume', async () => {
  const h = harness(posix);
  let calls = 0;
  const signal = h.ports.process.signal;
  h.ports.process.signal = (pid: number, sig: 'SIGTERM' | 'SIGKILL') => {
    calls++;
    if (calls === 1) throw new Error('kill ESRCH');
    signal(pid, sig);
  };
  const run = runDelegate(claude, { ...req, timeoutMs: 1_800_000 }, 'cli', h.ports);
  await flush();
  h.clock.advance(1_500_000);
  await flush();
  assert.equal(h.launches.length, 1);
  assert.deepEqual(h.signals, []);
  h.clock.advance(300_000);
  await flush();
  assert.deepEqual(h.signals, ['-50:SIGTERM']);
  h.finish(ok({ exit: null, signal: 'SIGTERM', stdout: 'partial', timedOut: true }));
  const done = await run;
  assert.equal(h.launches.length, 1);
  assert.equal(done.outcome.status === 'fail' && done.outcome.cls, 'timeout');
  assert.match(done.outcome.status === 'fail' ? done.outcome.detail : '', /partial output at/);
});

test('wrap-up stop: teardown failure returns timeout with no resume', async () => {
  const h = harness(posix);
  h.ports.process.settleGroup = async () => false;
  const run = runDelegate(opencode, { ...req, timeoutMs: 1_800_000 }, 'cli', h.ports);
  await flush();
  h.fs.writeText('/r/log', '{"sessionID":"sess-op-123","type":"text","part":{"text":"hi"}}\n');
  for (let t = 0; t < 1_500_000; t += 60_000) { h.activity(); h.clock.advance(60_000); await flush(); }
  assert.ok(h.signals.length > 0, 'expected wrap-up stop signal');
  h.finish(ok({ exit: null, signal: 'SIGTERM', stdout: '{"sessionID":"sess-op-123"}' }));
  const done = await run;
  assert.equal(done.result?.wrapUpStop, true);
  assert.equal(h.launches.length, 1);
  assert.equal(done.outcome.status === 'fail' && done.outcome.cls, 'timeout');
  assert.match(done.outcome.status === 'fail' ? done.outcome.detail : '', /partial output at/);
  assert.ok(done.result?.lifecycleError);
});

test('wrap-up stop: sandbox-inactive result returns sandbox-unsupported with no resume', async () => {
  const h = harness(posix);
  const run = runDelegate(claude, { ...req, timeoutMs: 1_800_000, sandbox: true }, 'cli', h.ports);
  await flush();
  h.clock.advance(1_500_000);
  await flush();
  assert.deepEqual(h.signals, ['-50:SIGTERM']);
  h.finish(ok({ exit: null, signal: 'SIGTERM', stdout: 'partial', stderrTail: 'Sandbox disabled, sandbox not active' }));
  await flush(); await flush();
  const done = await run;
  assert.equal(h.launches.length, 1);
  assert.equal(done.outcome.status === 'fail' && done.outcome.cls, 'sandbox-unsupported');
});

test('deadline notice: effort retry draws a fresh preset id and resumes send none', async () => {
  const h = harness(posix);
  let n = 0;
  (h.ports as any).nonce = () => `preset-${++n}`;
  const spec: any = {
    ...claude,
    parse: (out: ProcessResult, launch: any) => launch.effort
      ? { status: 'fail' as const, cls: 'config' as const, detail: 'effort unsupported', retryWithoutEffort: true }
      : claude.parse(out, launch),
  };
  const run = runDelegate(spec, { ...req, model: 'm', effort: 'high' }, 'cli', h.ports);
  await flush();
  h.finish(ok({ durationMs: 7 }));
  await flush(); await flush();
  h.finish(ok({ stdout: JSON.stringify({ type: 'result', result: 'R', session_id: 'sess-1' }) }));
  await run;
  const first = (h.launches[0]?.argv ?? []).join(' ');
  const second = (h.launches[1]?.argv ?? []).join(' ');
  assert.match(first, /--session-id preset-1/);
  assert.match(second, /--session-id preset-2/);
  assert.ok(!first.includes('--resume'));
  assert.ok(!second.includes('--resume'));
});
