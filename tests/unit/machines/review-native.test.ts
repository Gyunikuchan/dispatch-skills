import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effect, Event, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { reviewMachine, type ReviewState } from '../../../skills/dispatch/scripts/machines/review.ts';
import { play } from '../../helpers/play.ts';

const CONFIG = {
  'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] }, claude: { targets: [{ low: { model: 'opus' } }] } },
  phases: { 'code-review': { rounds: { low: 1 }, targets: { low: 2 } } },
};
const started: RunStartedEvent = {
  type: 'RUN_STARTED', verb: 'review', argument: '', level: 'low', levelSource: 'explicit', pins: null, fix: false,
  orchestrator: 'claude', orchestratorModel: null, overrides: {}, config: CONFIG, repo: {},
};
const finding = (id: string, source: string) => ({ id, severity: 'MUST', category: 'correctness', locus: `src/${source}.ts:L1`, defect: 'd', requiredChange: 'r', sources: [source], scope: 'in' });
const descriptor = { sourceKey: 'claude[0]#fallback', substitutesFor: 'claude[0]', outputPath: 'run/claude.native.md', promptPath: 'p1', agentType: 'explore' };
const events: Event[] = [
  started,
  { type: 'REVIEW_PREPARED', effectId: 'review.prepare-review.1', scope: {}, promptPaths: { 'codex[0]': 'p0', 'claude[0]': 'p1' } },
  { type: 'WAVE_DONE', effectId: 'review.wave.1', round: 1, slots: [{ slot: 'codex[0]', state: 'success' }, { slot: 'claude[0]', state: 'native', descriptor }], findings: [finding('R1-F001', 'codex[0]')] },
  { type: 'NATIVE_RESULTS', slots: [{ slot: 'claude[0]', sourceKey: 'claude[0]#fallback', outputPath: 'run/claude.native.md' }] },
  { type: 'WAVE_DONE', effectId: 'review.wave.2', round: 1, slots: [{ slot: 'claude[0]', state: 'native' }], findings: [finding('R1-F001', 'claude[0]')] },
];

test('native frame { round, slots } → NATIVE_RESULTS → native wave → merged findings → rule', () => {
  const frames = play(reviewMachine, events);
  assert.deepEqual(frames.map((frame) => frame.at), ['review › prepare', 'review › wave', 'review › native', 'review › wave', 'review › rule']);
  assert.equal(frames[2]?.await, 'native');
  assert.deepEqual(frames[2]?.data, { round: 1, slots: [descriptor] });
  assert.deepEqual((frames[4]?.data['findings'] as { id: string; sources: string[] }[]).map((entry) => [entry.id, entry.sources[0]]),
    [['R1-F001', 'codex[0]'], ['R1-F002', 'claude[0]']]);
});

test('the native wave roster is exactly the native slots, each carrying its capture', () => {
  let state: ReviewState = reviewMachine.initial();
  let effects: readonly Effect[] = [];
  for (const event of events.slice(0, 4)) ({ state, effects } = reviewMachine.step(state, event));
  const wave = effects[0];
  assert.equal(wave?.kind === 'wave' && wave.id, 'review.wave.2');
  assert.deepEqual(wave?.kind === 'wave' && wave.roster.map((row) => [row['slot'], row['native'], row['capture']]),
    [['claude[0]', true, { slot: 'claude[0]', sourceKey: 'claude[0]#fallback', outputPath: 'run/claude.native.md' }]]);
  const rounds = 'c' in state ? state.c.rounds : [];
  assert.equal(rounds.length, 0);
  assert.match(reviewMachine.validate?.(reviewMachine.step(reviewMachine.initial(), started).state, { type: 'NATIVE_RESULTS', slots: [] }) ?? 'null', /null/);
});

test('NATIVE_RESULTS entries must name slot and outputPath', () => {
  let state: ReviewState = reviewMachine.initial();
  for (const event of events.slice(0, 3)) state = reviewMachine.step(state, event).state;
  assert.equal(reviewMachine.validate?.(state, { type: 'NATIVE_RESULTS', slots: [{ slot: 'claude[0]' }] }), 'event.slots[0]: expected { slot, outputPath, sourceKey? }');
});
