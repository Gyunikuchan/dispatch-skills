import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effect, Event, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import type { PlanCriterion } from '../../../skills/dispatch/scripts/domain/types.ts';
import { initialImplement, stepImplement } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { parseRedMatrix } from '../../../skills/dispatch/scripts/machines/implement-types.ts';

const HASH = `sha256:${'a'.repeat(64)}`;
const FP = { head: 'head', index: 'index', worktree: 'tree' };
const RED: PlanCriterion = { id: 'SC1', title: 'Behavior works', line: 1, changes: ['src/feature.ts', 'tests/feature.test.ts'], verify: [{ command: 'node --test tests/all.test.ts', final: false }], evidence: 'red', preExisting: false, redException: null, testRationale: 'must reject invalid input', review: null, enforcementInfeasibility: null };
const PLAN = {
  title: 'Feature', box: { 'TL;DR': 'Add feature' }, keyDecisions: [], criteria: [RED],
  changes: [{ action: 'MODIFY', path: 'src/feature.ts', note: 'Feature implementation', command: null, line: 1 }, { action: 'NEW', path: 'tests/feature.test.ts', note: 'Behavior tests', command: null, line: 2 }],
  verification: { automated: ['node --test tests/all.test.ts'], none: null, manual: [] }, finalCommands: [], traceability: null, governedText: '# Feature',
};
const run = (preExisting = false): RunStartedEvent => ({
  type: 'RUN_STARTED', verb: 'implement', argument: 'plans/feature.plan.md', level: 'low', levelSource: 'explicit', pins: null, fix: false,
  orchestrator: 'claude', orchestratorModel: null, overrides: { settledPlan: { path: 'plans/feature.plan.md', hash: HASH, outcome: 'settled' } }, repo: {},
  config: { 'write-subagents': { claude: { low: { model: ['writer-a', 'writer-b'] } } }, 'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } }, phases: { 'plan-review': { rounds: { low: 1 }, targets: { low: 1 } }, 'code-review': { rounds: { low: 1 }, targets: { low: 1 } } } },
});
const drive = (state: ReturnType<typeof initialImplement>, event: Event) => {
  const result = stepImplement(state, event);
  if (result.state.tag !== 'checking-host-event') return result;
  assert.equal(result.effects[0]?.kind, 'snapshot');
  return stepImplement(result.state, { type: 'SNAPSHOT', effectId: result.state.effectId, fingerprint: result.state.c.lastFingerprint ?? FP, diff: { paths: [] } });
};
function effect(effects: readonly Effect[], kind: Effect['kind']): Effect {
  const found = effects.find((item) => item.kind === kind);
  assert.ok(found, `missing ${kind} effect`);
  return found;
}
function toRedWriter(preExisting = false, baselineFailure = false, redException = false) {
  const plan = { ...PLAN, criteria: [{ ...RED, preExisting, redException: redException ? 'External invariant prevents a meaningful failing state.' : null }] };
  let result = drive(initialImplement(), run(preExisting));
  let snapshot = effect(result.effects, 'snapshot');
  result = drive(result.state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: FP, diff: { paths: [] } });
  const parse = effect(result.effects, 'parse-artifact');
  result = drive(result.state, { type: 'ARTIFACT_PARSED', effectId: parse.id, kind: 'plan', hash: HASH, parsed: plan, defects: [] });
  snapshot = effect(result.effects, 'snapshot');
  result = drive(result.state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: FP, diff: { paths: [] } });
  const baseline = effect(result.effects, 'verify');
  const failureId = baselineFailure ? 'node --test tests/all.test.ts::test:rejects bad input' : null;
  result = drive(result.state, { type: 'VERIFY_DONE', effectId: baseline.id, purpose: 'baseline', results: [{ command: 'node --test tests/all.test.ts', exit: baselineFailure ? 1 : 0, logPath: 'baseline.log', failureId, failedTests: baselineFailure ? ['test:rejects bad input'] : [], diagnostic: 'baseline', loadError: false, inputFingerprint: 'base' }], fingerprint: FP });
  snapshot = effect(result.effects, 'snapshot');
  result = drive(result.state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: FP, diff: { paths: [] } });
  if (baselineFailure) result = drive(result.state, { type: 'DECISION', kind: 'baseline', answer: { action: 'accept-known-red', ids: [failureId] } });
  result = drive(result.state, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } });
  if (redException) return result;
  const brief = effect(result.effects, 'write-brief');
  result = drive(result.state, { type: 'BRIEF_READY', effectId: brief.id, stage: 'tests-only', path: 'run/tests-brief.md', sha256: HASH, envelopePath: 'run/tests-outcome.json' });
  snapshot = effect(result.effects, 'snapshot');
  result = drive(result.state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: FP, diff: { paths: [] } });
  return result;
}
function admit(result: ReturnType<typeof drive>, evidence: string[]) {
  assert.equal(result.state.tag, 'write');
  if (result.state.tag !== 'write') return result;
  const paths = result.state.info.stage === 'tests-only' ? ['tests/feature.test.ts'] : ['src/feature.ts', 'tests/feature.test.ts'];
  const checked = effect(drive(result.state, { type: 'WRITE_ENVELOPE', envelopePath: result.state.info.envelopePath }).effects, 'check-envelope');
  let next = drive(result.state, { type: 'WRITE_ENVELOPE', envelopePath: result.state.info.envelopePath });
  next = drive(next.state, { type: 'ENVELOPE_CHECKED', effectId: checked.id, envelope: { schemaVersion: 1, status: 'DONE', stage: 'RED_READY', summary: 'Tests added', evidence }, defects: [], diff: { paths } });
  return next;
}
function runRed(result: ReturnType<typeof drive>, options: { exit: number; failedTests: string[]; loadError?: boolean; failureId: string | null }) {
  if (result.state.tag !== 'snapshot-after-write') throw new Error('accepted RED matrix expected');
  const before = effect(result.effects, 'snapshot');
  result = drive(result.state, { type: 'SNAPSHOT', effectId: before.id, fingerprint: { ...FP, worktree: 'tests' }, diff: { paths: ['tests/feature.test.ts'] } });
  if (result.state.tag !== 'red-verify') throw new Error('RED verification expected');
  const verify = effect(result.effects, 'verify');
  if (verify.kind !== 'verify') throw new Error('verify effect expected');
  const command = String(verify.commands[0]?.['command']);
  return drive(result.state, { type: 'VERIFY_DONE', effectId: verify.id, purpose: 'red', results: [{ command, exit: options.exit, logPath: 'red.log', failureId: options.failureId, failedTests: options.failedTests, diagnostic: '', loadError: options.loadError ?? false, inputFingerprint: 'red' }], fingerprint: { ...FP, worktree: 'tests' } });
}

test('RED matrix requires exactly one expected asserted failure row per active criterion and a declared test path', () => {
  const criteria = [RED];
  assert.deepEqual(parseRedMatrix(['RED-MATRIX SC1 | tests/feature.test.ts:rejects bad input | exit 1 test:rejects bad input'], criteria).defects, []);
  assert.ok(parseRedMatrix(['RED-MATRIX SC1 | src/feature.ts:rejects bad input | exit 1 test:rejects bad input'], criteria).defects.some((defect) => /approved test file/.test(defect)));
  assert.ok(parseRedMatrix([], criteria).defects.some((defect) => /Exactly one/.test(defect)));
  assert.ok(parseRedMatrix(['RED-MATRIX SC1 | tests/feature.test.ts:one | exit 1 test:one', 'RED-MATRIX SC1 | tests/feature.test.ts:two | exit 1 test:two'], criteria).defects.some((defect) => /Exactly one/.test(defect)));
});

test('tests-only writer is restricted to approved test paths and a valid matrix gets narrowly mapped RED commands', () => {
  const result = toRedWriter();
  assert.equal(result.state.tag, 'write');
  if (result.state.tag !== 'write') return;
  assert.deepEqual(result.state.info.stage, 'tests-only');
  assert.deepEqual(result.state.info.models, ['writer-a', 'writer-b']);
  const data = result.state.c.plan?.changes.map((change) => change.path) ?? [];
  assert.deepEqual(data, ['src/feature.ts', 'tests/feature.test.ts']);
  const admitted = admit(result, ['RED-MATRIX SC1 | tests/feature.test.ts:rejects bad input | exit 1 test:rejects bad input']);
  assert.equal(admitted.state.tag, 'snapshot-after-write');
  if (admitted.state.tag !== 'snapshot-after-write') return;
  const red = runRed(admitted, { exit: 1, failedTests: ['test:rejects bad input'], failureId: 'red::test:rejects bad input' });
  assert.equal(red.state.tag, 'writing-brief');
  if (red.state.tag === 'writing-brief') assert.equal(red.state.stage, 'production');
});

test('implement-attempt-bound: one malformed RED matrix gets one same-model repair without broadening paths', () => {
  let result = toRedWriter();
  let repaired = admit(result, ['not a matrix']);
  assert.equal(repaired.state.tag, 'writing-brief');
  if (repaired.state.tag !== 'writing-brief') return;
  let brief = effect(repaired.effects, 'write-brief');
  assert.equal(brief.kind, 'write-brief');
  repaired = drive(repaired.state, { type: 'BRIEF_READY', effectId: brief.id, stage: 'tests-only', path: 'run/repair.md', sha256: HASH, envelopePath: 'run/repair-outcome.json' });
  let snapshot = effect(repaired.effects, 'snapshot');
  repaired = drive(repaired.state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: FP, diff: { paths: [] } });
  assert.equal(repaired.state.tag, 'write');
  if (repaired.state.tag !== 'write') return;
  assert.equal(repaired.state.info.attempt, 2);
  assert.deepEqual(repaired.state.info.models, ['writer-a']);
  const again = admit(repaired, ['still not a matrix']);
  assert.equal(again.state.tag, 'failure-snapshot');
});

test('implement-red-gate: repairs load errors and rejects collisions unless Pre-existing is yes', () => {
  const ordinary = toRedWriter(false);
  const matrix = admit(ordinary, ['RED-MATRIX SC1 | tests/feature.test.ts:rejects bad input | exit 1 test:rejects bad input']);
  let red = runRed(matrix, { exit: 1, failedTests: [], failureId: 'red::load-error', loadError: true });
  assert.equal(red.state.tag, 'writing-brief');
  if (red.state.tag === 'writing-brief') assert.deepEqual(red.state.modelLimit, ['writer-a']);

  const collision = toRedWriter(false, true);
  const colliding = admit(collision, ['RED-MATRIX SC1 | tests/feature.test.ts:rejects bad input | exit 1 test:rejects bad input']);
  const collisionVerify = runRed(colliding, { exit: 1, failureId: 'red::test:rejects bad input', failedTests: ['test:rejects bad input'] });
  assert.equal(collisionVerify.state.tag, 'writing-brief');

  const exempt = toRedWriter(true, true);
  const accepted = admit(exempt, ['RED-MATRIX SC1 | tests/feature.test.ts:rejects bad input | exit 1 test:rejects bad input']);
  assert.equal(accepted.state.tag, 'snapshot-after-write');
  const exemptVerify = runRed(accepted, { exit: 1, failureId: 'red::test:rejects bad input', failedTests: ['test:rejects bad input'] });
  assert.equal(exemptVerify.state.tag, 'writing-brief');
  if (exemptVerify.state.tag === 'writing-brief') assert.equal(exemptVerify.state.stage, 'production');
});

test('RED exceptions require an attributed ruling and skip the tests-only stage', () => {
  const result = toRedWriter(false, false, true);
  assert.equal(result.state.tag, 'needs-user');
  if (result.state.tag !== 'needs-user') return;
  const bad = drive(result.state, { type: 'DECISION', kind: 'needs-user', answer: { decision: 'accept', by: 'user' } });
  assert.equal(bad.state.tag, 'needs-user');
  const accepted = drive(result.state, { type: 'DECISION', kind: 'needs-user', answer: { decision: 'accept', by: 'user', quote: 'Accept the external invariant' } });
  assert.equal(accepted.state.tag, 'writing-brief');
  if (accepted.state.tag === 'writing-brief') assert.equal(accepted.state.stage, 'production');
});

test('an un-narrowable RED plan fails without spending the writer quality repair', () => {
  let result = toRedWriter();
  if (result.state.tag !== 'write' || !result.state.c.plan) throw new Error('writer expected');
  result = { ...result, state: { ...result.state, c: { ...result.state.c, plan: { ...result.state.c.plan, criteria: result.state.c.plan.criteria.map((criterion) => ({ ...criterion, verify: [{ command: 'npm run check', final: false }] })) } } } };
  const admitted = admit(result, ['RED-MATRIX SC1 | tests/feature.test.ts:rejects bad input | exit 1 test:rejects bad input']);
  if (admitted.state.tag !== 'snapshot-after-write') throw new Error('matrix admission expected');
  const snapshot = effect(admitted.effects, 'snapshot');
  const rejected = drive(admitted.state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: { ...FP, worktree: 'tests' }, diff: { paths: ['tests/feature.test.ts'] } });
  assert.equal(rejected.state.tag, 'failure-snapshot');
  if ('c' in rejected.state && rejected.state.c) assert.equal(rejected.state.c.redQualityRepairUsed, false);
});

test('RED narrowing replaces existing suite file operands while keeping runner options', () => {
  const admitted = admit(toRedWriter(), ['RED-MATRIX SC1 | tests/feature.test.ts:rejects bad input | exit 1 test:rejects bad input']);
  if (admitted.state.tag !== 'snapshot-after-write') throw new Error('matrix admission expected');
  const snapshot = effect(admitted.effects, 'snapshot');
  const red = drive(admitted.state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: { ...FP, worktree: 'tests' }, diff: { paths: ['tests/feature.test.ts'] } });
  const verify = effect(red.effects, 'verify');
  assert.equal(verify.kind, 'verify');
  if (verify.kind === 'verify') {
    assert.match(String(verify.commands[0]?.['command']), /tests\/feature.test.ts/);
    assert.doesNotMatch(String(verify.commands[0]?.['command']), /tests\/all.test.ts/);
  }
});

test('RED narrowing keeps attached quoted filters and permits a suite shared with verify criteria', () => {
  let result = toRedWriter();
  if (result.state.tag !== 'write' || !result.state.c.plan) throw new Error('writer expected');
  const command = 'node --test --test-name-pattern="rejects bad input" --import=./hook.ts tests/all.test.ts tests/other.test.ts';
  const red = { ...RED, verify: [{ command, final: false }] };
  const other = { ...RED, id: 'SC2', evidence: 'verify' as const, verify: [{ command, final: false }] };
  result = { ...result, state: { ...result.state, c: { ...result.state.c, plan: { ...result.state.c.plan, criteria: [red, other] } } } };
  const admitted = admit(result, ['RED-MATRIX SC1 | tests/feature.test.ts:rejects bad input | exit 1 test:rejects bad input']);
  if (admitted.state.tag !== 'snapshot-after-write') throw new Error('matrix admission expected');
  const snapshot = effect(admitted.effects, 'snapshot');
  const checked = drive(admitted.state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: { ...FP, worktree: 'tests' }, diff: { paths: ['tests/feature.test.ts'] } });
  assert.equal(checked.state.tag, 'red-verify');
  const verify = effect(checked.effects, 'verify');
  if (verify.kind === 'verify') {
    const narrowed = String(verify.commands[0]?.['command']);
    assert.match(narrowed, /--test-name-pattern="rejects bad input"/);
    assert.match(narrowed, /--import=\.\/hook.ts/);
    assert.doesNotMatch(narrowed, /tests\/(?:all|other).test.ts/);
    assert.match(narrowed, /tests\/feature.test.ts/);
  }
});
