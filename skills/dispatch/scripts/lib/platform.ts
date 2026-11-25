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

type EnvGet = (name: string) => string | undefined;

type PlatformInput = {
  platform: string;
  arch: string;
  release: string;
  home: string;
  env: EnvGet;
  bubblewrap: boolean;
};

const toOs = (platform: string): OsId => (platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux');

// NOTE: Windows caps a whole command line at 32767 chars; POSIX ARG_MAX is shared with the environment block.
const argvLimitFor = (osId: OsId): number => (osId === 'win32' ? 24000 : 100000);

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
    pathExt:
      osId === 'win32'
        ? (input.env('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
            .split(';')
            .filter(Boolean)
            .map((ext) => ext.toLowerCase())
        : [],
  };
}

/** Real process facts; bubblewrap is present when `bwrap` sits on PATH. */
export function currentPlatform(): PlatformEnv {
  const env: EnvGet = (name) => process.env[name];
  const dirs = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  const bubblewrap = process.platform === 'linux' && dirs.some((dir) => fs.existsSync(path.join(dir, 'bwrap')));
  return platformFacts({
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    home: os.homedir(),
    env,
    bubblewrap,
  });
}

// SECTION: Orchestrator

// The host platform comes only from the session record; env supplies the model.
const MODEL_ENV: Readonly<Record<ProviderKey, readonly string[]>> = {
  agy: ['ANTIGRAVITY_MODEL', 'GEMINI_MODEL'],
  claude: ['CLAUDE_MODEL', 'ANTHROPIC_MODEL'],
  copilot: ['COPILOT_MODEL', 'GITHUB_COPILOT_MODEL'],
  opencode: ['OPENCODE_MODEL'],
  codex: ['CODEX_MODEL'],
};

export type Orchestrator = { platform: ProviderKey; model: string | null };

/** OpenCode `subagent` model value: `P/M#E` with effort, otherwise `P/M`. */
export const opencodeModelValue = (model: string, effort?: string | null): string =>
  effort ? `${model}#${effort}` : model;

/** Host-specific launch instruction for a configured model list and effort. */
export function launchLine(provider: string, models: readonly string[], effort: string | null): string {
  const effortText = effort ? `effort ${effort}` : 'no effort set';
  if (!models.length) return `launch: no model configured, ${effortText}`;
  const [first, ...rest] = models,
    lower = provider.toLowerCase(),
    canonical = lower === 'antigravity' ? 'agy' : lower;
  if (canonical === 'opencode')
    return `launch: \`subagent\` with \`model: "${opencodeModelValue(first!, effort)}"\` (user-configured; set it despite the tool's default guidance)${rest.map((m) => `, else "${opencodeModelValue(m, effort)}"`).join('')}`;
  if (canonical === 'agy')
    return `launch: closest \`Model\` (\`inherit\`, \`flash_lite\`, \`flash\`, \`pro\`) to ${first!}, ${effortText}${rest.map((m) => `, else closest to ${m}`).join('')}`;
  return `launch: model ${first!}, ${effortText}${rest.map((m) => `, else ${m}`).join('')}`;
}

/** First-model summary form of `launchLine`, with a fallback count when more models exist. */
export const summaryLaunch = (provider: string, models: readonly string[], effort: string | null): string =>
  models.length <= 1
    ? launchLine(provider, models, effort)
    : `${launchLine(provider, models.slice(0, 1), effort)} (+${models.length - 1} fallbacks in result)`;

/** The orchestrator for a recorded host, or null when the value is not a ProviderKey. */
export function orchestratorFor(host: unknown, env: EnvGet): Orchestrator | null {
  if (typeof host !== 'string' || !Object.hasOwn(MODEL_ENV, host)) return null;
  return {
    platform: host as ProviderKey,
    model: MODEL_ENV[host as ProviderKey].map((name) => env(name)).find((value) => Boolean(value)) ?? null,
  };
}

/** True when Claude Code's sandboxed Bash environment variables are present. */
export function claudeHostSandboxed(env: EnvGet): boolean {
  return Boolean(env('SANDBOX_RUNTIME')) || env('SANDBOX') === '1';
}

/** XDG base-dir overrides that are set; omitted entirely when none are. */
function xdgOverrides(env: EnvGet): { xdg?: { data?: string; cache?: string; state?: string } } {
  const xdg = Object.fromEntries(
    (['data', 'cache', 'state'] as const)
      .map((key) => [key, env(`XDG_${key.toUpperCase()}_HOME`)] as const)
      .filter(([, value]) => Boolean(value)),
  );
  return Object.keys(xdg).length ? { xdg } : {};
}
