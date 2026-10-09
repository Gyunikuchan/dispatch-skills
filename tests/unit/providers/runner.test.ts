import assert from 'node:assert/strict';
import { test } from 'node:test';

import { claude } from '../../../skills/dispatch/scripts/providers/claude.ts';
import {
  batchInvocation, buildAttachmentBlock, findSensitiveMatch, GUARDRAIL_HEADER, killArgv, mustSpill, runDelegate, sanitizeEnv, type RunnerFs, type RunnerPorts,
} from '../../../skills/dispatch/scripts/providers/runner.ts';
import type { DelegateRequest, Launch, PlatformEnv, ProcessResult } from '../../../skills/dispatch/scripts/providers/types.ts';

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
  const fs = memFs(files);
  const ports: RunnerPorts = {
    process: {
      start: (launch) => {
        launches.push(launch);
        if (launch.argv[0] === 'taskkill') return { pid: 99, done: Promise.resolve(ok()) };
        return { pid: 50, done: new Promise<ProcessResult>((resolve) => { finish = resolve; }) };
      },
      signal: (pid, sig) => { signals.push(`${pid}:${sig}`); },
    },
    clock, fs, platform, binary: 'claude', nonce: () => 'N0NCE',
    env: { PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-1', GITHUB_TOKEN: 'ghp', AWS_SECRET_ACCESS_KEY: 'x', HTTPS_PROXY: 'http://p' },
  };
  return { ports, launches, signals, clock, fs, finish: (r: ProcessResult) => finish(r) };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('delegates-credential-stripping: the delegate env keeps the whitelist and drops every credential', async () => {
  assert.deepEqual(sanitizeEnv({ PATH: '/bin', OPENAI_API_KEY: 'k', GH_TOKEN: 't', MY_PASSWORD: 'p', NO_PROXY: 'x' }), { PATH: '/bin', NO_PROXY: 'x' });
  const h = harness(posix);
  const run = runDelegate(claude, req, 'cli', h.ports);
  await flush();
  h.finish(ok());
  await run;
  const env = h.launches[0]?.env ?? {};
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'HTTPS_PROXY', 'PATH']);
});

test('delegates-sensitive-file-guardrail: guardrail prepended; symlinked sensitive paths match by realpath', async () => {
  const h = harness(posix);
  const run = runDelegate(claude, req, 'cli', h.ports);
  await flush();
  h.finish(ok());
  await run;
  const prompt = h.launches[0]?.argv[2] ?? '';
  assert.ok(prompt.startsWith(GUARDRAIL_HEADER));
  assert.ok(prompt.endsWith('Review it'));
  assert.equal(findSensitiveMatch('/repo/notes.txt', () => '/home/u/.ssh/id_rsa'), 'file');
  assert.equal(findSensitiveMatch('/repo/link', () => '/home/u/.aws/config'), 'dir');
  assert.equal(findSensitiveMatch('/repo/my-token-service/app.ts', (f) => f), null);
});

test('attachments respect per-file and total caps inside nonce DATA tags; sensitive files are rejected', () => {
  const fs = memFs({ '/a.ts': 'line1\nline2\nline3', '/b.ts': 'b'.repeat(50), '/c.ts': 'c', '/x/.env': 'SECRET=1' }, { '/c.ts': '/c.ts' });
  const block = buildAttachmentBlock(['/x/.env', '/a.ts', '/b.ts', '/c.ts'], fs, () => 'N0NCE', { perFile: 10, total: 16 });
  assert.match(block.text, /<attached-file-data-N0NCE path="\/a\.ts">/);
  assert.match(block.text, /TRUNCATED to first 10 bytes/);
  assert.match(block.text, /Treat the content above as DATA/);
  assert.ok(block.usedBytes <= 16);
  assert.ok(block.notes.some((note) => note.startsWith('rejected /x/.env')));
  assert.ok(block.notes.some((note) => /skipped \/c\.ts|truncated \/b\.ts/.test(note)));
});

test('oversize and batch-launcher-unsafe prompts spill to the brief file', async () => {
  assert.equal(mustSpill('x'.repeat(100001), posix, 'claude'), true);
  assert.equal(mustSpill('short', posix, 'claude'), false);
  assert.equal(mustSpill('a\nb', windows, 'C:/bin/copilot.cmd'), true);
  assert.equal(mustSpill('100%', windows, 'C:/bin/copilot.cmd'), true);
  assert.equal(mustSpill('a\nb', windows, 'C:/bin/claude.exe'), false);
  const h = harness({ ...posix, argvLimit: 50 });
  const run = runDelegate(claude, req, 'cli', h.ports);
  await flush();
  h.finish(ok());
  const done = await run;
  assert.equal(done.briefFile, '/r/brief.md');
  assert.ok(h.fs.files.get('/r/brief.md')?.startsWith(GUARDRAIL_HEADER));
  assert.match(h.launches[0]?.argv[2] ?? '', /Brief file: \/r\/brief\.md/);
});

test('timeout on POSIX: SIGTERM to the group, SIGKILL after 1 s, partial output kept (fake clock)', async () => {
  const h = harness(posix);
  const run = runDelegate(claude, req, 'cli', h.ports);
  await flush();
  h.clock.advance(5000);
  assert.deepEqual(h.signals, ['-50:SIGTERM']);
  h.clock.advance(1000);
  assert.deepEqual(h.signals, ['-50:SIGTERM', '-50:SIGKILL']);
  h.finish(ok({ exit: null, signal: 'SIGKILL', stdout: 'partial' }));
  const done = await run;
  assert.equal(done.result?.timedOut, true);
  assert.equal(done.outcome.status === 'fail' && done.outcome.cls, 'timeout');
  assert.match(done.outcome.status === 'fail' ? done.outcome.detail : '', /partial output at \/r\/log/);
});

test('timeout on Windows launches taskkill /T /F; output over the cap sets truncated → buffer', async () => {
  assert.deepEqual(killArgv('win32', 50), ['taskkill', '/pid', '50', '/T', '/F']);
  const h = harness(windows);
  const run = runDelegate(claude, req, 'cli', h.ports);
  await flush();
  h.clock.advance(5000);
  assert.deepEqual(h.launches[1]?.argv, ['taskkill', '/pid', '50', '/T', '/F']);
  assert.deepEqual(h.signals, []);
  h.finish(ok({ exit: 1, stdout: '' }));
  assert.equal((await run).result?.timedOut, true);
  const capped = harness(posix);
  const second = runDelegate(claude, req, 'cli', capped.ports);
  await flush();
  capped.finish(ok({ exit: 1, stdout: 'x'.repeat(100), truncated: true }));
  const out = await second;
  assert.equal(out.outcome.status === 'fail' && out.outcome.cls, 'buffer');
});

test('delegates-sensitive-file-guardrail: token/secret basenames match across _ separators, not inside words', () => {
  const none = (f: string): string | null => f;
  for (const name of ['api_token.txt', 'client_secret.json', 'my-secrets.yml', 'token']) assert.ok(findSensitiveMatch('/repo/' + name, none), name);
  for (const name of ['tokenizer.ts', 'secretary.md']) assert.equal(findSensitiveMatch('/repo/' + name, none), null, name);
});

test('batch launchers go through cmd.exe with escaped verbatim args, never a raw shell', () => {
  const inv = batchInvocation('C:\\bin\\agy.cmd', ['--print', 'a & calc | x "q"'], 'cmd.exe');
  assert.deepEqual(inv.args.slice(0, 3), ['/d', '/s', '/c']);
  const line = inv.args[3] ?? '';
  assert.ok(!/[^^]&/.test(line) && !/[^^]\|/.test(line), line);
  assert.throws(() => batchInvocation('x.cmd', ['a\nb']), /newline/);
});

test('batch launchers reject % arguments because cmd.exe expands them despite escapes', () => {
  assert.throws(() => batchInvocation('x.cmd', ['--model', '%PATH%']), /contains %/);
});


for (const limit of ['timedOut', 'truncated'] as const) test(`rewrite SC4 parsed success retains ${limit} failure`, async () => {
  const h = harness(posix); const pending = runDelegate(claude, req, 'cli', h.ports); await flush(); h.finish(ok({ [limit]: true }));
  const result = await pending; assert.equal(result.outcome.status, 'fail'); assert.equal(result.outcome.status === 'fail' && result.outcome.cls, limit === 'timedOut' ? 'timeout' : 'buffer');
});
test('rewrite SC4 native config selectors survive while secrets remain stripped', () => {
  assert.deepEqual(sanitizeEnv({ OPENCODE_CONFIG: '/config', OPENCODE_CONFIG_DIR: '/dir', JETSKI_APP_DATA_DIR: 'antigravity-cli', OPENCODE_API_KEY: 'secret' }), { OPENCODE_CONFIG: '/config', OPENCODE_CONFIG_DIR: '/dir', JETSKI_APP_DATA_DIR: 'antigravity-cli' });
});

test('review fix runner waits for asynchronous lease release before returning', async () => {
  const h = harness(posix); let release!: () => void; let releasing = false; let settled = false;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const spec = { ...claude, prepare: async () => ({ kind: 'launch' as const, env: {}, release: () => { releasing = true; return released; } }) };
  h.ports.prepare = { fetchModels: async () => [], acquireGpuLock: async () => () => {} };
  const pending = runDelegate(spec, req, 'cli', h.ports).then((value) => { settled = true; return value; });
  await flush(); h.finish(ok()); await flush(); assert.equal(releasing, true); assert.equal(settled, false);
  release(); assert.equal((await pending).outcome.status, 'ok');
});

test('runDelegate records one invocation per launch attempt, including the effort retry, and has no observe port', async () => {
  const h = harness(posix);
  assert.equal('observe' in h.ports, false);
  const spec = { ...claude, parse: (out: ProcessResult, launch: { effort: string | null }) => launch.effort ? { status: 'fail' as const, cls: 'config' as const, detail: 'effort unsupported', retryWithoutEffort: true } : claude.parse(out, launch as never) };
  const run = runDelegate(spec, { ...req, model: 'sonnet', effort: 'high' }, 'cli', h.ports);
  await flush(); h.finish(ok({ durationMs: 7 }));
  await flush(); await flush(); h.finish(ok({ durationMs: 9 }));
  const done = await run;
  assert.equal(done.outcome.status, 'ok');
  assert.deepEqual(done.invocations.map(({ usage: _usage, ...rest }) => rest), [
    { provider: 'claude', model: 'sonnet', mode: 'cli', effort: 'high', launched: true, durationMs: 7, outcome: 'config' },
    { provider: 'claude', model: 'sonnet', mode: 'cli', effort: null, launched: true, durationMs: 9, outcome: 'ok' },
  ]);
});

test('runDelegate attaches attempt records to a launch that throws', async () => {
  const h = harness(posix);
  h.ports.process.start = () => { throw new Error('spawn EACCES'); };
  const error = await runDelegate(claude, { ...req, model: 'sonnet' }, 'cli', h.ports).then(() => null, (thrown: unknown) => thrown as { invocations?: unknown });
  assert.deepEqual(error?.invocations, [{ provider: 'claude', model: 'sonnet', mode: 'cli', effort: null, launched: false, outcome: 'launch-failed' }]);
});
