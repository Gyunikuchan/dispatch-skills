import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_CLAUDE_MODELS,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_EFFORT,
  READ_ONLY_ALLOWED_TOOLS,
  MODE_DEFINITIONS,
  extractClaudeSessionId,
  getClaudeBinary,
  getClaudeDesktopBinary,
  getClaudeVSCodeBinary,
  getClaudeCliBinary,
  isClaudeAvailable,
  parseClaudeEnvelope,
  probeAllClaudeModes,
  resolveClaudeTarget,
  testClaudeBinaryReachability,
} from '../../../skills/dispatch/scripts/claude-run.mjs';

describe('claude-run: runner discovery, reachability & envelope parsing', () => {
  describe('constants & tools', () => {
    it('defines candidate models and default effort', () => {
      assert.deepEqual(DEFAULT_CLAUDE_MODELS, ['claude-opus-5', 'bedrock.claude-opus-5']);
      assert.equal(DEFAULT_CLAUDE_MODEL, 'claude-opus-5');
      assert.equal(DEFAULT_CLAUDE_EFFORT, 'medium');
    });

    it('enforces read-only allowed tools list without destructive tools', () => {
      assert.ok(READ_ONLY_ALLOWED_TOOLS.includes('Read'));
      assert.ok(READ_ONLY_ALLOWED_TOOLS.includes('Glob'));
      assert.ok(READ_ONLY_ALLOWED_TOOLS.includes('LS'));
      assert.ok(READ_ONLY_ALLOWED_TOOLS.includes('Bash(git diff*)'));
      assert.ok(!READ_ONLY_ALLOWED_TOOLS.includes('Write'));
      assert.ok(!READ_ONLY_ALLOWED_TOOLS.includes('Edit'));
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
});
