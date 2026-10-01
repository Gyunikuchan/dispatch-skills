import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Event, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { planMachine } from '../../../skills/dispatch/scripts/machines/plan.ts';
import { rootMachine } from '../../../skills/dispatch/scripts/machines/root.ts';
import { play } from '../../helpers/play.ts';

const config = (rounds: number) => ({
  'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } },
  phases: { 'plan-review': { rounds: { low: rounds }, targets: { low: 1 } } },
});
const started = (rounds = 1): RunStartedEvent => ({
  type: 'RUN_STARTED', verb: 'plan', argument: 'Add a cache', level: 'low', levelSource: 'explicit', pins: null, fix: false,
  orchestrator: 'claude', orchestratorModel: null, overrides: {}, config: config(rounds), repo: {},
});
const authored: Event = { type: 'AUTHORED', path: 'docs/add-a-cache.plan.md' };
const parsed = (n: number, defects: unknown[]): Event => ({ type: 'ARTIFACT_PARSED', effectId: `plan.parse-artifact.${n}`, kind: 'plan', hash: 'h', parsed: {}, defects: defects as never });

test('plan: author → parse → defects re-enter author → review → done complete', () => {
  const defect = { code: 'placeholder', message: 'Plan contains a prose placeholder.' };
  const frames = play(planMachine, [
    started(), authored, parsed(1, [defect]), authored, parsed(2, []),
    { type: 'REVIEW_PREPARED', effectId: 'plan.review.prepare-review.1', scope: {}, promptPaths: { 'codex[0]': 'p0' } },
    { type: 'WAVE_DONE', effectId: 'plan.review.wave.1', round: 1, slots: [{ slot: 'codex[0]', state: 'success' }], findings: [] },
  ]);
  assert.deepEqual(frames.map((frame) => [frame.at, frame.await]), [
    ['plan › author', 'author'], ['plan › parsing', 'done'], ['plan › author', 'author'], ['plan › parsing', 'done'],
    ['plan › review › prepare', 'done'], ['plan › review › wave', 'done'], ['plan › complete', 'done'],
  ]);
  assert.deepEqual(frames[0]?.data, { artifact: 'plan', path: 'add-a-cache.plan.md', template: 'references/templates/plan.md' });
  assert.deepEqual(frames[2]?.data['defects'], [defect]);
  assert.equal(frames[6]?.data['outcome'], 'complete');
});

test('plan: review skipped (rounds 0) → done complete with the skip summary', () => {
  const frame = play(rootMachine, [started(0), authored, { ...parsed(1, []) }, { type: 'HANDOFF_DONE', effectId: 'root.handoff.1', destination: '/t', warning: null }]).at(-1);
  assert.deepEqual(frame?.data, { outcome: 'complete', summary: 'plan review skipped (rounds 0)', handoff: '/t' });
});


test('standalone plan revision diagnostic describes actual support', () => {
  const state = planMachine.step(planMachine.initial(), started()).state;
  const error = planMachine.validate!(state, { type: 'REVISE', artifact: 'plan', reason: 'change', evidence: 'observed' });
  assert.match(error ?? '', /standalone/);
});
