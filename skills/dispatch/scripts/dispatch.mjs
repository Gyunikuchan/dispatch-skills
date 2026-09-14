#!/usr/bin/env node

/**
 * @file dispatch.mjs
 * @description Master cascade dispatcher for multi-agent delegation.
 *
 * Implements preference order:
 * 1. Claude Code (`claude`)
 * 2. Antigravity 2.0 (`agy`)
 * 3. GitHub Copilot (`copilot`)
 * 4. OpenCode (`opencode`) if online
 * (alternative providers tried first; orchestrator platform tried last)
 * 5. Fallback signal for built-in subagent invocation
 *
 * Zero context pollution: logs full execution to dedicated session files,
 * emitting only a single initialization banner to stderr and the clean final
 * response to stdout.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatCliError,
  safeExitCode,
  getGitStatus,
  classifyFailure,
  DEFAULT_MAX_BUFFER_MB,
  detectOrchestrator,
  detectOrchestratorModel,
  isSameModel,
  diversitySort,
  DEFAULT_TIMEOUT_SECONDS,
  isEmptyResult,
  isMainModule,
  KNOWN_PROVIDERS,
  loadSkillConfig,
  parseCommonArgs,
  readStdin,
  validateDispatchConfig,
  verifySkillIntegrity,
} from './common.mjs';

// Re-exported: they live in common.mjs so other modules can detect host/model
// without importing this module (and, through it, every provider runner).
export { detectOrchestrator, detectOrchestratorModel, isSameModel };
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
 * @property {string|string[]} [model]
 * @property {string} [effort]
 * @property {string} [agent]
 * @property {number} [timeout] Seconds before the delegate is killed.
 * @property {number} [maxBufferMb] Stdout cap before the delegate is killed.
 * @property {boolean} [json] Structured JSON output (opencode provider only).
 * @property {boolean} [verbose]
 * @property {string|null} [orchestrator] Explicit orchestrator override; skips detection.
 * @property {string|null} [orchestratorModel] Explicit orchestrator model override; skips detection.
 * @property {string|null} [provider] Pins the cascade to a single provider (no fallback).
 * @property {boolean} [noConfig] Ignore the dispatch config entirely (model, effort, cascade
 *   membership); requires `provider`.
 * @property {object} [config] Injected config object (bypasses loading config from disk).
 * @property {string} [configPath] Display path for the injected config.
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
    maxBufferMb = DEFAULT_MAX_BUFFER_MB,
    json = false,
    verbose = false,
    orchestrator = null,
    orchestratorModel = undefined,
    provider = null,
    noConfig = false,
    config: injectedConfig = undefined,
    configPath: injectedConfigPath = undefined,
  } = options;

  assertSkillIntegrity();

  if (noConfig && !provider) {
    const err = new Error('--no-config ignores cascade membership entirely and requires --provider.');
    err.code = 'NO_CONFIG_REQUIRES_PROVIDER';
    throw err;
  }

  let config = injectedConfig;
  let configPath = injectedConfigPath ?? (injectedConfig ? '<injected>' : null);
  if (!noConfig && config === undefined) {
    const loaded = loadDispatchConfig();
    config = loaded.config;
    configPath = loaded.path;
  }

  if (!noConfig && config) {
    const problems = validateDispatchConfig(config);
    if (problems.length > 0) {
      const err = new Error(`Invalid dispatch config (${configPath}):\n- ${problems.join('\n- ')}`);
      err.code = 'INVALID_DISPATCH_CONFIG';
      throw err;
    }
  }

  // Resolved once so cascade membership and the orchestrator-last grouping below agree; a pin never
  // groups by orchestrator, so detection is skipped there.
  const effectiveOrchestrator = provider ? null : normalizeOrchestrator(orchestrator || detectOrchestrator());
  const effectiveOrchestratorModel =
    !effectiveOrchestrator || provider
      ? null
      : orchestratorModel !== undefined
        ? (orchestratorModel || null)
        : detectOrchestratorModel({ orchestrator: effectiveOrchestrator });

  const candidates = await getCandidateProviders({
    explicitProvider: provider,
    orchestrator: effectiveOrchestrator,
    noConfig,
    config,
    configPath,
  });

  if (candidates.length === 0) {
    const err = new Error(
      'No alternative dispatch agent available.\n' +
        '- Neither alternative platforms nor the orchestrator platform were found and ready.\n' +
        'Proceeding to orchestrator subagent fallback.',
    );
    err.code = 'NO_DISPATCH_AVAILABLE';
    throw err;
  }

  // One baseline for the whole cascade, taken before any provider runs. Per-runner baselines let a
  // write by a provider that then failed become the *next* provider's clean starting point, so the
  // breach was reported by nobody.
  const initialGitStatus = getGitStatus();

  // Build target candidates list: expanding array platform entries when no CLI -m/-e override
  // is passed; CLI -m/-e overrides collapse a platform to a single candidate target.
  const targetCandidates = [];
  for (const candidateProvider of candidates) {
    const entry = config?.platforms?.[candidateProvider];
    if (model !== null || effort !== null) {
      const fallbackEntry = Array.isArray(entry) ? (entry[0] ?? {}) : (entry ?? {});
      targetCandidates.push({
        provider: candidateProvider,
        model: model ?? fallbackEntry.model ?? null,
        effort: effort ?? fallbackEntry.effort ?? null,
        label: candidateProvider,
      });
    } else if (Array.isArray(entry)) {
      for (const c of entry) {
        const cModel = c?.model ?? null;
        const cEffort = c?.effort ?? null;
        const modelLabel = Array.isArray(cModel) ? cModel.join(', ') : cModel;
        targetCandidates.push({
          provider: candidateProvider,
          model: cModel,
          effort: cEffort,
          label: modelLabel ? `${candidateProvider} (${modelLabel})` : candidateProvider,
        });
      }
    } else {
      const singleEntry = entry ?? {};
      targetCandidates.push({
        provider: candidateProvider,
        model: singleEntry.model ?? null,
        effort: singleEntry.effort ?? null,
        label: candidateProvider,
      });
    }
  }

  const runnerOptionsFor = (candidate) => {
    return {
      prompt,
      initialGitStatus,
      files,
      agent,
      timeout,
      maxBufferMb,
      json,
      verbose,
      model: candidate.model,
      effort: candidate.effort,
    };
  };

  // Try every platform's first entry before any platform's second, externals before the orchestrator.
  // Within the orchestrator's platform, demote exact platform + model matches behind alternative models.
  // A pin cascades over one provider's entries only, so the sort is a no-op there.
  let orderedCandidates;
  if (!provider && effectiveOrchestrator) {
    const externals = targetCandidates.filter((c) => c.provider !== effectiveOrchestrator);
    const orchestratorDiffModel = targetCandidates.filter(
      (c) => c.provider === effectiveOrchestrator && !isSameModel(c.model, effectiveOrchestratorModel),
    );
    const orchestratorSameModel = targetCandidates.filter(
      (c) => c.provider === effectiveOrchestrator && isSameModel(c.model, effectiveOrchestratorModel),
    );
    orderedCandidates = [
      ...diversitySort(externals, (c) => c.provider),
      ...diversitySort(orchestratorDiffModel, (c) => c.provider),
      ...diversitySort(orchestratorSameModel, (c) => c.provider),
    ];
  } else {
    orderedCandidates = diversitySort(targetCandidates, (c) => c.provider);
  }

  return await runCascade(orderedCandidates, runnerOptionsFor, { pinned: Boolean(provider) });
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
 * Runs `runnerOptions` through `targetCandidates` in order, cascading to the next candidate on
 * failure. When pinned, cascades only among candidates of the pinned provider. A truncated or
 * empty run is still worth returning if nothing better follows: without `bestPartial`, a 9-minute
 * analysis that timed out one step short was discarded outright.
 * @param {Array<{ provider: Provider, model: string|null, effort: string|null, label: string }>} targetCandidates
 * @param {(candidate: { provider: Provider, model: string|null, effort: string|null, label: string }) => object} runnerOptionsFor
 * @param {{ pinned: boolean }} cascadeOptions
 * @returns {Promise<DispatchTaskResult>}
 */
async function runCascade(targetCandidates, runnerOptionsFor, { pinned }) {
  const attemptFailures = [];
  let bestPartial = null;

  // A provider that wrote to the workspace and *then* failed still breached read-only isolation.
  // Its result is discarded by the cascade, so the violation is accumulated here and stamped onto
  // whatever the cascade ultimately returns or throws.
  let sawViolation = false;
  const violationDetails = [];

  /** Records any integrity breach reported by one attempt, whoever ends up answering. */
  const absorbViolation = (outcome) => {
    if (!outcome?.gitIntegrityViolation) return;
    sawViolation = true;
    const provider = outcome.provider ?? 'unknown';
    const detail = outcome.gitIntegrityDetails
      ? `${provider}:\n${outcome.gitIntegrityDetails}`
      : `${provider}: (no detail)`;
    if (!violationDetails.includes(detail)) violationDetails.push(detail);
  };

  /** Stamps the accumulated integrity state onto the cascade's answer. */
  const withViolations = (result) => {
    if (!result || !sawViolation) return result;
    return {
      ...result,
      gitIntegrityViolation: true,
      gitIntegrityDetails: violationDetails.join('\n') || null,
    };
  };

  for (let i = 0; i < targetCandidates.length; i++) {
    const current = targetCandidates[i];
    const next = targetCandidates[i + 1] ?? null;
    const currentProvider = current.provider;
    const currentLabel = current.label;
    const nextLabel = next?.label ?? null;
    const isSameProviderNext = next && next.provider === currentProvider;

    /** Records the failure and reports whether the cascade should continue. */
    const shouldCascade = (reason, kind) => {
      attemptFailures.push(`${currentLabel}: ${reason}${kind ? ` [${kind}]` : ''}`);

      if (pinned) {
        if (isSameProviderNext) {
          process.stderr.write(
            `[dispatch] Provider '${currentLabel}' ${reason}${kind ? ` [${kind}]` : ''}. Cascading to '${nextLabel}'...\n`,
          );
          return true;
        }
        process.stderr.write(
          `[dispatch] Provider '${currentLabel}' ${reason}${kind ? ` [${kind}]` : ''}. ` +
            `Pinned with --provider, so not cascading — see the session log.\n`,
        );
        return false;
      }

      if (next) {
        process.stderr.write(
          `[dispatch] Provider '${currentLabel}' ${reason}${kind ? ` [${kind}]` : ''}. Cascading to '${nextLabel}'...\n`,
        );
      }
      return true;
    };

    try {
      const result = await executeProvider(currentProvider, runnerOptionsFor(current));

      // A CLI that reports quota exhaustion or a refusal on stderr and still exits 0 is a
      // failure, not a silent success.
      absorbViolation(result);

      if (result.exitCode === 0 && isEmptyResult(result)) {
        const kind = result.failureKind || classifyFailure(result.stderr) || 'empty-output';
        if (!shouldCascade('exited 0 with no output', kind))
          return withViolations({ ...result, exitCode: 1 });
        continue;
      }

      if (result.exitCode === 0) {
        return withViolations(result);
      }

      if (!isEmptyResult(result)) {
        bestPartial = bestPartial ?? result;
      }

      const kind =
        result.failureKind || classifyFailure(`${result.stderr || ''}\n${result.stdout || ''}`);
      if (!shouldCascade(`exited with code ${result.exitCode}`, kind)) return withViolations(result);
    } catch (err) {
      // A runner can throw after the delegate already wrote; the error carries the same fields.
      absorbViolation(err);
      const kind = err.failureKind || classifyFailure(`${err.message}\n${err.stderr || ''}`);
      if (!shouldCascade(err.message, kind)) throw err;
    }
  }

  if (bestPartial) {
    process.stderr.write(
      `[dispatch] All providers failed; returning partial output from '${bestPartial.provider}'.\n`,
    );
    return withViolations(bestPartial);
  }

  const err = new Error(
    'All candidate dispatch agents failed execution:\n' +
      attemptFailures.map((f) => `  - ${f}`).join('\n') +
      '\nProceeding to orchestrator subagent fallback.',
  );
  err.code = 'NO_DISPATCH_AVAILABLE';
  err.failures = attemptFailures;
  // Nobody answered, but somebody may still have written; the caller must hear about it.
  err.gitIntegrityViolation = sawViolation;
  err.gitIntegrityDetails = sawViolation ? violationDetails.join('\n') : null;
  throw err;
}

// ============================================================================
// SECTION: CLI Entry Point
// ============================================================================

export async function main() {
  const options = parseCommonArgs(process.argv, { booleanFlags: ['--no-config', '--validate-only'] });
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
    if (options.json) ignored.push('--json');
    if (options.verbose) ignored.push('--verbose');
    if (options.orchestrator !== null) ignored.push('--orchestrator');
    if (options.orchestratorModel !== null) ignored.push('--orchestrator-model');
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
    const result = await dispatchTask({
      ...options,
      prompt: finalPrompt,
      noConfig,
      orchestratorModel: options.orchestratorModel ?? undefined,
    });

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
    console.error(formatCliError(err));
    const exitCode = safeExitCode(err);
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
  --prompt-file <path>        Read the prompt from a file (cannot combine with -p/positional prompt)
  -f, --file, --artifact      Attach context file or artifact (repeatable)
  -m, --model <name>          Override model identifier (takes precedence over config)
  -e, --effort <level>        Override reasoning effort (takes precedence over config)
  -a, --agent <name>          Override agent name (opencode provider only)
  -t, --timeout <seconds>     Override execution timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})
  --max-buffer <MB>           Max output buffer limit in MB (default: ${DEFAULT_MAX_BUFFER_MB})
  --provider <name>           Force specific provider (${KNOWN_PROVIDERS.join(', ')})
  --orchestrator <name>       Explicitly declare orchestrator (${KNOWN_PROVIDERS.join(', ')})
  --orchestrator-model <name> Override detected orchestrator model
  --no-config                 Ignore the dispatch config entirely (model, effort, membership); requires --provider
  --validate-only             Validate the dispatch config schema and exit (rejects every other run flag)
  --json                      Request structured JSON output (opencode provider only)
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
 * 2. Same agent as orchestrator (tried last, if a cascade member and available)
 *
 * A pinned `explicitProvider` absent from the loaded config is a hard error unless `noConfig`
 * is set — cascade membership rule 3 (dispatch config is the source of truth) applies to
 * pinned dispatches too.
 *
 * @param {object} [params]
 * @param {string|null} [params.explicitProvider]
 * @param {string|null} [params.orchestrator]
 * @param {boolean} [params.noConfig] Skip config entirely; only valid alongside `explicitProvider`.
 * @param {object|null} [params.config] Pre-loaded dispatch config; loaded fresh when omitted
 *   (and `noConfig` is false) so direct callers/tests need not load it themselves.
 * @param {string|null} [params.configPath] Path `config` was loaded from, for error messages.
 * @returns {Promise<Provider[]>}
 */
export async function getCandidateProviders(params = {}) {
  const { explicitProvider = null, orchestrator = null, noConfig = false } = params;

  let config = params.config;
  let configPath = params.configPath ?? (config ? '<injected>' : null);
  if (!noConfig && config === undefined) {
    const loaded = loadDispatchConfig();
    config = loaded.config;
    configPath = loaded.path;
  }

  if (!noConfig && config) {
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
      const err = new Error(`platform "${resolved}" is not configured in ${configPath}`);
      err.code = 'PLATFORM_NOT_CONFIGURED';
      throw err;
    }
    return [resolved];
  }

  const order = config ? Object.keys(config.platforms) : KNOWN_PROVIDERS;
  const effectiveOrchestrator = normalizeOrchestrator(orchestrator || detectOrchestrator());

  // Probe concurrently: each probe spawns a CLI and waits on it, so serially they add up to seconds
  // of pure latency before the first delegate starts. Cascade order is preserved by filtering the
  // alternative providers first, and appending the orchestrator platform last if configured and
  // available. A pinned `--provider` never reaches here — that path returns above, probing nothing.
  const availability = await Promise.all(order.map((name) => isProviderAvailable(name)));
  const availableSet = new Set(order.filter((_, i) => availability[i]));

  const candidates = order.filter((p) => p !== effectiveOrchestrator && availableSet.has(p));
  if (effectiveOrchestrator && availableSet.has(effectiveOrchestrator)) {
    candidates.push(effectiveOrchestrator);
  }

  return candidates;
}

/** Canonicalizes an orchestrator name via {@link PROVIDER_ALIASES}, passing unknown names through. */
function normalizeOrchestrator(name) {
  if (!name) return name ?? null;
  return PROVIDER_ALIASES[String(name).toLowerCase()] ?? name;
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

/**
 * Executes a specific provider runner via {@link providerRunners}.
 *
 * Exported as a seam even though only `runCascade` calls it in-repo: tests drive an
 * unhandled provider through it, and a pinned `--provider` resolution funnels here.
 */
export async function executeProvider(provider, runnerOptions) {
  const runner = providerRunners[provider];
  if (!runner) {
    throw new Error(`Unhandled provider: ${provider}`);
  }
  return await runner(runnerOptions);
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
