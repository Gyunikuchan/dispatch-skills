import { isRecord } from "../lib/config.ts";
import { parseJson } from "../lib/integrity.ts";
import type { JsonObject, JsonValue } from "../lib/integrity.ts";
import { validSessionId } from "../lib/session.ts";
import { CLAUDE_INVOCATION_USAGE, claudeUsage } from "../lib/usage/claude.ts";
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
  RunOutcome,
} from "./types.ts";

const READ_ONLY_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "LS",
  "Bash(git diff*)",
  "Bash(git status*)",
  "Bash(git log*)",
  "Bash(git show*)",
  "Bash(git blame*)",
  "Bash(git rev-parse*)",
  "Bash(git ls-files*)",
  "Bash(grep *)",
  "Bash(rg *)",
  "Bash(ls *)",
  "Bash(head *)",
  "Bash(tail *)",
  "Bash(wc *)",
  "Bash(file *)",
  "Bash(jq *)",
  "Bash(diff *)",
  "Bash(uniq *)",
  "Bash(cut *)",
  "Bash(tr *)",
  "Bash(stat *)",
  "Bash(which *)",
  "Bash(type *)",
  "Bash(date *)",
  "Bash(basename *)",
  "Bash(dirname *)",
  "Bash(realpath *)",
  "Bash(readlink *)",
  "Bash(column *)",
  "Bash(paste *)",
  "Bash(npm ls*)",
  "TodoWrite",
] as const;

const DISALLOWED_WRITE_TOOLS = ["Write", "Edit", "NotebookEdit"] as const;

const DISALLOWED_SUBAGENT_TOOLS = ["Agent", "Task"] as const;
const SANDBOX_SETTINGS = JSON.stringify({ sandbox: { enabled: true } });

const MODEL_NOT_FOUND = /selected model|model\b[^\n]*\bnot found/iu;

const CLI_OUTDATED =
  /claude_code_version_too_old|Claude Code \S+ does not support this model/iu;

const ADVISORY = /^[^\n]*Sandbox disabled[^\n]*not active[^\n]*$/gimu;

const exe = (env: PlatformEnv) => (env.os === "win32" ? ".exe" : "");

const join = (env: PlatformEnv, ...parts: string[]) =>
  parts.join(env.os === "win32" ? "\\" : "/");

const claudeDesktopCandidates = (env: PlatformEnv) => {
  if (env.os === "darwin") {
    return [
      "/Applications/Claude.app/Contents/Resources/claude-code/claude",
      join(
        env,
        env.home,
        "Applications/Claude.app/Contents/Resources/claude-code/claude"
      ),
    ];
  }

  if (env.os === "win32") {
    return [
      join(
        env,
        env.home,
        "AppData",
        "Roaming",
        "Claude",
        "claude-code",
        "*",
        "claude.exe"
      ),
    ];
  }

  return [];
};

const parseEnvelope = (stdout: string) => {
  const trimmed = stdout.trim();

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }

  let parsed: JsonValue;

  try {
    parsed = parseJson(trimmed);
  } catch {
    return null;
  }

  const pick = Array.isArray(parsed)
    ? parsed.findLast((entry) => isRecord(entry) && entry["type"] === "result")
    : parsed;

  if (typeof pick !== "object" || pick === null) {
    return null;
  }

  const record: JsonObject = isRecord(pick) ? pick : {};
  const status = record["api_error_status"];

  let text = "";

  if (typeof record["result"] === "string") {
    text = record["result"];
  } else if (typeof record["error"] === "string") {
    text = record["error"];
  }

  return {
    text: text.trim(),
    sessionId:
      typeof record["session_id"] === "string" ? record["session_id"] : null,
    isError: record["is_error"] === true,
    subtype: typeof record["subtype"] === "string" ? record["subtype"] : null,
    status:
      typeof status === "number" && Number.isInteger(status) ? status : null,
    code:
      typeof record["api_error_code"] === "string"
        ? record["api_error_code"]
        : null,
  };
};

const earlyClaudeFailure = (diagnostics: string) =>
  isSandboxUnsupported(diagnostics, { includeSettings: true, strict: true })
    ? "sandbox-unsupported"
    : null;

const claudeSuccess = (
  out: ProcessResult,
  envelope: ReturnType<typeof parseEnvelope>
): RunOutcome => {
  const early =
    classifyFailure(out.stderrTail) ??
    earlyClaudeFailure(out.stderrTail.replaceAll(ADVISORY, ""));

  if (early !== null) {
    return failOutcome(early, `claude: ${out.stderrTail.trim().slice(0, 300)}`);
  }

  const text = envelope ? envelope.text : extractCleanResponse(out.stdout);

  if (text === "") {
    return failOutcome("empty-output", "claude exited 0 with no response text");
  }

  const sessionId =
    envelope?.sessionId ?? extractSessionId(out.stdout, "claude");

  return {
    status: "ok",
    text,
    sessionId,
    resume:
      sessionId !== undefined && sessionId !== null && sessionId !== ""
        ? `claude --resume ${sessionId}`
        : null,
  };
};

export const claude: ProviderSpec = {
  usage: claudeUsage,
  sessionUsage: sessionUsageReader(
    "claude",
    (raw) => parseEnvelope(raw)?.sessionId ?? null,
    (context) => (context.cwd === undefined ? {} : { cwd: context.cwd })
  ),
  perLaunchUsageProvenance: CLAUDE_INVOCATION_USAGE,
  resumeUsage: "cumulative",
  id: "claude",
  modes: [
    {
      id: "cli",
      candidates: (env) => [
        env.os === "win32" ? "claude.exe" : "claude",
        ...(env.os === "win32" ? ["claude.cmd"] : []),
        join(env, env.home, ".local", "bin", `claude${exe(env)}`),
        join(env, env.home, ".claude", "local", `claude${exe(env)}`),
      ],
    },
    {
      id: "desktop",
      candidates: (env) => claudeDesktopCandidates(env),
    },
    {
      id: "vscode",
      candidates: (env) =>
        [".vscode", ".vscode-insiders", ".vscode-server", ".cursor"].map(
          (dir) =>
            join(
              env,
              env.home,
              dir,
              "extensions",
              "anthropic.claude-code-*",
              "resources",
              "native-binary",
              `claude${exe(env)}`
            )
        ),
    },
  ],
  readOnlyFlags: [
    "--permission-mode",
    "plan",
    "--disallowedTools",
    ...DISALLOWED_WRITE_TOOLS,
    ...DISALLOWED_SUBAGENT_TOOLS,
  ],
  sandbox: {
    flags: ["--settings", SANDBOX_SETTINGS],
    inactive: /Sandbox disabled[^\n]*not active/iu,

    supported: (env) => env.os !== "win32",
  },
  schema: true,
  native: "claude",
  modeCascadeOn: [],
  resumeCommand: (id) => `claude --resume ${id}`,

  silentUntilExit: true,

  presetsSession: true,
  attemptSession: (out: ProcessResult, req: LaunchRequest) =>
    validSessionId(parseEnvelope(out.stdout)?.sessionId ?? null) ??
    (out.wrapUpStop ? validSessionId(req.sessionPreset) : null),
  argv(req) {
    const argv = [
      req.binary,
      "-p",
      req.prompt,
      "--output-format",
      "json",
      "--permission-mode",
      "plan",
    ];

    if (req.resume !== undefined && req.resume !== null && req.resume !== "") {
      argv.push("--resume", req.resume);
    } else if (
      req.sessionPreset !== undefined &&
      req.sessionPreset !== null &&
      req.sessionPreset !== ""
    ) {
      argv.push("--session-id", req.sessionPreset);
    }

    if (req.model !== undefined && req.model !== null && req.model !== "") {
      argv.push("--model", req.model);
    }

    if (req.effort !== undefined && req.effort !== null && req.effort !== "") {
      argv.push("--effort", req.effort);
    }

    if (
      req.schemaText !== undefined &&
      req.schemaText !== null &&
      req.schemaText !== ""
    ) {
      argv.push("--json-schema", req.schemaText);
    }

    if (req.sandbox) {
      argv.push("--settings", SANDBOX_SETTINGS);
    }

    for (const tool of READ_ONLY_ALLOWED_TOOLS) {
      argv.push("--allowedTools", tool);
    }

    for (const command of req.readCommands ?? []) {
      argv.push("--allowedTools", `Bash(${command}*)`);
    }

    argv.push(
      "--disallowedTools",
      ...DISALLOWED_WRITE_TOOLS,
      ...DISALLOWED_SUBAGENT_TOOLS
    );

    return { argv, stdin: null, env: {}, cwd: req.cwd };
  },
  parse(out) {
    const envelope = parseEnvelope(out.stdout);
    const diagnostics = out.stderrTail.replaceAll(ADVISORY, "");
    const both = `${out.stderrTail}\n${out.stdout}`;

    if (out.exit === 0 && envelope?.isError !== true) {
      return claudeSuccess(out, envelope);
    }

    const detailText =
      envelope?.text !== undefined && envelope.text !== ""
        ? envelope.text
        : out.stderrTail;

    const detail = `claude exit ${String(out.exit)}: ${detailText.trim().slice(0, 300)}`;

    if (isSandboxUnsupported(diagnostics, { includeSettings: true })) {
      return failOutcome("sandbox-unsupported", detail);
    }

    if (
      envelope?.code === "claude_code_version_too_old" ||
      CLI_OUTDATED.test(both)
    ) {
      return failOutcome("cli-outdated", detail);
    }

    if (envelope?.status === 404 || MODEL_NOT_FOUND.test(both)) {
      return failOutcome("model-not-found", detail);
    }

    return failOutcome(classifyFailure(both) ?? "empty-output", detail);
  },
};
