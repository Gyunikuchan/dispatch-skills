import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  READ_ONLY_ALLOWED_TOOLS,
  MODE_DEFINITIONS,
  buildClaudeArgs,
  claudeFixedArgBytes,
  classifyClaudeFailure,
  classifyClaudeResult,
  CLI_FLAGS,
  extractClaudeSessionId,
  getClaudeBinary,
  getClaudeDesktopBinary,
  getClaudeVSCodeBinary,
  getClaudeCliBinary,
  isClaudeAvailable,
  nextClaudeStep,
  parseModeFlags,
  parseClaudeEnvelope,
  probeAllClaudeModes,
  resolveClaudeOutcome,
  resolveClaudeTarget,
  runClaude,
  shouldPrintClaudeStdout,
  testClaudeBinaryReachability,
} from '../../../skills/dispatch/scripts/claude-run.mjs';

describe('claude-run: runner discovery, reachability & envelope parsing', () => {
  describe('constants & tools', () => {
    it('enforces read-only allowed tools list without destructive tools', () => {
      assert.ok(READ_ONLY_ALLOWED_TOOLS.includes('Read'));
      assert.ok(READ_ONLY_ALLOWED_TOOLS.includes('Glob'));
      assert.ok(READ_ONLY_ALLOWED_TOOLS.includes('LS'));
      assert.ok(READ_ONLY_ALLOWED_TOOLS.includes('Bash(git diff*)'));
      assert.ok(!READ_ONLY_ALLOWED_TOOLS.includes('Write'));
      assert.ok(!READ_ONLY_ALLOWED_TOOLS.includes('Edit'));
    });

    it('READ_ONLY_ALLOWED_TOOLS excludes find/awk/sort/WebFetch/WebSearch', () => {
      for (const tool of ['Bash(find *)', 'Bash(awk *)', 'Bash(sort *)', 'WebFetch', 'WebSearch']) {
        assert.ok(!READ_ONLY_ALLOWED_TOOLS.includes(tool), `${tool} must not be allowed`);
      }
      assert.ok(READ_ONLY_ALLOWED_TOOLS.includes('Grep'));
    });

    it('defines modes in preference order cli > desktop > vscode', () => {
      assert.deepEqual(
        MODE_DEFINITIONS.map((m) => m.mode),
        ['cli', 'desktop', 'vscode'],
      );
    });
  });

  describe('envelope & session parsing', () => {
    it('extracts text, session id, and error subtype from JSON result', () => {
      const envelope = JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        result: '## Summary\nAll good.',
        session_id: 'abc-123-def',
      });

      const parsed = parseClaudeEnvelope(envelope);
      assert.equal(parsed.text, '## Summary\nAll good.');
      assert.equal(parsed.sessionId, 'abc-123-def');
      assert.equal(parsed.isError, true);
      assert.equal(parsed.subtype, 'error_max_turns');
    });

    it('reads the last result entry of a streamed JSON array', () => {
      const stream = JSON.stringify([
        { type: 'assistant', message: 'thinking' },
        { type: 'result', result: 'final answer', session_id: 's-1', is_error: false },
      ]);

      const parsed = parseClaudeEnvelope(stream);
      assert.equal(parsed.text, 'final answer');
      assert.equal(parsed.sessionId, 's-1');
    });

    it('falls back to text extraction for non-JSON or malformed output', () => {
      assert.equal(parseClaudeEnvelope('## Summary\nplain text').text, '## Summary\nplain text');
      assert.equal(parseClaudeEnvelope('{"result": "truncated mid-str').isError, false);
    });

    it('does not match short prose after the word session', () => {
      assert.equal(extractClaudeSessionId('The session: ended cleanly'), null);
      assert.equal(extractClaudeSessionId('{"session_id":"uuid-value-1"}'), 'uuid-value-1');
    });
  });

  describe('multi-mode resolution & reachability', () => {
    it('probes all three modes reporting metadata', () => {
      const modes = probeAllClaudeModes();
      assert.deepEqual(
        modes.map((m) => m.mode),
        ['cli', 'desktop', 'vscode'],
      );
      for (const m of modes) {
        assert.equal(typeof m.name, 'string');
        assert.equal(typeof m.reachable, 'boolean');
        assert.ok(['REACHABLE', 'UNREACHABLE', 'NOT_FOUND'].includes(m.status));
      }
    });

    it('tests reachability of an executable binary up to --version without token consumption', () => {
      const result = testClaudeBinaryReachability(process.execPath);
      assert.equal(result.reachable, true);
      assert.ok(/^v\d+\./.test(result.version));
      assert.equal(result.error, null);
    });

    it('reports unreachable for non-existent binary without throwing', () => {
      const result = testClaudeBinaryReachability('/path/to/non-existent-claude-binary');
      assert.equal(result.reachable, false);
      assert.equal(result.version, null);
      assert.ok(result.error !== null);
    });

    it('supports explicit mode override in resolution', { skip: !getClaudeCliBinary() && !getClaudeDesktopBinary() && !getClaudeVSCodeBinary() ? 'no Claude binary installed' : false }, () => {
      const targetDesktop = resolveClaudeTarget('desktop');
      if (targetDesktop) {
        assert.equal(targetDesktop.mode, 'desktop');
      }

      const targetVscode = resolveClaudeTarget('vscode');
      if (targetVscode) {
        assert.equal(targetVscode.mode, 'vscode');
      }

      const targetCli = resolveClaudeTarget('cli');
      if (targetCli) {
        assert.equal(targetCli.mode, 'cli');
      }
    });

    it('follows preference order cli > desktop > vscode', { skip: !getClaudeCliBinary() && !getClaudeDesktopBinary() && !getClaudeVSCodeBinary() ? 'no Claude binary installed' : false }, () => {
      const cliBin = getClaudeCliBinary();
      const desktopBin = getClaudeDesktopBinary();
      const vscodeBin = getClaudeVSCodeBinary();
      const resolved = resolveClaudeTarget();

      if (cliBin) {
        assert.equal(resolved?.mode, 'cli');
        assert.equal(getClaudeBinary(), cliBin);
      } else if (desktopBin) {
        assert.equal(resolved?.mode, 'desktop');
        assert.equal(getClaudeBinary(), desktopBin);
      } else if (vscodeBin) {
        assert.equal(resolved?.mode, 'vscode');
        assert.equal(getClaudeBinary(), vscodeBin);
      }
    });

    it('availability agrees with the resolved target reachability', async () => {
      const available = await isClaudeAvailable();
      const bin = getClaudeBinary();
      assert.equal(available, bin ? testClaudeBinaryReachability(bin).reachable : false);
    });
  });

  describe('claudeFixedArgBytes (batch-launcher budget)', () => {
    it('measures the arguments buildClaudeArgs adds around the prompt', () => {
      const bytes = claudeFixedArgBytes({ model: 'claude-sonnet-5', effort: 'medium' });
      assert.ok(bytes > 200, `expected the read-only tool list to be substantial, got ${bytes}`);
      assert.ok(claudeFixedArgBytes({ model: 'm', effort: 'e' }) > claudeFixedArgBytes({}));
    });

    it('excludes the prompt, so the reservation cannot double-count it', () => {
      assert.equal(claudeFixedArgBytes({}), claudeFixedArgBytes({}));
      const fixed = claudeFixedArgBytes({});
      const whole = buildClaudeArgs('z'.repeat(500), {}).reduce((n, a) => n + Buffer.byteLength(String(a), 'utf8') + 1, 0);
      assert.equal(whole - fixed, 500, 'the only difference must be the prompt itself');
    });

    it('accounts for the sandbox setting when explicitly disabled', () => {
      const enabledSettingsBytes = Buffer.byteLength(JSON.stringify({ sandbox: { enabled: true } }), 'utf8');
      const disabledSettingsBytes = Buffer.byteLength(JSON.stringify({ sandbox: { enabled: false } }), 'utf8');
      assert.equal(
        claudeFixedArgBytes({ sandbox: false }) - claudeFixedArgBytes({ sandbox: true }),
        disabledSettingsBytes - enabledSettingsBytes,
        'the serialized sandbox setting must be budgeted',
      );
    });

    it('accounts for a native response schema', () => {
      const schema = { type: 'object', additionalProperties: false };
      assert.ok(
        claudeFixedArgBytes({ responseSchema: schema }) > claudeFixedArgBytes({}),
        'the serialized schema must be reserved in the command-line budget',
      );
    });
  });

  describe('buildClaudeArgs', () => {
    it('includes -p, --output-format json, and every read-only tool as --allowedTools', () => {
      const args = buildClaudeArgs('hello', {});
      assert.equal(args[0], '-p');
      assert.equal(args[1], 'hello');
      assert.ok(args.includes('--output-format'));
      assert.equal(args[args.indexOf('--output-format') + 1], 'json');
      for (const tool of READ_ONLY_ALLOWED_TOOLS) {
        assert.ok(args.includes(tool), `expected --allowedTools ${tool}`);
      }
      assert.equal(args.filter((a) => a === '--allowedTools').length, READ_ONLY_ALLOWED_TOOLS.length);
    });

    it('enables the native sandbox by default and supports an explicit opt-out', () => {
      const enabled = buildClaudeArgs('hello', {});
      const disabled = buildClaudeArgs('hello', { sandbox: false });
      const enabledSettings = JSON.parse(enabled[enabled.indexOf('--settings') + 1]);
      const disabledSettings = JSON.parse(disabled[disabled.indexOf('--settings') + 1]);
      assert.deepEqual(enabledSettings, { sandbox: { enabled: true } });
      assert.deepEqual(disabledSettings, { sandbox: { enabled: false } });
    });

    it('omits --model/--effort when null', () => {
      const args = buildClaudeArgs('hello', { model: null, effort: null });
      assert.ok(!args.includes('--model'));
      assert.ok(!args.includes('--effort'));
    });

    describe('Claude sandbox flags and diagnostics', () => {
      it('parses the direct-runner sandbox flags with enabled as the default', () => {
        assert.equal(parseModeFlags([]).sandbox, true);
        assert.equal(parseModeFlags(['--sandbox']).sandbox, true);
        assert.equal(parseModeFlags(['--no-sandbox']).sandbox, false);
        assert.ok(CLI_FLAGS.booleanFlags.includes('--sandbox'));
        assert.ok(CLI_FLAGS.booleanFlags.includes('--no-sandbox'));
      });

      it('classifies unsupported settings diagnostics and preserves shared failures', () => {
        assert.equal(classifyClaudeFailure('Unknown option: --settings'), 'sandbox-unsupported');
        assert.equal(
          classifyClaudeResult({
            exitCode: 1,
            stderr: 'Warning: sandbox is unavailable on this platform',
            stdout: '{"type":"result","result":"answer"}',
          }),
          'sandbox-unsupported',
        );
        assert.equal(
          classifyClaudeResult({
            exitCode: 0,
            stderr: '',
            stdout: 'The answer explains that sandbox is not supported by this provider.',
          }),
          null,
        );
        assert.equal(
          classifyClaudeResult({
            exitCode: 0,
            stderr: 'Warning: sandbox disabled for this command because it requires network access',
            stdout: '{"type":"result","result":"answer"}',
          }),
          null,
        );
        assert.equal(
          classifyClaudeResult({
            exitCode: 1,
            stderr: 'quota reached; sandbox disabled for this command because it requires network access',
            stdout: 'partial answer discusses sandbox unsupported behavior',
          }),
          'quota',
        );
        assert.equal(
          classifyClaudeResult({
            exitCode: 1,
            stderr: '',
            stdout: 'partial answer discusses sandbox unsupported behavior',
          }),
          null,
        );
        assert.equal(classifyClaudeFailure('usage limit reached'), 'quota');
      });

      it('preserves envelope subtypes and forces a non-zero sandbox failure', () => {
        assert.deepEqual(
          resolveClaudeOutcome({
            envelope: { isError: true, subtype: 'error_max_turns' },
            classifiedFailure: 'quota',
            exitCode: 1,
          }),
          { failureKind: 'error_max_turns', effectiveExitCode: 1 },
        );
        assert.deepEqual(
          resolveClaudeOutcome({
            envelope: { isError: false },
            classifiedFailure: 'sandbox-unsupported',
            exitCode: 0,
          }),
          { failureKind: 'sandbox-unsupported', effectiveExitCode: 1 },
        );
        assert.deepEqual(
          resolveClaudeOutcome({
            envelope: { isError: false },
            classifiedFailure: null,
            exitCode: 1,
            truncated: 'truncated',
          }),
          { failureKind: 'truncated', effectiveExitCode: 1 },
        );
      });

      it('suppresses direct-runner output when sandbox support is unverified', () => {
        assert.equal(shouldPrintClaudeStdout({ failureKind: 'sandbox-unsupported' }), false);
        assert.equal(shouldPrintClaudeStdout({ failureKind: null }), true);
      });
    });

    it('includes --model/--effort when set', () => {
      const args = buildClaudeArgs('hello', { model: 'claude-opus-5', effort: 'high' });
      assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5');
      assert.equal(args[args.indexOf('--effort') + 1], 'high');
    });

    it('passes a response schema through Claude native structured output', () => {
      const schema = { type: 'object', additionalProperties: false };
      const args = buildClaudeArgs('hello', { responseSchema: schema });
      assert.equal(args[args.indexOf('--json-schema') + 1], JSON.stringify(schema));
      assert.ok(
        args.indexOf('--json-schema') < args.indexOf('--disallowedTools'),
        'schema flag must precede the variadic disallowed-tools flag',
      );
    });

    it('buildClaudeArgs pins --permission-mode plan and disallows write tools', () => {
      const args = buildClaudeArgs('hello', { model: 'm', effort: 'e' });
      assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
      const disallowedIndex = args.indexOf('--disallowedTools');
      assert.ok(disallowedIndex !== -1);
      // Variadic flag last, so its values cannot swallow anything that follows.
      assert.deepEqual(args.slice(disallowedIndex + 1), ['Write', 'Edit', 'NotebookEdit']);
    });
  });

  describe('nextClaudeStep (pure cascade decision)', () => {
    const base = { isLastModel: false, isLastTarget: false, pinned: false };

    it('success (exit 0, no failureKind) -> return', () => {
      const step = nextClaudeStep({ ...base, result: { exitCode: 0, failureKind: null }, error: null });
      assert.equal(step, 'return');
    });

    it("nextClaudeStep: exit 0 with failureKind 'success', not last model -> return", () => {
      for (const failureKind of ['success', 'quota', 'auth', 'timeout']) {
        const step = nextClaudeStep({ ...base, result: { exitCode: 0, failureKind }, error: null });
        assert.equal(step, 'return', `exit 0 with ${failureKind} must not re-run a real answer`);
      }
    });

    it('failure, not last model -> next-model', () => {
      const step = nextClaudeStep({ ...base, result: { exitCode: 1, failureKind: 'other' }, error: null });
      assert.equal(step, 'next-model');
    });

    it('does not retry an unsupported sandbox setting across Claude models', () => {
      const step = nextClaudeStep({
        ...base,
        result: { exitCode: 1, failureKind: 'sandbox-unsupported' },
        error: null,
      });
      assert.equal(step, 'return');
    });

    it('quota/auth failure, last model, not last target, unpinned -> next-target', () => {
      const step = nextClaudeStep({
        ...base,
        isLastModel: true,
        result: { exitCode: 1, failureKind: 'quota' },
        error: null,
      });
      assert.equal(step, 'next-target');
    });

    it('quota/auth failure, last model, pinned -> return', () => {
      const step = nextClaudeStep({
        ...base,
        isLastModel: true,
        pinned: true,
        result: { exitCode: 1, failureKind: 'auth' },
        error: null,
      });
      assert.equal(step, 'return');
    });

    it('other (non quota/auth) failure, last model -> return', () => {
      const step = nextClaudeStep({
        ...base,
        isLastModel: true,
        isLastTarget: false,
        result: { exitCode: 1, failureKind: 'other' },
        error: null,
      });
      assert.equal(step, 'return');
    });

    it('error (catch path), not last model -> next-model', () => {
      const step = nextClaudeStep({ ...base, result: null, error: new Error('boom') });
      assert.equal(step, 'next-model');
    });

    it('error, last model, not last target, unpinned -> next-target', () => {
      const step = nextClaudeStep({ ...base, isLastModel: true, result: null, error: new Error('boom') });
      assert.equal(step, 'next-target');
    });

    it('error, last model, last target -> throw', () => {
      const step = nextClaudeStep({
        ...base,
        isLastModel: true,
        isLastTarget: true,
        result: null,
        error: new Error('boom'),
      });
      assert.equal(step, 'throw');
    });

    it('error, last model, pinned -> throw', () => {
      const step = nextClaudeStep({
        ...base,
        isLastModel: true,
        pinned: true,
        result: null,
        error: new Error('boom'),
      });
      assert.equal(step, 'throw');
    });

  });
});

// Uncovered for the same reason as the agy loop. runClaude cascades in two dimensions — targets
// outer, models inner — so the call *sequence* is the contract, not just the final result.
describe('runClaude cascade loop', () => {
  const target = (name) => ({ name, mode: name });

  const quotaResult = () => ({ exitCode: 1, failureKind: 'quota', stdout: '', stderr: '' });
  const modelFailResult = () => ({ exitCode: 1, failureKind: null, stdout: '', stderr: 'model not available' });
  const okResult = () => ({ exitCode: 0, failureKind: null, stdout: 'done', stderr: '' });

  function harness({ results = [], targets = [target('desktop'), target('vscode')] } = {}) {
    const calls = [];
    const sandboxValues = [];
    const responseSchemas = [];
    let closed = 0;
    return {
      calls,
      sandboxValues,
      responseSchemas,
      closedCount: () => closed,
      options: {
        prompt: 'x',
        model: ['model-a', 'model-b'],
        discoverTargets: () => targets,
        createLogger: () => ({ logFile: null, write() {}, close() { closed += 1; } }),
        execute: async ({ target: t, model, sandbox, responseSchema }) => {
          calls.push(`${t.name}:${model}`);
          sandboxValues.push(sandbox);
          responseSchemas.push(responseSchema);
          const next = results[calls.length - 1];
          if (next instanceof Error) throw next;
          return next ?? okResult();
        },
      },
    };
  }

  // nextClaudeStep tests `!isLastModel` BEFORE the quota/auth check, so the inner loop always
  // runs to the end of the model list first, whatever the failure kind. Target advance is a
  // last-model-only decision. These three pin that ordering, which the call sequence exposes
  // and a result-only assertion would not.
  it('tries every model on a target before considering the next target', async () => {
    // model-a is out of quota — the condition that abandons a target — yet model-b on the same
    // target is still tried first, because the model loop is inner.
    const h = harness({ results: [quotaResult(), quotaResult(), okResult()] });
    await runClaude(h.options);
    assert.deepEqual(h.calls, ['desktop:model-a', 'desktop:model-b', 'vscode:model-a']);
  });

  it('propagates the sandbox option through the cascade executor', async () => {
    const h = harness({ results: [okResult()] });
    await runClaude({ ...h.options, sandbox: false });
    assert.deepEqual(h.sandboxValues, [false]);
  });

  it('propagates the response schema through the cascade executor', async () => {
    const h = harness({ results: [okResult()] });
    const schema = { type: 'object' };
    await runClaude({ ...h.options, responseSchema: schema });
    assert.deepEqual(h.responseSchemas, [schema]);
  });

  it('advances the target only after the last model, and only on quota or auth', async () => {
    const cascades = harness({ results: [modelFailResult(), quotaResult(), okResult()] });
    await runClaude(cascades.options);
    assert.deepEqual(cascades.calls, ['desktop:model-a', 'desktop:model-b', 'vscode:model-a']);

    // Same shape, but the last model fails for an ordinary reason: that result is returned
    // rather than cascading, because only quota/auth means "this target is unusable".
    const stops = harness({ results: [modelFailResult(), modelFailResult(), okResult()] });
    const result = await runClaude(stops.options);
    assert.deepEqual(stops.calls, ['desktop:model-a', 'desktop:model-b'], 'vscode is never reached');
    assert.equal(result.exitCode, 1);
  });

  it('a pinned mode suppresses target advance but not model fallback', async () => {
    const h = harness({ results: [quotaResult(), quotaResult()] });
    const result = await runClaude({ ...h.options, claudeMode: 'desktop' });
    assert.deepEqual(h.calls, ['desktop:model-a', 'desktop:model-b'], 'pinning does not disable model fallback');
    assert.equal(result.failureKind, 'quota', 'the pinned target result is returned, not cascaded');
  });

  it('returns the last result rather than throwing when the cascade is exhausted', async () => {
    const h = harness({ results: [quotaResult(), quotaResult(), quotaResult(), quotaResult()] });
    const result = await runClaude(h.options);
    assert.deepEqual(h.calls, ['desktop:model-a', 'desktop:model-b', 'vscode:model-a', 'vscode:model-b']);
    assert.ok(result, 'an exhausted cascade still returns lastResult');
    assert.equal(result.failureKind, 'quota');
  });

  it('closes the session logger on success, on exhaustion, and on a propagated throw', async () => {
    const ok = harness({ results: [okResult()] });
    await runClaude(ok.options);
    assert.equal(ok.closedCount(), 1, 'closed on success');

    const spent = harness({ results: [quotaResult(), quotaResult(), quotaResult(), quotaResult()] });
    await runClaude(spent.options);
    assert.equal(spent.closedCount(), 1, 'closed on exhaustion');

    const boom = harness({ results: [new Error('spawn failed'), new Error('spawn failed'), new Error('spawn failed'), new Error('spawn failed')] });
    await assert.rejects(() => runClaude(boom.options));
    assert.equal(boom.closedCount(), 1, 'closed before rethrowing');
  });

  it('throws when no target is viable, before any execution', async () => {
    const h = harness({ targets: [] });
    await assert.rejects(() => runClaude(h.options), (err) => {
      assert.equal(err.code, 'CLI_NOT_FOUND');
      assert.ok(err.message.includes('Claude Code was not found or not reachable in any mode'));
      assert.ok(err.message.includes('npm install -g @anthropic-ai/claude-code'), 'the message names the CLI install path');
      return true;
    });
    assert.deepEqual(h.calls, []);
  });
});
