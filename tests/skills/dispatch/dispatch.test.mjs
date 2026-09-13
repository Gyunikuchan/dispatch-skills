import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, afterEach, mock } from 'node:test';

import {
  detectOrchestrator,
  resolveProvider,
  getCandidateProviders,
  dispatchTask,
  providerProbes,
  providerRunners,
  PROVIDER_ALIASES,
} from '../../../skills/dispatch/scripts/dispatch.mjs';
import {
  KNOWN_PROVIDERS,
  PROJECT_ROOT,
  validateDispatchConfig,
  verifySkillIntegrity,
} from '../../../skills/dispatch/scripts/common.mjs';

describe('dispatch: orchestrator detection & provider resolution', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    Object.keys(process.env).forEach((k) => delete process.env[k]);
    Object.assign(process.env, originalEnv);
    mock.restoreAll();
  });

  const clearOrchestratorEnv = () => {
    delete process.env.ANTIGRAVITY_AGENT;
    delete process.env.ANTIGRAVITY_CONVERSATION_ID;
    delete process.env.ANTIGRAVITY_PROJECT_ID;
    delete process.env.GEMINI_CLI;
    delete process.env.CLAUDE_CODE;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.ANTIGRAVITY_SESSION_ID;
    delete process.env.COPILOT_AGENT;
    delete process.env.COPILOT_CLI_SESSION_ID;
    delete process.env.VSCODE_PID;
    delete process.env.OPENCODE_PORT;
    delete process.env.OPENCODE_AGENT;
  };

  describe('detectOrchestrator', () => {
    for (const [envVar, value] of [
      ['ANTIGRAVITY_AGENT', 'true'],
      ['ANTIGRAVITY_CONVERSATION_ID', 'conv-123'],
      ['ANTIGRAVITY_SESSION_ID', 'sess-456'],
      ['GEMINI_CLI', '1'],
    ]) {
      it(`detects agy when ${envVar} is set`, () => {
        clearOrchestratorEnv();
        process.env[envVar] = value;
        assert.equal(detectOrchestrator(), 'agy');
      });
    }

    for (const [envVar, value] of [
      ['CLAUDECODE', '1'],
      ['CLAUDE_CODE', '1'],
      ['CLAUDE_CODE_SESSION_ID', 'sess-claude-1'],
      ['CLAUDE_SESSION_ID', 'sess-claude-2'],
      ['CLAUDE_CODE_ENTRYPOINT', 'cli'],
    ]) {
      it(`detects claude when ${envVar} is set`, () => {
        clearOrchestratorEnv();
        process.env[envVar] = value;
        assert.equal(detectOrchestrator(), 'claude');
      });
    }

    for (const [envVar, value] of [
      ['COPILOT_AGENT', 'true'],
      ['COPILOT_CLI_SESSION_ID', 'sess-copilot'],
    ]) {
      it(`detects copilot when ${envVar} is set`, () => {
        clearOrchestratorEnv();
        process.env[envVar] = value;
        assert.equal(detectOrchestrator(), 'copilot');
      });
    }

    for (const [envVar, value] of [
      ['OPENCODE_PORT', '4096'],
      ['OPENCODE_AGENT', 'opencode'],
    ]) {
      it(`detects opencode when ${envVar} is set`, () => {
        clearOrchestratorEnv();
        process.env[envVar] = value;
        assert.equal(detectOrchestrator(), 'opencode');
      });
    }

    it('returns null when no orchestrator markers are present', () => {
      clearOrchestratorEnv();
      assert.equal(detectOrchestrator(), null);
    });

    it('does not infer Copilot from a bare VS Code terminal', () => {
      clearOrchestratorEnv();
      process.env.VSCODE_PID = '1234';
      assert.equal(detectOrchestrator(), null);
    });

    it('respects precedence order when multiple platform markers are present', () => {
      clearOrchestratorEnv();
      process.env.ANTIGRAVITY_AGENT = 'true';
      process.env.CLAUDECODE = '1';
      process.env.COPILOT_AGENT = 'true';
      process.env.OPENCODE_PORT = '4096';
      assert.equal(detectOrchestrator(), 'agy');

      clearOrchestratorEnv();
      process.env.CLAUDECODE = '1';
      process.env.COPILOT_AGENT = 'true';
      process.env.OPENCODE_PORT = '4096';
      assert.equal(detectOrchestrator(), 'claude');

      clearOrchestratorEnv();
      process.env.COPILOT_AGENT = 'true';
      process.env.OPENCODE_PORT = '4096';
      assert.equal(detectOrchestrator(), 'copilot');
    });
  });

  describe('resolveProvider & getCandidateProviders', () => {
    it('defines canonical providers and aliases', () => {
      assert.deepEqual(KNOWN_PROVIDERS, ['claude', 'agy', 'copilot', 'opencode']);
      assert.equal(PROVIDER_ALIASES.antigravity, 'agy');
      assert.equal(PROVIDER_ALIASES.claudecode, 'claude');
      assert.equal(PROVIDER_ALIASES['github-copilot'], 'copilot');
    });

    it('prioritizes claude over agy, copilot, and opencode when all are available', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isClaudeAvailable', async () => true);
      mock.method(providerProbes, 'isAgyAvailable', async () => true);
      mock.method(providerProbes, 'isCopilotAvailable', async () => true);
      mock.method(providerProbes, 'isOpencodeAvailable', async () => true);

      const provider = await resolveProvider();
      assert.equal(provider, 'claude');
    });

    it('prioritizes agy when claude is unavailable or orchestrator', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isClaudeAvailable', async () => false);
      mock.method(providerProbes, 'isAgyAvailable', async () => true);
      mock.method(providerProbes, 'isCopilotAvailable', async () => true);
      mock.method(providerProbes, 'isOpencodeAvailable', async () => true);

      const provider = await resolveProvider();
      assert.equal(provider, 'agy');
    });

    it('prioritizes copilot when claude and agy are unavailable', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isClaudeAvailable', async () => false);
      mock.method(providerProbes, 'isAgyAvailable', async () => false);
      mock.method(providerProbes, 'isCopilotAvailable', async () => true);
      mock.method(providerProbes, 'isOpencodeAvailable', async () => true);

      const provider = await resolveProvider();
      assert.equal(provider, 'copilot');
    });

    it('falls back to opencode when claude, agy, and copilot are unavailable', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isClaudeAvailable', async () => false);
      mock.method(providerProbes, 'isAgyAvailable', async () => false);
      mock.method(providerProbes, 'isCopilotAvailable', async () => false);
      mock.method(providerProbes, 'isOpencodeAvailable', async () => true);

      const provider = await resolveProvider();
      assert.equal(provider, 'opencode');
    });

    it('skips orchestrator in alternative cascade', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isOpencodeAvailable', async () => false);
      process.env.CLAUDE_CODE = '1';

      mock.method(providerProbes, 'isAgyAvailable', async () => true);
      mock.method(providerProbes, 'isCopilotAvailable', async () => true);

      const provider = await resolveProvider();
      assert.equal(provider, 'agy');
    });

    it('returns null (subagent fallback) when no alternative agent is available', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isOpencodeAvailable', async () => false);
      process.env.CLAUDE_CODE = '1';

      mock.method(providerProbes, 'isAgyAvailable', async () => false);
      mock.method(providerProbes, 'isCopilotAvailable', async () => false);
      mock.method(providerProbes, 'isClaudeAvailable', async () => true);

      const provider = await resolveProvider();
      assert.equal(provider, null);
    });

    it('falls back to same agent when allowSameAgent is explicitly true', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isOpencodeAvailable', async () => false);
      process.env.CLAUDE_CODE = '1';

      mock.method(providerProbes, 'isAgyAvailable', async () => false);
      mock.method(providerProbes, 'isCopilotAvailable', async () => false);
      mock.method(providerProbes, 'isClaudeAvailable', async () => true);

      const provider = await resolveProvider({ allowSameAgent: true });
      assert.equal(provider, 'claude');
    });

    it('returns null when all providers are unavailable', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isOpencodeAvailable', async () => false);
      mock.method(providerProbes, 'isAgyAvailable', async () => false);
      mock.method(providerProbes, 'isClaudeAvailable', async () => false);
      mock.method(providerProbes, 'isCopilotAvailable', async () => false);

      const provider = await resolveProvider();
      assert.equal(provider, null);
    });

    it('honors explicit provider override regardless of cascade', async () => {
      const provider = await resolveProvider({ explicitProvider: 'copilot' });
      assert.equal(provider, 'copilot');
    });

    it('normalizes provider aliases in explicit provider override', async () => {
      const provider = await resolveProvider({ explicitProvider: 'antigravity' });
      assert.equal(provider, 'agy');
    });

    it('--provider local is rejected as unknown after alias removal', async () => {
      await assert.rejects(
        resolveProvider({ explicitProvider: 'local' }),
        /Unknown provider specified: local/,
      );
    });

    it('returns ordered candidates according to preference: claude > agy > copilot > opencode', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isClaudeAvailable', async () => true);
      mock.method(providerProbes, 'isAgyAvailable', async () => true);
      mock.method(providerProbes, 'isCopilotAvailable', async () => true);
      mock.method(providerProbes, 'isOpencodeAvailable', async () => true);

      const candidates = await getCandidateProviders();
      assert.deepEqual(candidates, ['claude', 'agy', 'copilot', 'opencode']);
    });

    it('returns ordered candidates for fallback passes skipping orchestrator', async () => {
      clearOrchestratorEnv();
      process.env.CLAUDE_CODE = '1';

      mock.method(providerProbes, 'isAgyAvailable', async () => true);
      mock.method(providerProbes, 'isCopilotAvailable', async () => true);
      mock.method(providerProbes, 'isOpencodeAvailable', async () => true);

      const candidates = await getCandidateProviders();
      assert.deepEqual(candidates, ['agy', 'copilot', 'opencode']);
    });
  });

  describe('dispatchTask execution & cascading', () => {
    it('cascades to next candidate when first candidate fails during execution', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isOpencodeAvailable', async () => false);
      process.env.CLAUDE_CODE = '1';

      mock.method(providerProbes, 'isAgyAvailable', async () => true);
      mock.method(providerProbes, 'isCopilotAvailable', async () => true);

      mock.method(providerRunners, 'agy', async () => {
        throw new Error('Auth failed');
      });
      mock.method(providerRunners, 'copilot', async () => ({
        provider: 'copilot',
        stdout: 'Success from copilot fallback',
        exitCode: 0,
        logFile: path.join(os.tmpdir(), 'copilot.log'),
        gitIntegrityViolation: false,
      }));

      const result = await dispatchTask({ prompt: 'Test task' });
      assert.equal(result.provider, 'copilot');
      assert.equal(result.stdout, 'Success from copilot fallback');
    });

    it('throws NO_DISPATCH_AVAILABLE when all candidate passes fail', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isOpencodeAvailable', async () => false);
      process.env.CLAUDE_CODE = '1';

      mock.method(providerProbes, 'isAgyAvailable', async () => true);
      mock.method(providerProbes, 'isCopilotAvailable', async () => false);

      mock.method(providerRunners, 'agy', async () => {
        throw new Error('agy crashed');
      });

      await assert.rejects(
        dispatchTask({ prompt: 'Test task' }),
        /All candidate dispatch agents failed execution/,
      );
    });

    it('surfaces a failed provider gitIntegrityViolation on the succeeding result', async () => {
      // The breach a failed provider caused used to vanish with its discarded result, and the next
      // provider's own baseline absorbed the write.
      clearOrchestratorEnv();
      process.env.CLAUDE_CODE = '1';
      mock.method(providerProbes, 'isOpencodeAvailable', async () => false);
      mock.method(providerProbes, 'isAgyAvailable', async () => true);
      mock.method(providerProbes, 'isCopilotAvailable', async () => true);

      mock.method(providerRunners, 'agy', async () => ({
        provider: 'agy',
        stdout: '',
        exitCode: 1,
        gitIntegrityViolation: true,
        gitIntegrityDetails: 'M src/app.ts',
      }));
      mock.method(providerRunners, 'copilot', async () => ({
        provider: 'copilot',
        stdout: 'Clean review from copilot',
        exitCode: 0,
        gitIntegrityViolation: false,
      }));

      const result = await dispatchTask({ prompt: 'Review' });
      assert.equal(result.provider, 'copilot');
      assert.equal(result.gitIntegrityViolation, true);
      assert.match(result.gitIntegrityDetails, /agy:/);
      assert.match(result.gitIntegrityDetails, /src\/app\.ts/);
    });

    it('surfaces a gitIntegrityViolation on the NO_DISPATCH_AVAILABLE error when every provider fails', async () => {
      clearOrchestratorEnv();
      process.env.CLAUDE_CODE = '1';
      mock.method(providerProbes, 'isOpencodeAvailable', async () => false);
      mock.method(providerProbes, 'isAgyAvailable', async () => true);
      mock.method(providerProbes, 'isCopilotAvailable', async () => false);

      mock.method(providerRunners, 'agy', async () => ({
        provider: 'agy',
        stdout: '',
        exitCode: 1,
        gitIntegrityViolation: true,
        gitIntegrityDetails: '?? leaked.txt',
      }));

      const err = await dispatchTask({ prompt: 'Review' }).then(
        () => null,
        (e) => e,
      );
      assert.ok(err, 'the cascade rejects when nothing answers');
      assert.equal(err.code, 'NO_DISPATCH_AVAILABLE');
      assert.equal(err.gitIntegrityViolation, true);
      assert.match(err.gitIntegrityDetails, /leaked\.txt/);
    });

    it('passes one cascade-level git baseline to every runner', async () => {
      // Per-runner baselines cannot span a write made by an earlier provider.
      clearOrchestratorEnv();
      process.env.CLAUDE_CODE = '1';
      mock.method(providerProbes, 'isOpencodeAvailable', async () => false);
      mock.method(providerProbes, 'isAgyAvailable', async () => true);
      mock.method(providerProbes, 'isCopilotAvailable', async () => true);

      const seen = [];
      mock.method(providerRunners, 'agy', async (opts) => {
        seen.push(opts.initialGitStatus);
        return { provider: 'agy', stdout: '', exitCode: 1 };
      });
      mock.method(providerRunners, 'copilot', async (opts) => {
        seen.push(opts.initialGitStatus);
        return { provider: 'copilot', stdout: 'ok', exitCode: 0 };
      });

      await dispatchTask({ prompt: 'Review' });
      assert.equal(seen.length, 2);
      assert.equal(seen[0], seen[1], 'both runners receive the identical baseline');
    });

    it('aborts before probing when the pinned provider is absent from config', async () => {
      clearOrchestratorEnv();
      process.env.CLAUDE_CODE = '1';
      let probed = false;
      const countProbe = async () => {
        probed = true;
        return true;
      };
      mock.method(providerProbes, 'isAgyAvailable', countProbe);
      mock.method(providerProbes, 'isCopilotAvailable', countProbe);
      mock.method(providerProbes, 'isOpencodeAvailable', countProbe);
      mock.method(providerProbes, 'isClaudeAvailable', countProbe);

      await assert.rejects(
        dispatchTask({
          prompt: 'Review',
          provider: 'copilot',
          config: { platforms: { agy: {} } },
          configPath: 'x.jsonc',
        }),
        /is not configured in/,
      );
      assert.equal(probed, false, 'a config rejection short-circuits before any provider probe');
    });

    it('cascades past a provider that exits 0 with no output', async () => {
      clearOrchestratorEnv();
      process.env.CLAUDECODE = '1';
      mock.method(providerProbes, 'isOpencodeAvailable', async () => false);
      mock.method(providerProbes, 'isAgyAvailable', async () => true);
      mock.method(providerProbes, 'isCopilotAvailable', async () => true);

      mock.method(providerRunners, 'agy', async () => ({
        provider: 'agy',
        stdout: '   ',
        stderr: 'usage limit reached',
        exitCode: 0,
      }));
      mock.method(providerRunners, 'copilot', async () => ({
        provider: 'copilot',
        stdout: '## Summary',
        exitCode: 0,
      }));

      const result = await dispatchTask({ prompt: 'Review' });
      assert.equal(result.provider, 'copilot');
    });

    it('reports why a pinned provider returned nothing instead of passing it off as success', async () => {
      clearOrchestratorEnv();
      process.env.CLAUDECODE = '1';
      mock.method(providerProbes, 'isAgyAvailable', async () => true);
      mock.method(providerRunners, 'agy', async () => ({
        provider: 'agy',
        stdout: '',
        stderr: 'a tool required the "command" permission',
        exitCode: 0,
      }));

      const written = [];
      mock.method(process.stderr, 'write', (chunk) => {
        written.push(String(chunk));
        return true;
      });

      const result = await dispatchTask({ prompt: 'Review', provider: 'agy' });
      assert.equal(result.provider, 'agy');
      assert.equal(result.exitCode, 1);

      const notice = written.join('');
      assert.ok(notice.includes("Provider 'agy' exited 0 with no output"));
      assert.ok(notice.includes('Pinned with --provider'));
    });

    it('returns exitCode 1 when copilot is pinned with --provider and returns nothing (not logged in)', async () => {
      clearOrchestratorEnv();
      process.env.CLAUDECODE = '1';
      mock.method(providerProbes, 'isCopilotAvailable', async () => true);
      mock.method(providerRunners, 'copilot', async () => ({
        provider: 'copilot',
        stdout: '',
        stderr: 'Please run `gh auth login` to authenticate',
        exitCode: 0,
        failureKind: 'auth',
      }));

      const result = await dispatchTask({ prompt: 'Review', provider: 'copilot' });
      assert.equal(result.provider, 'copilot');
      assert.equal(result.exitCode, 1);
    });

    it('returns partial output when every provider fails', async () => {
      clearOrchestratorEnv();
      process.env.CLAUDECODE = '1';
      mock.method(providerProbes, 'isOpencodeAvailable', async () => false);
      mock.method(providerProbes, 'isAgyAvailable', async () => true);
      mock.method(providerProbes, 'isCopilotAvailable', async () => true);

      mock.method(providerRunners, 'agy', async () => ({
        provider: 'agy',
        stdout: '## Partial findings',
        exitCode: 124,
        truncated: 'timeout',
      }));
      mock.method(providerRunners, 'copilot', async () => {
        throw new Error('copilot: command not found');
      });

      const result = await dispatchTask({ prompt: 'Review' });
      assert.equal(result.provider, 'agy');
      assert.equal(result.truncated, 'timeout');
      assert.equal(result.stdout, '## Partial findings');
    });

    it('does not cascade when a provider is pinned', async () => {
      clearOrchestratorEnv();
      const copilotRunner = mock.method(providerRunners, 'copilot', async () => ({
        provider: 'copilot',
        stdout: '',
        exitCode: 0,
      }));
      mock.method(providerRunners, 'agy', async () => ({
        provider: 'agy',
        stdout: '',
        exitCode: 1,
      }));

      const result = await dispatchTask({ prompt: 'Review', provider: 'agy' });
      assert.equal(result.exitCode, 1);
      assert.equal(copilotRunner.mock.calls.length, 0);
    });
  });

  describe('config-driven cascade', () => {
    const CONFIG = {
      config: { platforms: { agy: { model: 'gemini-3.8-flash', effort: 'medium' }, claude: {} } },
      configPath: '/fake/config.default.jsonc',
    };

    it('excludes a platform absent from the loaded config, even if live', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isClaudeAvailable', async () => true);
      mock.method(providerProbes, 'isAgyAvailable', async () => true);
      mock.method(providerProbes, 'isCopilotAvailable', async () => true);
      mock.method(providerProbes, 'isOpencodeAvailable', async () => true);

      const candidates = await getCandidateProviders({ ...CONFIG });
      // Cascade order follows the config's platforms key order (agy, then claude),
      // not the removed hardcoded PREFERENCE_ORDER — copilot/opencode are correctly
      // excluded entirely since they're absent from CONFIG.platforms.
      assert.deepEqual(candidates, ['agy', 'claude']);
    });

    it('uses the config platforms key order as cascade order', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isClaudeAvailable', async () => true);
      mock.method(providerProbes, 'isAgyAvailable', async () => true);

      const candidates = await getCandidateProviders({
        config: { platforms: { agy: {}, claude: {} } },
        configPath: '/fake/config.default.jsonc',
      });
      assert.deepEqual(candidates, ['agy', 'claude']);
    });

    it('errors when a pinned provider is absent from the loaded config', async () => {
      await assert.rejects(
        getCandidateProviders({ explicitProvider: 'copilot', ...CONFIG }),
        /platform "copilot" is not configured in \/fake\/config\.default\.jsonc/,
      );
    });

    it('allows a pinned provider absent from config when noConfig is set', async () => {
      const candidates = await getCandidateProviders({ explicitProvider: 'copilot', noConfig: true });
      assert.deepEqual(candidates, ['copilot']);
    });

    it('resolves per-provider model/effort from config, distinct per candidate', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isOpencodeAvailable', async () => false);
      process.env.CLAUDE_CODE = '1';
      mock.method(providerProbes, 'isAgyAvailable', async () => true);
      mock.method(providerProbes, 'isCopilotAvailable', async () => false);

      const agyRunner = mock.method(providerRunners, 'agy', async (opts) => ({
        provider: 'agy',
        stdout: `model=${opts.model} effort=${opts.effort}`,
        exitCode: 0,
      }));

      const result = await dispatchTask({ prompt: 'Test' });
      assert.equal(agyRunner.mock.calls.length, 1);
      const passedOpts = agyRunner.mock.calls[0].arguments[0];
      // Real config.default.jsonc supplies agy's model/effort since no CLI override was given.
      assert.equal(passedOpts.model, 'gemini-3.8-flash');
      assert.equal(passedOpts.effort, 'medium');
      assert.equal(result.provider, 'agy');
    });

    it('CLI -m/-e override takes precedence over the config entry', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isOpencodeAvailable', async () => false);
      process.env.CLAUDE_CODE = '1';
      mock.method(providerProbes, 'isAgyAvailable', async () => true);
      mock.method(providerProbes, 'isCopilotAvailable', async () => false);

      const agyRunner = mock.method(providerRunners, 'agy', async (opts) => ({
        provider: 'agy',
        stdout: 'ok',
        exitCode: 0,
      }));

      await dispatchTask({ prompt: 'Test', model: 'custom-model', effort: 'low' });
      const passedOpts = agyRunner.mock.calls[0].arguments[0];
      assert.equal(passedOpts.model, 'custom-model');
      assert.equal(passedOpts.effort, 'low');
    });

    it('dispatchTask rejects --no-config without --provider', async () => {
      await assert.rejects(
        dispatchTask({ prompt: 'Test', noConfig: true }),
        /--no-config .* requires --provider/,
      );
    });

    it('dispatchTask honors --no-config alongside --provider, bypassing config membership', async () => {
      mock.method(providerRunners, 'copilot', async () => ({
        provider: 'copilot',
        stdout: 'ok',
        exitCode: 0,
      }));

      const result = await dispatchTask({ prompt: 'Test', provider: 'copilot', noConfig: true });
      assert.equal(result.provider, 'copilot');
    });
  });
});

describe('dispatch: terminal sentinels are set and reach the CLI', () => {
  it('sets NO_CONFIG_REQUIRES_PROVIDER at the dispatchTask throw site', async () => {
    const err = await dispatchTask({ prompt: 'x', noConfig: true }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err, '--no-config without --provider rejects');
    assert.equal(err.code, 'NO_CONFIG_REQUIRES_PROVIDER');
  });

  it('sets INVALID_DISPATCH_CONFIG at the dispatchTask throw site when injected config is malformed', async () => {
    const err = await dispatchTask({
      prompt: 'x',
      config: { platforms: 'not-an-object', bogus: 1 },
      configPath: 'x.jsonc',
    }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err, 'malformed config throws');
    assert.equal(err.code, 'INVALID_DISPATCH_CONFIG');
    assert.match(err.message, /x\.jsonc/);
  });

  it('pins the INVALID_DISPATCH_CONFIG predicate: validateDispatchConfig reports problems', () => {
    const problems = validateDispatchConfig({ platforms: 'not-an-object', bogus: 1 });
    assert.ok(problems.length > 0, 'a malformed config yields a non-empty problems list');
  });

  // Regression pin on the predicate INTEGRITY_VIOLATION wraps: assertSkillIntegrity is
  // unexported and hardcodes SKILL_DIR, so the wrapper itself cannot be driven from a test.
  it('pins the INTEGRITY_VIOLATION predicate: verifySkillIntegrity flags a tampered skill dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-integrity-'));
    try {
      const scripts = path.join(dir, 'scripts');
      fs.mkdirSync(scripts);
      fs.writeFileSync(path.join(scripts, 'x.mjs'), 'export const a = 1;\n');
      fs.writeFileSync(
        path.join(dir, 'skill-hashes.json'),
        JSON.stringify({ 'scripts/x.mjs': 'deadbeef'.repeat(8) }),
      );
      const result = verifySkillIntegrity(dir);
      assert.equal(result.valid, false);
      assert.deepEqual(result.violations, ['scripts/x.mjs']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints the sentinel on stderr end-to-end for `dispatch.mjs --no-config`', () => {
    const script = path.join(
      PROJECT_ROOT,
      'skills',
      'dispatch',
      'scripts',
      'dispatch.mjs',
    );
    // stdin: 'ignore' — an inherited non-TTY stdin makes the child idle readStdin's initial timeout.
    const run = cp.spawnSync(process.execPath, [script, '--no-config', 'x'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: PROJECT_ROOT, // hermetic: never inherit the caller's cwd
    });
    assert.equal(run.error, undefined, `spawn failed outright: ${run.error?.message}`);
    const stderr = run.stderr || '';
    assert.ok(
      !stderr.includes('[INTEGRITY_VIOLATION]'),
      `skill hash manifest is stale — run \`npm run hashes\` before this test. stderr: ${stderr}`,
    );
    assert.match(stderr, /\[dispatch\] ERROR: \[NO_CONFIG_REQUIRES_PROVIDER\]/);
    assert.equal(run.status, 1);
  });
});
