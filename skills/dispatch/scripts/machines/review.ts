// Reusable review sub-machine (spec §5.5, §7): prepare → wave → [native] → rule → [fix → fix-verify] → next?.
// Pure reducer; rounds policy lives in policy/rounds.ts. Parents embed `ReviewState` and forward events via `stepReview`.

import type { ChangeNotice, DriftResolution, Effect, Event, FindingId, HostEvent, Level, Machine, RunStartedEvent } from '../core/types.ts';
import { resolution } from './change-resolution.ts';
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
  answers, asFinding, asNativeCapture, asNativeSlot, asRuling, isAccepted, isRecord, isString, launchMismatch, never, nextId, stay,
  type CarriedRejection, type Counters, type Decide, type NativeSlot, type ReviewFinding, type ReviewMode, type ReviewSpec, type Ruling, type SettledRow, type Step,
} from './types.ts';
import { writerConfig } from './implement-types.ts';

export const DEFAULT_TIMEOUT_MS = 600_000;

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
  const timeoutMs = typeof timeout === 'number' && timeout > 0 ? timeout * 1000 : DEFAULT_TIMEOUT_MS;
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

export function reviewSpecFromRun(run: RunStartedEvent, kind: ReviewKind, mode: ReviewMode, target: string): { ok: true; spec: ReviewSpec } | { ok: false; error: string } {
  const slots = resolveSlots(run, phaseOf(kind));
  if (!slots.ok) return slots;
  const context = isString(run.overrides['context']) ? run.overrides['context'] : (run.verb === 'review' && kind === 'code' ? null : run.argument);
  const sessionDir = isString(run.overrides['sessionDir']) ? run.overrides['sessionDir'] : undefined;
  const governing = isRecord(run.overrides['governing']) ? run.overrides['governing'] as ReviewSpec['governing'] : undefined;
  const writer = writerConfig(run.config, run.orchestrator, run.level);
  return { ok: true, spec: { kind, mode, target, cap: slots.cap, breadth: slots.breadth, context, roster: slots.roster, timeoutMs: slots.timeoutMs, writer: writer.ok ? writer.value : null, ...(sessionDir ? { sessionDir } : {}), ...(governing ? { governing } : {}) } };
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

export type RoundRecord = { round: number; scope: RoundScope; reviewers: readonly (string | ReviewerView)[]; failed: readonly { slot: string; reason: string }[] };

export type ReviewCtx = {
  pendingSpec?: ReviewSpec;
  spec: ReviewSpec;
  path: string;
  counters: Counters;
  effectId: string | null;
  round: number;
  scope: RoundScope;
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
  targetManifest?: string;
  reviewedRevision?: string;
  findingBindings?: Readonly<Record<string, string>>;
  fixCandidate?: string;
  waveBinding?: { waveKey: string; attempt: number; roster: readonly Row[] };
};

export type Pass = 'main' | 'opt-in';
export type Escalation = { kind: 'regression' | 'deadlock'; ids: readonly FindingId[] };

export type ReviewState =
  | { tag: 'target-check'; c: ReviewCtx; before: Exclude<ReviewState, { tag: 'target-check' | 'change-resolution' }>; pending: Event; effectId: string; resolution?: DriftResolution }
  | { tag: 'change-resolution'; c: ReviewCtx; check: Extract<ReviewState, { tag: 'target-check' }>; notice: ChangeNotice }
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
  | { tag: 'settled'; c: ReviewCtx; exit: ExitSummary; followUps: readonly string[] }
  | { tag: 'escalated'; c: ReviewCtx; escalation: Escalation }
  | { tag: 'failed'; c: ReviewCtx; detail: string }
  | { tag: 'skipped'; c: ReviewCtx }
  | { tag: 'empty'; c: ReviewCtx };

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
export function beginReview(spec: ReviewSpec, path: string, counters: Counters): S {
  const c: ReviewCtx = {
    spec, path, counters, effectId: null, round: 0, scope: 'full', carried: [], findings: [], history: [], rounds: [], fixes: [],
    optInAsked: false, promptPaths: {}, rows: [], drafts: [],
  };
  if (spec.cap <= 0) return stay({ tag: 'skipped', c });
  return prepare(c, 1, 'full', []);
}

/** Statuses whose ruling stands; pending, superseded, and duplicate findings are not settled decisions. */
const SETTLED: readonly ReviewFinding['status'][] = ['accepted', 'downgraded', 'fixed', 'rejected', 'closed-by-reviewer', 'closed-by-orchestrator'];

/** Prior-round rulings that reviewers re-raise only with new evidence. */
function settledRows(findings: readonly ReviewFinding[], round: number): SettledRow[] {
  return findings.filter((finding) => finding.round < round && SETTLED.includes(finding.status))
    .map((finding) => ({ id: finding.id, locus: finding.locus, defect: finding.defect, ruling: statusLabel(statusOf(finding)), reason: finding.resolution ?? '' }));
}

function prepare(c0: ReviewCtx, round: number, scope: RoundScope, carried: readonly CarriedRejection[]): S {
  const { pendingSpec, ...bound } = c0;
  const base = { ...bound, spec: pendingSpec ?? c0.spec, round, scope, carried, rows: [], drafts: [], promptPaths: {} };
  const settled = settledRows(base.findings, round);
  const { c, effect } = withEffect(base, 'prepare-review', (id) => ({ kind: 'prepare-review', id, review: base.spec, round, scope: { scope, carried, ...(settled.length ? { settled } : {}), affectedPaths: [...new Set(base.findings.flatMap((finding) => finding.fix?.paths ?? []))], ...(base.priorManifest ? { priorManifest: base.priorManifest } : {}) } }));
  return { state: { tag: 'prepare', c }, effects: [effect] };
}

function launchWave(c0: ReviewCtx, roster: readonly Row[], phase: 'cli' | 'native'): S {
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
  const fresh: ReviewFinding[] = c0.drafts.map((finding) => ({ ...finding, round, status: finding.dupOf === undefined ? 'open' : 'duplicate' }));
  const c1: ReviewCtx = { ...c0, findingBindings: { ...c0.findingBindings, ...Object.fromEntries(fresh.map((row) => [row.id, c0.reviewedRevision ?? c0.targetManifest ?? 'unbound'])) }, rounds: [...c0.rounds, { round, scope: c0.scope, reviewers, failed }] };
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

export function validateRulings(c: ReviewCtx, rulings: Readonly<Record<string, unknown>>): string | null {
  const open = roundOpen(c);
  for (const id of Object.keys(rulings)) if (!open.some((finding) => finding.id === id)) return `event.rulings.${id}: no open finding ${id} in round ${c.round}`;
  for (const finding of open) {
    const raw = rulings[finding.id];
    if (raw === undefined) return `event.rulings: missing ruling for ${finding.id}; every finding must be ruled`;
    const ruling = asRuling(raw);
    if (!ruling) return `event.rulings.${finding.id}.ruling: expected accept|reject|downgrade|needs-user`;
    if (finding.category === 'intent' && ruling.ruling !== 'needs-user') {
      if (!userRuled(ruling)) return `event.rulings.${finding.id}.ruling: expected needs-user, or accept|reject with the user's quote, for an intent finding`;
      continue; // NOTE: the user's quote is the recorded reason.
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
    if (finding.category === 'intent' && userRuled(ruling)) {
      const ruled = { ...finding, resolution: `user: ${ruling.quote}`, ...(ruling.fix ? { fix: ruling.fix } : {}) };
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
  if (c.spec.mode === 'fix') {
    const batch = c.findings.filter((finding) => finding.round === c.round && fixable(finding));
    if (batch.length) return enterFix(c, batch, 'main');
  }
  return decideNext(c);
}

/**
 * A target change met while consuming `RULINGS` is the fix in progress, not drift, when every ruling accepts and every
 * changed path lies in the fix paths those rulings admit (the reviewed file for artifact reviews).
 */
function preRulingFix(c: ReviewCtx, rulings: Readonly<Record<string, unknown>>, notice: ChangeNotice): boolean {
  // NOTE: a HEAD/comparison-identity change invalidates the reviewed baseline, so it always needs a drift decision.
  if (c.spec.mode !== 'fix' || notice.reason === 'Comparison identity changed.' || !notice.paths.length || notice.pathCount !== notice.paths.length) return false;
  const ruled = roundOpen(c).map((finding) => ({ finding, ruling: asRuling(rulings[finding.id]) }));
  if (!ruled.length || ruled.some(({ ruling }) => ruling?.ruling !== 'accept')) return false;
  const batch = ruled.map(({ finding, ruling }): ReviewFinding => ({ ...finding, status: 'accepted', ...(ruling?.fix ? { fix: ruling.fix } : {}) })).filter(fixable);
  // NOTE: notices carry repo-relative forward-slash paths; rulings may spell them with `./` or backslashes.
  const relative = (file: string) => file.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
  const allowed = new Set(batch.flatMap((finding) => fixPaths(c, finding)).map(relative));
  return notice.paths.every((file) => allowed.has(relative(file)));
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
  const { c, effect } = withEffect(c0, 'parse-artifact', (id) => ({ kind: 'parse-artifact', id, path: c0.spec.target, artifact }));
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
  const c = { ...c0, findings, history };
  const next = nextRound({ round: c.round, cap, findings: roundView(c) });
  if (!next.run) return settleOrOptIn(c);
  const carriedIds = new Set(next.carry);
  const pending = findings.filter((finding) => carriedIds.has(finding.id));
  const affinity = assignAffinity(pending.map((finding) => ({ id: finding.id, source: String(c.rows.find((row) => row['by'] === finding.sources[0])?.['slot'] ?? finding.sources[0] ?? '') })), c.spec.roster.filter((slot) => !slot.reserve));
  const carried = pending.map((finding): CarriedRejection => ({
    id: finding.id, slot: affinity[finding.id] ?? null, locus: finding.locus, defect: finding.defect, reason: finding.resolution ?? '',
  }));
  return prepare(c, next.round, next.scope, carried);
}

const optInItems = (c: ReviewCtx): FindingId[] => c.findings
  .filter((finding) => (isAccepted(finding) && (finding.scope === 'adjacent' || finding.severity === 'CONSIDER'))
    || (finding.status === 'needs-user' && finding.severity === 'CONSIDER'))
  .map((finding) => finding.id);

function settleOrOptIn(c: ReviewCtx): S {
  if (c.spec.mode === 'fix' && !c.optInAsked) {
    const items = optInItems(c);
    if (items.length) return stay({ tag: 'decide-opt-in', c: { ...c, optInAsked: true }, items });
  }
  return settle(c);
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
    default: return stay(state);
  }
}

const DECIDE_KIND = { 'decide-escalation': 'escalation', 'decide-needs-user': 'needs-user', 'decide-opt-in': 'opt-in' } as const;

export function validateReview(state: ReviewState, event: HostEvent): string | null {
  if (event.type === 'REVISE') return 'event.type: REVISE is unavailable in standalone review; author a new artifact and start a new run';
  switch (state.tag) {
    case 'rule': return event.type === 'RULINGS' ? validateRulings(state.c, event.rulings) : null;
    case 'native': return event.type === 'NATIVE_RESULTS' ? validateNativeResults(event.slots, state.slots) : null;
    case 'fix': return event.type === 'FIXES_APPLIED' ? validateFixes(state.clusters, event.clusters) : null;
    case 'decide-escalation': case 'decide-needs-user': case 'decide-opt-in': {
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
      return null;
    }
    case 'change-resolution': return event.type === 'DECISION' && event.kind === 'drift' && resolution(event.answer, state.notice) ? null : 'event.answer: bind the current change notice and evidence.';
    case 'target-check': return 'event: review target check is pending';
    case 'booting': case 'prepare': case 'wave': case 'fix-verify': case 'settled': case 'escalated': case 'failed': case 'skipped': case 'empty':
      return null;
    default: return never(state, 'review state');
  }
}

// SECTION: Step

export function stepReview(state: ReviewState, event: Event): S {
  if (state.tag === 'change-resolution') {
    if (event.type !== 'DECISION' || event.kind !== 'drift') return stay(state);
    const answer = resolution(event.answer, state.notice); if (!answer) return stay(state);
    const next = nextId(state.c.counters, state.c.path, 'check-review-target');
    const c = { ...state.c, counters: next.counters };
    return { state: { ...state.check, c, effectId: next.id, resolution: answer }, effects: [{ kind: 'check-review-target', id: next.id, review: c.spec, manifestPath: c.fixCandidate ?? c.targetManifest ?? c.priorManifest!, allowedPaths: [] }] };
  }
  if (state.tag === 'target-check') {
    if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return stay({ tag: 'failed', c: state.c, detail: event.detail });
    if (event.type !== 'REVIEW_TARGET_CHECKED' || !answers(event, state.effectId)) return stay(state);
    if (event.result === 'changed') {
      if (!event.notice) return stay({ tag: 'failed', c: state.c, detail: 'Changed target lacks binding evidence.' });
      if (!state.resolution && state.before.tag === 'rule' && state.pending.type === 'RULINGS' && preRulingFix(state.before.c, state.pending.rulings, event.notice)) {
        // NOTE: the reviewed baseline stays bound, so the FIXES_APPLIED check re-admits these edits through the fix clusters' allowed paths.
        return stepReviewUnchecked({ ...state.before, c: { ...state.before.c, counters: state.c.counters, reviewedRevision: event.notice.afterHash } }, state.pending);
      }
      if (!state.resolution || state.resolution.afterHash !== event.notice.afterHash) return stay({ tag: 'change-resolution', c: state.c, check: state, notice: event.notice });
      if (state.resolution.action === 'refresh') {
        if (state.before.tag === 'fix' || state.before.tag === 'fix-verify') return refreshFix(state, state.before, event.manifestPath, event.notice.afterHash);
        const round = state.before.tag === 'prepare' ? state.c.round : state.c.round + 1;
        // NOTE: at the cap no later round reviews the refreshed content, so accepted findings stand and cap-round fixes exit as fixedUnreviewed; unruled or disputed findings escalate.
        const settles = round > state.c.spec.cap && !state.c.findings.some((row) => row.status === 'open' || row.status === 'pending-rejection' || row.status === 'needs-user');
        const superseded = ['open', 'accepted', 'pending-rejection', 'needs-user'].filter((status) => !settles || status !== 'accepted');
        const c = { ...state.c, targetManifest: event.manifestPath, priorManifest: event.manifestPath, reviewedRevision: event.notice.afterHash,
          findings: state.c.findings.map((row): ReviewFinding => superseded.includes(row.status) ? { ...row, status: 'superseded' } : row), carried: [] };
        delete c.fixCandidate;
        if (settles) return settleOrOptIn(c);
        if (round > c.spec.cap) return stay({ tag: 'escalated', c, escalation: { kind: 'deadlock', ids: c.findings.map((row) => row.id) } });
        return prepare(c, round, 'full', c.carried);
      }
      return stay({ tag: 'decide-escalation', c: state.c, escalation: { kind: 'deadlock', ids: state.c.findings.map((row) => row.id) } });
    }
    const before = state.before;
    if (!('c' in before)) return stay({ tag: 'failed', c: state.c, detail: 'target-changed: missing review context' });
    const verifying = before.tag === 'fix-verify';
    const verified = verifying && ((state.pending.type === 'VERIFY_DONE' && state.pending.results.every((row) => row['exit'] === 0))
      || (state.pending.type === 'ARTIFACT_PARSED' && state.pending.defects.length === 0));
    const candidate = state.pending.type === 'FIXES_APPLIED' || (verifying && !verified);
    const c: ReviewCtx = { ...before.c, counters: state.c.counters, ...(event.notice ? { reviewedRevision: event.notice.afterHash } : {}),
      ...(candidate ? { fixCandidate: event.manifestPath } : { targetManifest: event.manifestPath }) };
    if (verified) delete c.fixCandidate;
    return stepReviewUnchecked({ ...before, c }, state.pending);
  }
  const manifest = 'c' in state ? state.c.fixCandidate ?? state.c.targetManifest ?? state.c.priorManifest : undefined;
  const consumes = (state.tag === 'prepare' && event.type === 'REVIEW_PREPARED' && answers(event, state.c.effectId))
    || (state.tag === 'native' && event.type === 'NATIVE_RESULTS' && validateNativeResults(event.slots, state.slots) === null)
    || (state.tag === 'wave' && (event.type === 'WAVE_DONE' || (event.type === 'WAVE_STARTED' && 'completed' in event)) && answers(event, state.c.effectId))
    || (state.tag === 'rule' && event.type === 'RULINGS' && validateRulings(state.c, event.rulings) === null)
    || (state.tag === 'fix' && event.type === 'FIXES_APPLIED' && validateFixes(state.clusters, event.clusters) === null)
    || (state.tag === 'fix-verify' && (event.type === 'VERIFY_DONE' || event.type === 'ARTIFACT_PARSED') && answers(event, state.c.effectId))
    || ((state.tag === 'decide-needs-user' || state.tag === 'decide-opt-in') && event.type === 'DECISION' && event.kind === DECIDE_KIND[state.tag] && validateReview(state, event) === null);
  if (manifest && consumes && 'c' in state) {
    const next = nextId(state.c.counters, state.c.path, 'check-review-target');
    const c = { ...state.c, counters: next.counters };
    const applied = state.tag === 'fix' && event.type === 'FIXES_APPLIED' ? state.clusters.filter((cluster) => event.clusters.some((row) => row['clusterId'] === cluster.clusterId && row['status'] !== 'failed')) : [];
    const allowedPaths = applied.length ? c.spec.kind === 'code' ? applied.flatMap((cluster) => cluster.paths) : [c.spec.target] : [];
    return { state: { tag: 'target-check', c, before: state, pending: event, effectId: next.id }, effects: [{ kind: 'check-review-target', id: next.id, review: c.spec, manifestPath: manifest, allowedPaths }] };
  }
  return stepReviewUnchecked(state, event);
}

/**
 * Refresh after applied fixes keeps finding statuses: a parked receipt proceeds to fix-verify, and a parked verification
 * result is discarded and reissued, so findings become `fixed` only after the refreshed content passes.
 */
function refreshFix(state: Extract<ReviewState, { tag: 'target-check' }>, before: Extract<ReviewState, { tag: 'fix' | 'fix-verify' }>, manifestPath: string, afterHash: string): S {
  // NOTE: `priorManifest` stays on the reviewed content so the next round still sees the fix as a delta.
  const c: ReviewCtx = { ...before.c, counters: state.c.counters, targetManifest: manifestPath, reviewedRevision: afterHash };
  delete c.fixCandidate;
  if (before.tag === 'fix') return stepReviewUnchecked({ ...before, c }, state.pending);
  const { tag: _tag, c: _c, ...recovery } = before;
  return issueFixVerify(c, recovery);
}

function stepReviewUnchecked(state: Exclude<ReviewState, { tag: 'target-check' | 'change-resolution' }>, event: Event): S {
  if (event.type === 'EFFECT_FAILED' && 'c' in state && answers(event, state.c.effectId)
    && (state.tag === 'prepare' || state.tag === 'wave' || state.tag === 'fix-verify')) {
    return stay({ tag: 'failed', c: state.c, detail: `${event.cls}: ${event.detail}` });
  }
  switch (state.tag) {
    case 'booting': return stay(state);
    case 'prepare':
      if (event.type !== 'REVIEW_PREPARED' || !answers(event, state.c.effectId)) return stay(state);
      if (event.scope['empty'] === true) return stay({ tag: 'empty', c: state.c });
      return launchWave({ ...state.c, promptPaths: event.promptPaths, ...(typeof event.scope['manifestPath'] === 'string' ? { priorManifest: event.scope['manifestPath'], targetManifest: String(event.scope['bindingPath'] ?? event.scope['manifestPath']) } : {}) }, waveRoster(state.c.spec.roster, state.c.spec.kind, event.promptPaths), 'cli');
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
        return afterFixVerify(state, event.defects.map((defect) => String(defect['message'] ?? defect['code'] ?? 'lint defect')));
      }
      if (event.type === 'VERIFY_DONE' && answers(event, state.c.effectId)) {
        const red = event.results.filter((result) => result['exit'] !== 0);
        return afterFixVerify(state, red.map((result) => `${String(result['command'])} exited ${String(result['exit'])} (${String(result['logPath'])})`));
      }
      return stay(state);
    case 'decide-escalation': case 'decide-needs-user': case 'decide-opt-in':
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
    case 'change-resolution': case 'decide-escalation': case 'decide-needs-user': case 'decide-opt-in': return 'decide' as const;
    case 'settled': case 'escalated': case 'failed': case 'skipped': case 'empty': return 'done' as const;
    case 'booting': case 'prepare': case 'wave': case 'fix-verify': case 'target-check': return null;
    default: return never(state, 'review state');
  }
}

function decide(state: Extract<ReviewState, { tag: 'decide-escalation' | 'decide-needs-user' | 'decide-opt-in' }>): Decide {
  const byId = (ids: readonly FindingId[]) => state.c.findings.filter((finding) => ids.includes(finding.id));
  switch (state.tag) {
    case 'decide-escalation':
      return { kind: 'escalation', question: `Review halted on ${state.escalation.kind} of ${state.escalation.ids.join(', ')}; inform the user and answer stop.`, options: ['stop'], items: state.escalation.ids };
    case 'decide-needs-user':
      return { kind: 'needs-user', question: 'Ask the user to rule each listed finding; relay { <id>: { ruling: accept|reject|downgrade, quote: <user words>, fix?: { affectedPaths, dependsOn, verification } } }. Accepted in-scope findings enter the fix batch.', options: ['accept', 'reject', 'downgrade'], items: byId(state.ids) };
    case 'decide-opt-in':
      return { kind: 'opt-in', question: 'Offer the user these adjacent and CONSIDER items once; relay the selected ids ([] for none).', options: ['<selected finding ids>'], items: byId(state.items) };
    default: return never(state, 'decide state');
  }
}

export function reviewData(state: ReviewState): Readonly<Record<string, unknown>> {
  if (state.tag === 'change-resolution') return { kind: 'drift', question: 'Resolve changed reviewed content before consuming the parked receipt.', notice: state.notice, options: ['preserve', 'refresh', 'reconcile', 'escalate'] };
  switch (state.tag) {
    case 'native': return { round: state.c.round, slots: state.slots };
    case 'rule': {
      const { c } = state;
      return {
        round: c.round, cap: c.spec.cap, threshold: threshold(c.round, c.spec.cap), findings: roundOpen(c),
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
    case 'decide-escalation': case 'decide-needs-user': case 'decide-opt-in': return decide(state);
    case 'settled': return { outcome: 'complete', summary: `review settled after ${state.c.round} round(s)`, completion: { exitSummary: state.exit, followUps: state.followUps } };
    case 'escalated': return { outcome: 'stopped', summary: `review escalated: ${state.escalation.kind} (${state.escalation.ids.join(', ')})` };
    case 'failed': return { outcome: 'failed', summary: state.detail };
    case 'skipped': return { outcome: 'skipped', summary: 'review skipped (rounds 0)' };
    case 'empty': return { outcome: 'no-reviewable-changes', summary: 'no reviewable changes' };
    case 'booting': case 'prepare': case 'wave': case 'fix-verify': case 'target-check': return { round: 'c' in state ? state.c.round : 0 };
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
  ...[
    ['prepare', 'REVIEW_PREPARED'], ['native', 'NATIVE_RESULTS'], ['wave', 'WAVE_DONE'], ['wave', 'WAVE_STARTED'], ['rule', 'RULINGS'],
    ['fix', 'FIXES_APPLIED'], ['fix-verify', 'VERIFY_DONE'], ['fix-verify', 'ARTIFACT_PARSED'],
    ['decide-needs-user', 'DECISION'], ['decide-opt-in', 'DECISION'],
  ].map(([from, on]) => ({ from: from!, on: on!, to: 'target-check' })),
  ...['wave', 'rule', 'native', 'fix', 'fix-verify', 'prepare', 'settled', 'failed', 'decide-needs-user', 'decide-opt-in', 'decide-escalation'].map((to) => ({ from: 'target-check', on: 'REVIEW_TARGET_CHECKED', to })),
  { from: 'target-check', on: 'REVIEW_TARGET_CHECKED', to: 'empty' },
  { from: 'target-check', on: 'REVIEW_TARGET_CHECKED', to: 'change-resolution' },
  { from: 'target-check', on: 'REVIEW_TARGET_CHECKED', to: 'escalated' },
  { from: 'change-resolution', on: 'DECISION', to: 'target-check' },
  { from: 'target-check', on: 'EFFECT_FAILED', to: 'failed' },
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
  { from: 'decide-escalation', on: 'DECISION', to: 'escalated' },
  { from: 'decide-opt-in', on: 'DECISION', to: 'fix' },
  { from: 'decide-opt-in', on: 'DECISION', to: 'settled' },
] as const;

/** Standalone reviewer over a code target (root builds specs itself; this machine serves tier-1 tests and parity). */
export const reviewMachine: Machine<ReviewState> = {
  initial: () => ({ tag: 'booting', counters: {} }),
  step(state, event) {
    if (state.tag === 'booting' && event.type === 'RUN_STARTED') {
      const kind: ReviewKind = event.overrides['kind'] === 'plan' || event.overrides['kind'] === 'design' ? event.overrides['kind'] : 'code';
      const built = reviewSpecFromRun(event, kind, event.fix ? 'fix' : 'report', event.argument);
      if (built.ok) return beginReview(built.spec, 'review', state.counters);
      const spec: ReviewSpec = { kind, mode: 'report', target: event.argument, cap: 0, breadth: 0, context: '', roster: [], timeoutMs: DEFAULT_TIMEOUT_MS };
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
