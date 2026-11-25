import type { FailureClass } from '../toolkit/types.ts';
import type { RunOutcome } from './types.ts';

/** Shared classifier over diagnostics text; null when nothing matches. */
export function classifyFailure(text: string): FailureClass | null {
  if (!text) {
    return null;
  }
  // A missing or lapsed plan needs user action, so it is auth and takes precedence over quota wording.
  if (
    /(no (active )?subscription|subscription (is )?(required|expired|inactive|not found)|payment required|\b402\b)/i.test(
      text,
    )
  ) {
    return 'auth';
  }
  if (
    /\b(usage limit|rate limit|rate_limit|quota|credit balance|insufficient[_ ]quota|too many requests|\b429\b)/i.test(
      text,
    )
  ) {
    return 'quota';
  }
  if (
    /(context (window|length)|prompt is too long|maximum context|token limit|context_length_exceeded|too many tokens|CONTEXT_BUDGET_EXCEEDED)/i.test(
      text,
    )
  ) {
    return 'context-overflow';
  }
  if (
    /(unauthorized|not authenticated|authentication failed|no authentication|invalid api key|please (log|sign) in|access denied by policy|policy settings may be preventing access|\b401\b|\b403\b)/i.test(
      text,
    )
  ) {
    return 'auth';
  }
  if (/no models loaded|model (is )?not loaded|SERVER_OFFLINE/i.test(text)) {
    return 'model-not-loaded';
  }
  if (/(command not found|is not recognized|ENOENT|no such file or directory)/i.test(text)) {
    return 'not-found';
  }
  if (/(timed out|timeout|ETIMEDOUT)/i.test(text)) {
    return 'timeout';
  }
  return null;
}

/** A provider diagnostic saying a sandbox flag or setting is unsupported. */
export function isSandboxUnsupported(
  text: string,
  options: { includeSettings?: boolean; strict?: boolean } = {},
): boolean {
  const flag = options.includeSettings
    ? String.raw`--(?:settings|sandbox)|\bsandbox(?:ing)?\b`
    : String.raw`--sandbox|\bsandbox(?:ing)?\b`;
  const reason = options.strict
    ? 'unknown|unrecognized|unsupported|invalid'
    : "unknown|unrecognized|unsupported|invalid|ignored|unavailable|not available|not supported|disabled|cannot|can't|requires";
  return new RegExp(`(?:(?:${flag}).{0,80}(?:${reason})|(?:${reason}).{0,80}(?:${flag}))`, 'i').test(text);
}

/** JSON `session_id`, a `session id:` line, or the CLI's own `--resume` mention. */
export function extractSessionId(text: string, resumePrefix: string): string | null {
  const match =
    /"session_id"\s*:\s*"([a-zA-Z0-9_-]+)"/.exec(text) ??
    /session\s+id[:=]\s*([a-zA-Z0-9_-]{8,})/i.exec(text) ??
    new RegExp(`${resumePrefix}\\s+--resume\\s+([a-zA-Z0-9_-]{8,})`, 'i').exec(text);
  return match?.[1] ?? null;
}

const TRACE = /^(?:> build|→ (?:Skill|Read|Write|Edit|Run)|\$ |✱ |\[dispatch\])/;

/** Drops a leading tool trace so only the answer remains. */
export function extractCleanResponse(raw: string): string {
  const lines = raw.trim().split(/\r?\n/);
  let start = 0;
  while (start < lines.length && (TRACE.test(lines[start] ?? '') || !(lines[start] ?? '').trim())) {
    start++;
  }
  return start > 0 && start < lines.length ? lines.slice(start).join('\n').trim() : raw.trim();
}

export const failOutcome = (cls: FailureClass, detail: string): Extract<RunOutcome, { status: 'fail' }> => ({
  status: 'fail',
  cls,
  detail,
});
