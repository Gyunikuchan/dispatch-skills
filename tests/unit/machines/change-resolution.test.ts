import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDispositions, refreshEvidence, resolution, validateDispositions } from '../../../skills/dispatch/scripts/machines/change-resolution.ts';
import { initialTasks } from '../../../skills/dispatch/scripts/machines/implement-tasks.ts';
import type { ChangeNotice } from '../../../skills/dispatch/scripts/core/types.ts';
import { stepImplement, type ImplementState } from '../../../skills/dispatch/scripts/machines/implement.ts';
import type { Event } from '../../../skills/dispatch/scripts/core/types.ts';
import { approvalState, FP, assessed } from './fixtures/implement-recovery.ts';
const notice: ChangeNotice = { id: 'n', phase: 'host', pendingId: 'approval', beforeHash: 'b', afterHash: 'a', paths: ['src/a.ts'], pathCount: 1, relevance: 'relevant', reason: 'input changed', affectedEvidence: ['SC1'], rawDeltaRef: { version: 1, sha256: 'a'.repeat(64), bytes: 10, path: 'recovery-deltas/a.json' } };
const answer = { by: 'orchestrator', noticeId: 'n', afterHash: 'a', action: 'refresh', rationale: 'Same approved intent; redo affected checks.', evidenceIds: ['SC1'] };
// SECTION: Evidence refresh and change contract

test('phase adapter: refresh retains independent criteria, task acceptance, live writers and integration', () => {
  const c = approvalState().c, plan = c.plan!;
  const independent = { ...plan.criteria[0]!, id: 'SC2', changes: ['src/b.ts'], verify: [{ command: 'check-b', final: false }] };
  const revised = { ...plan, criteria: [...plan.criteria, independent], tasks: [...plan.tasks, { ...plan.tasks[0]!, id: 'T2', paths: ['src/b.ts'], criteria: ['SC2'] }] };
  const initial = initialTasks(revised);
  const evidence = (id: string) => ({ id, outcome: 'pass' as const, evidence: 'checked', planHash: c.planHash!, mutationEpoch: 0, source: 'verify', redProvenance: 'not-required' as const });
  const tasks = { ...initial, T1: { ...initial['T1']!, status: 'accepted' as const, attempt: 2, failures: 1 }, T2: { ...initial['T2']!, status: 'running' as const, handle: 'live', attempt: 3, failures: 2 } };
  const before = { ...c, plan: revised, evidence: { SC1: evidence('SC1'), SC2: evidence('SC2') }, tasks, integration: { path: 'integration', base: 'base', head: 'head', links: [], ignored: [] } };
  const after = refreshEvidence(before, ['SC1'], 'n', 'recheck');
  assert.equal(after.evidence['SC1'], undefined); assert.deepEqual(after.evidence['SC2'], before.evidence.SC2);
  assert.deepEqual(after.evidenceHistory, [before.evidence.SC1]);
  assert.deepEqual(after.tasks, before.tasks); assert.deepEqual(after.integration, before.integration);
  assert.deepEqual(after.obligations?.['SC1']?.tasks, ['T1']);
  assert.equal(after.criterionMutation['SC2'], undefined);
});
test('change contract: resolution binds actor, revision, rationale and evidence without a relevance veto', () => {
  assert.ok(resolution(answer, notice));
  for (const change of [{ by: 'user' }, { noticeId: 'old' }, { afterHash: 'old' }, { rationale: ' ' }, { evidenceIds: [] }, { evidenceIds: ['SC1', 'SC1'] }]) assert.equal(resolution({ ...answer, ...change }, notice), null);
  assert.ok(resolution({ ...answer, action: 'preserve' }, notice));
});
test('change contract: dispositions bind open observations once and only to current criteria', () => {
  const c0 = approvalState().c;
  const observation = { id: 'o', afterHash: 'a', beforeHash: 'b', phase: 'approval', pendingId: 'DECISION', rawDeltaRef: notice.rawDeltaRef, paths: ['README.md'], pathCount: 1, suggestedRelevance: 'unknown' as const, reason: 'r', suggestedEvidence: [] };
  const c = { ...c0, observations: [observation] };
  const bind = { observationId: 'o', afterHash: 'a', rationale: 'Unrelated documentation.' };
  assert.equal(validateDispositions(c, [{ ...bind, retain: ['SC1'] }]), null);
  assert.match(validateDispositions(c, [{ ...bind, afterHash: 'x' }]) ?? '', /stale binding/);
  assert.match(validateDispositions(c, [{ ...bind, refresh: ['SC7'] }]) ?? '', /cannot change scope/);
  assert.match(validateDispositions(c, [{ ...bind, retain: ['SC1'], refresh: ['SC1'] }]) ?? '', /once/);
  const disposed = applyDispositions(c, [bind]);
  assert.deepEqual(disposed.evidence, c.evidence);
  assert.match(validateDispositions(disposed, [bind]) ?? '', /already disposed/);
});
// SECTION: Phase adapters and recovery assessment

test('phase adapter: an ordinary parked approval resumes once and does not grant observed paths', () => {
  const original = approvalState();
  const check = stepImplement(original, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } });
  const resumed = assessed(stepImplement(check.state, { type: 'SNAPSHOT', effectId: check.effects[0]!.id, fingerprint: { ...FP, worktree: 'new' }, diff: { paths: ['caller.ts'] } }), ['caller.ts']);
  assert.equal(resumed.state.tag, 'level-classification');
  assert.ok('c' in resumed.state && resumed.state.c && !('adoptedPaths' in resumed.state.c));
  if ('c' in resumed.state && resumed.state.c) assert.deepEqual(resumed.state.c.observations?.map((row) => row.paths), [['caller.ts']]);
});
test('recovery assessment: duplicate or stale receipts do not advance a pending observation', () => {
  const check = stepImplement(approvalState(), { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } });
  const pending = stepImplement(check.state, { type: 'SNAPSHOT', effectId: check.effects[0]!.id, fingerprint: { ...FP, worktree: 'new' }, diff: { paths: ['caller.ts'] } });
  assert.equal(pending.state.tag, 'assessing-host-event');
  const bad = { type: 'RECOVERY_ASSESSED' as const, effectId: pending.effects[0]!.id, purpose: 'drift' as const, beforeHash: 'stale', afterHash: 'stale', notice };
  assert.deepEqual(stepImplement(pending.state, bad).state, pending.state);
  const valid = assessed(pending, ['caller.ts']);
  assert.deepEqual(stepImplement(valid.state, bad).state, valid.state);
  assert.ok(JSON.stringify(valid.state).length < 20000);
});
test('phase adapter: changes in parked phases apply the parked result once with an advisory observation', () => {
  for (const phase of ['baseline', 'generated', 'final', 'hotfix'] as const) {
    const c = approvalState().c, changed = { ...FP, worktree: 'new' };
    const row = { command: 'check', exit: 0, logPath: 'check.log' };
    let parent: ImplementState, event: Event;
    if (phase === 'baseline') {
      parent = { tag: 'baseline-snapshot', c, effectId: 'old', results: [] };
      event = { type: 'SNAPSHOT', effectId: 'old', fingerprint: changed, diff: { paths: ['caller.ts'] } };
    } else if (phase === 'generated') {
      parent = { tag: 'generated-snapshot', c, effectId: 'old', before: FP, paths: ['generated.ts'] };
      event = { type: 'SNAPSHOT', effectId: 'old', fingerprint: changed, diff: { paths: ['caller.ts'] } };
    } else if (phase === 'hotfix') {
      parent = { tag: 'hotfix-verify', c: { ...c, stalled: { purpose: 'final', rows: [] } }, before: FP, effectId: 'old', origin: { tag: 'failure', c, reason: 'failed', changedPaths: [] }, changedPaths: [] };
      event = { type: 'VERIFY_DONE', effectId: 'old', purpose: 'hotfix', fingerprint: changed, results: [row] };
    } else {
      parent = { tag: 'final-verify', c, before: FP, effectId: 'old' };
      event = { type: 'VERIFY_DONE', effectId: 'old', purpose: 'final', fingerprint: changed, results: [row] };
    }
    let result = stepImplement(parent, event);
    if (result.state.tag === 'checking-host-event') result = stepImplement(result.state, { type: 'SNAPSHOT', effectId: result.effects[0]!.id, fingerprint: changed, diff: { paths: ['caller.ts'] } });
    result = assessed(result, ['caller.ts']);
    assert.notEqual(result.state.tag, 'drift');
    assert.notEqual(result.state.tag, 'assessing-host-event');
    assert.ok('c' in result.state && result.state.c);
    if ('c' in result.state && result.state.c) { assert.equal(result.state.c.observations?.length, 1); assert.deepEqual(result.state.c.tasks, c.tasks); }
  }
});
test('phase adapter: a live delivery collision still requires a bound decision before rebuilding', () => {
  const c = approvalState().c, changed = { ...FP, worktree: 'new' };
  const parent: ImplementState = { tag: 'task-checkout', c: { ...c, phase: 'tasks' }, effectId: 'old', step: 'deliver', task: null, reason: null };
  let result = stepImplement(parent, { type: 'CHECKOUT_DONE', effectId: 'old', op: 'deliver', result: { conflicts: ['caller.ts'], collision: { kind: 'newer-content' } } });
  result = stepImplement(result.state, { type: 'SNAPSHOT', effectId: result.effects[0]!.id, fingerprint: changed, diff: { paths: ['caller.ts'] } });
  result = assessed(result, ['caller.ts']);
  assert.equal(result.state.tag, 'drift'); if (result.state.tag !== 'drift') return;
  const response = { ...answer, noticeId: result.state.notice.id, afterHash: result.state.notice.afterHash, evidenceIds: result.state.notice.affectedEvidence };
  const current = result.state.fingerprint;
  result = stepImplement(result.state, { type: 'DECISION', kind: 'drift', answer: response });
  result = assessed(stepImplement(result.state, { type: 'SNAPSHOT', effectId: result.effects[0]!.id, fingerprint: current, diff: { paths: ['caller.ts'] } }), ['caller.ts']);
  assert.equal(result.effects[0]?.kind, 'checkout');
  if (result.effects[0]?.kind === 'checkout') assert.equal((result.effects[0].input as Readonly<Record<string, unknown>>)['rebase'], true);
});
