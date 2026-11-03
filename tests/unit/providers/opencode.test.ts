import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveEffectiveOpencodeLaunch } from '../../../skills/dispatch/scripts/providers/opencode-runtime.ts';
import { opencode, prepareOpencode, PROXY_TRAP } from '../../../skills/dispatch/scripts/providers/opencode.ts';
import { runDelegate, type RunnerPorts } from '../../../skills/dispatch/scripts/providers/runner.ts';
import { parseReport } from '../../../skills/dispatch/scripts/toolkit/domain/report.ts';
import type { DelegateRequest, LaunchRequest, Launch, ProcessResult } from '../../../skills/dispatch/scripts/providers/types.ts';

const platform = { os: 'darwin', arch: 'arm64', wsl: false, bubblewrap: false, argvLimit: 100000, home: '/h', path: [], pathExt: [] } as const;
const base: DelegateRequest = {
  promptPath: '/p.md', model: 'lmstudio/qwen', effort: 'high', sandbox: false, schemaPath: null, resume: null, cwd: '/repo', timeoutMs: 1000,
  agent: 'explore', readOnlyVerified: true, outputCapBytes: 1000, attachments: [], logPath: '/log', briefPath: '/brief',
};
const launchReq = (over: Partial<LaunchRequest> = {}): LaunchRequest => ({ ...base, binary: 'opencode', prompt: 'P', briefFile: null, schemaText: null, platform, ...over });

test('opencode argv is v2-only: run --auto --format json, -m model#effort, -- prompt; never --pure or --variant', () => {
  for (const mode of ['cli', 'desktop', 'vscode'] as const) {
    const argv = opencode.argv(launchReq({ agent: 'plan' }), mode).argv;
    assert.deepEqual(argv, ['opencode', '--standalone', 'run', '--auto', '--format', 'json', '--agent', 'plan', '-m', 'lmstudio/qwen#high', '--', 'P'], mode);
    assert.ok(!argv.includes('--pure') && !argv.includes('--variant'), mode);
  }
  assert.deepEqual(opencode.argv(launchReq({ effort: null }), 'cli').argv.slice(-3), ['lmstudio/qwen', '--', 'P']);
  assert.equal(opencode.outputCapBytes, 64 * 1024 * 1024);
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
});

function ports(results: ProcessResult[], prepare?: RunnerPorts['prepare']): RunnerPorts & { launches: Launch[] } {
  const launches: Launch[] = [];
  const p: RunnerPorts & { launches: Launch[] } = {
    launches,
    process: { start: (launch) => { launches.push(launch); return { pid: 1, done: Promise.resolve(results.shift() ?? results[0]!) }; }, signal: () => {} },
    clock: { now: () => 0, every: () => () => {} },
    fs: { readText: () => 'body', writeText: () => {}, realpath: (f) => f, readdir: () => [], size: () => null, readPrefix: () => '' },
    env: { HTTP_PROXY: 'http://corp:8080', OPENAI_API_KEY: 'sk-x' }, platform, binary: 'opencode', nonce: () => 'n',
  };
  if (prepare) p.prepare = prepare;
  return p;
}
const result = (stdout: string, exit = 0, stderrTail = ''): ProcessResult => ({ exit, signal: null, stdout, stdoutPath: '/log', stderrTail, durationMs: 1, timedOut: false, truncated: false });
const event = (type: string, part: Record<string, unknown>) => JSON.stringify({ type, timestamp: 0, sessionID: 'ses', part });
const jsonText = (text: string) => event('text', { id: 'text-0', sessionID: 'ses', messageID: 'msg', type: 'text', text });
const jsonStep = (tokens: Record<string, unknown> = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }) =>
  event('step_finish', { id: 'step-finish-0', sessionID: 'ses', messageID: 'msg', type: 'step-finish', reason: 'stop', cost: 0, tokens });
const jsonError = (message: string) => JSON.stringify({ type: 'error', timestamp: 0, sessionID: 'ses', error: { name: 'ProviderError', message } });

test('`Variant unavailable` retries once without effort', async () => {
  const outcome = opencode.parse(result('', 1, 'Error: Variant unavailable for model'), launchReq());
  assert.equal(outcome.status === 'fail' && outcome.cls, 'config');
  assert.match(outcome.status === 'fail' ? outcome.detail : '', /effort variant "high" unavailable/);

  const p = ports([result('', 1, 'Error: Variant unavailable for model'), result(jsonText('R'))]);
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
  const p = ports([result(jsonText('R'))], prepare);
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

test('opencode json text extraction', () => {
  const stream = [jsonText('Hello '), jsonText('world'), jsonStep({ input: 12, output: 3, reasoning: 1, cache: { read: 4, write: 0 } })].join('\n');
  assert.deepEqual(opencode.parse(result(stream), launchReq()), {
    status: 'ok', text: 'Hello world', sessionId: null, resume: 'opencode:lmstudio/qwen',
  });
});

test('opencode narration parses when the report starts its own line', () => {
  const stream = [jsonText("I'll read the plan.\n"), jsonText('{"status":"CLEAN","findings":[]}')].join('\n');
  const outcome = opencode.parse(result(stream), launchReq());
  assert.equal(outcome.status, 'ok');
  assert.equal(parseReport({kind: 'plan', source: 'claude[0]', text: outcome.status === 'ok' ? outcome.text : ''}).ok, true);

  const gluedStream = [jsonText("I'll read the plan."), jsonText('{"status":"CLEAN","findings":[]}')].join('\n');
  const gluedOutcome = opencode.parse(result(gluedStream), launchReq());
  assert.equal(gluedOutcome.status, 'ok');
  assert.equal(parseReport({kind: 'plan', source: 'claude[0]', text: gluedOutcome.status === 'ok' ? gluedOutcome.text : ''}).ok, false);

  const splitStream = [jsonText('{"status":"CLE'), jsonText('AN","findings":[]}')].join('\n');
  const splitOutcome = opencode.parse(result(splitStream), launchReq());
  assert.equal(splitOutcome.status, 'ok');
  const splitParsed = parseReport({kind: 'plan', source: 'claude[0]', text: splitOutcome.status === 'ok' ? splitOutcome.text : ''});
  assert.equal(splitParsed.ok, true);
  assert.equal(splitParsed.ok && splitParsed.status, 'CLEAN');
});

test('opencode nonzero exit keeps stderr class', () => {
  const outcome = opencode.parse(result(jsonText('partial answer'), 1, 'rate limit exceeded'), launchReq());
  assert.equal(outcome.status === 'fail' && outcome.cls, 'quota');

  const errorEventOutcome = opencode.parse(result(jsonError('rate limit exceeded: usage limit reached'), 0), launchReq());
  assert.equal(errorEventOutcome.status === 'fail' && errorEventOutcome.cls, 'quota');
  assert.match(errorEventOutcome.status === 'fail' ? errorEventOutcome.detail : '', /usage limit reached/);

  const tool = event('tool_use', {
    id: 'tool-0', sessionID: 'ses', messageID: 'msg', type: 'tool',
    state: { status: 'error', input: {}, error: 'rate limit exceeded', metadata: {}, content: [{ type: 'text', text: 'rate limit exceeded' }] },
  });
  const toolOutcome = opencode.parse(result(tool, 2), launchReq());
  assert.equal(toolOutcome.status === 'fail' && toolOutcome.cls, 'empty-output');
});

test('opencode error after text fails', () => {
  const outcome = opencode.parse(result([jsonText('answer'), jsonError('provider response ended unexpectedly')].join('\n')), launchReq());
  assert.equal(outcome.status, 'fail');
  assert.match(outcome.status === 'fail' ? outcome.detail : '', /provider response ended unexpectedly/);
});

test('opencode large tool events keep usage', () => {
  const tool = event('tool_use', {
    id: 'tool-0', sessionID: 'ses', messageID: 'msg', type: 'tool', tool: 'read',
    state: { status: 'completed', input: { path: 'big.txt' }, output: 'x'.repeat(400_000), metadata: {}, content: [] },
  });
  const stream = [tool, jsonText('done'), jsonStep({ input: 10, output: 2, reasoning: 0, cache: { read: 5, write: 1 } })].join('\n');
  assert.equal(opencode.parse(result(stream), launchReq()).status, 'ok');
  assert.deepEqual(opencode.usage?.(stream), {
    input: 10, output: 2, reasoning: 0, cacheRead: 5, cacheWrite: 1,
    scope: 'invocation', provenance: 'opencode.step.finish', inputSemantics: 'uncached',
  });
});
