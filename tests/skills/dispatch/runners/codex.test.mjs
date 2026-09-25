import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  buildCodexArgs, classifyCodexFailure, CODEX_DOWNGRADE_WARNING, findViableTargets, getCodexVscodeCandidates,
  nextCodexStep, parseCodexArgs, parseCodexEvents, runCodex, testCodexReachability,
} from '../../../../skills/dispatch/scripts/runners/codex.mjs';
import { dispatchTask, providerRunners } from '../../../../skills/dispatch/scripts/dispatch.mjs';
import { detectOrchestrator, detectOrchestratorModel, validateProviderSpec } from '../../../../skills/dispatch/scripts/lib/providers.mjs';
import { validateConfig } from '../../../../skills/dispatch/scripts/lib/config.mjs';

describe('Codex read-delegate runner', () => {
  it('uses JSONL, read-only sandbox, and noninteractive approvals', () => {
    const args = buildCodexArgs('-', { model: 'gpt-6-sol', effort: 'high' });
    assert.deepEqual(args.slice(0, 2), ['exec', '--json']);
    assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
    assert.ok(args.includes('approval_policy="never"'));
    assert.ok(args.includes('model_reasoning_effort="high"'));
    assert.equal(args.at(-1), '-');
    const unsandboxed = buildCodexArgs('-', { sandbox: false });
    assert.deepEqual(unsandboxed.slice(unsandboxed.indexOf('--sandbox'), unsandboxed.indexOf('--sandbox') + 2), ['--sandbox', 'danger-full-access']);
  });

  it('extracts only the final agent message and reports failed turns', () => {
    const raw = [
      { type: 'thread.started', thread_id: 'thread-123' },
      { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'secret trace' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'first draft' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } },
      { type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 5 } },
    ].map(JSON.stringify).join('\n');
    assert.deepEqual(parseCodexEvents(raw), {
      answer: 'final answer', threadId: 'thread-123', usage: { input_tokens: 20, output_tokens: 5 }, error: null,
    });
    assert.equal(parseCodexEvents('{"type":"turn.failed","error":{"message":"sandbox unavailable"}}').error, 'sandbox unavailable');
  });

  it('classifies sandbox failures and leaves quoted answer text out of classification', () => {
    assert.equal(classifyCodexFailure('sandbox is unavailable'), 'sandbox-unsupported');
    assert.equal(classifyCodexFailure('rate limit exceeded'), 'quota');
    assert.equal(classifyCodexFailure('healthy'), null);
  });

  it('retries a rejected sandbox on the same target, warns, and records both attempts', async () => {
    const calls = [];
    const logged = [];
    const result = await runCodex({
      prompt: 'Read the project', model: 'gpt-6-sol',
      discoverTargets: () => [
        { mode: 'cli', name: 'Codex CLI', binary: 'bad' },
        { mode: 'vscode', name: 'VS Code', binary: 'good' },
      ],
      createLogger: () => ({ logFile: 'test.log', write: (line) => logged.push(line), close() {} }),
      execute: async ({ target, sandbox }) => {
        calls.push([target.mode, sandbox]);
        return { provider: 'codex', mode: target.mode, stdout: sandbox ? '' : 'answer', exitCode: sandbox ? 1 : 0, failureKind: sandbox ? 'sandbox-unsupported' : null };
      },
    });
    assert.deepEqual(calls, [['cli', true], ['cli', false]]);
    assert.equal(result.stdout, 'answer');
    assert.equal(result.sandboxDowngraded, true);
    assert.deepEqual(result.warnings, [CODEX_DOWNGRADE_WARNING]);
    assert.deepEqual(logged, [`${CODEX_DOWNGRADE_WARNING}\n`]);
    assert.equal(result.metricsAttempts.length, 2);
    assert.equal(result.effectiveAttempt, 1);
  });

  it('retries a thrown sandbox rejection once, then preserves mode cascade for other failures', async () => {
    const calls = [];
    const result = await runCodex({
      prompt: 'Read the project', model: 'gpt-6-sol',
      discoverTargets: () => [
        { mode: 'cli', name: 'Codex CLI', binary: 'bad' },
        { mode: 'vscode', name: 'VS Code', binary: 'good' },
      ],
      createLogger: () => ({ logFile: 'test.log', write() {}, close() {} }),
      execute: async ({ target, sandbox }) => {
        calls.push([target.mode, sandbox]);
        if (target.mode === 'cli' && sandbox) {
          const err = new Error('sandbox is unavailable');
          err.failureKind = 'sandbox-unsupported';
          throw err;
        }
        return { provider: 'codex', mode: target.mode, stdout: target.mode === 'vscode' ? 'answer' : '', exitCode: target.mode === 'vscode' ? 0 : 1, failureKind: target.mode === 'vscode' ? null : 'quota' };
      },
    });
    assert.deepEqual(calls, [['cli', true], ['cli', false], ['vscode', false]]);
    assert.equal(result.stdout, 'answer');
    assert.equal(result.sandboxDowngraded, true);
    assert.equal(result.metricsAttempts.length, 3);
  });

  it('keeps a pinned mode pinned', () => {
    assert.equal(nextCodexStep({ result: { exitCode: 1 }, hasNext: false }), 'return');
    assert.equal(nextCodexStep({ result: { exitCode: 1 }, hasNext: true }), 'next-target');
    assert.equal(parseCodexArgs(['node', 'codex.mjs', '--codex-mode', 'vscode', '--no-sandbox', '-p', 'Hi']).codexMode, 'vscode');
  });

  it('locates current-platform extension candidates and rejects a broken executable', () => {
    assert.ok(Array.isArray(getCodexVscodeCandidates()));
    assert.equal(testCodexReachability('/missing/codex').reachable, false);
    assert.ok(Array.isArray(findViableTargets('vscode')));
  });

  it('accepts Codex config and routes pinned requests with its sandbox setting', async () => {
    const config = { 'read-delegates': { codex: { sandbox: true, targets: [{ low: { model: 'gpt-6-sol', effort: 'medium' } }] } } };
    assert.deepEqual(validateConfig(config), []);
    assert.equal(validateProviderSpec('openai-codex'), 'codex');
    assert.equal(detectOrchestrator({ env: { CODEX_THREAD_ID: 'thread-123' } }), 'codex');
    assert.equal(detectOrchestratorModel({ env: { CODEX_MODEL: 'gpt-6-astra' }, orchestrator: 'codex' }), 'gpt-6-astra');
    const calls = mock.method(providerRunners, 'codex', async (options) => {
      assert.equal(options.model, 'gpt-6-sol');
      assert.equal(options.effort, 'medium');
      assert.equal(options.sandbox, true);
      return { provider: 'codex', stdout: 'review', stderr: '', exitCode: 0, failureKind: null };
    });
    try {
      const result = await dispatchTask({ prompt: 'Review', provider: 'codex', config, configPath: 'test.jsonc', level: 'low' });
      assert.equal(result.stdout, 'review');
      assert.equal(calls.mock.callCount(), 1);
    } finally {
      calls.mock.restore();
    }
  });
});
