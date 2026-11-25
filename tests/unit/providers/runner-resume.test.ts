import { nodeProcess } from '../../../skills/dispatch/scripts/providers/node-process.ts';
import { copilot } from '../../../skills/dispatch/scripts/providers/copilot.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { claude } from '../../../skills/dispatch/scripts/providers/claude.ts';
import { codex } from '../../../skills/dispatch/scripts/providers/codex.ts';
import { opencode } from '../../../skills/dispatch/scripts/providers/opencode.ts';
import type { HostUsageFs } from '../../../skills/dispatch/scripts/lib/usage/rows.ts';
import {
  CONTINUE_PROMPT,
  IDLE_TIMEOUT_MS,
  GUARDRAIL_HEADER,
  runDelegate,
} from '../../../skills/dispatch/scripts/providers/runner.ts';
import type { RunnerFs, RunnerPorts } from '../../../skills/dispatch/scripts/providers/runner.ts';
import type {
  DelegateRequest,
  Invocation,
  Launch,
  PlatformEnv,
  ProcessResult,
  ProviderSpec,
} from '../../../skills/dispatch/scripts/providers/types.ts';

const posix: PlatformEnv = {
  os: 'linux',
  arch: 'x64',
  wsl: false,
  bubblewrap: true,
  argvLimit: 100_000,
  home: '/h',
  path: [],
  pathExt: [],
};
const windows: PlatformEnv = { ...posix, os: 'win32', bubblewrap: false, argvLimit: 24_000 };
const req: DelegateRequest = {
  promptPath: '/r/p.md',
  model: null,
  effort: null,
  sandbox: false,
  schemaPath: null,
  resume: null,
  cwd: '/repo',
  timeoutMs: 5000,
  outputCapBytes: 100,
  attachments: [],
  logPath: '/r/log',
  briefPath: '/r/brief.md',
};
const ok = (over: Partial<ProcessResult> = {}): ProcessResult => ({
  exit: 0,
  signal: null,
  stdout: '{"result":"R"}',
  stdoutPath: '/r/log',
  stderrTail: '',
  durationMs: 1,
  timedOut: false,
  truncated: false,
  ...over,
});

function memFs(
  files: Record<string, string>,
  links: Record<string, string> = {},
): RunnerFs & { files: Map<string, string> } {
  const map = new Map(Object.entries(files));
  return {
    files: map,
    readText: (f) => map.get(f) ?? '',
    writeText: (f, t) => {
      map.set(f, t);
    },
    realpath: (f) => links[f] ?? (map.has(f) ? f : null),
    readdir: () => [],
    size: (f) => (map.has(f) ? Buffer.byteLength(map.get(f) ?? '') : null),
    readPrefix: (f, n) =>
      Buffer.from(map.get(f) ?? '')
        .subarray(0, n)
        .toString('utf8'),
  };
}

/** Placeholder until the fake process registers its real callback. */
const noop = (): void => {};

/** Manual clock: timers fire only when the test advances time. */
function manualClock() {
  let now = 0;
  const timers: Array<{ at: number; ms: number; fn: () => void; live: boolean }> = [];
  return {
    now: () => now,
    every: (ms: number, fn: () => void) => {
      const t = { at: now + ms, ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    advance(ms: number) {
      now += ms;
      for (const t of timers.slice()) {
        while (t.live && t.at <= now) {
          t.at += t.ms;
          t.fn();
        }
      }
    },
  };
}

function harness(platform: PlatformEnv, files: Record<string, string> = { '/r/p.md': 'Review it' }) {
  const launches: Array<Launch> = [];
  const signals: Array<string> = [];
  const clock = manualClock();
  let finish: (r: ProcessResult) => void = noop;
  let activity: () => void = noop;
  let line: (value: string, fragment?: boolean) => void = noop;
  const fs = memFs(files);
  const ports: RunnerPorts = {
    process: {
      start: (launch, io) => {
        launches.push(launch);
        if (io.onActivity) {
          activity = io.onActivity;
        }
        if (io.onLine) {
          line = io.onLine;
        }
        if (launch.argv[0] === 'taskkill') {
          return { pid: 99, done: Promise.resolve(ok()) };
        }
        return {
          pid: 50,
          done: new Promise<ProcessResult>((resolve) => {
            finish = resolve;
          }),
        };
      },
      signal: (pid, sig) => {
        signals.push(`${pid}:${sig}`);
      },
    },
    clock,
    fs,
    usageFs: memUsageFs({}),
    platform,
    binary: 'claude',
    nonce: () => 'N0NCE',
    env: {
      PATH: '/bin',
      HOME: '/h',
      ANTHROPIC_API_KEY: 'sk-1',
      GITHUB_TOKEN: 'ghp',
      AWS_SECRET_ACCESS_KEY: 'x',
      HTTPS_PROXY: 'http://p',
    },
  };
  return {
    ports,
    launches,
    signals,
    clock,
    fs,
    finish: (r: ProcessResult) => finish(r),
    activity: () => activity(),
    line: (value: string, fragment?: boolean) => {
      activity();
      line(value, fragment);
    },
  };
}

const flush = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

test('Copilot retry clears only the rejected per-attempt configured effort', async () => {
  const h = harness(posix);
  const spec = {
    ...copilot,
    parse: (out: ProcessResult, launch: Parameters<typeof copilot.parse>[1]) =>
      launch.effort
        ? { status: 'fail' as const, cls: 'config' as const, detail: 'effort unsupported', retryWithoutEffort: true }
        : copilot.parse(out, launch),
  };
  const pending = runDelegate(spec, { ...req, effort: 'high' }, 'cli', h.ports);
  await flush();
  h.finish(ok());
  await flush();
  await flush();
  h.finish(ok({ stdout: 'answer' }));
  const result = await pending;
  assert.equal(result.outcome.status, 'ok');
  assert.deepEqual(
    result.invocations.map((i) => i.configuredEffort),
    ['high', undefined],
  );
  assert.deepEqual(
    result.invocations.map((i) => i.effort),
    [null, null],
  );
  assert.ok(h.launches[0]!.argv.includes('high'));
  assert.ok(!h.launches[1]!.argv.includes('high'));
});

const makeNudgeSpec = (sessionId: string | null): any => ({
  ...claude,
  id: 'codex',
  silentUntilExit: undefined,
  attemptSession: () => sessionId,
  parse: (out: ProcessResult) =>
    out.stdout.includes('FINAL')
      ? { status: 'ok' as const, text: 'FINAL', sessionId: 'sess1', resume: null }
      : { status: 'fail' as const, cls: 'empty-output' as const, detail: 'empty' },
  argv: (r: any) => ({
    argv: ['bin', r.resume ? `resume:${r.resume}` : 'fresh', r.prompt],
    stdin: null,
    env: {},
    cwd: r.cwd,
  }),
});

const makeCapacitySpec = (retryAfterMs?: number): any => ({
  ...makeNudgeSpec('sess1'),
  parse: (out: ProcessResult) =>
    out.stdout.includes('FINAL')
      ? { status: 'ok' as const, text: 'FINAL', sessionId: 'sess1', resume: null }
      : {
          status: 'fail' as const,
          cls: 'capacity' as const,
          detail: 'at capacity',
          ...(!(retryAfterMs === undefined) && { retryAfterMs }),
        },
});

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
          if (seg) {
            names.add(seg);
          }
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
      if (!buf) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return buf.subarray(0, maxBytes);
    },
    decompress: null,
    ...extra,
  };
}

// T2 wrap-up RED: deadline notice, stop/resume, budget, fallback.

test('silent delegate times out idle after the idle window, before the overall deadline', async () => {
  const h = harness(posix);
  const run = runDelegate(codex, { ...req, timeoutMs: 4 * IDLE_TIMEOUT_MS }, 'cli', h.ports);
  await flush();
  h.clock.advance(10_000);
  h.activity();
  h.clock.advance(IDLE_TIMEOUT_MS - 30_000);
  assert.deepEqual(h.signals, []);
  h.clock.advance(30_000);
  assert.deepEqual(h.signals, ['-50:SIGTERM']);
  h.finish(ok({ exit: null, signal: 'SIGTERM', stdout: 'partial' }));
  const done = await run;
  assert.equal(done.result?.timedOut, true);
  assert.equal(done.outcome.status === 'fail' && done.outcome.cls, 'timeout');
  assert.match(
    done.outcome.status === 'fail' ? done.outcome.detail : '',
    new RegExp(`^idle ${Math.round(IDLE_TIMEOUT_MS / 1000)}s; partial output at \\/r\\/log$`),
  );
});

test('resume: stall resumes once after idle or empty-output with continue prompt', async () => {
  for (const first of ['idle', 'empty'] as const) {
    const h = harness(posix);
    const spec = makeNudgeSpec('sess1');
    const rows: Array<Invocation> = [];
    const run = runDelegate(spec, { ...req, onInvocation: (row) => rows.push(row) }, 'cli', h.ports);
    await flush();
    if (first === 'idle') {
      h.finish(ok({ exit: null, signal: 'SIGTERM', stdout: 'SESS partial', timedOut: true, idleMs: IDLE_TIMEOUT_MS }));
    } else {
      h.clock.advance(10);
      h.finish(ok({ exit: 1, stdout: 'no answer', stderrTail: 'boom' }));
    }
    await flush();
    await flush();
    h.clock.advance(10);
    h.finish(ok({ stdout: 'FINAL answer' }));
    const done = await run;
    assert.equal(h.launches.length, 2, first);
    assert.equal(done.outcome.status, 'ok', first);
    assert.equal(done.invocations[1]?.nudge, true, first);
    assert.deepEqual(
      rows.map(({ startMs, endMs }) => [startMs, endMs]),
      first === 'idle'
        ? [
            [0, 0],
            [1, 10],
          ]
        : [
            [0, 10],
            [11, 20],
          ],
      first,
    );
    if (first === 'idle') {
      assert.match(String(h.launches[1]?.argv[1] ?? ''), /resume:sess1/);
      assert.ok(String(h.launches[1]?.argv[2] ?? '').includes(CONTINUE_PROMPT));
      assert.ok((h.fs.files.get('/r/log.stalled') ?? '').includes('## codex'));
    }
  }
});

test('resume: stall retries to the cap with the last valid session id', async () => {
  for (const launches of [3, 4]) {
    const h = harness(posix);
    const run = runDelegate(makeNudgeSpec('sess1'), { ...req, resumesUsed: 4 - launches }, 'cli', h.ports);
    await flush();
    for (let i = 0; i < launches - 1; i++) {
      h.finish(ok({ exit: 1, stdout: 'empty one' }));
      await flush();
      await flush();
    }
    const terminal = launches === 4;
    h.finish(ok(terminal ? { exit: 1, stdout: 'empty final' } : { stdout: 'FINAL answer' }));
    const done = await run;
    assert.equal(h.launches.length, launches);
    assert.equal(done.attempts, launches);
    assert.equal(done.outcome.status, terminal ? 'fail' : 'ok');
    assert.deepEqual(
      done.invocations.map((invocation) => (invocation as { nudge?: boolean }).nudge),
      done.invocations.map((_, i) => (i === 0 ? undefined : true)),
    );
  }
  const h = harness(posix);
  let call = 0;
  const spec: ProviderSpec = { ...makeNudgeSpec('sess1'), attemptSession: () => (call++ === 0 ? 'sess1' : null) };
  const run = runDelegate(spec, req, 'cli', h.ports);
  await flush();
  h.finish(ok({ exit: 1, stdout: 'empty one' }));
  await flush();
  await flush();
  assert.match(String(h.launches[1]?.argv[1] ?? ''), /resume:sess1/);
  h.finish(ok({ exit: 1, stdout: 'empty two' }));
  await flush();
  await flush();
  assert.match(String(h.launches[2]?.argv[1] ?? ''), /resume:sess1/);
  h.finish(ok({ stdout: 'FINAL answer' }));
  assert.equal((await run).outcome.status, 'ok');
});

test('resume: stall nudge marks resume launches but not effort retries', async () => {
  const initial = harness(posix);
  const initialRun = runDelegate(makeNudgeSpec('sess1'), { ...req, resume: 'prior' }, 'cli', initial.ports);
  await flush();
  initial.finish(ok({ stdout: 'FINAL answer' }));
  const initialDone = await initialRun;
  assert.match(String(initial.launches[0]?.argv[1] ?? ''), /resume:prior/);
  assert.equal(initialDone.invocations[0]?.nudge, true);

  const chained = harness(posix);
  const chainedRun = runDelegate(makeNudgeSpec('sess1'), req, 'cli', chained.ports);
  await flush();
  chained.finish(ok({ exit: 1, stdout: 'empty' }));
  await flush();
  await flush();
  chained.finish(ok({ stdout: 'FINAL answer' }));
  const chainedDone = await chainedRun;
  assert.equal(chainedDone.invocations[0]?.nudge, undefined);
  assert.equal(chainedDone.invocations[1]?.nudge, true);

  const h = harness(posix);
  const spec: any = {
    ...claude,
    parse: (out: ProcessResult, launch: any) =>
      launch.effort
        ? { status: 'fail' as const, cls: 'config' as const, detail: 'effort unsupported', retryWithoutEffort: true }
        : claude.parse(out, launch),
    attemptSession: () => 'sess1',
  };
  const run = runDelegate(spec, { ...req, model: 'm', effort: 'high' }, 'cli', h.ports);
  await flush();
  h.finish(ok({ durationMs: 7 }));
  await flush();
  await flush();
  h.finish(ok({ durationMs: 9 }));
  const done = await run;
  assert.equal(done.outcome.status, 'ok');
  assert.equal(h.launches.length, 2);
  assert.equal(done.invocations[1]?.nudge, undefined);
});

test('resume: capacity waits bounded delay then resumes or skips without time', async () => {
  {
    // explicit retryAfterMs waits then resumes with the continue prompt
    const h = harness(posix);
    const run = runDelegate(makeCapacitySpec(30_000), { ...req, timeoutMs: 200_000 }, 'cli', h.ports);
    await flush();
    h.finish(ok({ exit: 1, stdout: 'at capacity' }));
    await flush();
    assert.equal(h.launches.length, 1);
    h.clock.advance(29_999);
    await flush();
    assert.equal(h.launches.length, 1);
    h.clock.advance(1);
    await flush();
    await flush();
    assert.equal(h.launches.length, 2);
    assert.match(String(h.launches[1]?.argv[1] ?? ''), /resume:sess1/);
    assert.ok(String(h.launches[1]?.argv[2] ?? '').includes(CONTINUE_PROMPT));
    h.finish(ok({ stdout: 'FINAL answer' }));
    const done = await run;
    assert.equal(done.outcome.status, 'ok');
    assert.equal(done.invocations[1]?.nudge, true);
  }
  for (const [retryAfterMs, wait] of [
    [undefined, 30_000],
    [500_000, 120_000],
  ] as const) {
    const h = harness(posix);
    const run = runDelegate(makeCapacitySpec(retryAfterMs), { ...req, timeoutMs: 200_000 }, 'cli', h.ports);
    await flush();
    h.finish(ok({ exit: 1, stdout: 'at capacity' }));
    await flush();
    h.clock.advance(wait - 1);
    await flush();
    assert.equal(h.launches.length, 1, String(retryAfterMs));
    h.clock.advance(1);
    await flush();
    await flush();
    assert.equal(h.launches.length, 2, String(retryAfterMs));
    h.finish(ok({ stdout: 'FINAL answer' }));
    assert.equal((await run).outcome.status, 'ok', String(retryAfterMs));
  }
  {
    // remaining time at or below retryAfterMs makes no resume launch
    const h = harness(posix);
    const run = runDelegate(makeCapacitySpec(30_000), { ...req, timeoutMs: 10_000 }, 'cli', h.ports);
    await flush();
    h.finish(ok({ exit: 1, stdout: 'at capacity' }));
    await flush();
    await flush();
    const done = await run;
    assert.equal(h.launches.length, 1);
    assert.equal(done.outcome.status, 'fail');
    assert.equal(done.outcome.status === 'fail' && done.outcome.cls, 'capacity');
  }
});

test('resume: stall skips resume when unresumable', async () => {
  {
    // no session id
    const h = harness(posix);
    const spec = makeNudgeSpec(null);
    const run = runDelegate(spec, req, 'cli', h.ports);
    await flush();
    h.finish(ok({ exit: 1, stdout: 'empty' }));
    await flush();
    await flush();
    const done = await run;
    assert.equal(h.launches.length, 1);
    assert.equal(done.outcome.status, 'fail');
  }
  {
    // no deadline left
    const h = harness(posix, { '/r/p.md': 'Review it' });
    const spec: any = {
      ...claude,
      id: 'codex',
      silentUntilExit: undefined,
      attemptSession: () => {
        h.clock.advance(10_000);
        return 'sess1';
      },
      parse: () => ({ status: 'fail' as const, cls: 'empty-output' as const, detail: 'empty' }),
      argv: (r: any) => ({
        argv: ['bin', r.resume ? `resume:${r.resume}` : 'fresh', r.prompt],
        stdin: null,
        env: {},
        cwd: r.cwd,
      }),
    };
    const run = runDelegate(spec, { ...req, timeoutMs: 5000 }, 'cli', h.ports);
    await flush();
    h.finish(ok({ exit: 1, stdout: 'empty' }));
    const done = await run;
    assert.equal(h.launches.length, 1);
    assert.equal(done.outcome.status, 'fail');
  }
  for (const { name, result, cls } of [
    { name: 'lifecycleError', result: ok({ lifecycleError: 'group unconfirmed' }), cls: 'timeout' },
    { name: 'truncated', result: ok({ truncated: true }), cls: 'buffer' },
    {
      name: 'overall-deadline timeout',
      result: ok({ exit: null, signal: 'SIGTERM', stdout: 'partial', timedOut: true }),
      cls: 'timeout',
    },
  ] as const) {
    const h = harness(posix);
    const run = runDelegate(makeNudgeSpec('sess1'), req, 'cli', h.ports);
    await flush();
    h.finish(result);
    await flush();
    await flush();
    const done = await run;
    assert.equal(h.launches.length, 1, name);
    assert.equal(done.outcome.status === 'fail' && done.outcome.cls, cls, name);
  }
});

test('resume prompt carries safety header and continue prompt without attachments or brief leak', async () => {
  const h = harness(posix, { '/r/p.md': 'Review it', '/r/a.ts': 'attachment data' });
  const spec = makeNudgeSpec('sess1');
  const run = runDelegate(spec, { ...req, attachments: ['/r/a.ts'] }, 'cli', h.ports);
  await flush();
  h.finish(ok({ exit: 1, stdout: 'empty' }));
  await flush();
  await flush();
  h.finish(ok({ stdout: 'FINAL answer' }));
  const done = await run;
  assert.equal(done.outcome.status, 'ok');
  const resumePrompt = String(h.launches[1]?.argv[2] ?? '');
  assert.ok(resumePrompt.includes(GUARDRAIL_HEADER));
  assert.ok(resumePrompt.includes(CONTINUE_PROMPT));
  assert.ok(!resumePrompt.includes('/r/a.ts'));
  {
    // spilled first prompt does not leak brief file into resume
    const spilled = harness(posix, { '/r/p.md': 'Review it', '/r/a.ts': `data ${'x'.repeat(110_000)}` });
    const spilledRun = runDelegate(makeNudgeSpec('sess1'), { ...req, attachments: ['/r/a.ts'] }, 'cli', spilled.ports);
    await flush();
    spilled.finish(ok({ exit: 1, stdout: 'empty' }));
    await flush();
    await flush();
    spilled.finish(ok({ stdout: 'FINAL answer' }));
    const spilledDone = await spilledRun;
    assert.equal(spilledDone.outcome.status, 'ok');
    assert.ok(String(spilled.launches[0]?.argv[2] ?? '').includes('Brief file:'));
    const spilledResume = String(spilled.launches[1]?.argv[2] ?? '');
    assert.ok(spilledResume.includes(CONTINUE_PROMPT));
    assert.ok(!spilledResume.includes('Brief file:'));
    assert.equal(spilledDone.briefFile, null);
  }
});

test('resume: stall: two stalled launches in one slot both kept in stalled', async () => {
  const h = harness(posix);
  const spec = makeNudgeSpec('sess1');
  for (let i = 0; i < 2; i++) {
    const run = runDelegate(spec, req, 'cli', h.ports);
    await flush();
    h.finish(ok({ exit: 1, stdout: `empty ${i}` }));
    await flush();
    await flush();
    h.finish(ok({ stdout: 'FINAL answer' }));
    await run;
  }
  const stalled = h.fs.files.get('/r/log.stalled') ?? '';
  assert.equal((stalled.match(/## codex/g) ?? []).length, 2);
});

test('resume: stall: first stall with missing or unreadable stalled file still nudges', async () => {
  for (const code of ['ENOENT', 'EACCES'] as const) {
    const h = harness(posix);
    const realRead = h.fs.readText;
    h.fs.readText = (f: string) => {
      if (f.endsWith('.stalled')) {
        if (code === 'ENOENT') {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      return realRead(f);
    };
    const run = runDelegate(makeNudgeSpec('sess1'), req, 'cli', h.ports);
    await flush();
    h.finish(ok({ exit: 1, stdout: 'empty' }));
    await flush();
    await flush();
    h.finish(ok({ stdout: 'FINAL answer' }));
    const done = await run;
    assert.equal(done.outcome.status, 'ok', code);
    assert.equal(h.launches.length, 2, code);
    if (code === 'ENOENT') {
      assert.ok((h.fs.files.get('/r/log.stalled') ?? '').includes('## codex'), code);
    }
  }
});

const parse = (out: ProcessResult) =>
  out.stdout.includes('FINAL')
    ? { status: 'ok' as const, text: 'FINAL', sessionId: 's', resume: null }
    : { status: 'fail' as const, cls: 'empty-output' as const, detail: 'empty' };
const argv = (r: any) => ({
  argv: ['bin', r.resume ? `resume:${r.resume}` : 'fresh', r.prompt],
  stdin: null,
  env: {},
  cwd: r.cwd,
});

test('resume: stall resume setup failure returns stalled outcome', async () => {
  {
    // resume prepare fails
    const h = harness(posix);
    h.ports.prepare = { fetchModels: async () => [], acquireGpuLock: async () => () => {} };
    const spec: any = {
      ...claude,
      id: 'codex',
      silentUntilExit: undefined,
      prepare: async (r: any) =>
        r.resume
          ? { kind: 'fail' as const, outcome: { status: 'fail' as const, cls: 'config' as const, detail: 'nope' } }
          : { kind: 'launch' as const, env: {}, release: () => {} },
      parse,
      attemptSession: () => 'sess1',
      argv,
    };
    const run = runDelegate(spec, req, 'cli', h.ports);
    await flush();
    h.finish(ok({ exit: 1, stdout: 'empty' }));
    const done = await run;
    assert.equal(done.outcome.status, 'fail');
    assert.equal(done.outcome.status === 'fail' && done.outcome.cls, 'empty-output');
    assert.equal(h.launches.length, 1);
  }
  {
    // deadline spent in resume prepare
    const h = harness(posix);
    h.ports.prepare = { fetchModels: async () => [], acquireGpuLock: async () => () => {} };
    const spec: any = {
      ...claude,
      id: 'codex',
      silentUntilExit: undefined,
      prepare: async (r: any) => {
        if (r.resume) {
          h.clock.advance(10_000);
        }
        return { kind: 'launch' as const, env: {}, release: () => {} };
      },
      parse,
      attemptSession: () => 'sess1',
      argv,
    };
    const run = runDelegate(spec, { ...req, timeoutMs: 5000 }, 'cli', h.ports);
    await flush();
    h.finish(ok({ exit: 1, stdout: 'empty' }));
    const done = await run;
    assert.equal(done.outcome.status, 'fail');
    assert.equal(h.launches.length, 1);
  }
  {
    // throwing spill write on resume (win32 batch launcher always spills)
    const h = harness(windows);
    h.ports.binary = 'C:/bin/tool.cmd';
    const realWrite = h.fs.writeText;
    h.fs.writeText = (f: string, t: string) => {
      if (f === '/r/brief.md' && t.includes(CONTINUE_PROMPT)) {
        throw new Error('spill boom');
      }
      realWrite(f, t);
    };
    const spec: any = {
      ...claude,
      id: 'codex',
      silentUntilExit: undefined,
      attemptSession: () => 'sess1',
      parse,
      argv: (r: any) => ({
        argv: [r.binary, r.resume ? `resume:${r.resume}` : 'fresh', r.prompt],
        stdin: null,
        env: {},
        cwd: r.cwd,
      }),
    };
    const run = runDelegate(spec, req, 'cli', h.ports);
    await flush();
    h.finish(ok({ exit: 1, stdout: 'empty' }));
    const done = await run;
    assert.equal(done.outcome.status, 'fail');
    assert.equal(h.launches.length, 1);
  }
  {
    // throwing argv build on resume
    const h = harness(posix);
    const spec: any = {
      ...claude,
      id: 'codex',
      silentUntilExit: undefined,
      attemptSession: () => 'sess1',
      parse,
      argv: (r: any) => {
        if (r.resume) {
          throw new Error('argv boom');
        }
        return { argv: ['bin', 'fresh', r.prompt], stdin: null, env: {}, cwd: r.cwd };
      },
    };
    const run = runDelegate(spec, req, 'cli', h.ports);
    await flush();
    h.finish(ok({ exit: 1, stdout: 'empty' }));
    const done = await run;
    assert.equal(done.outcome.status, 'fail');
    assert.equal(done.outcome.status === 'fail' && done.outcome.cls, 'empty-output');
    assert.equal(h.launches.length, 1);
  }
  {
    // throwing process start on resume
    const h = harness(posix);
    const spec = makeNudgeSpec('sess1');
    const realStart = h.ports.process.start.bind(h.ports.process);
    h.ports.process.start = (launch, io) => {
      if (String(launch.argv[1] ?? '').startsWith('resume:')) {
        throw new Error('spawn boom');
      }
      return realStart(launch, io);
    };
    const run = runDelegate(spec, req, 'cli', h.ports);
    await flush();
    h.finish(ok({ exit: 1, stdout: 'empty' }));
    const done = await run;
    assert.equal(done.outcome.status, 'fail');
    assert.equal(h.launches.length, 1);
  }
});

test('resume: stall: win32 cmd resume spills continue prompt and starts', async () => {
  const h = harness(windows);
  h.ports.binary = 'C:/bin/tool.cmd';
  const spec: any = {
    ...claude,
    id: 'codex',
    silentUntilExit: undefined,
    attemptSession: () => 'sess1',
    parse: (out: ProcessResult) =>
      out.stdout.includes('FINAL')
        ? { status: 'ok' as const, text: 'FINAL', sessionId: 's', resume: null }
        : { status: 'fail' as const, cls: 'empty-output' as const, detail: 'empty' },
    argv: (r: any) => ({
      argv: [r.binary, r.resume ? `resume:${r.resume}` : 'fresh', r.prompt],
      stdin: null,
      env: {},
      cwd: r.cwd,
    }),
  };
  const run = runDelegate(spec, req, 'cli', h.ports);
  await flush();
  h.finish(ok({ exit: 1, stdout: 'empty' }));
  await flush();
  await flush();
  h.finish(ok({ stdout: 'FINAL answer' }));
  const done = await run;
  assert.equal(done.outcome.status, 'ok');
  assert.ok((h.fs.files.get('/r/brief.md') ?? '').includes(CONTINUE_PROMPT));
  assert.equal(h.launches.length, 2);
});

test('resume: stall: copilot preset flag on fresh launch only', async () => {
  const h = harness(posix);
  h.ports.nonce = () => 'preset123';
  const run = runDelegate(copilot, { ...req, timeoutMs: 60_000 }, 'cli', h.ports);
  await flush();
  assert.ok((h.launches[0]?.argv ?? []).includes('--session-id'));
  h.finish(ok({ exit: null, signal: 'SIGTERM', stdout: 'partial output', timedOut: true, idleMs: IDLE_TIMEOUT_MS }));
  await flush();
  await flush();
  const resumeArgv = h.launches[1]?.argv ?? [];
  assert.ok(resumeArgv.includes('--resume'));
  assert.ok(!resumeArgv.includes('--session-id'));
  h.finish(ok({ exit: 0, stdout: 'recovered answer', stderrTail: '' }));
  const done = await run;
  assert.equal(done.outcome.status, 'ok');
});

test('silent-until-exit delegate is not idle-killed before its deadline', async () => {
  const h = harness(posix);
  const run = runDelegate(claude, { ...req, timeoutMs: 4 * IDLE_TIMEOUT_MS }, 'cli', h.ports);
  await flush();
  h.clock.advance(3 * IDLE_TIMEOUT_MS);
  assert.deepEqual(h.signals, []);
  h.finish(ok());
  const done = await run;
  assert.equal(done.result?.timedOut, false);
  assert.equal(done.outcome.status, 'ok');
});

test('active delegate is not idle while output keeps arriving', async () => {
  const h = harness(posix);
  const run = runDelegate(codex, { ...req, timeoutMs: 4 * IDLE_TIMEOUT_MS }, 'cli', h.ports);
  await flush();
  for (let elapsed = 0; elapsed < 3 * IDLE_TIMEOUT_MS; elapsed += 60_000) {
    h.clock.advance(60_000);
    h.activity();
  }
  assert.deepEqual(h.signals, []);
  h.finish(ok());
  const done = await run;
  assert.equal(done.result?.timedOut, false);
});

test('diagnostics usage parsing stays off unless collection is enabled', async () => {
  for (const scenario of ['disabled', 'resume', 'truncated'] as const) {
    let calls = 0;
    const spec = {
      ...claude,
      resumeUsage: undefined,
      usage: () => {
        calls++;
        return {
          input: 3,
          output: 2,
          inputSemantics: 'uncached' as const,
          scope: 'invocation' as const,
          provenance: 'fixture',
        };
      },
    };
    const h = harness(posix);
    const pending = runDelegate(
      spec,
      { ...req, collectUsage: scenario !== 'disabled', resume: scenario === 'resume' ? 'resume-id' : null },
      'cli',
      h.ports,
    );
    await flush();
    h.finish(ok({ truncated: scenario === 'truncated' }));
    const result = await pending;
    assert.equal(calls, 0, scenario);
    assert.equal(result.outcome.status, scenario === 'truncated' ? 'fail' : 'ok', scenario);
  }
});

test('diagnostics usage parsing records measured usage and never throws', async () => {
  for (const scenario of ['enabled', 'throw'] as const) {
    let calls = 0;
    const spec = {
      ...claude,
      resumeUsage: undefined,
      usage: () => {
        calls++;
        if (scenario === 'throw') {
          throw new Error('parser');
        }
        return {
          input: 3,
          output: 2,
          inputSemantics: 'uncached' as const,
          scope: 'invocation' as const,
          provenance: 'fixture',
        };
      },
    };
    const h = harness(posix);
    const pending = runDelegate(spec, { ...req, collectUsage: true }, 'cli', h.ports);
    await flush();
    h.finish(ok());
    const result = await pending;
    assert.equal(calls, 1, scenario);
    assert.equal(result.outcome.status, 'ok', scenario);
    assert.equal(result.invocations[0]?.usage?.input, scenario === 'enabled' ? 3 : undefined, scenario);
  }
});

test('diagnostics usage parsing on effort retry and resume stays result-neutral', async () => {
  const spec = {
    ...claude,
    resumeUsage: undefined,
    parse: (out: ProcessResult, launch: Parameters<typeof claude.parse>[1]) =>
      launch.effort
        ? { status: 'fail' as const, cls: 'config' as const, detail: 'unsupported', retryWithoutEffort: true }
        : claude.parse(out, launch),
    usage: () => ({
      input: 3,
      output: 2,
      inputSemantics: 'uncached' as const,
      scope: 'invocation' as const,
      provenance: 'fixture',
    }),
  };
  const h = harness(posix);
  const pending = runDelegate(spec, { ...req, collectUsage: true, effort: 'high' }, 'cli', h.ports);
  await flush();
  h.finish(ok({ exit: 1, stderrTail: 'unknown option --effort' }));
  await flush();
  await flush();
  h.finish(ok());
  assert.equal((await pending).outcome.status, 'ok');
});

test('OpenCode settles its POSIX group after success, failure and timeout without changing other providers', async () => {
  for (const scenario of ['success', 'failure', 'timeout', 'other-provider'] as const) {
    for (const confirmed of [true, false]) {
      const h = harness(posix);
      let checks = 0;
      Object.assign(h.ports.process, {
        settleGroup: async (pid: number, budget: number) => {
          assert.equal(pid, 50);
          assert.ok(budget > 0 && budget <= 2000);
          checks++;
          return confirmed;
        },
      });
      const spec = scenario === 'other-provider' ? claude : opencode;
      const pending = runDelegate(spec, { ...req, agent: 'explore', readOnlyVerified: true }, 'cli', h.ports);
      await flush();
      if (scenario === 'timeout') {
        h.clock.advance(req.timeoutMs);
      }
      const stdout =
        scenario === 'other-provider'
          ? '{}'
          : scenario === 'failure'
            ? JSON.stringify({
                type: 'text',
                timestamp: 0,
                part: { id: 'text-0', messageID: 'msg', type: 'text', text: 'controlled output' },
              })
            : JSON.stringify({
                type: 'text',
                timestamp: 0,
                sessionID: 'ses',
                part: { id: 'text-0', sessionID: 'ses', messageID: 'msg', type: 'text', text: 'controlled output' },
              });
      h.finish(ok({ exit: scenario === 'failure' ? 7 : 0, stdout }));
      const result = await pending;
      assert.equal(checks, scenario === 'other-provider' ? 0 : 1);
      if (scenario === 'timeout') {
        assert.equal(result.outcome.status === 'fail' && result.outcome.cls, 'timeout');
        if (!confirmed) {
          assert.match(result.outcome.status === 'fail' ? result.outcome.detail : '', /process group.*unconfirmed/);
        }
      } else if (scenario !== 'other-provider' && !confirmed) {
        assert.equal(result.outcome.status === 'fail' && result.outcome.cls, 'timeout');
        assert.match(result.outcome.status === 'fail' ? result.outcome.detail : '', /process group.*unconfirmed/);
      } else if (scenario === 'success') {
        assert.equal(result.outcome.status, 'ok');
      } else if (scenario === 'failure') {
        assert.notEqual(result.outcome.status === 'fail' && result.outcome.cls, 'timeout');
      }
    }
  }
});

test('OpenCode spawn failures with no PID preserve not-found without signaling or settling a process group', async () => {
  for (const timing of ['before-deadline', 'deadline-race'] as const) {
    const h = harness(posix);
    let finish: (result: ProcessResult) => void = noop;
    let settleCalls = 0;
    Object.assign(h.ports.process, {
      settleGroup: async () => {
        settleCalls++;
        return false;
      },
    });
    h.ports.process.start = () => ({
      pid: -1,
      done: new Promise<ProcessResult>((resolve) => {
        finish = resolve;
      }),
    });
    const request = {
      ...req,
      timeoutMs: timing === 'deadline-race' ? 50 : req.timeoutMs,
      agent: 'explore',
      readOnlyVerified: true,
    };
    const pending = runDelegate(opencode, request, 'cli', h.ports);
    await flush();
    if (timing === 'deadline-race') {
      h.clock.advance(request.timeoutMs);
      await flush();
    }
    finish(ok({ exit: null, stderrTail: 'spawn opencode ENOENT' }));
    const result = await pending;
    assert.equal(settleCalls, 0, timing);
    assert.equal(result.outcome.status === 'fail' && result.outcome.cls, 'not-found', timing);
    assert.equal(result.result?.lifecycleError, undefined, timing);
    assert.deepEqual(h.signals, [], timing);
  }
});

test('POSIX owned-group checks distinguish missing groups, permission failure and bounded escalation', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  t.mock.timers.enable();
  for (const scenario of ['gone', 'permission', 'term', 'kill', 'unconfirmed'] as const) {
    const signals: Array<string | number | undefined> = [];
    let terminated = false;
    let killed = false;
    const killMock = t.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
      assert.equal(pid, -50);
      signals.push(signal);
      if (scenario === 'permission') {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      }
      if (scenario === 'gone' || (scenario === 'term' && terminated) || (scenario === 'kill' && killed)) {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
      if (signal === 'SIGTERM') {
        terminated = true;
      }
      if (signal === 'SIGKILL') {
        killed = true;
      }
      return true;
    });
    try {
      const pending = nodeProcess.settleGroup!(50, 1000);
      t.mock.timers.tick(500);
      for (let i = 0; i < 4; i++) {
        await Promise.resolve();
      }
      t.mock.timers.tick(500);
      for (let i = 0; i < 4; i++) {
        await Promise.resolve();
      }
      assert.equal(await pending, !['permission', 'unconfirmed'].includes(scenario), scenario);
      assert.equal(signals.includes('SIGKILL'), ['kill', 'unconfirmed'].includes(scenario), scenario);
      if (scenario === 'permission') {
        assert.deepEqual(signals, [0], scenario);
      }
    } finally {
      killMock.mock.restore();
    }
  }
});

test('OpenCode lifecycle steps keep preparation, response and settlement separate and stay OpenCode-only', async () => {
  const text = JSON.stringify({
    type: 'text',
    timestamp: 0,
    sessionID: 'ses',
    part: { id: 'text-0', sessionID: 'ses', messageID: 'msg', type: 'text', text: 'controlled output' },
  });
  const run = async (scenario: 'ok' | 'timeout' | 'offline' | 'other-provider') => {
    const h = harness(posix);
    Object.assign(h.ports.process, { settleGroup: async () => scenario !== 'timeout' });
    h.ports.prepare = { fetchModels: async () => null, acquireGpuLock: async () => () => {} };
    const request = {
      ...req,
      agent: 'explore',
      readOnlyVerified: true,
      collectLifecycle: true,
      ...(scenario === 'offline' && { endpoint: 'http://127.0.0.1:9/v1' }),
    };
    const pending = runDelegate(scenario === 'other-provider' ? claude : opencode, request, 'cli', h.ports);
    await flush();
    if (scenario === 'offline') {
      return pending;
    }
    if (scenario === 'timeout') {
      h.clock.advance(req.timeoutMs);
    }
    h.finish(ok({ stdout: scenario === 'other-provider' ? '{}' : text }));
    return pending;
  };
  // Settlement is recorded inside the launch, so compare by step name rather than recording order.
  const steps = async (scenario: Parameters<typeof run>[0]) =>
    (await run(scenario)).invocations
      .flatMap((i) => i.lifecycleSteps ?? [])
      .sort((a, b) => a.step.localeCompare(b.step));
  assert.deepEqual(await steps('ok'), [
    { step: 'prepare', elapsedMs: 0, budgetMs: req.timeoutMs, outcome: 'ok' },
    { step: 'response', elapsedMs: 1, budgetMs: req.timeoutMs, outcome: 'ok' },
    { step: 'teardown', elapsedMs: 0, budgetMs: 1000, outcome: 'ok' },
  ]);
  const timeout = await steps('timeout');
  assert.deepEqual(
    timeout.map(({ step, outcome }) => [step, outcome]),
    [
      ['prepare', 'ok'],
      ['response', 'timeout'],
      ['teardown', 'unconfirmed'],
    ],
  );
  const offline = await run('offline');
  assert.deepEqual(
    offline.invocations.map((i) => [i.launched, i.lifecycleSteps?.map((s) => [s.step, s.outcome])]),
    [[false, [['prepare', 'failed']]]],
  );
  assert.deepEqual(await steps('other-provider'), [], 'other providers never record lifecycle steps');
});

test('step-phase silence budgets stop idle launches and reset on activity', async () => {
  {
    // silence between steps stops at 60 s
    const h = harness(posix);
    const spec = {
      ...makeNudgeSpec(null),
      stepEvent: (line: string) => (line === 'end' ? ('step-end' as const) : null),
    };
    const run = runDelegate(spec, { ...req, timeoutMs: 400_000 }, 'cli', h.ports);
    await flush();
    h.line('end');
    h.clock.advance(50_000);
    assert.deepEqual(h.signals, []);
    h.clock.advance(10_000);
    assert.deepEqual(h.signals, ['-50:SIGTERM']);
    h.finish(ok({ exit: null, signal: 'SIGTERM' }));
    await run;
  }
  for (const afterEnd of [false, true]) {
    // inside a step stops at 180 s, including after an unknown line
    const h = harness(posix);
    const spec = {
      ...makeNudgeSpec(null),
      stepEvent: (line: string) => (line === 'end' ? ('step-end' as const) : null),
    };
    const run = runDelegate(spec, { ...req, timeoutMs: 400_000 }, 'cli', h.ports);
    await flush();
    if (afterEnd) {
      h.line('end');
      h.line('unknown');
    }
    h.clock.advance(170_000);
    assert.deepEqual(h.signals, []);
    h.clock.advance(10_000);
    assert.deepEqual(h.signals, ['-50:SIGTERM']);
    h.finish(ok({ exit: null, signal: 'SIGTERM' }));
    await run;
  }
  {
    // stderr activity resets silence without changing the phase
    const h = harness(posix);
    const spec = {
      ...makeNudgeSpec(null),
      stepEvent: (line: string) => (line === 'end' ? ('step-end' as const) : null),
    };
    const run = runDelegate(spec, { ...req, timeoutMs: 400_000 }, 'cli', h.ports);
    await flush();
    h.line('end');
    h.clock.advance(50_000);
    h.activity();
    h.clock.advance(50_000);
    assert.deepEqual(h.signals, []);
    h.clock.advance(10_000);
    assert.deepEqual(h.signals, ['-50:SIGTERM']);
    h.finish(ok({ exit: null, signal: 'SIGTERM' }));
    await run;
  }
  {
    // a resumed launch starts inside a step
    const h = harness(posix);
    let sessions = 0;
    const spec = {
      ...makeNudgeSpec('sess1'),
      attemptSession: () => (++sessions === 1 ? 'sess1' : null),
      stepEvent: (line: string) => (line === 'end' ? ('step-end' as const) : null),
    };
    const run = runDelegate(spec, { ...req, timeoutMs: 400_000 }, 'cli', h.ports);
    await flush();
    h.line('end');
    h.clock.advance(60_000);
    h.finish(ok({ exit: null, signal: 'SIGTERM', stdout: 'partial' }));
    await flush();
    await flush();
    h.clock.advance(170_000);
    assert.equal(h.signals.length, 1);
    h.finish(ok({ stdout: 'FINAL answer' }));
    await run;
  }
  {
    // a parseable over-long line fragment returns the phase inside a step
    const h = harness(posix);
    const spec = { ...makeNudgeSpec(null), stepEvent: opencode.stepEvent };
    const run = runDelegate(spec, { ...req, timeoutMs: 400_000 }, 'cli', h.ports);
    await flush();
    h.line('{"type":"step_finish"}');
    h.line('{"type":"step_finish"}', true);
    h.clock.advance(170_000);
    assert.deepEqual(h.signals, []);
    h.clock.advance(10_000);
    assert.deepEqual(h.signals, ['-50:SIGTERM']);
    h.finish(ok({ exit: null, signal: 'SIGTERM' }));
    await run;
  }
});
