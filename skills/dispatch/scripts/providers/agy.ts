import path from "node:path";

import { isRecord } from "../lib/config.ts";
import type { JsonObject } from "../lib/integrity.ts";
import { validSessionId } from "../lib/session.ts";
import {
  AGY_ENVELOPE_USAGE,
  agyUsage,
  normalizeAgyModelEffort,
} from "../lib/usage/agy.ts";
import { classifyFailure, failOutcome } from "./response.ts";
import { sessionUsageReader } from "./session-usage.ts";
import type {
  ModeId,
  PlatformEnv,
  ProcessResult,
  ProviderSpec,
  ProviderUsageContext,
} from "./types.ts";

const AGY_MODE_PROFILES: Readonly<Record<ModeId, string>> = {
  cli: "antigravity-cli",
  desktop: "antigravity",
  vscode: "antigravity-ide",
};

const usageAppDataDir = (context: ProviderUsageContext | undefined) => {
  const home = context?.platform?.home;

  const mode = context?.mode;

  return (
    context?.appDataDir ??
    (home !== undefined && home !== "" && mode !== undefined
      ? path.join(home, ".gemini", AGY_MODE_PROFILES[mode])
      : undefined)
  );
};

const TOKEN_OR_SUBSCRIPTION =
  /\b(?<rg1>not signed in|no tokens?|subscription|license|selfassignlicense)/iu;

const join = (env: PlatformEnv, ...parts: string[]) =>
  parts.join(env.os === "win32" ? "\\" : "/");

const dirname = (file: string) => file.replace(/[/\\][^/\\]*$/u, "") || file;

const desktopCandidates = (env: PlatformEnv) => {
  if (env.os === "darwin") {
    return ["/Applications/Antigravity.app/Contents/Resources/app/bin/agy"];
  }

  if (env.os === "win32") {
    return [
      join(
        env,
        env.home,
        "AppData",
        "Local",
        "Programs",
        "Antigravity",
        "bin",
        "agy.cmd"
      ),
    ];
  }

  return ["/usr/share/antigravity/bin/agy"];
};

const parseEnvelope = (stdout: string) => {
  const start = stdout.indexOf("{");

  if (start === -1) {
    return null;
  }

  let value: unknown;

  try {
    value = JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }

  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record: JsonObject = isRecord(value) ? value : {};
  const nested = record["conversation"];

  const id =
    record["conversationId"] ??
    record["conversation_id"] ??
    (isRecord(nested) ? nested["id"] : undefined);

  const text =
    record["response"] ??
    record["result"] ??
    record["text"] ??
    record["output"];

  return {
    conversationId: typeof id === "string" && id ? id : null,
    text: typeof text === "string" ? text : null,
  };
};

export const agy: ProviderSpec = {
  id: "agy",
  invocationAttribution: {
    normalize: normalizeAgyModelEffort,
    measured: "prefer-measured",
    retainWithoutBaselineProvenance: AGY_ENVELOPE_USAGE,
  },
  modes: [
    {
      id: "cli",
      candidates: (env) => [
        env.os === "win32" ? "agy.exe" : "agy",
        env.os === "win32"
          ? "agy.cmd"
          : join(env, env.home, ".local", "bin", "agy"),
      ],
    },
    {
      id: "desktop",
      candidates: (env) => desktopCandidates(env),
    },
    {
      id: "vscode",
      candidates: (env) => [
        join(
          env,
          env.home,
          ".vscode",
          "extensions",
          "google.antigravity-*",
          "bin",
          env.os === "win32" ? "agy.exe" : "agy"
        ),
      ],
    },
  ],
  readOnlyFlags: ["--mode", "plan"],
  native: "agy",

  modeCascadeOn: ["quota", "auth", "not-found"],
  resumeCommand: (id) => `conversation://${id}`,

  silentUntilExit: true,
  usage(raw, context) {
    const appDataDir = usageAppDataDir(context);

    return agyUsage(raw, {
      ...(appDataDir !== undefined && appDataDir !== "" && { appDataDir }),
      ...(context?.readSqliteGenMetadata && {
        readSqliteGenMetadata: context.readSqliteGenMetadata,
      }),
      ...(context?.transcripts?.budget && {
        budget: context.transcripts.budget,
      }),
    });
  },
  sessionUsage: sessionUsageReader(
    "agy",
    (raw) => parseEnvelope(raw)?.conversationId ?? null,
    (context) => {
      const appDataDir = usageAppDataDir(context);

      return appDataDir !== undefined && appDataDir !== ""
        ? { appDataDir }
        : {};
    }
  ),
  resumeUsage: "cumulative",
  attemptSession: (out: ProcessResult) =>
    validSessionId(parseEnvelope(out.stdout)?.conversationId ?? null),
  argv(req, mode) {
    const seconds = Math.max(1, Math.ceil(req.timeoutMs / 1000));

    const argv = [
      req.binary,
      "--print",
      req.prompt,
      "--output-format",
      "json",
      `--print-timeout=${seconds}s`,
    ];

    if (
      req.briefFile !== undefined &&
      req.briefFile !== null &&
      req.briefFile !== ""
    ) {
      argv.push("--add-dir", dirname(req.briefFile));
    }

    if (req.model !== undefined && req.model !== null && req.model !== "") {
      argv.push("--model", req.model);
    }

    if (req.effort !== undefined && req.effort !== null && req.effort !== "") {
      argv.push("--effort", req.effort);
    }

    if (req.resume !== undefined && req.resume !== null && req.resume !== "") {
      argv.push("--conversation", req.resume);
    }

    argv.push("--mode", "plan", "--dangerously-skip-permissions");

    return {
      argv,
      stdin: null,
      env: { JETSKI_APP_DATA_DIR: AGY_MODE_PROFILES[mode] },
      cwd: req.cwd,
    };
  },
  parse(out) {
    const envelope = parseEnvelope(out.stdout);

    const text = envelope ? (envelope.text ?? "").trim() : out.stdout.trim();

    if (out.exit === 0 && text) {
      const id = envelope?.conversationId ?? null;

      return {
        status: "ok",
        text,
        sessionId: id,
        resume:
          id !== undefined && id !== null && id !== ""
            ? `conversation://${id}`
            : null,
      };
    }

    const both = `${out.stderrTail}\n${out.stdout}`;
    const detail = `agy exit ${String(out.exit)}: ${out.stderrTail.trim().slice(0, 300)}`;

    let cls = classifyFailure(both);

    if (cls === null) {
      if (TOKEN_OR_SUBSCRIPTION.test(both)) {
        cls = "auth";
      } else if (out.exit === 0) {
        cls = "empty-output";
      } else {
        cls = "not-found";
      }
    }

    return failOutcome(cls, detail);
  },
};
