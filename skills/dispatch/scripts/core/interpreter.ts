// Interpreter: fold the journal through a machine, apply one host event, run pending effects (spec §4.4).
// Generic journal loop plus the design-designated root-machine wiring choke point.

import { validateReferences } from '../effects/checkpoint-references.ts';
import { migrateReviewReferences } from '../effects/review-manifest.ts';
import path from 'node:path';
import crypto from 'node:crypto';
import { governedDesignText } from '../domain/design.ts';
import { governedPlanText } from '../domain/plan.ts';
import type { ParsedPlan, PlanTask } from '../domain/types.ts';
import { attemptOf, restoreSessionPaths, runPaths, storeSessionPaths } from '../lib/session.ts';
import { rootMachine, type RootState } from '../machines/root.ts';
import { taskCriteria, taskEnvelopeCheckInputs, taskRecordForEnvelope, type TaskRecord } from '../machines/implement-tasks.ts';
import { isWriterEnvelope, taskSubmissionValidation } from '../machines/implement-types.ts';
import { ruleFindingRow } from '../machines/review.ts';
import { dryRunGuidance, faultFrame, oneLine, projectFrame, recoveryFrame } from './frame.ts';
import { appendEvent, EngineFault, JOURNAL_FILE, LayoutUnsupported, journalPath, readJournal, type JournalRead } from './journal.ts';
import { acquireLock, LockHeld, releaseLock } from './lock.ts';
import { HEARTBEAT_MS, milestone, writeProgress } from './progress.ts';
import { JOURNAL_PROTOCOL_REVISION } from './types.ts';
import type {
  Effect, Event, ExitCode, Frame, Handler, Handlers, HostEvent, JournalLine, Machine, Ports, ResultEvent,
  ResultEventType, RunStartedEvent, TerminalResultMap, ExecutionConfigUpdated, DiagnosticNote, DryRunVerdict,
} from './types.ts';
import { HOST_EVENT_SHAPES, validateHostEvent, validateExecutionUpdate, validateRecoveryDisposition } from './validate.ts';
import { probeEffect, descriptorHash, assertRecoveredResults, publishEffectResult } from './effect-recovery.ts';
import type { EffectRecoveryDisposition, SpecApproval } from './types.ts';
import { pathIdentity } from '../domain/path-identity.ts';
import { applyExecutionConfig, executionDelta } from '../domain/execution-config.ts';
import { validateConfig } from '../lib/config.ts';
import { diagnosticPhases } from '../machines/diagnostics.ts';
import { DIAGNOSTIC_LIMITS, rejectionReason } from '../domain/diagnostics.ts';
import { diagnosticFrame, diagnosticWarning, renderSessionDiagnostics, USER_DECIDE_KINDS, type BuildIdentity, type DiagnosticReport, type FoldRun, type TimelineStep } from './diagnostics.ts';
import { loadCheckpoint, publishCheckpoint, sha256 } from './checkpoint.ts';
import { runtimeIdentity } from '../lib/runtime-identity.ts';

export const validateExecutionReferences = validateReferences;
export const migrateExecutionReferences = migrateReviewReferences;
/** Production wiring supplies runtime I/O; injected machines retain their own codec identity. */
export const dispatchMachine: Machine<RootState> = { ...rootMachine, codec: { ...rootMachine.codec!, runtime: runtimeIdentity } };
export { executionTopology } from '../domain/execution-config.ts';
export const designRevision = (source: string): string => `sha256:${crypto.createHash('sha256').update(governedDesignText(source)).digest('hex')}`;
/** Read-only receipt preview shares the emitted checker and the writer's captured baseline. */
export async function previewReceipt(state: RootState, event: HostEvent, handlers: Handlers, ports: Ports, runDir: string): Promise<string | null> {
  if (event.type !== 'WRITE_RECEIPT' || event.status !== 'submitted' || state.tag !== 'implement') return null;
  const child = state.child;
  let effect: Extract<Effect, { kind: 'check-envelope' }> & { since?: Readonly<Record<string, unknown>> };
  let taskContext: { plan: ParsedPlan; task: PlanTask; record: TaskRecord } | null = null;
  if (child.tag === 'tasks') {
    const record = event.task ? child.c.tasks[event.task] : undefined;
    const task = child.c.plan!.tasks.find((item) => item.id === event.task);
    if (!record?.worktree || !task || !record.baseline || event.task === undefined || event.attempt !== record.attempt || event.signature !== record.signature || event.handle !== record.handle) return 'Receipt names no active task attempt';
    const selected = taskRecordForEnvelope(record, event.envelopePath);
    effect = { kind: 'check-envelope', id: 'preview.check-envelope.1', envelopePath: event.envelopePath, ...taskEnvelopeCheckInputs(child.c.plan!, task, selected, event.envelopePath) };
    taskContext = { plan: child.c.plan!, task, record: selected };
  } else if (child.tag === 'hotfix-write') {
    effect = { kind: 'check-envelope', id: 'preview.check-envelope.1', envelopePath: event.envelopePath, permitted: [...new Set([...child.c.plan!.changes.map((change) => change.path)])], since: child.before };
  } else return null;
  const checker = handlers['check-envelope']; if (!checker) return 'Receipt checker is unavailable';
  const results = await checker(effect, ports, { runDir, attempt: 1 });
  const result = results[0];
  if (result?.type === 'EFFECT_FAILED') return result.detail;
  if (result?.type !== 'ENVELOPE_CHECKED') return 'Receipt checker returned no result';
  if (result.defects.length) return result.defects.map((defect) => typeof defect === 'string' ? defect : JSON.stringify(defect)).join('; ');
  if (!taskContext) return null;
  const envelope = result.envelope;
  if (!isWriterEnvelope(envelope)) return 'Envelope rejected: malformed envelope.';
  const permitted = new Set(effect.permitted);
  const paths = result.diff['paths'];
  if (Array.isArray(paths) && paths.some((file) => typeof file === 'string' && !permitted.has(file))) return null;
  if (envelope.stage !== 'COMPLETE') return `Envelope stage must be COMPLETE; got ${envelope.stage}.`;
  if (envelope.status === 'NEEDS_CONTEXT' || envelope.status === 'BLOCKED') return null;
  const issued = taskContext.record.briefs?.find((row) => row.envelopePath === taskContext.record.brief?.envelopePath)?.contractChecks;
  return taskSubmissionValidation(envelope.evidence, taskContext.plan, taskCriteria(taskContext.plan, taskContext.task), issued).rejection;
}

/** Guards a reducer bug from looping forever; exceeding it is an engine fault. */
export const MAX_STEPS = 200;

export const TERMINAL_RESULT: TerminalResultMap = {
  'check-review-target': 'REVIEW_TARGET_CHECKED',
  'parse-artifact': 'ARTIFACT_PARSED',
  'prepare-review': 'REVIEW_PREPARED',
  wave: 'WAVE_DONE',
  'wave-start': 'WAVE_STARTED',
  'wave-finish': 'WAVE_DONE',
  verify: 'VERIFY_DONE',
  'write-brief': 'BRIEF_READY',
  'check-envelope': 'ENVELOPE_CHECKED',
  snapshot: 'SNAPSHOT',
  'assess-recovery': 'RECOVERY_ASSESSED',
  restore: 'RESTORED',
  handoff: 'HANDOFF_DONE',
  checkout: 'CHECKOUT_DONE',
};

const RESULT_TYPES: ReadonlySet<string> = new Set<ResultEventType>([...Object.values(TERMINAL_RESULT), 'WAVE_PROGRESS', 'EFFECT_FAILED']);

function isResultEvent(event: Event): event is ResultEvent {
  return RESULT_TYPES.has(event.type);
}

// SECTION: Fold

export interface Folder<S> {
  state: S;
  /** FIFO of effects emitted by steps and not yet terminated; the head runs next. */
  readonly queue: Effect[];
  /** Latest attempt per started effect id. */
  readonly attempts: Map<string, number>;
  /** Started effect ids without a terminal result. */
  readonly open: Set<string>;
  apply(event: Event): void;
}

export function createFolder<S>(machine: Machine<S>, runDir?: string): Folder<S> {
  const folder: Folder<S> = {
    state: machine.initial(),
    queue: [],
    attempts: new Map(),
    open: new Set(),
    apply(event) {
      if (event.type === 'RUNTIME_REBOUND' || event.type === 'LOCK_BROKEN') return;
      if (event.type === 'EFFECT_RECOVERY') {
        const effect = folder.queue.find((item) => item.id === event.effectId);
        if (!effect || !folder.open.has(event.effectId) || validateRecoveryDisposition(event, effect.id, folder.attempts.get(effect.id)!, descriptorHash(effect, runDir))) throw new EngineFault('effect-recovery: stale effect identity');
        if (event.action === 'retry') folder.open.delete(effect.id);
        return;
      }
      if (event.type === 'EXECUTION_CONFIG_UPDATED') {
        if (!machine.reconfigure) throw new EngineFault('execution-config-unavailable: machine cannot refresh configuration');
        folder.state = machine.reconfigure(folder.state, event);
        return;
      }
      if (event.type === 'EFFECT_STARTED') {
        if (!folder.queue.some((effect) => effect.id === event.effectId)) throw new EngineFault(`EFFECT_STARTED for unknown effect ${event.effectId}`);
        folder.attempts.set(event.effectId, event.attempt);
        folder.open.add(event.effectId);
        return;
      }
      if (isResultEvent(event)) {
        if (!folder.open.has(event.effectId)) throw new EngineFault(`${event.type} for effect ${event.effectId} that is not running`);
        const index = folder.queue.findIndex((effect) => effect.id === event.effectId);
        const effect = folder.queue[index];
        if (effect && (event.type === 'EFFECT_FAILED' || event.type === TERMINAL_RESULT[effect.kind])) {
          folder.open.delete(event.effectId);
          folder.queue.splice(index, 1);
          folder.attempts.delete(event.effectId);
        }
      }
      const result = machine.step(folder.state, event);
      folder.state = result.state;
      folder.queue.push(...result.effects);
    },
  };
  return folder;
}

export function toEvent(line: JournalLine, protocolRevision: number = JOURNAL_PROTOCOL_REVISION): Event {
  if (protocolRevision !== JOURNAL_PROTOCOL_REVISION) throw new EngineFault(`unsupported-journal-protocol: expected revision ${JOURNAL_PROTOCOL_REVISION}; start a new run`);
  const event = { ...line.data, type: line.type } as Event;
  if (event.type === 'EXECUTION_CONFIG_UPDATED') {
    const error = validateExecutionUpdate(event);
    if (error || event.boundarySeq !== line.seq) throw new EngineFault(error ?? 'execution-config-invalid: boundary sequence mismatch');
  }
  return event;
}

/** Folds journal lines; `inFlight` is the head effect when it started without a terminal result. */
export function fold<S>(machine: Machine<S>, lines: Iterable<JournalLine>, sessionRoot?: string, observe?: (state: S, line: JournalLine) => void): Folder<S> & { inFlight: { effect: Effect; attempt: number } | null } {
  const protocolRevision = JOURNAL_PROTOCOL_REVISION;
  const folder = createFolder(machine, sessionRoot ? path.join(sessionRoot, '.state/runs/fold') : undefined);
  let revision = 0;
  let config: Record<string, unknown> | undefined;
  let first = true;
  for (const line of lines) {
    if (first && line.type !== 'RUN_STARTED') throw new EngineFault('journal must start with RUN_STARTED');
    first = false;
    // Diagnostics notes never reach the machine, so replay is identical with or without them.
    if (line.type === 'DIAGNOSTIC_NOTE') continue;
    if (line.type === 'RUN_STARTED') {
      if (typeof line.data['protocolRevision'] === 'number' && line.data['protocolRevision'] < JOURNAL_PROTOCOL_REVISION) throw new LayoutUnsupported();
      if (line.data['protocolRevision'] !== JOURNAL_PROTOCOL_REVISION) throw new EngineFault(`unsupported-journal-protocol: expected revision ${JOURNAL_PROTOCOL_REVISION}; start a new run`);
      config = line.data['config'] as Record<string, unknown>;
    }
    const event = toEvent(sessionRoot ? restoreJournalPaths(line, sessionRoot) : line, protocolRevision);
    if (event.type === 'EXECUTION_CONFIG_UPDATED') {
      if (event.revision !== ++revision || !config) throw new EngineFault('execution-config-invalid: revision sequence mismatch');
      config = applyExecutionConfig(config, event.delta);
      const errors = validateConfig(config);
      if (errors.length) throw new EngineFault(`execution-config-invalid: ${errors.join('; ')}`);
    }
    folder.apply(event);
    observe?.(folder.state, line);
  }
  const head = folder.queue[0];
  const inFlight = head && folder.open.has(head.id) ? { effect: head, attempt: folder.attempts.get(head.id) ?? 1 } : null;
  return Object.assign(folder, { inFlight });
}

// Pure machines construct portable paths; live events and restored journals must use that same form.
function restoreJournalPaths<T>(value: T, root: string): T {
  if (typeof value === 'string') return (value.includes('@session') ? restoreSessionPaths(value, root).replaceAll('\\', '/') : value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => restoreJournalPaths(item, root)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restoreJournalPaths(item, root)])) as T;
  return value;
}

// SECTION: Send

export interface SendOptions<S> {
  runDir: string;
  machine: Machine<S>;
  handlers: Handlers;
  ports: Ports;
  /** Parsed JSON or raw JSON text of one host event. */
  rawEvent?: unknown;
  dryRun?: boolean;
  /** Run dir relative to the repository root, for the frame. */
  runRel?: string;
  preview?: (state: S, event: HostEvent) => Promise<string | null>;
  refreshConfig?: boolean;
  configSource?: () => Readonly<Record<string, unknown>>;
  /** Live diagnostics toggle, read once per mutating send; a throw falls back to the run's start config. */
  diagnosticToggle?: () => boolean;
  /** The retro instruction, attached only to frames that await `retro`. */
  diagnosticRetroInstruction?: () => string;
  diagnosticBuild?: () => BuildIdentity;
}

export interface SendResult {
  /** Null when the lock is held (exit 3; `message` names the holder) or when `verdict` answers an event dry-run. */
  frame: Frame | null;
  exitCode: ExitCode;
  message?: string;
  /** Event dry-run only: whether the event would be accepted, with the one-line refusal. */
  verdict?: DryRunVerdict;
}

/** Frames list suggested events as an array, so a one-element array sent verbatim unwraps; any other array is a usage error. */
function parseRaw(raw: unknown): { ok: true; value: unknown } | { ok: false; error: string; usage?: true } {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw) as unknown; } catch { return { ok: false, error: 'event: expected JSON object, got malformed JSON' }; }
  }
  if (!Array.isArray(value)) return { ok: true, value };
  return value.length === 1 ? { ok: true, value: value[0] } : { ok: false, error: `event: expected one object, got array of ${value.length}`, usage: true };
}

/** A usage-class event error exits 1 before the lock, so it records no rejection note. */
function eventUsageError(raw: unknown): string | null {
  if (raw === undefined) return null;
  const parsed = parseRaw(raw);
  return !parsed.ok && parsed.usage ? parsed.error : null;
}

function hostEventError<S>(machine: Machine<S>, folder: Folder<S>, raw: unknown, sessionRoot?: string): { event: HostEvent } | { error: string } {
  const head = folder.queue[0];
  if (head) return { error: `event: effect ${head.id} is pending; send without --event to resume it` };
  const parsed = parseRaw(raw);
  if (!parsed.ok) return { error: parsed.error };
  const state = folder.state;
  const check = machine.validate ? (event: HostEvent) => machine.validate?.(state, event) ?? null : undefined;
  const value = sessionRoot ? restoreJournalPaths(storeSessionPaths(parsed.value, sessionRoot), sessionRoot) : parsed.value;
  const result = validateHostEvent(machine.awaitOf(state) ?? 'done', value, check);
  return result.ok ? { event: result.value } : { error: oneLine(result.error) };
}

/** The host's declared event type for a rejection note when it is an event-type token; free text or an untyped reply records `UNKNOWN`. */
function eventTypeOf(raw: unknown): string {
  const parsed = parseRaw(raw);
  const type = parsed.ok && parsed.value && typeof parsed.value === 'object' ? (parsed.value as Record<string, unknown>)['type'] : undefined;
  return typeof type === 'string' && /^[A-Z][A-Z0-9_]{0,47}$/.test(type) ? type : 'UNKNOWN';
}

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// SECTION: Diagnostics wiring

/** Recent lines kept for the reply boundary and execution status. */
const RECENT_LINES = 48;
const HOST_TYPES: ReadonlySet<string> = new Set(Object.keys(HOST_EVENT_SHAPES));
type NoteData = { [K in DiagnosticNote['kind']]: Omit<Extract<DiagnosticNote, { kind: K }>, 'type'> }[DiagnosticNote['kind']];

/** The live toggle when readable; the run's start config otherwise, so a broken settings read never flips a run. */
function diagnosticsEnabled(toggle: (() => boolean) | undefined, started: JournalLine | undefined, warn: () => void): boolean {
  const config = started?.data['config'];
  const fallback = !!config && typeof config === 'object' && (config as Record<string, unknown>)['diagnostics'] === true;
  if (!toggle) return fallback;
  try { return toggle() === true; } catch { warn(); return fallback; }
}

/** The error class as a token (`EngineFault` -> `engine-fault`); the message never reaches diagnostics. */
function faultClass(error: unknown): string {
  const name = error instanceof Error ? error.name : 'unknown';
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'unknown';
}

/** Adds frame diagnostics; the retro instruction loads only for a `retro` frame, and oversize text warns and is dropped. */
function withDiagnostics<S>(options: SendOptions<S>, frame: Frame, enabled: boolean, report: DiagnosticReport | null, warn: () => void): Frame {
  let instruction = '';
  if (frame.await === 'retro' && options.diagnosticRetroInstruction) {
    try { instruction = options.diagnosticRetroInstruction(); } catch { warn(); }
    if (Buffer.byteLength(instruction) > DIAGNOSTIC_LIMITS.instructionBytes) { instruction = ''; warn(); }
  }
  return diagnosticFrame(frame, enabled, report, instruction);
}

/** The collector's fold adapter; phases come from the root machine only, so other machines report none. */
export function timelineFold<S>(machine: Machine<S>, sessionRoot: string | undefined, ports?: Ports, runDir?: string): FoldRun {
  const root = machine === rootMachine as unknown as Machine<S> || machine.codec?.name === 'dispatch-root';
  const bytes = (state: S): number => Buffer.byteLength(JSON.stringify(machine.project(state)));
  return (lines, metadata, currentRunDir) => {
    if (ports && runDir) {
      // Consume the collector's tap so event facts and saved phase attribution share one journal scan.
      const target = currentRunDir ?? runDir;
      const read = metadata ?? readJournal(ports, target, true);
      const loaded = loadExecution(machine, ports, target, read, runSession(target), false, lines);
      const awaiting = machine.awaitOf(loaded.folder.state);
      return { steps: loaded.timeline.steps, orchestratorBytes: loaded.timeline.orchestratorBytes + (awaiting !== null && loaded.folder.queue.length === 0 ? bytes(loaded.folder.state) : 0) };
    }
    const steps: TimelineStep[] = [];
    let orchestratorBytes = 0, signature = '';
    let prior = undefined as { state: S } | undefined;
    const folder = fold(machine, lines, sessionRoot, (state, line) => {
      // The host replied to the frame projected from the prior state.
      if (prior && HOST_TYPES.has(line.type)) orchestratorBytes += bytes(prior.state);
      prior = { state };
      const data = machine.project(state).data, awaiting = machine.awaitOf(state);
      // A user-backed decide marks the wait as a person's even when a failed send rolls back the reply.
      const user = awaiting === 'decide' && USER_DECIDE_KINDS.has(String(data['kind']));
      const step: TimelineStep = { seq: line.seq, phases: root ? diagnosticPhases(state as RootState) : [], awaiting, user, ...(awaiting === 'done' ? { outcome: String(data['outcome'] ?? 'partial') } : {}) };
      const next = JSON.stringify([step.phases, step.awaiting, step.user, step.outcome]);
      if (next !== signature) { steps.push(step); signature = next; }
    });
    if (prior && machine.awaitOf(prior.state) !== null && folder.queue.length === 0) orchestratorBytes += bytes(prior.state);
    return { steps, orchestratorBytes };
  };
}

function observeTimeline<S>(machine: Machine<S>, folder: Folder<S>, line: JournalLine, timeline: { steps: TimelineStep[]; orchestratorBytes: number }, prior?: S): void {
  if (line.type === 'DIAGNOSTIC_NOTE') return;
  if (prior !== undefined && HOST_TYPES.has(line.type)) timeline.orchestratorBytes += Buffer.byteLength(JSON.stringify(machine.project(prior)));
  const data = machine.project(folder.state).data, awaiting = machine.awaitOf(folder.state);
  const step: TimelineStep = { seq: line.seq, phases: machine.codec?.name === 'dispatch-root' ? diagnosticPhases(folder.state as RootState) : [], awaiting, user: awaiting === 'decide' && USER_DECIDE_KINDS.has(String(data['kind'])), ...(awaiting === 'done' ? { outcome: String(data['outcome'] ?? 'partial') } : {}) };
  const signature = ({ seq: _seq, ...value }: TimelineStep) => JSON.stringify(value);
  if (!timeline.steps.length || signature(timeline.steps.at(-1)!) !== signature(step)) timeline.steps.push(step);
}

/** All execution and discovery entrypoints restore the same committed private prefix. */
export function loadExecution<S>(machine: Machine<S>, ports: Ports, runDir: string, read = readJournal(ports, runDir, true), sessionRoot = runSession(runDir), mutation = false, source = read.records, migrateReview = false): { folder: Folder<S>; timeline: { steps: TimelineStep[]; orchestratorBytes: number }; read: JournalRead } {
  const tail: JournalLine[] = [];
  // Metadata must be filled even when a collector supplies its own one-pass tap.
  let last: JournalLine | undefined;
  for (const line of source) {
    if (!last && line.type !== 'RUN_STARTED') throw new EngineFault('journal must start with RUN_STARTED');
    if (line.type === 'RUN_STARTED' && line.data['protocolRevision'] !== JOURNAL_PROTOCOL_REVISION) {
      if (Number(line.data['protocolRevision'] ?? 0) < JOURNAL_PROTOCOL_REVISION) throw new LayoutUnsupported();
      throw new EngineFault('unsupported-journal-protocol');
    }
    if (line.checkpoint) tail.length = 0;
    else tail.push(line);
    last = line;
  }
  const saved = loadCheckpoint(ports, runDir, machine, read, sessionRoot, mutation, migrateReview);
  const folder = createFolder(machine, runDir);
  const timeline = { steps: saved ? [...saved.checkpoint.timeline.steps] : [], orchestratorBytes: saved?.checkpoint.timeline.orchestratorBytes ?? 0 };
  if (saved) {
    folder.state = saved.state;
    folder.queue.push(...saved.queue);
    for (const [id, attempt] of saved.attempts) folder.attempts.set(id, attempt);
    for (const id of saved.open) folder.open.add(id);
  }
  let revision = saved?.checkpoint.execution?.revision ?? 0;
  let config = saved?.checkpoint.execution?.config;
  for (const line of tail) {
    if (line.type === 'DIAGNOSTIC_NOTE') continue;
    const prior = folder.state;
    const event = toEvent(sessionRoot ? restoreJournalPaths(line, sessionRoot) : line);
    if (event.type === 'RUN_STARTED') config = event.config as Record<string, unknown>;
    if (event.type === 'EXECUTION_CONFIG_UPDATED') {
      if (event.revision !== ++revision || !config) throw new EngineFault('execution-config-invalid: revision sequence mismatch');
      config = applyExecutionConfig(config, event.delta);
      const errors = validateConfig(config);
      if (errors.length) throw new EngineFault(`execution-config-invalid: ${errors.join('; ')}`);
    }
    folder.apply(event);
    if (!['LOCK_BROKEN', 'RUNTIME_REBOUND'].includes(line.type)) {
      validateExecutionReferences(folder.state, ports, runDir);
      validateExecutionReferences(folder.queue, ports, runDir);
    }
    observeTimeline(machine, folder, line, timeline, prior);
  }
  return { folder, timeline, read };
}

export async function send<S>(options: SendOptions<S>): Promise<SendResult> {
  const { runDir, machine, handlers, ports } = options;
  const runRel = options.runRel ?? runDir.replace(/\\/g, '/');
  if (options.refreshConfig && options.rawEvent !== undefined) return { frame: null, exitCode: 1, message: '--refresh-config cannot be combined with --event' };
  const usage = eventUsageError(options.rawEvent);
  if (usage) return { frame: null, exitCode: 1, message: usage };
  if (options.dryRun) return dryRun(options, runRel);

  const file = journalPath(runDir);
  const sendStartedAt = ports.clock.now();
  const sessionRoot = runSession(runDir);
  const warn = diagnosticWarning(ports);
  let locked = false;
  let baseline: { existed: boolean; bytes: number; count: number } | null = null;
  let enabled = false;
  let currentEffect: string | undefined;
  let sendBoundarySeq: number | undefined;
  const render = (): DiagnosticReport | null => {
    let build: BuildIdentity = {};
    try { build = options.diagnosticBuild?.() ?? {}; } catch { warn(); }
    return renderSessionDiagnostics(ports, runDir, build, timelineFold(machine, sessionRoot, ports, runDir), warn);
  };
  try {
    let broken: number | null;
    try {
      broken = acquireLock(ports, runDir).broken;
    } catch (error) {
      if (error instanceof LockHeld) return { frame: null, exitCode: 3, message: error.message };
      throw error;
    }
    locked = true;
    const read: JournalRead = readJournal(ports, runDir, true);
    const { folder, timeline } = loadExecution(machine, ports, runDir, read, sessionRoot, true);
    if (read.tornTail) ports.fs.truncate(file, read.goodBytes);
    baseline = { existed: ports.fs.exists(file), bytes: read.goodBytes, count: read.count };
    sendBoundarySeq = read.count;
    enabled = diagnosticsEnabled(options.diagnosticToggle, read.started, warn);
    const wasDone = machine.awaitOf(folder.state) === 'done';
    let recentLines: JournalLine[] = read.recent;
    let seq = read.count + 1;
    let prefixHash = read.prefixHash ?? sha256('');
    const prefixDigest = read.prefixHasher ?? crypto.createHash('sha256');
    const record = (event: Event): void => {
      const { type, ...data } = event;
      const stored = sessionRoot ? storeSessionPaths(data, sessionRoot) : data;
      const line: JournalLine = { seq, v: 1, at: new Date(ports.clock.now()).toISOString(), type, data: stored };
      const prior = folder.state;
      folder.apply(sessionRoot ? restoreJournalPaths({ ...stored, type } as Event, sessionRoot) : event);
      observeTimeline(machine, folder, line, timeline, prior);
      if (event.type === 'EXECUTION_CONFIG_UPDATED' && read.execution) read.execution = { config: applyExecutionConfig(read.execution.config, event.delta), revision: event.revision };
      const checkpoint = publishCheckpoint(ports, runDir, machine, folder, line, prefixHash, read, timeline, sessionRoot);
      if (checkpoint) line.checkpoint = checkpoint;
      const text = `${JSON.stringify(line)}\n`;
      try { ports.fs.appendDurable(file, text); }
      catch (error) {
        // A post-append fault cannot revoke a complete reference that is already visible on disk.
        if (checkpoint) {
          const committed = readJournal(ports, runDir);
          if (committed.checkpoint?.line.seq === line.seq && committed.checkpoint.line.checkpoint?.sha256 === checkpoint.sha256) baseline = { existed: true, bytes: committed.goodBytes, count: committed.count };
        }
        throw error;
      }
      seq++;
      baseline = { existed: true, bytes: (baseline?.bytes ?? 0) + Buffer.byteLength(text), count: line.seq };
      // Prefix hashing is incremental during a send; journal scanning verifies the raw committed bytes.
      prefixDigest.update(text);
      prefixHash = prefixDigest.copy().digest('hex');
      const boundary = event.type === 'LOCK_BROKEN' ? recentLines.filter((prior) => prior.type !== 'LOCK_BROKEN').at(-1) : undefined;
      recentLines = [...recentLines.filter((prior) => prior.type === 'RUN_STARTED' || prior.type === 'EXECUTION_CONFIG_UPDATED' || prior === boundary), line].slice(-RECENT_LINES);
      machine.render?.(folder.state, ports, runDir);
    };
    // A note skips apply and render and never joins recentLines, so the reply boundary stays on the prior operational line.
    const recordNote = (note: NoteData): void => {
      try { const line = appendEvent(ports, runDir, 'DIAGNOSTIC_NOTE', note, seq); seq++; baseline = { existed: true, bytes: ports.fs.size(file), count: line.seq }; prefixDigest.update(`${JSON.stringify(line)}\n`); prefixHash = prefixDigest.copy().digest('hex'); } catch { warn(); }
    };

    let refreshStatus: Record<string, unknown> | undefined;
    if (options.refreshConfig) {
      const refresh = prepareRefresh(options, folder, read);
      if ('error' in refresh) return { frame: withDiagnostics(options, boundaryFrame(ports, runDir, projectFrame(machine, folder.state, runRel, refresh.error, hostBoundary(recentLines))), enabled, null, warn), exitCode: 0 };
      refreshStatus = refresh.status;
      if (refresh.event) record(refresh.event);
    }
    if (broken !== null) record({ type: 'LOCK_BROKEN', stalePid: broken });
    let recoveryReply = false;
    if (options.rawEvent !== undefined && folder.queue[0] && folder.open.has(folder.queue[0].id)) {
      const effect = folder.queue[0], parsed = parseRaw(options.rawEvent);
      const value = parsed.ok ? parsed.value : null;
      const error = validateRecoveryDisposition(value, effect.id, folder.attempts.get(effect.id)!, descriptorHash(effect, runDir));
      if (error) return { frame: { ...recoveryFrame(machine, folder.state, runRel, effect, folder.attempts.get(effect.id)!, error, runDir), error }, exitCode: 0 };
      const event = value as EffectRecoveryDisposition;
      record(event); recoveryReply = true;
      if (event.action === 'stop') record({ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'crash', detail: `Recovery stopped: ${event.rationale}` });
    }
    if (options.rawEvent !== undefined && !recoveryReply) {
      const checked = hostEventError(machine, folder, options.rawEvent, sessionRoot);
      if ('error' in checked) {
        // Validator text echoes submitted values and keys; the note keeps only the reduced class and allowlisted path.
        recordNote({ kind: 'event-rejected', eventType: eventTypeOf(options.rawEvent), reason: rejectionReason(checked.error) });
        return { frame: withDiagnostics(options, boundaryFrame(ports, runDir, projectFrame(machine, folder.state, runRel, checked.error, hostBoundary(recentLines))), enabled, null, warn), exitCode: 0 };
      }
      record(checked.event);
    }

    for (let steps = 1; folder.queue.length > 0; steps++) {
      if (steps > MAX_STEPS) throw new EngineFault(`MAX_STEPS (${MAX_STEPS}) exceeded in one send; a machine keeps emitting effects`);
      const effect = folder.queue[0] as Effect;
      if (folder.open.has(effect.id)) {
        const priorAttempt = folder.attempts.get(effect.id)!;
        const proof = await probeEffect(effect, priorAttempt, handlers, ports, runDir);
        if (proof.status === 'unresolved') return { frame: recoveryFrame(machine, folder.state, runRel, effect, priorAttempt, proof.evidence, runDir), exitCode: 0 };
        if (proof.status === 'complete' || proof.status === 'live') {
          currentEffect = effect.id;
          const results = proof.status === 'complete' ? proof.results : await proof.resume();
          assertRecoveredResults(effect, results, TERMINAL_RESULT[effect.kind]);
          // Only terminal output is missing; earlier progress lines remain accepted.
          record(results.at(-1)!); currentEffect = undefined;
          continue;
        }
        record({ type: 'EFFECT_RECOVERY', effectId: effect.id, attempt: priorAttempt, descriptorHash: descriptorHash(effect, runDir), action: 'retry', rationale: 'Handler declares a deterministic read-only repeat' });
      }
      const attempt = (folder.attempts.get(effect.id) ?? 0) + 1;
      currentEffect = effect.id;
      record({ type: 'EFFECT_STARTED', effectId: effect.id, kind: effect.kind, attempt });
      const results = await runEffect(effect, attempt, handlers, ports, runDir, () => enabled, machine.ownedArtifacts?.(folder.state, runDir));
      for (const result of results) record(result);
      currentEffect = undefined;
    }
    if (machine.awaitOf(folder.state) === null) throw new EngineFault('machine neither awaits nor emits effects');
    machine.render?.(folder.state, ports, runDir);
    const done = machine.awaitOf(folder.state) === 'done';
    // Rendered under this run's lock before release; a concurrent run's later render replaces it (last writer wins).
    const report = done && !wasDone && enabled ? render() : null;
    if (done) pruneWorkerFiles(ports, runDir);
    const status = refreshStatus?.['status'] === 'unchanged' ? refreshStatus : executionStatus(recentLines, machine.awaitOf(folder.state), machine.executionDeferred?.(folder.state));
    const frame = withDiagnostics(options, executionFrame(boundaryFrame(ports, runDir, projectFrame(machine, folder.state, runRel, undefined, hostBoundary(recentLines))), status), enabled, report, warn);
    releaseLock(ports, runDir); locked = false;
    return { frame, exitCode: 0 };
  } catch (error) {
    if (error instanceof LayoutUnsupported) return { frame: null, exitCode: 1, message: `layout-unsupported: ${runRel}` };
    let report: DiagnosticReport | null = null;
    if (baseline) {
      restoreJournal(ports, file, baseline);
      // Retain every durable transition; remove only an uncommitted or torn suffix.
      if (locked && baseline.existed) {
        const note: NoteData = { kind: 'fault', ...(currentEffect ? { effectId: currentEffect } : {}), cls: faultClass(error), sendStartedAt, failedAt: ports.clock.now(), ...(sendBoundarySeq !== undefined ? { boundarySeq: sendBoundarySeq } : {}) };
        try { appendEvent(ports, runDir, 'DIAGNOSTIC_NOTE', note, baseline.count + 1); } catch { warn(); }
        if (enabled) report = render();
      }
    }
    if (locked) { releaseLock(ports, runDir); locked = false; }
    return { frame: withDiagnostics(options, faultFrame(runRel, message(error)), enabled, report, warn), exitCode: 2 };
  } finally {
    if (locked) releaseLock(ports, runDir);
  }
}

/** Event files are named by the last host-visible journal seq; lock recovery and diagnostics notes are skipped, so neither moves the reply path. */
function hostBoundary(lines: Iterable<JournalLine>): number {
  let seq = 0;
  for (const line of lines) if (line.type !== 'LOCK_BROKEN' && line.type !== 'DIAGNOSTIC_NOTE') seq = line.seq;
  return seq;
}

/** Creates `events/` before a frame names a path inside it, so hosts write the reply without a mkdir. */
function boundaryFrame(ports: Ports, runDir: string, frame: Frame): Frame {
  if (frame.await !== 'done') ports.fs.mkdir(path.join(runDir, 'events'), { recursive: true });
  return findingsFrame(ports, runDir, frame);
}

/** Full findings stay in projection and journal; only the emitted frame uses the current file. */
function findingsFrame(ports: Ports, runDir: string, frame: Frame, dryRun = false): Frame {
  const findings = frame.data['findings'];
  if (frame.await !== 'rule' || !Array.isArray(findings)) return frame;
  const file = runPaths(runDir).ruleFindings();
  if (dryRun) {
    try {
      if (JSON.stringify(JSON.parse(ports.fs.readText(file))) !== JSON.stringify(findings)) return frame;
    } catch { return frame; }
  } else {
    // NOTE: failed frame publication must not roll back completed effects.
    try { ports.fs.writeAtomic(file, `${JSON.stringify(findings, null, 2)}\n`); } catch { return frame; }
  }
  const summaries = findings.map(ruleFindingRow);
  return { ...frame, data: { ...frame.data, findings: summaries, findingsPath: runPaths(frame.run).ruleFindings().replace(/\\/g, '/') } };
}

/** Worker recovery files only serve resume, so a done run drops them; best-effort, as a failed unlink must not change the outcome. */
function pruneWorkerFiles(ports: Ports, runDir: string): void {
  let files: string[];
  try { files = ports.fs.listFiles(runDir); } catch (error) { milestone(ports, `warning: worker files not pruned: ${message(error)}`); return; }
  for (const file of files) {
    const [effect, name, ...rest] = file.split('/');
    if (!effect || !name || rest.length || effect === 'events') continue;
    if (name !== 'launch.json' && !['claim', 'heartbeat', 'done'].some((stem) => attemptOf(stem, name) !== null)) continue;
    try { ports.fs.remove(path.join(runPaths(runDir).effectDir(effect), name)); } catch (error) { milestone(ports, `warning: could not remove ${file}: ${message(error)}`); }
  }
}

/** Remove only bytes beyond the last durable transition. */
function restoreJournal(ports: Ports, file: string, baseline: { existed: boolean; bytes: number }): void {
  if (!ports.fs.exists(file)) return;
  if (!baseline.existed) ports.fs.remove(file);
  else if (ports.fs.size(file) !== baseline.bytes) ports.fs.truncate(file, baseline.bytes);
}

async function runEffect(effect: Effect, attempt: number, handlers: Handlers, ports: Ports, runDir: string, diagnosticToggle?: () => boolean, ownedArtifacts?: readonly string[]): Promise<readonly ResultEvent[]> {
  const handler = handlers[effect.kind] as Handler | undefined;
  if (!handler) throw new EngineFault(`no handler for effect kind ${effect.kind}`);
  const startedAt = new Date(ports.clock.now()).toISOString();
  const snapshot = () => ({ at: new Date(ports.clock.now()).toISOString(), effect: { id: effect.id, kind: effect.kind, startedAt } });
  writeProgress(ports, runDir, snapshot());
  milestone(ports, `${effect.id} started (attempt ${attempt})`);
  const stop = ports.clock.every(HEARTBEAT_MS, () => writeProgress(ports, runDir, snapshot()));
  let results: readonly ResultEvent[];
  try {
    results = await handler(effect, ports, { runDir, attempt, ...(diagnosticToggle ? { diagnosticToggle } : {}), ...(ownedArtifacts ? { ownedArtifacts } : {}) });
  } finally {
    stop();
  }
  const terminal = TERMINAL_RESULT[effect.kind];
  const last = results[results.length - 1];
  const terminals = results.filter((result) => result.type === terminal || result.type === 'EFFECT_FAILED').length;
  if (!last || terminals !== 1 || (last.type !== terminal && last.type !== 'EFFECT_FAILED')) {
    throw new EngineFault(`handler for ${effect.id} must end with exactly one terminal result (${terminal} or EFFECT_FAILED)`);
  }
  const stray = results.find((result) => result.effectId !== effect.id);
  if (stray) throw new EngineFault(`handler for ${effect.id} returned ${stray.type} for ${stray.effectId}`);
  publishEffectResult(effect, attempt, results, ports, runDir);
  return results;
}

async function dryRun<S>(options: SendOptions<S>, runRel: string): Promise<SendResult> {
  const { machine, ports, runDir } = options;
  const warn = diagnosticWarning(ports);
  try {
    const read = readJournal(ports, runDir, true);
    const { folder } = loadExecution(machine, ports, runDir, read);
    const enabled = diagnosticsEnabled(options.diagnosticToggle, read.started, warn);
    const hint = (frame: Frame): Frame => withDiagnostics(options, findingsFrame(ports, runDir, frame, true), enabled, null, warn);
    const open = folder.queue[0];
    if (open && folder.open.has(open.id)) {
      const attempt = folder.attempts.get(open.id)!;
      if (options.rawEvent !== undefined) {
        const parsed = parseRaw(options.rawEvent);
        const error = parsed.ok ? validateRecoveryDisposition(parsed.value, open.id, attempt, descriptorHash(open, runDir)) : parsed.error;
        return { frame: null, verdict: error ? { valid: false, error } : { valid: true }, exitCode: error ? 1 : 0 };
      }
      return { frame: hint(recoveryFrame(machine, folder.state, runRel, open, attempt, 'Read-only status preserves the open attempt; send probes completion', runDir)), exitCode: 0 };
    }
    if (options.refreshConfig) {
      const refresh = prepareRefresh(options, folder, read);
      return { frame: hint('error' in refresh ? projectFrame(machine, folder.state, runRel, refresh.error, hostBoundary(read.recent)) : executionFrame(projectFrame(machine, folder.state, runRel, undefined, hostBoundary(read.recent)), refresh.status)), exitCode: 0 };
    }
    if (options.rawEvent === undefined) return { frame: hint(projectFrame(machine, folder.state, runRel, undefined, hostBoundary(read.recent))), exitCode: 0 };
    const checked = hostEventError(machine, folder, options.rawEvent, runSession(runDir));
    const error = 'error' in checked ? checked.error : await options.preview?.(folder.state, checked.event) ?? undefined;
    return error ? { frame: null, verdict: { valid: false, error, ...dryRunGuidance(machine, folder.state, runRel, hostBoundary(read.recent)) }, exitCode: 1 } : { frame: null, verdict: { valid: true }, exitCode: 0 };
  } catch (error) {
    if (error instanceof LayoutUnsupported) return { frame: null, exitCode: 1, message: `layout-unsupported: ${runRel}` };
    return { frame: faultFrame(runRel, message(error)), exitCode: 2 };
  }
}

// SECTION: Start

export interface StartOptions<S> extends Omit<SendOptions<S>, 'rawEvent' | 'dryRun'> {
  runStarted: RunStartedEvent;
  reservedRun?: boolean;
}
const runSession = (runDir: string): string | undefined => {
  const root = runDir.replace(/[\\/]\.state[\\/]runs[\\/][^\\/]+[\\/]?$/, '');
  return root === runDir ? undefined : root;
};
/** Historical discovery skips legacy-layout runs, so they cannot block new runs in the same session. */
function foldCurrent<S>(machine: Machine<S>, ports: Ports, runDir: string, read: JournalRead): Folder<S> | null {
  try { return loadExecution(machine, ports, runDir, read).folder; } catch (error) { if (error instanceof LayoutUnsupported) return null; throw error; }
}
/** User spec approvals from current-protocol runs in the session, de-duplicated by hash. */
function journalSpecApprovals(ports: Ports, runsDir: string): SpecApproval[] {
  if (!ports.fs.exists(runsDir)) return [];
  const byHash = new Map<string, SpecApproval>();
  for (const file of ports.fs.listFiles(runsDir).sort()) {
    if (path.basename(file) !== JOURNAL_FILE) continue;
    let read: JournalRead;
    // Journals from other layouts or revisions never block a new run.
    try { read = readJournal(ports, path.dirname(path.isAbsolute(file) ? file : path.join(runsDir, file))); } catch { continue; }
    if (read.started?.data['protocolRevision'] !== JOURNAL_PROTOCOL_REVISION) continue;
    for (const record of read.records) {
      if (record.type !== 'DECISION' || record.data?.['kind'] !== 'spec-approval') continue;
      const answer = record.data['answer'] as Record<string, unknown> | null;
      if (!answer || answer['by'] !== 'user' || typeof answer['quote'] !== 'string' || typeof answer['hash'] !== 'string' || byHash.has(answer['hash'])) continue;
      byHash.set(answer['hash'], { by: 'user', quote: answer['quote'], hash: answer['hash'] });
    }
  }
  return [...byHash.values()];
}
function journalDesignApproval<S>(ports: Ports, runsDir: string, machine: Machine<S>, identity: DesignDeliveryIdentity): RunStartedEvent['designApproval'] {
  if (!ports.fs.exists(runsDir)) return undefined;
  for (const file of ports.fs.listFiles(runsDir)) {
    if (path.basename(file) !== JOURNAL_FILE) continue;
    const runDir = path.dirname(path.isAbsolute(file) ? file : path.join(runsDir, file));
    const read = readJournal(ports, runDir);
    const root = runSession(runDir) ?? runDir;
    const started = read.started ? restoreJournalPaths(read.started, root) : undefined;
    if (!started || started.data['verb'] !== 'design') continue;
    const folder = foldCurrent(machine, ports, runDir, read);
    if (!folder) continue;
    const projected = machine.project(folder.state).data;
    if (machine.awaitOf(folder.state) !== 'done' || projected['outcome'] !== 'complete') continue;
    const completion = projected['completion'];
    if (typeof completion !== 'object' || completion === null) continue;
    const binding = (completion as Record<string, unknown>)['governedDesign'];
    if (typeof binding !== 'object' || binding === null) continue;
    const governed = binding as Record<string, unknown>;
    if (typeof governed['path'] !== 'string' || pathIdentity(governed['path'], process.cwd()) !== pathIdentity(identity.path, process.cwd()) || governed['revision'] !== identity.revision) continue;
    const approval = (completion as Record<string, unknown>)['approval'];
    if (typeof approval !== 'object' || approval === null) continue;
    const a = approval as Record<string, unknown>;
    if (a['by'] === 'user' && typeof a['quote'] === 'string' && a['quote'].trim() && a['hash'] === identity.revision) return { by: 'user', quote: a['quote'], hash: identity.revision };
  }
  return undefined;
}
export type DesignDeliveryIdentity = { path: string; revision: string };
/** Same-session lookup folds journal payloads; mutable design files cannot supply approval or resumed state. */
export function findDesignDelivery<S>(ports: Ports, runsDir: string, machine: Machine<S>, identity: DesignDeliveryIdentity): { runDir: string; state: S; finished: boolean } | null {
  if (!/^sha256:[a-f0-9]{64}$/.test(identity.revision)) throw new EngineFault('Design delivery identity requires a governed revision hash.');
  if (!ports.fs.exists(runsDir)) return null;
  let match: { runDir: string; state: S; finished: boolean } | null = null;
  for (const file of ports.fs.listFiles(runsDir)) {
    if (path.basename(file) !== JOURNAL_FILE) continue;
    const runDir = path.dirname(path.isAbsolute(file) ? file : path.join(runsDir, file));
    const read = readJournal(ports, runDir);
    const root = runSession(runDir) ?? runDir;
    const started = read.started ? restoreJournalPaths(read.started, root) : undefined;
    if (!started || started.data['verb'] !== 'implement' || typeof started.data['argument'] !== 'string' || pathIdentity(started.data['argument'], process.cwd()) !== pathIdentity(identity.path, process.cwd())) continue;
    const folder = foldCurrent(machine, ports, runDir, read);
    if (!folder) continue;
    const finished = machine.awaitOf(folder.state) === 'done';
    const data = machine.project(folder.state).data;
    const completion = data['completion'];
    const binding = data['governedDesign'] ?? (typeof completion === 'object' && completion !== null ? (completion as Record<string, unknown>)['governedDesign'] : null);
    if (typeof binding !== 'object' || binding === null) continue;
    const revision = (binding as Record<string, unknown>)['revision'];
    if (typeof revision !== 'string') continue;
    if (revision !== identity.revision) {
      if (!finished) throw new EngineFault('An unfinished same-session design delivery has an incompatible governed revision.');
      continue;
    }
    if (match && !finished && !match.finished) throw new EngineFault('Competing unfinished same-session design deliveries.');
    if (!match || !finished) match = { runDir, state: folder.state, finished };
  }
  return match;
}

export type SettledPlanIdentity = { path: string; currentHash?: string };

/** Looks up completed settled plan runs in the session journal. */
export function findSettledPlan<S>(
  ports: Ports,
  runsDir: string,
  machine: Machine<S>,
  repoRoot: string,
  identity: SettledPlanIdentity,
): { path: string; hash: string; outcome: 'settled' | 'skipped' } | null {
  const currentHash = identity.currentHash ?? (ports.fs.exists(identity.path)
    ? `sha256:${crypto.createHash('sha256').update(governedPlanText(ports.fs.readText(identity.path) ?? '')).digest('hex')}`
    : null);
  if (!currentHash) return null;
  if (!ports.fs.exists(runsDir)) return null;
  for (const file of ports.fs.listFiles(runsDir)) {
    if (path.basename(file) !== JOURNAL_FILE) continue;
    const runDir = path.dirname(path.isAbsolute(file) ? file : path.join(runsDir, file));
    const read = readJournal(ports, runDir);
    const root = runSession(runDir) ?? runDir;
    const started = read.started ? restoreJournalPaths(read.started, root) : undefined;
    if (!started || started.data['verb'] !== 'plan') continue;
    const authoredLine = read.authored ? restoreJournalPaths(read.authored, root) : undefined;
    const planArg = typeof started.data['argument'] === 'string' ? started.data['argument'] : '';
    const overrides = started.data['overrides'] as Record<string, unknown> | undefined;
    const planPath = typeof overrides?.['path'] === 'string'
      ? overrides['path'] as string
      : typeof authoredLine?.data['path'] === 'string'
      ? authoredLine.data['path'] as string
      : planArg;
    if (pathIdentity(planPath, repoRoot) !== pathIdentity(identity.path, repoRoot)) continue;
    const folder = foldCurrent(machine, ports, runDir, read);
    if (!folder) continue;
    if (machine.awaitOf(folder.state) !== 'done') continue;
    const projected = machine.project(folder.state).data;
    if (projected['outcome'] !== 'complete') continue;
    const parsedLine = read.parsedPlan;
    const hash = parsedLine?.data['hash'];
    if (typeof hash !== 'string' || hash !== currentHash) continue;
    const summary = String(projected['summary'] ?? '');
    const outcome: 'settled' | 'skipped' = summary.includes('skipped') ? 'skipped' : 'settled';
    return { path: identity.path, hash, outcome };
  }
  return null;
}


/** Creates the run folder exclusively (ADR 0003), appends `RUN_STARTED`, and enters the send loop. */
export async function start<S>(options: StartOptions<S>): Promise<SendResult> {
  const { ports, runDir } = options;
  const { designApproval: _untrustedApproval, specApprovals: _untrustedSpecApprovals, ...accepted } = options.runStarted;
  // An ask run has no governing spec, so a caller-supplied candidate is never journaled.
  const { specCandidate: _askCandidate, ...askRequested } = accepted;
  const requested = accepted.verb === 'ask' ? askRequested : accepted;
  let designApproval: RunStartedEvent['designApproval'];
  const revision = requested.overrides['designRevision'];
  if (requested.verb === 'implement' && /\.design\.md$/i.test(requested.argument) && typeof revision === 'string') {
    const identity = { path: requested.argument, revision };
    const existing = findDesignDelivery(ports, path.dirname(runDir), options.machine, identity);
    if (existing) {
      const runRel = options.runRel === undefined ? existing.runDir.replace(/\\/g, '/') : path.posix.join(path.posix.dirname(options.runRel.replace(/\\/g, '/')), path.basename(existing.runDir));
      return existing.finished ? { frame: projectFrame(options.machine, existing.state, runRel), exitCode: 0 } : send({ ...options, runDir: existing.runDir, runRel });
    }
    designApproval = journalDesignApproval(ports, path.dirname(runDir), options.machine, identity);
  }
  ports.fs.mkdir(path.dirname(runDir), { recursive: true });
  if (options.reservedRun) {
    if (!ports.fs.exists(runDir) || ports.fs.listFiles(runDir).length) throw new EngineFault('Reserved run must be an empty directory');
  } else ports.fs.mkdir(runDir, { recursive: false });
  const sessionDir = runDir.replace(/[\\/]\.state[\\/]runs[\\/][^\\/]+[\\/]?$/, '');
  // Spec approvals are trusted only from prior journals in this session, never from the caller.
  const specApprovals = requested.verb === 'ask' ? [] : journalSpecApprovals(ports, path.dirname(runDir));
  const { type, ...data } = { ...requested, protocolRevision: JOURNAL_PROTOCOL_REVISION, ...(designApproval ? { designApproval } : {}), ...(specApprovals.length ? { specApprovals } : {}), overrides: { ...requested.overrides, sessionDir } };
  const stored = runSession(runDir) ? storeSessionPaths(data, sessionDir) : data;
  const line: JournalLine = { seq: 1, v: 1, at: new Date(ports.clock.now()).toISOString(), type, data: stored };
  const folder = createFolder(options.machine);
  folder.apply(runSession(runDir) ? restoreJournalPaths({ type, ...stored } as Event, sessionDir) : { type, ...data } as Event);
  const timeline = { steps: [] as TimelineStep[], orchestratorBytes: 0 };
  observeTimeline(options.machine, folder, line, timeline);
  const initialRead: JournalRead = { records: [], count: 0, recent: [], tornTail: false, goodBytes: 0, started: line, execution: { config: requested.config as Record<string, unknown>, revision: 0 } };
  const checkpoint = publishCheckpoint(ports, runDir, options.machine, folder, line, sha256(''), initialRead, timeline, runSession(runDir));
  if (checkpoint) line.checkpoint = checkpoint;
  ports.fs.appendDurable(journalPath(runDir), `${JSON.stringify(line)}\n`);
  const sendOptions: SendOptions<S> = { runDir, machine: options.machine, handlers: options.handlers, ports };
  if (options.runRel !== undefined) sendOptions.runRel = options.runRel;
  if (options.configSource !== undefined) sendOptions.configSource = options.configSource;
  if (options.diagnosticToggle !== undefined) sendOptions.diagnosticToggle = options.diagnosticToggle;
  if (options.diagnosticRetroInstruction !== undefined) sendOptions.diagnosticRetroInstruction = options.diagnosticRetroInstruction;
  if (options.diagnosticBuild !== undefined) sendOptions.diagnosticBuild = options.diagnosticBuild;
  return send(sendOptions);
}

function executionFrame(frame: Frame, status?: Record<string, unknown>): Frame {
  return status ? { ...frame, progress: { ...frame.progress, executionConfig: status } } : frame;
}
function executionStatus(lines: Iterable<JournalLine>, current: string | null, deferred = current === 'native' || current === 'write'): Record<string, unknown> | undefined {
  let latest: JournalLine | undefined;
  for (const line of lines) if (line.type === 'EXECUTION_CONFIG_UPDATED') latest = line;
  return latest ? { revision: latest.data['revision'], status: deferred ? 'deferred' : 'applied', effectiveAt: 'next-unissued-descriptor', overrides: 'explicit start model/effort take precedence' } : undefined;
}
function prepareRefresh<S>(options: SendOptions<S>, folder: Folder<S>, read: JournalRead): { error: string } | { event?: ExecutionConfigUpdated; status: Record<string, unknown> } {
  try {
    if (options.machine.awaitOf(folder.state) === 'done') throw new Error('execution-config-terminal: start a new run');
    const started = read.started, config = read.execution?.config, revision = read.execution?.revision ?? 0, sequence = read.count;
    if (!started || !config) throw new Error('execution-config-unavailable: missing RUN_STARTED');
    if (!options.machine.reconfigure || !options.configSource) throw new Error('execution-config-unavailable: configuration source and reconfigure hook required');
    const next = options.configSource(), errors = validateConfig(next);
    if (errors.length) throw new Error(`execution-config-invalid: ${errors.join('; ')}`);
    const delta = executionDelta(config, next);
    const changed = delta.read.length + delta.write.length > 0;
    const event: ExecutionConfigUpdated = { type: 'EXECUTION_CONFIG_UPDATED', revision: revision + 1, boundarySeq: sequence + 1, delta };
    const error = validateExecutionUpdate(event);
    if (error) throw new Error(error);
    if (changed) options.machine.reconfigure(folder.state, event);
    const deferred = folder.queue.length > 0 || ['native', 'write'].includes(options.machine.awaitOf(folder.state) ?? '');
    return { ...(changed ? { event } : {}), status: { revision: changed ? revision + 1 : revision, status: changed ? deferred ? 'deferred' : 'applied' : 'unchanged', effectiveAt: 'next-unissued-descriptor', overrides: 'explicit start model/effort take precedence' } };
  } catch (error) { return { error: oneLine(message(error)) }; }
}
