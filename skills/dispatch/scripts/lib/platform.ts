// Platform facts and orchestrator detection.
// Pure over injected getters; `currentPlatform()` binds the real process.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ProviderKey = 'claude' | 'agy' | 'copilot' | 'opencode' | 'codex';
export const PROVIDER_KEYS: readonly ProviderKey[] = ['claude', 'agy', 'copilot', 'opencode', 'codex'];

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

// SECTION: Orchestrator detection

// NOTE: VSCODE_PID is ignored because ordinary VS Code terminals also set it.
export const ORCHESTRATOR_MARKERS: Readonly<Record<ProviderKey, { platform: readonly string[]; model: readonly string[] }>> = {
  agy: { platform: ['ANTIGRAVITY_AGENT', 'ANTIGRAVITY_CONVERSATION_ID', 'ANTIGRAVITY_SESSION_ID', 'GEMINI_CLI'], model: ['ANTIGRAVITY_MODEL', 'GEMINI_MODEL'] },
  claude: { platform: ['CLAUDECODE', 'CLAUDE_CODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT'], model: ['CLAUDE_MODEL', 'ANTHROPIC_MODEL'] },
  copilot: { platform: ['COPILOT_AGENT', 'COPILOT_CLI_SESSION_ID'], model: ['COPILOT_MODEL', 'GITHUB_COPILOT_MODEL'] },
  opencode: { platform: ['OPENCODE_PORT', 'OPENCODE_AGENT'], model: ['OPENCODE_MODEL'] },
  codex: { platform: ['CODEX_THREAD_ID', 'CODEX_CLI', 'CODEX_APP_SERVER'], model: ['CODEX_MODEL'] },
};

// Detection order: agy, claude, copilot, opencode, codex.
const DETECTION_ORDER: readonly ProviderKey[] = ['agy', 'claude', 'copilot', 'opencode', 'codex'];

export type Orchestrator = { platform: ProviderKey; model: string | null };

/** The host platform from env markers, or null; `override` (`--orchestrator`) wins. */
export function detectOrchestrator(env: EnvGet, override: { platform?: ProviderKey; model?: string } = {}): Orchestrator | null {
  const platform = override.platform ?? DETECTION_ORDER.find((key) => ORCHESTRATOR_MARKERS[key].platform.some((name) => Boolean(env(name))));
  if (platform === undefined) return null;
  const model = override.model ?? ORCHESTRATOR_MARKERS[platform].model.map((name) => env(name)).find((value) => Boolean(value)) ?? null;
  return { platform, model };
}

/** XDG base-dir overrides that are set; omitted entirely when none are. */
function xdgOverrides(env: EnvGet): { xdg?: { data?: string; cache?: string; state?: string } } {
  const xdg = Object.fromEntries((['data', 'cache', 'state'] as const)
    .map((key) => [key, env(`XDG_${key.toUpperCase()}_HOME`)] as const).filter(([, value]) => Boolean(value)));
  return Object.keys(xdg).length ? { xdg } : {};
}
