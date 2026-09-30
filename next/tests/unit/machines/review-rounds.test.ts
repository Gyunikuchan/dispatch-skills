import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effect, Event, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { reviewMachine, type ReviewState } from '../../../skills/dispatch/scripts/machines/review.ts';
import { play } from '../../helpers/play.ts';

const CONFIG = {
  'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] }, agy: { targets: [{ low: { model: 'gemini' } }] } },
  phases: { 'code-review': { rounds: { low: 2 }, targets: { low: 2 } } },
};
const started = (over: Partial<RunStartedEvent> = {}): RunStartedEvent => ({
  type: 'RUN_STARTED', verb: 'review', argument: 'main..HEAD', level: 'low', levelSource: 'explicit', pins: null, fix: false,
  orchestrator: 'claude', orchestratorModel: null, overrides: {}, config: CONFIG, repo: {}, ...over,
});
const finding = (id: string, over: Record<string, unknown> = {}) => ({
  id, severity: 'MUST', category: 'correctness', locus: 'src/a.ts:L3', defect: `defect ${id}`, requiredChange: 'fix it', sources: ['agy[0]'], scope: 'in', ...over,
});
const prepared = (n: number): Event => ({ type: 'REVIEW_PREPARED', effectId: `review.prepare-review.${n}`, scope: {}, promptPaths: { 'codex[0]': 'p0', 'agy[0]': 'p1' } });
const rows = [{ slot: 'codex[0]', state: 'success' }, { slot: 'agy[0]', state: 'success' }];
const waveDone = (n: number, findings: unknown[]): Event => ({ type: 'WAVE_DONE', effectId: `review.wave.${n}`, round: n, slots: rows, findings: findings as never });

function drive(events: readonly Event[]): { state: ReviewState; effects: readonly Effect[] } {
  let state = reviewMachine.initial();
  let effects: readonly Effect[] = [];
  for (const event of events) ({ state, effects } = reviewMachine.step(state, event));
  return { state, effects };
}

test('prepare → wave → rule: frames per transition', () => {
  const frames = play(reviewMachine, [started(), prepared(1), waveDone(1, [finding('R1-F001')])]);
  assert.deepEqual(frames.map((frame) => [frame.at, frame.await]), [['review › prepare', 'done'], ['review › wave', 'done'], ['review › rule', 'rule']]);
  assert.deepEqual((frames[2]?.data['findings'] as { id: string }[]).map((entry) => entry.id), ['R1-F001']);
  const { effects } = drive([started(), prepared(1)]);
  const wave = effects[0];
  assert.equal(wave?.kind, 'wave');
  assert.deepEqual(wave?.kind === 'wave' && wave.roster.map((slot) => [slot['slot'], slot['promptPath'], slot['review']]), [['codex[0]', 'p0', 'code'], ['agy[0]', 'p1', 'code']]);
});

test('disputes-only round when nothing was fixed; affinity carries the rejection to its source slot', () => {
  const events = [started({ fix: true }), prepared(1), waveDone(1, [finding('R1-F001')]), { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'reject', reason: 'by design' } } } as Event];
  const { state, effects } = drive(events);
  assert.equal(state.tag, 'prepare');
  const next = effects[0];
  assert.equal(next?.kind === 'prepare-review' && next.id, 'review.prepare-review.2');
  assert.deepEqual(next?.kind === 'prepare-review' && next.scope, {
    scope: 'disputes-only', carried: [{ id: 'R1-F001', slot: 'agy[0]', locus: 'src/a.ts:L3', defect: 'defect R1-F001', reason: 'by design' }],
  });
});

test('accept-by-omission closes a carried rejection the reviewer did not re-raise', () => {
  const events = [started({ fix: true }), prepared(1), waveDone(1, [finding('R1-F001')]), { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'reject' } } } as Event, prepared(2), waveDone(2, [])];
  const { state } = drive(events);
  assert.equal(state.tag, 'settled');
  assert.equal('c' in state && state.c.findings.find((entry) => entry.id === 'R1-F001')?.status, 'closed-by-reviewer');
  assert.deepEqual(state.tag === 'settled' && state.exit.rejections, ['R1-F001']);
});

test('orchestrator closure below threshold at the cap', () => {
  const should = finding('R1-F001', { severity: 'SHOULD' });
  const events = [
    started({ fix: true }), prepared(1), waveDone(1, [should]), { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'reject' } } } as Event,
    prepared(2), waveDone(2, [{ ...should, id: 'R2-F001' }]), { type: 'RULINGS', rulings: { 'R2-F001': { ruling: 'reject' } } } as Event,
  ];
  const { state } = drive(events);
  assert.equal(state.tag, 'settled');
  const statuses = 'c' in state ? state.c.findings.map((entry) => [entry.id, entry.status]) : [];
  assert.deepEqual(statuses, [['R1-F001', 'superseded'], ['R2-F001', 'closed-by-orchestrator']]);
});

test('cap = 0 → skipped with no effect', () => {
  const config = { ...CONFIG, phases: { 'code-review': { rounds: { low: 0 }, targets: { low: 2 } } } };
  const result = reviewMachine.step(reviewMachine.initial(), started({ config }));
  assert.equal(result.state.tag, 'skipped');
  assert.deepEqual(result.effects, []);
  assert.deepEqual(reviewMachine.project(result.state).data, { outcome: 'skipped', summary: 'review skipped (rounds 0)' });
});

test('an active review phase with zero resolved reviewers fails; rounds zero still skips', () => {
  const none = { ...CONFIG, 'read-delegates': {} };
  assert.equal(play(reviewMachine, [started({ config: none })]).at(-1)?.at, 'review › failed');
  const skip = { ...none, phases: { 'code-review': { rounds: { low: 0 }, targets: { low: 1 } } } };
  assert.equal(play(reviewMachine, [started({ config: skip })]).at(-1)?.at, 'review › skipped');
});
