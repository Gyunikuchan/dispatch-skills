import type { OsId, PlatformEnv } from "../lib/platform.ts";

const BATCH_LAUNCHER_ARG_BYTE_LIMIT = 8000;

const SAFE_ENV_WHITELIST: ReadonlySet<string> = new Set([
  "PATH",
  "Path",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "windir",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ProgramData",
  "PROGRAMFILES",
  "ProgramFiles",
  "PROGRAMFILES(X86)",
  "ProgramFiles(x86)",
  "COMMONPROGRAMFILES",
  "CommonProgramFiles",
  "ALLUSERSPROFILE",
  "SYSTEMDRIVE",
  "SystemDrive",
  "NODE_ENV",
  "TERM",
  "LANG",
  "LC_ALL",
  "SHELL",
  "COMSPEC",
  "GIT_EXEC_PATH",

  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "JETSKI_APP_DATA_DIR",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "USER",
  "USERNAME",
  "LOGNAME",
  "TZ",
]);

const SENSITIVE_ENV_KEY =
  /(?<rg1>KEY|SECRET|TOKEN|PASSWORD|AUTH|CREDENTIAL|PRIVATE)/iu;

export interface EnvVars {
  [name: string]: string;
}

export const sanitizeEnv = (
  env: Readonly<Record<string, string | undefined>>
) => {
  const clean: EnvVars = {};

  for (const [key, value] of Object.entries(env)) {
    if (
      value !== undefined &&
      SAFE_ENV_WHITELIST.has(key) &&
      !SENSITIVE_ENV_KEY.test(key)
    ) {
      clean[key] = value;
    }
  }

  return clean;
};

export const isBatchLauncher = (os: string, binary: string) =>
  os === "win32" && /\.(?:bat|cmd)$/iu.test(binary);

/** Whether the prompt must spill: over the argv ceiling, unsafe for a Windows command shim, or too large for a batch launcher. */
export const mustSpill = (
  prompt: string,
  env: PlatformEnv,
  binary: string,
  reservedBytes = 0
) => {
  const size = Buffer.byteLength(prompt, "utf-8");
  const windowsShim = env.os === "win32" && /[\r\n%]/u.test(prompt);

  const batch =
    isBatchLauncher(env.os, binary) &&
    size > Math.max(0, BATCH_LAUNCHER_ARG_BYTE_LIMIT - reservedBytes);

  return size > env.argvLimit || windowsShim || batch;
};

export const KILL_ESCALATION_MS = 1000;

/** The Windows tree-kill launch; POSIX signals the negative pid (process group) instead. */
export const killArgv = (os: OsId, pid: number) =>
  os === "win32"
    ? ["taskkill", "/pid", String(pid), "/T", "/F"]
    : ["kill", "-TERM", `-${pid}`];

/** Waits for an owned process effect without allowing teardown to hold a caller indefinitely. */
export const waitWithin = async <T>(promise: Promise<T>, ms: number) =>
  // oxlint-disable-next-line promise/avoid-new -- deferred wraps setTimeout with clearTimeout teardown; timers/promises delay cannot cancel the timer.
  await new Promise<T | null>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        resolve(null);
      },
      Math.max(0, ms)
    );

    // oxlint-disable-next-line promise/catch-or-return, promise/prefer-catch -- two-arg then settles one deferred; a catch chain would split the resolve/reject teardown paths.
    promise.then(
      // oxlint-disable-next-line promise/always-return -- callbacks settle the outer deferred via resolve/reject; a return value would fork an unobserved promise.
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- reason forwarded verbatim from the wrapped promise; wrapping would change caller-observed identity.
        reject(error);
      }
    );
  });

const CMD_META_CHARS = /(?<rg1>[()\]!^"`<>&|;, *?])/gu;

const escapeCmdArgument = (argument: string) => {
  const quoted = `"${argument
    .replaceAll(/(?<rg1>\\*)"/gu, String.raw`$1$1\"`)
    .replace(/(?<rg1>\\*)$/u, "$1$1")}"`.replaceAll(CMD_META_CHARS, "^$1");

  return quoted.replaceAll(CMD_META_CHARS, "^$1");
};

/**
 * Batch launchers (.cmd/.bat) cannot run without cmd.exe, and `shell: true` concatenates argv unescaped (injection);
 * route through cmd.exe with every argument escaped and verbatim arguments.
 */
export interface BatchInvocation {
  command: string;
  args: string[];
}

export const batchInvocation = (
  binary: string,
  args: readonly string[],
  comSpec = "cmd.exe"
) => {
  if (args.some((arg) => /[\r\n]/u.test(arg))) {
    throw new Error(
      "batch launcher argument contains a newline; spill it to a brief file"
    );
  }

  if (args.some((arg) => arg.includes("%"))) {
    throw new Error(
      "batch launcher argument contains %; spill it to a brief file"
    );
  }

  const line = [
    binary.replaceAll(CMD_META_CHARS, "^$1"),
    ...args.map(escapeCmdArgument),
  ].join(" ");

  return { command: comSpec, args: ["/d", "/s", "/c", `"${line}"`] };
};
