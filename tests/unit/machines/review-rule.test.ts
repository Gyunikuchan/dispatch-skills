import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Event, HostEvent, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { resolutionRounds, reviewMachine, type ReviewState } from '../../../skills/dispatch/scripts/machines/review.ts';

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

test('ruling-reason: reject and downgrade require a nonblank string before consumption', () => {
  const state = drive([started({ fix: false }), prepared(1), waveDone(1, [finding('R1-F001', { severity: 'CONSIDER' })])]);
  for (const ruling of ['reject', 'downgrade']) {
    for (const reason of [undefined, '', '  ', 42]) {
      const event = rulings({ 'R1-F001': { ruling, reason } });
      assert.match(reviewMachine.validate?.(state, event) ?? '', /reason.*nonblank/);
      assert.deepEqual(reviewMachine.step(state, event).state, state);
    }
    const event = rulings({ 'R1-F001': { ruling, reason: 'Evidence in D2', severity: 'CONSIDER' } });
    assert.equal(reviewMachine.validate?.(state, event), null);
    const next = reviewMachine.step(state, event).state;
    assert.equal('c' in next && next.c.findings[0]?.resolution, 'Evidence in D2');
    assert.deepEqual(drive([event], state), next);
  }
});

function drive(events: readonly Event[], from: ReviewState = reviewMachine.initial()): ReviewState {
  return events.reduce((state, event) => reviewMachine.step(state, event).state, from);
}

test('review-intent-needs-user: an intent finding ruled anything but needs-user fails validate with one line', () => {
  const state = drive([started(), prepared(1), waveDone(1, [finding('R1-F001', { category: 'intent' })])]);
  const error = reviewMachine.validate?.(state, rulings({ 'R1-F001': { ruling: 'accept' } }));
  assert.equal(error, "event.rulings.R1-F001.ruling: expected needs-user, or accept|reject with the user's quote, for an intent finding");
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
  const reject = (id: string) => rulings({ [id]: { ruling: 'reject', reason: 'intentional behavior; retained scenario evidence' } });
  const config = { ...CONFIG, phases: { 'code-review': { rounds: { low: 4 }, targets: { low: 1 } } } };
  const state = drive([started({ config }), prepared(1), waveDone(1, [finding('R1-F001')]), reject('R1-F001'),
    prepared(2), waveDone(2, [finding('R2-F001')]), reject('R2-F001'), prepared(3), waveDone(3, [finding('R3-F001')])]);
  assert.equal(state.tag, 'decide-escalation');
  assert.equal(state.tag === 'decide-escalation' && state.escalation.kind, 'deadlock');
});

// SECTION: Unknown tag recovery

const recovered = (id: string, over: Record<string, unknown> = {}) => finding(id, { category: 'uncategorized', originalTag: 'robustness', ...over });
const known = (id: string) => finding(id, { locus: 'src/b.ts:L40', defect: 'quadratic scan over rows', requiredChange: 'index the lookup' });

test('SC5 rule frame shows recovered original tag', () => {
  const state = drive([started(), prepared(1), waveDone(1, [recovered('R1-F001'), known('R1-F002')])]);
  assert.equal(state.tag, 'rule');
  const findings = reviewMachine.project(state).data['findings'] as Record<string, unknown>[];
  assert.deepEqual(findings.map((item) => [item['id'], item['category'], item['originalTag'] ?? null]), [
    ['R1-F001', 'uncategorized', 'robustness'], ['R1-F002', 'correctness', null],
  ]);
  assert.ok(!('originalTag' in (findings[1] ?? {})));
});

test('SC5 uncategorized finding takes an ordinary ruling', () => {
  const state = drive([started({ fix: false }), prepared(1), waveDone(1, [recovered('R1-F001', { originalTag: 'Intent' })])]);
  const event = rulings({ 'R1-F001': { ruling: 'accept' } });
  assert.equal(reviewMachine.validate?.(state, event), null);
  const next = reviewMachine.step(state, event).state;
  const ruled = 'c' in next ? next.c.findings[0] : undefined;
  assert.deepEqual([ruled?.status, ruled?.category, ruled?.originalTag], ['accepted', 'uncategorized', 'Intent']);
});

test('SC5 resolution entries keep original tag', () => {
  const state = drive([started({ fix: false }), prepared(1), waveDone(1, [recovered('R1-F001'), known('R1-F002')]),
    rulings({ 'R1-F001': { ruling: 'accept' }, 'R1-F002': { ruling: 'accept' } })]);
  assert.ok('c' in state);
  const entries = resolutionRounds(state.c)[0]?.entries ?? [];
  assert.deepEqual(entries.map((entry) => [entry.id, entry.originalTag ?? null]), [['R1-F001', 'robustness'], ['R1-F002', null]]);
  assert.ok(!('originalTag' in (entries[1] ?? {})));
});

test('intent finding ruled with a user quote', () => {
  const ruled = (fix: boolean) => drive([started({ fix }), prepared(1), waveDone(1, [finding('R1-F001', { category: 'intent' })])]);
  const report = ruled(false);
  for (const quote of [undefined, '', '  ']) {
    const event = rulings({ 'R1-F001': { ruling: 'reject', reason: 'user declined', quote } });
    assert.match(reviewMachine.validate?.(report, event) ?? '', /^event\.rulings\.R1-F001\.ruling: expected /);
    assert.deepEqual(reviewMachine.step(report, event).state, report);
  }
  const downgrade = rulings({ 'R1-F001': { ruling: 'downgrade', reason: 'minor', severity: 'CONSIDER', quote: 'minor' } });
  assert.match(reviewMachine.validate?.(report, downgrade) ?? '', /expected /);
  const reject = rulings({ 'R1-F001': { ruling: 'reject', quote: 'keep the current API' } });
  assert.equal(reviewMachine.validate?.(report, reject), null);
  const settled = drive([reject], report);
  assert.equal(settled.tag, 'settled');
  const rejected = 'c' in settled ? settled.c.findings[0] : undefined;
  assert.deepEqual([rejected?.status, rejected?.resolution], ['rejected', 'user: keep the current API']);
  const accept = rulings({ 'R1-F001': { ruling: 'accept', quote: 'yes, rename it', fix: { affectedPaths: ['src/a.ts'], dependsOn: [], verification: [] } } });
  const fix = drive([accept], ruled(true));
  assert.equal(fix.tag, 'fix');
  assert.deepEqual(fix.tag === 'fix' && fix.clusters.flatMap((cluster) => cluster.findingIds), ['R1-F001']);
  assert.equal('c' in fix && fix.c.findings[0]?.resolution, 'user: yes, rename it');
});
