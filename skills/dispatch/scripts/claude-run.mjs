#!/usr/bin/env node

/**
 * @file claude-run.mjs
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
  dedupeTargetsByBinary,
  emitCompletionBanner,
  emitInitBanner,
  extractCleanResponse,
  extractSessionIdFromOutput,
  findBinary,
  findFirstExistingFile,
  getSanitizedEnv,
  isSandboxUnsupportedDiagnostic,
  isMainModule,
  parseCommonArgs,
  parseRunnerModeArgs,
  preparePromptForArgv,
  probeCliReachability,
  PROJECT_ROOT,
  readStdin,
  resolveRunnerExitCode,
  runDelegateCapture,
  scanVersionDirs,
  spawnCli,
  validateEffortSpec,
  validateModelSpec,
} from './common.mjs';

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
 * @property {string} prompt
 * @property {string[]} [files]
 * @property {string|string[]} [model] Model id, comma-separated list, or array — tried in order.
 * @property {string} [effort]
 * @property {boolean} [sandbox] Enable Claude's native OS-level Bash sandbox (default true).
 * @property {object|null} [responseSchema] JSON Schema enforced by Claude's structured output.
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
 */

// ============================================================================
// SECTION: Constants (tweak these)
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
// SECTION: Main API — runClaude()
// ============================================================================

/**
 * Runs a prompt through Claude Code using the preferred mode (cli > desktop > vscode).
 * If a mode encounters auth or quota failure (unsubscribed or out of tokens), it cascades
 * to the next available mode in preference order unless pinned via `claudeMode`.
 *
 * @param {RunClaudeOptions} options
 * @returns {Promise<RunClaudeResult>}
 */
export async function runClaude(options = {}) {
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
          sandbox,
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
        lastResult = result;

        const step = nextClaudeStep({ result, error: null, isLastModel, isLastTarget, pinned: !!claudeMode });

        if (step === 'next-model') {
          const nextModel = modelsToTry[m + 1];
          process.stderr.write(
            `[dispatch] Notice: Model '${currentModel}' failed or not available on ${target.name} (exit ${result.exitCode}${result.failureKind ? `, failure: ${result.failureKind}` : ''}).\n` +
              `[dispatch] Trying fallback model '${nextModel}'...\n`,
          );
          continue;
        }

        if (step === 'next-target') {
          process.stderr.write(
            `[dispatch] Notice: ${target.name} exited with '${result.failureKind}' (not subscribed or token depleted).\n` +
              `[dispatch] Cascading to next available mode (${viableTargets[i + 1].name})...\n`,
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
        const step = nextClaudeStep({ result: null, error: err, isLastModel, isLastTarget, pinned: !!claudeMode });

        if (step === 'next-model') {
          process.stderr.write(
            `[dispatch] Warning: Model '${currentModel}' execution failed on ${target.name} (${err.message}). Trying fallback model '${modelsToTry[m + 1]}'...\n`,
          );
          continue;
        }
        if (step === 'next-target') {
          process.stderr.write(
            `[dispatch] Warning: ${target.name} execution failed (${err.message}). Cascading to next mode...\n`,
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
 * @param {{ model?: string|null, effort?: string|null, sandbox?: boolean }} [opts]
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
 * @param {{ model?: string|null, effort?: string|null, sandbox?: boolean, responseSchema?: object|null }} [opts]
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
 * @param {{ result: object|null, error: Error|null, isLastModel: boolean, isLastTarget: boolean, pinned: boolean }} args
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
  // An unsupported sandbox setting is a property of the CLI/mode, not the model — retrying
  // across models or execution modes would just repeat the same diagnostic. Return so the
  // outer dispatch cascade can choose another provider.
  if (result.failureKind === 'sandbox-unsupported') {
    return 'return';
  }
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
 * is shared machinery — `runDelegateCapture` in common.mjs. This function keeps only what
 * is Claude-specific: the batch-budget prompt spill, the JSON envelope parse, the session
 * id fallback, and the failure-kind composition. The logger stays open on success —
 * `runClaude` owns it for the whole cascade.
 * @returns {Promise<RunClaudeResult>}
 */
function executeOnTarget({
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
  const claudeArgs = buildClaudeArgs(argvPrompt, { model, effort, sandbox, responseSchema });

  const providerLabel = `Claude Code [${target.mode}] (claude)`;
  emitInitBanner({
    provider: providerLabel,
    model,
    effort,
    logFile: sessionLogger.logFile,
    mode: 'READ-ONLY',
  });

  const trace = createTraceWriter(verbose);

  return runDelegateCapture({
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

      emitCompletionBanner({
        provider: providerLabel,
        sessionLink,
        exitCode: effectiveExitCode,
        truncated: outcome.truncated,
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
      };
    },
  });
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
      claudeMode: requestedMode,
      sandbox,
      prompt: finalPrompt,
    });
    if (shouldPrintClaudeStdout(res) && res.stdout) {
      process.stdout.write(res.stdout.endsWith('\n') ? res.stdout : `${res.stdout}\n`);
    }
    if (res.failureKind === 'sandbox-unsupported') {
      console.error(
        `\n[dispatch] This Claude CLI does not support the inline --settings sandbox JSON. ` +
          `Upgrade Claude Code, set platforms.claude.sandbox to false, or use --no-sandbox.\n` +
          `Session log: ${res.logFile}`,
      );
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
 * @returns {'sandbox-unsupported'|'quota'|'context-overflow'|'auth'|'model-not-loaded'|'not-found'|'timeout'|null}
 */
export function classifyClaudeFailure(text) {
  const standardFailure = classifyFailure(text);
  if (standardFailure) return standardFailure;
  if (isSandboxUnsupportedDiagnostic(text, { includeSettings: true })) {
    return 'sandbox-unsupported';
  }
  return null;
}

/**
 * Classifies one completed Claude run. A successful answer is kept out of diagnostic matching;
 * a non-zero run may include provider details on either stream.
 *
 * @param {{ exitCode: number, stderr?: string, stdout?: string }} result
 * @returns {ReturnType<typeof classifyClaudeFailure>}
 */
export function classifyClaudeResult({ exitCode, stderr = '', stdout = '' }) {
  if (exitCode === 0) {
    const standardFailure = classifyFailure(stderr);
    if (standardFailure) return standardFailure;
    return isSandboxUnsupportedDiagnostic(stderr, { includeSettings: true, strict: true })
      ? 'sandbox-unsupported'
      : null;
  }
  const standardFailure = classifyFailure(`${stderr}\n${stdout}`);
  if (standardFailure) return standardFailure;
  return isSandboxUnsupportedDiagnostic(stderr, { includeSettings: true })
    ? 'sandbox-unsupported'
    : null;
}

/**
 * Applies Claude's error-envelope precedence and the fail-closed exit status for sandbox
 * contract failures in one pure seam.
 */
export function resolveClaudeOutcome({ envelope = {}, classifiedFailure = null, exitCode, truncated = null }) {
  const failureKind =
    classifiedFailure === 'sandbox-unsupported'
      ? classifiedFailure
      : (envelope.isError && envelope.subtype) || classifiedFailure || truncated || null;
  return {
    failureKind,
    effectiveExitCode: failureKind === 'sandbox-unsupported' ? 1 : exitCode,
  };
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
  node scripts/claude-run.mjs [options] [prompt]

Options:
  -p, --prompt <string>         The prompt message to send
  -f, --file, --artifact        Attach context file or artifact (repeatable)
  -m, --model <name>            Override Claude model (no default here — see dispatch's config.default.jsonc)
  -e, --effort, --reasoning-effort <level>
                                Override reasoning effort (no default here — see dispatch's config.default.jsonc)
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
