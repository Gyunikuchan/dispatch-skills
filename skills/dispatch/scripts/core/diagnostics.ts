// Journal-derived diagnostics: per-run facts from session journals, the session report, and frame hints.
// Facts, gates, and rendering are pure (domain/diagnostics.ts); the machine fold is injected, so core imports no machines/.

import path from 'node:path';
import { normalizeUsage, rejectionReason, renderDiagnostics, type InvocationFacts, type Phase, type PhaseFacts, type ReviewFacts, type RunFacts } from '../domain/diagnostics.ts';
import { JOURNAL_FILE, readJournal } from './journal.ts';
import type { Frame, JournalLine, Ports } from './types.ts';
import { HOST_EVENT_SHAPES } from './validate.ts';

/** The folded machine view at a journal line; one step per change of phases (review phases carry convergence), await, or outcome. */
export type TimelineStep = { seq: number; phases: readonly Phase[]; awaiting: string | null; user: boolean; outcome?: string };
/** `orchestratorBytes` sums the projected frame bytes at every host await. */
export type TimelineFacts = { steps: readonly TimelineStep[]; orchestratorBytes: number };
export type FoldRun = (lines: Iterable<JournalLine>) => TimelineFacts;
export type BuildIdentity = { version?: string; build?: string; os?: string };
export type DiagnosticReport = { path: string; findings: number; top?: string };

export const ATTEST_HINT = ['tokens', 'durationMs'] as const;
/**
 * Decide kinds whose production answer comes from the user: a `by:"user"` quote, per-finding user quotes, or a user
 * selection (`opt-in`). Mixed kinds (`failure`, `concerns`) are classified per reply.
 */
export const USER_DECIDE_KINDS: ReadonlySet<string> = new Set(['approval', 'level-recommendation', 'needs-user', 'scope-deviation-user', 'opt-in']);

const HOST_TYPES: ReadonlySet<string> = new Set(Object.keys(HOST_EVENT_SHAPES));
// Lock recovery and config refresh happen inside a host wait, so they never split a timing interval.
const UNTIMED: ReadonlySet<string> = new Set(['LOCK_BROKEN', 'EXECUTION_CONFIG_UPDATED']);
const RUN_JOURNAL = new RegExp(`^[^/]+/${JOURNAL_FILE.replace('.', '\\.')}$`);

const sessionOf = (runDir: string): string => runDir.replace(/[\\/]\.state[\\/]runs[\\/][^\\/]+[\\/]?$/, '');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
const count = (value: unknown): number | undefined => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
const opt = <K extends string, V>(key: K, value: V | undefined) => (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

export function diagnosticWarning(ports: Ports): () => void {
  let warned = false;
  return () => { if (!warned) { warned = true; ports.proc.stderr('[dispatch] diagnostics collection incomplete; workflow continues\n'); } };
}

// SECTION: Collection

/** The phase that owns an interval: the innermost open phase, else the last one. */
const activeKey = (step: TimelineStep | undefined): string | undefined => step?.phases.filter((phase) => !phase.outcome).at(-1)?.key ?? step?.phases.at(-1)?.key;

const pinsOf = (pins: unknown): string | undefined => {
  if (!record(pins)) return undefined;
  if (pins['kind'] === 'all') return 'all';
  if (pins['kind'] === 'count') return count(pins['count'])?.toString();
  return pins['kind'] === 'providers' ? list(pins['keys']).filter((key) => typeof key === 'string').join(',') || undefined : undefined;
};

/**
 * Who answered a decision: an explicit orchestrator `by` wins; a user-backed kind, `by:"user"`, or a user quote at the
 * top level or per finding (`{ <id>: { ruling, quote } }`) means the user.
 */
function answeredBy(kind: unknown, answer: unknown): 'user' | 'orchestrator' | undefined {
  if (record(answer) && answer['by'] === 'orchestrator') return 'orchestrator';
  const quoted = (value: unknown): boolean => record(value) && (value['by'] === 'user' || typeof value['quote'] === 'string');
  return USER_DECIDE_KINDS.has(String(kind)) || quoted(answer) || (record(answer) && Object.values(answer).some(quoted)) ? 'user' : undefined;
}

function cliInvocation(phase: string, slot: Record<string, unknown>, value: unknown): InvocationFacts[] {
  if (!record(value)) return [];
  const raw = record(value['usage']) ? value['usage'] : undefined;
  const usage = raw ? normalizeUsage(raw, raw['inputSemantics'] === 'includes-cache' ? 'includes-cache' : 'uncached') : undefined;
  const reported = raw ? list(raw['actualModels']).filter((model): model is string => typeof model === 'string') : [];
  const slotProvider = text(slot['provider']) ?? text(slot['slot'])?.replace(/\[\d+\]$/, '');
  return [{
    phase, provider: text(value['provider']) ?? slotProvider ?? '—', model: text(value['model']) ?? 'default', ...opt('effort', text(value['effort'])), ...opt('mode', text(value['mode'])),
    surface: 'cli', launched: value['launched'] === true, ...opt('durationMs', count(value['durationMs'])), outcome: text(value['outcome']) ?? '—',
    ...opt('usage', usage), ...opt('reportedModels', reported.length ? reported : undefined),
  }];
}

type Accumulator = { key: string; name: string; outcome?: string; wallMs: number; driverMs: number; hostMs: number; userMs: number };

/**
 * Reads one run journal in a single scan: the injected fold sees every line once, while this tap keeps only the
 * fields the report needs. Facts are dispatch-owned; `renderDiagnostics` sanitizes them again before rendering.
 */
export function collectRunFacts(ports: Ports, runDir: string, build: BuildIdentity, foldRun: FoldRun): RunFacts {
  const kept: JournalLine[] = [];
  const read = readJournal(ports, runDir, true);
  const tap = { *[Symbol.iterator]() { for (const line of read.records) { kept.push(compact(line)); yield line; } } };
  const timeline = foldRun(tap);
  const steps = timeline.steps;
  let pointer = -1;
  // Steps and lines both ascend by seq, so a forward pointer finds the step in force at any later seq.
  const stepAt = (seq: number): TimelineStep | undefined => {
    while (pointer + 1 < steps.length && steps[pointer + 1]!.seq <= seq) pointer++;
    return steps[pointer];
  };
  const phases = new Map<string, Accumulator>();
  const convergence = new Map<string, Pick<ReviewFacts, 'reraised' | 'escalation'>>();
  for (const step of steps) for (const phase of step.phases) {
    const entry = phases.get(phase.key) ?? { key: phase.key, name: phase.name, wallMs: 0, driverMs: 0, hostMs: 0, userMs: 0 };
    entry.name = phase.name;
    if (phase.outcome) entry.outcome = phase.outcome; else delete entry.outcome;
    phases.set(phase.key, entry);
    // Review history is cumulative, so the latest step that carries a result holds the whole review's.
    if (phase.reraised || phase.escalation) convergence.set(phase.key, { ...opt('reraised', phase.reraised), ...opt('escalation', phase.escalation) });
  }
  const orphan = { driverMs: 0, hostMs: 0, userMs: 0 };
  const add = (key: string | undefined, part: 'driverMs' | 'hostMs' | 'userMs', ms: number) => {
    const entry = key === undefined ? undefined : phases.get(key);
    if (!entry) { orphan[part] += ms; return; }
    // Time before the first phase existed (booting) belongs to the first phase.
    for (const lost of ['driverMs', 'hostMs', 'userMs'] as const) { entry[lost] += orphan[lost]; entry.wallMs += orphan[lost]; orphan[lost] = 0; }
    entry[part] += ms; entry.wallMs += ms;
  };

  const facts: RunFacts = { ...build, phases: [], hostGaps: [], invocations: [], reviews: [], rejectedEvents: [], orchestratorBytes: timeline.orchestratorBytes };
  const writers = new Map<string, { model?: string; effort?: string }>();
  let host = '—';
  let cursor: { at: number; seq: number } | undefined;
  let repairs = 0, admissionDefects = 0, lastNote: JournalLine | undefined;
  for (const line of kept) {
    const at = Date.parse(line.at);
    if (line.type === 'DIAGNOSTIC_NOTE') {
      lastNote = line;
      // The interpreter journals the reduced class already; re-reducing here and at render keeps older or edited notes safe.
      if (line.data['kind'] === 'event-rejected') facts.rejectedEvents.push({ eventType: HOST_TYPES.has(String(line.data['eventType'])) ? String(line.data['eventType']) : 'UNKNOWN', reason: rejectionReason(line.data['reason']) });
      if (line.data['kind'] === 'fault') {
        const started = count(line.data['sendStartedAt']), failed = count(line.data['failedAt']);
        const boundary = cursor ? stepAt(cursor.seq) : undefined;
        const hostWaitMs = cursor && started !== undefined ? Math.max(0, started - cursor.at) : undefined;
        const driverMs = started !== undefined && failed !== undefined ? Math.max(0, failed - started) : undefined;
        // The rolled-back reply is gone, so only the boundary step can mark the wait as a person's.
        if (hostWaitMs !== undefined && boundary?.user) add(activeKey(boundary), 'userMs', hostWaitMs);
        else if (hostWaitMs !== undefined) { add(activeKey(boundary), 'hostMs', hostWaitMs); facts.hostGaps.push({ await: boundary?.awaiting ?? '—', ms: hostWaitMs }); }
        if (driverMs !== undefined) add(activeKey(boundary), 'driverMs', driverMs);
        // The failed send's appends were rolled back, so the next interval starts where it failed.
        if (cursor && failed !== undefined) cursor = { at: failed, seq: cursor.seq };
        facts.fault = { ...opt('effectId', text(line.data['effectId'])), cls: String(line.data['cls'] ?? '—'), ...opt('hostWaitMs', hostWaitMs), ...opt('driverMs', driverMs) };
      }
      continue;
    }
    lastNote = undefined;
    const before = stepAt(line.seq - 1);
    if (!UNTIMED.has(line.type) && Number.isFinite(at)) {
      if (cursor) {
        const ms = Math.max(0, at - cursor.at), boundary = stepAt(cursor.seq), key = activeKey(boundary);
        const by = line.type === 'DECISION' ? line.data['by'] : undefined;
        if (!HOST_TYPES.has(line.type)) add(key, 'driverMs', ms);
        else if (by === 'user' || (by !== 'orchestrator' && boundary?.user)) add(key, 'userMs', ms);
        else { add(key, 'hostMs', ms); facts.hostGaps.push({ await: boundary?.awaiting ?? '—', ms }); }
      }
      cursor = { at, seq: line.seq };
    }
    const phase = activeKey(before) ?? '';
    const d = line.data;
    switch (line.type) {
      case 'RUN_STARTED': {
        host = text(d['orchestrator']) ?? '—';
        Object.assign(facts, { ...opt('verb', text(d['verb'])), ...opt('level', text(d['level'])), ...opt('pins', pinsOf(d['pins'])), ...opt('config', record(d['config']) ? d['config'] : undefined), host });
        break;
      }
      case 'WAVE_DONE': {
        for (const slot of list(d['slots']).filter(record)) for (const value of list(slot['invocations'])) facts.invocations.push(...cliInvocation(phase, slot, value));
        const name = before?.phases.find((item) => item.key === phase)?.name ?? '';
        const round = count(d['round']);
        if (name.endsWith('review') && round) facts.reviews.push({ phase, round, accepted: 0, rejected: 0 });
        break;
      }
      case 'RULINGS': {
        const review: ReviewFacts | undefined = facts.reviews.filter((item) => item.phase === phase).at(-1);
        if (!review || !record(d['rulings'])) break;
        for (const raw of Object.values(d['rulings'])) {
          const ruling = typeof raw === 'string' ? raw : record(raw) ? raw['ruling'] : undefined;
          if (ruling === 'reject') review.rejected++;
          else if (ruling === 'accept' || ruling === 'downgrade') review.accepted++;
        }
        break;
      }
      case 'NATIVE_RESULTS':
        for (const slot of list(d['slots']).filter(record)) {
          // The receipt mapping attests the launched model and effort; a disclosed substitution makes them differ from the configured ones.
          const mapping = record(slot['mapping']) ? slot['mapping'] : {};
          const model = text(mapping['launcherModel']) ?? text(mapping['configuredModel']) ?? text(slot['model']) ?? '—';
          facts.invocations.push({ phase, provider: host, model, ...opt('effort', text(mapping['launcherEffort'])), surface: 'native', launched: true, outcome: 'ok', estimated: true, ...opt('tokens', count(slot['tokens'])), ...opt('durationMs', count(slot['durationMs'])) });
        }
        break;
      case 'WRITE_LAUNCHED':
        for (const task of list(d['tasks']).filter(record)) {
          writers.set(`${String(task['task'])}#${String(task['attempt'])}`, { ...opt('model', text(task['model'])), ...opt('effort', text(task['effort'])) });
          if ((count(task['attempt']) ?? 1) > 1) repairs++;
        }
        break;
      case 'WRITE_ENVELOPE': case 'WRITE_FAILED': case 'WRITE_CANCELLED': {
        const writer = writers.get(`${String(d['task'])}#${String(d['attempt'])}`);
        const outcome = line.type === 'WRITE_ENVELOPE' ? 'ok' : line.type === 'WRITE_FAILED' ? 'failed' : 'cancelled';
        facts.invocations.push({ phase, provider: host, model: text(d['model']) ?? writer?.model ?? '—', ...opt('effort', writer?.effort), mode: 'write', surface: 'native', launched: true, outcome, estimated: true, ...opt('tokens', count(d['tokens'])), ...opt('durationMs', count(d['durationMs'])) });
        break;
      }
      case 'ENVELOPE_CHECKED': admissionDefects += list(d['defects']).length; break;
      case 'RETRO': facts.observations = d['observations']; break;
      default: break;
    }
  }
  const last = steps.at(-1);
  facts.outcome = last?.awaiting === 'done' ? last.outcome ?? 'partial' : lastNote?.data['kind'] === 'fault' ? 'fault' : 'in-progress';
  facts.phases = [...phases.values()].map((entry): PhaseFacts => entry);
  for (const [key, result] of convergence) {
    const review = facts.reviews.filter((item) => item.phase === key).at(-1);
    if (review) Object.assign(review, result);
  }
  if (repairs) facts.repairs = repairs;
  if (admissionDefects) facts.admissionDefects = admissionDefects;
  return facts;
}

/** Keeps a journal line's identity and only the payload fields the collector reads, bounding memory on long runs. */
function compact(line: JournalLine): JournalLine {
  const slots = (keep: (slot: Record<string, unknown>) => Record<string, unknown>) => list(line.data['slots']).filter(record).map(keep);
  switch (line.type) {
    case 'RUN_STARTED': case 'RULINGS': case 'WRITE_LAUNCHED': case 'WRITE_ENVELOPE': case 'WRITE_FAILED': case 'WRITE_CANCELLED': case 'DIAGNOSTIC_NOTE': case 'RETRO':
      return line;
    case 'WAVE_DONE': return { ...line, data: { round: line.data['round'], slots: slots((slot) => ({ ...opt('slot', slot['slot']), ...opt('provider', slot['provider']), ...opt('invocations', slot['invocations']) })) } };
    case 'NATIVE_RESULTS': return { ...line, data: { slots: slots((slot) => {
      const mapping = record(slot['mapping']) ? slot['mapping'] : {};
      return { ...opt('model', slot['model']), mapping: { ...opt('launcherModel', mapping['launcherModel']), ...opt('launcherEffort', mapping['launcherEffort']), ...opt('configuredModel', mapping['configuredModel']) }, ...opt('tokens', slot['tokens']), ...opt('durationMs', slot['durationMs']) };
    }) } };
    // Only the answerer survives, so nested per-finding quotes still classify the wait after the answer is dropped.
    case 'DECISION': return { ...line, data: opt('by', answeredBy(line.data['kind'], line.data['answer'])) };
    case 'ENVELOPE_CHECKED': return { ...line, data: { defects: list(line.data['defects']).map(() => 0) } };
    default: return { ...line, data: {} };
  }
}

// SECTION: Report

/**
 * Renders `<session>/diagnostics.md` from every session journal. Callers hold their own run lock; concurrent runs
 * are last-writer-wins and the next run-end render heals a stale snapshot. Failures warn and return null.
 */
export function renderSessionDiagnostics(ports: Ports, runDir: string, build: BuildIdentity, foldRun: FoldRun, warn: () => void = diagnosticWarning(ports)): DiagnosticReport | null {
  try {
    const session = sessionOf(runDir);
    const runsDir = path.join(session, '.state', 'runs');
    const runs = session === runDir ? [runDir] : ports.fs.listFiles(runsDir).map((file) => file.replaceAll('\\', '/')).filter((file) => RUN_JOURNAL.test(file)).sort().map((file) => path.join(runsDir, path.dirname(file)));
    const facts: RunFacts[] = [];
    for (const dir of runs) {
      try { facts.push(collectRunFacts(ports, dir, build, foldRun)); } catch { warn(); }
    }
    const rendered = renderDiagnostics(facts);
    const file = path.join(session === runDir ? runDir.replace(/[\\/]+$/, '') : session, 'diagnostics.md');
    ports.fs.writeAtomic(file, rendered.text);
    return { path: file.replaceAll('\\', '/'), findings: rendered.findings, ...opt('top', rendered.top) };
  } catch { warn(); return null; }
}

// SECTION: Frames

/**
 * Adds diagnostics data to three frame kinds only. A `retro` frame always carries its instruction, because entering
 * retro is already journaled; `native`/`write` hints and the `done` report need the toggle on.
 */
export function diagnosticFrame(frame: Frame, enabled: boolean, report: DiagnosticReport | null | undefined, instruction: string): Frame {
  if (frame.await === 'retro') return { ...frame, data: { ...frame.data, diagnostics: { instruction } } };
  if (!enabled) return frame;
  if (frame.await === 'native' || frame.await === 'write') return { ...frame, data: { ...frame.data, diagnostics: { attest: [...ATTEST_HINT] } } };
  if (frame.await === 'done' && report && report.findings > 0) return { ...frame, data: { ...frame.data, diagnostics: { path: report.path, findings: report.findings } } };
  return frame;
}
