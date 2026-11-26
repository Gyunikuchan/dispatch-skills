import { spawn } from "node:child_process";
import fs from "node:fs";

import { nodeErrorCode } from "../lib/fs-ext.ts";
import { currentPlatform } from "../lib/platform.ts";
import { createNodeDiscovery } from "./discovery.ts";
import type { Discovery } from "./discovery.ts";
import { SPECS } from "./index.ts";
import { bwrapArgv, unsupportedStandaloneDiagnostic } from "./opencode.ts";
import {
  batchInvocation,
  isBatchLauncher,
  sanitizeEnv,
} from "./process-policy.ts";
import type { PlatformEnv, ProviderId } from "./types.ts";

const CONCURRENCY = 4;
const PROVIDER_MS = 10_000;
const GLOBAL_MS = 15_000;
const STREAM_BYTES = 64 * 1024;
const STANDALONE_STDOUT_BYTES = 1024 * 1024;

export interface ProbeTarget {
  provider: ProviderId;
  sandboxRequired: boolean;
}

export type ProbeReadiness =
  | "ok"
  | "unauthenticated"
  | "unsupported"
  | "unprobeable"
  | "error";

export type ProbeSandbox = "ok" | "unverified" | "unsupported" | "unavailable";

const REMEDIATION = {
  "not-found": "Install the provider CLI and make its launcher discoverable.",
  timeout: "Check whether the provider starts promptly, then retry the probe.",
  "unsupported-version": "Upgrade OpenCode to a release with standalone mode.",
  "sandbox-unavailable": "Check bubblewrap and OpenCode state directories.",
  "sandbox-unsupported":
    "Set sandbox: false for this provider to opt out of OS isolation, or use a platform that supports its sandbox.",
  "config-error": "Check the provider configuration and available agents.",
  "probe-error": "Check that the installed provider CLI starts successfully.",
} as const;

export type ProbeFailureCategory = keyof typeof REMEDIATION | null;

export interface ProviderProbeResult {
  provider: ProviderId;
  binaryFound: boolean;
  version: string | null;
  readiness: ProbeReadiness;
  sandbox: ProbeSandbox;
  failureCategory: ProbeFailureCategory;
  remediation: string | null;
}

export interface ProbeSummary {
  ok: number;
  failed: number;
  unprobeable: number;
  unverified: number;
}

interface ProbeOutput {
  exit: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  errorCode?: string;
  timedOut?: boolean;
}

interface ProbeLaunch {
  cwd: string;
  timeoutMs: number;
  stdoutCapBytes?: number;
}

export type ProbeSpawnPort = (
  binary: string,
  args: readonly string[],
  launch: ProbeLaunch
) => Promise<ProbeOutput>;

export interface ProbeDeps {
  spawn?: ProbeSpawnPort;
  platform?: PlatformEnv;
  discovery?: Discovery;
  exists?: (path: string) => boolean;
  cwd?: string;
  now?: () => number;
}

const cappedStream = (capBytes = STREAM_BYTES) => {
  const buffer = Buffer.alloc(capBytes);
  let size = 0;
  let truncated = false;

  return {
    append: (chunk: Buffer) => {
      const copied = chunk.copy(
        buffer,
        size,
        0,
        Math.min(chunk.length, buffer.length - size)
      );

      size += copied;

      if (copied < chunk.length) {
        truncated = true;
      }
    },
    text: () => buffer.toString("utf-8", 0, size),
    truncated: () => truncated,
  };
};

const killGroup = (pid: number) => {
  try {
    process.kill(-pid, "SIGKILL");

    return true;
  } catch (error) {
    // ESRCH means the process group has already exited.
    return nodeErrorCode(error) === "ESRCH";
  }
};

export const nodeProbeSpawn: ProbeSpawnPort = async (
  binary,
  args,
  { cwd, timeoutMs, stdoutCapBytes }
) =>
  // oxlint-disable-next-line promise/avoid-new -- deferred promise resolved by child-process callbacks; async/await cannot express this shape.
  await new Promise((resolve) => {
    const windows = process.platform === "win32";
    const env = sanitizeEnv(process.env);
    const batch = isBatchLauncher(process.platform, binary);

    const invocation = batch
      ? batchInvocation(binary, args, env["COMSPEC"])
      : { command: binary, args };

    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: !windows,
      windowsHide: true,
      windowsVerbatimArguments: batch,
    });

    const stdout = cappedStream(stdoutCapBytes);
    const stderr = cappedStream();
    let exited = false;
    let timedOut = false;
    child.stdout.on("data", stdout.append);
    child.stderr.on("data", stderr.append);
    child.once("exit", () => {
      exited = true;

      if (!windows && !timedOut && child.pid !== undefined) {
        killGroup(child.pid);
      }
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        exit: null,
        stdout: "",
        stderr: "",
        errorCode: error.code ?? "UNKNOWN",
      });
    });
    child.once("close", (exit) => {
      clearTimeout(timer);
      resolve({
        exit,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated(),
      });
    });

    const timer = setTimeout(() => {
      timedOut = true;

      if (!exited && child.pid !== undefined) {
        if (windows) {
          // taskkill owns the tree teardown. Do not kill the parent first or lose its descendants.
          const killer = spawn(
            "taskkill",
            ["/PID", String(child.pid), "/T", "/F"],
            {
              env,
              stdio: "ignore",
              windowsHide: true,
            }
          );

          killer.once("error", () => {
            child.kill();
          });
          killer.once("exit", (code) => {
            if (code !== 0 && !exited) {
              child.kill();
            }
          });

          const killTimer = setTimeout(() => {
            killer.kill();

            if (!exited) {
              child.kill();
            }
          }, 1000);

          killTimer.unref();
          killer.once("close", () => {
            clearTimeout(killTimer);
          });
          killer.unref();
        } else if (!killGroup(child.pid)) {
          child.kill("SIGKILL");
        }
      }

      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolve({ exit: null, stdout: "", stderr: "", timedOut: true });
    }, timeoutMs);
  });

const initialSandbox = (provider: ProviderId, platform: PlatformEnv) => {
  if (provider === "opencode") {
    if (platform.os !== "linux") {
      return "unsupported";
    }

    return platform.bubblewrap ? "unverified" : "unavailable";
  }

  return SPECS[provider].sandbox?.supported(platform) === true
    ? "unverified"
    : "unsupported";
};

const numericVersion = (stdout: string) => {
  const firstLine =
    stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) ?? "";

  const match =
    /^(?:[A-Za-z0-9._/-]{1,32}\s+)?v?(?<rg1>\d{1,4})\.(?<rg2>\d{1,4})\.(?<rg3>\d{1,4})(?:\s|$)/u.exec(
      firstLine
    );

  return match
    ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`
    : null;
};

const hasErrorCode = (value: string | null | undefined) =>
  value !== undefined && value !== null && value !== "";

const standaloneFailure = (output: ProbeOutput) => {
  if (hasErrorCode(output.errorCode)) {
    return "probe-error";
  }

  if (unsupportedStandaloneDiagnostic(`${output.stderr}\n${output.stdout}`)) {
    return "unsupported-version";
  }

  if (output.exit !== 0 || output.stdoutTruncated === true) {
    return "config-error";
  }

  try {
    return Array.isArray(JSON.parse(output.stdout)) ? null : "config-error";
  } catch {
    return "config-error";
  }
};

const hasAllBindSources = (
  args: readonly string[],
  exists: (path: string) => boolean
) => {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--bind" || args[index] === "--ro-bind") {
      const source = args[index + 1];

      if (source === undefined || !exists(source)) {
        return false;
      }

      index += 2;
    }

    if (args[index] === "--") {
      break;
    }
  }

  return true;
};

// oxlint-disable-next-line eslint/complexity -- probe outcome table enumerates every provider mode; refactor deferred to avoid behavior drift.
const probeProvider = async (
  target: ProbeTarget,
  deps: Required<ProbeDeps>,
  globalDeadline: number
) => {
  const { provider, sandboxRequired } = target;
  const { discovery, platform, now, cwd, exists } = deps;
  const providerDeadline = now() + PROVIDER_MS;
  const baseline = initialSandbox(provider, platform);
  let binaryFound = false;
  let version: string | null = null;

  const row = (
    readiness: ProbeReadiness,
    sandbox: ProbeSandbox,
    failureCategory: ProbeFailureCategory
  ) => ({
    provider,
    binaryFound,
    version,
    readiness,
    sandbox,
    failureCategory,
    remediation: failureCategory === null ? null : REMEDIATION[failureCategory],
  });

  const timeout = () => row("error", baseline, "timeout");
  const remaining = () => Math.min(providerDeadline, globalDeadline) - now();

  const run = async (
    binary: string,
    args: readonly string[],
    stdoutCapBytes = STREAM_BYTES
  ) => {
    const timeoutMs = remaining();

    if (timeoutMs <= 0) {
      return { exit: null, stdout: "", stderr: "", timedOut: true };
    }

    try {
      return await deps.spawn(binary, args, { cwd, timeoutMs, stdoutCapBytes });
    } catch (error) {
      return {
        exit: null,
        stdout: "",
        stderr: "",
        errorCode: nodeErrorCode(error) ?? "UNKNOWN",
      };
    }
  };

  if (remaining() <= 0) {
    return timeout();
  }

  let binary: string | null = null;

  for (const mode of SPECS[provider].modes) {
    const resolution = discovery.resolve(provider, mode.id);

    if (resolution.status === "path") {
      binary = resolution.path;
      break;
    }
  }

  if (binary === undefined || binary === null || binary === "") {
    return row("error", baseline, "not-found");
  }

  const versionOutput = await run(binary, ["--version"]);

  if (versionOutput.timedOut === true) {
    return timeout();
  }

  if (
    versionOutput.errorCode === "ENOENT" ||
    versionOutput.errorCode === "EACCES"
  ) {
    return row("error", baseline, "not-found");
  }

  if (hasErrorCode(versionOutput.errorCode) || versionOutput.exit !== 0) {
    return row("error", baseline, "probe-error");
  }

  binaryFound = true;
  version = numericVersion(versionOutput.stdout);

  let readiness: ProbeReadiness = "unprobeable";
  let sandbox: ProbeSandbox = baseline;
  let failure: ProbeFailureCategory = null;

  if (provider === "opencode") {
    for (const command of ["config", "agents"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential config probes share one short-lived process budget.
      const output = await run(
        binary,
        ["--standalone", "debug", command],
        STANDALONE_STDOUT_BYTES
      );

      if (output.timedOut === true) {
        return timeout();
      }

      failure = standaloneFailure(output);

      if (failure !== null) {
        break;
      }
    }

    if (failure === null) {
      readiness = "ok";
    } else if (failure === "unsupported-version") {
      readiness = "unsupported";
    } else {
      readiness = "error";
    }

    if (baseline === "unverified") {
      const [command, ...args] = bwrapArgv({ cwd, platform, briefFile: null }, [
        "true",
      ]);

      sandbox = "unavailable";

      if (command !== undefined && hasAllBindSources(args, exists)) {
        const output = await run(command, args);

        if (output.timedOut === true) {
          return timeout();
        }

        if (!hasErrorCode(output.errorCode) && output.exit === 0) {
          sandbox = "ok";
        }
      }
    }
  }

  if (failure === null && sandboxRequired) {
    if (sandbox === "unavailable") {
      failure = "sandbox-unavailable";
    }

    if (sandbox === "unsupported") {
      failure = "sandbox-unsupported";
    }
  }

  return row(readiness, sandbox, failure);
};

const failedProbe = (
  row: ProviderProbeResult,
  { sandboxRequired }: ProbeTarget
) =>
  !row.binaryFound ||
  (sandboxRequired &&
    (row.sandbox === "unsupported" || row.sandbox === "unavailable")) ||
  row.failureCategory === "timeout" ||
  row.readiness === "unsupported" ||
  row.readiness === "unauthenticated" ||
  row.readiness === "error";

export const probeProviders = async (
  targets: readonly ProbeTarget[],
  options: ProbeDeps = {}
) => {
  const now = options.now ?? Date.now;
  const globalDeadline = now() + GLOBAL_MS;
  const platform = options.platform ?? currentPlatform();

  const deps = {
    now,
    platform,
    cwd: options.cwd ?? process.cwd(),
    exists: options.exists ?? fs.existsSync,
    discovery: options.discovery ?? createNodeDiscovery(SPECS, platform),
    spawn: options.spawn ?? nodeProbeSpawn,
  };

  const probes: ProviderProbeResult[] = [];
  let next = 0;

  const worker = async () => {
    while (next < targets.length) {
      const index = next;
      next += 1;
      const target = targets[index];

      if (target) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- probes run against a shared global deadline and are intentionally ordered.
        probes[index] = await probeProvider(target, deps, globalDeadline);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker)
  );

  const probeSummary: ProbeSummary = {
    ok: 0,
    failed: 0,
    unprobeable: 0,
    unverified: 0,
  };

  for (const [index, row] of probes.entries()) {
    const target = targets[index];

    if (target && failedProbe(row, target)) {
      probeSummary.failed += 1;
    } else {
      probeSummary.ok += 1;
    }

    if (row.readiness === "unprobeable") {
      probeSummary.unprobeable += 1;
    }

    if (row.sandbox === "unverified") {
      probeSummary.unverified += 1;
    }
  }

  return { probes, probeSummary };
};
