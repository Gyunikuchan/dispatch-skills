#!/usr/bin/env node

/**
 * @file copilot-run.mjs
 * @description Dedicated runner for GitHub Copilot.
 *
 * Supports cross-platform execution (macOS / Windows / Linux, bash / zsh / PowerShell).
 * Resolves Copilot executables according to preference order:
 *   1. Standalone GitHub Copilot CLI (`cli`)
 *   2. GitHub Copilot Desktop (`desktop`)
 *   3. Copilot VS Code Extension (`vscode`)
 *
 * Each mode is discoverable and testable up to reachability (`--version`) without
 * requiring an active GitHub Copilot subscription or OAuth token, so environments
 * without credentials can still verify reachability and fall back cleanly.
 */

import os from 'node:os';
import path from 'node:path';
import {
  cascadeModels,
  resolveModelsToTry,
  formatCliError,
  safeExitCode,
  buildFormattedPrompt,
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
  PROJECT_ROOT,
  readStdin,
  resolveRunnerExitCode,
  runDelegateCapture,
  scanVersionDirs,
  spawnCli,
  spawnCliSync,
} from './common.mjs';

// ============================================================================
// SECTION: Types
// ============================================================================

/** @typedef {'cli'|'desktop'|'vscode'} CopilotMode */

/**
 * @typedef {object} ModeDefinition
 * @property {CopilotMode} mode
 * @property {string} name
 * @property {() => string|null} fn Resolves the binary path for this mode, or null if absent.
 */

/**
 * @typedef {object} CopilotTarget
 * @property {CopilotMode} mode
 * @property {string} name
 * @property {string} binary
 * @property {string|null} version
 */

/**
 * @typedef {object} RunCopilotOptions
 * @property {string} prompt
 * @property {string[]} [files]
 * @property {string} [model]
 * @property {string} [effort]
 * @property {boolean} [sandbox] Enable Copilot's experimental OS-level command sandbox.
 * @property {number} [timeout] Seconds before the delegate is killed.
 * @property {number} [maxBufferMb] Stdout cap before the delegate is killed.
 * @property {boolean} [verbose]
 * @property {'auto'|CopilotMode} [copilotMode] Pins execution to one mode; disables mode cascade.
 */

/**
 * @typedef {object} RunCopilotResult
 * @property {'copilot'} provider
 * @property {CopilotMode} mode
 * @property {string} binary
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
 * Execution modes in cascade preference order: Standalone Copilot CLI > GitHub Copilot Desktop > VS Code Extension.
 * The single source of truth for mode metadata — every mode-aware function below
 * (resolution, probing, execution) iterates this instead of redeclaring the list.
 * @type {ModeDefinition[]}
 */
const MODE_DEFINITIONS = [
  { mode: 'cli', name: 'Standalone Copilot CLI', fn: () => getCopilotCliBinary() },
  { mode: 'desktop', name: 'GitHub Copilot Desktop', fn: () => getCopilotDesktopBinary() },
  { mode: 'vscode', name: 'Copilot VS Code Extension', fn: () => getCopilotVscodeBinary() },
];

// ============================================================================
// SECTION: Main API — runCopilot()
// ============================================================================

/**
 * Runs a prompt through GitHub Copilot using the preferred mode (cli > desktop > vscode).
 * If a mode hits a quota/rate limit or fails to spawn, cascades to the next available mode in
 * preference order unless pinned via `copilotMode`. An auth failure does not cascade — all modes
 * share one credential store; see {@link nextCopilotStep}.
 *
 * @param {RunCopilotOptions} options
 * @returns {Promise<RunCopilotResult>}
 */
export async function runCopilot(options = {}) {
  const {
    prompt,
    files = [],
    model = null,
    effort = null,
    sandbox = true,
    timeout = DEFAULT_TIMEOUT_SECONDS,
    maxBufferMb = DEFAULT_MAX_BUFFER_MB,
    verbose = false,
    copilotMode = 'auto',
    // Test seams: each defaults to the real implementation, so production calls are unchanged.
    // The cascade loop is otherwise unreachable in a test — its executor spawns a subprocess
    // and opens a session log.
    execute = executeOnTarget,
    discoverTargets = findViableTargets,
    createLogger = createSessionLogger,
  } = options;

  const viableTargets = discoverTargets(copilotMode);
  if (viableTargets.length === 0) {
    throw createNoTargetsError();
  }

  const formattedPrompt = buildFormattedPrompt(prompt, files);
  const effectiveEffort = effort || null;

  // Each configured model gets the full target cascade; the attempt owns its logger, so a
  // fallback model never writes to a logger an earlier attempt closed.
  return cascadeModels(
    resolveModelsToTry(model),
    async (currentModel) => {
      const sessionLogger = createLogger('copilot');
      try {
        return await runTargetCascade({ currentModel, sessionLogger });
      } finally {
        sessionLogger.close();
      }
    },
    { label: 'GitHub Copilot' },
  );

  async function runTargetCascade({ currentModel, sessionLogger }) {
    let lastResult = null;

    // Cascade across viable targets in priority order. A quota failure or a spawn error advances to
    // the next target; any other outcome — an auth failure included — is returned immediately.
    // See nextCopilotStep for why auth does not cascade.
    for (let i = 0; i < viableTargets.length; i++) {
      const target = viableTargets[i];
      const isLastTarget = i === viableTargets.length - 1;
      const canCascade = !isLastTarget && (!copilotMode || copilotMode === 'auto');

      try {
        const result = await execute({
          target,
          model: currentModel,
          formattedPrompt,
          effort: effectiveEffort,
          sandbox,
          timeout,
          maxBufferMb,
          verbose,
          sessionLogger,
        });

        const step = nextCopilotStep({ result, error: null, canCascade });
        if (step === 'next-target') {
          process.stderr.write(
            `[dispatch] Notice: ${target.name} exited with '${result.failureKind}' (quota/rate limit).\n` +
              `[dispatch] Cascading to next available mode (${viableTargets[i + 1].name})...\n`,
          );
          lastResult = result;
          continue;
        }

        return result;
      } catch (err) {
        const step = nextCopilotStep({ result: null, error: err, canCascade });
        if (step === 'next-target') {
          process.stderr.write(
            `[dispatch] Warning: ${target.name} execution failed (${err.message}). Cascading to next mode...\n`,
          );
          continue;
        }
        throw err;
      }
    }

    return lastResult;
  }
}


// ============================================================================
// SECTION: Cascade & Execution Helpers
// ============================================================================

/**
 * Returns viable Copilot targets in preference order, each probed up to executable
 * reachability. Falls back to on-disk presence (without reachability) if no probe
 * succeeds — covers sandboxes where `--version` invocation is inconclusive. Modes resolving to one
 * binary are collapsed (see dedupeTargetsByBinary).
 * @param {'auto'|CopilotMode} copilotMode
 * @returns {CopilotTarget[]}
 */
function findViableTargets(copilotMode) {
  const norm = String(copilotMode || 'auto').toLowerCase();
  const candidates = norm === 'auto' ? MODE_DEFINITIONS : MODE_DEFINITIONS.filter((m) => m.mode === norm);

  const viable = [];
  for (const candidate of candidates) {
    const bin = candidate.fn();
    if (!bin) continue;
    const probe = testCopilotReachability(bin);
    if (probe.reachable) {
      viable.push({ mode: candidate.mode, name: candidate.name, binary: bin, version: probe.version });
    }
  }
  // Modes routinely resolve to the same executable; with CLI prioritized first,
  // finding a CLI binary on PATH takes precedence in deduplication.
  if (viable.length > 0) return dedupeTargetsByBinary(viable, (t) => t.binary);

  for (const candidate of candidates) {
    const bin = candidate.fn();
    if (bin) viable.push({ mode: candidate.mode, name: candidate.name, binary: bin, version: null });
  }
  return dedupeTargetsByBinary(viable, (t) => t.binary);
}

/**
 * Pure cascade decision for one target attempt, covering both the result path and the
 * `catch (err)` path (mutually exclusive: pass `error` OR `result`, never both). `runCopilot`'s
 * loop delegates here so the cascade logic is unit-testable without spawning the real CLI;
 * the stderr notices stay in the loop, unchanged.
 * @param {{ result: object|null, error: Error|null, canCascade: boolean }} args
 * @returns {'return'|'throw'|'next-target'}
 */
export function nextCopilotStep({ result, error, canCascade }) {
  if (error) return canCascade ? 'next-target' : 'throw';
  // `auth` is deliberately absent: every mode is spawned with the same getSanitizedEnv(), so all
  // three binaries read one per-user credential store (~/.copilot). A login failure is account
  // state, identical for each mode, and retrying it only burns time — the audit's probe measured
  // three identical `No authentication information found` runs. Restore `auth` here if a mode ever
  // gains its own HOME/config-dir. `quota` still cascades, and a spawn error (above) always does.
  if (result.failureKind === 'quota' && canCascade) return 'next-target';
  return 'return';
}

function createNoTargetsError() {
  return createCliNotFoundError(
    'GitHub Copilot was not found in system PATH, Copilot Desktop cache, or VS Code extension storage.\n' +
      'Preference order: Standalone Copilot CLI > GitHub Copilot Desktop > Copilot VS Code Extension.\n' +
      '- Mode [copilot cli]:     npm install -g @github/copilot (or brew install copilot)\n' +
      '- Mode [copilot desktop]: Install GitHub Copilot Desktop app.\n' +
      '- Mode [copilot vscode]:  Install GitHub Copilot Chat extension in VS Code.',
    'not-found',
  );
}

/**
 * Builds the Copilot argument array. `model`/`effort` are omitted entirely when falsy so the
 * Copilot CLI's own default applies — dispatch ships no hardcoded fallback. Copilot gates its
 * command sandbox behind the experimental feature flag, so both flags travel together.
 * @param {string} argvPrompt
 * @param {{ model?: string|null, effort?: string|null, sandbox?: boolean }} [opts]
 * @returns {string[]}
 */
export function buildCopilotArgs(argvPrompt, { model, effort, sandbox = true } = {}) {
  const args = sandbox ? ['--experimental', '--sandbox', '-p', argvPrompt] : ['-p', argvPrompt];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  args.push('--mode', 'plan');
  return args;
}

/**
 * Spawns Copilot on a single resolved target and resolves once the process exits,
 * enforcing the timeout and buffer caps.
 *
 * The subprocess lifecycle (buffering, timers, caps, kill, the error+close settled guard)
 * is shared machinery — `runDelegateCapture` in common.mjs. This function keeps only what
 * is Copilot-specific: the dual-stream session-id scan, the auth classifier, and the
 * failure-kind composition. The logger stays open on success — `runCopilot` owns it per
 * model attempt.
 * @returns {Promise<RunCopilotResult>}
 */
function executeOnTarget({
  target,
  model,
  formattedPrompt,
  effort,
  sandbox,
  timeout,
  maxBufferMb,
  verbose,
  sessionLogger,
}) {
  // Headless print mode (interactive mode removed — delegates are always headless)
  const { prompt: argvPrompt, briefFile } = preparePromptForArgv(formattedPrompt, 'copilot', {
    binary: target.binary,
  });
  const copilotArgs = buildCopilotArgs(argvPrompt, { model, effort, sandbox });

  const modeLabel = { desktop: 'copilot desktop', vscode: 'copilot vscode', cli: 'copilot cli' }[target.mode];
  const providerLabel = `GitHub Copilot [${target.mode}] (${modeLabel})`;

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
      spawnCli(target.binary, copilotArgs, {
        cwd: PROJECT_ROOT,
        env: getSanitizedEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      }),
    timeoutSeconds: timeout,
    maxBufferMb,
    sessionLogger,
    trace,
    onFail: (err, { stderrBuffer }) => {
      err.failureKind = classifyCopilotFailure(`${stderrBuffer}\n${err.message}`);
    },
    onClose: (outcome) => {
      const sessionId = extractCopilotSessionId(outcome.stdoutBuffer) || extractCopilotSessionId(outcome.stderrBuffer);
      const sessionLink = sessionId ? `copilot --resume ${sessionId}` : null;

      // A truncated run still carries its partial analysis; return captured output
      const cleanStdout = extractCleanResponse(outcome.stdoutBuffer);
      const exitCode = resolveRunnerExitCode({
        code: outcome.code,
        signal: outcome.signal,
        truncated: outcome.truncated,
        cleanStdout,
      });
      const failureKind =
        classifyCopilotResult({ exitCode, stderr: outcome.stderrBuffer, stdout: outcome.stdoutBuffer }) ||
        outcome.truncated;
      const effectiveExitCode = failureKind === 'sandbox-unsupported' ? 1 : exitCode;

      emitCompletionBanner({
        provider: providerLabel,
        sessionLink,
        exitCode: effectiveExitCode,
        truncated: outcome.truncated,
      });

      return {
        provider: 'copilot',
        mode: target.mode,
        binary: target.binary,
        stdout: cleanStdout,
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

export async function main() {
  const options = parseCopilotArgs(process.argv);

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  if (options.probeOnly) {
    printReachabilityReport(options.copilotMode);
    process.exit(0);
  }

  const pipedStdin = await readStdin();
  let finalPrompt = options.prompt.trim();
  if (pipedStdin) {
    finalPrompt = finalPrompt ? `${finalPrompt}\n\n[Piped Input]:\n${pipedStdin}` : pipedStdin;
  }

  if (!finalPrompt) {
    console.error('Error: No prompt provided. Use --test to probe reachability or -p to pass a prompt.');
    process.exit(1);
  }

  try {
    const res = await runCopilot({ ...options, prompt: finalPrompt });
    if (res.stdout) {
      process.stdout.write(res.stdout.endsWith('\n') ? res.stdout : `${res.stdout}\n`);
    } else if (res.failureKind === 'auth') {
      console.error(
        `\n[dispatch] Copilot was reached via mode '${res.mode}', but lacks authentication/subscription credentials.\n` +
          `Session log: ${res.logFile}`,
      );
    }
    if (res.failureKind === 'sandbox-unsupported') {
      console.error(
        `\n[dispatch] This Copilot CLI does not support the experimental sandbox flags. ` +
          `Upgrade Copilot CLI, set platforms.copilot.sandbox to false, or use --no-sandbox.\n` +
          `Session log: ${res.logFile}`,
      );
    }
    process.exit(res.failureKind === 'sandbox-unsupported' ? 1 : res.exitCode);
  } catch (err) {
    console.error(formatCliError(err));
    process.exit(safeExitCode(err));
  }
}

/** Runner-specific flags, exported so the flag-parity test checks `--help` against the real list. */
export const CLI_FLAGS = {
  valueFlags: ['--copilot-mode'],
  booleanFlags: ['--sandbox', '--no-sandbox', '--test', '--probe', '--check', '--test-modes'],
  aliases: { '--copilot-mode': 'copilotMode' },
};

/** Parses the runner-specific `--copilot-mode` and `--test`/`--probe` flags. */
export function parseCopilotArgs(argv) {
  const options = parseCommonArgs(argv, CLI_FLAGS);
  const { values, booleans } = parseRunnerModeArgs(argv.slice(2), CLI_FLAGS);

  options.copilotMode = values.copilotMode ?? 'auto';
  options.sandbox = !booleans['--no-sandbox'];
  options.probeOnly =
    booleans['--test'] || booleans['--probe'] || booleans['--check'] || booleans['--test-modes'];
  return options;
}

function printReachabilityReport(copilotMode) {
  const probe = probeCopilotModes(copilotMode);
  console.log('[dispatch] GitHub Copilot Reachability Status:');
  console.log(formatProbeLine('copilot cli', 1, probe.cli));
  console.log(formatProbeLine('copilot desktop', 2, probe.desktop));
  console.log(formatProbeLine('copilot vscode', 3, probe.vscode));

  if (probe.preferred) {
    console.log(`\n  -> Selected Target: mode=${probe.preferred.mode}, binary=${probe.preferred.binary}`);
    console.log(
      '  -> Verification: Reached successfully via executable invocation. Active subscription/token not required for reachability test.',
    );
  } else {
    console.error(
      '\n  -> Error: Neither Standalone Copilot CLI, Copilot Desktop, nor VS Code Copilot extension is reachable.',
    );
    process.exitCode = 1;
  }
}

/** Formats a single mode's probe result for the `--test` report. */
function formatProbeLine(label, priority, probe) {
  const status = probe.reachable
    ? `REACHABLE (${probe.binary}) [${probe.version}]`
    : probe.binary
      ? `FOUND BUT UNREACHABLE (${probe.binary}: ${probe.error})`
      : 'NOT FOUND';
  return `  - Mode [${label}] (priority ${priority}): ${status}`;
}

function printHelp() {
  console.log(`
GitHub Copilot Runner (copilot)

Usage:
  node scripts/copilot-run.mjs [options] [prompt]

Options:
  -p, --prompt <string>         The prompt message to send
  -f, --file, --artifact        Attach context file or artifact (repeatable)
  -m, --model <name>            Override Copilot model (no default here — see dispatch's config.default.jsonc)
  -e, --effort, --reasoning-effort <level>
                                Override reasoning effort (no default here — see dispatch's config.default.jsonc)
  -t, --timeout <seconds>       Override timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})
  --prompt-file <path>          Read the prompt from a file instead of an argument
  --max-buffer <MB>             Raise the subprocess output cap (default: ${DEFAULT_MAX_BUFFER_MB})
  --copilot-mode <mode>         Explicit mode preference: 'cli', 'desktop', 'vscode', or 'auto' (default: auto)
  --sandbox                     Enable Copilot's experimental OS-level command sandbox (default)
  --no-sandbox                  Disable Copilot's experimental OS-level command sandbox
  --test, --probe, --check, --test-modes
                                Test reachability across modes without requiring tokens or prompt
  -v, --verbose                 Stream live trace to stderr (terminal only; ignored when piped)
  -h, --help                    Show this help

Preference Order:
  1. Standalone Copilot CLI (cli)
  2. GitHub Copilot Desktop (desktop)
  3. Copilot VS Code Extension (vscode)

Cross-Platform Support:
  - macOS: Copilot Desktop SDK cache (~/Library/Caches/github-copilot-sdk), VS Code globalStorage, Homebrew, user binaries
  - Windows: %LOCALAPPDATA%\\github-copilot-sdk, %APPDATA% / %LOCALAPPDATA% globalStorage (.bat/.cmd/.exe/.ps1), npm global
  - Linux: ~/.cache/github-copilot-sdk, XDG config (~/.config), Flatpak, Snap, /usr/local/bin, /usr/bin
`);
}

// ============================================================================
// SECTION: Mode Resolution & Reachability
// ============================================================================

/**
 * Returns the path to the preferred Copilot executable.
 * @param {'auto'|CopilotMode} [preferredMode='auto']
 * @returns {string|null}
 */
export function getCopilotBinary(preferredMode = 'auto') {
  return resolveCopilotTarget(preferredMode)?.binary ?? null;
}

/**
 * Resolves the active Copilot binary and execution mode (highest-preference
 * reachability-viable target). Unlike existence-only mode resolution, this checks
 * `testCopilotReachability` so a mode that is installed but unreachable (e.g. a
 * broken binary) is skipped in favor of the next candidate.
 * @param {'auto'|CopilotMode} [preferredMode='auto']
 * @returns {CopilotTarget|null}
 */
export function resolveCopilotTarget(preferredMode = 'auto') {
  return findViableTargets(preferredMode)[0] || null;
}

/**
 * Tests whether a Copilot executable is reachable on the current system.
 *
 * Runs `copilot --version` with a short timeout. Does not require an active GitHub
 * Copilot subscription or valid OAuth token: reaching executable launch validates
 * reachability for that mode without failing due to credentials.
 *
 * @param {string} binary Path to Copilot executable
 * @returns {{ reachable: boolean, version: string|null, error: string|null }}
 */
export function testCopilotReachability(binary) {
  if (!binary || typeof binary !== 'string') {
    return { reachable: false, version: null, error: 'Binary path not specified' };
  }
  try {
    const res = spawnCliSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (res.status === 0) {
      const firstLine = (res.stdout || res.stderr || '').trim().split(/\r?\n/)[0];
      return { reachable: true, version: firstLine, error: null };
    }
    return {
      reachable: false,
      version: null,
      error: `Process exited with code ${res.status}: ${(res.stderr || res.stdout || '').trim()}`,
    };
  } catch (err) {
    return { reachable: false, version: null, error: err.message };
  }
}

/**
 * Probes availability and reachability across all three Copilot modes.
 * Allows users and tests to inspect which modes are installed and reachable
 * without requiring subscriptions or active tokens.
 *
 * @param {'auto'|CopilotMode} [preferredMode='auto']
 * @returns {{
 *   desktop: { binary: string|null, reachable: boolean, version: string|null, error: string|null },
 *   vscode: { binary: string|null, reachable: boolean, version: string|null, error: string|null },
 *   cli: { binary: string|null, reachable: boolean, version: string|null, error: string|null },
 *   preferred: CopilotTarget | null
 * }}
 */
export function probeCopilotModes(preferredMode = 'auto') {
  const result = { preferred: resolveCopilotTarget(preferredMode) };
  for (const { mode, fn } of MODE_DEFINITIONS) {
    const binary = fn();
    result[mode] = { binary, ...testCopilotReachability(binary) };
  }
  return result;
}

/**
 * Checks if GitHub Copilot is installed and reachable.
 * Does not require an active subscription or token.
 * @param {'auto'|CopilotMode} [preferredMode='auto']
 * @returns {Promise<boolean>}
 */
export async function isCopilotAvailable(preferredMode = 'auto') {
  const target = resolveCopilotTarget(preferredMode);
  if (!target) return false;
  return testCopilotReachability(target.binary).reachable;
}

// ============================================================================
// SECTION: Binary Discovery — Mode 2: GitHub Copilot Desktop (`desktop`)
// ============================================================================

/**
 * Gathers candidate executable paths for the GitHub Copilot Desktop application.
 *
 * Branching by Operating System:
 * - macOS (darwin): versioned SDK caches (`~/Library/Caches/github-copilot-sdk/cli/<version>`),
 *   copilot pkg caches (`~/Library/Caches/copilot/pkg/darwin-*`), and native app bundles
 *   (`/Applications/GitHub Copilot.app`).
 * - Windows (win32): `%LOCALAPPDATA%\github-copilot-sdk\cli`, `%LOCALAPPDATA%\Programs\GitHub Copilot`,
 *   `%APPDATA%\GitHub Copilot`, `%ProgramFiles%\GitHub Copilot`.
 * - Linux: `~/.cache/github-copilot-sdk/cli`, XDG cache/data dirs, `/opt/GitHub Copilot`.
 *
 * @returns {string[]} Ordered array of candidate paths
 */
export function getCopilotDesktopCandidates() {
  const homeDir = os.homedir();
  const candidates = [];

  // [OS: macOS]
  if (process.platform === 'darwin') {
    const sdkCacheDir = path.join(homeDir, 'Library/Caches/github-copilot-sdk/cli');
    for (const ver of scanVersionDirs(sdkCacheDir)) {
      candidates.push(path.join(sdkCacheDir, ver, 'copilot'));
    }

    const copilotPkgArmDir = path.join(homeDir, 'Library/Caches/copilot/pkg/darwin-arm64');
    for (const ver of scanVersionDirs(copilotPkgArmDir)) {
      candidates.push(path.join(copilotPkgArmDir, ver, 'copilot'));
    }

    const copilotPkgX64Dir = path.join(homeDir, 'Library/Caches/copilot/pkg/darwin-x64');
    for (const ver of scanVersionDirs(copilotPkgX64Dir)) {
      candidates.push(path.join(copilotPkgX64Dir, ver, 'copilot'));
    }

    const appSupportCopilot = path.join(homeDir, 'Library/Application Support/GitHub Copilot');
    for (const ver of scanVersionDirs(appSupportCopilot)) {
      candidates.push(
        path.join(appSupportCopilot, ver, 'copilot'),
        path.join(appSupportCopilot, ver, 'bin/copilot'),
      );
    }

    candidates.push(
      '/Applications/GitHub Copilot.app/Contents/Resources/bin/copilot',
      '/Applications/GitHub Copilot.app/Contents/MacOS/copilot',
      path.join(homeDir, 'Applications/GitHub Copilot.app/Contents/Resources/bin/copilot'),
      path.join(homeDir, 'Applications/GitHub Copilot.app/Contents/MacOS/copilot'),
    );
  }

  // [OS: Windows]
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const progFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

    const winSdkDirs = [
      path.join(localAppData, 'github-copilot-sdk', 'cli'),
      path.join(localAppData, 'github-copilot', 'cli'),
      path.join(appData, 'github-copilot-sdk', 'cli'),
    ];
    const winExecs = ['copilot.exe', 'copilot.cmd', 'copilot.bat', 'copilot'];

    for (const sdkDir of winSdkDirs) {
      for (const ver of scanVersionDirs(sdkDir)) {
        for (const exec of winExecs) {
          candidates.push(path.join(sdkDir, ver, exec));
        }
      }
    }

    for (const exec of winExecs) {
      candidates.push(
        path.join(localAppData, 'Programs', 'GitHub Copilot', 'resources', 'bin', exec),
        path.join(localAppData, 'Programs', 'GitHub Copilot', 'bin', exec),
        path.join(localAppData, 'Programs', 'GitHub Copilot', exec),
        path.join(localAppData, 'GitHub Copilot', 'bin', exec),
        path.join(localAppData, 'GitHub Copilot', exec),
        path.join(appData, 'GitHub Copilot', 'bin', exec),
        path.join(appData, 'GitHub Copilot', exec),
        path.join(progFiles, 'GitHub Copilot', 'bin', exec),
        path.join(progFiles, 'GitHub Copilot', exec),
        path.join(progFilesX86, 'GitHub Copilot', 'bin', exec),
        path.join(progFilesX86, 'GitHub Copilot', exec),
      );
    }
  }

  // [OS: Linux]
  if (process.platform === 'linux') {
    const cacheDir = process.env.XDG_CACHE_HOME || path.join(homeDir, '.cache');
    const dataDir = process.env.XDG_DATA_HOME || path.join(homeDir, '.local/share');

    const linuxSdkDirs = [
      path.join(cacheDir, 'github-copilot-sdk/cli'),
      path.join(homeDir, '.cache/github-copilot-sdk/cli'),
      path.join(cacheDir, 'copilot/pkg/linux-x64'),
      path.join(cacheDir, 'copilot/pkg/linux-arm64'),
      path.join(dataDir, 'github-copilot-sdk/cli'),
    ];

    for (const sdkDir of linuxSdkDirs) {
      for (const ver of scanVersionDirs(sdkDir)) {
        candidates.push(path.join(sdkDir, ver, 'copilot'));
      }
    }

    candidates.push(
      path.join(homeDir, '.config/GitHub Copilot/bin/copilot'),
      '/opt/GitHub Copilot/resources/bin/copilot',
      '/opt/GitHub Copilot/bin/copilot',
      '/opt/GitHub Copilot/copilot',
    );
  }

  return candidates;
}

/**
 * Resolves the GitHub Copilot Desktop application binary.
 * @returns {string|null} Path to executable or null if not found
 */
export function getCopilotDesktopBinary() {
  return findFirstExistingFile(getCopilotDesktopCandidates());
}

// ============================================================================
// SECTION: Binary Discovery — Mode 3: Copilot VS Code Extension (`vscode`)
// ============================================================================

/**
 * Gathers candidate executable paths for the VS Code Copilot Chat extension.
 *
 * Branching by Operating System:
 * - macOS (darwin): `globalStorage` under VS Code, VS Code Insiders, VSCodium, and Cursor.
 * - Windows (win32): `%APPDATA%` / `%LOCALAPPDATA%` `globalStorage` for VS Code, Insiders,
 *   and VSCodium; tests `.bat`/`.cmd`/`.exe`/`.ps1` and extensionless launchers.
 * - Linux: standard XDG config, Flatpak, and Snap locations for Code and variants.
 *
 * @returns {string[]} Ordered array of candidate paths
 */
export function getCopilotVscodeCandidates() {
  const homeDir = os.homedir();
  const candidates = [];

  // [OS: macOS]
  if (process.platform === 'darwin') {
    const macEditors = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor'];
    for (const editor of macEditors) {
      candidates.push(
        path.join(
          homeDir,
          'Library/Application Support',
          editor,
          'User/globalStorage/github.copilot-chat/copilotCli/copilot',
        ),
      );
    }
  }

  // [OS: Windows]
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    const winBases = [appData, localAppData].filter(Boolean);
    const winEditors = ['Code', 'Code - Insiders', 'VSCodium'];
    const winLaunchers = ['copilot.bat', 'copilot.cmd', 'copilot.exe', 'copilot.ps1', 'copilot'];

    for (const base of winBases) {
      for (const editor of winEditors) {
        for (const launcher of winLaunchers) {
          candidates.push(
            path.join(base, editor, 'User', 'globalStorage', 'github.copilot-chat', 'copilotCli', launcher),
          );
        }
      }
    }
  }

  // [OS: Linux]
  if (process.platform === 'linux') {
    const configDir = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
    const linuxEditors = ['Code', 'Code - Insiders', 'VSCodium'];

    // Standard native / package manager installations
    for (const editor of linuxEditors) {
      candidates.push(
        path.join(configDir, editor, 'User/globalStorage/github.copilot-chat/copilotCli/copilot'),
      );
    }

    // Flatpak installation path
    candidates.push(
      path.join(
        homeDir,
        '.var/app/com.visualstudio.code/config/Code/User/globalStorage/github.copilot-chat/copilotCli/copilot',
      ),
    );

    // Snap installation paths (current and common revisions)
    candidates.push(
      path.join(homeDir, 'snap/code/current/.config/Code/User/globalStorage/github.copilot-chat/copilotCli/copilot'),
      path.join(homeDir, 'snap/code/common/.config/Code/User/globalStorage/github.copilot-chat/copilotCli/copilot'),
    );
  }

  return candidates;
}

/**
 * Resolves the VS Code Copilot Chat extension binary.
 * @returns {string|null} Path to executable or null if not installed
 */
export function getCopilotVscodeBinary() {
  return findFirstExistingFile(getCopilotVscodeCandidates());
}

// ============================================================================
// SECTION: Binary Discovery — Mode 1: Standalone Copilot CLI (`cli`)
// ============================================================================

/**
 * Gathers candidate executable paths for standalone GitHub Copilot CLI.
 *
 * Branching by Operating System:
 * - macOS (darwin): Homebrew (Apple Silicon & Intel), user local bin, npm global prefixes.
 * - Windows (win32): npm global binaries, `%LOCALAPPDATA%\Programs`, `%ProgramFiles%`, user bin.
 * - Linux: `/usr/local/bin`, `/usr/bin`, Linuxbrew, `~/.local/bin`, npm global prefixes.
 *
 * @returns {string[]} Ordered array of candidate fallback paths
 */
export function getCopilotCliCandidates() {
  const homeDir = os.homedir();
  const candidates = [];

  // [OS: macOS]
  if (process.platform === 'darwin') {
    candidates.push(
      '/opt/homebrew/bin/copilot',
      '/usr/local/bin/copilot',
      path.join(homeDir, '.local/bin/copilot'),
      path.join(homeDir, '.npm-global/bin/copilot'),
    );
  }

  // [OS: Windows]
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    const progFiles = process.env.ProgramFiles || 'C:\\Program Files';

    candidates.push(
      path.join(appData, 'npm', 'copilot.cmd'),
      path.join(appData, 'npm', 'copilot'),
      path.join(localAppData, 'npm', 'copilot.cmd'),
      path.join(localAppData, 'npm', 'copilot'),
      path.join(localAppData, 'Programs', 'copilot', 'copilot.exe'),
      path.join(progFiles, 'GitHub Copilot', 'copilot.exe'),
      path.join(homeDir, '.local', 'bin', 'copilot.cmd'),
      path.join(homeDir, '.local', 'bin', 'copilot.exe'),
    );
  }

  // [OS: Linux]
  if (process.platform === 'linux') {
    candidates.push(
      '/usr/local/bin/copilot',
      '/usr/bin/copilot',
      '/home/linuxbrew/.linuxbrew/bin/copilot',
      path.join(homeDir, '.local/bin/copilot'),
      path.join(homeDir, '.npm-global/bin/copilot'),
    );
  }

  return candidates;
}

/**
 * Resolves the standalone GitHub Copilot CLI executable.
 * Probes system PATH first, then OS-specific candidate install locations.
 * @returns {string|null} Path to executable or null if not installed
 */
export function getCopilotCliBinary() {
  const binName = process.platform === 'win32' ? ['copilot.cmd', 'copilot.exe'] : 'copilot';
  return findBinary(binName, getCopilotCliCandidates());
}


// ============================================================================
// SECTION: Session ID & Failure Classification
// ============================================================================

/**
 * Extracts Copilot session ID from output text.
 * @param {string} text Raw stdout or stderr
 * @returns {string|null}
 */
export function extractCopilotSessionId(text) {
  return extractSessionIdFromOutput(text, 'copilot');
}

/**
 * Classifies Copilot-specific execution failures.
 *
 * Catches credential, OAuth, and subscription errors when a mode is reachable
 * but not subscribed or lacks tokens, then falls back to the shared classifier.
 *
 * @param {string} text Raw stdout and stderr
 * @returns {'quota'|'context-overflow'|'auth'|'sandbox-unsupported'|'model-not-loaded'|'not-found'|'timeout'|null}
 */
export function classifyCopilotFailure(text) {
  if (!text || typeof text !== 'string') return null;

  if (isSandboxUnsupportedDiagnostic(text)) {
    return 'sandbox-unsupported';
  }

  // e.g. "Error: No authentication information found."
  // "Copilot can be authenticated with GitHub using an OAuth Token..."
  // "You need an active GitHub Copilot subscription."
  if (
    /(no authentication|can be authenticated|oauth token|personal access token|gh auth login|subscription required|not subscribed|active github copilot subscription)/i.test(
      text,
    )
  ) {
    return 'auth';
  }

  return classifyFailure(text);
}

/**
 * Classifies one finished run. Stdout is consulted only on a non-zero (effective) exit: a
 * successful review body that merely mentions "OAuth token" must not read as an auth failure,
 * while an auth/quota message on stderr still classifies (and cascades) even on exit 0.
 *
 * @param {{ exitCode: number, stderr: string, stdout: string }} run
 * @returns {ReturnType<typeof classifyCopilotFailure>}
 */
export function classifyCopilotResult({ exitCode, stderr = '', stdout = '' }) {
  if (isSandboxUnsupportedDiagnostic(`${stderr}\n${stdout}`)) return 'sandbox-unsupported';
  return exitCode === 0
    ? classifyCopilotFailure(stderr)
    : classifyCopilotFailure(`${stderr}\n${stdout}`);
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
