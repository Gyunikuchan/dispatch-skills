import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effect, Event, RunStartedEvent, Verb } from '../../../skills/dispatch/scripts/core/types.ts';
import { inferKind, rootMachine, type RootState } from '../../../skills/dispatch/scripts/machines/root.ts';
import { play } from '../../helpers/play.ts';

const CONFIG = {
  'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } },
  phases: { 'code-review': { rounds: { low: 1 }, targets: { low: 1 } }, 'plan-review': { rounds: { low: 1 }, targets: { low: 1 } } },
};
const started = (verb: Verb, over: Partial<RunStartedEvent> = {}): RunStartedEvent => ({
  type: 'RUN_STARTED', verb, argument: 'src/a.ts', level: 'low', levelSource: 'explicit', pins: null, fix: false,
  orchestrator: 'claude', orchestratorModel: null, overrides: {}, config: CONFIG, repo: {}, ...over,
});

function drive(events: readonly Event[]): { state: RootState; effects: Effect[] } {
  let state = rootMachine.initial();
  const effects: Effect[] = [];
  for (const event of events) { const result = rootMachine.step(state, event); state = result.state; effects.push(...result.effects); }
  return { state, effects };
}
const handoffDone = (warning: string | null = null): Event => ({ type: 'HANDOFF_DONE', effectId: 'root.handoff.1', destination: '/tmp/dispatch-skills/s', warning });

test('root selects each verb', () => {
  assert.equal(rootMachine.project(drive([started('ask')]).state).at, 'ask › preparing');
  assert.deepEqual(play(rootMachine, [started('plan')]).map((frame) => [frame.at, frame.await]), [['plan › author', 'author']]);
  const review = drive([started('review')]);
  assert.equal(rootMachine.project(review.state).at, 'review › prepare');
  assert.deepEqual(review.effects.map((effect) => effect.id), ['review.prepare-review.1']);
});

test('implement and design are explicit failed stubs that still hand off', () => {
  for (const verb of ['implement', 'design'] as const) {
    const { effects } = drive([started(verb)]);
    assert.deepEqual(effects, [{ kind: 'handoff', id: 'root.handoff.1', terminal: true }]);
    const frame = play(rootMachine, [started(verb), handoffDone()]).at(-1);
    assert.equal(frame?.await, 'done');
    assert.deepEqual(frame?.data, { outcome: 'failed', summary: `verb ${verb} not available until I05/I07`, handoff: '/tmp/dispatch-skills/s' });
  }
});

test('grammar-review-infers: --kind wins, then .plan.md / .design.md, else code', () => {
  assert.equal(inferKind('docs/x.plan.md', { kind: 'code' }), 'code');
  assert.equal(inferKind('docs/x.plan.md', {}), 'plan');
  assert.equal(inferKind('docs/X.DESIGN.md', {}), 'design');
  assert.equal(inferKind('main..HEAD', {}), 'code');
  assert.equal(inferKind('', {}), 'code');
  const effects = drive([started('review', { argument: 'docs/x.plan.md' })]).effects;
  assert.equal(effects[0]?.kind === 'prepare-review' && effects[0].review['kind'], 'plan');
});

test('review-report-only-default: standalone review reports unless fix is true', () => {
  const mode = (fix: boolean) => {
    const effect = drive([started('review', { fix })]).effects[0];
    return effect?.kind === 'prepare-review' ? effect.review['mode'] : null;
  };
  assert.equal(mode(false), 'report');
  assert.equal(mode(true), 'fix');
});

test('a terminal child emits handoff { terminal: true }, then done carries outcome and destination; EFFECT_FAILED keeps a warning', () => {
  const empty: Event = { type: 'REVIEW_PREPARED', effectId: 'review.prepare-review.1', scope: { empty: true }, promptPaths: {} };
  const { state, effects } = drive([started('review'), empty]);
  assert.equal(state.tag, 'handoff');
  assert.deepEqual(effects.at(-1), { kind: 'handoff', id: 'root.handoff.1', terminal: true });
  const done = play(rootMachine, [started('review'), empty, handoffDone()]).at(-1);
  assert.equal(done?.at, 'review › done');
  assert.deepEqual(done?.data, { outcome: 'no-reviewable-changes', summary: 'no reviewable changes', handoff: '/tmp/dispatch-skills/s' });
  const warned = play(rootMachine, [started('review'), empty, { type: 'EFFECT_FAILED', effectId: 'root.handoff.1', cls: 'io', detail: 'EBUSY' }]).at(-1);
  assert.deepEqual(warned?.data, { outcome: 'no-reviewable-changes', summary: 'no reviewable changes', handoff: null, warning: 'handoff failed: io: EBUSY' });
});
