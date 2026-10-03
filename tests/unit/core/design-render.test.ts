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


test('standalone artifact reviews record inline history in report mode and preserve successive runs', () => {
  const ports = fakePorts(), session = tempDir(), target = path.join(session, 'feature.plan.md');
  ports.fs.writeAtomic(target, '# Feature\n\n## Review Findings & Resolutions\nNo reviews conducted yet.\n\n## Out of Scope\nkeep\n');
  for (const kind of ['plan', 'design'] as const) {
    const begun = beginReview({ kind, mode: 'report', target, cap: 1, breadth: 1, context: '', roster: [], timeoutMs: 1000 }, 'review', {}).state;
    if (!('c' in begun)) throw new Error('review');
    const review = { tag: 'rule' as const, c: { ...begun.c, round: 1, rounds: [{ round: 1, scope: 'full' as const, reviewers: ['reader'], failed: [] }], findings: [] } };
    const state: RootState = { tag: 'review', run: { verb: 'review', argument: target, slug: 'feature' }, child: review };
    const runDir = path.join(session, kind);
    rootMachine.render!(state, ports, runDir);
    const first = ports.fs.readText(target);
    rootMachine.render!(state, ports, runDir);
    assert.equal(ports.fs.readText(target), first);
    assert.equal(ports.fs.exists(path.join(runDir, 'feature.report.md')), false);
  }
  const rendered = ports.fs.readText(target);
  assert.equal((rendered.match(/^### Review /gm) ?? []).length, 2);
  assert.ok(!rendered.includes('No reviews conducted yet.'));
  assert.match(rendered, /## Out of Scope\nkeep/);
});


test('code review records findings in its governing walkthrough', () => {
  const ports = fakePorts(), session = tempDir(), target = path.join(session, 'feature.walkthrough.md');
  ports.fs.writeAtomic(target, '# Delivered\n');
  const begun = beginReview({ kind: 'code', mode: 'report', target: 'HEAD', cap: 1, breadth: 1, context: '', roster: [], timeoutMs: 1000, governing: { planPath: 'feature.plan.md', walkthroughPath: target, criteria: [] } }, 'review', {}).state;
  if (!('c' in begun)) throw new Error('review');
  const state: RootState = { tag: 'review', run: { verb: 'review', argument: 'HEAD', slug: 'feature' }, child: { tag: 'rule', c: { ...begun.c, round: 1, rounds: [{ round: 1, scope: 'full', reviewers: ['reader'], failed: [] }] } } };
  rootMachine.render!(state, ports, session);
  assert.match(ports.fs.readText(target), /## Review Findings & Resolutions[\s\S]*No findings/);
  assert.equal(ports.fs.exists(path.join(session, 'feature.report.md')), false);
});


test('walkthrough regeneration retains later standalone review history without duplicating implementation rounds', () => {
  const ports = fakePorts(), session = tempDir(), target = path.join(session, 'feature.walkthrough.md');
  const implementation = { tag: 'complete' as const, c: approvalState().c, summary: 'Done' };
  const state: RootState = { tag: 'implement', run: { verb: 'implement', argument: 'feature.plan.md', slug: 'feature' }, child: implementation };
  rootMachine.render!(state, ports, session);
  const original = ports.fs.readText(target);
  ports.fs.writeAtomic(target, `${original}\n### Review later-review\n\n#### Round 1\n- No findings.\n`);
  rootMachine.render!(state, ports, session);
  const updated = ports.fs.readText(target);
  assert.match(updated, /### Review later-review/);
  assert.equal((updated.match(/\/implementation/g) ?? []).length, 1);
  rootMachine.render!(state, ports, session);
  assert.equal(ports.fs.readText(target), updated);
});


test('design integration records review history in the owning design', () => {
  const ports = fakePorts(), session = tempDir(), target = path.join(session, 'feature.design.md');
  ports.fs.writeAtomic(target, '# Design\n');
  const begun = beginReview({ kind: 'code', mode: 'report', target: 'HEAD', cap: 1, breadth: 1, context: '', roster: [], timeoutMs: 1000 }, 'design.integration', {}).state;
  if (!('c' in begun)) throw new Error('review');
  const integrationReview = { tag: 'rule' as const, c: { ...begun.c, round: 1, rounds: [{ round: 1, scope: 'full' as const, reviewers: ['reader'], failed: [] }] } };
  const active = started();
  const state: RootState = { tag: 'design', run: { verb: 'implement', argument: target, slug: 'feature' }, child: { tag: 'complete', c: { ...active.c, path: target, integrationReview }, summary: 'Done' } };
  rootMachine.render!(state, ports, session);
  assert.match(ports.fs.readText(target), /## Review Findings & Resolutions[\s\S]*design.integration[\s\S]*No findings/);
  assert.equal(ports.fs.exists(path.join(session, 'feature-integration.report.md')), false);
});
