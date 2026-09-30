import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effect, Event, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { initialImplement, stepImplement, validateImplement } from '../../../skills/dispatch/scripts/machines/implement.ts';

const HASH = `sha256:${'a'.repeat(64)}`;
const FP = { head: 'head', index: 'index', worktree: 'tree' };
const PATH = 'plans/example.plan.md';
const PLAN = {
  title: 'Example', box: { 'TL;DR': 'Implement it' }, keyDecisions: [],
  criteria: [{ id: 'SC1', title: 'It works', line: 1, changes: ['src/example.ts'], verify: [{ command: 'node --test tests/example.test.ts', final: false }], evidence: 'verify', preExisting: false, redException: null, testRationale: null, review: null, enforcementInfeasibility: null }],
  changes: [{ action: 'MODIFY', path: 'src/example.ts', note: 'Implement behavior', command: null, line: 1 }],
  verification: { automated: ['node --test tests/example.test.ts'], none: null, manual: [] }, finalCommands: [], traceability: null, governedText: '# Example',
};
const started = (): RunStartedEvent => ({ type: 'RUN_STARTED', verb: 'implement', argument: PATH, level: 'low', levelSource: 'explicit', pins: null, fix: false, orchestrator: 'claude', orchestratorModel: null,
  overrides: { settledPlan: { path: PATH, hash: HASH, outcome: 'settled' } }, repo: {}, config: { 'write-subagents': { claude: { low: { model: ['writer-a', 'writer-b'] } } }, 'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } }, phases: { 'plan-review': { rounds: { low: 1 }, targets: { low: 1 } }, 'code-review': { rounds: { low: 1 }, targets: { low: 1 } } } } });
const step = (state: ReturnType<typeof initialImplement>, event: Event) => stepImplement(state, event);
function getEffect(effects: readonly Effect[], kind: Effect['kind']): Effect {
  const result = effects.find((item) => item.kind === kind);
  assert.ok(result, `expected ${kind}`);
  return result;
}
function productionWriter() {
  let result = step(initialImplement(), started());
  let snapshot = getEffect(result.effects, 'snapshot');
  result = step(result.state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: FP, diff: { paths: [] } });
  const parse = getEffect(result.effects, 'parse-artifact');
  result = step(result.state, { type: 'ARTIFACT_PARSED', effectId: parse.id, kind: 'plan', hash: HASH, parsed: PLAN, defects: [] });
  snapshot = getEffect(result.effects, 'snapshot');
  result = step(result.state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: FP, diff: { paths: [] } });
  const baseline = getEffect(result.effects, 'verify');
  result = step(result.state, { type: 'VERIFY_DONE', effectId: baseline.id, purpose: 'baseline', results: [{ command: 'node --test tests/example.test.ts', exit: 0, logPath: 'baseline.log', failedTests: [], failureId: null, diagnostic: '', loadError: false, inputFingerprint: 'base' }], fingerprint: FP });
  snapshot = getEffect(result.effects, 'snapshot');
  result = step(result.state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: FP, diff: { paths: [] } });
  result = step(result.state, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } });
  const brief = getEffect(result.effects, 'write-brief');
  result = step(result.state, { type: 'BRIEF_READY', effectId: brief.id, stage: 'production', path: 'run/production.md', sha256: HASH, envelopePath: 'run/production-outcome.json' });
  snapshot = getEffect(result.effects, 'snapshot');
  result = step(result.state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: FP, diff: { paths: [] } });
  return result;
}
function checked(state: ReturnType<typeof initialImplement>, envelope: Record<string, unknown>, paths: string[] = ['src/example.ts']) {
  assert.equal(state.tag, 'write');
  if (state.tag !== 'write') return step(state, { type: 'AUTHORED', path: '' });
  const invalidPath = validateImplement(state, { type: 'WRITE_ENVELOPE', envelopePath: 'other.json' });
  assert.match(invalidPath ?? '', /exact path/);
  let result = step(state, { type: 'WRITE_ENVELOPE', envelopePath: state.info.envelopePath });
  const effect = getEffect(result.effects, 'check-envelope');
  result = step(result.state, { type: 'ENVELOPE_CHECKED', effectId: effect.id, envelope, defects: [], diff: { paths } });
  return result;
}
const productionEnvelope = (status: 'DONE' | 'DONE_WITH_CONCERNS' = 'DONE') => ({
  schemaVersion: 1, status, stage: 'COMPLETE', summary: 'Implemented behavior',
  evidence: ['CRITERION SC1 | src/example.ts | rejects an invalid value'], ...(status === 'DONE_WITH_CONCERNS' ? { concerns: ['Existing API remains synchronous.'] } : {}),
});

test('implement-writer-cascade: configured aliases advance without consuming another attempt', () => {
  const result = productionWriter();
  assert.equal(result.state.tag, 'write');
  if (result.state.tag !== 'write') return;
  assert.equal(result.state.info.attempt, 1);
  assert.equal(validateImplement(result.state, { type: 'WRITE_FAILED', model: 'wrong-model', kind: 'quota', reason: 'no capacity' }), 'event.model: expected the current configured model id.');
  let failed = step(result.state, { type: 'WRITE_FAILED', model: 'writer-a', kind: 'quota', reason: 'no capacity' });
  assert.equal(failed.state.tag, 'cascade-snapshot');
  const snapshot = getEffect(failed.effects, 'snapshot');
  failed = step(failed.state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: FP, diff: { paths: [] } });
  assert.equal(failed.state.tag, 'write');
  if (failed.state.tag === 'write') assert.deepEqual([failed.state.info.modelIndex, failed.state.info.attempt], [1, 1]);
});

test('implement-attempt-bound: terminal failures and edited attempts stop the writer cascade', () => {
  const result = productionWriter();
  if (result.state.tag !== 'write') return assert.fail('write state expected');
  let failed = step(result.state, { type: 'WRITE_FAILED', model: 'writer-a', kind: 'sandbox-unsupported', reason: 'isolation unavailable' });
  const snapshot = getEffect(failed.effects, 'snapshot');
  failed = step(failed.state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: FP, diff: { paths: [] } });
  assert.equal(failed.state.tag, 'failure-snapshot');

  let changed = step(result.state, { type: 'WRITE_FAILED', model: 'writer-a', kind: 'quota', reason: 'quota' });
  const check = getEffect(changed.effects, 'snapshot');
  changed = step(changed.state, { type: 'SNAPSHOT', effectId: check.id, fingerprint: { ...FP, worktree: 'mutated' }, diff: { paths: ['src/example.ts'] } });
  assert.equal(changed.state.tag, 'failure-snapshot');
});

test('envelope stage and changed paths are bound to the current production frame', () => {
  const result = productionWriter();
  if (result.state.tag !== 'write') return assert.fail('write state expected');
  const wrong = checked(result.state, { schemaVersion: 1, status: 'DONE', stage: 'RED_READY', summary: 'wrong stage', evidence: [] });
  assert.equal(wrong.state.tag, 'failure-snapshot');

  const outside = checked(result.state, productionEnvelope(), ['src/example.ts', 'README.md']);
  assert.equal(outside.state.tag, 'failure-snapshot');
});

test('writer concerns require a quoted user ruling and remain recorded for completion', () => {
  let result = productionWriter();
  if (result.state.tag !== 'write') return assert.fail('write state expected');
  result = checked(result.state, productionEnvelope('DONE_WITH_CONCERNS'));
  assert.equal(result.state.tag, 'snapshot-after-write');
  if (result.state.tag !== 'snapshot-after-write') return;
  const snapshot = getEffect(result.effects, 'snapshot');
  result = step(result.state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: { ...FP, worktree: 'changed' }, diff: { paths: ['src/example.ts'] } });
  assert.equal(result.state.tag, 'scoped-snapshot');
  if (result.state.tag !== 'scoped-snapshot') return;
  const scopedSnapshot = getEffect(result.effects, 'snapshot');
  result = step(result.state, { type: 'SNAPSHOT', effectId: scopedSnapshot.id, fingerprint: { ...FP, worktree: 'changed' }, diff: { paths: [] } });
  const verify = getEffect(result.effects, 'verify');
  result = step(result.state, { type: 'VERIFY_DONE', effectId: verify.id, purpose: 'scoped', results: [{ command: 'node --test tests/example.test.ts', exit: 0, logPath: 'scoped.log', failedTests: [], failureId: null, diagnostic: '', loadError: false, inputFingerprint: 'scope' }], fingerprint: { ...FP, worktree: 'changed' } });
  assert.equal(result.state.tag, 'evidence');
  if (result.state.tag !== 'evidence') return;
  result = step(result.state, { type: 'EVIDENCE', criteria: { SC1: { outcome: 'pass', evidence: 'test passed' } } });
  assert.equal(result.state.tag, 'concerns');
  if (result.state.tag !== 'concerns') return;
  assert.match(validateImplement(result.state, { type: 'DECISION', kind: 'concerns', answer: { decision: 'accept', by: 'user' } }) ?? '', /by, and quote/);
  const accepted = step(result.state, { type: 'DECISION', kind: 'concerns', answer: { decision: 'accept', by: 'user', quote: 'Accept this limitation' } });
  assert.equal(accepted.state.tag, 'code-review');
  if (accepted.state.tag === 'code-review') assert.deepEqual(accepted.state.c.concernRulings['Existing API remains synchronous.'], { decision: 'accept', by: 'user', quote: 'Accept this limitation' });
});

test('production acceptance preserves earlier tests-only writer concerns', () => {
  const initial = productionWriter();
  assert.equal(initial.state.tag, 'write');
  if (initial.state.tag !== 'write') return;
  const state = { ...initial.state, c: { ...initial.state.c, concerns: ['Tests need a later portability check.'] } };
  const result = checked(state, productionEnvelope());
  assert.ok('c' in result.state && result.state.c);
  if ('c' in result.state && result.state.c) assert.deepEqual(result.state.c.concerns, ['Tests need a later portability check.']);
});
