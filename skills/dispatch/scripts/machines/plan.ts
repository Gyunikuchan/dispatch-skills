// Plan machine: author → AUTHORED → parse-artifact → (defects → author) → review (kind plan, fix mode) → complete.
// Approval belongs to implement; a disabled plan review (rounds 0) completes with the skip recorded.

import { qualitySections } from '../domain/prompt.ts';
import type { Event, HostEvent, Machine, RunStartedEvent, SpecIdentity } from '../core/types.ts';
import { beginReview, reviewArtifactId, reviewAwait, reviewData, reviewSpecFromRun, stepReview, validateReview, type ReviewState } from './review.ts';
import { answers, isString, never, nextId, staleGoverning, stay, type Counters, type ReviewSpec, type Step } from './types.ts';

export const PLAN_TEMPLATE = 'references/templates/plan.md';

export type PlanInput = { path: string; spec: ReviewSpec; governingSpec?: SpecIdentity | null };
/** `specEpoch` counts governing-spec revisions; epoch k > 0 reviews at `<path>.review.s<k>` so earlier review history stays intact. */
export type PlanCtx = { input: PlanInput; path: string; counters: Counters; effectId: string | null; specEpoch?: number; designPin?: string | null };

export type PlanState =
  | { tag: 'booting'; counters: Counters }
  | { tag: 'author'; c: PlanCtx; defects: readonly Readonly<Record<string, unknown>>[] }
  | { tag: 'parsing'; c: PlanCtx }
  | { tag: 'review'; c: PlanCtx; review: ReviewState }
  | { tag: 'complete'; c: PlanCtx; review: ReviewState }
  | { tag: 'escalated'; c: PlanCtx; review: ReviewState }
  | { tag: 'failed'; c: PlanCtx | null; detail: string; review: ReviewState | null };

type S = Step<PlanState>;

/** Kebab slug of an objective or path, at most 40 characters; only a path (no whitespace, or ending in `.plan.md`, `.design.md` or `.report.md`) is reduced to its basename. */
export function slugOf(text: string, fallback = 'dispatch'): string {
  const trimmed = text.trim().toLowerCase();
  const artifactSuffix = /\.(plan|design|report)\.md$/;
  // Dispatch artifact paths may sit in directories with spaces; free text ending in another `.md` path stays an objective.
  const isPath = !/\s/.test(trimmed) || artifactSuffix.test(trimmed);
  const base = trimmed.replace(artifactSuffix, '');
  const slug = (isPath ? base.replace(/^.*[\\/]/, '') : base).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return slug || fallback;
}

export function planInputFromRun(run: RunStartedEvent, governingSpec: SpecIdentity | null = null): { ok: true; input: PlanInput } | { ok: false; error: string } {
  const sessionDir = typeof run.overrides['sessionDir'] === 'string' ? run.overrides['sessionDir'].replace(/[\\/]+$/, '') : null;
  const path = isString(run.overrides['path'])
    ? run.overrides['path']
    : /\.plan\.md$/i.test(run.argument.trim())
      ? run.argument.trim()
      : sessionDir
        ? `${sessionDir}/${slugOf(run.argument)}.plan.md`
        : `${slugOf(run.argument)}.plan.md`;
  const built = reviewSpecFromRun(run, 'plan', path, governingSpec);
  return built.ok ? { ok: true, input: { path, spec: built.spec, governingSpec } } : built;
}

export function beginPlan(input: PlanInput, path: string, counters: Counters): S {
  return stay({ tag: 'author', c: { input, path, counters, effectId: null, specEpoch: 0 }, defects: [] });
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
    case 'decide-escalation': case 'decide-opt-in': case 'decide-verification': case 'target-check': case 'pin-check':
      return { state: { tag: 'review', c, review }, effects: result.effects };
    default: return never(review, 'review state');
  }
}

/** A revised governing spec returns authoring to the plan; any active review is dropped (its log section is already rendered). */
function respec(c0: PlanCtx, governingSpec: SpecIdentity): S {
  const input = { ...c0.input, governingSpec, spec: { ...c0.input.spec, governingSpec } as ReviewSpec };
  const c = { ...c0, input, effectId: null, specEpoch: (c0.specEpoch ?? 0) + 1 };
  if (c.designPin) return stay({ tag: 'failed', c, detail: `stale-design-spec: ${c.designPin} pins a revised spec; revise the design first`, review: null });
  return stay({ tag: 'author', c, defects: [{ code: 'stale-spec', message: `Governing spec revised to ${governingSpec.hash}; re-author against it.` }] });
}

const reviewPath = (c: PlanCtx): string => (c.specEpoch ?? 0) > 0 ? `${c.path}.review.s${c.specEpoch}` : `${c.path}.review`;

export function stepPlan(state: PlanState, event: Event): S {
  if (event.type === 'SPEC_SETTLED' && (state.tag === 'author' || state.tag === 'parsing' || state.tag === 'review')) return respec(state.c, { path: event.path, hash: event.hash });
  switch (state.tag) {
    case 'booting': return stay(state);
    case 'author': {
      if (event.type !== 'AUTHORED') return stay(state);
      const input = { ...state.c.input, path: event.path, spec: { ...state.c.input.spec, target: event.path } };
      const { id, counters } = nextId(state.c.counters, state.c.path, 'parse-artifact');
      return { state: { tag: 'parsing', c: { ...state.c, input, counters, effectId: id } }, effects: [{ kind: 'parse-artifact', id, path: event.path, artifact: 'plan', ...(input.governingSpec ? { governing: input.governingSpec.path } : {}) }] };
    }
    case 'parsing':
      if (event.type === 'EFFECT_FAILED' && answers(event, state.c.effectId)) return stay({ tag: 'failed', c: state.c, detail: `${event.cls}: ${event.detail}`, review: null });
      if (event.type !== 'ARTIFACT_PARSED' || !answers(event, state.c.effectId)) return stay(state);
      const c = { ...state.c, designPin: event.governing?.design ?? null };
      if (staleGoverning(event, c.input.governingSpec)) return stay({ ...state, c });
      if (event.defects.length) return stay({ tag: 'author', c, defects: event.defects });
      return fromReview(c, beginReview(state.c.input.spec, reviewPath(state.c), state.c.counters));
    case 'review':
      if (answers(event, reviewArtifactId(state.review)) && staleGoverning(event, state.c.input.governingSpec)) return stay({ ...state, c: { ...state.c, designPin: event.governing.design } });
      return fromReview(state.c, stepReview(state.review, event));
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
    case 'author': return { artifact: 'plan', path: state.c.input.path, template: PLAN_TEMPLATE, read: [{ path: 'references/templates/quality-bar.md', sections: qualitySections.plan }], ...(state.c.input.governingSpec ? { governingSpec: state.c.input.governingSpec } : {}), ...(state.defects.length ? { defects: state.defects } : {}) };
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
  if (event.type === 'REVISE') return 'event.type: REVISE is unavailable in standalone review; author a new artifact and start a new run';
  return state.tag === 'review' ? validateReview(state.review, event) : null;
}

export const planTransitions = [
  ...['author', 'parsing', 'review'].map(from => ({ from, on: 'SPEC_SETTLED', to: 'failed' })),
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
  { from: 'review', on: 'SPEC_SETTLED', to: 'author' },
  { from: 'author', on: 'SPEC_SETTLED', to: 'author' },
  { from: 'parsing', on: 'SPEC_SETTLED', to: 'author' },
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
