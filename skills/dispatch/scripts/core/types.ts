// Run types shared by every layer. Value-free except `assertNever`; imports nothing (dependency guard).

// SECTION: Closed unions

export type Await = 'author' | 'native' | 'rule' | 'fix' | 'write' | 'evidence' | 'decide' | 'done';

export type DecideKind = 'approval' | 'baseline' | 'failure' | 'concerns' | 'escalation' | 'needs-user' | 'opt-in' | 'drift';

export type DoneOutcome = 'complete' | 'failed' | 'stopped' | 'fault' | 'no-reviewable-changes' | 'lint-defects' | 'skipped';

/** 0 frame printed, 1 usage/Node version, 2 engine fault, 3 lock held. */
export type ExitCode = 0 | 1 | 2 | 3;

export type EffectKind =
  | 'parse-artifact' | 'prepare-review' | 'wave' | 'wave-start' | 'wave-finish' | 'verify' | 'write-brief'
  | 'check-envelope' | 'snapshot' | 'restore' | 'handoff';

// Effect-handler failure classes.
export type EffectFailureClass = 'io' | 'timeout' | 'crash' | 'invalid-output' | 'integrity' | 'config';

/** Provider slot failure classes (spec §6.4). */
export type FailureClass =
  | 'quota' | 'context-overflow' | 'auth' | 'model-not-found' | 'cli-outdated' | 'model-not-loaded'
  | 'sandbox-unsupported' | 'not-found' | 'timeout' | 'buffer' | 'empty-output' | 'refusal'
  | 'truncated' | 'integrity' | 'config';

export type Verb = 'ask' | 'design' | 'plan' | 'review' | 'implement';
export type Level = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export function assertNever(value: never, what = 'value'): never {
  throw new Error(`unhandled ${what}: ${JSON.stringify(value)}`);
}

// SECTION: Payload types

type Payload = Readonly<Record<string, unknown>>;
export type Platform = string;
export type Pins = Payload;
export type Overrides = Payload;
export type ResolvedConfig = Payload;
export type RepoIdentity = Payload;
export type NativeSlotResult = Payload;
export type FindingId = string;
export type Ruling = Payload;
export type FixClusterResult = Payload;
export type WriterFailureKind = string;
export type CriterionId = string;
export type CriterionEvidence = Payload;
export type DecisionAnswer = unknown;
export type ParsedPlan = Payload;
export type ParsedDesign = Payload;
export type LintDefect = Payload;
export type ReviewScope = Payload;
export type SlotId = string;
export type SlotStatus = string;
export type SlotOutcome = Payload;
export type Finding = Payload;
export type VerifyPurpose = string;
export type CommandResult = Payload;
export type TreeFingerprint = Payload;
export type WriteStage = 'tests-only' | 'production' | 'hotfix';
export type RecoverySnapshot = {
  repoRoot: string;
  contents: Readonly<Record<string, string | null>>;
  contentStore?: 'recovery-contents';
  entries: Readonly<Record<string, FileEntry | null>>;
  taskStartFiles: readonly string[];
  callerDirty: readonly string[];
  ignored: readonly { path: string; hash: string }[];
  git: { head: string; index: string; stash: string; gitDir: string };
  changed: readonly { path: string; added: number; removed: number; deleted: boolean; outsideRepo: boolean }[];
  verifiedManifestDirs: readonly string[];
  hashManifestDirs: readonly string[];
};
export type FileEntry = { kind: 'file' | 'symlink'; mode: number; linkTarget: string | null };
export type PathInfo = { kind: 'file' | 'symlink' | 'directory'; mode: number; linkTarget: string | null; realPath: string | null };
export type WriteEnvelope = Payload;
export type PathDiff = Payload;
export type ReviewSpec = Payload;
export type ScopeRequest = Payload;
export type RosterSlot = Payload;
export type VerifyCommand = Payload;
export type BriefInput = Payload;
export type IntegrationScope = { baseline: string; revision: string; ownership: Readonly<Record<string, readonly string[]>> };
export type PathSet = readonly string[];

// SECTION: Events

export type DesignApproval =
  | { by: 'user'; quote: string; hash: string }
  | { by: 'revision'; quote: string; hash: string; basedOn: string; revisions: readonly { before: string; after: string }[] };

export type RunStartedEvent = {
  designApproval?: DesignApproval;
  protocolRevision?: 2;
  type: 'RUN_STARTED'; verb: Verb; argument: string; level: Level; levelSource: 'explicit' | 'classified';
  pins: Pins | null; fix: boolean; orchestrator: Platform; orchestratorModel: string | null;
  overrides: Overrides; config: ResolvedConfig; repo: RepoIdentity;
};

export type LifecycleEvent =
  | RunStartedEvent
  | { type: 'EFFECT_STARTED'; effectId: string; kind: EffectKind; attempt: number; pid?: number }
  | { type: 'LOCK_BROKEN'; stalePid: number };

export type HostEvent =
  | { type: 'AUTHORED'; path: string }
  | { type: 'NATIVE_RESULTS'; slots: NativeSlotResult[] }
  | { type: 'RULINGS'; rulings: Record<FindingId, Ruling> }
  | { type: 'FIXES_APPLIED'; clusters: FixClusterResult[] }
  | { type: 'WRITE_ENVELOPE'; envelopePath: string }
  | { type: 'WRITE_FAILED'; model: string; kind: WriterFailureKind; reason: string }
  | { type: 'EVIDENCE'; criteria: Record<CriterionId, CriterionEvidence> }
  | { type: 'DECISION'; kind: DecideKind; answer: DecisionAnswer }
  | { type: 'REVISE'; artifact: 'plan' | 'design'; reason: string; evidence: string };

export type ResultEvent =
  | { type: 'ARTIFACT_PARSED'; effectId: string; kind: 'plan' | 'design'; hash: string; parsed: ParsedPlan | ParsedDesign; defects: LintDefect[] }
  | { type: 'REVIEW_PREPARED'; effectId: string; scope: ReviewScope; promptPaths: Record<SlotId, string> }
  | { type: 'WAVE_STARTED'; effectId: string; waveKey: string; attempt: number; roster: RosterSlot[]; native: NativeSlotResult[]; early: NativeSlotResult[]; claimPath: string | null; inputPath: string }
  | { type: 'WAVE_PROGRESS'; effectId: string; slot: SlotId; status: SlotStatus }
  | { type: 'WAVE_DONE'; effectId: string; round: number; slots: SlotOutcome[]; findings: Finding[] }
  | { type: 'VERIFY_DONE'; effectId: string; purpose: VerifyPurpose; results: CommandResult[]; fingerprint: TreeFingerprint }
  | { type: 'BRIEF_READY'; effectId: string; stage: WriteStage; path: string; sha256: string; envelopePath: string }
  | { type: 'ENVELOPE_CHECKED'; effectId: string; envelope: WriteEnvelope | null; defects: string[]; diff: PathDiff }
  | { type: 'SNAPSHOT'; effectId: string; fingerprint: TreeFingerprint; diff: PathDiff }
  | { type: 'RESTORED'; effectId: string; paths: string[]; patchPath: string }
  | { type: 'HANDOFF_DONE'; effectId: string; destination: string; warning: string | null }
  | { type: 'EFFECT_FAILED'; effectId: string; cls: EffectFailureClass; detail: string };

export type Event = HostEvent | ResultEvent | LifecycleEvent;
export type EventType = Event['type'];
export type HostEventType = HostEvent['type'];
export type ResultEventType = ResultEvent['type'];

// SECTION: Effects

export type Effect =
  | { kind: 'parse-artifact'; id: string; path: string; artifact: 'plan' | 'design' }
  | { kind: 'prepare-review'; id: string; review: ReviewSpec; round: number; scope: ScopeRequest }
  | { kind: 'wave-start'; id: string; round: number; roster: RosterSlot[]; timeoutMs: number }
  | { kind: 'wave-finish'; id: string; round: number; roster: RosterSlot[]; timeoutMs: number; waveKey: string; attempt: number; captures: NativeSlotResult[] }
  | { kind: 'wave'; id: string; round: number; roster: RosterSlot[]; timeoutMs: number }
  | { kind: 'verify'; id: string; purpose: VerifyPurpose; commands: VerifyCommand[] }
  | { kind: 'write-brief'; id: string; stage: WriteStage; input: BriefInput }
  | { kind: 'check-envelope'; id: string; envelopePath: string; permitted: PathSet }
  | { kind: 'snapshot'; id: string; since: TreeFingerprint | null }
  | { kind: 'restore'; id: string; paths: string[]; to: TreeFingerprint }
  | { kind: 'handoff'; id: string; terminal: boolean };

/** Exactly one terminal result type per effect kind; `EFFECT_FAILED` is terminal for all. */
export type TerminalResultMap = { readonly [K in EffectKind]: ResultEventType };

// SECTION: Journal and frames

export interface JournalLine {
  seq: number;
  v: 1;
  at: string;
  type: EventType;
  data: Readonly<Record<string, unknown>>;
}

export type FrameData = Readonly<Record<string, unknown>>;

export interface Frame {
  v: 1;
  run: string;
  at: string;
  await: Await;
  data: FrameData;
  reply: string;
  events?: readonly HostEvent[];
  error?: string;
  progress?: FrameData;
}

// SECTION: Machines

export interface Transition { from: string; on: string; to: string }

export interface StepResult<S> { state: S; effects: readonly Effect[] }

export interface Machine<S> {
  initial(): S;
  step(state: S, event: Event): StepResult<S>;
  awaitOf(state: S): Await | null;
  /** Breadcrumb and await-specific frame data (spec §11.2). */
  project(state: S): { at: string; data: FrameData };
  transitions: readonly Transition[];
  /** Id/path context checks beyond await acceptance; returns a one-line error or null. */
  validate?(state: S, event: HostEvent): string | null;
  /** Idempotent rendering of driver-owned Markdown after each send (not an effect). */
  render?(state: S, ports: Ports, runDir: string): void;
}

export interface HandlerContext { runDir: string; attempt: number }

/** Returns zero or more non-terminal results followed by exactly one terminal result. */
export type Handler<E extends Effect = Effect> = (effect: E, ports: Ports, ctx: HandlerContext) => Promise<readonly ResultEvent[]>;

export type Handlers = { readonly [K in EffectKind]?: Handler<Extract<Effect, { kind: K }>> };

// SECTION: Ports

export interface FsPort {
  hashFile(file: string): string;
  copyFileAtomic(source: string, destination: string): void;
  listFiles(dir: string): string[];
  inspectPath(file: string): PathInfo | null;
  setMode(file: string, mode: number): void;
  writeLinkAtomic(file: string, target: string): void;
  readText(file: string): string;
  /** Byte-preserving content encoded for serializable recovery snapshots. */
  readBase64(file: string): string;
  /** Decode bytes, then temp file + fsync + rename. */
  writeBase64Atomic(file: string, base64: string): void;
  exists(file: string): boolean;
  size(file: string): number;
  mkdir(dir: string, options: { recursive: boolean }): void;
  /** open(a) + write + fsync. */
  appendDurable(file: string, text: string): void;
  /** Exclusive create (`wx`); throws with code EEXIST when present. */
  writeExclusive(file: string, text: string): void;
  /** Temp file + fsync + rename. */
  writeAtomic(file: string, text: string): void;
  /** Truncate to length and fsync. */
  truncate(file: string, length: number): void;
  remove(file: string): void;
}

// Spawn and git port shapes.
export interface SpawnPort {
  run(argv: readonly string[], options: { cwd: string }): Promise<{ exit: number; stdout: string; stderr: string }>;
}
export interface GitPort { run(args: readonly string[], cwd: string): Promise<string>; fileContent?(file: string, cwd: string): string }

export interface ClockPort {
  now(): number;
  /** Starts a repeating timer; returns its stop function. */
  every(ms: number, fn: () => void): () => void;
}

export interface EnvPort { get(name: string): string | undefined }

export interface ProcPort {
  pid: number;
  host: string;
  isAlive(pid: number): boolean;
  stderr(text: string): void;
}

export interface Ports {
  fs: FsPort;
  spawn: SpawnPort;
  git: GitPort;
  clock: ClockPort;
  env: EnvPort;
  proc: ProcPort;
}
