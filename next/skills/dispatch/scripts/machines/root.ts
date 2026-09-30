// Root machine (spec §5.3): verb selection, review kind inference, terminal handoff, `done` projection, host-event
// validation, and driver-owned Markdown rendering (resolution sections and the standalone report; not an effect).

import type { Await, Event, HostEvent, Machine, Ports, RunStartedEvent, Verb } from '../core/types.ts';
import { renderReport, renderResolutionSection, replaceResolutionSection } from '../domain/render.ts';
import type { ReviewKind } from '../domain/types.ts';
import { askAwait, askData, askSpecFromRun, beginAsk, stepAsk, validateAsk, type AskState } from './ask.ts';
import { beginPlan, planAwait, planData, planInputFromRun, slugOf, stepPlan, validatePlan, type PlanState } from './plan.ts';
import {
  beginReview, isReviewTerminal, resolutionRounds, reviewAwait, reviewData, reviewSpecFromRun, stepReview, validateReview, type ReviewState,
} from './review.ts';
import { answers, isRecord, never, nextId, stay, type Claim, type Counters, type DoneData, type Step } from './types.ts';

export type RunInfo = { verb: Verb; argument: string; slug: string };

export type RootState =
  | { tag: 'booting' }
  | { tag: 'ask'; run: RunInfo; child: AskState }
  | { tag: 'plan'; run: RunInfo; child: PlanState }
  | { tag: 'review'; run: RunInfo; child: ReviewState }
  | { tag: 'handoff'; run: RunInfo; last: Child | null; counters: Counters; effectId: string; done: DoneData }
  | { tag: 'done'; run: RunInfo; last: Child | null; counters: Counters; done: DoneData; handoff: string | null; warning: string | null };

export type Child = { verb: 'ask'; state: AskState } | { verb: 'plan'; state: PlanState } | { verb: 'review'; state: ReviewState };

type S = Step<RootState>;

// SECTION: Kind inference

/** `--kind` wins; else `.plan.md` → plan, `.design.md` → design, otherwise code (range, paths, or working tree). */
export function inferKind(argument: string, overrides: Readonly<Record<string, unknown>>): ReviewKind {
  const kind = overrides['kind'];
  if (kind === 'plan' || kind === 'design' || kind === 'code') return kind;
  const target = argument.trim();
  if (/\.plan\.md$/i.test(target)) return 'plan';
  if (/\.design\.md$/i.test(target)) return 'design';
  return 'code';
}

// SECTION: Child plumbing

function childOf(state: RootState): Child | null {
  switch (state.tag) {
    case 'ask': return { verb: 'ask', state: state.child };
    case 'plan': return { verb: 'plan', state: state.child };
    case 'review': return { verb: 'review', state: state.child };
    case 'handoff': case 'done': return state.last;
    case 'booting': return null;
    default: return never(state, 'root state');
  }
}

function countersOf(child: Child): Counters {
  const state = child.state;
  if ('c' in state && state.c !== null) return state.c.counters;
  return 'counters' in state ? state.counters : {};
}

function terminal(child: Child): boolean {
  switch (child.verb) {
    case 'ask': return child.state.tag === 'done' || child.state.tag === 'failed';
    case 'plan': return child.state.tag === 'complete' || child.state.tag === 'escalated' || child.state.tag === 'failed';
    case 'review': return isReviewTerminal(child.state);
    default: return never(child, 'child');
  }
}

function childData(child: Child): Readonly<Record<string, unknown>> {
  switch (child.verb) {
    case 'ask': return askData(child.state);
    case 'plan': return planData(child.state);
    case 'review': return reviewData(child.state);
    default: return never(child, 'child');
  }
}

function doneOf(child: Child): DoneData {
  const data = childData(child);
  const outcome = data['outcome'] as DoneData['outcome'];
  const done: DoneData = { outcome, summary: String(data['summary'] ?? outcome) };
  if (Array.isArray(data['claims'])) done.claims = data['claims'] as readonly Claim[];
  if (Array.isArray(data['failed'])) done.completion = { failed: data['failed'] };
  if (isRecord(data['completion'])) done.completion = data['completion'];
  return done;
}

function toHandoff(run: RunInfo, last: Child | null, counters: Counters, done: DoneData): S {
  const { id, counters: next } = nextId(counters, 'root', 'handoff');
  return { state: { tag: 'handoff', run, last, counters: next, effectId: id, done }, effects: [{ kind: 'handoff', id, terminal: true }] };
}

function wrap(run: RunInfo, child: Child, effects: Step<unknown>['effects']): S {
  if (terminal(child)) return toHandoff(run, child, countersOf(child), doneOf(child));
  switch (child.verb) {
    case 'ask': return { state: { tag: 'ask', run, child: child.state }, effects };
    case 'plan': return { state: { tag: 'plan', run, child: child.state }, effects };
    case 'review': return { state: { tag: 'review', run, child: child.state }, effects };
    default: return never(child, 'child');
  }
}

const failed = (run: RunInfo, summary: string): S => toHandoff(run, null, {}, { outcome: 'failed', summary });

function boot(event: RunStartedEvent): S {
  const run: RunInfo = { verb: event.verb, argument: event.argument, slug: slugOf(event.argument, event.verb) };
  switch (event.verb) {
    case 'ask': {
      const built = askSpecFromRun(event);
      if (!built.ok) return failed(run, built.error);
      const result = beginAsk(built.spec, 'ask', {});
      return wrap(run, { verb: 'ask', state: result.state }, result.effects);
    }
    case 'plan': {
      const built = planInputFromRun(event);
      if (!built.ok) return failed(run, built.error);
      const result = beginPlan(built.input, 'plan', {});
      return wrap(run, { verb: 'plan', state: result.state }, result.effects);
    }
    case 'review': {
      const kind = inferKind(event.argument, event.overrides);
      const built = reviewSpecFromRun(event, kind, event.fix ? 'fix' : 'report', event.argument.trim());
      if (!built.ok) return failed(run, built.error);
      const result = beginReview(built.spec, 'review', {});
      return wrap(run, { verb: 'review', state: result.state }, result.effects);
    }
    case 'implement': case 'design': return failed(run, `verb ${event.verb} not available until I05/I07`);
    default: return never(event.verb, 'verb');
  }
}

// SECTION: Step

export function stepRoot(state: RootState, event: Event): S {
  switch (state.tag) {
    case 'booting': return event.type === 'RUN_STARTED' ? boot(event) : stay(state);
    case 'ask': { const result = stepAsk(state.child, event); return wrap(state.run, { verb: 'ask', state: result.state }, result.effects); }
    case 'plan': { const result = stepPlan(state.child, event); return wrap(state.run, { verb: 'plan', state: result.state }, result.effects); }
    case 'review': { const result = stepReview(state.child, event); return wrap(state.run, { verb: 'review', state: result.state }, result.effects); }
    case 'handoff': {
      const base = { run: state.run, last: state.last, counters: state.counters, done: state.done };
      if (event.type === 'HANDOFF_DONE' && answers(event, state.effectId)) return stay({ tag: 'done', ...base, handoff: event.destination, warning: event.warning });
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return stay({ tag: 'done', ...base, handoff: null, warning: `handoff failed: ${event.cls}: ${event.detail}` });
      return stay(state);
    }
    case 'done': return stay(state);
    default: return never(state, 'root state');
  }
}

function awaitOf(state: RootState): Await | null {
  switch (state.tag) {
    case 'ask': return askAwait(state.child);
    case 'plan': return planAwait(state.child);
    case 'review': return reviewAwait(state.child);
    case 'done': return 'done';
    case 'booting': case 'handoff': return null;
    default: return never(state, 'root state');
  }
}

function project(state: RootState): { at: string; data: Readonly<Record<string, unknown>> } {
  switch (state.tag) {
    case 'booting': case 'handoff': return { at: `root › ${state.tag}`, data: {} };
    case 'ask': return { at: `ask › ${state.child.tag}`, data: askData(state.child) };
    case 'plan': return { at: `plan › ${state.child.tag}${state.child.tag === 'review' ? ` › ${state.child.review.tag}` : ''}`, data: planData(state.child) };
    case 'review': return { at: `review › ${state.child.tag}`, data: reviewData(state.child) };
    case 'done': {
      const data: Record<string, unknown> = { ...state.done, handoff: state.handoff };
      if (state.warning !== null) data['warning'] = state.warning;
      return { at: `${state.run.verb} › done`, data };
    }
    default: return never(state, 'root state');
  }
}

function validate(state: RootState, event: HostEvent): string | null {
  switch (state.tag) {
    case 'ask': return validateAsk(state.child, event);
    case 'plan': return validatePlan(state.child, event);
    case 'review': return validateReview(state.child, event);
    case 'booting': case 'handoff': case 'done': return null;
    default: return never(state, 'root state');
  }
}

// SECTION: Render

/** The session root when the run dir sits at `<session>/.state/runs/<id>`; the run dir otherwise. */
export function sessionDirOf(runDir: string): string {
  const stripped = runDir.replace(/[\\/]\.state[\\/]runs[\\/][^\\/]+[\\/]?$/, '');
  return stripped === runDir ? runDir.replace(/[\\/]+$/, '') : stripped;
}

export const reportPathOf = (runDir: string, slug: string): string => `${sessionDirOf(runDir)}/${slug}.report.md`;

function writeIfChanged(ports: Ports, file: string, text: string): void {
  if (ports.fs.exists(file) && ports.fs.readText(file) === text) return;
  ports.fs.writeAtomic(file, text);
}

function writeSection(ports: Ports, file: string, review: ReviewState): void {
  if (!('c' in review) || !review.c.rounds.length || !ports.fs.exists(file)) return;
  writeIfChanged(ports, file, replaceResolutionSection(ports.fs.readText(file), renderResolutionSection(resolutionRounds(review.c))));
}

function render(state: RootState, ports: Ports, runDir: string): void {
  const child = childOf(state);
  if (!child || state.tag === 'booting') return;
  if (child.verb === 'plan') {
    const plan = child.state;
    if ('review' in plan && plan.review !== null && 'c' in plan.review) writeSection(ports, plan.review.c.spec.target, plan.review);
    return;
  }
  if (child.verb !== 'review') return;
  const review = child.state;
  if (!('c' in review) || !review.c.rounds.length) return;
  const { spec } = review.c;
  const summary = isReviewTerminal(review) ? String(reviewData(review)['summary']) : `round ${review.c.round} in progress (${review.tag})`;
  writeIfChanged(ports, reportPathOf(runDir, state.run.slug), renderReport({
    title: `Review: ${spec.target || 'working tree'}`, kind: spec.kind, target: spec.target || 'working tree', summary, rounds: resolutionRounds(review.c),
  }));
  if (spec.kind !== 'code' && spec.mode === 'fix') writeSection(ports, spec.target, review);
}

// SECTION: Machine

export const rootTransitions = [
  { from: 'booting', on: 'RUN_STARTED', to: 'ask' },
  { from: 'booting', on: 'RUN_STARTED', to: 'plan' },
  { from: 'booting', on: 'RUN_STARTED', to: 'review' },
  { from: 'booting', on: 'RUN_STARTED', to: 'handoff' },
  { from: 'ask', on: 'WAVE_DONE', to: 'handoff' },
  { from: 'ask', on: 'EFFECT_FAILED', to: 'handoff' },
  { from: 'plan', on: 'ARTIFACT_PARSED', to: 'handoff' },
  { from: 'plan', on: 'WAVE_DONE', to: 'handoff' },
  { from: 'plan', on: 'RULINGS', to: 'handoff' },
  { from: 'plan', on: 'DECISION', to: 'handoff' },
  { from: 'plan', on: 'EFFECT_FAILED', to: 'handoff' },
  { from: 'review', on: 'REVIEW_PREPARED', to: 'handoff' },
  { from: 'review', on: 'WAVE_DONE', to: 'handoff' },
  { from: 'review', on: 'RULINGS', to: 'handoff' },
  { from: 'review', on: 'DECISION', to: 'handoff' },
  { from: 'review', on: 'VERIFY_DONE', to: 'handoff' },
  { from: 'review', on: 'ARTIFACT_PARSED', to: 'handoff' },
  { from: 'review', on: 'EFFECT_FAILED', to: 'handoff' },
  { from: 'handoff', on: 'HANDOFF_DONE', to: 'done' },
  { from: 'handoff', on: 'EFFECT_FAILED', to: 'done' },
] as const;

export const rootMachine: Machine<RootState> = {
  initial: () => ({ tag: 'booting' }),
  step: stepRoot,
  awaitOf,
  project,
  transitions: rootTransitions,
  validate,
  render,
};
