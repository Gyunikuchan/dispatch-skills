// Provider contracts (spec §6.1–§6.3). Specs are declarative data plus pure `argv`/`parse`; the runner owns I/O
// through `ProcessPort` (core `SpawnPort` is buffered and cannot stream, cap, or kill a tree).

import type { FailureClass } from '../toolkit/types.ts';
import type { PlatformEnv, ProviderKey } from '../lib/platform.ts';
import type { CoverageReason, DiagnosticUsage } from '../toolkit/types.ts';

export type { PlatformEnv } from '../lib/platform.ts';

export type ProviderId = ProviderKey;
export type ModeId = 'cli' | 'desktop' | 'vscode';
export const MODE_IDS: readonly ModeId[] = ['cli', 'desktop', 'vscode'];

export type ModeSpec = { id: ModeId; candidates: (env: PlatformEnv) => readonly string[] };

export type DelegateRequest = {
  collectUsage?: boolean;
  /** Set only by the diagnostics observer; OpenCode then records bounded lifecycle steps. */
  collectLifecycle?: boolean;
  promptPath: string;
  model: string | null;
  effort: string | null;
  sandbox: boolean;
  schemaPath: string | null;
  resume: string | null;
  cwd: string;
  /** Active Dispatch session directory; its artifacts skip the basename word patterns in the guard. */
  sessionRoot?: string;
  /** Logical slot this reserve attempt substitutes for; set only on reserve attempts. */
  targetSlot?: string;
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
  /** Host read-command prefixes from config; providers with command allowlists permit them. */
  readCommands?: readonly string[];
};

/** What `argv` receives: the request plus the runner-prepared prompt and resolved binary. */
export type LaunchRequest = DelegateRequest & {
  binary: string;
  /** Prompt text for argv: the guarded prompt, or a pointer to the spilled brief. */
  prompt: string;
  briefFile: string | null;
  schemaText: string | null;
  platform: PlatformEnv;
  /** Pre-assigned session id for a fresh launch; only emitted when the spec presets sessions. */
  sessionPreset?: string | null;
};

export type Launch = { argv: readonly string[]; stdin: string | null; env: Readonly<Record<string, string>>; cwd: string; promptFile?: string };

/** Shell-safe session ids only: ids ride on argv and the win32 batch launcher. */
const VALID_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const validSessionId = (id: string | null | undefined): string | null =>
  (typeof id === 'string' && VALID_SESSION_ID.test(id) ? id : null);

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
  /** Silence length when the runner stopped the process for idleness. */
  idleMs?: number;
  /** OpenCode-owned teardown failure; callers must retain the path and report the unconfirmed exit. */
  lifecycleError?: string;
};

export type RunOutcome =
  | { status: 'ok'; text: string; sessionId: string | null; resume: string | null }
  | { status: 'fail'; cls: FailureClass; detail: string; retryWithoutEffort?: boolean };

/** One measured OpenCode lifecycle step: enums and bounded integers only, never raw output or configuration. */
export type LifecycleStep = { step: 'debug-config' | 'debug-agents' | 'prepare' | 'response' | 'teardown'; elapsedMs: number; budgetMs: number; outcome: 'ok' | 'failed' | 'timeout' | 'unconfirmed' };

/** One launch attempt, journaled on the slot row; `outcome` is `ok` or a failure class (`launch-failed` when the launch threw). */
export type Invocation = { provider: ProviderId; model: string | null; mode: ModeId; effort: string | null; launched: boolean; durationMs?: number; outcome: string; usage?: DiagnosticUsage; coverage?: CoverageReason; lifecycleSteps?: LifecycleStep[]; /** Set on the single resume launch after an idle stop or empty answer. */ nudge?: true };

/** What a wave worker run returns: the provider outcome plus every attempt it took. */
export type RunResult = { outcome: RunOutcome; invocations: Invocation[] };

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
  /** Marks a launched invocation whose provider has no machine-readable usage output. */
  usageUnavailable?: CoverageReason;
  /** Provider-specific stdout cap; the runner default is 10 MiB. */
  outputCapBytes?: number;
  sandbox?: SandboxSpec;
  schema?: true;
  /** Host platform whose native subagents can serve this provider's targets. */
  native?: ProviderId;
  /** Classes that advance to the next mode (spec §6.4). */
  modeCascadeOn: readonly FailureClass[];
  resumeCommand(id: string): string;
  /** True when argv sets `--session-id <sessionPreset>` on a fresh launch (copilot only). */
  presetsSession?: true;
  /** Session id of a finished or killed attempt when the attempt shows the session exists; null otherwise. */
  attemptSession?(out: ProcessResult, req: LaunchRequest): string | null;
  /** The CLI writes nothing until exit (single JSON envelope), so silence is not idleness; only the deadline applies. */
  silentUntilExit?: true;
  prepare?(req: LaunchRequest, ports: PreparePorts): Promise<Prelaunch>;
};

export interface ProcessPort {
  /** Launches detached (own process group on POSIX), streaming stdout to `logPath` up to `capBytes`; `onActivity` fires per stdout or stderr chunk. */
  start(launch: Launch, io: { logPath: string; capBytes: number; onActivity?: () => void }): { pid: number; done: Promise<ProcessResult> };
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  /** Settle only the invocation's POSIX group; false means exit is unconfirmed, not permission to remove its directory. */
  settleGroup?(pid: number, budgetMs: number): Promise<boolean>;
}
