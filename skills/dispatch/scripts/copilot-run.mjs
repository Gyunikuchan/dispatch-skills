#!/usr/bin/env node

/**
 * @file copilot-run.mjs
 * @description Dedicated runner for GitHub Copilot.
 *
 * Supports cross-platform execution (macOS / Windows / Linux, bash / zsh / PowerShell).
 * Resolves Copilot executables according to preference order:
 *   1. GitHub Copilot Desktop (`desktop`)
 *   2. Copilot VS Code Extension (`vscode`)
 *   3. Standalone GitHub Copilot CLI (`cli`)
 *
 * Each mode is discoverable and testable up to reachability (`--version`) without
 * requiring an active GitHub Copilot subscription or OAuth token, so environments
 * without credentials can still verify reachability and fall back cleanly.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildFormattedPrompt,
  checkGitIntegrity,
  classifyFailure,
  createSessionLogger,
  createTraceWriter,
  DEFAULT_TIMEOUT_SECONDS,
  emitCompletionBanner,
  emitInitBanner,
  extractCleanResponse,
  findBinary,
  findFirstExistingFile,
  getGitStatus,
  getSanitizedEnv,
  isMainModule,
  parseCommonArgs,
  preparePromptForArgv,
  PROJECT_ROOT,
  readStdin,
  scanVersionDirs,
  spawnCli,
  spawnCliSync,
  terminateProcessTree,
} from './common.mjs';

export { isExecutableFile } from './common.mjs';

// ============================================================================
// SECTION: Types
// ============================================================================

/** @typedef {'desktop'|'vscode'|'cli'} CopilotMode */

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
 * @property {boolean} gitIntegrityViolation
 * @property {string|null} gitIntegrityDetails
 */

// ============================================================================
// SECTION: Constants (tweak these)
// ============================================================================

export const DEFAULT_COPILOT_MODEL = 'gpt-5.6-luna';
export const DEFAULT_COPILOT_EFFORT = 'max';

/**
 * Execution modes in cascade preference order: Copilot Desktop > VS Code Extension > CLI.
 * The single source of truth for mode metadata — every mode-aware function below
 * (resolution, probing, execution) iterates this instead of redeclaring the list.
 * @type {ModeDefinition[]}
 */
const MODE_DEFINITIONS = [
  { mode: 'desktop', name: 'GitHub Copilot Desktop', fn: () => getCopilotDesktopBinary() },
  { mode: 'vscode', name: 'Copilot VS Code Extension', fn: () => getCopilotVscodeBinary() },
  { mode: 'cli', name: 'Standalone Copilot CLI', fn: () => getCopilotCliBinary() },
];

// ============================================================================
// SECTION: Main API — runCopilot()
// ============================================================================

/**
 * Runs a prompt through GitHub Copilot using the preferred mode (desktop > vscode > cli).
 * If a mode is reachable but lacks subscription/tokens, cascades to the next available
 * mode in preference order unless pinned via `copilotMode`.
 *
 * @param {RunCopilotOptions} options
 * @returns {Promise<RunCopilotResult>}
 */
export async function runCopilot(options = {}) {
  const {
    prompt,
    files = [],
    model = DEFAULT_COPILOT_MODEL,
    effort = DEFAULT_COPILOT_EFFORT,
    timeout = DEFAULT_TIMEOUT_SECONDS,
    maxBufferMb = 10,
    verbose = false,
    copilotMode = 'auto',
  } = options;

  const viableTargets = findViableTargets(copilotMode);
  if (viableTargets.length === 0) {
    throw createNoTargetsError();
  }

  const sessionLogger = createSessionLogger('copilot');
  const initialGitStatus = getGitStatus();
  const formattedPrompt = buildFormattedPrompt(prompt, files);
  const effectiveModel = model || DEFAULT_COPILOT_MODEL;
  const effectiveEffort = effort || DEFAULT_COPILOT_EFFORT;

  let lastResult = null;

  // Cascade across viable targets in priority order. A quota/auth failure advances
  // to the next target; any other outcome is returned immediately.
  for (let i = 0; i < viableTargets.length; i++) {
    const target = viableTargets[i];
    const isLastTarget = i === viableTargets.length - 1;
    const canCascade = !isLastTarget && (!copilotMode || copilotMode === 'auto');

    try {
      const result = await executeOnTarget({
        target,
        model: effectiveModel,
        formattedPrompt,
        effort: effectiveEffort,
        timeout,
        maxBufferMb,
        verbose,
        sessionLogger,
        initialGitStatus,
      });

      const isQuotaOrAuth = result.failureKind === 'quota' || result.failureKind === 'auth';
      if (isQuotaOrAuth && canCascade) {
        process.stderr.write(
          `[dispatch] Notice: ${target.name} exited with '${result.failureKind}' (not subscribed or token missing).\n` +
            `[dispatch] Cascading to next available mode (${viableTargets[i + 1].name})...\n`,
        );
        lastResult = result;
        continue;
      }

      sessionLogger.close();
      return result;
    } catch (err) {
      if (canCascade) {
        process.stderr.write(
          `[dispatch] Warning: ${target.name} execution failed (${err.message}). Cascading to next mode...\n`,
        );
        continue;
      }
      sessionLogger.close();
      throw err;
    }
  }

  sessionLogger.close();
  return lastResult;
}


/**
 * Returns viable Copilot targets in preference order, each probed up to executable
 * reachability. Falls back to on-disk presence (without reachability) if no probe
 * succeeds — covers sandboxes where `--version` invocation is inconclusive.
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
  if (viable.length > 0) return viable;

  for (const candidate of candidates) {
    const bin = candidate.fn();
    if (bin) viable.push({ mode: candidate.mode, name: candidate.name, binary: bin, version: null });
  }
  return viable;
}

function createNoTargetsError() {
  const err = new Error(
    'GitHub Copilot was not found in Copilot Desktop cache, VS Code extension storage, or system PATH.\n' +
      'Preference order: GitHub Copilot Desktop > Copilot VS Code Extension > Standalone Copilot CLI.\n' +
      '- Mode [copilot desktop]: Install GitHub Copilot Desktop app.\n' +
      '- Mode [copilot vscode]:  Install GitHub Copilot Chat extension in VS Code.\n' +
      '- Mode [copilot cli]:     npm install -g @github/copilot (or brew install copilot)',
  );
  err.code = 'CLI_NOT_FOUND';
  err.failureKind = 'not-found';
  return err;
}

/**
 * Spawns Copilot on a single resolved target and resolves once the process exits,
 * enforcing the timeout and buffer caps and checking git integrity.
 * @returns {Promise<RunCopilotResult>}
 */
function executeOnTarget({
  target,
  model,
  formattedPrompt,
  effort,
  timeout,
  maxBufferMb,
  verbose,
  sessionLogger,
  initialGitStatus,
}) {
  // Headless print mode (interactive mode removed — delegates are always headless)
  const { prompt: argvPrompt, briefFile } = preparePromptForArgv(formattedPrompt, 'copilot');
  const copilotArgs = ['-p', argvPrompt];
  if (model) copilotArgs.push('--model', model);
  if (effort) copilotArgs.push('--effort', effort);
  copilotArgs.push('--mode', 'plan');

  const modeLabel = { desktop: 'copilot desktop', vscode: 'copilot vscode', cli: 'copilot cli' }[target.mode];
  const providerLabel = `GitHub Copilot [${target.mode}] (${modeLabel})`;

  emitInitBanner({ provider: providerLabel, logFile: sessionLogger.logFile, mode: 'READ-ONLY' });

  const trace = createTraceWriter(verbose);

  return new Promise((resolve, reject) => {
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let totalOutputBytes = 0;
    let isTimedOut = false;
    let isBufferExceeded = false;
    const maxBufferBytes = maxBufferMb * 1024 * 1024;

    const child = spawnCli(target.binary, copilotArgs, {
      cwd: PROJECT_ROOT,
      env: getSanitizedEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    const timer = setTimeout(() => {
      isTimedOut = true;
      terminateProcessTree(child);
    }, timeout * 1000);

    child.stdout.on('data', (chunk) => {
      totalOutputBytes += chunk.length;
      if (totalOutputBytes > maxBufferBytes) {
        if (!isBufferExceeded) {
          isBufferExceeded = true;
          terminateProcessTree(child);
        }
        return;
      }
      stdoutBuffer += chunk.toString('utf8');
      sessionLogger.write(chunk);
      if (trace) trace(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString('utf8');
      sessionLogger.write(chunk);
      if (trace) trace(chunk);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);

      const sessionId = extractCopilotSessionId(stdoutBuffer) || extractCopilotSessionId(stderrBuffer);
      const sessionLink = sessionId ? `copilot --resume ${sessionId}` : null;

      const gitIntegrity = checkGitIntegrity(initialGitStatus);

      // A truncated run still carries its partial analysis; return captured output
      const truncated = isTimedOut ? 'timeout' : isBufferExceeded ? 'buffer' : null;
      const exitCode = truncated ? (isTimedOut ? 124 : 137) : (code ?? (signal ? 1 : 0));
      const failureKind = classifyCopilotFailure(`${stderrBuffer}\n${stdoutBuffer}`) || truncated;

      emitCompletionBanner({ provider: providerLabel, sessionLink, exitCode, truncated });

      resolve({
        provider: 'copilot',
        mode: target.mode,
        binary: target.binary,
        stdout: extractCleanResponse(stdoutBuffer),
        rawStdout: stdoutBuffer,
        stderr: stderrBuffer,
        exitCode,
        logFile: sessionLogger.logFile,
        briefFile,
        sessionId,
        sessionLink,
        truncated,
        failureKind,
        gitIntegrityViolation: gitIntegrity.violation,
        gitIntegrityDetails: gitIntegrity.details,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      terminateProcessTree(child);
      sessionLogger.close();
      err.code = 1;
      err.stderr = stderrBuffer;
      err.failureKind = classifyCopilotFailure(`${stderrBuffer}\n${err.message}`);
      reject(err);
    });
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
    if (res.gitIntegrityViolation) {
      console.warn(`\n[dispatch] WARNING: Workspace was modified during READ-ONLY execution!`);
      if (res.gitIntegrityDetails) {
        console.warn(`[dispatch] Changed files:\n${res.gitIntegrityDetails}`);
      }
      console.warn('');
    }
    process.exit(res.stdout ? res.exitCode : (res.failureKind ? 1 : res.exitCode));
  } catch (err) {
    console.error(`\n[dispatch] ERROR: ${err.message}`);
    process.exit(typeof err.code === 'number' ? err.code : 1);
  }
}

/** Parses the runner-specific `--copilot-mode` and `--test`/`--probe` flags. */
function parseCopilotArgs(argv) {
  const options = parseCommonArgs(argv);
  options.copilotMode = 'auto';
  options.probeOnly = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--test' || arg === '--probe' || arg === '--check' || arg === '--test-modes') {
      options.probeOnly = true;
    } else if (arg === '--copilot-mode' && argv[i + 1]) {
      options.copilotMode = argv[++i];
    } else if (arg.startsWith('--copilot-mode=')) {
      options.copilotMode = arg.slice('--copilot-mode='.length);
    }
  }

  return options;
}

function printReachabilityReport(copilotMode) {
  const probe = probeCopilotModes(copilotMode);
  console.log('[dispatch] GitHub Copilot Reachability Status:');
  console.log(formatProbeLine('copilot desktop', 1, probe.desktop));
  console.log(formatProbeLine('copilot vscode', 2, probe.vscode));
  console.log(formatProbeLine('copilot cli', 3, probe.cli));

  if (probe.preferred) {
    console.log(`\n  -> Selected Target: mode=${probe.preferred.mode}, binary=${probe.preferred.binary}`);
    console.log(
      '  -> Verification: Reached successfully via executable invocation. Active subscription/token not required for reachability test.',
    );
  } else {
    console.error(
      '\n  -> Error: Neither Copilot Desktop, VS Code Copilot extension, nor Standalone Copilot CLI is reachable.',
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
  -m, --model <name>            Override Copilot model (default: ${DEFAULT_COPILOT_MODEL})
  -e, --effort <level>          Override reasoning effort (default: ${DEFAULT_COPILOT_EFFORT})
  -t, --timeout <seconds>       Override timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})
  --copilot-mode <mode>         Explicit mode preference: 'desktop', 'vscode', 'cli', or 'auto' (default: auto)
  --test, --probe               Test reachability across modes without requiring tokens or prompt
  -v, --verbose                 Stream live trace to stderr (terminal only; ignored when piped)
  -h, --help                    Show this help

Preference Order:
  1. GitHub Copilot Desktop (desktop)
  2. Copilot VS Code Extension (vscode)
  3. Standalone Copilot CLI (cli)

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
// SECTION: Binary Discovery — Mode 1: GitHub Copilot Desktop (`desktop`)
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
// SECTION: Binary Discovery — Mode 2: Copilot VS Code Extension (`vscode`)
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
// SECTION: Binary Discovery — Mode 3: Standalone Copilot CLI (`cli`)
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
  const binName = process.platform === 'win32' ? 'copilot.cmd' : 'copilot';
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
  if (!text) return null;
  const match =
    text.match(/"session_id"\s*:\s*"([a-zA-Z0-9_-]+)"/) ||
    text.match(/session\s+id[:=]\s*([a-zA-Z0-9_-]{8,})/i) ||
    text.match(/copilot\s+--resume\s+([a-zA-Z0-9_-]{8,})/i);
  return match ? match[1] : null;
}

/**
 * Classifies Copilot-specific execution failures.
 *
 * Catches credential, OAuth, and subscription errors when a mode is reachable
 * but not subscribed or lacks tokens, then falls back to the shared classifier.
 *
 * @param {string} text Raw stdout and stderr
 * @returns {'quota'|'context-overflow'|'auth'|'not-found'|'timeout'|null}
 */
export function classifyCopilotFailure(text) {
  if (!text || typeof text !== 'string') return null;

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

// ============================================================================
// SECTION: Module Execution Guard
// ============================================================================

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}
