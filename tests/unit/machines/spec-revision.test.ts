import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effect, Event, Level, RunStartedEvent, Verb } from '../../../skills/dispatch/scripts/core/types.ts';
import { rootMachine, type RootState, type RunInfo } from '../../../skills/dispatch/scripts/machines/root.ts';
import type { ImplementState } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { SPEC_PATH, SPEC_SOURCE, specApproval, specHash, specParsed, withSpec } from '../../helpers/spec-fixture.ts';
import { approval as designApproval, approveDesignScope, design as designFixture, run as designRun } from './fixtures/design.ts';
import { stepDesign, type DesignState } from '../../../skills/dispatch/scripts/machines/design.ts';
import { beginReview, reviewSpecFromRun, stepReview } from '../../../skills/dispatch/scripts/machines/review.ts';
import { started as deliveryStarted } from './fixtures/design-delivery.ts';
import { approvalState } from './fixtures/implement-recovery.ts';
import { launch, start } from './fixtures/implement-tasks.ts';

const CONFIG = {
  'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } },
  phases: { 'code-review': { rounds: { low: 1 }, targets: { low: 1 } }, 'plan-review': { rounds: { low: 1 }, targets: { low: 1 } }, 'design-review': { rounds: { low: 0 }, targets: { low: 1 } } },
};
const FP = { head: 'a'.repeat(40), index: 'i', worktree: 'w' };
const REVISED = `${SPEC_SOURCE}\nRevised.\n`;
const identity = { path: SPEC_PATH, hash: specHash() };
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
const at = (state: RootState) => rootMachine.project(state).at;
const data = (state: RootState) => rootMachine.project(state).data;
const settled = (verb: Verb, over: Partial<RunStartedEvent> = {}) => drive([withSpec(started(verb, over)), specParsed()]);
const runInfo = (verb: Verb, defaults: RunStartedEvent, level: Level = 'low', approvals = [] as { by: 'user'; quote: string; hash: string }[]): RunInfo =>
  ({ verb, argument: defaults.argument, slug: 'x', defaults: { ...defaults, level }, spec: { identity, approvals, counters: {} } });
/** Sends SPEC_REVISED and settles the revised bytes. */
function revise(state: RootState, source = REVISED): { state: RootState; effects: Effect[] } {
  const read = drive([{ type: 'SPEC_REVISED', path: SPEC_PATH }], state);
  const settledRevision = drive([specParsed(read.effects[0]!.id, SPEC_PATH, source)], read.state);
  return { state: settledRevision.state, effects: [...read.effects, ...settledRevision.effects] };
}
const revisedEvent = { type: 'SPEC_REVISED', path: SPEC_PATH } as const;

// SECTION: Acceptance

test('spec revision: root rejects another path and accepts the governing spec', () => {
  const { state } = settled('plan');
  assert.match(rootMachine.validate!(state, { type: 'SPEC_REVISED', path: 'other.spec.md' }) ?? '', /governing spec/);
  assert.equal(rootMachine.validate!(state, revisedEvent), null);
});

test('spec revision: root rejects a revision while writers or a hotfix writer are live', () => {
  const sim = {};
  const trace = { effects: [], events: [] };
  const tasks = launch(start(1, sim).result, sim, trace).state;
  assert.equal(tasks.tag, 'tasks');
  const implement = (child: ImplementState): RootState => ({ tag: 'implement', run: runInfo('implement', started('implement')), child });
  assert.match(rootMachine.validate!(implement(tasks), revisedEvent) ?? '', /live writers/);
  assert.match(rootMachine.validate!(implement({ ...tasks, tag: 'hotfix-write' } as unknown as ImplementState), revisedEvent) ?? '', /live writers hotfix/);
});

test('spec revision: root rejects a revision while a design revision is past author', () => {
  const defaults = designRun('implement');
  const revising = drive([{ type: 'REVISE', artifact: 'design', reason: 'Clarify', evidence: 'review' }], { tag: 'design', run: runInfo('implement', defaults), child: designApproval('implement') }).state;
  assert.ok(revising.tag === 'design' && revising.child.tag === 'revision' && revising.child.child.tag === 'author');
  assert.equal(rootMachine.validate!(revising, revisedEvent), null);
  const parsing = drive([{ type: 'AUTHORED', path: revising.child.child.workingPath }], revising).state;
  assert.match(rootMachine.validate!(parsing, revisedEvent) ?? '', /design revision past author/);
});

test('spec revision: the parked child receives no event until the new hash settles', () => {
  const { state } = settled('plan');
  const parked = drive([revisedEvent, { type: 'AUTHORED', path: '/session/a-ts.plan.md' }], state).state;
  assert.equal(at(parked), 'spec › reading');
  assert.ok(parked.tag === 'spec' && parked.parked?.verb === 'plan');
  assert.equal(parked.parked.state.tag, 'author');
});

// SECTION: Child transitions

test('spec revision: plan review returns to author with stale-spec and reviews again at a fresh path', () => {
  const authored = drive([{ type: 'AUTHORED', path: '/session/a-ts.plan.md' }], settled('plan').state);
  const reviewing = drive([{ type: 'ARTIFACT_PARSED', effectId: 'plan.parse-artifact.1', kind: 'plan', hash: `sha256:${'b'.repeat(64)}`, parsed: {}, defects: [] }], authored.state);
  assert.deepEqual(reviewing.effects.map((effect) => effect.id), ['plan.review.prepare-review.1']);
  const revised = revise(reviewing.state).state;
  assert.equal(at(revised), 'plan › author');
  assert.deepEqual((data(revised)['defects'] as { code: string }[]).map((row) => row.code), ['stale-spec']);
  assert.deepEqual(data(revised)['governingSpec'], { path: SPEC_PATH, hash: specHash(REVISED) });
  const again = drive([
    { type: 'AUTHORED', path: '/session/a-ts.plan.md' },
    { type: 'ARTIFACT_PARSED', effectId: 'plan.parse-artifact.2', kind: 'plan', hash: `sha256:${'c'.repeat(64)}`, parsed: {}, defects: [] },
  ], revised);
  // The earlier review keeps its own path (and review-log key); the re-review cannot overwrite it.
  assert.deepEqual(again.effects.map((effect) => effect.id), ['plan.parse-artifact.2', 'plan.review.s1.prepare-review.1']);
});

test('spec revision: design before approval returns to author with stale-spec', () => {
  const revised = revise(settled('design').state).state;
  assert.equal(at(revised), 'design › author');
  assert.deepEqual((data(revised)['defects'] as { code: string }[]).map((row) => row.code), ['stale-spec']);
  assert.ok(revised.tag === 'design');
  assert.deepEqual(revised.child.c.governingSpec, { path: SPEC_PATH, hash: specHash(REVISED) });
});

test('spec revision: design delivery opens a gated design revision and authors no next increment plan', () => {
  const defaults = designRun('implement');
  const delivery = deliveryStarted();
  assert.ok(delivery.tag === 'increment' && delivery.child.tag === 'starting');
  const approved = [{ by: 'user' as const, quote: 'approve', hash: specHash() }];
  const parsing = drive([{ type: 'SNAPSHOT', effectId: delivery.child.effectId, fingerprint: FP, diff: { paths: [] } }], { tag: 'design', run: runInfo('implement', defaults, 'medium', approved), child: delivery });
  const authoring = parsing.state;
  assert.equal(rootMachine.awaitOf(authoring), 'author');
  assert.equal(at(authoring), 'design › increment');
  const revised = revise(authoring).state;
  assert.equal(rootMachine.awaitOf(revised), 'decide');
  assert.equal(data(revised)['kind'], 'spec-approval');
  assert.equal(data(revised)['hash'], specHash(REVISED));
  assert.ok(revised.tag === 'spec' && revised.parked?.verb === 'design' && revised.parked.state.tag === 'revision');
  assert.equal(revised.parked.state.child.tag, 'author');
});

test('spec revision: a refused objective change after a spec revision re-authors and does not resume the stale increment', () => {
  const defaults = designRun('implement');
  const delivery = deliveryStarted();
  assert.ok(delivery.tag === 'increment' && delivery.child.tag === 'starting');
  const approved = [{ by: 'user' as const, quote: 'approve', hash: specHash() }];
  const authoring = drive([{ type: 'SNAPSHOT', effectId: delivery.child.effectId, fingerprint: FP, diff: { paths: [] } }], { tag: 'design', run: runInfo('implement', defaults, 'medium', approved), child: delivery }).state;
  const gated = revise(authoring).state;
  const revising = drive([specApproval(specHash(REVISED))], gated).state;
  assert.ok(revising.tag === 'design' && revising.child.tag === 'revision' && revising.child.child.tag === 'author');
  const parsing = drive([{ type: 'AUTHORED', path: revising.child.child.workingPath }], revising);
  const parse = parsing.effects.find((effect) => effect.kind === 'parse-artifact');
  assert.ok(parse);
  const changedObjective = { ...designFixture, box: { 'TL;DR': 'Deliver another feature' }, governedText: '# Delivery\nNew objective.' };
  const refused = drive([{ type: 'ARTIFACT_PARSED', kind: 'design', effectId: parse.id, hash: `sha256:${'d'.repeat(64)}`, parsed: changedObjective, defects: [] }], parsing.state).state;
  assert.equal(at(refused), 'design › revision');
  assert.equal(rootMachine.awaitOf(refused), 'author');
  assert.ok(refused.tag === 'design' && refused.child.tag === 'revision' && refused.child.child.tag === 'author');
  assert.deepEqual(refused.child.child.defects.map((row) => row['code']), ['revision-refused']);
  assert.deepEqual(refused.child.child.c.governingSpec, { path: SPEC_PATH, hash: specHash(REVISED) });
});

test('spec revision: standalone review supersedes pending findings and re-prepares with the new spec', () => {
  const ruling = drive([
    { type: 'REVIEW_PREPARED', effectId: 'review.prepare-review.1', scope: {}, promptPaths: { 'codex[0]': 'p0' } },
    {
      type: 'WAVE_DONE', effectId: 'review.wave.1', round: 1, slots: [{ slot: 'codex[0]', state: 'success' }],
      findings: [{ id: 'R1-F001', severity: 'MUST', category: 'correctness', locus: 'src/a.ts:L3', defect: 'defect', requiredChange: 'fix', sources: ['codex[0]'], scope: 'in' }],
    },
  ], settled('review').state).state;
  assert.equal(at(ruling), 'review › rule');
  const revised = revise(ruling);
  assert.equal(at(revised.state), 'review › prepare');
  assert.ok(revised.state.tag === 'review' && 'c' in revised.state.child);
  assert.deepEqual(revised.state.child.c.findings.map((row) => [row.id, row.status]), [['R1-F001', 'superseded']]);
  const prepare = revised.effects.find((effect) => effect.kind === 'prepare-review');
  assert.ok(prepare && prepare.kind === 'prepare-review');
  assert.deepEqual((prepare.review as Record<string, unknown>)['governingSpec'], { path: SPEC_PATH, hash: specHash(REVISED) });
  assert.equal(prepare.review['cap'], 2);
});

test('spec revision: implement halts with stale-spec for a standalone plan and stale-design-spec for an increment plan', () => {
  const child = approvalState();
  const standalone = revise({ tag: 'implement', run: runInfo('implement', started('implement')), child }).state;
  assert.equal(rootMachine.awaitOf(drive([{ type: 'HANDOFF_DONE', effectId: 'root.handoff.1', destination: '/session', warning: null }], standalone).state), 'done');
  assert.match(String((standalone.tag === 'handoff' ? standalone.done : {} as Record<string, unknown>)['summary']), /^stale-spec: /);
  const plan = { ...child.c.plan!, box: { ...child.c.plan!.box, Parent: '`x.design.md` · I01' } };
  const increment = revise({ tag: 'implement', run: runInfo('implement', started('implement')), child: { ...child, c: { ...child.c, plan } } }).state;
  assert.match(String((increment.tag === 'handoff' ? increment.done : {} as Record<string, unknown>)['summary']), /^stale-design-spec: x\.design\.md pins/);
});

test('spec revision: implement before a plan returns to author with stale-spec', () => {
  const boot = settled('implement');
  const authoring = drive([
    { type: 'SNAPSHOT', effectId: 'implement.snapshot.1', fingerprint: FP, diff: { paths: [] } },
    { type: 'EFFECT_FAILED', effectId: 'implement.parse-artifact.1', cls: 'io', detail: 'plan not found' },
  ], boot.state).state;
  assert.equal(at(authoring), 'implement › author');
  const revised = revise(authoring).state;
  assert.equal(at(revised), 'implement › author');
  assert.deepEqual((data(revised)['defects'] as { code: string }[]).map((row) => row.code), ['stale-spec']);
});

test('spec revision: a resumed increment re-prepares its pending plan review under the revised spec', () => {
  const delivery = deliveryStarted();
  assert.ok(delivery.tag === 'increment' && 'c' in delivery.child && delivery.child.c);
  const context = delivery.child.c;
  const phases = { ...(context.run.config['phases'] as Record<string, unknown>), 'plan-review': { rounds: { low: 1 }, targets: { low: 1 } } };
  const built = reviewSpecFromRun({ ...context.run, config: { ...context.run.config, phases } }, 'plan', context.planPath, identity);
  assert.ok(built.ok);
  const prepared = beginReview(built.spec, 'design.i01.implement.plan-review', context.counters);
  const waved = stepReview(prepared.state, { type: 'REVIEW_PREPARED', effectId: prepared.effects[0]!.id, scope: {}, promptPaths: { 'codex[0]': 'p0' } });
  const ruling = stepReview(waved.state, {
    type: 'WAVE_DONE', effectId: waved.effects[0]!.id, round: 1, slots: [{ slot: 'codex[0]', state: 'success' }],
    findings: [{ id: 'R1-F001', severity: 'MUST', category: 'correctness', locus: 'x.plan.md:L3', defect: 'defect', requiredChange: 'fix', sources: ['codex[0]'], scope: 'in' }],
  }).state;
  assert.equal(ruling.tag, 'rule');
  const child = { tag: 'plan-review', c: { ...context, governingSpec: identity, planReview: ruling }, review: ruling } as ImplementState;
  const reviewing: DesignState = { ...delivery, c: { ...delivery.c, governingSpec: identity }, child };
  const revisedSpec = { path: SPEC_PATH, hash: specHash(REVISED) };
  const revision = stepDesign(reviewing, { type: 'SPEC_SETTLED', ...revisedSpec });
  assert.ok(revision.state.tag === 'revision' && revision.state.child.tag === 'author');
  const parsing = stepDesign(revision.state, { type: 'AUTHORED', path: revision.state.child.workingPath });
  const revisedDesign = { ...designFixture, governedText: '# Delivery\nRevised for the spec.' };
  const revisedHash = `sha256:${'c'.repeat(64)}`;
  const parsed = stepDesign(parsing.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: parsing.effects[0]!.id, hash: revisedHash, parsed: revisedDesign, defects: [] });
  const resumed = approveDesignScope(stepDesign(parsed.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: parsed.effects[0]!.id, hash: revisedHash, parsed: revisedDesign, defects: [] }));
  assert.ok(resumed.state.tag === 'increment' && resumed.state.child.tag === 'plan-review');
  assert.equal(resumed.state.child.review.tag, 'prepare');
  const prepare = resumed.effects.find((effect) => effect.kind === 'prepare-review');
  assert.ok(prepare && prepare.kind === 'prepare-review');
  assert.deepEqual((prepare.review as Record<string, unknown>)['governingSpec'], revisedSpec);
  assert.ok('c' in resumed.state.child.review);
  assert.deepEqual(resumed.state.child.review.c.findings.map((row) => [row.id, row.status]), [['R1-F001', 'superseded']]);
});

/** A standalone review awaiting rulings in a round of the given scope. */
function rulingAtScope(scope: 'delta' | 'disputes-only'): RootState {
  const ruling = drive([
    { type: 'REVIEW_PREPARED', effectId: 'review.prepare-review.1', scope: {}, promptPaths: { 'codex[0]': 'p0' } },
    {
      type: 'WAVE_DONE', effectId: 'review.wave.1', round: 1, slots: [{ slot: 'codex[0]', state: 'success' }],
      findings: [{ id: 'R1-F001', severity: 'MUST', category: 'correctness', locus: 'src/a.ts:L3', defect: 'defect', requiredChange: 'fix', sources: ['codex[0]'], scope: 'in' }],
    },
  ], settled('review').state).state;
  assert.ok(ruling.tag === 'review' && 'c' in ruling.child);
  return { ...ruling, child: { ...ruling.child, c: { ...ruling.child.c, scope } } } as RootState;
}

for (const scope of ['delta', 'disputes-only'] as const) {
  test(`spec revision: a ${scope} review round re-prepares at full scope under the revised spec`, () => {
    const revised = revise(rulingAtScope(scope));
    const prepare = revised.effects.find((effect) => effect.kind === 'prepare-review');
    assert.ok(prepare && prepare.kind === 'prepare-review');
    assert.equal((prepare.scope as Record<string, unknown>)['scope'], 'full');
    assert.ok(revised.state.tag === 'review' && 'c' in revised.state.child);
    assert.deepEqual(revised.state.child.c.findings.map((row) => [row.id, row.status]), [['R1-F001', 'superseded']]);
  });
}

test('spec revision outside rule forces full next round through the resumed increment', () => {
  const delivery = deliveryStarted();
  assert.ok(delivery.tag === 'increment' && 'c' in delivery.child && delivery.child.c);
  const context = delivery.child.c;
  const phases = { ...(context.run.config['phases'] as Record<string, unknown>), 'plan-review': { rounds: { low: 1 }, targets: { low: 1 } } };
  const built = reviewSpecFromRun({ ...context.run, config: { ...context.run.config, phases } }, 'plan', context.planPath, identity);
  assert.ok(built.ok);
  const begun = beginReview(built.spec, 'design.i01.implement.plan-review', context.counters);
  assert.ok(begun.state.tag === 'prepare');
  // A delta preparation still in flight; under the revised spec it could report an empty scope and end the review.
  const pending = { ...begun.state, c: { ...begun.state.c, round: 1, preparedRound: 2, scope: 'delta' as const } };
  const child = { tag: 'plan-review', c: { ...context, governingSpec: identity, planReview: pending }, review: pending } as ImplementState;
  const reviewing: DesignState = { ...delivery, c: { ...delivery.c, governingSpec: identity }, child };
  const revisedSpec = { path: SPEC_PATH, hash: specHash(REVISED) };
  const revision = stepDesign(reviewing, { type: 'SPEC_SETTLED', ...revisedSpec });
  assert.ok(revision.state.tag === 'revision' && revision.state.child.tag === 'author');
  const parsing = stepDesign(revision.state, { type: 'AUTHORED', path: revision.state.child.workingPath });
  const revisedDesign = { ...designFixture, governedText: '# Delivery\nRevised for the spec.' };
  const revisedHash = `sha256:${'c'.repeat(64)}`;
  const parsed = stepDesign(parsing.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: parsing.effects[0]!.id, hash: revisedHash, parsed: revisedDesign, defects: [] });
  const resumed = approveDesignScope(stepDesign(parsed.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: parsed.effects[0]!.id, hash: revisedHash, parsed: revisedDesign, defects: [] }));
  assert.ok(resumed.state.tag === 'increment' && resumed.state.child.tag === 'plan-review');
  const review = resumed.state.child.review;
  assert.equal(review.tag, 'prepare');
  const prepare = resumed.effects.find((effect) => effect.kind === 'prepare-review');
  assert.ok(prepare && prepare.kind === 'prepare-review');
  assert.notEqual(prepare.id, begun.effects[0]!.id);
  assert.ok('c' in review && review.c.effectId === prepare.id);
  assert.equal((prepare.scope as Record<string, unknown>)['scope'], 'full');
  assert.deepEqual((prepare.review as Record<string, unknown>)['governingSpec'], revisedSpec);
});
