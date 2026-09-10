#!/usr/bin/env node

/**
 * @file dispatch.mjs
 * @description Master cascade dispatcher for multi-agent delegation.
 *
 * Implements preference order:
 * 1. Claude Code (`claude`)
 * 2. Antigravity 2.0 (`agy`)
 * 3. GitHub Copilot (`copilot`)
 * 4. OpenCode (`opencode`) (OpenCode + LM Studio) if online
 * (skipping current orchestrator unless --allow-same-agent, which runs as last resort)
 * 5. Fallback signal for built-in subagent invocation
 *
 * Zero context pollution: logs full execution to dedicated session files,
 * emitting only a single initialization banner to stderr and the clean final
 * response to stdout.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyFailure,
  DEFAULT_TIMEOUT_SECONDS,
  getGitStatus,
  isEmptyResult,
  isMainModule,
  parseCommonArgs,
  readStdin,
  verifySkillIntegrity,
} from './common.mjs';
import { isOpencodeAvailable, runOpencode } from './opencode-run.mjs';
import { isAgyAvailable, runAgy } from './agy-run.mjs';
import { isClaudeAvailable, runClaude } from './claude-run.mjs';
import { isCopilotAvailable, runCopilot } from './copilot-run.mjs';

const currentFilePath = fileURLToPath(import.meta.url);
const SKILL_DIR = path.resolve(path.dirname(currentFilePath), '..');

// ============================================================================
// SECTION: Types
// ============================================================================

/** @typedef {'opencode'|'agy'|'claude'|'copilot'} Provider */

/**
 * @typedef {object} DispatchTaskOptions
 * @property {string} prompt
 * @property {string[]} [files]
 * @property {string} [model]
 * @property {string} [effort]
 * @property {string} [agent]
 * @property {number} [timeout] Seconds before the delegate is killed.
 * @property {number} [maxBufferMb] Stdout cap before the delegate is killed.
 * @property {boolean} [json] Structured JSON output (local provider only).
 * @property {boolean} [verbose]
 * @property {string|null} [orchestrator] Explicit orchestrator override; skips detection.
 * @property {string|null} [provider] Pins the cascade to a single provider (no fallback).
 * @property {boolean} [allowSameAgent] Allow falling back to the orchestrator's own CLI.
 */

/**
 * @typedef {object} DispatchTaskResult
 * @property {Provider} provider
 * @property {string} stdout Cleaned assistant response.
 * @property {string} stderr
 * @property {number} exitCode
 * @property {string} logFile
 * @property {'timeout'|'buffer'|null} truncated
 * @property {boolean} [gitIntegrityViolation]
 * @property {string|null} [gitIntegrityDetails]
 */

// ============================================================================
// SECTION: Constants (tweak these)
// ============================================================================

/**
 * Cascade preference order, most-preferred first. The single source of truth for provider
 * order — {@link getCandidateProviders} and the help text both iterate this instead of
 * redeclaring it.
 * @type {Provider[]}
 */
export const PREFERENCE_ORDER = ['claude', 'agy', 'copilot', 'opencode'];

/** Accepted `--provider` aliases, normalized to their canonical {@link Provider} name. */
export const PROVIDER_ALIASES = {
  opencode: 'opencode',
  agy: 'agy',
  antigravity: 'agy',
  claude: 'claude',
  claudecode: 'claude',
  copilot: 'copilot',
  'github-copilot': 'copilot',
};

/** Probes reachability for each provider, indirected so tests can mock individual entries. */
export const providerProbes = {
  isOpencodeAvailable,
  isAgyAvailable,
  isClaudeAvailable,
  isCopilotAvailable,
};

/** Executes a task on each provider, indirected so tests can mock individual entries. */
export const providerRunners = {
  opencode: runOpencode,
  agy: runAgy,
  claude: runClaude,
  copilot: runCopilot,
};

/**
 * Workspace state probe, indirected through an object so the write-mode cascade guard can be
 * exercised without a working `git` binary (CI images such as `node:*-alpine` ship without one,
 * which silently disabled the guard and let the cascade run on).
 */
export const workspaceProbes = {
  getGitStatus,
};

// ============================================================================
// SECTION: Main API — dispatchTask()
// ============================================================================

/**
 * Dispatches the prompt to candidate providers with automatic fallback passes.
 * @param {DispatchTaskOptions} [options]
 * @returns {Promise<DispatchTaskResult>}
 */
export async function dispatchTask(options = {}) {
  const {
    prompt,
    files = [],
    model = null,
    effort = null,
    agent = null,
    timeout = DEFAULT_TIMEOUT_SECONDS,
    maxBufferMb = 10,
    json = false,
    verbose = false,
    orchestrator = null,
    provider = null,
    allowSameAgent = false,
  } = options;

  assertSkillIntegrity();

  const candidates = await getCandidateProviders({
    explicitProvider: provider,
    orchestrator,
    allowSameAgent,
  });

  if (candidates.length === 0) {
    const err = new Error(
      'No alternative dispatch agent available.\n' +
        '- OpenCode / LM Studio is offline.\n' +
        '- No alternative external agents on other platforms were found and ready.\n' +
        'Proceeding to orchestrator subagent fallback.',
    );
    err.code = 'NO_DISPATCH_AVAILABLE';
    throw err;
  }

  const runnerOptions = { prompt, files, model, effort, agent, timeout, maxBufferMb, json, verbose };

  return await runCascade(candidates, runnerOptions, { pinned: Boolean(provider) });
}

/** Throws if any skill file has been tampered with since installation. */
function assertSkillIntegrity() {
  const integrity = verifySkillIntegrity(SKILL_DIR);
  if (integrity.valid || integrity.missing) return;
  process.stderr.write(
    `[dispatch] WARNING: Skill file integrity check failed! Modified files:\n` +
      integrity.violations.map((v) => `  - ${v}`).join('\n') +
      '\n' +
      `[dispatch] This may indicate tampering. Aborting dispatch.\n`,
  );
  const err = new Error('Skill file integrity verification failed');
  err.code = 'INTEGRITY_VIOLATION';
  throw err;
}

/**
 * Runs `runnerOptions` through `candidates` in order, cascading to the next provider on
 * failure. A truncated or empty run is still worth returning if nothing better follows:
 * without `bestPartial`, a 9-minute analysis that timed out one step short was discarded
 * outright.
 * @param {Provider[]} candidates
 * @param {object} runnerOptions
 * @param {{ pinned: boolean }} cascadeOptions
 * @returns {Promise<DispatchTaskResult>}
 */
async function runCascade(candidates, runnerOptions, { pinned }) {
  const attemptFailures = [];
  let bestPartial = null;

  for (let i = 0; i < candidates.length; i++) {
    const currentProvider = candidates[i];
    const nextProvider = candidates[i + 1] ?? null;

    /** Records the failure and reports whether the cascade should continue. */
    const shouldCascade = (reason, kind) => {
      attemptFailures.push(`${currentProvider}: ${reason}${kind ? ` [${kind}]` : ''}`);

      if (pinned) {
        process.stderr.write(
          `[dispatch] Provider '${currentProvider}' ${reason}${kind ? ` [${kind}]` : ''}. ` +
            `Pinned with --provider, so not cascading — see the session log.\n`,
        );
        return false;
      }

      if (nextProvider) {
        process.stderr.write(
          `[dispatch] Provider '${currentProvider}' ${reason}${kind ? ` [${kind}]` : ''}. Cascading to '${nextProvider}'...\n`,
        );
      }
      return true;
    };

    try {
      const result = await executeProvider(currentProvider, runnerOptions);

      // A CLI that reports quota exhaustion or a refusal on stderr and still exits 0 is a
      // failure, not a silent success.
      if (result.exitCode === 0 && isEmptyResult(result)) {
        const kind = result.failureKind || classifyFailure(result.stderr) || 'empty-output';
        if (!shouldCascade('exited 0 with no output', kind)) return result;
        continue;
      }

      if (result.exitCode === 0) {
        return result;
      }

      if (!isEmptyResult(result)) {
        bestPartial = bestPartial ?? result;
      }

      const kind =
        result.failureKind || classifyFailure(`${result.stderr || ''}\n${result.stdout || ''}`);
      if (!shouldCascade(`exited with code ${result.exitCode}`, kind)) return result;
    } catch (err) {
      const kind = err.failureKind || classifyFailure(`${err.message}\n${err.stderr || ''}`);
      if (!shouldCascade(err.message, kind)) throw err;
    }
  }

  if (bestPartial) {
    process.stderr.write(
      `[dispatch] All providers failed; returning partial output from '${bestPartial.provider}'.\n`,
    );
    return bestPartial;
  }

  const err = new Error(
    'All candidate dispatch agents failed execution:\n' +
      attemptFailures.map((f) => `  - ${f}`).join('\n') +
      '\nProceeding to orchestrator subagent fallback.',
  );
  err.code = 'NO_DISPATCH_AVAILABLE';
  err.failures = attemptFailures;
  throw err;
}

// ============================================================================
// SECTION: CLI Entry Point
// ============================================================================

export async function main() {
  const options = parseCommonArgs(process.argv);

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  const pipedStdin = await readStdin();
  let finalPrompt = options.prompt.trim();
  if (pipedStdin) {
    finalPrompt = finalPrompt ? `${finalPrompt}\n\n[Piped Input]:\n${pipedStdin}` : pipedStdin;
  }

  if (!finalPrompt) {
    console.error('Error: No prompt provided. Use --help for usage.');
    process.exit(1);
  }

  try {
    const result = await dispatchTask({ ...options, prompt: finalPrompt });

    if (result.stdout) {
      process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
    }

    if (result.truncated) {
      console.warn(
        `\n[dispatch] WARNING: Output truncated (${result.truncated}). Full trace: ${result.logFile}\n`,
      );
    }

    if (result.gitIntegrityViolation) {
      console.warn(`\n[dispatch] WARNING: Workspace was modified during READ-ONLY execution!`);
      if (result.gitIntegrityDetails) {
        console.warn(`[dispatch] Changed files:\n${result.gitIntegrityDetails}`);
      }
      console.warn('');
    }

    process.exit(result.exitCode ?? 0);
  } catch (err) {
    console.error(`\n[dispatch] ERROR: ${err.message}`);
    const exitCode = typeof err.code === 'number' ? err.code : 1;
    process.exit(exitCode);
  }
}

function printHelp() {
  console.log(`
Master Cascade Dispatcher

Routes a task through the delegate cascade. The authoritative description of the cascade,
monitoring, and fallback lives in the dispatch skill: SKILL.md

Usage:
  node ${process.argv[1]} [options] [prompt]

Options:
  -p, --prompt <string>       The prompt message to send
  -f, --file, --artifact      Attach context file or artifact (repeatable)
  -m, --model <name>          Override model identifier
  -e, --effort <level>        Override reasoning effort (low, medium, high, max)
  -a, --agent <name>          Override agent name
  -t, --timeout <seconds>     Override execution timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})
  --allow-same-agent          Allow fallback to same agent CLI if no alternative is available
  --provider <name>           Force specific provider (${PREFERENCE_ORDER.join(', ')})
  --orchestrator <name>       Explicitly declare orchestrator (${PREFERENCE_ORDER.join(', ')})
  --json                      Request structured JSON output (local provider only)
  -v, --verbose                Stream live trace to stderr (terminal only; ignored when piped)
  -h, --help                  Show this help
`);
}

// ============================================================================
// SECTION: Provider Resolution
// ============================================================================

/**
 * Returns an ordered array of viable candidate providers based on the preference cascade:
 * 1. Alternative providers in preference order ({@link PREFERENCE_ORDER}, skipping orchestrator)
 * 2. Same agent as orchestrator (only if `allowSameAgent` is true)
 *
 * @param {object} [params]
 * @param {string|null} [params.explicitProvider]
 * @param {string|null} [params.orchestrator]
 * @param {boolean} [params.allowSameAgent]
 * @returns {Promise<Provider[]>}
 */
export async function getCandidateProviders(params = {}) {
  const { explicitProvider = null, orchestrator = null, allowSameAgent = false } = params;

  if (explicitProvider) {
    return [resolveExplicitProvider(explicitProvider)];
  }

  const effectiveOrchestrator = orchestrator || detectOrchestrator();
  const alternatives = PREFERENCE_ORDER.filter((p) => p !== effectiveOrchestrator);

  const candidates = [];
  for (const name of alternatives) {
    if (await isProviderAvailable(name)) candidates.push(name);
  }

  // Same agent as orchestrator (only if explicitly allowed), tried last.
  if (allowSameAgent && effectiveOrchestrator && (await isProviderAvailable(effectiveOrchestrator))) {
    candidates.push(effectiveOrchestrator);
  }

  return candidates;
}

/** Normalizes a user-supplied `--provider` value to a canonical {@link Provider} name. */
function resolveExplicitProvider(explicitProvider) {
  const resolved = PROVIDER_ALIASES[explicitProvider.toLowerCase()];
  if (!resolved) throw new Error(`Unknown provider specified: ${explicitProvider}`);
  return resolved;
}

/** Checks reachability of one provider via {@link providerProbes}. */
async function isProviderAvailable(name) {
  const probe = {
    claude: providerProbes.isClaudeAvailable,
    agy: providerProbes.isAgyAvailable,
    copilot: providerProbes.isCopilotAvailable,
    opencode: providerProbes.isOpencodeAvailable,
  }[name];
  return probe ? await probe() : false;
}

/**
 * Resolves the primary target provider using the preference cascade.
 * @param {object} [params]
 * @returns {Promise<Provider|null>}
 */
export async function resolveProvider(params = {}) {
  const candidates = await getCandidateProviders(params);
  return candidates[0] || null;
}

/** Executes a specific provider runner via {@link providerRunners}. */
export async function executeProvider(provider, runnerOptions) {
  const runner = providerRunners[provider];
  if (!runner) {
    throw new Error(`Unhandled provider: ${provider}`);
  }
  return await runner(runnerOptions);
}

// ============================================================================
// SECTION: Orchestrator Detection
// ============================================================================

/**
 * Detects the orchestrator runtime from environment variables.
 *
 * Claude Code exports `CLAUDECODE` / `CLAUDE_CODE_*`; probing only the `CLAUDE_CODE` and
 * `CLAUDE_SESSION_ID` that never existed made detection return null there, so the cascade
 * delegated straight back to the orchestrator's own platform. The VS Code heuristic went for
 * the same reason: `VSCODE_PID` is set in any VS Code terminal, whichever agent drives it.
 * `--orchestrator` overrides whatever this returns.
 * @returns {Provider|null}
 */
export function detectOrchestrator() {
  if (
    process.env.ANTIGRAVITY_AGENT ||
    process.env.ANTIGRAVITY_CONVERSATION_ID ||
    process.env.ANTIGRAVITY_SESSION_ID ||
    process.env.GEMINI_CLI
  ) {
    return 'agy';
  }
  if (
    process.env.CLAUDECODE ||
    process.env.CLAUDE_CODE ||
    process.env.CLAUDE_CODE_SESSION_ID ||
    process.env.CLAUDE_SESSION_ID ||
    process.env.CLAUDE_CODE_ENTRYPOINT
  ) {
    return 'claude';
  }
  if (process.env.COPILOT_AGENT || process.env.COPILOT_CLI_SESSION_ID) {
    return 'copilot';
  }
  if (process.env.OPENCODE_PORT || process.env.OPENCODE_AGENT) {
    return 'opencode';
  }
  return null;
}

// ============================================================================
// SECTION: Module Execution Guard
// ============================================================================

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}
