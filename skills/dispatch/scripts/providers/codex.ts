// Codex (spec §6.1): `exec --json` with approvals disabled and a read-only
// sandbox; sandbox rejection → `sandbox-unsupported`; only `sandbox: false` selects `danger-full-access`.

import { classifyFailure, failOutcome } from './runner.ts';
import type { PlatformEnv, ProviderSpec, RunOutcome } from './types.ts';

const REJECTED = [
  /(?:unrecognized|unknown|unexpected|invalid) (?:option|argument|value)[^\n]*--sandbox/i,
  /sandbox[^\n]*(?:unavailable|unsupported|initialization failed|not supported)|(?:failed to initialize|failed to create)[^\n]*sandbox/i,
];

const join = (env: PlatformEnv, ...parts: string[]): string => parts.join(env.os === 'win32' ? '\\' : '/');

/** The final assistant message and thread id from the JSONL stream; tool events stay in the log. */
export function parseCodexEvents(raw: string): { answer: string; threadId: string | null; error: string | null } {
  let answer = '';
  let threadId: string | null = null;
  let error: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const item = event['item'] as { type?: unknown; text?: unknown } | undefined;
    if (event['type'] === 'thread.started' && typeof event['thread_id'] === 'string') threadId = event['thread_id'];
    if (event['type'] === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') answer = item.text;
    if (event['type'] === 'turn.failed' || event['type'] === 'error') {
      const nested = event['error'] as { message?: unknown } | undefined;
      error = typeof nested?.message === 'string' ? nested.message : typeof event['message'] === 'string' ? event['message'] : 'Codex turn failed';
    }
  }
  return { answer, threadId, error };
}

export const codex: ProviderSpec = {
  id: 'codex',
  modes: [
    { id: 'cli', candidates: (env) => [env.os === 'win32' ? 'codex.cmd' : 'codex', env.os === 'win32' ? 'codex.exe' : join(env, env.home, '.local', 'bin', 'codex')] },
    { id: 'desktop', candidates: (env) => env.os === 'darwin' ? ['/Applications/Codex.app/Contents/Resources/codex'] : env.os === 'win32' ? [join(env, env.home, 'AppData', 'Local', 'Programs', 'Codex', 'resources', 'codex.exe')] : [] },
    { id: 'vscode', candidates: (env) => [join(env, env.home, '.vscode', 'extensions', 'openai.chatgpt-*', 'bin', '*', env.os === 'win32' ? 'codex.exe' : 'codex')] },
  ],
  readOnlyFlags: ['--config', 'approval_policy="never"'],
  sandbox: { flags: ['--sandbox', 'read-only'], inactive: REJECTED[1] ?? /$^/, supported: () => true },
  modeCascadeOn: [],
  resumeCommand: (id) => `codex exec resume ${id}`,
  argv(req) {
    const argv = [req.binary, 'exec'];
    if (req.resume) argv.push('resume', req.resume);
    argv.push('--json', '--cd', req.cwd, '--config', 'approval_policy="never"');
    // NOTE: the unsandboxed path uses config because an older CLI may reject --sandbox itself.
    if (req.sandbox) argv.push('--sandbox', 'read-only');
    else argv.push('--config', 'sandbox_mode="danger-full-access"');
    if (req.model) argv.push('--model', req.model);
    if (req.effort) argv.push('--config', `model_reasoning_effort=${JSON.stringify(req.effort)}`);
    argv.push(req.prompt);
    return { argv, stdin: null, env: {}, cwd: req.cwd };
  },
  parse(out): RunOutcome {
    const events = parseCodexEvents(out.stdout);
    // Classify only CLI diagnostics; the answer may legitimately quote an error.
    const diagnostics = `${out.stderrTail}\n${events.error ?? ''}`;
    if (REJECTED.some((pattern) => pattern.test(diagnostics))) return failOutcome('sandbox-unsupported', `codex rejected its sandbox: ${diagnostics.trim().slice(0, 300)}`);
    if (out.exit === 0 && events.answer.trim() && !events.error) {
      const id = events.threadId;
      return { status: 'ok', text: events.answer.trim(), sessionId: id, resume: id ? `codex exec resume ${id}` : null };
    }
    return failOutcome(classifyFailure(diagnostics) ?? 'empty-output', `codex exit ${String(out.exit)}: ${diagnostics.trim().slice(0, 300)}`);
  },
};
