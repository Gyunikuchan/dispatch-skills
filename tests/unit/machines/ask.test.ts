import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Event, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { askMachine } from '../../../skills/dispatch/scripts/machines/ask.ts';
import { play } from '../../helpers/play.ts';

const started: RunStartedEvent = {
  type: 'RUN_STARTED', verb: 'ask', argument: 'Where is the lock released?', level: 'low', levelSource: 'explicit', pins: null, fix: false,
  orchestrator: 'claude', orchestratorModel: null, overrides: {}, repo: {},
  config: { 'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } } },
};
const prepared: Event = { type: 'REVIEW_PREPARED', effectId: 'ask.prepare-review.1', scope: {}, promptPaths: { 'codex[0]': 'p0' } };

test('ask: preparing → wave → done { claims, failed }', () => {
  const effect = askMachine.step(askMachine.initial(), started).effects[0];
  assert.deepEqual(effect?.kind === 'prepare-review' && [effect.id, effect.review['kind'], effect.review['target']], ['ask.prepare-review.1', 'ask', 'Where is the lock released?']);
  const frames = play(askMachine, [started, prepared, { type: 'WAVE_DONE', effectId: 'ask.wave.1', round: 1, slots: [{ slot: 'codex[0]', state: 'success', claim: 'core/lock.ts:L40' }], findings: [] }]);
  assert.deepEqual(frames.map((frame) => frame.at), ['ask › preparing', 'ask › wave', 'ask › done']);
  assert.deepEqual(frames[2]?.data, { outcome: 'complete', summary: '1 claim(s), 0 failed slot(s)', claims: [{ text: 'core/lock.ts:L40', source: 'codex[0]' }], failed: [], coverage: 'unknown', transport: 'success', captures: [] });
});

test('ask: native slots go through the native frame and a second wave', () => {
  const descriptor = { sourceKey: 'claude[0]', substitutesFor: null, outputPath: 'o.md' };
  const frames = play(askMachine, [
    started, prepared,
    { type: 'WAVE_DONE', effectId: 'ask.wave.1', round: 1, slots: [{ slot: 'codex[0]', state: 'failed', cls: 'quota' }, { slot: 'claude[0]', state: 'native', descriptor }], findings: [] },
    { type: 'NATIVE_RESULTS', slots: [{ slot: 'claude[0]', outputPath: 'o.md', mapping: { launcherModel: 'host-default' } }] },
    { type: 'WAVE_DONE', effectId: 'ask.wave.2', round: 1, slots: [{ slot: 'claude[0]', state: 'native', claim: 'answer' }], findings: [] },
  ]);
  assert.deepEqual(frames.map((frame) => [frame.at, frame.await]), [
    ['ask › preparing', 'done'], ['ask › wave', 'done'], ['ask › native', 'native'], ['ask › wave', 'done'], ['ask › done', 'done'],
  ]);
  assert.deepEqual(frames[4]?.data['claims'], [{ text: 'answer', source: 'claude[0]' }]);
  assert.deepEqual(frames[4]?.data['failed'], [{ slot: 'codex[0]', cls: 'quota' }]);
});

test('ask: a failed effect ends failed', () => {
  const frame = play(askMachine, [started, { type: 'EFFECT_FAILED', effectId: 'ask.prepare-review.1', cls: 'io', detail: 'boom' }]).at(-1);
  assert.deepEqual(frame?.data, { outcome: 'failed', summary: 'io: boom' });
});

test('ask: zero resolved reviewers fails instead of completing', () => {
  const frames = play(askMachine, [{ ...started, config: { 'read-delegates': {} } }]);
  assert.equal(frames.at(-1)?.at, 'ask › failed');
});


test('rewrite SC3 ask consumes started and finished waves and labels coverage unknown', () => {
  let r = askMachine.step(askMachine.initial(), started); r = askMachine.step(r.state, prepared);
  r = askMachine.step(r.state, { type: 'WAVE_STARTED', effectId: r.effects[0]!.id, waveKey: 'ask.wave.1', attempt: 1, roster: [], native: [], early: [], claimPath: 'claim', inputPath: 'input' });
  assert.equal(r.effects[0]?.kind, 'wave-finish');
  r = askMachine.step(r.state, { type: 'WAVE_DONE', effectId: r.effects[0]!.id, round: 1, slots: [{ slot: 'codex[0]', state: 'success', claim: 'Investigating the issue', outputPath: 'raw.log', records: ['diagnostic'] }], findings: [] });
  const data = askMachine.project(r.state).data; assert.equal(data['coverage'], 'unknown'); assert.equal(data['transport'], 'success'); assert.deepEqual(data['captures'], ['raw.log']);
});

test('emits failed outcome when all slots fail', () => {
  const frames = play(askMachine, [
    started, prepared,
    { type: 'WAVE_DONE', effectId: 'ask.wave.1', round: 1, slots: [{ slot: 'codex[0]', state: 'failed', cls: 'quota' }], findings: [] },
  ]);
  assert.equal(frames.at(-1)?.at, 'ask › done');
  assert.equal(frames.at(-1)?.data['outcome'], 'failed');
  assert.equal(frames.at(-1)?.data['transport'], 'failed');
  assert.equal(frames.at(-1)?.data['summary'], '0 claim(s), 1 failed slot(s)');
});
