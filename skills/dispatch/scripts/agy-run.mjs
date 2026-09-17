#!/usr/bin/env node

/**
 * @file agy-run.mjs
 * @description Dedicated runner for Google Antigravity with multi-mode resolution.
 *
 * Supports cross-platform execution across macOS, Windows, and Linux (bash/zsh/PowerShell).
 * Resolves Antigravity executables according to preference order:
 *   1. Antigravity CLI (Standalone agy/antigravity CLI)
 *   2. Antigravity 2.0 (Desktop application)
 *   3. Antigravity VS Code Extension (IDE extension / Antigravity IDE)
 *
 * Each mode is discoverable and testable up to reachability (--help) without
 * requiring active subscriptions or token consumption.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cascadeModels,
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
  existsAny,
  extractCleanResponse,
  findBinary,
  getSanitizedEnv,
  isMainModule,
  parseCommonArgs,
  parseRunnerModeArgs,
  preparePromptForArgv,
  probeCliReachability,
  PROJECT_ROOT,
  readStdin,
  resolveRunnerExitCode,
  runDelegateCapture,
  spawnCli,
} from './common.mjs';

// ============================================================================
// SECTION: Types
// ============================================================================

/** @typedef {'antigravity-cli'|'antigravity-2.0'|'antigravity-vscode'} AgyMode */

/**
 * @typedef {object} ModeDefinition
 * @property {AgyMode} mode
 * @property {string} name
 * @property {string} dataDir Value passed via JETSKI_APP_DATA_DIR for this mode.
 * @property {() => string|null} fn Resolves the binary path for this mode, or null if absent.
 */

/**
 * @typedef {object} AgyTarget
 * @property {AgyMode} mode
 * @property {string} name
 * @property {string} bin
 * @property {string} dataDir
 */

/**
 * @typedef {object} RunAgyOptions
 * @property {string} prompt
 * @property {string[]} [files]
 * @property {string} [model]
 * @property {string} [effort]
 * @property {number} [timeout] Seconds before the delegate is killed.
 * @property {number} [maxBufferMb] Stdout cap before the delegate is killed.
 * @property {boolean} [verbose]
 * @property {AgyMode|'auto'|null} [modeVariant] Pins execution to one mode; disables mode cascade.
 * @property {AgyMode|'auto'|null} [agyMode] Alias for `modeVariant`.
 */

/**
 * @typedef {object} RunAgyResult
 * @property {'agy'} provider
 * @property {AgyMode} mode
 * @property {string} stdout Cleaned response text.
 * @property {string} rawStdout Raw stdout, unparsed.
 * @property {string} stderr
 * @property {number} exitCode
 * @property {string} logFile
 * @property {string|null} briefFile
 * @property {string|null} conversationId
 * @property {string|null} sessionLink
 * @property {'timeout'|'buffer'|null} truncated
 * @property {string|null} failureKind
 */

// ============================================================================
// SECTION: Constants (tweak these)
// ============================================================================

export const AGY_MODES = {
  ANTIGRAVITY_CLI: 'antigravity-cli',
  ANTIGRAVITY_2_0: 'antigravity-2.0',
  ANTIGRAVITY_VSCODE: 'antigravity-vscode',
};

/**
 * Execution modes in cascade preference order: CLI > Antigravity 2.0 (Desktop) > VS Code Extension.
 * The single source of truth for mode metadata — every mode-aware function below
 * (resolution, probing, execution) iterates this instead of redeclaring the list.
 * @type {ModeDefinition[]}
 */
export const MODE_DEFINITIONS = [
  { mode: AGY_MODES.ANTIGRAVITY_CLI, name: 'Antigravity CLI (agy)', dataDir: 'antigravity-cli', fn: () => getAgyCliBinary() },
  { mode: AGY_MODES.ANTIGRAVITY_2_0, name: 'Antigravity 2.0 (agy)', dataDir: 'antigravity', fn: () => getAgy20Binary() },
  { mode: AGY_MODES.ANTIGRAVITY_VSCODE, name: 'Antigravity VS Code Extension (agy)', dataDir: 'antigravity-ide', fn: () => getAgyVSCodeBinary() },
];

// Derived from MODE_DEFINITIONS for callers that only need one facet of it.
export const AGY_MODE_PREFERENCE = MODE_DEFINITIONS.map((m) => m.mode);
export const AGY_MODE_DATA_DIRS = Object.fromEntries(MODE_DEFINITIONS.map((m) => [m.mode, m.dataDir]));
export const AGY_MODE_LABELS = Object.fromEntries(MODE_DEFINITIONS.map((m) => [m.mode, m.name]));

// ============================================================================
// SECTION: Main API — runAgy()
// ============================================================================

/**
 * Runs a prompt through Antigravity using the preferred mode (cli > 2.0 > vscode).
 * If a mode encounters auth or quota failure (unsubscribed or out of tokens), it cascades
 * to the next available mode in preference order unless pinned via `modeVariant`/`agyMode`.
 *
 * @param {RunAgyOptions} [options={}]
 * @returns {Promise<RunAgyResult>}
 */
export async function runAgy(options = {}) {
  const {
    prompt,
    files = [],
    model = null,
    effort = null,
    timeout = DEFAULT_TIMEOUT_SECONDS,
    maxBufferMb = DEFAULT_MAX_BUFFER_MB,
    verbose = false,
    modeVariant = null,
    agyMode = null,
    // Test seams: each defaults to the real implementation, so production calls are unchanged.
    // The cascade loop is otherwise unreachable in a test — its executor spawns a subprocess
    // and opens a session log.
    execute = executeAgyInMode,
    getAvailableModes = getAvailableAgyModes,
    getBinary = getAgyBinary,
    createLogger = createSessionLogger,
  } = options;

  const bin = getBinary();
  if (!bin) {
    throw createCliNotFoundError(
      'Google Antigravity CLI (agy) was not found in PATH or ~/.gemini/bin/agy.\n' +
        'Please ensure agy is installed: https://antigravity.google/docs/cli/reference',
    );
  }

  const requestedMode = modeVariant || agyMode || null;

  // Resolve candidate modes. `pinnedMode` — not `requestedMode` — is what the cascade guards below
  // must test: 'auto' is a *request* that deliberately pins nothing. Pinning does not depend on
  // availability, so resolve it first and skip the probe entirely when a mode is pinned.
  const { pinnedMode } = resolveModePlan({ requestedMode });
  // Preferred cascade: Antigravity CLI > Antigravity 2.0 > VS Code Extension
  const { modesToTry } = pinnedMode
    ? { modesToTry: [pinnedMode] }
    : resolveModePlan({ requestedMode, availableModes: await getAvailableModes() });

  const formattedPrompt = buildFormattedPrompt(prompt, files);
  const metricsAttempts = [];

  // Each configured model gets the full mode cascade; discovery runs once.
  return cascadeModels(resolveModelsToTry(model), runModeCascade, { label: 'Google Antigravity' });

  async function runModeCascade(currentModel) {
    let lastResult = null;
    let lastError = null;

    for (let i = 0; i < modesToTry.length; i++) {
      const currentMode = modesToTry[i];
      const sessionLogger = createLogger('agy');

      try {
        const result = await execute(currentMode, {
          model: currentModel,
          effort,
          timeout,
          maxBufferMb,
          verbose,
          sessionLogger,
          formattedPrompt,
        });
        metricsAttempts.push(buildMetricsAttempt({
          input: formattedPrompt,
          output: result.stdout,
          provider: 'agy',
          model: currentModel,
          effort,
          mode: currentMode,
          exitCode: result.exitCode,
          failureKind: result.failureKind,
          truncated: result.truncated,
          usage: result.usage,
        }));
        result.metricsAttempts = [...metricsAttempts];
        result.effectiveAttempt = metricsAttempts.length - 1;

        lastResult = result;

        // If execution reached the mode but encountered token/subscription issues,
        // cascade to the next available mode if one remains.
        const hasNextMode = i < modesToTry.length - 1 && !pinnedMode;
        const step = nextAgyStep({ result, hasNextMode });

        if (step === 'next-mode') {
          process.stderr.write(
            `[dispatch] Antigravity mode '${currentMode}' reached but lacked tokens/subscription (${result.failureKind || 'quota/auth'}).\n` +
              `[dispatch] Cascading to next preferred mode '${modesToTry[i + 1]}'...\n`,
          );
          continue;
        }

        // Covers both the success return and the "no further cascade" return.
        return result;
      } catch (err) {
        metricsAttempts.push(buildMetricsAttempt({
          input: formattedPrompt,
          provider: 'agy',
          model: currentModel,
          effort,
          mode: currentMode,
          failureKind: err.failureKind || classifyFailure(`${err.message}\n${err.stderr || ''}`),
        }));
        err.metricsAttempts = [...metricsAttempts];
        lastError = err;
        const hasNextMode = i < modesToTry.length - 1 && !pinnedMode;
        if (hasNextMode) {
          process.stderr.write(
            `[dispatch] Antigravity mode '${currentMode}' failed execution: ${err.message}.\n` +
              `[dispatch] Cascading to next preferred mode '${modesToTry[i + 1]}'...\n`,
          );
          continue;
        }
        throw err;
      } finally {
        // This loop owns the logger it created, matching runClaude/runCopilot: the shared
        // executor (runDelegateCapture) never closes a caller's logger, so this finally is the
        // sole closer — on success, on a spawn error, and on a throw before the child is even
        // spawned (which would otherwise cascade and open another). close() is idempotent.
        sessionLogger.close();
      }
    }

    if (lastResult) return lastResult;
    if (lastError) throw lastError;

    const err = new Error('No Antigravity mode was able to execute the request.');
    err.code = 1;
    throw err;
  }
}

// ============================================================================
// SECTION: Cascade & Execution Helpers
// ============================================================================

/**
 * Checks if output indicates a token exhaustion, missing subscription, or unauthenticated state.
 * @param {string} text - Combined stderr and stdout output
 * @returns {boolean}
 */
export function isSubscriptionOrTokenIssue(text) {
  if (!text || typeof text !== 'string') return false;
  return (
    /\b(usage limit|rate limit|quota|credit balance|insufficient[_ ]quota|too many requests|\b429\b)/i.test(
      text,
    ) ||
    /\b(unauthorized|not authenticated|authentication failed|no authentication|invalid api key|please (log|sign) in|\b401\b|\b403\b)/i.test(
      text,
    ) ||
    /\b(not signed in|no tokens?|subscription|license|selfassignlicense)/i.test(text)
  );
}

/**
 * Decides which modes to try and whether the run is pinned to one, given the requested mode and
 * the modes found available.
 *
 * Pure and exported because the pinning rule and the cascade guard must not drift: `'auto'` is the
 * documented cascading value, so it pins *nothing* — reading it as a pin (any plain truthiness test
 * on the requested mode) silently disables the cascade it was asked for.
 *
 * @param {{ requestedMode?: AgyMode|'auto'|null, availableModes?: AgyMode[] }} [args={}]
 * @returns {{ modesToTry: AgyMode[], pinnedMode: AgyMode|null }}
 */
export function resolveModePlan({ requestedMode = null, availableModes = [] } = {}) {
  const pinnedMode = requestedMode && requestedMode !== 'auto' ? requestedMode : null;
  if (pinnedMode) return { modesToTry: [pinnedMode], pinnedMode };
  return { modesToTry: availableModes.length > 0 ? [...availableModes] : [...AGY_MODE_PREFERENCE], pinnedMode: null };
}

/**
 * Pure cascade decision for one mode attempt's result path (the `catch (err)` path is not
 * extracted — it stays inline, since its logic is a single `hasNextMode` branch). Success is
 * exit 0 with non-empty stdout; a token/subscription issue with another mode available cascades,
 * otherwise the result is returned as-is (covers a clean non-cascading failure).
 * @param {{ result: object, hasNextMode: boolean }} args
 * @returns {'return'|'next-mode'}
 */
export function nextAgyStep({ result, hasNextMode }) {
  const hasOutput = typeof result.stdout === 'string' && result.stdout.trim().length > 0;
  if (result.exitCode === 0 && hasOutput) return 'return';
  const combinedOutput = `${result.stderr}\n${result.stdout}`;
  const isTokenIssue =
    result.failureKind === 'quota' ||
    result.failureKind === 'auth' ||
    isSubscriptionOrTokenIssue(combinedOutput);
  if (isTokenIssue && hasNextMode) return 'next-mode';
  return 'return';
}

/**
 * Builds the agy CLI argument array for a headless --print run.
 * Exported for unit testing.
 *
 * agy has no file-attachment flag (`agy --help` lists no `-f`/`--file`) — attempting to pass
 * one is a hard CLI parse error ("flags provided but not defined: -f"). When the prompt
 * overflows argv and spills to a brief file, agy can only reach it by reading the path
 * directly, which requires the file's directory to be in its workspace. `--add-dir` grants
 * that without widening access to the rest of the OS temp directory.
 *
 * @param {string} argvPrompt - The prompt text to pass on argv (may be a brief-file pointer).
 * @param {string|null} briefFile - Path to the brief file, or null if the prompt fit on argv.
 * @param {Object} opts
 * @param {string} [opts.model]
 * @param {string} [opts.effort]
 * @param {number} opts.timeout
 */
export function buildAgyArgs(argvPrompt, briefFile, { model, effort, timeout }) {
  // JSON output carries the conversation id explicitly. Without it the id can only be guessed from
  // the newest brain-directory mtime, which hands two concurrent dispatches the same conversation
  // (see parseAgyEnvelope and getNewestBrainConversationId).
  const args = ['--print', argvPrompt, '--output-format', 'json', `--print-timeout=${timeout}s`];
  if (briefFile) args.push('--add-dir', path.dirname(briefFile));
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  args.push('--mode', 'plan');
  args.push('--dangerously-skip-permissions');
  return args;
}

/**
 * Extracts the conversation id and response text from an `--output-format json` envelope.
 *
 * Returns nulls rather than throwing when stdout is not the expected envelope — an older `agy`
 * ignoring the flag, or a non-JSON error path — so callers can fall back to plain-text stdout and
 * the brain-directory scan instead of losing the run.
 *
 * @param {string} stdout
 * @returns {{ conversationId: string|null, text: string|null }}
 */
export function parseAgyEnvelope(stdout) {
  const empty = { conversationId: null, text: null };
  if (!stdout || !stdout.trim()) return empty;

  // The envelope is normally the whole of stdout, but a banner or warning line can precede it.
  const start = stdout.indexOf('{');
  if (start === -1) return empty;

  let envelope;
  try {
    envelope = JSON.parse(stdout.slice(start));
  } catch {
    return empty;
  }
  if (!envelope || typeof envelope !== 'object') return empty;

  const conversationId =
    envelope.conversationId ?? envelope.conversation_id ?? envelope.conversation?.id ?? null;
  const text = envelope.response ?? envelope.result ?? envelope.text ?? envelope.output ?? null;

  return {
    conversationId: typeof conversationId === 'string' && conversationId ? conversationId : null,
    text: typeof text === 'string' ? text : null,
  };
}

/**
 * Spawns Antigravity for a single mode and resolves once the process exits, enforcing
 * the timeout and buffer caps.
 *
 * The subprocess lifecycle (buffering, timers, caps, kill, the error+close settled guard)
 * is shared machinery — `runDelegateCapture` in common.mjs. This function keeps only what
 * is Antigravity-specific: the per-mode data-dir env, the JSON envelope parse, and the brain-
 * directory conversation fallback. The session logger is closed by `runModeCascade`'s
 * `finally` (agy-run's runAgy), which owns it on every path — success, spawn error, and a
 * throw before the child is spawned.
 * @returns {Promise<RunAgyResult>}
 */
function executeAgyInMode(mode, options) {
  const {
    model = null,
    effort = null,
    timeout = DEFAULT_TIMEOUT_SECONDS,
    maxBufferMb = DEFAULT_MAX_BUFFER_MB,
    verbose = false,
    sessionLogger,
    formattedPrompt,
  } = options;

  const bin = getAgyBinary(mode);
  if (!bin) {
    throw createCliNotFoundError(
      `Google Antigravity binary was not found for mode '${mode}'.\n` +
        'Please ensure agy is installed: https://antigravity.google/docs/cli/reference',
    );
  }

  const startTime = Date.now();
  const effectiveModel = model || null;
  const effectiveEffort = effort || null;
  const dataDir = AGY_MODE_DATA_DIRS[mode] || 'antigravity';
  const providerLabel = AGY_MODE_LABELS[mode] || 'Antigravity 2.0 (agy)';

  const modeEnv = {
    ...getSanitizedEnv(),
    JETSKI_APP_DATA_DIR: dataDir,
  };

  // Headless execution (interactive mode removed — delegates are always headless)
  const { prompt: argvPrompt, briefFile } = preparePromptForArgv(formattedPrompt, 'agy', { binary: bin });
  const agyArgs = buildAgyArgs(argvPrompt, briefFile, { model: effectiveModel, effort: effectiveEffort, timeout });

  emitInitBanner({
    provider: providerLabel,
    model: effectiveModel,
    effort: effectiveEffort,
    logFile: sessionLogger.logFile,
    mode: 'READ-ONLY',
  });

  const trace = createTraceWriter(verbose);

  return runDelegateCapture({
    spawnChild: () =>
      spawnCli(bin, agyArgs, {
        cwd: PROJECT_ROOT,
        env: modeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      }),
    timeoutSeconds: timeout,
    maxBufferMb,
    sessionLogger,
    trace,
    onClose: (outcome) => {
      // The envelope names its own conversation; the mtime scan is the fallback for an older agy
      // that ignored --output-format, and it cannot tell two concurrent dispatches apart.
      const envelope = parseAgyEnvelope(outcome.stdoutBuffer);
      const conversationId = envelope.conversationId ?? getNewestBrainConversationId(startTime, mode);
      const sessionLink = conversationId ? `conversation://${conversationId}` : null;

      const cleanStdout = envelope.text ?? extractCleanResponse(outcome.stdoutBuffer);
      const exitCode = resolveRunnerExitCode({
        code: outcome.code,
        signal: outcome.signal,
        truncated: outcome.truncated,
        cleanStdout,
      });
      const failureKind =
        classifyFailure(`${outcome.stderrBuffer}\n${outcome.stdoutBuffer}`) || outcome.truncated;

      emitCompletionBanner({
        provider: providerLabel,
        sessionLink,
        exitCode,
        truncated: outcome.truncated,
      });

      return {
        provider: 'agy',
        mode,
        stdout: cleanStdout,
        rawStdout: outcome.stdoutBuffer,
        stderr: outcome.stderrBuffer,
        exitCode,
        logFile: sessionLogger.logFile,
        briefFile,
        conversationId,
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

export async function main() {
  const options = parseAgyArgs(process.argv);

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  // Reachability test mode: tests up to reaching each mode without consuming tokens
  if (options.testReachability) {
    printReachabilityReport();
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
    const res = await runAgy({ ...options, prompt: finalPrompt });
    if (res.stdout) {
      process.stdout.write(res.stdout.endsWith('\n') ? res.stdout : `${res.stdout}\n`);
    }
    process.exit(res.exitCode);
  } catch (err) {
    console.error(formatCliError(err));
    process.exit(safeExitCode(err));
  }
}

/** Runner-specific flags, exported so the flag-parity test checks `--help` against the real list.
 * `aliases` maps both mode spellings onto one canonical value — the last spelling on argv wins. */
export const CLI_FLAGS = {
  valueFlags: ['--agy-mode', '--mode-variant'],
  booleanFlags: ['--test-reachability', '--test-modes'],
  aliases: { '--agy-mode': 'modeVariant', '--mode-variant': 'modeVariant' },
};

/** Parses arguments with additional agy mode flags. */
function parseAgyArgs(argv) {
  const common = parseCommonArgs(argv, CLI_FLAGS);
  const { values, booleans } = parseRunnerModeArgs(argv.slice(2), CLI_FLAGS);

  return {
    ...common,
    modeVariant: values.modeVariant,
    testReachability: booleans['--test-reachability'] || booleans['--test-modes'],
  };
}

function printReachabilityReport() {
  console.log('[dispatch] Testing Antigravity Mode Reachability (non-token-consuming):');
  for (const { mode, name, present, bin, reachable } of probeAllAgyModes()) {
    console.log(`\nMode: ${name} [${mode}]`);
    console.log(`  OS Presence: ${present ? 'DETECTED' : 'NOT DETECTED'}`);
    console.log(`  Executable:  ${bin || 'NOT FOUND'}`);
    console.log(`  Reachability:${reachable ? ' REACHABLE (tested via non-token probe)' : ' UNREACHABLE'}`);
  }
}

function printHelp() {
  console.log(`
Google Antigravity Runner (agy)

Usage:
  node scripts/agy-run.mjs [options] [prompt]

Options:
  -p, --prompt <string>         The prompt message to send
  -f, --file, --artifact        Attach context file or artifact (repeatable)
  -m, --model <name>            Override Antigravity model (no default here — see dispatch's config.default.jsonc)
  -e, --effort, --reasoning-effort <level>
                                Override reasoning effort (no default here — see dispatch's config.default.jsonc)
  -t, --timeout <seconds>       Override timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})
  --prompt-file <path>          Read the prompt from a file instead of an argument
  --max-buffer <MB>             Raise the subprocess output cap (default: ${DEFAULT_MAX_BUFFER_MB})
  --agy-mode, --mode-variant    Force mode: antigravity-cli | antigravity-2.0 | antigravity-vscode | auto
  --test-reachability, --test-modes
                                Test and report reachability for all modes without consuming tokens
  -v, --verbose                 Stream live trace to stderr (terminal only; ignored when piped)
  -h, --help                    Show this help

Preference Order:
  1. Antigravity CLI
  2. Antigravity 2.0 (Desktop)
  3. Antigravity VS Code Extension
`);
}

// ============================================================================
// SECTION: Mode Resolution & Reachability
// ============================================================================

/**
 * Resolves the executable binary for Antigravity in cascade preference order, or for
 * one pinned mode.
 * @param {AgyMode|null} [mode=null] - Specific AGY mode to locate binary for
 * @returns {string|null} Resolved absolute path to executable binary
 */
export function getAgyBinary(mode = null) {
  const target = resolveAgyTarget(mode);
  return target ? target.bin : null;
}

/**
 * Resolves the active Antigravity execution target with mode metadata.
 * @param {AgyMode|null} [preferredMode=null]
 * @returns {AgyTarget|null}
 */
export function resolveAgyTarget(preferredMode = null) {
  const candidates = preferredMode
    ? MODE_DEFINITIONS.filter((m) => m.mode === preferredMode.toLowerCase())
    : MODE_DEFINITIONS;

  for (const candidate of candidates) {
    const bin = candidate.fn();
    if (bin) {
      return { mode: candidate.mode, name: candidate.name, bin, dataDir: candidate.dataDir };
    }
  }
  return null;
}

/**
 * Tests whether an Antigravity binary is reachable without requiring tokens or subscriptions.
 * Runs `--help` under a short timeout with the mode's data-dir profile.
 * @param {string} binPath - Path to binary
 * @param {AgyMode} [mode=AGY_MODES.ANTIGRAVITY_2_0] - Mode to test
 * @returns {{ reachable: boolean, error: string|null }}
 */
export function testAgyBinaryReachability(binPath, mode = AGY_MODES.ANTIGRAVITY_2_0) {
  const { reachable, error } = probeCliReachability({
    bin: binPath,
    args: ['--help'],
    timeoutMs: 3000,
    env: {
      ...getSanitizedEnv(),
      JETSKI_APP_DATA_DIR: AGY_MODE_DATA_DIRS[mode] || 'antigravity',
    },
  });
  return { reachable, error };
}

/**
 * Probes all three Antigravity modes, reporting presence, paths, and reachability without
 * consuming tokens or requiring subscriptions.
 * @returns {Array<{ mode: AgyMode, name: string, present: boolean, bin: string|null, reachable: boolean, error: string|null }>}
 */
export function probeAllAgyModes() {
  return MODE_DEFINITIONS.map(({ mode, name, fn }) => {
    const present = detectAgyModePresence(mode);
    const bin = fn();
    if (!bin) {
      return { mode, name, present, bin: null, reachable: false, error: 'Binary not found' };
    }
    const reach = testAgyBinaryReachability(bin, mode);
    return { mode, name, present, bin, reachable: reach.reachable, error: reach.error };
  });
}

/**
 * Tests whether Antigravity can be reached via a specific mode.
 *
 * NOTE: Not all modes are subscribed or have tokens; in those cases,
 * this tests up to being able to reach it via that mode (i.e. verifying
 * OS-level presence, binary availability, and executing '--help' with the
 * mode's profile) without requiring tokens or active subscriptions.
 *
 * @param {AgyMode} mode
 * @returns {Promise<boolean>}
 */
export async function isAgyModeAvailable(mode) {
  if (!detectAgyModePresence(mode)) return false;

  const bin = getAgyBinary(mode);
  if (!bin) return false;

  return testAgyBinaryReachability(bin, mode).reachable;
}

/**
 * Returns an ordered array of reachable Antigravity modes in order of preference:
 * 1. Antigravity CLI
 * 2. Antigravity 2.0
 * 3. Antigravity VS Code Extension
 * @returns {Promise<AgyMode[]>}
 */
export async function getAvailableAgyModes() {
  const available = [];
  for (const mode of AGY_MODE_PREFERENCE) {
    if (await isAgyModeAvailable(mode)) {
      available.push(mode);
    }
  }
  return available;
}

/**
 * Verifies that at least one Antigravity mode is installed and reachable.
 */
export async function isAgyAvailable() {
  const bin = getAgyBinary();
  if (!bin) return false;

  const modes = await getAvailableAgyModes();
  if (modes.length > 0) return true;

  // Fallback for the default binary: no mode reported reachable, so test the plain binary
  // (the shared probe carries the 2.0 data-dir profile — a probe-only difference).
  return testAgyBinaryReachability(bin).reachable;
}

// ============================================================================
// SECTION: Binary Discovery — Mode 2: Antigravity 2.0 (`antigravity-2.0`)
// ============================================================================

/**
 * Resolves the executable binary for the Antigravity 2.0 desktop application.
 *
 * Branching by Operating System:
 * - macOS (darwin):
 *   Probes `~/.gemini/antigravity/bin/agy`, the Antigravity.app resource bundle,
 *   and Homebrew/local `antigravity` shims.
 * - Windows (win32):
 *   Probes `%LOCALAPPDATA%\Google\Antigravity\bin`, `%LOCALAPPDATA%\Programs\Antigravity`,
 *   `%APPDATA%\Google\Antigravity\bin`, `%ProgramFiles%\Antigravity`, and
 *   `%ProgramFiles(x86)%\Antigravity` for `agy.exe` / `antigravity.exe` / `Antigravity.exe`.
 * - Linux (linux):
 *   Probes `~/.gemini/antigravity/bin/agy`, `/opt/Antigravity`, `/usr/bin`,
 *   `/usr/local/bin`, and the `antigravity` snap.
 *
 * @returns {string|null}
 */
export function getAgy20Binary() {
  const candidates = [];
  const homeDir = os.homedir();

  // [OS: macOS]
  if (process.platform === 'darwin') {
    candidates.push(
      path.join(homeDir, '.gemini', 'antigravity', 'bin', 'agy'),
      '/Applications/Antigravity.app/Contents/Resources/bin/agy',
      path.join(homeDir, 'Applications/Antigravity.app/Contents/Resources/bin/agy'),
      '/opt/homebrew/bin/antigravity',
      '/usr/local/bin/antigravity',
    );
  }

  // [OS: Windows]
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      candidates.push(
        path.join(process.env.LOCALAPPDATA, 'Google', 'Antigravity', 'bin', 'agy.exe'),
        path.join(process.env.LOCALAPPDATA, 'Google', 'Antigravity', 'bin', 'antigravity.exe'),
        path.join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity', 'Antigravity.exe'),
        path.join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity', 'bin', 'agy.exe'),
      );
    }
    if (process.env.APPDATA) {
      candidates.push(
        path.join(process.env.APPDATA, 'Google', 'Antigravity', 'bin', 'agy.exe'),
        path.join(process.env.APPDATA, 'Google', 'Antigravity', 'bin', 'antigravity.exe'),
      );
    }
    if (process.env.ProgramFiles) {
      candidates.push(
        path.join(process.env.ProgramFiles, 'Antigravity', 'bin', 'agy.exe'),
        path.join(process.env.ProgramFiles, 'Antigravity', 'Antigravity.exe'),
      );
    }
    if (process.env['ProgramFiles(x86)']) {
      candidates.push(
        path.join(process.env['ProgramFiles(x86)'], 'Antigravity', 'bin', 'agy.exe'),
        path.join(process.env['ProgramFiles(x86)'], 'Antigravity', 'Antigravity.exe'),
      );
    }
  }

  // [OS: Linux]
  if (process.platform === 'linux') {
    candidates.push(
      path.join(homeDir, '.gemini', 'antigravity', 'bin', 'agy'),
      '/opt/Antigravity/agy',
      '/opt/Antigravity/antigravity',
      '/usr/bin/antigravity',
      '/usr/local/bin/antigravity',
      '/snap/bin/antigravity',
    );
  }

  return findAgyOrAntigravityBinary(candidates);
}

/**
 * Checks if the host OS has files, directories, or an active session for Antigravity 2.0.
 * @returns {boolean}
 */
function detectAntigravity20Presence() {
  const homeDir = os.homedir();

  if (process.platform === 'darwin') {
    if (
      existsAny(
        '/Applications/Antigravity.app',
        path.join(homeDir, 'Applications/Antigravity.app'),
        path.join(homeDir, 'Library/Application Support/Antigravity'),
        path.join(homeDir, '.gemini', 'antigravity'),
      )
    ) {
      return true;
    }
  }

  if (process.platform === 'win32') {
    if (
      existsAny(
        path.join(homeDir, '.gemini', 'antigravity'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Antigravity'),
        process.env.APPDATA && path.join(process.env.APPDATA, 'Antigravity'),
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Antigravity'),
        process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Antigravity'),
      )
    ) {
      return true;
    }
  }

  if (process.platform === 'linux') {
    if (
      existsAny(
        path.join(homeDir, '.gemini', 'antigravity'),
        path.join(homeDir, '.config', 'Antigravity'),
        '/opt/Antigravity',
        '/usr/share/antigravity',
      )
    ) {
      return true;
    }
  }

  // Active session environment markers
  return Boolean(
    process.env.ANTIGRAVITY_AGENT ||
      process.env.__CFBundleIdentifier === 'com.google.antigravity' ||
      process.env.ANTIGRAVITY_AGENTAPI_EXE,
  );
}

// ============================================================================
// SECTION: Binary Discovery — Mode 3: Antigravity VS Code Extension (`antigravity-vscode`)
// ============================================================================

/**
 * Resolves the executable binary bundled with the Antigravity VS Code Extension / IDE.
 *
 * Branching by Operating System:
 * - macOS (darwin):
 *   Probes `~/.gemini/antigravity-ide/bin/agy`, the "Antigravity IDE.app" resource bundle,
 *   and the VS Code global storage path for `google.google-antigravity`.
 * - Windows (win32):
 *   Probes `%APPDATA%\Code\User\globalStorage\google.google-antigravity`,
 *   `%APPDATA%\Antigravity IDE`, and `%LOCALAPPDATA%\Programs\Antigravity IDE` for `agy.exe`.
 * - Linux (linux):
 *   Probes `~/.gemini/antigravity-ide/bin/agy`, the VS Code global storage path, and
 *   `/opt/Antigravity IDE/bin/agy`.
 *
 * @returns {string|null}
 */
export function getAgyVSCodeBinary() {
  const candidates = [];
  const homeDir = os.homedir();

  // [OS: macOS]
  if (process.platform === 'darwin') {
    candidates.push(
      path.join(homeDir, '.gemini', 'antigravity-ide', 'bin', 'agy'),
      '/Applications/Antigravity IDE.app/Contents/Resources/app/bin/agy',
      path.join(
        homeDir,
        'Library/Application Support/Code/User/globalStorage/google.google-antigravity/bin/agy',
      ),
    );
  }

  // [OS: Windows]
  if (process.platform === 'win32') {
    if (process.env.APPDATA) {
      candidates.push(
        path.join(
          process.env.APPDATA,
          'Code',
          'User',
          'globalStorage',
          'google.google-antigravity',
          'bin',
          'agy.exe',
        ),
        path.join(process.env.APPDATA, 'Antigravity IDE', 'bin', 'agy.exe'),
      );
    }
    if (process.env.LOCALAPPDATA) {
      candidates.push(
        path.join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity IDE', 'bin', 'agy.exe'),
      );
    }
    candidates.push(path.join(homeDir, '.gemini', 'antigravity-ide', 'bin', 'agy.exe'));
  }

  // [OS: Linux]
  if (process.platform === 'linux') {
    candidates.push(
      path.join(homeDir, '.gemini', 'antigravity-ide', 'bin', 'agy'),
      path.join(homeDir, '.config/Code/User/globalStorage/google.google-antigravity/bin/agy'),
      '/opt/Antigravity IDE/bin/agy',
    );
  }

  return findAgyOrAntigravityBinary(candidates);
}

/**
 * Checks if the host OS has files, directories, or a matching VS Code extension for the
 * Antigravity VS Code Extension.
 * @returns {boolean}
 */
function detectAntigravityVscodePresence() {
  const homeDir = os.homedir();

  if (process.platform === 'darwin') {
    if (
      existsAny(
        path.join(homeDir, '.gemini', 'antigravity-ide'),
        path.join(homeDir, 'Library/Application Support/Antigravity IDE'),
        '/Applications/Antigravity IDE.app',
        path.join(homeDir, 'Applications/Antigravity IDE.app'),
        path.join(homeDir, 'Library/Application Support/Code/User/globalStorage/google.google-antigravity'),
      )
    ) {
      return true;
    }
    if (
      hasAntigravityExtension([
        path.join(homeDir, '.vscode', 'extensions'),
        path.join(homeDir, '.vscode-insiders', 'extensions'),
        path.join(homeDir, 'Library/Application Support/Code/CachedExtensionVSIXs'),
      ])
    ) {
      return true;
    }
  }

  if (process.platform === 'win32') {
    if (
      existsAny(
        path.join(homeDir, '.gemini', 'antigravity-ide'),
        process.env.APPDATA && path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'google.google-antigravity'),
        process.env.APPDATA && path.join(process.env.APPDATA, 'Antigravity IDE'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity IDE'),
      )
    ) {
      return true;
    }
    if (
      hasAntigravityExtension([
        path.join(homeDir, '.vscode', 'extensions'),
        path.join(homeDir, '.vscode-insiders', 'extensions'),
      ])
    ) {
      return true;
    }
  }

  if (process.platform === 'linux') {
    if (
      existsAny(
        path.join(homeDir, '.gemini', 'antigravity-ide'),
        path.join(homeDir, '.config', 'Code', 'User', 'globalStorage', 'google.google-antigravity'),
        path.join(homeDir, '.config', 'Antigravity IDE'),
        '/opt/Antigravity IDE',
      )
    ) {
      return true;
    }
    if (
      hasAntigravityExtension([
        path.join(homeDir, '.vscode', 'extensions'),
        path.join(homeDir, '.vscode-insiders', 'extensions'),
        path.join(homeDir, '.vscode-server', 'extensions'),
      ])
    ) {
      return true;
    }
  }

  return process.env.JETSKI_APP_DATA_DIR === 'antigravity-ide';
}

// ============================================================================
// SECTION: Binary Discovery — Mode 1: Antigravity CLI (`antigravity-cli`)
// ============================================================================

/**
 * Resolves the standalone Antigravity CLI binary installed via PATH or a well-known location.
 *
 * Branching by Operating System:
 * - Cross-platform:
 *   Probes `~/.gemini/bin`, `~/.local/bin`, `/usr/local/bin`, and `/opt/homebrew/bin`
 *   for `agy` / `antigravity`, plus a PATH lookup for both binary names.
 * - Windows (win32):
 *   Additionally probes `.exe` / `.cmd` variants of every candidate above.
 *
 * @returns {string|null}
 */
export function getAgyCliBinary() {
  const isWin = process.platform === 'win32';
  const candidates = [
    '~/.gemini/bin/agy',
    '~/.local/bin/agy',
    '/usr/local/bin/agy',
    '/opt/homebrew/bin/agy',
    '~/.gemini/bin/antigravity',
    '~/.local/bin/antigravity',
    '/usr/local/bin/antigravity',
    '/opt/homebrew/bin/antigravity',
  ];

  // [OS: Windows] Probe .exe and .cmd equivalents
  if (isWin) {
    for (const candidate of [...candidates]) {
      if (!candidate.endsWith('.exe') && !candidate.endsWith('.cmd')) {
        candidates.push(`${candidate}.exe`);
        candidates.push(`${candidate}.cmd`);
      }
    }
  }

  return findAgyOrAntigravityBinary(candidates);
}

/**
 * Checks if the host OS has a `~/.gemini/antigravity-cli` directory or a resolvable
 * standalone CLI binary.
 * @returns {boolean}
 */
function detectAntigravityCliPresence() {
  const homeDir = os.homedir();
  return (
    fs.existsSync(path.join(homeDir, '.gemini', 'antigravity-cli')) ||
    Boolean(getAgyCliBinary())
  );
}

// ============================================================================
// SECTION: Mode Presence Detection
// ============================================================================

/**
 * Checks if the host OS has files, directories, or processes for the given mode.
 * @param {AgyMode} mode
 * @returns {boolean}
 */
export function detectAgyModePresence(mode) {
  if (mode === AGY_MODES.ANTIGRAVITY_2_0) return detectAntigravity20Presence();
  if (mode === AGY_MODES.ANTIGRAVITY_VSCODE) return detectAntigravityVscodePresence();
  if (mode === AGY_MODES.ANTIGRAVITY_CLI) return detectAntigravityCliPresence();
  return false;
}

/** Scans each directory for entries whose filename mentions "antigravity". */
function hasAntigravityExtension(dirs) {
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir);
      if (files.some((f) => f.includes('antigravity'))) return true;
    } catch {}
  }
  return false;
}

// ============================================================================
// SECTION: Directory & Binary Scanning Helpers
// ============================================================================

/**
 * Probes a list of candidate file paths for either binary name agy uses (`agy` first,
 * `antigravity` second — both cover the same install), preferring a system PATH match.
 * @param {string[]} candidates
 * @returns {string|null}
 */
function findAgyOrAntigravityBinary(candidates) {
  const isWin = process.platform === 'win32';

  const primaryBin = isWin ? 'agy.exe' : 'agy';
  const resolvedPrimary = findBinary(primaryBin, candidates);
  if (resolvedPrimary) return resolvedPrimary;

  const secondaryBin = isWin ? 'antigravity.exe' : 'antigravity';
  return findBinary(secondaryBin, candidates);
}

// ============================================================================
// SECTION: Brain Conversation Tracking
// ============================================================================

/**
 * Finds the newest conversation ID in the Antigravity brain directory for a given mode.
 * Supports cross-platform path resolution across macOS, Windows, and Linux.
 * @param {AgyMode|null} [mode=null] - Optional mode to narrow search
 * @returns {string|null} Newest conversation ID or null
 */
export function getNewestBrainConversationId(modifiedAfterMs = 0, mode = null) {
  const homeDir = os.homedir();
  const isWin = process.platform === 'win32';

  const candidateDirs = [];

  // Prioritize directory for specified mode
  if (mode && AGY_MODE_DATA_DIRS[mode]) {
    const dirName = AGY_MODE_DATA_DIRS[mode];
    candidateDirs.push(path.join(homeDir, '.gemini', dirName, 'brain'));
    if (isWin) {
      if (process.env.APPDATA) {
        candidateDirs.push(path.join(process.env.APPDATA, dirName, 'brain'));
      }
      if (process.env.LOCALAPPDATA) {
        candidateDirs.push(path.join(process.env.LOCALAPPDATA, dirName, 'brain'));
      }
    }
  }

  // Search all mode data directories in preference order when no mode is specified or unknown
  if (!mode || !AGY_MODE_DATA_DIRS[mode]) {
    for (const m of AGY_MODE_PREFERENCE) {
      const dirName = AGY_MODE_DATA_DIRS[m];
      candidateDirs.push(path.join(homeDir, '.gemini', dirName, 'brain'));
      if (isWin) {
        if (process.env.APPDATA) {
          candidateDirs.push(path.join(process.env.APPDATA, dirName, 'brain'));
        }
        if (process.env.LOCALAPPDATA) {
          candidateDirs.push(path.join(process.env.LOCALAPPDATA, dirName, 'brain'));
        }
      }
    }
  }

  let newestId = null;
  let maxMtime = modifiedAfterMs;

  for (const brainDir of candidateDirs) {
    if (!fs.existsSync(brainDir)) continue;
    try {
      const entries = fs.readdirSync(brainDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== 'scratch') {
          const fullPath = path.join(brainDir, entry.name);
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs > maxMtime) {
            maxMtime = stat.mtimeMs;
            newestId = entry.name;
          }
        }
      }
    } catch {}
  }

  return newestId;
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
