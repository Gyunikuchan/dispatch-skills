import type { Await, Event, HostEvent, Machine, TreeFingerprint } from '../core/types.ts';
import type { ParsedPlan, PlanCriterion } from '../domain/types.ts';
import type { Context, ImplementState } from './implement.ts';
import { asParsedPlan, approvedPaths, commandMappings, recoverySnapshot, driftAnswer, isFingerprint, artifactRelative } from './implement-types.ts';
import { classifyDrift } from '../policy/drift.ts';
import { beginReview, reviewAwait, reviewData, reviewSpecFromRun, stepReview, validateReview, type ReviewState } from './review.ts';
import { answers, nextId, stay, type Step } from './types.ts';

export type RevisionContext = {
  parent: ImplementState; c: Context; original: ParsedPlan; originalHash: string; workingPath: string;
  reason: string; evidence: string; plan: ParsedPlan | null; hash: string | null; changed: readonly string[]; removed: readonly string[]; grew: boolean;
};
export type RevisionState = { tag: 'author'; r: RevisionContext; error: string | null }
  | { tag: 'checking-host-event'; r: RevisionContext; parent: RevisionState; parked: HostEvent; effectId: string }
  | { tag: 'drift'; r: RevisionContext; parent: RevisionState; parked: HostEvent; paths: readonly string[]; fingerprint: TreeFingerprint }
  | { tag: 'parse'; r: RevisionContext; effectId: string; afterReview: boolean }
  | { tag: 'review'; r: RevisionContext; review: ReviewState }
  | { tag: 'resume'; r: RevisionContext }
  | { tag: 'refused'; r: RevisionContext; error: string };
type S = Step<RevisionState>;
const semantic = (row: PlanCriterion) => JSON.stringify({ title: row.title, changes: [...row.changes].sort(), verify: [...row.verify].sort((a, b) => a.command.localeCompare(b.command)), evidence: row.evidence, preExisting: row.preExisting, redException: row.redException, testRationale: row.testRationale, review: row.review, enforcementInfeasibility: row.enforcementInfeasibility });

export function revisionDelta(original: ParsedPlan, revised: ParsedPlan): { changed: string[]; removed: string[]; grew: boolean } {
  const changed = revised.criteria.filter((row) => { const old = original.criteria.find((r) => r.id === row.id); return !old || semantic(old) !== semantic(row); }).map((row) => row.id);
  return { changed, removed: original.criteria.filter((row) => !revised.criteria.some((r) => r.id === row.id)).map((row) => row.id),
    grew: approvedPaths(revised).some((file) => !approvedPaths(original).includes(file)) || commandMappings(revised).some((m) => !commandMappings(original).some((old) => old.command === m.command)) };
}

export function beginRevision(parent: ImplementState, event: Extract<HostEvent, { type: 'REVISE' }>): S {
  if (!('c' in parent) || !parent.c?.plan || !parent.c.planHash) throw new Error('Revision requires a governed implementation context.');
  const c = parent.c;
  const session = typeof c.run.overrides['sessionDir'] === 'string' ? c.run.overrides['sessionDir'] : null;
  if (!session) throw new Error('Revision requires the journal-bound sessionDir.');
  const workingPath = `${session.replace(/[\\/]+$/, '')}/revision-${c.revisions.length + 1}.plan.md`;
  return stay({ tag: 'author', error: null, r: { parent, c, original: c.plan!, originalHash: c.planHash!, workingPath, reason: event.reason, evidence: event.evidence, plan: null, hash: null, changed: [], removed: [], grew: false } });
}
export function initialRevision(parent: ImplementState, event: Extract<HostEvent, { type: 'REVISE' }>): RevisionState { return beginRevision(parent, event).state; }

function parse(r: RevisionContext, afterReview: boolean): S {
  const next = nextId(r.c.counters, 'implement.revision', 'parse-artifact');
  return { state: { tag: 'parse', r: { ...r, c: { ...r.c, counters: next.counters } }, effectId: next.id, afterReview }, effects: [{ kind: 'parse-artifact', id: next.id, path: r.workingPath, artifact: 'plan' }] };
}
function reviewed(r: RevisionContext, result: Step<ReviewState>): S {
  const review = result.state;
  const next = { ...r, c: { ...r.c, counters: 'c' in review ? review.c.counters : r.c.counters, revisionReviewRound: 'c' in review ? Math.max(r.c.revisionReviewRound, review.c.round) : r.c.revisionReviewRound } };
  if (review.tag === 'settled' || review.tag === 'skipped') return parse(next, true);
  if (review.tag === 'failed' || review.tag === 'escalated' || review.tag === 'empty') return stay({ tag: 'refused', r: next, error: `Revision delta review did not settle: ${review.tag}` });
  return { state: { tag: 'review', r: next, review }, effects: result.effects };
}
function applyRevision(state: RevisionState, event: Event): S {
  switch (state.tag) {
    case 'author': return event.type === 'AUTHORED' && event.path === state.r.workingPath ? parse(state.r, false) : stay(state);
    case 'parse': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return stay({ tag: 'author', r: state.r, error: event.detail });
      if (event.type !== 'ARTIFACT_PARSED' || !answers(event, state.effectId) || event.kind !== 'plan') return stay(state);
      const plan = asParsedPlan(event.parsed);
      if (!plan || event.defects.length || !/^sha256:[a-f0-9]{64}$/.test(event.hash)) return stay({ tag: 'author', r: state.r, error: 'Revision parser rejected its concrete plan/hash.' });
      if (plan.box['TL;DR'] !== state.r.original.box['TL;DR']) return stay({ tag: 'refused', r: state.r, error: 'TL;DR objective cannot change during plan revision.' });
      const r = { ...state.r, plan, hash: event.hash, ...revisionDelta(state.r.original, plan) };
      if (state.afterReview || event.hash === r.originalHash) return stay({ tag: 'resume', r });
      const built = reviewSpecFromRun(r.c.run, 'plan', 'fix', r.workingPath);
      if (!built.ok) return stay({ tag: 'refused', r, error: built.error });
      const offset = r.c.revisionReviewRound;
      const result = beginReview({ ...built.spec, cap: built.spec.cap > 0 ? built.spec.cap + offset : 0, context: `Review only the governed delta between the immutable original and working copy.\n${JSON.stringify({ beforeHash: r.originalHash, afterHash: event.hash, before: r.original.governedText, after: plan.governedText, changedCriteria: r.changed, removedCriteria: r.removed, reason: r.reason, evidence: r.evidence })}` }, 'implement.revision.review', r.c.counters);
      if ('c' in result.state) result.state = { ...result.state, c: { ...result.state.c, round: result.state.c.round + offset, scope: 'delta' } };
      result.effects = result.effects.map((effect) => effect.kind === 'prepare-review' ? { ...effect, round: effect.round + offset, scope: { ...effect.scope, scope: 'delta', sinceHash: r.originalHash, beforeText: r.original.governedText, afterText: plan.governedText, delta: true, criteria: r.changed, removed: r.removed } } : effect);
      return reviewed(r, result);
    }
    case 'review': return reviewed(state.r, stepReview(state.review, event));
    case 'resume': case 'refused': case 'checking-host-event': case 'drift': return stay(state);
  }
}
export function stepRevision(state: RevisionState, event: Event): S {
  if (state.tag === 'checking-host-event') {
    if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return stay({ tag: 'refused', r: state.r, error: `Revision snapshot failed: ${event.detail}` });
    if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId) || !isFingerprint(event.fingerprint)) return stay(state);
    const paths = Array.isArray(event.diff['paths']) ? event.diff['paths'] as string[] : [];
    const metadata = recoverySnapshot(event.fingerprint);
    const artifact = artifactRelative(event.fingerprint, state.r.workingPath);
    const classified = classifyDrift({ awaiting: revisionAwait(state.parent) ?? 'done', ctx: { stagePaths: [artifact], testPaths: [], testsOnly: false, artifactPath: artifact }, changed: paths, callerDirty: recoverySnapshot(state.r.c.startFingerprint)?.callerDirty ?? [], hashManifestDirs: metadata?.hashManifestDirs ?? [] });
    classified.drift.push(...classified.autoAdopt.filter((file) => !(metadata?.verifiedManifestDirs ?? []).includes(file.slice(0, -'skill-hashes.json'.length).replace(/\/$/, ''))));
    if (classified.drift.length) return stay({ tag: 'drift', r: state.r, parent: state.parent, parked: state.parked, paths: classified.drift, fingerprint: event.fingerprint });
    return applyRevision({ ...state.parent, r: { ...state.r, c: { ...state.r.c, lastFingerprint: event.fingerprint } } }, state.parked);
  }
  if (state.tag === 'drift') {
    if (event.type !== 'DECISION' || event.kind !== 'drift') return stay(state);
    const answer = driftAnswer(event.answer, state.paths);
    if (!answer) return stay(state);
    if (Object.values(answer).includes('stop')) return stay({ tag: 'refused', r: state.r, error: 'User stopped revision drift.' });
    const r = { ...state.r, c: { ...state.r.c, lastFingerprint: state.fingerprint, adoptedPaths: [...new Set([...state.r.c.adoptedPaths, ...state.paths])], finalFocus: [...new Set([...state.r.c.finalFocus, ...state.paths])] } };
    return applyRevision({ ...state.parent, r }, state.parked);
  }
  if (['AUTHORED', 'NATIVE_RESULTS', 'RULINGS', 'FIXES_APPLIED', 'DECISION'].includes(event.type) && revisionAwait(state) !== null && revisionAwait(state) !== 'done') {
    if (validateRevision(state, event as HostEvent)) return stay(state);
    const next = nextId(state.r.c.counters, 'implement.revision', 'snapshot');
    const r = { ...state.r, c: { ...state.r.c, counters: next.counters } };
    return { state: { tag: 'checking-host-event', r, parent: state, parked: event as HostEvent, effectId: next.id }, effects: [{ kind: 'snapshot', id: next.id, since: r.c.lastFingerprint }] };
  }
  return applyRevision(state, event);
}
export function reboundRevision(state: Extract<RevisionState, { tag: 'resume' }>): Context {
  const r = state.r, plan = r.plan!, hash = r.hash!;
  const evidence = Object.fromEntries(Object.entries(r.c.evidence).filter(([id]) => plan.criteria.some((row) => row.id === id) && !r.changed.includes(id)).map(([id, row]) => [id, { ...row, planHash: hash }]));
  const records = Object.fromEntries(Object.entries(r.c.records).filter(([command]) => {
    const next = commandMappings(plan).find((row) => row.command === command), old = commandMappings(r.original).find((row) => row.command === command);
    return next && old && JSON.stringify(next) === JSON.stringify(old) && !next.criteria.some((id) => r.changed.includes(id));
  }));
  return { ...r.c, plan, planHash: hash, planPath: r.workingPath, evidence, records, criterionMutation: Object.fromEntries(plan.criteria.map((row) => [row.id, r.changed.includes(row.id) ? r.c.mutationEpoch : r.c.criterionMutation[row.id] ?? 0])),
    concerns: [...r.c.concerns, ...r.removed.map((id) => `Revision removed criterion ${id}.`)], revisions: [...r.c.revisions, { artifact: 'plan', reason: r.reason, beforeHash: r.originalHash, afterHash: hash, rebind: { retained: Object.keys(evidence), pending: r.changed, removed: r.removed } }] };
}
export function revisionAwait(state: RevisionState): Await | null { return state.tag === 'author' ? 'author' : state.tag === 'review' ? reviewAwait(state.review) : state.tag === 'drift' ? 'decide' : state.tag === 'resume' || state.tag === 'refused' ? 'done' : null; }
export function revisionData(state: RevisionState): Record<string, unknown> { return state.tag === 'author' ? { artifact: 'plan', path: state.r.workingPath, originalPath: state.r.c.planPath, originalHash: state.r.originalHash, reason: state.r.reason, error: state.error } : state.tag === 'review' ? { ...reviewData(state.review), delta: state.r.changed } : { changed: state.r.changed, removed: state.r.removed, grew: state.r.grew, ...(state.tag === 'refused' ? { error: state.error } : {}) }; }
export function validateRevision(state: RevisionState, event: HostEvent): string | null {
  if (event.type === 'REVISE') return 'event.type: settle the outstanding revision first.';
  if (state.tag === 'drift' && (event.type !== 'DECISION' || event.kind !== 'drift' || !driftAnswer(event.answer, state.paths))) return 'event.answer: rule adopt or stop for every revision drift path.';
  if (state.tag === 'author' && (event.type !== 'AUTHORED' || event.path !== state.r.workingPath)) return 'event.path: expected the session revision working copy.';
  return state.tag === 'review' ? validateReview(state.review, event) : null;
}
export const revisionTransitions = [
  ...['author', 'review'].flatMap((from) => ['AUTHORED', 'NATIVE_RESULTS', 'RULINGS', 'FIXES_APPLIED', 'DECISION'].map((on) => ({ from, on, to: 'checking-host-event' }))),
  ...['parse', 'review', 'drift'].map((to) => ({ from: 'checking-host-event', on: 'SNAPSHOT', to })),
  { from: 'checking-host-event', on: 'EFFECT_FAILED', to: 'refused' },
  ...['parse', 'review', 'refused'].map((to) => ({ from: 'drift', on: 'DECISION', to })),
  { from: 'author', on: 'AUTHORED', to: 'parse' }, { from: 'parse', on: 'ARTIFACT_PARSED', to: 'review' }, { from: 'parse', on: 'ARTIFACT_PARSED', to: 'resume' }, { from: 'parse', on: 'ARTIFACT_PARSED', to: 'refused' }, { from: 'parse', on: 'ARTIFACT_PARSED', to: 'author' }, { from: 'parse', on: 'EFFECT_FAILED', to: 'author' },
  ...['REVIEW_PREPARED', 'WAVE_DONE', 'RULINGS', 'FIXES_APPLIED', 'VERIFY_DONE', 'DECISION', 'EFFECT_FAILED'].flatMap((on) => [{ from: 'review', on, to: 'parse' }, { from: 'review', on, to: 'refused' }]),
];
export const revisionMachine: Machine<RevisionState> = { initial: () => { throw new Error('Use beginRevision with the saved governed parent.'); }, step: stepRevision, awaitOf: revisionAwait, project: (state) => ({ at: `revision › ${state.tag}`, data: revisionData(state) }), validate: validateRevision, transitions: revisionTransitions };
