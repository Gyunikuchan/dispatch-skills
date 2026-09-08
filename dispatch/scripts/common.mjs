#!/usr/bin/env node

/**
 * @file common.mjs
 * @description Cross-platform utilities, binary resolution, Git integrity,
 * and context-clean session logging for dispatch runners.
 *
 * Supports Windows, macOS, Linux (bash, zsh, PowerShell).
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Resolves the workspace a dispatch acts on.
 *
 * This is the delegate's cwd, the Git integrity root, and the sandbox bind
 * boundary, so it must track the caller's repository rather than this file's
 * own location — the runner ships as a portable skill and cannot assume a
 * fixed depth beneath the workspace.
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

// 30 minutes, sized for long analysis runs. This exceeds the ~600s ceiling agent harnesses
// impose on a single tool call, so dispatch backgrounded (see the dispatch skill) — a
// foreground run is killed by the harness before this timeout can fire.
export const DEFAULT_TIMEOUT_SECONDS = 1800;
export const DEFAULT_MAX_BUFFER_MB = 10;

// Attachment caps keep `-f` from blowing the delegate's context window; the brief-file
// path below keeps the prompt off argv when it still ends up large.
export const MAX_ATTACHMENT_BYTES_PER_FILE = 128 * 1024;
export const MAX_ATTACHMENT_BYTES_TOTAL = 512 * 1024;

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
 * Locates an executable binary across platforms using:
 * 1. Explicit PATH check via `where.exe` (Windows) or `which` (macOS/Linux)
 * 2. Array of fallback candidate paths
 */
export function findBinary(binName, extraCandidates = []) {
  // Check system PATH
  const lookupCmd = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const res = spawnSync(lookupCmd, [binName], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout.trim()) {
      const firstMatch = res.stdout.trim().split(/\r?\n/)[0];
      if (firstMatch && fs.existsSync(firstMatch)) {
        return firstMatch;
      }
    }
  } catch {}

  // Check custom candidate paths
  const homeDir = os.homedir();
  const expandedCandidates = extraCandidates.map((p) =>
    p.replace(/^~(?=$|\/|\\)/, homeDir),
  );

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
}

// SECTION: Windows batch-launcher spawning

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
 * Builds the concrete spawn invocation for a delegate CLI.
 *
 * Node refuses to execute a Windows `.cmd`/`.bat` launcher without a shell
 * (EINVAL since the CVE-2024-27980 fix), and `shell: true` concatenates
 * arguments unescaped — an injection vector once a delegate prompt carries
 * quotes or `&`. So batch launchers are routed through cmd.exe with arguments
 * escaped here and `windowsVerbatimArguments` suppressing Node's re-quoting.
 */
function resolveCliInvocation(binary, args, options) {
  const isBatchLauncher = process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(binary);
  if (!isBatchLauncher) {
    return { command: binary, args, options: { ...options, shell: false } };
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
  return spawn(invocation.command, invocation.args, invocation.options);
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
    try {
      child.kill('SIGTERM');
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, 1000).unref();
    } catch {}
  }
}

/**
 * Captures Git porcelain status to verify read-only integrity.
 */
export function getGitStatus(cwd = PROJECT_ROOT) {
  try {
    const res = spawnSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
    });
    return res.status === 0 ? res.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Creates a dedicated session log file for this run to avoid context pollution.
 */
export function createSessionLogger(providerName) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logDir = path.join(os.tmpdir(), 'agent-dispatch-logs');
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  } catch {}

  const logFile = path.join(logDir, `${providerName}-${timestamp}-${process.pid}.log`);
  try {
    fs.writeFileSync(logFile, '', { flag: 'a' });
  } catch {}
  const logStream = fs.createWriteStream(logFile, { flags: 'a', encoding: 'utf8' });

  return {
    logFile,
    write(chunk) {
      try {
        logStream.write(chunk);
      } catch {}
    },
    close() {
      try {
        logStream.end();
      } catch {}
    },
  };
}

/**
 * Spawns an external terminal window displaying live log output (tail -f)
 * to allow real-time human observation without polluting orchestrator context.
 *
 * Supported OS platforms:
 * - macOS (darwin): Terminal.app via osascript
 * - Windows (win32): Windows Terminal (wt.exe) or cmd.exe running PowerShell Get-Content -Wait
 * - Linux (linux): x-terminal-emulator, gnome-terminal, konsole, xfce4-terminal, alacritty, kitty, wezterm, xterm
 *
 * @param {string} logFilePath
 * @param {Object} [options]
 * @param {string} [options.title]
 * @returns {boolean} true if a terminal launch was attempted successfully, false otherwise
 */
export function spawnLogTerminal(logFilePath, options = {}) {
  if (!logFilePath) return false;

  const title = options.title || 'Agak Dispatch Live Trace';
  const resolvedPath = path.resolve(logFilePath);

  // In non-interactive CI or explicitly disabled environments, skip auto-opening
  if (
    process.env.CI ||
    process.env.CONTINUOUS_INTEGRATION ||
    process.env.AGAK_DISPATCH_HEADLESS === '1' ||
    process.env.DEBIAN_FRONTEND === 'noninteractive'
  ) {
    return false;
  }

  // macOS (darwin)
  if (process.platform === 'darwin') {
    try {
      // Escape path and title for AppleScript
      const safePath = resolvedPath.replace(/"/g, '\\"');
      const safeTitle = title.replace(/"/g, '\\"');
      const script = `
        tell application "Terminal"
          do script "printf '\\\\033]0;${safeTitle}\\\\007'; tail -n 50 -f \\"${safePath}\\""
          activate
        end tell
      `;
      const child = spawn('osascript', ['-e', script], {
        stdio: 'ignore',
        detached: true,
      });
      child.unref();
      return true;
    } catch {
      return false;
    }
  }

  // Windows (win32)
  if (process.platform === 'win32') {
    try {
      const safePath = resolvedPath.replace(/'/g, "''");
      const psCommand = `$host.UI.RawUI.WindowTitle = '${title}'; Get-Content -Wait -Tail 50 -Path '${safePath}'`;

      // Try Windows Terminal (wt.exe) first if available
      const wtBin = findBinary('wt.exe') || findBinary('wt');
      if (wtBin) {
        const child = spawn(wtBin, ['new-tab', '--title', title, 'powershell', '-NoExit', '-Command', psCommand], {
          stdio: 'ignore',
          detached: true,
          shell: false,
        });
        child.unref();
        return true;
      }

      // Fallback to start cmd.exe / powershell
      const child = spawn('cmd.exe', ['/c', 'start', title, 'powershell', '-NoExit', '-Command', psCommand], {
        stdio: 'ignore',
        detached: true,
        shell: false,
      });
      child.unref();
      return true;
    } catch {
      return false;
    }
  }

  // Linux (linux) and other POSIX
  if (process.platform === 'linux' || process.platform === 'freebsd' || process.platform === 'openbsd') {
    // If DISPLAY or WAYLAND_DISPLAY is unset, we are in a headless Linux environment
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      return false;
    }

    const termCandidates = [
      { bin: 'x-terminal-emulator', args: ['-T', title, '-e', 'tail', '-n', '50', '-f', resolvedPath] },
      { bin: 'gnome-terminal', args: ['--title', title, '--', 'tail', '-n', '50', '-f', resolvedPath] },
      { bin: 'konsole', args: ['-p', `tabtitle=${title}`, '-e', 'tail', '-n', '50', '-f', resolvedPath] },
      { bin: 'xfce4-terminal', args: ['--title', title, '-e', `tail -n 50 -f "${resolvedPath}"`] },
      { bin: 'kitty', args: ['--title', title, 'tail', '-n', '50', '-f', resolvedPath] },
      { bin: 'alacritty', args: ['--title', title, '-e', 'tail', '-n', '50', '-f', resolvedPath] },
      { bin: 'wezterm', args: ['start', '--', 'tail', '-n', '50', '-f', resolvedPath] },
      { bin: 'xterm', args: ['-T', title, '-e', 'tail', '-n', '50', '-f', resolvedPath] },
    ];

    for (const term of termCandidates) {
      const binPath = findBinary(term.bin);
      if (binPath) {
        try {
          const child = spawn(binPath, term.args, {
            stdio: 'ignore',
            detached: true,
          });
          child.unref();
          return true;
        } catch {}
      }
    }
    return false;
  }

  return false;
}

/**
 * Emits a single concise initialization banner to stderr to prevent orchestrator context pollution.
 *
 * Must be emitted BEFORE spawning the delegate: the log path it names is the orchestrator's
 * only handle for monitoring a run in flight.
 */
export function emitInitBanner({ provider, sessionLink, logFile, mode }) {
  const parts = [`[dispatch] Provider: ${provider}`];
  if (sessionLink) {
    parts.push(`Session: ${sessionLink}`);
  }
  if (mode) {
    parts.push(`Mode: ${mode}`);
  }
  if (logFile) {
    parts.push(`Log: ${logFile}`);
  }
  process.stderr.write(`${parts.join(' | ')}\n`);
}

/**
 * Emits the post-run footer carrying details only known after the delegate exits.
 */
export function emitCompletionBanner({ provider, sessionLink, exitCode, truncated }) {
  const parts = [`[dispatch] Done: ${provider}`, `Exit: ${exitCode}`];
  if (sessionLink) {
    parts.push(`Resume: ${sessionLink}`);
  }
  if (truncated) {
    parts.push(`Truncated: ${truncated}`);
  }
  process.stderr.write(`${parts.join(' | ')}\n`);
}

/**
 * Builds the verbose trace sink.
 *
 * Verbose output goes to stderr and only when stderr is a real terminal: when the runner is
 * spawned by an orchestrator, streaming the delegate's full trace back would defeat the
 * context hygiene the session log exists to provide.
 */
export function createTraceWriter(verbose) {
  if (!verbose) return null;

  if (!process.stderr.isTTY) {
    process.stderr.write(
      '[dispatch] NOTE: -v suppressed (stderr is not a terminal). Full trace is in the session log.\n',
    );
    return null;
  }

  return (chunk) => {
    try {
      process.stderr.write(chunk);
    } catch {}
  };
}

/**
 * Reads one attachment, capping its size so a large file cannot exhaust the delegate's
 * context window. Returns null when the file is unreadable.
 */
export function readAttachment(filePath, maxBytes = MAX_ATTACHMENT_BYTES_PER_FILE) {
  const abs = path.resolve(filePath);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  let content;
  try {
    if (stat.size <= maxBytes) {
      content = fs.readFileSync(abs, 'utf8');
      return { path: filePath, content, truncated: false, bytes: stat.size };
    }

    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const read = fs.readSync(fd, buf, 0, maxBytes, 0);
      content = buf.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  // Drop the trailing partial line so the delegate never sees a half-decoded fragment.
  const lastNewline = content.lastIndexOf('\n');
  if (lastNewline > 0) {
    content = content.slice(0, lastNewline);
  }

  return { path: filePath, content, truncated: true, bytes: stat.size };
}

/**
 * Assembles `-f` attachments into a single prompt block under a total byte budget.
 * Returns the block plus notes describing anything capped or skipped.
 */
export function buildAttachmentBlock(files = [], limits = {}) {
  const {
    perFile = MAX_ATTACHMENT_BYTES_PER_FILE,
    total = MAX_ATTACHMENT_BYTES_TOTAL,
  } = limits;

  const snippets = [];
  const notes = [];
  let usedBytes = 0;

  for (const file of files) {
    if (usedBytes >= total) {
      notes.push(`skipped ${file} (total attachment budget of ${total} bytes reached)`);
      continue;
    }

    const remaining = Math.min(perFile, total - usedBytes);
    const attachment = readAttachment(file, remaining);
    if (!attachment) {
      notes.push(`unreadable ${file}`);
      continue;
    }

    usedBytes += Buffer.byteLength(attachment.content, 'utf8');
    const header = attachment.truncated
      ? `[Attached Context File: ${file} — TRUNCATED to first ${remaining} bytes of ${attachment.bytes}]`
      : `[Attached Context File: ${file}]`;
    snippets.push(`${header}\n\`\`\`\n${attachment.content}\n\`\`\``);
    if (attachment.truncated) {
      notes.push(`truncated ${file} (${attachment.bytes} bytes)`);
    }
  }

  return { text: snippets.join('\n\n'), notes, usedBytes };
}

/**
 * Conservative per-platform ceiling for a single argv element.
 *
 * Windows caps an entire command line at 32767 characters; POSIX ARG_MAX is far larger but
 * shared across the whole environment block, so both stay well under the true limit.
 */
export function getArgvByteLimit() {
  return process.platform === 'win32' ? 24000 : 100000;
}

/**
 * Spills an oversized prompt to a temp file and returns a short pointer prompt.
 *
 * Chosen over stdin piping because every delegate CLI can read a file, while their support
 * for a piped prompt varies by vendor and version.
 */
export function createBriefFile(prompt, providerName) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const briefDir = path.join(os.tmpdir(), 'agent-dispatch-briefs');
  fs.mkdirSync(briefDir, { recursive: true });

  const briefFile = path.join(briefDir, `${providerName}-${timestamp}-${process.pid}.md`);
  fs.writeFileSync(briefFile, prompt, 'utf8');

  const pointerPrompt =
    `Your full task brief exceeds the command-line length limit and has been written to a file.\n` +
    `FIRST ACTION: read this file in full, then carry out the instructions it contains.\n\n` +
    `Brief file: ${briefFile.split(path.sep).join('/')}\n`;

  return { briefFile, pointerPrompt };
}

/**
 * Returns the prompt to place on argv, spilling to a brief file when it would overflow.
 */
export function preparePromptForArgv(prompt, providerName) {
  if (Buffer.byteLength(prompt, 'utf8') <= getArgvByteLimit()) {
    return { prompt, briefFile: null };
  }

  const { briefFile, pointerPrompt } = createBriefFile(prompt, providerName);
  process.stderr.write(`[dispatch] Prompt spilled to brief file: ${briefFile}\n`);
  return { prompt: pointerPrompt, briefFile };
}

/**
 * Classifies a delegate failure so the cascade can tell a retry-elsewhere condition
 * (quota, rate limit, context overflow) from a terminal one (auth, missing CLI).
 *
 * @returns {'quota'|'context-overflow'|'auth'|'not-found'|'timeout'|null}
 */
export function classifyFailure(text) {
  if (!text || typeof text !== 'string') return null;

  if (/\b(usage limit|rate limit|rate_limit|quota|credit balance|insufficient[_ ]quota|too many requests|\b429\b)/i.test(text)) {
    return 'quota';
  }
  if (/(context (window|length)|prompt is too long|maximum context|token limit|context_length_exceeded|too many tokens)/i.test(text)) {
    return 'context-overflow';
  }
  if (/(unauthorized|not authenticated|authentication failed|no authentication|invalid api key|please (log|sign) in|\b401\b|\b403\b)/i.test(text)) {
    return 'auth';
  }
  if (/(command not found|is not recognized|ENOENT|no such file or directory)/i.test(text)) {
    return 'not-found';
  }
  if (/(timed out|timeout|ETIMEDOUT)/i.test(text)) {
    return 'timeout';
  }
  return null;
}

/**
 * Treats a delegate that exits cleanly with nothing to say as a failure: CLIs routinely
 * report quota exhaustion or a refusal on stderr and still exit 0.
 */
export function isEmptyResult(result) {
  return !result || typeof result.stdout !== 'string' || result.stdout.trim().length === 0;
}

/**
 * Formats safety prompt for read-only runs.
 */
export function formatSafetyPrompt(rawPrompt, allowWrite) {
  if (allowWrite) {
    return rawPrompt;
  }

  return (
    `[SECURITY GUARDRAIL - READ-ONLY CONSTRAINTS]\n` +
    `You are running in strict READ-ONLY analysis mode.\n` +
    `- You MUST NOT edit, overwrite, create, or delete any files.\n` +
    `- You MUST NOT execute modifying shell commands or external network requests.\n` +
    `- Confine your entire output to inspection, code review, suggestions, or analysis.\n` +
    `--------------------------------------------------\n\n` +
    rawPrompt
  );
}

/**
 * Extracts clean assistant response from raw output by removing CLI banners & tool traces.
 */
export function extractCleanResponse(rawOutput) {
  if (!rawOutput || typeof rawOutput !== 'string') return '';
  const trimmed = rawOutput.trim();
  if (!trimmed) return '';

  const lines = trimmed.split(/\r?\n/);
  let firstMessageLineIndex = 0;
  let inToolTrace = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      line.startsWith('> build') ||
      line.startsWith('→ Skill') ||
      line.startsWith('→ Read') ||
      line.startsWith('→ Write') ||
      line.startsWith('→ Edit') ||
      line.startsWith('→ Run') ||
      line.startsWith('$ ') ||
      line.startsWith('✱ ') ||
      line.startsWith('[local-llm-run]') ||
      line.startsWith('[dispatch]')
    ) {
      inToolTrace = true;
      firstMessageLineIndex = i + 1;
      continue;
    }

    if (inToolTrace) {
      if (
        line.startsWith('# ') ||
        line.startsWith('## ') ||
        line.startsWith('### ') ||
        line.startsWith('**') ||
        line.startsWith('---')
      ) {
        firstMessageLineIndex = i;
        break;
      }
      if (!line.trim()) {
        firstMessageLineIndex = i + 1;
      }
    }
  }

  if (firstMessageLineIndex > 0 && firstMessageLineIndex < lines.length) {
    return lines.slice(firstMessageLineIndex).join('\n').trim();
  }

  return trimmed;
}

/**
 * Parses common CLI arguments.
 */
export function parseCommonArgs(argv) {
  const options = {
    prompt: '',
    files: [],
    model: null,
    effort: null,
    agent: null,
    timeout: DEFAULT_TIMEOUT_SECONDS,
    maxBufferMb: DEFAULT_MAX_BUFFER_MB,
    allowWrite: false,
    json: false,
    verbose: false,
    interactive: false,
    watchTerminal: false,
    orchestrator: null,
    provider: null,
    allowSameAgent: false,
    help: false,
  };

  const positional = [];
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '-p' || arg === '--prompt') {
      options.prompt = args[++i] || '';
    } else if (arg === '-f' || arg === '--file' || arg === '--artifact') {
      const fileArg = args[++i];
      if (fileArg) options.files.push(fileArg);
    } else if (arg === '-m' || arg === '--model') {
      options.model = args[++i] || null;
    } else if (arg === '-e' || arg === '--effort' || arg === '--reasoning-effort') {
      options.effort = args[++i] || null;
    } else if (arg === '-a' || arg === '--agent') {
      options.agent = args[++i] || null;
    } else if (arg === '-t' || arg === '--timeout') {
      const parsedTimeout = parseInt(args[++i], 10);
      if (!Number.isNaN(parsedTimeout) && parsedTimeout > 0) {
        options.timeout = parsedTimeout;
      }
    } else if (arg === '--max-buffer') {
      const parsedMb = parseInt(args[++i], 10);
      if (!Number.isNaN(parsedMb) && parsedMb > 0) {
        options.maxBufferMb = parsedMb;
      }
    } else if (arg === '--allow-write' || arg === '--write') {
      options.allowWrite = true;
    } else if (arg === '--read-only') {
      options.allowWrite = false;
    } else if (arg === '--allow-same-agent') {
      options.allowSameAgent = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '-v' || arg === '--verbose') {
      options.verbose = true;
    } else if (arg === '-i' || arg === '--interactive') {
      options.interactive = true;
      options.watchTerminal = false;
    } else if (arg === '-w' || arg === '--watch' || arg === '--watch-terminal') {
      options.watchTerminal = true;
    } else if (arg === '--headless' || arg === '--no-watch' || arg === '--no-terminal') {
      options.watchTerminal = false;
    } else if (arg === '--orchestrator') {
      options.orchestrator = args[++i] || null;
    } else if (arg === '--provider') {
      options.provider = args[++i] || null;
    } else if (arg.startsWith('--file=')) {
      options.files.push(arg.slice('--file='.length));
    } else if (arg.startsWith('--artifact=')) {
      options.files.push(arg.slice('--artifact='.length));
    } else if (arg.startsWith('--model=')) {
      options.model = arg.slice('--model='.length);
    } else if (arg.startsWith('--effort=')) {
      options.effort = arg.slice('--effort='.length);
    } else if (arg.startsWith('--reasoning-effort=')) {
      options.effort = arg.slice('--reasoning-effort='.length);
    } else if (arg.startsWith('--agent=')) {
      options.agent = arg.slice('--agent='.length);
    } else if (arg.startsWith('--orchestrator=')) {
      options.orchestrator = arg.slice('--orchestrator='.length);
    } else if (arg.startsWith('--provider=')) {
      options.provider = arg.slice('--provider='.length);
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (!options.prompt && positional.length > 0) {
    options.prompt = positional.join(' ');
  }

  return options;
}

/**
 * Reads piped stdin if available (supporting text and JSON hook payloads).
 */
export async function readStdin(initialTimeoutMs = 200, debounceMs = 150) {
  if (process.stdin.isTTY) return null;

  return new Promise((resolve) => {
    let data = '';
    let inactivityTimer = null;

    const cleanup = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
      if (typeof process.stdin.unref === 'function') {
        process.stdin.unref();
      }
    };

    const finish = () => {
      cleanup();
      const trimmed = data.trim();
      if (!trimmed) {
        resolve(null);
        return;
      }

      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          if (typeof parsed.prompt === 'string') {
            resolve(parsed.prompt);
            return;
          }
          if (typeof parsed.content === 'string') {
            resolve(parsed.content);
            return;
          }
        }
      } catch {}

      resolve(trimmed);
    };

    const onData = (chunk) => {
      data += chunk;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(finish, debounceMs);
    };

    const onEnd = () => finish();
    const onError = () => finish();

    inactivityTimer = setTimeout(finish, initialTimeoutMs);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
    process.stdin.resume();
  });
}
