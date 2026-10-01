// Antigravity (spec §6.1): headless plan mode; token, subscription, and execution
// failures cascade to the next mode; a spilled brief is reachable through `--add-dir`; resume `conversation://<id>`.

import { classifyFailure, failOutcome } from './runner.ts';
import type { ModeId, PlatformEnv, ProviderSpec, RunOutcome } from './types.ts';

export const AGY_MODE_PROFILES: Readonly<Record<ModeId, string>> = { cli: 'antigravity-cli', desktop: 'antigravity', vscode: 'antigravity-ide' };

const TOKEN_OR_SUBSCRIPTION = /\b(not signed in|no tokens?|subscription|license|selfassignlicense)/i;

const join = (env: PlatformEnv, ...parts: string[]): string => parts.join(env.os === 'win32' ? '\\' : '/');
const dirname = (file: string): string => file.replace(/[/\\][^/\\]*$/, '') || file;

function parseEnvelope(stdout: string): { conversationId: string | null; text: string | null } {
  const start = stdout.indexOf('{');
  if (start === -1) return { conversationId: null, text: null };
  let value: unknown;
  try { value = JSON.parse(stdout.slice(start)); } catch { return { conversationId: null, text: null }; }
  if (typeof value !== 'object' || value === null) return { conversationId: null, text: null };
  const record = value as Record<string, unknown>;
  const nested = record['conversation'] as { id?: unknown } | undefined;
  const id = record['conversationId'] ?? record['conversation_id'] ?? nested?.id;
  const text = record['response'] ?? record['result'] ?? record['text'] ?? record['output'];
  return { conversationId: typeof id === 'string' && id ? id : null, text: typeof text === 'string' ? text : null };
}

export const agy: ProviderSpec = {
  id: 'agy',
  modes: [
    { id: 'cli', candidates: (env) => [env.os === 'win32' ? 'agy.exe' : 'agy', env.os === 'win32' ? 'agy.cmd' : join(env, env.home, '.local', 'bin', 'agy')] },
    { id: 'desktop', candidates: (env) => env.os === 'darwin'
      ? ['/Applications/Antigravity.app/Contents/Resources/app/bin/agy']
      : env.os === 'win32' ? [join(env, env.home, 'AppData', 'Local', 'Programs', 'Antigravity', 'bin', 'agy.cmd')] : ['/usr/share/antigravity/bin/agy'] },
    { id: 'vscode', candidates: (env) => [join(env, env.home, '.vscode', 'extensions', 'google.antigravity-*', 'bin', env.os === 'win32' ? 'agy.exe' : 'agy')] },
  ],
  readOnlyFlags: ['--mode', 'plan'],
  native: 'agy',
  // token/subscription → quota or auth; execution → not-found (mode unreachable or crashed).
  modeCascadeOn: ['quota', 'auth', 'not-found'],
  resumeCommand: (id) => `conversation://${id}`,
  argv(req, mode) {
    const seconds = Math.max(1, Math.ceil(req.timeoutMs / 1000));
    const argv = [req.binary, '--print', req.prompt, '--output-format', 'json', `--print-timeout=${seconds}s`];
    if (req.briefFile) argv.push('--add-dir', dirname(req.briefFile));
    if (req.model) argv.push('--model', req.model);
    if (req.effort) argv.push('--effort', req.effort);
    argv.push('--mode', 'plan', '--dangerously-skip-permissions');
    return { argv, stdin: null, env: { JETSKI_APP_DATA_DIR: AGY_MODE_PROFILES[mode] }, cwd: req.cwd };
  },
  parse(out): RunOutcome {
    const envelope = parseEnvelope(out.stdout);
    const text = (envelope.text ?? out.stdout).trim();
    if (out.exit === 0 && text) {
      const id = envelope.conversationId;
      return { status: 'ok', text, sessionId: id, resume: id ? `conversation://${id}` : null };
    }
    const both = `${out.stderrTail}\n${out.stdout}`;
    const detail = `agy exit ${String(out.exit)}: ${out.stderrTail.trim().slice(0, 300)}`;
    const cls = classifyFailure(both) ?? (TOKEN_OR_SUBSCRIPTION.test(both) ? 'auth' : out.exit === 0 ? 'empty-output' : 'not-found');
    return failOutcome(cls, detail);
  },
};
