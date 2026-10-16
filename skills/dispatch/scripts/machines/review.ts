// Reusable review sub-machine (spec §5.5, §7): prepare → wave → [native] → rule → [fix → fix-verify] → next?.
// Pure reducer; rounds policy lives in policy/rounds.ts. Parents embed `ReviewState` and forward events via `stepReview`.

import type { ChangeNotice, ReviewManifestRef, Effect, Event, FindingId, HostEvent, Level, Machine, ReviewObservation, ReviewUse, RunStartedEvent, SpecIdentity } from '../core/types.ts';
import { clusterFixes, orderFixClusters, splitFailedCluster, type FixCluster } from '../domain/fix-clustering.ts';
import { findingId } from '../domain/report.ts';
import { statusLabel } from '../domain/render.ts';
import type { Finding, ResolutionRound, ResolutionStatus, ReviewKind, ReviewerView, RosterSlot } from '../domain/types.ts';
import { resolveRoster, type PhasePolicy, type Pins, type ReadDelegate } from '../policy/roster.ts';
import {
  acceptByOmission, assignAffinity, convergence, exitSummary, nextRound, orchestratorClosures, roundsPolicy, threshold,
  type ExitSummary, type HistoryEntry, type RoundFinding, type RoundScope,
} from '../policy/rounds.ts';
import {
  answers, asFinding, asNativeCapture, asNativeSlot, asRuling, isAccepted, isRecord, isString, launchMismatch, never, nextId, staleGoverning, stay,
  type ScopeRequest, type CarriedRejection, type Counters, type Decide, type NativeSlot, type ReviewFinding, type ReviewSpec, type Ruling, type SettledRow, type Step,
} from './types.ts';
import { writerConfig } from './implement-types.ts';

export const DEFAULT_TIMEOUT_MS = 600_000;

export const defaultTimeoutMs = (level: Level): number => level === 'high' ? 1_200_000 : level === 'xhigh' || level === 'max' ? 1_800_000 : DEFAULT_TIMEOUT_MS;

// SECTION: Spec resolution (shared with ask and plan)

type Row = Readonly<Record<string, unknown>>;

function asPins(value: unknown): Pins | null {
  if (!isRecord(value)) return null;
  if (value['kind'] === 'all') return { kind: 'all' };
  if (value['kind'] === 'count' && typeof value['count'] === 'number') return { kind: 'count', count: value['count'] };
  if (value['kind'] === 'providers' && Array.isArray(value['keys'])) return { kind: 'providers', keys: value['keys'].filter(isString) };
  return null;
}

export type Slots = { ok: true; roster: RosterSlot[]; cap: number; breadth: number | 'all'; timeoutMs: number } | { ok: false; error: string };

/** Roster, round cap, and breadth for a phase (`undefined` → standalone default: one target, one round). */
export function resolveSlots(run: RunStartedEvent, phase: 'plan-review' | 'code-review' | undefined): Slots {
  const config = run.config;
  const delegates = isRecord(config['read-delegates']) ? (config['read-delegates'] as Readonly<Record<string, ReadDelegate>>) : {};
  const phases = isRecord(config['phases']) ? config['phases'] : {};
  const policy = phase && isRecord(phases[phase]) ? (phases[phase] as PhasePolicy) : undefined;
  const pins = asPins(run.pins);
  const level: Level = run.level;
  const rounds = roundsPolicy(policy, level, pins !== null);
  const overrides: { model?: string; effort?: string } = {};
  if (isString(run.overrides['model'])) overrides.model = run.overrides['model'];
  if (isString(run.overrides['effort'])) overrides.effort = run.overrides['effort'];
  const timeout = run.overrides['timeout'];
  const timeoutMs = typeof timeout === 'number' && timeout > 0 ? timeout * 1000 : defaultTimeoutMs(level);
  try {
    const input: Parameters<typeof resolveRoster>[0] = { level, readDelegates: delegates, pins, overrides, orchestrator: { platform: run.orchestrator, model: run.orchestratorModel } };
    if (policy) input.policy = policy;
    const roster = resolveRoster(input);
    const cap = rounds.enabled ? rounds.cap : 0;
    // NOTE: ask (no phase) and active review phases need a reviewer; only a rounds-zero skip may run without one.
    if ((phase === undefined || cap > 0) && roster.targets.length === 0) return { ok: false, error: 'no read delegate resolved for an active phase' };
    return { ok: true, roster: [...roster.targets, ...roster.reserves], cap, breadth: rounds.enabled ? rounds.targets : 0, timeoutMs };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export const phaseOf = (kind: ReviewKind): 'plan-review' | 'code-review' => (kind === 'code' ? 'code-review' : 'plan-review');

export function reviewSpecFromRun(run: RunStartedEvent, kind: ReviewKind, target: string, governingSpec: SpecIdentity | null = null): { ok: true; spec: ReviewSpec } | { ok: false; error: string } {
  const slots = resolveSlots(run, phaseOf(kind));
  if (!slots.ok) return slots;
  const context = null;
  const sessionDir = isString(run.overrides['sessionDir']) ? run.overrides['sessionDir'] : undefined;
  const governing = isRecord(run.overrides['governing']) ? run.overrides['governing'] as ReviewSpec['governing'] : undefined;
  const writer = writerConfig(run.config, run.orchestrator, run.level);
  return { ok: true, spec: { kind, target, cap: slots.cap, breadth: slots.breadth, context, roster: slots.roster, timeoutMs: slots.timeoutMs, writer: writer.ok ? writer.value : null, ...(sessionDir ? { sessionDir } : {}), ...(governing ? { governing } : {}), ...(governingSpec ? { governingSpec } : {}) } };
}

// SECTION: Waves (shared with ask)

/** Wave-1 roster: every slot with its prepared prompt path and the review kind the wave parses for. */
export function waveRoster(roster: readonly RosterSlot[], review: ReviewKind | 'ask', promptPaths: Readonly<Record<string, string>>): Row[] {
  return roster.map((slot) => ({ ...slot, review, promptPath: promptPaths[slot.slot] ?? '' }));
}

/** A wave-1 row the single-shot wave marked for the host: `state: 'native'` with its descriptor and no capture yet. */
export function pendingNative(rows: readonly Row[]): NativeSlot[] {
  return rows.flatMap((row) => (row['state'] === 'native' && row['descriptor'] !== undefined ? [asNativeSlot(row['descriptor'])].filter((slot): slot is NativeSlot => slot !== null) : []));
}

/** Wave-2 roster: exactly the native slots, each carrying its host capture (matched by `sourceKey ?? slot`). */
export function nativeRoster(slots: readonly NativeSlot[], results: readonly unknown[], review: ReviewKind | 'ask'): Row[] {
  const captures = results.map(asNativeCapture).filter((capture) => capture !== null);
  return slots.map((descriptor, index) => {
    const slot = descriptor.substitutesFor ?? descriptor.sourceKey;
    const capture = captures.find((entry) => (entry.sourceKey ?? entry.slot) === descriptor.sourceKey)
      ?? captures.find((entry) => entry.sourceKey === undefined && entry.slot === slot)
      ?? { slot, sourceKey: descriptor.sourceKey, outputPath: descriptor.outputPath };
    return { slot, provider: 'native', index, native: true, reserve: false, review, sourceKey: descriptor.sourceKey, capture: { ...capture, sourceKey: descriptor.sourceKey } };
  });
}

/** Stamps each accepted capture with its descriptor's `sourceKey`; wave-finish matches captures only by that key. */
export function keyedCaptures(slots: readonly unknown[], descriptors: readonly NativeSlot[]): unknown[] {
  return slots.map((value) => {
    const capture = asNativeCapture(value);
    if (!capture || capture.sourceKey !== undefined) return value;
    const descriptor = descriptors.find((entry) => entry.sourceKey === capture.slot) ?? descriptors.find((entry) => (entry.substitutesFor ?? entry.sourceKey) === capture.slot);
    return descriptor && isRecord(value) ? { ...value, sourceKey: descriptor.sourceKey } : value;
  });
}

export function validateNativeResults(slots: readonly unknown[], descriptors: readonly NativeSlot[] = []): string | null {
  const matched = new Set<string>();
  for (const [index, value] of slots.entries()) {
    const capture = asNativeCapture(value);
    if (capture === null) return `event.slots[${index}]: expected { slot, outputPath, sourceKey? }`;
    if (!descriptors.length) continue;
    const descriptor = descriptors.find((entry) => entry.sourceKey === (capture.sourceKey ?? capture.slot)) ?? descriptors.find((entry) => capture.sourceKey === undefined && (entry.substitutesFor ?? entry.sourceKey) === capture.slot);
    if (!descriptor || matched.has(descriptor.sourceKey)) return `event.slots[${index}]: expected one capture per pending native slot; ${descriptor ? 'duplicate' : 'unknown'} ${capture.sourceKey ?? capture.slot}.`;
    matched.add(descriptor.sourceKey);
    const mapping = isRecord(capture.mapping) ? capture.mapping : {};
    const mismatch = launchMismatch({ model: descriptor['model'], effort: descriptor['reasoningEffort'] }, { model: mapping['launcherModel'], effort: mapping['launcherEffort'], substitution: mapping['substitution'] });
    if (mismatch) return `event.slots[${index}].mapping: ${mismatch}.`;
  }
  // NOTE: omitted captures would otherwise be synthesized from descriptor output paths with no launch attestation.
  const missing = descriptors.filter((entry) => !matched.has(entry.sourceKey)).map((entry) => entry.sourceKey);
  return missing.length ? `event.slots: missing captures for pending native slots ${missing.join(', ')}.` : null;
}

// SECTION: State

export type RoundRecord = { round: number; scope: RoundScope; reviewers: readonly (string | ReviewerView)[]; failed: readonly { slot: string; reason: string }[]; revision?: string };

export type ReviewCtx = {
  pendingSpec?: ReviewSpec;
  spec: ReviewSpec;
  path: string;
  counters: Counters;
  effectId: string | null;
  round: number;
  preparedRound?: number;
  scope: RoundScope;
  scopeOverride?: Partial<Pick<ScopeRequest, 'scope' | 'sinceHash' | 'priorTarget'>>;
  carried: readonly CarriedRejection[];
  findings: readonly ReviewFinding[];
  history: readonly HistoryEntry[];
  rounds: readonly RoundRecord[];
  fixes: readonly { id: FindingId; round: number }[];
  optInAsked: boolean;
  promptPaths: Readonly<Record<string, string>>;
  /** This round's reconciled wave rows and findings (wave 1, then merged native wave 2). */
  rows: readonly Row[];
  drafts: readonly Finding[];
  priorManifest?: string;
  priorManifestRef?: ReviewManifestRef | undefined;
  targetManifest?: string;
  targetManifestRef?: ReviewManifestRef | undefined;
  reviewedRevision?: string;
  findingBindings?: Readonly<Record<string, string>>;
  fixCandidate?: string;
  fixCandidateRef?: ReviewManifestRef | undefined;
  waveBinding?: { waveKey: string; attempt: number; roster: readonly Row[] };
  /** Target binding the current wave launched against; its findings stay bound to it even if the target changes before receipt. */
  waveRevision?: string;
  /** Target changes seen during the review; each may carry the host's applicability selection. */
  observations?: readonly ReviewObservation[];
  /** Observation whose targeted or full review launches at the next round boundary. */
  requested?: string;
  /** Set by a spec rebind outside rule/decide; the next prepared round uses full scope. */
  forceFullScope?: boolean;
};

export type Pass = 'main' | 'opt-in';
export type Escalation = { kind: 'regression' | 'deadlock'; ids: readonly FindingId[] };

export type ReviewState =
  | { tag: 'pin-check'; c: ReviewCtx; effectId: string; pending: Extract<Effect, { kind: 'prepare-review' }> }
  | { tag: 'target-check'; c: ReviewCtx; before: Exclude<ReviewState, { tag: 'target-check' }>; pending: Event; effectId: string }
  | { tag: 'booting'; counters: Counters }
  | { tag: 'prepare'; c: ReviewCtx }
  | { tag: 'wave'; c: ReviewCtx; phase: 'cli' | 'native' }
  | { tag: 'native'; c: ReviewCtx; slots: readonly NativeSlot[] }
  | { tag: 'rule'; c: ReviewCtx }
  | { tag: 'decide-needs-user'; c: ReviewCtx; ids: readonly FindingId[] }
  | { tag: 'fix'; c: ReviewCtx; clusters: readonly FixCluster[]; pass: Pass; defects: readonly string[] }
  | { tag: 'fix-verify'; c: ReviewCtx; clusters: readonly FixCluster[]; pass: Pass; pendingClusters?: readonly FixCluster[]; exhausted?: readonly FindingId[] }
  | { tag: 'decide-escalation'; c: ReviewCtx; escalation: Escalation }
  | { tag: 'decide-opt-in'; c: ReviewCtx; items: readonly FindingId[] }
  | { tag: 'decide-verification'; c: ReviewCtx; clusters: readonly FixCluster[]; pass: Pass; pendingClusters?: readonly FixCluster[]; exhausted?: readonly FindingId[]; failures: readonly VerificationFailure[] }
  | { tag: 'settled'; c: ReviewCtx; exit: ExitSummary; followUps: readonly string[] }
  | { tag: 'escalated'; c: ReviewCtx; escalation: Escalation }
  | { tag: 'failed'; c: ReviewCtx; detail: string; code?: 'stale-spec' | 'stale-design-spec' }
  | { tag: 'skipped'; c: ReviewCtx }
  | { tag: 'empty'; c: ReviewCtx };

export type VerificationFailure = { command: string; exit: number; logPath: string };

export type ReviewTag = ReviewState['tag'];
export const REVIEW_TERMINALS: readonly ReviewTag[] = ['settled', 'escalated', 'failed', 'skipped', 'empty'];
export const isReviewTerminal = (state: ReviewState): boolean => REVIEW_TERMINALS.includes(state.tag);

type S = Step<ReviewState>;

function withEffect(c: ReviewCtx, kind: Effect['kind'], build: (id: string) => Effect): { c: ReviewCtx; effect: Effect } {
  const { id, counters } = nextId(c.counters, c.path, kind);
  return { c: { ...c, counters, effectId: id }, effect: build(id) };
}

// SECTION: Entry

/** Starts a review at `path` (e.g. `review`, `plan.review`); `cap = 0` → `skipped` with no effect. */
export function beginReview(spec: ReviewSpec, path: string, counters: Counters, cumulativeOffset = 0, scopeOverride?: ReviewCtx['scopeOverride']): S {
  const c: ReviewCtx = {
    ...(scopeOverride ? { scopeOverride } : {}), spec, path, counters, effectId: null, round: cumulativeOffset, scope: 'full', carried: [], findings: [], history: [], rounds: [], fixes: [],
    optInAsked: false, promptPaths: {}, rows: [], drafts: [],
  };
  if (spec.cap <= 0) return stay({ tag: 'skipped', c });
  return prepare(c, cumulativeOffset + 1, 'full', []);
}

/** Statuses whose ruling stands; pending, superseded, and duplicate findings are not settled decisions. */
const SETTLED: readonly ReviewFinding['status'][] = ['accepted', 'downgraded', 'fixed', 'rejected', 'closed-by-reviewer', 'closed-by-orchestrator'];

/** Prior-round rulings that reviewers re-raise only with new evidence. */
function settledRows(findings: readonly ReviewFinding[], round: number): SettledRow[] {
  return findings.filter((finding) => finding.round < round && SETTLED.includes(finding.status))
    .map((finding) => ({ id: finding.id, locus: finding.locus, defect: finding.defect, ruling: statusLabel(statusOf(finding)), reason: finding.resolution ?? '', ...(finding.revision ? { revision: finding.revision } : {}) }));
}

function prepare(c0: ReviewCtx, round: number, scope: RoundScope, carried: readonly CarriedRejection[], requested?: ReviewUse): S {
  // NOTE: any prepare consumes the rebind flag; the round it prepares is the one that honors it.
  const { pendingSpec, forceFullScope: _forced, scopeOverride, ...bound } = c0;
  scope = scopeOverride?.scope ?? scope;
  const base = { ...bound, spec: pendingSpec ?? c0.spec, preparedRound: round, scope, carried, rows: [], drafts: [], promptPaths: {} };
  const settled = settledRows(base.findings, round);
  const affectedPaths = [...new Set([...base.findings.filter((finding) => finding.round === c0.round && finding.status === 'fixed').flatMap((finding) => finding.fix?.paths ?? []), ...(requested?.paths ?? [])])];
  const selection = requested ? { requested: { observationId: requested.observationId, afterHash: requested.afterHash, action: requested.action, paths: [...(requested.paths ?? [])] } } : {};
  const { c, effect } = withEffect(base, 'prepare-review', (id) => ({ kind: 'prepare-review', id, review: base.spec, round, scope: { scope, carried, ...(settled.length ? { settled } : {}), affectedPaths, ...selection, ...(base.priorManifest ? { priorManifest: base.priorManifest, priorManifestRef: base.priorManifestRef } : {}), ...scopeOverride } }));
  if (c.spec.governingSpec && (c.spec.kind === 'plan' || c.spec.kind === 'design')) {
    const next = nextId(c.counters, c.path, 'parse-artifact');
    return { state: { tag: 'pin-check', c: { ...c, counters: next.counters }, effectId: next.id, pending: effect as Extract<Effect, { kind: 'prepare-review' }> },
      effects: [{ kind: 'parse-artifact', id: next.id, path: c.spec.target, artifact: c.spec.kind, governing: c.spec.governingSpec.path }] };
  }
  return { state: { tag: 'prepare', c }, effects: [effect] };
}

/** Current target binding: the latest checked revision, else the prepared manifest. */
const liveRevision = (c: ReviewCtx): string | undefined => c.reviewedRevision ?? c.targetManifest;

function launchWave(c1: ReviewCtx, roster: readonly Row[], phase: 'cli' | 'native'): S {
  const { preparedRound, ...bound } = c1;
  const launched = phase === 'cli' && preparedRound !== undefined;
  const round = launched ? preparedRound : c1.round;
  const selected = launched && c1.requested;
  const ready: ReviewCtx = { ...bound, round, ...(selected ? { observations: (c1.observations ?? []).map((row) => row.id === selected && row.use ? { ...row, use: { ...row.use, launchedRound: round } } : row) } : {}) };
  if (selected) delete ready.requested;
  // NOTE: the native second wave completes the same round, so it keeps the first wave's launch revision.
  const revision = phase === 'cli' ? liveRevision(ready) : undefined;
  const c0 = revision ? { ...ready, waveRevision: revision } : ready;
  const { c, effect } = withEffect(c0, 'wave', (id) => ({ kind: phase === 'native' ? 'wave' : 'wave-start', id, round: c0.round, roster: [...roster], timeoutMs: c0.spec.timeoutMs }));
  return { state: { tag: 'wave', c, phase }, effects: [effect] };
}

// SECTION: Wave → rule

function finishReviewWave(c0: ReviewCtx, captures: readonly Row[]): S {
  const binding = c0.waveBinding!;
  const { c, effect } = withEffect(c0, 'wave-finish', (id) => ({ kind: 'wave-finish', id, round: c0.round, roster: [...binding.roster], timeoutMs: c0.spec.timeoutMs, waveKey: binding.waveKey, attempt: binding.attempt, captures: [...captures] }));
  return { state: { tag: 'wave', c, phase: 'cli' }, effects: [effect] };
}

function renumber(round: number, base: number, findings: readonly Finding[]): Finding[] {
  const ids = new Map(findings.map((finding, index) => [finding.id, findingId(round, base + index + 1)]));
  return findings.map((finding) => {
    const out: Finding = { ...finding, id: ids.get(finding.id) ?? finding.id };
    if (finding.dupOf !== undefined) out.dupOf = ids.get(finding.dupOf) ?? finding.dupOf;
    return out;
  });
}

const matchKey = (finding: Finding) => ({ locus: finding.locus, category: finding.category, text: `${finding.defect} ${finding.requiredChange}` });

function onWaveDone(state: Extract<ReviewState, { tag: 'wave' }>, event: Extract<Event, { type: 'WAVE_DONE' }>): S {
  const rows = event.slots;
  const findings = event.findings.map(asFinding).filter((finding) => finding !== null);
  if (state.phase === 'cli') {
    const pending = pendingNative(rows);
    const c = { ...state.c, rows: rows.filter((row) => !(row['state'] === 'native' && row['descriptor'] !== undefined)), drafts: findings };
    if (pending.length) return stay({ tag: 'native', c, slots: pending });
    return afterWave(c);
  }
  const c = { ...state.c, rows: [...state.c.rows, ...rows], drafts: [...state.c.drafts, ...renumber(state.c.round, state.c.drafts.length, findings)] };
  return afterWave(c);
}

function failureReasonOf(row: Row): string {
  if (typeof row['reason'] === 'string' && row['reason']) return row['reason'];
  if (typeof row['record'] === 'string' && row['record']) return row['record'].replace(/^.*?→.*?:\s*/, '');
  if (typeof row['cls'] === 'string' && row['cls']) return row['cls'];
  return 'failed';
}

function reviewerViewOf(row: Row, roster: readonly RosterSlot[]): ReviewerView {
  const slot = String(row['by'] ?? row['slot']);
  const rosterSlot = roster.find((s) => s.slot === slot);
  const model = typeof row['model'] === 'string' && row['model']
    ? row['model']
    : typeof rosterSlot?.model === 'string'
      ? rosterSlot.model
      : undefined;
  const effort = typeof row['effort'] === 'string' && row['effort']
    ? row['effort']
    : typeof rosterSlot?.effort === 'string'
      ? rosterSlot.effort
      : undefined;
  return {
    slot,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

function afterWave(c0: ReviewCtx): S {
  const round = c0.round;
  const usable = c0.rows.filter((row) => ['success', 'reserve', 'native'].includes(String(row['state'])) && row['descriptor'] === undefined);
  const reviewers = usable.map((row) => reviewerViewOf(row, c0.spec.roster));
  const failed = [
    ...c0.rows.filter((row) => row['state'] === 'failed').map((row) => ({ slot: String(row['slot']), reason: failureReasonOf(row) })),
    ...c0.rows.filter((row) => row['state'] === 'reserve').map((row) => ({ slot: String(row['slot']), reason: failureReasonOf(row) })),
  ];
  const revision = c0.waveRevision ?? liveRevision(c0);
  const bound = revision ? { revision } : {};
  const fresh: ReviewFinding[] = c0.drafts.map((finding) => ({ ...finding, round, status: finding.dupOf === undefined ? 'open' : 'duplicate', ...bound }));
  const c1: ReviewCtx = { ...c0, findingBindings: { ...c0.findingBindings, ...Object.fromEntries(fresh.map((row) => [row.id, revision ?? 'unbound'])) }, rounds: [...c0.rounds, { round, scope: c0.scope, reviewers, failed, ...bound }] };
  const uncovered = c0.carried.filter((entry) => entry.slot === null || !usable.some((row) => row['slot'] === entry.slot || row['substitutesFor'] === entry.slot || row['by'] === entry.slot));
  if (!reviewers.length || uncovered.length) return stay({ tag: 'failed', c: c1, detail: `reviewer-coverage: ${uncovered.length ? `responsible reviewer unavailable for ${uncovered.map((entry) => entry.id).join(', ')}` : 'no usable reviewer capture'}` });
  const verdict = convergence(fresh.filter((finding) => finding.status === 'open').map(matchKey), c0.history);
  if (verdict.halt) return stay({ tag: 'decide-escalation', c: { ...c1, findings: [...c1.findings, ...fresh] }, escalation: verdict.escalation });
  const reraised = new Set(verdict.reraised);
  const covered = c0.carried.filter((entry) => !uncovered.includes(entry)).map((entry) => entry.id);
  const closed = new Set(acceptByOmission(c0.carried.map((entry) => entry.id), verdict.reraised, covered).map((closure) => closure.id));
  const findings = c1.findings.map((finding): ReviewFinding => {
    if (closed.has(finding.id)) return { ...finding, status: 'closed-by-reviewer' };
    if (reraised.has(finding.id)) return { ...finding, status: 'superseded' };
    return finding;
  });
  const history = c1.history.map((entry) => (reraised.has(entry.id) ? { ...entry, reraises: entry.reraises + 1 } : entry));
  const c: ReviewCtx = { ...c1, findings: [...findings, ...fresh], history };
  if (!fresh.some((finding) => finding.status === 'open')) return decideNext(c);
  return stay({ tag: 'rule', c });
}

// SECTION: Rulings

const roundOpen = (c: ReviewCtx) => c.findings.filter((finding) => finding.round === c.round && finding.status === 'open');
/** A known user answer settles an intent finding directly, with the needs-user decision semantics. */
const userRuled = (ruling: Ruling): ruling is Ruling & { quote: string } => (ruling.ruling === 'accept' || ruling.ruling === 'reject') && ruling.quote !== undefined;
const orchestratorRuled = (ruling: Ruling): ruling is Ruling & { reason: string } => (ruling.ruling === 'accept' || ruling.ruling === 'reject') && ruling.by === 'orchestrator' && !!ruling.reason?.trim();

export function validateRulings(c: ReviewCtx, rulings: Readonly<Record<string, unknown>>): string | null {
  const open = roundOpen(c);
  for (const id of Object.keys(rulings)) if (!open.some((finding) => finding.id === id)) return `event.rulings.${id}: no open finding ${id} in round ${c.round}`;
  for (const finding of open) {
    const raw = rulings[finding.id];
    if (raw === undefined) return `event.rulings: missing ruling for ${finding.id}; every finding must be ruled`;
    const ruling = asRuling(raw);
    if (!ruling) return `event.rulings.${finding.id}.ruling: expected accept|reject|downgrade|needs-user`;
    if (finding.category === 'intent' && ruling.ruling !== 'needs-user') {
      if (!userRuled(ruling) && !orchestratorRuled(ruling)) return `event.rulings.${finding.id}.ruling: expected needs-user, accept|reject with the user's quote, or accept|reject by orchestrator with a reason, for an intent finding`;
      continue; // NOTE: recorded authority settles intent directly.
    }
    if ((ruling.ruling === 'reject' || ruling.ruling === 'downgrade') && !ruling.reason?.trim()) return `event.rulings.${finding.id}.reason: expected a nonblank reason for ${ruling.ruling}`;
  }
  return null;
}

function onRulings(c0: ReviewCtx, rulings: Readonly<Record<string, unknown>>): S {
  if (validateRulings(c0, rulings) !== null) return stay({ tag: 'rule', c: c0 });
  const findings = c0.findings.map((finding): ReviewFinding => {
    if (finding.round !== c0.round || finding.status !== 'open') return finding;
    const ruling = asRuling(rulings[finding.id]);
    if (!ruling) return finding;
    if (finding.category === 'intent' && (userRuled(ruling) || orchestratorRuled(ruling))) {
      const ruled = { ...finding, resolution: userRuled(ruling) ? `user: ${ruling.quote}` : `orchestrator: ${ruling.reason}`, ...(ruling.fix ? { fix: ruling.fix } : {}) };
      return { ...ruled, status: ruling.ruling === 'accept' ? 'accepted' : 'rejected' };
    }
    const resolution = { ...(ruling.reason === undefined ? {} : { resolution: ruling.reason }), ...(ruling.fix ? { fix: ruling.fix } : {}) };
    switch (ruling.ruling) {
      case 'accept': return { ...finding, ...resolution, status: 'accepted' };
      case 'downgrade': return { ...finding, ...resolution, severity: ruling.severity ?? finding.severity, status: 'downgraded' };
      case 'needs-user': return { ...finding, ...resolution, status: 'needs-user' };
      case 'reject': {
        const disputed = finding.scope === 'in' && (finding.severity === 'MUST' || finding.severity === 'SHOULD');
        return { ...finding, ...resolution, status: disputed ? 'pending-rejection' : 'rejected' };
      }
      default: return never(ruling.ruling, 'ruling');
    }
  });
  const c = { ...c0, findings };
  const ids = findings.filter((finding) => finding.round === c.round && finding.status === 'needs-user').map((finding) => finding.id);
  if (ids.length) return stay({ tag: 'decide-needs-user', c, ids });
  return afterRulings(c);
}

const fixable = (finding: ReviewFinding): boolean => finding.scope === 'in' && isAccepted(finding) && (finding.severity !== 'CONSIDER' || (finding.fix?.paths.length ?? 0) > 0);

function afterRulings(c: ReviewCtx): S {
  const batch = c.findings.filter((finding) => finding.round === c.round && fixable(finding));
  if (batch.length) return enterFix(c, batch, 'main');
  return decideNext(c);
}

// SECTION: Fix

const locusPath = (c: ReviewCtx, locus: string): string => (c.spec.kind === 'code' ? locus.replace(/:L\d+.*$/, '') : c.spec.target);
/** Paths a fix may touch: the ruled fix paths for code (else the locus file); the reviewed file for artifacts. */
const fixPaths = (c: ReviewCtx, finding: ReviewFinding): string[] => (c.spec.kind === 'code' ? (finding.fix?.paths.length ? [...finding.fix.paths] : [locusPath(c, finding.locus)]) : [c.spec.target]);

function enterFix(c: ReviewCtx, findings: readonly ReviewFinding[], pass: Pass): S {
  const ids = new Set(findings.map((finding) => finding.id));
  try {
    const clusters = clusterFixes(findings.map((finding) => ({
      id: finding.id,
      paths: finding.fix?.paths.length ? finding.fix.paths : [locusPath(c, finding.locus)],
      dependencies: (finding.fix?.dependencies ?? []).filter((id) => ids.has(id)),
      verification: finding.fix?.verification ?? [],
    })), { runId: c.path });
    return stay({ tag: 'fix', c, clusters, pass, defects: [] });
  } catch (error) {
    return stay({ tag: 'failed', c, detail: error instanceof Error ? error.message : String(error) });
  }
}

export function validateFixes(clusters: readonly FixCluster[], results: readonly unknown[]): string | null {
  const known = new Set(clusters.map((cluster) => cluster.clusterId));
  const seen = new Set<string>();
  for (const [index, value] of results.entries()) {
    if (!isRecord(value) || !isString(value['clusterId'])) return `event.clusters[${index}].clusterId: expected a cluster id`;
    if (!known.has(value['clusterId'])) return `event.clusters[${index}].clusterId: unknown cluster ${value['clusterId']}`;
    if (seen.has(value['clusterId'])) return `event.clusters[${index}].clusterId: duplicate cluster ${value['clusterId']}`;
    seen.add(value['clusterId']);
    if (value['status'] !== undefined && value['status'] !== 'applied' && value['status'] !== 'failed') return `event.clusters[${index}].status: expected applied|failed`;
    const withdrawError = validateWithdrawn(clusters.find((cluster) => cluster.clusterId === value['clusterId'])!, value, index);
    if (withdrawError) return withdrawError;
  }
  const missing = clusters.find((cluster) => !results.some((value) => isRecord(value) && value['clusterId'] === cluster.clusterId));
  if (missing) return `event.clusters: missing result for ${missing.clusterId}`;
  const failed = new Set(results.filter((value) => isRecord(value) && value['status'] === 'failed').map((value) => (value as Row)['clusterId']));
  const blocked = new Set(failed);
  for (const cluster of orderFixClusters(clusters)) if (cluster.dependsOnClusters.some((id) => blocked.has(id))) blocked.add(cluster.clusterId);
  const invalid = clusters.find((cluster) => blocked.has(cluster.clusterId) && !failed.has(cluster.clusterId));
  return invalid ? `event.clusters: ${invalid.clusterId} cannot be applied while a prerequisite failed` : null;
}

/** A user reversal after acceptance withdraws a finding from an applied cluster; it is recorded as a user rejection, not a fix. */
function validateWithdrawn(cluster: FixCluster, value: Row, index: number): string | null {
  const withdrawn = value['withdrawn'];
  if (withdrawn === undefined) return null;
  if (!Array.isArray(withdrawn)) return `event.clusters[${index}].withdrawn: expected [{ findingId, quote }]`;
  if (value['status'] === 'failed') return `event.clusters[${index}].withdrawn: expected status applied`;
  for (const [entry, row] of withdrawn.entries()) {
    if (!isRecord(row) || !isString(row['findingId']) || !cluster.findingIds.includes(row['findingId'])) return `event.clusters[${index}].withdrawn[${entry}].findingId: expected a finding of ${cluster.clusterId}`;
    if (!isString(row['quote']) || !row['quote'].trim()) return `event.clusters[${index}].withdrawn[${entry}].quote: expected the user's words`;
  }
  return null;
}

function withdrawnQuotes(results: readonly unknown[]): Map<string, string> {
  return new Map(results.flatMap((value) => isRecord(value) && Array.isArray(value['withdrawn']) ? value['withdrawn'].filter(isRecord).map((row) => [String(row['findingId']), String(row['quote'])] as const) : []));
}

function onFixesApplied(state0: Extract<ReviewState, { tag: 'fix' }>, results: readonly unknown[]): S {
  const quotes = withdrawnQuotes(results);
  const state = quotes.size ? { ...state0,
    c: { ...state0.c, findings: state0.c.findings.map((finding): ReviewFinding => quotes.has(finding.id) ? { ...finding, status: 'rejected', resolution: `user: ${quotes.get(finding.id)}` } : finding) },
    clusters: state0.clusters.map((cluster) => ({ ...cluster, findingIds: cluster.findingIds.filter((id) => !quotes.has(id)),
      members: cluster.members.filter((member) => !quotes.has(member.id)).map((member) => ({ ...member, dependencies: member.dependencies.filter((id) => !quotes.has(id)) })) })) } : state0;
  const failedIds = new Set(results.filter((value) => isRecord(value) && value['status'] === 'failed').map((value) => (value as Row)['clusterId']));
  const failed = state.clusters.filter((cluster) => failedIds.has(cluster.clusterId));
  const retry = retryFailed(state.c, failed);
  const defects = failed.map((cluster) => `cluster ${cluster.clusterId} failed to apply`);
  const applied = state.clusters.filter((cluster) => !failedIds.has(cluster.clusterId));
  if (!applied.length) return resumeFix(state.c, retry.clusters, retry.exhausted, state.pass, defects);
  return issueFixVerify(state.c, { clusters: applied, pass: state.pass, pendingClusters: retry.clusters, exhausted: retry.exhausted });
}

type FixRecovery = Omit<Extract<ReviewState, { tag: 'fix-verify' }>, 'tag' | 'c'>;

function issueFixVerify(c0: ReviewCtx, recovery: FixRecovery): S {
  if (c0.spec.kind === 'code') {
    const commands = [...new Set(recovery.clusters.flatMap((cluster) => cluster.verification))].map((command) => ({ command }));
    const { c, effect } = withEffect(c0, 'verify', (id) => ({ kind: 'verify', id, purpose: 'fix-verify', commands }));
    return { state: { tag: 'fix-verify', c, ...recovery }, effects: [effect] };
  }
  const artifact = c0.spec.kind;
  const { c, effect } = withEffect(c0, 'parse-artifact', (id) => ({ kind: 'parse-artifact', id, path: c0.spec.target, artifact, ...(c0.spec.governingSpec ? { governing: c0.spec.governingSpec.path } : {}) }));
  return { state: { tag: 'fix-verify', c, ...recovery }, effects: [effect] };
}

function retryFailed(c: ReviewCtx, clusters: readonly FixCluster[]) {
  const retries = clusters.map((cluster) => ({ cluster, split: splitFailedCluster(cluster, { runId: c.path, failed: null, attemptsConsumed: 1 }) }));
  return { clusters: retries.flatMap(({ split }) => split.clusters), exhausted: retries.filter(({ split }) => !split.canProceed).flatMap(({ cluster }) => cluster.findingIds) };
}

function resumeFix(c: ReviewCtx, clusters: readonly FixCluster[], exhausted: readonly FindingId[], pass: Pass, defects: readonly string[]): S {
  if (exhausted.length) return stay({ tag: 'failed', c, detail: `fix-attempts-exhausted: ${exhausted.join(', ')}; pending: ${clusters.flatMap((cluster) => cluster.findingIds).join(', ') || 'none'}; verified fixes retained` });
  if (clusters.length) return stay({ tag: 'fix', c, clusters: orderFixClusters(clusters), pass, defects });
  return pass === 'opt-in' ? settle(c) : decideNext(c);
}

function afterFixVerify(state: Extract<ReviewState, { tag: 'fix-verify' }>, defects: readonly string[]): S {
  const pending = state.pendingClusters ?? [];
  const exhausted = state.exhausted ?? [];
  if (defects.length) {
    const retry = retryFailed(state.c, state.clusters);
    return resumeFix(state.c, [...pending, ...retry.clusters], [...exhausted, ...retry.exhausted], state.pass, defects);
  }
  const fixedIds = new Set(state.clusters.flatMap((cluster) => cluster.findingIds));
  const c = { ...state.c, findings: state.c.findings.map((finding): ReviewFinding => fixedIds.has(finding.id) ? { ...finding, status: 'fixed' } : finding),
    fixes: [...state.c.fixes.filter((fix) => !fixedIds.has(fix.id)), ...[...fixedIds].map((id) => ({ id, round: state.c.round }))] };
  return resumeFix(c, pending, exhausted, state.pass, []);
}

// SECTION: Next round and exit

function roundView(c: ReviewCtx): RoundFinding[] {
  return c.findings.flatMap((finding): RoundFinding[] => {
    if (finding.status === 'pending-rejection') return [{ id: finding.id, severity: finding.severity, state: 'pending-rejection' }];
    if (finding.round !== c.round) return [];
    if (finding.status === 'fixed') return [{ id: finding.id, severity: finding.severity, state: 'fixed' }];
    if (isAccepted(finding)) return [{ id: finding.id, severity: finding.severity, state: 'accepted' }];
    return finding.status === 'duplicate' ? [] : [{ id: finding.id, severity: finding.severity, state: 'closed' }];
  });
}

function decideNext(c0: ReviewCtx): S {
  const cap = c0.spec.cap;
  const closures = new Set(orchestratorClosures({ round: c0.round, cap, findings: roundView(c0) }).map((closure) => closure.id));
  const findings = c0.findings.map((finding): ReviewFinding => (closures.has(finding.id) ? { ...finding, status: 'closed-by-orchestrator' } : finding));
  const history = [
    ...c0.history,
    ...findings.filter((finding) => finding.round === c0.round && (finding.status === 'fixed' || finding.status === 'pending-rejection'))
      .map((finding): HistoryEntry => ({ ...matchKey(finding), id: finding.id, status: finding.status === 'fixed' ? 'applied' : 'pending-rejection', reraises: 0 })),
  ];
  const c1 = { ...c0, findings, history };
  const next = nextRound({ round: c1.round, cap, findings: roundView(c1) });
  const selected = c1.requested && c1.round < cap ? c1.observations?.find((row) => row.id === c1.requested)?.use : undefined;
  // NOTE: an outstanding spec rebind blocks settlement until a full round runs under the revised spec.
  if (!next.run && !selected && !(c1.forceFullScope && c1.round < cap)) return settleOrOptIn(c1);
  // NOTE: a host-selected review launches at this boundary and spends the round it starts; full scope wins over policy scope.
  const round = c1.round + 1;
  const c: ReviewCtx = c1;
  const policyScope: RoundScope = !selected ? (next.run ? next.scope : "full") : selected.action === 'full' || (next.run && next.scope === 'full') ? 'full' : 'delta';
  const scope: RoundScope = c.forceFullScope ? 'full' : policyScope;
  if (!next.run) return prepare(c, round, scope, [], selected);
  const carriedIds = new Set(next.carry);
  const pending = findings.filter((finding) => carriedIds.has(finding.id));
  const affinity = assignAffinity(pending.map((finding) => ({ id: finding.id, source: String(c.rows.find((row) => row['by'] === finding.sources[0])?.['slot'] ?? finding.sources[0] ?? '') })), c.spec.roster.filter((slot) => !slot.reserve));
  const carried = pending.map((finding): CarriedRejection => ({
    id: finding.id, slot: affinity[finding.id] ?? null, locus: finding.locus, defect: finding.defect, reason: finding.resolution ?? '',
  }));
  return prepare(c, next.round, scope, carried, selected);
}

const optInItems = (c: ReviewCtx): FindingId[] => c.findings
  .filter((finding) => (isAccepted(finding) && (finding.scope === 'adjacent' || finding.severity === 'CONSIDER'))
    || (finding.status === 'needs-user' && finding.severity === 'CONSIDER'))
  .map((finding) => finding.id);

function settleOrOptIn(c: ReviewCtx): S {
  if (!c.optInAsked) {
    const items = optInItems(c);
    if (items.length) return stay({ tag: 'decide-opt-in', c: { ...c, optInAsked: true }, items });
  }
  return settle(c);
}

/** Review evidence and its actual coverage: finding revisions, the live target, and changes no host selection assessed. */
export function reviewCoverage(c: ReviewCtx): Readonly<Record<string, unknown>> {
  const observations = c.observations ?? [];
  return {
    reviewed: [...new Set(c.findings.flatMap((finding) => finding.revision ? [finding.revision] : []))], current: liveRevision(c) ?? 'unbound',
    unassessed: observations.filter((row) => !row.use).map(({ id, afterHash, round, paths, reason }) => ({ id, afterHash, round, paths, reason })),
    assessed: observations.filter((row) => row.use).map(({ id, afterHash, use }) => ({ id, afterHash, use })),
    ...(c.requested ? { unlaunched: c.requested } : {}),
  };
}

function settle(c: ReviewCtx): S {
  const rejections = c.findings.filter((finding) => ['rejected', 'pending-rejection', 'closed-by-reviewer', 'closed-by-orchestrator'].includes(finding.status)).map((finding) => finding.id);
  const exit = exitSummary({ rounds: c.round, cap: c.spec.cap, fixes: c.fixes, rejections });
  const followUps = c.findings.filter((finding) => finding.scope === 'adjacent' && isAccepted(finding))
    .map((finding) => `${finding.id} ${finding.locus}: ${finding.defect}`);
  return stay({ tag: 'settled', c, exit, followUps });
}

// SECTION: Decisions

export function selectedIds(answer: unknown): string[] | null {
  const list = isRecord(answer) ? answer['selected'] : answer;
  return Array.isArray(list) && list.every((entry) => typeof entry === 'string') ? list : null;
}

function userRuling(value: unknown): (Ruling & { quote: string }) | null {
  const ruling = asRuling(value);
  if (!ruling || ruling.ruling === 'needs-user' || ruling.quote === undefined) return null;
  return { ...ruling, quote: ruling.quote };
}

function onDecision(state: ReviewState, answer: unknown): S {
  switch (state.tag) {
    case 'decide-escalation': return answer === 'stop' ? stay({ tag: 'escalated', c: state.c, escalation: state.escalation }) : stay(state);
    case 'decide-needs-user': {
      if (!isRecord(answer) || state.ids.some((id) => !userRuling(answer[id]))) return stay(state);
      // NOTE: the user's ruling settles the finding, so accepted ones join the fix batch and rejections are not disputed.
      const findings = state.c.findings.map((finding): ReviewFinding => {
        const ruling = state.ids.includes(finding.id) ? userRuling(answer[finding.id]) : null;
        if (!ruling) return finding;
        const ruled = { ...finding, resolution: `user: ${ruling.quote}`, ...(ruling.fix ? { fix: ruling.fix } : {}) };
        if (ruling.ruling === 'accept') return { ...ruled, status: 'accepted' };
        if (ruling.ruling === 'downgrade') return { ...ruled, severity: ruling.severity ?? finding.severity, status: 'downgraded' };
        return { ...ruled, status: 'rejected' };
      });
      return afterRulings({ ...state.c, findings });
    }
    case 'decide-opt-in': {
      const selected = selectedIds(answer);
      if (!selected) return stay(state);
      const chosen = state.c.findings.filter((finding) => selected.includes(finding.id) && state.items.includes(finding.id));
      return chosen.length ? enterFix(state.c, chosen, 'opt-in') : settle(state.c);
    }
    case 'decide-verification': {
      if (!isRecord(answer)) return stay(state);
      const repairs = new Map(state.clusters.map((cluster) => [cluster.clusterId, verificationRepair(answer[cluster.clusterId])]));
      if ([...repairs.values()].some((repair) => !repair)) return stay(state);
      // NOTE: the repaired check replaces the cluster command at no attempt cost; the fix itself was never tested.
      const clusters = state.clusters.map((cluster) => {
        const verification = repairs.get(cluster.clusterId)!;
        return { ...cluster, verification, members: cluster.members.map((member) => ({ ...member, verification })) };
      });
      const { tag: _tag, c, failures: _failures, ...recovery } = state;
      return issueFixVerify(c, { ...recovery, clusters });
    }
    default: return stay(state);
  }
}

/** An orchestrator repair of an unrunnable fix check: non-blank replacement commands with a rationale. */
function verificationRepair(value: unknown): readonly string[] | null {
  if (!isRecord(value) || value['by'] !== 'orchestrator' || typeof value['rationale'] !== 'string' || !value['rationale'].trim()) return null;
  const verification = value['verification'];
  if (!Array.isArray(verification) || !verification.length || verification.some((command) => typeof command !== 'string' || !command.trim())) return null;
  return verification as string[];
}

const DECIDE_KIND = { 'decide-escalation': 'escalation', 'decide-needs-user': 'needs-user', 'decide-opt-in': 'opt-in', 'decide-verification': 'fix-verification' } as const;

export function validateReview(state: ReviewState, event: HostEvent): string | null {
  if (event.type === 'REVISE') return 'event.type: REVISE is unavailable in standalone review; author a new artifact and start a new run';
  if (event.type === 'REVIEW_USE') {
    const awaiting = reviewAwait(state);
    return 'c' in state && awaiting !== null && awaiting !== 'done' ? validateUse(state.c, event) : 'event.type: REVIEW_USE is accepted only at a live review frame.';
  }
  switch (state.tag) {
    case 'rule': return event.type === 'RULINGS' ? validateRulings(state.c, event.rulings) : null;
    case 'native': return event.type === 'NATIVE_RESULTS' ? validateNativeResults(event.slots, state.slots) : null;
    case 'fix': return event.type === 'FIXES_APPLIED' ? validateFixes(state.clusters, event.clusters) : null;
    case 'decide-escalation': case 'decide-needs-user': case 'decide-opt-in': case 'decide-verification': {
      if (event.type !== 'DECISION') return null;
      const kind = DECIDE_KIND[state.tag];
      if (event.kind !== kind) return `event.kind: expected ${kind}, got ${event.kind}`;
      if (state.tag === 'decide-escalation' && event.answer !== 'stop') return 'event.answer: escalation accepts only "stop"';
      if (state.tag === 'decide-needs-user') {
        const answer = event.answer;
        const missing = state.ids.find((id) => !isRecord(answer) || !userRuling(answer[id]));
        if (missing) return `event.answer.${missing}: expected { ruling: accept|reject|downgrade, quote: <user's words>, fix? }`;
      }
      if (state.tag === 'decide-opt-in') {
        const selected = selectedIds(event.answer);
        if (!selected) return 'event.answer: expected an array of offered finding ids';
        const unknown = selected.find((id) => !state.items.includes(id));
        if (unknown) return `event.answer: ${unknown} was not offered`;
      }
      if (state.tag === 'decide-verification') {
        const answer = event.answer;
        const missing = state.clusters.find((cluster) => !isRecord(answer) || !verificationRepair(answer[cluster.clusterId]));
        if (missing) return `event.answer.${missing.clusterId}: expected { verification: [<non-blank command>, ...], by: "orchestrator", rationale: <non-blank> }`;
      }
      return null;
    }
    case 'pin-check': return 'event: governing pin check is pending';
    case 'target-check': return 'event: review target check is pending';
    case 'booting': case 'prepare': case 'wave': case 'fix-verify': case 'settled': case 'escalated': case 'failed': case 'skipped': case 'empty':
      return null;
    default: return never(state, 'review state');
  }
}

// SECTION: Step

export function stepReview(state: ReviewState, event: Event): S {
  if (state.tag === 'target-check') {
    if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return stay({ tag: 'failed', c: state.c, detail: event.detail });
    if (event.type !== 'REVIEW_TARGET_CHECKED' || !answers(event, state.effectId)) return stay(state);
    if (event.result === 'changed' && !event.notice) return stay({ tag: 'failed', c: state.c, detail: 'Changed target lacks binding evidence.' });
    const before = state.before;
    if (!('c' in before)) return stay({ tag: 'failed', c: state.c, detail: 'target-changed: missing review context' });
    const verifying = before.tag === 'fix-verify';
    const verified = verifying && ((state.pending.type === 'VERIFY_DONE' && state.pending.results.every((row) => row['exit'] === 0))
      || (state.pending.type === 'ARTIFACT_PARSED' && state.pending.defects.length === 0));
    const fixing = before.tag === 'fix' && state.pending.type === 'FIXES_APPLIED';
    const rulings = state.pending.type === 'RULINGS' ? state.pending.rulings : {};
    const rulingFix = before.tag === 'rule' && state.pending.type === 'RULINGS'
      && roundOpen(before.c).some((finding) => asRuling(rulings[finding.id])?.ruling === 'accept');
    const admission = fixing || verifying || rulingFix;
    const observed = event.notice && (event.result === 'changed' || (rulingFix && event.notice.pathCount > 0)) ? observeTarget(before.c, event.notice) : before.c;
    if (admission && event.result === 'changed') return stay({ tag: 'failed', c: { ...observed, counters: state.c.counters }, detail: 'Fix admission failed: changed paths or comparison identity exceed the authorized applied scope; binding evidence retained.' });
    // NOTE: successful checks precede their output capture, so changed declared bytes need another bounded verification pass.
    if (before.tag === 'fix-verify' && verified && event.result === 'expected' && (event.notice?.pathCount ?? 0) > 0) {
      const c = { ...observed, counters: state.c.counters, fixCandidate: event.manifestPath, fixCandidateRef: event.manifestRef };
      const retry = retryFailed(c, before.clusters);
      const exhausted = [...(before.exhausted ?? []), ...retry.exhausted];
      if (exhausted.length) return resumeFix(c, [...(before.pendingClusters ?? []), ...retry.clusters], exhausted, before.pass, ['Verification changed the admitted candidate.']);
      return issueFixVerify(c, { clusters: retry.clusters, pass: before.pass, ...(before.pendingClusters ? { pendingClusters: before.pendingClusters } : {}), exhausted });
    }
    const candidate = fixing && state.pending.type === 'FIXES_APPLIED' && state.pending.clusters.some((row) => row['status'] !== 'failed');
    // NOTE: fix checks retain the admission baseline; ordinary observations retain each finding's launch revision.
    const c: ReviewCtx = { ...observed, counters: state.c.counters,
      ...(!admission || verified ? { ...(event.notice ? { reviewedRevision: event.notice.afterHash } : {}), targetManifest: event.manifestPath, targetManifestRef: event.manifestRef } : {}),
      ...(candidate ? { fixCandidate: event.manifestPath, fixCandidateRef: event.manifestRef } : {}) };
    if (verified) { delete c.fixCandidate; delete c.fixCandidateRef; }
    return stepReviewUnchecked({ ...before, c } as typeof before, state.pending);
  }
  if (event.type === 'SPEC_SETTLED' && (state.tag === 'rule' || state.tag === 'decide-needs-user' || state.tag === 'decide-escalation' || state.tag === 'decide-opt-in')) {
    return respec(state.c, { path: event.path, hash: event.hash });
  }
  if (event.type === 'REVIEW_USE') return 'c' in state && validateReview(state, event) === null ? stay({ ...state, c: useReview(state.c, event) } as ReviewState) : stay(state);
  const manifest = 'c' in state ? state.c.fixCandidate ?? state.c.targetManifest ?? state.c.priorManifest : undefined;
  const consumes = (state.tag === 'prepare' && event.type === 'REVIEW_PREPARED' && answers(event, state.c.effectId))
    || (state.tag === 'native' && event.type === 'NATIVE_RESULTS' && validateNativeResults(event.slots, state.slots) === null)
    || (state.tag === 'wave' && (event.type === 'WAVE_DONE' || (event.type === 'WAVE_STARTED' && 'completed' in event)) && answers(event, state.c.effectId))
    || (state.tag === 'rule' && event.type === 'RULINGS' && validateRulings(state.c, event.rulings) === null)
    || (state.tag === 'fix' && event.type === 'FIXES_APPLIED' && validateFixes(state.clusters, event.clusters) === null)
    || (state.tag === 'fix-verify' && (event.type === 'VERIFY_DONE' || event.type === 'ARTIFACT_PARSED') && answers(event, state.c.effectId))
    || ((state.tag === 'decide-needs-user' || state.tag === 'decide-opt-in' || state.tag === 'decide-verification') && event.type === 'DECISION' && event.kind === DECIDE_KIND[state.tag] && validateReview(state, event) === null);
  if (manifest && consumes && 'c' in state) {
    const next = nextId(state.c.counters, state.c.path, 'check-review-target');
    const c = { ...state.c, counters: next.counters };
    const applied = state.tag === 'fix' && event.type === 'FIXES_APPLIED' ? state.clusters.filter((cluster) => event.clusters.some((row) => row['clusterId'] === cluster.clusterId && row['status'] !== 'failed')) : [];
    const rulings = state.tag === 'rule' && event.type === 'RULINGS' ? roundOpen(c).map((finding) => asRuling(event.rulings[finding.id])) : [];
    const preRulingPaths = rulings.length && rulings.every((ruling) => ruling?.ruling === 'accept' && ruling.fix?.paths.length) ? rulings.flatMap((ruling) => ruling!.fix!.paths) : [];
    const verifyingPaths = state.tag === 'fix-verify' && c.spec.kind === 'code' ? state.clusters.flatMap((cluster) => cluster.paths) : [];
    const scopedPaths = applied.length ? applied.flatMap((cluster) => cluster.paths) : verifyingPaths.length ? verifyingPaths : preRulingPaths;
    const allowedPaths = scopedPaths.length ? c.spec.kind === 'code' ? scopedPaths : [c.spec.target] : [];
    return { state: { tag: 'target-check', c, before: state, pending: event, effectId: next.id }, effects: [{ kind: 'check-review-target', id: next.id, review: c.spec, manifestPath: manifest, manifestRef: c.fixCandidate ? c.fixCandidateRef : c.targetManifest ? c.targetManifestRef : c.priorManifestRef, allowedPaths }] };
  }
  return stepReviewUnchecked(state, event);
}

/**
 * Supersedes the round's unruled findings and re-prepares a full-scope round against the revised spec.
 * A delta or disputes-only scope would skip an unchanged target, so it would never be checked against the new intent.
 * NOTE: the next round number keeps finding IDs unique; the cap grows by one so the re-review costs no round.
 */
function respec(c: ReviewCtx, governingSpec: SpecIdentity): S {
  const findings = c.findings.map((finding): ReviewFinding => finding.round === c.round && (finding.status === 'open' || finding.status === 'needs-user') ? { ...finding, status: 'superseded' } : finding);
  const pendingSpec = { ...c.spec, cap: c.spec.cap + 1, governingSpec } as ReviewSpec;
  return prepare({ ...c, findings, pendingSpec }, c.round + 1, 'full', c.carried);
}

/**
 * Rebinds a retained nested review to a revised governing spec. A round awaiting rulings or decisions supersedes
 * and re-prepares as SPEC_SETTLED does; any other state carries the new identity into its next prepare.
 */
export function rebindReviewSpec(state: ReviewState, governingSpec: SpecIdentity): S {
  if (!('c' in state)) return stay(state);
  if (state.tag === 'rule' || state.tag === 'decide-needs-user' || state.tag === 'decide-escalation' || state.tag === 'decide-opt-in') return respec(state.c, governingSpec);
  const rebind = (c: ReviewCtx): ReviewCtx => ({ ...c, forceFullScope: true, spec: { ...c.spec, governingSpec } as ReviewSpec, ...(c.pendingSpec ? { pendingSpec: { ...c.pendingSpec, governingSpec } as ReviewSpec } : {}) });
  // NOTE: a pending delta preparation could return an empty scope under the old spec; replace it with a fresh full one.
  if ((state.tag === 'prepare' || state.tag === 'pin-check') && state.c.effectId) return prepare(rebind(state.c), state.c.preparedRound ?? state.c.round + 1, 'full', state.c.carried);
  if (state.tag !== 'target-check') return stay({ ...state, c: rebind(state.c) } as ReviewState);
  return stay({ ...state, c: rebind(state.c), before: 'c' in state.before ? { ...state.before, c: rebind(state.before.c) } as typeof state.before : state.before });
}

/** Records one observation per resulting revision; it changes no finding, ruling, or round. */
function observeTarget(c: ReviewCtx, notice: ChangeNotice): ReviewCtx {
  const observations = c.observations ?? [];
  if (observations.some((row) => row.afterHash === notice.afterHash)) return c;
  const { id, afterHash, beforeHash, paths, pathCount, reason, rawDeltaRef } = notice;
  return { ...c, observations: [...observations, { id, afterHash, beforeHash, round: c.round, paths, pathCount, reason, rawDeltaRef }] };
}

function useReview(c: ReviewCtx, event: Extract<HostEvent, { type: 'REVIEW_USE' }>): ReviewCtx {
  const { type: _type, changeDispositions: _dispositions, ...use } = event;
  const observations = (c.observations ?? []).map((row) => row.id === use.observationId ? { ...row, use: { ...use, round: c.round } } : row);
  return { ...c, observations, ...(use.action === 'reuse' ? {} : { requested: use.observationId }) };
}

/** A selection binds an unassessed observation at its exact revision; a new review wave needs a round left under the cap. */
function validateUse(c: ReviewCtx, event: Extract<HostEvent, { type: 'REVIEW_USE' }>): string | null {
  const observation = (c.observations ?? []).find((row) => row.id === event.observationId);
  if (!observation || observation.afterHash !== event.afterHash) return 'event.observationId: name a review observation with its current afterHash.';
  if (observation.use) return `event.observationId: ${observation.id} already has a host applicability selection.`;
  if (event.action === 'reuse') return null;
  if (event.action === 'targeted' && !event.paths?.length) return 'event.paths: a targeted review names the paths to review.';
  if (c.requested) return `event.action: a selected review for ${c.requested} is pending; it launches at the next round boundary.`;
  if (c.round >= c.spec.cap) return `event.action: the review cap (${c.spec.cap}) is reached; reuse with a rationale or escalate. Findings and unresolved coverage are retained.`;
  return null;
}

function stepReviewUnchecked(state: Exclude<ReviewState, { tag: 'target-check' }>, event: Event): S {
  if (event.type === 'EFFECT_FAILED' && 'c' in state && answers(event, state.c.effectId)
    && (state.tag === 'prepare' || state.tag === 'wave' || state.tag === 'fix-verify')) {
    return stay({ tag: 'failed', c: state.c, detail: `${event.cls}: ${event.detail}` });
  }
  switch (state.tag) {
    case 'booting': return stay(state);
    case 'pin-check': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) {
        const ancestor = event.detail.startsWith('design pin target unreadable') || event.detail.includes('has no spec pin');
        return stay({ tag: 'failed', c: state.c, detail: ancestor ? `stale-design-spec: ${event.detail}` : event.detail, ...(ancestor ? { code: 'stale-design-spec' as const } : {}) });
      }
      if (event.type !== 'ARTIFACT_PARSED' || !answers(event, state.effectId)) return stay(state);
      if (staleGoverning(event, state.c.spec.governingSpec)) {
        const code = event.governing.design ? 'stale-design-spec' : 'stale-spec';
        return stay({ tag: 'failed', c: state.c, code, detail: code + ': governing spec pin differs from current bytes' });
      }
      if (event.defects.length) return stay({ tag: 'failed', c: state.c, detail: event.defects.map(row => row['message'] ?? row['code']).join('; ') });
      return { state: { tag: 'prepare', c: state.c }, effects: [state.pending] };
    }
    case 'prepare':
      if (event.type !== 'REVIEW_PREPARED' || !answers(event, state.c.effectId)) return stay(state);
      if (event.scope['empty'] === true) return stay({ tag: 'empty', c: state.c });
      return launchWave({ ...state.c, promptPaths: event.promptPaths, ...(typeof event.scope['manifestPath'] === 'string' ? { priorManifest: event.scope['manifestPath'], priorManifestRef: event.scope['manifestRef'] as ReviewManifestRef | undefined, targetManifest: String(event.scope['bindingPath'] ?? event.scope['manifestPath']), targetManifestRef: (event.scope['bindingRef'] ?? event.scope['manifestRef']) as ReviewManifestRef | undefined } : {}) }, waveRoster(state.c.spec.roster, state.c.spec.kind, event.promptPaths), 'cli');
    case 'wave':
      if (event.type === 'WAVE_STARTED' && answers(event, state.c.effectId)) {
        const completed = (event as typeof event & { completed?: Extract<Event, { type: 'WAVE_DONE' }> }).completed;
        if (completed) return onWaveDone(state, completed);
        const slots = pendingNative([...event.native, ...event.early].map((descriptor) => ({ state: 'native', descriptor })));
        const c = { ...state.c, waveBinding: { waveKey: event.waveKey, attempt: event.attempt, roster: event.roster } };
        return slots.length ? stay({ tag: 'native', c, slots }) : finishReviewWave(c, []);
      }
      return event.type === 'WAVE_DONE' && answers(event, state.c.effectId) ? onWaveDone(state, event) : stay(state);
    case 'native':
      if (event.type !== 'NATIVE_RESULTS' || validateNativeResults(event.slots, state.slots) !== null) return stay(state);
      if (state.c.waveBinding) return finishReviewWave(state.c, keyedCaptures(event.slots, state.slots) as typeof event.slots);
      return launchWave(state.c, nativeRoster(state.slots, event.slots, state.c.spec.kind), 'native');
    case 'rule': return event.type === 'RULINGS' ? onRulings(state.c, event.rulings) : stay(state);
    case 'fix':
      return event.type === 'FIXES_APPLIED' && validateFixes(state.clusters, event.clusters) === null ? onFixesApplied(state, event.clusters) : stay(state);
    case 'fix-verify':
      if (event.type === 'ARTIFACT_PARSED' && answers(event, state.c.effectId)) {
        if (staleGoverning(event, state.c.spec.governingSpec)) {
          const code = event.governing.design ? 'stale-design-spec' : 'stale-spec';
          return stay({ tag: 'failed', c: state.c, code, detail: `${code}: governing spec pin differs from current bytes` });
        }
        return afterFixVerify(state, event.defects.map((defect) => String(defect['message'] ?? defect['code'] ?? 'lint defect')));
      }
      if (event.type === 'VERIFY_DONE' && answers(event, state.c.effectId)) {
        const red = event.results.filter((result) => result['exit'] !== 0);
        // NOTE: when no failing check could run, the fix is untested, so the orchestrator repairs the commands at no attempt cost.
        if (red.length && red.every((result) => result['loadError'] === true || result['exit'] === 127)) {
          const failures = red.map((result) => ({ command: String(result['command']), exit: Number(result['exit']), logPath: String(result['logPath']) }));
          const { tag: _tag, c, ...recovery } = state;
          return stay({ tag: 'decide-verification', c, ...recovery, failures });
        }
        return afterFixVerify(state, red.map((result) => `${String(result['command'])} exited ${String(result['exit'])} (${String(result['logPath'])})`));
      }
      return stay(state);
    case 'decide-escalation': case 'decide-needs-user': case 'decide-opt-in': case 'decide-verification':
      return event.type === 'DECISION' && event.kind === DECIDE_KIND[state.tag] ? onDecision(state, event.answer) : stay(state);
    case 'settled': case 'escalated': case 'failed': case 'skipped': case 'empty': return stay(state);
    default: return never(state, 'review state');
  }
}

// SECTION: Projection

export function reviewAwait(state: ReviewState) {
  switch (state.tag) {
    case 'native': return 'native' as const;
    case 'rule': return 'rule' as const;
    case 'fix': return 'fix' as const;
    case 'decide-escalation': case 'decide-needs-user': case 'decide-opt-in': case 'decide-verification': return 'decide' as const;
    case 'settled': case 'escalated': case 'failed': case 'skipped': case 'empty': return 'done' as const;
    case 'booting': case 'prepare': case 'wave': case 'fix-verify': case 'target-check': case 'pin-check': return null;
    default: return never(state, 'review state');
  }
}

function decide(state: Extract<ReviewState, { tag: 'decide-escalation' | 'decide-needs-user' | 'decide-opt-in' | 'decide-verification' }>): Decide {
  const byId = (ids: readonly FindingId[]) => state.c.findings.filter((finding) => ids.includes(finding.id));
  switch (state.tag) {
    case 'decide-escalation':
      return { kind: 'escalation', question: `Review halted on ${state.escalation.kind} of ${state.escalation.ids.join(', ')}; inform the user and answer stop.`, options: ['stop'], items: state.escalation.ids };
    case 'decide-needs-user':
      return { kind: 'needs-user', question: 'Ask the user to rule each listed finding; relay { <id>: { ruling: accept|reject|downgrade, quote: <user words>, fix?: { affectedPaths, dependsOn, verification } } }. Accepted in-scope findings enter the fix batch.', options: ['accept', 'reject', 'downgrade'], items: byId(state.ids) };
    case 'decide-opt-in':
      return { kind: 'opt-in', question: 'Offer the user these adjacent and CONSIDER items once; relay the selected ids ([] for none).', options: ['<selected finding ids>'], items: byId(state.items) };
    case 'decide-verification':
      return { kind: 'fix-verification', question: `No failing fix check could run: ${state.failures.map((failure) => `${failure.command} exited ${failure.exit} (${failure.logPath})`).join('; ')}. Read the logs, then relay { <clusterId>: { verification: [<corrected command>], by: "orchestrator", rationale } } for every listed cluster; no attempt is charged.`, options: ['<replacement verification per cluster>'], items: state.clusters.map((cluster) => ({ clusterId: cluster.clusterId, findingIds: cluster.findingIds, verification: cluster.verification })) };
    default: return never(state, 'decide state');
  }
}

export function reviewData(state: ReviewState): Readonly<Record<string, unknown>> {
  const data = reviewFrameData(state);
  if (!('c' in state) || !state.c.observations?.length) return data;
  const awaiting = reviewAwait(state);
  if (awaiting === 'done') return state.tag === 'settled' ? { ...data, completion: { ...(data['completion'] as object), coverage: reviewCoverage(state.c) } } : { ...data, coverage: reviewCoverage(state.c) };
  if (awaiting === null) return data;
  // NOTE: observations are advisory; a selection is optional and findings keep the revision their wave reviewed.
  return { ...data, reviewObservations: state.c.observations, reviewUse: 'Optional: REVIEW_USE { observationId, afterHash, action: reuse|targeted|full, rationale, paths? }. Observations never block progress or spend a round.', ...(state.tag === 'decide-escalation' ? { coverage: reviewCoverage(state.c) } : {}) };
}

function reviewFrameData(state: ReviewState): Readonly<Record<string, unknown>> {
  switch (state.tag) {
    case 'native': return { round: state.c.round, slots: state.slots };
    case 'rule': {
      const { c } = state;
      return {
        round: c.round, cap: c.spec.cap, scope: c.scope, threshold: threshold(c.round, c.spec.cap), findings: roundOpen(c),
        ...(c.round > c.spec.cap ? { continuationReason: c.scope === 'disputes-only'
          ? 'MUST continuation beyond the cap: disputes-only review of pending-rejection MUST findings.'
          : c.scope === 'delta' ? 'MUST continuation beyond the cap: delta review of fixed MUST findings.'
            : 'MUST continuation beyond the cap: review remaining MUST findings.' } : {}),
        pending: c.findings.filter((finding) => finding.status === 'pending-rejection').map((finding) => ({ id: finding.id, severity: finding.severity, status: finding.status })),
        reportPaths: [],
        ...(c.spec.kind === 'code' ? {} : { fixTarget: c.spec.target }),
      };
    }
    case 'fix': return {
      round: state.c.round,
      clusters: state.clusters.map((cluster) => ({ clusterId: cluster.clusterId, findingIds: cluster.findingIds, affectedPaths: cluster.paths, verification: cluster.verification })),
      ...(state.c.spec.writer ? { writer: state.c.spec.writer } : {}),
      ...(state.defects.length ? { defects: state.defects } : {}),
    };
    case 'decide-escalation': case 'decide-needs-user': case 'decide-opt-in': case 'decide-verification': return decide(state);
    case 'settled': return { outcome: 'complete', summary: `review settled after ${state.c.round} round(s)`, completion: { exitSummary: state.exit, followUps: state.followUps } };
    case 'escalated': return { outcome: 'stopped', summary: `review escalated: ${state.escalation.kind} (${state.escalation.ids.join(', ')})` };
    case 'failed': return { outcome: 'failed', summary: state.code && !state.detail.startsWith(state.code) ? `${state.code}: ${state.detail}` : state.detail };
    case 'skipped': return { outcome: 'skipped', summary: 'review skipped (rounds 0)' };
    case 'empty': return { outcome: 'no-reviewable-changes', summary: 'no reviewable changes' };
    case 'booting': case 'prepare': case 'wave': case 'fix-verify': case 'target-check': case 'pin-check': return { round: 'c' in state ? state.c.round : 0 };
    default: return never(state, 'review state');
  }
}

// SECTION: Rendered rounds

function statusOf(finding: ReviewFinding): ResolutionStatus {
  switch (finding.status) {
    case 'open': case 'accepted': return 'accepted';
    case 'downgraded': return 'downgraded';
    case 'fixed': return 'fixed';
    case 'rejected': return 'rejected';
    case 'pending-rejection': return 'pending-rejection';
    case 'needs-user': return 'needs-user';
    case 'closed-by-reviewer': return 'closed-by-reviewer';
    case 'superseded': return 'superseded';
    case 'closed-by-orchestrator': return 'closed-by-orchestrator';
    case 'duplicate': return 'duplicate';
    default: return never(finding.status, 'finding status');
  }
}

export function resolutionRounds(c: ReviewCtx): ResolutionRound[] {
  return c.rounds.map((record) => ({
    round: record.round,
    heading: record.scope,
    // NOTE: coverage renders only when the target changed, so the reviewed revision and the host's reuse stay distinct.
    ...(record.revision && c.observations?.some((row) => row.round === record.round) ? {
      revision: record.revision,
      applicability: c.observations.filter((row) => row.round === record.round).map((row) => ({ afterHash: row.afterHash, reason: row.reason,
        ...(row.use ? { action: row.use.action, rationale: row.use.rationale, ...(row.use.paths?.length ? { paths: [...row.use.paths] } : {}), ...(row.use.launchedRound ? { launchedRound: row.use.launchedRound } : {}) } : {}) })),
    } : {}),
    reviewers: record.reviewers.map((reviewer) => (typeof reviewer === 'string' ? { slot: reviewer } : reviewer)),
    failed: record.failed,
    entries: c.findings.filter((finding) => finding.round === record.round).map((finding) => ({
      id: finding.id, severity: finding.severity, status: statusOf(finding), sources: finding.sources, locus: finding.locus,
      category: finding.category, defect: finding.defect,
      ...(finding.requiredChange === undefined ? {} : { requiredChange: finding.requiredChange }),
      ...(finding.resolution === undefined ? {} : { resolution: finding.resolution }),
      ...(finding.dupOf === undefined ? {} : { dupOf: finding.dupOf }),
      ...(finding.originalTag === undefined ? {} : { originalTag: finding.originalTag }),
    })),
  }));
}

// SECTION: Standalone machine

export const reviewTransitions = [
  { from: 'pin-check', on: 'ARTIFACT_PARSED', to: 'prepare' },
  { from: 'pin-check', on: 'ARTIFACT_PARSED', to: 'failed' },
  { from: 'pin-check', on: 'EFFECT_FAILED', to: 'failed' },
  ...[
    ['prepare', 'REVIEW_PREPARED'], ['native', 'NATIVE_RESULTS'], ['wave', 'WAVE_DONE'], ['wave', 'WAVE_STARTED'], ['rule', 'RULINGS'],
    ['fix', 'FIXES_APPLIED'], ['fix-verify', 'VERIFY_DONE'], ['fix-verify', 'ARTIFACT_PARSED'],
    ['decide-needs-user', 'DECISION'], ['decide-opt-in', 'DECISION'], ['decide-verification', 'DECISION'],
  ].map(([from, on]) => ({ from: from!, on: on!, to: 'target-check' })),
  ...['wave', 'rule', 'native', 'fix', 'fix-verify', 'prepare', 'pin-check', 'settled', 'failed', 'decide-needs-user', 'decide-opt-in', 'decide-escalation', 'decide-verification'].map((to) => ({ from: 'target-check', on: 'REVIEW_TARGET_CHECKED', to })),
  { from: 'target-check', on: 'REVIEW_TARGET_CHECKED', to: 'empty' },
  { from: 'target-check', on: 'EFFECT_FAILED', to: 'failed' },
  ...['native', 'rule', 'fix', 'decide-escalation', 'decide-needs-user', 'decide-opt-in', 'decide-verification'].map((tag) => ({ from: tag, on: 'REVIEW_USE', to: tag })),
  { from: 'booting', on: 'RUN_STARTED', to: 'prepare' },
  { from: 'booting', on: 'RUN_STARTED', to: 'skipped' },
  { from: 'booting', on: 'RUN_STARTED', to: 'failed' },
  { from: 'prepare', on: 'REVIEW_PREPARED', to: 'wave' },
  { from: 'prepare', on: 'REVIEW_PREPARED', to: 'empty' },
  { from: 'prepare', on: 'EFFECT_FAILED', to: 'failed' },
  { from: 'wave', on: 'WAVE_DONE', to: 'native' },
  { from: 'wave', on: 'WAVE_DONE', to: 'rule' },
  { from: 'wave', on: 'WAVE_DONE', to: 'decide-escalation' },
  { from: 'wave', on: 'WAVE_DONE', to: 'settled' },
  { from: 'wave', on: 'WAVE_DONE', to: 'decide-opt-in' },
  { from: 'wave', on: 'EFFECT_FAILED', to: 'failed' },
  { from: 'native', on: 'NATIVE_RESULTS', to: 'wave' },
  { from: 'rule', on: 'RULINGS', to: 'fix' },
  { from: 'rule', on: 'RULINGS', to: 'decide-needs-user' },
  { from: 'rule', on: 'RULINGS', to: 'prepare' },
  { from: 'rule', on: 'RULINGS', to: 'settled' },
  { from: 'rule', on: 'RULINGS', to: 'decide-opt-in' },
  { from: 'decide-needs-user', on: 'DECISION', to: 'fix' },
  { from: 'decide-needs-user', on: 'DECISION', to: 'settled' },
  { from: 'decide-needs-user', on: 'DECISION', to: 'prepare' },
  { from: 'decide-needs-user', on: 'DECISION', to: 'decide-opt-in' },
  { from: 'fix', on: 'FIXES_APPLIED', to: 'fix-verify' },
  { from: 'fix', on: 'FIXES_APPLIED', to: 'failed' },
  { from: 'fix-verify', on: 'ARTIFACT_PARSED', to: 'failed' },
  { from: 'fix-verify', on: 'VERIFY_DONE', to: 'failed' },
  { from: 'fix-verify', on: 'ARTIFACT_PARSED', to: 'fix' },
  { from: 'fix-verify', on: 'ARTIFACT_PARSED', to: 'prepare' },
  { from: 'fix-verify', on: 'ARTIFACT_PARSED', to: 'settled' },
  { from: 'fix-verify', on: 'ARTIFACT_PARSED', to: 'decide-opt-in' },
  { from: 'fix-verify', on: 'VERIFY_DONE', to: 'fix' },
  { from: 'fix-verify', on: 'VERIFY_DONE', to: 'prepare' },
  { from: 'fix-verify', on: 'VERIFY_DONE', to: 'settled' },
  { from: 'fix-verify', on: 'VERIFY_DONE', to: 'decide-opt-in' },
  { from: 'fix-verify', on: 'EFFECT_FAILED', to: 'failed' },
  { from: 'fix-verify', on: 'VERIFY_DONE', to: 'decide-verification' },
  { from: 'decide-verification', on: 'DECISION', to: 'fix-verify' },
  { from: 'decide-verification', on: 'DECISION', to: 'target-check' },
  { from: 'decide-escalation', on: 'DECISION', to: 'escalated' },
  { from: 'decide-opt-in', on: 'DECISION', to: 'fix' },
  { from: 'decide-opt-in', on: 'DECISION', to: 'settled' },
  ...['rule', 'decide-needs-user', 'decide-escalation', 'decide-opt-in'].flatMap((from) => ['prepare', 'pin-check'].map(to => ({ from, on: 'SPEC_SETTLED', to }))),
] as const;

/** Standalone reviewer over a code target (root builds specs itself; this machine serves tier-1 tests and parity). */
export const reviewMachine: Machine<ReviewState> = {
  initial: () => ({ tag: 'booting', counters: {} }),
  step(state, event) {
    if (state.tag === 'booting' && event.type === 'RUN_STARTED') {
      const kind: ReviewKind = event.overrides['kind'] === 'plan' || event.overrides['kind'] === 'design' ? event.overrides['kind'] : 'code';
      const built = reviewSpecFromRun(event, kind, event.argument);
      if (built.ok) return beginReview(built.spec, 'review', state.counters);
      const spec: ReviewSpec = { kind, target: event.argument, cap: 0, breadth: 0, context: '', roster: [], timeoutMs: DEFAULT_TIMEOUT_MS };
      const c = (beginReview(spec, 'review', state.counters).state as Extract<ReviewState, { tag: 'skipped' }>).c;
      return stay({ tag: 'failed', c, detail: built.error });
    }
    return stepReview(state, event);
  },
  awaitOf: reviewAwait,
  project: (state) => ({ at: `review › ${state.tag}`, data: reviewData(state) }),
  transitions: reviewTransitions,
  validate: validateReview,
};

export function reviewArtifactId(state: ReviewState): string | null {
  return state.tag === 'pin-check' ? state.effectId : state.tag === 'fix-verify' && state.c.spec.kind !== 'code' ? state.c.effectId : null;
}
