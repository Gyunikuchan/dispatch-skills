// Platform facts and the recorded-host orchestrator.
// Pure over injected getters; `currentPlatform()` binds the real process.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ProviderKey = 'claude' | 'agy' | 'copilot' | 'opencode' | 'codex';

export type OsId = 'win32' | 'darwin' | 'linux';

export type PlatformEnv = {
  os: OsId;
  arch: string;
  wsl: boolean;
  bubblewrap: boolean;
  /** Conservative per-argv-element ceiling in bytes. */
  argvLimit: number;
  home: string;
  /** PATH directories, in order. */
  path: readonly string[];
  /** Windows executable extensions (lowercase, with dot); empty elsewhere. */
  pathExt: readonly string[];
  /** XDG_DATA_HOME / XDG_CACHE_HOME / XDG_STATE_HOME when set. */
  xdg?: { data?: string; cache?: string; state?: string };
};

export type EnvGet = (name: string) => string | undefined;

export type PlatformInput = { platform: string; arch: string; release: string; home: string; env: EnvGet; bubblewrap: boolean };

export const toOs = (platform: string): OsId => (platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux');

// NOTE: Windows caps a whole command line at 32767 chars; POSIX ARG_MAX is shared with the environment block.
export const argvLimitFor = (osId: OsId): number => (osId === 'win32' ? 24000 : 100000);

export function platformFacts(input: PlatformInput): PlatformEnv {
  const osId = toOs(input.platform);
  const wsl = osId === 'linux' && (Boolean(input.env('WSL_DISTRO_NAME')) || /microsoft/i.test(input.release));
  const sep = osId === 'win32' ? ';' : ':';
  const rawPath = input.env('PATH') ?? input.env('Path') ?? '';
  return {
    os: osId,
    arch: input.arch,
    wsl,
    bubblewrap: osId === 'linux' && input.bubblewrap,
    argvLimit: argvLimitFor(osId),
    home: input.home,
    ...xdgOverrides(input.env),
    path: rawPath.split(sep).filter(Boolean),
    pathExt: osId === 'win32' ? (input.env('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((ext) => ext.toLowerCase()) : [],
  };
}

/** Real process facts; bubblewrap is present when `bwrap` sits on PATH. */
export function currentPlatform(): PlatformEnv {
  const env: EnvGet = (name) => process.env[name];
  const dirs = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  const bubblewrap = process.platform === 'linux' && dirs.some((dir) => fs.existsSync(path.join(dir, 'bwrap')));
  return platformFacts({ platform: process.platform, arch: process.arch, release: os.release(), home: os.homedir(), env, bubblewrap });
}

// SECTION: Orchestrator

// The host platform comes only from the session record; env supplies the model.
const MODEL_ENV: Readonly<Record<ProviderKey, readonly string[]>> = {
  agy: ['ANTIGRAVITY_MODEL', 'GEMINI_MODEL'], claude: ['CLAUDE_MODEL', 'ANTHROPIC_MODEL'], copilot: ['COPILOT_MODEL', 'GITHUB_COPILOT_MODEL'],
  opencode: ['OPENCODE_MODEL'], codex: ['CODEX_MODEL'],
};

export type Orchestrator = { platform: ProviderKey; model: string | null };

/** The orchestrator for a recorded host, or null when the value is not a ProviderKey. */
export function orchestratorFor(host: unknown, env: EnvGet): Orchestrator | null {
  if (typeof host !== 'string' || !Object.hasOwn(MODEL_ENV, host)) return null;
  return { platform: host as ProviderKey, model: MODEL_ENV[host as ProviderKey].map((name) => env(name)).find((value) => Boolean(value)) ?? null };
}

/** XDG base-dir overrides that are set; omitted entirely when none are. */
function xdgOverrides(env: EnvGet): { xdg?: { data?: string; cache?: string; state?: string } } {
  const xdg = Object.fromEntries((['data', 'cache', 'state'] as const)
    .map((key) => [key, env(`XDG_${key.toUpperCase()}_HOME`)] as const).filter(([, value]) => Boolean(value)));
  return Object.keys(xdg).length ? { xdg } : {};
}
