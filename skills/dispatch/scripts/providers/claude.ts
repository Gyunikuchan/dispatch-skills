// Claude Code (spec §6.1; ports legacy runners/claude.mjs): plan permission mode, read-tool allowlist, write-tool
// denylist; sandbox via `--settings`; native Windows reports the sandbox inactive → `sandbox-unsupported`.

import { classifyFailure, extractCleanResponse, extractSessionId, failOutcome, isSandboxUnsupported } from './runner.ts';
import type { PlatformEnv, ProviderSpec, RunOutcome } from './types.ts';

/** Read-only tools; commands that write through their own arguments and web tools are excluded. */
export const READ_ONLY_ALLOWED_TOOLS = [
  'Read', 'Glob', 'Grep', 'LS', 'Bash(git diff*)', 'Bash(git status*)', 'Bash(git log*)', 'Bash(git show*)', 'Bash(git blame*)',
  'Bash(git rev-parse*)', 'Bash(git ls-files*)', 'Bash(grep *)', 'Bash(rg *)', 'Bash(ls *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(wc *)',
  'Bash(file *)', 'Bash(jq *)', 'Bash(diff *)', 'Bash(uniq *)', 'Bash(cut *)', 'Bash(tr *)', 'Bash(stat *)', 'Bash(which *)', 'Bash(type *)',
  'Bash(date *)', 'Bash(basename *)', 'Bash(dirname *)', 'Bash(realpath *)', 'Bash(readlink *)', 'Bash(column *)', 'Bash(paste *)',
  'Bash(npm ls*)', 'TodoWrite',
] as const;
export const DISALLOWED_WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit'] as const;
export const SANDBOX_SETTINGS = JSON.stringify({ sandbox: { enabled: true } });

const MODEL_NOT_FOUND = /selected model|model\b[^\n]*\bnot found/i;
const CLI_OUTDATED = /claude_code_version_too_old|Claude Code \S+ does not support this model/i;
const ADVISORY = /^[^\n]*Sandbox disabled[^\n]*not active[^\n]*$/gim;

const exe = (env: PlatformEnv): string => (env.os === 'win32' ? '.exe' : '');
const join = (env: PlatformEnv, ...parts: string[]): string => parts.join(env.os === 'win32' ? '\\' : '/');

type Envelope = { text: string; sessionId: string | null; isError: boolean; subtype: string | null; status: number | null; code: string | null };

function parseEnvelope(stdout: string): Envelope | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return null; }
  const pick = Array.isArray(parsed) ? parsed.findLast((entry: unknown) => (entry as { type?: unknown } | null)?.type === 'result') : parsed;
  if (typeof pick !== 'object' || pick === null) return null;
  const record = pick as Record<string, unknown>;
  const text = typeof record['result'] === 'string' ? record['result'] : typeof record['error'] === 'string' ? record['error'] : '';
  return {
    text: text.trim(),
    sessionId: typeof record['session_id'] === 'string' ? record['session_id'] : null,
    isError: record['is_error'] === true,
    subtype: typeof record['subtype'] === 'string' ? record['subtype'] : null,
    status: Number.isInteger(record['api_error_status']) ? record['api_error_status'] as number : null,
    code: typeof record['api_error_code'] === 'string' ? record['api_error_code'] : null,
  };
}

export const claude: ProviderSpec = {
  id: 'claude',
  modes: [
    { id: 'cli', candidates: (env) => [env.os === 'win32' ? 'claude.exe' : 'claude', ...(env.os === 'win32' ? ['claude.cmd'] : []), join(env, env.home, '.local', 'bin', `claude${exe(env)}`), join(env, env.home, '.claude', 'local', `claude${exe(env)}`)] },
    { id: 'desktop', candidates: (env) => env.os === 'darwin'
      ? ['/Applications/Claude.app/Contents/Resources/claude-code/claude', join(env, env.home, 'Applications/Claude.app/Contents/Resources/claude-code/claude')]
      : env.os === 'win32' ? [join(env, env.home, 'AppData', 'Roaming', 'Claude', 'claude-code', '*', 'claude.exe')] : [] },
    { id: 'vscode', candidates: (env) => ['.vscode', '.vscode-insiders', '.vscode-server', '.cursor'].map((dir) =>
      join(env, env.home, dir, 'extensions', 'anthropic.claude-code-*', 'resources', 'native-binary', `claude${exe(env)}`)) },
  ],
  readOnlyFlags: ['--permission-mode', 'plan', '--disallowedTools', ...DISALLOWED_WRITE_TOOLS],
  sandbox: {
    flags: ['--settings', SANDBOX_SETTINGS],
    inactive: /Sandbox disabled[^\n]*not active/i,
    // Seatbelt on macOS, Bubblewrap on Linux/WSL2; native Windows has none.
    supported: (env) => env.os !== 'win32',
  },
  schema: true,
  native: 'claude',
  modeCascadeOn: [],
  resumeCommand: (id) => `claude --resume ${id}`,
  argv(req) {
    const argv = [req.binary, '-p', req.prompt, '--output-format', 'json', '--permission-mode', 'plan'];
    if (req.resume) argv.push('--resume', req.resume);
    if (req.model) argv.push('--model', req.model);
    if (req.effort) argv.push('--effort', req.effort);
    if (req.schemaText) argv.push('--json-schema', req.schemaText);
    if (req.sandbox) argv.push('--settings', SANDBOX_SETTINGS);
    for (const tool of READ_ONLY_ALLOWED_TOOLS) argv.push('--allowedTools', tool);
    argv.push('--disallowedTools', ...DISALLOWED_WRITE_TOOLS);
    return { argv, stdin: null, env: {}, cwd: req.cwd };
  },
  parse(out): RunOutcome {
    const envelope = parseEnvelope(out.stdout);
    const diagnostics = out.stderrTail.replace(ADVISORY, '');
    const both = `${out.stderrTail}\n${out.stdout}`;
    if (out.exit === 0 && !envelope?.isError) {
      const early = classifyFailure(out.stderrTail) ?? (isSandboxUnsupported(diagnostics, { includeSettings: true, strict: true }) ? 'sandbox-unsupported' : null);
      if (early) return failOutcome(early, `claude: ${out.stderrTail.trim().slice(0, 300)}`);
      const text = envelope ? envelope.text : extractCleanResponse(out.stdout);
      if (!text) return failOutcome('empty-output', 'claude exited 0 with no response text');
      const sessionId = envelope?.sessionId ?? extractSessionId(out.stdout, 'claude');
      return { status: 'ok', text, sessionId, resume: sessionId ? `claude --resume ${sessionId}` : null };
    }
    const detail = `claude exit ${String(out.exit)}: ${(envelope?.text || out.stderrTail).trim().slice(0, 300)}`;
    if (isSandboxUnsupported(diagnostics, { includeSettings: true })) return failOutcome('sandbox-unsupported', detail);
    if (envelope?.code === 'claude_code_version_too_old' || CLI_OUTDATED.test(both)) return failOutcome('cli-outdated', detail);
    if (envelope?.status === 404 || MODEL_NOT_FOUND.test(both)) return failOutcome('model-not-found', detail);
    return failOutcome(classifyFailure(both) ?? 'empty-output', detail);
  },
};
