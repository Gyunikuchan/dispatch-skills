// Plan machine: author → AUTHORED → parse-artifact → (defects → author) → review (kind plan, fix mode) → complete.
// Approval belongs to implement (I05); a disabled plan review (rounds 0) completes with the skip recorded.

import type { Event, HostEvent, Machine, RunStartedEvent } from '../core/types.ts';
import { beginReview, reviewAwait, reviewData, reviewSpecFromRun, stepReview, validateReview, type ReviewState } from './review.ts';
import { answers, isString, never, nextId, stay, type Counters, type ReviewSpec, type Step } from './types.ts';

export const PLAN_TEMPLATE = 'references/templates/plan.md';

export type PlanInput = { path: string; spec: ReviewSpec };
export type PlanCtx = { input: PlanInput; path: string; counters: Counters; effectId: string | null };

export type PlanState =
  | { tag: 'booting'; counters: Counters }
  | { tag: 'author'; c: PlanCtx; defects: readonly Readonly<Record<string, unknown>>[] }
  | { tag: 'parsing'; c: PlanCtx }
  | { tag: 'review'; c: PlanCtx; review: ReviewState }
  | { tag: 'complete'; c: PlanCtx; review: ReviewState }
  | { tag: 'escalated'; c: PlanCtx; review: ReviewState }
  | { tag: 'failed'; c: PlanCtx | null; detail: string; review: ReviewState | null };

type S = Step<PlanState>;

/** Kebab slug of an objective, at most 40 characters. */
export function slugOf(text: string, fallback = 'dispatch'): string {
  const slug = text.toLowerCase().replace(/\.(plan|design|report)\.md$/, '').replace(/^.*[\\/]/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return slug || fallback;
}

export function planInputFromRun(run: RunStartedEvent): { ok: true; input: PlanInput } | { ok: false; error: string } {
  const path = isString(run.overrides['path']) ? run.overrides['path'] : /\.plan\.md$/i.test(run.argument.trim()) ? run.argument.trim() : `${slugOf(run.argument)}.plan.md`;
  const built = reviewSpecFromRun(run, 'plan', 'fix', path);
  return built.ok ? { ok: true, input: { path, spec: built.spec } } : built;
}

export function beginPlan(input: PlanInput, path: string, counters: Counters): S {
  return stay({ tag: 'author', c: { input, path, counters, effectId: null }, defects: [] });
}

function fromReview(c0: PlanCtx, result: Step<ReviewState>): S {
  const review = result.state;
  const c = { ...c0, counters: 'c' in review ? review.c.counters : c0.counters };
  switch (review.tag) {
    case 'settled': case 'skipped': return stay({ tag: 'complete', c, review });
    case 'escalated': return stay({ tag: 'escalated', c, review });
    case 'failed': return stay({ tag: 'failed', c, detail: review.detail, review });
    case 'empty': return stay({ tag: 'failed', c, detail: 'plan review found no reviewable scope', review });
    case 'booting': case 'prepare': case 'wave': case 'native': case 'rule': case 'decide-needs-user': case 'fix': case 'fix-verify':
    case 'decide-escalation': case 'decide-opt-in':
      return { state: { tag: 'review', c, review }, effects: result.effects };
    default: return never(review, 'review state');
  }
}

export function stepPlan(state: PlanState, event: Event): S {
  switch (state.tag) {
    case 'booting': return stay(state);
    case 'author': {
      if (event.type !== 'AUTHORED') return stay(state);
      const input = { ...state.c.input, path: event.path, spec: { ...state.c.input.spec, target: event.path } };
      const { id, counters } = nextId(state.c.counters, state.c.path, 'parse-artifact');
      return { state: { tag: 'parsing', c: { ...state.c, input, counters, effectId: id } }, effects: [{ kind: 'parse-artifact', id, path: event.path, artifact: 'plan' }] };
    }
    case 'parsing':
      if (event.type === 'EFFECT_FAILED' && answers(event, state.c.effectId)) return stay({ tag: 'failed', c: state.c, detail: `${event.cls}: ${event.detail}`, review: null });
      if (event.type !== 'ARTIFACT_PARSED' || !answers(event, state.c.effectId)) return stay(state);
      if (event.defects.length) return stay({ tag: 'author', c: state.c, defects: event.defects });
      return fromReview(state.c, beginReview(state.c.input.spec, `${state.c.path}.review`, state.c.counters));
    case 'review': return fromReview(state.c, stepReview(state.review, event));
    case 'complete': case 'escalated': case 'failed': return stay(state);
    default: return never(state, 'plan state');
  }
}

export function planAwait(state: PlanState) {
  switch (state.tag) {
    case 'author': return 'author' as const;
    case 'review': return reviewAwait(state.review);
    case 'complete': case 'escalated': case 'failed': return 'done' as const;
    case 'booting': case 'parsing': return null;
    default: return never(state, 'plan state');
  }
}

export function planData(state: PlanState): Readonly<Record<string, unknown>> {
  switch (state.tag) {
    case 'author': return { artifact: 'plan', path: state.c.input.path, template: PLAN_TEMPLATE, ...(state.defects.length ? { defects: state.defects } : {}) };
    case 'review': return reviewData(state.review);
    case 'complete': return state.review.tag === 'skipped'
      ? { outcome: 'complete', summary: 'plan review skipped (rounds 0)' }
      : { outcome: 'complete', summary: `plan settled at ${state.c.input.path}`, completion: reviewData(state.review)['completion'] ?? {} };
    case 'escalated': return reviewData(state.review);
    case 'failed': return { outcome: 'failed', summary: state.detail };
    case 'booting': case 'parsing': return {};
    default: return never(state, 'plan state');
  }
}

export function validatePlan(state: PlanState, event: HostEvent): string | null {
  if (event.type === 'REVISE') return 'event.type: REVISE is not available in plan in standalone review; author a new artifact and start a new run';
  return state.tag === 'review' ? validateReview(state.review, event) : null;
}

export const planTransitions = [
  { from: 'booting', on: 'RUN_STARTED', to: 'author' },
  { from: 'booting', on: 'RUN_STARTED', to: 'failed' },
  { from: 'author', on: 'AUTHORED', to: 'parsing' },
  { from: 'parsing', on: 'ARTIFACT_PARSED', to: 'author' },
  { from: 'parsing', on: 'ARTIFACT_PARSED', to: 'review' },
  { from: 'parsing', on: 'ARTIFACT_PARSED', to: 'complete' },
  { from: 'parsing', on: 'EFFECT_FAILED', to: 'failed' },
  { from: 'review', on: 'WAVE_DONE', to: 'complete' },
  { from: 'review', on: 'RULINGS', to: 'complete' },
  { from: 'review', on: 'ARTIFACT_PARSED', to: 'complete' },
  { from: 'review', on: 'DECISION', to: 'escalated' },
  { from: 'review', on: 'DECISION', to: 'complete' },
  { from: 'review', on: 'EFFECT_FAILED', to: 'failed' },
] as const;

export const planMachine: Machine<PlanState> = {
  initial: () => ({ tag: 'booting', counters: {} }),
  step(state, event) {
    if (state.tag === 'booting' && event.type === 'RUN_STARTED') {
      const built = planInputFromRun(event);
      return built.ok ? beginPlan(built.input, 'plan', state.counters) : stay({ tag: 'failed', c: null, detail: built.error, review: null });
    }
    return stepPlan(state, event);
  },
  awaitOf: planAwait,
  project: (state) => ({ at: `plan › ${state.tag}${state.tag === 'review' ? ` › ${state.review.tag}` : ''}`, data: planData(state) }),
  transitions: planTransitions,
  validate: validatePlan,
};
