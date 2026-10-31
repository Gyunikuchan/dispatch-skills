import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveEffectiveOpencodeLaunch } from '../../../skills/dispatch/scripts/providers/opencode-runtime.ts';
import { opencode, prepareOpencode, PROXY_TRAP } from '../../../skills/dispatch/scripts/providers/opencode.ts';
import { runDelegate, type RunnerPorts } from '../../../skills/dispatch/scripts/providers/runner.ts';
import type { DelegateRequest, LaunchRequest, Launch, ProcessResult } from '../../../skills/dispatch/scripts/providers/types.ts';

const platform = { os: 'darwin', arch: 'arm64', wsl: false, bubblewrap: false, argvLimit: 100000, home: '/h', path: [], pathExt: [] } as const;
const base: DelegateRequest = {
  promptPath: '/p.md', model: 'lmstudio/qwen', effort: 'high', sandbox: false, schemaPath: null, resume: null, cwd: '/repo', timeoutMs: 1000,
  agent: 'explore', readOnlyVerified: true, outputCapBytes: 1000, attachments: [], logPath: '/log', briefPath: '/brief',
};
const launchReq = (over: Partial<LaunchRequest> = {}): LaunchRequest => ({ ...base, binary: 'opencode', prompt: 'P', briefFile: null, schemaText: null, platform, ...over });

test('opencode argv is v2-only: run --auto, -m model#effort, -- prompt; never --pure or --variant', () => {
  const argv = opencode.argv(launchReq({ agent: 'plan' }), 'cli').argv;
  assert.deepEqual(argv, ['opencode', '--standalone', 'run', '--auto', '--agent', 'plan', '-m', 'lmstudio/qwen#high', '--', 'P']);
  assert.ok(!argv.includes('--pure') && !argv.includes('--variant'));
  assert.deepEqual(opencode.argv(launchReq({ effort: null }), 'cli').argv.slice(-3), ['lmstudio/qwen', '--', 'P']);
});

test('OpenCode delegates use private servers in every mode', async () => {
  for (const mode of ['cli', 'desktop', 'vscode'] as const) {
    const argv = opencode.argv(launchReq({ agent: 'plan' }), mode).argv;
    assert.deepEqual(argv.slice(0, 3), ['opencode', '--standalone', 'run'], mode);
    assert.ok(argv.includes('--auto') && argv.includes('--agent') && argv.includes('plan'));
  }

  const bubblewrapped = opencode.argv(launchReq({
    sandbox: true,
    platform: { ...platform, os: 'linux', bubblewrap: true },
  }), 'cli').argv;
  const binaryIndex = bubblewrapped.indexOf('opencode');
  assert.deepEqual(bubblewrapped.slice(binaryIndex, binaryIndex + 3), ['opencode', '--standalone', 'run']);

  const retryPorts = ports([result('', 1, 'Variant unavailable'), result('R')]);
  const retry = await runDelegate(opencode, base, 'cli', retryPorts);
  assert.equal(retry.outcome.status, 'ok');
  assert.deepEqual(retryPorts.launches.map((launch) => launch.argv.slice(0, 3)), [
    ['opencode', '--standalone', 'run'],
    ['opencode', '--standalone', 'run'],
  ]);

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
  const outcome = opencode.parse(result('', 1, 'Error: Variant unavailable for model'), launchReq());
  assert.equal(outcome.status === 'fail' && outcome.cls, 'config');
  assert.match(outcome.status === 'fail' ? outcome.detail : '', /effort variant "high" unavailable/);

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

test('a missing subscription classifies as auth, not empty-output', () => {
  for (const stderr of [
    'Error: No active subscription for this model',
    'HTTP 402 Payment Required: insufficient credit balance; no active subscription',
  ]) {
    const outcome = opencode.parse(result('', 1, stderr), launchReq());
    assert.equal(outcome.status, 'fail');
    assert.equal(outcome.status === 'fail' && outcome.cls, 'auth');
  }
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

test('an offline local server fails as model-not-loaded', async () => {
  const offline = await prepareOpencode(launchReq({ endpoint: 'http://localhost:1234/v1' }), { fetchModels: async () => null, acquireGpuLock: async () => () => {} });
  assert.equal(offline.kind === 'fail' && offline.outcome.cls, 'model-not-loaded');
});

test('a remote endpoint skips model preflight, GPU locking, and the proxy trap', async () => {
  let touched = false;
  const remote = await prepareOpencode(launchReq({ endpoint: 'https://api.example.com/v1' }), {
    fetchModels: async () => { touched = true; return []; }, acquireGpuLock: async () => { touched = true; return () => {}; },
  });
  assert.equal(touched, false);
  assert.deepEqual(remote.kind === 'launch' ? remote.env : null, {});
});


test('effective config merges selected model endpoint and verifies agent denial', async () => {
  const inspect = async (command: 'config' | 'agents') => command === 'config' ? [{ type: 'document', info: { model: 'remote/model', providers: { local: { settings: { baseURL: 'http://localhost:1234/v1' } } } } }, { type: 'document', info: { providers: { local: { settings: { baseURL: 'http://127.0.0.1:1234/v1' } } } } }] : [{ id: 'plan', permissions: [{ action: '*', resource: '*', effect: 'allow' }, { action: 'edit', resource: '*', effect: 'ask' }] }, { id: 'explore', permissions: [{ action: '*', resource: '*', effect: 'deny' }, { action: 'read', resource: '*', effect: 'allow' }] }];
  const resolved = await resolveEffectiveOpencodeLaunch({ ...base, agent: null, model: 'local/qwen' }, inspect);
  assert.equal(resolved.endpoint, 'http://127.0.0.1:1234/v1'); assert.equal(resolved.agent, 'explore'); assert.equal(resolved.readOnlyVerified, true);
  await assert.rejects(resolveEffectiveOpencodeLaunch(base, async (command) => command === 'config' ? [] : [{ id: 'plan', permissions: [{ action: '*', resource: '*', effect: 'allow' }] }]), /read-only-agent-unavailable/);
  const denied = await prepareOpencode(launchReq({ agent: null }), { fetchModels: async () => [], acquireGpuLock: async () => () => {} }); assert.equal(denied.kind, 'fail');
});

test('opencode accepts an unverified built-in explore agent as best-effort read-only, never another agent', async () => {
  const agents = [{ id: 'explore', permissions: [{ action: '*', resource: '*', effect: 'deny' }, { action: 'shell', resource: '*', effect: 'allow' }] }, { id: 'build', permissions: [{ action: '*', resource: '*', effect: 'allow' }] }];
  const inspect = async (command: 'config' | 'agents') => command === 'config' ? [] : agents;
  const resolved = await resolveEffectiveOpencodeLaunch({ ...base, agent: null }, inspect);
  assert.equal(resolved.agent, 'explore'); assert.equal(resolved.readOnlyVerified, false); assert.equal(resolved.readOnlyBestEffort, true);
  assert.equal((await prepareOpencode(launchReq({ readOnlyVerified: false, readOnlyBestEffort: true }), { fetchModels: async () => [], acquireGpuLock: async () => () => {} })).kind, 'launch');
  await assert.rejects(resolveEffectiveOpencodeLaunch({ ...base, agent: 'build' }, inspect), /read-only-agent-unavailable/);
});


test('unsupported standalone parser variants fail config without effort retry or shared fallback', async () => {
  // Installed v2.2.5 reports "Unrecognized flag: --dispatch-unsupported-inspection-probe in command opencode debug config".
  // Substitution of --standalone is an inference; option/argument forms are synthetic compatibility cases.
  for (const diagnostic of ['error: unrecognized option \'--standalone\'', 'Unrecognized flag: --standalone in command opencode debug config', "error: unknown option '--standalone'", 'Unknown argument: standalone', 'Unknown arguments: standalone']) {
    const parsed = opencode.parse(result('', 2, diagnostic),launchReq());
    assert.equal(parsed.status==='fail'&&parsed.cls,'config',diagnostic);
    assert.equal(parsed.status==='fail'&&parsed.retryWithoutEffort,undefined);
    const p=ports([result('',2,diagnostic)]);
    const run=await runDelegate(opencode,base,'cli',p);
    assert.equal(run.outcome.status==='fail'&&run.outcome.cls,'config');
    assert.equal(p.launches.length,1);
    assert.ok(p.launches.every(launch=>launch.argv.includes('--standalone')));
  }
});
