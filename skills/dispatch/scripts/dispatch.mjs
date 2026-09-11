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
  DEFAULT_MAX_BUFFER_MB,
  DEFAULT_TIMEOUT_SECONDS,
  getGitStatus,
  isEmptyResult,
  isMainModule,
  KNOWN_PROVIDERS,
  loadSkillConfig,
  parseCommonArgs,
  readStdin,
  validateDispatchConfig,
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
 * @property {boolean} [noConfig] Ignore the dispatch config entirely (model, effort, cascade
 *   membership); requires `provider`.
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
    noConfig = false,
  } = options;

  assertSkillIntegrity();

  if (noConfig && !provider) {
    const err = new Error('--no-config ignores cascade membership entirely and requires --provider.');
    err.code = 'NO_CONFIG_REQUIRES_PROVIDER';
    throw err;
  }

  let config = null;
  let configPath = null;
  if (!noConfig) {
    const loaded = loadDispatchConfig();
    config = loaded.config;
    configPath = loaded.path;
    const problems = validateDispatchConfig(config);
    if (problems.length > 0) {
      const err = new Error(`Invalid dispatch config (${configPath}):\n- ${problems.join('\n- ')}`);
      err.code = 'INVALID_DISPATCH_CONFIG';
      throw err;
    }
  }

  const candidates = await getCandidateProviders({
    explicitProvider: provider,
    orchestrator,
    allowSameAgent,
    noConfig,
    config,
    configPath,
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

  // Per-candidate: a CLI `-m`/`-e` override wins, else the config entry for that specific
  // provider, else null (the provider CLI's own default). Distinct models per provider are
  // required once config supplies them — a single shared `model` cannot express that.
  const runnerOptionsFor = (candidateProvider) => {
    const entry = config?.platforms?.[candidateProvider] ?? {};
    return {
      prompt,
      files,
      agent,
      timeout,
      maxBufferMb,
      json,
      verbose,
      model: model ?? entry.model ?? null,
      effort: effort ?? entry.effort ?? null,
    };
  };

  return await runCascade(candidates, runnerOptionsFor, { pinned: Boolean(provider) });
}

/** Loads the dispatch cascade config via the shared skill-config loader. */
function loadDispatchConfig() {
  return loadSkillConfig({ skillRoot: SKILL_DIR });
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
 * @param {(provider: Provider) => object} runnerOptionsFor Resolves per-candidate runner options
 *   (distinct model/effort per provider).
 * @param {{ pinned: boolean }} cascadeOptions
 * @returns {Promise<DispatchTaskResult>}
 */
async function runCascade(candidates, runnerOptionsFor, { pinned }) {
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
      const result = await executeProvider(currentProvider, runnerOptionsFor(currentProvider));

      // A CLI that reports quota exhaustion or a refusal on stderr and still exits 0 is a
      // failure, not a silent success.
      if (result.exitCode === 0 && isEmptyResult(result)) {
        const kind = result.failureKind || classifyFailure(result.stderr) || 'empty-output';
        if (!shouldCascade('exited 0 with no output', kind)) return { ...result, exitCode: 1 };
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
  const { noConfig, validateOnly } = parseDispatchFlags(process.argv);

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  if (validateOnly) {
    // Refuse the combination rather than silently ignoring flags the user believes were
    // checked: --validate-only inspects the dispatch config schema and nothing else.
    const ignored = [];
    if (options.prompt) ignored.push('prompt');
    if (options.files.length > 0) ignored.push('--file');
    if (options.model !== null) ignored.push('--model');
    if (options.effort !== null) ignored.push('--effort');
    if (options.agent !== null) ignored.push('--agent');
    if (options.timeout !== DEFAULT_TIMEOUT_SECONDS) ignored.push('--timeout');
    if (options.maxBufferMb !== DEFAULT_MAX_BUFFER_MB) ignored.push('--max-buffer');
    if (options.allowSameAgent) ignored.push('--allow-same-agent');
    if (options.json) ignored.push('--json');
    if (options.verbose) ignored.push('--verbose');
    if (options.orchestrator !== null) ignored.push('--orchestrator');
    if (options.provider !== null) ignored.push('--provider');
    if (noConfig) ignored.push('--no-config');
    if (ignored.length > 0) {
      console.error(
        `Error: --validate-only checks the dispatch config schema alone and cannot be combined with: ${ignored.join(', ')}`,
      );
      process.exit(1);
    }

    let loaded;
    try {
      loaded = loadDispatchConfig();
    } catch (err) {
      console.error(`Error loading config: ${err.message}`);
      process.exit(1);
    }
    const problems = validateDispatchConfig(loaded.config);
    if (problems.length > 0) {
      console.error(`Invalid dispatch config (${loaded.path}):\n- ${problems.join('\n- ')}`);
      process.exit(1);
    }
    console.log('Config is valid.');
    return;
  }

  if (noConfig && !options.provider) {
    console.error('Error: --no-config ignores cascade membership entirely and requires --provider.');
    process.exit(1);
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
    const result = await dispatchTask({ ...options, prompt: finalPrompt, noConfig });

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

Cascade order, membership, and per-platform model/effort come from the dispatch config
(config.default.jsonc, overridable — see the Configuration section of SKILL.md).

Usage:
  node ${process.argv[1]} [options] [prompt]

Options:
  -p, --prompt <string>       The prompt message to send
  -f, --file, --artifact      Attach context file or artifact (repeatable)
  -m, --model <name>          Override model identifier (takes precedence over config)
  -e, --effort <level>        Override reasoning effort (takes precedence over config)
  -a, --agent <name>          Override agent name
  -t, --timeout <seconds>     Override execution timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})
  --allow-same-agent          Allow fallback to same agent CLI if no alternative is available
  --provider <name>           Force specific provider (${KNOWN_PROVIDERS.join(', ')})
  --orchestrator <name>       Explicitly declare orchestrator (${KNOWN_PROVIDERS.join(', ')})
  --no-config                 Ignore the dispatch config entirely (model, effort, membership); requires --provider
  --validate-only             Validate the dispatch config schema and exit (rejects every other run flag)
  --json                      Request structured JSON output (local provider only)
  -v, --verbose                Stream live trace to stderr (terminal only; ignored when piped)
  -h, --help                  Show this help
`);
}

/** Parses dispatch.mjs's own `--no-config` / `--validate-only` flags. */
function parseDispatchFlags(argv) {
  let noConfig = false;
  let validateOnly = false;
  for (const arg of argv.slice(2)) {
    if (arg === '--no-config') noConfig = true;
    else if (arg === '--validate-only') validateOnly = true;
  }
  return { noConfig, validateOnly };
}

// ============================================================================
// SECTION: Provider Resolution
// ============================================================================

/**
 * Returns an ordered array of viable candidate providers based on the preference cascade:
 * 1. Alternative providers in cascade order (the loaded dispatch config's `platforms` key
 *    order, skipping orchestrator; falls back to {@link KNOWN_PROVIDERS} when `noConfig`)
 * 2. Same agent as orchestrator (only if `allowSameAgent` is true, and it is a cascade member)
 *
 * A pinned `explicitProvider` absent from the loaded config is a hard error unless `noConfig`
 * is set — cascade membership rule 3 (dispatch config is the source of truth) applies to
 * pinned dispatches too.
 *
 * @param {object} [params]
 * @param {string|null} [params.explicitProvider]
 * @param {string|null} [params.orchestrator]
 * @param {boolean} [params.allowSameAgent]
 * @param {boolean} [params.noConfig] Skip config entirely; only valid alongside `explicitProvider`.
 * @param {object|null} [params.config] Pre-loaded dispatch config; loaded fresh when omitted
 *   (and `noConfig` is false) so direct callers/tests need not load it themselves.
 * @param {string|null} [params.configPath] Path `config` was loaded from, for error messages.
 * @returns {Promise<Provider[]>}
 */
export async function getCandidateProviders(params = {}) {
  const { explicitProvider = null, orchestrator = null, allowSameAgent = false, noConfig = false } = params;

  let config = params.config;
  let configPath = params.configPath;
  if (!noConfig && config === undefined) {
    const loaded = loadDispatchConfig();
    config = loaded.config;
    configPath = loaded.path;
    const problems = validateDispatchConfig(config);
    if (problems.length > 0) {
      const err = new Error(`Invalid dispatch config (${configPath}):\n- ${problems.join('\n- ')}`);
      err.code = 'INVALID_DISPATCH_CONFIG';
      throw err;
    }
  }

  if (explicitProvider) {
    const resolved = resolveExplicitProvider(explicitProvider);
    if (config && !Object.prototype.hasOwnProperty.call(config.platforms, resolved)) {
      throw new Error(`platform "${resolved}" is not configured in ${configPath}`);
    }
    return [resolved];
  }

  const order = config ? Object.keys(config.platforms) : KNOWN_PROVIDERS;
  const effectiveOrchestrator = orchestrator || detectOrchestrator();
  const alternatives = order.filter((p) => p !== effectiveOrchestrator);

  const candidates = [];
  for (const name of alternatives) {
    if (await isProviderAvailable(name)) candidates.push(name);
  }

  // Same agent as orchestrator (only if explicitly allowed, and a cascade member), tried last.
  if (
    allowSameAgent &&
    effectiveOrchestrator &&
    order.includes(effectiveOrchestrator) &&
    (await isProviderAvailable(effectiveOrchestrator))
  ) {
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
