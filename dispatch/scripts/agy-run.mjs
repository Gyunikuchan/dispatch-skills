#!/usr/bin/env node

/**
 * @file agy-run.mjs
 * @description Dedicated runner for Google Antigravity.
 *
 * Supports cross-platform execution (macOS / Windows / Linux, bash / zsh / PowerShell).
 * Implements mode resolution in order of preference:
 *   1. Antigravity 2.0 (Desktop application)
 *   2. Antigravity VS Code Extension (IDE extension / Antigravity IDE)
 *   3. Antigravity CLI (Standalone agy/antigravity CLI)
 *
 * Explicit code branches indicate which OS and execution mode are being targeted.
 * Reachability testing tests up to being able to reach each mode without requiring
 * active subscriptions or token consumption.
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
  describeGitStatusDiff,
  extractCleanResponse,
  findBinary,
  formatSafetyPrompt,
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

// SECTION: Modes and Preference Configuration

export const AGY_MODES = {
  ANTIGRAVITY_2_0: 'antigravity-2.0',
  ANTIGRAVITY_VSCODE: 'antigravity-vscode',
  ANTIGRAVITY_CLI: 'antigravity-cli',
};

/**
 * Order of preference:
 * 1. Antigravity 2.0 (Desktop app)
 * 2. Antigravity VS Code Extension (IDE extension / Antigravity IDE)
 * 3. Antigravity CLI (Standalone agy/antigravity CLI)
 */
export const AGY_MODE_PREFERENCE = [
  AGY_MODES.ANTIGRAVITY_2_0,
  AGY_MODES.ANTIGRAVITY_VSCODE,
  AGY_MODES.ANTIGRAVITY_CLI,
];

/**
 * App data directory mappings (passed via JETSKI_APP_DATA_DIR):
 * - Antigravity 2.0 maps to 'antigravity'
 * - Antigravity VS Code Extension maps to 'antigravity-ide'
 * - Antigravity CLI maps to 'antigravity-cli'
 */
export const AGY_MODE_DATA_DIRS = {
  [AGY_MODES.ANTIGRAVITY_2_0]: 'antigravity',
  [AGY_MODES.ANTIGRAVITY_VSCODE]: 'antigravity-ide',
  [AGY_MODES.ANTIGRAVITY_CLI]: 'antigravity-cli',
};

/**
 * Human-readable provider labels for init/completion banners and logs.
 */
export const AGY_MODE_LABELS = {
  [AGY_MODES.ANTIGRAVITY_2_0]: 'Antigravity 2.0 (agy)',
  [AGY_MODES.ANTIGRAVITY_VSCODE]: 'Antigravity VS Code Extension (agy)',
  [AGY_MODES.ANTIGRAVITY_CLI]: 'Antigravity CLI (agy)',
};

export const DEFAULT_AGY_MODEL = 'gemini-3.8-flash';
export const DEFAULT_AGY_EFFORT = 'medium';

// SECTION: Binary Resolution Across Platforms and Modes

/**
 * Resolves the executable binary for Antigravity on the current OS.
 * Can target a specific mode or search generally across all candidates.
 *
 * @param {string|null} [mode=null] - Specific AGY mode to locate binary for
 * @returns {string|null} Resolved absolute path to executable binary
 */
export function getAgyBinary(mode = null) {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';
  const homeDir = os.homedir();

  const extraCandidates = [];

  // ============================================================================
  // BRANCH: Antigravity 2.0 Binary Candidates
  // ============================================================================
  if (!mode || mode === AGY_MODES.ANTIGRAVITY_2_0) {
    // OS: macOS | MODE: Antigravity 2.0
    if (isMac) {
      extraCandidates.push(
        path.join(homeDir, '.gemini', 'antigravity', 'bin', 'agy'),
        '/Applications/Antigravity.app/Contents/Resources/bin/agy',
        path.join(homeDir, 'Applications/Antigravity.app/Contents/Resources/bin/agy'),
        '/opt/homebrew/bin/antigravity',
        '/usr/local/bin/antigravity',
      );
    }

    // OS: Windows | MODE: Antigravity 2.0
    if (isWin) {
      if (process.env.LOCALAPPDATA) {
        extraCandidates.push(
          path.join(process.env.LOCALAPPDATA, 'Google', 'Antigravity', 'bin', 'agy.exe'),
          path.join(process.env.LOCALAPPDATA, 'Google', 'Antigravity', 'bin', 'antigravity.exe'),
          path.join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity', 'Antigravity.exe'),
          path.join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity', 'bin', 'agy.exe'),
        );
      }
      if (process.env.APPDATA) {
        extraCandidates.push(
          path.join(process.env.APPDATA, 'Google', 'Antigravity', 'bin', 'agy.exe'),
          path.join(process.env.APPDATA, 'Google', 'Antigravity', 'bin', 'antigravity.exe'),
        );
      }
      if (process.env.ProgramFiles) {
        extraCandidates.push(
          path.join(process.env.ProgramFiles, 'Antigravity', 'bin', 'agy.exe'),
          path.join(process.env.ProgramFiles, 'Antigravity', 'Antigravity.exe'),
        );
      }
      if (process.env['ProgramFiles(x86)']) {
        extraCandidates.push(
          path.join(process.env['ProgramFiles(x86)'], 'Antigravity', 'bin', 'agy.exe'),
          path.join(process.env['ProgramFiles(x86)'], 'Antigravity', 'Antigravity.exe'),
        );
      }
    }

    // OS: Linux | MODE: Antigravity 2.0
    if (isLinux) {
      extraCandidates.push(
        path.join(homeDir, '.gemini', 'antigravity', 'bin', 'agy'),
        '/opt/Antigravity/agy',
        '/opt/Antigravity/antigravity',
        '/usr/bin/antigravity',
        '/usr/local/bin/antigravity',
        '/snap/bin/antigravity',
      );
    }
  }

  // ============================================================================
  // BRANCH: Antigravity VS Code Extension / IDE Binary Candidates
  // ============================================================================
  if (!mode || mode === AGY_MODES.ANTIGRAVITY_VSCODE) {
    // OS: macOS | MODE: Antigravity VS Code Extension
    if (isMac) {
      extraCandidates.push(
        path.join(homeDir, '.gemini', 'antigravity-ide', 'bin', 'agy'),
        '/Applications/Antigravity IDE.app/Contents/Resources/app/bin/agy',
        path.join(
          homeDir,
          'Library/Application Support/Code/User/globalStorage/google.google-antigravity/bin/agy',
        ),
      );
    }

    // OS: Windows | MODE: Antigravity VS Code Extension
    if (isWin) {
      if (process.env.APPDATA) {
        extraCandidates.push(
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
        extraCandidates.push(
          path.join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity IDE', 'bin', 'agy.exe'),
        );
      }
      extraCandidates.push(
        path.join(homeDir, '.gemini', 'antigravity-ide', 'bin', 'agy.exe'),
      );
    }

    // OS: Linux | MODE: Antigravity VS Code Extension
    if (isLinux) {
      extraCandidates.push(
        path.join(homeDir, '.gemini', 'antigravity-ide', 'bin', 'agy'),
        path.join(
          homeDir,
          '.config/Code/User/globalStorage/google.google-antigravity/bin/agy',
        ),
        '/opt/Antigravity IDE/bin/agy',
      );
    }
  }

  // ============================================================================
  // BRANCH: Antigravity Standalone CLI Binary Candidates
  // ============================================================================
  // OS: Cross-platform (macOS / Linux / Windows) | MODE: Antigravity CLI
  extraCandidates.push(
    '~/.gemini/bin/agy',
    '~/.local/bin/agy',
    '/usr/local/bin/agy',
    '/opt/homebrew/bin/agy',
    '~/.gemini/bin/antigravity',
    '~/.local/bin/antigravity',
    '/usr/local/bin/antigravity',
    '/opt/homebrew/bin/antigravity',
  );

  // OS: Windows | Probe .exe and .cmd equivalents
  if (isWin) {
    for (const candidate of [...extraCandidates]) {
      if (!candidate.endsWith('.exe') && !candidate.endsWith('.cmd')) {
        extraCandidates.push(`${candidate}.exe`);
        extraCandidates.push(`${candidate}.cmd`);
      }
    }
  }

  // Probe primary binary ('agy' / 'agy.exe')
  const primaryBin = isWin ? 'agy.exe' : 'agy';
  const resolvedPrimary = findBinary(primaryBin, extraCandidates);
  if (resolvedPrimary) return resolvedPrimary;

  // Probe secondary binary ('antigravity' / 'antigravity.exe')
  const secondaryBin = isWin ? 'antigravity.exe' : 'antigravity';
  return findBinary(secondaryBin, extraCandidates);
}

/**
 * Resolves binary specifically for Antigravity 2.0 (Desktop app).
 *
 * @returns {string|null}
 */
export function getAgy20Binary() {
  return getAgyBinary(AGY_MODES.ANTIGRAVITY_2_0);
}

/**
 * Resolves binary specifically for Antigravity VS Code Extension.
 *
 * @returns {string|null}
 */
export function getAgyVSCodeBinary() {
  return getAgyBinary(AGY_MODES.ANTIGRAVITY_VSCODE);
}

/**
 * Resolves binary specifically for Antigravity standalone CLI.
 *
 * @returns {string|null}
 */
export function getAgyCliBinary() {
  return getAgyBinary(AGY_MODES.ANTIGRAVITY_CLI);
}

/**
 * Resolves the active Antigravity execution target with mode metadata.
 * Order of preference: Antigravity 2.0 > Antigravity VS Code Extension > Antigravity CLI.
 *
 * @param {string|null} [preferredMode=null]
 * @returns {{ mode: string, name: string, bin: string, dataDir: string } | null}
 */
export function resolveAgyTarget(preferredMode = null) {
  const modes = [
    { mode: AGY_MODES.ANTIGRAVITY_2_0, name: AGY_MODE_LABELS[AGY_MODES.ANTIGRAVITY_2_0], fn: getAgy20Binary },
    { mode: AGY_MODES.ANTIGRAVITY_VSCODE, name: AGY_MODE_LABELS[AGY_MODES.ANTIGRAVITY_VSCODE], fn: getAgyVSCodeBinary },
    { mode: AGY_MODES.ANTIGRAVITY_CLI, name: AGY_MODE_LABELS[AGY_MODES.ANTIGRAVITY_CLI], fn: getAgyCliBinary },
  ];

  const ordered = preferredMode
    ? modes.filter((m) => m.mode === preferredMode.toLowerCase())
    : modes;

  for (const candidate of ordered) {
    const bin = candidate.fn();
    if (bin) {
      return {
        mode: candidate.mode,
        name: candidate.name,
        bin,
        dataDir: AGY_MODE_DATA_DIRS[candidate.mode],
      };
    }
  }
  return null;
}

/**
 * Tests whether an Antigravity binary is reachable without requiring tokens or subscriptions.
 *
 * @param {string} binPath - Path to binary
 * @param {string} [mode=AGY_MODES.ANTIGRAVITY_2_0] - Mode to test
 * @returns {{ reachable: boolean, error: string|null }}
 */
export function testAgyBinaryReachability(binPath, mode = AGY_MODES.ANTIGRAVITY_2_0) {
  if (!binPath || typeof binPath !== 'string') {
    return { reachable: false, error: 'Binary path not provided' };
  }
  if (!fs.existsSync(binPath)) {
    return { reachable: false, error: 'Binary file does not exist' };
  }

  const dataDir = AGY_MODE_DATA_DIRS[mode] || 'antigravity';
  try {
    const res = spawnCliSync(binPath, ['--help'], {
      encoding: 'utf8',
      timeout: 3000,
      env: {
        ...getSanitizedEnv(),
        JETSKI_APP_DATA_DIR: dataDir,
      },
    });
    if (res.status === 0) {
      return { reachable: true, error: null };
    }
    return { reachable: false, error: `Process exited with code ${res.status}: ${res.stderr || ''}` };
  } catch (err) {
    return { reachable: false, error: err.message };
  }
}

/**
 * Probes all Antigravity modes in order of preference and returns diagnostic state.
 * Tests up to reachability without consuming tokens or requiring subscriptions.
 *
 * @returns {Promise<Array<{ mode: string, name: string, present: boolean, bin: string|null, reachable: boolean, error: string|null }>>}
 */
export async function probeAllAgyModes() {
  const results = [];
  for (const mode of AGY_MODE_PREFERENCE) {
    const name = AGY_MODE_LABELS[mode];
    const present = detectAgyModePresence(mode);
    const bin = getAgyBinary(mode);
    let reachable = false;
    let error = null;

    if (bin) {
      const reachability = testAgyBinaryReachability(bin, mode);
      reachable = reachability.reachable;
      error = reachability.error;
    } else {
      error = 'Binary not found';
    }

    results.push({
      mode,
      name,
      present,
      bin,
      reachable,
      error,
    });
  }
  return results;
}

// SECTION: Mode Presence Detection

/**
 * Checks if the host OS has files, directories, or processes for the given mode.
 *
 * @param {string} mode - One of 'antigravity-2.0', 'antigravity-vscode', 'antigravity-cli'
 * @returns {boolean}
 */
export function detectAgyModePresence(mode) {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';
  const homeDir = os.homedir();

  // ============================================================================
  // BRANCH: Antigravity 2.0 (Desktop App) Presence
  // ============================================================================
  if (mode === AGY_MODES.ANTIGRAVITY_2_0) {
    // OS: macOS | MODE: Antigravity 2.0
    if (isMac) {
      if (
        fs.existsSync('/Applications/Antigravity.app') ||
        fs.existsSync(path.join(homeDir, 'Applications/Antigravity.app')) ||
        fs.existsSync(path.join(homeDir, 'Library/Application Support/Antigravity')) ||
        fs.existsSync(path.join(homeDir, '.gemini', 'antigravity'))
      ) {
        return true;
      }
    }

    // OS: Windows | MODE: Antigravity 2.0
    if (isWin) {
      const winCandidates = [
        path.join(homeDir, '.gemini', 'antigravity'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Antigravity'),
        process.env.APPDATA && path.join(process.env.APPDATA, 'Antigravity'),
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Antigravity'),
        process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Antigravity'),
      ].filter(Boolean);

      if (winCandidates.some((p) => fs.existsSync(p))) {
        return true;
      }
    }

    // OS: Linux | MODE: Antigravity 2.0
    if (isLinux) {
      const linuxCandidates = [
        path.join(homeDir, '.gemini', 'antigravity'),
        path.join(homeDir, '.config', 'Antigravity'),
        '/opt/Antigravity',
        '/usr/share/antigravity',
      ];
      if (linuxCandidates.some((p) => fs.existsSync(p))) {
        return true;
      }
    }

    // Active session environment markers
    if (
      process.env.ANTIGRAVITY_AGENT ||
      process.env.__CFBundleIdentifier === 'com.google.antigravity' ||
      process.env.ANTIGRAVITY_AGENTAPI_EXE
    ) {
      return true;
    }
  }

  // ============================================================================
  // BRANCH: Antigravity VS Code Extension Presence
  // ============================================================================
  if (mode === AGY_MODES.ANTIGRAVITY_VSCODE) {
    // OS: macOS | MODE: Antigravity VS Code Extension
    if (isMac) {
      const macCandidates = [
        path.join(homeDir, '.gemini', 'antigravity-ide'),
        path.join(homeDir, 'Library/Application Support/Antigravity IDE'),
        '/Applications/Antigravity IDE.app',
        path.join(homeDir, 'Applications/Antigravity IDE.app'),
        path.join(homeDir, 'Library/Application Support/Code/User/globalStorage/google.google-antigravity'),
      ];
      if (macCandidates.some((p) => fs.existsSync(p))) {
        return true;
      }

      const extDirs = [
        path.join(homeDir, '.vscode', 'extensions'),
        path.join(homeDir, '.vscode-insiders', 'extensions'),
        path.join(homeDir, 'Library/Application Support/Code/CachedExtensionVSIXs'),
      ];
      for (const dir of extDirs) {
        if (fs.existsSync(dir)) {
          try {
            const files = fs.readdirSync(dir);
            if (files.some((f) => f.includes('antigravity'))) return true;
          } catch {}
        }
      }
    }

    // OS: Windows | MODE: Antigravity VS Code Extension
    if (isWin) {
      const winCandidates = [
        path.join(homeDir, '.gemini', 'antigravity-ide'),
        process.env.APPDATA && path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'google.google-antigravity'),
        process.env.APPDATA && path.join(process.env.APPDATA, 'Antigravity IDE'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity IDE'),
      ].filter(Boolean);

      if (winCandidates.some((p) => fs.existsSync(p))) {
        return true;
      }

      const extDirs = [
        path.join(homeDir, '.vscode', 'extensions'),
        path.join(homeDir, '.vscode-insiders', 'extensions'),
      ];
      for (const dir of extDirs) {
        if (fs.existsSync(dir)) {
          try {
            const files = fs.readdirSync(dir);
            if (files.some((f) => f.includes('antigravity'))) return true;
          } catch {}
        }
      }
    }

    // OS: Linux | MODE: Antigravity VS Code Extension
    if (isLinux) {
      const linuxCandidates = [
        path.join(homeDir, '.gemini', 'antigravity-ide'),
        path.join(homeDir, '.config', 'Code', 'User', 'globalStorage', 'google.google-antigravity'),
        path.join(homeDir, '.config', 'Antigravity IDE'),
        '/opt/Antigravity IDE',
      ];
      if (linuxCandidates.some((p) => fs.existsSync(p))) {
        return true;
      }

      const extDirs = [
        path.join(homeDir, '.vscode', 'extensions'),
        path.join(homeDir, '.vscode-insiders', 'extensions'),
        path.join(homeDir, '.vscode-server', 'extensions'),
      ];
      for (const dir of extDirs) {
        if (fs.existsSync(dir)) {
          try {
            const files = fs.readdirSync(dir);
            if (files.some((f) => f.includes('antigravity'))) return true;
          } catch {}
        }
      }
    }

    if (process.env.JETSKI_APP_DATA_DIR === 'antigravity-ide') {
      return true;
    }
  }

  // ============================================================================
  // BRANCH: Antigravity CLI Presence
  // ============================================================================
  // OS: Cross-platform (macOS / Windows / Linux) | MODE: Antigravity CLI
  if (mode === AGY_MODES.ANTIGRAVITY_CLI) {
    if (fs.existsSync(path.join(homeDir, '.gemini', 'antigravity-cli'))) {
      return true;
    }
    if (getAgyBinary(AGY_MODES.ANTIGRAVITY_CLI)) {
      return true;
    }
  }

  return false;
}

// SECTION: Reachability Testing (Non-Token-Consuming)

/**
 * Tests whether Antigravity can be reached via a specific mode.
 *
 * NOTE: Not all modes are subscribed or have tokens; in those cases,
 * this tests up to being able to reach it via that mode (i.e. verifying
 * binary availability, mode detection, and executing '--help' with the
 * mode's profile) without requiring tokens or active subscriptions.
 *
 * @param {string} mode - One of 'antigravity-2.0', 'antigravity-vscode', 'antigravity-cli'
 * @returns {Promise<boolean>}
 */
export async function isAgyModeAvailable(mode) {
  // 1. Verify presence of mode indicators on the host OS
  if (!detectAgyModePresence(mode)) {
    return false;
  }

  // 2. Locate executable binary
  const bin = getAgyBinary(mode);
  if (!bin) return false;

  const dataDir = AGY_MODE_DATA_DIRS[mode] || 'antigravity';

  // 3. Test up to reachability without consuming tokens or subscription
  try {
    const res = spawnCliSync(bin, ['--help'], {
      encoding: 'utf8',
      timeout: 3000,
      env: {
        ...getSanitizedEnv(),
        JETSKI_APP_DATA_DIR: dataDir,
      },
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Returns an ordered array of reachable Antigravity modes in order of preference:
 * 1. Antigravity 2.0
 * 2. Antigravity VS Code Extension
 * 3. Antigravity CLI
 *
 * @returns {Promise<string[]>}
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

  // Fallback check on standard binary
  try {
    const res = spawnCliSync(bin, ['--help'], { encoding: 'utf8', timeout: 3000 });
    return res.status === 0;
  } catch {
    return false;
  }
}

// SECTION: Brain Conversation Trajectory Tracking

/**
 * Finds the newest conversation ID in the Antigravity brain directory for a given mode.
 * Supports cross-platform path resolution across macOS, Windows, and Linux.
 *
 * @param {number} [beforeTimestamp=0] - Only consider conversations modified after this timestamp
 * @param {string|null} [mode=null] - Optional mode to narrow search
 * @returns {string|null} Newest conversation ID or null
 */
export function getNewestBrainConversationId(beforeTimestamp = 0, mode = null) {
  const homeDir = os.homedir();
  const isWin = process.platform === 'win32';

  const candidateDirs = [];

  // Prioritize directory for specified mode
  if (mode && AGY_MODE_DATA_DIRS[mode]) {
    const dirName = AGY_MODE_DATA_DIRS[mode];
    // OS: macOS / Linux | POSIX directory
    candidateDirs.push(path.join(homeDir, '.gemini', dirName, 'brain'));
    // OS: Windows | AppData directories
    if (isWin) {
      if (process.env.APPDATA) {
        candidateDirs.push(path.join(process.env.APPDATA, dirName, 'brain'));
      }
      if (process.env.LOCALAPPDATA) {
        candidateDirs.push(path.join(process.env.LOCALAPPDATA, dirName, 'brain'));
      }
    }
  }

  // Fallback to searching all mode data directories in preference order
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

  let newestId = null;
  let maxMtime = beforeTimestamp;

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

// SECTION: Prompt Execution and Mode Cascading

/**
 * Checks if output indicates a token exhaustion, missing subscription, or unauthenticated state.
 *
 * @param {string} text - Combined stderr and stdout output
 * @returns {boolean}
 */
function isSubscriptionOrTokenIssue(text) {
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
 * Executes a single prompt in a specific Antigravity mode.
 */
async function executeAgyInMode(mode, options) {
  const {
    model = DEFAULT_AGY_MODEL,
    effort = DEFAULT_AGY_EFFORT,
    timeout = DEFAULT_TIMEOUT_SECONDS,
    maxBufferMb = 10,
    verbose = false,
    sessionLogger,
    initialGitStatus,
    formattedPrompt,
  } = options;

  const bin = getAgyBinary(mode);
  if (!bin) {
    const err = new Error(
      `Google Antigravity binary was not found for mode '${mode}'.\n` +
        'Please ensure agy is installed: https://antigravity.google/docs/cli/reference',
    );
    err.code = 'CLI_NOT_FOUND';
    throw err;
  }

  const startTime = Date.now();
  const effectiveModel = model || DEFAULT_AGY_MODEL;
  const effectiveEffort = effort || DEFAULT_AGY_EFFORT;
  const dataDir = AGY_MODE_DATA_DIRS[mode] || 'antigravity';
  const providerLabel = AGY_MODE_LABELS[mode] || 'Antigravity 2.0 (agy)';

  const modeEnv = {
    ...getSanitizedEnv(),
    JETSKI_APP_DATA_DIR: dataDir,
  };

  // Headless execution (interactive mode removed — delegates are always headless)
  const { prompt: argvPrompt, briefFile } = preparePromptForArgv(formattedPrompt, 'agy');
  const agyArgs = ['--print', argvPrompt, `--print-timeout=${timeout}s`];

  if (effectiveModel) {
    agyArgs.push('--model', effectiveModel);
  }

  if (effectiveEffort) {
    agyArgs.push('--effort', effectiveEffort);
  }

  agyArgs.push('--mode', 'plan');

  emitInitBanner({
    provider: providerLabel,
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

    const child = spawnCli(bin, agyArgs, {
      cwd: PROJECT_ROOT,
      env: modeEnv,
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
      sessionLogger.close();

      const conversationId = getNewestBrainConversationId(startTime, mode);
      const sessionLink = conversationId ? `conversation://${conversationId}` : null;

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
        provider: providerLabel,
        sessionLink,
        exitCode,
        truncated,
      });

      resolve({
        provider: 'agy',
        mode,
        stdout: extractCleanResponse(stdoutBuffer),
        rawStdout: stdoutBuffer,
        stderr: stderrBuffer,
        exitCode,
        logFile: sessionLogger.logFile,
        briefFile,
        conversationId,
        sessionLink,
        truncated,
        failureKind: classifyFailure(`${stderrBuffer}\n${stdoutBuffer}`) || truncated,
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
}

/**
 * Runs a prompt through Antigravity following the preference order:
 * Antigravity 2.0 > Antigravity VS Code Extension > Antigravity CLI.
 *
 * If a mode is reachable but encounters token or subscription exhaustion,
 * execution cascades to the next available mode.
 *
 * @param {Object} [options={}]
 * @returns {Promise<Object>}
 */
export async function runAgy(options = {}) {
  const {
    prompt,
    files = [],
    model = DEFAULT_AGY_MODEL,
    effort = DEFAULT_AGY_EFFORT,
    timeout = DEFAULT_TIMEOUT_SECONDS,
    maxBufferMb = 10,
    verbose = false,
    modeVariant = null,
    agyMode = null,
  } = options;

  const bin = getAgyBinary();
  if (!bin) {
    const err = new Error(
      'Google Antigravity CLI (agy) was not found in PATH or ~/.gemini/bin/agy.\n' +
        'Please ensure agy is installed: https://antigravity.google/docs/cli/reference',
    );
    err.code = 'CLI_NOT_FOUND';
    throw err;
  }

  const requestedMode = modeVariant || agyMode || null;

  // Resolve candidate modes
  let modesToTry;
  if (requestedMode && requestedMode !== 'auto') {
    modesToTry = [requestedMode];
  } else {
    // Preferred cascade: Antigravity 2.0 > VS Code Extension > CLI
    const available = await getAvailableAgyModes();
    modesToTry = available.length > 0 ? available : [...AGY_MODE_PREFERENCE];
  }

  const attachments = buildAttachmentBlock(files);
  for (const note of attachments.notes) {
    process.stderr.write(`[dispatch] Attachment ${note}\n`);
  }

  const fullPrompt = attachments.text ? `${attachments.text}\n\n${prompt}` : prompt;
  const formattedPrompt = formatSafetyPrompt(fullPrompt, {
    workspaceRoot: PROJECT_ROOT,
    attachedFiles: files,
  });
  const initialGitStatus = getGitStatus();

  let lastResult = null;
  let lastError = null;

  for (let i = 0; i < modesToTry.length; i++) {
    const currentMode = modesToTry[i];
    const sessionLogger = createSessionLogger('agy');

    try {
      const result = await executeAgyInMode(currentMode, {
        prompt,
        model,
        effort,
        timeout,
        maxBufferMb,
        verbose,
        sessionLogger,
        initialGitStatus,
        formattedPrompt,
      });

      lastResult = result;

      // Check if this run succeeded
      const hasOutput = typeof result.stdout === 'string' && result.stdout.trim().length > 0;
      const combinedOutput = `${result.stderr}\n${result.stdout}`;
      const isTokenIssue =
        result.failureKind === 'quota' ||
        result.failureKind === 'auth' ||
        isSubscriptionOrTokenIssue(combinedOutput);

      if (result.exitCode === 0 && hasOutput) {
        return result;
      }

      // If execution reached the mode but encountered token/subscription issues,
      // cascade to the next available mode if one remains.
      const hasNextMode = i < modesToTry.length - 1 && !requestedMode;
      if (isTokenIssue && hasNextMode) {
        process.stderr.write(
          `[dispatch] Antigravity mode '${currentMode}' reached but lacked tokens/subscription (${result.failureKind || 'quota/auth'}).\n` +
            `[dispatch] Cascading to next preferred mode '${modesToTry[i + 1]}'...\n`,
        );
        continue;
      }

      // If workspace integrity was violated in read-only mode, stop cascading immediately
      if (result.gitIntegrityViolation) {
        return result;
      }

      // If not a token issue, or no further modes remain, return the captured result
      return result;
    } catch (err) {
      lastError = err;
      const hasNextMode = i < modesToTry.length - 1 && !requestedMode;
      if (hasNextMode) {
        process.stderr.write(
          `[dispatch] Antigravity mode '${currentMode}' failed execution: ${err.message}.\n` +
            `[dispatch] Cascading to next preferred mode '${modesToTry[i + 1]}'...\n`,
        );
        continue;
      }
      throw err;
    }
  }

  if (lastResult) return lastResult;
  if (lastError) throw lastError;

  const err = new Error('No Antigravity mode was able to execute the request.');
  err.code = 1;
  throw err;
}

// SECTION: CLI Entrypoint

/**
 * Parses arguments with additional agy mode flags.
 */
function parseAgyArgs(argv) {
  const common = parseCommonArgs(argv);
  const extra = {
    modeVariant: null,
    testReachability: false,
  };

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--agy-mode' || arg === '--mode-variant') {
      extra.modeVariant = args[++i] || null;
    } else if (arg.startsWith('--agy-mode=')) {
      extra.modeVariant = arg.slice('--agy-mode='.length);
    } else if (arg.startsWith('--mode-variant=')) {
      extra.modeVariant = arg.slice('--mode-variant='.length);
    } else if (arg === '--test-reachability' || arg === '--test-modes') {
      extra.testReachability = true;
    }
  }

  return { ...common, ...extra };
}

export async function main() {
  const options = parseAgyArgs(process.argv);

  if (options.help) {
    console.log(`
Google Antigravity Runner (agy)

Preference Order:
  1. Antigravity 2.0 (Desktop)
  2. Antigravity VS Code Extension
  3. Antigravity CLI

Usage:
  node scripts/agy-run.mjs [options] [prompt]

Options:
  -p, --prompt <string>         The prompt message to send
  -f, --file, --artifact        Attach context file or artifact (repeatable)
  -m, --model <name>            Override Antigravity model (default: ${DEFAULT_AGY_MODEL})
  -e, --effort <level>          Override reasoning effort (default: ${DEFAULT_AGY_EFFORT})
  -t, --timeout <seconds>       Override timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})
  --agy-mode, --mode-variant    Force mode: antigravity-2.0 | antigravity-vscode | antigravity-cli | auto
  --test-reachability           Test and report reachability for all modes without consuming tokens
  -v, --verbose                 Stream live trace to stderr (terminal only; ignored when piped)
  -h, --help                    Show this help
`);
    process.exit(0);
  }

  // Reachability test mode: tests up to reaching each mode without consuming tokens
  if (options.testReachability) {
    console.log('[dispatch] Testing Antigravity Mode Reachability (non-token-consuming):');
    for (const mode of AGY_MODE_PREFERENCE) {
      const label = AGY_MODE_LABELS[mode];
      const present = detectAgyModePresence(mode);
      const binary = getAgyBinary(mode);
      const reachable = await isAgyModeAvailable(mode);
      console.log(`\nMode: ${label} [${mode}]`);
      console.log(`  OS Presence: ${present ? 'DETECTED' : 'NOT DETECTED'}`);
      console.log(`  Executable:  ${binary || 'NOT FOUND'}`);
      console.log(`  Reachability:${reachable ? ' REACHABLE (tested via non-token probe)' : ' UNREACHABLE'}`);
    }
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
    const res = await runAgy({ ...options, prompt: finalPrompt });
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
  path.resolve(process.argv[1]) === path.resolve(currentFilePath)
) {
  main().catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}
