// OpenCode (spec §6.1): v2-only argv `run --auto --format json [--agent] [-m model[#effort]] -- <prompt>`;
// `Variant unavailable` asks the runner to rerun once without effort. A loopback
// endpoint gets a `/models` preflight, the GPU lock, and a WAN proxy trap; a remote endpoint skips all three.
// Bubblewrap sandbox on Linux only; elsewhere `sandbox: true` is `sandbox-unsupported`.

import { isRecord } from "../lib/config.ts";
import type { JsonObject } from "../lib/integrity.ts";
import { opencodeModelValue } from "../lib/platform.ts";
import { validSessionId } from "../lib/session.ts";
import {
  OPENCODE_COMPLETION_USAGE,
  opencodeUsage,
} from "../lib/usage/opencode.ts";
import { classifyFailure, failOutcome } from "./response.ts";
import { sessionUsageReader } from "./session-usage.ts";
import type {
  LaunchRequest,
  PlatformEnv,
  Prelaunch,
  PreparePorts,
  ProviderSpec,
} from "./types.ts";

interface ProxyEnv {
  [name: string]: string;
}

export const PROXY_TRAP = "http://127.0.0.1:0";

const PROXY_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
];

const VARIANT_UNAVAILABLE = /Variant unavailable/iu;

const STANDALONE_UNSUPPORTED =
  /(?:--standalone[\s\S]{0,100}(?:unknown|unrecognized|unsupported|invalid|unexpected|not supported|not recognized|not available)|(?:unknown|unrecognized|unsupported|invalid|unexpected|not supported|not recognized|not available)[\s\S]{0,100}--standalone)/iu;

const row = (v: unknown) => (isRecord(v) ? v : null);

const hasText = (value: string | null | undefined): value is string =>
  value !== undefined && value !== null && value !== "";

const NOOP_RELEASE = () => {
  /* no resources held */
};

const opencodeDesktopCandidates = (env: PlatformEnv) => {
  if (env.os === "darwin") {
    return ["/Applications/OpenCode.app/Contents/MacOS/opencode-cli-*"];
  }

  if (env.os === "win32") {
    return [
      join(env, env.home, "AppData", "Local", "OpenCode", "opencode-cli-*.exe"),
    ];
  }

  return ["/usr/lib/opencode/opencode-cli-*"];
};

/** JSON mode: text replies and failure messages come only from their own events; tool and reasoning payloads never classify. */
// oxlint-disable-next-line eslint/complexity -- JSONL event classifier has one branch per OpenCode event type; refactor deferred.
const parseEvents = (raw: string) => {
  const texts: string[] = [];
  const errors: string[] = [];

  let previousTextPartId: string | undefined;
  let sessionId: string | null = null;
  let capacity = false;
  let retryAfterMs: number | undefined;

  for (const line of raw.split(/\r?\n/u).filter((value) => value.trim())) {
    let event: JsonObject | null;

    try {
      event = row(JSON.parse(line));
    } catch {
      continue;
    }

    if (typeof event?.["sessionID"] === "string") {
      sessionId = event["sessionID"];
    }

    if (event?.["type"] === "text") {
      const part = row(event["part"]);
      const text = part?.["text"];

      if (typeof text === "string") {
        const id = part?.["id"];
        const partId = typeof id === "string" ? id : undefined;

        if (texts.length && partId !== previousTextPartId) {
          texts.push("\n");
        }

        texts.push(text);
        previousTextPartId = partId;
      }
    }

    if (event?.["type"] === "error") {
      const error = row(event["error"]);
      const message = error?.["message"] ?? event["message"];
      errors.push(
        typeof message === "string" ? message : "OpenCode reported an error"
      );

      if (
        error?.["type"] === "provider.rate-limit" ||
        error?.["status"] === 429
      ) {
        capacity = true;
        const delay = error["retryAfterMs"];

        if (typeof delay === "number" && Number.isFinite(delay) && delay > 0) {
          retryAfterMs = delay;
        }
      }
    }
  }

  return {
    text: texts.join("").trim(),
    errors,
    sessionId,
    capacity,
    ...(!(retryAfterMs === undefined) && { retryAfterMs }),
  };
};

export const unsupportedStandaloneDiagnostic = (text: string) =>
  STANDALONE_UNSUPPORTED.test(text) ||
  /(?:unknown|unrecognized|unsupported|invalid|unexpected)\s+arguments?:?\s+['"`]*(?:--)?standalone\b/iu.test(
    text
  );

const join = (env: PlatformEnv, ...parts: string[]) =>
  parts.join(env.os === "win32" ? "\\" : "/");

/** Loopback hosts only: a LAN or remote host is not "local" for the WAN trap. */
const isLocalHost = (host: string) => {
  const bare = host.replaceAll(/^\[|\]$/gu, "").toLowerCase();

  return (
    bare === "localhost" ||
    bare === "::1" ||
    bare.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/u.test(bare)
  );
};

const endpointHost = (endpoint: string) => {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return null;
  }
};

/** Bubblewrap: read-only root, private /tmp, writable OpenCode state; the delegate cannot write the project. */
export const bwrapArgv = (
  req: Pick<LaunchRequest, "platform" | "cwd" | "briefFile">,
  inner: readonly string[]
) => {
  const { home } = req.platform;
  const xdg = req.platform.xdg ?? {};

  // OpenCode's writable dirs are XDG data/cache/state, each with an `opencode` leaf.
  const state = [
    join(
      req.platform,
      xdg.data ?? join(req.platform, home, ".local", "share"),
      "opencode"
    ),
    join(
      req.platform,
      xdg.cache ?? join(req.platform, home, ".cache"),
      "opencode"
    ),
    join(
      req.platform,
      xdg.state ?? join(req.platform, home, ".local", "state"),
      "opencode"
    ),
  ];

  const briefDir = hasText(req.briefFile)
    ? [req.briefFile.replace(/[/\\][^/\\]*$/u, "")]
    : [];

  return [
    "bwrap",
    "--unshare-user",
    "--unshare-ipc",
    "--unshare-pid",
    "--unshare-uts",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/run",
    ...briefDir.flatMap((dir) => ["--ro-bind", dir, dir]),
    ...state.flatMap((dir) => ["--bind", dir, dir]),
    "--die-with-parent",
    "--chdir",
    req.cwd,
    "--",
    ...inner,
  ];
};

export const prepareOpencode: (
  req: LaunchRequest,
  ports: PreparePorts
) => Promise<Prelaunch> = async (req, ports) => {
  if (
    !hasText(req.agent) ||
    (req.readOnlyVerified !== true && req.readOnlyBestEffort !== true)
  ) {
    return {
      kind: "fail",
      outcome: failOutcome(
        "config",
        "read-only-agent-unavailable: verified native agent required"
      ),
    };
  }

  const host = hasText(req.endpoint) ? endpointHost(req.endpoint) : null;

  if (!hasText(req.endpoint) || host === null || !isLocalHost(host)) {
    return { kind: "launch", env: {}, release: NOOP_RELEASE };
  }

  const models = await ports.fetchModels(req.endpoint);

  if (models === null) {
    return {
      kind: "fail",
      outcome: failOutcome(
        "model-not-loaded",
        `SERVER_OFFLINE: ${req.endpoint}/models did not answer`
      ),
    };
  }

  if (
    models.length === 0 ||
    (hasText(req.model) &&
      !models.includes(req.model.split("/").slice(1).join("/") || req.model))
  ) {
    return {
      kind: "fail",
      outcome: failOutcome(
        "model-not-loaded",
        `${req.endpoint} reports no models loaded`
      ),
    };
  }

  let release: () => void | Promise<void>;

  try {
    release = await ports.acquireGpuLock();
  } catch (error) {
    return { kind: "fail", outcome: failOutcome("timeout", String(error)) };
  }

  // Local dispatch has no legitimate WAN use: every proxy points at a dead port, with only the backend exempt.
  const exempt = [...new Set([host, "localhost", "127.0.0.1", "::1"])].join(
    ","
  );

  const env: ProxyEnv = { NO_PROXY: exempt, no_proxy: exempt };

  for (const key of PROXY_KEYS) {
    env[key] = PROXY_TRAP;
  }

  return { kind: "launch", env, release };
};

export const opencode: ProviderSpec = {
  id: "opencode",
  invocationAttribution: { measured: "prefer-measured" },
  ownedTreeLabel: "OpenCode",
  stepEvent(line) {
    try {
      const type = row(JSON.parse(line))?.["type"];

      if (type === "step_start") {
        return "step-start";
      }

      if (type === "step_finish") {
        return "step-end";
      }

      return null;
    } catch {
      return null;
    }
  },
  modes: [
    {
      id: "cli",
      candidates: (env) => [
        env.os === "win32" ? "opencode.cmd" : "opencode",
        env.os === "win32"
          ? "opencode.exe"
          : join(env, env.home, ".opencode", "bin", "opencode"),
      ],
    },
    {
      id: "desktop",
      candidates: (env) => opencodeDesktopCandidates(env),
    },
    {
      id: "vscode",
      candidates: (env) => [
        join(
          env,
          env.home,
          ".vscode",
          "extensions",
          "sst-dev.opencode-*",
          "bin",
          env.os === "win32" ? "opencode.exe" : "opencode"
        ),
      ],
    },
  ],
  readOnlyFlags: ["run"],
  sandbox: {
    flags: ["bwrap"],
    inactive:
      /bwrap: [^\n]*(?:No permissions|Operation not permitted|setting up uid map)/iu,
    supported: (env) => env.os === "linux" && env.bubblewrap,
  },
  native: "opencode",
  modeCascadeOn: [],
  usage: opencodeUsage,
  sessionUsage: sessionUsageReader(
    "opencode",
    (raw) => parseEvents(raw).sessionId,
    (context, fs) =>
      !fs.opencodeMessages && context.readOpencodeMessages
        ? { fs: { ...fs, opencodeMessages: context.readOpencodeMessages } }
        : {}
  ),
  zeroUsageProvenance: OPENCODE_COMPLETION_USAGE,
  resumeUsage: "per-launch",
  outputCapBytes: 64 * 1024 * 1024,
  resumeCommand: (id) => id,
  attemptSession: (out) => validSessionId(parseEvents(out.stdout).sessionId),
  argv(req) {
    // Headless `--auto` requires the read-only agent from preparation: verified deny-by-default, or best-effort explore.
    // Standalone owns the server lifecycle; `--pure` and `--variant` are v1-only and never emitted.
    const inner = [
      req.binary,
      "--standalone",
      "run",
      "--auto",
      "--format",
      "json",
    ];

    if (hasText(req.agent)) {
      inner.push("--agent", req.agent);
    }

    if (hasText(req.model)) {
      inner.push("-m", opencodeModelValue(req.model, req.effort));
    }

    if (hasText(req.resume)) {
      inner.push("--session", req.resume);
    }

    inner.push("--", req.prompt);

    return {
      argv: req.sandbox ? bwrapArgv(req, inner) : inner,
      stdin: null,
      env: {},
      cwd: req.cwd,
    };
  },
  parse(out, req) {
    const events = parseEvents(out.stdout);
    const diagnostics = [out.stderrTail, ...events.errors].join("\n").trim();

    if (out.exit === 0 && !events.errors.length && events.text) {
      const handle =
        req.endpoint ?? (hasText(req.model) ? `opencode:${req.model}` : null);

      const id = validSessionId(events.sessionId);

      return { status: "ok", text: events.text, sessionId: id, resume: handle };
    }

    const detail = `opencode exit ${String(out.exit)}: ${diagnostics.slice(0, 300)}`;

    if (unsupportedStandaloneDiagnostic(diagnostics)) {
      return failOutcome(
        "config",
        "OpenCode binary does not support --standalone; upgrade to a supported v2 binary. Shared-service fallback is disabled."
      );
    }

    // The model exists; only the configured effort variant does not, so this is a config fault, not model-not-found.
    if (VARIANT_UNAVAILABLE.test(diagnostics) && hasText(req.effort)) {
      return {
        status: "fail",
        cls: "config",
        detail: `effort variant "${req.effort}" unavailable for ${req.model ?? "model"}; ${detail}`,
        retryWithoutEffort: true,
      };
    }

    const cls =
      classifyFailure(diagnostics) ??
      (events.capacity ? "capacity" : "empty-output");

    if (cls === "capacity" && events.retryAfterMs !== undefined) {
      return { status: "fail", cls, detail, retryAfterMs: events.retryAfterMs };
    }

    return failOutcome(cls, detail);
  },
  prepare: prepareOpencode,
};
