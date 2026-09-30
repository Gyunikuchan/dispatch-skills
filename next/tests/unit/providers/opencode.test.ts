import assert from 'node:assert/strict';
import { test } from 'node:test';

import { opencode, prepareOpencode, PROXY_TRAP } from '../../../skills/dispatch/scripts/providers/opencode.ts';
import { runDelegate, type RunnerPorts } from '../../../skills/dispatch/scripts/providers/runner.ts';
import type { DelegateRequest, LaunchRequest, Launch, ProcessResult } from '../../../skills/dispatch/scripts/providers/types.ts';

const platform = { os: 'darwin', arch: 'arm64', wsl: false, bubblewrap: false, argvLimit: 100000, home: '/h', path: [], pathExt: [] } as const;
const base: DelegateRequest = {
  promptPath: '/p.md', model: 'lmstudio/qwen', effort: 'high', sandbox: false, schemaPath: null, resume: null, cwd: '/repo', timeoutMs: 1000,
  outputCapBytes: 1000, attachments: [], logPath: '/log', briefPath: '/brief',
};
const launchReq = (over: Partial<LaunchRequest> = {}): LaunchRequest => ({ ...base, binary: 'opencode', prompt: 'P', briefFile: null, schemaText: null, platform, ...over });

test('opencode argv is v2-only: run --auto, -m model#effort, -- prompt; never --pure or --variant', () => {
  const argv = opencode.argv(launchReq({ agent: 'plan' }), 'cli').argv;
  assert.deepEqual(argv, ['opencode', 'run', '--auto', '--agent', 'plan', '-m', 'lmstudio/qwen#high', '--', 'P']);
  assert.ok(!argv.includes('--pure') && !argv.includes('--variant'));
  assert.deepEqual(opencode.argv(launchReq({ effort: null }), 'cli').argv.slice(-3), ['lmstudio/qwen', '--', 'P']);
});

function ports(results: ProcessResult[], prepare?: RunnerPorts['prepare']): RunnerPorts & { launches: Launch[] } {
  const launches: Launch[] = [];
  const p: RunnerPorts & { launches: Launch[] } = {
    launches,
    process: { start: (launch) => { launches.push(launch); return { pid: 1, done: Promise.resolve(results.shift() ?? results[0]!) }; }, signal: () => {} },
    clock: { now: () => 0, every: () => () => {} },
    fs: { readText: () => 'body', writeText: () => {}, realpath: (f) => f, size: () => null, readPrefix: () => '' },
    env: { HTTP_PROXY: 'http://corp:8080', OPENAI_API_KEY: 'sk-x' }, platform, binary: 'opencode', nonce: () => 'n',
  };
  if (prepare) p.prepare = prepare;
  return p;
}
const result = (stdout: string, exit = 0, stderrTail = ''): ProcessResult => ({ exit, signal: null, stdout, stdoutPath: '/log', stderrTail, durationMs: 1, timedOut: false, truncated: false });

test('`Variant unavailable` retries once without effort', async () => {
  const p = ports([result('', 1, 'Error: Variant unavailable for model'), result('R')]);
  const run = await runDelegate(opencode, base, 'cli', p);
  assert.equal(run.outcome.status, 'ok');
  assert.equal(run.attempts, 2);
  assert.ok(p.launches[0]?.argv.includes('lmstudio/qwen#high'));
  assert.ok(p.launches[1]?.argv.includes('lmstudio/qwen'));
  const twice = await runDelegate(opencode, base, 'cli', ports([result('', 1, 'Variant unavailable'), result('', 1, 'Variant unavailable')]));
  assert.equal(twice.attempts, 2);
  assert.equal(twice.outcome.status, 'fail');
});

test('local endpoint: /models preflight, GPU lock held for the launch, WAN proxy trap with the backend exempt', async () => {
  const events: string[] = [];
  const prepare = {
    fetchModels: async (endpoint: string) => { events.push(`models ${endpoint}`); return ['qwen']; },
    acquireGpuLock: async () => { events.push('lock'); return () => { events.push('release'); }; },
  };
  const p = ports([result('R')], prepare);
  const run = await runDelegate(opencode, { ...base, endpoint: 'http://127.0.0.1:1234/v1' }, 'cli', p);
  assert.equal(run.outcome.status, 'ok');
  assert.deepEqual(events, ['models http://127.0.0.1:1234/v1', 'lock', 'release']);
  const env = p.launches[0]?.env ?? {};
  assert.equal(env['HTTPS_PROXY'], PROXY_TRAP);
  assert.equal(env['HTTP_PROXY'], PROXY_TRAP);
  assert.match(env['NO_PROXY'] ?? '', /127\.0\.0\.1/);
  assert.equal(env['OPENAI_API_KEY'], undefined);
});

test('an offline local server is model-not-loaded without a launch; a remote endpoint skips preflight and trap', async () => {
  const offline = await prepareOpencode(launchReq({ endpoint: 'http://localhost:1234/v1' }), { fetchModels: async () => null, acquireGpuLock: async () => () => {} });
  assert.equal(offline.kind === 'fail' && offline.outcome.cls, 'model-not-loaded');
  let touched = false;
  const remote = await prepareOpencode(launchReq({ endpoint: 'https://api.example.com/v1' }), {
    fetchModels: async () => { touched = true; return []; }, acquireGpuLock: async () => { touched = true; return () => {}; },
  });
  assert.equal(touched, false);
  assert.deepEqual(remote.kind === 'launch' ? remote.env : null, {});
});
