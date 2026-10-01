import type { Event, HostEvent } from '../core/types.ts';
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
  | { tag: 'resume'; c: DesignContext; workingPath: string; reason: string; evidence: string; design: ParsedDesign; hash: string; delta: ReturnType<typeof designDelta> }
  | { tag: 'refused'; c: DesignContext; workingPath: string; reason: string; evidence: string; error: string };
type S = Step<DesignRevisionState>;
export function beginDesignRevision(c: DesignContext, event: Extract<HostEvent, { type: 'REVISE' }>): S {
  const session = c.run.overrides['sessionDir'];
  if (typeof session !== 'string') throw new Error('Design revision requires the journal-owned session directory.');
  return stay({ tag: 'author', c, workingPath: `${session}/revision-${c.revisions.length + 1}.design.md`, reason: event.reason, evidence: event.evidence, error: null });
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
    case 'resume': case 'refused': return stay(state);
    case 'parse': break;
    default: return never(state, 'design revision state');
  }
  if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return stay({ ...state, tag: 'refused', error: event.detail });
  if (event.type !== 'ARTIFACT_PARSED' || event.kind !== 'design' || !answers(event, state.effectId)) return stay(state);
  const design = asParsedDesign(event.parsed);
  if (event.defects.length || !design || !/^sha256:[a-f0-9]{64}$/.test(event.hash)) return stay({ ...state, tag: 'author', error: 'Revision requires a valid design and governed hash.' });
  if (design.box['TL;DR'] !== state.c.design?.box['TL;DR']) return stay({ ...state, tag: 'refused', error: 'Design objective cannot change during revision.' });
  const delta = designDelta(state.c.design!, design);
  if (state.afterReview || event.hash === state.c.hash) return stay({ ...state, tag: 'resume', design, hash: event.hash, delta });
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
    case 'resume': case 'refused': return 'done' as const;
    case 'parse': return null;
    default: return never(state, 'design revision state');
  }
}
export const designRevisionData = (state: DesignRevisionState): Readonly<Record<string, unknown>> => state.tag === 'review' ? reviewData(state.review) : { artifact: 'design', path: state.workingPath, reason: state.reason, ...('error' in state ? { error: state.error } : {}) };
export const validateDesignRevision = (state: DesignRevisionState, event: HostEvent) => state.tag === 'review' ? validateReview(state.review, event) : event.type === 'AUTHORED' && event.path !== state.workingPath ? 'event.path: expected design revision working copy.' : event.type === 'REVISE' ? 'Settle the current design revision first.' : null;
export const transitions = [
  { from: 'author', on: 'AUTHORED', to: 'parse' }, { from: 'parse', on: 'ARTIFACT_PARSED', to: 'author' }, { from: 'parse', on: 'ARTIFACT_PARSED', to: 'review' }, { from: 'parse', on: 'ARTIFACT_PARSED', to: 'resume' }, { from: 'parse', on: 'ARTIFACT_PARSED', to: 'refused' }, { from: 'parse', on: 'EFFECT_FAILED', to: 'refused' },
  ...['WAVE_DONE', 'RULINGS', 'DECISION', 'ARTIFACT_PARSED'].map((on) => ({ from: 'review', on, to: 'parse' })),
  ...['REVIEW_PREPARED', 'DECISION', 'EFFECT_FAILED'].map((on) => ({ from: 'review', on, to: 'refused' })),
];
