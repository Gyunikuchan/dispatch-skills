import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveRunnerExitCode } from '../../../skills/dispatch/scripts/common.mjs';

import {
  READ_ONLY_ALLOWED_TOOLS,
  MODE_DEFINITIONS,
  buildClaudeArgs,
  extractClaudeSessionId,
  getClaudeBinary,
  getClaudeDesktopBinary,
  getClaudeVSCodeBinary,
  getClaudeCliBinary,
  isClaudeAvailable,
  nextClaudeStep,
  parseClaudeEnvelope,
  probeAllClaudeModes,
  resolveClaudeTarget,
  resolveModelsToTry,
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

    it('defines modes in preference order desktop > vscode > cli', () => {
      assert.deepEqual(
        MODE_DEFINITIONS.map((m) => m.mode),
        ['desktop', 'vscode', 'cli'],
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

  describe('resolveModelsToTry (no hardcoded default)', () => {
    it('returns [null] when no model is configured anywhere, omitting --model', () => {
      assert.deepEqual(resolveModelsToTry(null), [null]);
      assert.deepEqual(resolveModelsToTry(undefined), [null]);
      assert.deepEqual(resolveModelsToTry(''), [null]);
    });

    it('returns the array as-is (ordered fallback list) when given an array', () => {
      assert.deepEqual(resolveModelsToTry(['claude-opus-5', 'bedrock.claude-opus-5']), [
        'claude-opus-5',
        'bedrock.claude-opus-5',
      ]);
    });

    it('splits a comma-separated string into an ordered fallback list', () => {
      assert.deepEqual(resolveModelsToTry('a, b ,c'), ['a', 'b', 'c']);
    });

    it('wraps a single model string', () => {
      assert.deepEqual(resolveModelsToTry('claude-opus-5'), ['claude-opus-5']);
    });
  });

  describe('multi-mode resolution & reachability', () => {
    it('probes all three modes reporting metadata', () => {
      const modes = probeAllClaudeModes();
      assert.deepEqual(
        modes.map((m) => m.mode),
        ['desktop', 'vscode', 'cli'],
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

    it('supports explicit mode override in resolution', () => {
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

    it('follows preference order desktop > vscode > cli', () => {
      const desktopBin = getClaudeDesktopBinary();
      const vscodeBin = getClaudeVSCodeBinary();
      const cliBin = getClaudeCliBinary();
      const resolved = resolveClaudeTarget();

      if (desktopBin) {
        assert.equal(resolved?.mode, 'desktop');
        assert.equal(getClaudeBinary(), desktopBin);
      } else if (vscodeBin) {
        assert.equal(resolved?.mode, 'vscode');
        assert.equal(getClaudeBinary(), vscodeBin);
      } else if (cliBin) {
        assert.equal(resolved?.mode, 'cli');
        assert.equal(getClaudeBinary(), cliBin);
      }
    });

    it('checks Claude availability without consuming tokens', async () => {
      const available = await isClaudeAvailable();
      assert.equal(typeof available, 'boolean');
    });
  });

  describe('exit code & output resolution', () => {
    it('preserves exit code 0 when stdout contains keywords like timeout or rate limit', () => {
      const stdout = 'Review: timeout and rate limit considerations';
      assert.equal(resolveRunnerExitCode({ code: 0, cleanStdout: stdout }), 0);
    });

    it('forces exit code 1 when claude exits 0 with isError envelope', () => {
      assert.equal(resolveRunnerExitCode({ code: 0, cleanStdout: 'error details', isError: true }), 1);
    });

    it('forces exit code 1 when claude exits 0 with empty stdout', () => {
      assert.equal(resolveRunnerExitCode({ code: 0, cleanStdout: '' }), 1);
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

    it('omits --model/--effort when null', () => {
      const args = buildClaudeArgs('hello', { model: null, effort: null });
      assert.ok(!args.includes('--model'));
      assert.ok(!args.includes('--effort'));
    });

    it('includes --model/--effort when set', () => {
      const args = buildClaudeArgs('hello', { model: 'claude-opus-5', effort: 'high' });
      assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5');
      assert.equal(args[args.indexOf('--effort') + 1], 'high');
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
