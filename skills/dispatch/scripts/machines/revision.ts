import type { Await, Event, HostEvent, TreeFingerprint, RevisionScopeProposal, ScopeAdjustment, ScopeDelta } from '../core/types.ts';
import { stableValue } from '../domain/stable-value.ts';
import type { ParsedPlan, PlanCriterion } from '../domain/types.ts';
import { effectivePlan, type Context, type ImplementState } from './implement.ts';
import { invalidatesIntegration, reconcileTasks } from './implement-tasks.ts';
import { asParsedPlan, approvedPaths, commandMappings, recoverySnapshot, driftAnswer, isFingerprint, artifactRelative } from './implement-types.ts';
import { classifyDrift } from '../policy/drift.ts';
import { beginReview, reviewAwait, reviewData, reviewSpecFromRun, stepReview, validateReview, type ReviewState } from './review.ts';
import { answers, isRecord, nextId, stay, type Step } from './types.ts';
import { validateDesignTraceability } from '../domain/plan.ts';

export type RevisionContext = {
  parent: ImplementState; c: Context; original: ParsedPlan; originalHash: string; workingPath: string;
  reason: string; evidence: string; plan: ParsedPlan | null; hash: string | null; changed: readonly string[]; removed: readonly string[]; grew: boolean; scopeAdjudicated: boolean;
};
export type RevisionState = { tag: 'author'; r: RevisionContext; error: string | null }
  | { tag: 'checking-host-event'; r: RevisionContext; parent: RevisionState; parked: HostEvent; effectId: string }
  | { tag: 'drift'; r: RevisionContext; parent: RevisionState; parked: HostEvent; paths: readonly string[]; fingerprint: TreeFingerprint }
  | { tag: 'parse'; r: RevisionContext; effectId: string; afterReview: boolean }
  | { tag: 'review'; r: RevisionContext; review: ReviewState }
  | { tag: 'scope-adjudication'; r: RevisionContext; request: RevisionScopeProposal }
  | { tag: 'scope-user-decision'; r: RevisionContext; request: RevisionScopeProposal; orchestratorRationale: string }
  | { tag: 'resume'; r: RevisionContext }
  | { tag: 'stopped'; r: RevisionContext; summary: string }
  | { tag: 'refused'; r: RevisionContext; error: string };
type S = Step<RevisionState>;
const semantic = (row: PlanCriterion) => JSON.stringify({ title: row.title, changes: [...row.changes].sort(), verify: [...row.verify].sort((a, b) => a.command.localeCompare(b.command)), evidence: row.evidence, preExisting: row.preExisting, redException: row.redException, testRationale: row.testRationale, review: row.review, enforcementInfeasibility: row.enforcementInfeasibility });

export function revisionDelta(original: ParsedPlan, revised: ParsedPlan): { changed: string[]; removed: string[]; grew: boolean } {
  const changed = revised.criteria.filter((row) => { const old = original.criteria.find((r) => r.id === row.id); return !old || semantic(old) !== semantic(row); }).map((row) => row.id);
  const scope = revisionScopeDelta(original, revised, changed);
  return { changed, removed: original.criteria.filter((row) => !revised.criteria.some((r) => r.id === row.id)).map((row) => row.id),
    grew: Object.values(scope).some((items) => items.length > 0) };
}

function revisionScopeDelta(original: ParsedPlan, revised: ParsedPlan, changed: readonly string[]): ScopeDelta {
  const oldPaths = new Set(approvedPaths(original));
  const oldCommands = new Set(commandMappings(original).map((row) => row.command));
  const oldObligations = new Set(original.keyDecisions);
  const oldDuties = new Set(original.verification.manual);
  const scopeContract = (row: PlanCriterion | undefined) => row && JSON.stringify({
    changes: [...row.changes].sort(), verify: [...row.verify].sort((a, b) => a.command.localeCompare(b.command)),
    evidence: row.evidence, preExisting: row.preExisting, redException: row.redException,
    testRationale: row.testRationale, review: row.review, enforcementInfeasibility: row.enforcementInfeasibility,
  });
  const expandedCriteria = changed.filter((id) => {
    const before = original.criteria.find((row) => row.id === id);
    const after = revised.criteria.find((row) => row.id === id);
    return !!after && (!before || scopeContract(before) !== scopeContract(after));
  });
  return {
    paths: approvedPaths(revised).filter((file) => !oldPaths.has(file)).sort(),
    criteria: expandedCriteria,
    criterionDefinitions: revised.criteria.filter((row) => expandedCriteria.includes(row.id)).map((row) => ({
      id: row.id, title: row.title, changes: [...row.changes], verify: row.verify.map((item) => ({ ...item })), evidence: row.evidence,
      preExisting: row.preExisting, redException: row.redException, testRationale: row.testRationale, review: row.review, enforcementInfeasibility: row.enforcementInfeasibility,
    })),
    obligations: revised.keyDecisions.filter((item) => !oldObligations.has(item)),
    commands: commandMappings(revised).filter((row) => !row.final && !oldCommands.has(row.command)).map((row) => row.command),
    finalCommands: commandMappings(revised).filter((row) => row.final && !oldCommands.has(row.command)).map((row) => row.command),
    phaseDuties: revised.verification.manual.filter((item) => !oldDuties.has(item)),
    increments: [],
  };
}

function hasScopeDelta(delta: ScopeDelta): boolean { return Object.values(delta).some((items) => Array.isArray(items) && items.length > 0); }

function revisionProposal(r: RevisionContext): RevisionScopeProposal {
  const plan = r.plan!;
  const delta = revisionScopeDelta(r.original, plan, r.changed);
  const taskIds = plan.tasks.filter((task) => task.criteria.some((id) => delta.criteria.includes(id)) || task.paths.some((path) => delta.paths.includes(path)) || !r.original.tasks.some((old) => old.id === task.id)).map((task) => task.id);
  const affectedTasks = taskIds.length ? taskIds : plan.tasks.map((task) => task.id);
  const suffix = (value: string) => value.replace(/^sha256:/, '').slice(-12);
  return {
    requestId: `plan-revision-${suffix(r.originalHash)}-${suffix(r.hash!)}`,
    source: 'plan-revision', baseArtifactHash: r.originalHash, proposedArtifactHash: r.hash!,
    affectedTasks, rationale: `${r.reason}: ${r.evidence}`, delta,
  };
}

function afterReview(r: RevisionContext): S {
  if (!r.c.levelGatePassed) return stay({ tag: 'resume', r });
  const request = revisionProposal(r);
  return hasScopeDelta(request.delta) ? stay({ tag: 'scope-adjudication', r, request }) : stay({ tag: 'resume', r });
}

export function beginRevision(parent: ImplementState, event: Extract<HostEvent, { type: 'REVISE' }>): S {
  if (!('c' in parent) || !parent.c?.plan || !parent.c.planHash) throw new Error('Revision requires a governed implementation context.');
  const c = parent.c;
  const session = typeof c.run.overrides['sessionDir'] === 'string' ? c.run.overrides['sessionDir'] : null;
  if (!session) throw new Error('Revision requires the journal-bound sessionDir.');
  const workingPath = `${session.replace(/[\\/]+$/, '')}/revision-${c.revisions.length + 1}.plan.md`;
  return stay({ tag: 'author', error: null, r: { parent, c, original: effectivePlan(c), originalHash: c.planHash!, workingPath, reason: event.reason, evidence: event.evidence, plan: null, hash: null, changed: [], removed: [], grew: false, scopeAdjudicated: false } });
}

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
      if (state.r.c.designBinding) {
        const defects = validateDesignTraceability(plan, state.r.c.designBinding);
        if (defects.length) return stay({ tag: 'author', r: state.r, error: defects.join(' ') });
      }
      if (plan.box['TL;DR'] !== state.r.original.box['TL;DR']) return stay({ tag: 'refused', r: state.r, error: 'TL;DR objective cannot change during plan revision.' });
      const r = { ...state.r, plan, hash: event.hash, ...revisionDelta(state.r.original, plan) };
      if (state.afterReview || event.hash === r.originalHash) return afterReview(r);
      const built = reviewSpecFromRun(r.c.run, 'plan', 'fix', r.workingPath);
      if (!built.ok) return stay({ tag: 'refused', r, error: built.error });
      const offset = r.c.revisionReviewRound;
      const result = beginReview({ ...built.spec, cap: built.spec.cap > 0 ? built.spec.cap + offset : 0, context: `Review only the governed delta between the immutable original and working copy.\n${JSON.stringify({ beforeHash: r.originalHash, afterHash: event.hash, before: r.original.governedText, after: plan.governedText, changedCriteria: r.changed, removedCriteria: r.removed, reason: r.reason, evidence: r.evidence })}` }, 'implement.revision.review', r.c.counters);
      if ('c' in result.state) result.state = { ...result.state, c: { ...result.state.c, round: result.state.c.round + offset, scope: 'delta' } };
      result.effects = result.effects.map((effect) => effect.kind === 'prepare-review' ? { ...effect, round: effect.round + offset, scope: { ...effect.scope, scope: 'delta', sinceHash: r.originalHash, beforeText: r.original.governedText, afterText: plan.governedText, delta: true, criteria: r.changed, removed: r.removed } } : effect);
      return reviewed(r, result);
    }
    case 'review': return reviewed(state.r, stepReview(state.review, event));
    case 'scope-adjudication': {
      if (event.type === 'DECISION' && event.kind === 'run-stop') return stay({ tag: 'stopped', r: state.r, summary: `User stopped during plan-revision scope adjudication: ${(event.answer as { quote: string }).quote}` });
      if (event.type !== 'DECISION' || event.kind !== 'scope-deviation') return stay(state);
      const answer = event.answer as { by: 'orchestrator'; request: RevisionScopeProposal; ruling: 'approve' | 'disagree'; rationale: string };
      if (answer.ruling === 'disagree') return stay({ tag: 'scope-user-decision', r: state.r, request: state.request, orchestratorRationale: answer.rationale });
      const adjustment: ScopeAdjustment = { proposal: state.request, approvedBy: 'orchestrator', rationale: answer.rationale, ...(state.r.c.designBinding ? { ownerIncrement: state.r.c.designBinding.increment } : {}) };
      const c = { ...state.r.c, scopeAdjustments: [...state.r.c.scopeAdjustments, adjustment], scopeNotice: { requestId: state.request.requestId, approvedBy: adjustment.approvedBy, rationale: adjustment.rationale } };
      return stay({ tag: 'resume', r: { ...state.r, c, scopeAdjudicated: true } });
    }
    case 'scope-user-decision': {
      if (event.type !== 'DECISION') return stay(state);
      if (event.kind === 'run-stop') return stay({ tag: 'stopped', r: state.r, summary: `User stopped during plan-revision scope adjudication: ${(event.answer as { quote: string }).quote}` });
      if (event.kind !== 'scope-deviation-user') return stay(state);
      const answer = event.answer as { choice: 'accept' | 'decline'; quote: string };
      if (answer.choice === 'decline') return stay({ tag: 'refused', r: state.r, error: `User declined plan-revision scope expansion: ${answer.quote}` });
      const adjustment: ScopeAdjustment = { proposal: state.request, approvedBy: 'user', rationale: state.orchestratorRationale, quote: answer.quote, ...(state.r.c.designBinding ? { ownerIncrement: state.r.c.designBinding.increment } : {}) };
      const c = { ...state.r.c, scopeAdjustments: [...state.r.c.scopeAdjustments, adjustment], scopeNotice: { requestId: state.request.requestId, approvedBy: adjustment.approvedBy, rationale: adjustment.rationale, quote: answer.quote } };
      return stay({ tag: 'resume', r: { ...state.r, c, scopeAdjudicated: true } });
    }
    case 'resume': case 'refused': case 'checking-host-event': case 'drift': return stay(state);
    case 'stopped': return stay(state);
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
  const tasks = Object.keys(r.c.tasks).length ? reconcileTasks(r.c.tasks, plan) : r.c.tasks;
  const integration = r.c.integration && invalidatesIntegration(r.c.tasks, tasks) ? { ...r.c.integration, rewind: true } : r.c.integration;
  const evidence = Object.fromEntries(Object.entries(r.c.evidence).filter(([id]) => plan.criteria.some((row) => row.id === id) && !r.changed.includes(id)).map(([id, row]) => [id, { ...row, planHash: hash }]));
  const records = Object.fromEntries(Object.entries(r.c.records).filter(([command]) => {
    const next = commandMappings(plan).find((row) => row.command === command), old = commandMappings(r.original).find((row) => row.command === command);
    return next && old && JSON.stringify(next) === JSON.stringify(old) && !next.criteria.some((id) => r.changed.includes(id));
  }));
  return { ...r.c, plan, planHash: hash, planPath: r.workingPath, evidence, records, tasks, integration, criterionMutation: Object.fromEntries(plan.criteria.map((row) => [row.id, r.changed.includes(row.id) ? r.c.mutationEpoch : r.c.criterionMutation[row.id] ?? 0])),
    concerns: [...r.c.concerns, ...r.removed.map((id) => `Revision removed criterion ${id}.`)], revisions: [...r.c.revisions, { artifact: 'plan', reason: r.reason, beforeHash: r.originalHash, afterHash: hash, rebind: { retained: Object.keys(evidence), pending: r.changed, removed: r.removed } }] };
}
export function revisionAwait(state: RevisionState): Await | null { return state.tag === 'author' ? 'author' : state.tag === 'review' ? reviewAwait(state.review) : state.tag === 'drift' || state.tag === 'scope-adjudication' || state.tag === 'scope-user-decision' ? 'decide' : state.tag === 'resume' || state.tag === 'stopped' || state.tag === 'refused' ? 'done' : null; }
export function revisionData(state: RevisionState): Record<string, unknown> {
  if (state.tag === 'author') return { artifact: 'plan', path: state.r.workingPath, originalPath: state.r.c.planPath, originalHash: state.r.originalHash, reason: state.r.reason, error: state.error };
  if (state.tag === 'review') return { ...reviewData(state.review), delta: state.r.changed };
  if (state.tag === 'scope-adjudication') return { kind: 'scope-deviation', pendingProposal: state.request, choices: ['approve', 'disagree', 'stop'], stopAllowed: true };
  if (state.tag === 'scope-user-decision') return { kind: 'scope-deviation-user', pendingProposal: state.request, orchestratorRationale: state.orchestratorRationale, choices: ['accept', 'decline', 'stop'], stopAllowed: true };
  if (state.tag === 'stopped') return { outcome: 'stopped', summary: state.summary };
  return { changed: state.r.changed, removed: state.r.removed, grew: state.r.grew, ...(state.tag === 'refused' ? { error: state.error } : {}) };
}
export function validateRevision(state: RevisionState, event: HostEvent): string | null {
  if (event.type === 'REVISE') return 'event.type: settle the outstanding revision first.';
  if (state.tag === 'drift' && (event.type !== 'DECISION' || event.kind !== 'drift' || !driftAnswer(event.answer, state.paths))) return 'event.answer: rule adopt or stop for every revision drift path.';
  if (state.tag === 'author' && (event.type !== 'AUTHORED' || event.path !== state.r.workingPath)) return 'event.path: expected the session revision working copy.';
  if (state.tag === 'scope-adjudication') {
    if (event.type === 'DECISION' && event.kind === 'run-stop' && isRecord(event.answer) && typeof event.answer['quote'] === 'string' && event.answer['quote'].trim()) return null;
    if (event.type !== 'DECISION' || event.kind !== 'scope-deviation' || !isRecord(event.answer)) return 'event.answer: expected adjudication for the pending revision proposal, or stop with a user quote.';
    const answer = event.answer;
    return answer['by'] === 'orchestrator' && stableValue(answer['request']) === stableValue(state.request) && ['approve', 'disagree'].includes(String(answer['ruling'])) && typeof answer['rationale'] === 'string' && !!answer['rationale'].trim() ? null : 'event.answer: adjudication must bind the pending revision proposal and include a rationale.';
  }
  if (state.tag === 'scope-user-decision') {
    if (event.type === 'DECISION' && event.kind === 'run-stop' && isRecord(event.answer) && typeof event.answer['quote'] === 'string' && event.answer['quote'].trim()) return null;
    if (event.type !== 'DECISION' || event.kind !== 'scope-deviation-user' || !isRecord(event.answer)) return 'event.answer: expected a user choice for the pending revision request, or stop with a user quote.';
    const answer = event.answer;
    return answer['by'] === 'user' && answer['requestId'] === state.request.requestId && ['accept', 'decline'].includes(String(answer['choice'])) && typeof answer['quote'] === 'string' && !!answer['quote'].trim() ? null : 'event.answer: user choice must bind the pending revision request and include a quote.';
  }
  return state.tag === 'review' ? validateReview(state.review, event) : null;
}
