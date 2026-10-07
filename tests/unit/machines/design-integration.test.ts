import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginReview, stepReview } from '../../../skills/dispatch/scripts/machines/review.ts';
import { threshold } from '../../../skills/dispatch/scripts/policy/rounds.ts';
import { stepDesign, designData, type DesignState } from '../../../skills/dispatch/scripts/machines/design.ts';
import { design, hash } from './fixtures/design.ts';
import { started } from './fixtures/design-delivery.ts';
import { integration } from './fixtures/design-integration.ts';

test('design-reopen-on-defect: accepted owned defect reopens its child with repair context', () => {
  const result = stepDesign(integration(), { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' } } });
  assert.equal(result.state.tag, 'increment');
  if (result.state.tag !== 'increment' || !('c' in result.state.child) || !result.state.child.c) throw new Error('child');
  assert.equal(result.state.increment, 'I01');
  assert.match(result.state.child.c.designBinding!.repair[0]!, /Broken integration/);
  assert.deepEqual(result.state.c.ownership['I01'], ['src/a.ts']);
});
test('design-integration-ownership: ambiguous ownership fails closed', () => {
  const state = integration();
  state.c = { ...state.c, ownership: { I01: ['src/a.ts'], I02: ['src/a.ts'] } };
  assert.equal(stepDesign(state, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' } } }).state.tag, 'failed');
});
test('accepted shared-contract integration finding requests design revision', () => {
  const state = integration();
  if (state.tag !== 'integration' || !('c' in state.review)) throw new Error('review');
  state.review = { ...state.review, c: { ...state.review.c, findings: state.review.c.findings.map((row) => ({ ...row, fix: { paths: ['src/a.ts', 'src/b.ts'], dependencies: [], verification: [] } })) } };
  assert.equal(stepDesign(state, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' } } }).state.tag, 'revision');
});

test('integration discloses the one-owner shared contract ruling signal', () => {
  const state = integration();
  const signal = designData(state)['sharedContract'] as { marker: string; rulingField: string };
  assert.equal(signal.rulingField, 'rulings[id].reason');
  const result = stepDesign(state, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept', reason: `${signal.marker} changes an inherited invariant` } } });
  assert.equal(result.state.tag, 'revision');
});

test('integration shared revision objective refusal fails closed without replaying consumed rulings', () => {
  const revision = stepDesign(integration(), { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept', reason: '[shared-contract]' } } });
  if (revision.state.tag !== 'revision') throw new Error('revision');
  const parsed = stepDesign(revision.state, { type: 'AUTHORED', path: revision.state.child.workingPath });
  const refused = stepDesign(parsed.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: parsed.effects[0]!.id, hash, parsed: { ...design, box: { 'TL;DR': 'Other objective' } }, defects: [] });
  assert.equal(refused.state.tag, 'failed');
  assert.deepEqual(refused.effects, []);
  assert.equal(stepDesign(refused.state, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' } } }).state, refused.state);
});

test('increment-local intent reopens its owner after the user ruling settles', () => {
  const state = integration();
  if (state.tag !== 'integration' || !('c' in state.review)) throw new Error('review');
  state.review = stepReview({ tag: 'rule', c: { ...state.review.c, findings: state.review.c.findings.map((row) => ({ ...row, category: 'intent', status: 'accepted' })) } }, { type: 'RULINGS', rulings: {} }).state;
  const result = stepDesign(state, { type: 'LOCK_BROKEN', stalePid: 1 });
  assert.equal(result.state.tag, 'increment');
});

test('shared-contract revision retains every accepted local repair in either finding order', () => {
  for (const reverse of [false, true]) {
    const state = integration();
    if (state.tag !== 'integration' || !('c' in state.review)) throw new Error('review');
    const local = state.review.c.findings[0]!;
    const shared = { ...local, id: 'R1-F002', defect: 'Shared defect', fix: { paths: ['src/a.ts', 'src/b.ts'], dependencies: [], verification: [] } };
    state.review = { ...state.review, c: { ...state.review.c, findings: reverse ? [shared, local] : [local, shared] } };
    const result = stepDesign(state, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' }, 'R1-F002': { ruling: 'accept' } } });
    assert.equal(result.state.tag, 'revision');
    assert.match(result.state.c.repairs['I01']!.join('\n'), /Broken integration/);
    assert.deepEqual(result.state.c.completed, ['I02']);
    if (result.state.tag === 'revision') assert.match(result.state.child.evidence, /Shared defect/);
  }
});

test('integration repair re-entry retains the original cap and cumulative round threshold', () => {
  const first = stepDesign(integration(), { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' } } }).state;
  if (first.tag !== 'increment' || !('c' in first.child) || !first.child.c) throw new Error('repair');
  const config = { ...first.c.run.config, phases: { 'code-review': { rounds: { low: 2 }, targets: { low: 1 } } } };
  const repaired = { ...first, c: { ...first.c, run: { ...first.c.run, config } }, child: { tag: 'complete' as const, c: { ...first.child.c, changedPaths: ['src/a.ts'] }, summary: 'Repaired' } };
  const next = stepDesign(repaired, { type: 'LOCK_BROKEN', stalePid: 1 }).state;
  if (next.tag !== 'integration' || !('c' in next.review)) throw new Error('integration');
  assert.equal(next.review.c.round, 2);
  assert.equal(next.review.c.spec.cap, 2);
  assert.equal(threshold(next.review.c.round, next.review.c.spec.cap), 'MUST');
});
