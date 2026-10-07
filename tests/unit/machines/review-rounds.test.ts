import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effect, Event, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { reviewMachine, resolutionRounds, type ReviewState } from '../../../skills/dispatch/scripts/machines/review.ts';
import { renderResolutionSection } from '../../../skills/dispatch/scripts/domain/render.ts';
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
  assert.equal(wave?.kind, 'wave-start');
  assert.deepEqual(wave?.kind === 'wave-start' && wave.roster.map((slot) => [slot['slot'], slot['promptPath'], slot['review']]), [['codex[0]', 'p0', 'code'], ['agy[0]', 'p1', 'code']]);
});

test('disputes-only round when nothing was fixed; affinity carries the rejection to its source slot', () => {
  const events = [started({ fix: true }), prepared(1), waveDone(1, [finding('R1-F001')]), { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'reject', reason: 'by design' } } } as Event];
  const { state, effects } = drive(events);
  assert.equal(state.tag, 'prepare');
  const next = effects[0];
  assert.equal(next?.kind === 'prepare-review' && next.id, 'review.prepare-review.2');
  assert.deepEqual(next?.kind === 'prepare-review' && next.scope, {
    scope: 'disputes-only', affectedPaths: [], carried: [{ id: 'R1-F001', slot: 'agy[0]', locus: 'src/a.ts:L3', defect: 'defect R1-F001', reason: 'by design' }],
  });
});

test('accept-by-omission closes a carried rejection the reviewer did not re-raise', () => {
  const events = [started({ fix: true }), prepared(1), waveDone(1, [finding('R1-F001')]), { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'reject', reason: 'intentional behavior; retained scenario evidence' } } } as Event, prepared(2), waveDone(2, [])];
  const { state } = drive(events);
  assert.equal(state.tag, 'settled');
  assert.equal('c' in state && state.c.findings.find((entry) => entry.id === 'R1-F001')?.status, 'closed-by-reviewer');
  assert.deepEqual(state.tag === 'settled' && state.exit.rejections, ['R1-F001']);
});

test('orchestrator closure below threshold at the cap', () => {
  const should = finding('R1-F001', { severity: 'SHOULD' });
  const events = [
    started({ fix: true }), prepared(1), waveDone(1, [should]), { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'reject', reason: 'intentional behavior; retained scenario evidence' } } } as Event,
    prepared(2), waveDone(2, [{ ...should, id: 'R2-F001' }]), { type: 'RULINGS', rulings: { 'R2-F001': { ruling: 'reject', reason: 'intentional behavior; retained scenario evidence' } } } as Event,
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

for (const coverage of ['failed', 'missing', 'clean'] as const) test(`rewrite SC1 responsible reviewer ${coverage} controls omission`, () => {
  const events = [started({ fix: true }), prepared(1), waveDone(1, [finding('R1-F001')]),
    { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'reject', reason: 'by design' } } } as Event, prepared(2),
    { ...waveDone(2, []), slots: coverage === 'clean' ? rows : [rows[0]!, ...(coverage === 'failed' ? [{ slot: 'agy[0]', state: 'failed', reason: 'timeout' }] : [])] } as Event];
  const { state } = drive(events);
  assert.equal(state.tag, coverage === 'clean' ? 'settled' : 'failed');
  assert.equal('c' in state && state.c.findings[0]?.status, coverage === 'clean' ? 'closed-by-reviewer' : 'pending-rejection');
});

test('rewrite SC1 all-failed review reports coverage failure', () => {
  const { state } = drive([started(), prepared(1), { ...waveDone(1, []), slots: rows.map((row) => ({ ...row, state: 'failed' })) } as Event]);
  assert.equal(state.tag, 'failed');
  assert.match(state.tag === 'failed' ? state.detail : '', /reviewer-coverage/);
});

test('reserve-substitution: reviewers list reflects reserve delegate and failed reflects primary failure', () => {
  const reserveRows = [
    { slot: 'claude[0]', state: 'reserve', by: 'codex[0]', model: 'gpt-5', record: 'claude[0] → codex[0]: api-error: 400', reason: 'api-error: 400' },
  ];
  const { state } = drive([
    started(),
    prepared(1),
    { type: 'WAVE_DONE', effectId: 'review.wave.1', round: 1, slots: reserveRows, findings: [finding('R1-F001', { sources: ['codex[0]'] })] } as Event,
  ]);
  assert.equal(state.tag, 'rule');
  if (!('c' in state)) throw new Error('review context missing');
  const rounds = resolutionRounds(state.c);
  assert.equal(rounds.length, 1);
  assert.deepEqual(rounds[0]?.reviewers, [{ slot: 'codex[0]', model: 'gpt-5' }]);
  assert.deepEqual(rounds[0]?.failed, [{ slot: 'claude[0]', reason: 'api-error: 400' }]);
  const rendered = renderResolutionSection(rounds);
  assert.match(rendered, /- Reviewers: codex\[0\] gpt-5/);
  assert.match(rendered, /- Failed: claude\[0\] \(api-error: 400\)/);
});

test('reviewer-metadata-preservation: model and effort are preserved from wave and roster', () => {
  const metaRows = [
    { slot: 'codex[0]', state: 'success', model: 'gpt-5', effort: 'high' },
  ];
  const { state } = drive([
    started(),
    prepared(1),
    { type: 'WAVE_DONE', effectId: 'review.wave.1', round: 1, slots: metaRows, findings: [] } as Event,
  ]);
  assert.equal(state.tag, 'settled');
  if (!('c' in state)) throw new Error('review context missing');
  const rounds = resolutionRounds(state.c);
  assert.deepEqual(rounds[0]?.reviewers, [{ slot: 'codex[0]', model: 'gpt-5', effort: 'high' }]);
  const rendered = renderResolutionSection(rounds);
  assert.match(rendered, /- Reviewers: codex\[0\] gpt-5 \(high\)/);
});
