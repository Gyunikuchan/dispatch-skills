import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effect, Event, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { implementData, initialImplement, stepImplement, validateImplement } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { settledPlanInput, writerConfig } from '../../../skills/dispatch/scripts/machines/implement-types.ts';
import { reviewSpecFromRun } from '../../../skills/dispatch/scripts/machines/review.ts';

const HASH = `sha256:${'a'.repeat(64)}`;
const FP = { head: 'head', index: 'index', worktree: 'tree' };
const PLAN = {
  title: 'Implement example', box: { 'TL;DR': 'Deliver example' }, keyDecisions: [],
  criteria: [{ id: 'SC1', title: 'Example works', line: 1, changes: ['src/example.ts'], verify: [{ command: 'node --test tests/example.test.ts', final: false }], evidence: 'verify', preExisting: false, redException: null, testRationale: null, review: null, enforcementInfeasibility: null }],
  changes: [{ action: 'MODIFY', path: 'src/example.ts', note: 'Add behavior', command: null, line: 1 }],
  verification: { automated: ['node --test tests/example.test.ts'], none: null, manual: [] }, tasks: [], finalCommands: [], traceability: null, governedText: '# plan',
};
const run = (overrides: Record<string, unknown> = {}): RunStartedEvent => ({
  type: 'RUN_STARTED', verb: 'implement', argument: 'Implement example', level: 'low', levelSource: 'explicit', pins: null, fix: false,
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
  let result = step(state, { type: 'VERIFY_DONE', effectId, purpose: 'baseline', results: [{ command: 'node --test tests/example.test.ts', exit, logPath: 'baseline.log', failureId, failedTests: [], diagnostic: 'baseline', loadError: false, inputFingerprint: 'input' }], fingerprint: after });
  state = result.state;
  const snapshot = effectOf(result.effects, 'snapshot');
  result = step(state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: after, diff: { paths: [] } });
  return result.state;
}

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

test('implement-baseline-known-red: records failure identities, requires the full set, and checks side effects', () => {
  const { state, effect } = atBaseline();
  const decision = toDecision(state, effect.id, 2, 'node --test tests/example.test.ts::test:old failure');
  assert.equal(decision.tag, 'baseline-decision');
  if (decision.tag !== 'baseline-decision') return;
  assert.match(validateImplement(decision, { type: 'DECISION', kind: 'baseline', answer: { action: 'accept-known-red', ids: [] } }) ?? '', /every distinct baseline failure/);
  const accepted = step(decision, { type: 'DECISION', kind: 'baseline', answer: { action: 'accept-known-red', ids: ['node --test tests/example.test.ts::test:old failure'] } });
  assert.equal(accepted.state.tag, 'approval');

  const sideEffect = toDecision(state, effect.id, 0, null, { ...FP, worktree: 'changed' });
  assert.equal(sideEffect.tag, 'assessing-host-event');
});

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
  const classified = step(allowed.state, { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'low', rationale: 'One bounded local behavior change.', gateScope: implementData(allowed.state)['gateScope'] } });
  assert.equal(classified.state.tag, 'task-checkout');
});

function classifyExplicitRun(choice: 'adopt' | 'retain') {
  const { state, effect } = atBaseline();
  let result = toDecision(state, effect.id);
  assert.equal(result.tag, 'approval');
  result = step(result, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } }).state;
  assert.equal(result.tag, 'level-classification');
  if (result.tag !== 'level-classification') throw new Error('level-classification');
  const gateScope = implementData(result)['gateScope'];
  result = step(result, { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'medium', rationale: 'The bounded integration has meaningful uncertainty, but failures remain observable and recoverable.', gateScope } }).state;
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
  let result = step(gate, { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'medium', rationale: 'The change crosses task boundaries but remains observable and recoverable.', gateScope: implementData(gate)['gateScope'] } });
  assert.equal(result.state.tag, 'level-recommendation');
  if (result.state.tag !== 'level-recommendation') return;
  result = step(result.state, { type: 'DECISION', kind: 'level-recommendation', answer: { choice: 'adopt', quote: 'Adopt medium.' } });
  assert.equal(result.state.tag, 'task-checkout');
  if (result.state.tag !== 'task-checkout') return;
  assert.equal(result.state.c.run.level, 'medium');
  assert.deepEqual(result.state.c.writer?.models, ['writer-medium']);
  const review = reviewSpecFromRun(result.state.c.run, 'code', 'fix', 'plans/example.plan.md');
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
    const result = step(gate, { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel, rationale: 'The evidence fits within the explicit ceiling.', gateScope: implementData(gate)['gateScope'] } });
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
    const result = step(gate, { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'high', rationale: 'The classification is below the explicit advanced level.', gateScope: implementData(gate)['gateScope'] } });
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
  const result = step(gate, { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'medium', rationale: 'The bounded work does not require the requested ceiling.', gateScope: implementData(gate)['gateScope'] } });
  assert.equal(result.state.tag, 'task-checkout');
  if (result.state.tag === 'task-checkout') {
    assert.equal(result.state.c.run.level, 'high');
    assert.equal(result.state.c.writer?.models[0], 'writer-high');
    const review = reviewSpecFromRun(result.state.c.run, 'code', 'fix', 'plans/example.plan.md');
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

