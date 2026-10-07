// Provider contracts (spec §6.1–§6.3). Specs are declarative data plus pure `argv`/`parse`; the runner owns I/O
// through `ProcessPort` (core `SpawnPort` is buffered and cannot stream, cap, or kill a tree).

import type { FailureClass } from '../core/types.ts';
import type { PlatformEnv, ProviderKey } from '../lib/platform.ts';
import type { DiagnosticBinding, DiagnosticUsage } from '../core/types.ts';

export type { PlatformEnv } from '../lib/platform.ts';

export type ProviderId = ProviderKey;
export type ModeId = 'cli' | 'desktop' | 'vscode';
export const MODE_IDS: readonly ModeId[] = ['cli', 'desktop', 'vscode'];

export type ModeSpec = { id: ModeId; candidates: (env: PlatformEnv) => readonly string[] };

export type DelegateRequest = {
  diagnostics?: DiagnosticBinding;
  promptPath: string;
  model: string | null;
  effort: string | null;
  sandbox: boolean;
  schemaPath: string | null;
  resume: string | null;
  cwd: string;
  timeoutMs: number;
  outputCapBytes: number;
  attachments: readonly string[];
  /** Slot log (stdout stream); the spill brief is written beside it. */
  logPath: string;
  /** Spill target when the prompt cannot ride on argv. */
  briefPath: string;
  /** OpenCode endpoint base URL (e.g. `http://127.0.0.1:1234/v1`); null for a remote or default provider. */
  endpoint?: string | null;
  agent?: string | null;
  readOnlyVerified?: boolean;
  /** Opencode's built-in explore agent accepted without a verified read-only permission set. */
  readOnlyBestEffort?: boolean;
  configSelectors?: Readonly<Record<string, string>>;
};

/** What `argv` receives: the request plus the runner-prepared prompt and resolved binary. */
export type LaunchRequest = DelegateRequest & {
  binary: string;
  /** Prompt text for argv: the guarded prompt, or a pointer to the spilled brief. */
  prompt: string;
  briefFile: string | null;
  schemaText: string | null;
  platform: PlatformEnv;
};

export type Launch = { argv: readonly string[]; stdin: string | null; env: Readonly<Record<string, string>>; cwd: string; promptFile?: string };

export type ProcessResult = {
  exit: number | null;
  signal: string | null;
  /** Captured stdout text (at most the output cap). */
  stdout: string;
  stdoutPath: string;
  stderrTail: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
};

export type RunOutcome =
  | { status: 'ok'; text: string; sessionId: string | null; resume: string | null }
  | { status: 'fail'; cls: FailureClass; detail: string; retryWithoutEffort?: boolean };

export type Prelaunch =
  | { kind: 'launch'; env: Readonly<Record<string, string>>; release: () => void | Promise<void> }
  | { kind: 'fail'; outcome: Extract<RunOutcome, { status: 'fail' }> };

export type PreparePorts = {
  /** GET `<endpoint>/models`: model ids, or null when the server is offline. */
  fetchModels(endpoint: string): Promise<readonly string[] | null>;
  /** Acquires the local GPU concurrency lock; resolves to its release. */
  acquireGpuLock(): Promise<() => void | Promise<void>>;
};

export type SandboxSpec = {
  /** Flags `argv` adds only when `sandbox: true`. */
  flags: readonly string[];
  /** Output signature meaning the sandbox did not take effect. */
  inactive: RegExp;
  supported(env: PlatformEnv): boolean;
};

export type ProviderSpec = {
  id: ProviderId;
  modes: readonly ModeSpec[];
  /** Read-only controls `argv` always includes. */
  readOnlyFlags: readonly string[];
  argv(req: LaunchRequest, mode: ModeId): Launch;
  parse(out: ProcessResult, req: LaunchRequest): RunOutcome;
  usage?(raw: string): DiagnosticUsage | undefined;
  sandbox?: SandboxSpec;
  schema?: true;
  /** Host platform whose native subagents can serve this provider's targets. */
  native?: ProviderId;
  /** Classes that advance to the next mode (spec §6.4). */
  modeCascadeOn: readonly FailureClass[];
  resumeCommand(id: string): string;
  prepare?(req: LaunchRequest, ports: PreparePorts): Promise<Prelaunch>;
};

export interface ProcessPort {
  /** Launches detached (own process group on POSIX), streaming stdout to `logPath` up to `capBytes`. */
  start(launch: Launch, io: { logPath: string; capBytes: number }): { pid: number; done: Promise<ProcessResult> };
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
}
