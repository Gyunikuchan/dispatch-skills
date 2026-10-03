import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effect, Event, RunStartedEvent, Verb } from '../../../skills/dispatch/scripts/core/types.ts';
import { inferKind, rootMachine, type RootState } from '../../../skills/dispatch/scripts/machines/root.ts';
import { play } from '../../helpers/play.ts';
import { approvalState, FP, HASH, PLAN } from './implement-recovery.test.ts';

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

test('root nested revision routes after parked snapshot and resumes original Context without approval growth', () => {
  const parent = approvalState();
  let r = rootMachine.step({ tag: 'implement', run: { verb: 'implement', argument: 'x.plan.md', slug: 'feature' }, child: parent }, { type: 'REVISE', artifact: 'plan', reason: 'blocked-by-plan', evidence: 'check failure' });
  assert.equal(r.state.tag, 'implement');
  r = rootMachine.step(r.state, { type: 'SNAPSHOT', effectId: r.effects[0]!.id, fingerprint: FP, diff: { paths: [] } });
  assert.equal(r.state.tag, 'revision'); if (r.state.tag !== 'revision') return;
  const path = r.state.child.r.workingPath;
  r = rootMachine.step(r.state, { type: 'AUTHORED', path });
  r = rootMachine.step(r.state, { type: 'SNAPSHOT', effectId: r.effects[0]!.id, fingerprint: FP, diff: { paths: [] } });
  r = rootMachine.step(r.state, { type: 'ARTIFACT_PARSED', effectId: r.effects[0]!.id, kind: 'plan', hash: HASH, parsed: PLAN, defects: [] });
  assert.equal(r.state.tag, 'implement'); if (r.state.tag !== 'implement' || !('c' in r.state.child) || !r.state.child.c) return;
  assert.equal(r.state.child.tag, 'approval'); assert.deepEqual(r.state.child.c.tasks, parent.c.tasks);
  assert.equal(r.state.child.c.revisions[0]?.reason, 'blocked-by-plan');
  assert.deepEqual(r.state.child.c.startFingerprint, parent.c.startFingerprint);
});

test('root selects each verb', () => {
  assert.equal(rootMachine.project(drive([started('ask')]).state).at, 'ask › preparing');
  assert.deepEqual(play(rootMachine, [started('plan')]).map((frame) => [frame.at, frame.await]), [['plan › author', 'author']]);
  const review = drive([started('review')]);
  assert.equal(rootMachine.project(review.state).at, 'review › prepare');
  assert.deepEqual(review.effects.map((effect) => effect.id), ['review.prepare-review.1']);
});

test('implement routes into its reducer; design routes into authoring', () => {
  const implementation = drive([started('implement')]);
  assert.deepEqual(implementation.effects.map((effect) => effect.kind), ['snapshot']);
  assert.equal(rootMachine.project(implementation.state).at, 'implement › starting');
  const failed = { type: 'EFFECT_FAILED', effectId: implementation.effects[0]?.id ?? '', cls: 'io', detail: 'snapshot failed' } as const;
  const frame = play(rootMachine, [started('implement'), failed, handoffDone()]).at(-1);
  assert.equal(frame?.await, 'done');
  assert.equal(frame?.data['outcome'], 'failed');
  assert.equal(frame?.data['summary'], 'initial snapshot failed: io: snapshot failed');
  assert.equal(frame?.data['handoff'], '/tmp/dispatch-skills/s');
  assert.equal((frame?.data['completion'] as Record<string, unknown>)['planPath'], 'src-a-ts.plan.md');

  const design = drive([started('design')]);
  assert.deepEqual(design.effects, []);
  assert.equal(rootMachine.awaitOf(design.state), 'author');
  assert.equal(rootMachine.project(design.state).at, 'design › author');
  assert.equal(rootMachine.project(design.state).data['artifact'], 'design');
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
