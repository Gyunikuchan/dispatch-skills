import type { Event, HostEvent, RevisionScopeProposal, ScopeAdjustment, ScopeDelta } from '../core/types.ts';
import { stableValue } from '../domain/stable-value.ts';
import type { ParsedDesign } from '../domain/types.ts';
import { asParsedDesign, sharedDesignSections } from '../domain/design.ts';
import { beginReview, stepReview, reviewAwait, reviewData, validateReview, reviewSpecFromRun, type ReviewState } from './review.ts';
import { answers, never, nextId, stay, type Step } from './types.ts';
import type { DesignContext } from './design.ts';

export function designDelta(before: ParsedDesign, after: ParsedDesign): { changed: string[]; invalidated: string[]; removed: string[] } {
  const contract = (d: ParsedDesign, id: string) => JSON.stringify({ graph: d.increments.find((row) => row.id === id), acceptance: d.details[id] });
  const changed = after.increments.filter((row) => contract(before, row.id) !== contract(after, row.id)).map((row) => row.id);
  const removed = before.increments.filter((row) => !after.increments.some((next) => next.id === row.id)).map((row) => row.id);
  const sharedChanged = sharedDesignSections(before.governedText) !== sharedDesignSections(after.governedText);
  const initialInvalidated = sharedChanged ? after.increments.map((row) => row.id) : [...changed, ...removed];
  const invalidated = new Set(initialInvalidated);
  let grew = true;
  while (grew) { grew = false; for (const row of after.increments) if (!invalidated.has(row.id) && row.prerequisites.some((id) => invalidated.has(id))) { invalidated.add(row.id); grew = true; } }
  return { changed, invalidated: [...invalidated].filter((id) => after.increments.some((row) => row.id === id)), removed };
}
export type DesignRevisionState =
  | { tag: 'author'; c: DesignContext; workingPath: string; reason: string; evidence: string; error: string | null }
  | { tag: 'parse'; c: DesignContext; workingPath: string; reason: string; evidence: string; effectId: string; afterReview: boolean }
  | { tag: 'review'; c: DesignContext; workingPath: string; reason: string; evidence: string; review: ReviewState }
  | { tag: 'scope-adjudication'; c: DesignContext; workingPath: string; reason: string; evidence: string; request: RevisionScopeProposal; design: ParsedDesign; hash: string; delta: ReturnType<typeof designDelta> }
  | { tag: 'scope-user-decision'; c: DesignContext; workingPath: string; reason: string; evidence: string; request: RevisionScopeProposal; orchestratorRationale: string; design: ParsedDesign; hash: string; delta: ReturnType<typeof designDelta> }
  | { tag: 'resume'; c: DesignContext; workingPath: string; reason: string; evidence: string; design: ParsedDesign; hash: string; delta: ReturnType<typeof designDelta>; scopeAdjudicated: boolean }
  | { tag: 'stopped'; c: DesignContext; workingPath: string; reason: string; evidence: string; summary: string }
  | { tag: 'refused'; c: DesignContext; workingPath: string; reason: string; evidence: string; error: string };
type S = Step<DesignRevisionState>;
export function beginDesignRevision(c: DesignContext, event: Extract<HostEvent, { type: 'REVISE' }>): S {
  const session = c.run.overrides['sessionDir'];
  if (typeof session !== 'string') throw new Error('Design revision requires the journal-owned session directory.');
  return stay({ tag: 'author', c, workingPath: `${session}/revision-${c.revisions.length + 1}.design.md`, reason: event.reason, evidence: event.evidence, error: null });
}

function scopeDelta(before: ParsedDesign, after: ParsedDesign, delta: ReturnType<typeof designDelta>): ScopeDelta {
  const oldPaths = new Set(before.increments.flatMap((row) => row.paths));
  const obligations: string[] = [];
  for (const [id, fields] of Object.entries(after.details)) {
    const old = before.details[id] ?? {};
    for (const [key, value] of Object.entries(fields)) if (old[key] !== value) obligations.push(`${id}.${key}: ${value}`);
  }
  const sharedBodies = (sections: string[]) => new Map(sections.map((section) => {
    const [heading = '', ...body] = section.split('\n');
    return [heading, body.join('\n').trim()];
  }));
  const oldShared = sharedBodies(sharedDesignSections(before.governedText).split(/\n\n(?=## )/));
  const newShared = sharedBodies(sharedDesignSections(after.governedText).split(/\n\n(?=## )/));
  for (const heading of ['## Goals & Requirements', '## Architecture & Boundaries', '## Final Integration']) {
    const oldBody = oldShared.get(heading) ?? '', newBody = newShared.get(heading) ?? '';
    if (oldBody !== newBody) obligations.push(`${heading} ${newBody ? 'updated' : 'cleared'}:\n${newBody || '(empty)'}`);
  }
  const increments = after.increments.filter((row) => delta.changed.includes(row.id)).map((row) => ({
    id: row.id, prerequisites: [...row.prerequisites], paths: [...row.paths],
    acceptance: Object.entries(after.details[row.id] ?? {}).map(([key, value]) => `${key}: ${value}`),
  }));
  const addsIncrement = delta.changed.some((id) => !before.increments.some((row) => row.id === id));
  return {
    paths: [...new Set(after.increments.flatMap((row) => row.paths).filter((path) => !oldPaths.has(path)))].sort(),
    criteria: [], obligations, commands: [],
    phaseDuties: addsIncrement ? ['Complete each newly affected design increment and include its owned paths in final integration review.'] : [],
    increments,
  };
}

const hasScopeDelta = (delta: ScopeDelta) => Object.values(delta).some((items) => Array.isArray(items) && items.length > 0);
const scopeRequestId = (before: string, after: string) => `design-revision-${before.replace(/^sha256:/, '').slice(-12)}-${after.replace(/^sha256:/, '').slice(-12)}`;

function proposeScope(c: DesignContext, workingPath: string, reason: string, evidence: string, design: ParsedDesign, hash: string, delta: ReturnType<typeof designDelta>): S {
  const proposalDelta = scopeDelta(c.design!, design, delta);
  if (!hasScopeDelta(proposalDelta) || !c.levelGatePassed) return stay({ tag: 'resume', c, workingPath, reason, evidence, design, hash, delta, scopeAdjudicated: false });
  const request: RevisionScopeProposal = {
    requestId: scopeRequestId(c.hash!, hash), source: 'design-revision', baseArtifactHash: c.hash!, proposedArtifactHash: hash,
    affectedIncrements: delta.invalidated.length ? [...delta.invalidated] : [...delta.changed],
    rationale: `${reason}: ${evidence}`, delta: proposalDelta,
  };
  return stay({ tag: 'scope-adjudication', c, workingPath, reason, evidence, request, design, hash, delta });
}

function decision(state: Extract<DesignRevisionState, { tag: 'scope-adjudication' | 'scope-user-decision' }>, event: HostEvent): S {
  if (event.type !== 'DECISION') return stay(state);
  if (event.kind === 'run-stop') return stay({ tag: 'stopped', c: state.c, workingPath: state.workingPath, reason: state.reason, evidence: state.evidence, summary: `User stopped during design-revision scope adjudication: ${(event.answer as { quote: string }).quote}` });
  if (state.tag === 'scope-adjudication') {
    if (event.kind !== 'scope-deviation') return stay(state);
    const answer = event.answer as { by: 'orchestrator'; request: RevisionScopeProposal; ruling: 'approve' | 'disagree'; rationale: string };
    if (answer.by !== 'orchestrator' || stableValue(answer.request) !== stableValue(state.request) || !answer.rationale.trim()) return stay(state);
    if (answer.ruling === 'disagree') return stay({ ...state, tag: 'scope-user-decision', orchestratorRationale: answer.rationale });
    if (answer.ruling !== 'approve') return stay(state);
    const adjustment: ScopeAdjustment = { proposal: state.request, approvedBy: 'orchestrator', rationale: answer.rationale };
    const c = { ...state.c, scopeAdjustments: [...state.c.scopeAdjustments, adjustment], scopeNotice: { requestId: state.request.requestId, approvedBy: adjustment.approvedBy, rationale: adjustment.rationale } };
    return stay({ tag: 'resume', c, workingPath: state.workingPath, reason: state.reason, evidence: state.evidence, design: state.design, hash: state.hash, delta: state.delta, scopeAdjudicated: true });
  }
  if (event.kind !== 'scope-deviation-user') return stay(state);
  const answer = event.answer as { by: 'user'; requestId: string; choice: 'accept' | 'decline'; quote: string };
  if (answer.by !== 'user' || answer.requestId !== state.request.requestId || !answer.quote.trim()) return stay(state);
  if (answer.choice === 'decline') return stay({ tag: 'refused', c: state.c, workingPath: state.workingPath, reason: state.reason, evidence: state.evidence, error: `User declined design-revision scope expansion: ${answer.quote}` });
  if (answer.choice !== 'accept') return stay(state);
  const adjustment: ScopeAdjustment = { proposal: state.request, approvedBy: 'user', rationale: state.orchestratorRationale, quote: answer.quote };
  const c = { ...state.c, scopeAdjustments: [...state.c.scopeAdjustments, adjustment], scopeNotice: { requestId: state.request.requestId, approvedBy: adjustment.approvedBy, rationale: adjustment.rationale, quote: answer.quote } };
  return stay({ tag: 'resume', c, workingPath: state.workingPath, reason: state.reason, evidence: state.evidence, design: state.design, hash: state.hash, delta: state.delta, scopeAdjudicated: true });
}
function parse(state: DesignRevisionState, afterReview: boolean): S {
  const next = nextId(state.c.counters, 'design.revision', 'parse-artifact');
  return { state: { tag: 'parse', c: { ...state.c, counters: next.counters }, workingPath: state.workingPath, reason: state.reason, evidence: state.evidence, effectId: next.id, afterReview }, effects: [{ kind: 'parse-artifact', id: next.id, path: state.workingPath, artifact: 'design' }] };
}
function reviewed(state: DesignRevisionState, result: Step<ReviewState>): S {
  const c = { ...state.c, counters: 'c' in result.state ? result.state.c.counters : state.c.counters, revisionReviewRound: 'c' in result.state ? Math.max(state.c.revisionReviewRound, result.state.c.round) : state.c.revisionReviewRound };
  const base = { c, workingPath: state.workingPath, reason: state.reason, evidence: state.evidence };
  if (result.state.tag === 'settled' || result.state.tag === 'skipped') return parse({ ...state, c }, true);
  if (['failed', 'escalated', 'empty'].includes(result.state.tag)) return stay({ ...base, tag: 'refused', error: `Design revision review did not settle: ${result.state.tag}` });
  return { state: { ...base, tag: 'review', review: result.state }, effects: result.effects };
}
export function stepDesignRevision(state: DesignRevisionState, event: Event): S {
  switch (state.tag) {
    case 'author': return event.type === 'AUTHORED' && event.path === state.workingPath ? parse(state, false) : stay(state);
    case 'review': return reviewed(state, stepReview(state.review, event));
    case 'scope-adjudication': case 'scope-user-decision': return decision(state, event as HostEvent);
    case 'resume': case 'stopped': case 'refused': return stay(state);
    case 'parse': break;
    default: return never(state, 'design revision state');
  }
  if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return stay({ ...state, tag: 'refused', error: event.detail });
  if (event.type !== 'ARTIFACT_PARSED' || event.kind !== 'design' || !answers(event, state.effectId)) return stay(state);
  const design = asParsedDesign(event.parsed);
  if (event.defects.length || !design || !/^sha256:[a-f0-9]{64}$/.test(event.hash)) return stay({ ...state, tag: 'author', error: 'Revision requires a valid design and governed hash.' });
  if (design.box['TL;DR'] !== state.c.design?.box['TL;DR']) return stay({ ...state, tag: 'refused', error: 'Design objective cannot change during revision.' });
  const delta = designDelta(state.c.design!, design);
  if (state.afterReview || event.hash === state.c.hash) return proposeScope(state.c, state.workingPath, state.reason, state.evidence, design, event.hash, delta);
  const built = reviewSpecFromRun(state.c.run, 'design', 'fix', state.workingPath);
  if (!built.ok) return stay({ ...state, tag: 'refused', error: built.error });
  const offset = state.c.revisionReviewRound;
  const result = beginReview({ ...built.spec, context: `Review the governed design delta. ${JSON.stringify({ before: state.c.design!.governedText, after: design.governedText, delta, reason: state.reason, evidence: state.evidence })}` }, 'design.revision.review', state.c.counters);
  if ('c' in result.state) result.state = { ...result.state, c: { ...result.state.c, round: result.state.c.round + offset, scope: 'delta' } };
  result.effects = result.effects.map((effect) => effect.kind === 'prepare-review' ? { ...effect, round: effect.round + offset, scope: { ...effect.scope, scope: 'delta', sinceHash: state.c.hash, priorTarget: state.c.path } } : effect);
  return reviewed(state, result);
}
export function designRevisionAwait(state: DesignRevisionState) {
  switch (state.tag) {
    case 'author': return 'author' as const;
    case 'review': return reviewAwait(state.review);
    case 'scope-adjudication': case 'scope-user-decision': return 'decide' as const;
    case 'resume': case 'stopped': case 'refused': return 'done' as const;
    case 'parse': return null;
    default: return never(state, 'design revision state');
  }
}
export const designRevisionData = (state: DesignRevisionState): Readonly<Record<string, unknown>> => {
  if (state.tag === 'review') return reviewData(state.review);
  if (state.tag === 'scope-adjudication') return { kind: 'scope-deviation', pendingProposal: state.request, choices: ['approve', 'disagree', 'stop'], stopAllowed: true };
  if (state.tag === 'scope-user-decision') return { kind: 'scope-deviation-user', pendingProposal: state.request, orchestratorRationale: state.orchestratorRationale, choices: ['accept', 'decline', 'stop'], stopAllowed: true };
  if (state.tag === 'stopped') return { outcome: 'stopped', summary: state.summary };
  return { artifact: 'design', path: state.workingPath, reason: state.reason, ...('error' in state ? { error: state.error } : {}) };
};
export const validateDesignRevision = (state: DesignRevisionState, event: HostEvent) => {
  if (event.type === 'REVISE') return 'Settle the current design revision first.';
  if (state.tag === 'review') return validateReview(state.review, event);
  if (state.tag === 'author' && event.type === 'AUTHORED' && event.path !== state.workingPath) return 'event.path: expected design revision working copy.';
  if (state.tag === 'scope-adjudication') {
    if (event.type === 'DECISION' && event.kind === 'run-stop') return typeof (event.answer as Record<string, unknown>)['quote'] === 'string' && !!String((event.answer as Record<string, unknown>)['quote']).trim() ? null : 'event.answer.quote: run stop requires the user quote.';
    const answer = event.type === 'DECISION' && event.kind === 'scope-deviation' ? event.answer as Record<string, unknown> : null;
    return answer && answer['by'] === 'orchestrator' && stableValue(answer['request']) === stableValue(state.request) && ['approve', 'disagree'].includes(String(answer['ruling'])) && typeof answer['rationale'] === 'string' && String(answer['rationale']).trim() ? null : 'event.answer: adjudication must bind the pending design proposal and include a rationale, or stop with a user quote.';
  }
  if (state.tag === 'scope-user-decision') {
    if (event.type === 'DECISION' && event.kind === 'run-stop') return typeof (event.answer as Record<string, unknown>)['quote'] === 'string' && !!String((event.answer as Record<string, unknown>)['quote']).trim() ? null : 'event.answer.quote: run stop requires the user quote.';
    const answer = event.type === 'DECISION' && event.kind === 'scope-deviation-user' ? event.answer as Record<string, unknown> : null;
    return answer && answer['by'] === 'user' && answer['requestId'] === state.request.requestId && ['accept', 'decline'].includes(String(answer['choice'])) && typeof answer['quote'] === 'string' && String(answer['quote']).trim() ? null : 'event.answer: user choice must bind the pending design request and include a quote, or stop with a user quote.';
  }
  return null;
};
export const transitions = [
  { from: 'author', on: 'AUTHORED', to: 'parse' }, { from: 'parse', on: 'ARTIFACT_PARSED', to: 'author' }, { from: 'parse', on: 'ARTIFACT_PARSED', to: 'review' }, { from: 'parse', on: 'ARTIFACT_PARSED', to: 'scope-adjudication' }, { from: 'parse', on: 'ARTIFACT_PARSED', to: 'resume' }, { from: 'parse', on: 'ARTIFACT_PARSED', to: 'refused' }, { from: 'parse', on: 'EFFECT_FAILED', to: 'refused' },
  ...['WAVE_DONE', 'RULINGS', 'DECISION', 'ARTIFACT_PARSED'].map((on) => ({ from: 'review', on, to: 'parse' })),
  ...['REVIEW_PREPARED', 'DECISION', 'EFFECT_FAILED'].map((on) => ({ from: 'review', on, to: 'refused' })),
  { from: 'scope-adjudication', on: 'DECISION', to: 'scope-user-decision' }, { from: 'scope-adjudication', on: 'DECISION', to: 'resume' }, { from: 'scope-adjudication', on: 'DECISION', to: 'stopped' },
  { from: 'scope-user-decision', on: 'DECISION', to: 'resume' }, { from: 'scope-user-decision', on: 'DECISION', to: 'refused' }, { from: 'scope-user-decision', on: 'DECISION', to: 'stopped' },
];
