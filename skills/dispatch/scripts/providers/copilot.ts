// GitHub Copilot (spec §6.1): plan mode; sandbox --sandbox with hands-free tool approval;
// quota moves to the next mode, auth does not; resume `copilot --resume <id>`.

import { classifyFailure, extractCleanResponse, extractSessionId, failOutcome, isSandboxUnsupported } from './runner.ts';
import type { FailureClass } from '../toolkit/types.ts';
import type { PlatformEnv, ProviderSpec, RunOutcome } from './types.ts';

const AUTH = /(no authentication|can be authenticated|oauth token|personal access token|gh auth login|subscription required|not subscribed|active github copilot subscription)/i;

const join = (env: PlatformEnv, ...parts: string[]): string => parts.join(env.os === 'win32' ? '\\' : '/');
const SANDBOX_FLAGS = ['--sandbox', '--allow-all-tools', '--no-ask-user'] as const;
const EFFORT_REJECTION = /^(?:error: invalid value '[^'\r\n]+' for '--reasoning-effort <level>'|Error: Model "[^"\r\n]+" does not support reasoning effort configuration \(requested: "[^"\r\n]+"\)\.)\r?$/im;
const UNSUPPORTED_HOST_WARNING = /^Sandboxing is enabled but is not supported on this host\b[^\r\n]*(?:\r?\n|$)/i;

function classify(text: string): FailureClass | null {
  if (isSandboxUnsupported(text)) return 'sandbox-unsupported';
  if (AUTH.test(text)) return 'auth';
  return classifyFailure(text);
}

export const copilot: ProviderSpec = {
  id: 'copilot',
  modes: [
    { id: 'cli', candidates: (env) => [env.os === 'win32' ? 'copilot.cmd' : 'copilot', env.os === 'win32' ? 'copilot.exe' : join(env, env.home, '.local', 'bin', 'copilot')] },
    { id: 'desktop', candidates: (env) => env.os === 'darwin'
      ? ['/Applications/GitHub Copilot.app/Contents/Resources/copilot']
      : env.os === 'win32' ? [join(env, env.home, 'AppData', 'Local', 'GitHubCopilot', '*', 'copilot.exe')] : [] },
    { id: 'vscode', candidates: (env) => [join(env, env.home, '.vscode', 'extensions', 'github.copilot-chat-*', 'dist', 'cli', env.os === 'win32' ? 'copilot.exe' : 'copilot')] },
  ],
  readOnlyFlags: ['--mode', 'plan'],
  sandbox: { flags: SANDBOX_FLAGS, inactive: /(?:sandbox[^\n]*(?:not active|disabled)|sandboxing is enabled but is not supported on this host)/i, supported: () => true },
  native: 'copilot',
  modeCascadeOn: ['quota'],
  resumeCommand: (id) => `copilot --resume ${id}`,
  argv(req) {
    const argv = [req.binary, ...(req.sandbox ? [...SANDBOX_FLAGS] : []), '-p', req.prompt];
    if (req.resume) argv.push('--resume', req.resume);
    if (req.model) argv.push('--model', req.model);
    if (req.effort) argv.push('--reasoning-effort', req.effort);
    argv.push('--mode', 'plan');
    return { argv, stdin: null, env: {}, cwd: req.cwd };
  },
  parse(out, req): RunOutcome {
    // Only the anchored CLI startup warning can classify successful stdout as sandbox failure.
    const diagnostics = out.exit === 0 ? out.stderrTail : `${out.stderrTail}\n${out.stdout}`;
    const cls = UNSUPPORTED_HOST_WARNING.test(out.stdout.trimStart()) ? 'sandbox-unsupported' : classify(diagnostics);
    const text = extractCleanResponse(out.stdout);
    if (out.exit === 0 && !cls && text) {
      const id = extractSessionId(out.stdout, 'copilot') ?? extractSessionId(out.stderrTail, 'copilot');
      return { status: 'ok', text, sessionId: id, resume: id ? `copilot --resume ${id}` : null };
    }
    const detail = `copilot exit ${String(out.exit)}: ${out.stderrTail.trim().slice(0, 300)}`;
    if (cls) return failOutcome(cls, detail);
    if (out.exit !== 0 && out.exit !== null && req.effort && EFFORT_REJECTION.test(out.stderrTail)) {
      return { ...failOutcome('empty-output', detail), retryWithoutEffort: true };
    }
    return failOutcome('empty-output', detail);
  },
};
