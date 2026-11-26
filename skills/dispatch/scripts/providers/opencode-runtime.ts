import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { types } from "node:util";

import { isRecord } from "../lib/config.ts";
import { nodeErrorCode } from "../lib/fs-ext.ts";
import { parseJson } from "../lib/integrity.ts";
import type { JsonObject, JsonValue } from "../lib/integrity.ts";
import { nodeProcess } from "./node-process.ts";
import { unsupportedStandaloneDiagnostic } from "./opencode.ts";
import {
  KILL_ESCALATION_MS,
  sanitizeEnv,
  waitWithin,
} from "./process-policy.ts";
import type { DelegateRequest, LifecycleStep, ProcessResult } from "./types.ts";

const pause = async (ms: number) => {
  await delay(ms);
};

const hasContent = (value: JsonValue | null) =>
  value !== null &&
  value !== undefined &&
  value !== false &&
  value !== 0 &&
  value !== "";

const hasAgent = (value: string | null | undefined): value is string =>
  value !== undefined && value !== null && value !== "";

const merge = (a: JsonObject, b: JsonObject) => {
  const out = { ...a };

  for (const [key, value] of Object.entries(b)) {
    out[key] =
      isRecord(out[key]) && isRecord(value) ? merge(out[key], value) : value;
  }

  return out;
};

type Introspect = (command: "config" | "agents") => Promise<JsonValue>;

// oxlint-disable-next-line eslint/complexity -- effective-config resolution enumerates every agent/provider source; refactor deferred.
export const resolveEffectiveOpencodeLaunch = async (
  req: DelegateRequest,
  inspect: Introspect
) => {
  const sources = await inspect("config");

  if (!Array.isArray(sources)) {
    // oxlint-disable-next-line unicorn/prefer-type-error -- missing native config is an operational failure, not a type misuse; TypeError would misclassify it.
    throw new Error(
      "effective-config-unverified: native config sources unavailable"
    );
  }

  let config: JsonObject = {};

  for (const source of sources) {
    if (!isRecord(source)) {
      throw new Error("effective-config-unverified: unsupported native source");
    }

    const { type: sourceType } = source;

    if (
      typeof sourceType !== "string" ||
      !["document", "directory"].includes(sourceType)
    ) {
      throw new Error("effective-config-unverified: unsupported native source");
    }

    if (sourceType === "document") {
      const { info } = source;

      if (!isRecord(info)) {
        throw new Error(
          "effective-config-unverified: source has no resolved settings"
        );
      }

      config = merge(config, info);
    }
  }

  const agents = await inspect("agents");

  if (!Array.isArray(agents)) {
    // oxlint-disable-next-line unicorn/prefer-type-error -- unavailable agents is an operational failure, not a type misuse; TypeError would misclassify it.
    throw new Error(
      "read-only-agent-unavailable: effective agents unavailable"
    );
  }

  const readActions = new Set([
    "read",
    "glob",
    "grep",
    "webfetch",
    "websearch",
    "external_directory",
  ]);

  const safe = (agent: unknown): agent is JsonObject => {
    if (
      !isRecord(agent) ||
      !Array.isArray(agent["permissions"]) ||
      typeof agent["id"] !== "string" ||
      agent["hidden"] === true
    ) {
      return false;
    }

    const rules = agent["permissions"];

    const lastDeny = rules.findLastIndex(
      (rule: unknown) =>
        isRecord(rule) &&
        rule["action"] === "*" &&
        rule["resource"] === "*" &&
        rule["effect"] === "deny"
    );

    return (
      lastDeny !== -1 &&
      rules.slice(lastDeny + 1).every((rule: unknown) => {
        if (!isRecord(rule)) {
          return false;
        }

        const { action } = rule;

        return (
          rule["effect"] === "deny" ||
          (typeof action === "string" && readActions.has(action))
        );
      })
    );
  };

  const candidates = agents.filter(safe);

  const verified = hasAgent(req.agent)
    ? candidates.find((a) => a["id"] === req.agent)
    : (candidates.find((a) => a["id"] === "explore") ??
      candidates.find((a) => a["id"] === "plan"));

  const bestEffort =
    verified !== undefined || (hasAgent(req.agent) && req.agent !== "explore")
      ? undefined
      : agents.find(
          (a): a is JsonObject =>
            isRecord(a) && a["id"] === "explore" && a["hidden"] !== true
        );

  const agent = verified ?? bestEffort;

  if (!agent) {
    throw new Error(
      "read-only-agent-unavailable: require an effective agent with wildcard deny and only read tool grants"
    );
  }

  const model =
    req.model ?? (typeof config["model"] === "string" ? config["model"] : null);

  const providerId = model?.split("/")[0];

  const { providers: fromProviders, provider: fromProvider } = config;
  let providers: JsonObject;

  if (isRecord(fromProviders)) {
    providers = fromProviders;
  } else if (isRecord(fromProvider)) {
    providers = fromProvider;
  } else {
    providers = {};
  }

  const configured =
    providerId !== undefined && providerId !== ""
      ? providers[providerId]
      : undefined;

  const provider: JsonObject = isRecord(configured) ? configured : {};
  const { settings: providerSettings, options: providerOptions } = provider;
  let settings: JsonObject;

  if (isRecord(providerSettings)) {
    settings = providerSettings;
  } else if (isRecord(providerOptions)) {
    settings = providerOptions;
  } else {
    settings = {};
  }

  const endpoint =
    typeof settings["baseURL"] === "string" ? settings["baseURL"] : null;

  if (endpoint !== null && endpoint !== "") {
    const url = new URL(endpoint);

    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      throw new Error("effective-config-unverified: unsupported endpoint");
    }
  }

  const agentId = agent["id"];

  return {
    ...req,
    model,
    endpoint,
    agent: typeof agentId === "string" ? agentId : JSON.stringify(agentId),
    readOnlyVerified: verified !== undefined,
    ...(verified === undefined && { readOnlyBestEffort: true }),
  };
};

export const nativeOpencodeIntrospection = (
  binary: string,
  req: DelegateRequest,
  env: Readonly<Record<string, string | undefined>>,
  budgetMs: number,
  steps?: LifecycleStep[]
) => {
  const inlineConfig = env["OPENCODE_CONFIG_CONTENT"];

  if (inlineConfig !== undefined && inlineConfig !== "") {
    throw new Error(
      "effective-config-unverified: inline config propagation requires an explicit user choice"
    );
  }

  const deadline = Date.now() + budgetMs;

  // oxlint-disable-next-line eslint/complexity -- bounded introspection retries have one branch per failure class; refactor deferred.
  return async (command: Parameters<Introspect>[0]) => {
    const remaining = Math.min(10_000, deadline - Date.now());

    if (remaining <= 0) {
      throw new Error(
        "effective-config-unverified: opencode-lifecycle-timeout: preparation deadline expired"
      );
    }

    const started = Date.now();
    let outcome: LifecycleStep["outcome"] = "ok";
    const commandDeadline = started + remaining;
    const settlementDeadline = commandDeadline + KILL_ESCALATION_MS;
    const logPath = `${req.logPath}.introspect-${command}`;
    const killLogPath = `${logPath}.kill`;

    const child = nodeProcess.start(
      {
        argv: [binary, "--standalone", "debug", command],
        env: sanitizeEnv(env),
        stdin: null,
        cwd: req.cwd,
      },
      { logPath, capBytes: 1024 * 1024 }
    );

    let killerDone: Promise<ProcessResult> | undefined;
    let teardownStartFailed = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      if (child.pid <= 1) {
        return;
      }

      timedOut = true;

      if (process.platform === "win32") {
        try {
          killerDone = nodeProcess.start(
            {
              argv: ["taskkill", "/PID", String(child.pid), "/T", "/F"],
              env: sanitizeEnv(env),
              stdin: null,
              cwd: req.cwd,
            },
            { logPath: killLogPath, capBytes: 4096 }
          ).done;
        } catch {
          teardownStartFailed = true;
        }
      } else {
        nodeProcess.signal(-child.pid, "SIGKILL");
      }
    }, remaining);

    try {
      const result = await waitWithin(
        child.done,
        Math.max(0, settlementDeadline - Date.now())
      );

      clearTimeout(timer);

      const commandTimedOut =
        timedOut ||
        (child.pid > 1 && Date.now() > commandDeadline) ||
        result?.timedOut === true;

      if (!result) {
        throw new Error(
          "effective-config-unverified: opencode-lifecycle-timeout: native introspection process exit unconfirmed after bounded teardown"
        );
      }

      const killerResult = killerDone
        ? await waitWithin(
            killerDone,
            Math.max(0, settlementDeadline - Date.now())
          )
        : null;

      if (killerDone && !killerResult) {
        throw new Error(
          "effective-config-unverified: opencode-lifecycle-timeout: OpenCode teardown process exit unconfirmed after bounded teardown"
        );
      }

      if (
        teardownStartFailed ||
        (killerResult !== null && killerResult.exit !== 0)
      ) {
        throw new Error(
          "effective-config-unverified: opencode-lifecycle-timeout: OpenCode process-tree teardown did not confirm exit within the bounded deadline"
        );
      }

      if (
        child.pid > 1 &&
        process.platform !== "win32" &&
        nodeProcess.settleGroup
      ) {
        const grace = Math.max(
          0,
          Math.min(KILL_ESCALATION_MS, settlementDeadline - Date.now())
        );

        const confirmed = await nodeProcess.settleGroup(child.pid, grace);

        if (!confirmed) {
          throw new Error(
            "effective-config-unverified: opencode-lifecycle-timeout: process group exit unconfirmed; retain the worktree and verify process exit before cleanup"
          );
        }
      }

      if (commandTimedOut) {
        throw new Error(
          "effective-config-unverified: opencode-lifecycle-timeout: native introspection exceeded its command deadline"
        );
      }

      if (
        unsupportedStandaloneDiagnostic(
          `${result.stderrTail}\n${result.stdout}`
        )
      ) {
        throw new Error(
          "effective-config-unverified: OpenCode binary does not support --standalone; upgrade to a supported v2 binary"
        );
      }

      if (result.exit !== 0 || result.truncated) {
        throw new Error(
          "effective-config-unverified: native introspection failed"
        );
      }

      try {
        return parseJson(result.stdout);
      } catch {
        throw new Error(
          "effective-config-unverified: native introspection returned invalid JSON"
        );
      }
    } catch (error) {
      const reason = String(error);

      if (/exit unconfirmed|did not confirm exit/u.test(reason)) {
        outcome = "unconfirmed";
      } else if (reason.includes("opencode-lifecycle-timeout")) {
        outcome = "timeout";
      } else {
        outcome = "failed";
      }

      throw error;
    } finally {
      clearTimeout(timer);

      steps?.push({
        step: `debug-${command}`,
        elapsedMs: Date.now() - started,
        budgetMs: remaining,
        outcome,
      });

      for (const file of [logPath, killLogPath]) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* no credential-bearing introspection capture retained */
        }
      }
    }
  };
};

export const fetchModels = async (endpoint: string, timeoutMs = 5000) => {
  try {
    const response = await fetch(`${endpoint.replace(/\/$/u, "")}/models`, {
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(1, Math.min(5000, timeoutMs))),
    });

    if (!response.ok || !response.body) {
      return null;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;

    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- stream chunks must be consumed in order; concurrency would reorder the cap.
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
        // oxlint-disable-next-line eslint/no-await-in-loop -- stream teardown must finish before returning the cap result.
        await reader.cancel();

        return null;
      }

      chunks.push(chunk);
    }

    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

    if (!isRecord(value) || !Array.isArray(value["data"])) {
      return null;
    }

    const ids: string[] = [];

    for (const row of value["data"]) {
      if (
        !isRecord(row) ||
        typeof row["id"] !== "string" ||
        !row["id"].trim() ||
        row["id"].length > 1024 ||
        // oxlint-disable-next-line eslint/require-unicode-regexp -- code-unit check; `u` would reject astral ids.
        /[^ -￿]/.test(row["id"])
      ) {
        return null;
      }

      ids.push(row["id"]);
    }

    return ids;
  } catch {
    return null;
  }
};

interface Owner {
  host: string;
  pid: number;
  token: string;
}

const gpuLockPath = () =>
  path.join(
    fs.realpathSync(os.tmpdir()),
    "dispatch-skills",
    ".locks",
    "opencode-local-gpu.lock"
  );

export const acquireGpuLock = async (
  timeoutMs = 30_000,
  file = gpuLockPath()
) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const owner: Owner = {
    host: os.hostname(),
    pid: process.pid,
    token: crypto.randomUUID(),
  };

  const guard = `${file}.guard`;
  const deadline = Date.now() + Math.max(0, Math.min(30_000, timeoutMs));

  const guardOnce = () => {
    try {
      return fs.openSync(guard, "wx", 0o600);
    } catch (error) {
      if (nodeErrorCode(error) === "EEXIST") {
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
          prior = parseJson(fs.readFileSync(file, "utf-8"));
        } catch (error) {
          if (nodeErrorCode(error) !== "ENOENT") {
            throw new Error("gpu-lock-unverifiable", { cause: error });
          }
        }

        if (hasContent(prior)) {
          const held: JsonObject = isRecord(prior) ? prior : {};

          const { host, pid, token } = {
            host: held["host"],
            pid: held["pid"],
            token: held["token"],
          };

          if (
            host !== owner.host ||
            typeof pid !== "number" ||
            !Number.isInteger(pid) ||
            pid <= 0 ||
            typeof token !== "string" ||
            !token
          ) {
            throw new Error("gpu-lock-foreign-or-unverifiable");
          }

          try {
            process.kill(pid, 0);
          } catch (error) {
            if (nodeErrorCode(error) === "ESRCH") {
              fs.unlinkSync(file);
              prior = null;
            } else {
              throw new Error("gpu-lock-owner-unverifiable", { cause: error });
            }
          }
        }

        if (!hasContent(prior)) {
          fs.writeFileSync(file, JSON.stringify(owner), {
            flag: "wx",
            mode: 0o600,
          });
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

      return async () => {
        if (released) {
          return;
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
              throw new Error("gpu-lock-release-guard-unavailable");
            }

            // oxlint-disable-next-line eslint/no-await-in-loop -- lock acquisition is a bounded sequential poll.
            await pause(Math.min(25, until - Date.now()));
          }

          try {
            try {
              const current = parseJson(fs.readFileSync(file, "utf-8"));

              if (current === null) {
                throw new Error("gpu-lock-unverifiable");
              }

              if (isRecord(current) && current["token"] === owner.token) {
                fs.unlinkSync(file);
              }
            } catch (error) {
              if (nodeErrorCode(error) !== "ENOENT") {
                throw error;
              }
            }

            released = true;
          } finally {
            fs.closeSync(releaseFd);
            fs.unlinkSync(guard);
          }
          // oxlint-disable-next-line promise/prefer-await-to-callbacks -- catch clears the cached pending slot before rethrow; await alone cannot reset it.
        })().catch((error: unknown) => {
          pending = null;
          throw error;
        });

        await pending;
      };
    }

    if (Date.now() >= deadline) {
      throw new Error("gpu-lock-timeout");
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- release retries are a bounded sequential poll.
    await pause(Math.min(25, deadline - Date.now()));
  }
};

export const createOpencodePreparePorts = (deadline: number) => ({
  fetchModels: async (endpoint: string) =>
    await fetchModels(endpoint, deadline - Date.now()),
  acquireGpuLock: async () => await acquireGpuLock(deadline - Date.now()),
});
