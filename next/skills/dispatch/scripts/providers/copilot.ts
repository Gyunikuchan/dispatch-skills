// GitHub Copilot (spec §6.1; ports legacy runners/copilot.mjs): plan mode; sandbox `--experimental --sandbox`;
// quota moves to the next mode, auth does not; resume `copilot --resume <id>`.

import { classifyFailure, extractCleanResponse, extractSessionId, failOutcome, isSandboxUnsupported } from './runner.ts';
import type { FailureClass } from '../core/types.ts';
import type { PlatformEnv, ProviderSpec, RunOutcome } from './types.ts';

const AUTH = /(no authentication|can be authenticated|oauth token|personal access token|gh auth login|subscription required|not subscribed|active github copilot subscription)/i;

const join = (env: PlatformEnv, ...parts: string[]): string => parts.join(env.os === 'win32' ? '\\' : '/');

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
  sandbox: { flags: ['--experimental', '--sandbox'], inactive: /sandbox[^\n]*(?:not active|disabled)/i, supported: () => true },
  native: 'copilot',
  modeCascadeOn: ['quota'],
  resumeCommand: (id) => `copilot --resume ${id}`,
  argv(req) {
    const argv = [req.binary, ...(req.sandbox ? ['--experimental', '--sandbox'] : []), '-p', req.prompt];
    if (req.resume) argv.push('--resume', req.resume);
    if (req.model) argv.push('--model', req.model);
    if (req.effort) argv.push('--effort', req.effort);
    argv.push('--mode', 'plan');
    return { argv, stdin: null, env: {}, cwd: req.cwd };
  },
  parse(out): RunOutcome {
    // Stdout counts only on failure: a review body quoting "OAuth token" is not an auth failure.
    const diagnostics = out.exit === 0 ? out.stderrTail : `${out.stderrTail}\n${out.stdout}`;
    const cls = isSandboxUnsupported(`${out.stderrTail}\n${out.stdout}`) ? 'sandbox-unsupported' : classify(diagnostics);
    const text = extractCleanResponse(out.stdout);
    if (out.exit === 0 && !cls && text) {
      const id = extractSessionId(out.stdout, 'copilot') ?? extractSessionId(out.stderrTail, 'copilot');
      return { status: 'ok', text, sessionId: id, resume: id ? `copilot --resume ${id}` : null };
    }
    return failOutcome(cls ?? 'empty-output', `copilot exit ${String(out.exit)}: ${out.stderrTail.trim().slice(0, 300)}`);
  },
};
