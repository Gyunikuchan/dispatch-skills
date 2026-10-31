// Native introspection owns configuration precedence and effective permissions; raw settings never enter logs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KILL_ESCALATION_MS, sanitizeEnv, waitWithin } from './runner.ts';
import { nodeProcess } from './node-process.ts';
import { unsupportedStandaloneDiagnostic } from './opencode.ts';
import type { DelegateRequest, PreparePorts, ProcessResult } from './types.ts';

type Row = Record<string, unknown>;
const record = (x: unknown): x is Row => !!x && typeof x === 'object' && !Array.isArray(x);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const merge = (a: Row, b: Row): Row => {
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) out[key] = record(out[key]) && record(value) ? merge(out[key], value) : value;
  return out;
};
export type Introspect = (command: 'config' | 'agents') => Promise<unknown>;

export async function resolveEffectiveOpencodeLaunch(req: DelegateRequest, inspect: Introspect): Promise<DelegateRequest> {
  const sources = await inspect('config');
  if (!Array.isArray(sources)) throw new Error('effective-config-unverified: native config sources unavailable');
  let config: Row = {};
  for (const source of sources) {
    if (!record(source) || !['document', 'directory'].includes(String(source['type']))) throw new Error('effective-config-unverified: unsupported native source');
    if (source['type'] === 'document') {
      if (!record(source['info'])) throw new Error('effective-config-unverified: source has no resolved settings');
      config = merge(config, source['info']);
    }
  }
  const agents = await inspect('agents');
  if (!Array.isArray(agents)) throw new Error('read-only-agent-unavailable: effective agents unavailable');
  const readActions = new Set(['read', 'glob', 'grep', 'webfetch', 'websearch', 'external_directory']);
  const safe = (agent: unknown): agent is Row => {
    if (!record(agent) || !Array.isArray(agent['permissions']) || typeof agent['id'] !== 'string' || agent['hidden'] === true) return false;
    const rules = agent['permissions'];
    const lastDeny = rules.findLastIndex((rule: unknown) => record(rule) && rule['action'] === '*' && rule['resource'] === '*' && rule['effect'] === 'deny');
    return lastDeny >= 0 && rules.slice(lastDeny + 1).every((rule: unknown) => record(rule) && (rule['effect'] === 'deny' || readActions.has(String(rule['action']))));
  };
  const candidates = agents.filter(safe);
  const verified = req.agent ? candidates.find((a) => a['id'] === req.agent) : candidates.find((a) => a['id'] === 'explore') ?? candidates.find((a) => a['id'] === 'plan');
  // NOTE: newer opencode builds grant `shell` to the built-in explore agent; the user accepted it as best-effort read-only.
  const bestEffort = verified || (req.agent && req.agent !== 'explore') ? undefined
    : agents.find((a): a is Row => record(a) && a['id'] === 'explore' && a['hidden'] !== true);
  const agent = verified ?? bestEffort;
  if (!agent) throw new Error('read-only-agent-unavailable: require an effective agent with wildcard deny and only read tool grants');
  const model = req.model ?? (typeof config['model'] === 'string' ? config['model'] : null);
  const providerId = model?.split('/')[0];
  const providers = record(config['providers']) ? config['providers'] : record(config['provider']) ? config['provider'] : {};
  const provider = providerId && record(providers[providerId]) ? providers[providerId] : {};
  const settings = record(provider['settings']) ? provider['settings'] : record(provider['options']) ? provider['options'] : {};
  const endpoint = typeof settings['baseURL'] === 'string' ? settings['baseURL'] : null;
  if (endpoint) { const url = new URL(endpoint); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('effective-config-unverified: unsupported endpoint'); }
  return { ...req, model, endpoint, agent: String(agent['id']), readOnlyVerified: Boolean(verified), ...(verified ? {} : { readOnlyBestEffort: true }) };
}

export function nativeOpencodeIntrospection(binary: string, req: DelegateRequest, env: Readonly<Record<string, string | undefined>>, budgetMs: number): Introspect {
  if (env['OPENCODE_CONFIG_CONTENT']) throw new Error('effective-config-unverified: inline config propagation requires an explicit user choice');
  const deadline = Date.now() + budgetMs;
  return async (command) => {
    const remaining = Math.min(5000, deadline - Date.now());
    if (remaining <= 0) throw new Error('effective-config-unverified: opencode-lifecycle-timeout: preparation deadline expired');
    const commandDeadline = Date.now() + remaining;
    const settlementDeadline = commandDeadline + KILL_ESCALATION_MS;
    const logPath = `${req.logPath}.introspect-${command}`;
    const killLogPath = `${logPath}.kill`;
    const child = nodeProcess.start({ argv: [binary, '--standalone', 'debug', command], env: sanitizeEnv(env), stdin: null, cwd: req.cwd }, { logPath, capBytes: 1024 * 1024 });
    let killerDone: Promise<ProcessResult> | undefined;
    let teardownStartFailed = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      if (child.pid <= 1) return;
      timedOut = true;
      if (process.platform === 'win32') {
        try { killerDone = nodeProcess.start({ argv: ['taskkill', '/PID', String(child.pid), '/T', '/F'], env: sanitizeEnv(env), stdin: null, cwd: req.cwd }, { logPath: killLogPath, capBytes: 4096 }).done; }
        catch { teardownStartFailed = true; }
      } else nodeProcess.signal(-child.pid, 'SIGKILL');
    }, remaining);
    try {
      const result = await waitWithin(child.done, Math.max(0, settlementDeadline - Date.now()));
      clearTimeout(timer);
      const commandTimedOut = timedOut || child.pid > 1 && Date.now() > commandDeadline || result?.timedOut === true;
      if (!result) throw new Error('effective-config-unverified: opencode-lifecycle-timeout: native introspection process exit unconfirmed after bounded teardown');
      const killerResult = killerDone ? await waitWithin(killerDone, Math.max(0, settlementDeadline - Date.now())) : null;
      if (killerDone && !killerResult) {
        throw new Error('effective-config-unverified: opencode-lifecycle-timeout: OpenCode teardown process exit unconfirmed after bounded teardown');
      }
      if (teardownStartFailed || (killerResult !== null && killerResult.exit !== 0)) {
        throw new Error('effective-config-unverified: opencode-lifecycle-timeout: OpenCode process-tree teardown did not confirm exit within the bounded deadline');
      }
      if (child.pid > 1 && process.platform !== 'win32' && nodeProcess.settleGroup) {
        const grace = Math.max(0, Math.min(KILL_ESCALATION_MS, settlementDeadline - Date.now()));
        const confirmed = await nodeProcess.settleGroup(child.pid, grace);
        if (!confirmed) throw new Error('effective-config-unverified: opencode-lifecycle-timeout: process group exit unconfirmed; retain the worktree and verify process exit before cleanup');
      }
      if (commandTimedOut) throw new Error('effective-config-unverified: opencode-lifecycle-timeout: native introspection exceeded its command deadline');
      if (unsupportedStandaloneDiagnostic(`${result.stderrTail}\n${result.stdout}`)) {
        throw new Error('effective-config-unverified: OpenCode binary does not support --standalone; upgrade to a supported v2 binary');
      }
      if (result.exit !== 0 || result.truncated) throw new Error('effective-config-unverified: native introspection failed');
      try { return JSON.parse(result.stdout) as unknown; }
      catch { throw new Error('effective-config-unverified: native introspection returned invalid JSON'); }
    } finally {
      clearTimeout(timer);
      for (const file of [logPath, killLogPath]) try { fs.unlinkSync(file); } catch { /* no credential-bearing introspection capture retained */ }
    }
  };
}

export async function fetchModels(endpoint: string, timeoutMs = 5000): Promise<readonly string[] | null> {
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/models`, { redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(5000, timeoutMs))) });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 1024 * 1024) { await reader.cancel(); return null; } chunks.push(part.value); }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!record(value) || !Array.isArray(value['data'])) return null;
    const ids: string[] = [];
    for (const row of value['data']) { if (!record(row) || typeof row['id'] !== 'string' || !row['id'].trim() || row['id'].length > 1024 || /[\x00-\x1f]/.test(row['id'])) return null; ids.push(row['id']); }
    return ids;
  } catch { return null; }
}

type Owner = { host: string; pid: number; token: string };
export const gpuLockPath = () => path.join(fs.realpathSync(os.tmpdir()), 'dispatch-skills', '.locks', 'opencode-local-gpu.lock');
export async function acquireGpuLock(timeoutMs = 30000, file = gpuLockPath()): Promise<() => Promise<void>> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const owner: Owner = { host: os.hostname(), pid: process.pid, token: crypto.randomUUID() };
  const guard = `${file}.guard`;
  const deadline = Date.now() + Math.max(0, Math.min(30000, timeoutMs));
  const guardOnce = (): number | null => { try { return fs.openSync(guard, 'wx', 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null; throw error; } };
  for (;;) {
    const fd = guardOnce();
    let acquired = false;
    if (fd !== null) {
      try {
        let prior: Owner | null = null;
        try { prior = JSON.parse(fs.readFileSync(file, 'utf8')) as Owner; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('gpu-lock-unverifiable'); }
        if (prior) {
          if (prior.host !== owner.host || !Number.isInteger(prior.pid) || prior.pid <= 0 || typeof prior.token !== 'string' || !prior.token) throw new Error('gpu-lock-foreign-or-unverifiable');
          try { process.kill(prior.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { fs.unlinkSync(file); prior = null; } else throw new Error('gpu-lock-owner-unverifiable'); }
        }
        if (!prior) { fs.writeFileSync(file, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); acquired = true; }
      } finally { fs.closeSync(fd); fs.unlinkSync(guard); }
    }
    if (acquired) {
      let released = false;
      let pending: Promise<void> | null = null;
      return () => {
        if (released) return Promise.resolve();
        pending ??= (async () => {
          const until = Date.now() + 30000; let releaseFd: number | null = null;
          while (releaseFd === null) {
            releaseFd = guardOnce();
            if (releaseFd !== null) break;
            if (Date.now() >= until) throw new Error('gpu-lock-release-guard-unavailable');
            await pause(Math.min(25, until - Date.now()));
          }
          try {
            try { const current = JSON.parse(fs.readFileSync(file, 'utf8')) as Owner; if (current.token === owner.token) fs.unlinkSync(file); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            released = true;
          } finally { fs.closeSync(releaseFd); fs.unlinkSync(guard); }
        })().catch((error: unknown) => { pending = null; throw error; });
        return pending;
      };
    }
    if (Date.now() >= deadline) throw new Error('gpu-lock-timeout');
    await pause(Math.min(25, deadline - Date.now()));
  }
}

export function createOpencodePreparePorts(deadline: number): PreparePorts {
  return { fetchModels: (endpoint) => fetchModels(endpoint, deadline - Date.now()), acquireGpuLock: () => acquireGpuLock(deadline - Date.now()) };
}
