// Interpreter: fold the journal through a machine, apply one host event, run pending effects (spec §4.4).
// Generic journal loop plus the design-designated root-machine wiring choke point.

import path from 'node:path';
import crypto from 'node:crypto';
import { governedDesignText } from '../domain/design.ts';
import { governedPlanText } from '../domain/plan.ts';
import { restoreSessionPaths, storeSessionPaths } from '../lib/session.ts';
import { rootMachine, type RootState } from '../machines/root.ts';
import { faultFrame, oneLine, projectFrame } from './frame.ts';
import { appendEvent, EngineFault, JOURNAL_FILE, journalPath, readJournal, type JournalRead } from './journal.ts';
import { acquireLock, LockHeld, releaseLock } from './lock.ts';
import { HEARTBEAT_MS, milestone, writeProgress } from './progress.ts';
import type {
  Effect, Event, ExitCode, Frame, Handler, Handlers, HostEvent, JournalLine, Machine, Ports, ResultEvent,
  ResultEventType, RunStartedEvent, TerminalResultMap, ExecutionConfigUpdated,
} from './types.ts';
import { validateHostEvent, validateExecutionUpdate } from './validate.ts';
import { applyExecutionConfig, executionDelta } from '../domain/execution-config.ts';
import { validateConfig } from '../lib/config.ts';
import { diagnosticPhases } from '../machines/diagnostics.ts';
import { DIAGNOSTIC_LIMITS, extractTransport, type Capture } from '../domain/diagnostics.ts';
import { diagnosticFrame, diagnosticWarning, diagnosticId, publishInvocation, publishBoundary, publishReport, resolveDiagnosticToggle, type TimelineEntry } from './diagnostics.ts';
export { rootMachine as dispatchMachine } from '../machines/root.ts';
export { executionTopology } from '../domain/execution-config.ts';
export const designRevision = (source: string): string => `sha256:${crypto.createHash('sha256').update(governedDesignText(source)).digest('hex')}`;
/** Read-only receipt preview shares the emitted checker and the writer's captured baseline. */
export async function previewReceipt(state: RootState, event: HostEvent, handlers: Handlers, ports: Ports, runDir: string): Promise<string | null> {
  if (event.type !== 'WRITE_ENVELOPE' || state.tag !== 'implement') return null;
  const child = state.child;
  if (child.tag !== 'write' && child.tag !== 'hotfix-write') return null;
  const projectedPaths = rootMachine.project(state).data['paths'];
  const permitted: string[] = Array.isArray(projectedPaths) ? projectedPaths.filter((file): file is string => typeof file === 'string')
    : [...new Set([...(child.c.plan?.changes.map((change) => change.path) ?? []), ...child.c.adoptedPaths])];
  const effect: Extract<Effect, { kind: 'check-envelope' }> & { since: Readonly<Record<string, unknown>> } = { kind: 'check-envelope', id: 'preview.check-envelope.1', envelopePath: event.envelopePath, permitted,
    since: child.tag === 'write' ? child.info.preFingerprint : child.before };
  const checker = handlers['check-envelope']; if (!checker) return 'Receipt checker is unavailable';
  const results = await checker(effect, ports, { runDir, attempt: 1 });
  const result = results[0];
  if (result?.type === 'EFFECT_FAILED') return result.detail;
  if (result?.type !== 'ENVELOPE_CHECKED') return 'Receipt checker returned no result';
  return result.defects.length ? result.defects.map((defect) => typeof defect === 'string' ? defect : JSON.stringify(defect)).join('; ') : null;
}

/** Guards a reducer bug from looping forever; exceeding it is an engine fault. */
export const MAX_STEPS = 200;

export const TERMINAL_RESULT: TerminalResultMap = {
  'parse-artifact': 'ARTIFACT_PARSED',
  'prepare-review': 'REVIEW_PREPARED',
  wave: 'WAVE_DONE',
  'wave-start': 'WAVE_STARTED',
  'wave-finish': 'WAVE_DONE',
  verify: 'VERIFY_DONE',
  'write-brief': 'BRIEF_READY',
  'check-envelope': 'ENVELOPE_CHECKED',
  snapshot: 'SNAPSHOT',
  restore: 'RESTORED',
  handoff: 'HANDOFF_DONE',
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

export function createFolder<S>(machine: Machine<S>): Folder<S> {
  const folder: Folder<S> = {
    state: machine.initial(),
    queue: [],
    attempts: new Map(),
    open: new Set(),
    apply(event) {
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
        }
      }
      const result = machine.step(folder.state, event);
      folder.state = result.state;
      folder.queue.push(...result.effects);
    },
  };
  return folder;
}

export function toEvent(line: JournalLine, protocolRevision = 3): Event {
  if (protocolRevision !== 3) throw new EngineFault('unsupported-journal-protocol: expected revision 3; start a new run');
  const event = { ...line.data, type: line.type } as Event;
  if (event.type === 'EXECUTION_CONFIG_UPDATED') {
    const error = validateExecutionUpdate(event);
    if (error || event.boundarySeq !== line.seq) throw new EngineFault(error ?? 'execution-config-invalid: boundary sequence mismatch');
  }
  return event;
}

/** Folds journal lines; `inFlight` is the head effect when it started without a terminal result. */
export function fold<S>(machine: Machine<S>, lines: readonly JournalLine[], sessionRoot?: string): Folder<S> & { inFlight: { effect: Effect; attempt: number } | null } {
  const run = lines.find((line) => line.type === 'RUN_STARTED');
  const protocolRevision = 3;
  if (run && run.data['protocolRevision'] !== 3) throw new EngineFault('unsupported-journal-protocol: expected revision 3; start a new run');
  const folder = createFolder(machine);
  let revision = 0;
  let config = run?.data['config'] as Record<string, unknown> | undefined;
  for (const line of lines) {
    const event = toEvent(sessionRoot ? restoreJournalPaths(line, sessionRoot) : line, protocolRevision);
    if (event.type === 'EXECUTION_CONFIG_UPDATED') {
      if (event.revision !== ++revision || !config) throw new EngineFault('execution-config-invalid: revision sequence mismatch');
      config = applyExecutionConfig(config, event.delta);
      const errors = validateConfig(config);
      if (errors.length) throw new EngineFault(`execution-config-invalid: ${errors.join('; ')}`);
    }
    folder.apply(event);
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
  diagnosticToggle?: () => boolean;
  diagnosticInstruction?: () => string;
  diagnosticIdentity?: () => Capture['identity'];
}

export interface SendResult {
  /** Null only when the lock is held (exit 3); `message` then names the holder. */
  frame: Frame | null;
  exitCode: ExitCode;
  message?: string;
}

function parseRaw(raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: true, value: raw };
  try { return { ok: true, value: JSON.parse(raw) as unknown }; } catch { return { ok: false, error: 'event: expected JSON object, got malformed JSON' }; }
}

function hostEventError<S>(machine: Machine<S>, folder: Folder<S>, raw: unknown, sessionRoot?: string): { event: HostEvent; sidecar?: unknown } | { error: string } {
  const head = folder.queue[0];
  if (head) return { error: `event: effect ${head.id} is pending; send without --event to resume it` };
  const parsed = parseRaw(raw);
  if (!parsed.ok) return { error: parsed.error };
  const transport = extractTransport(parsed.value);
  if (transport.error) return { error: transport.error };
  const state = folder.state;
  const check = machine.validate ? (event: HostEvent) => machine.validate?.(state, event) ?? null : undefined;
  const value = sessionRoot ? restoreJournalPaths(storeSessionPaths(transport.event, sessionRoot), sessionRoot) : transport.event;
  const result = validateHostEvent(machine.awaitOf(state) ?? 'done', value, check);
  return result.ok ? { event: result.value, ...(transport.sidecar !== undefined ? { sidecar: transport.sidecar } : {}) } : { error: oneLine(result.error) };
}

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export async function send<S>(options: SendOptions<S>): Promise<SendResult> {
  const { runDir, machine, handlers, ports } = options;
  const runRel = options.runRel ?? runDir.replace(/\\/g, '/');
  if (options.refreshConfig && options.rawEvent !== undefined) return { frame: null, exitCode: 1, message: '--refresh-config cannot be combined with --event' };
  if (options.dryRun) return dryRun(options, runRel);

  const file = journalPath(runDir);
  let locked = false;
  let baseline: { existed: boolean; bytes: number } | null = null;
  const warn = diagnosticWarning(ports);
  let diagnosticEnabled = false;
  let diagnosticBinding = { seq: 0, at: ports.clock.now() };
  let instruction = '';
  let identity: Capture['identity'];
  const timeline: TimelineEntry[] = [];
  const sidecars: Array<{ seq: number; phase: string; value?: unknown }> = [];
  const activePhaseId = () => {
    const key = timeline.at(-1)?.phases.filter((phase) => !phase.outcome).at(-1)?.key ?? timeline.at(-1)?.phases.at(-1)?.key ?? 'unavailable';
    let entry = timeline.at(-1)?.seq ?? 0;
    for (let index = timeline.length - 1; index >= 0; index--) { const item = timeline[index]!; if (!item.phases.some((phase) => phase.key === key)) break; entry = item.seq; }
    return `${key}:${entry}`;
  };
  let diagnosticLines: JournalLine[] = [];
  const collectState = (state: S, line: JournalLine) => {
    if (!diagnosticEnabled || machine !== rootMachine as unknown as Machine<S>) return;
    try {
      const phases = diagnosticPhases(state as RootState), data = machine.project(state).data;
      timeline.push({ seq: line.seq, at: Date.parse(line.at), phases, awaiting: data['kind'] === 'approval' ? 'approval' : machine.awaitOf(state), ...(machine.awaitOf(state) === 'done' ? { outcome: String(data['outcome'] ?? 'partial') } : {}) });
    } catch { warn(); }
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
    const read: JournalRead = readJournal(ports, runDir);
    if (read.tornTail) ports.fs.truncate(file, read.goodBytes);
    baseline = { existed: ports.fs.exists(file), bytes: read.goodBytes };

    const sessionRoot = runSession(runDir);
    const folder = fold(machine, read.lines, sessionRoot);
    diagnosticLines = [...read.lines];
    diagnosticEnabled = resolveDiagnosticToggle(ports, runDir, read.lines.find((line) => line.type === 'RUN_STARTED')?.data['config'] !== undefined && (read.lines.find((line) => line.type === 'RUN_STARTED')!.data['config'] as Record<string, unknown>)['diagnostics'] === true, options.diagnosticToggle, warn);
    diagnosticBinding = { seq: read.lines.length, at: ports.clock.now() };
    if (diagnosticEnabled) {
      try {
        instruction = options.diagnosticInstruction?.() ?? '';
        if (Buffer.byteLength(instruction) > DIAGNOSTIC_LIMITS.instructionBytes) { instruction = ''; warn(); }
        identity = options.diagnosticIdentity?.();
        if (identity) identity = { ...identity, host: String(read.lines.find((line) => line.type === 'RUN_STARTED')?.data['orchestrator'] ?? 'unavailable') };
      } catch { warn(); }
      try {
        const replay = createFolder(machine), revision = Number(read.lines.find((line) => line.type === 'RUN_STARTED')?.data['protocolRevision'] ?? 3);
        for (const line of read.lines) { replay.apply(toEvent(sessionRoot ? restoreJournalPaths(line, sessionRoot) : line, revision)); collectState(replay.state, line); }
      } catch { warn(); }
    }
    let seq = read.lines.length + 1;
    const record = (event: Event): void => {
      const { type, ...data } = event;
      const stored = sessionRoot ? storeSessionPaths(data, sessionRoot) : data;
      const line = appendEvent(ports, runDir, type, stored, seq++);
      diagnosticLines.push(line);
      folder.apply(sessionRoot ? restoreJournalPaths({ ...stored, type } as Event, sessionRoot) : event);
      machine.render?.(folder.state, ports, runDir);
      collectState(folder.state, line);
    };

    let refreshStatus: Record<string, unknown> | undefined;
    if (options.refreshConfig) {
      const refresh = prepareRefresh(options, folder, read.lines);
      if ('error' in refresh) return { frame: projectFrame(machine, folder.state, runRel, refresh.error), exitCode: 0 };
      refreshStatus = refresh.status;
      if (refresh.event) record(refresh.event);
    }
    if (broken !== null) record({ type: 'LOCK_BROKEN', stalePid: broken });
    if (options.rawEvent !== undefined) {
      const checked = hostEventError(machine, folder, options.rawEvent, sessionRoot);
      if ('error' in checked) return { frame: projectFrame(machine, folder.state, runRel, checked.error), exitCode: 0 };
      if (diagnosticEnabled) {
        sidecars.push({ seq, phase: activePhaseId().replace(/:\d+$/, ''), ...(checked.sidecar !== undefined ? { value: checked.sidecar } : {}) });
        if (checked.event.type === 'NATIVE_RESULTS') for (const slot of checked.event.slots) {
          const source = String(slot['sourceKey'] ?? slot['slot']);
          const producer = diagnosticId(`${source}:${activePhaseId()}:${seq}`);
          publishInvocation(ports, runDir, { id: producer, producer, sequence: 1, phase: activePhaseId(), surface: 'native', provider: String(read.lines.find((line) => line.type === 'RUN_STARTED')?.data['orchestrator'] ?? 'unavailable'), configuredModel: null, mode: 'native', start: ports.clock.now(), durationMs: null, outcome: 'captured', launched: true }, warn);
        }
      }
      record(checked.event);
    }

    for (let steps = 1; folder.queue.length > 0; steps++) {
      if (steps > MAX_STEPS) throw new EngineFault(`MAX_STEPS (${MAX_STEPS}) exceeded in one send; a machine keeps emitting effects`);
      const effect = folder.queue[0] as Effect;
      const attempt = (folder.attempts.get(effect.id) ?? 0) + 1;
      record({ type: 'EFFECT_STARTED', effectId: effect.id, kind: effect.kind, attempt });
      const results = await runEffect(effect, attempt, handlers, ports, runDir, diagnosticEnabled ? { runDir, phase: activePhaseId(), boundary: seq - 1 } : undefined);
      for (const result of results) record(result);
    }
    if (machine.awaitOf(folder.state) === null) throw new EngineFault('machine neither awaits nor emits effects');
    machine.render?.(folder.state, ports, runDir);
    publishBoundary(ports, runDir, diagnosticEnabled, diagnosticLines, timeline, sidecars, instruction.split(/\r?\n/).filter(Boolean), warn, identity, machine.awaitOf(folder.state) === 'done' ? 0 : Buffer.byteLength(instruction), diagnosticBinding);
    releaseLock(ports, runDir); locked = false;
    publishReport(ports, runDir, diagnosticEnabled, warn, instruction.split(/\r?\n/).filter(Boolean));
    const status = refreshStatus?.['status'] === 'unchanged' ? refreshStatus : executionStatus(diagnosticLines, machine.awaitOf(folder.state), machine.executionDeferred?.(folder.state));
    return { frame: diagnosticFrame(executionFrame(projectFrame(machine, folder.state, runRel), status), ports, runDir, diagnosticEnabled, instruction), exitCode: 0 };
  } catch (error) {
    if (baseline) restoreJournal(ports, file, baseline);
    if (locked) { releaseLock(ports, runDir); locked = false; }
    publishReport(ports, runDir, diagnosticEnabled, warn, instruction.split(/\r?\n/).filter(Boolean));
    return { frame: diagnosticFrame(faultFrame(runRel, message(error)), ports, runDir, diagnosticEnabled, instruction), exitCode: 2 };
  } finally {
    if (locked) releaseLock(ports, runDir);
  }
}

/** Truncates back to the pre-send length (fsync) so a fault appends nothing past the last good event. */
function restoreJournal(ports: Ports, file: string, baseline: { existed: boolean; bytes: number }): void {
  if (!ports.fs.exists(file)) return;
  if (!baseline.existed) ports.fs.remove(file);
  else if (ports.fs.size(file) !== baseline.bytes) ports.fs.truncate(file, baseline.bytes);
}

async function runEffect(effect: Effect, attempt: number, handlers: Handlers, ports: Ports, runDir: string, diagnostics?: import('./types.ts').DiagnosticBinding): Promise<readonly ResultEvent[]> {
  const handler = handlers[effect.kind] as Handler | undefined;
  if (!handler) throw new EngineFault(`no handler for effect kind ${effect.kind}`);
  const startedAt = new Date(ports.clock.now()).toISOString();
  const snapshot = () => ({ at: new Date(ports.clock.now()).toISOString(), effect: { id: effect.id, kind: effect.kind, startedAt } });
  writeProgress(ports, runDir, snapshot());
  milestone(ports, `${effect.id} started (attempt ${attempt})`);
  const stop = ports.clock.every(HEARTBEAT_MS, () => writeProgress(ports, runDir, snapshot()));
  let results: readonly ResultEvent[];
  try {
    results = await handler(effect, ports, { runDir, attempt, ...(diagnostics ? { diagnostics } : {}) });
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
  return results;
}

async function dryRun<S>(options: SendOptions<S>, runRel: string): Promise<SendResult> {
  const { machine, ports, runDir } = options;
  try {
    const lines = readJournal(ports, runDir).lines;
    const folder = fold(machine, lines, runSession(runDir));
    if (options.refreshConfig) {
      const refresh = prepareRefresh(options, folder, lines);
      return { frame: 'error' in refresh ? projectFrame(machine, folder.state, runRel, refresh.error) : executionFrame(projectFrame(machine, folder.state, runRel), refresh.status), exitCode: 0 };
    }
    if (options.rawEvent === undefined) return { frame: projectFrame(machine, folder.state, runRel), exitCode: 0 };
    const checked = hostEventError(machine, folder, options.rawEvent, runSession(runDir));
    const error = 'error' in checked ? checked.error : await options.preview?.(folder.state, checked.event) ?? undefined;
    return { frame: projectFrame(machine, folder.state, runRel, error ?? undefined), exitCode: 0 };
  } catch (error) {
    return { frame: faultFrame(runRel, message(error)), exitCode: 2 };
  }
}

// SECTION: Start

export interface StartOptions<S> extends Omit<SendOptions<S>, 'rawEvent' | 'dryRun'> {
  runStarted: RunStartedEvent;
  reservedRun?: boolean;
}
const designPathIdentity = (file: string) => {
  const normalized = path.resolve(file.replace(/\\/g, '/')).replace(/\\/g, '/');
  return path.sep === '\\' ? normalized.toLowerCase() : normalized;
};
const runSession = (runDir: string): string | undefined => {
  const root = runDir.replace(/[\\/]\.state[\\/]runs[\\/][^\\/]+[\\/]?$/, '');
  return root === runDir ? undefined : root;
};
function journalDesignApproval<S>(ports: Ports, runsDir: string, machine: Machine<S>, identity: DesignDeliveryIdentity): RunStartedEvent['designApproval'] {
  if (!ports.fs.exists(runsDir)) return undefined;
  for (const file of ports.fs.listFiles(runsDir)) {
    if (path.basename(file) !== JOURNAL_FILE) continue;
    const runDir = path.dirname(path.isAbsolute(file) ? file : path.join(runsDir, file));
    const lines = restoreJournalPaths(readJournal(ports, runDir).lines, runSession(runDir) ?? runDir);
    const started = lines.find((line) => line.type === 'RUN_STARTED');
    if (!started || started.data['verb'] !== 'design') continue;
    const folder = fold(machine, lines);
    const projected = machine.project(folder.state).data;
    if (machine.awaitOf(folder.state) !== 'done' || projected['outcome'] !== 'complete') continue;
    const completion = projected['completion'];
    if (typeof completion !== 'object' || completion === null) continue;
    const binding = (completion as Record<string, unknown>)['governedDesign'];
    if (typeof binding !== 'object' || binding === null) continue;
    const governed = binding as Record<string, unknown>;
    if (typeof governed['path'] !== 'string' || designPathIdentity(governed['path']) !== designPathIdentity(identity.path) || governed['revision'] !== identity.revision) continue;
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
    const lines = restoreJournalPaths(readJournal(ports, runDir).lines, runSession(runDir) ?? runDir);
    const started = lines.find((line) => line.type === 'RUN_STARTED');
    if (!started || started.data['verb'] !== 'implement' || typeof started.data['argument'] !== 'string' || designPathIdentity(started.data['argument']) !== designPathIdentity(identity.path)) continue;
    const folder = fold(machine, lines);
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
    const lines = restoreJournalPaths(readJournal(ports, runDir).lines, runSession(runDir) ?? runDir);
    const started = lines.find((line) => line.type === 'RUN_STARTED');
    if (!started || started.data['verb'] !== 'plan') continue;
    const authoredLine = [...lines].reverse().find((line) => line.type === 'AUTHORED' && typeof line.data['path'] === 'string');
    const planArg = typeof started.data['argument'] === 'string' ? started.data['argument'] : '';
    const overrides = started.data['overrides'] as Record<string, unknown> | undefined;
    const planPath = typeof overrides?.['path'] === 'string'
      ? overrides['path'] as string
      : typeof authoredLine?.data['path'] === 'string'
      ? authoredLine.data['path'] as string
      : planArg;
    if (designPathIdentity(path.resolve(repoRoot, planPath)) !== designPathIdentity(path.resolve(repoRoot, identity.path))) continue;
    const folder = fold(machine, lines);
    if (machine.awaitOf(folder.state) !== 'done') continue;
    const projected = machine.project(folder.state).data;
    if (projected['outcome'] !== 'complete') continue;
    const parsedLine = [...lines].reverse().find((line) => line.type === 'ARTIFACT_PARSED' && line.data['kind'] === 'plan');
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
  const { designApproval: _untrustedApproval, ...requested } = options.runStarted;
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
  const { type, ...data } = { ...requested, protocolRevision: 3, ...(designApproval ? { designApproval } : {}), overrides: { ...requested.overrides, sessionDir } };
  appendEvent(ports, runDir, type, runSession(runDir) ? storeSessionPaths(data, sessionDir) : data, 1);
  const sendOptions: SendOptions<S> = { runDir, machine: options.machine, handlers: options.handlers, ports };
  if (options.runRel !== undefined) sendOptions.runRel = options.runRel;
  if (options.configSource !== undefined) sendOptions.configSource = options.configSource;
  if (options.diagnosticToggle !== undefined) sendOptions.diagnosticToggle = options.diagnosticToggle;
  if (options.diagnosticInstruction !== undefined) sendOptions.diagnosticInstruction = options.diagnosticInstruction;
  if (options.diagnosticIdentity !== undefined) sendOptions.diagnosticIdentity = options.diagnosticIdentity;
  return send(sendOptions);
}

function executionFrame(frame: Frame, status?: Record<string, unknown>): Frame {
  return status ? { ...frame, progress: { ...frame.progress, executionConfig: status } } : frame;
}
function executionStatus(lines: readonly JournalLine[], current: string | null, deferred = current === 'native' || current === 'write'): Record<string, unknown> | undefined {
  const latest = lines.findLast((line) => line.type === 'EXECUTION_CONFIG_UPDATED');
  return latest ? { revision: latest.data['revision'], status: deferred ? 'deferred' : 'applied', effectiveAt: 'next-unissued-descriptor', overrides: 'explicit start model/effort take precedence' } : undefined;
}
function prepareRefresh<S>(options: SendOptions<S>, folder: Folder<S>, lines: readonly JournalLine[]): { error: string } | { event?: ExecutionConfigUpdated; status: Record<string, unknown> } {
  try {
    if (options.machine.awaitOf(folder.state) === 'done') throw new Error('execution-config-terminal: start a new run');
    const started = lines.find((line) => line.type === 'RUN_STARTED');
    if (!started) throw new Error('execution-config-unavailable: missing RUN_STARTED');
    if (!options.machine.reconfigure || !options.configSource) throw new Error('execution-config-unavailable: configuration source and reconfigure hook required');
    let config = started.data['config'] as Record<string, unknown>;
    let revision = 0;
    for (const line of lines) if (line.type === 'EXECUTION_CONFIG_UPDATED') {
      const event = toEvent(line, 3) as ExecutionConfigUpdated;
      config = applyExecutionConfig(config, event.delta);
      revision = event.revision;
    }
    const next = options.configSource(), errors = validateConfig(next);
    if (errors.length) throw new Error(`execution-config-invalid: ${errors.join('; ')}`);
    const delta = executionDelta(config, next);
    const changed = delta.read.length + delta.write.length > 0;
    const event: ExecutionConfigUpdated = { type: 'EXECUTION_CONFIG_UPDATED', revision: revision + 1, boundarySeq: lines.length + 1, delta };
    const error = validateExecutionUpdate(event);
    if (error) throw new Error(error);
    if (changed) options.machine.reconfigure(folder.state, event);
    const deferred = folder.queue.length > 0 || ['native', 'write'].includes(options.machine.awaitOf(folder.state) ?? '');
    return { ...(changed ? { event } : {}), status: { revision: changed ? revision + 1 : revision, status: changed ? deferred ? 'deferred' : 'applied' : 'unchanged', effectiveAt: 'next-unissued-descriptor', overrides: 'explicit start model/effort take precedence' } };
  } catch (error) { return { error: oneLine(message(error)) }; }
}
