import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effect, Event, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { initialImplement, stepImplement, validateImplement } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { settledPlanInput, writerConfig } from '../../../skills/dispatch/scripts/machines/implement-types.ts';

const HASH = `sha256:${'a'.repeat(64)}`;
const FP = { head: 'head', index: 'index', worktree: 'tree' };
const PLAN = {
  title: 'Implement example', box: { 'TL;DR': 'Deliver example' }, keyDecisions: [],
  criteria: [{ id: 'SC1', title: 'Example works', line: 1, changes: ['src/example.ts'], verify: [{ command: 'node --test tests/example.test.ts', final: false }], evidence: 'verify', preExisting: false, redException: null, testRationale: null, review: null, enforcementInfeasibility: null }],
  changes: [{ action: 'MODIFY', path: 'src/example.ts', note: 'Add behavior', command: null, line: 1 }],
  verification: { automated: ['node --test tests/example.test.ts'], none: null, manual: [] }, finalCommands: [], traceability: null, governedText: '# plan',
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

function atBaseline(overrides: Record<string, unknown> = {}) {
  let state = initialImplement();
  let result = step(state, run({ path: 'plans/example.plan.md', settledPlan: { path: 'plans/example.plan.md', hash: HASH, outcome: 'settled' }, ...overrides }));
  state = result.state;
  let effect = effectOf(result.effects, 'snapshot');
  result = step(state, { type: 'SNAPSHOT', effectId: effect.id, fingerprint: FP, diff: { paths: [] } });
  state = result.state;
  effect = effectOf(result.effects, 'parse-artifact');
  result = step(state, { type: 'ARTIFACT_PARSED', effectId: effect.id, kind: 'plan', hash: HASH, parsed: PLAN, defects: [] });
  state = result.state;
  assert.equal(state.tag, 'baseline-preflight');
  effect = effectOf(result.effects, 'snapshot');
  result = step(state, { type: 'SNAPSHOT', effectId: effect.id, fingerprint: FP, diff: { paths: [] } });
  state = result.state;
  return { state, effect: effectOf(result.effects, 'verify') };
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
  assert.equal(sideEffect.tag, 'failure-snapshot');
});

test('implement-approval-by-quote: blocks writing until a user-attributed by and quote are supplied', () => {
  const { state, effect } = atBaseline();
  const approval = toDecision(state, effect.id);
  assert.equal(approval.tag, 'approval');
  assert.match(validateImplement(approval, { type: 'DECISION', kind: 'approval', answer: { by: 'user' } }) ?? '', /by and quote/);
  const denied = step(approval, { type: 'DECISION', kind: 'approval', answer: { by: 'user' } });
  assert.equal(denied.state.tag, 'approval');
  const allowed = step(approval, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } });
  assert.equal(allowed.state.tag, 'writing-brief');
});

test('writer configuration resolves sparse levels and rejects malformed cascades', () => {
  assert.deepEqual(writerConfig({ 'write-subagents': { claude: { high: { model: ['a', 'b'], effort: 'high' } } } }, 'claude', 'medium'), { ok: true, value: { models: ['a', 'b'], effort: 'high' } });
  assert.equal(writerConfig({ 'write-subagents': { claude: { low: { model: ['a', 'a'] } } } }, 'claude', 'low').ok, false);
  assert.equal(writerConfig({ 'write-subagents': { claude: { low: { model: ['a', null] } } } }, 'claude', 'low').ok, false);
});
