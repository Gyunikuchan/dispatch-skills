import nodeFs from "node:fs";
// Executable discovery (spec §6.3): expand each mode's candidates (`*` segments via
// the fs table, bare names via PATH/PATHEXT), probe executability, cache provider × mode per invocation.

import type { ModeId, PlatformEnv, ProviderId, ProviderSpec } from "./types.ts";

export interface DiscoveryFs {
  /** Directory entry names; [] when missing. */
  list: (dir: string) => readonly string[];
  exists: (file: string) => boolean;
  /** Launchable regular file (POSIX execute bit; Windows: exists). */
  executable: (file: string) => boolean;
}

type Resolution =
  | { status: "path"; path: string }
  | { status: "missing"; path: null }
  | { status: "unlaunchable"; path: string };

type DoctorRow = { provider: ProviderId; mode: ModeId } & Resolution;

const isAbsolute = (file: string) => /^(?:[a-zA-Z]:[/\\]|[/\\])/u.test(file);

const sep = (env: PlatformEnv) => (env.os === "win32" ? "\\" : "/");

const globMatch = (pattern: string, name: string) => {
  const source = pattern
    .split("*")
    .map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/gu, String.raw`\$&`))
    .join(".*");

  return new RegExp(`^${source}$`, "iu").test(name);
};

/** Expands `*` segments against the fs table; sorted descending so the newest version-suffixed dir wins. */
export const expandCandidate = (candidate: string, fs: DiscoveryFs) => {
  const parts = candidate.split(/[/\\]/u);
  const joiner = candidate.includes("\\") ? "\\" : "/";
  let prefixes = [parts[0] ?? ""];

  for (const part of parts.slice(1)) {
    if (!part.includes("*")) {
      prefixes = prefixes.map((prefix) => `${prefix}${joiner}${part}`);
      continue;
    }

    prefixes = prefixes.flatMap((prefix) =>
      fs
        .list(prefix || joiner)
        .filter((name) => globMatch(part, name))
        .toSorted((a, b) =>
          b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" })
        )
        .map((name) => `${prefix}${joiner}${name}`)
    );
  }

  return prefixes;
};

/** A bare name resolves through PATH (and PATHEXT on Windows when it has no extension). */
const onPath = (name: string, env: PlatformEnv) => {
  const exts =
    env.os === "win32" && !/\.[a-z0-9]+$/iu.test(name)
      ? env.pathExt.map((ext) => ext.toLowerCase())
      : [""];

  return env.path.flatMap((dir) =>
    exts.map((ext) => `${dir}${sep(env)}${name}${ext}`)
  );
};

export interface Discovery {
  resolve: (provider: ProviderId, mode: ModeId) => Resolution;
  doctor: () => DoctorRow[];
  /** Probes performed so far (each candidate path at most once per invocation). */
  readonly probes: number;
}

export const createDiscovery = (
  specs: Readonly<Record<ProviderId, ProviderSpec>>,
  env: PlatformEnv,
  fs: DiscoveryFs
) => {
  const cache = new Map<string, Resolution>();
  const probed = new Map<string, "exec" | "present" | "absent">();
  let probes = 0;

  const probe = (file: string) => {
    const known = probed.get(file);

    if (known) {
      return known;
    }

    probes += 1;

    let state: "exec" | "present" | "absent";

    if (fs.exists(file)) {
      state = fs.executable(file) ? "exec" : "present";
    } else {
      state = "absent";
    }

    probed.set(file, state);

    return state;
  };

  const resolve = (provider: ProviderId, mode: ModeId) => {
    const key = `${provider}:${mode}`;
    const hit = cache.get(key);

    if (hit) {
      return hit;
    }

    const spec = specs[provider].modes.find((entry) => entry.id === mode);
    let unlaunchable: string | null = null;
    let found: Resolution | null = null;

    for (const candidate of spec ? spec.candidates(env) : []) {
      const paths = isAbsolute(candidate)
        ? expandCandidate(candidate, fs)
        : onPath(candidate, env);

      for (const file of paths) {
        const state = probe(file);

        if (state === "exec") {
          found = { status: "path", path: file };
          break;
        }

        if (state === "present") {
          unlaunchable ??= file;
        }
      }

      if (found) {
        break;
      }
    }

    const result: Resolution =
      found ??
      (unlaunchable === null
        ? { status: "missing", path: null }
        : { status: "unlaunchable", path: unlaunchable });

    cache.set(key, result);

    return result;
  };

  return {
    resolve,
    doctor: () =>
      Object.keys(specs)
        .filter((key): key is ProviderId => Object.hasOwn(specs, key))
        .flatMap((provider) =>
          specs[provider].modes.map((mode) => ({
            provider,
            mode: mode.id,
            ...resolve(provider, mode.id),
          }))
        ),
    get probes() {
      return probes;
    },
  };
};

export const createNodeDiscovery = (
  specs: Readonly<Record<ProviderId, ProviderSpec>>,
  platform: PlatformEnv
) =>
  createDiscovery(specs, platform, {
    list(dir) {
      try {
        return nodeFs.readdirSync(dir);
      } catch {
        return [];
      }
    },
    exists: nodeFs.existsSync,
    executable(file) {
      try {
        const stat = nodeFs.statSync(file);

        if (!stat.isFile()) {
          return false;
        }

        if (platform.os === "win32") {
          return true;
        }

        try {
          nodeFs.accessSync(file, nodeFs.constants.X_OK);

          return true;
        } catch {
          return false;
        }
      } catch {
        return false;
      }
    },
  });
