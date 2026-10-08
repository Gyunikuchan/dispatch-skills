import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewMachine, reviewAwait, reviewData, validateReview, type ReviewState } from '../../../skills/dispatch/scripts/machines/review.ts';
import { createFolder, fold } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { JOURNAL_PROTOCOL_REVISION, type Event, type JournalLine, type RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';

const started: RunStartedEvent = { type: 'RUN_STARTED', protocolRevision: JOURNAL_PROTOCOL_REVISION, verb: 'review', argument: '', level: 'low', levelSource: 'explicit', pins: null, fix: false, orchestrator: 'claude', orchestratorModel: null, overrides: {}, repo: {}, config: { 'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } } } };
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

test('change receipt: recorded identity results replay without checking the live target', () => {
  const folder = createFolder(reviewMachine), events: Event[] = [started]; folder.apply(started);
  const apply = (event: Event) => { events.push(event); folder.apply(event); };
  const effect = folder.queue[0]!; apply({ type: 'EFFECT_STARTED', effectId: effect.id, kind: effect.kind, attempt: 1 });
  apply({ type: 'REVIEW_PREPARED', effectId: effect.id, scope: { manifestPath: 'prior.json' }, promptPaths: {} });
  const launched = folder.queue[0]!; apply({ type: 'EFFECT_STARTED', effectId: launched.id, kind: launched.kind, attempt: 1 });
  apply({ type: 'WAVE_STARTED', effectId: launched.id, waveKey: launched.id, attempt: 0, roster: [], native: [], early: [], claimPath: null, inputPath: '', completed: { type: 'WAVE_DONE', effectId: launched.id, round: 1, slots: [{ slot: 'codex[0]', state: 'success' }], findings: [] } } as Event);
  const check = folder.queue[0]!; apply({ type: 'EFFECT_STARTED', effectId: check.id, kind: check.kind, attempt: 1 });
  apply({ type: 'REVIEW_TARGET_CHECKED', effectId: check.id, manifestPath: 'checked.json' });
  const lines: JournalLine[] = events.map(({ type, ...data }, index) => ({ seq: index + 1, v: 1, at: 'now', type, data }));
  assert.deepEqual(fold(reviewMachine, lines).state, folder.state); assert.equal(folder.state.tag, 'settled');
});

for (const tag of ['decide-needs-user', 'decide-opt-in'] as const) test(`review-target guards ${tag} settlement decisions`, () => {
  const initial = wave(); if (!('c' in initial.state)) throw new Error('context');
  const c = { ...initial.state.c, findings: [{ ...finding, round: 1, status: 'needs-user' as const }] };
  const state: ReviewState = tag === 'decide-needs-user' ? { tag, c, ids: [finding.id] } : { tag, c, items: [finding.id] };
  const event: Event = tag === 'decide-needs-user' ? { type: 'DECISION', kind: 'needs-user', answer: { [finding.id]: { ruling: 'accept', quote: 'Accept this condition' } } } : { type: 'DECISION', kind: 'opt-in', answer: [] };
  assert.equal(reviewMachine.step(state, event).state.tag, 'target-check');
});

test('review-target fix candidates are adopted only after unchanged successful verification', () => {
  const initial = wave(); if (!('c' in initial.state)) throw new Error('context');
  const c = { ...initial.state.c, spec: { ...initial.state.c.spec, mode: 'fix' as const }, findings: [{ ...finding, round: 1, status: 'accepted' as const }] };
  const state: ReviewState = { tag: 'fix', c, pass: 'main', defects: [], clusters: [{ clusterId: 'C1', findingIds: [finding.id], paths: ['src/a.ts'], verification: [], attemptBudget: 3, parentId: null, dependsOnClusters: [], members: [{ id: finding.id, paths: ['src/a.ts'], dependencies: [], verification: [] }] }] };
  const capture = reviewMachine.step(state, { type: 'FIXES_APPLIED', clusters: [{ clusterId: 'C1' }] });
  assert.deepEqual(capture.effects[0]?.kind === 'check-review-target' && capture.effects[0].allowedPaths, ['src/a.ts']);
  const verify = reviewMachine.step(capture.state, { type: 'REVIEW_TARGET_CHECKED', effectId: capture.effects[0]!.id, manifestPath: 'candidate.json' });
  assert.equal(verify.state.tag, 'fix-verify'); if (verify.state.tag !== 'fix-verify') return;
  assert.equal(verify.state.c.fixCandidate, 'candidate.json'); assert.equal(verify.state.c.targetManifest, 'prior.json');
  const checked = reviewMachine.step(verify.state, { type: 'VERIFY_DONE', effectId: verify.effects[0]!.id, purpose: 'fix-verify', results: [], fingerprint: {} });
  assert.deepEqual(checked.effects[0]?.kind === 'check-review-target' && [checked.effects[0].manifestPath, checked.effects[0].allowedPaths], ['candidate.json', []]);
  const settled = reviewMachine.step(checked.state, { type: 'REVIEW_TARGET_CHECKED', effectId: checked.effects[0]!.id, manifestPath: 'verified.json' });
  assert.equal(settled.state.tag, 'settled'); if (!('c' in settled.state)) return;
  assert.equal(settled.state.c.targetManifest, 'verified.json'); assert.equal(settled.state.c.fixCandidate, undefined);
  const red = reviewMachine.step(verify.state, { type: 'VERIFY_DONE', effectId: verify.effects[0]!.id, purpose: 'fix-verify', results: [{ exit: 1, command: 'check', logPath: 'red.log' }], fingerprint: {} });
  const retry = reviewMachine.step(red.state, { type: 'REVIEW_TARGET_CHECKED', effectId: red.effects[0]!.id, manifestPath: 'still-candidate.json' });
  assert.equal(retry.state.tag, 'fix'); if (!('c' in retry.state)) return;
  assert.equal(retry.state.c.fixCandidate, 'still-candidate.json'); assert.equal(retry.state.c.targetManifest, 'prior.json');
});
