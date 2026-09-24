#!/usr/bin/env node
// @ts-check

/**
 * @file runners/claude.mjs
 * @description Dedicated runner for Claude Code with multi-mode resolution.
 *
 * Supports cross-platform execution across macOS, Windows, and Linux (bash/zsh/PowerShell).
 * Resolves Claude executables according to preference order:
 *   1. Claude CLI (cli)
 *   2. Claude Desktop (desktop)
 *   3. Claude VS Code Extension (vscode)
 *
 * Each mode is discoverable and testable up to reachability (--version) without
 * requiring active subscriptions or token consumption.
 *
 * Emits resume instructions and suppresses context pollution.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dedupeTargetsByBinary,
  findBinary,
  findFirstExistingFile,
  isMainModule,
  PROJECT_ROOT,
  scanVersionDirs,
  spawnCli,
} from '../lib/platform.mjs';
import { validateEffortSpec, validateModelSpec } from '../lib/providers.mjs';
import {
  resolveModelsToTry,
  formatCliError,
  safeExitCode,
  buildFormattedPrompt,
  buildMetricsAttempt,
  classifyFailure,
  createNoTargetsError as createCliNotFoundError,
  createSessionLogger,
  createTraceWriter,
  DEFAULT_MAX_BUFFER_MB,
  DEFAULT_TIMEOUT_SECONDS,
  emitCompletionBanner,
  emitInitBanner,
  extractCleanResponse,
  extractSessionIdFromOutput,
  getSanitizedEnv,
  isSandboxUnsupportedDiagnostic,
  parseCommonArgs,
  parseRunnerModeArgs,
  preparePromptForArgv,
  probeCliReachability,
  readStdin,
  removeBriefFile,
  resolveRunnerExitCode,
  runDelegateCapture,
} from './shared.mjs';

// ============================================================================
// SECTION: Types
// ============================================================================

/** @typedef {'desktop'|'vscode'|'cli'} ClaudeMode */

/**
 * @typedef {object} ModeDefinition
 * @property {ClaudeMode} mode
 * @property {string} name
 * @property {() => string|null} fn Resolves the binary path for this mode, or null if absent.
 */

/**
 * @typedef {object} ClaudeTarget
 * @property {ClaudeMode} mode
 * @property {string} name
 * @property {string} bin
 */

/**
 * @typedef {object} RunClaudeOptions
 * @property {typeof executeOnTarget} [execute] Test seam.
 * @property {typeof findViableTargets} [discoverTargets] Test seam.
 * @property {typeof createSessionLogger} [createLogger] Test seam.
 * @property {string} prompt
 * @property {string[]} [files]
 * @property {string|string[]} [model] Model id, comma-separated list, or array — tried in order.
 * @property {string} [effort]
 * @property {boolean} [sandbox] Enable Claude's native OS-level Bash sandbox (default true).
 * @property {Record<string, any>|null} [responseSchema] JSON Schema enforced by Claude's structured output.
 * @property {number} [timeout] Seconds before the delegate is killed.
 * @property {number} [maxBufferMb] Stdout cap before the delegate is killed.
 * @property {boolean} [verbose]
 * @property {ClaudeMode|null} [claudeMode] Pins execution to one mode; disables mode cascade.
 */

/**
 * @typedef {object} RunClaudeResult
 * @property {'claude'} provider
 * @property {ClaudeMode} claudeMode
 * @property {string} bin
 * @property {string} model
 * @property {string} stdout Cleaned assistant response.
 * @property {string} rawStdout Raw stdout, unparsed.
 * @property {string} stderr
 * @property {number} exitCode
 * @property {string} logFile
 * @property {string|null} briefFile
 * @property {string|null} sessionId
 * @property {string|null} sessionLink
 * @property {'timeout'|'buffer'|null} truncated
 * @property {string|null} failureKind
 * @property {Record<string, any>} [usage]
 * @property {ReturnType<typeof buildMetricsAttempt>[]} [metricsAttempts]
 * @property {number} [effectiveAttempt]
 */

// ============================================================================
// SECTION: Provider-Tweakable Constants
// ============================================================================

/**
 * Structural read-only enforcement: only these tools are available to the delegate.
 * Covers file reading, git inspection, and text search — no write, edit, network, or
 * unrestricted shell access. Commands that can write or execute through their own
 * arguments (`find -exec/-delete`, `awk system()`, `sort -o`) and web tools are excluded;
 * `--permission-mode plan` and `--disallowedTools` back this up (see buildClaudeArgs).
 */
export const READ_ONLY_ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'LS',
  'Bash(git diff*)',
  'Bash(git status*)',
  'Bash(git log*)',
  'Bash(git show*)',
  'Bash(git blame*)',
  'Bash(git rev-parse*)',
  'Bash(git ls-files*)',
  'Bash(grep *)',
  'Bash(rg *)',
  'Bash(ls *)',
  'Bash(head *)',
  'Bash(tail *)',
  'Bash(wc *)',
  'Bash(file *)',
  'Bash(jq *)',
  'Bash(diff *)',
  'Bash(uniq *)',
  'Bash(cut *)',
  'Bash(tr *)',
  'Bash(stat *)',
  'Bash(which *)',
  'Bash(type *)',
  'Bash(date *)',
  'Bash(basename *)',
  'Bash(dirname *)',
  'Bash(realpath *)',
  'Bash(readlink *)',
  'Bash(column *)',
  'Bash(paste *)',
  'Bash(npm ls*)',
  'TodoWrite',
];

/** Write-capable tools denied outright, independent of the allowlist above. */
export const DISALLOWED_WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit'];

/**
 * Execution modes in cascade preference order: Claude CLI > Claude Desktop > VS Code Extension.
 * The single source of truth for mode metadata — every mode-aware function below
 * (resolution, probing, execution) iterates this instead of redeclaring the list.
 * @type {ModeDefinition[]}
 */
export const MODE_DEFINITIONS = [
  { mode: 'cli', name: 'Claude CLI', fn: () => getClaudeCliBinary() },
  { mode: 'desktop', name: 'Claude Desktop', fn: () => getClaudeDesktopBinary() },
  { mode: 'vscode', name: 'Claude VS Code Extension', fn: () => getClaudeVSCodeBinary() },
];

// ============================================================================
// SECTION: Primary API
// ============================================================================

/**
 * Runs a prompt through Claude Code using the preferred mode (cli > desktop > vscode).
 * If a mode encounters auth or quota failure (unsubscribed or out of tokens), it cascades
 * to the next available mode in preference order unless pinned via `claudeMode`.
 *
 * @param {RunClaudeOptions} options
 * @returns {Promise<RunClaudeResult>}
 */
export async function runClaude(options = /** @type {RunClaudeOptions} */ ({})) {
  const {
    prompt,
    files = [],
    model = null,
    effort = null,
    sandbox = true,
    responseSchema = null,
    timeout = DEFAULT_TIMEOUT_SECONDS,
    maxBufferMb = DEFAULT_MAX_BUFFER_MB,
    verbose = false,
    claudeMode = null,
    // Test seams: each defaults to the real implementation, so production calls are unchanged.
    // The cascade loop is otherwise unreachable in a test — its executor spawns a subprocess
    // and opens a session log.
    execute = executeOnTarget,
    discoverTargets = findViableTargets,
    createLogger = createSessionLogger,
  } = options;

  validateModelSpec(model, 'model');
  validateEffortSpec(effort, 'effort');

  const viableTargets = discoverTargets(claudeMode);
  if (viableTargets.length === 0) {
    throw createNoTargetsError();
  }

  const sessionLogger = createLogger('claude');
  const formattedPrompt = buildFormattedPrompt(prompt, files);
  const modelsToTry = resolveModelsToTry(model);
  const effectiveEffort = effort || null;

  let lastResult = null;
  const metricsAttempts = [];
  // Warn-and-run: an unsupported sandbox reruns the same model once unsandboxed, then never again.
  let activeSandbox = sandbox;
  const downgrade = { flagged: false, warnings: [] };
  const noteDowngrade = (warning) => {
    downgrade.flagged = true;
    if (!downgrade.warnings.includes(warning)) downgrade.warnings.push(warning);
  };
  const withDowngrade = (value) => {
    if (value && typeof value === 'object') {
      for (const warning of value.warnings ?? []) noteDowngrade(warning);
      if (value.sandboxDowngraded) downgrade.flagged = true;
      if (downgrade.flagged) value.sandboxDowngraded = true;
      if (downgrade.warnings.length > 0) value.warnings = [...downgrade.warnings];
    }
    return value;
  };
  const tryDowngrade = (failureKind) => {
    if (!activeSandbox || failureKind !== 'sandbox-unsupported') return false;
    activeSandbox = false;
    process.stderr.write(`${CLAUDE_DOWNGRADE_WARNING}\n`);
    sessionLogger.write(`${CLAUDE_DOWNGRADE_WARNING}\n`);
    noteDowngrade(CLAUDE_DOWNGRADE_WARNING);
    return true;
  };

  // Cascade across viable targets, and within each target across candidate models,
  // both in priority order. A quota/auth failure advances to the next target; any
  // other failure advances to the next model before giving up on the target.
  for (let i = 0; i < viableTargets.length; i++) {
    const target = viableTargets[i];
    const isLastTarget = i === viableTargets.length - 1;

    for (let m = 0; m < modelsToTry.length; m++) {
      const currentModel = modelsToTry[m];
      const isLastModel = m === modelsToTry.length - 1;

      try {
        const result = await execute({
          target,
          model: currentModel,
          formattedPrompt,
          effort: effectiveEffort,
          sandbox: activeSandbox,
          responseSchema,
          timeout,
          maxBufferMb,
          verbose,
          sessionLogger,
        });
        metricsAttempts.push(buildMetricsAttempt({
          input: formattedPrompt,
          output: result.stdout,
          provider: 'claude',
          model: currentModel,
          effort: effectiveEffort,
          mode: target.mode,
          exitCode: result.exitCode,
          failureKind: result.failureKind,
          truncated: result.truncated,
          usage: result.usage,
        }));
        result.metricsAttempts = [...metricsAttempts];
        result.effectiveAttempt = metricsAttempts.length - 1;
        lastResult = withDowngrade(result);
        if (result.exitCode !== 0 && tryDowngrade(result.failureKind)) {
          m--;
          continue;
        }

        const step = nextClaudeStep({ result, error: null, isLastModel, isLastTarget, pinned: !!claudeMode });

        if (step === 'next-model') {
          const nextModel = modelsToTry[m + 1];
          process.stderr.write(
            `[dispatch] fallback ${target.name}:${currentModel} -> ${target.name}:${nextModel}: exit ${result.exitCode}${result.failureKind ? ` [${result.failureKind}]` : ''}\n`,
          );
          continue;
        }

        if (step === 'next-target') {
          process.stderr.write(
            `[dispatch] fallback ${target.name} -> ${viableTargets[i + 1].name}: ${result.failureKind} (not subscribed or token depleted)\n`,
          );
          break;
        }

        sessionLogger.close();
        return result;
      } catch (err) {
        metricsAttempts.push(buildMetricsAttempt({
          input: formattedPrompt,
          provider: 'claude',
          model: currentModel,
          effort: effectiveEffort,
          mode: target.mode,
          failureKind: err.failureKind || classifyFailure(`${err.message}\n${err.stderr || ''}`),
        }));
        err.metricsAttempts = [...metricsAttempts];
        if (tryDowngrade(err.failureKind)) {
          m--;
          continue;
        }
        withDowngrade(err);
        const step = nextClaudeStep({ result: null, error: err, isLastModel, isLastTarget, pinned: !!claudeMode });

        if (step === 'next-model') {
          process.stderr.write(
            `[dispatch] fallback ${target.name}:${currentModel} -> ${target.name}:${modelsToTry[m + 1]}: ${err.message}\n`,
          );
          continue;
        }
        if (step === 'next-target') {
          process.stderr.write(
            `[dispatch] fallback ${target.name} -> ${viableTargets[i + 1]?.name ?? 'next mode'}: ${err.message}\n`,
          );
          break;
        }
        sessionLogger.close();
        throw err;
      }
    }
  }

  sessionLogger.close();
  return lastResult;
}

// ============================================================================
// SECTION: Cascade & Execution Helpers
// ============================================================================

/**
 * Byte length of every argument `buildClaudeArgs` adds around the prompt, plus a separator per
 * argument. Used to reserve room against the batch-launcher command-line ceiling.
 *
 * @param {{ model?: string|null, effort?: string|null, sandbox?: boolean, responseSchema?: Record<string, any>|null }} [opts]
 * @returns {number}
 */
export function claudeFixedArgBytes({ model, effort, sandbox = true, responseSchema = null } = {}) {
  const withPrompt = buildClaudeArgs('', { model, effort, sandbox, responseSchema });
  return withPrompt.reduce((sum, arg) => sum + Buffer.byteLength(String(arg), 'utf8') + 1, 0);
}

/**
 * Builds the `claude -p` argument array. `model`/`effort` are omitted entirely when
 * falsy so the Claude CLI's own default applies — dispatch ships no hardcoded fallback.
 * `--permission-mode plan` and `--disallowedTools` layer on the allowlist so a write tool
 * stays denied even if a future CLI widens what the allowlist implies. The inline
 * `--settings` JSON enables Claude's native OS-level Bash sandbox by default, layering
 * defense in depth on top of the structural read-only controls above.
 * @param {string} argvPrompt
 * @param {{ model?: string|null, effort?: string|null, sandbox?: boolean, responseSchema?: Record<string, any>|null }} [opts]
 * @returns {string[]}
 */
export function buildClaudeArgs(argvPrompt, { model, effort, sandbox = true, responseSchema = null } = {}) {
  const args = ['-p', argvPrompt, '--output-format', 'json', '--permission-mode', 'plan'];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (responseSchema) args.push('--json-schema', JSON.stringify(responseSchema));
  args.push('--settings', JSON.stringify({ sandbox: { enabled: sandbox } }));
  for (const tool of READ_ONLY_ALLOWED_TOOLS) {
    args.push('--allowedTools', tool);
  }
  // Variadic flag: kept last so its tool list cannot swallow a later positional.
  args.push('--disallowedTools', ...DISALLOWED_WRITE_TOOLS);
  return args;
}

/**
 * Pure cascade decision for one target/model attempt, covering both the result path and
 * the `catch (err)` path (mutually exclusive: pass `error` OR `result`, never both).
 * `runClaude`'s loop delegates here so the cascade logic is unit-testable without
 * spawning the real CLI; the stderr notices stay in the loop, unchanged.
 * @param {{ result: Record<string, any>|null, error: Error|null, isLastModel: boolean, isLastTarget: boolean, pinned: boolean }} args
 * @returns {'return'|'throw'|'next-model'|'next-target'}
 */
export function nextClaudeStep({ result, error, isLastModel, isLastTarget, pinned }) {
  if (error) {
    if (!isLastModel) return 'next-model';
    if (!isLastTarget && !pinned) return 'next-target';
    return 'throw';
  }
  // resolveRunnerExitCode already maps an error envelope, empty output, and truncation to
  // non-zero, so exit 0 is a real answer whatever label failureKind carries.
  if (result.exitCode === 0) return 'return';
  // runClaude has already downgraded an unsupported sandbox, so every failure kind advances.
  if (!isLastModel) return 'next-model';
  const isQuotaOrAuth = result.failureKind === 'quota' || result.failureKind === 'auth';
  if (isQuotaOrAuth && !isLastTarget && !pinned) return 'next-target';
  return 'return';
}


/** Filters {@link MODE_DEFINITIONS} down to modes with a reachable binary. */
function findViableTargets(claudeMode) {
  const candidates = claudeMode
    ? MODE_DEFINITIONS.filter((m) => m.mode === claudeMode.toLowerCase())
    : MODE_DEFINITIONS;

  const viable = [];
  for (const candidate of candidates) {
    const bin = candidate.fn();
    if (bin && testClaudeBinaryReachability(bin).reachable) {
      viable.push({ mode: candidate.mode, name: candidate.name, bin });
    }
  }
  // Modes routinely resolve to the same executable; with CLI prioritized first,
  // finding a CLI binary on PATH takes precedence in deduplication.
  return dedupeTargetsByBinary(viable, (t) => t.bin);
}

function createNoTargetsError() {
  return createCliNotFoundError(
    'Claude Code was not found or not reachable in any mode (Claude Desktop, VS Code extension, or CLI).\n' +
      'Install options:\n' +
      '  - Claude Desktop: Install Claude Desktop application\n' +
      '  - VS Code Extension: Install Anthropic Claude Code extension\n' +
      '  - Claude CLI: npm install -g @anthropic-ai/claude-code (or curl -fsSL https://claude.ai/install.sh | bash)',
  );
}

/**
 * Spawns Claude Code on a single resolved target/model pair and resolves once the
 * process exits, enforcing the timeout and buffer caps.
 *
 * The subprocess lifecycle (buffering, timers, caps, kill, the error+close settled guard)
 * is shared machinery — `runDelegateCapture` in runners/shared.mjs. This function keeps only what
 * is Claude-specific: the batch-budget prompt spill, the JSON envelope parse, the session
 * id fallback, and the failure-kind composition. The logger stays open on success —
 * `runClaude` owns it for the whole cascade.
 * @returns {Promise<RunClaudeResult>}
 */
async function executeOnTarget({
  target,
  model,
  formattedPrompt,
  effort,
  sandbox,
  responseSchema,
  timeout,
  maxBufferMb,
  verbose,
  sessionLogger,
}) {
  // Headless print mode (interactive mode removed — delegates are always headless)
  const { prompt: argvPrompt, briefFile } = preparePromptForArgv(formattedPrompt, 'claude', {
    binary: target.bin,
    // `buildClaudeArgs` appends an `--allowedTools` pair per read-only tool plus the variadic
    // `--disallowedTools` list and the inline `--settings` sandbox JSON; measured here so the
    // batch-launcher check budgets the whole command line rather than the prompt alone.
    reservedBytes: claudeFixedArgBytes({ model, effort, sandbox, responseSchema }),
  });
  try {
    const claudeArgs = buildClaudeArgs(argvPrompt, { model, effort, sandbox, responseSchema });

    emitInitBanner({
      platform: 'claude',
      mode: target.mode,
      model,
      effort,
      logFile: sessionLogger.logFile,
    });

    const trace = createTraceWriter(verbose);

    return await runDelegateCapture({
      spawnChild: () =>
        spawnCli(target.bin, claudeArgs, {
          cwd: PROJECT_ROOT,
          env: getSanitizedEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
        }),
      timeoutSeconds: timeout,
      maxBufferMb,
      sessionLogger,
      trace,
      onClose: (outcome) => {
        const envelope = parseClaudeEnvelope(outcome.stdoutBuffer);
        const sessionId = envelope.sessionId || extractClaudeSessionId(outcome.stderrBuffer);
        const sessionLink = sessionId ? `claude --resume ${sessionId}` : null;

        const exitCode = resolveRunnerExitCode({
          code: outcome.code,
          signal: outcome.signal,
          truncated: outcome.truncated,
          cleanStdout: envelope.text,
          isError: envelope.isError,
        });

        // A success envelope carries subtype 'success'; only an error envelope's subtype is a failure.
        const classifiedFailure = classifyClaudeResult({
          exitCode,
          stderr: outcome.stderrBuffer,
          stdout: envelope.text,
        });
        const { failureKind, effectiveExitCode } = resolveClaudeOutcome({
          envelope,
          classifiedFailure,
          exitCode,
          truncated: outcome.truncated,
        });
        // Written here, before the caller closes the session logger.
        const warning = sandboxWarning({ sandbox, exitCode: effectiveExitCode, stderr: outcome.stderrBuffer });
        if (warning) {
          process.stderr.write(warning);
          sessionLogger.write(warning);
        }
        const downgradeFields = warning ? { sandboxDowngraded: true, warnings: [warning.trim()] } : {};

        emitCompletionBanner({
          platform: 'claude',
          exitCode: effectiveExitCode,
          truncated: outcome.truncated,
          sessionId,
          resumeCommand: sessionLink,
        });

        return {
          provider: 'claude',
          claudeMode: target.mode,
          bin: target.bin,
          model,
          stdout: envelope.text,
          rawStdout: outcome.stdoutBuffer,
          stderr: outcome.stderrBuffer,
          exitCode: effectiveExitCode,
          logFile: sessionLogger.logFile,
          briefFile,
          sessionId,
          sessionLink,
          truncated: outcome.truncated,
          failureKind,
          ...downgradeFields,
        };
      },
    });
  } finally {
    // Also covers a synchronous throw between the spill and the spawn.
    removeBriefFile(briefFile);
  }
}

// ============================================================================
// SECTION: CLI Entry Point
// ============================================================================

/** Runner-specific flags, exported so the flag-parity test checks `--help` against the real list.
 * `aliases` maps both mode spellings onto one canonical value — the last spelling on argv wins. */
export const CLI_FLAGS = {
  valueFlags: ['--claude-mode', '--mode'],
  booleanFlags: ['--test-modes', '--probe-modes', '--reachability', '--sandbox', '--no-sandbox'],
  aliases: { '--claude-mode': 'requestedMode', '--mode': 'requestedMode' },
};

export async function main() {
  const options = parseCommonArgs(process.argv, CLI_FLAGS);
  const { requestedMode, testModes, sandbox } = parseModeFlags(process.argv.slice(2));

  if (testModes) {
    printReachabilityReport();
    process.exit(0);
  }

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
    console.error('Error: No prompt provided.');
    process.exit(1);
  }

  try {
    const res = await runClaude({
      ...options,
      claudeMode: /** @type {ClaudeMode|null} */ (requestedMode),
      sandbox,
      prompt: finalPrompt,
    });
    if (shouldPrintClaudeStdout(res) && res.stdout) {
      process.stdout.write(res.stdout.endsWith('\n') ? res.stdout : `${res.stdout}\n`);
    }
    process.exit(res.exitCode);
  } catch (err) {
    console.error(formatCliError(err));
    process.exit(safeExitCode(err));
  }
}

/** Parses runner-specific mode, sandbox, and reachability flags. */
export function parseModeFlags(args) {
  const { values, booleans } = parseRunnerModeArgs(args, CLI_FLAGS);
  return {
    requestedMode: values.requestedMode,
    testModes:
      booleans['--test-modes'] || booleans['--probe-modes'] || booleans['--reachability'],
    sandbox: !booleans['--no-sandbox'],
  };
}

/**
 * Classifies Claude-specific diagnostics before applying the shared failure classifier.
 *
 * @param {string} text Raw stdout and stderr
 * @returns {'sandbox-unsupported'|'quota'|'context-overflow'|'auth'|'cli-outdated'|'model-not-found'|'model-not-loaded'|'not-found'|'timeout'|null}
 */
export function classifyClaudeFailure(text) {
  if (CLI_OUTDATED_PATTERN.test(text ?? '')) return 'cli-outdated';
  if (MODEL_NOT_FOUND_PATTERN.test(text ?? '')) return 'model-not-found';
  const standardFailure = classifyFailure(text);
  if (standardFailure) return standardFailure;
  if (isSandboxUnsupportedDiagnostic(stripSandboxAdvisory(text), { includeSettings: true })) {
    return 'sandbox-unsupported';
  }
  return null;
}

/**
 * Classifies one completed Claude run. A successful answer is kept out of diagnostic matching;
 * a non-zero run may include provider details on either stream.
 *
 * @param {{ exitCode: number, stderr?: string, stdout?: string }} result
 * @returns {'sandbox-unsupported'|'quota'|'context-overflow'|'auth'|'cli-outdated'|'model-not-found'|'model-not-loaded'|'not-found'|'timeout'|null}
 */
export function classifyClaudeResult({ exitCode, stderr = '', stdout = '' }) {
  // The "Sandbox disabled … not active" advisory is informational, never an unsupported-flag diagnostic.
  const diagnostics = stripSandboxAdvisory(stderr);
  if (exitCode === 0) {
    const standardFailure = classifyFailure(stderr);
    if (standardFailure) return standardFailure;
    return isSandboxUnsupportedDiagnostic(diagnostics, { includeSettings: true, strict: true })
      ? 'sandbox-unsupported'
      : null;
  }
  if (CLI_OUTDATED_PATTERN.test(`${stderr}\n${stdout}`)) return 'cli-outdated';
  if (MODEL_NOT_FOUND_PATTERN.test(`${stderr}\n${stdout}`)) return 'model-not-found';
  const standardFailure = classifyFailure(`${stderr}\n${stdout}`);
  if (standardFailure) return standardFailure;
  return isSandboxUnsupportedDiagnostic(diagnostics, { includeSettings: true })
    ? 'sandbox-unsupported'
    : null;
}

/**
 * Applies Claude's error-envelope precedence and the fail-closed exit status for sandbox
 * contract failures in one pure seam.
 *
 * @param {{ envelope?: Record<string, any>, classifiedFailure?: string|null, exitCode: number|null, truncated?: string|null }} options
 */
export function resolveClaudeOutcome({ envelope = {}, classifiedFailure = null, exitCode, truncated = null }) {
  const cliOutdated = envelope.apiErrorCode === 'claude_code_version_too_old'
    || (envelope.isError && CLI_OUTDATED_PATTERN.test(envelope.raw ?? ''))
    || classifiedFailure === 'cli-outdated';
  const modelNotFound = envelope.apiErrorStatus === 404
    || (envelope.isError && MODEL_NOT_FOUND_PATTERN.test(envelope.raw ?? ''))
    || classifiedFailure === 'model-not-found';
  // An API error envelope can still carry subtype 'success', which names no failure.
  const subtype = envelope.isError && envelope.subtype !== 'success' ? envelope.subtype : null;
  // Precedence: genuine sandbox-unsupported > timeout > cli-outdated > model-not-found > envelope subtype > other kinds > buffer.
  const failureKind =
    classifiedFailure === 'sandbox-unsupported'
      ? classifiedFailure
      : truncated === 'timeout'
        ? 'timeout'
        : cliOutdated
        ? 'cli-outdated'
        : modelNotFound
          ? 'model-not-found'
          : subtype || classifiedFailure || truncated || null;
  return {
    failureKind,
    effectiveExitCode: failureKind === 'sandbox-unsupported' ? 1 : exitCode,
  };
}

const MODEL_NOT_FOUND_PATTERN = /selected model|model\b[^\n]*\bnot found/i;
const CLI_OUTDATED_PATTERN = /claude_code_version_too_old|Claude Code \S+ does not support this model/i;
const SANDBOX_ADVISORY_PATTERN = /^[^\n]*Sandbox disabled[^\n]*not active[^\n]*$/gim;

function stripSandboxAdvisory(text) {
  return String(text ?? '').replace(SANDBOX_ADVISORY_PATTERN, '');
}

export const CLAUDE_DOWNGRADE_WARNING = '[dispatch] WARNING: Claude sandbox is unavailable; the run proceeded unsandboxed.';

/** Whether Claude printed its "Sandbox disabled … not active" advisory. */
export function claudeSandboxInactive(stderr) {
  return /Sandbox disabled[^\n]*not active/i.test(String(stderr ?? ''));
}

/**
 * The one-line warning for a successful run that requested the sandbox but ran unsandboxed
 * (Claude's sandbox supports macOS, Linux, and WSL2 only), or null.
 */
export function sandboxWarning({ sandbox, exitCode, stderr, platform = process.platform }) {
  if (!sandbox || exitCode !== 0 || !claudeSandboxInactive(stderr)) return null;
  const cause = platform === 'win32' ? ' Native Windows is unsupported; use WSL2.' : '';
  return `[dispatch] WARNING: Claude sandbox is not active; the run proceeded unsandboxed.${cause}\n`;
}

/** Whether the direct runner may print the delegate's answer to stdout. */
export function shouldPrintClaudeStdout(result) {
  return result?.failureKind !== 'sandbox-unsupported';
}

function printReachabilityReport() {
  const report = probeAllClaudeModes();
  console.log('\nClaude Modes Reachability Report:');
  for (const r of report) {
    const statusIcon = r.reachable ? '✓ REACHABLE' : '✗ UNREACHABLE';
    const detail = r.reachable ? `(version: ${r.version})` : `(${r.error || 'not installed'})`;
    console.log(`  - [${r.mode}] ${r.name.padEnd(26)}: ${statusIcon} ${detail}`);
    if (r.bin) {
      console.log(`      Path: ${r.bin}`);
    }
  }
  const resolved = resolveClaudeTarget();
  console.log(
    `\nActive preference selection: ${
      resolved ? `${resolved.name} [${resolved.mode}] (${resolved.bin})` : 'None found'
    }\n`,
  );
}

function printHelp() {
  console.log(`
Claude Code CLI Runner (claude)

Usage:
  node scripts/runners/claude.mjs [options] [prompt]

Options:
  -p, --prompt <string>         The prompt message to send
  -f, --file, --artifact        Attach context file or artifact (repeatable)
  -m, --model <name>            Override Claude model (no default here — see dispatch's config.sample.jsonc)
  -e, --effort, --reasoning-effort <level>
                                Override reasoning effort (no default here — see dispatch's config.sample.jsonc)
  -t, --timeout <seconds>       Override timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})
  --prompt-file <path>          Read the prompt from a file instead of an argument
  --max-buffer <MB>             Raise the subprocess output cap (default: ${DEFAULT_MAX_BUFFER_MB})
  --claude-mode, --mode <mode>  Select execution mode: cli | desktop | vscode
  --sandbox                     Enable Claude's native OS-level Bash sandbox (default)
  --no-sandbox                  Disable Claude's native OS-level Bash sandbox
  --test-modes, --probe-modes, --reachability
                                Test reachability of all modes (--version) without token consumption
  -v, --verbose                 Stream live trace to stderr (terminal only; ignored when piped)
  -h, --help                    Show this help

Preference Order:
  1. Claude CLI (cli)
  2. Claude Desktop (desktop)
  3. Claude VS Code Extension (vscode)
`);
}

// ============================================================================
// SECTION: Mode Resolution & Reachability
// ============================================================================

/**
 * Resolves the Claude binary in cascade preference order, or for one pinned mode.
 * @param {ClaudeMode|null} [preferredMode]
 * @returns {string|null}
 */
export function getClaudeBinary(preferredMode = null) {
  const target = resolveClaudeTarget(preferredMode);
  return target ? target.bin : null;
}

/**
 * Resolves the active Claude execution target with mode metadata.
 * @param {ClaudeMode|null} [preferredMode]
 * @returns {ClaudeTarget|null}
 */
export function resolveClaudeTarget(preferredMode = null) {
  const candidates = preferredMode
    ? MODE_DEFINITIONS.filter((m) => m.mode === preferredMode.toLowerCase())
    : MODE_DEFINITIONS;

  for (const candidate of candidates) {
    const bin = candidate.fn();
    if (bin) {
      return { mode: candidate.mode, name: candidate.name, bin };
    }
  }
  return null;
}

/**
 * Tests whether a Claude binary is reachable and executable without requiring tokens or
 * subscriptions. Runs `--version` with a short timeout.
 * @param {string} binPath
 * @returns {{ reachable: boolean, version: string|null, error: string|null }}
 */
export function testClaudeBinaryReachability(binPath) {
  return probeCliReachability({ bin: binPath, args: ['--version'], timeoutMs: 3000 });
}

/**
 * Probes all three Claude modes, reporting reachability, paths, and versions without
 * consuming tokens.
 * @returns {Array<{ mode: ClaudeMode, name: string, bin: string|null, reachable: boolean, version: string|null, status: string, error?: string }>}
 */
export function probeAllClaudeModes() {
  return MODE_DEFINITIONS.map(({ mode, name, fn }) => {
    const bin = fn();
    if (!bin) {
      return { mode, name, bin: null, reachable: false, version: null, status: 'NOT_FOUND' };
    }
    const reach = testClaudeBinaryReachability(bin);
    return {
      mode,
      name,
      bin,
      reachable: reach.reachable,
      version: reach.version,
      status: reach.reachable ? 'REACHABLE' : 'UNREACHABLE',
      error: reach.error || undefined,
    };
  });
}

/**
 * Checks if Claude Code is available in any mode (or a specific preferred mode)
 * by verifying binary reachability up to `--version`.
 * @param {ClaudeMode|null} [preferredMode]
 * @returns {Promise<boolean>}
 */
export async function isClaudeAvailable(preferredMode = null) {
  const bin = getClaudeBinary(preferredMode);
  if (!bin) return false;
  return testClaudeBinaryReachability(bin).reachable;
}

// ============================================================================
// SECTION: Binary Discovery — Mode 2: Claude Desktop (`desktop`)
// ============================================================================

/**
 * Resolves the Claude Code binary bundled or managed by the Claude Desktop application.
 *
 * Branching by Operating System:
 * - macOS (darwin):
 *   Probes `~/Library/Application Support/Claude/claude-code/<version>/claude.app/Contents/MacOS/claude`
 *   as well as fallback app bundle resource paths.
 * - Windows (win32):
 *   Probes `%APPDATA%\Claude\claude-code` and `%LOCALAPPDATA%\Claude\claude-code` for `<version>\claude.exe`,
 *   and `%LOCALAPPDATA%\Programs\Claude\resources\claude-code\claude.exe`.
 * - Linux (linux):
 *   Probes `~/.config/Claude/claude-code/<version>/claude`, `~/.local/share/Claude/claude-code/...`,
 *   and `/opt/Claude/claude-code/claude`.
 *
 * @returns {string|null}
 */
export function getClaudeDesktopBinary() {
  const candidates = [];

  // [OS: macOS] Claude Desktop installs helper CLI binaries inside
  // ~/Library/Application Support/Claude/claude-code/<version>/claude.app
  if (process.platform === 'darwin') {
    const appSupportClaudeCode = path.join(
      os.homedir(),
      'Library/Application Support/Claude/claude-code',
    );
    for (const ver of scanVersionDirs(appSupportClaudeCode)) {
      candidates.push(
        path.join(appSupportClaudeCode, ver, 'claude.app/Contents/MacOS/claude'),
        path.join(appSupportClaudeCode, ver, 'claude'),
        path.join(appSupportClaudeCode, ver, 'bin/claude'),
      );
    }
    candidates.push(
      '/Applications/Claude.app/Contents/Resources/claude-code/claude',
      path.join(os.homedir(), 'Applications/Claude.app/Contents/Resources/claude-code/claude'),
    );
  }

  // [OS: Windows] Claude Desktop stores app data in %APPDATA%\Claude and %LOCALAPPDATA%\Claude
  if (process.platform === 'win32') {
    const winDirs = [
      process.env.APPDATA ? path.join(process.env.APPDATA, 'Claude', 'claude-code') : null,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Claude', 'claude-code') : null,
    ].filter(Boolean);

    for (const winDir of winDirs) {
      for (const ver of scanVersionDirs(winDir)) {
        candidates.push(
          path.join(winDir, ver, 'claude.exe'),
          path.join(winDir, ver, 'claude', 'claude.exe'),
          path.join(winDir, ver, 'bin', 'claude.exe'),
        );
      }
    }

    if (process.env.LOCALAPPDATA) {
      candidates.push(
        path.join(process.env.LOCALAPPDATA, 'Programs', 'Claude', 'resources', 'claude-code', 'claude.exe'),
        path.join(process.env.LOCALAPPDATA, 'Programs', 'Claude', 'claude-code', 'claude.exe'),
      );
    }
  }

  // [OS: Linux] Claude Desktop / packages place data in ~/.config/Claude or ~/.local/share/Claude
  if (process.platform === 'linux') {
    const linuxDirs = [
      path.join(os.homedir(), '.config', 'Claude', 'claude-code'),
      path.join(os.homedir(), '.local', 'share', 'Claude', 'claude-code'),
    ];
    for (const lDir of linuxDirs) {
      for (const ver of scanVersionDirs(lDir)) {
        candidates.push(
          path.join(lDir, ver, 'claude'),
          path.join(lDir, ver, 'bin', 'claude'),
        );
      }
    }
    candidates.push(
      '/opt/Claude/claude-code/claude',
      '/opt/claude/claude-code/claude',
    );
  }

  return findFirstExistingFile(candidates);
}

// ============================================================================
// SECTION: Binary Discovery — Mode 3: Claude VS Code Extension (`vscode`)
// ============================================================================

/**
 * Resolves the Claude Code binary bundled with the Anthropic VS Code Extension.
 *
 * Branching by Operating System & IDE:
 * - Cross-platform:
 *   1. Direct environment variable export `CLAUDE_CODE_EXECPATH`.
 *   2. Probes VS Code extension directories (`~/.vscode/extensions`, `~/.vscode-insiders/extensions`,
 *      `~/.vscode-server/extensions`, `~/.cursor/extensions`) for `anthropic.claude-code-*`.
 * - macOS (darwin):
 *   Probes `~/Library/Application Support/Code/agent-host/sdk-cache/claude` and `Code - Insiders`.
 * - Windows (win32):
 *   Probes `%APPDATA%\Code\agent-host\sdk-cache\claude` and `Code - Insiders`.
 * - Linux (linux):
 *   Probes `~/.config/Code/agent-host/sdk-cache/claude` and `Code - Insiders`.
 *
 * @returns {string|null}
 */
export function getClaudeVSCodeBinary() {
  const candidates = [];
  const homeDir = os.homedir();

  // [Cross-platform] The VS Code extension exports CLAUDE_CODE_EXECPATH into terminals it spawns.
  if (process.env.CLAUDE_CODE_EXECPATH) {
    candidates.push(process.env.CLAUDE_CODE_EXECPATH);
  }

  // [Cross-platform] Scan standard VS Code / Cursor extension directories for native binaries.
  const extBaseDirs = [
    path.join(homeDir, '.vscode', 'extensions'),
    path.join(homeDir, '.vscode-insiders', 'extensions'),
    path.join(homeDir, '.vscode-server', 'extensions'),
    path.join(homeDir, '.cursor', 'extensions'),
  ];

  for (const extBase of extBaseDirs) {
    if (!fs.existsSync(extBase)) continue;
    try {
      const entries = fs.readdirSync(extBase, { withFileTypes: true });
      const claudeExts = entries
        .filter((entry) => entry.isDirectory() && /(?:anthropic\.)?claude-code/i.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));

      for (const extName of claudeExts) {
        if (process.platform === 'win32') {
          candidates.push(
            path.join(extBase, extName, 'resources', 'native-binary', 'claude.exe'),
            path.join(extBase, extName, 'bin', 'claude.exe'),
            path.join(extBase, extName, 'resources', 'native-binary', 'claude.cmd'),
          );
        } else {
          candidates.push(
            path.join(extBase, extName, 'resources', 'native-binary', 'claude'),
            path.join(extBase, extName, 'bin', 'claude'),
          );
        }
      }
    } catch {}
  }

  // [OS: macOS] Agent-host SDK cache
  if (process.platform === 'darwin') {
    const macCodeRoots = [
      path.join(homeDir, 'Library/Application Support/Code/agent-host/sdk-cache/claude'),
      path.join(homeDir, 'Library/Application Support/Code - Insiders/agent-host/sdk-cache/claude'),
    ];
    for (const sdkRoot of macCodeRoots) {
      for (const ver of scanVersionDirs(sdkRoot)) {
        candidates.push(
          path.join(sdkRoot, ver, 'darwin-arm64/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'),
          path.join(sdkRoot, ver, 'darwin-x64/node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/claude'),
        );
      }
    }
  }

  // [OS: Windows] Agent-host SDK cache
  if (process.platform === 'win32' && process.env.APPDATA) {
    const winCodeRoots = [
      path.join(process.env.APPDATA, 'Code', 'agent-host', 'sdk-cache', 'claude'),
      path.join(process.env.APPDATA, 'Code - Insiders', 'agent-host', 'sdk-cache', 'claude'),
    ];
    for (const sdkRoot of winCodeRoots) {
      for (const ver of scanVersionDirs(sdkRoot)) {
        candidates.push(
          path.join(sdkRoot, ver, 'win32-x64', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe'),
          path.join(sdkRoot, ver, 'win32-arm64', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-arm64', 'claude.exe'),
        );
      }
    }
  }

  // [OS: Linux] Agent-host SDK cache
  if (process.platform === 'linux') {
    const linuxCodeRoots = [
      path.join(homeDir, '.config', 'Code', 'agent-host', 'sdk-cache', 'claude'),
      path.join(homeDir, '.config', 'Code - Insiders', 'agent-host', 'sdk-cache', 'claude'),
    ];
    for (const sdkRoot of linuxCodeRoots) {
      for (const ver of scanVersionDirs(sdkRoot)) {
        candidates.push(
          path.join(sdkRoot, ver, 'linux-x64/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'),
          path.join(sdkRoot, ver, 'linux-arm64/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude'),
        );
      }
    }
  }

  return findFirstExistingFile(candidates);
}

// ============================================================================
// SECTION: Binary Discovery — Mode 1: Claude CLI (`cli`)
// ============================================================================

/**
 * Resolves the standalone Claude Code CLI binary installed via npm, native installer, or
 * package manager.
 *
 * Branching by Operating System:
 * - macOS / Linux:
 *   Probes `~/.local/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`,
 *   global npm/nvm paths, and system PATH via `which`.
 * - Windows:
 *   Probes `%APPDATA%\npm\claude.cmd`, `%USERPROFILE%\.local\bin\claude.exe`, and system PATH
 *   via `where.exe`. Prefers nested direct `claude.exe` to avoid batch launcher argument mangling.
 *
 * @returns {string|null}
 */
export function getClaudeCliBinary() {
  const extraCandidates = [];

  // [OS: macOS / Linux]
  if (process.platform !== 'win32') {
    extraCandidates.push(
      '~/.local/bin/claude',
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      '~/.npm-global/bin/claude',
    );

    const nvmVersionsDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
    for (const ver of scanVersionDirs(nvmVersionsDir)) {
      extraCandidates.push(path.join(nvmVersionsDir, ver, 'bin', 'claude'));
    }
  }

  // [OS: Windows]
  if (process.platform === 'win32') {
    if (process.env.APPDATA) {
      extraCandidates.push(
        path.join(process.env.APPDATA, 'npm', 'claude.cmd'),
        path.join(process.env.APPDATA, 'npm', 'claude'),
      );
    }
    if (process.env.USERPROFILE) {
      extraCandidates.push(
        path.join(process.env.USERPROFILE, '.local', 'bin', 'claude.exe'),
        path.join(process.env.USERPROFILE, '.local', 'bin', 'claude.cmd'),
      );
    }
    if (process.env.LOCALAPPDATA) {
      extraCandidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Claude', 'claude.exe'));
    }
  }

  const bin = findBinary(
    process.platform === 'win32' ? ['claude.cmd', 'claude.exe'] : 'claude',
    extraCandidates,
  );

  // [OS: Windows] Prefer direct claude.exe inside node_modules over the .cmd launcher
  if (process.platform === 'win32' && bin) {
    const nestedExe = path.join(
      path.dirname(bin),
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe',
    );
    if (fs.existsSync(nestedExe)) {
      return nestedExe;
    }
  }

  return bin;
}


// ============================================================================
// SECTION: Session ID & Envelope Parsing
// ============================================================================

/**
 * Extracts Claude session ID from raw output or error trace.
 *
 * Fallback only: `--output-format json` carries `session_id` directly. The loose
 * `session: <word>` form was dropped because review prose matched it and produced
 * bogus resume commands.
 */
export function extractClaudeSessionId(text) {
  return extractSessionIdFromOutput(text, 'claude');
}

/**
 * Parses the `--output-format json` envelope, which carries the assistant text, the
 * session id, and an explicit error subtype (`error_max_turns`, quota failures).
 * Falls back to heuristic text extraction when the envelope is absent or malformed.
 */
export function parseClaudeEnvelope(rawStdout) {
  const fallback = () => ({
    text: extractCleanResponse(rawStdout),
    sessionId: extractClaudeSessionId(rawStdout),
    isError: false,
    subtype: null,
    apiErrorStatus: null,
    apiErrorCode: null,
    raw: rawStdout || '',
  });

  const trimmed = (rawStdout || '').trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return fallback();

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return fallback();
  }

  const envelope = Array.isArray(parsed)
    ? parsed.findLast((entry) => entry && entry.type === 'result')
    : parsed;
  if (!envelope || typeof envelope !== 'object') return fallback();

  const text =
    typeof envelope.result === 'string'
      ? envelope.result
      : typeof envelope.error === 'string'
        ? envelope.error
        : '';

  return {
    text: text.trim(),
    sessionId: typeof envelope.session_id === 'string' ? envelope.session_id : null,
    isError: envelope.is_error === true,
    subtype: typeof envelope.subtype === 'string' ? envelope.subtype : null,
    apiErrorStatus: Number.isInteger(envelope.api_error_status) ? envelope.api_error_status : null,
    apiErrorCode: typeof envelope.api_error_code === 'string' ? envelope.api_error_code : null,
    raw: trimmed,
  };
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
