import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewMachine, reviewAwait, reviewData, validateReview, reviewSpecFromRun, type ReviewState } from '../../../skills/dispatch/scripts/machines/review.ts';
import { JOURNAL_PROTOCOL_REVISION, type Event, type RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';

const started: RunStartedEvent = { type: 'RUN_STARTED', protocolRevision: JOURNAL_PROTOCOL_REVISION, verb: 'review', argument: '', level: 'low', levelSource: 'explicit', pins: null, orchestrator: 'claude', orchestratorModel: null, overrides: {}, repo: {}, config: { 'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } } } };

test('governing spec identity survives review construction without override or argument intent', () => {
  const identity = { path: 'intent.spec.md', hash: `sha256:${'a'.repeat(64)}` };
  for (const kind of ['code', 'plan', 'design'] as const) {
    const result = reviewSpecFromRun({ ...started, argument: 'legacy argument', overrides: { context: 'legacy override' } }, kind, 'target', identity);
    assert.ok(result.ok); assert.equal(result.spec.context, null); assert.deepEqual(result.spec.governingSpec, identity);
  }
});
function wave() {
  const prepare = reviewMachine.step(reviewMachine.initial(), started);
  return reviewMachine.step(prepare.state, { type: 'REVIEW_PREPARED', effectId: prepare.effects[0]!.id, scope: { manifestPath: 'prior.json' }, promptPaths: {} });
}
const finding = { id: 'R1-F001', severity: 'SHOULD' as const, category: 'correctness', locus: 'src/a.ts:L1', defect: 'Missing condition', requiredChange: 'Add condition', sources: ['codex[0]'], scope: 'in' as const };

test('review-target defers wave consumption and rejects host replies while checking', () => {
  const initial = wave();
  const result = reviewMachine.step(initial.state, { type: 'WAVE_DONE', effectId: initial.effects[0]!.id, round: 1, slots: [{ slot: 'codex[0]', state: 'success' }], findings: [finding] });
  assert.equal(result.state.tag, 'target-check'); assert.equal(reviewAwait(result.state), null);
  assert.match(validateReview(result.state, { type: 'RULINGS', rulings: {} }) ?? '', /pending/);
  const failed = reviewMachine.step(result.state, { type: 'EFFECT_FAILED', effectId: result.effects[0]!.id, cls: 'integrity', detail: 'target-changed: external edit' });
  assert.equal(failed.state.tag, 'failed'); assert.equal(reviewData(failed.state)['outcome'], 'failed');
});



test('review-target guards settlement decisions for needs-user and opt-in', () => {
  for (const tag of ['decide-needs-user', 'decide-opt-in'] as const) {
    const initial = wave(); if (!('c' in initial.state)) throw new Error('context');
    const c = { ...initial.state.c, findings: [{ ...finding, round: 1, status: 'needs-user' as const }] };
    const state: ReviewState = tag === 'decide-needs-user' ? { tag, c, ids: [finding.id] } : { tag, c, items: [finding.id] };
    const event: Event = tag === 'decide-needs-user' ? { type: 'DECISION', kind: 'needs-user', answer: { [finding.id]: { ruling: 'accept', quote: 'Accept this condition' } } } : { type: 'DECISION', kind: 'opt-in', answer: [] };
    assert.equal(reviewMachine.step(state, event).state.tag, 'target-check', tag);
  }
});

test('review-target fix candidates are adopted only after unchanged successful verification', () => {
  const initial = wave(); if (!('c' in initial.state)) throw new Error('context');
  const c = { ...initial.state.c, findings: [{ ...finding, round: 1, status: 'accepted' as const }] };
  const state: ReviewState = { tag: 'fix', c, pass: 'main', defects: [], clusters: [{ clusterId: 'C1', findingIds: [finding.id], paths: ['src/a.ts'], verification: [], attemptBudget: 3, parentId: null, dependsOnClusters: [], members: [{ id: finding.id, paths: ['src/a.ts'], dependencies: [], verification: [] }] }] };
  const capture = reviewMachine.step(state, { type: 'FIXES_APPLIED', clusters: [{ clusterId: 'C1' }] });
  assert.deepEqual(capture.effects[0]?.kind === 'check-review-target' && capture.effects[0].allowedPaths, ['src/a.ts']);
  const verify = reviewMachine.step(capture.state, { type: 'REVIEW_TARGET_CHECKED', effectId: capture.effects[0]!.id, manifestPath: 'candidate.json', result: 'expected' });
  assert.equal(verify.state.tag, 'fix-verify'); if (verify.state.tag !== 'fix-verify') return;
  assert.equal(verify.state.c.fixCandidate, 'candidate.json'); assert.equal(verify.state.c.targetManifest, 'prior.json');
  const checked = reviewMachine.step(verify.state, { type: 'VERIFY_DONE', effectId: verify.effects[0]!.id, purpose: 'fix-verify', results: [], fingerprint: {} });
  assert.deepEqual(checked.effects[0]?.kind === 'check-review-target' && [checked.effects[0].manifestPath, checked.effects[0].allowedPaths], ['candidate.json', ['src/a.ts']]);
  const settled = reviewMachine.step(checked.state, { type: 'REVIEW_TARGET_CHECKED', effectId: checked.effects[0]!.id, manifestPath: 'verified.json', result: 'unchanged' });
  assert.equal(settled.state.tag, 'settled'); if (!('c' in settled.state)) return;
  assert.equal(settled.state.c.targetManifest, 'verified.json'); assert.equal(settled.state.c.fixCandidate, undefined);
  const results = [{ exit: 1, command: 'check', logPath: 'red.log' }];
  const red = reviewMachine.step(verify.state, { type: 'VERIFY_DONE', effectId: verify.effects[0]!.id, purpose: 'fix-verify', results, fingerprint: {} });
  const recheck = reviewMachine.step(red.state, { type: 'REVIEW_TARGET_CHECKED', effectId: red.effects[0]!.id, manifestPath: 'still-candidate.json', result: 'unchanged' });
  assert.equal(recheck.state.tag, 'fix-verify'); assert.deepEqual(recheck.effects[0]?.kind === 'verify' && recheck.effects[0].commands, [{ command: 'check' }]);
  const rerun = reviewMachine.step(recheck.state, { type: 'VERIFY_DONE', effectId: recheck.effects[0]!.id, purpose: 'fix-verify', results, fingerprint: {} });
  const retry = reviewMachine.step(rerun.state, { type: 'REVIEW_TARGET_CHECKED', effectId: rerun.effects[0]!.id, manifestPath: 'still-candidate.json', result: 'unchanged' });
  assert.equal(retry.state.tag, 'fix'); if (!('c' in retry.state)) return;
  assert.equal(retry.state.c.fixCandidate, 'candidate.json'); assert.equal(retry.state.c.targetManifest, 'prior.json');
});
