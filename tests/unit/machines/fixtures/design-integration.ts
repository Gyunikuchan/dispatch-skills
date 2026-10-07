import assert from 'node:assert/strict';
import { beginReview, stepReview } from '../../../../skills/dispatch/scripts/machines/review.ts';
import { threshold } from '../../../../skills/dispatch/scripts/policy/rounds.ts';
import { stepDesign, designData, type DesignState } from '../../../../skills/dispatch/scripts/machines/design.ts';
import { design, hash } from './design.ts';
import { started } from './design-delivery.ts';

export function integration(): DesignState {
  const first = started();
  const c = { ...first.c, completed: ['I01', 'I02'], ownership: { I01: ['src/a.ts'], I02: ['src/b.ts'] } };
  const review = beginReview({ kind: 'code', mode: 'report', target: '', cap: 2, breadth: 1, context: '', roster: [], timeoutMs: 1000 }, 'design.integration', c.counters).state;
  if (!('c' in review)) throw new Error('review');
  return { tag: 'integration', c, review: { tag: 'rule', c: { ...review.c, round: 1, findings: [{ id: 'R1-F001', round: 1, status: 'open', severity: 'MUST', category: 'correctness', locus: 'src/a.ts:L1', defect: 'Broken integration', requiredChange: 'Repair', sources: ['reader'], scope: 'in' }] } } };
}