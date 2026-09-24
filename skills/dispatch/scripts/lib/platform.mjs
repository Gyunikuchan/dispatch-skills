/**
 * @file platform.mjs
 * @description Cross-platform process, path, and executable primitives: CLI spawning and batch escaping,
 * workspace/boundary paths, binary discovery, JSONC parsing, config loading, and main-module detection.
 *
 * Supports Windows, macOS, Linux (bash, zsh, PowerShell).
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================================
// SECTION: Configurable Constants
// ============================================================================

/**
 * @typedef {object} CommonArgs
 * @property {string} prompt
 * @property {string[]} files
 * @property {string|null} model
 * @property {string|null} effort
 * @property {string|null} agent
 * @property {number} timeout
 * @property {number} maxBufferMb
 * @property {boolean} json
 * @property {boolean} verbose
 * @property {string|null} orchestrator
 * @property {string|null} orchestratorModel
 * @property {string|null} provider
 * @property {boolean} help
 * @property {string|null} promptFile
 */

/**
 * @typedef {object} AttachmentResult
 * @property {string} path
 * @property {string} content
 * @property {boolean} truncated
 * @property {number} bytes
 */

/**
 * @typedef {object} AttachmentBlockResult
 * @property {string} text
 * @property {string[]} notes
 * @property {number} usedBytes
 */

/**
 * @typedef {object} BriefFileResult
 * @property {string} briefFile
 * @property {string} pointerPrompt
 */

/**
 * @typedef {object} PreparedPromptResult
 * @property {string} prompt
 * @property {string|null} briefFile
 */

/**
 * @typedef {object} SessionLogger
 * @property {string} logFile
 * @property {(chunk: string) => void} write
 * @property {() => void} close
 */

/**
 * @typedef {object} SkillIntegrityResult
 * @property {boolean} valid
 * @property {string[]} violations
 * @property {boolean} [missing]
 */

/**
 * @typedef {object} CliInvocation
 * @property {string} command
 * @property {string[]} args
 * @property {object} options
 */

/**
 * Resolves the workspace a dispatch acts on.
 *
 * This is the delegate's cwd and sandbox bind boundary, so it must track the
 * caller's repository rather than this file's own location — the runner ships
 * as a portable skill and cannot assume a fixed depth beneath the workspace.
 */
function resolveWorkspaceRoot() {
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 5000,
  });
  if (res.status === 0 && res.stdout.trim()) {
    return path.resolve(res.stdout.trim());
  }
  // Outside a repository the caller's cwd is the only boundary on offer.
  return process.cwd();
}

export const PROJECT_ROOT = resolveWorkspaceRoot();

/** Whether Linux Bubblewrap (OpenCode's sandbox mechanism) is installed; always false off Linux. */
export function detectBwrap() {
  if (process.platform !== 'linux') return false;
  const check = spawnSync('which', ['bwrap'], { encoding: 'utf8' });
  return check.status === 0 && Boolean(check.stdout.trim());
}

// ============================================================================
// SECTION: Subprocess Spawning & Batch Escaping
// ============================================================================

// The double quote is itself escaped: cmd.exe ignores ^ inside a quoted span,
// so quoting an argument literally would neuter every other escape in it.
const CMD_META_CHARS = /([()\]!^"`<>&|;, *?])/g;

/**
 * Escapes the launcher path for cmd.exe. Left unquoted — an escaped separator
 * already keeps a path with spaces intact as a single token.
 */
function escapeCmdCommand(command) {
  return String(command).replace(CMD_META_CHARS, '^$1');
}

/**
 * Escapes one argument so cmd.exe hands it to the target verbatim.
 *
 * Algorithm from https://qntm.org/cmd — quote for CommandLineToArgvW first,
 * then ^-escape every cmd.exe metacharacter including those quotes. A .bat
 * re-parses its own arguments, so escapes inside one must survive twice.
 *
 * NOTE: `%VAR%` still expands — cmd.exe has no ^ escape for `%`, so a prompt
 * naming an environment variable reaches a batch launcher with it substituted.
 * Corrupts the text, cannot execute anything; same limitation as cross-spawn.
 */
function escapeCmdArgument(argument, doubleEscapeMetaChars) {
  let escaped = String(argument)
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, '$1$1');
  escaped = `"${escaped}"`.replace(CMD_META_CHARS, '^$1');
  return doubleEscapeMetaChars ? escaped.replace(CMD_META_CHARS, '^$1') : escaped;
}

/**
 * True for a Windows `.bat`/`.cmd` launcher, whose arguments cmd.exe re-parses.
 * @param {string|null|undefined} binary
 */
export function isBatchLauncher(binary) {
  return process.platform === 'win32' && typeof binary === 'string' && /\.(?:bat|cmd)$/i.test(binary);
}

/**
 * Builds the concrete spawn invocation for a delegate CLI.
 *
 * Node refuses to execute a Windows `.cmd`/`.bat` launcher without a shell
 * (EINVAL since the CVE-2024-27980 fix), and `shell: true` concatenates
 * arguments unescaped — an injection vector once a delegate prompt carries
 * quotes or `&`. So batch launchers are routed through cmd.exe with arguments
 * escaped here and `windowsVerbatimArguments` suppressing Node's re-quoting.
 */
export function resolveCliInvocation(binary, args, options) {
  if (!isBatchLauncher(binary)) {
    return { command: binary, args, options: { ...options, shell: false } };
  }

  // NOTE: cmd.exe ends the command at a raw newline, silently dropping the rest of that
  // argument and every argument after it — callers must spill multi-line text to a brief file.
  if (args.some((arg) => /[\r\n]/.test(String(arg)))) {
    throw new Error('batch launcher argument contains a newline; spill it to a brief file');
  }

  const commandLine = [
    escapeCmdCommand(binary),
    ...args.map((arg) => escapeCmdArgument(arg, true)),
  ].join(' ');

  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    options: { ...options, shell: false, windowsVerbatimArguments: true },
  };
}

/**
 * Spawns a delegate CLI, tolerating Windows `.cmd`/`.bat` launchers.
 */
export function spawnCli(binary, args = [], options = {}) {
  const invocation = resolveCliInvocation(binary, args, options);
  return spawn(invocation.command, invocation.args, {
    // Own process group on POSIX so a timeout can terminate the delegate's whole tree
    // (see terminateProcessTree). Windows gets the same reach from `taskkill /T`.
    detached: process.platform !== 'win32',
    ...invocation.options,
  });
}

/**
 * Synchronous counterpart of `spawnCli`, used by provider availability probes.
 */
export function spawnCliSync(binary, args = [], options = {}) {
  const invocation = resolveCliInvocation(binary, args, options);
  return spawnSync(invocation.command, invocation.args, invocation.options);
}

/**
 * Cross-platform process tree termination.
 */
export function terminateProcessTree(child) {
  if (!child || !child.pid) return;

  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
    } catch {}
  } else {
    // Signal the whole process group, not just the direct child: every runner spawns a launcher
    // that forks the real CLI, and `child.kill` leaves those grandchildren running — burning tokens
    // long after the timeout fired. `spawnCli` starts POSIX children detached (their own group), so
    // the negative pid reaches the launcher and its descendants alike.
    const signalGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch {
        // ESRCH: the group is already gone, or this child was not spawned detached (Node exposes no
        // readable `detached` flag, so the attempt is the test). EPERM: not ours to signal.
        return false;
      }
    };

    try {
      if (!signalGroup('SIGTERM')) child.kill('SIGTERM');
      setTimeout(() => {
        try {
          if (!signalGroup('SIGKILL')) child.kill('SIGKILL');
        } catch {}
      }, 1000).unref();
    } catch {}
  }
}

// ============================================================================
// SECTION: Skill Hash Validation
// ============================================================================

/**
 * Renames `src` over `dest` atomically where the platform allows.
 * NOTE: Windows rejects renaming onto an existing file with EPERM, so the destination is removed first there.
 */
export function safeRenameSync(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err?.code === 'EPERM' && process.platform === 'win32') {
      fs.rmSync(dest, { force: true });
      fs.renameSync(src, dest);
    } else {
      throw err;
    }
  }
}

// ============================================================================
// SECTION: Path & Executable Discovery
// ============================================================================

/**
 * Expands a leading `~` (followed by end-of-string, `/`, or `\`) to the user's home
 * directory; every other path passes through unchanged. Shared by the candidate-file
 * and binary lookups below.
 */
function expandHomePath(candidate) {
  return candidate.replace(/^~(?=$|\/|\\)/, os.homedir());
}

/**
 * Normalizes filesystem path for cross-platform comparison.
 */
export function normalizePath(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Verifies if targetPath is inside rootDirectory safely across platforms.
 */
export function isPathInside(targetPath, rootDirectory) {
  const normTarget = normalizePath(targetPath);
  const normRoot = normalizePath(rootDirectory);
  if (normTarget === normRoot) return true;
  const rel = path.relative(normRoot, normTarget);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Returns allowed boundary root directories for `-f` attachments and context files:
 * - Project workspace
 * - Antigravity brain / artifacts (~/.gemini/antigravity and %APPDATA%/%LOCALAPPDATA%/antigravity)
 * - Agent configurations (~/.agents, ~/.claude)
 * - OS temp directory (covers orchestrator-relocated artifacts, e.g. a walkthrough moved to
 *   `os.tmpdir()` by an orchestrator's scratch-fallback cleanup, and delegate brief files)
 */
export function getAllowedBoundaryRoots() {
  const homeDir = os.homedir();
  const roots = [
    PROJECT_ROOT,
    path.join(homeDir, '.gemini', 'antigravity'),
    path.join(homeDir, '.agents'),
    path.join(homeDir, '.claude'),
    os.tmpdir(),
  ];

  if (process.env.APPDATA) {
    roots.push(path.join(process.env.APPDATA, 'antigravity'));
  }
  if (process.env.LOCALAPPDATA) {
    roots.push(path.join(process.env.LOCALAPPDATA, 'antigravity'));
  }

  return roots;
}

/**
 * Locates an executable binary across platforms. Precedence: a PATH lookup (`where.exe` on
 * Windows, `which` elsewhere) for each name in `binName` order — first existing match wins —
 * then `extraCandidates` in order. `binName` accepts a single name or an ordered array (e.g.
 * `['claude.cmd', 'claude.exe']` to prefer the batch launcher's nested-exe logic without missing
 * a PATH-only `claude.exe` install).
 *
 * Pass `{ pathFirst: false }` to invert that precedence for a mode-specific lookup: a mode that names
 * its own install location (a VS Code extension's bundled CLI, say) must resolve to *that* binary,
 * not to whichever build happens to be on PATH — otherwise every mode collapses onto one executable
 * and the mode cascade retries the same thing repeatedly.
 *
 * @param {string|string[]} binName
 * @param {string[]} [extraCandidates]
 * @param {{ pathFirst?: boolean }} [options]
 */
export function findBinary(binName, extraCandidates = [], { pathFirst = true } = {}) {
  const names = Array.isArray(binName) ? binName : [binName];
  const lookupCmd = process.platform === 'win32' ? 'where.exe' : 'which';

  const fromPath = () => {
    // Check system PATH, one name at a time, in order.
    for (const name of names) {
      try {
        const res = spawnSync(lookupCmd, [name], { encoding: 'utf8' });
        if (res.status === 0 && res.stdout.trim()) {
          const firstMatch = res.stdout.trim().split(/\r?\n/)[0];
          if (firstMatch && fs.existsSync(firstMatch)) {
            return firstMatch;
          }
        }
      } catch {}
    }
    return null;
  };

  const fromCandidates = () => {
    const expandedCandidates = extraCandidates.map(expandHomePath);

    for (const candidate of expandedCandidates) {
      if (fs.existsSync(candidate)) {
        try {
          const stat = fs.statSync(candidate);
          if (stat.isFile()) {
            return candidate;
          }
        } catch {}
      }
    }
    return null;
  };

  return pathFirst ? (fromPath() ?? fromCandidates()) : (fromCandidates() ?? fromPath());
}

/**
 * Drops targets whose binary another, higher-preference target already resolved to.
 *
 * Mode cascades exist to survive one broken install, but several modes routinely discover the *same*
 * executable (a PATH lookup answering for "desktop" and "cli" alike). Retrying such a mode re-runs an
 * identical command and fails identically — pure latency. First occurrence wins, preserving
 * preference order.
 *
 * @template T
 * @param {T[]} targets
 * @param {(target: T) => string|null|undefined} binaryOf
 * @returns {T[]}
 */
export function dedupeTargetsByBinary(targets, binaryOf) {
  const seen = new Set();
  return targets.filter((target) => {
    const bin = binaryOf(target);
    if (!bin) return true;
    const key = normalizePath(bin);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Scans a directory for subdirectories, sorted in descending order (newest version first).
 * Used across macOS, Windows, and Linux for version-stamped application caches.
 *
 * @param {string} baseDir
 * @returns {string[]}
 */
export function scanVersionDirs(baseDir) {
  if (!fs.existsSync(baseDir)) return [];
  try {
    return fs
      .readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
  } catch {
    return [];
  }
}

/**
 * Checks whether a given path points to an existing file that can be executed.
 *
 * @param {string} targetPath File path to inspect
 * @returns {boolean}
 */
export function isExecutableFile(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  try {
    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) return false;

    // [OS: macOS / Linux] Check executable bit
    if (process.platform !== 'win32') {
      try {
        fs.accessSync(targetPath, fs.constants.X_OK);
        return true;
      } catch {
        // Fallback for sandboxes or network shares where accessSync(X_OK) errs
        return (stat.mode & 0o111) !== 0;
      }
    }

    // [OS: Windows] Regular file presence is sufficient
    return true;
  } catch {
    return false;
  }
}

/**
 * Probes a list of candidate file paths, expanding leading `~` to the user's home directory.
 * Returns the first candidate that exists on disk and is a regular file.
 *
 * @param {string[]} candidates
 * @returns {string|null}
 */
export function findFirstExistingFile(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const expanded = expandHomePath(candidate);
    try {
      if (fs.existsSync(expanded) && fs.statSync(expanded).isFile()) {
        return path.resolve(expanded);
      }
    } catch {}
  }
  return null;
}

/**
 * Returns true if any of the given paths exists. Falsy entries are skipped.
 *
 * @param {...(string|null|undefined)} paths
 * @returns {boolean}
 */
export function existsAny(...paths) {
  return paths.filter(Boolean).some((p) => fs.existsSync(p));
}

// ============================================================================
// SECTION: Utilities & CLI Lifecycle
// ============================================================================

/**
 * Strips single-line and multi-line comments and trailing commas from JSON/JSONC
 * strings while preserving URLs and string literals (leniently supports both " and ').
 *
 * @param {string} jsonString
 * @returns {string}
 */
export function stripJsonComments(jsonString) {
  if (!jsonString || typeof jsonString !== 'string') return '';

  let insideString = false;
  let stringChar = '';
  let isEscaped = false;
  let insideSingleComment = false;
  let insideMultiComment = false;
  let result = '';

  for (let i = 0; i < jsonString.length; i++) {
    const char = jsonString[i];
    const nextChar = jsonString[i + 1];

    if (insideSingleComment) {
      if (char === '\n' || char === '\r') {
        insideSingleComment = false;
        result += char;
      }
      continue;
    }

    if (insideMultiComment) {
      if (char === '*' && nextChar === '/') {
        insideMultiComment = false;
        i++; // skip /
      }
      continue;
    }

    if (insideString) {
      result += char;
      if (isEscaped) {
        isEscaped = false;
      } else if (char === '\\') {
        isEscaped = true;
      } else if (char === stringChar) {
        insideString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      insideString = true;
      stringChar = char;
      isEscaped = false;
      result += char;
    } else if (char === '/' && nextChar === '/') {
      insideSingleComment = true;
      i++; // skip next slash
    } else if (char === '/' && nextChar === '*') {
      insideMultiComment = true;
      i++; // skip next star
    } else if (char === ',') {
      // Check if this comma is trailing (followed only by whitespace or comments before } or ])
      let j = i + 1;
      let isTrailing = false;
      while (j < jsonString.length) {
        const c = jsonString[j];
        if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
          j++;
        } else if (c === '/' && jsonString[j + 1] === '/') {
          j += 2;
          while (j < jsonString.length && jsonString[j] !== '\n' && jsonString[j] !== '\r') j++;
        } else if (c === '/' && jsonString[j + 1] === '*') {
          j += 2;
          while (j < jsonString.length && !(jsonString[j] === '*' && jsonString[j + 1] === '/')) j++;
          j += 2;
        } else if (c === '}' || c === ']') {
          isTrailing = true;
          break;
        } else {
          break;
        }
      }
      if (!isTrailing) {
        result += char;
      }
    } else {
      result += char;
    }
  }

  if (insideMultiComment) {
    throw new SyntaxError('Unterminated block comment in JSONC');
  }

  return result;
}

/**
 * Parses JSONC (JSON with comments and trailing commas) text into a JavaScript value.
 *
 * @param {string} text
 * @returns {any}
 */
export function parseJsonc(text) {
  return JSON.parse(stripJsonComments(text));
}

// ============================================================================
// SECTION: Skill Config Loading
// ============================================================================

/**
 * Builds the 2-path config precedence list:
 * skill-root override (local, then shared).
 *
 * @param {object|string} params
 * @param {string} [params.skillRoot]
 * @returns {string[]}
 */
export function getConfigCandidates(params) {
  const skillRoot = typeof params === 'string' ? params : params?.skillRoot;
  return [
    path.join(skillRoot, 'config.local.jsonc'),
    path.join(skillRoot, 'config.jsonc'),
  ];
}

/**
 * Loads a skill config wholly from the first candidate that exists (no merging across
 * tiers), in the precedence order from {@link getConfigCandidates}.
 *
 * @param {object} params
 * @param {string} params.skillRoot
 * @returns {{ config: object, path: string }}
 */
export function loadSkillConfig({ skillRoot } = {}) {
  const candidates = getConfigCandidates({ skillRoot });
  const configPath = candidates.find((p) => fs.existsSync(p));
  if (!configPath) {
    throw new Error(
      `Config file not found: tried ${candidates.join(', ')}. Create config.local.jsonc or config.jsonc — copy config.sample.jsonc in this skill directory as a starting point.`,
    );
  }
  return { config: parseJsonc(fs.readFileSync(configPath, 'utf8')), path: configPath };
}

/**
 * Determines whether the calling module is the main process entry point.
 * Preserves realpathSync symlink resolution.
 *
 * @param {string} importMetaUrl - `import.meta.url` of the caller module
 * @returns {boolean}
 */
export function isMainModule(importMetaUrl) {
  if (!process.argv[1] || !importMetaUrl) return false;
  try {
    const scriptPath = fileURLToPath(importMetaUrl);
    const a = path.resolve(process.argv[1]);
    const b = path.resolve(scriptPath);
    if (a === b) return true;
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}
