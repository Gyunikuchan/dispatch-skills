import type { ExecutionConfigUpdated, RunStartedEvent, ModelLevels } from '../core/types.ts';
import { refreshedRun } from '../domain/execution-config.ts';
import { LEVELS, normalizeProvider, resolveLevel } from '../policy/roster.ts';
import type { RosterSlot } from '../domain/types.ts';
import type { RootState } from './root.ts';
import type { PlanState } from './plan.ts';
import type { ReviewState } from './review.ts';
import type { ImplementState, Context } from './implement.ts';
import { writerConfig } from './implement-types.ts';
import type { DesignState, DesignContext } from './design.ts';
import type { RevisionState } from './revision.ts';
import type { DesignRevisionState } from './design-revision.ts';
import type { ReviewSpec } from './types.ts';

function specDefaults(spec: ReviewSpec, run: RunStartedEvent, event: ExecutionConfigUpdated): ReviewSpec {
  const roster = spec.roster.map((slot): RosterSlot => {
    const change = event.delta.read.find((item) => normalizeProvider(item.provider) === slot.provider && Number(/\[(\d+)\]$/.exec(item.slot)?.[1]) === slot.index);
    if (!change) return slot;
    const level = resolveLevel<ModelLevels[string]>(Object.fromEntries(LEVELS.filter((key) => change.levels[key]).map((key) => [key, change.levels[key]])), run.level);
    if (!level) throw new Error('execution-config-level: no selected model');
    const { effort: _old, ...base } = slot;
    const model = typeof run.overrides['model'] === 'string' ? run.overrides['model'] : level.model;
    const effort = typeof run.overrides['effort'] === 'string' ? run.overrides['effort'] : level.effort;
    return { ...base, model, ...(effort !== undefined ? { effort } : {}) };
  });
  return { ...spec, roster };
}
function review(state: ReviewState, run: RunStartedEvent, event: ExecutionConfigUpdated): ReviewState {
  if (state.tag === 'booting' || ['settled', 'skipped', 'failed', 'empty', 'escalated'].includes(state.tag)) return state;
  return { ...state, c: { ...state.c, pendingSpec: specDefaults(state.c.pendingSpec ?? state.c.spec, run, event) } };
}
function context(c: Context, event: ExecutionConfigUpdated): Context {
  const run = refreshedRun(c.run, event);
  const writer = writerConfig(run.config, run.orchestrator, run.level);
  return { ...c, run, ...(writer.ok ? { pendingWriter: writer.value } : {}) };
}
function implement(state: ImplementState, event: ExecutionConfigUpdated): ImplementState {
  if (!('c' in state) || state.c === null || ['complete', 'stopped', 'failed'].includes(state.tag)) return state;
  const c = context(state.c, event);
  if ('parent' in state) return { ...state, c, parent: implement(state.parent, event) };
  if (state.tag === 'plan-review' || state.tag === 'code-review') return { ...state, c, review: review(state.review, c.run, event) };
  return { ...state, c };
}
function plan(state: PlanState, run: RunStartedEvent, event: ExecutionConfigUpdated): PlanState {
  if (!('c' in state) || state.c === null || ['complete', 'escalated', 'failed'].includes(state.tag)) return state;
  const c = { ...state.c, input: { ...state.c.input, spec: specDefaults(state.c.input.spec, run, event) } };
  return state.tag === 'review' ? { ...state, c, review: review(state.review, run, event) } : { ...state, c };
}
function revision(state: RevisionState, event: ExecutionConfigUpdated): RevisionState {
  const r = { ...state.r, c: context(state.r.c, event), parent: implement(state.r.parent, event) };
  if ('parent' in state) return { ...state, r, parent: revision(state.parent, event) };
  return state.tag === 'review' ? { ...state, r, review: review(state.review, r.c.run, event) } : { ...state, r };
}
const designContext = (c: DesignContext, event: ExecutionConfigUpdated): DesignContext => ({ ...c, run: refreshedRun(c.run, event) });
function designRevision(state: DesignRevisionState, event: ExecutionConfigUpdated): DesignRevisionState {
  const c = designContext(state.c, event);
  return state.tag === 'review' ? { ...state, c, review: review(state.review, c.run, event) } : { ...state, c };
}
function design(state: DesignState, event: ExecutionConfigUpdated): DesignState {
  if (state.tag === 'complete' || state.tag === 'failed') return state;
  const c = designContext(state.c, event);
  if (state.tag === 'increment') return { ...state, c, child: implement(state.child, event) };
  if (state.tag === 'plan-revision') return { ...state, c, child: revision(state.child, event) };
  if (state.tag === 'review' || state.tag === 'integration') return { ...state, c, review: review(state.review, c.run, event) };
  if (state.tag === 'revision') return { ...state, c, child: designRevision(state.child, event), ...(state.parent ? { parent: design(state.parent, event) } : {}) };
  if (state.tag === 'approval' && state.parent) return { ...state, c, parent: design(state.parent, event) };
  return { ...state, c };
}

/** Update future defaults recursively; completed histories and materialized bindings stay immutable. */
export function reconfigureRoot(state: RootState, event: ExecutionConfigUpdated, run: RunStartedEvent): RootState {
  switch (state.tag) {
    case 'plan': return { ...state, child: plan(state.child, run, event) };
    case 'review': return { ...state, child: review(state.child, run, event) };
    case 'implement': return { ...state, child: implement(state.child, event) };
    case 'design': return { ...state, child: design(state.child, event) };
    case 'revision': return { ...state, child: revision(state.child, event) };
    case 'ask': case 'booting': case 'done': case 'handoff': return state;
  }
}

/** A new descriptor consumes pending defaults; its await alone does not imply deferral. */
export function executionBindingDeferred(state: RootState): boolean {
  const reviewing = (value: ReviewState) => value.tag === 'native' && value.c.pendingSpec !== undefined;
  const implementing = (value: ImplementState): boolean => {
    if (value.tag === 'tasks' || value.tag === 'hotfix-write') return value.c.pendingWriter !== undefined;
    if (value.tag === 'plan-review' || value.tag === 'code-review') return reviewing(value.review);
    return false;
  };
  const revising = (value: RevisionState) => value.tag === 'review' && reviewing(value.review);
  const designing = (value: DesignState): boolean => {
    switch (value.tag) {
      case 'increment': return implementing(value.child);
      case 'plan-revision': return revising(value.child);
      case 'review': case 'integration': return reviewing(value.review);
      case 'revision': return value.child.tag === 'review' && reviewing(value.child.review);
      default: return false;
    }
  };
  switch (state.tag) {
    case 'ask': return state.child.tag === 'native';
    case 'plan': return state.child.tag === 'review' && reviewing(state.child.review);
    case 'review': return reviewing(state.child);
    case 'implement': return implementing(state.child);
    case 'revision': return revising(state.child);
    case 'design': return designing(state.child);
    case 'booting': case 'handoff': case 'done': return false;
  }
}
