// Interpreter: fold the journal through a machine, apply one host event, run pending effects (spec §4.4).
// Generic over `Machine<S>` and a handler table so the core tier needs no machines/ or effects/ import.

import path from 'node:path';
import { faultFrame, oneLine, projectFrame } from './frame.ts';
import { appendEvent, EngineFault, JOURNAL_FILE, journalPath, readJournal, type JournalRead } from './journal.ts';
import { acquireLock, LockHeld, releaseLock } from './lock.ts';
import { HEARTBEAT_MS, milestone, writeProgress } from './progress.ts';
import type {
  Effect, Event, ExitCode, Frame, Handler, Handlers, HostEvent, JournalLine, Machine, Ports, ResultEvent,
  ResultEventType, RunStartedEvent, TerminalResultMap,
} from './types.ts';
import { validateHostEvent } from './validate.ts';

/** Guards a reducer bug from looping forever; exceeding it is an engine fault. */
export const MAX_STEPS = 200;

export const TERMINAL_RESULT: TerminalResultMap = {
  'parse-artifact': 'ARTIFACT_PARSED',
  'prepare-review': 'REVIEW_PREPARED',
  wave: 'WAVE_DONE',
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

export function toEvent(line: JournalLine): Event {
  return { ...line.data, type: line.type } as Event;
}

/** Folds journal lines; `inFlight` is the head effect when it started without a terminal result. */
export function fold<S>(machine: Machine<S>, lines: readonly JournalLine[]): Folder<S> & { inFlight: { effect: Effect; attempt: number } | null } {
  const folder = createFolder(machine);
  for (const line of lines) folder.apply(toEvent(line));
  const head = folder.queue[0];
  const inFlight = head && folder.open.has(head.id) ? { effect: head, attempt: folder.attempts.get(head.id) ?? 1 } : null;
  return Object.assign(folder, { inFlight });
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

function hostEventError<S>(machine: Machine<S>, folder: Folder<S>, raw: unknown): { event: HostEvent } | { error: string } {
  const head = folder.queue[0];
  if (head) return { error: `event: effect ${head.id} is pending; send without --event to resume it` };
  const parsed = parseRaw(raw);
  if (!parsed.ok) return { error: parsed.error };
  const state = folder.state;
  const check = machine.validate ? (event: HostEvent) => machine.validate?.(state, event) ?? null : undefined;
  const result = validateHostEvent(machine.awaitOf(state) ?? 'done', parsed.value, check);
  return result.ok ? { event: result.value } : { error: oneLine(result.error) };
}

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export async function send<S>(options: SendOptions<S>): Promise<SendResult> {
  const { runDir, machine, handlers, ports } = options;
  const runRel = options.runRel ?? runDir.replace(/\\/g, '/');
  if (options.dryRun) return dryRun(options, runRel);

  const file = journalPath(runDir);
  let locked = false;
  let baseline: { existed: boolean; bytes: number } | null = null;
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

    const folder = fold(machine, read.lines);
    let seq = read.lines.length + 1;
    const record = (event: Event): void => {
      const { type, ...data } = event;
      appendEvent(ports, runDir, type, data, seq++);
      folder.apply(event);
    };

    if (broken !== null) record({ type: 'LOCK_BROKEN', stalePid: broken });
    if (options.rawEvent !== undefined) {
      const checked = hostEventError(machine, folder, options.rawEvent);
      if ('error' in checked) return { frame: projectFrame(machine, folder.state, runRel, checked.error), exitCode: 0 };
      record(checked.event);
    }

    for (let steps = 1; folder.queue.length > 0; steps++) {
      if (steps > MAX_STEPS) throw new EngineFault(`MAX_STEPS (${MAX_STEPS}) exceeded in one send; a machine keeps emitting effects`);
      const effect = folder.queue[0] as Effect;
      const attempt = (folder.attempts.get(effect.id) ?? 0) + 1;
      record({ type: 'EFFECT_STARTED', effectId: effect.id, kind: effect.kind, attempt });
      const results = await runEffect(effect, attempt, handlers, ports, runDir);
      for (const result of results) record(result);
    }
    if (machine.awaitOf(folder.state) === null) throw new EngineFault('machine neither awaits nor emits effects');
    machine.render?.(folder.state, ports, runDir);
    return { frame: projectFrame(machine, folder.state, runRel), exitCode: 0 };
  } catch (error) {
    if (baseline) restoreJournal(ports, file, baseline);
    return { frame: faultFrame(runRel, message(error)), exitCode: 2 };
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

async function runEffect(effect: Effect, attempt: number, handlers: Handlers, ports: Ports, runDir: string): Promise<readonly ResultEvent[]> {
  const handler = handlers[effect.kind] as Handler | undefined;
  if (!handler) throw new EngineFault(`no handler for effect kind ${effect.kind}`);
  const startedAt = new Date(ports.clock.now()).toISOString();
  const snapshot = () => ({ at: new Date(ports.clock.now()).toISOString(), effect: { id: effect.id, kind: effect.kind, startedAt } });
  writeProgress(ports, runDir, snapshot());
  milestone(ports, `${effect.id} started (attempt ${attempt})`);
  const stop = ports.clock.every(HEARTBEAT_MS, () => writeProgress(ports, runDir, snapshot()));
  let results: readonly ResultEvent[];
  try {
    results = await handler(effect, ports, { runDir, attempt });
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

function dryRun<S>(options: SendOptions<S>, runRel: string): SendResult {
  const { machine, ports, runDir } = options;
  try {
    const folder = fold(machine, readJournal(ports, runDir).lines);
    if (options.rawEvent === undefined) return { frame: projectFrame(machine, folder.state, runRel), exitCode: 0 };
    const checked = hostEventError(machine, folder, options.rawEvent);
    return { frame: projectFrame(machine, folder.state, runRel, 'error' in checked ? checked.error : undefined), exitCode: 0 };
  } catch (error) {
    return { frame: faultFrame(runRel, message(error)), exitCode: 2 };
  }
}

// SECTION: Start

export interface StartOptions<S> extends Omit<SendOptions<S>, 'rawEvent' | 'dryRun'> {
  runStarted: RunStartedEvent;
}
const designPathIdentity = (file: string) => {
  const normalized = path.resolve(file.replace(/\\/g, '/')).replace(/\\/g, '/');
  return path.sep === '\\' ? normalized.toLowerCase() : normalized;
};
function journalDesignApproval<S>(ports: Ports, runsDir: string, machine: Machine<S>, identity: DesignDeliveryIdentity): RunStartedEvent['designApproval'] {
  if (!ports.fs.exists(runsDir)) return undefined;
  for (const file of ports.fs.listFiles(runsDir)) {
    if (path.basename(file) !== JOURNAL_FILE) continue;
    const runDir = path.dirname(path.isAbsolute(file) ? file : path.join(runsDir, file));
    const lines = readJournal(ports, runDir).lines;
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
    const lines = readJournal(ports, runDir).lines;
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
  ports.fs.mkdir(runDir, { recursive: false });
  const sessionDir = runDir.replace(/[\\/]\.state[\\/]runs[\\/][^\\/]+[\\/]?$/, '');
  const { type, ...data } = { ...requested, ...(designApproval ? { designApproval } : {}), overrides: { ...requested.overrides, sessionDir } };
  appendEvent(ports, runDir, type, data, 1);
  const sendOptions: SendOptions<S> = { runDir, machine: options.machine, handlers: options.handlers, ports };
  if (options.runRel !== undefined) sendOptions.runRel = options.runRel;
  return send(sendOptions);
}
