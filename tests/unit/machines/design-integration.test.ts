import assert from 'node:assert/strict';
import { test } from 'node:test';
import { threshold } from '../../../skills/dispatch/scripts/policy/rounds.ts';
import { stepDesign, designData, type DesignState } from '../../../skills/dispatch/scripts/machines/design.ts';
import { design, hash } from './fixtures/design.ts';
import { started } from './fixtures/design-delivery.ts';
import { integration } from './fixtures/design-integration.ts';

function fixBatch(state: DesignState) {
  if (state.tag !== 'integration' || state.review.tag !== 'fix') throw new Error('integration fix batch');
  return state.review;
}

// SECTION: Integration fix batch and ownership

test('design-integration-fix: accepted finding enters fix batch under unique or ambiguous ownership', () => {
  for (const ownership of [{ I01: ['src/a.ts'] }, { I01: ['src/a.ts'], I02: ['src/a.ts'] }]) {
    const state = integration();
    state.c = { ...state.c, ownership };
    assert.deepEqual(fixBatch(stepDesign(state, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' } } }).state).clusters.flatMap((cluster) => cluster.findingIds), ['R1-F001']);
  }
});
test('design-integration-ownership: settled non-fixable acceptance still fails closed on ambiguous ownership', () => {
  const state = integration();
  if (state.tag !== 'integration' || !('c' in state.review)) throw new Error('review');
  state.c = { ...state.c, ownership: { I01: ['src/a.ts'], I02: ['src/a.ts'] } };
  state.review = { ...state.review, c: { ...state.review.c, findings: state.review.c.findings.map((row) => ({ ...row, severity: 'CONSIDER' })) } };
  const offered = stepDesign(state, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' } } });
  if (offered.state.tag !== 'integration' || offered.state.review.tag !== 'decide-opt-in') throw new Error('opt-in');
  const settled = stepDesign(offered.state, { type: 'DECISION', kind: 'opt-in', answer: [] }).state;
  assert.equal(settled.tag, 'failed');
  if (settled.tag === 'failed') assert.match(settled.summary, /ownership is ambiguous or lost/);
});
test('design-integration-fix: accepted shared-contract finding enters fix batch', () => {
  const state = integration();
  if (state.tag !== 'integration' || !('c' in state.review)) throw new Error('review');
  state.review = { ...state.review, c: { ...state.review.c, findings: state.review.c.findings.map((row) => ({ ...row, fix: { paths: ['src/a.ts', 'src/b.ts'], dependencies: [], verification: [] } })) } };
  const fix = fixBatch(stepDesign(state, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' } } }).state);
  assert.deepEqual(fix.clusters.flatMap((cluster) => cluster.paths), ['src/a.ts', 'src/b.ts']);
});

// SECTION: Integration shared contracts and repair

test('integration discloses the one-owner shared contract ruling signal', () => {
  const state = integration();
  const signal = designData(state)['sharedContract'] as { marker: string; rulingField: string; instruction: string };
  assert.equal(signal.rulingField, 'rulings[id].reason');
  assert.match(signal.instruction, /fixable in-scope findings receive scoped fixes/i);
  assert.match(signal.instruction, /marker in the ruling reason.*design revision.*if it remains accepted when review settles/i);
  const result = stepDesign(state, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept', reason: `${signal.marker} changes an inherited invariant` } } });
  assert.deepEqual(fixBatch(result.state).clusters.flatMap((cluster) => cluster.findingIds), ['R1-F001']);
});

test('integration shared revision objective refusal fails closed without replaying consumed rulings', () => {
  const state = integration();
  if (state.tag !== 'integration' || !('c' in state.review)) throw new Error('review');
  state.review = { ...state.review, c: { ...state.review.c, findings: state.review.c.findings.map((row) => ({ ...row, severity: 'CONSIDER' })) } };
  const offered = stepDesign(state, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept', reason: '[shared-contract]' } } });
  assert.equal(offered.state.tag, 'integration');
  if (offered.state.tag !== 'integration' || offered.state.review.tag !== 'decide-opt-in') throw new Error('opt-in');
  const revision = stepDesign(offered.state, { type: 'DECISION', kind: 'opt-in', answer: [] });
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
  state.review = { ...state.review, c: { ...state.review.c, findings: state.review.c.findings.map((row) => ({ ...row, category: 'intent', severity: 'CONSIDER' })) } };
  const needsUser = stepDesign(state, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'needs-user' } } });
  const accepted = stepDesign(needsUser.state, { type: 'DECISION', kind: 'needs-user', answer: { 'R1-F001': { ruling: 'accept', quote: 'yes' } } });
  const result = stepDesign(accepted.state, { type: 'DECISION', kind: 'opt-in', answer: [] });
  assert.equal(result.state.tag, 'increment');
});

test('shared-contract accepted local findings enter one fix batch in either order', () => {
  for (const reverse of [false, true]) {
    const state = integration();
    if (state.tag !== 'integration' || !('c' in state.review)) throw new Error('review');
    const local = state.review.c.findings[0]!;
    const shared = { ...local, id: 'R1-F002', defect: 'Shared defect', fix: { paths: ['src/a.ts', 'src/b.ts'], dependencies: [], verification: [] } };
    state.review = { ...state.review, c: { ...state.review.c, findings: reverse ? [shared, local] : [local, shared] } };
    const fix = fixBatch(stepDesign(state, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' }, 'R1-F002': { ruling: 'accept' } } }).state);
    assert.deepEqual(fix.clusters.flatMap((cluster) => cluster.findingIds).sort(), ['R1-F001', 'R1-F002']);
  }
});

test('non-fixable accepted integration repair re-entry retains the original cap and cumulative round threshold', () => {
  const initial = integration();
  if (initial.tag !== 'integration' || !('c' in initial.review)) throw new Error('integration review');
  initial.review = { ...initial.review, c: { ...initial.review.c, findings: initial.review.c.findings.map((row) => ({ ...row, severity: 'CONSIDER' })) } };
  const offered = stepDesign(initial, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' } } });
  const first = stepDesign(offered.state, { type: 'DECISION', kind: 'opt-in', answer: [] }).state;
  if (first.tag !== 'increment' || !('c' in first.child) || !first.child.c) throw new Error('repair');
  const config = { ...first.c.run.config, phases: { 'code-review': { rounds: { low: 2 }, targets: { low: 1 } } } };
  const repaired = { ...first, c: { ...first.c, run: { ...first.c.run, config } }, child: { tag: 'complete' as const, c: { ...first.child.c, changedPaths: ['src/a.ts'] }, summary: 'Repaired' } };
  const preparing = stepDesign(repaired, { type: 'LOCK_BROKEN', stalePid: 1 });
  const next = preparing.state;
  if (next.tag !== 'integration' || !('c' in next.review)) throw new Error('integration');
  assert.equal(next.review.tag, 'prepare');
  assert.equal(next.review.c.round, 1);
  assert.equal(next.review.c.spec.cap, 2);
  const prepare = preparing.effects.find((effect) => effect.kind === 'prepare-review');
  assert.ok(prepare?.kind === 'prepare-review');
  assert.equal(prepare.round, 2);
  const launched = stepDesign(next, { type: 'REVIEW_PREPARED', effectId: prepare.id, scope: { empty: false }, promptPaths: {} });
  if (launched.state.tag !== 'integration' || launched.state.review.tag !== 'wave') throw new Error('wave');
  assert.equal(launched.state.review.c.round, 2);
  assert.equal(launched.state.review.c.spec.cap, 2);
  assert.equal(threshold(launched.state.review.c.round, launched.state.review.c.spec.cap), 'MUST');
  assert.equal(launched.effects[0]?.kind === 'wave-start' && launched.effects[0].round, 2);
});
