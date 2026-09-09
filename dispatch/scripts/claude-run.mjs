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
import { fileURLToPath } from 'node:url';
import {
  buildAttachmentBlock,
  classifyFailure,
  createSessionLogger,
  createTraceWriter,
  DEFAULT_TIMEOUT_SECONDS,
  emitCompletionBanner,
  emitInitBanner,
  extractCleanResponse,
  findBinary,
  formatSafetyPrompt,
  describeGitStatusDiff,
  getGitStatus,
  getSanitizedEnv,
  parseCommonArgs,
  preparePromptForArgv,
  PROJECT_ROOT,
  readStdin,
  spawnCli,
  spawnCliSync,
  terminateProcessTree,
} from './common.mjs';

const currentFilePath = fileURLToPath(import.meta.url);

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5';
export const DEFAULT_CLAUDE_EFFORT = 'medium';

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

// SECTION: Directory & Version Scanning Helpers

/**
 * Scans a directory for subdirectories, sorted in descending order (newest version first).
 * Used across macOS, Windows, and Linux for version-stamped application caches.
 *
 * @param {string} baseDir
 * @returns {string[]}
 */
function scanVersionDirs(baseDir) {
  if (!fs.existsSync(baseDir)) return [];
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
  } catch {
    return [];
  }
}

/**
 * Probes a list of candidate file paths, expanding leading `~` to the user's home directory.
 * Returns the first candidate that exists on disk and is a regular file.
 *
 * @param {string[]} candidates
 * @returns {string|null}
 */
function findFirstExistingFile(candidates) {
  const homeDir = os.homedir();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const expanded = candidate.replace(/^~(?=$|\/|\\)/, homeDir);
    try {
      if (fs.existsSync(expanded)) {
        const stat = fs.statSync(expanded);
        if (stat.isFile()) {
          return path.resolve(expanded);
        }
      }
    } catch {}
  }
  return null;
}

// SECTION: Mode 1 - Claude Desktop (`desktop`)

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

  // [MODE: Claude Desktop] [OS: macOS]
  // Claude Desktop on macOS installs helper CLI binaries inside ~/Library/Application Support/Claude/claude-code/<version>/claude.app
  if (process.platform === 'darwin') {
    const appSupportClaudeCode = path.join(
      os.homedir(),
      'Library/Application Support/Claude/claude-code',
    );
    const versions = scanVersionDirs(appSupportClaudeCode);
    for (const ver of versions) {
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

  // [MODE: Claude Desktop] [OS: Windows]
  // Claude Desktop on Windows stores app data in %APPDATA%\Claude and %LOCALAPPDATA%\Claude
  if (process.platform === 'win32') {
    const winDirs = [
      process.env.APPDATA ? path.join(process.env.APPDATA, 'Claude', 'claude-code') : null,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Claude', 'claude-code') : null,
    ].filter(Boolean);

    for (const winDir of winDirs) {
      const versions = scanVersionDirs(winDir);
      for (const ver of versions) {
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

  // [MODE: Claude Desktop] [OS: Linux]
  // Claude Desktop / packages on Linux place data in ~/.config/Claude or ~/.local/share/Claude
  if (process.platform === 'linux') {
    const linuxDirs = [
      path.join(os.homedir(), '.config', 'Claude', 'claude-code'),
      path.join(os.homedir(), '.local', 'share', 'Claude', 'claude-code'),
    ];
    for (const lDir of linuxDirs) {
      const versions = scanVersionDirs(lDir);
      for (const ver of versions) {
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

// SECTION: Mode 2 - Claude VS Code Extension (`vscode`)

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

  // [MODE: Claude VS Code Extension] [OS: Cross-platform - Environment Variable]
  // The VS Code extension exports CLAUDE_CODE_EXECPATH into terminals it spawns.
  if (process.env.CLAUDE_CODE_EXECPATH) {
    candidates.push(process.env.CLAUDE_CODE_EXECPATH);
  }

  // [MODE: Claude VS Code Extension] [OS: Cross-platform - Extension Directory Scan]
  // Scans standard VS Code / Cursor extension directories for native binaries.
  const homeDir = os.homedir();
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
          // [OS: Windows] Extension binary paths
          candidates.push(
            path.join(extBase, extName, 'resources', 'native-binary', 'claude.exe'),
            path.join(extBase, extName, 'bin', 'claude.exe'),
            path.join(extBase, extName, 'resources', 'native-binary', 'claude.cmd'),
          );
        } else {
          // [OS: macOS / Linux] Extension binary paths
          candidates.push(
            path.join(extBase, extName, 'resources', 'native-binary', 'claude'),
            path.join(extBase, extName, 'bin', 'claude'),
          );
        }
      }
    } catch {}
  }

  // [MODE: Claude VS Code Extension] [OS: macOS - Agent-host SDK Cache]
  if (process.platform === 'darwin') {
    const macCodeRoots = [
      path.join(homeDir, 'Library/Application Support/Code/agent-host/sdk-cache/claude'),
      path.join(homeDir, 'Library/Application Support/Code - Insiders/agent-host/sdk-cache/claude'),
    ];
    for (const sdkRoot of macCodeRoots) {
      const versions = scanVersionDirs(sdkRoot);
      for (const ver of versions) {
        candidates.push(
          path.join(sdkRoot, ver, 'darwin-arm64/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'),
          path.join(sdkRoot, ver, 'darwin-x64/node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/claude'),
        );
      }
    }
  }

  // [MODE: Claude VS Code Extension] [OS: Windows - Agent-host SDK Cache]
  if (process.platform === 'win32' && process.env.APPDATA) {
    const winCodeRoots = [
      path.join(process.env.APPDATA, 'Code', 'agent-host', 'sdk-cache', 'claude'),
      path.join(process.env.APPDATA, 'Code - Insiders', 'agent-host', 'sdk-cache', 'claude'),
    ];
    for (const sdkRoot of winCodeRoots) {
      const versions = scanVersionDirs(sdkRoot);
      for (const ver of versions) {
        candidates.push(
          path.join(sdkRoot, ver, 'win32-x64', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe'),
          path.join(sdkRoot, ver, 'win32-arm64', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-arm64', 'claude.exe'),
        );
      }
    }
  }

  // [MODE: Claude VS Code Extension] [OS: Linux - Agent-host SDK Cache]
  if (process.platform === 'linux') {
    const linuxCodeRoots = [
      path.join(homeDir, '.config', 'Code', 'agent-host', 'sdk-cache', 'claude'),
      path.join(homeDir, '.config', 'Code - Insiders', 'agent-host', 'sdk-cache', 'claude'),
    ];
    for (const sdkRoot of linuxCodeRoots) {
      const versions = scanVersionDirs(sdkRoot);
      for (const ver of versions) {
        candidates.push(
          path.join(sdkRoot, ver, 'linux-x64/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'),
          path.join(sdkRoot, ver, 'linux-arm64/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude'),
        );
      }
    }
  }

  return findFirstExistingFile(candidates);
}

// SECTION: Mode 3 - Claude CLI (`cli`)

/**
 * Resolves the standalone Claude Code CLI binary installed via npm, native installer, or package manager.
 *
 * Branching by Operating System:
 * - macOS / Linux:
 *   Probes `~/.local/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`,
 *   global npm/nvm paths, and system PATH via `which`.
 * - Windows:
 *   Probes `%APPDATA%\npm\claude.cmd`, `%USERPROFILE%\.local\bin\claude.exe`, and system PATH via `where.exe`.
 *   Prefers nested direct `claude.exe` to avoid batch launcher argument mangling.
 *
 * @returns {string|null}
 */
export function getClaudeCliBinary() {
  const extraCandidates = [];

  // [MODE: Claude CLI] [OS: macOS / Linux]
  if (process.platform !== 'win32') {
    extraCandidates.push(
      '~/.local/bin/claude',
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      '~/.npm-global/bin/claude',
    );

    // Node Version Manager (NVM) paths on macOS/Linux
    const nvmVersionsDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
    const nvmVersions = scanVersionDirs(nvmVersionsDir);
    for (const ver of nvmVersions) {
      extraCandidates.push(path.join(nvmVersionsDir, ver, 'bin', 'claude'));
    }
  }

  // [MODE: Claude CLI] [OS: Windows]
  if (process.platform === 'win32') {
    if (process.env.APPDATA) {
      extraCandidates.push(path.join(process.env.APPDATA, 'npm', 'claude.cmd'));
      extraCandidates.push(path.join(process.env.APPDATA, 'npm', 'claude'));
    }
    if (process.env.USERPROFILE) {
      extraCandidates.push(path.join(process.env.USERPROFILE, '.local', 'bin', 'claude.exe'));
      extraCandidates.push(path.join(process.env.USERPROFILE, '.local', 'bin', 'claude.cmd'));
    }
    if (process.env.LOCALAPPDATA) {
      extraCandidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Claude', 'claude.exe'));
    }
  }

  // System PATH lookup fallback across platforms
  const bin = findBinary(process.platform === 'win32' ? 'claude.cmd' : 'claude', extraCandidates);

  // [OS: Windows] Prefer direct claude.exe inside node_modules over .cmd launcher
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

// SECTION: Mode Preference Order & Target Resolution

/**
 * Resolves the Claude binary in order of preference:
 *   1. Claude Desktop (`desktop`)
 *   2. Claude VS Code Extension (`vscode`)
 *   3. Claude CLI (`cli`)
 *
 * @param {'desktop'|'vscode'|'cli'|null} [preferredMode] Explicit mode override, or null for default cascade
 * @returns {string|null}
 */
export function getClaudeBinary(preferredMode = null) {
  if (preferredMode === 'desktop') return getClaudeDesktopBinary();
  if (preferredMode === 'vscode') return getClaudeVSCodeBinary();
  if (preferredMode === 'cli') return getClaudeCliBinary();

  // Cascade order of preference: claude desktop > claude vscode extension > claude cli
  return (
    getClaudeDesktopBinary() ||
    getClaudeVSCodeBinary() ||
    getClaudeCliBinary() ||
    null
  );
}

/**
 * Resolves the active Claude execution target with mode metadata.
 *
 * @param {'desktop'|'vscode'|'cli'|null} [preferredMode]
 * @returns {{ mode: 'desktop'|'vscode'|'cli', name: string, bin: string } | null}
 */
export function resolveClaudeTarget(preferredMode = null) {
  const modes = [
    { mode: 'desktop', name: 'Claude Desktop', fn: getClaudeDesktopBinary },
    { mode: 'vscode', name: 'Claude VS Code Extension', fn: getClaudeVSCodeBinary },
    { mode: 'cli', name: 'Claude CLI', fn: getClaudeCliBinary },
  ];

  const ordered = preferredMode
    ? modes.filter((m) => m.mode === preferredMode.toLowerCase())
    : modes;

  for (const candidate of ordered) {
    const bin = candidate.fn();
    if (bin) {
      return { mode: candidate.mode, name: candidate.name, bin };
    }
  }
  return null;
}

// SECTION: Reachability & Mode Probing

/**
 * Tests whether a Claude binary is reachable and executable without requiring tokens or subscriptions.
 * Runs `--version` with a short timeout.
 *
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
      const version = (res.stdout || '').trim();
      return { reachable: true, version, error: null };
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
 * Probes all three Claude modes, reporting reachability, paths, and versions without consuming tokens.
 *
 * @returns {Array<{ mode: 'desktop'|'vscode'|'cli', name: string, bin: string|null, reachable: boolean, version: string|null, status: string, error?: string }>}
 */
export function probeAllClaudeModes() {
  const modes = [
    { mode: 'desktop', name: 'Claude Desktop', fn: getClaudeDesktopBinary },
    { mode: 'vscode', name: 'Claude VS Code Extension', fn: getClaudeVSCodeBinary },
    { mode: 'cli', name: 'Claude CLI', fn: getClaudeCliBinary },
  ];

  return modes.map(({ mode, name, fn }) => {
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
 *
 * @param {'desktop'|'vscode'|'cli'|null} [preferredMode]
 * @returns {Promise<boolean>}
 */
export async function isClaudeAvailable(preferredMode = null) {
  const bin = getClaudeBinary(preferredMode);
  if (!bin) return false;
  return testClaudeBinaryReachability(bin).reachable;
}

// SECTION: Session ID & Envelope Parsing

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

// SECTION: Execution Runner

/**
 * Runs a prompt through Claude Code using the preferred mode (desktop > vscode > cli).
 * If a mode encounters auth or quota failure (unsubscribed or out of tokens), it cascades
 * to the next available mode in preference order unless pinned.
 */
export async function runClaude(options = {}) {
  const {
    prompt,
    files = [],
    model = DEFAULT_CLAUDE_MODEL,
    effort = DEFAULT_CLAUDE_EFFORT,
    timeout = DEFAULT_TIMEOUT_SECONDS,
    maxBufferMb = 10,
    verbose = false,
    claudeMode = null,
  } = options;

  // Determine candidate execution modes in order of preference
  const allModeCandidates = [
    { mode: 'desktop', name: 'Claude Desktop', fn: getClaudeDesktopBinary },
    { mode: 'vscode', name: 'Claude VS Code Extension', fn: getClaudeVSCodeBinary },
    { mode: 'cli', name: 'Claude CLI', fn: getClaudeCliBinary },
  ];

  const targetModes = claudeMode
    ? allModeCandidates.filter((m) => m.mode === claudeMode.toLowerCase())
    : allModeCandidates;

  const viableTargets = [];
  for (const candidate of targetModes) {
    const bin = candidate.fn();
    if (bin && testClaudeBinaryReachability(bin).reachable) {
      viableTargets.push({ mode: candidate.mode, name: candidate.name, bin });
    }
  }

  if (viableTargets.length === 0) {
    const err = new Error(
      'Claude Code was not found or not reachable in any mode (Claude Desktop, VS Code extension, or CLI).\n' +
        'Install options:\n' +
        '  - Claude Desktop: Install Claude Desktop application\n' +
        '  - VS Code Extension: Install Anthropic Claude Code extension\n' +
        '  - Claude CLI: npm install -g @anthropic-ai/claude-code (or curl -fsSL https://claude.ai/install.sh | bash)',
    );
    err.code = 'CLI_NOT_FOUND';
    throw err;
  }

  const sessionLogger = createSessionLogger('claude');
  const initialGitStatus = getGitStatus();

  const attachments = buildAttachmentBlock(files);
  for (const note of attachments.notes) {
    process.stderr.write(`[dispatch] Attachment ${note}\n`);
  }

  const fullPrompt = attachments.text ? `${attachments.text}\n\n${prompt}` : prompt;
  const formattedPrompt = formatSafetyPrompt(fullPrompt, {
    workspaceRoot: PROJECT_ROOT,
    attachedFiles: files,
  });

  const effectiveModel = model || DEFAULT_CLAUDE_MODEL;
  const effectiveEffort = effort || DEFAULT_CLAUDE_EFFORT;

  // Helper to execute on a specific target
  const executeOnTarget = async (target) => {
    // Headless print mode (interactive mode removed — delegates are always headless)
    const { prompt: argvPrompt, briefFile } = preparePromptForArgv(formattedPrompt, 'claude');
    const claudeArgs = ['-p', argvPrompt, '--output-format', 'json'];

    if (effectiveModel) claudeArgs.push('--model', effectiveModel);
    if (effectiveEffort) claudeArgs.push('--effort', effectiveEffort);
    for (const tool of READ_ONLY_ALLOWED_TOOLS) {
      claudeArgs.push('--allowedTools', tool);
    }

    emitInitBanner({
      provider: `Claude Code [${target.mode}] (claude)`,
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

      const cleanup = () => {
        clearTimeout(timer);
        terminateProcessTree(child);
        sessionLogger.close();
      };

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

        let gitIntegrityViolation = false;
        let gitIntegrityDetails = null;
        if (initialGitStatus !== null) {
          const finalGitStatus = getGitStatus();
          if (finalGitStatus !== null && finalGitStatus !== initialGitStatus) {
            gitIntegrityViolation = true;
            gitIntegrityDetails = describeGitStatusDiff(initialGitStatus, finalGitStatus);
          }
        }

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
          gitIntegrityViolation,
          gitIntegrityDetails,
        });
      });

      child.on('error', (err) => {
        cleanup();
        err.code = 1;
        err.stderr = stderrBuffer;
        reject(err);
      });
    });
  };

  let lastResult = null;

  // Execute across viable targets with fallback on auth/quota failure
  for (let i = 0; i < viableTargets.length; i++) {
    const currentTarget = viableTargets[i];
    const isLastTarget = i === viableTargets.length - 1;

    try {
      const result = await executeOnTarget(currentTarget);
      const isQuotaOrAuth = result.failureKind === 'quota' || result.failureKind === 'auth';

      // If this mode is not subscribed or lacks tokens, cascade to next available mode
      if (isQuotaOrAuth && !isLastTarget && !claudeMode) {
        process.stderr.write(
          `[dispatch] Notice: ${currentTarget.name} exited with '${result.failureKind}' (not subscribed or token depleted).\n` +
            `[dispatch] Cascading to next available mode (${viableTargets[i + 1].name})...\n`,
        );
        lastResult = result;
        continue;
      }

      sessionLogger.close();
      return result;
    } catch (err) {
      if (!isLastTarget && !claudeMode) {
        process.stderr.write(
          `[dispatch] Warning: ${currentTarget.name} execution failed (${err.message}). Cascading to next mode...\n`,
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

// SECTION: CLI Entry Point

export async function main() {
  const options = parseCommonArgs(process.argv);

  // Parse custom mode flags
  const args = process.argv.slice(2);
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

  if (testModes) {
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
    process.exit(0);
  }

  if (options.help) {
    console.log(`
Claude Code CLI Runner (claude)

Usage:
  node scripts/claude-run.mjs [options] [prompt]

Options:
  -p, --prompt <string>         The prompt message to send
  -f, --file, --artifact        Attach context file or artifact (repeatable)
  -m, --model <name>            Override Claude model (default: ${DEFAULT_CLAUDE_MODEL})
  -e, --effort <level>          Override reasoning effort (default: ${DEFAULT_CLAUDE_EFFORT})
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
    process.exit(0);
  }

  const pipedStdin = await readStdin();
  let finalPrompt = options.prompt.trim();
  if (pipedStdin) {
    finalPrompt = finalPrompt
      ? `${finalPrompt}\n\n[Piped Input]:\n${pipedStdin}`
      : pipedStdin;
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

if (
  process.argv[1] &&
  (() => {
    const a = path.resolve(process.argv[1]);
    const b = path.resolve(currentFilePath);
    if (a === b) return true;
    try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
  })()
) {
  main().catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}
