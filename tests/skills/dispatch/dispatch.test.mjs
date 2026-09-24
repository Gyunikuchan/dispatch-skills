import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, before, after, afterEach, mock } from 'node:test';

import {
  resolveProvider as resolveProviderImpl,
  getCandidateProviders as getCandidateProvidersImpl,
  dispatchBatch,
  dispatchTask as dispatchTaskImpl,
  loadBatchFile,
  executeProvider,
  loadResponseSchema,
  normalizeResponseSchema,
  providerProbes,
  providerRunners,
  resolveConfiguredTargets,
  writeDispatchOutput,
} from '../../../skills/dispatch/scripts/dispatch.mjs';
import { verifySkillIntegrity } from '../../../skills/dispatch/scripts/lib/integrity.mjs';
import { PROJECT_ROOT } from '../../../skills/dispatch/scripts/lib/platform.mjs';
import { detectOrchestrator, KNOWN_PROVIDERS, PROVIDER_ALIASES } from '../../../skills/dispatch/scripts/lib/providers.mjs';
import { resolveReadDelegates, validateConfig } from '../../../skills/dispatch/scripts/lib/config.mjs';

/** Strict read-provider wrapper: one target per candidate, each a single `low` level. */
const targetsOf = (...candidates) => ({ targets: candidates.map(candidate => ({ low: candidate })) });

const TEST_DISPATCH_CONFIG = {
  'read-delegates': {
    claude: targetsOf({ model: 'claude-opus-5', effort: 'low' }),
    agy: targetsOf({ model: 'gemini-3.8-flash', effort: 'medium' }),
    copilot: targetsOf({ model: 'gpt-5.6-luna', effort: 'max' }),
    opencode: targetsOf(
      { model: 'opencode-go/glm-5.3-flash', effort: 'max' },
      { model: 'opencode-go/mistral-small', effort: 'max' },
      { model: 'lmstudio/qwen3.8-27b-ridge', effort: 'max' },
    ),
  },
};
const TEST_DISPATCH_CONFIG_ARGS = {
  config: TEST_DISPATCH_CONFIG,
  configPath: 'config.jsonc',
};

const resolveProvider = (options = {}) => resolveProviderImpl({ ...TEST_DISPATCH_CONFIG_ARGS, ...options });
const getCandidateProviders = (options = {}) => getCandidateProvidersImpl({ ...TEST_DISPATCH_CONFIG_ARGS, ...options });
const dispatchTask = (options = {}) => dispatchTaskImpl({ ...TEST_DISPATCH_CONFIG_ARGS, ...options });

// SECTION: Configured targets and provider selection

describe('configured target resolution', () => {
  it('takes the level-resolved { platforms } map from resolveReadDelegates', () => {
    const config = {
      'read-delegates': {
        claude: { targets: [{ low: { model: 'claude-opus-5' }, high: { model: 'claude-fable-5.1' } }] },
        agy: { targets: [{ low: { model: 'gemini-3.7-flash' }, high: { model: 'gemini-3.8-flash' } }, { high: { model: 'gemini-3.7-pro' } }] },
      },
    };
    const high = resolveConfiguredTargets(resolveReadDelegates(config, 'high'), 'claude');
    assert.deepEqual(high.map((t) => `${t.platform}:${t.candidateIndex}:${t.model}`), [
      'agy:0:gemini-3.8-flash',
      'agy:1:gemini-3.7-pro',
      'claude:0:claude-fable-5.1',
    ]);
    const low = resolveConfiguredTargets(resolveReadDelegates(config, 'low'), 'claude');
    assert.deepEqual(low.map((t) => `${t.platform}:${t.model}`), ['agy:gemini-3.7-flash', 'agy:gemini-3.7-pro', 'claude:claude-opus-5']);
  });

  it('preserves config order while shifting the orchestrator and exact model match back', () => {
    const targets = resolveConfiguredTargets(
      {
        platforms: {
          claude: [
            { model: 'claude-opus-5', effort: 'high' },
            { model: 'claude-sonnet-5', effort: 'medium' },
          ],
          agy: [{ model: 'gemini-3.8-flash' }],
          opencode: [
            { model: 'glm-5.3-flash' },
            { model: 'mistral-small' },
          ],
        },
      },
      'claude',
      'claude-opus-5',
    );

    assert.deepEqual(targets, [
      { platform: 'agy', candidateIndex: 0, model: 'gemini-3.8-flash' },
      { platform: 'opencode', candidateIndex: 0, model: 'glm-5.3-flash', sandbox: true },
      { platform: 'opencode', candidateIndex: 1, model: 'mistral-small', sandbox: true },
      {
        platform: 'claude',
        candidateIndex: 1,
        model: 'claude-sonnet-5',
        effort: 'medium',
        sandbox: true,
      },
      {
        platform: 'claude',
        candidateIndex: 0,
        model: 'claude-opus-5',
        effort: 'high',
        sandbox: true,
      },
    ]);
  });
});

describe('orchestrator detection and provider resolution', () => {
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

    it('cascades to orchestrator as a last resort when no alternative agent is available', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isOpencodeAvailable', async () => false);
      process.env.CLAUDE_CODE = '1';

      mock.method(providerProbes, 'isAgyAvailable', async () => false);
      mock.method(providerProbes, 'isCopilotAvailable', async () => false);
      mock.method(providerProbes, 'isClaudeAvailable', async () => true);

      const provider = await resolveProvider();
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

    it('probes only providers allowed by a native capability', async () => {
      const calls = [];
      for (const [name, probe] of [
        ['claude', 'isClaudeAvailable'],
        ['agy', 'isAgyAvailable'],
        ['copilot', 'isCopilotAvailable'],
        ['opencode', 'isOpencodeAvailable'],
      ]) {
        mock.method(providerProbes, probe, async () => {
          calls.push(name);
          return true;
        });
      }
      const providers = await getCandidateProviders({
        allowedProviders: new Set(['claude']),
      });
      assert.deepEqual(providers, ['claude']);
      assert.deepEqual(calls, ['claude']);
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

    it('returns ordered candidates for fallback passes appending orchestrator last', async () => {
      clearOrchestratorEnv();
      process.env.CLAUDE_CODE = '1';

      mock.method(providerProbes, 'isClaudeAvailable', async () => true);
      mock.method(providerProbes, 'isAgyAvailable', async () => true);
      mock.method(providerProbes, 'isCopilotAvailable', async () => true);
      mock.method(providerProbes, 'isOpencodeAvailable', async () => true);

      const candidates = await getCandidateProviders();
      assert.deepEqual(candidates, ['agy', 'copilot', 'opencode', 'claude']);
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
        const error = new Error('Auth failed');
        error.metricsAttempts = [{ provider: 'agy' }];
        throw error;
      });
      mock.method(providerRunners, 'copilot', async () => ({
        provider: 'copilot',
        stdout: 'Success from copilot fallback',
        exitCode: 0,
        logFile: path.join(os.tmpdir(), 'copilot.log'),
        metricsAttempts: [{ provider: 'copilot' }],
        effectiveAttempt: 0,
      }));

      const result = await dispatchTask({ prompt: 'Test task' });
      assert.equal(result.provider, 'copilot');
      assert.equal(result.stdout, 'Success from copilot fallback');
      assert.deepEqual(result.metricsAttempts.map((attempt) => attempt.provider), ['agy', 'copilot']);
      assert.equal(result.effectiveAttempt, 1);
    });

    it('throws NO_DISPATCH_AVAILABLE when all candidate passes fail', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isClaudeAvailable', async () => false);
      mock.method(providerProbes, 'isOpencodeAvailable', async () => false);
      process.env.CLAUDE_CODE = '1';

      mock.method(providerProbes, 'isAgyAvailable', async () => true);
      mock.method(providerProbes, 'isCopilotAvailable', async () => false);

      mock.method(providerRunners, 'agy', async () => {
        const error = new Error('agy crashed');
        error.metricsAttempts = [{ provider: 'agy' }];
        throw error;
      });

      await assert.rejects(
        dispatchTask({ prompt: 'Test task' }),
        (error) => {
          assert.match(error.message, /All candidate dispatch agents failed execution/);
          assert.deepEqual(error.metricsAttempts, [{ provider: 'agy' }]);
          return true;
        },
      );
    });

    it('names the host subagent and the prompt file in the native-fallback guidance', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isClaudeAvailable', async () => false);
      mock.method(providerProbes, 'isOpencodeAvailable', async () => false);
      mock.method(providerProbes, 'isCopilotAvailable', async () => false);
      mock.method(providerProbes, 'isAgyAvailable', async () => true);
      mock.method(providerRunners, 'agy', async () => {
        throw new Error('agy crashed');
      });

      // Cross-platform: providers.md routes this to the FAILED platform's subagent, not the host's.
      await assert.rejects(
        dispatchTask({
          prompt: 'Test task',
          orchestrator: 'copilot',
          promptFile: 'tmp/brief.md',
          files: ['tmp/walkthrough.md'],
        }),
        (error) => {
          assert.match(error.message, /Do not answer inline and do not re-enter dispatch/);
          assert.match(error.message, /Cross-platform failure \(agy failed, host is copilot\)/);
          assert.match(error.message, /each failed platform's in-process native subagent/);
          assert.doesNotMatch(error.message, /copilot's own native subagent/);
          assert.match(error.message, /read this prompt file in full and follow it as the authoritative instructions: tmp\/brief\.md/i);
          assert.match(error.message, /attachment paths: tmp\/walkthrough\.md/);
          assert.match(error.message, /prune them once this fallback consumes them or reaches a terminal outcome/);
          return true;
        },
      );

      // Same-platform: the failed target is the host, which must take the native branch immediately.
      await assert.rejects(
        dispatchTask({ prompt: 'Test task', orchestrator: 'agy' }),
        (error) => {
          assert.match(error.message, /Same-platform failure \(agy\): launch agy's own native subagent/);
          assert.match(error.message, /default subagent when the platform defines no named types/);
          assert.match(error.message, /Reuse the exact prompt and attachments prepared for this dispatch/);
          return true;
        },
      );
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
          config: { 'read-delegates': { agy: targetsOf({ model: 'agy-model' }) } },
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
      // Unmocked, a live local claude is appended as the orchestrator candidate and really spawned.
      mock.method(providerProbes, 'isClaudeAvailable', async () => false);
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

    it('rejects malformed provider specs before invocation', async () => {
      await assert.rejects(
        () => dispatchTask({ prompt: 'Review', provider: 'claude:' }),
        /Invalid --provider.*end with a colon/,
      );
      await assert.rejects(
        () => dispatchTask({ prompt: 'Review', provider: '   ' }),
        /Invalid --provider.*cannot be empty/,
      );
    });

    it('rejects whitespace-only and colon-suffixed model overrides before invocation', async () => {
      await assert.rejects(
        () => dispatchTask({ prompt: 'Review', provider: 'claude', model: '   ' }),
        /Invalid --model.*cannot be empty/,
      );
      await assert.rejects(
        () => dispatchTask({ prompt: 'Review', provider: 'claude', model: 'claude:' }),
        /Invalid --model.*end with a colon/,
      );
    });

    it('rejects whitespace-only effort overrides before invocation', async () => {
      await assert.rejects(
        () => dispatchTask({ prompt: 'Review', provider: 'claude', effort: '   ' }),
        /Invalid --effort.*cannot be empty/,
      );
    });
  });

  describe('config-driven cascade', () => {
    const CONFIG = {
      config: { 'read-delegates': { agy: targetsOf({ model: 'gemini-3.8-flash', effort: 'medium' }), claude: targetsOf({ model: 'claude-model' }) } },
      configPath: '/fake/config.jsonc',
    };

    it('excludes a platform absent from the loaded config, even if live', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isClaudeAvailable', async () => true);
      mock.method(providerProbes, 'isAgyAvailable', async () => true);
      mock.method(providerProbes, 'isCopilotAvailable', async () => true);
      mock.method(providerProbes, 'isOpencodeAvailable', async () => true);

      const candidates = await getCandidateProviders({ ...CONFIG });
      // Cascade order follows the config's read-delegates key order (agy, then claude),
      // not the removed hardcoded PREFERENCE_ORDER — copilot/opencode are correctly
      // excluded entirely since they're absent from CONFIG['read-delegates'].
      assert.deepEqual(candidates, ['agy', 'claude']);
    });

    it('uses the config read-delegates key order as cascade order', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isClaudeAvailable', async () => true);
      mock.method(providerProbes, 'isAgyAvailable', async () => true);

      const candidates = await getCandidateProviders({
        config: { 'read-delegates': { agy: targetsOf({ model: 'agy-model' }), claude: targetsOf({ model: 'claude-model' }) } },
        configPath: '/fake/config.jsonc',
      });
      assert.deepEqual(candidates, ['agy', 'claude']);
    });

    it('errors when a pinned provider is absent from the loaded config', async () => {
      await assert.rejects(
        getCandidateProviders({ explicitProvider: 'copilot', ...CONFIG }),
        /platform "copilot" is not configured in \/fake\/config\.jsonc/,
      );
    });

    it('tags a pinned recognized provider absent from config with PLATFORM_NOT_CONFIGURED', async () => {
      await assert.rejects(
        getCandidateProviders({
          explicitProvider: 'claude',
          config: { 'read-delegates': { agy: targetsOf({ model: 'agy-model' }) } },
          configPath: '/fake/agy-only.jsonc',
        }),
        (err) => err.code === 'PLATFORM_NOT_CONFIGURED' && /platform "claude" is not configured/.test(err.message),
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
      // The inline TEST_DISPATCH_CONFIG fixture supplies agy's model/effort since no CLI override was given.
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

    it('passes the Copilot sandbox setting from config to the runner', async () => {
      clearOrchestratorEnv();
      const copilotRunner = mock.method(providerRunners, 'copilot', async () => ({
        provider: 'copilot',
        stdout: 'ok',
        exitCode: 0,
      }));
      mock.method(providerProbes, 'isCopilotAvailable', async () => true);

      await dispatchTask({
        prompt: 'Test',
        provider: 'copilot',
        config: {
          'read-delegates': {
            copilot: { sandbox: true, ...targetsOf({ model: 'gpt-5.6-luna', effort: 'max' }) },
          },
        },
        configPath: 'custom.jsonc',
      });

      assert.equal(copilotRunner.mock.calls[0].arguments[0].sandbox, true);
    });

    it('defaults the Copilot sandbox setting to true when config omits it', async () => {
      clearOrchestratorEnv();
      const copilotRunner = mock.method(providerRunners, 'copilot', async () => ({
        provider: 'copilot',
        stdout: 'ok',
        exitCode: 0,
      }));
      mock.method(providerProbes, 'isCopilotAvailable', async () => true);

      await dispatchTask({
        prompt: 'Test',
        provider: 'copilot',
        config: {
          'read-delegates': {
            copilot: targetsOf({ model: 'gpt-5.6-luna', effort: 'max' }),
          },
        },
        configPath: 'custom.jsonc',
      });

      assert.equal(copilotRunner.mock.calls[0].arguments[0].sandbox, true);
    });

    it('passes an explicit false Copilot sandbox setting through to the runner', async () => {
      clearOrchestratorEnv();
      const copilotRunner = mock.method(providerRunners, 'copilot', async () => ({
        provider: 'copilot',
        stdout: 'ok',
        exitCode: 0,
      }));
      mock.method(providerProbes, 'isCopilotAvailable', async () => true);

      await dispatchTask({
        prompt: 'Test',
        provider: 'copilot',
        config: {
          'read-delegates': {
            copilot: { sandbox: false, ...targetsOf({ model: 'gpt-5.6-luna', effort: 'max' }) },
          },
        },
        configPath: 'custom.jsonc',
      });

      assert.equal(copilotRunner.mock.calls[0].arguments[0].sandbox, false);
    });

    it('allows the programmatic sandbox override to disable the config default', async () => {
      clearOrchestratorEnv();
      const copilotRunner = mock.method(providerRunners, 'copilot', async () => ({
        provider: 'copilot',
        stdout: 'ok',
        exitCode: 0,
      }));
      mock.method(providerProbes, 'isCopilotAvailable', async () => true);

      await dispatchTask({
        prompt: 'Test',
        provider: 'copilot',
        sandbox: false,
        config: { 'read-delegates': { copilot: targetsOf({ model: 'gpt-5.6-luna', effort: 'max' }) } },
        configPath: 'custom.jsonc',
      });

      assert.equal(copilotRunner.mock.calls[0].arguments[0].sandbox, false);
    });

    it('passes the Claude sandbox setting from config to the runner', async () => {
      clearOrchestratorEnv();
      const claudeRunner = mock.method(providerRunners, 'claude', async () => ({
        provider: 'claude',
        stdout: 'ok',
        exitCode: 0,
      }));
      mock.method(providerProbes, 'isClaudeAvailable', async () => true);

      await dispatchTask({
        prompt: 'Test',
        provider: 'claude',
        config: {
          'read-delegates': {
            claude: { sandbox: true, ...targetsOf({ model: 'claude-sonnet-5', effort: 'medium' }) },
          },
        },
        configPath: 'custom.jsonc',
      });

      assert.equal(claudeRunner.mock.calls[0].arguments[0].sandbox, true);
    });

    it('defaults the Claude sandbox setting to true when config omits it', async () => {
      clearOrchestratorEnv();
      const claudeRunner = mock.method(providerRunners, 'claude', async () => ({
        provider: 'claude',
        stdout: 'ok',
        exitCode: 0,
      }));
      mock.method(providerProbes, 'isClaudeAvailable', async () => true);

      await dispatchTask({
        prompt: 'Test',
        provider: 'claude',
        config: { 'read-delegates': { claude: targetsOf({ model: 'claude-sonnet-5', effort: 'medium' }) } },
        configPath: 'custom.jsonc',
      });

      assert.equal(claudeRunner.mock.calls[0].arguments[0].sandbox, true);
    });

    it('passes an explicit false Claude sandbox setting through to the runner', async () => {
      clearOrchestratorEnv();
      const claudeRunner = mock.method(providerRunners, 'claude', async () => ({
        provider: 'claude',
        stdout: 'ok',
        exitCode: 0,
      }));
      mock.method(providerProbes, 'isClaudeAvailable', async () => true);

      await dispatchTask({
        prompt: 'Test',
        provider: 'claude',
        config: { 'read-delegates': { claude: { sandbox: false, ...targetsOf({ model: 'claude-sonnet-5', effort: 'medium' }) } } },
        configPath: 'custom.jsonc',
      });

      assert.equal(claudeRunner.mock.calls[0].arguments[0].sandbox, false);
    });

    it('allows the programmatic sandbox override to disable the Claude config default', async () => {
      clearOrchestratorEnv();
      const claudeRunner = mock.method(providerRunners, 'claude', async () => ({
        provider: 'claude',
        stdout: 'ok',
        exitCode: 0,
      }));
      mock.method(providerProbes, 'isClaudeAvailable', async () => true);

      await dispatchTask({
        prompt: 'Test',
        provider: 'claude',
        sandbox: false,
        config: { 'read-delegates': { claude: targetsOf({ model: 'claude-sonnet-5', effort: 'medium' }) } },
        configPath: 'custom.jsonc',
      });

      assert.equal(claudeRunner.mock.calls[0].arguments[0].sandbox, false);
    });

    it('passes a Copilot sandbox-unsupported answer through without the retired fail-closed override', async () => {
      clearOrchestratorEnv();
      mock.method(providerRunners, 'copilot', async () => ({
        provider: 'copilot',
        stdout: 'answer without sandbox',
        stderr: 'Warning: --sandbox was ignored because the sandbox feature is unavailable',
        exitCode: 0,
        failureKind: 'sandbox-unsupported',
      }));
      mock.method(providerProbes, 'isCopilotAvailable', async () => true);

      const result = await dispatchTask({
        prompt: 'Test',
        provider: 'copilot',
        config: { 'read-delegates': { copilot: targetsOf({ model: 'copilot-model' }) } },
        configPath: 'custom.jsonc',
      });
      // Warn-and-run: the runner owns the downgrade, so dispatch never forces exit 1 here.
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, 'answer without sandbox');
    });

    it('cascades across multiple candidate models within a platform array', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isOpencodeAvailable', async () => true);

      const opencodeConfig = {
        'read-delegates': {
          opencode: targetsOf(
            { model: 'glm-5.3-flash', effort: 'max' },
            { model: 'mistral-small', effort: 'max' },
            { model: 'lmstudio/qwen3.8-27b-ridge', effort: 'medium' },
          ),
        },
      };

      const calls = [];
      mock.method(providerRunners, 'opencode', async (opts) => {
        calls.push({ model: opts.model, effort: opts.effort });
        if (opts.model === 'glm-5.3-flash') {
          return { provider: 'opencode', stdout: '', exitCode: 1, failureKind: 'model-not-loaded' };
        }
        if (opts.model === 'mistral-small') {
          return { provider: 'opencode', stdout: '', exitCode: 1, failureKind: 'quota' };
        }
        return { provider: 'opencode', stdout: 'Success from local LLM', exitCode: 0 };
      });

      const result = await dispatchTask({ prompt: 'Test task', config: opencodeConfig, configPath: 'custom.jsonc' });
      assert.equal(result.provider, 'opencode');
      assert.equal(result.stdout, 'Success from local LLM');
      assert.equal(calls.length, 3);
      assert.deepEqual(calls, [
        { model: 'glm-5.3-flash', effort: 'max' },
        { model: 'mistral-small', effort: 'max' },
        { model: 'lmstudio/qwen3.8-27b-ridge', effort: 'medium' },
      ]);
    });

    it('cascades within a pinned platform array but stops without cascading to other providers', async () => {
      clearOrchestratorEnv();
      const multiConfig = {
        'read-delegates': {
          opencode: targetsOf(
            { model: 'glm-5.3-flash', effort: 'medium' },
            { model: 'mistral-small', effort: 'medium' },
          ),
          copilot: targetsOf({ model: 'gpt-5.6-luna', effort: 'medium' }),
        },
      };

      const opencodeCalls = [];
      mock.method(providerRunners, 'opencode', async (opts) => {
        opencodeCalls.push(opts.model);
        return { provider: 'opencode', stdout: '', exitCode: 1, failureKind: 'quota' };
      });

      const copilotRunner = mock.method(providerRunners, 'copilot', async () => ({
        provider: 'copilot',
        stdout: 'Should not run',
        exitCode: 0,
      }));

      const result = await dispatchTask({
        prompt: 'Test',
        provider: 'opencode',
        config: multiConfig,
        configPath: 'custom.jsonc',
      });

      assert.equal(result.provider, 'opencode');
      assert.equal(result.exitCode, 1);
      assert.deepEqual(opencodeCalls, ['glm-5.3-flash', 'mistral-small']);
      assert.equal(copilotRunner.mock.calls.length, 0, 'did not cascade to copilot');
    });

    it('executes exactly one configured target by index with its provider sandbox setting', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isClaudeAvailable', async () => true);
      const calls = [];
      mock.method(providerRunners, 'claude', async (opts) => {
        calls.push({ model: opts.model, effort: opts.effort, sandbox: opts.sandbox });
        return { provider: 'claude', stdout: 'selected', exitCode: 0 };
      });

      const result = await dispatchTask({
        prompt: 'Test',
        provider: 'claude',
        candidateIndex: 1,
        config: {
          'read-delegates': {
            claude: {
              sandbox: false,
              ...targetsOf({ model: 'claude-opus-5', effort: 'low' }, { model: 'claude-sonnet-5', effort: 'high' }),
            },
          },
        },
        configPath: 'custom.jsonc',
      });

      assert.equal(result.stdout, 'selected');
      assert.deepEqual(calls, [{ model: 'claude-sonnet-5', effort: 'high', sandbox: false }]);
    });

    it('rejects an out-of-range configured candidate index', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isClaudeAvailable', async () => true);
      await assert.rejects(
        dispatchTask({
          prompt: 'Test',
          provider: 'claude',
          candidateIndex: 2,
          config: { 'read-delegates': { claude: targetsOf({ model: 'claude-opus-5', effort: 'medium' }) } },
          configPath: 'custom.jsonc',
        }),
        /candidate index 2 is out of range/,
      );
    });

    it('diversity-sorts the unpinned cascade: first entry per platform, then repeats, orchestrator last', async () => {
      clearOrchestratorEnv();
      for (const probe of ['isClaudeAvailable', 'isAgyAvailable', 'isCopilotAvailable', 'isOpencodeAvailable']) {
        mock.method(providerProbes, probe, async () => true);
      }
      const multiConfig = {
        'read-delegates': {
          claude: targetsOf({ model: 'claude-opus-5', effort: 'medium' }),
          opencode: targetsOf({ model: 'glm-5.3-flash', effort: 'medium' }, { model: 'mistral-small', effort: 'medium' }, { model: 'qwen3.8-27b', effort: 'medium' }),
          agy: targetsOf({ model: 'gemini-3.8-flash', effort: 'medium' }),
          copilot: targetsOf({ model: 'gpt-5.6-luna', effort: 'medium' }),
        },
      };

      const calls = [];
      const fail = (provider) => async (opts) => {
        calls.push(opts.model);
        return { provider, stdout: '', exitCode: 1, failureKind: 'quota' };
      };
      for (const provider of ['claude', 'agy', 'copilot', 'opencode']) {
        mock.method(providerRunners, provider, fail(provider));
      }

      await dispatchTask({ prompt: 'Test', orchestrator: 'claude', config: multiConfig, configPath: 'custom.jsonc' }).catch(() => {});
      // opencode is keyed first, yet its second and third models yield to agy and copilot.
      assert.deepEqual(calls, [
        'glm-5.3-flash',
        'gemini-3.8-flash',
        'gpt-5.6-luna',
        'mistral-small',
        'qwen3.8-27b',
        'claude-opus-5',
      ]);
    });

    it('normalizes an alias orchestrator so its platform still sorts last', async () => {
      clearOrchestratorEnv();
      for (const probe of ['isClaudeAvailable', 'isAgyAvailable', 'isCopilotAvailable', 'isOpencodeAvailable']) {
        mock.method(providerProbes, probe, async () => true);
      }
      const calls = [];
      for (const provider of ['claude', 'agy']) {
        mock.method(providerRunners, provider, async () => {
          calls.push(provider);
          return { provider, stdout: '', exitCode: 1, failureKind: 'quota' };
        });
      }
      await dispatchTask({
        prompt: 'Test',
        orchestrator: 'claudecode',
        config: { 'read-delegates': { claude: targetsOf({ model: 'claude-model' }), agy: targetsOf({ model: 'agy-model' }) } },
        configPath: 'c.jsonc',
      }).catch(() => {});
      assert.deepEqual(calls, ['agy', 'claude']);
    });

    it('demotes same platform + model candidate to dead last behind alternative models on the orchestrator platform', async () => {
      clearOrchestratorEnv();
      for (const probe of ['isClaudeAvailable', 'isAgyAvailable', 'isCopilotAvailable', 'isOpencodeAvailable']) {
        mock.method(providerProbes, probe, async () => true);
      }
      const multiConfig = {
        'read-delegates': {
          claude: targetsOf(
            { model: 'claude-opus-5', effort: 'medium' },
            { model: 'claude-sonnet-5', effort: 'medium' },
          ),
          agy: targetsOf({ model: 'gemini-3.8-flash', effort: 'medium' }),
          copilot: targetsOf({ model: 'gpt-5.6-luna', effort: 'medium' }),
        },
      };

      const calls = [];
      const fail = (provider) => async (opts) => {
        calls.push({ provider, model: opts.model, effort: opts.effort });
        return { provider, stdout: '', exitCode: 1, failureKind: 'quota' };
      };
      for (const provider of ['claude', 'agy', 'copilot']) {
        mock.method(providerRunners, provider, fail(provider));
      }

      await dispatchTask({
        prompt: 'Test',
        orchestrator: 'claude',
        orchestratorModel: 'claude-opus-5',
        config: multiConfig,
        configPath: 'custom.jsonc',
      }).catch(() => {});

      // Externals first (agy, copilot), then claude with different model (sonnet-5), then exact match (opus-5) last
      assert.deepEqual(calls.map((c) => `${c.provider}:${c.model}`), [
        'agy:gemini-3.8-flash',
        'copilot:gpt-5.6-luna',
        'claude:claude-sonnet-5',
        'claude:claude-opus-5',
      ]);
    });

    it('demotes same platform + model match regardless of reasoning effort (effort neutrality)', async () => {
      clearOrchestratorEnv();
      for (const probe of ['isClaudeAvailable', 'isAgyAvailable']) {
        mock.method(providerProbes, probe, async () => true);
      }
      const config = {
        'read-delegates': {
          claude: targetsOf(
            { model: 'claude-opus-5', effort: 'low' },
            { model: 'claude-sonnet-5', effort: 'high' },
          ),
          agy: targetsOf({ model: 'gemini-3.8-flash', effort: 'medium' }),
        },
      };

      const calls = [];
      for (const provider of ['claude', 'agy']) {
        mock.method(providerRunners, provider, async (opts) => {
          calls.push({ provider, model: opts.model, effort: opts.effort });
          return { provider, stdout: '', exitCode: 1, failureKind: 'quota' };
        });
      }

      // Orchestrator has effort "max", candidate has effort "low" — should still match and demote
      await dispatchTask({
        prompt: 'Test',
        orchestrator: 'claude',
        orchestratorModel: 'claude-opus-5',
        config,
        configPath: 'custom.jsonc',
      }).catch(() => {});

      assert.deepEqual(calls.map((c) => `${c.provider}:${c.model}`), [
        'agy:gemini-3.8-flash',
        'claude:claude-sonnet-5',
        'claude:claude-opus-5',
      ]);
    });

    it('preserves baseline group order when orchestratorModel is null (undetected)', async () => {
      clearOrchestratorEnv();
      for (const probe of ['isClaudeAvailable', 'isAgyAvailable']) {
        mock.method(providerProbes, probe, async () => true);
      }
      const config = {
        'read-delegates': {
          claude: targetsOf(
            { model: 'claude-opus-5', effort: 'medium' },
            { model: 'claude-sonnet-5', effort: 'medium' },
          ),
          agy: targetsOf({ model: 'gemini-3.8-flash', effort: 'medium' }),
        },
      };

      const calls = [];
      for (const provider of ['claude', 'agy']) {
        mock.method(providerRunners, provider, async (opts) => {
          calls.push(`${provider}:${opts.model}`);
          return { provider, stdout: '', exitCode: 1, failureKind: 'quota' };
        });
      }

      await dispatchTask({
        prompt: 'Test',
        orchestrator: 'claude',
        orchestratorModel: null,
        config,
        configPath: 'custom.jsonc',
      }).catch(() => {});

      assert.deepEqual(calls, [
        'agy:gemini-3.8-flash',
        'claude:claude-opus-5',
        'claude:claude-sonnet-5',
      ]);
    });

    it('pinned cascade bypasses orchestrator demotion', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isClaudeAvailable', async () => true);
      const config = {
        'read-delegates': {
          claude: targetsOf(
            { model: 'claude-opus-5', effort: 'medium' },
            { model: 'claude-sonnet-5', effort: 'medium' },
          ),
        },
      };

      const calls = [];
      mock.method(providerRunners, 'claude', async (opts) => {
        calls.push(opts.model);
        return { provider: 'claude', stdout: '', exitCode: 1, failureKind: 'quota' };
      });

      await dispatchTask({
        prompt: 'Test',
        provider: 'claude',
        orchestratorModel: 'claude-opus-5',
        config,
        configPath: 'custom.jsonc',
      }).catch(() => {});

      // Pinned walks candidate array in original order
      assert.deepEqual(calls, ['claude-opus-5', 'claude-sonnet-5']);
    });

    it('falls through to environment model detection when orchestratorModel is omitted (undefined)', async () => {
      clearOrchestratorEnv();
      process.env.CLAUDE_MODEL = 'claude-opus-5';
      process.env.CLAUDECODE = '1';

      for (const probe of ['isClaudeAvailable', 'isAgyAvailable']) {
        mock.method(providerProbes, probe, async () => true);
      }
      const config = {
        'read-delegates': {
          claude: targetsOf(
            { model: 'claude-opus-5', effort: 'medium' },
            { model: 'claude-sonnet-5', effort: 'medium' },
          ),
          agy: targetsOf({ model: 'gemini-3.8-flash', effort: 'medium' }),
        },
      };

      const calls = [];
      for (const provider of ['claude', 'agy']) {
        mock.method(providerRunners, provider, async (opts) => {
          calls.push(`${provider}:${opts.model}`);
          return { provider, stdout: '', exitCode: 1, failureKind: 'quota' };
        });
      }

      // orchestratorModel omitted entirely -> defaults to undefined -> detects CLAUDE_MODEL -> demotes opus-5 to end
      await dispatchTask({
        prompt: 'Test',
        config,
        configPath: 'custom.jsonc',
      }).catch(() => {});

      assert.deepEqual(calls, [
        'agy:gemini-3.8-flash',
        'claude:claude-sonnet-5',
        'claude:claude-opus-5',
      ]);
    });

    it('CLI -m override still yields one candidate per platform in the unpinned cascade', async () => {
      clearOrchestratorEnv();
      for (const probe of ['isClaudeAvailable', 'isAgyAvailable', 'isCopilotAvailable', 'isOpencodeAvailable']) {
        mock.method(providerProbes, probe, async () => true);
      }
      const multiConfig = {
        'read-delegates': {
          opencode: targetsOf({ model: 'glm-5.3-flash', effort: 'medium' }, { model: 'mistral-small', effort: 'medium' }),
          agy: targetsOf({ model: 'gemini-3.8-flash', effort: 'medium' }),
        },
      };
      const calls = [];
      for (const provider of ['agy', 'opencode']) {
        mock.method(providerRunners, provider, async (opts) => {
          calls.push(`${provider}:${opts.model}`);
          return { provider, stdout: '', exitCode: 1, failureKind: 'quota' };
        });
      }
      await dispatchTask({ prompt: 'Test', model: 'm', orchestrator: 'claude', config: multiConfig, configPath: 'c.jsonc' }).catch(() => {});
      assert.deepEqual(calls, ['opencode:m', 'agy:m']);
    });

    it('CLI -m flag collapses candidate array to a single target invocation', async () => {
      clearOrchestratorEnv();
      const multiConfig = {
        'read-delegates': {
          opencode: targetsOf(
            { model: 'glm-5.3-flash', effort: 'medium' },
            { model: 'mistral-small', effort: 'medium' },
          ),
        },
      };

      const opencodeCalls = [];
      mock.method(providerRunners, 'opencode', async (opts) => {
        opencodeCalls.push(opts.model);
        return { provider: 'opencode', stdout: 'Success with single override', exitCode: 0 };
      });

      const result = await dispatchTask({
        prompt: 'Test',
        provider: 'opencode',
        model: 'custom-override',
        config: multiConfig,
        configPath: 'custom.jsonc',
      });

      assert.equal(result.stdout, 'Success with single override');
      assert.deepEqual(opencodeCalls, ['custom-override']);
    });

    it('resolves read-delegates at options.level, defaulting to medium', async () => {
      clearOrchestratorEnv();
      mock.method(providerProbes, 'isAgyAvailable', async () => true);
      const seen = [];
      mock.method(providerRunners, 'agy', async (opts) => {
        seen.push(opts.model);
        return { provider: 'agy', stdout: 'ok', exitCode: 0 };
      });
      const config = { 'read-delegates': { agy: { targets: [{
        low: { model: 'gemini-3.7-flash', effort: 'medium' },
        high: { model: 'gemini-3.8-flash', effort: 'medium' },
      }] } } };
      await dispatchTask({ prompt: 'Test', provider: 'agy', config, configPath: 'c.jsonc', level: 'high' });
      await dispatchTask({ prompt: 'Test', provider: 'agy', config, configPath: 'c.jsonc' });
      await dispatchTask({ prompt: 'Test', provider: 'agy', config, configPath: 'c.jsonc', level: 'low' });
      assert.deepEqual(seen, ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.7-flash']);
    });

    it('rejects an unknown level before probing', async () => {
      clearOrchestratorEnv();
      await assert.rejects(
        dispatchTask({ prompt: 'Test', provider: 'agy', level: 'ultra' }),
        /Unknown level "ultra"/,
      );
    });

    it('rejects an injected config with an unknown top-level key as INVALID_DISPATCH_CONFIG', async () => {
      clearOrchestratorEnv();
      await assert.rejects(
        dispatchTask({ prompt: 'Test', config: { platforms: { agy: targetsOf({ model: 'agy-model' }) } }, configPath: 'old.jsonc' }),
        (err) => err.code === 'INVALID_DISPATCH_CONFIG',
      );
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

// SECTION: Failure sentinels and response-schema transport

describe('failure sentinels and CLI transport', () => {
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
      config: { 'read-delegates': 'not-an-object', bogus: 1 },
      configPath: 'x.jsonc',
    }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err, 'malformed config throws');
    assert.equal(err.code, 'INVALID_DISPATCH_CONFIG');
    assert.match(err.message, /x\.jsonc/);
  });

  it('pins the INVALID_DISPATCH_CONFIG predicate: validateConfig reports problems', () => {
    const problems = validateConfig({ 'read-delegates': 'not-an-object', bogus: 1 });
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

  it('executeProvider throws on an unhandled provider key', async () => {
    await assert.rejects(
      () => executeProvider('nonexistent-provider', {}),
      /Unhandled provider: nonexistent-provider/,
    );
  });

  it('loads and validates bounded response schemas', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-response-schema-'));
    try {
      const file = path.join(dir, 'schema.json');
      fs.writeFileSync(file, '{"type":"object","additionalProperties":false}\n');
      assert.deepEqual(loadResponseSchema(file), {
        type: 'object',
        additionalProperties: false,
      });
      assert.throws(() => normalizeResponseSchema([]), /must contain one JSON object/);
      fs.writeFileSync(file, '{broken');
      assert.throws(() => loadResponseSchema(file), /contains invalid JSON/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when a pinned provider lacks native response schema support', async () => {
    await assert.rejects(
      () => dispatchTask({
        prompt: 'Test',
        provider: 'copilot',
        responseSchema: { type: 'object' },
      }),
      (err) => err.code === 'RESPONSE_SCHEMA_UNSUPPORTED',
    );
  });

  it('reports native schema unavailability without a double negative', async () => {
    const config = { 'read-delegates': { copilot: targetsOf({ model: 'copilot-model' }) } };
    await assert.rejects(
      () => dispatchTaskImpl({
        prompt: 'Test',
        responseSchema: { type: 'object' },
        config,
        configPath: 'copilot-only.jsonc',
      }),
      (err) =>
        err.code === 'RESPONSE_SCHEMA_UNSUPPORTED' &&
        err.message === 'No available provider supports native response schema transport.',
    );
  });

  it('forwards a native response schema to Claude', async () => {
    const schema = { type: 'object', additionalProperties: false };
    try {
      mock.method(providerRunners, 'claude', async (opts) => ({
        exitCode: 0,
        stdout: JSON.stringify(opts.responseSchema),
        stderr: '',
        provider: 'claude',
      }));
      const result = await dispatchTask({
        prompt: 'Test',
        provider: 'claude',
        responseSchema: schema,
      });
      assert.deepEqual(JSON.parse(result.stdout), schema);
    } finally {
      mock.restoreAll();
    }
  });

  it('dispatchTask forwards files, agent, timeout, maxBufferMb, json and verbose into the runner options', async () => {
    const seen = [];
    try {
      mock.method(providerProbes, 'isAgyAvailable', async () => true);
      mock.method(providerRunners, 'agy', async (opts) => {
        seen.push(opts);
        return { exitCode: 0, stdout: 'ok', stderr: '', provider: 'agy' };
      });

      await dispatchTask({
        prompt: 'p',
        provider: 'agy',
        files: ['a.md'],
        agent: 'my-agent',
        timeout: 1234,
        maxBufferMb: 25,
        json: true,
        verbose: true,
      });

      const opts = seen[0];
      assert.deepEqual(
        {
          files: opts.files,
          agent: opts.agent,
          timeout: opts.timeout,
          maxBufferMb: opts.maxBufferMb,
          json: opts.json,
          verbose: opts.verbose,
        },
        {
          files: ['a.md'],
          agent: 'my-agent',
          timeout: 1234,
          maxBufferMb: 25,
          json: true,
          verbose: true,
        },
      );
    } finally {
      // This describe has no afterEach of its own; restore here so the mocks cannot leak into
      // later tests if this file grows (mocks persist across sibling tests otherwise).
      mock.restoreAll();
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
      env: { ...process.env, DISPATCH_TELEMETRY: '0' }, // keep test runs out of real telemetry
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

// SECTION: CLI inspection modes and output

describe('dispatch inspection CLI', () => {
  // main() calls process.exit on every path, so it is only drivable as a spawned child.
  let fixtureRoot;
  let dispatchScript;

  before(() => {
    // The spawn targets a fixture copy of the skill whose `config.jsonc` comes from the shipped
    // sample: the workspace's `config.local.jsonc` is git-ignored and absent on fresh checkouts
    // and CI, where the repo script would fail on config load before argument parsing.
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cli-'));
    const dispatchDir = path.join(fixtureRoot, 'dispatch');
    fs.cpSync(path.join(PROJECT_ROOT, 'skills', 'dispatch'), dispatchDir, { recursive: true });
    for (const override of ['config.jsonc', 'config.local.jsonc']) {
      fs.rmSync(path.join(dispatchDir, override), { force: true });
    }
    fs.writeFileSync(
      path.join(dispatchDir, 'config.jsonc'),
      fs.readFileSync(path.join(PROJECT_ROOT, 'skills', 'dispatch', 'config.sample.jsonc'), 'utf8'),
    );
    dispatchScript = path.join(dispatchDir, 'scripts', 'dispatch.mjs');
  });

  after(() => {
    if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  const run = (args) =>
    cp.spawnSync(process.execPath, [dispatchScript, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: PROJECT_ROOT, // hermetic: never inherit the caller's cwd
      env: { ...process.env, DISPATCH_TELEMETRY: '0' }, // keep test runs out of real telemetry
    });

  it('validates the fixture config and exits 0', () => {
    const res = run(['--validate-only']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout || '', /Config is valid\./);
  });

  it('rejects combining --validate-only with flags it would otherwise ignore', () => {
    const res = run(['--validate-only', '-m', 'claude-opus-5', 'positional prompt']);
    assert.equal(res.status, 1);
    assert.match(
      res.stderr || '',
      /--validate-only checks the dispatch config schema alone and cannot be combined with: prompt, --model/,
    );
  });

  // The fixture's config.jsonc is the shipped sample (all four platforms), so the CLI asserts the
  // effective membership shape rather than a specific platform set.
  it('--list-platforms prints the effective config platform keys, one per line', () => {
    const res = run(['--list-platforms']);
    assert.equal(res.status, 0, res.stderr);
    const keys = (res.stdout || '').trim().split('\n').filter(Boolean);
    assert.ok(keys.length > 0, 'expected at least one configured platform');
    for (const key of keys) assert.ok(KNOWN_PROVIDERS.includes(key), `unknown platform key "${key}"`);
    assert.equal(new Set(keys).size, keys.length, 'platform keys must be unique');
  });

  it('--list-targets prints configured targets as JSON', () => {
    const res = run(['--list-targets']);
    assert.equal(res.status, 0, res.stderr);
    const targets = JSON.parse(res.stdout || '[]');
    assert.ok(targets.length > 0, 'expected at least one configured target');
    for (const target of targets) {
      assert.ok(KNOWN_PROVIDERS.includes(target.platform), `unknown platform key "${target.platform}"`);
      assert.equal(Number.isInteger(target.candidateIndex), true);
    }
  });

  it('--list-targets accepts orchestrator ordering overrides', () => {
    const res = run(['--list-targets', '--orchestrator', 'claude', '--orchestrator-model', 'claude-opus-5']);
    assert.equal(res.status, 0, res.stderr);
    const targets = JSON.parse(res.stdout || '[]');
    const firstClaude = targets.findIndex(target => target.platform === 'claude');
    const lastAlternative = targets.findLastIndex(target => target.platform !== 'claude');
    assert.notEqual(firstClaude, -1, 'effective config must include claude for this ordering assertion');
    assert.notEqual(lastAlternative, -1, 'effective config must include an alternative for this ordering assertion');
    assert.ok(firstClaude > lastAlternative);
  });

  it('--list-targets, --list-platforms, and --validate-only accept --level', () => {
    for (const mode of ['--list-targets', '--list-platforms', '--validate-only']) {
      const res = run([mode, '--level', 'high']);
      assert.equal(res.status, 0, `${mode}: ${res.stderr}`);
    }
    const listed = JSON.parse(run(['--list-targets', '--level', 'max', '--orchestrator', 'claude']).stdout || '[]');
    assert.ok(listed.length > 0);
  });

  it('rejects an unknown --level', () => {
    const res = run(['--list-targets', '--level', 'ultra']);
    assert.equal(res.status, 1);
    assert.match(res.stderr || '', /Unknown level "ultra"/);
  });

  it('rejects --level-source outside --doctor and runs', () => {
    for (const mode of ['--list-targets', '--list-platforms', '--validate-only']) {
      const res = run([mode, '--level', 'high', '--level-source', 'explicit']);
      assert.equal(res.status, 1, mode);
      assert.match(res.stderr || '', /cannot be combined with: .*--level-source/);
    }
  });

  it('rejects the orchestrator pair with --list-platforms and --validate-only', () => {
    for (const mode of ['--list-platforms', '--validate-only']) {
      const res = run([mode, '--orchestrator', 'claude']);
      assert.equal(res.status, 1, mode);
      assert.match(res.stderr || '', /cannot be combined with: .*--orchestrator/);
    }
  });

  it('rejects an unknown top-level config key with the schema diagnostic', () => {
    const invalidRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cli-invalid-'));
    try {
      const invalidDir = path.join(invalidRoot, 'dispatch');
      fs.cpSync(path.join(fixtureRoot, 'dispatch'), invalidDir, { recursive: true });
      fs.writeFileSync(path.join(invalidDir, 'config.jsonc'), JSON.stringify({ platforms: { claude: targetsOf({ model: 'claude-model' }) } }));
      const res = cp.spawnSync(process.execPath, [path.join(invalidDir, 'scripts', 'dispatch.mjs'), '--validate-only'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: PROJECT_ROOT,
        env: { ...process.env, DISPATCH_TELEMETRY: '0' },
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr || '', /Unrecognized top-level key "platforms"/);
    } finally {
      fs.rmSync(invalidRoot, { recursive: true, force: true });
    }
  });

  it('--help lists --level, --level-source, and --pins', () => {
    const res = run(['--help']);
    assert.equal(res.status, 0);
    for (const flag of ['--level', '--level-source', '--pins']) assert.match(res.stdout, new RegExp(`${flag}\\b`));
  });

  it('--help driver section lists ask and every DRIVER_FLAGS entry', async () => {
    const { DRIVER_FLAGS } = await import('../../../skills/dispatch/scripts/driver/index.mjs');
    const res = run(['--help']);
    assert.equal(res.status, 0);
    const start = res.stdout.indexOf('Driver (');
    assert.ok(start >= 0, 'help has a Driver section');
    const driver = res.stdout.slice(start).split(/\r?\n\s*\r?\n/)[0];
    const missing = DRIVER_FLAGS.filter((flag) => !new RegExp(`${flag}(?![\\w-])`).test(driver));
    assert.deepEqual(missing, [], `driver help omits: ${missing.join(', ')}`);
    assert.match(driver.split(/\r?\n/).find((line) => /--run\b/.test(line)) ?? '', /\bask\b/);
    assert.match(driver.split(/\r?\n/).find((line) => /^\s*-- <argument>/.test(line)) ?? '', /ask question/);
  });

  it('rejects an empty candidate index', () => {
    const res = run(['--provider', 'claude', '--candidate-index=', 'Review this change']);
    assert.equal(res.status, 1);
    assert.match(res.stderr || '', /--candidate-index must be a non-negative integer/);
  });

  it('rejects combining --list-platforms with run flags', () => {
    const res = run(['--list-platforms', '--provider', 'claude']);
    assert.equal(res.status, 1);
    assert.match(
      res.stderr || '',
      /--list-platforms prints the effective config's platform keys alone and cannot be combined with: --provider/,
    );
  });

  it('rejects --list-platforms together with --validate-only', () => {
    const res = run(['--list-platforms', '--validate-only']);
    assert.equal(res.status, 1);
    assert.match(res.stderr || '', /separate inspection modes/);
  });

  it('rejects --list-targets together with another inspection mode', () => {
    const res = run(['--list-targets', '--list-platforms']);
    assert.equal(res.status, 1);
    assert.match(res.stderr || '', /separate inspection modes/);
  });

  it('rejects --doctor together with another inspection mode', () => {
    const res = run(['--doctor', '--validate-only']);
    assert.equal(res.status, 1);
    assert.match(res.stderr || '', /separate inspection modes/);
  });

  it('rejects --batch-file combined with a single-target selector', () => {
    const res = run(['--batch-file', path.join(os.tmpdir(), 'missing-batch.json'), '--provider', 'claude', 'Review']);
    assert.equal(res.status, 1);
    assert.match(res.stderr || '', /--batch-file cannot be combined with: --provider/);
  });

  it('rejects --batch-file combined with --no-config', () => {
    const res = run(['--batch-file', path.join(os.tmpdir(), 'missing-batch.json'), '--no-config', 'Review']);
    assert.equal(res.status, 1);
    assert.match(res.stderr || '', /--batch-file cannot be combined with: --no-config/);
  });

  it('writes --output-file reports to the file, banner to stderr, and falls back to stdout', () => {
    const sink = () => { const chunks = []; return { chunks, write: (c) => chunks.push(c) }; };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-output-test-'));
    try {
      const file = path.join(dir, 'output.txt');
      let stdout = sink(), stderr = sink();
      writeDispatchOutput('{"complete":true}\n', file, { stdout, stderr });
      assert.equal(fs.readFileSync(file, 'utf8'), '{"complete":true}\n');
      assert.deepEqual(stdout.chunks, []);
      assert.match(stderr.chunks.join(''), /\[dispatch\] Output: /);

      stdout = sink(); stderr = sink();
      writeDispatchOutput('report\n', path.join(dir, 'missing', 'output.txt'), { stdout, stderr });
      assert.deepEqual(stdout.chunks, ['report\n']);
      assert.match(stderr.chunks.join(''), /could not write --output-file/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects --output-file in inspection modes', () => {
    const res = run(['--validate-only', '--output-file', path.join(os.tmpdir(), 'unused-output.txt')]);
    assert.equal(res.status, 1);
    assert.match(res.stderr || '', /cannot be combined with: --output-file/);
  });

  it('does not treat inspection flags after -- as dispatch flags', () => {
    const res = run(['--validate-only', '--', '--list-platforms']);
    assert.equal(res.status, 1);
    assert.match(
      res.stderr || '',
      /--validate-only checks the dispatch config schema alone and cannot be combined with: prompt/,
    );
    assert.doesNotMatch(res.stderr || '', /--list-platforms prints the effective config/);
  });
});

// SECTION: Strict target, effort, and sandbox contracts

describe('strict config targets and sandbox', () => {
  afterEach(() => mock.restoreAll());
  const lvl = (model, effort = 'low') => ({ low: { model, effort } });
  // copilot is absent from the config, so orchestrator demotion cannot mask provider flatten order.
  const MULTI = {
    'read-delegates': {
      claude: { targets: [lvl('claude-opus-5')] },
      agy: { targets: [lvl('gemini-3.8-flash')] },
      opencode: { sandbox: false, targets: [lvl('glm-5.3-flash'), lvl('mistral-small')] },
    },
  };

  it('SC3 resolveConfiguredTargets enumerates provider[index] targets in provider-then-target order with wrapper sandbox', () => {
    assert.deepEqual(validateConfig(MULTI), []);
    const targets = resolveConfiguredTargets(resolveReadDelegates(MULTI, 'low'), 'copilot');
    assert.deepEqual(targets.map(t => `${t.platform}[${t.candidateIndex}]:${t.model}:${t.sandbox}`), [
      'claude[0]:claude-opus-5:true',
      'agy[0]:gemini-3.8-flash:undefined',
      'opencode[0]:glm-5.3-flash:false',
      'opencode[1]:mistral-small:false',
    ]);
  });

  it('SC3 --list-targets CLI prints every wrapper target in provider-then-target order', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-strict-cli-'));
    try {
      const dir = path.join(root, 'dispatch');
      fs.cpSync(path.join(PROJECT_ROOT, 'skills', 'dispatch'), dir, { recursive: true });
      fs.rmSync(path.join(dir, 'config.local.jsonc'), { force: true });
      fs.writeFileSync(path.join(dir, 'config.jsonc'), JSON.stringify(MULTI));
      const res = cp.spawnSync(process.execPath, [path.join(dir, 'scripts', 'dispatch.mjs'), '--list-targets', '--orchestrator', 'copilot'], {
        encoding: 'utf8',
        cwd: PROJECT_ROOT,
        env: { ...process.env, DISPATCH_TELEMETRY: '0' },
      });
      assert.equal(res.status, 0, res.stderr);
      const listed = JSON.parse(res.stdout || '[]');
      assert.deepEqual(listed.map(t => `${t.platform}[${t.candidateIndex}]:${t.model}`), [
        'claude[0]:claude-opus-5',
        'agy[0]:gemini-3.8-flash',
        'opencode[0]:glm-5.3-flash',
        'opencode[1]:mistral-small',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('SC5 dispatchTask surfaces a runner sandbox downgrade in the dispatch result', async () => {
    const warning = '[dispatch] WARNING: Copilot sandbox is unavailable; the run proceeded unsandboxed.';
    mock.method(providerRunners, 'copilot', async () => ({
      provider: 'copilot',
      stdout: 'ok',
      exitCode: 0,
      sandboxDowngraded: true,
      warnings: [warning],
    }));
    mock.method(providerProbes, 'isCopilotAvailable', async () => true);
    const result = await dispatchTask({
      prompt: 'Test',
      provider: 'copilot',
      config: { 'read-delegates': { copilot: { targets: [lvl('gpt-5.6-luna', 'max')] } } },
      configPath: 'custom.jsonc',
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.sandboxDowngraded, true);
    assert.deepEqual(result.warnings, [warning]);
  });

  it('SC5 dispatchBatch carries a runner sandbox downgrade into the slot record', async () => {
    const warning = '[dispatch] WARNING: Copilot sandbox is unavailable; the run proceeded unsandboxed.';
    mock.method(providerRunners, 'copilot', async () => ({
      provider: 'copilot', stdout: '{"findings":[]}', stderr: '', exitCode: 0, failureKind: null,
      logFile: null, truncated: null, metricsAttempts: [], sandboxDowngraded: true, warnings: [warning],
    }));
    mock.method(providerProbes, 'isCopilotAvailable', async () => true);
    const config = { 'read-delegates': { copilot: { targets: [lvl('gpt-5.6-luna', 'max')] } } };
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dispatch-strict-batch-'));
    const saved = process.env.DISPATCH_TELEMETRY;
    process.env.DISPATCH_TELEMETRY = '0';
    try {
      const batchPath = path.join(root, 'batch.json');
      fs.writeFileSync(batchPath, JSON.stringify({
        targets: [{ roundId: 'code-review:R1', candidateId: 'code-review:copilot:0', platform: 'copilot', model: 'gpt-5.6-luna' }],
        reserves: [],
      }));
      const batch = loadBatchFile(batchPath, resolveReadDelegates(config, 'low'));
      const out = await dispatchBatch(batch, { prompt: 'Review', files: [], configPath: 'custom.jsonc', orchestrator: 'claude', level: 'low' }, config);
      assert.equal(out.targets.length, 1);
      assert.equal(out.targets[0].sandboxDowngraded, true);
      assert.deepEqual(out.targets[0].warnings, [warning]);
    } finally {
      if (saved === undefined) delete process.env.DISPATCH_TELEMETRY;
      else process.env.DISPATCH_TELEMETRY = saved;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('SC4 an effort-less level passes no effort to the runner while an explicit effort override still applies', async () => {
    const runner = mock.method(providerRunners, 'claude', async () => ({ provider: 'claude', stdout: 'ok', exitCode: 0 }));
    mock.method(providerProbes, 'isClaudeAvailable', async () => true);
    const config = { 'read-delegates': { claude: { targets: [{ low: { model: 'claude-opus-5' } }] } } };
    await dispatchTask({ prompt: 'Test', provider: 'claude', config, configPath: 'custom.jsonc', level: 'low' });
    await dispatchTask({ prompt: 'Test', provider: 'claude', config, configPath: 'custom.jsonc', level: 'low', effort: 'high' });
    assert.equal(runner.mock.calls.length, 2);
    assert.equal(runner.mock.calls[0].arguments[0].effort ?? null, null);
    assert.equal(runner.mock.calls[0].arguments[0].model, 'claude-opus-5');
    assert.equal(runner.mock.calls[1].arguments[0].effort, 'high');
  });

  it('SC5 dispatchTask passes wrapper sandbox false to the Claude runner', async () => {
    const runner = mock.method(providerRunners, 'claude', async () => ({ provider: 'claude', stdout: 'ok', exitCode: 0 }));
    mock.method(providerProbes, 'isClaudeAvailable', async () => true);
    const result = await dispatchTask({
      prompt: 'Test',
      provider: 'claude',
      config: { 'read-delegates': { claude: { sandbox: false, targets: [lvl('claude-opus-5')] } } },
      configPath: 'custom.jsonc',
    });
    assert.equal(result.exitCode, 0);
    assert.equal(runner.mock.calls[0].arguments[0].sandbox, false);
    assert.equal(Object.hasOwn(result, 'sandboxDowngraded'), false);
  });

  it('SC6 dispatchTask passes the effective wrapper sandbox (default true, explicit false) to OpenCode', async () => {
    const runner = mock.method(providerRunners, 'opencode', async () => ({ provider: 'opencode', stdout: 'ok', exitCode: 0 }));
    mock.method(providerProbes, 'isOpencodeAvailable', async () => true);
    for (const wrapper of [{}, { sandbox: true }, { sandbox: false }]) {
      await dispatchTask({
        prompt: 'Test',
        provider: 'opencode',
        config: { 'read-delegates': { opencode: { ...wrapper, targets: [lvl('glm-5.3-flash')] } } },
        configPath: 'custom.jsonc',
      });
    }
    assert.deepEqual(runner.mock.calls.map(c => c.arguments[0].sandbox), [true, true, false]);
  });
});
