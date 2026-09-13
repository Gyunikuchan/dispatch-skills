import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveRunnerExitCode } from '../../../skills/dispatch/scripts/common.mjs';

import {
  buildCopilotArgs,
  extractCopilotSessionId,
  getCopilotDesktopCandidates,
  getCopilotVscodeCandidates,
  getCopilotCliCandidates,
  getCopilotDesktopBinary,
  getCopilotVscodeBinary,
  getCopilotCliBinary,
  getCopilotBinary,
  nextCopilotStep,
  resolveCopilotTarget,
  testCopilotReachability,
  probeCopilotModes,
  isCopilotAvailable,
  classifyCopilotFailure,
  classifyCopilotResult,
  runCopilot,
} from '../../../skills/dispatch/scripts/copilot-run.mjs';

describe('copilot-run: runner discovery, reachability & auth classification', () => {
  describe('constants & defaults', () => {
    it('omits -m/-e entirely when model/effort are null (no hardcoded default)', () => {
      const args = buildCopilotArgs('prompt', { model: null, effort: null });
      assert.ok(!args.includes('--model'));
      assert.ok(!args.includes('--effort'));
    });

    it('includes -m/-e when model/effort are provided (e.g. from dispatch config)', () => {
      const args = buildCopilotArgs('prompt', { model: 'gpt-5.6-luna', effort: 'max' });
      assert.equal(args[args.indexOf('--model') + 1], 'gpt-5.6-luna');
      assert.equal(args[args.indexOf('--effort') + 1], 'max');
    });
  });

  describe('discovery across modes & platforms', () => {
    it('gathers candidate paths for current platform across all modes', () => {
      const desktopCandidates = getCopilotDesktopCandidates();
      const vscodeCandidates = getCopilotVscodeCandidates();
      const cliCandidates = getCopilotCliCandidates();

      assert.ok(Array.isArray(desktopCandidates));
      assert.ok(Array.isArray(vscodeCandidates));
      assert.ok(Array.isArray(cliCandidates));
      assert.ok(desktopCandidates.length > 0);
      assert.ok(vscodeCandidates.length > 0);
      assert.ok(cliCandidates.length > 0);
    });

    it('tests reachability of an executable binary up to --version without token consumption', () => {
      const result = testCopilotReachability(process.execPath);
      assert.equal(result.reachable, true);
      assert.ok(/^v\d+\./.test(result.version));
      assert.equal(result.error, null);
    });

    it('reports unreachable for non-existent binary without throwing', () => {
      const result = testCopilotReachability('/path/to/non-existent-copilot-binary');
      assert.equal(result.reachable, false);
      assert.equal(result.version, null);
      assert.ok(result.error !== null);
    });

    it('supports explicit mode override in resolution', () => {
      const targetDesktop = resolveCopilotTarget('desktop');
      if (targetDesktop) {
        assert.equal(targetDesktop.mode, 'desktop');
      }

      const targetVscode = resolveCopilotTarget('vscode');
      if (targetVscode) {
        assert.equal(targetVscode.mode, 'vscode');
      }

      const targetCli = resolveCopilotTarget('cli');
      if (targetCli) {
        assert.equal(targetCli.mode, 'cli');
      }
    });

    it('follows preference order: copilot desktop > copilot vscode > copilot cli', () => {
      const desktopBin = getCopilotDesktopBinary();
      const vscodeBin = getCopilotVscodeBinary();
      const cliBin = getCopilotCliBinary();
      const resolved = resolveCopilotTarget();

      if (desktopBin && testCopilotReachability(desktopBin).reachable) {
        assert.equal(resolved?.mode, 'desktop');
        assert.equal(getCopilotBinary(), desktopBin);
      } else if (vscodeBin && testCopilotReachability(vscodeBin).reachable) {
        assert.equal(resolved?.mode, 'vscode');
        assert.equal(getCopilotBinary(), vscodeBin);
      } else if (cliBin && testCopilotReachability(cliBin).reachable) {
        assert.equal(resolved?.mode, 'cli');
        assert.equal(getCopilotBinary(), cliBin);
      }
    });

    it('probes all copilot modes without consuming tokens', () => {
      const probe = probeCopilotModes();
      assert.ok('desktop' in probe);
      assert.ok('vscode' in probe);
      assert.ok('cli' in probe);
      assert.equal(typeof probe.desktop.reachable, 'boolean');
      assert.equal(typeof probe.vscode.reachable, 'boolean');
      assert.equal(typeof probe.cli.reachable, 'boolean');
    });

    it('checks Copilot availability without requiring subscription or tokens', async () => {
      const available = await isCopilotAvailable();
      assert.equal(typeof available, 'boolean');
    });
  });

  describe('auth error classification', () => {
    it('classifies Copilot-specific auth errors', () => {
      assert.equal(
        classifyCopilotFailure(
          'Error: No authentication information found.\nCopilot can be authenticated with GitHub using an OAuth Token.',
        ),
        'auth',
      );
      assert.equal(
        classifyCopilotFailure('You need an active GitHub Copilot subscription to use this feature.'),
        'auth',
      );
      assert.equal(
        classifyCopilotFailure('Please run `gh auth login` to authenticate'),
        'auth',
      );
    });
  });

  describe('classifyCopilotResult (stdout only on non-zero exit)', () => {
    const authText = 'Copilot can be authenticated with GitHub using an OAuth Token.';

    it('exit 0 with auth text only on stdout -> null', () => {
      assert.equal(classifyCopilotResult({ exitCode: 0, stderr: '', stdout: `Review notes: ${authText}` }), null);
    });

    it('exit 0 with auth text on stderr -> auth', () => {
      assert.equal(classifyCopilotResult({ exitCode: 0, stderr: authText, stdout: 'answer' }), 'auth');
    });

    it('non-zero exit with auth text on stdout -> auth', () => {
      assert.equal(classifyCopilotResult({ exitCode: 1, stderr: '', stdout: authText }), 'auth');
    });
  });

  describe('exit code & output resolution', () => {
    it('preserves exit code 0 when stdout contains keywords like timeout or rate limit', () => {
      const stdout = 'Review: timeout and rate limit concerns addressed';
      assert.equal(resolveRunnerExitCode({ code: 0, cleanStdout: stdout }), 0);
    });

    it('forces exit code 1 when copilot exits 0 with empty stdout', () => {
      assert.equal(resolveRunnerExitCode({ code: 0, cleanStdout: '' }), 1);
    });
  });

  describe('extractCopilotSessionId', () => {
    it('extracts from JSON session_id field', () => {
      assert.equal(extractCopilotSessionId('{"session_id":"abc-123-def"}'), 'abc-123-def');
    });

    it('extracts from "Session ID: <id>" form', () => {
      assert.equal(extractCopilotSessionId('Session ID: sess-98765432'), 'sess-98765432');
    });

    it('extracts from "copilot --resume <id>" form', () => {
      assert.equal(extractCopilotSessionId('Run: copilot --resume sess-abcdefgh'), 'sess-abcdefgh');
    });

    it('returns null for short ids or no match', () => {
      assert.equal(extractCopilotSessionId('session id: short'), null);
      assert.equal(extractCopilotSessionId('no session info here'), null);
      assert.equal(extractCopilotSessionId(''), null);
      assert.equal(extractCopilotSessionId(null), null);
    });
  });

  describe('nextCopilotStep (pure cascade decision)', () => {
    it('success -> return', () => {
      assert.equal(
        nextCopilotStep({ result: { failureKind: null }, error: null, canCascade: true }),
        'return',
      );
    });

    it('quota failure with cascade available -> next-target', () => {
      assert.equal(
        nextCopilotStep({ result: { failureKind: 'quota' }, error: null, canCascade: true }),
        'next-target',
      );
    });

    it('auth failure -> return even with cascade available', () => {
      // Every mode is spawned with the same env and reads one credential store, so a second mode
      // would fail identically. Cascading on auth is pure latency.
      assert.equal(
        nextCopilotStep({ result: { failureKind: 'auth' }, error: null, canCascade: true }),
        'return',
      );
    });

    it('quota failure without cascade available -> return', () => {
      assert.equal(
        nextCopilotStep({ result: { failureKind: 'quota' }, error: null, canCascade: false }),
        'return',
      );
    });

    it('other failure -> return regardless of cascade', () => {
      assert.equal(
        nextCopilotStep({ result: { failureKind: 'other' }, error: null, canCascade: true }),
        'return',
      );
    });

    it('error (catch path) with cascade available -> next-target', () => {
      assert.equal(
        nextCopilotStep({ result: null, error: new Error('boom'), canCascade: true }),
        'next-target',
      );
    });

    it('error without cascade available -> throw', () => {
      assert.equal(
        nextCopilotStep({ result: null, error: new Error('boom'), canCascade: false }),
        'throw',
      );
    });
  });
});

// Uncovered for the same reason as the other two loops. Copilot's rule differs from claude's:
// auth does not cascade (see nextCopilotStep), so that asymmetry is what these pin.
describe('runCopilot cascade loop', () => {
  const target = (name) => ({ name, mode: name });

  const quotaResult = () => ({ exitCode: 1, failureKind: 'quota', stdout: '', stderr: '' });
  const authResult = () => ({ exitCode: 1, failureKind: 'auth', stdout: '', stderr: '' });
  const okResult = () => ({ exitCode: 0, failureKind: null, stdout: 'done', stderr: '' });

  function harness({ results = [], targets = [target('desktop'), target('vscode')] } = {}) {
    const calls = [];
    let closed = 0;
    return {
      calls,
      closedCount: () => closed,
      options: {
        prompt: 'x',
        initialGitStatus: '',
        discoverTargets: () => targets,
        createLogger: () => ({ logFile: null, write() {}, close() { closed += 1; } }),
        execute: async ({ target: t }) => {
          calls.push(t.name);
          const next = results[calls.length - 1];
          if (next instanceof Error) throw next;
          return next ?? okResult();
        },
      },
    };
  }

  it('cascades to the next target on a quota result', async () => {
    const h = harness({ results: [quotaResult(), okResult()] });
    const result = await runCopilot(h.options);
    assert.deepEqual(h.calls, ['desktop', 'vscode']);
    assert.equal(result.exitCode, 0);
  });

  it('cascades on a spawn error', async () => {
    const h = harness({ results: [new Error('spawn failed'), okResult()] });
    await runCopilot(h.options);
    assert.deepEqual(h.calls, ['desktop', 'vscode']);
  });

  it('does not cascade on auth — an authenticated-but-unsubscribed target is answered, not retried', async () => {
    const h = harness({ results: [authResult(), okResult()] });
    const result = await runCopilot(h.options);
    assert.deepEqual(h.calls, ['desktop'], 'auth must not advance the cascade');
    assert.equal(result.failureKind, 'auth');
  });

  it('a pinned mode suppresses cascade', async () => {
    const h = harness({ results: [quotaResult(), okResult()], targets: [target('desktop')] });
    const result = await runCopilot({ ...h.options, copilotMode: 'desktop' });
    assert.deepEqual(h.calls, ['desktop']);
    assert.equal(result.failureKind, 'quota');
  });

  it('returns the last result when every target is spent', async () => {
    const h = harness({ results: [quotaResult(), quotaResult()] });
    const result = await runCopilot(h.options);
    assert.deepEqual(h.calls, ['desktop', 'vscode']);
    assert.equal(result.failureKind, 'quota');
  });

  it('closes the session logger on success, on exhaustion, and on a propagated throw', async () => {
    const ok = harness({ results: [okResult()] });
    await runCopilot(ok.options);
    assert.equal(ok.closedCount(), 1);

    const spent = harness({ results: [quotaResult(), quotaResult()] });
    await runCopilot(spent.options);
    assert.equal(spent.closedCount(), 1);

    const boom = harness({ results: [new Error('boom'), new Error('boom')] });
    await assert.rejects(() => runCopilot(boom.options));
    assert.equal(boom.closedCount(), 1);
  });
});
