// Native introspection owns configuration precedence and effective permissions; raw settings never enter logs.
import { isRecord } from '../lib/config.ts';
import { nodeErrorCode } from '../lib/fs-ext.ts';
import { parseJson } from '../lib/integrity.ts';
import type { JsonObject, JsonValue } from '../lib/integrity.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { types } from 'node:util';
import { KILL_ESCALATION_MS, sanitizeEnv, waitWithin } from './process-policy.ts';
import { nodeProcess } from './node-process.ts';
import { unsupportedStandaloneDiagnostic } from './opencode.ts';
import type { DelegateRequest, LifecycleStep, PreparePorts, ProcessResult } from './types.ts';

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
const merge = (a: JsonObject, b: JsonObject): JsonObject => {
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) {
    out[key] = isRecord(out[key]) && isRecord(value) ? merge(out[key], value) : value;
  }
  return out;
};
type Introspect = (command: 'config' | 'agents') => Promise<JsonValue>;

export async function resolveEffectiveOpencodeLaunch(
  req: DelegateRequest,
  inspect: Introspect,
): Promise<DelegateRequest> {
  const sources = await inspect('config');
  if (!Array.isArray(sources)) {
    throw new Error('effective-config-unverified: native config sources unavailable');
  }
  let config: JsonObject = {};
  for (const source of sources) {
    if (!isRecord(source) || !['document', 'directory'].includes(String(source['type']))) {
      throw new Error('effective-config-unverified: unsupported native source');
    }
    if (source['type'] === 'document') {
      if (!isRecord(source['info'])) {
        throw new Error('effective-config-unverified: source has no resolved settings');
      }
      config = merge(config, source['info']);
    }
  }
  const agents = await inspect('agents');
  if (!Array.isArray(agents)) {
    throw new Error('read-only-agent-unavailable: effective agents unavailable');
  }
  const readActions = new Set(['read', 'glob', 'grep', 'webfetch', 'websearch', 'external_directory']);
  const safe = (agent: unknown): agent is JsonObject => {
    if (
      !isRecord(agent) ||
      !Array.isArray(agent['permissions']) ||
      typeof agent['id'] !== 'string' ||
      agent['hidden'] === true
    ) {
      return false;
    }
    const rules = agent['permissions'];
    const lastDeny = rules.findLastIndex(
      (rule: unknown) =>
        isRecord(rule) && rule['action'] === '*' && rule['resource'] === '*' && rule['effect'] === 'deny',
    );
    return (
      lastDeny >= 0 &&
      rules
        .slice(lastDeny + 1)
        .every(
          (rule: unknown) => isRecord(rule) && (rule['effect'] === 'deny' || readActions.has(String(rule['action']))),
        )
    );
  };
  const candidates = agents.filter(safe);
  const verified = req.agent
    ? candidates.find((a) => a['id'] === req.agent)
    : (candidates.find((a) => a['id'] === 'explore') ?? candidates.find((a) => a['id'] === 'plan'));
  // NOTE: newer opencode builds grant `shell` to the built-in explore agent; the user accepted it as best-effort read-only.
  const bestEffort =
    verified || (req.agent && req.agent !== 'explore')
      ? undefined
      : agents.find((a): a is JsonObject => isRecord(a) && a['id'] === 'explore' && a['hidden'] !== true);
  const agent = verified ?? bestEffort;
  if (!agent) {
    throw new Error(
      'read-only-agent-unavailable: require an effective agent with wildcard deny and only read tool grants',
    );
  }
  const model = req.model ?? (typeof config['model'] === 'string' ? config['model'] : null);
  const providerId = model?.split('/')[0];
  const providers = isRecord(config['providers'])
    ? config['providers']
    : isRecord(config['provider'])
      ? config['provider']
      : {};
  const configured = providerId ? providers[providerId] : undefined;
  const provider: JsonObject = isRecord(configured) ? configured : {};
  const settings: JsonObject = isRecord(provider['settings'])
    ? provider['settings']
    : isRecord(provider['options'])
      ? provider['options']
      : {};
  const endpoint = typeof settings['baseURL'] === 'string' ? settings['baseURL'] : null;
  if (endpoint) {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('effective-config-unverified: unsupported endpoint');
    }
  }
  return {
    ...req,
    model,
    endpoint,
    agent: String(agent['id']),
    readOnlyVerified: Boolean(verified),
    ...(!verified && { readOnlyBestEffort: true }),
  };
}

export function nativeOpencodeIntrospection(
  binary: string,
  req: DelegateRequest,
  env: Readonly<Record<string, string | undefined>>,
  budgetMs: number,
  steps?: Array<LifecycleStep>,
): Introspect {
  if (env['OPENCODE_CONFIG_CONTENT']) {
    throw new Error('effective-config-unverified: inline config propagation requires an explicit user choice');
  }
  const deadline = Date.now() + budgetMs;
  return async (command) => {
    const remaining = Math.min(10_000, deadline - Date.now());
    if (remaining <= 0) {
      throw new Error('effective-config-unverified: opencode-lifecycle-timeout: preparation deadline expired');
    }
    const started = Date.now();
    let outcome: LifecycleStep['outcome'] = 'ok';
    const commandDeadline = started + remaining;
    const settlementDeadline = commandDeadline + KILL_ESCALATION_MS;
    const logPath = `${req.logPath}.introspect-${command}`;
    const killLogPath = `${logPath}.kill`;
    const child = nodeProcess.start(
      { argv: [binary, '--standalone', 'debug', command], env: sanitizeEnv(env), stdin: null, cwd: req.cwd },
      { logPath, capBytes: 1024 * 1024 },
    );
    let killerDone: Promise<ProcessResult> | undefined;
    let teardownStartFailed = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      if (child.pid <= 1) {
        return;
      }
      timedOut = true;
      if (process.platform === 'win32') {
        try {
          killerDone = nodeProcess.start(
            {
              argv: ['taskkill', '/PID', String(child.pid), '/T', '/F'],
              env: sanitizeEnv(env),
              stdin: null,
              cwd: req.cwd,
            },
            { logPath: killLogPath, capBytes: 4096 },
          ).done;
        } catch {
          teardownStartFailed = true;
        }
      } else {
        nodeProcess.signal(-child.pid, 'SIGKILL');
      }
    }, remaining);
    try {
      const result = await waitWithin(child.done, Math.max(0, settlementDeadline - Date.now()));
      clearTimeout(timer);
      const commandTimedOut = timedOut || (child.pid > 1 && Date.now() > commandDeadline) || result?.timedOut === true;
      if (!result) {
        throw new Error(
          'effective-config-unverified: opencode-lifecycle-timeout: native introspection process exit unconfirmed after bounded teardown',
        );
      }
      const killerResult = killerDone
        ? await waitWithin(killerDone, Math.max(0, settlementDeadline - Date.now()))
        : null;
      if (killerDone && !killerResult) {
        throw new Error(
          'effective-config-unverified: opencode-lifecycle-timeout: OpenCode teardown process exit unconfirmed after bounded teardown',
        );
      }
      if (teardownStartFailed || (killerResult !== null && killerResult.exit !== 0)) {
        throw new Error(
          'effective-config-unverified: opencode-lifecycle-timeout: OpenCode process-tree teardown did not confirm exit within the bounded deadline',
        );
      }
      if (child.pid > 1 && process.platform !== 'win32' && nodeProcess.settleGroup) {
        const grace = Math.max(0, Math.min(KILL_ESCALATION_MS, settlementDeadline - Date.now()));
        const confirmed = await nodeProcess.settleGroup(child.pid, grace);
        if (!confirmed) {
          throw new Error(
            'effective-config-unverified: opencode-lifecycle-timeout: process group exit unconfirmed; retain the worktree and verify process exit before cleanup',
          );
        }
      }
      if (commandTimedOut) {
        throw new Error(
          'effective-config-unverified: opencode-lifecycle-timeout: native introspection exceeded its command deadline',
        );
      }
      if (unsupportedStandaloneDiagnostic(`${result.stderrTail}\n${result.stdout}`)) {
        throw new Error(
          'effective-config-unverified: OpenCode binary does not support --standalone; upgrade to a supported v2 binary',
        );
      }
      if (result.exit !== 0 || result.truncated) {
        throw new Error('effective-config-unverified: native introspection failed');
      }
      try {
        return parseJson(result.stdout);
      } catch {
        throw new Error('effective-config-unverified: native introspection returned invalid JSON');
      }
    } catch (error) {
      outcome = /exit unconfirmed|did not confirm exit/.test(String(error))
        ? 'unconfirmed'
        : /opencode-lifecycle-timeout/.test(String(error))
          ? 'timeout'
          : 'failed';
      throw error;
    } finally {
      clearTimeout(timer);
      // Covers the command and its own process-tree settlement; the response teardown is measured by the runner.
      steps?.push({ step: `debug-${command}`, elapsedMs: Date.now() - started, budgetMs: remaining, outcome });
      for (const file of [logPath, killLogPath]) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* no credential-bearing introspection capture retained */
        }
      }
    }
  };
}

export async function fetchModels(endpoint: string, timeoutMs = 5000): Promise<ReadonlyArray<string> | null> {
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/models`, {
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, Math.min(5000, timeoutMs))),
    });
    if (!response.ok || !response.body) {
      return null;
    }
    const reader = response.body.getReader();
    const chunks: Array<Uint8Array> = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) {
        break;
      }
      const chunk: unknown = part.value;
      if (!types.isUint8Array(chunk)) {
        return null;
      }
      size += chunk.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isRecord(value) || !Array.isArray(value['data'])) {
      return null;
    }
    const ids: Array<string> = [];
    for (const row of value['data']) {
      if (
        !isRecord(row) ||
        typeof row['id'] !== 'string' ||
        !row['id'].trim() ||
        row['id'].length > 1024 ||
        // A code unit below U+0020 is a control character.
        /[^ -￿]/.test(row['id'])
      ) {
        return null;
      }
      ids.push(row['id']);
    }
    return ids;
  } catch {
    return null;
  }
}

type Owner = { host: string; pid: number; token: string };
const gpuLockPath = () =>
  path.join(fs.realpathSync(os.tmpdir()), 'dispatch-skills', '.locks', 'opencode-local-gpu.lock');
export async function acquireGpuLock(timeoutMs = 30_000, file = gpuLockPath()): Promise<() => Promise<void>> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const owner: Owner = { host: os.hostname(), pid: process.pid, token: crypto.randomUUID() };
  const guard = `${file}.guard`;
  const deadline = Date.now() + Math.max(0, Math.min(30_000, timeoutMs));
  const guardOnce = (): number | null => {
    try {
      return fs.openSync(guard, 'wx', 0o600);
    } catch (error) {
      if (nodeErrorCode(error) === 'EEXIST') {
        return null;
      }
      throw error;
    }
  };
  for (;;) {
    const fd = guardOnce();
    let acquired = false;
    if (fd !== null) {
      try {
        let prior: JsonValue = null;
        try {
          prior = parseJson(fs.readFileSync(file, 'utf8'));
        } catch (error) {
          if (nodeErrorCode(error) !== 'ENOENT') {
            throw new Error('gpu-lock-unverifiable', { cause: error });
          }
        }
        if (prior) {
          const held: JsonObject = isRecord(prior) ? prior : {};
          const { host, pid, token } = { host: held['host'], pid: held['pid'], token: held['token'] };
          if (
            host !== owner.host ||
            typeof pid !== 'number' ||
            !Number.isInteger(pid) ||
            pid <= 0 ||
            typeof token !== 'string' ||
            !token
          ) {
            throw new Error('gpu-lock-foreign-or-unverifiable');
          }
          try {
            process.kill(pid, 0);
          } catch (error) {
            if (nodeErrorCode(error) === 'ESRCH') {
              fs.unlinkSync(file);
              prior = null;
            } else {
              throw new Error('gpu-lock-owner-unverifiable', { cause: error });
            }
          }
        }
        if (!prior) {
          fs.writeFileSync(file, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
          acquired = true;
        }
      } finally {
        fs.closeSync(fd);
        fs.unlinkSync(guard);
      }
    }
    if (acquired) {
      let released = false;
      let pending: Promise<void> | null = null;
      return () => {
        if (released) {
          return Promise.resolve();
        }
        pending ??= (async () => {
          const until = Date.now() + 30_000;
          let releaseFd: number | null = null;
          while (releaseFd === null) {
            releaseFd = guardOnce();
            if (releaseFd !== null) {
              break;
            }
            if (Date.now() >= until) {
              throw new Error('gpu-lock-release-guard-unavailable');
            }
            await pause(Math.min(25, until - Date.now()));
          }
          try {
            try {
              const current = parseJson(fs.readFileSync(file, 'utf8'));
              if (current === null) {
                throw new Error('gpu-lock-unverifiable');
              }
              if (isRecord(current) && current['token'] === owner.token) {
                fs.unlinkSync(file);
              }
            } catch (error) {
              if (nodeErrorCode(error) !== 'ENOENT') {
                throw error;
              }
            }
            released = true;
          } finally {
            fs.closeSync(releaseFd);
            fs.unlinkSync(guard);
          }
        })().catch((error: unknown) => {
          pending = null;
          throw error;
        });
        return pending;
      };
    }
    if (Date.now() >= deadline) {
      throw new Error('gpu-lock-timeout');
    }
    await pause(Math.min(25, deadline - Date.now()));
  }
}

export function createOpencodePreparePorts(deadline: number): PreparePorts {
  return {
    fetchModels: (endpoint) => fetchModels(endpoint, deadline - Date.now()),
    acquireGpuLock: () => acquireGpuLock(deadline - Date.now()),
  };
}
