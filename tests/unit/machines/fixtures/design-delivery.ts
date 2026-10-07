import assert from 'node:assert/strict';
import { stepDesign, selectReady, type DesignState } from '../../../../skills/dispatch/scripts/machines/design.ts';
import { validateDesignTraceability } from '../../../../skills/dispatch/scripts/domain/plan.ts';
import { approval, approveDesignScope, hash, design } from './design.ts';
import { beginRevision } from '../../../../skills/dispatch/scripts/machines/revision.ts';
import { beginDesignRevision, stepDesignRevision } from '../../../../skills/dispatch/scripts/machines/design-revision.ts';
import { PLAN, FP } from './implement-recovery.ts';
import type { ParsedPlan } from '../../../../skills/dispatch/scripts/domain/types.ts';

export function started(): DesignState {
  const approved = stepDesign(approval('implement'), { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Deliver', hash } });
  return stepDesign(approved.state, { type: 'SNAPSHOT', effectId: approved.effects[0]!.id, fingerprint: { head: 'a'.repeat(40), index: 'i', worktree: 'w' }, diff: { paths: [] } }).state;
}
