// OpenCode (spec §6.1; ports legacy runners/opencode.mjs): v2-only argv `run --auto [--agent] [-m model[#effort]]
// [--format json] -- <prompt>`; `Variant unavailable` asks the runner to rerun once without effort. A loopback
// endpoint gets a `/models` preflight, the GPU lock, and a WAN proxy trap; a remote endpoint skips all three.
// Bubblewrap sandbox on Linux only; elsewhere `sandbox: true` is `sandbox-unsupported`.

import { classifyFailure, extractCleanResponse, failOutcome } from './runner.ts';
import type { LaunchRequest, PlatformEnv, Prelaunch, PreparePorts, ProviderSpec, RunOutcome } from './types.ts';

export const PROXY_TRAP = 'http://127.0.0.1:0';
const PROXY_KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
const VARIANT_UNAVAILABLE = /Variant unavailable/i;

const join = (env: PlatformEnv, ...parts: string[]): string => parts.join(env.os === 'win32' ? '\\' : '/');

/** Loopback hosts only: a LAN or remote host is not "local" for the WAN trap. */
export function isLocalHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  return bare === 'localhost' || bare === '::1' || bare.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(bare);
}

export function endpointHost(endpoint: string): string | null {
  try { return new URL(endpoint).hostname; } catch { return null; }
}

/** Bubblewrap: read-only root, private /tmp, writable OpenCode state; the delegate cannot write the project. */
export function bwrapArgv(req: LaunchRequest, inner: readonly string[]): string[] {
  const home = req.platform.home;
  const xdg = req.platform.xdg ?? {};
  // OpenCode's writable dirs are XDG data/cache/state, each with an `opencode` leaf (legacy resolveOpencodeStateDirs).
  const state = [
    join(req.platform, xdg.data ?? join(req.platform, home, '.local', 'share'), 'opencode'),
    join(req.platform, xdg.cache ?? join(req.platform, home, '.cache'), 'opencode'),
    join(req.platform, xdg.state ?? join(req.platform, home, '.local', 'state'), 'opencode'),
  ];
  const briefDir = req.briefFile ? [req.briefFile.replace(/[/\\][^/\\]*$/, '')] : [];
  return [
    'bwrap', '--unshare-user', '--unshare-ipc', '--unshare-pid', '--unshare-uts', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/run',
    ...briefDir.flatMap((dir) => ['--ro-bind', dir, dir]),
    ...state.flatMap((dir) => ['--bind', dir, dir]),
    '--die-with-parent', '--chdir', req.cwd, '--', ...inner,
  ];
}

export async function prepareOpencode(req: LaunchRequest, ports: PreparePorts): Promise<Prelaunch> {
  if (!req.agent || req.readOnlyVerified !== true) return { kind: 'fail', outcome: failOutcome('config', 'read-only-agent-unavailable: verified native agent required') };
  const host = req.endpoint ? endpointHost(req.endpoint) : null;
  if (!req.endpoint || !host || !isLocalHost(host)) return { kind: 'launch', env: {}, release: () => {} };
  const models = await ports.fetchModels(req.endpoint);
  if (models === null) return { kind: 'fail', outcome: failOutcome('model-not-loaded', `SERVER_OFFLINE: ${req.endpoint}/models did not answer`) };
  if (!models.length || req.model && !models.includes(req.model.split('/').slice(1).join('/') || req.model)) return { kind: 'fail', outcome: failOutcome('model-not-loaded', `${req.endpoint} reports no models loaded`) };
  let release: () => void | Promise<void>;
  try { release = await ports.acquireGpuLock(); } catch (error) { return { kind: 'fail', outcome: failOutcome('timeout', String(error)) }; }
  // Local dispatch has no legitimate WAN use: every proxy points at a dead port, with only the backend exempt.
  const exempt = [...new Set([host, 'localhost', '127.0.0.1', '::1'])].join(',');
  const env: Record<string, string> = { NO_PROXY: exempt, no_proxy: exempt };
  for (const key of PROXY_KEYS) env[key] = PROXY_TRAP;
  return { kind: 'launch', env, release };
}

export const opencode: ProviderSpec = {
  id: 'opencode',
  modes: [
    { id: 'cli', candidates: (env) => [env.os === 'win32' ? 'opencode.cmd' : 'opencode', env.os === 'win32' ? 'opencode.exe' : join(env, env.home, '.opencode', 'bin', 'opencode')] },
    { id: 'desktop', candidates: (env) => env.os === 'darwin'
      ? ['/Applications/OpenCode.app/Contents/MacOS/opencode-cli-*']
      : env.os === 'win32' ? [join(env, env.home, 'AppData', 'Local', 'OpenCode', 'opencode-cli-*.exe')] : ['/usr/lib/opencode/opencode-cli-*'] },
    { id: 'vscode', candidates: (env) => [join(env, env.home, '.vscode', 'extensions', 'sst-dev.opencode-*', 'bin', env.os === 'win32' ? 'opencode.exe' : 'opencode')] },
  ],
  readOnlyFlags: ['run'],
  sandbox: { flags: ['bwrap'], inactive: /bwrap: [^\n]*(?:No permissions|Operation not permitted|setting up uid map)/i, supported: (env) => env.os === 'linux' && env.bubblewrap },
  native: 'opencode',
  modeCascadeOn: [],
  resumeCommand: (id) => id,
  argv(req) {
    // Headless `--auto` requires the effective deny-by-default read-only agent verified in preparation.
    // `--pure` and `--variant` are v1-only and never emitted.
    const inner = [req.binary, 'run', '--auto'];
    if (req.agent) inner.push('--agent', req.agent);
    if (req.model) inner.push('-m', req.effort ? `${req.model}#${req.effort}` : req.model);
    inner.push('--', req.prompt);
    return { argv: req.sandbox ? bwrapArgv(req, inner) : inner, stdin: null, env: {}, cwd: req.cwd };
  },
  parse(out, req): RunOutcome {
    const both = `${out.stderrTail}\n${out.stdout}`;
    const text = extractCleanResponse(out.stdout);
    if (out.exit === 0 && text) {
      const handle = req.endpoint ?? (req.model ? `opencode:${req.model}` : null);
      return { status: 'ok', text, sessionId: null, resume: handle };
    }
    const detail = `opencode exit ${String(out.exit)}: ${out.stderrTail.trim().slice(0, 300)}`;
    if (VARIANT_UNAVAILABLE.test(both) && req.effort) return { status: 'fail', cls: 'model-not-found', detail, retryWithoutEffort: true };
    return failOutcome(classifyFailure(both) ?? 'empty-output', detail);
  },
  prepare: prepareOpencode,
};
