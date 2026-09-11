#!/usr/bin/env node

/**
 * @file claude-run.mjs
 * @description Dedicated runner for Claude Code with multi-mode resolution.
 *
 * Supports cross-platform execution across macOS, Windows, and Linux (bash/zsh/PowerShell).
 * Resolves Claude executables according to preference order:
 *   1. Claude Desktop (desktop)
 *   2. Claude VS Code Extension (vscode)
 *   3. Claude CLI (cli)
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
 * @property {boolean} gitIntegrityViolation
 * @property {string|null} gitIntegrityDetails
 */

// ============================================================================
// SECTION: Constants (tweak these)
// ============================================================================

/**
 * Structural read-only enforcement: only these tools are available to the delegate.
 * Covers file reading, git inspection, and text search — no write, edit, or
 * unrestricted shell access.
 */
export const READ_ONLY_ALLOWED_TOOLS = [
  'Read',
  'Glob',
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
  'Bash(find *)',
  'Bash(ls *)',
  'Bash(head *)',
  'Bash(tail *)',
  'Bash(wc *)',
  'Bash(file *)',
  'Bash(jq *)',
  'Bash(awk *)',
  'Bash(diff *)',
  'Bash(sort *)',
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
  'WebFetch',
  'WebSearch',
  'TodoWrite',
];

/**
 * Execution modes in cascade preference order: Claude Desktop > VS Code Extension > CLI.
 * The single source of truth for mode metadata — every mode-aware function below
 * (resolution, probing, execution) iterates this instead of redeclaring the list.
 * @type {ModeDefinition[]}
 */
export const MODE_DEFINITIONS = [
  { mode: 'desktop', name: 'Claude Desktop', fn: () => getClaudeDesktopBinary() },
  { mode: 'vscode', name: 'Claude VS Code Extension', fn: () => getClaudeVSCodeBinary() },
  { mode: 'cli', name: 'Claude CLI', fn: () => getClaudeCliBinary() },
];

// ============================================================================
// SECTION: Main API — runClaude()
// ============================================================================

/**
 * Runs a prompt through Claude Code using the preferred mode (desktop > vscode > cli).
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
    timeout = DEFAULT_TIMEOUT_SECONDS,
    maxBufferMb = 10,
    verbose = false,
    claudeMode = null,
  } = options;

  const viableTargets = findViableTargets(claudeMode);
  if (viableTargets.length === 0) {
    throw createNoTargetsError();
  }

  const sessionLogger = createSessionLogger('claude');
  const initialGitStatus = getGitStatus();
  const formattedPrompt = buildFormattedPrompt(prompt, files);
  const modelsToTry = resolveModelsToTry(model);
  const effectiveEffort = effort || null;

  let lastResult = null;

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
        const result = await executeOnTarget({
          target,
          model: currentModel,
          formattedPrompt,
          effort: effectiveEffort,
          timeout,
          maxBufferMb,
          verbose,
          sessionLogger,
          initialGitStatus,
        });
        lastResult = result;

        if (result.exitCode === 0 && !result.failureKind) {
          sessionLogger.close();
          return result;
        }

        if (!isLastModel) {
          const nextModel = modelsToTry[m + 1];
          process.stderr.write(
            `[dispatch] Notice: Model '${currentModel}' failed or not available on ${target.name} (exit ${result.exitCode}${result.failureKind ? `, failure: ${result.failureKind}` : ''}).\n` +
              `[dispatch] Trying fallback model '${nextModel}'...\n`,
          );
          continue;
        }

        const isQuotaOrAuth = result.failureKind === 'quota' || result.failureKind === 'auth';
        if (isQuotaOrAuth && !isLastTarget && !claudeMode) {
          process.stderr.write(
            `[dispatch] Notice: ${target.name} exited with '${result.failureKind}' (not subscribed or token depleted).\n` +
              `[dispatch] Cascading to next available mode (${viableTargets[i + 1].name})...\n`,
          );
          break;
        }

        sessionLogger.close();
        return result;
      } catch (err) {
        if (!isLastModel) {
          process.stderr.write(
            `[dispatch] Warning: Model '${currentModel}' execution failed on ${target.name} (${err.message}). Trying fallback model '${modelsToTry[m + 1]}'...\n`,
          );
          continue;
        }
        if (!isLastTarget && !claudeMode) {
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

/**
 * Resolves the models to try, in priority order, from the raw `model` option.
 * Accepts an array, a comma-separated string, or a single model id. `null`/empty means
 * no model is configured anywhere — a single-element `[null]` list omits `--model`
 * entirely so the Claude CLI's own default applies.
 * @param {string|string[]|null} model
 * @returns {(string|null)[]}
 */
/**
 * Builds the `claude -p` argument array. `model`/`effort` are omitted entirely when
 * falsy so the Claude CLI's own default applies — dispatch ships no hardcoded fallback.
 * @param {string} argvPrompt
 * @param {{ model?: string|null, effort?: string|null }} [opts]
 * @returns {string[]}
 */
export function buildClaudeArgs(argvPrompt, { model, effort } = {}) {
  const args = ['-p', argvPrompt, '--output-format', 'json'];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  for (const tool of READ_ONLY_ALLOWED_TOOLS) {
    args.push('--allowedTools', tool);
  }
  return args;
}

export function resolveModelsToTry(model) {
  let models = [];
  if (Array.isArray(model)) {
    models = model.filter(Boolean);
  } else if (typeof model === 'string' && model.includes(',')) {
    models = model.split(',').map((m) => m.trim()).filter(Boolean);
  } else if (typeof model === 'string' && model.trim()) {
    models = [model.trim()];
  }
  return models.length > 0 ? models : [null];
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
  return viable;
}

function createNoTargetsError() {
  const err = new Error(
    'Claude Code was not found or not reachable in any mode (Claude Desktop, VS Code extension, or CLI).\n' +
      'Install options:\n' +
      '  - Claude Desktop: Install Claude Desktop application\n' +
      '  - VS Code Extension: Install Anthropic Claude Code extension\n' +
      '  - Claude CLI: npm install -g @anthropic-ai/claude-code (or curl -fsSL https://claude.ai/install.sh | bash)',
  );
  err.code = 'CLI_NOT_FOUND';
  return err;
}

/**
 * Spawns Claude Code on a single resolved target/model pair and resolves once the
 * process exits, enforcing the timeout and buffer caps and checking git integrity.
 * @returns {Promise<RunClaudeResult>}
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
  const { prompt: argvPrompt, briefFile } = preparePromptForArgv(formattedPrompt, 'claude');
  const claudeArgs = buildClaudeArgs(argvPrompt, { model, effort });

  emitInitBanner({
    provider: `Claude Code [${target.mode}] (claude)`,
    model,
    effort,
    logFile: sessionLogger.logFile,
    mode: 'READ-ONLY',
  });

  const trace = createTraceWriter(verbose);

  return new Promise((resolve, reject) => {
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let totalOutputBytes = 0;
    let isTimedOut = false;
    let isBufferExceeded = false;
    const maxBufferBytes = maxBufferMb * 1024 * 1024;

    const child = spawnCli(target.bin, claudeArgs, {
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

      const envelope = parseClaudeEnvelope(stdoutBuffer);
      const sessionId = envelope.sessionId || extractClaudeSessionId(stderrBuffer);
      const sessionLink = sessionId ? `claude --resume ${sessionId}` : null;

      const gitIntegrity = checkGitIntegrity(initialGitStatus);

      const truncated = isTimedOut ? 'timeout' : isBufferExceeded ? 'buffer' : null;
      const exitCode = truncated ? (isTimedOut ? 124 : 137) : (code ?? (signal ? 1 : 0));

      emitCompletionBanner({
        provider: `Claude Code [${target.mode}] (claude)`,
        sessionLink,
        exitCode,
        truncated,
      });

      resolve({
        provider: 'claude',
        claudeMode: target.mode,
        bin: target.bin,
        model,
        stdout: envelope.text,
        rawStdout: stdoutBuffer,
        stderr: stderrBuffer,
        exitCode: envelope.isError && exitCode === 0 ? 1 : exitCode,
        logFile: sessionLogger.logFile,
        briefFile,
        sessionId,
        sessionLink,
        truncated,
        failureKind:
          envelope.subtype ||
          classifyFailure(`${stderrBuffer}\n${envelope.text}`) ||
          (truncated ? truncated : null),
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
      reject(err);
    });
  });
}

// ============================================================================
// SECTION: CLI Entry Point
// ============================================================================

export async function main() {
  const options = parseCommonArgs(process.argv);
  const { requestedMode, testModes } = parseModeFlags(process.argv.slice(2));

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
      claudeMode: requestedMode || options.claudeMode,
      prompt: finalPrompt,
    });
    if (res.stdout) {
      process.stdout.write(res.stdout.endsWith('\n') ? res.stdout : `${res.stdout}\n`);
    }
    if (res.gitIntegrityViolation) {
      console.warn(`\n[dispatch] WARNING: Workspace was modified during READ-ONLY execution!`);
      if (res.gitIntegrityDetails) {
        console.warn(`[dispatch] Changed files:\n${res.gitIntegrityDetails}`);
      }
      console.warn('');
    }
    process.exit(res.exitCode);
  } catch (err) {
    console.error(`\n[dispatch] ERROR: ${err.message}`);
    process.exit(typeof err.code === 'number' ? err.code : 1);
  }
}

/** Parses the runner-specific `--claude-mode`/`--mode` and `--test-modes` flags. */
function parseModeFlags(args) {
  let requestedMode = null;
  let testModes = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--claude-mode' || arg === '--mode') {
      requestedMode = args[++i] || null;
    } else if (arg.startsWith('--claude-mode=')) {
      requestedMode = arg.slice('--claude-mode='.length);
    } else if (arg === '--test-modes' || arg === '--probe-modes' || arg === '--reachability') {
      testModes = true;
    }
  }
  return { requestedMode, testModes };
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
  -e, --effort <level>          Override reasoning effort (no default here — see dispatch's config.default.jsonc)
  -t, --timeout <seconds>       Override timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})
  --claude-mode <mode>          Select execution mode: desktop | vscode | cli
  --test-modes, --reachability  Test reachability of all modes (--version) without token consumption
  -v, --verbose                 Stream live trace to stderr (terminal only; ignored when piped)
  -h, --help                    Show this help

Preference Order:
  1. Claude Desktop (desktop)
  2. Claude VS Code Extension (vscode)
  3. Claude CLI (cli)
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
  if (!binPath || typeof binPath !== 'string') {
    return { reachable: false, version: null, error: 'Binary path not provided' };
  }
  if (!fs.existsSync(binPath)) {
    return { reachable: false, version: null, error: 'Binary file does not exist' };
  }
  try {
    const res = spawnCliSync(binPath, ['--version'], { encoding: 'utf8', timeout: 3000 });
    if (res.status === 0) {
      return { reachable: true, version: (res.stdout || '').trim(), error: null };
    }
    return {
      reachable: false,
      version: null,
      error: `Process exited with code ${res.status}: ${(res.stderr || '').trim()}`,
    };
  } catch (err) {
    return { reachable: false, version: null, error: err.message };
  }
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
// SECTION: Binary Discovery — Mode 1: Claude Desktop (`desktop`)
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
// SECTION: Binary Discovery — Mode 2: Claude VS Code Extension (`vscode`)
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
// SECTION: Binary Discovery — Mode 3: Claude CLI (`cli`)
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

  const bin = findBinary(process.platform === 'win32' ? 'claude.cmd' : 'claude', extraCandidates);

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
  if (!text) return null;
  const match =
    text.match(/"session_id"\s*:\s*"([a-zA-Z0-9_-]+)"/) ||
    text.match(/session\s+id[:=]\s*([a-zA-Z0-9_-]{8,})/i) ||
    text.match(/claude\s+--resume\s+([a-zA-Z0-9_-]{8,})/i);
  return match ? match[1] : null;
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
