import assert from 'node:assert/strict';
import type { LevelGateScope, RunStartedEvent, ScopeProposal } from '../../../../skills/dispatch/scripts/core/types.ts';
import { beginDesign, stepDesign, validateDesign, type DesignState } from '../../../../skills/dispatch/scripts/machines/design.ts';
import type { ImplementState } from '../../../../skills/dispatch/scripts/machines/implement.ts';
import { stepDesignRevision } from '../../../../skills/dispatch/scripts/machines/design-revision.ts';
import { asParsedDesign, designScopeGrew } from '../../../../skills/dispatch/scripts/domain/design.ts';
import { rootMachine, stepRoot, type RootState } from '../../../../skills/dispatch/scripts/machines/root.ts';
import { approvalState, FP } from './implement-recovery.ts';

export const hash = `sha256:${'a'.repeat(64)}`;
export const design = { title: 'Delivery', box: { 'TL;DR': 'Deliver feature' }, governedText: '# Delivery', executionStatus: null, increments: [{ id: 'I01', priority: 1, summary: 'First', prerequisites: [], paths: ['src/a.ts'] }, { id: 'I02', priority: 2, summary: 'Second', prerequisites: ['I01'], paths: ['src/b.ts'] }], details: { I01: { Outcome: 'First behavior' }, I02: { Outcome: 'Second behavior' } } };
export const run = (verb: 'design' | 'implement' = 'design'): RunStartedEvent => ({ type: 'RUN_STARTED', protocolRevision: 5, verb, argument: 'x.design.md', level: 'low', levelSource: 'explicit', pins: null, fix: true, orchestrator: 'claude', orchestratorModel: null, overrides: { sessionDir: '/session' }, repo: {}, config: { 'write-subagents': { claude: { low: { model: 'writer' } } }, 'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } }, phases: { 'design-review': { rounds: { low: 0 }, targets: { low: 1 } }, 'plan-review': { rounds: { low: 0 }, targets: { low: 1 } }, 'code-review': { rounds: { low: 0 }, targets: { low: 1 } } } } });
export function approval(verb: 'design' | 'implement' = 'design'): DesignState {
  let result = beginDesign(run(verb));
  if (result.state.tag === 'author') result = stepDesign(result.state, { type: 'AUTHORED', path: 'x.design.md' });
  result = stepDesign(result.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: result.effects[0]!.id, hash, parsed: design, defects: [] });
  return stepDesign(result.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: result.effects[0]!.id, hash, parsed: design, defects: [] }).state;
}
export function approveDesignScope(result: ReturnType<typeof stepDesign>): ReturnType<typeof stepDesign> {
  const state = result.state;
  if (state.tag !== 'revision') return result;
  let child = state.child;
  if (child.tag === 'scope-adjudication') {
    child = stepDesignRevision(child, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request: child.request, ruling: 'approve', rationale: 'The revised acceptance expands governed work.' } }).state;
  }
  if (child.tag !== 'resume') return result;
  const resumed = stepDesign({ ...state, child }, { type: 'LOCK_BROKEN', stalePid: 1 });
  return { ...result, state: resumed.state, effects: [...result.effects, ...resumed.effects] };
}