#!/usr/bin/env node

/**
 * @file opencode-run.mjs
 * @description Config-driven runner for offloading tasks to OpenCode, against any
 * `provider/model` pair resolvable from opencode.jsonc — local LM Studio is the zero-config
 * default, not the only supported target.
 *
 * Defense-in-depth layers:
 * 1. Locality-branched preflight: a local endpoint gets a fast, free `/models` health check
 *    (fast-fail if offline); a remote endpoint skips the live network probe (no unauthenticated
 *    reachability call against a paid API) and leaves reachability to opencode's own execution.
 * 2. WAN network confinement for local endpoints only (proxy-traps outbound external HTTP/HTTPS,
 *    allows the local backend); a remote provider's entire purpose is reaching WAN, so the trap
 *    does not apply there at all.
 * 3. Environment variable whitelisting (strips cloud keys, tokens, and SSH secrets) — a remote
 *    provider's credentials belong in opencode.jsonc's `providers.<name>.settings.apiKey`, resolved
 *    by opencode's own subprocess, not in the orchestrator's ambient environment.
 * 4. Sensitive file & key denylist (blocks attaching .env*, *.pem, id_rsa, .npmrc, etc.)
 * 5. Attachment boundary warning (an attachment outside the workspace, Antigravity brain, agent
 *    configs, or OS temp is kept but flagged — `-f` is orchestrator-chosen, not delegate-chosen)
 * 6. Read-only safety prompt framing
 * 7. GPU concurrency lockfile for local backends only (prevents concurrent hooks from thrashing
 *    local VRAM; a remote API call has no such contention and is not serialized behind it)
 * 8. Output buffer cap (10 MB default, prevents infinite-loop memory exhaustion)
 * 9. Configurable timeout with recursive process tree termination (taskkill on Windows)
 * 10. Dual interface: standalone CLI + programmatic API, silent by default
 *
 * =============================================================================
 * PREREQUISITES:
 * =============================================================================
 * - Model: set opencode.jsonc's `model` to a bare `lmstudio` model name to target a local
 *   LM Studio server (http://127.0.0.1:1234/v1), or to any other `provider/model` (e.g.
 *   `anthropic/claude-opus-5`, `openrouter/...`) to target a remote provider instead —
 *   its credentials go in that provider's `providers.<name>.settings.apiKey` in opencode.jsonc
 *   (opencode resolves it itself), never in this process's environment. When opencode.jsonc
 *   sets no `model` at all, this script assumes nothing about the target — opencode's own
 *   CLI default applies (no `-m` flag passed, no LM Studio host guessed).
 * - OpenCode: `opencode` CLI v2 installed and available in PATH. Argv is v2-only — no
 *   `--pure`/`--variant`, and no v1-CLI fallback is attempted.
 * - Config: merged across every locally-readable tier from opencode's own precedence order
 *   (https://opencode.ai/docs/config/#precedence-order) — global (`~/.config/opencode/`),
 *   `OPENCODE_CONFIG`, project root, `.opencode/` directories, `OPENCODE_CONFIG_CONTENT`, and
 *   OS-managed config dirs — supplying model, agent, context/output limits, and optional
 *   provider `baseURL`/`apiKey`. Remote config and macOS MDM `.mobileconfig` are excluded (see
 *   `readOpencodeConfig`'s doc comment for why).
 * - Optional: `bwrap` (Bubblewrap) on Linux for filesystem-level read-only mounts.
 *
 * Usage examples live in this script's `--help` output, which cannot drift from the parser.
 */

// NOTE: imported as a namespace (not destructured) so tests can `mock.method(cp, 'spawn', ...)` /
// `mock.method(cp, 'spawnSync', ...)` — a destructured named import snapshots the function
// reference at module-load time for this builtin, so mutating the module's own `spawn`/
// `spawnSync` property afterward would not be visible through a destructured binding.
import cp from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  cascadeModels,
  resolveModelsToTry,
  formatCliError,
  safeExitCode,
  classifyFailure,
  createSessionLogger,
  createTraceWriter,
  DEFAULT_MAX_BUFFER_MB,
  DEFAULT_TIMEOUT_SECONDS,
  emitCompletionBanner,
  emitInitBanner,
  extractCleanResponse,
  buildFormattedPrompt,
  buildMetricsAttempt,
  isExecutableFile,
  isMainModule,
  parseCommonArgs,
  parseJsonc,
  preparePromptForArgv,
  PROJECT_ROOT,
  readStdin,
  removeBriefFile,
  resolveCliInvocation,
  resolveRunnerExitCode,
  runDelegateCapture,
  SAFE_ENV_WHITELIST,
  scanVersionDirs,
  SENSITIVE_ENV_KEY_PATTERN,
  SENSITIVE_FILE_PATTERNS,
  validateEffortSpec,
  validateModelSpec,
} from './common.mjs';

// ============================================================================
// SECTION: Types
// ============================================================================

/**
 * @typedef {'cli'|'desktop'|'vscode'} OpencodeMode
 */

/**
 * @typedef {object} OpencodeModeDefinition
 * @property {OpencodeMode} mode
 * @property {string} name
 * @property {() => string|null} fn Resolves the binary path for this mode, or null if absent.
 */

/**
 * @typedef {object} OpencodeTarget
 * @property {OpencodeMode} mode
 * @property {string} name
 * @property {string} bin
 */

/**
 * @typedef {object} OpencodeSettings
 * @property {string} rawModel
 * @property {string} modelId
 * @property {string} providerName
 * @property {string} baseURL
 * @property {number} contextLimit
 * @property {number} outputLimit
 * @property {string|null} reasoningEffort
 * @property {string} agentKey Resolved default agent key from opencode.jsonc.
 * @property {string|null} host Null when the endpoint is a remote/unconfigured cloud provider
 *   whose real address this script has no way to know.
 * @property {number|null} port
 * @property {string|null} pathname
 * @property {string|null} protocol URL scheme (`'http:'`/`'https:'`) for `host`; null when `host`
 *   is null.
 * @property {boolean} isLocal True when the resolved endpoint host is a loopback address.
 */

/**
 * @typedef {object} LMStudioEndpoint
 * @property {string} host
 * @property {number} port
 * @property {string} pathname
 * @property {string} protocol URL scheme (`'http:'`/`'https:'`); `'http:'` when none was resolved.
 */

/**
 * @typedef {object} RunOpencodeOptions
 * @property {string} prompt
 * @property {string[]} [files]
 * @property {string|string[]|null} [model] Overrides opencode.jsonc's configured model; a list is tried in order.
 * @property {string|null} [agent] Overrides opencode.jsonc's configured agent.
 * @property {string|null} [effort] Folded into the model as `opencode run -m <model>#<effort>`
 *   (provider-specific reasoning effort, e.g. high, max, minimal); omitted when null. Dropped
 *   with a stderr note when no model is resolvable to fold it into.
 * @property {number} [timeout] Seconds before the delegate is killed.
 * @property {number} [maxBufferMb] Stdout cap before the delegate is killed.
 * @property {boolean} [json]
 * @property {boolean} [verbose]
 * @property {string|null} [binary] Caller-supplied delegate binary, forwarded to
 *   {@link buildCommand}; skips {@link resolveOpencodeTarget} when given (test seam).
 */

/**
 * @typedef {object} RunOpencodeResult
 * @property {'opencode'} provider
 * @property {string} model
 * @property {string} agent
 * @property {OpencodeMode|null} mode Binary provenance — which install shape supplied the
 *   executable (cli/desktop/vscode); null when no mode resolved and the bare `'opencode'`
 *   fallback string is used. Independent of `engineType`, which reports the execution engine
 *   (e.g. `'linux-bwrap'`); under bwrap both are present.
 * @property {string} engineType
 * @property {string} stdout Cleaned assistant response.
 * @property {string} rawStdout Raw stdout, unparsed.
 * @property {string} stderr
 * @property {number} exitCode
 * @property {string} logFile
 * @property {string|null} briefFile Temp file the prompt was spilled to when over the argv byte
 *   limit; null when the prompt was passed directly.
 * @property {string|null} sessionLink Endpoint URL of the resolved backend, or null when no host
 *   is known.
 * @property {'timeout'|'buffer'|null} truncated
 * @property {string|null} failureKind
 */

// ============================================================================
// SECTION: Constants (tweak these)
// ============================================================================

export const DEFAULT_FALLBACK_AGENT = 'plan';
export const DEFAULT_LM_STUDIO_HOST = '127.0.0.1';
export const DEFAULT_LM_STUDIO_PORT = 1234;
export const DEFAULT_CONTEXT_LIMIT = 81920;
export const DEFAULT_OUTPUT_LIMIT = 8192;
export const CHARS_PER_TOKEN_ESTIMATE = 3.5;

/**
 * Execution modes in discovery priority order: OpenCode CLI > OpenCode Desktop app >
 * OpenCode VS Code extension. The single source of truth for mode metadata — every mode-aware
 * function below (resolution, availability) iterates this instead of redeclaring the list.
 * Mirrors claude-run.mjs/copilot-run.mjs MODE_DEFINITIONS; unlike those runners, opencode does
 * not cascade execution across modes — this orders *binary discovery* only.
 * @type {OpencodeModeDefinition[]}
 */
export const OPENCODE_MODE_DEFINITIONS = [
  { mode: 'cli', name: 'OpenCode CLI', fn: () => getOpencodeCliBinary() },
  { mode: 'desktop', name: 'OpenCode Desktop', fn: () => getOpencodeDesktopBinary() },
  { mode: 'vscode', name: 'OpenCode VS Code Extension', fn: () => getOpencodeVscodeBinary() },
];

/**
 * OpenCode-specific environment variables layered on top of the shared
 * {@link SAFE_ENV_WHITELIST} — these only make sense for this runner and would
 * be noise in every other delegate's environment.
 */
export const OPENCODE_EXTRA_ENV_ALLOWLIST = new Set([
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CACHE_DIR',
  'OPENCODE_DISABLE_UPDATE_CHECK',
  'OPENCODE_PORT',
]);

// NOTE: GPU lockfile name is pinned to this legacy value — os.tmpdir() is machine-global and
// older installed copies of this skill in other repos still contend on the same file.
// Renaming it would silently break mutual exclusion between old and new copies, defeating
// the VRAM-thrashing prevention the lock exists to provide.
export const GPU_LOCK_FILE_NAME = 'agent_dispatch_local_llm.lock';
export const GPU_LOCK_STALE_MS = 360000;
export const GPU_LOCK_MAX_WAIT_MS = 15000;
export const GPU_LOCK_POLL_MS = 500;

// Enough to hold opencode's closing error block without retaining a whole transcript twice.
const LOG_TAIL_CHARS = 16 * 1024;

export const LM_STUDIO_NO_LOADED_MODEL_WARNING =
  "LM Studio reports no loaded model; JIT loading may be off — run 'lms load <model>'";

// ============================================================================
// SECTION: Main API — runOpencode()
// ============================================================================

/**
 * Executes a task using the OpenCode runner, against whatever `provider/model` opencode.jsonc
 * resolves — local LM Studio when configured, any other provider/model, or opencode's own
 * CLI default when opencode.jsonc sets no model at all.
 * Session logger and init banner are created before preflight so that an offline
 * LM Studio failure still produces a session log (mirrors the previous two-file
 * split's ordering from the pre-consolidation two-file architecture).
 *
 * An array (or comma-separated) `model` is tried in order, each model as a full single-model run
 * (settings, preflight and GPU lock re-resolved per model, since the model decides locality).
 *
 * @param {RunOpencodeOptions} options
 * @returns {Promise<RunOpencodeResult>}
 */
export async function runOpencode(options = {}) {
  const {
    prompt = '',
    model = null,
    // Test seam: defaults to the real single-model run, so production calls are unchanged.
    runSingle = runOpencodeSingle,
  } = options;

  if (!prompt.trim()) {
    throw new Error('No prompt provided for opencode agent execution.');
  }

  validateModelSpec(model, 'model');
  validateEffortSpec(options.effort, 'effort');

  const metricsAttempts = [];
  return cascadeModels(
    resolveModelsToTry(model),
    async (currentModel) => {
      try {
        const result = await runSingle({ ...options, model: currentModel });
        const input = result.formattedPromptForMetrics ?? prompt;
        metricsAttempts.push(buildMetricsAttempt({
          input,
          output: result.stdout,
          provider: 'opencode',
          model: result.model ?? currentModel,
          effort: options.effort ?? null,
          mode: result.mode,
          exitCode: result.exitCode,
          failureKind: result.failureKind,
          truncated: result.truncated,
          usage: result.usage,
        }));
        delete result.formattedPromptForMetrics;
        result.metricsAttempts = [...metricsAttempts];
        result.effectiveAttempt = metricsAttempts.length - 1;
        return result;
      } catch (err) {
        metricsAttempts.push(buildMetricsAttempt({
          input: err.formattedPromptForMetrics ?? null,
          provider: 'opencode',
          model: currentModel,
          effort: options.effort ?? null,
          failureKind: err.failureKind || classifyFailure(`${err.message}\n${err.stderr || ''}`),
        }));
        err.metricsAttempts = [...metricsAttempts];
        throw err;
      }
    },
    { label: 'OpenCode' },
  );
}

/**
 * Single-model body of {@link runOpencode}.
 * @param {RunOpencodeOptions} options
 * @returns {Promise<RunOpencodeResult>}
 */
async function runOpencodeSingle(options = {}) {
  const {
    prompt = '',
    files = [],
    model = null,
    agent = null,
    effort = null,
    timeout = DEFAULT_TIMEOUT_SECONDS,
    maxBufferMb = DEFAULT_MAX_BUFFER_MB,
    json = false,
    verbose = false,
    binary = null,
  } = options;

  // Step 1: one config parse, threaded through every step below. A CLI -m override is folded in
  // before settings resolve, so it can change providerName/isLocal before the preflight/lock
  // decision below — resolving from the bare config would decide locality on stale (pre-override)
  // input.
  const rawConfig = readOpencodeConfig();
  const settings = resolveOpencodeSettings(model ? { ...rawConfig, model } : rawConfig);
  // Recorded for the banner; the subprocess receives it folded into `-m <model>#<effort>` (see buildCommand).
  if (effort) settings.reasoningEffort = effort;
  const { isLocal } = settings;
  const endpoint = isLocal ? getLMStudioEndpoint(settings) : null;
  // Binary discovery (cli > desktop > vscode) happens before the init banner so both banners
  // carry the resolved mode; the target is threaded down into buildCommand. A caller-supplied
  // `binary` (test seam) skips discovery entirely — its mode is unknown, so banners/results
  // carry a null mode rather than guessing.
  const target = binary ? { mode: null, name: null, bin: binary } : resolveOpencodeTarget();
  // A resolved host (local, or an explicit remote baseURL) still gets a real URL, built with its
  // actual scheme/port so an HTTPS remote endpoint doesn't get relabeled as plain http://; a
  // remote provider relying on opencode's own built-in endpoint registry has no host this script
  // knows, so it gets null rather than a model label posing as a session.
  const isDefaultPort =
    (settings.protocol === 'http:' && settings.port === 80) ||
    (settings.protocol === 'https:' && settings.port === 443);
  const sessionLink = settings.host
    ? `${settings.protocol}//${settings.host}${isDefaultPort ? '' : `:${settings.port}`}${settings.pathname}`
    : null;

  // Step 2: create logger + emit init banner before any preflight that could fail,
  // so offline runs still produce a session log.
  const sessionLogger = createSessionLogger('opencode');
  emitInitBanner({
    platform: 'opencode',
    mode: target?.mode ?? null,
    model: settings.rawModel || null,
    effort: settings.reasoningEffort || null,
    logFile: sessionLogger.logFile,
    host: sessionLink,
  });

  // Step 3: preflight — only meaningful for a local backend (fast, free, safe unauthenticated
  // GET against a machine the user just started). A remote provider may require auth headers
  // this script doesn't send and may not expose an unauthenticated /models route, so its
  // reachability is left to opencode's own execution (classifyFailure() cascades normally).
  if (isLocal) {
    const isServerReady = await preflightLMStudioCheck(2000, endpoint);
    if (!isServerReady) {
      const offlineMessage =
        `LM Studio local server is not reachable at ${endpoint.protocol}//${endpoint.host}:${endpoint.port}.\n` +
        `Please ensure LM Studio is running and the local server is started.`;
      failLogger(sessionLogger, offlineMessage);
      const err = new Error(offlineMessage);
      err.code = 'SERVER_OFFLINE';
      throw err;
    }
    // `/v1/models` lists downloaded models (JIT), so it cannot tell "not loaded"; warn only,
    // since JIT loading may still succeed on demand.
    const modelWarning = await checkLMStudioLoadedModel(endpoint);
    if (modelWarning) {
      process.stderr.write(`[dispatch] WARNING: ${modelWarning}\n`);
      sessionLogger.write(`[dispatch] WARNING: ${modelWarning}\n`);
    }
  }

  // Step 4: GPU concurrency lock — only for a local backend (prevents concurrent hooks from
  // thrashing local VRAM). A remote API call has no such contention, so it gets a no-op release
  // instead, keeping the rest of the releaseOnce()-guarded flow identical for both paths.
  // Every path from here to the spawn handlers must release it — a stranded lockfile blocks all
  // subsequent local runs until GPU_LOCK_STALE_MS elapses — so the whole remainder is wrapped and
  // the release is funnelled through releaseOnce().
  const releaseLock = isLocal ? acquireLock() : () => {};
  let lockReleased = false;
  const releaseOnce = () => {
    if (lockReleased) return;
    lockReleased = true;
    releaseLock();
  };

  // Hoisted so the outer `finally` can clean it up even when a step between `buildCommand`
  // and the spawn itself throws (e.g. a synchronous spawn resolution failure).
  let briefFile = null;
  try {
    // Step 5: format prompt with attachments (inlines context files with nonce delimiters and byte caps).
    const formattedPrompt = buildFormattedPrompt(prompt, files);

    // Step 6: prompt-budget check — ~3.5 chars/token, loose estimate to catch gross overruns.
    // Fail before spawning rather than letting the model report a context overflow.
    const promptBudgetChars = Math.floor(
      (settings.contextLimit - settings.outputLimit) * CHARS_PER_TOKEN_ESTIMATE,
    );
    if (formattedPrompt.length > promptBudgetChars) {
      const err = new Error(
        `Prompt is ${formattedPrompt.length} chars, over the ~${promptBudgetChars} char budget for a ` +
          `${settings.contextLimit}-token context reserving ${settings.outputLimit} tokens for output. ` +
          `Shorten the prompt or attach fewer files.`,
      );
      err.code = 'CONTEXT_BUDGET_EXCEEDED';
      throw err;
    }

    // Step 7: build the command, resolving model/agent from the pre-read config and using the
    // binary discovered above (target.bin) instead of re-resolving inside.
    const effectiveModel = model || resolveDefaultModel(rawConfig);
    const effectiveAgent = agent || resolveDefaultAgent(rawConfig);
    const built = buildCommand({
      prompt: formattedPrompt,
      model: effectiveModel,
      agent: effectiveAgent,
      effort,
      json,
      config: rawConfig,
      binary: target?.bin ?? null,
    });
    const { command, args, engineType } = built;
    briefFile = built.briefFile;

    if (verbose) {
      process.stderr.write(
        `[dispatch] Engine: ${engineType} | Agent: ${effectiveAgent} | Model: ${effectiveModel} | Mode: READ-ONLY | Timeout: ${timeout}s\n`,
      );
    }

    const trace = createTraceWriter(verbose);

    // Steps 8-10: spawn, stream into logger + trace, and resolve on close.
    const result = await spawnOpencode({
      command,
      args,
      settings,
      timeout,
      maxBufferMb,
      json,
      trace,
      sessionLogger,
      sessionLink,
      effectiveModel,
      effectiveAgent,
      engineType,
      briefFile,
      mode: target?.mode ?? null,
      releaseOnce,
    });
    result.formattedPromptForMetrics = formattedPrompt;
    return result;
  } catch (err) {
    // Synchronous throws from Steps 5-8 (denylisted attachment, budget overrun, binary
    // resolution) would otherwise strand both the lockfile and the log file handle.
    releaseOnce();
    failLogger(sessionLogger, err?.message ?? String(err));
    if (typeof formattedPrompt !== 'undefined') err.formattedPromptForMetrics = formattedPrompt;
    throw err;
  } finally {
    removeBriefFile(briefFile);
  }
}

// ============================================================================
// SECTION: Log Lifecycle & Delegate Spawn
// ============================================================================

/**
 * Records a terminal error in the session log before closing it, so a failed run leaves a log
 * explaining itself rather than an empty file. Idempotent per logger: the spawn `error` handler
 * and `runOpencode`'s outer catch both fire on a spawn failure, and only the first should write.
 */
const closedLoggers = new WeakSet();
function failLogger(sessionLogger, message) {
  if (closedLoggers.has(sessionLogger)) return;
  try {
    sessionLogger.write(`\n[dispatch] Error: ${message}\n`);
  } finally {
    closeLogger(sessionLogger);
  }
}

/** Closes a session logger once, so no later path can write to a closed stream. */
function closeLogger(sessionLogger) {
  if (closedLoggers.has(sessionLogger)) return;
  closedLoggers.add(sessionLogger);
  sessionLogger.close();
}

/**
 * Spawns the delegate and settles once — Node emits both `error` and `close` on a spawn
 * failure, so a shared guard keeps the failure path from also emitting a success banner.
 *
 * The subprocess lifecycle (buffering, timers, caps, kill, the error+close settled guard)
 * is shared machinery — `runDelegateCapture` in common.mjs. This function keeps only what
 * is OpenCode-specific: the invocation routing around `spawnCli` (for `cp.spawn` mockability),
 * the immediate stdin close, the arrival-ordered log tail, the `--format json` raw-stdout
 * branch, the last-`Error:`-line surfacing, and GPU-lock/log release on every exit path.
 *
 * @returns {Promise<RunOpencodeResult>}
 */
function spawnOpencode({
  command,
  args,
  settings,
  timeout,
  maxBufferMb,
  json,
  trace,
  sessionLogger,
  sessionLink,
  effectiveModel,
  effectiveAgent,
  engineType,
  briefFile,
  mode,
  releaseOnce,
}) {
  // Arrival-ordered tail of both streams, mirroring the session log's end for diagnostics.
  let logTail = '';

  return runDelegateCapture({
    spawnChild: () => {
      // NOTE: common's invocation builder (not spawnCli) so an npm `.cmd` shim is routed through
      // cmd.exe safely while `cp.spawn` stays mockable in tests.
      const invocation = resolveCliInvocation(command, args, {
        cwd: PROJECT_ROOT,
        env: getOpencodeEnv(settings),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        // Set here rather than inherited from spawnCli (which this deliberately bypasses): without an
        // own process group, a timeout leaves opencode's grandchildren running on POSIX.
        detached: process.platform !== 'win32',
      });
      const child = cp.spawn(invocation.command, invocation.args, invocation.options);

      // Close stdin at once — opencode reads from its flags, not stdin.
      if (child.stdin) {
        child.stdin.end();
      }
      return child;
    },
    timeoutSeconds: timeout,
    maxBufferMb,
    sessionLogger,
    trace,
    onChunk: (_stream, chunk) => {
      logTail = (logTail + chunk.toString('utf8')).slice(-LOG_TAIL_CHARS);
    },
    onFail: (err) => {
      releaseOnce();
      failLogger(sessionLogger, err?.message ?? String(err));
    },
    onClose: (outcome) => {
      releaseOnce();

      // A truncated run still carries most of its analysis; return captured output and let
      // the caller decide whether to use it or cascade.
      const truncated = outcome.truncated;
      if (truncated) {
        process.stderr.write(
          outcome.isTimedOut
            ? `[dispatch] Timed out after ${timeout}s; returning partial output.\n`
            : `[dispatch] Output exceeded ${maxBufferMb}MB cap; returning partial output.\n`,
        );
      }

      const cleanStdout = json ? outcome.stdoutBuffer : extractCleanResponse(outcome.stdoutBuffer);
      const exitCode = resolveRunnerExitCode({
        code: outcome.code,
        signal: outcome.signal,
        truncated,
        cleanStdout,
      });
      let failureKind =
        classifyFailure(`${outcome.stderrBuffer}\n${outcome.stdoutBuffer}`) || (truncated ? truncated : null);

      // opencode can fail with its cause only in the output stream, leaving stderr silent; surface
      // the last `Error:` line so the orchestrator sees why instead of a bare exit code.
      let stderrOut = outcome.stderrBuffer;
      if (exitCode !== 0 && !classifyFailure(outcome.stderrBuffer)) {
        const lastError = findLastErrorLine(logTail);
        if (lastError && !outcome.stderrBuffer.includes(lastError)) {
          stderrOut = outcome.stderrBuffer
            ? `${outcome.stderrBuffer.replace(/\s+$/, '')}\n${lastError}\n`
            : `${lastError}\n`;
          process.stderr.write(`[dispatch] OpenCode reported: ${lastError}\n`);
          failureKind = failureKind || classifyFailure(lastError);
        }
      }

      emitCompletionBanner({
        // NOTE: no opencode session id is captured, so session=/resume= are omitted.
        platform: 'opencode',
        exitCode,
        truncated,
      });

      closeLogger(sessionLogger);

      return {
        provider: 'opencode',
        model: effectiveModel,
        agent: effectiveAgent,
        mode: mode ?? null,
        engineType,
        stdout: cleanStdout,
        rawStdout: outcome.stdoutBuffer,
        stderr: stderrOut,
        exitCode,
        logFile: sessionLogger.logFile,
        briefFile,
        sessionLink,
        truncated,
        failureKind,
      };
    },
  });
}

// ============================================================================
// SECTION: Availability Probe
// ============================================================================

/**
 * Checks if the resolved OpenCode backend is available. A local endpoint (the LM Studio default,
 * or any other loopback-bound backend) gets the existing live HTTP preflight — it stays the more
 * precise probe when it's cheap and safe to run. A remote endpoint degrades to a binary-presence
 * probe instead, mirroring how isClaudeAvailable/isCopilotAvailable/isAgyAvailable already probe
 * reachability via binary discovery rather than an unauthenticated live network call against a
 * paid API.
 * @param {OpencodeSettings} [settings] Pre-resolved settings; defaults to a fresh resolve. Exposed
 *   as a parameter so tests can force the remote branch without mutating global config state.
 * @returns {Promise<boolean>}
 */
export async function isOpencodeAvailable(settings = resolveOpencodeSettings()) {
  try {
    if (settings.isLocal) {
      return await preflightLMStudioCheck(1500, getLMStudioEndpoint(settings));
    }
    return isOpencodeBinaryAvailable();
  } catch {
    return false;
  }
}

// ============================================================================
// SECTION: OpenCode Configuration (opencode.jsonc)
// ============================================================================

/**
 * Recursively merges `overlay` onto `base`: plain objects merge key-by-key, arrays concatenate
 * (base then overlay), and any other value type is overridden by `overlay`. Approximates
 * opencode's own `mergeConfigConcatArrays` without a schema — sufficient for this config's
 * actual shape (`model`, `providers.<name>.*`, `agent.<name>.*`, `compaction`).
 * @param {object|null} base
 * @param {object|null} overlay
 * @returns {object|null}
 */
export function mergeConfigDeep(base, overlay) {
  if (!base) return overlay ?? null;
  if (!overlay) return base;

  const result = { ...base };
  for (const [key, overlayValue] of Object.entries(overlay)) {
    // Config files are untrusted input (read from disk, or from an env-var-supplied path/
    // content); a bracket assignment to these keys would consult Object.prototype's `__proto__`
    // accessor and repoint result's actual prototype rather than setting a plain data property.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const baseValue = result[key];
    if (Array.isArray(baseValue) && Array.isArray(overlayValue)) {
      result[key] = [...baseValue, ...overlayValue];
    } else if (
      baseValue &&
      overlayValue &&
      typeof baseValue === 'object' &&
      typeof overlayValue === 'object' &&
      !Array.isArray(baseValue) &&
      !Array.isArray(overlayValue)
    ) {
      result[key] = mergeConfigDeep(baseValue, overlayValue);
    } else {
      result[key] = overlayValue;
    }
  }
  return result;
}

/**
 * Reads and parses one opencode config file (JSON or JSONC). Returns `null` on a missing,
 * unreadable, unparsable, or denylisted path — every source in the precedence chain is
 * best-effort, matching this file's existing security posture (`SENSITIVE_FILE_PATTERNS`, the
 * same denylist `buildFormattedPrompt` applies when inlining `-f` attachments).
 * @param {string} filePath
 * @returns {object|null}
 */
export function loadConfigFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;

  const baseName = path.basename(filePath);
  for (const pattern of SENSITIVE_FILE_PATTERNS) {
    if (pattern.test(filePath) || pattern.test(baseName)) return null;
  }

  try {
    const parsed = parseJsonc(fs.readFileSync(filePath, 'utf8'));
    return isPlainConfigObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * True for a non-null, non-array object — the only shape `mergeConfigDeep` can safely fold.
 * A top-level array or primitive (`true`, `123`, `"str"`) would otherwise be iterated by
 * `Object.entries` and silently corrupt the merged config with spurious numeric-like keys.
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainConfigObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolves the one OS-specific managed opencode config directory (admin-controlled, per
 * https://opencode.ai/docs/config/#precedence-order tier 7). Resolves the Windows path instead
 * of hardcoding the `%ProgramData%` literal, which Node never expands. `env`/`platform` are
 * parameterized (not read from `process.env`/`process.platform` directly) so tests can point
 * this at an isolated fixture directory instead of the real machine's admin-managed config dir.
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.platform]
 * @returns {string}
 */
export function resolveManagedConfigDir({ env = process.env, platform = process.platform } = {}) {
  if (platform === 'darwin') return '/Library/Application Support/opencode';
  if (platform === 'linux') return '/etc/opencode';
  const programData = env.ProgramData || env.ALLUSERSPROFILE || 'C:\\ProgramData';
  return path.join(programData, 'opencode');
}

/**
 * Builds the ordered list of opencode config file candidates, lowest to highest precedence,
 * matching every locally-readable tier from https://opencode.ai/docs/config/#precedence-order:
 * global, custom (`OPENCODE_CONFIG`), project, `.opencode` directories, and managed (admin).
 * Tier 6 (`OPENCODE_CONFIG_CONTENT`, inline text) and the remote/MDM tiers are not file paths —
 * handled separately by {@link readOpencodeConfig} and excluded respectively (see that
 * function's doc comment).
 * @param {object} params
 * @param {string} params.projectRoot
 * @param {string} params.homeDir
 * @param {NodeJS.ProcessEnv} params.env
 * @returns {string[]}
 */
export function resolveOpencodeConfigSources({ projectRoot, homeDir, env }) {
  const globalConfigDir = path.join(
    env.XDG_CONFIG_HOME || path.join(homeDir, '.config'),
    'opencode',
  );
  const sources = [
    // Tier 2: global.
    path.join(globalConfigDir, 'config.json'),
    path.join(globalConfigDir, 'opencode.json'),
    path.join(globalConfigDir, 'opencode.jsonc'),
    // Tier 3: custom (single path, as opencode itself resolves it).
    env.OPENCODE_CONFIG,
    // Tier 4: project — checked directly, no upward walk (PROJECT_ROOT is already the git
    // worktree root every caller in this script uses, so there is never an intermediate
    // directory to traverse).
    path.join(projectRoot, 'opencode.json'),
    path.join(projectRoot, 'opencode.jsonc'),
    // Tier 5: .opencode directories — home first (broader), then project (more specific), then
    // an explicit OPENCODE_CONFIG_DIR override. Folded after tier 4 (project root), so a
    // personal ~/.opencode/opencode.json(c) outranks a bare project-root opencode.json(c) for
    // repos that haven't migrated to .opencode — an intentional consequence of the doc's own
    // numbered order (project is tier 4, .opencode dirs are tier 5), not an ordering bug here.
    path.join(homeDir, '.opencode', 'opencode.json'),
    path.join(homeDir, '.opencode', 'opencode.jsonc'),
    path.join(projectRoot, '.opencode', 'opencode.json'),
    path.join(projectRoot, '.opencode', 'opencode.jsonc'),
  ];

  if (env.OPENCODE_CONFIG_DIR) {
    sources.push(
      path.join(env.OPENCODE_CONFIG_DIR, 'opencode.json'),
      path.join(env.OPENCODE_CONFIG_DIR, 'opencode.jsonc'),
    );
  }

  return sources.filter(Boolean);
}

/**
 * Reads and merges opencode configuration across every locally-readable source, in the exact
 * precedence order documented at https://opencode.ai/docs/config/#precedence-order (later
 * folds override earlier ones for scalar fields; array fields concatenate):
 *
 *   global → custom (`OPENCODE_CONFIG`) → project → `.opencode` dirs →
 *   inline (`OPENCODE_CONFIG_CONTENT`) → managed (admin)
 *
 * Two tiers are excluded by design, not oversight:
 * - **Remote config** (`.well-known/opencode`): requires an outbound fetch to an arbitrary
 *   remote origin, which conflicts with this runner's WAN-confinement model (`getOpencodeEnv`
 *   proxy-traps all outbound WAN for the delegate; the orchestrator process resolving its own
 *   config shouldn't open a network path the delegate itself is denied).
 * - **macOS MDM `.mobileconfig`**: a binary/plist profile read via `CFPreferences`, not a JSON
 *   file on a documented path — no reasonable cross-platform Node implementation.
 *
 * The managed tier (tier 7) is a local, read-only filesystem read, so it's included; a missing
 * or unreadable managed directory (the common case without MDM) is silently skipped, same as
 * every other optional source.
 *
 * `homeDir` and `env` are parameterized rather than read from `os.homedir()` / `process.env`
 * directly, so callers (and tests) can isolate every tier from the real machine's config.
 *
 * @param {string} [projectRoot]
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.homeDir]
 * @param {string} [options.managedConfigDir] Overrides {@link resolveManagedConfigDir}'s result —
 *   lets tests isolate the managed tier from the real machine's admin-managed config dir.
 * @returns {object|null}
 */
export function readOpencodeConfig(
  projectRoot = PROJECT_ROOT,
  { env = process.env, homeDir = os.homedir(), managedConfigDir = resolveManagedConfigDir({ env }) } = {},
) {
  let merged = null;

  for (const filePath of resolveOpencodeConfigSources({ projectRoot, homeDir, env })) {
    merged = mergeConfigDeep(merged, loadConfigFile(filePath));
  }

  if (env.OPENCODE_CONFIG_CONTENT) {
    try {
      const inline = parseJsonc(env.OPENCODE_CONFIG_CONTENT);
      if (isPlainConfigObject(inline)) {
        merged = mergeConfigDeep(merged, inline);
      }
    } catch {}
  }

  merged = mergeConfigDeep(merged, loadConfigFile(path.join(managedConfigDir, 'opencode.json')));
  merged = mergeConfigDeep(merged, loadConfigFile(path.join(managedConfigDir, 'opencode.jsonc')));

  return merged;
}

/**
 * Resolves the default agent identifier from opencode config or fallback.
 * Checks for a configured `plan` agent, then an agent with `mode === 'primary'`,
 * then the first declared agent, falling back to {@link DEFAULT_FALLBACK_AGENT} ('plan').
 * @param {object|null} [config] Pre-parsed opencode config; defaults to a fresh read.
 * @returns {string}
 */
export function resolveDefaultAgent(config = readOpencodeConfig()) {
  if (config && config.agent && typeof config.agent === 'object') {
    if (config.agent.plan) {
      return 'plan';
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
 * Resolves the default model identifier from opencode config. Returns `null` when
 * `opencode.jsonc` sets no model anywhere — dispatch no longer assumes LM Studio in
 * that case; opencode's own CLI default applies instead (no `-m` flag is passed).
 * @param {object|null} [config] Pre-parsed opencode config; defaults to a fresh read.
 * @returns {string|null}
 */
export function resolveDefaultModel(config = readOpencodeConfig()) {
  if (config && config.model) {
    if (config.providers) {
      for (const key of Object.keys(config.providers)) {
        if (config.providers[key]?.models?.[config.model] && !config.model.startsWith(`${key}/`)) {
          return `${key}/${config.model}`;
        }
      }
    }
    return config.model;
  }
  return null;
}

/**
 * True when `host` is a loopback address the local machine binds a server to — the basis for
 * every preflight/lock/WAN-confinement branch below. Covers the documented set (`localhost`,
 * `::1`, `0.0.0.0`) plus the full IPv4 loopback block (127.0.0.0/8, not just `127.0.0.1`): RFC
 * 3330 reserves all of `127.*.*.*` for loopback, and a self-hosted OpenAI-compatible server may
 * bind any address in that range.
 * @param {string|null|undefined} host
 * @returns {boolean}
 */
export function isLocalEndpointHost(host) {
  if (!host) return false;
  // `new URL(...).hostname` keeps the brackets on an IPv6 literal (e.g. '[::1]'); strip them
  // before comparing so 'http://[::1]:1234/v1' is recognized as loopback.
  const unbracketed = host.replace(/^\[|\]$/g, '');
  return (
    unbracketed === 'localhost' ||
    unbracketed === '::1' ||
    unbracketed === '0.0.0.0' ||
    // `startsWith('127.')` alone would also match a domain name like '127.example.com'; require
    // a real dotted-quad IPv4 address in the loopback block, not just a matching string prefix.
    (net.isIPv4(unbracketed) && unbracketed.startsWith('127.'))
  );
}

/**
 * Resolves full settings from opencode.jsonc / opencode.json with environment variable overrides.
 * Pass a pre-read config to avoid re-parsing the file.
 *
 * Locality (`isLocal`) is decided by whether the resolved endpoint host is a loopback address,
 * not by `providerName === 'lmstudio'` — a self-hosted OpenAI-compatible server behind a
 * different provider key is still local, and a remote LM-Studio-labelled provider key pointed at
 * a public host is still remote. The LM-Studio-shaped default (`host`/`port`/`pathname` filled
 * in, `isLocal: true`) only applies when nothing explicit set a `baseURL` *and* the resolved
 * provider is `lmstudio` — for any other provider with no explicit `baseURL` (a cloud provider
 * relying on opencode's own built-in endpoint registry, e.g. `anthropic`, `openai`,
 * `openrouter`), this script has no way to know that provider's real endpoint and must not guess
 * `127.0.0.1`, so `host`/`port`/`pathname` stay `null` and `isLocal` is `false`.
 *
 * @param {object|null} [config] Pre-parsed opencode config; defaults to a fresh read.
 * @returns {OpencodeSettings}
 */
export function resolveOpencodeSettings(config = readOpencodeConfig()) {
  const parsed = config || {};
  // No `model` anywhere leaves providerName/modelKey null — dispatch no longer assumes
  // LM Studio in that case; opencode's own CLI default applies (no `-m` flag, no host guess).
  const rawModel = parsed.model || null;
  let providerName = rawModel ? 'lmstudio' : null;
  let modelKey = rawModel;

  if (rawModel && rawModel.includes('/')) {
    const parts = rawModel.split('/');
    providerName = parts[0];
    modelKey = parts.slice(1).join('/');
  } else if (rawModel && parsed.providers) {
    // A bare model name (no provider/ prefix) may still be declared under a specific provider's
    // `models` map — mirrors resolveDefaultModel's own prefix inference, so settings resolve the
    // same provider that model would actually run under.
    const matchedProvider = Object.keys(parsed.providers).find(
      (key) => parsed.providers[key]?.models?.[rawModel],
    );
    if (matchedProvider) {
      providerName = matchedProvider;
    }
  }

  const providerConfig = providerName ? parsed.providers?.[providerName] || {} : {};
  const explicitBaseURLValue =
    process.env.LM_STUDIO_URL || providerConfig.settings?.baseURL || null;
  const explicitBaseURL = Boolean(explicitBaseURLValue);
  const isLmStudioDefault = !explicitBaseURL && providerName === 'lmstudio';

  const baseURL = explicitBaseURL
    ? explicitBaseURLValue
    : isLmStudioDefault
      ? `http://${DEFAULT_LM_STUDIO_HOST}:${DEFAULT_LM_STUDIO_PORT}/v1`
      : null;

  const modelConfig = providerConfig.models?.[modelKey] || {};
  const contextLimit = modelConfig.limit?.context || DEFAULT_CONTEXT_LIMIT;
  const outputLimit = modelConfig.limit?.output || DEFAULT_OUTPUT_LIMIT;

  // Pass the already-read config to avoid re-reading the file.
  const defaultAgentKey = resolveDefaultAgent(parsed);
  const reasoningEffort =
    modelConfig.settings?.reasoningEffort || modelConfig.settings?.reasoning_effort || null;

  let host = null;
  let port = null;
  let pathname = null;
  let protocol = null;
  let isLocal = false;

  if (isLmStudioDefault) {
    host = DEFAULT_LM_STUDIO_HOST;
    port = DEFAULT_LM_STUDIO_PORT;
    pathname = '/v1';
    protocol = 'http:';
    isLocal = true;
  } else if (explicitBaseURL) {
    try {
      const parsedUrl = new URL(baseURL);
      host = parsedUrl.hostname;
      protocol = parsedUrl.protocol;
      // An explicit baseURL with no port (e.g. 'https://api.openai.com/v1') must default to the
      // scheme's standard port, not the LM Studio port — 1234 is meaningless for a remote host.
      port = parsedUrl.port
        ? parseInt(parsedUrl.port, 10)
        : protocol === 'https:'
          ? 443
          : 80;
      pathname = parsedUrl.pathname || '/v1';
      isLocal = isLocalEndpointHost(host);
    } catch {
      // Malformed explicit baseURL: treat like an unknown remote endpoint rather than guessing.
      host = null;
      port = null;
      pathname = null;
      isLocal = false;
    }
  }
  // Else: cloud provider relying on opencode's own endpoint registry — host/port/pathname stay
  // null, isLocal stays false.

  return {
    rawModel,
    modelId: modelKey,
    providerName,
    baseURL,
    contextLimit,
    outputLimit,
    reasoningEffort,
    agentKey: defaultAgentKey,
    host,
    port,
    pathname,
    protocol,
    isLocal,
  };
}

// ============================================================================
// SECTION: LM Studio Preflight & Diagnosis
// ============================================================================

/**
 * Returns the LM Studio endpoint, preferring LM_STUDIO_HOST/PORT/PATH env overrides.
 * Pass pre-resolved settings to avoid re-parsing the config file.
 * @param {OpencodeSettings} [settings] Pre-resolved settings; defaults to a fresh resolve.
 * @returns {LMStudioEndpoint}
 */
export function getLMStudioEndpoint(settings) {
  // Direct env overrides take precedence over the URL parsed from opencode.jsonc.
  if (process.env.LM_STUDIO_HOST && process.env.LM_STUDIO_PORT) {
    return {
      host: process.env.LM_STUDIO_HOST,
      port: parseInt(process.env.LM_STUDIO_PORT, 10),
      pathname: process.env.LM_STUDIO_PATH || '/v1',
      // The env override carries no scheme, so plain http is the only thing it can mean.
      protocol: 'http:',
    };
  }
  const s = settings ?? resolveOpencodeSettings();
  // `protocol` is null when no host was resolved at all; every caller below speaks http by default.
  return { host: s.host, port: s.port, pathname: s.pathname, protocol: s.protocol ?? 'http:' };
}

/**
 * Pings the LM Studio endpoint to verify the server is reachable.
 * @param {number} [timeoutMs]
 * @param {LMStudioEndpoint} [endpoint] Pre-resolved endpoint; defaults to a fresh resolve.
 * @returns {Promise<boolean>}
 */
export async function preflightLMStudioCheck(timeoutMs = 2000, endpoint) {
  const ep = endpoint ?? getLMStudioEndpoint();
  // No resolvable endpoint (no model configured) means nothing to probe, not a crash.
  if (!ep?.host || !ep?.pathname) return false;
  const targetPath = ep.pathname.replace(/\/+$/, '') + '/models';

  const agent = ep.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const req = agent.get(
      {
        host: ep.host,
        port: ep.port,
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
 * Interprets an LM Studio `/api/v0/models` body. Returns the no-loaded-model warning only when
 * the body parses to a model list in which no entry has `state === 'loaded'`; anything else
 * (unparseable, unexpected shape, a loaded model) returns null.
 * @param {string} body
 * @returns {string|null}
 */
export function describeLMStudioModelState(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const models = Array.isArray(parsed?.data) ? parsed.data : null;
  if (!models) return null;
  return models.some((m) => m && m.state === 'loaded') ? null : LM_STUDIO_NO_LOADED_MODEL_WARNING;
}

/**
 * Asks LM Studio's v0 REST API whether any model is loaded. Never fails the run: a non-2xx,
 * timeout, network error, or unparseable body resolves null (older LM Studio lacks `/api/v0`).
 * @param {LMStudioEndpoint} endpoint
 * @param {number} [timeoutMs]
 * @returns {Promise<string|null>} warning text, or null
 */
export function checkLMStudioLoadedModel(endpoint, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let req;
    try {
      req = (endpoint.protocol === 'https:' ? https : http).get(
        { host: endpoint.host, port: endpoint.port, path: '/api/v0/models', timeout: timeoutMs },
        (res) => {
          if (!res || res.statusCode < 200 || res.statusCode >= 300 || typeof res.on !== 'function') {
            if (res && typeof res.resume === 'function') res.resume();
            resolve(null);
            return;
          }
          let body = '';
          res.setEncoding?.('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => resolve(describeLMStudioModelState(body)));
          res.on('error', () => resolve(null));
        },
      );
    } catch {
      resolve(null);
      return;
    }
    req.on?.('timeout', () => {
      req.destroy?.();
      resolve(null);
    });
    req.on?.('error', () => resolve(null));
  });
}

/**
 * Returns the last line carrying an `Error:` marker (ANSI colour stripped), or null.
 * @param {string} text
 * @returns {string|null}
 */
export function findLastErrorLine(text) {
  if (!text) return null;
  const lines = text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /\bError:/.test(l));
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

// ============================================================================
// SECTION: Process Safety — GPU Lock & Sanitized Environment
// ============================================================================

/**
 * Acquires a cross-process lock to prevent GPU memory thrashing from concurrent invocations.
 * @param {number} [maxWaitMs]
 * @param {number} [pollIntervalMs]
 * @returns {() => void} Release function.
 */
export function acquireLock(maxWaitMs = GPU_LOCK_MAX_WAIT_MS, pollIntervalMs = GPU_LOCK_POLL_MS) {
  const lockDir = os.tmpdir();
  const lockFile = path.join(lockDir, GPU_LOCK_FILE_NAME);
  const startTime = Date.now();

  while (fs.existsSync(lockFile)) {
    try {
      const stats = fs.statSync(lockFile);
      // Treat a lockfile older than GPU_LOCK_STALE_MS as stale from a crashed process.
      if (Date.now() - stats.mtimeMs > GPU_LOCK_STALE_MS) {
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
    // If creation failed due to a race, proceed anyway.
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
 * Builds the sanitized environment for the OpenCode delegate with proxy trapping and
 * whitelist filtering.
 *
 * Extends the shared {@link SAFE_ENV_WHITELIST} with {@link OPENCODE_EXTRA_ENV_ALLOWLIST}
 * and layers WAN proxy-trapping on top so the delegate can reach local LM Studio but
 * nothing on the external network. The predicate is a rejection filter:
 * `isWhitelisted && !SENSITIVE_ENV_KEY_PATTERN.test(key)`.
 *
 * @param {OpencodeSettings} [settings] Pre-resolved settings; defaults to a fresh resolve.
 * @returns {NodeJS.ProcessEnv}
 */
export function getOpencodeEnv(settings) {
  const s = settings ?? resolveOpencodeSettings();

  const cleanEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const isWhitelisted = SAFE_ENV_WHITELIST.has(key) || OPENCODE_EXTRA_ENV_ALLOWLIST.has(key);
    if (isWhitelisted && !SENSITIVE_ENV_KEY_PATTERN.test(key)) {
      cleanEnv[key] = value;
    }
  }

  // Network proxy trapping only applies to a local backend: local dispatch has no legitimate
  // reason to reach WAN at all, so trapping it behind a dead 127.0.0.1:0 proxy (with only the
  // local endpoint NO_PROXY-exempted) is safe. A remote provider's entire purpose is reaching
  // WAN — trapping it behind a NO_PROXY exemption whose enforcement this script can't verify
  // across every HTTP client opencode's provider SDKs use would be the wrong shape, so this
  // function sets no proxy variable for a remote/unknown-host provider: it inherits whatever
  // ambient proxy the whitelist passed through (a corporate proxy it may need to traverse),
  // matching how claude-run.mjs/agy-run.mjs/copilot-run.mjs let their delegates reach their
  // own service unimpeded.
  if (s.isLocal) {
    const endpoint = getLMStudioEndpoint(s);
    const localHosts = `127.0.0.1,localhost,127.0.0.1:${endpoint.port},localhost:${endpoint.port},${endpoint.host},${endpoint.host}:${endpoint.port},::1`;

    cleanEnv.NO_PROXY = localHosts;
    cleanEnv.no_proxy = localHosts;
    // Every proxy-shaped whitelisted key is overwritten, derived from the whitelist rather than
    // re-listed here: SAFE_ENV_WHITELIST passes the user's real proxy through, so a name added
    // there later (FTP_PROXY, GRPC_PROXY) must not silently restore WAN reachability for a
    // local run. NO_PROXY above is set first and excluded — it is the exemption, not a trap.
    for (const key of [...SAFE_ENV_WHITELIST, ...OPENCODE_EXTRA_ENV_ALLOWLIST]) {
      if (/_PROXY$/i.test(key) && !/^NO_PROXY$/i.test(key)) {
        cleanEnv[key] = 'http://127.0.0.1:0';
      }
    }
  }

  return cleanEnv;
}

// ============================================================================
// SECTION: Command Construction
// ============================================================================

/**
 * Probes for the opencode binary on PATH: `where.exe` on Windows, `which` elsewhere. Shared by
 * {@link resolveOpencodeBinary} (needs the resolved path, to avoid `shell: true`) and
 * {@link isOpencodeBinaryAvailable} (needs only a yes/no availability signal), so the two don't
 * duplicate this discovery.
 * @returns {string|null} The resolved absolute path, or null if not found.
 */
function probeOpencodeOnPath() {
  const lookupCommand = process.platform === 'win32' ? 'where.exe' : 'which';
  const res = cp.spawnSync(lookupCommand, ['opencode'], { encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout.trim()) return null;

  const lines = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // [OS: Windows] An npm global install lists the extensionless POSIX shim first, which cannot be
  // spawned; prefer a real .exe, then a .cmd/.bat launcher (spawned safely through cmd.exe).
  if (process.platform === 'win32') {
    return (
      lines.find((l) => /\.exe$/i.test(l)) ||
      lines.find((l) => /\.(?:cmd|bat)$/i.test(l)) ||
      lines[0] ||
      null
    );
  }
  return lines[0] || null;
}

/**
 * Resolves the opencode binary's absolute path on PATH (any platform) to avoid shell: true;
 * falls back to the bare command name when it can't be resolved.
 * @returns {string}
 */
export function resolveOpencodeBinary() {
  return resolveOpencodeTarget()?.bin ?? 'opencode';
}

/**
 * Cross-platform binary-presence probe: true when any mode (cli > desktop > vscode) resolves an
 * executable. Used to degrade {@link isOpencodeAvailable} for a remote provider, mirroring how
 * isClaudeAvailable/isCopilotAvailable/isAgyAvailable already probe reachability via binary
 * discovery rather than a live network call.
 * @returns {boolean}
 */
export function isOpencodeBinaryAvailable() {
  return resolveOpencodeTarget() !== null;
}

// ============================================================================
// SECTION: Binary Mode Discovery (cli > desktop > vscode)
// ============================================================================

/**
 * Mode 1: standalone OpenCode CLI on PATH. The historical discovery path, unchanged —
 * `where.exe` on Windows (preferring a real .exe, then a .cmd/.bat launcher), `which` elsewhere.
 * @returns {string|null}
 */
export function getOpencodeCliBinary() {
  return probeOpencodeOnPath();
}

/**
 * Collects the executable files directly inside `dir` whose names match `pattern`, as full paths.
 * `findFirstExistingFile` does literal existence checks only (no glob expansion), so candidate
 * builders must enumerate directories and hand over concrete paths.
 * @param {string} dir
 * @param {RegExp} pattern
 * @returns {string[]}
 */
function listMatchingExecutables(dir, pattern) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && pattern.test(entry.name))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/** Sidecar naming used by the desktop app's bundled CLI (Tauri external-bin convention). */
const OPENCODE_SIDECAR_PATTERN = /^opencode-cli-.*\.(exe|cmd|bat)$/i;
const OPENCODE_SIDECAR_PATTERN_POSIX = /^opencode-cli-/;

/**
 * Gathers candidate executable paths for the OpenCode Desktop application's bundled CLI.
 * The desktop app embeds the `opencode` CLI binary as a sidecar and runs it as a child process;
 * the desktop's own main binary (a GUI shell, sometimes itself named `opencode.exe` on Windows)
 * is NOT headless-capable and is never a candidate — only `resources\`/`bin\` subpaths are
 * probed, never the install root.
 *
 * Branching by Operating System:
 * - Windows (win32): `%LOCALAPPDATA%\OpenCode` and `%LOCALAPPDATA%\Programs\OpenCode`
 *   (Electron-builder NSIS layout) — `resources\bin`, `resources`, and `bin` subdirectories,
 *   plus version dirs scanned with `scanVersionDirs`.
 * - macOS (darwin): `/Applications/OpenCode.app` and `~/Applications/OpenCode.app` —
 *   `Contents/Resources/bin`, `Contents/Resources` sidecars, and the `app.asar.unpacked` bin shape.
 * - Linux (linux): `/opt/opencode-desktop/resources` (nix layout), `~/.local/share/opencode-desktop`,
 *   and `~/.local/share/OpenCode`.
 *
 * @returns {string[]} Ordered array of candidate paths (concrete paths only, no globs)
 */
export function getOpencodeDesktopCandidates() {
  const homeDir = os.homedir();
  const candidates = [];
  const isWin = process.platform === 'win32';
  const sidecarPattern = isWin ? OPENCODE_SIDECAR_PATTERN : OPENCODE_SIDECAR_PATTERN_POSIX;
  const cliNames = isWin ? ['opencode.exe', 'opencode.cmd', 'opencode.bat'] : ['opencode'];

  const pushDir = (dir) => {
    for (const name of cliNames) candidates.push(path.join(dir, name));
    candidates.push(...listMatchingExecutables(dir, sidecarPattern));
  };

  // [OS: Windows] Only `resources\`/`bin\` subpaths are probed — never a directory root itself,
  // where the GUI shell (sometimes itself named `opencode.exe`, matched case-insensitively on
  // NTFS) would be mis-resolved as the CLI. This includes version dirs: scanVersionDirs returns
  // EVERY subdirectory (no version-shape filter), and a version dir can be an install root
  // (Squirrel `app-<ver>` layout), so each one is only probed through its subpaths.
  const pushDirTree = (rootDir) => {
    for (const sub of ['resources\\bin', 'resources', 'bin']) {
      pushDir(path.join(rootDir, sub));
    }
  };

  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      for (const root of [
        path.join(localAppData, 'OpenCode'),
        path.join(localAppData, 'Programs', 'OpenCode'),
      ]) {
        pushDirTree(root);
        for (const ver of scanVersionDirs(root)) {
          pushDirTree(path.join(root, ver));
        }
      }
    }
  }

  if (process.platform === 'darwin') {
    for (const app of ['/Applications/OpenCode.app', path.join(homeDir, 'Applications/OpenCode.app')]) {
      const resources = path.join(app, 'Contents', 'Resources');
      pushDir(path.join(resources, 'bin'));
      pushDir(resources);
      pushDir(path.join(resources, 'app.asar.unpacked', 'bin'));
    }
  }

  if (process.platform === 'linux') {
    for (const root of [
      '/opt/opencode-desktop/resources',
      path.join(homeDir, '.local/share/opencode-desktop'),
      path.join(homeDir, '.local/share/OpenCode'),
    ]) {
      pushDir(path.join(root, 'bin'));
      pushDir(root);
    }
  }

  return candidates;
}

/**
 * Returns the first candidate that exists AND is executable, advancing past non-executable
 * namesakes instead of aborting on the first existing hit (`findFirstExistingFile` checks
 * existence only, so one unexecutable data file sharing the CLI's name would otherwise mask a
 * valid sidecar later in the list). `isExecutableFile` stats through symlinks, matching the
 * symlink acceptance in `listMatchingExecutables`.
 * @param {string[]} candidates
 * @returns {string|null}
 */
function firstExecutableCandidate(candidates) {
  for (const candidate of candidates) {
    if (candidate && isExecutableFile(candidate)) return path.resolve(candidate);
  }
  return null;
}

/**
 * Resolves the OpenCode Desktop application's bundled CLI binary.
 * @returns {string|null} Path to the sidecar CLI executable, or null if not found.
 */
export function getOpencodeDesktopBinary() {
  return firstExecutableCandidate(getOpencodeDesktopCandidates());
}

/**
 * Gathers candidate executable paths for the OpenCode VS Code extensions
 * (`sst-dev.opencode`, `sst-dev.opencode-v2`). The publisher-id prefix is anchored so an
 * unrelated extension directory can never match, and candidate binary names are exact
 * (`opencode`, `opencode.exe`, `opencode.cmd`) rather than prefix globs. Current released
 * extensions spawn the CLI from PATH and bundle no binary, so this list is usually empty —
 * the mode exists so a future bundled-binary version is discovered without another change.
 *
 * Scans `~/.vscode/extensions`, `~/.vscode-insiders/extensions`, `~/.vscode-server/extensions`,
 * and `~/.cursor/extensions` (newest extension version first), probing `bin/`, `resources/bin/`,
 * and `dist/` inside each matching extension directory.
 *
 * @returns {string[]} Ordered array of candidate paths (concrete paths only, no globs)
 */
export function getOpencodeVscodeCandidates() {
  const homeDir = os.homedir();
  const candidates = [];
  const isWin = process.platform === 'win32';
  const cliNames = isWin ? ['opencode.exe', 'opencode.cmd'] : ['opencode'];
  const extBaseDirs = [
    path.join(homeDir, '.vscode', 'extensions'),
    path.join(homeDir, '.vscode-insiders', 'extensions'),
    path.join(homeDir, '.vscode-server', 'extensions'),
    path.join(homeDir, '.cursor', 'extensions'),
  ];

  for (const extBase of extBaseDirs) {
    if (!fs.existsSync(extBase)) continue;
    let entries;
    try {
      entries = fs.readdirSync(extBase, { withFileTypes: true });
    } catch {
      continue;
    }
    const extNames = entries
      .filter(
        (entry) => entry.isDirectory() && /^sst-dev\.opencode(?:-v2)?-/i.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));

    for (const extName of extNames) {
      for (const sub of ['bin', path.join('resources', 'bin'), 'dist']) {
        for (const name of cliNames) {
          candidates.push(path.join(extBase, extName, sub, name));
        }
      }
    }
  }

  return candidates;
}

/**
 * Resolves the OpenCode VS Code extension's bundled CLI binary.
 * @returns {string|null} Path to the bundled executable, or null (the norm today).
 */
export function getOpencodeVscodeBinary() {
  return firstExecutableCandidate(getOpencodeVscodeCandidates());
}

/**
 * Pure cascade core: iterates mode definitions in priority order and returns the first target
 * with a resolvable binary, or null. Unit-testable with fabricated resolvers — no filesystem
 * access of its own.
 * @param {OpencodeModeDefinition[]} definitions
 * @returns {OpencodeTarget|null}
 */
export function resolveTargetFrom(definitions) {
  for (const candidate of definitions) {
    const bin = candidate.fn();
    if (bin) {
      return { mode: candidate.mode, name: candidate.name, bin };
    }
  }
  return null;
}

// Per-process resolution memo: `undefined` = not yet resolved, a target = first successful
// unpinned resolution, `null` = every mode missed. Caching the negative result too keeps the
// (common) no-opencode machine off repeated `which`/`where.exe` probes and extension-dir scans
// across `cascadeModels`' per-model re-entry; dispatch processes are short-lived, so a
// mid-process install going unnoticed until the next process is an accepted trade-off.
// `_resetOpencodeTargetCache()` is the test seam.
let cachedOpencodeTarget;

/**
 * Resolves the active OpenCode execution target in discovery priority order
 * (cli > desktop > vscode), or for one pinned mode. Unpinned results are memoized per process
 * (see {@link _resetOpencodeTargetCache}); a pinned lookup never touches the cache.
 * @param {OpencodeMode|string|null} [preferredMode] Pin resolution to one mode (case-insensitive).
 * @returns {OpencodeTarget|null}
 */
export function resolveOpencodeTarget(preferredMode = null) {
  const normalized = preferredMode ? String(preferredMode).toLowerCase() : null;
  if (!normalized && cachedOpencodeTarget !== undefined) {
    if (!cachedOpencodeTarget) return null;
    // Staleness re-check: a long-lived process surviving an uninstall must not keep returning a
    // dead path; a vanished binary re-resolves (cheap existsSync, no re-probe while it lives).
    try {
      if (fs.existsSync(cachedOpencodeTarget.bin)) return cachedOpencodeTarget;
    } catch {}
    cachedOpencodeTarget = undefined;
  }
  const candidates = normalized
    ? OPENCODE_MODE_DEFINITIONS.filter((m) => m.mode === normalized)
    : OPENCODE_MODE_DEFINITIONS;
  const target = resolveTargetFrom(candidates);
  // Cache both outcomes: a target (with the staleness re-check above) or null, so the
  // no-opencode machine stops re-probing and re-scanning on every call and model attempt. The
  // negative branch accepts the same mid-process-install trade-off stated in the cache comment.
  if (!normalized) cachedOpencodeTarget = target;
  return target;
}

/** Test seam: clears the per-process target memoization. */
export function _resetOpencodeTargetCache() {
  cachedOpencodeTarget = undefined;
}

/**
 * opencode's writable state dirs (XDG data/cache/state, each with an `opencode` leaf). Pure: takes
 * `home`/`env` and joins with POSIX separators, since only the Linux bwrap sandbox consumes it.
 * @param {{ home: string, env?: NodeJS.ProcessEnv }} params
 * @returns {string[]}
 */
export function resolveOpencodeStateDirs({ home, env = {} }) {
  return [
    path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share'), 'opencode'),
    path.posix.join(env.XDG_CACHE_HOME || path.posix.join(home, '.cache'), 'opencode'),
    path.posix.join(env.XDG_STATE_HOME || path.posix.join(home, '.local', 'state'), 'opencode'),
  ];
}

/**
 * Builds the Linux bwrap argv wrapping `opencode <opencodeArgs>`. Pure (no fs access) and
 * POSIX-path based, so it is testable on any OS. Mount order matters — later mounts win:
 * read-only root, fresh /tmp and /run, the project read-only, out-of-project attachments, then
 * the brief file's directory re-bound read-only (the /tmp tmpfs would otherwise hide it), and
 * finally opencode's own state dirs writable (callers must create them first).
 *
 * @param {object} params
 * @param {string[]} params.opencodeArgs
 * @param {string} [params.binary] Binary argv entry following `--chdir`; defaults to the bare
 *   `'opencode'` (PATH-resolved inside the sandbox). Callers threading a discovered absolute
 *   path (desktop/vscode sidecar) pass it here — it stays reachable via the `--ro-bind / /`
 *   root mount, provided it does not live under a tmpfs overlay (`/tmp`, `/run`); the candidate
 *   lists never place a sidecar there.
 * @param {string[]} [params.files]
 * @param {string|null} [params.briefFile]
 * @param {string} params.projectRoot
 * @param {string} params.home
 * @param {NodeJS.ProcessEnv} [params.env]
 * @returns {string[]}
 */
export function buildBwrapArgs({
  opencodeArgs,
  files = [],
  briefFile = null,
  projectRoot,
  home,
  env = {},
  binary = 'opencode',
}) {
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

  bwrapArgs.push('--ro-bind', projectRoot, projectRoot);

  // POSIX equivalent of common's isPathInside: a bare prefix test would treat a sibling like
  // `<root>-other` as inside and skip binding it.
  const isInsideProject = (f) => {
    const rel = path.posix.relative(projectRoot, path.posix.resolve(projectRoot, f));
    return rel === '' || (!rel.startsWith('..') && !path.posix.isAbsolute(rel));
  };
  for (const f of files) {
    if (!isInsideProject(f)) {
      bwrapArgs.push('--ro-bind', f, f);
    }
  }

  if (briefFile) {
    const briefDir = path.posix.dirname(briefFile);
    bwrapArgs.push('--ro-bind', briefDir, briefDir);
  }

  for (const dir of resolveOpencodeStateDirs({ home, env })) {
    bwrapArgs.push('--bind', dir, dir);
  }

  bwrapArgs.push('--chdir', projectRoot);
  bwrapArgs.push(binary, ...opencodeArgs);
  return bwrapArgs;
}

/**
 * Constructs the execution command and arguments for OpenCode or Linux bwrap.
 * @param {object} [params]
 * @param {string} [params.prompt]
 * @param {string[]} [params.files]
 * @param {string|null} [params.model]
 * @param {string|null} [params.agent]
 * @param {string|null} [params.effort] Folded into the model as `<model>#<effort>` when a model
 *   is resolvable; dropped with a stderr note when it is not (opencode v2 has no standalone
 *   effort flag to fall back to).
 * @param {boolean} [params.json]
 * @param {object|null} [params.config] Config `runOpencode` already parsed; passing it keeps the
 *   single parse threaded through, instead of re-reading and re-merging the tiers from disk here.
 * @param {string|null} [params.binary] Pre-resolved delegate binary (the discovered target's
 *   absolute path, threaded from `runOpencodeSingle`); falls back to {@link resolveOpencodeBinary}
 *   when omitted.
 */
export function buildCommand({
  prompt = '',
  files = [],
  model = null,
  agent = null,
  effort = null,
  json = false,
  config = null,
  binary = null,
} = {}) {
  const isLinux = process.platform === 'linux';
  const checkBwrap = isLinux ? cp.spawnSync('which', ['bwrap'], { encoding: 'utf8' }) : null;
  const hasLinuxBwrap = checkBwrap && checkBwrap.status === 0 && checkBwrap.stdout.trim();

  // Resolved before the prompt is prepared: a Windows .cmd shim forces a brief-file spill.
  let effectiveBinary = binary ?? (hasLinuxBwrap ? 'opencode' : resolveOpencodeBinary());
  // [OS: Linux] A discovered absolute path under a tmpfs overlay (/tmp, /run are --tmpfs mounts)
  // is unreachable inside the bwrap sandbox; fall back to the bare name, which PATH-resolves
  // inside the sandbox as before the absolute-path threading was introduced. Known limitation:
  // the literal-prefix check misses paths only reachable via symlinks (e.g. /var/run) or a
  // TMPDIR-relocated install; realpath comparison was rejected because the candidate may not
  // exist yet at this point.
  if (hasLinuxBwrap && effectiveBinary && /^(?:\/tmp|\/run)\//.test(effectiveBinary)) {
    effectiveBinary = 'opencode';
  }

  const finalFormattedPrompt =
    prompt.includes('[SECURITY GUARDRAIL - READ-ONLY CONSTRAINTS]')
      ? prompt
      : buildFormattedPrompt(prompt, files);
  const { prompt: argvPrompt, briefFile } = preparePromptForArgv(finalFormattedPrompt, 'opencode', {
    binary: effectiveBinary,
  });
  // NOTE: accepted risk — headless runs cannot answer permission prompts, so `--auto` stays;
  // read-only on macOS/Windows rests on the prompt guardrail. opencode v2 argv never includes
  // `--pure` or `--variant` — v1-only flags, dropped entirely rather than translated.
  const opencodeArgs = ['run', '--auto'];

  const effectiveAgent = agent || (config ? resolveDefaultAgent(config) : resolveDefaultAgent());
  if (effectiveAgent) {
    opencodeArgs.push('--agent', effectiveAgent);
  }

  const effectiveModel = model || (config ? resolveDefaultModel(config) : resolveDefaultModel());
  if (effectiveModel) {
    // v2 has no standalone effort flag — reasoning effort folds into the model spec itself.
    opencodeArgs.push('-m', effort ? `${effectiveModel}#${effort}` : effectiveModel);
  } else if (effort) {
    // No model to fold the effort into and no flag to pass it as standalone; surface the drop
    // rather than silently discarding it.
    process.stderr.write(
      `[dispatch] WARNING: effort '${effort}' has no resolvable model to fold into; dropping.\n`,
    );
  }

  if (json) {
    opencodeArgs.push('--format', 'json');
  }

  opencodeArgs.push('--', argvPrompt);

  if (hasLinuxBwrap) {
    const home = os.homedir();
    const env = process.env;
    // bwrap cannot bind a missing source, and opencode needs these writable on first run.
    for (const dir of resolveOpencodeStateDirs({ home, env })) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {}
    }
    const bwrapArgs = buildBwrapArgs({
      opencodeArgs,
      files,
      briefFile,
      projectRoot: PROJECT_ROOT,
      home,
      env,
      binary: effectiveBinary,
    });

    return { command: 'bwrap', args: bwrapArgs, engineType: 'linux-bwrap', briefFile };
  }

  return {
    command: effectiveBinary,
    args: opencodeArgs,
    engineType: 'process-hardened',
    briefFile,
  };
}

// ============================================================================
// SECTION: CLI Entry Point
// ============================================================================

/** Runner-specific flags — none. Every flag this runner accepts is a common one
 * (`-a/--agent` included, parsed by `parseCommonArgs`); listing any here as runner-declared
 * would shadow common's parsing and discard the value. Exported as an empty spec so the
 * flag-parity test still checks this runner's `--help` against DOCUMENTED_COMMON_FLAGS. */
export const CLI_FLAGS = {
  valueFlags: [],
  booleanFlags: [],
};

export async function main() {
  const options = parseCommonArgs(process.argv);

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
    console.error('Error: No prompt provided. Use --help for usage.');
    process.exit(1);
  }

  try {
    const res = await runOpencode({ ...options, prompt: finalPrompt });
    if (res.stdout) {
      process.stdout.write(res.stdout.endsWith('\n') ? res.stdout : `${res.stdout}\n`);
    }
    process.exit(res.exitCode);
  } catch (err) {
    console.error(formatCliError(err));
    // Read once: a getter that succeeds then throws would re-throw on a second access.
    const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
    if (stderr) {
      console.error(`\n--- Subprocess Stderr ---\n${stderr}`);
    }
    process.exit(safeExitCode(err));
  }
}

function printHelp() {
  console.log(`
OpenCode Runner (config-driven — any opencode.jsonc provider/model, sandboxed)

Usage:
  node scripts/opencode-run.mjs [options] [prompt]

Options:
  -p, --prompt <string>       The prompt message to send to the agent
  -f, --file, --artifact      Attach a context file or Antigravity artifact path (can repeat)
  --prompt-file <path>        Read the prompt from a file instead of an argument
  -a, --agent <name>          Override agent (auto-resolved from opencode config, fallback 'plan')
  -m, --model <provider/name> Override model (defaults to opencode.jsonc model)
  -e, --effort, --reasoning-effort <variant>
                              Folded into opencode run -m <model>#<effort> (provider-specific reasoning effort)
  -t, --timeout <seconds>     Override execution timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})
  --max-buffer <MB>           Max output buffer limit in MB (default: ${DEFAULT_MAX_BUFFER_MB})
  --json                      Emit raw JSON event stream
  -v, --verbose               Stream live execution trace and tool invocations (default: false)
  -h, --help                  Show this help message

Prerequisites:
  - opencode CLI installed and available in PATH
  - opencode.json(c) merged across opencode's own config precedence order — see
    https://opencode.ai/docs/config/#precedence-order — supplying model, agent, and optional
    provider baseURL/apiKey. Setting 'model' to a bare lmstudio model name targets a local
    LM Studio server (default: http://127.0.0.1:1234/v1); pointing 'model' at any other
    provider/model (e.g. anthropic/claude-opus-5, openrouter/...) targets that provider instead —
    setting no model at all leaves the choice to opencode's own CLI default —
    WAN proxy-trapping and the local GPU lock only apply when the resolved endpoint is local.
  - Remote-provider credentials belong in opencode.jsonc's providers.<name>.settings.apiKey
    (resolved by opencode's own subprocess), not in this process's environment — cloud API keys
    and tokens are stripped before the delegate spawns regardless of provider.
  - Requires opencode CLI v2; v1 is not supported (no --pure/--variant, no version detection).

Examples:
  node scripts/opencode-run.mjs "Review git diff for bugs"
  node scripts/opencode-run.mjs -a delegate "Inspect codebase structure"
  node scripts/opencode-run.mjs -v "Inspect codebase structure"
  git diff | node scripts/opencode-run.mjs "Analyze these changes"
  node scripts/opencode-run.mjs -f CONTEXT.md "Summarize invariants"
  node scripts/opencode-run.mjs -m anthropic/claude-opus-5 "Review this diff"
`);
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
