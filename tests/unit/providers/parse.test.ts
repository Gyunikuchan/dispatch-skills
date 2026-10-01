import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SPECS } from '../../../skills/dispatch/scripts/providers/index.ts';
import type { LaunchRequest, ProcessResult, ProviderId, RunOutcome } from '../../../skills/dispatch/scripts/providers/types.ts';

const req: LaunchRequest = {
  promptPath: '/p', model: 'openai/gpt-5', effort: null, sandbox: false, schemaPath: null, resume: null, cwd: '/repo', timeoutMs: 1000, outputCapBytes: 1000,
  attachments: [], logPath: '/log', briefPath: '/brief', binary: 'bin', prompt: 'P', briefFile: null, schemaText: null,
  platform: { os: 'linux', arch: 'x64', wsl: false, bubblewrap: false, argvLimit: 100000, home: '/h', path: [], pathExt: [] },
};

const out = (stdout: string, exit: number | null = 0, stderrTail = ''): ProcessResult =>
  ({ exit, signal: null, stdout, stdoutPath: '/log', stderrTail, durationMs: 1, timedOut: false, truncated: false });

const parse = (id: ProviderId, result: ProcessResult, over: Partial<LaunchRequest> = {}): RunOutcome => SPECS[id].parse(result, { ...req, ...over });
const cls = (outcome: RunOutcome): string => (outcome.status === 'fail' ? outcome.cls : 'ok');

test('delegates-resume-handles: recorded successes yield text, session id, and each provider’s resume handle', () => {
  assert.deepEqual(parse('claude', out('{"type":"result","result":"R","session_id":"abc123"}')),
    { status: 'ok', text: 'R', sessionId: 'abc123', resume: 'claude --resume abc123' });
  assert.deepEqual(parse('agy', out('{"conversationId":"c-1","response":"R"}')), { status: 'ok', text: 'R', sessionId: 'c-1', resume: 'conversation://c-1' });
  assert.deepEqual(parse('copilot', out('R\n\nTo resume: copilot --resume 0123456789abcdef')),
    { status: 'ok', text: 'R\n\nTo resume: copilot --resume 0123456789abcdef', sessionId: '0123456789abcdef', resume: 'copilot --resume 0123456789abcdef' });
  const codexStream = ['{"type":"thread.started","thread_id":"t-9"}', '{"type":"item.completed","item":{"type":"reasoning","text":"x"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"R"}}'].join('\n');
  assert.deepEqual(parse('codex', out(codexStream)), { status: 'ok', text: 'R', sessionId: 't-9', resume: 'codex exec resume t-9' });
  assert.deepEqual(parse('opencode', out('> build\nR')), { status: 'ok', text: 'R', sessionId: null, resume: 'opencode:openai/gpt-5' });
  const local = parse('opencode', out('R'), { endpoint: 'http://127.0.0.1:1234/v1' });
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
