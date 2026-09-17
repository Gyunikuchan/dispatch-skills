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
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  formatCliError,
  safeExitCode,
  classifyFailure,
  DEFAULT_MAX_BUFFER_MB,
  demoteOrchestratorTargets,
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
  parseRunnerModeArgs,
  SANDBOX_SUPPORTED_PROVIDERS,
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
import { prepareMetricsDestination, recordDispatchMetrics } from './slot-metrics.mjs';

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
 * @property {boolean} [sandbox] Sandbox override for Claude/Copilot candidates only (see
 *   SANDBOX_SUPPORTED_PROVIDERS); omitted values default to enabled.
 * @property {string} [agent]
 * @property {number} [timeout] Seconds before the delegate is killed.
 * @property {number} [maxBufferMb] Stdout cap before the delegate is killed.
 * @property {boolean} [json] Structured JSON output (opencode provider only).
 * @property {object|null} [responseSchema] Native response schema. Currently supported by Claude.
 * @property {boolean} [verbose]
 * @property {string|null} [orchestrator] Explicit orchestrator override; skips detection.
 * @property {string|null} [orchestratorModel] Explicit orchestrator model override; skips detection.
 * @property {string|null} [provider] Pins the cascade to one provider; no fallback to other
 *   providers, while that provider's configured candidates may still be tried.
 * @property {number|string|null} [candidateIndex] Selects one configured candidate within a
 *   pinned provider. Zero-based; incompatible with model/effort overrides and `noConfig`.
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
 * @property {string|null} [failureKind]
 * @property {string} logFile
 * @property {'timeout'|'buffer'|null} truncated
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

const PROVIDER_DISPLAY_NAMES = {
  claude: 'Claude Code',
  copilot: 'Copilot',
};

export const RESPONSE_SCHEMA_PROVIDERS = new Set(['claude']);
const MAX_RESPONSE_SCHEMA_BYTES = 64 * 1024;
const MAX_BATCH_FILE_BYTES = 64 * 1024;
const BATCH_ENTRY_FIELDS = new Set([
  'roundId',
  'candidateId',
  'platform',
  'candidateIndex',
  'model',
  'effort',
  'metricsFile',
]);

function sourceKeyFor(entry) {
  const candidateIndex = entry.candidateIndex ?? Number(entry.candidateId.split(':').at(-1));
  return `${entry.roundId}:${entry.platform}:${candidateIndex}`;
}

function validateBatchEntry(entry, where, config, sourceKeys, tuples, metricsFiles, runDirs) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${where} must be an object.`);
  }
  for (const key of Object.keys(entry)) {
    if (!BATCH_ENTRY_FIELDS.has(key)) throw new Error(`${where} contains unsupported field "${key}".`);
  }
  for (const key of ['roundId', 'candidateId', 'platform', 'metricsFile']) {
    if (typeof entry[key] !== 'string' || entry[key].length === 0) {
      throw new Error(`${where}.${key} must be a non-empty string.`);
    }
  }
  if (!/^[a-z][a-z0-9-]*:R[1-9]\d*$/.test(entry.roundId)) {
    throw new Error(`${where}.roundId must match <phase>:R<n>.`);
  }
  if (!/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*:(0|[1-9]\d*)$/.test(entry.candidateId)) {
    throw new Error(`${where}.candidateId must match <phase>:<platform>:<candidate-index>.`);
  }
  const [candidatePhase, candidatePlatform, candidateIndexText] = entry.candidateId.split(':');
  if (
    candidatePhase !== entry.roundId.split(':')[0] ||
    candidatePlatform !== entry.platform
  ) {
    throw new Error(`${where}.candidateId must match roundId and platform.`);
  }
  if (!Object.prototype.hasOwnProperty.call(config.platforms, entry.platform)) {
    throw new Error(`${where}.platform "${entry.platform}" is not configured.`);
  }
  const hasCandidateIndex = entry.candidateIndex !== undefined;
  const hasExplicitHints = entry.model !== undefined || entry.effort !== undefined;
  if (hasCandidateIndex === hasExplicitHints) {
    throw new Error(`${where} must use either candidateIndex or model/effort, never both.`);
  }
  if (hasCandidateIndex && (!Number.isSafeInteger(entry.candidateIndex) || entry.candidateIndex < 0)) {
    throw new Error(`${where}.candidateIndex must be a non-negative safe integer.`);
  }
  if (hasCandidateIndex && entry.candidateIndex !== Number(candidateIndexText)) {
    throw new Error(`${where}.candidateIndex must match candidateId.`);
  }
  if (hasCandidateIndex) {
    const configured = config.platforms[entry.platform];
    const candidates = Array.isArray(configured) ? configured : [configured];
    if (entry.candidateIndex >= candidates.length) {
      throw new Error(
        `${where}.candidateIndex ${entry.candidateIndex} is out of range for platform "${entry.platform}".`,
      );
    }
  }
  for (const key of ['model', 'effort']) {
    if (entry[key] !== undefined && (typeof entry[key] !== 'string' || entry[key].length === 0)) {
      throw new Error(`${where}.${key} must be a non-empty string when provided.`);
    }
  }

  const sourceKey = sourceKeyFor(entry);
  if (sourceKeys.has(sourceKey)) throw new Error(`${where} duplicates source key "${sourceKey}".`);
  sourceKeys.add(sourceKey);
  const tuple = JSON.stringify([
    entry.platform,
    entry.candidateIndex ?? null,
    entry.model ?? null,
    entry.effort ?? null,
  ]);
  if (tuples.has(tuple)) throw new Error(`${where} duplicates a target tuple.`);
  tuples.add(tuple);

  const destination = prepareMetricsDestination(entry.metricsFile);
  if (metricsFiles.has(destination.target)) {
    throw new Error(`${where}.metricsFile duplicates another batch metrics destination.`);
  }
  metricsFiles.add(destination.target);
  runDirs.add(destination.runDir);
  return { ...entry, sourceKey };
}

export function loadBatchFile(file, config) {
  if (!path.isAbsolute(file)) throw new Error('--batch-file must be an absolute path.');
  const resolved = path.resolve(file);
  const inputStat = fs.lstatSync(resolved);
  if (inputStat.isSymbolicLink()) throw new Error('--batch-file must not be a symbolic link.');
  const tempRoot = fs.realpathSync(os.tmpdir());
  const realFile = fs.realpathSync(resolved);
  if (realFile !== tempRoot && !realFile.startsWith(`${tempRoot}${path.sep}`)) {
    throw new Error('--batch-file must be located under the OS temp directory.');
  }
  const stat = fs.lstatSync(realFile);
  if (!stat.isFile()) throw new Error('--batch-file must be a regular file.');
  if (stat.size > MAX_BATCH_FILE_BYTES) throw new Error('--batch-file exceeds 64 KiB.');

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(realFile, 'utf8'));
  } catch (err) {
    throw new Error(`--batch-file contains invalid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--batch-file must contain one JSON object.');
  }
  for (const key of Object.keys(parsed)) {
    if (key !== 'targets' && key !== 'reserves') {
      throw new Error(`--batch-file contains unsupported field "${key}".`);
    }
  }
  if (!Array.isArray(parsed.targets) || parsed.targets.length === 0) {
    throw new Error('--batch-file.targets must contain at least one target.');
  }
  if (parsed.reserves !== undefined && !Array.isArray(parsed.reserves)) {
    throw new Error('--batch-file.reserves must be an array.');
  }

  const sourceKeys = new Set();
  const tuples = new Set();
  const metricsFiles = new Set();
  const runDirs = new Set();
  const targets = parsed.targets.map((entry, index) =>
    validateBatchEntry(entry, `targets[${index}]`, config, sourceKeys, tuples, metricsFiles, runDirs));
  const reserves = (parsed.reserves ?? []).map((entry, index) =>
    validateBatchEntry(entry, `reserves[${index}]`, config, sourceKeys, tuples, metricsFiles, runDirs));
  if (runDirs.size !== 1) {
    throw new Error('Every batch metricsFile must belong to the same initialized run directory.');
  }
  return { targets, reserves, path: realFile };
}

function batchRecord(entry, status, result = null, error = null, substitutesFor = null) {
  return {
    roundId: entry.roundId,
    candidateId: entry.candidateId,
    sourceKey: entry.sourceKey,
    platform: entry.platform,
    candidateIndex: entry.candidateIndex ?? Number(entry.candidateId.split(':').at(-1)),
    status,
    session: result?.session ?? null,
    report: result?.stdout ?? null,
    failureKind:
      result?.failureKind ??
      error?.failureKind ??
      (typeof error?.code === 'string' ? error.code : null) ??
      (result && result.exitCode !== 0 ? 'non-zero-exit' : null),
    substitutesFor,
    truncated: result?.truncated ?? null,
    logFile: result?.logFile ?? null,
    metricsError: null,
  };
}

async function runBatchEntry(entry, options, config, substitutesFor = null) {
  let result;
  let error;
  const targetSupportsSchema = RESPONSE_SCHEMA_PROVIDERS.has(entry.platform);
  try {
    result = await dispatchTask({
      ...options,
      prompt: options.prompt,
      provider: entry.platform,
      candidateIndex: entry.candidateIndex ?? null,
      model: entry.model ?? null,
      effort: entry.effort ?? null,
      responseSchema: targetSupportsSchema ? options.responseSchema : null,
      metricsFile: null,
      config,
      configPath: options.configPath,
    });
  } catch (err) {
    error = err;
  }
  const record = batchRecord(entry, 'failed', result, error, substitutesFor);
  try {
    recordDispatchMetrics(entry.metricsFile, result, error);
  } catch (metricsError) {
    record.metricsError = metricsError.message;
  }
  if (error) return { ok: false, terminal: error.code === 'INTEGRITY_VIOLATION', record };
  const ok = result.exitCode === 0 && !isEmptyResult(result);
  return {
    ok,
    terminal: false,
    record: { ...record, status: ok ? 'ok' : 'failed' },
  };
}

export async function dispatchBatch(batch, options, config) {
  const reserves = [...batch.reserves];
  const orchestrator = normalizeOrchestrator(options.orchestrator || detectOrchestrator());
  const outcomes = await Promise.all(batch.targets.map(entry => runBatchEntry(entry, options, config)));
  const records = [];
  const failures = [];
  let unresolved = 0;
  for (const outcome of outcomes) {
    if (outcome.ok) {
      records.push(outcome.record);
      continue;
    }
    if (outcome.terminal) throw Object.assign(new Error('Batch dispatch stopped on an integrity failure.'), { code: 'INTEGRITY_VIOLATION' });
    failures.push(outcome.record);
    if (outcome.record.platform === orchestrator) {
      unresolved++;
      continue;
    }
    let replacement = outcome;
    while (!replacement.ok && reserves.length > 0) {
      const reserve = reserves.shift();
      replacement = await runBatchEntry(reserve, options, config, outcome.record.sourceKey);
      if (replacement.terminal) {
        throw Object.assign(new Error('Batch dispatch stopped on an integrity failure.'), { code: 'INTEGRITY_VIOLATION' });
      }
      if (!replacement.ok) failures.push(replacement.record);
    }
    if (replacement.ok) records.push(replacement.record);
    else unresolved++;
  }
  const logFile = [...records, ...failures].find(record => record.logFile)?.logFile;
  return {
    targets: records,
    failures,
    logDir: logFile ? path.dirname(logFile) : null,
    complete: unresolved === 0,
  };
}

const PROVIDER_CORRECTIVE_COMMANDS = {
  claude: 'claude auth login',
  agy: 'agy --help',
  copilot: 'gh auth login',
  opencode: 'opencode auth login',
};

export async function buildDoctorReport(config, configPath, orchestrator = null, orchestratorModel = null) {
  const targets = resolveConfiguredTargets(config, orchestrator, orchestratorModel);
  const health = await Promise.all(Object.keys(config.platforms).map(async platform => {
    const reachable = await isProviderAvailable(platform);
    return {
      platform,
      reachable,
      sandboxSupported: SANDBOX_SUPPORTED_PROVIDERS.includes(platform),
      authentication: 'not safely detectable without a provider request',
      correctiveCommand: reachable ? null : PROVIDER_CORRECTIVE_COMMANDS[platform],
    };
  }));
  return { configPath, targets, health };
}

export function normalizeResponseSchema(value, source = 'response schema') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} must contain one JSON object.`);
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RESPONSE_SCHEMA_BYTES) {
    throw new Error(`${source} exceeds 64 KiB.`);
  }
  return JSON.parse(serialized);
}

export function loadResponseSchema(file) {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`--response-schema-file not found or unreadable: ${file}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    throw new Error(`--response-schema-file contains invalid JSON: ${err.message}`);
  }
  return normalizeResponseSchema(parsed, '--response-schema-file');
}

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
    sandbox: sandboxOverride = undefined,
    agent = null,
    timeout = DEFAULT_TIMEOUT_SECONDS,
    maxBufferMb = DEFAULT_MAX_BUFFER_MB,
    json = false,
    responseSchema: rawResponseSchema = null,
    verbose = false,
    orchestrator = null,
    orchestratorModel = undefined,
    provider = null,
    candidateIndex: rawCandidateIndex = null,
    noConfig = false,
    config: injectedConfig = undefined,
    configPath: injectedConfigPath = undefined,
  } = options;

  assertSkillIntegrity();
  const responseSchema = rawResponseSchema === null
    ? null
    : normalizeResponseSchema(rawResponseSchema);

  if (noConfig && !provider) {
    const err = new Error('--no-config ignores cascade membership entirely and requires --provider.');
    err.code = 'NO_CONFIG_REQUIRES_PROVIDER';
    throw err;
  }
  const hasCandidateIndex = rawCandidateIndex !== null && rawCandidateIndex !== undefined;
  if (
    hasCandidateIndex &&
    typeof rawCandidateIndex === 'string' &&
    !/^(0|[1-9]\d*)$/.test(rawCandidateIndex)
  ) {
    throw new Error('--candidate-index must be a non-negative integer.');
  }
  const candidateIndex = hasCandidateIndex ? Number(rawCandidateIndex) : null;
  if (
    candidateIndex !== null &&
    (!Number.isSafeInteger(candidateIndex) || candidateIndex < 0)
  ) {
    throw new Error('--candidate-index must be a non-negative integer.');
  }
  if (candidateIndex !== null && !provider) {
    throw new Error('--candidate-index requires --provider.');
  }
  if (candidateIndex !== null && noConfig) {
    throw new Error('--candidate-index requires the effective dispatch configuration.');
  }
  if (candidateIndex !== null && (model !== null || effort !== null)) {
    throw new Error('--candidate-index cannot be combined with --model or --effort.');
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

  let candidates = await getCandidateProviders({
    explicitProvider: provider,
    orchestrator: effectiveOrchestrator,
    noConfig,
    config,
    configPath,
    allowedProviders: responseSchema ? RESPONSE_SCHEMA_PROVIDERS : null,
  });

  if (responseSchema) {
    if (candidates.length === 0) {
      const message = provider
        ? `Provider "${normalizeOrchestrator(provider)}" does not support native response schema transport.`
        : 'No available provider supports native response schema transport.';
      const err = new Error(message);
      err.code = 'RESPONSE_SCHEMA_UNSUPPORTED';
      throw err;
    }
  }

  if (candidates.length === 0) {
    const err = new Error(
      'No alternative dispatch agent available.\n' +
        '- Neither alternative platforms nor the orchestrator platform were found and ready.\n' +
        'Proceeding to orchestrator subagent fallback.',
    );
    err.code = 'NO_DISPATCH_AVAILABLE';
    throw err;
  }

  // Build target candidates list: expanding array platform entries when no CLI -m/-e override
  // is passed; CLI -m/-e overrides collapse a platform to a single candidate target.
  const targetCandidates = [];
  for (const candidateProvider of candidates) {
    const entry = config?.platforms?.[candidateProvider];
    if (candidateIndex !== null) {
      const entries = Array.isArray(entry) ? entry : [entry ?? {}];
      const selected = entries[candidateIndex];
      if (!selected) {
        const err = new Error(
          `Configured candidate index ${candidateIndex} is out of range for provider "${candidateProvider}".`,
        );
        err.code = 'CANDIDATE_NOT_CONFIGURED';
        throw err;
      }
      const supportsSandbox = SANDBOX_SUPPORTED_PROVIDERS.includes(candidateProvider);
      targetCandidates.push({
        provider: candidateProvider,
        model: selected.model ?? null,
        effort: selected.effort ?? null,
        sandbox: supportsSandbox ? selected.sandbox ?? true : undefined,
        label: `${candidateProvider} candidate ${candidateIndex}`,
      });
    } else if (model !== null || effort !== null) {
      const fallbackEntry = Array.isArray(entry) ? (entry[0] ?? {}) : (entry ?? {});
      const supportsSandbox = SANDBOX_SUPPORTED_PROVIDERS.includes(candidateProvider);
      targetCandidates.push({
        provider: candidateProvider,
        model: model ?? fallbackEntry.model ?? null,
        effort: effort ?? fallbackEntry.effort ?? null,
        sandbox: supportsSandbox ? sandboxOverride ?? fallbackEntry.sandbox ?? true : undefined,
        label: candidateProvider,
      });
    } else if (Array.isArray(entry)) {
      const supportsSandbox = SANDBOX_SUPPORTED_PROVIDERS.includes(candidateProvider);
      for (const c of entry) {
        const cModel = c?.model ?? null;
        const cEffort = c?.effort ?? null;
        const modelLabel = Array.isArray(cModel) ? cModel.join(', ') : cModel;
        targetCandidates.push({
          provider: candidateProvider,
          model: cModel,
          effort: cEffort,
          sandbox: supportsSandbox ? sandboxOverride ?? c?.sandbox ?? true : undefined,
          label: modelLabel ? `${candidateProvider} (${modelLabel})` : candidateProvider,
        });
      }
    } else {
      const supportsSandbox = SANDBOX_SUPPORTED_PROVIDERS.includes(candidateProvider);
      const singleEntry = entry ?? {};
      targetCandidates.push({
        provider: candidateProvider,
        model: singleEntry.model ?? null,
        effort: singleEntry.effort ?? null,
        sandbox: supportsSandbox ? sandboxOverride ?? singleEntry.sandbox ?? true : undefined,
        label: candidateProvider,
      });
    }
  }

  const runnerOptionsFor = (candidate) => {
    const runnerOptions = {
      prompt,
      files,
      agent,
      timeout,
      maxBufferMb,
      json,
      responseSchema,
      verbose,
      model: candidate.model,
      effort: candidate.effort,
    };
    if (SANDBOX_SUPPORTED_PROVIDERS.includes(candidate.provider)) runnerOptions.sandbox = candidate.sandbox;
    return runnerOptions;
  };

  // Try every platform's first entry before any platform's second, externals before the orchestrator.
  // Within the orchestrator's platform, demote exact platform + model matches behind alternative models.
  // A pin cascades over one provider's entries only, so the sort is a no-op there.
  let orderedCandidates;
  if (!provider && effectiveOrchestrator) {
    orderedCandidates = demoteOrchestratorTargets(
      targetCandidates,
      effectiveOrchestrator,
      effectiveOrchestratorModel,
      (candidate) => candidate.provider,
      (candidate) => candidate.model,
      (group) => diversitySort(group, (candidate) => candidate.provider),
    );
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
  const metricsAttempts = [];
  let bestPartial = null;

  const captureMetrics = (carrier) => {
    const attempts = Array.isArray(carrier?.metricsAttempts) ? carrier.metricsAttempts : [];
    const offset = metricsAttempts.length;
    metricsAttempts.push(...attempts);
    return Number.isSafeInteger(carrier?.effectiveAttempt)
      ? offset + carrier.effectiveAttempt
      : null;
  };
  const withMetrics = (result, effectiveAttempt) => ({
    ...result,
    metricsAttempts: [...metricsAttempts],
    effectiveAttempt,
  });

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
      const effectiveAttempt = captureMetrics(result);

      if (result.failureKind === 'sandbox-unsupported') {
        if (!shouldCascade('reported unsupported sandbox', result.failureKind)) {
          return withMetrics({ ...result, exitCode: 1 }, effectiveAttempt);
        }
        continue;
      }

      if (result.exitCode === 0 && isEmptyResult(result)) {
        const kind = result.failureKind || classifyFailure(result.stderr) || 'empty-output';
        if (!shouldCascade('exited 0 with no output', kind))
          return withMetrics({ ...result, exitCode: 1 }, effectiveAttempt);
        continue;
      }

      if (result.exitCode === 0) {
        return withMetrics(result, effectiveAttempt);
      }

      if (!isEmptyResult(result)) {
        bestPartial = bestPartial ?? { result, effectiveAttempt };
      }

      const kind =
        result.failureKind || classifyFailure(`${result.stderr || ''}\n${result.stdout || ''}`);
      if (!shouldCascade(`exited with code ${result.exitCode}`, kind)) {
        return withMetrics(result, effectiveAttempt);
      }
    } catch (err) {
      captureMetrics(err);
      const kind = err.failureKind || classifyFailure(`${err.message}\n${err.stderr || ''}`);
      if (!shouldCascade(err.message, kind)) {
        err.metricsAttempts = [...metricsAttempts];
        throw err;
      }
    }
  }

  if (bestPartial) {
    process.stderr.write(
      `[dispatch] All providers failed; returning partial output from '${bestPartial.result.provider}'.\n`,
    );
    return withMetrics(bestPartial.result, bestPartial.effectiveAttempt);
  }

  const err = new Error(
    'All candidate dispatch agents failed execution:\n' +
      attemptFailures.map((f) => `  - ${f}`).join('\n') +
      '\nProceeding to orchestrator subagent fallback.',
  );
  err.code = 'NO_DISPATCH_AVAILABLE';
  err.failures = attemptFailures;
  err.metricsAttempts = [...metricsAttempts];
  throw err;
}

// ============================================================================
// SECTION: CLI Entry Point
// ============================================================================

export async function main() {
  const options = parseCommonArgs(process.argv, {
    booleanFlags: ['--no-config', '--validate-only', '--list-platforms', '--list-targets', '--doctor'],
    valueFlags: ['--response-schema-file', '--batch-file'],
  });
  const { noConfig, validateOnly, listPlatforms, listTargets, doctor } = parseDispatchFlags(process.argv);
  const { values: dispatchValues } = parseRunnerModeArgs(process.argv.slice(2), {
    valueFlags: ['--response-schema-file', '--batch-file'],
    aliases: { '--response-schema-file': 'responseSchemaFile', '--batch-file': 'batchFile' },
  });
  const responseSchemaFile = dispatchValues.responseSchemaFile ?? null;
  const batchFile = dispatchValues.batchFile ?? null;

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  if ([validateOnly, listPlatforms, listTargets, doctor].filter(Boolean).length > 1) {
    console.error('Error: --validate-only, --list-platforms, --list-targets, and --doctor are separate inspection modes; run one at a time.');
    process.exit(1);
  }

  if (validateOnly || listPlatforms || listTargets || doctor) {
    const mode = validateOnly ? '--validate-only' : listPlatforms ? '--list-platforms' : listTargets ? '--list-targets' : '--doctor';
    const purpose = validateOnly
      ? 'checks the dispatch config schema alone'
      : listPlatforms
        ? 'prints the effective config\'s platform keys alone'
        : listTargets
          ? 'prints the effective config\'s ordered targets'
          : 'reports the effective config, candidates, and provider health';
    // Refuse the combination rather than silently ignoring flags the user believes were
    // honored: both inspection modes read the config and nothing else.
    let ignored = collectRunFlags(options, noConfig);
    if (responseSchemaFile) ignored.push('--response-schema-file');
    if (batchFile) ignored.push('--batch-file');
    if (listTargets) {
      ignored = ignored.filter(flag => flag !== '--orchestrator' && flag !== '--orchestrator-model');
    }
    if (ignored.length > 0) {
      console.error(`Error: ${mode} ${purpose} and cannot be combined with: ${ignored.join(', ')}`);
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
    if (listPlatforms) {
      // Config order, one key per line, so named pins can validate membership without parsing JSON.
      // Availability is deliberately not probed: membership is a config fact, and liveness is the
      // fallback gate's job per dispatch.
      console.log(Object.keys(loaded.config.platforms).join('\n'));
      return;
    }
    if (listTargets) {
      const { orchestrator, orchestratorModel } = resolveOrchestratorContext(options);
      console.log(JSON.stringify(resolveConfiguredTargets(loaded.config, orchestrator, orchestratorModel), null, 2));
      return;
    }
    if (doctor) {
      const { orchestrator, orchestratorModel } = resolveOrchestratorContext(options);
      const report = await buildDoctorReport(loaded.config, loaded.path, orchestrator, orchestratorModel);
      console.log(`Effective config: ${report.configPath}`);
      console.log('Configured candidates:');
      for (const [index, target] of report.targets.entries()) {
        console.log(`  ${index + 1}. ${target.platform}[${target.candidateIndex}] model=${target.model ?? 'provider default'} effort=${target.effort ?? 'provider default'}`);
      }
      console.log('Provider health:');
      for (const item of report.health) {
        console.log(`  ${item.platform}: ${item.reachable ? 'reachable' : 'unreachable'}; sandbox=${item.sandboxSupported ? 'supported' : 'unsupported'}; auth/quota=${item.authentication}`);
        if (item.correctiveCommand) console.log(`    Corrective command: ${item.correctiveCommand}`);
      }
      return;
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

  let metricsReady = false;
  let result;
  try {
    if (batchFile) {
      const conflicts = [];
      if (options.provider !== null) conflicts.push('--provider');
      if (options.candidateIndex !== null) conflicts.push('--candidate-index');
      if (options.model !== null) conflicts.push('--model');
      if (options.effort !== null) conflicts.push('--effort');
      if (options.metricsFile !== null) conflicts.push('--metrics-file');
      if (noConfig) conflicts.push('--no-config');
      if (conflicts.length > 0) {
        throw new Error(`--batch-file cannot be combined with: ${conflicts.join(', ')}`);
      }
      const loaded = loadDispatchConfig();
      const problems = validateDispatchConfig(loaded.config);
      if (problems.length > 0) {
        throw new Error(`Invalid dispatch config (${loaded.path}):\n- ${problems.join('\n- ')}`);
      }
      const batch = loadBatchFile(batchFile, loaded.config);
      let envelope;
      try {
        envelope = await dispatchBatch(batch, {
          ...options,
          prompt: finalPrompt,
          responseSchema: responseSchemaFile ? loadResponseSchema(responseSchemaFile) : null,
          configPath: loaded.path,
        }, loaded.config);
      } finally {
        fs.rmSync(batch.path, { force: true });
      }
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      process.exit(envelope.complete ? 0 : 1);
      return;
    }
    if (options.metricsFile) {
      prepareMetricsDestination(options.metricsFile);
      metricsReady = true;
    }
    result = await dispatchTask({
      ...options,
      prompt: finalPrompt,
      responseSchema: responseSchemaFile ? loadResponseSchema(responseSchemaFile) : null,
      noConfig,
      orchestratorModel: options.orchestratorModel ?? undefined,
    });
  } catch (err) {
    if (options.metricsFile) {
      try {
        if (!fs.existsSync(options.metricsFile)) recordDispatchMetrics(options.metricsFile, null, err);
      } catch (metricsError) {
        console.error(`[dispatch] Failed to write metrics: ${metricsError.message}`);
      }
    }
    console.error(formatCliError(err));
    const exitCode = safeExitCode(err);
    process.exit(exitCode);
    return;
  }

  if (result.stdout) {
    process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  }

  if (result.truncated) {
    console.warn(
      `\n[dispatch] WARNING: Output truncated (${result.truncated}). Full trace: ${result.logFile}\n`,
    );
  }

  if (result.failureKind === 'sandbox-unsupported') {
    const providerName = PROVIDER_DISPLAY_NAMES[result.provider] ?? result.provider ?? 'Unknown provider';
    console.error(
      `\n[dispatch] ${providerName} sandbox support is unavailable. ` +
        `Upgrade the provider CLI or set platforms.${result.provider}.sandbox to false.\n`,
    );
  }

  if (metricsReady) {
    try {
      recordDispatchMetrics(options.metricsFile, result, null);
    } catch (metricsError) {
      console.error(`[dispatch] Failed to write metrics: ${metricsError.message}`);
      process.exit(safeExitCode(metricsError));
      return;
    }
  }
  process.exit(result.exitCode ?? 0);
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
  --metrics-file <path>       Write one content-free terminal slot record (absolute initialized path)
  --batch-file <path>         Execute caller-resolved targets/reserves from a temporary JSON file
  --response-schema-file <path>
                              Require provider-native structured output matching this JSON Schema
  --provider <name>           Force specific provider (${KNOWN_PROVIDERS.join(', ')})
  --candidate-index <n>       Select one configured candidate for a pinned provider (zero-based)
  --orchestrator <name>       Explicitly declare orchestrator (${KNOWN_PROVIDERS.join(', ')})
  --orchestrator-model <name> Override detected orchestrator model
  --no-config                 Ignore the dispatch config entirely (model, effort, membership); requires --provider
  --validate-only             Validate the dispatch config schema and exit (rejects every other run flag)
  --list-platforms            Print the effective config's platform keys in config order, one per line, and exit
  --list-targets              Print configured targets in count/all selection order as JSON and exit
  --doctor                    Validate config and report effective candidates and provider health
  --json                      Request structured JSON output (opencode provider only)
  -v, --verbose                Stream live trace to stderr (terminal only; ignored when piped)
  -h, --help                  Show this help
`);
}

/** Parses dispatch.mjs's own `--no-config` / `--validate-only` / `--list-platforms` flags. */
function parseDispatchFlags(argv) {
  let noConfig = false;
  let validateOnly = false;
  let listPlatforms = false;
  let listTargets = false;
  let doctor = false;
  for (const arg of argv.slice(2)) {
    if (arg === '--') break;
    if (arg === '--no-config') noConfig = true;
    else if (arg === '--validate-only') validateOnly = true;
    else if (arg === '--list-platforms') listPlatforms = true;
    else if (arg === '--list-targets') listTargets = true;
    else if (arg === '--doctor') doctor = true;
  }
  return { noConfig, validateOnly, listPlatforms, listTargets, doctor };
}

/** Names the run flags set on `options`, for an inspection mode to reject as unhonored. */
function collectRunFlags(options, noConfig) {
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
  if (options.candidateIndex !== null) ignored.push('--candidate-index');
  if (options.metricsFile !== null) ignored.push('--metrics-file');
  if (noConfig) ignored.push('--no-config');
  return ignored;
}

/**
 * Expands configured platform entries into the stable target order used by count and `all` pins.
 */
export function resolveConfiguredTargets(config, orchestrator = null, orchestratorModel = null) {
  const targets = [];
  for (const [platform, rawEntry] of Object.entries(config.platforms)) {
    const entries = Array.isArray(rawEntry) ? rawEntry : [rawEntry];
    for (const [candidateIndex, entry] of entries.entries()) {
      const target = { platform, candidateIndex };
      if (entry?.model !== undefined) target.model = entry.model;
      if (entry?.effort !== undefined) target.effort = entry.effort;
      if (SANDBOX_SUPPORTED_PROVIDERS.includes(platform)) {
        target.sandbox = entry?.sandbox ?? true;
      }
      targets.push(target);
    }
  }
  return demoteOrchestratorTargets(targets, orchestrator, orchestratorModel);
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
 * @param {Set<Provider>|null} [params.allowedProviders] Restrict providers before probing.
 * @returns {Promise<Provider[]>}
 */
export async function getCandidateProviders(params = {}) {
  const {
    explicitProvider = null,
    orchestrator = null,
    noConfig = false,
    allowedProviders = null,
  } = params;

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
    if (allowedProviders && !allowedProviders.has(resolved)) return [];
    return [resolved];
  }

  const configuredOrder = config ? Object.keys(config.platforms) : KNOWN_PROVIDERS;
  const order = allowedProviders
    ? configuredOrder.filter((name) => allowedProviders.has(name))
    : configuredOrder;
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

/** Resolves orchestrator name and model context from options or environment detection. */
export function resolveOrchestratorContext(options = {}) {
  const orchestrator = normalizeOrchestrator(options.orchestrator || detectOrchestrator());
  const orchestratorModel =
    options.orchestratorModel !== null && options.orchestratorModel !== undefined
      ? (options.orchestratorModel || null)
      : detectOrchestratorModel({ orchestrator });
  return { orchestrator, orchestratorModel };
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
