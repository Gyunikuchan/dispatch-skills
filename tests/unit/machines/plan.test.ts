import { qualitySections } from '../../../skills/dispatch/scripts/domain/prompt.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Event, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { planInputFromRun, planMachine, slugOf } from '../../../skills/dispatch/scripts/machines/plan.ts';
import { rootMachine } from '../../../skills/dispatch/scripts/machines/root.ts';
import { play } from '../../helpers/play.ts';
import { specHash, specParsed, withSpec } from '../../helpers/spec-fixture.ts';

const config = (rounds: number) => ({
  'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } },
  phases: { 'plan-review': { rounds: { low: rounds }, targets: { low: 1 } } },
});
const started = (rounds = 1): RunStartedEvent => ({
  type: 'RUN_STARTED', verb: 'plan', argument: 'Add a cache', level: 'low', levelSource: 'explicit', pins: null,
  orchestrator: 'claude', orchestratorModel: null, overrides: {}, config: config(rounds), repo: {},
});
const authored: Event = { type: 'AUTHORED', path: 'docs/add-a-cache.plan.md' };
const parsed = (n: number, defects: unknown[]): Event => ({ type: 'ARTIFACT_PARSED', effectId: `plan.parse-artifact.${n}`, kind: 'plan', hash: 'h', parsed: {}, defects: defects as never });

test('author quality reads: plan author → parse → defects re-enter author → review → done complete', () => {
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
  assert.deepEqual(frames[0]?.data, { artifact: 'plan', path: 'add-a-cache.plan.md', template: 'references/templates/plan.md', read: [{ path: 'references/templates/quality-bar.md', sections: qualitySections.plan }] });
  assert.deepEqual(frames[2]?.data['defects'], [defect]);
  assert.equal(frames[6]?.data['outcome'], 'complete');
});

test('plan: review skipped (rounds 0) → done complete with the skip summary', () => {
  // HANDOFF_DONE without `diagnostics` (journals written before the retro await) still reaches done.
  const frame = play(rootMachine, [withSpec(started(0)), specParsed(), authored, { ...parsed(1, []) }, { type: 'HANDOFF_DONE', effectId: 'root.handoff.1', destination: '/t', warning: null }]).at(-1);
  assert.equal(frame?.await, 'done');
  assert.deepEqual(frame?.data, { outcome: 'complete', summary: 'plan review skipped (rounds 0)', handoff: '/t', governingSpec: { path: 'fixture.spec.md', hash: specHash(), approved: false } });
});


test('standalone plan revision diagnostic describes actual support', () => {
  const state = planMachine.step(planMachine.initial(), started()).state;
  const error = planMachine.validate!(state, { type: 'REVISE', artifact: 'plan', reason: 'change', evidence: 'observed' });
  assert.match(error ?? '', /standalone/);
});

test('plan: default plan path is scoped to sessionDir', () => {
  const result = planInputFromRun({
    ...started(),
    overrides: { sessionDir: '/workspace/.scratch/dispatch-skills/20261001T0000Z-my-plan' },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.input.path, '/workspace/.scratch/dispatch-skills/20261001T0000Z-my-plan/add-a-cache.plan.md');
  }

  // Explicit path override is preserved
  const explicit = planInputFromRun({
    ...started(),
    overrides: { sessionDir: '/workspace/.scratch/dispatch-skills/20261001T0000Z-my-plan', path: 'custom/path.plan.md' },
  });
  assert.equal(explicit.ok, true);
  if (explicit.ok) {
    assert.equal(explicit.input.path, 'custom/path.plan.md');
  }

  // Explicit argument ending in .plan.md is preserved
  const explicitArg = planInputFromRun({
    ...started(),
    argument: 'custom/arg.plan.md',
    overrides: { sessionDir: '/workspace/.scratch/dispatch-skills/20261001T0000Z-my-plan' },
  });
  assert.equal(explicitArg.ok, true);
  if (explicitArg.ok) {
    assert.equal(explicitArg.input.path, 'custom/arg.plan.md');
  }
});

test('objective slugs retain leading words when the objective mentions a path', () => {
  for (const [objective, prefix] of [
    ['Fix review tags; see skills/dispatch/scripts/domain/report.ts and opencode usage parsers', 'fix-review-tags-see-skills-dispatch'],
    ['Update documentation in docs/README.md', 'update-documentation-in-docs'],
  ]) {
    const slug = slugOf(objective!);
    assert.ok(slug.startsWith(prefix!), slug);
  }
});

test('bare path slugs use the basename across separators, spaces, and artifact extensions', () => {
  for (const [input, expected] of [
    ['skills/dispatch/scripts/domain/report.ts', 'report-ts'],
    ['work/session/add-a-cache.plan.md', 'add-a-cache'],
    ['work/session/add-a-cache.design.md', 'add-a-cache'],
    ['C:\\work\\session\\foo-bar.design.md', 'foo-bar'],
    ['C:\\Users\\John Smith\\work\\foo-bar.design.md', 'foo-bar'],
  ]) assert.equal(slugOf(input!), expected, input);
});

test('plan stays on stale pin', () => {
 const boot = planMachine.step(planMachine.initial(), started());
 const parsing = planMachine.step(boot.state, authored);
 const event = { ...parsed(1, []), governing: { pinned: specHash(), current: 'sha256:' + 'b'.repeat(64), design: null, reqIds: [] } } as Event;
 const result = planMachine.step(parsing.state, event);
 assert.equal(result.state.tag, 'parsing'); assert.deepEqual(result.effects, []);
});
test('stale design spec pin fails plan run', () => {
 const boot = planMachine.step(planMachine.initial(), started());
 const parsing = planMachine.step(boot.state, authored);
 const stale = planMachine.step(parsing.state, { ...parsed(1, []), governing: { pinned: specHash(), current: 'sha256:' + 'b'.repeat(64), design: 'x.design.md', reqIds: [] } } as Event);
 const result = planMachine.step(stale.state, { type: 'SPEC_SETTLED', path: 'x.spec.md', hash: 'sha256:' + 'b'.repeat(64) });
 assert.equal(result.state.tag, 'failed'); assert.match(String(planMachine.project(result.state).data['summary']), /stale-design-spec/);
});
