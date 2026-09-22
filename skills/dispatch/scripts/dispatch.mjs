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
  parseCommonArgs,
  PROVIDER_ALIASES,
  readStdin,
  parseRunnerModeArgs,
  SANDBOX_SUPPORTED_PROVIDERS,
  validateEffortSpec,
  validateModelSpec,
  validateProviderSpec,
  verifySkillIntegrity,
} from './common.mjs';

// Re-exported: they live in common.mjs so other modules can detect host/model
// without importing this module (and, through it, every provider runner).
export { detectOrchestrator, detectOrchestratorModel, isSameModel, PROVIDER_ALIASES };
import { isOpencodeAvailable, runOpencode } from './opencode-run.mjs';
import { isAgyAvailable, runAgy } from './agy-run.mjs';
import { isClaudeAvailable, runClaude } from './claude-run.mjs';
import { isCopilotAvailable, runCopilot } from './copilot-run.mjs';
import { appendTelemetry } from './telemetry.mjs';
import {
  LEVELS,
  loadDispatchConfig as loadConfigFile,
  normalizeProviderKey,
  resolveLevelEntry,
  resolveReadDelegates,
  validateConfig,
} from './config.mjs';
import { normalizePin, parsePins, resolveFlow } from './resolve-flow.mjs';

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
 * @property {object} [config] Injected v0.5 config object (bypasses loading config from disk).
 * @property {string} [configPath] Display path for the injected config.
 * @property {string} [level] Level at which `read-delegates` resolve (default `medium`).
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
]);

function sourceKeyFor(entry) {
  const candidateIndex = entry.candidateIndex ?? Number(entry.candidateId.split(':').at(-1));
  return `${entry.roundId}:${entry.platform}:${candidateIndex}`;
}

function validateBatchEntry(entry, where, config, sourceKeys, tuples) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${where} must be an object.`);
  }
  for (const key of Object.keys(entry)) {
    if (!BATCH_ENTRY_FIELDS.has(key)) throw new Error(`${where} contains unsupported field "${key}".`);
  }
  for (const key of ['roundId', 'candidateId', 'platform']) {
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
  if (entry.model !== undefined) {
    validateModelSpec(entry.model, `${where}.model`);
  }
  if (entry.effort !== undefined) {
    validateEffortSpec(entry.effort, `${where}.effort`);
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
  return { ...entry, sourceKey };
}

/**
 * Loads and validates a caller-resolved batch manifest.
 *
 * @param {string} file Absolute path under the OS temp directory.
 * @param {{ platforms: Record<string, object | object[]> }} config Level-resolved read delegates
 *   (from `resolveReadDelegates`), which candidate indexes are checked against.
 */
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
  const targets = parsed.targets.map((entry, index) =>
    validateBatchEntry(entry, `targets[${index}]`, config, sourceKeys, tuples));
  const reserves = (parsed.reserves ?? []).map((entry, index) =>
    validateBatchEntry(entry, `reserves[${index}]`, config, sourceKeys, tuples));
  return { targets, reserves, path: realFile };
}

// Source-map records need a single model/effort string; a cascade list has none, so it records null.
function singleSpec(value) {
  return typeof value === 'string' ? value : null;
}

/**
 * Envelope record for one batch slot. `resolved` is the level-resolved read-delegate map, so a
 * candidate-index slot records the model/effort that actually ran. A provider-pinned cascade slot
 * (named `--pins`) records null model/effort: its final attempt may be any in-platform candidate.
 */
function batchRecord(entry, status, result = null, error = null, substitutesFor = null, resolved = null) {
  const candidateIndex = entry.candidateIndex ?? Number(entry.candidateId.split(':').at(-1));
  const configured = resolved?.platforms?.[entry.platform];
  const candidate = entry.cascade ? null : Array.isArray(configured) ? configured[candidateIndex] : configured;
  return {
    roundId: entry.roundId,
    candidateId: entry.candidateId,
    sourceKey: entry.sourceKey,
    platform: entry.platform,
    candidateIndex,
    role: substitutesFor ? 'reserve' : 'target',
    model: singleSpec(entry.model ?? candidate?.model),
    effort: singleSpec(entry.effort ?? candidate?.effort),
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
  };
}

async function runBatchEntry(entry, options, config, resolved, substitutesFor = null) {
  let result;
  let error;
  const startedAt = Date.now();
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
      config,
      configPath: options.configPath,
    });
  } catch (err) {
    error = err;
  }
  const record = batchRecord(entry, 'failed', result, error, substitutesFor, resolved);
  appendTelemetry({ result, error, startedAt });
  const exit = Number.isInteger(result?.exitCode) ? result.exitCode : null;
  if (error) return { ok: false, terminal: error.code === 'INTEGRITY_VIOLATION', record, exit };
  const ok = result.exitCode === 0 && !isEmptyResult(result);
  return {
    ok,
    terminal: false,
    record: { ...record, status: ok ? 'ok' : 'failed' },
    exit,
  };
}

/**
 * Runs a batch's targets concurrently, substituting ordered reserves for failed non-orchestrator
 * targets. `options.onSlot(record, exit)` fires once per launched slot, in target order with each
 * target's substitutes after it, so per-slot output stays deterministic.
 *
 * @param {{ targets: object[], reserves: object[] }} batch
 * @param {object} options dispatchTask options plus `level` and optional `onSlot`
 * @param {object} config v0.5 dispatch config (each slot calls dispatchTask with it)
 * @returns {Promise<{ targets: object[], failures: object[], logDir: string|null, complete: boolean }>}
 */
export async function dispatchBatch(batch, options, config) {
  const { onSlot = null, ...taskOptions } = options;
  const resolved = resolveReadDelegates(config, taskOptions.level ?? 'medium');
  const reserves = [...batch.reserves];
  const orchestrator = normalizeOrchestrator(taskOptions.orchestrator || detectOrchestrator());
  const outcomes = await Promise.all(batch.targets.map(entry => runBatchEntry(entry, taskOptions, config, resolved)));
  const records = [];
  const failures = [];
  let unresolved = 0;
  const integrityStop = () =>
    Object.assign(new Error('Batch dispatch stopped on an integrity failure.'), { code: 'INTEGRITY_VIOLATION' });
  for (const outcome of outcomes) {
    onSlot?.(outcome.record, outcome.exit);
    if (outcome.ok) {
      records.push(outcome.record);
      continue;
    }
    if (outcome.terminal) throw integrityStop();
    failures.push(outcome.record);
    if (outcome.record.platform === orchestrator) {
      unresolved++;
      continue;
    }
    let replacement = outcome;
    while (!replacement.ok && reserves.length > 0) {
      const reserve = reserves.shift();
      replacement = await runBatchEntry(reserve, taskOptions, config, resolved, outcome.record.sourceKey);
      onSlot?.(replacement.record, replacement.exit);
      if (replacement.terminal) throw integrityStop();
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

// ============================================================================
// SECTION: --pins wave (R8)
// ============================================================================

export const ASK_ROUND_ID = 'ask:R1';

/**
 * Builds the `ask` wave for `--pins` over level-resolved read delegates. Named pins: one
 * provider-pinned slot per distinct configured platform, in input order, cascading within the
 * platform and with no reserves. Count `n`: the first `n` targets in `--list-targets` order, the
 * rest ordered reserves. `all`: every target, no reserves. `phases.<phase>.only` never applies.
 *
 * @param {{ platforms: Record<string, object[]> }} resolved
 * @param {string[]} rawPins comma-split `--pins` values
 * @param {{ orchestrator?: string|null, orchestratorModel?: string|null }} [context]
 * @returns {{ targets: object[], reserves: object[], clamped: { requested: number, resolved: number } | null }}
 */
export function buildPinsWave(resolved, rawPins, { orchestrator = null, orchestratorModel = null } = {}) {
  const { keys, count } = parsePins(rawPins);
  const configured = Object.keys(resolved.platforms);
  if (keys && !keys.some((key) => normalizePin(key) === 'all')) {
    const named = [...new Set(keys.map(normalizePin))];
    const unknown = named.filter((key) => !configured.includes(key));
    if (unknown.length > 0) {
      throw new Error(
        `--pins names platform(s) not in read-delegates: ${unknown.join(', ')} (configured: ${configured.join(', ') || 'none'}).`,
      );
    }
    // Candidate index 0 is a fixed entry-point label: the slot cascades within its platform.
    const targets = named.map((platform) => ({
      roundId: ASK_ROUND_ID,
      candidateId: `ask:${platform}:0`,
      platform,
      sourceKey: `${ASK_ROUND_ID}:${platform}:0`,
      cascade: true,
    }));
    return { targets, reserves: [], clamped: null };
  }
  const ordered = resolveConfiguredTargets(resolved, orchestrator, orchestratorModel).map((target) => ({
    roundId: ASK_ROUND_ID,
    candidateId: `ask:${target.platform}:${target.candidateIndex}`,
    platform: target.platform,
    candidateIndex: target.candidateIndex,
    sourceKey: `${ASK_ROUND_ID}:${target.platform}:${target.candidateIndex}`,
  }));
  const requested = count ?? ordered.length;
  const size = Math.min(requested, ordered.length);
  return {
    targets: ordered.slice(0, size),
    reserves: ordered.slice(size),
    clamped: size < requested ? { requested, resolved: size } : null,
  };
}

/**
 * Formats one R8 per-slot stdout line and writes a successful slot's report to an OS-temp file
 * (mode 0600) so stdout carries paths, never report bodies.
 */
function slotLine(record, exit, reportDir) {
  let output = null;
  if (record.status === 'ok' && record.report) {
    const file = path.join(reportDir, `${record.sourceKey.replace(/[^a-zA-Z0-9.-]/g, '_')}.md`);
    fs.writeFileSync(file, record.report, { encoding: 'utf8', mode: 0o600 });
    output = file;
  }
  return JSON.stringify({
    slot: record.sourceKey,
    platform: record.platform,
    status: record.status,
    exit,
    session: record.session,
    output,
  });
}

const PROVIDER_CORRECTIVE_COMMANDS = {
  claude: 'claude auth login',
  agy: 'agy --help',
  copilot: 'gh auth login',
  opencode: 'opencode auth login',
};

// ============================================================================
// SECTION: --doctor
// ============================================================================

/**
 * Builds the `--doctor` report: level-resolved read-delegate candidates and health, the review
 * phases resolved with probe results as liveness, and write subagents (the orchestrator's entry
 * when given, else every entry). Orchestrator detection is the caller's job.
 *
 * @param {object} config validated v0.5 config
 * @param {string} configPath
 * @param {{ level?: string, levelSource?: string, orchestrator?: string|null, orchestratorModel?: string|null }} [options]
 */
export async function buildDoctorReport(config, configPath, {
  level = 'medium',
  levelSource = 'default',
  orchestrator = null,
  orchestratorModel = null,
} = {}) {
  const resolved = resolveReadDelegates(config, level);
  const targets = resolveConfiguredTargets(resolved, orchestrator, orchestratorModel);
  const health = await Promise.all(Object.keys(resolved.platforms).map(async platform => {
    const reachable = await isProviderAvailable(platform);
    return {
      platform,
      reachable,
      sandboxSupported: SANDBOX_SUPPORTED_PROVIDERS.includes(platform),
      authentication: 'not safely detectable without a provider request',
      correctiveCommand: reachable ? null : PROVIDER_CORRECTIVE_COMMANDS[platform],
    };
  }));

  const liveness = Object.fromEntries(KNOWN_PROVIDERS.map(key => [key, false]));
  for (const item of health) liveness[item.platform] = item.reachable;
  const platform = KNOWN_PROVIDERS.includes(orchestrator) ? orchestrator : undefined;
  const flow = resolveFlow({
    platform,
    level,
    orchestratorModel,
    implementationFields: 'model,effort',
    tolerateMissingImplementationModel: true,
  }, liveness, config);
  const phases = Object.fromEntries(['plan-review', 'design-review', 'code-review'].map(phase => {
    const { targets: phaseTargets, reserves, rounds, consensus, configured } = flow[phase];
    return [phase, { configured, targets: phaseTargets, reserves, rounds, consensus }];
  }));

  const entries = Object.fromEntries(
    Object.entries(config['write-subagents'] ?? {}).map(([key, entry]) => [normalizeProviderKey(key), entry]),
  );
  const writeSubagents = {};
  for (const key of platform ? [platform] : Object.keys(entries)) {
    writeSubagents[key] = entries[key] === undefined ? { configured: false } : resolveLevelEntry(entries[key], level);
  }
  return { configPath, level, levelSource, targets, health, phases, writeSubagents };
}

const specText = (value) => (Array.isArray(value) ? value.join(',') : value);

/** Renders a {@link buildDoctorReport} report as the `--doctor` text output. */
export function formatDoctorReport(report) {
  const lines = [
    `Effective config: ${report.configPath}`,
    `Level: level=${report.level} source=${report.levelSource}`,
    'Read-delegate candidates:',
  ];
  for (const [index, target] of report.targets.entries()) {
    lines.push(`  ${index + 1}. ${target.platform}[${target.candidateIndex}] model=${specText(target.model) ?? 'provider default'} effort=${target.effort ?? 'provider default'}`);
  }
  lines.push('Phases:');
  const names = (list) => list.map(t => `${t.platform}[${t.candidateId.split(':').at(-1)}]`).join(',') || 'none';
  for (const [phase, info] of Object.entries(report.phases)) {
    if (!info.configured) {
      lines.push(`  ${phase}: off (not configured)`);
    } else {
      const state = info.rounds === 0 ? 'off ' : '';
      lines.push(`  ${phase}: ${state}targets=${names(info.targets)} reserves=${names(info.reserves)} rounds=${info.rounds} consensus=${info.consensus}`);
    }
  }
  const writeEntries = Object.entries(report.writeSubagents);
  if (writeEntries.length === 0) {
    lines.push('Write-subagents: not configured');
  } else {
    lines.push('Write-subagents:');
    for (const [platform, entry] of writeEntries) {
      lines.push(entry.configured === false
        ? `  ${platform}: not configured`
        : `  ${platform}: model=${specText(entry.model) ?? 'none'} effort=${entry.effort ?? 'provider default'}`);
    }
  }
  lines.push('Provider health:');
  for (const item of report.health) {
    lines.push(`  ${item.platform}: ${item.reachable ? 'reachable' : 'unreachable'}; sandbox=${item.sandboxSupported ? 'supported' : 'unsupported'}; auth/quota=${item.authentication}`);
    if (item.correctiveCommand) lines.push(`    Corrective command: ${item.correctiveCommand}`);
  }
  return lines.join('\n');
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
    level = 'medium',
    // Message-only: the CLI already folded this file into `prompt`, but the native-fallback
    // guidance cites the path so the subagent reuses the identical brief.
    promptFile = null,
  } = options;

  assertSkillIntegrity();
  const responseSchema = rawResponseSchema === null
    ? null
    : normalizeResponseSchema(rawResponseSchema);

  if (!LEVELS.includes(level)) {
    throw new Error(`Unknown level "${level}". Valid levels: ${LEVELS.join(', ')}`);
  }
  if (provider !== null && provider !== undefined) {
    validateProviderSpec(provider, '--provider');
  }
  if (model !== null && model !== undefined) {
    validateModelSpec(model, '--model');
  }
  if (effort !== null && effort !== undefined) {
    validateEffortSpec(effort, '--effort');
  }

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

  if (!noConfig && config) assertValidConfig(config, configPath);
  const resolvedPlatforms = !noConfig && config ? resolveReadDelegates(config, level).platforms : {};

  // Resolved once so cascade membership and the orchestrator-last grouping below agree; a pin never
  // groups by orchestrator, so detection is skipped there.
  // A pin suppresses orchestrator ordering, but the native-fallback guidance still needs the host
  // platform to tell a same-platform failure from a cross-platform one.
  const hostPlatform = normalizeOrchestrator(orchestrator || detectOrchestrator());
  const effectiveOrchestrator = provider ? null : hostPlatform;
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
        nativeFallbackGuidance({ hostPlatform, failedPlatforms: [], promptFile, files }),
    );
    err.code = 'NO_DISPATCH_AVAILABLE';
    throw err;
  }

  // Build target candidates from the level-resolved read delegates: each platform expands to its
  // ordered candidates unless a CLI -m/-e override collapses it to a single target.
  const targetCandidates = [];
  for (const candidateProvider of candidates) {
    const resolvedEntries = resolvedPlatforms[candidateProvider];
    const entries = resolvedEntries?.length ? resolvedEntries : [{}];
    // A single-candidate platform keeps the bare provider label, as a flat v0.4 entry did.
    const labelWithModel = Boolean(resolvedEntries) && (resolvedEntries.length > 1 || rawEntryIsArray(config, candidateProvider));
    const supportsSandbox = SANDBOX_SUPPORTED_PROVIDERS.includes(candidateProvider);
    if (candidateIndex !== null) {
      const selected = entries[candidateIndex];
      if (!selected) {
        const err = new Error(
          `Configured candidate index ${candidateIndex} is out of range for provider "${candidateProvider}".`,
        );
        err.code = 'CANDIDATE_NOT_CONFIGURED';
        throw err;
      }
      targetCandidates.push({
        provider: candidateProvider,
        model: selected.model ?? null,
        effort: selected.effort ?? null,
        sandbox: supportsSandbox ? selected.sandbox ?? true : undefined,
        label: `${candidateProvider} candidate ${candidateIndex}`,
      });
    } else if (model !== null || effort !== null) {
      const fallbackEntry = entries[0];
      targetCandidates.push({
        provider: candidateProvider,
        model: model ?? fallbackEntry.model ?? null,
        effort: effort ?? fallbackEntry.effort ?? null,
        sandbox: supportsSandbox ? sandboxOverride ?? fallbackEntry.sandbox ?? true : undefined,
        label: candidateProvider,
      });
    } else {
      for (const c of entries) {
        const cModel = c.model ?? null;
        const modelLabel = Array.isArray(cModel) ? cModel.join(', ') : cModel;
        targetCandidates.push({
          provider: candidateProvider,
          model: cModel,
          effort: c.effort ?? null,
          sandbox: supportsSandbox ? sandboxOverride ?? c.sandbox ?? true : undefined,
          label: labelWithModel && modelLabel ? `${candidateProvider} (${modelLabel})` : candidateProvider,
        });
      }
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

  return await runCascade(orderedCandidates, runnerOptionsFor, {
    pinned: Boolean(provider),
    hostPlatform,
    promptFile,
    files,
  });
}

/**
 * Builds the native-fallback instructions carried by `NO_DISPATCH_AVAILABLE`. The orchestrator often
 * sees only this message, so it has to name the actor and the brief: hosts that expose no named
 * read-only agent type otherwise read "subagent fallback" as permission to answer inline from a
 * paraphrased prompt. Mirrors `references/providers.md` § Native fallback.
 */
function nativeFallbackGuidance({ hostPlatform = null, failedPlatforms = [], promptFile = null, files = [] } = {}) {
  const hostSubagent = `${hostPlatform ? `${hostPlatform}'s` : "the host platform's"} own native subagent` +
    ' — its named read-only agent type, or its default subagent when the platform defines no named types';
  const crossPlatform = failedPlatforms.filter((platform) => platform !== hostPlatform);
  let actor;
  if (hostPlatform && failedPlatforms.includes(hostPlatform)) {
    actor = `Same-platform failure (${hostPlatform}): launch ${hostSubagent}.`;
  } else if (crossPlatform.length > 0) {
    // providers.md routes a cross-platform failure to the failed platform's own subagent, so the map
    // stays in that table rather than being duplicated here.
    actor = `Cross-platform failure (${crossPlatform.join(', ')} failed` +
      `${hostPlatform ? `, host is ${hostPlatform}` : ''}): launch each failed platform's in-process` +
      ' native subagent named in references/providers.md § Native fallback.';
  } else {
    actor = `Launch ${hostSubagent}.`;
  }
  const lines = [
    'Proceeding to orchestrator subagent fallback. Do not answer inline and do not re-enter dispatch.',
    `- ${actor}`,
    '- Instruct the subagent to stay read-only: claims and evidence only, no file edits.',
  ];
  if (promptFile) {
    lines.push(
      `- Tell the native subagent to read this prompt file in full and follow it as the authoritative instructions: ${promptFile}` +
        `${files.length > 0 ? `; attachment paths: ${files.join(', ')}` : ''}.`,
      // Only stated alongside the paths themselves: the cleanup bound is unactionable otherwise.
      '- Those inputs are unfinished cleanup paths: prune them once this fallback consumes them or' +
        ' reaches a terminal outcome.',
    );
  } else {
    lines.push(
      '- Reuse the exact prompt and attachments prepared for this dispatch, unchanged; never paraphrase them.',
    );
  }
  return lines.join('\n');
}

/** Loads the dispatch config; a v0.4 config throws the key-map diagnostic. */
function loadDispatchConfig() {
  return loadConfigFile({ skillRoot: SKILL_DIR });
}

/** Throws `INVALID_DISPATCH_CONFIG` listing every v0.5 schema problem. */
function assertValidConfig(config, configPath) {
  const problems = validateConfig(config);
  if (problems.length === 0) return;
  const err = new Error(`Invalid dispatch config (${configPath}):\n- ${problems.join('\n- ')}`);
  err.code = 'INVALID_DISPATCH_CONFIG';
  throw err;
}

/** Whether a provider's raw `read-delegates` entry is a candidate array (alias keys allowed). */
function rawEntryIsArray(config, provider) {
  const table = config?.['read-delegates'] ?? {};
  const key = Object.keys(table).find((k) => normalizeProviderKey(k) === provider);
  return key !== undefined && Array.isArray(table[key]);
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
 * @param {{ pinned: boolean, hostPlatform?: Provider|null, promptFile?: string|null, files?: string[] }} cascadeOptions
 * @returns {Promise<DispatchTaskResult>}
 */
async function runCascade(targetCandidates, runnerOptionsFor, { pinned, hostPlatform = null, promptFile = null, files = [] }) {
  const attemptFailures = [];
  const failedPlatforms = new Set();
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
      failedPlatforms.add(currentProvider);

      if (pinned) {
        if (isSameProviderNext) {
          process.stderr.write(
            `[dispatch] fallback ${currentLabel} -> ${nextLabel}: ${reason}${kind ? ` [${kind}]` : ''}\n`,
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
          `[dispatch] fallback ${currentLabel} -> ${nextLabel}: ${reason}${kind ? ` [${kind}]` : ''}\n`,
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
      '\n' +
      nativeFallbackGuidance({ hostPlatform, failedPlatforms: [...failedPlatforms], promptFile, files }),
  );
  err.code = 'NO_DISPATCH_AVAILABLE';
  err.failures = attemptFailures;
  err.metricsAttempts = [...metricsAttempts];
  throw err;
}

// ============================================================================
// SECTION: CLI Entry Point
// ============================================================================

/**
 * Writes the report to `outputFile` (keeping a background task's output to banners) or stdout.
 */
export function writeDispatchOutput(text, outputFile, { stdout = process.stdout, stderr = process.stderr } = {}) {
  if (outputFile) {
    let written = false;
    try {
      fs.writeFileSync(outputFile, text, { encoding: 'utf8', mode: 0o600 });
      written = true;
    } catch (err) {
      // NOTE: a completed provider run is costly; fall back to stdout rather than lose the report.
      stderr.write(`[dispatch] WARNING: could not write --output-file (${err.message}); report follows on stdout\n`);
    }
    if (written) {
      stderr.write(`[dispatch] Output: ${outputFile}\n`);
      return;
    }
  }
  stdout.write(text);
}

const DISPATCH_VALUE_FLAGS = ['--response-schema-file', '--batch-file', '--output-file', '--level', '--level-source', '--pins'];
const LEVEL_SOURCES = ['explicit', 'classified'];

/**
 * Resolves `--level`/`--level-source` into `{ level, levelSource }`: an omitted level is `medium`
 * from source `default`; an explicit level without a source is `explicit`.
 */
function resolveLevelArgs(rawLevel, rawSource) {
  if (rawSource !== null) {
    if (rawLevel === null) throw new Error('--level-source requires --level.');
    if (!LEVEL_SOURCES.includes(rawSource)) {
      throw new Error(`Unknown --level-source "${rawSource}". Valid sources: ${LEVEL_SOURCES.join(', ')}`);
    }
  }
  if (rawLevel !== null && !LEVELS.includes(rawLevel)) {
    throw new Error(`Unknown level "${rawLevel}". Valid levels: ${LEVELS.join(', ')}`);
  }
  if (rawLevel === null) return { level: 'medium', levelSource: 'default' };
  return { level: rawLevel, levelSource: rawSource ?? 'explicit' };
}

/** Loads and validates the config for a CLI mode, exiting 1 with the diagnostic on failure. */
function loadValidConfigOrExit() {
  let loaded;
  try {
    loaded = loadDispatchConfig();
  } catch (err) {
    console.error(`Error loading config: ${err.message}`);
    process.exit(1);
  }
  const problems = validateConfig(loaded.config);
  if (problems.length > 0) {
    console.error(`Invalid dispatch config (${loaded.path}):\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  return loaded;
}

export async function main() {
  // Driver entry points are flags, not subcommands, so a prompt starting with "run" stays a prompt.
  // Checked before importing so plain `ask` runs never load the driver's review stack.
  const args = process.argv.slice(2);
  const driverSeparator = args.indexOf('--');
  const head = driverSeparator === -1 ? args : args.slice(0, driverSeparator);
  if (head.some((arg) => arg === '--run' || arg === '--next' || arg.startsWith('--run='))) {
    const driver = await import('./driver/index.mjs');
    process.exit(await driver.runDriver(args));
  }
  const options = parseCommonArgs(process.argv, {
    booleanFlags: ['--no-config', '--validate-only', '--list-platforms', '--list-targets', '--doctor'],
    valueFlags: DISPATCH_VALUE_FLAGS,
  });
  const { noConfig, validateOnly, listPlatforms, listTargets, doctor } = parseDispatchFlags(process.argv);
  const { values: dispatchValues } = parseRunnerModeArgs(process.argv.slice(2), {
    valueFlags: DISPATCH_VALUE_FLAGS,
    aliases: {
      '--response-schema-file': 'responseSchemaFile',
      '--batch-file': 'batchFile',
      '--output-file': 'outputFile',
      '--level': 'level',
      '--level-source': 'levelSource',
      '--pins': 'pins',
    },
  });
  const responseSchemaFile = dispatchValues.responseSchemaFile ?? null;
  const batchFile = dispatchValues.batchFile ?? null;
  const outputFile = dispatchValues.outputFile ?? null;
  const rawLevel = dispatchValues.level ?? null;
  const rawLevelSource = dispatchValues.levelSource ?? null;
  const rawPins = dispatchValues.pins ?? null;
  // NOTE: parseRunnerModeArgs maps an empty value to null, so presence is read from argv; an empty
  // list must not fall through to a plain cascade or silently widen to an `all` wave.
  const optionArgs = process.argv.slice(2);
  const separator = optionArgs.indexOf('--');
  const pinsGiven = (separator === -1 ? optionArgs : optionArgs.slice(0, separator)).some((arg) => arg === '--pins' || arg.startsWith('--pins='));
  const writeOutput = (text) => writeDispatchOutput(text, outputFile);

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
          : 'reports the effective config, candidates, phases, and provider health';
    // Refuse the combination rather than silently ignoring flags the user believes were honored.
    // Every mode accepts --level; --doctor and --list-targets also take the orchestrator pair,
    // and only --doctor reports a level source.
    let ignored = collectRunFlags(options, noConfig);
    if (responseSchemaFile) ignored.push('--response-schema-file');
    if (batchFile) ignored.push('--batch-file');
    if (outputFile) ignored.push('--output-file');
    if (pinsGiven) ignored.push('--pins');
    if (rawLevelSource !== null && !doctor) ignored.push('--level-source');
    if (listTargets || doctor) {
      ignored = ignored.filter(flag => flag !== '--orchestrator' && flag !== '--orchestrator-model');
    }
    if (ignored.length > 0) {
      console.error(`Error: ${mode} ${purpose} and cannot be combined with: ${ignored.join(', ')}`);
      process.exit(1);
    }
    let levelArgs;
    try {
      levelArgs = resolveLevelArgs(rawLevel, doctor ? rawLevelSource : null);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }

    const loaded = loadValidConfigOrExit();
    const resolved = resolveReadDelegates(loaded.config, levelArgs.level);
    if (listPlatforms) {
      // Config order, one key per line, so named pins can validate membership without parsing JSON.
      // Availability is deliberately not probed: membership is a config fact, and liveness is the
      // fallback gate's job per dispatch.
      console.log(Object.keys(resolved.platforms).join('\n'));
      return;
    }
    if (listTargets) {
      const { orchestrator, orchestratorModel } = resolveOrchestratorContext(options);
      console.log(JSON.stringify(resolveConfiguredTargets(resolved, orchestrator, orchestratorModel), null, 2));
      return;
    }
    if (doctor) {
      const { orchestrator, orchestratorModel } = resolveOrchestratorContext(options);
      const report = await buildDoctorReport(loaded.config, loaded.path, { ...levelArgs, orchestrator, orchestratorModel });
      console.log(formatDoctorReport(report));
      return;
    }
    console.log('Config is valid.');
    return;
  }

  let levelArgs;
  try {
    levelArgs = resolveLevelArgs(rawLevel, rawLevelSource);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  if (pinsGiven && !(rawPins ?? '').split(',').some((pin) => pin.trim())) {
    console.error('Error: --pins requires provider keys, a count, or "all".');
    process.exit(1);
  }
  if (rawPins !== null) {
    // A wave resolves its own targets, so every flag that selects or overrides a candidate conflicts.
    const conflicts = [];
    if (options.provider !== null) conflicts.push('--provider');
    if (options.candidateIndex !== null) conflicts.push('--candidate-index');
    if (batchFile) conflicts.push('--batch-file');
    if (noConfig) conflicts.push('--no-config');
    if (options.model !== null) conflicts.push('--model');
    if (options.effort !== null) conflicts.push('--effort');
    if (conflicts.length > 0) {
      console.error(`Error: --pins cannot be combined with: ${conflicts.join(', ')}`);
      process.exit(1);
    }
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

  process.stderr.write(`[dispatch] level=${levelArgs.level} source=${levelArgs.levelSource}\n`);
  const startedAt = Date.now();
  let result;
  try {
    if (batchFile || rawPins !== null) {
      await runWave({
        options,
        noConfig,
        batchFile,
        rawPins,
        level: levelArgs.level,
        prompt: finalPrompt,
        responseSchema: responseSchemaFile ? loadResponseSchema(responseSchemaFile) : null,
        promptFile: pipedStdin ? null : options.promptFile,
        outputFile,
      });
      return;
    }
    result = await dispatchTask({
      ...options,
      prompt: finalPrompt,
      level: levelArgs.level,
      responseSchema: responseSchemaFile ? loadResponseSchema(responseSchemaFile) : null,
      noConfig,
      orchestratorModel: options.orchestratorModel ?? undefined,
      // Piped input was appended above, so the file alone no longer reproduces the attempt's brief;
      // the fallback guidance then cites the prompt generically instead of a partial file.
      promptFile: pipedStdin ? null : options.promptFile,
    });
  } catch (err) {
    appendTelemetry({ error: err, startedAt });
    console.error(formatCliError(err));
    const exitCode = safeExitCode(err);
    process.exit(exitCode);
    return;
  }

  if (result.stdout) {
    writeOutput(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
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
        `Upgrade the provider CLI or set read-delegates.${result.provider}.sandbox to false.\n`,
    );
  }

  appendTelemetry({ result, startedAt });
  process.exit(result.exitCode ?? 0);
}

/**
 * Runs a `--batch-file` or `--pins` wave: one R8 JSON line per launched slot on stdout, each
 * successful report in an OS-temp file, and the full envelope in `--output-file` when given.
 * Exits 0 only when every slot resolved.
 */
async function runWave({ options, noConfig, batchFile, rawPins, level, prompt, responseSchema, promptFile, outputFile }) {
  if (batchFile) {
    const conflicts = [];
    if (options.provider !== null) conflicts.push('--provider');
    if (options.candidateIndex !== null) conflicts.push('--candidate-index');
    if (options.model !== null) conflicts.push('--model');
    if (options.effort !== null) conflicts.push('--effort');
    if (noConfig) conflicts.push('--no-config');
    if (conflicts.length > 0) {
      throw new Error(`--batch-file cannot be combined with: ${conflicts.join(', ')}`);
    }
  }
  const loaded = loadDispatchConfig();
  assertValidConfig(loaded.config, loaded.path);
  const resolved = resolveReadDelegates(loaded.config, level);
  let batch;
  if (batchFile) {
    batch = loadBatchFile(batchFile, resolved);
  } else {
    const { orchestrator, orchestratorModel } = resolveOrchestratorContext(options);
    const wave = buildPinsWave(resolved, rawPins.split(',').map(s => s.trim()).filter(Boolean), { orchestrator, orchestratorModel });
    if (wave.clamped) {
      process.stderr.write(
        `[dispatch] --pins ${wave.clamped.requested} clamped to ${wave.clamped.resolved} (the level-resolved candidate total).\n`,
      );
    }
    batch = wave;
  }

  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-slots-'));
  let envelope;
  try {
    envelope = await dispatchBatch(batch, {
      ...options,
      prompt,
      level,
      responseSchema,
      configPath: loaded.path,
      promptFile,
      onSlot: (record, exit) => process.stdout.write(`${slotLine(record, exit, reportDir)}\n`),
    }, loaded.config);
  } finally {
    if (batchFile) fs.rmSync(batch.path, { force: true });
  }
  if (outputFile) writeDispatchOutput(`${JSON.stringify(envelope, null, 2)}\n`, outputFile);
  process.exit(envelope.complete ? 0 : 1);
}

function printHelp() {
  console.log(`
Master Cascade Dispatcher

Routes a task through the delegate cascade. The authoritative description of the cascade,
monitoring, and fallback lives in the dispatch skill: SKILL.md

Cascade order, membership, and per-platform model/effort come from the dispatch config's
read-delegates table (config.jsonc, overridable — see the Configuration section of the dispatch README).

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
  --level <level>             Resolve read-delegates at ${LEVELS.join('|')} (default: medium)
  --level-source <source>     Record where --level came from: ${LEVEL_SOURCES.join('|')} (requires --level)
  --pins <pins>               Launch one wave: provider keys (comma list), a count, or "all";
                              prints one JSON line per slot
  --batch-file <path>         Execute caller-resolved targets/reserves from a temporary JSON file;
                              prints one JSON line per slot
  --output-file <path>        Write the report (or wave envelope) to this file instead of stdout
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
  --doctor                    Report config, level, candidates, phases, write subagents, and provider health
  --json                      Request structured JSON output (opencode provider only)
  -v, --verbose                Stream live trace to stderr (terminal only; ignored when piped)
  -h, --help                  Show this help

Driver (each call prints one JSON action; see the dispatch skill):
  --run <verb>                plan|design|review|implement (review only in this release); needs --orchestrator
  --kind <kind>               Review kind plan|code|design (default: inferred from the argument)
  --fix                       Apply accepted fixes (review is report-only by default)
  --phases from:<phase>       Start phase for implement (rejected by review)
  --next                      Advance a run started with --run
  --state <file>              The stateFile named by the previous action
  --input <json|@file>        Reply to the previous action (omit after launch)
  --verbose                   Add report bodies and diagnostics to actions
  -- <argument>               Review target: artifact path or Git range
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
  if (noConfig) ignored.push('--no-config');
  return ignored;
}

/**
 * Expands level-resolved platform entries into the stable target order used by count and `all`
 * pins (and `--list-targets`).
 *
 * @param {{ platforms: Record<string, object | object[]> }} config from `resolveReadDelegates`
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
 * 1. Alternative providers in cascade order (the loaded dispatch config's `read-delegates` key
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
 * @param {object|null} [params.config] Pre-loaded v0.5 dispatch config; loaded fresh when omitted
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

  if (!noConfig && config) assertValidConfig(config, configPath);
  // Membership is level-independent: every read-delegate key, canonicalized, in config order.
  const configuredKeys = config ? Object.keys(config['read-delegates']).map(normalizeProviderKey) : null;

  if (explicitProvider) {
    const resolved = resolveExplicitProvider(explicitProvider);
    if (configuredKeys && !configuredKeys.includes(resolved)) {
      const err = new Error(`platform "${resolved}" is not configured in ${configPath}`);
      err.code = 'PLATFORM_NOT_CONFIGURED';
      throw err;
    }
    if (allowedProviders && !allowedProviders.has(resolved)) return [];
    return [resolved];
  }

  const configuredOrder = configuredKeys ?? KNOWN_PROVIDERS;
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
  return validateProviderSpec(explicitProvider, '--provider');
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
