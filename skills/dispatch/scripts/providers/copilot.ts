// GitHub Copilot (spec §6.1): plan mode with --assisted-approval --no-ask-user; sandbox adds
// --sandbox --allow-all-tools; quota moves to the next mode, auth does not; resume `copilot --resume <id>`.

import {
  classifyFailure,
  extractCleanResponse,
  extractSessionId,
  failOutcome,
  isSandboxUnsupported,
} from './response.ts';
import type { FailureClass } from '../toolkit/types.ts';
import type { LaunchRequest, PlatformEnv, ProcessResult, ProviderSpec, RunOutcome } from './types.ts';
import { validSessionId } from '../lib/session.ts';
import { sessionUsageReader } from './session-usage.ts';

const AUTH =
  /(no authentication|can be authenticated|oauth token|personal access token|gh auth login|subscription required|not subscribed|active github copilot subscription)/i;

const join = (env: PlatformEnv, ...parts: string[]): string => parts.join(env.os === 'win32' ? '\\' : '/');
const SANDBOX_FLAGS = ['--sandbox', '--allow-all-tools'] as const;
const EFFORT_REJECTION =
  /^(?:error: invalid value '[^'\r\n]+' for '--reasoning-effort <level>'|Error: Model "[^"\r\n]+" does not support reasoning effort configuration \(requested: "[^"\r\n]+"\)\.)\r?$/im;
const UNSUPPORTED_HOST_WARNING = /^Sandboxing is enabled but is not supported on this host\b[^\r\n]*(?:\r?\n|$)/i;

function classify(text: string, checkSandbox = true): FailureClass | null {
  if (checkSandbox && isSandboxUnsupported(text)) return 'sandbox-unsupported';
  if (AUTH.test(text)) return 'auth';
  return classifyFailure(text);
}

export const copilot: ProviderSpec = {
  id: 'copilot',
  invocationAttribution: { measured: 'measured-only' },
  sessionUsageFromAttempt: true,
  acceptPartialSessionUsage: true,
  usageUnavailable: 'no usage',
  resumeUsage: 'per-launch',
  sessionUsage: sessionUsageReader('copilot', (_raw, context) => context.sessionId || undefined),
  modes: [
    {
      id: 'cli',
      candidates: (env) => [
        env.os === 'win32' ? 'copilot.cmd' : 'copilot',
        env.os === 'win32' ? 'copilot.exe' : join(env, env.home, '.local', 'bin', 'copilot'),
      ],
    },
    {
      id: 'desktop',
      candidates: (env) =>
        env.os === 'darwin'
          ? ['/Applications/GitHub Copilot.app/Contents/Resources/copilot']
          : env.os === 'win32'
            ? [join(env, env.home, 'AppData', 'Local', 'GitHubCopilot', '*', 'copilot.exe')]
            : [],
    },
    {
      id: 'vscode',
      candidates: (env) => [
        join(
          env,
          env.home,
          '.vscode',
          'extensions',
          'github.copilot-chat-*',
          'dist',
          'cli',
          env.os === 'win32' ? 'copilot.exe' : 'copilot',
        ),
      ],
    },
  ],
  readOnlyFlags: ['--mode', 'plan'],
  sandbox: {
    flags: SANDBOX_FLAGS,
    inactive: /(?:sandbox[^\n]*(?:not active|disabled)|sandboxing is enabled but is not supported on this host)/i,
    supported: () => true,
  },
  native: 'copilot',
  modeCascadeOn: ['quota'],
  resumeCommand: (id) => `copilot --resume ${id}`,
  // NOTE: a preset id alone proves nothing; only an idle kill after streamed output reports it.
  presetsSession: true,
  attemptSession(out: ProcessResult, req: LaunchRequest): string | null {
    if (req.resume) return validSessionId(req.resume);
    const extracted = extractSessionId(out.stdout, 'copilot') ?? extractSessionId(out.stderrTail, 'copilot');
    if (extracted) return validSessionId(extracted);
    if (out.idleMs !== undefined && out.stdout.trim() && req.sessionPreset) return validSessionId(req.sessionPreset);
    if (out.wrapUpStop && out.stdout.trim() && req.sessionPreset) return validSessionId(req.sessionPreset);
    return null;
  },
  argv(req) {
    const argv = [
      req.binary,
      ...(req.sandbox ? [...SANDBOX_FLAGS] : []),
      '--assisted-approval',
      '--no-ask-user',
      '-p',
      req.prompt,
    ];
    if (req.resume) argv.push('--resume', req.resume);
    else if (req.sessionPreset) argv.push('--session-id', req.sessionPreset);
    if (req.model) argv.push('--model', req.model);
    if (req.effort) argv.push('--reasoning-effort', req.effort);
    for (const command of req.readCommands ?? []) {
      if (command && !/\s/.test(command)) argv.push('--allow-tool', `shell(${command}:*)`);
    }
    argv.push('--mode', 'plan');
    return { argv, stdin: null, env: {}, cwd: req.cwd };
  },
  parse(out, req): RunOutcome {
    // Only the line-anchored CLI startup warning can classify exit-0 output as sandbox failure.
    const sandboxUnsupported =
      UNSUPPORTED_HOST_WARNING.test(out.stdout.trimStart()) ||
      (out.exit === 0 && new RegExp(UNSUPPORTED_HOST_WARNING.source, 'im').test(out.stderrTail.trimStart()));
    const diagnostics = out.exit === 0 ? out.stderrTail : `${out.stderrTail}\n${out.stdout}`;
    const cls = sandboxUnsupported ? 'sandbox-unsupported' : classify(diagnostics, out.exit !== 0);
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
