import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { rootMachine, type RootState } from '../../../skills/dispatch/scripts/machines/root.ts';
import { beginReview, stepReview } from '../../../skills/dispatch/scripts/machines/review.ts';
import { approvalState } from '../machines/implement-recovery.test.ts';
import { started } from '../machines/design-delivery.test.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';

test('standalone, active and completed design children share idempotent plan resolution rendering', () => {
  const ports = fakePorts(), session = tempDir(), planPath = path.join(session, 'increment.plan.md');
  const begun = beginReview({ kind: 'plan', mode: 'report', target: planPath, cap: 1, breadth: 1, context: '', roster: [], timeoutMs: 1000 }, 'plan.review', {}).state;
  if (!('c' in begun)) throw new Error('review');
  const planReview = stepReview({ tag: 'rule', c: { ...begun.c, round: 1, rounds: [{ round: 1, scope: 'full', reviewers: ['reader'], failed: [] }], findings: [{ id: 'R1-F001', round: 1, status: 'open', severity: 'SHOULD', category: 'correctness', locus: 'src/a.ts:L1', defect: 'Missing check', requiredChange: 'Add check', sources: ['reader'], scope: 'in' }] } }, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept', reason: 'Added check' } } }).state;
  const implementation = { ...approvalState(), c: { ...approvalState().c, planPath, planReview } };
  const active = started();
  if (active.tag !== 'increment') throw new Error('design');
  const run = { verb: 'implement' as const, argument: 'x.design.md', slug: 'feature' };
  const states: RootState[] = [
    { tag: 'implement', run, child: implementation },
    { tag: 'design', run, child: { ...active, child: implementation } },
    { tag: 'design', run, child: { tag: 'complete', c: { ...active.c, histories: { I01: [{ tag: 'complete', c: implementation.c, summary: 'Done' }] } }, summary: 'Done' } },
  ];
  for (const state of states) {
    ports.fs.writeAtomic(planPath, '# Increment\n');
    rootMachine.render!(state, ports, session);
    const rendered = ports.fs.readText(planPath);
    assert.match(rendered, /## Review Findings & Resolutions[\s\S]*R1-F001[\s\S]*Added check/);
    let writes = 0;
    const original = ports.fs.writeAtomic;
    ports.fs.writeAtomic = (file, text) => { writes++; original(file, text); };
    rootMachine.render!(state, ports, session);
    ports.fs.writeAtomic = original;
    assert.equal(writes, 0);
  }
});
