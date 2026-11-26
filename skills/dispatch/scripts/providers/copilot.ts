// GitHub Copilot (spec §6.1): plan mode with --assisted-approval --no-ask-user; sandbox adds
// --sandbox --allow-all-tools; quota moves to the next mode, auth does not; resume `copilot --resume <id>`.

import { validSessionId } from "../lib/session.ts";
import {
  classifyFailure,
  extractCleanResponse,
  extractSessionId,
  failOutcome,
  isSandboxUnsupported,
} from "./response.ts";
import { sessionUsageReader } from "./session-usage.ts";
import type {
  LaunchRequest,
  PlatformEnv,
  ProcessResult,
  ProviderSpec,
} from "./types.ts";

const AUTH =
  /(?<rg1>no authentication|can be authenticated|oauth token|personal access token|gh auth login|subscription required|not subscribed|active github copilot subscription)/iu;

const join = (env: PlatformEnv, ...parts: string[]) =>
  parts.join(env.os === "win32" ? "\\" : "/");

const hasText = (value: string | null | undefined): value is string =>
  value !== undefined && value !== null && value !== "";

const copilotDesktopCandidates = (env: PlatformEnv) => {
  if (env.os === "darwin") {
    return ["/Applications/GitHub Copilot.app/Contents/Resources/copilot"];
  }

  if (env.os === "win32") {
    return [
      join(
        env,
        env.home,
        "AppData",
        "Local",
        "GitHubCopilot",
        "*",
        "copilot.exe"
      ),
    ];
  }

  return [];
};

const SANDBOX_FLAGS = ["--sandbox", "--allow-all-tools"] as const;

const EFFORT_REJECTION =
  /^(?:error: invalid value '[^'\r\n]+' for '--reasoning-effort <level>'|Error: Model "[^"\r\n]+" does not support reasoning effort configuration \(requested: "[^"\r\n]+"\)\.)\r?$/imu;

const UNSUPPORTED_HOST_WARNING =
  /^Sandboxing is enabled but is not supported on this host\b[^\r\n]*(?:\r?\n|$)/iu;

const classify = (text: string, checkSandbox = true) => {
  if (checkSandbox && isSandboxUnsupported(text)) {
    return "sandbox-unsupported";
  }

  if (AUTH.test(text)) {
    return "auth";
  }

  return classifyFailure(text);
};

export const copilot: ProviderSpec = {
  id: "copilot",
  invocationAttribution: { measured: "measured-only" },
  sessionUsageFromAttempt: true,
  acceptPartialSessionUsage: true,
  usageUnavailable: "no usage",
  resumeUsage: "per-launch",
  sessionUsage: sessionUsageReader("copilot", (_raw, context) =>
    hasText(context.sessionId) ? context.sessionId : null
  ),
  modes: [
    {
      id: "cli",
      candidates: (env) => [
        env.os === "win32" ? "copilot.cmd" : "copilot",
        env.os === "win32"
          ? "copilot.exe"
          : join(env, env.home, ".local", "bin", "copilot"),
      ],
    },
    {
      id: "desktop",
      candidates: (env) => copilotDesktopCandidates(env),
    },
    {
      id: "vscode",
      candidates: (env) => [
        join(
          env,
          env.home,
          ".vscode",
          "extensions",
          "github.copilot-chat-*",
          "dist",
          "cli",
          env.os === "win32" ? "copilot.exe" : "copilot"
        ),
      ],
    },
  ],
  readOnlyFlags: ["--mode", "plan"],
  sandbox: {
    flags: SANDBOX_FLAGS,
    inactive:
      /(?:sandbox[^\n]*(?:not active|disabled)|sandboxing is enabled but is not supported on this host)/iu,
    supported: () => true,
  },
  native: "copilot",
  modeCascadeOn: ["quota"],
  resumeCommand: (id) => `copilot --resume ${id}`,

  // NOTE: a preset id alone proves nothing; only an idle kill after streamed output reports it.
  presetsSession: true,
  attemptSession(out: ProcessResult, req: LaunchRequest) {
    if (hasText(req.resume)) {
      return validSessionId(req.resume);
    }

    const extracted =
      extractSessionId(out.stdout, "copilot") ??
      extractSessionId(out.stderrTail, "copilot");

    if (hasText(extracted)) {
      return validSessionId(extracted);
    }

    if (
      out.idleMs !== undefined &&
      out.stdout.trim() !== "" &&
      hasText(req.sessionPreset)
    ) {
      return validSessionId(req.sessionPreset);
    }

    if (
      out.wrapUpStop === true &&
      out.stdout.trim() !== "" &&
      hasText(req.sessionPreset)
    ) {
      return validSessionId(req.sessionPreset);
    }

    return null;
  },
  argv(req) {
    const argv = [
      req.binary,
      ...(req.sandbox ? [...SANDBOX_FLAGS] : []),
      "--assisted-approval",
      "--no-ask-user",
      "-p",
      req.prompt,
    ];

    if (hasText(req.resume)) {
      argv.push("--resume", req.resume);
    } else if (hasText(req.sessionPreset)) {
      argv.push("--session-id", req.sessionPreset);
    }

    if (hasText(req.model)) {
      argv.push("--model", req.model);
    }

    if (hasText(req.effort)) {
      argv.push("--reasoning-effort", req.effort);
    }

    for (const command of req.readCommands ?? []) {
      if (command && !/\s/u.test(command)) {
        argv.push("--allow-tool", `shell(${command}:*)`);
      }
    }

    argv.push("--mode", "plan");

    return { argv, stdin: null, env: {}, cwd: req.cwd };
  },
  parse(out, req) {
    // Only the line-anchored CLI startup warning can classify exit-0 output as sandbox failure.
    const sandboxUnsupported =
      UNSUPPORTED_HOST_WARNING.test(out.stdout.trimStart()) ||
      (out.exit === 0 &&
        new RegExp(UNSUPPORTED_HOST_WARNING.source, "imu").test(
          out.stderrTail.trimStart()
        ));

    const diagnostics =
      out.exit === 0 ? out.stderrTail : `${out.stderrTail}\n${out.stdout}`;

    const cls = sandboxUnsupported
      ? "sandbox-unsupported"
      : classify(diagnostics, out.exit !== 0);

    const text = extractCleanResponse(out.stdout);

    if (out.exit === 0 && !cls && text) {
      const id =
        extractSessionId(out.stdout, "copilot") ??
        extractSessionId(out.stderrTail, "copilot");

      return {
        status: "ok",
        text,
        sessionId: id,
        resume: hasText(id) ? `copilot --resume ${id}` : null,
      };
    }

    const detail = `copilot exit ${String(out.exit)}: ${out.stderrTail.trim().slice(0, 300)}`;

    if (cls) {
      return failOutcome(cls, detail);
    }

    if (
      out.exit !== 0 &&
      out.exit !== null &&
      hasText(req.effort) &&
      EFFORT_REJECTION.test(out.stderrTail)
    ) {
      return {
        ...failOutcome("empty-output", detail),
        retryWithoutEffort: true,
      };
    }

    return failOutcome("empty-output", detail);
  },
};
