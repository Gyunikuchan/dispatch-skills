import type { FailureClass } from "../toolkit/types.ts";
import type { RunOutcome } from "./types.ts";

/** Shared classifier over diagnostics text; null when nothing matches. */
export const classifyFailure = (text: string): FailureClass | null => {
  if (!text) {
    return null;
  }

  if (
    /(?<rg1>no (?<rg2>active )?subscription|subscription (?<rg3>is )?(?<rg4>required|expired|inactive|not found)|payment required|\b402\b)/iu.test(
      text
    )
  ) {
    return "auth";
  }

  if (
    /\b(?<rg1>usage limit|rate limit|rate_limit|quota|credit balance|insufficient[_ ]quota|too many requests|\b429\b)/iu.test(
      text
    )
  ) {
    return "quota";
  }

  if (
    /(?<rg1>context (?<rg2>window|length)|prompt is too long|maximum context|token limit|context_length_exceeded|too many tokens|CONTEXT_BUDGET_EXCEEDED)/iu.test(
      text
    )
  ) {
    return "context-overflow";
  }

  if (
    /(?<rg1>unauthorized|not authenticated|authentication failed|no authentication|invalid api key|please (?<rg2>log|sign) in|access denied by policy|policy settings may be preventing access|\b401\b|\b403\b)/iu.test(
      text
    )
  ) {
    return "auth";
  }

  if (
    /no models loaded|model (?<rg1>is )?not loaded|SERVER_OFFLINE/iu.test(text)
  ) {
    return "model-not-loaded";
  }

  if (
    /(?<rg1>command not found|is not recognized|ENOENT|no such file or directory)/iu.test(
      text
    )
  ) {
    return "not-found";
  }

  if (/(?<rg1>timed out|timeout|ETIMEDOUT)/iu.test(text)) {
    return "timeout";
  }

  return null;
};

/** A provider diagnostic saying a sandbox flag or setting is unsupported. */
export const isSandboxUnsupported = (
  text: string,
  options: { includeSettings?: boolean; strict?: boolean } = {}
) => {
  const flag =
    options.includeSettings === true
      ? String.raw`--(?:settings|sandbox)|\bsandbox(?:ing)?\b`
      : String.raw`--sandbox|\bsandbox(?:ing)?\b`;

  const reason =
    options.strict === true
      ? "unknown|unrecognized|unsupported|invalid"
      : "unknown|unrecognized|unsupported|invalid|ignored|unavailable|not available|not supported|disabled|cannot|can't|requires";

  return new RegExp(
    `(?:(?:${flag}).{0,80}(?:${reason})|(?:${reason}).{0,80}(?:${flag}))`,
    "iu"
  ).test(text);
};

/** JSON `session_id`, a `session id:` line, or the CLI's own `--resume` mention. */
export const extractSessionId = (text: string, resumePrefix: string) => {
  const match =
    /"session_id"\s*:\s*"(?<rg1>[a-zA-Z0-9_-]+)"/u.exec(text) ??
    /session\s+id[:=]\s*(?<rg1>[a-zA-Z0-9_-]{8,})/iu.exec(text) ??
    new RegExp(`${resumePrefix}\\s+--resume\\s+([a-zA-Z0-9_-]{8,})`, "iu").exec(
      text
    );

  return match?.[1] ?? null;
};

const TRACE =
  /^(?:> build|→ (?:Skill|Read|Write|Edit|Run)|\$ |✱ |\[dispatch\])/u;

/** Drops a leading tool trace so only the answer remains. */
export const extractCleanResponse = (raw: string) => {
  const lines = raw.trim().split(/\r?\n/u);
  let start = 0;

  while (
    start < lines.length &&
    (TRACE.test(lines[start] ?? "") || !(lines[start] ?? "").trim())
  ) {
    start += 1;
  }

  return start > 0 && start < lines.length
    ? lines.slice(start).join("\n").trim()
    : raw.trim();
};

export const failOutcome = (cls: FailureClass, detail: string) =>
  ({
    status: "fail",
    cls,
    detail,
  }) satisfies Extract<RunOutcome, { status: "fail" }>;
