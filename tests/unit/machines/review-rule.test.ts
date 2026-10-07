import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Event, HostEvent, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { reviewMachine, type ReviewState } from '../../../skills/dispatch/scripts/machines/review.ts';

const CONFIG = {
  'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } },
  phases: { 'code-review': { rounds: { low: 2 }, targets: { low: 1 } } },
};
const started = (over: Partial<RunStartedEvent> = {}): RunStartedEvent => ({
  type: 'RUN_STARTED', verb: 'review', argument: '', level: 'low', levelSource: 'explicit', pins: null, fix: true,
  orchestrator: 'claude', orchestratorModel: null, overrides: {}, config: CONFIG, repo: {}, ...over,
});
const finding = (id: string, over: Record<string, unknown> = {}) => ({
  id, severity: 'MUST', category: 'correctness', locus: 'src/a.ts:L3', defect: 'null deref', requiredChange: 'guard it', sources: ['codex[0]'], scope: 'in', ...over,
});
const prepared = (n: number): Event => ({ type: 'REVIEW_PREPARED', effectId: `review.prepare-review.${n}`, scope: {}, promptPaths: { 'codex[0]': 'p0' } });
const waveDone = (n: number, findings: unknown[]): Event => ({ type: 'WAVE_DONE', effectId: `review.wave.${n}`, round: n, slots: [{ slot: 'codex[0]', state: 'success' }], findings: findings as never });
const rulings = (map: Record<string, unknown>): HostEvent => ({ type: 'RULINGS', rulings: map as never });

function drive(events: readonly Event[], from: ReviewState = reviewMachine.initial()): ReviewState {
  return events.reduce((state, event) => reviewMachine.step(state, event).state, from);
}

test('review-intent-needs-user: an intent finding ruled anything but needs-user fails validate with one line', () => {
  const state = drive([started(), prepared(1), waveDone(1, [finding('R1-F001', { category: 'intent' })])]);
  const error = reviewMachine.validate?.(state, rulings({ 'R1-F001': { ruling: 'accept' } }));
  assert.equal(error, 'event.rulings.R1-F001: intent finding must be ruled needs-user, got accept');
  assert.doesNotMatch(error ?? '', /\n/);
  assert.equal(reviewMachine.validate?.(state, rulings({ 'R1-F001': { ruling: 'needs-user' } })), null);
  assert.match(reviewMachine.validate?.(state, rulings({})) ?? '', /missing ruling for R1-F001/);
});

test('review-intent-needs-user: needs-user → decide:needs-user, then the user ruling is recorded and the review settles', () => {
  const state = drive([started({ fix: false }), prepared(1), waveDone(1, [finding('R1-F001', { category: 'intent' })]), rulings({ 'R1-F001': { ruling: 'needs-user' } })]);
  assert.equal(state.tag, 'decide-needs-user');
  const frame = reviewMachine.project(state);
  assert.equal(frame.data['kind'], 'needs-user');
  assert.equal(reviewMachine.awaitOf(state), 'decide');
  assert.match(reviewMachine.validate?.(state, { type: 'DECISION', kind: 'needs-user', answer: {} }) ?? '', /R1-F001/);
  const done = drive([{ type: 'DECISION', kind: 'needs-user', answer: { 'R1-F001': { ruling: 'reject', quote: 'keep the current API' } } }], state);
  assert.equal(done.tag, 'settled');
  assert.equal('c' in done && done.c.findings[0]?.resolution, 'user: keep the current API');
  assert.equal('c' in done && done.c.findings[0]?.status, 'rejected');
});

test('review-needs-user-accept: a user-accepted finding joins the fix batch', () => {
  const state = drive([started(), prepared(1), waveDone(1, [finding('R1-F001', { category: 'intent' })]), rulings({ 'R1-F001': { ruling: 'needs-user' } })]);
  assert.match(reviewMachine.validate?.(state, { type: 'DECISION', kind: 'needs-user', answer: { 'R1-F001': 'yes' } }) ?? '', /ruling: accept/);
  const fix = drive([{ type: 'DECISION', kind: 'needs-user', answer: { 'R1-F001': { ruling: 'accept', quote: 'yes', fix: { affectedPaths: ['src/a.ts'], dependsOn: [], verification: [] } } } }], state);
  assert.equal(fix.tag, 'fix');
  assert.deepEqual(fix.tag === 'fix' && fix.clusters.flatMap((cluster) => cluster.findingIds), ['R1-F001']);
});

test('review-recorded-decision: a finding contradicting a recorded decision is host-ruled reject and recorded with its reason', () => {
  const state = drive([started({ fix: false }), prepared(1), waveDone(1, [finding('R1-F001', { severity: 'CONSIDER' })]),
    rulings({ 'R1-F001': { ruling: 'reject', reason: 'recorded decision D2; no new evidence' } })]);
  assert.equal(state.tag, 'settled');
  const recorded = 'c' in state ? state.c.findings[0] : undefined;
  assert.deepEqual([recorded?.status, recorded?.resolution], ['rejected', 'recorded decision D2; no new evidence']);
});

test('regression → decide:escalation → escalated on stop', () => {
  const fix = drive([started(), prepared(1), waveDone(1, [finding('R1-F001')]), rulings({ 'R1-F001': { ruling: 'accept' } })]);
  assert.equal(fix.tag, 'fix');
  const clusterId = fix.tag === 'fix' ? fix.clusters[0]?.clusterId : '';
  const round2 = drive([
    { type: 'FIXES_APPLIED', clusters: [{ clusterId, status: 'applied' }] },
    { type: 'VERIFY_DONE', effectId: 'review.verify.1', purpose: 'fix-verify', results: [], fingerprint: {} },
  ], fix);
  assert.equal(round2.tag, 'prepare');
  const halted = drive([prepared(2), waveDone(2, [finding('R2-F001')])], round2);
  assert.equal(halted.tag, 'decide-escalation');
  assert.deepEqual(reviewMachine.project(halted).data['items'], ['R1-F001']);
  assert.match(reviewMachine.validate?.(halted, { type: 'DECISION', kind: 'escalation', answer: 'go' }) ?? '', /only "stop"/);
  const escalated = drive([{ type: 'DECISION', kind: 'escalation', answer: 'stop' }], halted);
  assert.equal(escalated.tag, 'escalated');
  assert.equal(reviewMachine.project(escalated).data['outcome'], 'stopped');
});

test('deadlock: a pending rejection re-raised twice escalates', () => {
  const reject = (id: string) => rulings({ [id]: { ruling: 'reject' } });
  const config = { ...CONFIG, phases: { 'code-review': { rounds: { low: 4 }, targets: { low: 1 } } } };
  const state = drive([started({ config }), prepared(1), waveDone(1, [finding('R1-F001')]), reject('R1-F001'),
    prepared(2), waveDone(2, [finding('R2-F001')]), reject('R2-F001'), prepared(3), waveDone(3, [finding('R3-F001')])]);
  assert.equal(state.tag, 'decide-escalation');
  assert.equal(state.tag === 'decide-escalation' && state.escalation.kind, 'deadlock');
});
