import type { Phase } from '../domain/diagnostics.ts';
import type { RootState } from './root.ts';
import type { PlanState } from './plan.ts';
import type { ImplementState } from './implement.ts';
import type { DesignState } from './design.ts';
import type { ReviewState } from './review.ts';
import type { RevisionState } from './revision.ts';

const terminal = (tag: string): string | undefined => ({ complete: 'complete', settled: 'complete', skipped: 'skipped', empty: 'no-reviewable-changes', failed: 'failed', stopped: 'stopped', escalated: 'stopped', refused: 'stopped' })[tag];
/** A review phase with the machine's own convergence result (history re-raises, halt escalation), so diagnostics agree with the driver. */
function review(state: ReviewState, key: string, integration = false): Phase[] {
  if (!('c' in state)) return [];
  const reraised = state.c.history.filter((entry) => entry.reraises > 0).map((entry) => entry.id);
  const escalation = state.tag === 'decide-escalation' || state.tag === 'escalated' ? state.escalation : undefined;
  return [{
    key, name: integration ? 'integration review' : state.c.spec.kind === 'code' ? 'code review' : state.c.spec.kind === 'design' ? 'design review' : 'plan review',
    ...(terminal(state.tag) ? { outcome: terminal(state.tag)! } : {}), ...(reraised.length ? { reraised } : {}), ...(escalation ? { escalation: { kind: escalation.kind, ids: [...escalation.ids] } } : {}),
  }];
}
function plan(state: PlanState, key: string): Phase[] {
  if (state.tag === 'booting') return [];
  if (state.tag === 'review' || state.tag === 'complete' || state.tag === 'escalated') return [{ key, name: 'plan', ...(terminal(state.tag) ? { outcome: terminal(state.tag)! } : {}) }, ...review(state.review, `${key}/review`)];
  return [{ key, name: 'plan', ...(terminal(state.tag) ? { outcome: terminal(state.tag)! } : {}) }];
}
function implement(state: ImplementState, key: string): Phase[] {
  if (state.tag === 'booting') return [];
  if ('parent' in state) return implement(state.parent, key);
  const outer: Phase = { key, name: 'implementation', ...(terminal(state.tag) ? { outcome: terminal(state.tag)! } : {}) };
  if (state.tag === 'author' || state.tag === 'parsing' || state.tag === 'starting') return [outer, { key: `${key}/plan`, name: 'plan' }];
  if (state.tag === 'plan-review') return [outer, ...review(state.review, `${key}/plan-review`)];
  const prior = state.c?.planReview && terminal(state.c.planReview.tag) ? review(state.c.planReview, `${key}/plan-review`) : [];
  const code = state.tag === 'code-review' ? review(state.review, `${key}/code-review`) : state.c?.codeReview && terminal(state.c.codeReview.tag) ? review(state.c.codeReview, `${key}/code-review`) : [];
  return [...prior, outer, ...code];
}
function revision(state: RevisionState, key: string): Phase[] {
  const current = `${key}/revision-${state.r.c.revisions.length + 1}`;
  return [{ key: current, name: 'plan', ...(terminal(state.tag) ? { outcome: terminal(state.tag)! } : {}) }, ...(state.tag === 'review' ? review(state.review, `${current}/review`) : [])];
}
function design(state: DesignState, key: string): Phase[] {
  const outer: Phase = { key, name: 'design', ...(terminal(state.tag) ? { outcome: terminal(state.tag)! } : {}) };
  switch (state.tag) {
    case 'increment': return [outer, ...implement(state.child, `${key}/${state.increment.toLowerCase()}`)];
    case 'plan-revision': return [outer, { key: `${key}/${state.increment.toLowerCase()}`, name: 'implementation' }, ...revision(state.child, `${key}/${state.increment.toLowerCase()}`)];
    case 'review': return [outer, ...review(state.review, `${key}/review`)];
    case 'integration': return [outer, ...review(state.review, `${key}/integration`, true)];
    case 'revision': return [outer, { key: `${key}/revision-${state.c.revisions.length + 1}`, name: 'design' }, ...(state.child.tag === 'review' ? review(state.child.review, `${key}/revision-${state.c.revisions.length + 1}/review`) : [])];
    default: return [outer];
  }
}
export function diagnosticPhases(state: RootState): Phase[] {
  switch (state.tag) {
    case 'booting': return [];
    case 'ask': return [{ key: 'ask', name: 'ask' }];
    case 'plan': return plan(state.child, 'plan');
    case 'implement': return implement(state.child, 'implementation');
    case 'review': return review(state.child, 'review');
    case 'revision': return [{ key: 'implementation', name: 'implementation' }, ...revision(state.child, 'implementation')];
    case 'design': return design(state.child, 'design');
    case 'handoff': case 'retro': case 'done': {
      const last = state.last;
      if (!last) return [];
      const phases = last.verb === 'review' ? review(last.state, 'review') : last.verb === 'plan' ? plan(last.state, 'plan') : last.verb === 'implement' ? implement(last.state, 'implementation') : last.verb === 'design' ? design(last.state, 'design') : [{ key: 'ask', name: 'ask' as const }];
      return phases.map((phase) => ({ ...phase, outcome: phase.outcome ?? state.done.outcome }));
    }
  }
}
