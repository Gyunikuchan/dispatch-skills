import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effect, Event, RunStartedEvent, Verb } from '../../../skills/dispatch/scripts/core/types.ts';
import { inferKind, rootMachine, type RootState } from '../../../skills/dispatch/scripts/machines/root.ts';
import { play as playMachine } from '../../helpers/play.ts';
import { specHash, specParsed, withSpec } from '../../helpers/spec-fixture.ts';

const CONFIG = {
  'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } },
  phases: { 'code-review': { rounds: { low: 1 }, targets: { low: 1 } }, 'plan-review': { rounds: { low: 1 }, targets: { low: 1 } } },
};
const started = (verb: Verb, over: Partial<RunStartedEvent> = {}): RunStartedEvent => ({
  type: 'RUN_STARTED', verb, argument: 'src/a.ts', level: 'low', levelSource: 'explicit', pins: null,
  orchestrator: 'claude', orchestratorModel: null, overrides: {}, config: CONFIG, repo: {}, ...over,
});
/** Non-ask starts carry a spec candidate; `settle` answers its read so tests begin at the child's first frame. */
const governed = (event: Event): boolean => event.type === 'RUN_STARTED' && event.verb !== 'ask';
const settle = (events: readonly Event[]): Event[] => events.flatMap((event) => governed(event) ? [withSpec(event as RunStartedEvent), specParsed()] : [event]);
const play = (machine: typeof rootMachine, events: readonly Event[]) => {
  const frames = playMachine(machine, settle(events));
  return governed(events[0]!) ? frames.slice(1) : frames;
};

function drive(events: readonly Event[]): { state: RootState; effects: Effect[] } {
  let state = rootMachine.initial();
  const effects: Effect[] = [];
  for (const event of settle(events)) { const result = rootMachine.step(state, event); state = result.state; if (!governed(event)) effects.push(...result.effects); }
  return { state, effects };
}
const GOVERNED = { path: 'fixture.spec.md', hash: specHash(), approved: false };
const handoffDone = (warning: string | null = null): Event => ({ type: 'HANDOFF_DONE', effectId: 'root.handoff.1', destination: '/tmp/dispatch-skills/s', warning });

// SECTION: Verb routing

test('root selects each verb', () => {
  assert.equal(rootMachine.project(drive([started('ask')]).state).at, 'ask › preparing');
  assert.deepEqual(play(rootMachine, [started('plan')]).map((frame) => [frame.at, frame.await]), [['plan › author', 'author']]);
  const review = drive([started('review')]);
  assert.equal(rootMachine.project(review.state).at, 'review › prepare');
  assert.deepEqual(review.effects.map((effect) => effect.id), ['review.prepare-review.1']);
});

test('implement routes to initial snapshot collection', () => {
  const implementation = drive([started('implement')]);
  assert.deepEqual(implementation.effects.map((effect) => effect.kind), ['snapshot']);
  assert.equal(rootMachine.project(implementation.state).at, 'implement › starting');
});

test('initial implementation snapshot failure is handed off with its plan context', () => {
  const implementation = drive([started('implement')]);
  const failed = { type: 'EFFECT_FAILED', effectId: implementation.effects[0]?.id ?? '', cls: 'io', detail: 'snapshot failed' } as const;
  const frame = play(rootMachine, [started('implement'), failed, handoffDone()]).at(-1);
  assert.equal(frame?.await, 'done');
  assert.equal(frame?.data['outcome'], 'failed');
  assert.equal(frame?.data['summary'], 'initial snapshot failed: io: snapshot failed');
  assert.equal(frame?.data['handoff'], '/tmp/dispatch-skills/s');
  assert.equal((frame?.data['completion'] as Record<string, unknown>)['planPath'], 'src-a-ts.plan.md');
});

test('design routes to authoring without production effects', () => {
  const design = drive([started('design')]);
  assert.deepEqual(design.effects, []);
  assert.equal(rootMachine.awaitOf(design.state), 'author');
  assert.equal(rootMachine.project(design.state).at, 'design › author');
  assert.equal(rootMachine.project(design.state).data['artifact'], 'design');
});

// SECTION: Review inference and fix

test('review kind infers from explicit flag, design or plan extension, or defaults to code', () => {
  assert.equal(inferKind('docs/x.plan.md', { kind: 'code' }), 'code');
  assert.equal(inferKind('docs/x.plan.md', {}), 'plan');
  assert.equal(inferKind('docs/X.DESIGN.md', {}), 'design');
  assert.equal(inferKind('main..HEAD', {}), 'code');
  assert.equal(inferKind('', {}), 'code');
  const begun = drive([started('review', { argument: 'docs/x.plan.md' })]);
  const pin = begun.effects[0]!;
  assert.equal(pin.kind, 'parse-artifact');
  const { effects } = rootMachine.step(begun.state, { type: 'ARTIFACT_PARSED', effectId: pin.id, kind: 'plan', parsed: {}, hash: 'h', defects: [], governing: { pinned: specHash(), current: specHash(), design: null, reqIds: [] } });
  assert.equal(effects[0]?.kind === 'prepare-review' && effects[0].review['kind'], 'plan');
});

test('standalone review applies accepted fixes without a flag', () => {
  const state = drive([
    started('review'),
    { type: 'REVIEW_PREPARED', effectId: 'review.prepare-review.1', scope: {}, promptPaths: { 'codex[0]': 'p0' } },
    {
      type: 'WAVE_DONE', effectId: 'review.wave.1', round: 1,
      slots: [{ slot: 'codex[0]', state: 'success' }],
      findings: [{ id: 'R1-F001', severity: 'MUST', category: 'correctness', locus: 'src/a.ts:L3', defect: 'defect', requiredChange: 'fix', sources: ['codex[0]'], scope: 'in' }],
    },
    { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' } } },
  ]).state;
  assert.equal(rootMachine.project(state).at, 'review › fix');
});

// SECTION: Handoff and retro

test('a terminal child schedules handoff and preserves its outcome and destination', () => {
  const empty: Event = { type: 'REVIEW_PREPARED', effectId: 'review.prepare-review.1', scope: { empty: true }, promptPaths: {} };
  const { state, effects } = drive([started('review'), empty]);
  assert.equal(state.tag, 'handoff');
  assert.deepEqual(effects.at(-1), { kind: 'handoff', id: 'root.handoff.1', terminal: true });
  const done = play(rootMachine, [started('review'), empty, handoffDone()]).at(-1);
  assert.equal(done?.at, 'review › done');
  assert.deepEqual(done?.data, { outcome: 'no-reviewable-changes', governingSpec: GOVERNED, summary: 'no reviewable changes', handoff: '/tmp/dispatch-skills/s' });
});

test('handoff failure preserves the child outcome with a warning', () => {
  const empty: Event = { type: 'REVIEW_PREPARED', effectId: 'review.prepare-review.1', scope: { empty: true }, promptPaths: {} };
  const warned = play(rootMachine, [started('review'), empty, { type: 'EFFECT_FAILED', effectId: 'root.handoff.1', cls: 'io', detail: 'EBUSY' }]).at(-1);
  assert.deepEqual(warned?.data, { outcome: 'no-reviewable-changes', governingSpec: GOVERNED, summary: 'no reviewable changes', handoff: null, warning: 'handoff failed: io: EBUSY' });
});

test('handoff with diagnostics enabled enters retro and completes run with handoff outcome', () => {
  const empty: Event = { type: 'REVIEW_PREPARED', effectId: 'review.prepare-review.1', scope: { empty: true }, promptPaths: {} };
  const retro = drive([started('review'), empty, { type: 'HANDOFF_DONE', effectId: 'root.handoff.1', destination: '/tmp/dispatch-skills/s', warning: null, diagnostics: true }]);
  assert.equal(retro.state.tag, 'retro');
  assert.equal(rootMachine.awaitOf(retro.state), 'retro');
  assert.deepEqual(rootMachine.project(retro.state), { at: 'review › retro', data: { kind: 'retro' } });
  assert.equal(rootMachine.step(retro.state, { type: 'AUTHORED', path: 'x' }).state.tag, 'retro');
  const done = rootMachine.step(retro.state, { type: 'RETRO', observations: [] });
  assert.equal(done.state.tag, 'done');
  assert.deepEqual(done.effects, []);
  assert.deepEqual(rootMachine.project(done.state).data, { outcome: 'no-reviewable-changes', governingSpec: GOVERNED, summary: 'no reviewable changes', handoff: '/tmp/dispatch-skills/s' });
});

test('handoff without diagnostics completes run directly', () => {
  const empty: Event = { type: 'REVIEW_PREPARED', effectId: 'review.prepare-review.1', scope: { empty: true }, promptPaths: {} };
  for (const extra of [{ diagnostics: false }, {}]) {
    const { state } = drive([started('review'), empty, { ...handoffDone(), ...extra } as Event]);
    assert.equal(state.tag, 'done');
  }
});
