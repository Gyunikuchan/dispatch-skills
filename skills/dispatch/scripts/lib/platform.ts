// Platform facts and the recorded-host orchestrator.
// Pure over injected getters; `currentPlatform()` binds the real process.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** XDG base-dir overrides that are set; omitted entirely when none are. */
const xdgOverrides = (env: EnvGet) => {
  const xdg = Object.fromEntries(
    (["data", "cache", "state"] as const).flatMap((key) => {
      const value = env(`XDG_${key.toUpperCase()}_HOME`);

      return value === undefined || value === "" ? [] : [[key, value] as const];
    })
  );

  return Object.keys(xdg).length ? { xdg } : {};
};

export type ProviderKey = "claude" | "agy" | "copilot" | "opencode" | "codex";

export type OsId = "win32" | "darwin" | "linux";

export interface PlatformEnv {
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
}

type EnvGet = (name: string) => string | undefined;

interface PlatformInput {
  platform: string;
  arch: string;
  release: string;
  home: string;
  env: EnvGet;
  bubblewrap: boolean;
}

const toOs: (platform: string) => OsId = (platform) => {
  if (platform === "win32") {
    return "win32";
  }

  if (platform === "darwin") {
    return "darwin";
  }

  return "linux";
};

// NOTE: Windows caps a whole command line at 32767 chars; POSIX ARG_MAX is shared with the environment block.
const argvLimitFor = (osId: OsId) => (osId === "win32" ? 24_000 : 100_000);

export const platformFacts = (input: PlatformInput) => {
  const osId = toOs(input.platform);

  const wsl =
    osId === "linux" &&
    (Boolean(input.env("WSL_DISTRO_NAME")) ||
      /microsoft/iu.test(input.release));

  const sep = osId === "win32" ? ";" : ":";
  const rawPath = input.env("PATH") ?? input.env("Path") ?? "";

  return {
    os: osId,
    arch: input.arch,
    wsl,
    bubblewrap: osId === "linux" && input.bubblewrap,
    argvLimit: argvLimitFor(osId),
    home: input.home,
    ...xdgOverrides(input.env),
    path: rawPath.split(sep).filter(Boolean),
    pathExt:
      osId === "win32"
        ? (input.env("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
            .split(";")
            .filter(Boolean)
            .map((ext) => ext.toLowerCase())
        : [],
  };
};

const processEnv: EnvGet = (name) => process.env[name];

/** Real process facts; bubblewrap is present when `bwrap` sits on PATH. */
export const currentPlatform: () => PlatformEnv = () => {
  const dirs = (process.env["PATH"] ?? "")
    .split(path.delimiter)
    .filter(Boolean);

  const bubblewrap =
    process.platform === "linux" &&
    dirs.some((dir) => fs.existsSync(path.join(dir, "bwrap")));

  return platformFacts({
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    home: os.homedir(),
    env: processEnv,
    bubblewrap,
  });
};

// SECTION: Orchestrator

// The host platform comes only from the session record; env supplies the model.
const MODEL_ENV: Readonly<Record<ProviderKey, readonly string[]>> = {
  agy: ["ANTIGRAVITY_MODEL", "GEMINI_MODEL"],
  claude: ["CLAUDE_MODEL", "ANTHROPIC_MODEL"],
  copilot: ["COPILOT_MODEL", "GITHUB_COPILOT_MODEL"],
  opencode: ["OPENCODE_MODEL"],
  codex: ["CODEX_MODEL"],
};

export interface Orchestrator {
  platform: ProviderKey;
  model: string | null;
}

/** OpenCode `subagent` model value: `P/M#E` with effort, otherwise `P/M`. */
export const opencodeModelValue = (model: string, effort?: string | null) =>
  effort !== undefined && effort !== null && effort !== ""
    ? `${model}#${effort}`
    : model;

/** Host-specific launch instruction for a configured model list and effort. */
export const launchLine = (
  provider: string,
  models: readonly string[],
  effort: string | null
) => {
  const effortText =
    effort !== null && effort !== "" ? `effort ${effort}` : "no effort set";

  const [first, ...rest] = models;

  if (first === undefined) {
    return `launch: no model configured, ${effortText}`;
  }

  const lower = provider.toLowerCase();
  const canonical = lower === "antigravity" ? "agy" : lower;

  if (canonical === "opencode") {
    return `launch: \`subagent\` with \`model: "${opencodeModelValue(first, effort)}"\` (user-configured; set it despite the tool's default guidance)${rest.map((m) => `, else "${opencodeModelValue(m, effort)}"`).join("")}`;
  }

  if (canonical === "agy") {
    return `launch: closest \`Model\` (\`inherit\`, \`flash_lite\`, \`flash\`, \`pro\`) to ${first}, ${effortText}${rest.map((m) => `, else closest to ${m}`).join("")}`;
  }

  return `launch: model ${first}, ${effortText}${rest.map((m) => `, else ${m}`).join("")}`;
};

/** First-model summary form of `launchLine`, with a fallback count when more models exist. */
export const summaryLaunch = (
  provider: string,
  models: readonly string[],
  effort: string | null
) =>
  models.length <= 1
    ? launchLine(provider, models, effort)
    : `${launchLine(provider, models.slice(0, 1), effort)} (+${models.length - 1} fallbacks in result)`;

const isProviderKey = (host: string): host is ProviderKey =>
  Object.hasOwn(MODEL_ENV, host);

/** The orchestrator for a recorded host, or null when the value is not a ProviderKey. */
export const orchestratorFor = (host: unknown, env: EnvGet) => {
  if (typeof host !== "string" || !isProviderKey(host)) {
    return null;
  }

  return {
    platform: host,
    model: MODEL_ENV[host].map((name) => env(name)).find(Boolean) ?? null,
  };
};

/** True when Claude Code's sandboxed Bash environment variables are present. */
export const claudeHostSandboxed = (env: EnvGet) =>
  Boolean(env("SANDBOX_RUNTIME")) || env("SANDBOX") === "1";
