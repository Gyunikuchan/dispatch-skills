// Executable discovery (spec §6.3): expand each mode's candidates (`*` segments via
// the fs table, bare names via PATH/PATHEXT), probe executability, cache provider × mode per invocation.

import type { ModeId, PlatformEnv, ProviderId, ProviderSpec } from './types.ts';

export type DiscoveryFs = {
  /** Directory entry names; [] when missing. */
  list(dir: string): readonly string[];
  exists(file: string): boolean;
  /** Launchable regular file (POSIX execute bit; Windows: exists). */
  executable(file: string): boolean;
};

export type Resolution =
  | { status: 'path'; path: string }
  | { status: 'missing'; path: null }
  | { status: 'unlaunchable'; path: string };

export type DoctorRow = { provider: ProviderId; mode: ModeId } & Resolution;

const isAbsolute = (file: string): boolean => /^(?:[a-zA-Z]:[/\\]|[/\\])/.test(file);
const sep = (env: PlatformEnv): string => (env.os === 'win32' ? '\\' : '/');

function globMatch(pattern: string, name: string): boolean {
  const source = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}$`, 'i').test(name);
}

/** Expands `*` segments against the fs table; sorted descending so the newest version-suffixed dir wins. */
export function expandCandidate(candidate: string, fs: DiscoveryFs): string[] {
  const parts = candidate.split(/[/\\]/);
  const joiner = candidate.includes('\\') ? '\\' : '/';
  let prefixes = [parts[0] ?? ''];
  for (const part of parts.slice(1)) {
    if (!part.includes('*')) { prefixes = prefixes.map((prefix) => `${prefix}${joiner}${part}`); continue; }
    prefixes = prefixes.flatMap((prefix) => fs.list(prefix || joiner).filter((name) => globMatch(part, name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }))
      .map((name) => `${prefix}${joiner}${name}`));
  }
  return prefixes;
}

/** A bare name resolves through PATH (and PATHEXT on Windows when it has no extension). */
function onPath(name: string, env: PlatformEnv): string[] {
  const exts = env.os === 'win32' && !/\.[a-z0-9]+$/i.test(name) ? env.pathExt.map((ext) => ext.toLowerCase()) : [''];
  return env.path.flatMap((dir) => exts.map((ext) => `${dir}${sep(env)}${name}${ext}`));
}

export type Discovery = {
  resolve(provider: ProviderId, mode: ModeId): Resolution;
  doctor(): DoctorRow[];
  /** Probes performed so far (each candidate path at most once per invocation). */
  readonly probes: number;
};

export function createDiscovery(specs: Readonly<Record<ProviderId, ProviderSpec>>, env: PlatformEnv, fs: DiscoveryFs): Discovery {
  const cache = new Map<string, Resolution>();
  const probed = new Map<string, 'exec' | 'present' | 'absent'>();
  let probes = 0;
  const probe = (file: string): 'exec' | 'present' | 'absent' => {
    const known = probed.get(file);
    if (known) return known;
    probes++;
    const state = !fs.exists(file) ? 'absent' : fs.executable(file) ? 'exec' : 'present';
    probed.set(file, state);
    return state;
  };
  const resolve = (provider: ProviderId, mode: ModeId): Resolution => {
    const key = `${provider}:${mode}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const spec = specs[provider].modes.find((entry) => entry.id === mode);
    let unlaunchable: string | null = null;
    let found: Resolution | null = null;
    for (const candidate of spec ? spec.candidates(env) : []) {
      const paths = isAbsolute(candidate) ? expandCandidate(candidate, fs) : onPath(candidate, env);
      for (const file of paths) {
        const state = probe(file);
        if (state === 'exec') { found = { status: 'path', path: file }; break; }
        if (state === 'present') unlaunchable ??= file;
      }
      if (found) break;
    }
    const result: Resolution = found ?? (unlaunchable ? { status: 'unlaunchable', path: unlaunchable } : { status: 'missing', path: null });
    cache.set(key, result);
    return result;
  };
  return {
    resolve,
    doctor: () => (Object.keys(specs) as ProviderId[]).flatMap((provider) =>
      specs[provider].modes.map((mode): DoctorRow => ({ provider, mode: mode.id, ...resolve(provider, mode.id) }))),
    get probes() { return probes; },
  };
}
