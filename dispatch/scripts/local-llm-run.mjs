#!/usr/bin/env node

/**
 * @file local-llm-run.mjs
 * @description Hardened runner for offloading tasks to a local LLM agent via OpenCode + LM Studio.
 *
 * Implements a defense-in-depth security architecture:
 * 1. Dynamic LM Studio endpoint & pre-flight health check (fast-fail if offline)
 * 2. WAN network confinement (traps outbound external HTTP/HTTPS requests via proxy trapping while allowing local LM Studio)
 * 3. Environment variable whitelisting (strips all cloud keys, tokens, and SSH secrets)
 * 4. Sensitive file & key denylist (blocks attaching .env*, *.pem, id_rsa, .npmrc, etc.)
 * 5. Strict boundary enforcement (confines file attachments to workspace, Antigravity brain, agent configs, and OS temp)
 * 6. Read-only safety prompt framing & Git integrity check (alerts if files were touched)
 * 7. GPU concurrency lockfile (prevents concurrent hooks from thrashing local VRAM)
 * 8. Output buffer cap (10 MB cap to prevent infinite loop memory exhaustion)
 * 9. Configurable timeout with recursive process tree termination (taskkill on Windows)
 * 10. Dual interface: Standalone CLI + Programmatic API with silent-by-default execution
 *
 * =============================================================================
 * USAGE & EXAMPLES:
 * =============================================================================
 *
 * 1. Simple prompt execution (silent by default, emits only final answer):
 *    $ node scripts/local-llm-run.mjs "Summarize recent project changes"
 *    $ npm run ai:local -- "Analyze potential edge cases in domain models"
 *
 * 2. Verbose mode (stream live tool steps and startup banners):
 *    $ npm run ai:local -- -v "Explain simulation loop"
 *
 * 3. Piped input (e.g. Git diff or hook payload):
 *    $ git diff HEAD~1 | node scripts/local-llm-run.mjs "Perform code review on this diff"
 *
 * 4. With attached context files or Antigravity artifacts:
 *    $ node scripts/local-llm-run.mjs --file CONTEXT.md --file docs/adr/001.md "Check adherence"
 *    $ node scripts/local-llm-run.mjs --artifact C:/Users/name/.gemini/antigravity/brain/xyz/plan.md "Verify plan"
 *
 * 5. With custom model, agent, and timeout:
 *    $ node scripts/local-llm-run.mjs --agent delegate --model "qwen3.8-27b-ridge" --timeout 180 "Explain simulation loop"
 *
 * 6. Programmatic invocation within .agents hooks:
 *    import { runLocalAgent } from './local-llm-run.mjs';
 *    const result = await runLocalAgent({ prompt: 'Review diff' });
 *
 * =============================================================================
 * PREREQUISITES:
 * =============================================================================
 * - LM Studio: Running locally with local server started (http://127.0.0.1:1234/v1).
 * - OpenCode: `opencode` CLI installed and available in PATH.
 * - Bubblewrap (`bwrap`): Auto-detected and used on Linux if present.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTraceWriter,
  describeGitStatusDiff,
  formatSafetyPrompt,
  PROJECT_ROOT,
  SENSITIVE_FILE_PATTERNS,
} from './common.mjs';

// =============================================================================
// SECTION: Configuration & Constants
// =============================================================================

const currentFilePath = fileURLToPath(import.meta.url);

// Re-exported so this module keeps its standalone CLI surface, but the workspace
// boundary is resolved once in common.mjs.
export { PROJECT_ROOT };

/**
 * Strict whitelist of allowed environment variables to prevent token/credential leakage.
 * All sensitive cloud secrets, API keys, tokens, and SSH keys are stripped by omission.
 */
export const SAFE_ENV_WHITELIST = new Set([
  'PATH',
  'Path',
  'PATHEXT',
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'windir',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'ProgramData',
  'PROGRAMFILES',
  'ProgramFiles',
  'PROGRAMFILES(X86)',
  'ProgramFiles(x86)',
  'COMMONPROGRAMFILES',
  'CommonProgramFiles',
  'ALLUSERSPROFILE',
  'SYSTEMDRIVE',
  'SystemDrive',
  'NODE_ENV',
  'TERM',
  'LANG',
  'LC_ALL',
  'SHELL',
  'COMSPEC',
  'GIT_EXEC_PATH',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CACHE_DIR',
  'OPENCODE_DISABLE_UPDATE_CHECK',
  'OPENCODE_PORT',
]);

/**
 * Patterns that strictly disqualify an environment variable even if it matched a generic name.
 */
export const SENSITIVE_ENV_KEY_PATTERN = /(KEY|SECRET|TOKEN|PASSWORD|AUTH|CREDENTIAL|PRIVATE)/i;

// 30 minutes, sized for long local runs. This exceeds the ~600s ceiling agent harnesses
// impose on a single tool call, so invoke backgrounded — a foreground run is killed by the
// harness before this timeout can fire.
export const DEFAULT_TIMEOUT_SECONDS = 1800;
export const DEFAULT_MAX_BUFFER_MB = 10; // 10 MB buffer cap
export const DEFAULT_FALLBACK_MODEL = 'lmstudio/qwen3.8-27b-ridge';
export const DEFAULT_FALLBACK_AGENT = 'delegate';
export const DEFAULT_LM_STUDIO_HOST = '127.0.0.1';
export const DEFAULT_LM_STUDIO_PORT = 1234;

// =============================================================================
// SECTION: Path & Boundary Utilities
// =============================================================================

/**
 * Normalizes a filesystem path for cross-platform comparison (handles Windows case-insensitivity).
 */
export function normalizePathForComparison(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Determines whether targetPath is contained within rootDirectory (safe from prefix collisions).
 */
export function isPathInside(targetPath, rootDirectory) {
  const normTarget = normalizePathForComparison(targetPath);
  const normRoot = normalizePathForComparison(rootDirectory);

  if (normTarget === normRoot) return true;
  const rel = path.relative(normRoot, normTarget);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Returns allowed boundary root directories:
 * - Project Workspace
 * - Antigravity brain / artifacts (~/.gemini/antigravity and %APPDATA%/antigravity)
 * - Agent configurations (~/.agents, ~/.claude)
 * - OS Temp Directory
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

// =============================================================================
// SECTION: OpenCode Configuration & Dynamic LM Studio Resolution
// =============================================================================

/**
 * Strips single-line and multi-line comments from JSON strings while preserving URLs and strings.
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
    } else {
      result += char;
    }
  }

  return result.replace(/,\s*([}\]])/g, '$1');
}

/**
 * Reads and parses opencode configuration file (supporting JSON and JSONC with comments).
 */
export function readOpencodeConfig() {
  const candidateFiles = [
    path.join(PROJECT_ROOT, 'opencode.jsonc'),
    path.join(PROJECT_ROOT, 'opencode.json'),
  ];

  for (const configPath of candidateFiles) {
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, 'utf8');
        const sanitized = stripJsonComments(raw);
        return JSON.parse(sanitized);
      } catch {}
    }
  }

  return null;
}

/**
 * Resolves default agent identifier from opencode config or fallback.
 */
export function resolveDefaultAgent() {
  const config = readOpencodeConfig();
  if (config && config.agent && typeof config.agent === 'object') {
    if (config.agent.delegate) {
      return 'delegate';
    }
    if (config.agent.local) {
      return 'local';
    }
    const primaryKey = Object.keys(config.agent).find(
      (key) => config.agent[key]?.mode === 'primary',
    );
    if (primaryKey) {
      return primaryKey;
    }
    const firstKey = Object.keys(config.agent)[0];
    if (firstKey) {
      return firstKey;
    }
  }
  return DEFAULT_FALLBACK_AGENT;
}

/**
 * Resolves full settings from opencode.jsonc / opencode.json with environment variable overrides.
 */
export function resolveOpencodeSettings() {
  const config = readOpencodeConfig() || {};
  const rawModel = config.model || DEFAULT_FALLBACK_MODEL;
  let providerName = 'lmstudio';
  let modelKey = rawModel;

  if (rawModel.includes('/')) {
    const parts = rawModel.split('/');
    providerName = parts[0];
    modelKey = parts.slice(1).join('/');
  }

  const providerConfig = config.provider?.[providerName] || {};
  const baseURL =
    process.env.LM_STUDIO_URL ||
    providerConfig.options?.baseURL ||
    providerConfig.baseURL ||
    `http://${DEFAULT_LM_STUDIO_HOST}:${DEFAULT_LM_STUDIO_PORT}/v1`;

  const apiKey =
    process.env.LM_STUDIO_API_KEY ||
    providerConfig.options?.apiKey ||
    providerConfig.apiKey ||
    'lm-studio';

  const modelConfig = providerConfig.models?.[modelKey] || {};
  const contextLimit = modelConfig.limit?.context || 81920;
  const outputLimit = modelConfig.limit?.output || 8192;

  const defaultAgentKey = resolveDefaultAgent();
  const agentConfig = config.agent?.[defaultAgentKey] || {};
  const temperature =
    agentConfig.temperature ?? modelConfig.options?.temperature ?? 0.2;
  const reasoningEffort =
    modelConfig.options?.reasoningEffort ||
    modelConfig.options?.reasoning_effort ||
    null;

  let host = DEFAULT_LM_STUDIO_HOST;
  let port = DEFAULT_LM_STUDIO_PORT;
  let pathname = '/v1';

  try {
    const parsed = new URL(baseURL);
    host = parsed.hostname;
    port = parseInt(parsed.port || '1234', 10);
    pathname = parsed.pathname || '/v1';
  } catch {}

  return {
    rawModel,
    modelId: modelKey,
    providerName,
    baseURL,
    apiKey,
    contextLimit,
    outputLimit,
    temperature,
    reasoningEffort,
    agentPrompt: agentConfig.prompt || null,
    host,
    port,
    pathname,
  };
}

/**
 * Parses LM Studio endpoint from opencode config or environment variables.
 */
export function getLMStudioEndpoint() {
  if (process.env.LM_STUDIO_HOST && process.env.LM_STUDIO_PORT) {
    return {
      host: process.env.LM_STUDIO_HOST,
      port: parseInt(process.env.LM_STUDIO_PORT, 10),
      pathname: process.env.LM_STUDIO_PATH || '/v1',
    };
  }

  const settings = resolveOpencodeSettings();
  return {
    host: settings.host,
    port: settings.port,
    pathname: settings.pathname,
  };
}

/**
 * Pings LM Studio endpoint to verify server is reachable.
 */
export async function preflightLMStudioCheck(timeoutMs = 2000) {
  const endpoint = getLMStudioEndpoint();
  const targetPath = endpoint.pathname.replace(/\/+$/, '') + '/models';

  return new Promise((resolve) => {
    const req = http.get(
      {
        host: endpoint.host,
        port: endpoint.port,
        path: targetPath,
        timeout: timeoutMs,
      },
      (res) => {
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      },
    );

    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });

    req.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Validates and resolves context file paths against boundaries and sensitive patterns.
 */
export function resolveContextFiles(files) {
  const resolved = [];
  const allowedRoots = getAllowedBoundaryRoots();

  for (const rawPath of files) {
    const absPath = path.resolve(rawPath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`Context file does not exist: ${rawPath} (resolved: ${absPath})`);
    }

    // Check sensitive file denylist
    const baseName = path.basename(absPath);
    for (const pattern of SENSITIVE_FILE_PATTERNS) {
      if (pattern.test(absPath) || pattern.test(baseName)) {
        throw new Error(
          `Access rejected: Context file matches sensitive denylist pattern: ${rawPath}`,
        );
      }
    }

    // Strict boundary enforcement: must reside in one of the allowed roots
    const isInsideAllowedBoundary = allowedRoots.some((root) => isPathInside(absPath, root));

    if (!isInsideAllowedBoundary) {
      throw new Error(
        `Access denied to path outside workspace / artifact boundaries: ${absPath}`,
      );
    }

    resolved.push(absPath);
  }

  return resolved;
}

/**
 * Acquires a cross-process lock to prevent GPU memory thrashing from concurrent invocations.
 */
export function acquireLock(maxWaitMs = 15000, pollIntervalMs = 500) {
  const lockDir = os.tmpdir();
  const lockFile = path.join(lockDir, 'agent_dispatch_local_llm.lock');
  const startTime = Date.now();

  while (fs.existsSync(lockFile)) {
    try {
      const stats = fs.statSync(lockFile);
      // If lock file is older than 6 minutes, treat as stale
      if (Date.now() - stats.mtimeMs > 360000) {
        fs.unlinkSync(lockFile);
        break;
      }
    } catch {
      break;
    }

    if (Date.now() - startTime > maxWaitMs) {
      break;
    }

    const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(waitBuffer, 0, 0, pollIntervalMs);
  }

  try {
    fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
  } catch {
    // If creation failed due to race, proceed anyway
  }

  return () => {
    try {
      if (fs.existsSync(lockFile)) {
        const content = fs.readFileSync(lockFile, 'utf8');
        if (content.trim() === String(process.pid)) {
          fs.unlinkSync(lockFile);
        }
      }
    } catch {}
  };
}

/**
 * Captures git status for read-only integrity verification.
 */
export function getGitStatus() {
  try {
    const result = spawnSync('git', ['status', '--porcelain'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 5000,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

// =============================================================================
// SECTION: CLI Options & Stdin Parsing
// =============================================================================

export function parseArgs(argv) {
  const options = {
    prompt: '',
    files: [],
    model: null,
    agent: null,
    timeout: DEFAULT_TIMEOUT_SECONDS,
    maxBufferMb: DEFAULT_MAX_BUFFER_MB,
    json: false,
    verbose: false,
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
    } else if (arg === '-a' || arg === '--agent') {
      options.agent = args[++i] || null;
    } else if (arg === '-m' || arg === '--model') {
      options.model = args[++i] || null;
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
      // Write mode removed — delegates are always read-only. Accepted silently.
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '-v' || arg === '--verbose') {
      options.verbose = true;
    } else if (arg.startsWith('--file=')) {
      options.files.push(arg.slice('--file='.length));
    } else if (arg.startsWith('--artifact=')) {
      options.files.push(arg.slice('--artifact='.length));
    } else if (arg.startsWith('--agent=')) {
      options.agent = arg.slice('--agent='.length);
    } else if (arg.startsWith('--model=')) {
      options.model = arg.slice('--model='.length);
    } else if (arg.startsWith('--timeout=')) {
      const parsedTimeout = parseInt(arg.slice('--timeout='.length), 10);
      if (!Number.isNaN(parsedTimeout) && parsedTimeout > 0) {
        options.timeout = parsedTimeout;
      }
    } else if (arg.startsWith('--max-buffer=')) {
      const parsedMb = parseInt(arg.slice('--max-buffer='.length), 10);
      if (!Number.isNaN(parsedMb) && parsedMb > 0) {
        options.maxBufferMb = parsedMb;
      }
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
 * Reads piped stdin with adaptive chunk buffering (supporting JSON hook payloads and raw streams).
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

      // If stdin is an Antigravity / agent hook JSON payload, extract prompt or content
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
      } catch {
        // Plain text stream
      }

      resolve(trimmed);
    };

    const onData = (chunk) => {
      data += chunk;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(finish, debounceMs);
    };

    const onEnd = () => {
      finish();
    };

    const onError = () => {
      finish();
    };

    inactivityTimer = setTimeout(finish, initialTimeoutMs);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
    process.stdin.resume();
  });
}

export function resolveDefaultModel() {
  const parsed = readOpencodeConfig();
  if (parsed && parsed.model) {
    if (parsed.provider) {
      for (const key of Object.keys(parsed.provider)) {
        if (
          parsed.provider[key]?.models?.[parsed.model] &&
          !parsed.model.startsWith(`${key}/`)
        ) {
          return `${key}/${parsed.model}`;
        }
      }
    }
    return parsed.model;
  }
  return DEFAULT_FALLBACK_MODEL;
}

/**
 * Builds sanitized environment with proxy trapping and whitelist filtering.
 */
export function getSanitizedEnv() {
  const cleanEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SAFE_ENV_WHITELIST.has(key) && !SENSITIVE_ENV_KEY_PATTERN.test(key)) {
      cleanEnv[key] = value;
    }
  }

  // Network proxy trapping: traps external WAN calls while allowing local LM Studio
  const endpoint = getLMStudioEndpoint();
  const localHosts = `127.0.0.1,localhost,127.0.0.1:${endpoint.port},localhost:${endpoint.port},${endpoint.host},${endpoint.host}:${endpoint.port},::1`;

  cleanEnv.NO_PROXY = localHosts;
  cleanEnv.no_proxy = localHosts;
  cleanEnv.HTTP_PROXY = 'http://127.0.0.1:0';
  cleanEnv.http_proxy = 'http://127.0.0.1:0';
  cleanEnv.HTTPS_PROXY = 'http://127.0.0.1:0';
  cleanEnv.https_proxy = 'http://127.0.0.1:0';

  return cleanEnv;
}

export function printHelp() {
  console.log(`
Hardened Local LLM Runner (OpenCode + LM Studio)

Runs in silent mode by default, outputting only the final response text upon completion.

Usage:
  node scripts/local-llm-run.mjs [options] [prompt]
  npm run ai:local -- [options] [prompt]

Options:
  -p, --prompt <string>       The prompt message to send to the local agent
  -f, --file, --artifact      Attach a context file or Antigravity artifact path (can repeat)
  -a, --agent <name>          Override agent (defaults to 'delegate' from opencode.jsonc)
  -m, --model <name>          Override model (defaults to opencode.jsonc model)
  -t, --timeout <seconds>     Override execution timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})
  --max-buffer <MB>           Max output buffer limit in MB (default: ${DEFAULT_MAX_BUFFER_MB})
  --json                      Emit raw JSON event stream
  -v, --verbose               Stream live execution trace and tool invocations (default: false)
  -h, --help                  Show this help message

Examples:
  node scripts/local-llm-run.mjs "Review git diff for bugs"
  node scripts/local-llm-run.mjs -a delegate "Inspect codebase structure"
  node scripts/local-llm-run.mjs -v "Inspect codebase structure"
  git diff | node scripts/local-llm-run.mjs "Analyze these changes"
  node scripts/local-llm-run.mjs -f CONTEXT.md "Summarize invariants"
`);
}

// =============================================================================
// SECTION: Output Extraction & Parsing
// =============================================================================

/**
 * Extracts clean assistant text from opencode output by stripping leading tool logs if present.
 */
export function extractAssistantResponse(rawOutput) {
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
      line.startsWith('[local-llm-run]')
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

// =============================================================================
// SECTION: Command Construction & Execution
// =============================================================================


/**
 * Resolves the opencode binary path on Windows to avoid shell: true.
 */
export function resolveOpencodeBinary() {
  if (process.platform === 'win32') {
    const res = spawnSync('where.exe', ['opencode'], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout.trim()) {
      const firstLine = res.stdout.trim().split(/\r?\n/)[0];
      if (firstLine && fs.existsSync(firstLine)) {
        return firstLine;
      }
    }
  }
  return 'opencode';
}

/**
 * Constructs the execution command and arguments for OpenCode or Linux bwrap.
 * @param {Object} [params]
 * @param {string} [params.prompt]
 * @param {string[]} [params.files]
 * @param {string|null} [params.model]
 * @param {string|null} [params.agent]
 * @param {boolean} [params.json]
 */
export function buildCommand({
  prompt = '',
  files = [],
  model = null,
  agent = null,
  json = false,
} = {}) {
  const isLinux = process.platform === 'linux';
  const checkBwrap = isLinux
    ? spawnSync('which', ['bwrap'], { encoding: 'utf8' })
    : null;
  const hasLinuxBwrap = checkBwrap && checkBwrap.status === 0 && checkBwrap.stdout.trim();

  const formattedPrompt = formatSafetyPrompt(prompt, {
    workspaceRoot: PROJECT_ROOT,
    attachedFiles: files,
  });
  const opencodeArgs = ['run', '--auto', '--pure'];

  const effectiveAgent = agent || resolveDefaultAgent();
  if (effectiveAgent) {
    opencodeArgs.push('--agent', effectiveAgent);
  }

  const effectiveModel = model || resolveDefaultModel();
  if (effectiveModel) {
    opencodeArgs.push('-m', effectiveModel);
  }

  if (json) {
    opencodeArgs.push('--format', 'json');
  }

  for (const file of files) {
    opencodeArgs.push(`--file=${file}`);
  }

  opencodeArgs.push('--', formattedPrompt);

  if (hasLinuxBwrap) {
    const bwrapArgs = [
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/tmp',
      '--tmpfs', '/run',
      '--unshare-user',
      '--unshare-ipc',
      '--unshare-pid',
      '--unshare-uts',
    ];

    bwrapArgs.push('--ro-bind', PROJECT_ROOT, PROJECT_ROOT);

    for (const f of files) {
      if (!f.startsWith(PROJECT_ROOT)) {
        bwrapArgs.push('--ro-bind', f, f);
      }
    }

    bwrapArgs.push('--chdir', PROJECT_ROOT);
    bwrapArgs.push('opencode', ...opencodeArgs);

    return {
      command: 'bwrap',
      args: bwrapArgs,
      engineType: 'linux-bwrap',
    };
  }

  return {
    command: resolveOpencodeBinary(),
    args: opencodeArgs,
    engineType: 'process-hardened',
  };
}

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

// =============================================================================
// SECTION: Programmatic API for Agent Hooks & External Callers
// =============================================================================

/**
 * Programmatic runner for executing a local LLM task.
 * Returns clean stdout, stderr, exitCode, and execution summary.
 * @param {Object} [params]
 * @param {string} [params.prompt]
 * @param {string[]} [params.files]
 * @param {string|null} [params.model]
 * @param {string|null} [params.agent]
 * @param {number} [params.timeout]
 * @param {number} [params.maxBufferMb]
 * @param {boolean} [params.json]
 * @param {boolean} [params.verbose]
 * @param {((chunk: Buffer) => void)|null} [params.onChunk] Live sink for output, so a caller
 *   can stream the run to a session log instead of only seeing it at exit.
 */
export async function runLocalAgent(params = {}) {
  const {
    prompt = '',
    files = [],
    model = null,
    agent = null,
    timeout = DEFAULT_TIMEOUT_SECONDS,
    maxBufferMb = DEFAULT_MAX_BUFFER_MB,
    json = false,
    verbose = false,
    onChunk = null,
  } = params;

  if (!prompt.trim()) {
    throw new Error('No prompt provided for local agent execution.');
  }

  const isServerReady = await preflightLMStudioCheck();
  if (!isServerReady) {
    const endpoint = getLMStudioEndpoint();
    const err = new Error(
      `LM Studio local server is not reachable at http://${endpoint.host}:${endpoint.port}.\n` +
        `Please ensure LM Studio is running and the local server is started.`,
    );
    err.code = 'SERVER_OFFLINE';
    throw err;
  }

  const releaseLock = acquireLock();
  let contextFiles = [];
  try {
    contextFiles = resolveContextFiles(files);
  } catch (err) {
    releaseLock();
    throw err;
  }

  // Fail before spawning rather than letting the model report a context overflow: the
  // prompt alone must leave room for the attached files and the reply. ~3.5 chars/token
  // is a deliberately loose estimate — this catches gross overruns, not marginal ones.
  const { contextLimit, outputLimit } = resolveOpencodeSettings();
  const promptBudgetChars = Math.floor((contextLimit - outputLimit) * 3.5);
  if (prompt.length > promptBudgetChars) {
    releaseLock();
    const err = new Error(
      `Prompt is ${prompt.length} chars, over the ~${promptBudgetChars} char budget for a ` +
        `${contextLimit}-token context reserving ${outputLimit} tokens for output. ` +
        `Shorten the prompt or attach fewer files.`,
    );
    err.code = 'CONTEXT_BUDGET_EXCEEDED';
    throw err;
  }

  const effectiveModelName = model || resolveDefaultModel();
  const effectiveAgentName = agent || resolveDefaultAgent();
  const { command, args, engineType } = buildCommand({
    prompt,
    files: contextFiles,
    model: effectiveModelName,
    agent: effectiveAgentName,
    json,
  });

  if (verbose) {
    console.error(
      `[local-llm-run] Engine: ${engineType} | Agent: ${effectiveAgentName} | Model: ${effectiveModelName} | Mode: READ-ONLY | Timeout: ${timeout}s`,
    );
  }

  const initialGitStatus = getGitStatus();
  const sanitizedEnv = getSanitizedEnv();
  const trace = createTraceWriter(verbose);
  const maxBufferBytes = maxBufferMb * 1024 * 1024;

  return new Promise((resolve, reject) => {
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let totalOutputBytes = 0;
    let isTimedOut = false;
    let isBufferExceeded = false;

    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      env: sanitizedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    if (child.stdin) {
      child.stdin.end();
    }

    const timer = setTimeout(() => {
      isTimedOut = true;
      terminateProcessTree(child);
    }, timeout * 1000);

    const cleanup = () => {
      clearTimeout(timer);
      terminateProcessTree(child);
      releaseLock();
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
      if (onChunk) onChunk(chunk);
      if (trace) trace(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString('utf8');
      if (onChunk) onChunk(chunk);
      if (trace) trace(chunk);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      releaseLock();

      let gitIntegrityViolation = false;
      let gitIntegrityDetails = null;
      if (initialGitStatus !== null) {
        const finalGitStatus = getGitStatus();
        if (finalGitStatus !== null && finalGitStatus !== initialGitStatus) {
          gitIntegrityViolation = true;
          gitIntegrityDetails = describeGitStatusDiff(initialGitStatus, finalGitStatus);
        }
      }

      // A truncated run still carries most of its analysis; hand back what was captured
      // and let the caller decide whether to use it or cascade.
      const truncated = isTimedOut ? 'timeout' : isBufferExceeded ? 'buffer' : null;
      if (truncated) {
        process.stderr.write(
          isTimedOut
            ? `[local-llm-run] Timed out after ${timeout}s; returning partial output.\n`
            : `[local-llm-run] Output exceeded ${maxBufferMb}MB cap; returning partial output.\n`,
        );
      }

      const finalStdout = json ? stdoutBuffer : extractAssistantResponse(stdoutBuffer);

      resolve({
        stdout: finalStdout,
        rawStdout: stdoutBuffer,
        stderr: stderrBuffer,
        truncated,
        exitCode: truncated ? (isTimedOut ? 124 : 137) : (code ?? (signal ? 1 : 0)),
        engineType,
        agent: effectiveAgentName,
        model: effectiveModelName,
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

// =============================================================================
// SECTION: CLI Execution Entry Point
// =============================================================================

export async function main() {
  const options = parseArgs(process.argv);

  if (options.help) {
    printHelp();
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
    console.error('Error: No prompt or stdin provided. Use --help for usage.');
    process.exit(1);
  }

  try {
    const result = await runLocalAgent({
      prompt: finalPrompt,
      files: options.files,
      model: options.model,
      agent: options.agent,
      timeout: options.timeout,
      maxBufferMb: options.maxBufferMb,
      json: options.json,
      verbose: options.verbose,
    });

    // In default silent mode, write the extracted final response to stdout
    if (!options.verbose && result.stdout) {
      process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
    }

    if (result.gitIntegrityViolation) {
      console.warn(
        `\n[local-llm-run] WARNING: Workspace was modified during READ-ONLY execution!`,
      );
      if (result.gitIntegrityDetails) {
        console.warn(`[local-llm-run] Changed files:\n${result.gitIntegrityDetails}`);
      }
      console.warn('');
    }

    process.exit(result.exitCode);
  } catch (err) {
    console.error(`\n[local-llm-run] ERROR: ${err.message}`);
    if (err.stderr && err.stderr.trim()) {
      console.error(`\n--- Subprocess Stderr ---\n${err.stderr.trim()}`);
    }
    const exitCode = typeof err.code === 'number' ? err.code : 1;
    process.exit(exitCode);
  }
}

// Auto-run main only if invoked directly via CLI
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
