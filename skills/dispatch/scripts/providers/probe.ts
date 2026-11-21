import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { currentPlatform } from '../lib/platform.ts';
import { createDiscovery, type Discovery } from './discovery.ts';
import { SPECS } from './index.ts';
import { bwrapArgv, unsupportedStandaloneDiagnostic } from './opencode.ts';
import { batchInvocation, sanitizeEnv } from './runner.ts';
import type { PlatformEnv, ProviderId } from './types.ts';

const CONCURRENCY = 4;
const PROVIDER_MS = 10_000;
const GLOBAL_MS = 15_000;
const STREAM_BYTES = 64 * 1024;
const STANDALONE_STDOUT_BYTES = 1024 * 1024;

export type ProbeTarget = { provider: ProviderId; sandboxRequired: boolean };
export type ProbeReadiness = 'ok' | 'unauthenticated' | 'unsupported' | 'unprobeable' | 'error';
export type ProbeSandbox = 'ok' | 'unverified' | 'unsupported' | 'unavailable';
const REMEDIATION = {
  'not-found': 'Install the provider CLI and make its launcher discoverable.',
  timeout: 'Check whether the provider starts promptly, then retry the probe.',
  'unsupported-version': 'Upgrade OpenCode to a release with standalone mode.',
  'sandbox-unavailable': 'Check bubblewrap and OpenCode state directories.',
  'sandbox-unsupported': 'Set sandbox: false for this provider to opt out of OS isolation, or use a platform that supports its sandbox.',
  'config-error': 'Check the provider configuration and available agents.',
  'probe-error': 'Check that the installed provider CLI starts successfully.',
} as const;
export type ProbeFailureCategory = keyof typeof REMEDIATION | null;

export type ProviderProbeResult = {
  provider: ProviderId;
  binaryFound: boolean;
  version: string | null;
  readiness: ProbeReadiness;
  sandbox: ProbeSandbox;
  failureCategory: ProbeFailureCategory;
  remediation: string | null;
};

export type ProbeSummary = { ok: number; failed: number; unprobeable: number; unverified: number };
type ProbeOutput = { exit: number | null; stdout: string; stderr: string; stdoutTruncated?: boolean; errorCode?: string; timedOut?: boolean };
type ProbeLaunch = { cwd: string; timeoutMs: number; stdoutCapBytes?: number };
export type ProbeSpawnPort = (binary: string, args: readonly string[], launch: ProbeLaunch) => Promise<ProbeOutput>;
export type ProbeDeps = {
  spawn?: ProbeSpawnPort;
  platform?: PlatformEnv;
  discovery?: Discovery;
  exists?: (path: string) => boolean;
  cwd?: string;
  now?: () => number;
};

function cappedStream(capBytes = STREAM_BYTES) {
  const buffer = Buffer.alloc(capBytes);
  let size = 0;
  let truncated = false;
  return {
    append(chunk: Buffer) {
      const copied = chunk.copy(buffer, size, 0, Math.min(chunk.length, buffer.length - size));
      size += copied;
      if (copied < chunk.length) truncated = true;
    },
    text: () => buffer.toString('utf8', 0, size),
    truncated: () => truncated,
  };
}

function killGroup(pid: number): boolean {
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch (error) {
    // ESRCH means the process group has already exited.
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

export const nodeProbeSpawn: ProbeSpawnPort = (binary, args, { cwd, timeoutMs, stdoutCapBytes }) => new Promise(resolve => {
  const windows = process.platform === 'win32';
  const env = sanitizeEnv(process.env);
  const batch = windows && /\.(cmd|bat)$/i.test(binary);
  const invocation = batch ? batchInvocation(binary, args, env['COMSPEC']) : { command: binary, args };
  const child = spawn(invocation.command, invocation.args, {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: !windows,
    windowsHide: true, windowsVerbatimArguments: batch,
  });
  const stdout = cappedStream(stdoutCapBytes);
  const stderr = cappedStream();
  let exited = false;
  let timedOut = false;
  child.stdout.on('data', stdout.append);
  child.stderr.on('data', stderr.append);
  child.once('exit', () => {
    exited = true;
    if (!windows && !timedOut && child.pid !== undefined) killGroup(child.pid);
  });
  child.once('error', (error: NodeJS.ErrnoException) => {
    clearTimeout(timer);
    resolve({ exit: null, stdout: '', stderr: '', errorCode: error.code ?? 'UNKNOWN' });
  });
  child.once('close', exit => {
    clearTimeout(timer);
    resolve({ exit, stdout: stdout.text(), stderr: stderr.text(), stdoutTruncated: stdout.truncated() });
  });

  const timer = setTimeout(() => {
    timedOut = true;
    if (!exited && child.pid !== undefined) {
      if (windows) {
        // taskkill owns the tree teardown. Do not kill the parent first or lose its descendants.
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          env, stdio: 'ignore', windowsHide: true,
        });
        killer.once('error', () => child.kill());
        killer.once('exit', code => { if (code !== 0 && !exited) child.kill(); });
        const killTimer = setTimeout(() => { killer.kill(); if (!exited) child.kill(); }, 1000);
        killTimer.unref();
        killer.once('close', () => clearTimeout(killTimer));
        killer.unref();
      } else if (!killGroup(child.pid)) child.kill('SIGKILL');
    }
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    resolve({ exit: null, stdout: '', stderr: '', timedOut: true });
  }, timeoutMs);
});

function defaultDiscovery(platform: PlatformEnv): Discovery {
  return createDiscovery(SPECS, platform, {
    list(dir) { try { return fs.readdirSync(dir); } catch { return []; } },
    exists: fs.existsSync,
    executable(file) {
      try {
        const stat = fs.statSync(file);
        return stat.isFile() && (platform.os === 'win32' || (stat.mode & 0o111) !== 0);
      } catch { return false; }
    },
  });
}

function initialSandbox(provider: ProviderId, platform: PlatformEnv): ProbeSandbox {
  if (provider === 'opencode') {
    if (platform.os !== 'linux') return 'unsupported';
    return platform.bubblewrap ? 'unverified' : 'unavailable';
  }
  return SPECS[provider].sandbox?.supported(platform) ? 'unverified' : 'unsupported';
}

function numericVersion(stdout: string): string | null {
  const firstLine = stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
  const match = /^(?:[A-Za-z0-9._/-]{1,32}\s+)?v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:\s|$)/.exec(firstLine);
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null;
}

function standaloneFailure(output: ProbeOutput): ProbeFailureCategory {
  if (output.errorCode) return 'probe-error';
  if (unsupportedStandaloneDiagnostic(output.stderr + '\n' + output.stdout)) return 'unsupported-version';
  if (output.exit !== 0 || output.stdoutTruncated) return 'config-error';
  try { return Array.isArray(JSON.parse(output.stdout)) ? null : 'config-error'; }
  catch { return 'config-error'; }
}

function hasAllBindSources(args: readonly string[], exists: (path: string) => boolean): boolean {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--bind' || args[index] === '--ro-bind') {
      if (!exists(args[index + 1]!)) return false;
      index += 2;
    }
    if (args[index] === '--') break;
  }
  return true;
}

async function probeProvider(target: ProbeTarget, deps: Required<ProbeDeps>, globalDeadline: number): Promise<ProviderProbeResult> {
  const { provider, sandboxRequired } = target;
  const { discovery, platform, now, cwd, exists } = deps;
  const providerDeadline = now() + PROVIDER_MS;
  const baseline = initialSandbox(provider, platform);
  let binaryFound = false;
  let version: string | null = null;
  const row = (readiness: ProbeReadiness, sandbox: ProbeSandbox, failureCategory: ProbeFailureCategory): ProviderProbeResult => ({
    provider, binaryFound, version, readiness, sandbox, failureCategory,
    remediation: failureCategory === null ? null : REMEDIATION[failureCategory],
  });
  const timeout = () => row('error', baseline, 'timeout');
  const remaining = () => Math.min(providerDeadline, globalDeadline) - now();
  const run = async (binary: string, args: readonly string[], stdoutCapBytes = STREAM_BYTES): Promise<ProbeOutput> => {
    const timeoutMs = remaining();
    if (timeoutMs <= 0) return { exit: null, stdout: '', stderr: '', timedOut: true };
    try { return await deps.spawn(binary, args, { cwd, timeoutMs, stdoutCapBytes }); }
    catch (error) {
      return { exit: null, stdout: '', stderr: '', errorCode: (error as NodeJS.ErrnoException | null)?.code ?? 'UNKNOWN' };
    }
  };

  if (remaining() <= 0) return timeout();
  let binary: string | null = null;
  for (const mode of SPECS[provider].modes) {
    const resolution = discovery.resolve(provider, mode.id);
    if (resolution.status === 'path') { binary = resolution.path; break; }
  }
  if (!binary) return row('error', baseline, 'not-found');

  const versionOutput = await run(binary, ['--version']);
  if (versionOutput.timedOut) return timeout();
  if (versionOutput.errorCode === 'ENOENT' || versionOutput.errorCode === 'EACCES') return row('error', baseline, 'not-found');
  if (versionOutput.errorCode || versionOutput.exit !== 0) return row('error', baseline, 'probe-error');
  binaryFound = true;
  version = numericVersion(versionOutput.stdout);

  let readiness: ProbeReadiness = 'unprobeable';
  let sandbox = baseline;
  let failure: ProbeFailureCategory = null;
  if (provider === 'opencode') {
    for (const command of ['config', 'agents']) {
      const output = await run(binary, ['--standalone', 'debug', command], STANDALONE_STDOUT_BYTES);
      if (output.timedOut) return timeout();
      failure = standaloneFailure(output);
      if (failure !== null) break;
    }
    readiness = failure === null ? 'ok' : failure === 'unsupported-version' ? 'unsupported' : 'error';
    if (baseline === 'unverified') {
      const [command, ...args] = bwrapArgv({ cwd, platform, briefFile: null }, ['true']);
      sandbox = 'unavailable';
      if (hasAllBindSources(args, exists)) {
        const output = await run(command!, args);
        if (output.timedOut) return timeout();
        if (!output.errorCode && output.exit === 0) sandbox = 'ok';
      }
    }
  }
  if (failure === null && sandboxRequired) {
    if (sandbox === 'unavailable') failure = 'sandbox-unavailable';
    if (sandbox === 'unsupported') failure = 'sandbox-unsupported';
  }
  return row(readiness, sandbox, failure);
}

function failedProbe(row: ProviderProbeResult, { sandboxRequired }: ProbeTarget): boolean {
  return !row.binaryFound || (sandboxRequired && (row.sandbox === 'unsupported' || row.sandbox === 'unavailable'))
    || row.failureCategory === 'timeout' || row.readiness === 'unsupported'
    || row.readiness === 'unauthenticated' || row.readiness === 'error';
}

export async function probeProviders(targets: readonly ProbeTarget[], options: ProbeDeps = {}): Promise<{ probes: ProviderProbeResult[]; probeSummary: ProbeSummary }> {
  const now = options.now ?? Date.now;
  const globalDeadline = now() + GLOBAL_MS;
  const platform = options.platform ?? currentPlatform();
  const deps = {
    now, platform, cwd: options.cwd ?? process.cwd(), exists: options.exists ?? fs.existsSync,
    discovery: options.discovery ?? defaultDiscovery(platform), spawn: options.spawn ?? nodeProbeSpawn,
  };
  const probes: ProviderProbeResult[] = new Array(targets.length);
  let next = 0;
  async function worker() {
    while (next < targets.length) {
      const index = next++;
      probes[index] = await probeProvider(targets[index]!, deps, globalDeadline);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  const probeSummary: ProbeSummary = { ok: 0, failed: 0, unprobeable: 0, unverified: 0 };
  for (const [index, row] of probes.entries()) {
    if (failedProbe(row, targets[index]!)) probeSummary.failed++;
    else probeSummary.ok++;
    if (row.readiness === 'unprobeable') probeSummary.unprobeable++;
    if (row.sandbox === 'unverified') probeSummary.unverified++;
  }
  return { probes, probeSummary };
}
