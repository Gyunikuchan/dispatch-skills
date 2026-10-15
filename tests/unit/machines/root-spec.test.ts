import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effect, Event, HostEvent, Level, RunStartedEvent, Verb } from '../../../skills/dispatch/scripts/core/types.ts';
import { rootMachine, type RootState, type RunInfo } from '../../../skills/dispatch/scripts/machines/root.ts';
import { SPEC_EFFECT, SPEC_PATH, SPEC_SOURCE, specApproval, specHash, specParsed, withSpec } from '../../helpers/spec-fixture.ts';
import { approval as designApproval, design as designFixture, hash as designHash, run as designRun } from './fixtures/design.ts';
import { stepDesign, type DesignState } from '../../../skills/dispatch/scripts/machines/design.ts';
import { beginDesignRevision, stepDesignRevision } from '../../../skills/dispatch/scripts/machines/design-revision.ts';
import { started as deliveryStarted } from './fixtures/design-delivery.ts';
import { approvalState } from './fixtures/implement-recovery.ts';

const CONFIG = {
  'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } },
  phases: { 'code-review': { rounds: { low: 1 }, targets: { low: 1 } }, 'plan-review': { rounds: { low: 1 }, targets: { low: 1 } } },
};
const FP = { head: 'a'.repeat(40), index: 'i', worktree: 'w' };
const started = (verb: Verb, over: Partial<RunStartedEvent> = {}): RunStartedEvent => ({
  type: 'RUN_STARTED', verb, argument: 'src/a.ts', level: 'low', levelSource: 'explicit', pins: null,
  orchestrator: 'claude', orchestratorModel: null, overrides: { sessionDir: '/session' }, config: CONFIG, repo: {}, ...over,
});

function drive(events: readonly Event[], from: RootState = rootMachine.initial()): { state: RootState; effects: Effect[] } {
  let state = from;
  const effects: Effect[] = [];
  for (const event of events) { const result = rootMachine.step(state, event); state = result.state; effects.push(...result.effects); }
  return { state, effects };
}
const frame = (state: RootState) => ({ at: rootMachine.project(state).at, await: rootMachine.awaitOf(state), data: rootMachine.project(state).data });
const settledAt = (verb: Verb, level: Level = 'low', over: Partial<RunStartedEvent> = {}, approved = false) =>
  drive([withSpec(started(verb, { level, ...over }), SPEC_PATH, { approved }), specParsed()]);
const identity = { path: SPEC_PATH, hash: specHash() };
const runInfo = (verb: Verb, level: Level, defaults: RunStartedEvent): RunInfo => ({ verb, argument: defaults.argument, slug: 'x', defaults: { ...defaults, level }, spec: { identity, approvals: [], counters: {} } });

// SECTION: Composition

test('spec stage composition: a candidate is read before any child effect and the plan input carries its identity', () => {
  const boot = drive([withSpec(started('plan'))]);
  assert.deepEqual(boot.effects.map((effect) => effect.id), [SPEC_EFFECT]);
  assert.equal(frame(boot.state).at, 'spec › reading');
  const { state } = drive([specParsed()], boot.state);
  assert.equal(frame(state).at, 'plan › author');
  assert.ok(state.tag === 'plan' && state.child.tag === 'author');
  assert.deepEqual(state.child.c.input.governingSpec, identity);
  assert.deepEqual(frame(state).data['governingSpec'], identity);
});

test('spec stage composition: design, implement, and review children carry the governing spec', () => {
  const design = settledAt('design').state;
  assert.ok(design.tag === 'design');
  assert.deepEqual(design.child.c.governingSpec, identity);
  const implementation = settledAt('implement').state;
  assert.ok(implementation.tag === 'implement' && 'c' in implementation.child && implementation.child.c);
  assert.deepEqual(implementation.child.c.governingSpec, identity);
  const review = settledAt('review');
  const prepare = review.effects.find((effect) => effect.kind === 'prepare-review');
  assert.ok(prepare && prepare.kind === 'prepare-review');
  assert.deepEqual((prepare.review as Record<string, unknown>)['governingSpec'], identity);
});

test('spec stage composition: a start without a candidate authors the session spec', () => {
  const { state, effects } = drive([started('plan')]);
  assert.deepEqual(effects, []);
  const view = frame(state);
  assert.equal(view.at, 'spec › author');
  assert.equal(view.await, 'author');
  assert.equal(view.data['artifact'], 'spec');
  assert.equal(view.data['path'], '/session/a-ts.spec.md');
});

test('spec stage composition: ask starts emit no spec effect', () => {
  const { state, effects } = drive([withSpec(started('ask'))]);
  assert.ok(effects.every((effect) => !effect.id.startsWith('spec.')));
  assert.equal(frame(state).at.startsWith('ask › '), true);
});

test('spec stage composition: the done projection names the governing spec', () => {
  const boot = settledAt('implement', 'low', { argument: 'x.plan.md' });
  const snapshot = boot.effects.find((effect) => effect.kind === 'snapshot')!;
  const { state } = drive([
    { type: 'EFFECT_FAILED', effectId: snapshot.id, cls: 'io', detail: 'snapshot failed' },
    { type: 'HANDOFF_DONE', effectId: 'root.handoff.1', destination: '/session', warning: null },
  ], boot.state);
  assert.equal(frame(state).await, 'done');
  assert.deepEqual(frame(state).data['governingSpec'], { ...identity, approved: false });
});

// SECTION: Approval gate

function assertGate(state: RootState, hash = specHash()): void {
  const view = frame(state);
  assert.equal(view.await, 'decide');
  assert.equal(view.data['kind'], 'spec-approval');
  assert.equal(view.data['hash'], hash);
}

test('spec approval gate: medium plan, design, and objective implement ask before their first author frame', () => {
  for (const verb of ['plan', 'design'] as const) {
    const { state } = settledAt(verb, 'medium');
    assertGate(state);
    assert.equal(frame(drive([specApproval()], state).state).at, `${verb} › author`);
  }
  const implementation = settledAt('implement', 'medium');
  const snapshot = implementation.effects.find((effect) => effect.kind === 'snapshot')!;
  const gated = drive([
    { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: FP, diff: { paths: [] } },
    { type: 'EFFECT_FAILED', effectId: 'implement.parse-artifact.1', cls: 'io', detail: 'plan not found' },
  ], implementation.state).state;
  assertGate(gated);
  assert.equal(frame(drive([specApproval()], gated).state).at, 'implement › author');
});

test('spec approval gate: low level and a prior approval of the hash pass without a gate', () => {
  assert.equal(frame(settledAt('plan', 'low').state).at, 'plan › author');
  assert.equal(frame(settledAt('plan', 'medium', {}, true).state).at, 'plan › author');
});

test('spec approval gate: standalone review and plan-driven implement settle without a gate', () => {
  assert.equal(frame(settledAt('review', 'medium').state).at, 'review › prepare');
  const implementation = settledAt('implement', 'medium', { argument: 'x.plan.md' });
  assert.equal(frame(implementation.state).at, 'implement › starting');
  assert.deepEqual(implementation.effects.map((effect) => effect.kind), ['parse-artifact', 'snapshot']);
});

test('spec approval gate: an earlier hash approval does not pass the gate after SPEC_REVISED', () => {
  const approved = drive([specApproval()], settledAt('plan', 'medium').state).state;
  assert.equal(frame(approved).at, 'plan › author');
  const revised = `${SPEC_SOURCE}\nRevised.\n`;
  const read = drive([{ type: 'SPEC_REVISED', path: SPEC_PATH }], approved);
  assert.equal(frame(read.state).at, 'spec › reading');
  const gated = drive([specParsed('spec.parse-artifact.2', SPEC_PATH, revised)], read.state).state;
  assertGate(gated, specHash(revised));
  assert.match(rootMachine.validate!(gated, { type: 'DECISION', kind: 'spec-approval', answer: { by: 'user', quote: 'old', hash: specHash() } }) ?? '', /hash/);
});

test('spec approval gate: a nested increment-plan author waits for approval', () => {
  const defaults = { ...designRun('implement'), level: 'medium' as Level };
  const delivery = deliveryStarted();
  assert.ok(delivery.tag === 'increment' && delivery.child.tag === 'starting');
  const state: RootState = { tag: 'design', run: runInfo('implement', 'medium', defaults), child: delivery };
  const gated = drive([{ type: 'SNAPSHOT', effectId: delivery.child.effectId, fingerprint: FP, diff: { paths: [] } }], state).state;
  assertGate(gated);
  assert.equal(frame(drive([specApproval()], gated).state).at, 'design › increment');
  assert.equal(rootMachine.awaitOf(drive([specApproval()], gated).state), 'author');
});

test('spec approval gate: a design-revision author waits for approval', () => {
  const defaults = { ...designRun('implement'), level: 'medium' as Level };
  const state: RootState = { tag: 'design', run: runInfo('implement', 'medium', defaults), child: designApproval('implement') };
  const gated = drive([{ type: 'REVISE', artifact: 'design', reason: 'Clarify', evidence: 'review' }], state).state;
  assertGate(gated);
  const resumed = drive([specApproval()], gated).state;
  assert.equal(frame(resumed).at, 'design › revision');
  assert.equal(rootMachine.awaitOf(resumed), 'author');
});

// SECTION: Review children

test('spec stage composition: the design review child carries the settled governing spec', () => {
  const config = { ...CONFIG, phases: { ...CONFIG.phases, 'design-review': { rounds: { low: 1 }, targets: { low: 1 } } } };
  const authoring = settledAt('design', 'low', { config }).state;
  const path = String(frame(authoring).data['path']);
  const parsing = drive([{ type: 'AUTHORED', path }], authoring);
  const parse = parsing.effects.find((effect) => effect.kind === 'parse-artifact')!;
  const { state, effects } = drive([{ type: 'ARTIFACT_PARSED', kind: 'design', effectId: parse.id, hash: designHash, parsed: designFixture, defects: [] }], parsing.state);
  assert.ok(state.tag === 'design' && state.child.tag === 'review');
  const prepare = effects.find((effect) => effect.kind === 'prepare-review');
  assert.ok(prepare && prepare.kind === 'prepare-review');
  assert.deepEqual((prepare.review as Record<string, unknown>)['governingSpec'], identity);
});

test('spec stage composition: the design integration review carries the governing spec', () => {
  const first = deliveryStarted();
  let state: DesignState = { ...first, c: { ...first.c, governingSpec: identity } } as DesignState;
  const effects: Effect[] = [];
  for (const increment of ['I01', 'I02']) {
    if (state.tag !== 'increment' || !('c' in state.child) || !state.child.c) throw new Error('increment child');
    const completed = { ...state, child: { tag: 'complete' as const, c: { ...state.child.c, changedPaths: [`src/${increment === 'I01' ? 'a' : 'b'}.ts`] }, summary: 'Done' } };
    const result = stepDesign(completed, { type: 'LOCK_BROKEN', stalePid: 1 });
    state = result.state;
    effects.push(...result.effects);
  }
  assert.equal(state.tag, 'integration');
  const prepare = effects.find((effect) => effect.kind === 'prepare-review');
  assert.ok(prepare && prepare.kind === 'prepare-review');
  assert.deepEqual((prepare.review as Record<string, unknown>)['governingSpec'], identity);
});

test('spec stage composition: the design revision review carries the governing spec', () => {
  const base = designApproval('implement');
  const phases = { 'design-review': { rounds: { low: 1 }, targets: { low: 1 } } };
  const c = { ...base.c, run: { ...base.c.run, config: { ...base.c.run.config, phases } }, governingSpec: identity };
  const authoring = beginDesignRevision(c, { type: 'REVISE', artifact: 'design', reason: 'Clarify', evidence: 'review' });
  assert.ok(authoring.state.tag === 'author');
  const parsing = stepDesignRevision(authoring.state, { type: 'AUTHORED', path: authoring.state.workingPath });
  const revised = { ...designFixture, governedText: '# Delivery\nRevised.' };
  const { state, effects } = stepDesignRevision(parsing.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: parsing.effects[0]!.id, hash: `sha256:${'c'.repeat(64)}`, parsed: revised, defects: [] });
  assert.equal(state.tag, 'review');
  const prepare = effects.find((effect) => effect.kind === 'prepare-review');
  assert.ok(prepare && prepare.kind === 'prepare-review');
  assert.deepEqual((prepare.review as Record<string, unknown>)['governingSpec'], identity);
});

// SECTION: Host-event guards

const REVISE: HostEvent = { type: 'REVISE', artifact: 'plan', reason: 'Clarify', evidence: 'review' };
const AMEND: HostEvent = { type: 'AMEND', delta: [], notify: [], rationale: 'Adjust' };
const REPLACE_PLAN: HostEvent = { type: 'REPLACE_PLAN', path: 'x.plan.md', expectedHash: `sha256:${'b'.repeat(64)}`, rationale: 'Replace', notify: [], reconciliation: {} as never };

test('spec stage guard: a spec-approval decision outside the spec approval await is rejected', () => {
  const implement: RootState = { tag: 'implement', run: runInfo('implement', 'low', started('implement')), child: approvalState() };
  assert.equal(rootMachine.awaitOf(implement), 'decide');
  assert.match(rootMachine.validate!(implement, specApproval() as HostEvent) ?? '', /spec-approval is accepted at the spec approval await only/);
  const authoring = settledAt('plan').state;
  assert.match(rootMachine.validate!(authoring, specApproval() as HostEvent) ?? '', /spec approval await only/);
});

test('spec stage guard: a spec-approval answer without a user approval or stop is rejected', () => {
  const { state } = settledAt('plan', 'medium');
  assert.match(rootMachine.validate!(state, { type: 'DECISION', kind: 'spec-approval', answer: 'approve' }) ?? '', /event\.answer: expected "stop"/);
});

test('spec stage guard: REVISE at the spec author await is rejected', () => {
  const { state } = drive([started('plan')]);
  assert.equal(rootMachine.awaitOf(state), 'author');
  assert.match(rootMachine.validate!(state, REVISE) ?? '', /REVISE is not accepted while the spec is authored/);
});

test('spec stage guard: REVISE, AMEND, and REPLACE_PLAN at the spec approval await are rejected', () => {
  const { state } = settledAt('plan', 'medium');
  assert.equal(frame(state).data['kind'], 'spec-approval');
  for (const event of [REVISE, AMEND, REPLACE_PLAN]) {
    assert.match(rootMachine.validate!(state, event) ?? '', new RegExp(`${event.type} is not accepted at the spec approval await`));
  }
});

test('spec revision: a case-variant governing spec path is accepted on Windows', { skip: process.platform !== 'win32' && 'case-insensitive paths are Windows-only' }, () => {
  const variant = SPEC_PATH.toUpperCase();
  const { state } = settledAt('plan');
  assert.equal(rootMachine.validate!(state, { type: 'SPEC_REVISED', path: variant }), null);
  const gated = settledAt('plan', 'medium').state;
  assert.equal(rootMachine.validate!(gated, { type: 'SPEC_REVISED', path: variant }), null);
  const reread = drive([{ type: 'SPEC_REVISED', path: variant }], gated);
  assert.equal(frame(reread.state).at, 'spec › reading');
  assert.equal(reread.effects[0]?.kind === 'parse-artifact' && reread.effects[0].path, SPEC_PATH);
});

test('spec revision: a dot-segment and backslash variant of the governing spec path is accepted', () => {
  const variant = `.\\sub\\..\\${SPEC_PATH}`;
  const { state } = settledAt('plan');
  assert.equal(rootMachine.validate!(state, { type: 'SPEC_REVISED', path: variant }), null);
  assert.match(rootMachine.validate!(state, { type: 'SPEC_REVISED', path: `sub/${SPEC_PATH}` }) ?? '', /governing spec/);
});
