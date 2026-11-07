import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SPECS } from '../../../skills/dispatch/scripts/providers/index.ts';
import { runDelegate, type RunnerPorts } from '../../../skills/dispatch/scripts/providers/runner.ts';
import type { Launch, LaunchRequest, ProcessResult, ProviderId, RunOutcome } from '../../../skills/dispatch/scripts/providers/types.ts';

const req: LaunchRequest = {
  promptPath: '/p', model: 'openai/gpt-5', effort: null, sandbox: false, schemaPath: null, resume: null, cwd: '/repo', timeoutMs: 1000, outputCapBytes: 1000,
  attachments: [], logPath: '/log', briefPath: '/brief', binary: 'bin', prompt: 'P', briefFile: null, schemaText: null,
  platform: { os: 'linux', arch: 'x64', wsl: false, bubblewrap: false, argvLimit: 100000, home: '/h', path: [], pathExt: [] },
};

const out = (stdout: string, exit: number | null = 0, stderrTail = ''): ProcessResult =>
  ({ exit, signal: null, stdout, stdoutPath: '/log', stderrTail, durationMs: 1, timedOut: false, truncated: false });

const opencodeText = (text: string): string => JSON.stringify({
  type: 'text', timestamp: 0, sessionID: 'ses',
  part: { id: 'text-0', sessionID: 'ses', messageID: 'msg', type: 'text', text },
});

const parse = (id: ProviderId, result: ProcessResult, over: Partial<LaunchRequest> = {}): RunOutcome => SPECS[id].parse(result, { ...req, ...over });
const cls = (outcome: RunOutcome): string => (outcome.status === 'fail' ? outcome.cls : 'ok');

const COPILOT_UNSUPPORTED_HOST_WARNING = 'Sandboxing is enabled but is not supported on this host, so shell commands and sandboxed services will fail. Update Windows — supported versions at https://aka.ms/ghcp-sandbox-os-support — or turn sandboxing off with /sandbox disable, or set sandbox.enabled to false in settings.json. See https://docs.github.com/en/copilot/concepts/about-cloud-and-local-sandboxes ';
// GitHub/Copilot CLI issue #4652 reports this v1.0.81 warning; both streams are covered because its stream is unspecified.
const COPILOT_INVALID_EFFORT = "error: invalid value 'invalid' for '--reasoning-effort <level>'\n  [possible values: none, minimal, low, medium, high, xhigh, max]\n\n  tip: a similar value exists: 'minimal'\n\nFor more information, try '--help'.\n";

function runnerPorts(...results: ProcessResult[]): RunnerPorts & { launches: Launch[] } {
  const launches: Launch[] = [];
  const pending = [...results];
  const ports: RunnerPorts = {
    process: { start(launch) { launches.push(launch); return { pid: 7, done: Promise.resolve(pending.shift() ?? out('', 1)) }; }, signal: () => {} },
    clock: { now: () => 0, every: () => () => {} },
    fs: { readText: () => 'P', writeText: () => {}, realpath: () => null, readdir: () => [], size: () => null, readPrefix: () => '' },
    env: {}, platform: req.platform, binary: 'copilot', nonce: () => 'n',
  };
  return Object.assign(ports, { launches });
}

test('delegates-resume-handles: recorded successes yield text, session id, and each provider’s resume handle', () => {
  assert.deepEqual(parse('claude', out('{"type":"result","result":"R","session_id":"abc123"}')),
    { status: 'ok', text: 'R', sessionId: 'abc123', resume: 'claude --resume abc123' });
  assert.deepEqual(parse('agy', out('{"conversationId":"c-1","response":"R"}')), { status: 'ok', text: 'R', sessionId: 'c-1', resume: 'conversation://c-1' });
  assert.deepEqual(parse('copilot', out('R\n\nTo resume: copilot --resume 0123456789abcdef')),
    { status: 'ok', text: 'R\n\nTo resume: copilot --resume 0123456789abcdef', sessionId: '0123456789abcdef', resume: 'copilot --resume 0123456789abcdef' });
  const codexStream = ['{"type":"thread.started","thread_id":"t-9"}', '{"type":"item.completed","item":{"type":"reasoning","text":"x"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"R"}}'].join('\n');
  assert.deepEqual(parse('codex', out(codexStream)), { status: 'ok', text: 'R', sessionId: 't-9', resume: 'codex exec resume t-9' });
  assert.deepEqual(parse('opencode', out(opencodeText('R'))), { status: 'ok', text: 'R', sessionId: 'ses', resume: 'opencode:openai/gpt-5' });
  const local = parse('opencode', out(opencodeText('R')), { endpoint: 'http://127.0.0.1:1234/v1' });
  assert.equal(local.status === 'ok' ? local.resume : null, 'http://127.0.0.1:1234/v1');
});

test('recorded failures map to the ported failure classes', () => {
  assert.equal(cls(parse('claude', out('{"is_error":true,"result":"x","api_error_status":404}', 1))), 'model-not-found');
  assert.equal(cls(parse('claude', out('', 1, 'claude_code_version_too_old'))), 'cli-outdated');
  assert.equal(cls(parse('claude', out('', 0))), 'empty-output');
  assert.equal(cls(parse('agy', out('', 1, 'Error: not signed in'))), 'auth');
  assert.equal(cls(parse('agy', out('', 1, 'rate limit exceeded'))), 'quota');
  assert.equal(cls(parse('agy', out('', 1, 'segfault'))), 'not-found');
  assert.equal(cls(parse('copilot', out('', 1, 'Error: no authentication information found'))), 'auth');
  assert.equal(cls(parse('copilot', out('', 1, '429 Too Many Requests'))), 'quota');
  // A review quoting auth words on success is not a failure.
  assert.equal(cls(parse('copilot', out('Consider rotating the OAuth token'))), 'ok');
  assert.equal(cls(parse('codex', out('{"type":"turn.failed","error":{"message":"context_length_exceeded"}}', 1))), 'context-overflow');
  assert.equal(cls(parse('codex', out('', 1, 'sandbox initialization failed'))), 'sandbox-unsupported');
  assert.equal(cls(parse('opencode', out('', 1, 'SERVER_OFFLINE'))), 'model-not-loaded');
});

test('mode-cascade classes are declared per provider: agy token/subscription/execution, copilot quota not auth', () => {
  assert.deepEqual([...SPECS.agy.modeCascadeOn].sort(), ['auth', 'not-found', 'quota']);
  assert.deepEqual(SPECS.copilot.modeCascadeOn, ['quota']);
  assert.ok(!SPECS.copilot.modeCascadeOn.includes('auth'));
  assert.deepEqual([SPECS.claude.modeCascadeOn, SPECS.codex.modeCascadeOn, SPECS.opencode.modeCascadeOn], [[], [], []]);
});

test('copilot usage unavailable coverage', async () => {
  const run = await runDelegate(SPECS.copilot, { ...req, collectUsage: true }, 'cli', runnerPorts(out('A response')));
  assert.equal(run.outcome.status, 'ok');
  assert.equal(run.invocations.length, 1);
  assert.equal(run.invocations[0]?.usage, undefined);
  assert.equal(run.invocations[0]?.coverage, 'no usage output');
});

test('copilot unsupported sandbox host startup warning fails closed in the runner', async () => {
  for (const result of [out('A response', 0, COPILOT_UNSUPPORTED_HOST_WARNING), out(COPILOT_UNSUPPORTED_HOST_WARNING + '\r\nA response')]) {
    const run = await runDelegate(SPECS.copilot, { ...req, sandbox: true, effort: null }, 'cli', runnerPorts(result));
    assert.equal(cls(run.outcome), 'sandbox-unsupported');
  }
});

test('copilot successful response may discuss an unavailable sandbox', () => {
  const prose = 'The sandbox is unavailable for this host, so I will describe the safe next step.';
  for (const response of [prose, 'The CLI reports this warning:\n' + COPILOT_UNSUPPORTED_HOST_WARNING + '\nThis is quoted diagnostic evidence.']) {
    const result = parse('copilot', out(response));
    assert.equal(cls(result), 'ok');
    assert.equal(result.status === 'ok' ? result.text : '', response);
  }
});

test('copilot retries an effort rejection once without the effort flag', async () => {
  for (const diagnostic of [COPILOT_INVALID_EFFORT, COPILOT_INVALID_EFFORT.replaceAll('\n', '\r\n'), 'Error: Model \"auto\" does not support reasoning effort configuration (requested: \"low\").\r\n']) {
    const ports = runnerPorts(out('', 1, diagnostic), out('ok'));
    const run = await runDelegate(SPECS.copilot, { ...req, effort: 'high' }, 'cli', ports);
    assert.equal(cls(run.outcome), 'ok');
    assert.equal(run.attempts, 2);
    assert.equal(ports.launches.length, 2);
    assert.ok(ports.launches[0]?.argv.includes('--reasoning-effort'));
    assert.ok(ports.launches[0]?.argv.includes('high'));
    assert.ok(!ports.launches[1]?.argv.includes('--reasoning-effort'));
  }
});

test('copilot effort rejection yields to sandbox and auth errors', () => {
  const sandbox = parse('copilot', out('', 1, COPILOT_UNSUPPORTED_HOST_WARNING + '\n' + COPILOT_INVALID_EFFORT), { sandbox: true, effort: 'high' });
  assert.equal(cls(sandbox), 'sandbox-unsupported');
  assert.equal(sandbox.status === 'fail' ? sandbox.retryWithoutEffort : undefined, undefined);
  const auth = parse('copilot', out('', 1, 'not authenticated\n' + COPILOT_INVALID_EFFORT), { effort: 'high' });
  assert.equal(cls(auth), 'auth');
  assert.equal(auth.status === 'fail' ? auth.retryWithoutEffort : undefined, undefined);
});

const attempt = (id: ProviderId, result: ProcessResult, over: Partial<LaunchRequest> = {}): string | null =>
  SPECS[id].attemptSession!(result, { ...req, ...over });

const codexStream = (threadId: string | null): string =>
  [`{"type":"thread.started"${threadId === null ? '' : `,"thread_id":"${threadId}"`}}`,
    '{"type":"item.completed","item":{"type":"agent_message","text":"R"}}'].join('\n');

const opencodeEvent = (sessionID: string, text: string): string => JSON.stringify({
  type: 'text', timestamp: 0, sessionID,
  part: { id: 'text-0', sessionID, messageID: 'msg', type: 'text', text },
});

test('attempt session: codex returns thread id and builds resume argv', () => {
  assert.equal(attempt('codex', out(codexStream('t-9'))), 't-9');
  assert.equal(attempt('codex', out('')), null);
  assert.equal(attempt('codex', out(codexStream('../evil'))), null);
  const argv = SPECS.codex.argv({ ...req, sandbox: true, resume: 't-9', prompt: 'C' }, 'cli').argv;
  assert.ok(argv.includes('resume') && argv.includes('t-9'));
  assert.ok(argv.includes('--json') && argv.includes('--skip-git-repo-check'));
});

test('attempt session: opencode returns last sessionID', () => {
  assert.equal(attempt('opencode', out([opencodeEvent('ses_first', 'a'), opencodeEvent('ses_last', 'b')].join('\n'))), 'ses_last');
  assert.equal(attempt('opencode', out('')), null);
  assert.equal(attempt('opencode', out([opencodeEvent('../evil', 'x')].join('\n'))), null);
});

test('attempt session: copilot prefers resume, extracts id, presets only after idle output', () => {
  assert.equal(attempt('copilot', out(''), { resume: 'preset-id-1' }), 'preset-id-1');
  assert.equal(attempt('copilot', out('R\n\nTo resume: copilot --resume 0123456789abcdef')), '0123456789abcdef');
  assert.equal(attempt('copilot', { ...out('partial'), idleMs: 120000 }, { sessionPreset: 'preset-id-2' }), 'preset-id-2');
  assert.equal(attempt('copilot', out('', 1)), null);
  assert.equal(attempt('copilot', out('some unclassified stdout', 1, 'boom')), null);
  assert.equal(attempt('copilot', out('', 1), { sessionPreset: 'preset-id-3' }), null);
  assert.equal(attempt('copilot', out('R', 1), { resume: '../evil' }), null);
  const fresh = SPECS.copilot.argv(req, 'cli').argv;
  assert.ok(!fresh.includes('--session-id'));
  const preset = SPECS.copilot.argv({ ...req, sessionPreset: 'preset-id-4' }, 'cli').argv;
  assert.ok(preset.includes('--session-id') && preset.includes('preset-id-4'));
});

test('attempt session: claude returns envelope session id', () => {
  assert.equal(attempt('claude', out('{"type":"result","result":"R","session_id":"abc123"}')), 'abc123');
  assert.equal(attempt('claude', out('')), null);
  assert.equal(attempt('claude', out('', 1)), null);
  assert.equal(attempt('claude', out('{"type":"result","result":"R","session_id":"../evil"}')), null);
  const argv = SPECS.claude.argv({ ...req, resume: 'abc123', prompt: 'C' }, 'cli').argv;
  assert.ok(argv.includes('--resume') && argv.includes('abc123'));
});

test('attempt session: agy returns conversation id and classes empty envelope', () => {
  assert.equal(attempt('agy', out('{"conversationId":"c-1","response":"R"}')), 'c-1');
  assert.equal(attempt('agy', out('')), null);
  assert.equal(attempt('agy', out('{"conversationId":"../evil","response":"R"}')), null);
  assert.equal(cls(parse('agy', out('{"conversationId":"c-1","response":""}'))), 'empty-output');
  assert.equal(parse('agy', out('hello')).status, 'ok');
  assert.equal(cls(parse('agy', out('{"conversationId":"c-1","response":""}', 1, 'rate limit exceeded'))), 'quota');
  const argv = SPECS.agy.argv({ ...req, resume: 'c-1', prompt: 'C' }, 'cli').argv;
  assert.ok(argv.includes('--conversation') && argv.includes('c-1'));
});
