import { qualitySections } from '../../../skills/dispatch/scripts/domain/prompt.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effect, Event, Ports, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { beginBoundImplement, beginImplement, implementData, initialImplement, stepImplement, validateImplement, type Context } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { settledPlanInput, writerConfig } from '../../../skills/dispatch/scripts/machines/implement-types.ts';
import { rootMachine } from '../../../skills/dispatch/scripts/machines/root.ts';
import { beginReview, stepReview, reviewSpecFromRun } from '../../../skills/dispatch/scripts/machines/review.ts';
import { start as startTasks, launch, submit } from './fixtures/implement-tasks.ts';

const HASH = `sha256:${'a'.repeat(64)}`;
const FP = { head: 'head', index: 'index', worktree: 'tree' };
const PLAN = {
  title: 'Implement example', box: { 'TL;DR': 'Deliver example' }, keyDecisions: [],
  criteria: [{ id: 'SC1', title: 'Example works', line: 1, changes: ['src/example.ts'], verify: [{ command: 'node --test tests/example.test.ts', final: false }], evidence: 'verify', preExisting: false, redException: null, testRationale: null, review: null, enforcementInfeasibility: null }],
  changes: [{ action: 'MODIFY', path: 'src/example.ts', note: 'Add behavior', command: null, line: 1 }],
  verification: { automated: ['node --test tests/example.test.ts'], none: null, manual: [] }, tasks: [], finalCommands: [], traceability: null, governedText: '# plan',
};
const run = (overrides: Record<string, unknown> = {}): RunStartedEvent => ({
  type: 'RUN_STARTED', verb: 'implement', argument: 'Implement example', level: 'low', levelSource: 'explicit', pins: null,
  orchestrator: 'claude', orchestratorModel: null, overrides, repo: {},
  config: { 'write-subagents': { claude: { low: { model: 'writer-a' } } }, 'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } }, phases: { 'plan-review': { rounds: { low: 1 }, targets: { low: 1 } }, 'code-review': { rounds: { low: 1 }, targets: { low: 1 } } } },
});
const step = (state: ReturnType<typeof initialImplement>, event: Event) => {
  const result = stepImplement(state, event);
  if (result.state.tag !== 'checking-host-event') return result;
  assert.equal(result.effects[0]?.kind, 'snapshot');
  return stepImplement(result.state, { type: 'SNAPSHOT', effectId: result.state.effectId, fingerprint: result.state.c.lastFingerprint ?? FP, diff: { paths: [] } });
};
const effectOf = (effects: readonly Effect[], kind: Effect['kind']): Effect => {
  const effect = effects.find((item) => item.kind === kind);
  assert.ok(effect, `expected ${kind} effect`);
  return effect;
};

function atBaseline(overrides: Record<string, unknown> = {}, parsedPlan = PLAN, invocation = run(overrides)) {
  let state = initialImplement();
  let result = step(state, { ...invocation, overrides: { path: 'plans/example.plan.md', settledPlan: { path: 'plans/example.plan.md', hash: HASH, outcome: 'settled' }, ...overrides } });
  state = result.state;
  let effect = effectOf(result.effects, 'snapshot');
  result = step(state, { type: 'SNAPSHOT', effectId: effect.id, fingerprint: FP, diff: { paths: [] } });
  state = result.state;
  effect = effectOf(result.effects, 'parse-artifact');
  result = step(state, { type: 'ARTIFACT_PARSED', effectId: effect.id, kind: 'plan', hash: HASH, parsed: parsedPlan, defects: [] });
  state = result.state;
  assert.equal(state.tag, 'baseline-preflight');
  effect = effectOf(result.effects, 'snapshot');
  result = step(state, { type: 'SNAPSHOT', effectId: effect.id, fingerprint: FP, diff: { paths: [] } });
  state = result.state;
  return { state, effect: effectOf(result.effects, 'verify') };
}

function classificationGate(parsedPlan = PLAN, invocation = run()) {
  const { state, effect } = atBaseline({}, parsedPlan, invocation);
  const approval = toDecision(state, effect.id);
  assert.equal(approval.tag, 'approval');
  const result = step(approval, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } });
  assert.equal(result.state.tag, 'level-classification');
  if (result.state.tag !== 'level-classification') throw new Error('level-classification');
  return result.state;
}

function toDecision(state: ReturnType<typeof initialImplement>, effectId: string, exit = 0, failureId: string | null = null, after = FP) {
  let result = step(state, { type: 'VERIFY_DONE', effectId, purpose: 'baseline', results: [{ command: 'node --test tests/example.test.ts', exit, logPath: 'baseline.log', failureId, failedTests: [], diagnostic: 'baseline', inputFingerprint: 'input' }], fingerprint: after });
  state = result.state;
  const snapshot = effectOf(result.effects, 'snapshot');
  result = step(state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: after, diff: { paths: [] } });
  return result.state;
}

// SECTION: Baseline and settled plan

test('implement-settled-plan-skip: settled metadata binds path and governed hash before skipping plan review', () => {
  const metadata = settledPlanInput({ path: 'plans/example.plan.md', hash: HASH, outcome: 'settled' });
  assert.deepEqual(metadata, { path: 'plans/example.plan.md', hash: HASH, outcome: 'settled' });
  assert.equal(settledPlanInput({ path: 'plans/example.plan.md', hash: 'sha256:bad', outcome: 'settled' }), null);
  assert.equal(settledPlanInput({ path: 'plans/example.plan.md', hash: HASH, outcome: 'pending' }), null);
  const entry = atBaseline();
  assert.equal(entry.state.tag, 'baseline');
  assert.equal(entry.effect.kind, 'verify');
});

test('settled hash mismatch re-enters plan review and does not run the baseline', () => {
  let result = step(initialImplement(), run({ path: 'plans/example.plan.md', settledPlan: { path: 'plans/example.plan.md', hash: `sha256:${'b'.repeat(64)}`, outcome: 'settled' } }));
  const snapshot = effectOf(result.effects, 'snapshot');
  result = step(result.state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: FP, diff: { paths: [] } });
  const parse = effectOf(result.effects, 'parse-artifact');
  result = step(result.state, { type: 'ARTIFACT_PARSED', effectId: parse.id, kind: 'plan', hash: HASH, parsed: PLAN, defects: [] });
  assert.equal(result.state.tag, 'plan-review');
  assert.equal(result.effects[0]?.kind, 'prepare-review');

  result = step(initialImplement(), run({ path: 'plans/other.plan.md', settledPlan: { path: 'plans/example.plan.md', hash: HASH, outcome: 'settled' } }));
  const first = effectOf(result.effects, 'snapshot');
  result = step(result.state, { type: 'SNAPSHOT', effectId: first.id, fingerprint: FP, diff: { paths: [] } });
  const parseOther = effectOf(result.effects, 'parse-artifact');
  result = step(result.state, { type: 'ARTIFACT_PARSED', effectId: parseOther.id, kind: 'plan', hash: HASH, parsed: PLAN, defects: [] });
  assert.equal(result.state.tag, 'plan-review');
  assert.equal(result.effects[0]?.kind, 'prepare-review');
});

test('plan review concerns from an empty fallback slot reach the implement concerns', () => {
  let result = step(initialImplement(), run({ path: 'plans/example.plan.md' }));
  result = step(result.state, { type: 'SNAPSHOT', effectId: effectOf(result.effects, 'snapshot').id, fingerprint: FP, diff: { paths: [] } });
  result = step(result.state, { type: 'ARTIFACT_PARSED', effectId: effectOf(result.effects, 'parse-artifact').id, kind: 'plan', hash: HASH, parsed: PLAN, defects: [] });
  assert.equal(result.state.tag, 'plan-review');
  result = step(result.state, { type: 'REVIEW_PREPARED', effectId: effectOf(result.effects, 'prepare-review').id, scope: {}, promptPaths: { 'codex[0]': 'p0' } });
  const reserve = { slot: 'codex[0]', state: 'reserve', by: 'claude[0]', model: 'opus', record: 'reserve claude[0] for codex[0]', reason: 'quota' };
  result = step(result.state, { type: 'WAVE_DONE', effectId: effectOf(result.effects, 'wave-start').id, round: 1, slots: [reserve], findings: [] } as never);
  const concern = 'review slot codex[0]: no findings after fallback to opus';
  const c = 'c' in result.state ? result.state.c as Context : null;
  assert.equal(c?.planReview?.tag, 'settled');
  assert.deepEqual(c?.concerns, [concern]);
});

test('implement-baseline-known-red: acceptance requires every recorded failure identity', () => {
  const { state, effect } = atBaseline();
  const decision = toDecision(state, effect.id, 2, 'node --test tests/example.test.ts::test:old failure');
  assert.equal(decision.tag, 'baseline-decision');
  if (decision.tag !== 'baseline-decision') return;
  assert.match(validateImplement(decision, { type: 'DECISION', kind: 'baseline', answer: { action: 'accept-known-red', ids: [] } }) ?? '', /every distinct baseline failure/);
  const accepted = step(decision, { type: 'DECISION', kind: 'baseline', answer: { action: 'accept-known-red', ids: ['node --test tests/example.test.ts::test:old failure'] } });
  assert.equal(accepted.state.tag, 'approval');

});

test('implement-baseline: verification side effects require recovery assessment', () => {
  const { state, effect } = atBaseline();
  const sideEffect = toDecision(state, effect.id, 0, null, { ...FP, worktree: 'changed' });
  assert.equal(sideEffect.tag, 'assessing-host-event');
});

// SECTION: Prewrite level classification

test('prewrite-level: approval-by-quote resolves classification before checkout', () => {
  const { state, effect } = atBaseline();
  const approval = toDecision(state, effect.id);
  assert.equal(approval.tag, 'approval');
  assert.match(validateImplement(approval, { type: 'DECISION', kind: 'approval', answer: { by: 'user' } }) ?? '', /by and quote/);
  const denied = step(approval, { type: 'DECISION', kind: 'approval', answer: { by: 'user' } });
  assert.equal(denied.state.tag, 'approval');
  const allowed = step(approval, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } });
  assert.equal(allowed.state.tag, 'level-classification');
  if (allowed.state.tag !== 'level-classification') return;
  const classified = step(allowed.state, { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'low', rationale: 'One bounded local behavior change.', gateScopeHash: implementData(allowed.state)['gateScopeHash'] } });
  assert.equal(classified.state.tag, 'task-checkout');
});

function classifyExplicitRun(choice: 'adopt' | 'retain') {
  const { state, effect } = atBaseline();
  let result = toDecision(state, effect.id);
  assert.equal(result.tag, 'approval');
  result = step(result, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } }).state;
  assert.equal(result.tag, 'level-classification');
  if (result.tag !== 'level-classification') throw new Error('level-classification');
  const gateScopeHash = implementData(result)['gateScopeHash'];
  result = step(result, { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'medium', rationale: 'The bounded integration has meaningful uncertainty, but failures remain observable and recoverable.', gateScopeHash } }).state;
  assert.equal(result.tag, 'level-recommendation');
  if (result.tag !== 'level-recommendation') throw new Error('level-recommendation');
  const recommendation = implementData(result);
  assert.equal(recommendation['explicitLevel'], 'low');
  assert.equal(recommendation['assessedLevel'], 'medium');
  result = step(result, { type: 'DECISION', kind: 'level-recommendation', answer: { choice, quote: `I choose to ${choice} the recommended level.` } }).state;
  return result;
}

test('prewrite-level: a higher assessment pauses an explicit level until the user retains it', () => {
  const result = classifyExplicitRun('retain');
  assert.equal(result.tag, 'task-checkout');
  if (result.tag === 'task-checkout') {
    assert.equal(result.c.run.level, 'low');
    assert.equal(result.c.levelAssessment?.evaluatedLevel, 'medium');
    assert.equal(result.c.levelChoice?.choice, 'retain');
  }
});

test('prewrite-level: adopting a higher assessment settles the run at that level', () => {
  const result = classifyExplicitRun('adopt');
  assert.equal(result.tag, 'task-checkout');
  if (result.tag === 'task-checkout') {
    assert.equal(result.c.run.level, 'medium');
    assert.equal(result.c.levelAssessment?.evaluatedLevel, 'medium');
    assert.equal(result.c.levelChoice?.choice, 'adopt');
  }
});

test('prewrite-level: classified task assessment controls writer and review routing', () => {
  const config = {
    'write-subagents': { claude: { low: { model: 'writer-low' }, medium: { model: 'writer-medium' } } },
    'read-delegates': { codex: { targets: [{ low: { model: 'reader-low' }, medium: { model: 'reader-medium' } }] } },
    phases: { 'plan-review': { rounds: { low: 1, medium: 1 }, targets: { low: 1, medium: 1 } }, 'code-review': { rounds: { low: 0, medium: 1 }, targets: { low: 1, medium: 1 } } },
  } as unknown as RunStartedEvent['config'];
  const gate = classificationGate(PLAN, { ...run(), config });
  let result = step(gate, { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'medium', rationale: 'The change crosses task boundaries but remains observable and recoverable.', gateScopeHash: implementData(gate)['gateScopeHash'] } });
  assert.equal(result.state.tag, 'level-recommendation');
  if (result.state.tag !== 'level-recommendation') return;
  result = step(result.state, { type: 'DECISION', kind: 'level-recommendation', answer: { choice: 'adopt', quote: 'Adopt medium.' } });
  assert.equal(result.state.tag, 'task-checkout');
  if (result.state.tag !== 'task-checkout') return;
  assert.equal(result.state.c.run.level, 'medium');
  assert.deepEqual(result.state.c.writer?.models, ['writer-medium']);
  const review = reviewSpecFromRun(result.state.c.run, 'code', 'plans/example.plan.md');
  assert.equal(review.ok && review.spec.cap, 1);
});

test('prewrite-level: user stop at classification gate ends before first writer', () => {
  const gate = classificationGate();
  const result = step(gate, { type: 'DECISION', kind: 'run-stop', answer: { by: 'user', quote: 'Stop before writing.' } });
  assert.equal(result.state.tag, 'stopped');
  assert.equal(result.effects.some((effect) => effect.kind === 'checkout' && effect.op === 'task'), false);
  assert.equal(result.effects.some((effect) => effect.kind === 'write-brief'), false);
});

test('prewrite-level: explicit equal-or-lower assessment continues without prompting', () => {
  for (const evaluatedLevel of ['low', 'medium'] as const) {
    const level: RunStartedEvent['level'] = evaluatedLevel === 'low' ? 'low' : 'high';
    const invocation = { ...run(), level };
    const gate = classificationGate(PLAN, invocation);
    const result = step(gate, { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel, rationale: 'The evidence fits within the explicit ceiling.', gateScopeHash: implementData(gate)['gateScopeHash'] } });
    assert.equal(result.state.tag, 'task-checkout');
    if (result.state.tag === 'task-checkout') {
      assert.equal(result.state.c.run.level, level);
      assert.equal(result.state.c.levelChoice, null);
    }
  }
});

test('prewrite-level: xhigh and max stay explicit', () => {
  for (const level of ['xhigh', 'max'] as const) {
    const config = { ...run().config, 'write-subagents': { claude: { [level]: { model: `writer-${level}` } } } } as RunStartedEvent['config'];
    const gate = classificationGate(PLAN, { ...run(), level, config });
    const result = step(gate, { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'high', rationale: 'The classification is below the explicit advanced level.', gateScopeHash: implementData(gate)['gateScopeHash'] } });
    assert.equal(result.state.tag, 'task-checkout');
    if (result.state.tag === 'task-checkout') {
      assert.equal(result.state.c.run.level, level);
      assert.deepEqual(result.state.c.writer?.models, [`writer-${level}`]);
    }
  }
});

test('prewrite-level: lower retained level preserves configured phase skips', () => {
  const config = { ...run().config, 'write-subagents': { claude: { high: { model: 'writer-high' } } }, phases: { 'plan-review': { rounds: { high: 0 }, targets: { high: 1 } }, 'code-review': { rounds: { high: 0 }, targets: { high: 1 } } } } as RunStartedEvent['config'];
  const gate = classificationGate(PLAN, { ...run(), level: 'high', config });
  const result = step(gate, { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'medium', rationale: 'The bounded work does not require the requested ceiling.', gateScopeHash: implementData(gate)['gateScopeHash'] } });
  assert.equal(result.state.tag, 'task-checkout');
  if (result.state.tag === 'task-checkout') {
    assert.equal(result.state.c.run.level, 'high');
    assert.equal(result.state.c.writer?.models[0], 'writer-high');
    const review = reviewSpecFromRun(result.state.c.run, 'code', 'plans/example.plan.md');
    assert.equal(review.ok && review.spec.cap, 0);
  }
});

test('level-journal: assessment scope distinguishes acceptance obligations with different criterion titles', () => {
  const alternative: typeof PLAN = { ...PLAN, criteria: PLAN.criteria.map((criterion) => ({ ...criterion, title: 'A behaviorally different required outcome' })) };
  const originalScope = implementData(classificationGate())['gateScope'] as Record<string, unknown>;
  const alternativeScope = implementData(classificationGate(alternative))['gateScope'] as Record<string, unknown>;
  assert.notDeepEqual(originalScope, alternativeScope);
  assert.equal((originalScope['criteria'] as { title: string }[])[0]?.title, 'Example works');
  assert.equal((alternativeScope['criteria'] as { title: string }[])[0]?.title, 'A behaviorally different required outcome');
});

test('writer configuration resolves sparse levels and rejects malformed cascades', () => {
  assert.deepEqual(writerConfig({ 'write-subagents': { claude: { high: { model: ['a', 'b'], effort: 'high' } } } }, 'claude', 'medium'), { ok: true, value: { models: ['a', 'b'], effort: 'high' } });
  assert.equal(writerConfig({ 'write-subagents': { claude: { low: { model: ['a', 'a'] } } } }, 'claude', 'low').ok, false);
  assert.equal(writerConfig({ 'write-subagents': { claude: { low: { model: ['a', null] } } } }, 'claude', 'low').ok, false);
});

test('implement: default plan path is scoped to sessionDir', () => {
  const result = stepImplement(initialImplement(), run({
    sessionDir: '/workspace/.scratch/dispatch-skills/20261001T0000Z-my-impl',
  }));
  assert.equal(result.state.tag, 'starting');
  if (result.state.tag === 'starting') {
    assert.equal(result.state.c.planPath, '/workspace/.scratch/dispatch-skills/20261001T0000Z-my-impl/implement-example.plan.md');
  }

  // Explicit path override is preserved
  const explicit = stepImplement(initialImplement(), run({
    sessionDir: '/workspace/.scratch/dispatch-skills/20261001T0000Z-my-impl',
    path: 'custom/my.plan.md',
  }));
  assert.equal(explicit.state.tag, 'starting');
  if (explicit.state.tag === 'starting') {
    assert.equal(explicit.state.c.planPath, 'custom/my.plan.md');
  }
});


function parsedForSpec(parent?: string, own = false) {
 let r = step(initialImplement(), run({ path: 'x.plan.md' }));
 r = step(r.state, { type: 'SNAPSHOT', effectId: effectOf(r.effects, 'snapshot').id, fingerprint: FP, diff: { paths: [] } });
 if (own) {
 r = step(r.state, { type: 'EFFECT_FAILED', effectId: effectOf(r.effects, 'parse-artifact').id, cls: 'io', detail: 'not found' });
 r = step(r.state, { type: 'AUTHORED', path: 'x.plan.md' });
 }
 return step(r.state, { type: 'ARTIFACT_PARSED', effectId: effectOf(r.effects, 'parse-artifact').id, kind: 'plan', hash: HASH, parsed: { ...PLAN, box: { ...PLAN.box, ...(parent ? { Parent: parent } : {}) } }, defects: [], governing: { pinned: HASH, current: 'sha256:' + 'b'.repeat(64), design: parent ? 'x.design.md' : null, reqIds: [] } });
}
// SECTION: Spec revisions and re-authoring

test('spec revision stops an authored plan after task ledger initialization', () => {
 const parsed = parsedForSpec(undefined, true); assert.ok('c' in parsed.state && parsed.state.c);
 for (const phase of ['tasks', 'delivered'] as const) {
 const c: Context = { ...parsed.state.c, phase, levelGatePassed: true };
 const result = step({ ...parsed.state, c }, { type: 'SPEC_SETTLED', path: 'x.spec.md', hash: HASH });
 assert.equal(result.state.tag, 'stopped'); assert.ok('c' in result.state && result.state.c);
 assert.equal(result.state.c.tasks, c.tasks); assert.equal(result.state.c.integration, c.integration);
 assert.deepEqual(result.effects, []);
 }
});
test('spec revision after accepted task preserves ledger and refuses task addition', () => {
 const begun = startTasks(1); const launched = launch(begun.result, {}, begun.trace);
 const accepted = submit(launched, 'T1', {}, begun.trace);
 assert.ok('c' in accepted.state && accepted.state.c); const c = { ...accepted.state.c, planAuthoredHere: true };
 assert.equal(c.tasks['T1']?.status, 'accepted');
 const stopped = step({ ...accepted.state, c }, { type: 'SPEC_SETTLED', path: 'x.spec.md', hash: HASH });
 assert.ok(stopped.state.tag === 'stopped'); assert.equal(stopped.state.code, 'stale-spec');
 assert.equal(stopped.state.c.tasks, c.tasks); assert.equal(stopped.state.c.plan, c.plan); assert.equal(stopped.state.c.integration, c.integration);
 const proposed = step(stopped.state, { type: 'AUTHORED', path: 'plan-with-additional-task.plan.md' });
 assert.equal(proposed.state, stopped.state); assert.deepEqual(proposed.effects, []);
});
test('invalid increment parse retains resolved ancestor through settlement', () => {
 let r = step(initialImplement(), run({ path: 'x.plan.md' }));
 r = step(r.state, { type: 'SNAPSHOT', effectId: effectOf(r.effects, 'snapshot').id, fingerprint: FP, diff: { paths: [] } });
 r = step(r.state, { type: 'ARTIFACT_PARSED', effectId: effectOf(r.effects, 'parse-artifact').id, kind: 'plan', hash: HASH, parsed: {}, defects: [{ code: 'missing-satisfies' }], governing: { pinned: HASH, current: 'sha256:' + 'b'.repeat(64), design: 'x.design.md', reqIds: [] } });
 assert.equal(r.state.tag, 'parsing');
 const stopped = step(r.state, { type: 'SPEC_SETTLED', path: 'x.spec.md', hash: HASH });
 assert.ok(stopped.state.tag === 'stopped'); assert.equal(stopped.state.code, 'stale-design-spec');
});
test('implement respec: stops increment or existing plan, and re-authors own plan', () => {
 for (const [name, parent, own, expected] of [
  ['stops increment plan', '`x.design.md` · I01', false, 'stopped'], ['stops existing plan', undefined, false, 'stopped'], ['re-authors own plan', undefined, true, 'author'],
 ] as const) {
  const parsed = parsedForSpec(parent, own); assert.equal(parsed.state.tag, 'parsing'); assert.deepEqual(parsed.effects, []);
  const result = step(parsed.state, { type: 'SPEC_SETTLED', path: 'x.spec.md', hash: 'sha256:' + 'b'.repeat(64) });
  assert.equal(result.state.tag, expected, name);
  if (result.state.tag === 'stopped') assert.equal(result.state.code, parent ? 'stale-design-spec' : 'stale-spec', name);
  if (result.state.tag === 'author') assert.equal(result.state.c.specEpoch, 1, name);
 }
});
test('implement start halts on unreadable design pin or design without spec pin', () => {
 for (const [name, detail] of [['unreadable design pin', 'design pin target unreadable: x.design.md not found'], ['design without spec pin', 'x.design.md has no spec pin']] as const) {
  let r = step(initialImplement(), run({ path: 'x.plan.md' })); r = step(r.state, { type: 'SNAPSHOT', effectId: effectOf(r.effects, 'snapshot').id, fingerprint: FP, diff: { paths: [] } });
  r = step(r.state, { type: 'EFFECT_FAILED', effectId: effectOf(r.effects, 'parse-artifact').id, cls: 'io', detail });
  assert.equal(r.state.tag, 'stopped', name); assert.equal(r.state.tag === 'stopped' && r.state.code, 'stale-design-spec', name); assert.deepEqual(r.effects, []);
 }
});
test('implement start proceeds with current spec pin', () => {
 const identity = { path: 'x.spec.md', hash: HASH };
 let result = beginImplement({ ...run({ path: 'x.plan.md', settledPlan: { path: 'x.plan.md', hash: HASH, outcome: 'settled' } }), argument: 'x.plan.md' }, identity);
 result = step(result.state, { type: 'SNAPSHOT', effectId: effectOf(result.effects, 'snapshot').id, fingerprint: FP, diff: { paths: [] } });
 const effect = effectOf(result.effects, 'parse-artifact'); assert.ok(effect.kind === 'parse-artifact' && 'governing' in effect && effect.governing === identity.path);
 result = step(result.state, { type: 'ARTIFACT_PARSED', effectId: effect.id, kind: 'plan', hash: HASH, parsed: PLAN, defects: [], governing: { pinned: HASH, current: HASH, design: null, reqIds: [] } });
 assert.equal(result.state.tag, 'baseline-preflight'); assert.equal(result.effects[0]?.kind, 'snapshot');
});
test('implement re-authored plan keeps earlier review history', () => {
 const old = parsedForSpec(undefined, true); const author = step(old.state, { type: 'SPEC_SETTLED', path: 'x.spec.md', hash: HASH });
 let r = step(author.state, { type: 'AUTHORED', path: 'x.plan.md' });
 r = step(r.state, { type: 'ARTIFACT_PARSED', effectId: effectOf(r.effects, 'parse-artifact').id, kind: 'plan', hash: HASH, parsed: PLAN, defects: [] });
 assert.ok(r.state.tag === 'plan-review'); assert.equal(r.effects[0]?.id, 'implement.plan-review.s1.parse-artifact.1');
 const files = new Map<string, string>([['x.plan.md', '# Plan\n']]);
 const ports = { fs: { exists: (file: string) => files.has(file), readText: (file: string) => files.get(file)!, writeAtomic: (file: string, text: string) => files.set(file, text) } } as unknown as Ports;
 for (const [path, marker] of [['implement.plan-review', 'Earlier finding'], ['implement.plan-review.s1', 'Later finding']]) {
   const begun = beginReview({ kind: 'plan', target: 'x.plan.md', cap: 1, breadth: 1, context: '', roster: [], timeoutMs: 1000 }, path!, {}); assert.ok('c' in begun.state);
   const review = stepReview({ tag: 'rule', c: { ...begun.state.c, round: 1, rounds: [{ round: 1, scope: 'full', reviewers: ['reader'], failed: [] }], findings: [{ id: 'R1-F001', round: 1, status: 'open', severity: 'SHOULD', category: 'correctness', locus: 'x.plan.md:L1', defect: marker!, requiredChange: 'Keep the invariant.', sources: ['reader'], scope: 'in' }] } }, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'reject', reason: marker + ' ruling' } } }).state;
   rootMachine.render!({ tag: 'implement', run: { verb: 'implement', argument: 'x.plan.md', slug: 'x' }, child: { ...r.state, c: { ...r.state.c, planReview: review }, review } }, ports, '/session/.state/runs/run');
 }
 const log = files.get('x.review-log.md') ?? '';
 for (const marker of ['Earlier finding', 'Later finding', 'Earlier finding ruling', 'Later finding ruling', 'plan-review.s1']) assert.ok(log.includes(marker), marker);
});

test('author quality reads match the shared consumer map for nested plan', () => {
  const binding = { path: 'x.design.md', revision: HASH, increment: 'I01', contract: {}, paths: ['src/a.ts'], approval: { by: 'user' as const, quote: 'Approved', hash: HASH }, repair: [] };
  const initial = beginBoundImplement(run(), binding, {});
  assert.equal(initial.state.tag, 'starting');
  const state = step(initial.state, { type: 'SNAPSHOT', effectId: initial.effects[0]!.id, fingerprint: FP, diff: { paths: [] } }).state;
  assert.equal(state.tag, 'author');
  assert.deepEqual(implementData(state), { artifact: 'plan', path: 'implement-example.plan.md', template: 'references/templates/plan.md', read: [{ path: 'references/templates/quality-bar.md', sections: qualitySections.plan }] });
});
