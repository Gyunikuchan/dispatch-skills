#!/usr/bin/env node
// @ts-check

/** Read-delegate runner for Codex CLI binaries, including app and editor bundles. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dedupeTargetsByBinary, findBinary, findFirstExistingFile, isMainModule,
  PROJECT_ROOT, scanVersionDirs, spawnCli, spawnCliSync,
} from '../lib/platform.mjs';
import { validateEffortSpec, validateModelSpec } from '../lib/providers.mjs';
import {
  buildFormattedPrompt, buildMetricsAttempt, cascadeModels, classifyFailure,
  createNoTargetsError, createSessionLogger, createTraceWriter,
  DEFAULT_MAX_BUFFER_MB, DEFAULT_TIMEOUT_SECONDS, emitCompletionBanner, emitInitBanner,
  formatCliError, getSanitizedEnv, parseCommonArgs, parseRunnerModeArgs, readStdin,
  resolveFailureKind, resolveModelsToTry, resolveRunnerExitCode, runDelegateCapture,
  safeExitCode,
} from './shared.mjs';

/** @typedef {'cli'|'desktop'|'vscode'} CodexMode */
/** @typedef {{mode: CodexMode, name: string, binary: string, version?: string|null}} CodexTarget */
/** @typedef {{prompt: string, files?: string[], model?: string|string[]|null, effort?: string|null, sandbox?: boolean, timeout?: number, maxBufferMb?: number, verbose?: boolean, codexMode?: 'auto'|CodexMode, execute?: typeof executeOnTarget, discoverTargets?: typeof findViableTargets, createLogger?: typeof createSessionLogger}} RunCodexOptions */

/** @type {Array<{mode: CodexMode, name: string, fn: () => string|null}>} */
export const MODE_DEFINITIONS = [
  { mode: 'cli', name: 'Codex CLI', fn: getCodexCliBinary },
  { mode: 'desktop', name: 'Codex Desktop bundle', fn: getCodexDesktopBinary },
  { mode: 'vscode', name: 'Codex VS Code extension', fn: getCodexVscodeBinary },
];

export const CODEX_DOWNGRADE_WARNING = '[dispatch] WARNING: Codex sandbox is unavailable; retrying this mode without sandbox (write access is possible).';

/** Codex's JSONL stream, not the tool trace, supplies the delegate's answer.
 * @param {string} raw
 */
export function parseCodexEvents(raw) {
  let answer = '';
  let threadId = null;
  let usage = null;
  let error = null;
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') threadId = event.thread_id;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') answer = event.item.text;
    if (event.type === 'turn.completed' && event.usage) usage = event.usage;
    if (event.type === 'turn.failed' || event.type === 'error') error = event.error?.message ?? event.message ?? 'Codex turn failed';
  }
  return { answer, threadId, usage, error };
}

/** @param {string} prompt @param {{model?: string|null, effort?: string|null, sandbox?: boolean}} [options] */
export function buildCodexArgs(prompt, { model = null, effort = null, sandbox = true } = {}) {
  const args = ['exec', '--json', '--cd', PROJECT_ROOT, '--config', 'approval_policy="never"'];
  // NOTE: The fallback uses config because an older CLI may reject --sandbox itself.
  if (sandbox) args.push('--sandbox', 'read-only');
  else args.push('--config', 'sandbox_mode="danger-full-access"');
  if (model) args.push('--model', model);
  if (effort) args.push('--config', `model_reasoning_effort=${JSON.stringify(effort)}`);
  args.push(prompt);
  return args;
}

/** Classify only CLI diagnostics; answer text may legitimately quote an error.
 * @param {string} text
 */
export function classifyCodexFailure(text) {
  if (/(?:unrecognized|unknown|unexpected|invalid) (?:option|argument|value)[^\n]*--sandbox/i.test(text)) return 'sandbox-unsupported';
  if (/sandbox[^\n]*(?:unavailable|unsupported|initialization failed|not supported)|(?:failed to initialize|failed to create)[^\n]*sandbox/i.test(text)) return 'sandbox-unsupported';
  return classifyFailure(text);
}

/** @param {{stdoutBuffer: string, stderrBuffer: string, code: number|null, signal: string|null, truncated: 'timeout'|'buffer'|null}} outcome @param {{sandbox: boolean}} options */
export function resolveCodexOutcome(outcome, { sandbox }) {
  const parsed = parseCodexEvents(outcome.stdoutBuffer);
  const diagnostics = `${outcome.stderrBuffer}\n${parsed.error ?? ''}`;
  const failureKind = resolveFailureKind(classifyCodexFailure(diagnostics), outcome.truncated);
  const exitCode = resolveRunnerExitCode({ code: outcome.code, signal: outcome.signal, truncated: outcome.truncated, cleanStdout: parsed.answer, isError: !!parsed.error || (sandbox && failureKind === 'sandbox-unsupported') });
  return { parsed, diagnostics, failureKind, exitCode };
}

/** @param {{result?: Record<string, any>|null, error?: (Error & {failureKind?: string})|null, hasNext: boolean}} options */
export function nextCodexStep({ result = null, error = null, hasNext }) {
  if (error?.failureKind === 'sandbox-unsupported') return 'throw';
  if (result?.failureKind === 'sandbox-unsupported') return 'return';
  if (error) return hasNext ? 'next-target' : 'throw';
  return result?.exitCode === 0 || !hasNext ? 'return' : 'next-target';
}

/** @param {RunCodexOptions} options */
export async function runCodex(options = /** @type {RunCodexOptions} */ ({})) {
  const {
    prompt, files = [], model = null, effort = null, sandbox = true,
    timeout = DEFAULT_TIMEOUT_SECONDS, maxBufferMb = DEFAULT_MAX_BUFFER_MB,
    verbose = false, codexMode = 'auto', execute = executeOnTarget,
    discoverTargets = findViableTargets, createLogger = createSessionLogger,
  } = options;
  validateModelSpec(model, 'model');
  validateEffortSpec(effort, 'effort');
  const targets = discoverTargets(codexMode);
  if (!targets.length) throw createNoTargetsError('Codex was not reachable as a CLI, Desktop bundle, or VS Code extension.', 'not-found');
  const formattedPrompt = buildFormattedPrompt(prompt, files);
  const metricsAttempts = [];
  return cascadeModels(resolveModelsToTry(model), async (currentModel) => {
    let lastResult = null;
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const logger = createLogger('codex');
      const hasNext = codexMode === 'auto' && i < targets.length - 1;
      let activeSandbox = sandbox;
      let downgraded = false;
      const markDowngrade = (value) => {
        if (downgraded) {
          value.sandboxDowngraded = true;
          value.warnings = [CODEX_DOWNGRADE_WARNING];
        }
        return value;
      };
      const retryWithoutSandbox = (failureKind) => {
        if (!activeSandbox || failureKind !== 'sandbox-unsupported') return false;
        activeSandbox = false;
        downgraded = true;
        process.stderr.write(`${CODEX_DOWNGRADE_WARNING}\n`);
        logger.write?.(`${CODEX_DOWNGRADE_WARNING}\n`);
        return true;
      };
      try {
        while (true) {
          try {
            const result = await execute({ target, formattedPrompt, model: currentModel, effort, sandbox: activeSandbox, timeout, maxBufferMb, verbose, sessionLogger: logger });
            metricsAttempts.push(buildMetricsAttempt({ input: formattedPrompt, output: result.stdout, provider: 'codex', model: currentModel, effort, mode: target.mode, exitCode: result.exitCode, failureKind: result.failureKind, truncated: result.truncated, usage: result.usage }));
            if (result.exitCode !== 0 && retryWithoutSandbox(result.failureKind)) continue;
            result.metricsAttempts = [...metricsAttempts];
            result.effectiveAttempt = metricsAttempts.length - 1;
            lastResult = markDowngrade(result);
            if (nextCodexStep({ result, hasNext }) === 'return') return lastResult;
            process.stderr.write(`[dispatch] fallback codex:${target.mode} -> codex:${targets[i + 1].mode}: ${result.failureKind ?? 'execution'}\n`);
            break;
          } catch (err) {
            const failureKind = err.failureKind ?? classifyCodexFailure(`${err.message}\n${err.stderr ?? ''}`);
            metricsAttempts.push(buildMetricsAttempt({ input: formattedPrompt, provider: 'codex', model: currentModel, effort, mode: target.mode, failureKind }));
            if (retryWithoutSandbox(failureKind)) continue;
            err.failureKind = failureKind;
            err.metricsAttempts = [...metricsAttempts];
            markDowngrade(err);
            if (nextCodexStep({ error: err, hasNext }) === 'throw') throw err;
            process.stderr.write(`[dispatch] fallback codex:${target.mode} -> codex:${targets[i + 1].mode}: ${err.message}\n`);
            break;
          }
        }
      } finally {
        logger.close();
      }
    }
    return lastResult;
  }, { label: 'Codex' });
}

/** @param {{target: CodexTarget, formattedPrompt: string, model: string|null, effort: string|null, sandbox: boolean, timeout: number, maxBufferMb: number, verbose: boolean, sessionLogger: ReturnType<typeof createSessionLogger>}} options */
async function executeOnTarget({ target, formattedPrompt, model, effort, sandbox, timeout, maxBufferMb, verbose, sessionLogger }) {
  emitInitBanner({ platform: 'codex', mode: target.mode, model, effort, logFile: sessionLogger.logFile });
  const trace = createTraceWriter(verbose);
  return runDelegateCapture({
    spawnChild: () => {
      const env = getSanitizedEnv();
      // NOTE: Desktop-launched Windows shells may omit HOME; Codex needs an explicit state root.
      env.CODEX_HOME ??= path.join(os.homedir(), '.codex');
      const child = spawnCli(target.binary, buildCodexArgs('-', { model, effort, sandbox }), {
        cwd: PROJECT_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
      });
      child.stdin.on('error', () => {});
      child.stdin.end(formattedPrompt);
      return child;
    },
    timeoutSeconds: timeout, maxBufferMb, sessionLogger, trace,
    onFail: (err, captured) => { err.failureKind = classifyCodexFailure(`${captured.stderrBuffer}\n${err.message}`); },
    onClose: (outcome) => {
      const { parsed, diagnostics, failureKind, exitCode } = resolveCodexOutcome(outcome, { sandbox });
      const sessionLink = parsed.threadId ? `codex exec resume ${parsed.threadId}` : null;
      emitCompletionBanner({ platform: 'codex', exitCode, truncated: outcome.truncated, sessionId: parsed.threadId, resumeCommand: sessionLink });
      return { provider: 'codex', mode: target.mode, binary: target.binary, stdout: parsed.answer, rawStdout: outcome.stdoutBuffer, stderr: diagnostics, exitCode, logFile: sessionLogger.logFile, briefFile: null, sessionId: parsed.threadId, sessionLink, truncated: outcome.truncated, failureKind, usage: parsed.usage };
    },
  });
}

/** @param {'auto'|CodexMode} [mode='auto'] */
export function findViableTargets(mode = 'auto') {
  const selected = mode === 'auto' ? MODE_DEFINITIONS : MODE_DEFINITIONS.filter((entry) => entry.mode === mode);
  /** @type {CodexTarget[]} */
  const targets = [];
  for (const entry of selected) {
    const binary = entry.fn();
    if (!binary) continue;
    const probe = testCodexReachability(binary);
    if (probe.reachable) targets.push({ mode: entry.mode, name: entry.name, binary, version: probe.version });
  }
  return dedupeTargetsByBinary(targets, (target) => target.binary);
}

/** @param {string|null} binary */
export function testCodexReachability(binary) {
  if (!binary || !fs.existsSync(binary)) return { reachable: false, version: null, error: 'Binary not found' };
  try {
    const probe = spawnCliSync(binary, ['--version'], { encoding: 'utf8', timeout: 3000 });
    return probe.status === 0
      ? { reachable: true, version: (probe.stdout || probe.stderr || '').trim().split(/\r?\n/)[0], error: null }
      : { reachable: false, version: null, error: probe.error?.message ?? (probe.stderr || `exit ${probe.status}`).trim() };
  } catch (err) {
    return { reachable: false, version: null, error: err.message };
  }
}

/** @returns {string|null} */
export function getCodexCliBinary() {
  const home = os.homedir();
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'];
  return findBinary(names, [path.join(home, '.local', 'bin', names[0]), path.join(home, '.npm-global', 'bin', names[0])]);
}

/** @returns {string[]} */
export function getCodexDesktopCandidates() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    const bundle = path.join(home, 'Library', 'Application Support', 'OpenAI', 'Codex', 'bin');
    return [
      ...scanVersionDirs(bundle).map((version) => path.join(bundle, version, 'codex')),
      '/Applications/Codex.app/Contents/Resources/codex',
      path.join(home, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'),
    ];
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const programs = process.env.ProgramFiles || 'C:\\Program Files';
    return [
      ...scanVersionDirs(path.join(local, 'OpenAI', 'Codex', 'bin'))
        .map((version) => path.join(local, 'OpenAI', 'Codex', 'bin', version, 'codex.exe')),
      path.join(local, 'Programs', 'Codex', 'resources', 'bin', 'codex.exe'),
      path.join(local, 'Programs', 'Codex', 'bin', 'codex.exe'),
      path.join(programs, 'Codex', 'resources', 'bin', 'codex.exe'),
    ];
  }
  const linuxBundle = path.join(home, '.local', 'share', 'OpenAI', 'Codex', 'bin');
  return [
    ...scanVersionDirs(linuxBundle).map((version) => path.join(linuxBundle, version, 'codex')),
    '/opt/Codex/resources/bin/codex', '/usr/local/lib/codex/codex',
  ];
}

/** @returns {string|null} */
export function getCodexDesktopBinary() { return findFirstExistingFile(getCodexDesktopCandidates()); }

/** @returns {string[]} */
export function getCodexVscodeCandidates() {
  const home = os.homedir();
  const folder = `${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`;
  const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const roots = [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
    path.join(home, '.vscode-oss', 'extensions'),
  ];
  const candidates = [];
  for (const root of roots) {
    for (const version of scanVersionDirs(root).filter((name) => name.startsWith('openai.chatgpt-'))) {
      candidates.push(path.join(root, version, 'bin', folder, executable));
    }
  }
  return candidates;
}

/** @returns {string|null} */
export function getCodexVscodeBinary() { return findFirstExistingFile(getCodexVscodeCandidates()); }
/** @param {'auto'|CodexMode} [mode='auto'] */
export function resolveCodexTarget(mode = 'auto') { return findViableTargets(mode)[0] ?? null; }
/** @returns {Record<string, {binary: string|null, reachable: boolean, version: string|null, error: string|null}>} */
export function probeCodexModes() {
  return Object.fromEntries(MODE_DEFINITIONS.map(({ mode, fn }) => {
    const binary = fn();
    return [mode, { binary, ...testCodexReachability(binary) }];
  }));
}
/** @returns {Promise<boolean>} */
export async function isCodexAvailable() { return !!resolveCodexTarget(); }

export const CLI_FLAGS = {
  valueFlags: ['--codex-mode'],
  booleanFlags: ['--sandbox', '--no-sandbox', '--test-modes', '--probe'],
  aliases: { '--codex-mode': 'codexMode' },
};

/** @param {string[]} argv */
export function parseCodexArgs(argv) {
  const options = parseCommonArgs(argv, CLI_FLAGS);
  const { values, booleans } = parseRunnerModeArgs(argv.slice(2), CLI_FLAGS);
  options.codexMode = values.codexMode ?? 'auto';
  options.sandbox = !booleans['--no-sandbox'];
  options.probeOnly = !!(booleans['--test-modes'] || booleans['--probe']);
  return options;
}

export async function main() {
  const options = parseCodexArgs(process.argv);
  if (options.help) {
    console.log('Codex read-delegate runner\nUsage: node scripts/runners/codex.mjs [options] [prompt]\n--codex-mode <auto|cli|desktop|vscode>  Pin a mode\n--sandbox / --no-sandbox              Read-only sandbox (default) or explicit opt-out\n--test-modes, --probe                 Probe binaries without tokens\n-p, --prompt <text>  -f, --file <path>  -m, --model <name>  -e, --effort <level>  -t, --timeout <seconds>  --max-buffer <MB>  -v, --verbose  -h, --help');
    return;
  }
  if (options.probeOnly) {
    console.log(JSON.stringify(probeCodexModes(), null, 2));
    return;
  }
  const piped = await readStdin();
  const prompt = [options.prompt, piped].filter(Boolean).join('\n\n');
  if (!prompt.trim()) throw new Error('No prompt provided');
  const result = await runCodex({ ...options, prompt });
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  process.exitCode = result.exitCode;
}

if (isMainModule(import.meta.url)) main().catch((err) => { console.error(formatCliError(err)); process.exitCode = safeExitCode(err); });
