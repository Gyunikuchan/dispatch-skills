import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effect, Event, HostEvent, Level, RunStartedEvent, Verb } from '../../../skills/dispatch/scripts/core/types.ts';
import { rootMachine, type RootState, type RunInfo } from '../../../skills/dispatch/scripts/machines/root.ts';
import { SPEC_EFFECT, SPEC_PATH, SPEC_SOURCE, specApproval, specHash, specParsed, withSpec } from '../../helpers/spec-fixture.ts';
import { approval as designApproval, design as designFixture, hash as designHash, run as designRun } from './fixtures/design.ts';
import { beginPlan, stepPlan, planInputFromRun } from '../../../skills/dispatch/scripts/machines/plan.ts';
import { PLAN as IMPLEMENT_PLAN } from './fixtures/implement-recovery.ts';
import { stepDesign, type DesignState } from '../../../skills/dispatch/scripts/machines/design.ts';
import { beginDesignRevision, stepDesignRevision } from '../../../skills/dispatch/scripts/machines/design-revision.ts';
import { started as deliveryStarted } from './fixtures/design-delivery.ts';
import { approvalState } from './fixtures/implement-recovery.ts';
import { beginReview, type ReviewState } from '../../../skills/dispatch/scripts/machines/review.ts';
import { DESIGN_REVISION_CONTEXT_PREFIX } from '../../../skills/dispatch/scripts/domain/prompt.ts';

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

test('author projections expose the current governing identity for every downstream author family', () => {
  const defaults = designRun('implement');
  const delivery = deliveryStarted();
  assert.ok(delivery.tag === 'increment' && delivery.child.tag === 'starting');
  const nested = drive([{ type: 'SNAPSHOT', effectId: delivery.child.effectId, fingerprint: FP, diff: { paths: [] } }], { tag: 'design', run: runInfo('implement', 'low', defaults), child: delivery }).state;
  const revision = drive([{ type: 'REVISE', artifact: 'design', reason: 'Clarify', evidence: 'review' }], { tag: 'design', run: runInfo('implement', 'low', defaults), child: designApproval('implement') }).state;
  const boot = settledAt('implement');
  const snapshot = boot.effects.find(e => e.kind === 'snapshot')!;
  const implementation = drive([{ type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: FP, diff: { paths: [] } }, { type: 'EFFECT_FAILED', effectId: 'implement.parse-artifact.1', cls: 'io', detail: 'plan not found' }], boot.state).state;
  for (const state of [settledAt('design').state, revision, nested, implementation, settledAt('plan').state]) {
    assert.equal(frame(state).await, 'author');
    const prior = frame(state).data;
    for (const hash of [identity.hash, specHash(SPEC_SOURCE + '\nRevised.')]) {
      assert.ok('run' in state && state.run.spec);
      const current = { ...state, run: { ...state.run, spec: { ...state.run.spec, identity: { ...identity, hash } } } } as RootState;
      assert.deepEqual(frame(current).data, { ...prior, governingSpec: { ...identity, hash } });
    }
  }
});

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
  const pin = effects.find(effect => effect.kind === 'parse-artifact');
  const preparedEffects = pin ? (state.tag === 'design' ? rootMachine.step(state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: pin.id, hash: designHash, parsed: designFixture, defects: [], governing: { pinned: identity.hash, current: identity.hash, design: null, reqIds: [] } }).effects : effects) : effects;
  const prepare = preparedEffects.find((effect) => effect.kind === 'prepare-review');
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
  const pin = effects.find(effect => effect.kind === 'parse-artifact')!;
  assert.equal(pin.kind, 'parse-artifact');
  const preparedEffects = stepDesignRevision(state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: pin.id, hash: designHash, parsed: designFixture, defects: [], governing: { pinned: identity.hash, current: identity.hash, design: null, reqIds: [] } }).effects;
  const prepare = preparedEffects.find((effect) => effect.kind === 'prepare-review');
  assert.ok(prepare && prepare.kind === 'prepare-review');
  assert.deepEqual((prepare.review as Record<string, unknown>)['governingSpec'], identity);
  const context = String((prepare.review as Record<string, unknown>)['context']);
  assert.ok(context.startsWith(DESIGN_REVISION_CONTEXT_PREFIX));
  const provenance = JSON.parse(context.slice(DESIGN_REVISION_CONTEXT_PREFIX.length));
  assert.equal(provenance.reason, 'Clarify');
  assert.equal(provenance.evidence, 'review');
  assert.equal(provenance.before, c.design!.governedText);
  assert.equal(provenance.after, revised.governedText);
  assert.ok(provenance.delta);
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

test('stale pin requires approval of revised spec', () => {
 const author = settledAt('plan', 'medium', {}, true).state;
 const parsing = drive([{ type: 'AUTHORED', path: 'x.plan.md' }], author);
 const parse = parsing.effects.find(e => e.kind === 'parse-artifact')!;
 const stale = drive([{ type: 'ARTIFACT_PARSED', kind: 'plan', effectId: parse.id, hash: designHash, parsed: {}, defects: [], governing: { pinned: identity.hash, current: 'sha256:' + 'b'.repeat(64), design: null, reqIds: [] } }], parsing.state);
 assert.equal(stale.state.tag, 'spec'); assert.equal(frame(stale.state).at, 'spec › reading');
 assert.equal(stale.effects[0]?.kind, 'parse-artifact');
});

const staleCurrent = 'sha256:' + 'b'.repeat(64);
test('ancestor failure code survives each parent handoff', () => {
 const begun = beginReview({ kind: 'plan', target: 'x.plan.md', cap: 1, breadth: 1, context: '', roster: [], timeoutMs: 1000, governingSpec: identity }, 'review', {});
 assert.ok(begun.state.tag === 'pin-check'); const review = begun.state;
 const defaults = started('plan'); const input = planInputFromRun(defaults, identity); assert.ok(input.ok);
 const planned = beginPlan(input.input, 'plan', {}).state; assert.ok('c' in planned && planned.c);
 const plan = { ...planned, c: { ...planned.c, designPin: 'x.design.md' } };
 const c = designApproval().c;
 const revision = beginDesignRevision(c, { type: 'REVISE', artifact: 'design', reason: 'repair', evidence: 'finding' }).state;
 const cases: RootState[] = [
 { tag: 'review', run: runInfo('review', 'low', defaults), child: review },
 { tag: 'plan', run: runInfo('plan', 'low', defaults), child: { tag: 'review', c: plan.c, review } },
 { tag: 'design', run: runInfo('design', 'low', defaults), child: { tag: 'review', c, review } },
 { tag: 'design', run: runInfo('design', 'low', defaults), child: { tag: 'revision', c, child: { ...revision, tag: 'review', review } } },
 ];
 for (const state of cases) {
 const failed = drive([{ type: 'EFFECT_FAILED', effectId: review.effectId, cls: 'io', detail: 'design pin target unreadable: x.design.md not found' }], state).state;
 assert.ok(failed.tag === 'handoff', state.tag); assert.match(failed.done.summary, /stale-design-spec/, state.tag);
 }
});
test('live matching parent still settles changed approved bytes', () => {
 const author = settledAt('plan', 'medium', {}, true).state;
 const parsing = drive([{ type: 'AUTHORED', path: 'x.plan.md' }], author);
 const stale = drive([{ type: 'ARTIFACT_PARSED', kind: 'plan', effectId: parsing.effects[0]!.id, hash: designHash, parsed: {}, defects: [], governing: { pinned: staleCurrent, current: staleCurrent, design: null, reqIds: [] } }], parsing.state);
 assert.equal(stale.state.tag, 'spec');
});
test('changed settled bytes intercept each parent parse and review boundary', () => {
 const defaults = started('plan'); const input = planInputFromRun(defaults, identity); assert.ok(input.ok);
 const planned = beginPlan(input.input, 'plan', {}).state; assert.ok('c' in planned && planned.c);
 const plan = { ...planned, c: { ...planned.c, designPin: 'x.design.md' } };
 const dc = { ...designApproval().c, governingSpec: identity };
 const revision = beginDesignRevision(dc, { type: 'REVISE', artifact: 'design', reason: 'repair', evidence: 'finding' }).state;
 const impl = approvalState(); assert.ok('c' in impl && impl.c);
 const ic = { ...impl.c, governingSpec: identity, designPin: 'x.design.md' };
 const begun = beginReview({ kind: 'plan', target: 'x.plan.md', cap: 1, breadth: 1, context: '', roster: [], timeoutMs: 1000, governingSpec: identity }, 'review', {});
 assert.ok(begun.state.tag === 'pin-check');
 const reviews: Extract<ReviewState, { tag: 'pin-check' | 'fix-verify' }>[] = [begun.state, { tag: 'fix-verify', c: { ...begun.state.c, effectId: 'verify' }, clusters: [], pass: 'main' }];
 const cases: [RootState, string][] = [
 [{ tag: 'plan', run: runInfo('plan', 'medium', defaults), child: { tag: 'parsing', c: { ...plan.c, effectId: 'parse' } } }, 'parse'],
 [{ tag: 'design', run: runInfo('design', 'medium', defaults), child: { tag: 'parse', c: dc, effectId: 'parse', afterReview: false } }, 'parse'],
 [{ tag: 'design', run: runInfo('design', 'medium', defaults), child: { tag: 'revision', c: dc, child: { ...revision, tag: 'parse', effectId: 'parse', afterReview: false } } }, 'parse'],
 [{ tag: 'implement', run: runInfo('implement', 'medium', defaults), child: { tag: 'parsing', c: ic, effectId: 'parse', phase: 'initial' } }, 'parse'],
 [{ tag: 'design', run: runInfo('design', 'medium', defaults), child: { tag: 'increment', c: dc, increment: 'I01', child: { tag: 'parsing', c: ic, effectId: 'parse', phase: 'initial' } } }, 'parse'],
 ];
 for (const review of reviews) {
 const effectId = review.tag === 'pin-check' ? review.effectId : review.c.effectId!;
 cases.push(
 [{ tag: 'plan', run: runInfo('plan', 'medium', defaults), child: { tag: 'review', c: plan.c, review } }, effectId],
 [{ tag: 'design', run: runInfo('design', 'medium', defaults), child: { tag: 'review', c: dc, review } }, effectId],
 [{ tag: 'design', run: runInfo('design', 'medium', defaults), child: { tag: 'revision', c: dc, child: { ...revision, tag: 'review', review } } }, effectId],
 [{ tag: 'implement', run: runInfo('implement', 'medium', defaults), child: { tag: 'plan-review', c: ic, review } }, effectId],
 [{ tag: 'design', run: runInfo('design', 'medium', defaults), child: { tag: 'increment', c: dc, increment: 'I01', child: { tag: 'plan-review', c: ic, review } } }, effectId]);
 }
 for (const [state, effectId] of cases) for (const defects of [[], [{ code: 'missing-satisfies' }]]) {
 const source = SPEC_SOURCE + '\nChanged.\n'; const hash = specHash(source);
 const stale = drive([{ type: 'ARTIFACT_PARSED', kind: state.tag === 'design' ? 'design' : 'plan', effectId, hash: designHash, parsed: {}, defects, governing: { pinned: hash, current: hash, design: null, reqIds: [] } }], state);
 const delayed = drive([{ type: 'ARTIFACT_PARSED', kind: state.tag === 'design' ? 'design' : 'plan', effectId: 'old.parse-artifact.999', hash: designHash, parsed: {}, defects, governing: { pinned: hash, current: hash, design: null, reqIds: [] } }], state);
 assert.notEqual(delayed.state.tag, 'spec', `delayed ${state.tag}/${effectId}`); assert.deepEqual(delayed.effects, []);
 if (delayed.state.tag === 'plan' && 'c' in delayed.state.child) assert.equal(delayed.state.child.c?.designPin, 'x.design.md');
 if (delayed.state.tag === 'implement' && 'c' in delayed.state.child) assert.equal(delayed.state.child.c?.designPin, 'x.design.md');
 if (delayed.state.tag === 'design' && delayed.state.child.tag === 'increment' && 'c' in delayed.state.child.child) assert.equal(delayed.state.child.child.c?.designPin, 'x.design.md');
 const recovered = drive([{ type: 'SPEC_SETTLED', path: identity.path, hash }], delayed.state).state;
 if (state.tag === 'plan' || state.tag === 'implement') {
 assert.ok(recovered.tag === 'handoff'); assert.match(recovered.done.summary, /stale-design-spec/);
 } else {
 const expected = drive([{ type: 'SPEC_SETTLED', path: identity.path, hash }], state).state;
 assert.equal(recovered.tag, expected.tag);
 if (recovered.tag === 'design' && expected.tag === 'design') assert.equal(recovered.child.tag, expected.child.tag);
 if (recovered.tag === 'handoff' && expected.tag === 'handoff') assert.equal(recovered.done.summary, expected.done.summary);
 }
 assert.equal(stale.state.tag, 'spec', `${state.tag}/${effectId}/${defects.length}`);
 assert.deepEqual(rootMachine.codec!.decode(rootMachine.codec!.encode(stale.state)), stale.state);
 const gate = drive([specParsed(stale.effects[0]!.id, SPEC_PATH, source)], stale.state).state;
 assertGate(gate, hash);
 }
 for (const review of [{ tag: 'wave', c: begun.state.c, phase: 'cli' }, { tag: 'native', c: begun.state.c, slots: [] }] as ReviewState[]) {
 const inactive: RootState[] = [
 { tag: 'plan', run: runInfo('plan', 'medium', defaults), child: { tag: 'review', c: plan.c, review } },
 { tag: 'implement', run: runInfo('implement', 'medium', defaults), child: { tag: 'plan-review', c: ic, review } },
 { tag: 'design', run: runInfo('design', 'medium', defaults), child: { tag: 'review', c: dc, review } },
 { tag: 'design', run: runInfo('design', 'medium', defaults), child: { tag: 'revision', c: dc, child: { ...revision, tag: 'review', review } } },
 { tag: 'design', run: runInfo('design', 'medium', defaults), child: { tag: 'increment', c: dc, increment: 'I01', child: { tag: 'plan-review', c: ic, review } } },
 ];
 for (const state of inactive) {
 const duplicate = drive([{ type: 'ARTIFACT_PARSED', kind: 'plan', effectId: begun.state.effectId, hash: designHash, parsed: {}, defects: [], governing: { pinned: identity.hash, current: staleCurrent, design: null, reqIds: [] } }], state);
 assert.notEqual(duplicate.state.tag, 'spec'); assert.deepEqual(duplicate.effects, []);
 }
 }
});
test('resolved stale design wins concurrent lint and retains ancestor', () => {
 const author = settledAt('plan', 'medium', {}, true).state;
 const parsing = drive([{ type: 'AUTHORED', path: 'x.plan.md' }], author);
 const stale = drive([{ type: 'ARTIFACT_PARSED', kind: 'plan', effectId: parsing.effects[0]!.id, hash: designHash, parsed: {}, defects: [{ code: 'missing-satisfies' }], governing: { pinned: staleCurrent, current: identity.hash, design: 'x.design.md', reqIds: [] } }], parsing.state);
 assert.equal(stale.state.tag, 'spec');
 const resumed = drive([specParsed(stale.effects[0]!.id)], stale.state).state;
 assert.ok(resumed.tag === 'handoff'); assert.match(resumed.done.summary, /stale-design-spec/);
});
test('existing standalone stale plan with lint stops after settlement', () => {
 const boot = settledAt('implement', 'medium', { argument: 'x.plan.md' }, true);
 const snapshot = boot.effects.find(e => e.kind === 'snapshot')!;
 const parsing = drive([{ type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: FP, diff: { paths: [] } }], boot.state);
 const source = SPEC_SOURCE + '\nChanged.\n'; const hash = specHash(source);
 const stale = drive([{ type: 'ARTIFACT_PARSED', kind: 'plan', effectId: parsing.effects[0]!.id, hash: designHash, parsed: {}, defects: [{ code: 'missing-satisfies' }], governing: { pinned: identity.hash, current: hash, design: null, reqIds: [] } }], parsing.state);
 assert.equal(stale.state.tag, 'spec');
 const gate = drive([specParsed(stale.effects[0]!.id, SPEC_PATH, source)], stale.state).state; assertGate(gate, hash);
 const resumed = drive([specApproval(hash)], gate).state;
 assert.ok(resumed.tag === 'handoff'); assert.match(resumed.done.summary, /stale-spec/);
 assert.notEqual(rootMachine.awaitOf(resumed), 'author');
});
function stalePlanAtRoot(design: string | null = null, unchanged = false) {
 const author = settledAt('plan', 'medium', {}, true).state;
 const parse = drive([{ type: 'AUTHORED', path: 'x.plan.md' }], author);
 const effect = parse.effects.find(e => e.kind === 'parse-artifact')!;
 const stale = drive([{ type: 'ARTIFACT_PARSED', kind: 'plan', effectId: effect.id, hash: designHash, parsed: {}, defects: [], governing: { pinned: unchanged ? staleCurrent : identity.hash, current: unchanged ? identity.hash : staleCurrent, design, reqIds: [] } }], parse.state);
 assert.ok(stale.state.tag === 'spec');
 assert.deepEqual(rootMachine.codec!.decode(rootMachine.codec!.encode(stale.state)), stale.state);
 return stale;
}
test('stale pin recovery continues after approval', () => {
 const stale = stalePlanAtRoot(); const source = SPEC_SOURCE + '\nRevised.\n';
 const gate = drive([specParsed(stale.effects[0]!.id, SPEC_PATH, source)], stale.state).state;
 assertGate(gate, specHash(source));
 const resumed = drive([specApproval(specHash(source))], gate).state;
 assert.ok(resumed.tag === 'plan' && resumed.child.tag === 'author');
 assert.equal(resumed.child.defects[0]?.['code'], 'stale-spec');
 const next = drive([{ type: 'AUTHORED', path: 'x.plan.md' }, { type: 'ARTIFACT_PARSED', kind: 'plan', effectId: 'plan.parse-artifact.2', hash: designHash, parsed: {}, defects: [] }], resumed);
 assert.ok(next.effects.some(e => e.id.startsWith('plan.review.s1.')));
});
test('stale pin with unchanged spec resumes recovery', () => {
 const stale = stalePlanAtRoot(null, true);
 const resumed = drive([specParsed(stale.effects[0]!.id)], stale.state).state;
 assert.ok(resumed.tag === 'plan' && resumed.child.tag === 'author');
 assert.equal(resumed.child.c.specEpoch, 1); assert.equal(resumed.child.defects[0]?.['code'], 'stale-spec');
});
test('stale pin first acceptance increment plan fails', () => {
 const stale = stalePlanAtRoot('x.design.md', true);
 const resumed = drive([specParsed(stale.effects[0]!.id)], stale.state).state;
 assert.ok(resumed.tag === 'handoff'); assert.match(resumed.done.summary, /stale-design-spec/);
});
test('stale pin check in nested review requires approval', () => {
 const author = settledAt('plan', 'medium', {}, true).state;
 const defaults = started('plan');
 const run = author.tag === 'plan' ? author.run : runInfo('plan', 'medium', defaults);
 const input = planInputFromRun(defaults, identity); assert.ok(input.ok);
 const begun = beginPlan(input.input, 'plan', {});
 const parsing = stepPlan(begun.state, { type: 'AUTHORED', path: 'x.plan.md' });
 const review = stepPlan(parsing.state, { type: 'ARTIFACT_PARSED', kind: 'plan', effectId: parsing.effects[0]!.id, hash: designHash, parsed: {}, defects: [] });
 assert.equal(review.effects[0]?.kind, 'parse-artifact');
 const pendingRoot: RootState = { tag: 'plan', run, child: review.state };
 assert.deepEqual(rootMachine.codec!.decode(rootMachine.codec!.encode(pendingRoot)), pendingRoot);
 const stale = drive([{ type: 'ARTIFACT_PARSED', kind: 'plan', effectId: review.effects[0]!.id, hash: designHash, parsed: {}, defects: [], governing: { pinned: identity.hash, current: staleCurrent, design: null, reqIds: [] } }], { tag: 'plan', run, child: review.state });
 assert.equal(stale.state.tag, 'spec'); assert.equal(stale.effects[0]?.kind, 'parse-artifact');
 const gate = drive([specParsed(stale.effects[0]!.id, SPEC_PATH, SPEC_SOURCE + '\nRevised.\n')], stale.state).state;
 assertGate(gate, specHash(SPEC_SOURCE + '\nRevised.\n'));
});
test('stale pin initial implement parse keeps plan metadata', () => {
 for (const increment of [false, true]) {
 const boot = settledAt('implement', 'medium', { argument: 'x.plan.md' }, true);
 const snapshot = boot.effects.find(e => e.kind === 'snapshot')!;
 const parsing = drive([{ type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: FP, diff: { paths: [] } }], boot.state);
 const effect = parsing.effects.find(e => e.kind === 'parse-artifact')!;
 const parsed = { ...IMPLEMENT_PLAN, box: { ...IMPLEMENT_PLAN.box, Parent: increment ? '`x.design.md` · I01' : '`x.spec.md` · ' + identity.hash } };
 const source = SPEC_SOURCE + '\nRevised.\n';
 const stale = drive([{ type: 'ARTIFACT_PARSED', kind: 'plan', effectId: effect.id, hash: designHash, parsed, defects: [], governing: { pinned: identity.hash, current: specHash(source), design: increment ? 'x.design.md' : null, reqIds: [] } }], parsing.state);
 assert.ok(stale.state.tag === 'spec' && stale.state.parked?.verb === 'implement');
 assert.ok('c' in stale.state.parked.state && stale.state.parked.state.c?.plan);
 const gate = drive([specParsed(stale.effects[0]!.id, SPEC_PATH, source)], stale.state).state;
 assertGate(gate, specHash(source));
 const resumed = drive([specApproval(specHash(source))], gate).state;
 assert.ok(resumed.tag === 'handoff'); assert.match(resumed.done.summary, increment ? /stale-design-spec/ : /stale-spec/);
 }
});

for (const detail of ['design pin target unreadable: x.design.md', 'x.design.md has no spec pin']) test(`implement terminal handoff preserves ancestor diagnostic: ${detail}`, () => {
 const boot = settledAt('implement', 'medium', { argument: 'x.plan.md' }, true);
 const snapshot = boot.effects.find(e => e.kind === 'snapshot')!;
 const parsing = drive([{ type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: FP, diff: { paths: [] } }], boot.state);
 const effect = parsing.effects.find(e => e.kind === 'parse-artifact')!;
 const result = drive([{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail }], parsing.state);
 assert.ok(result.state.tag === 'handoff');
 assert.match(result.state.done.summary, /stale-design-spec/);
 const terminal = drive([{ type: 'HANDOFF_DONE', effectId: result.state.effectId, destination: 'handoff.md', warning: null, diagnostics: false }], result.state).state;
 assert.equal(terminal.tag, 'done');
 assert.match(String(rootMachine.project(terminal).data['summary']), /stale-design-spec/);
});
