import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginRevision, stepRevision, revisionDelta, reboundRevision, type RevisionState } from '../../../skills/dispatch/scripts/machines/revision.ts';
import { validateImplement, type ImplementState } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { asParsedPlan } from '../../../skills/dispatch/scripts/machines/implement-types.ts';
import { approvalState, PLAN, HASH, FP, host } from './implement-recovery.test.ts';

const revision = { type: 'REVISE' as const, artifact: 'plan' as const, reason: 'blocked-by-plan', evidence: 'stalled check report' };
function parsed(plan: Record<string, unknown> = PLAN, hash = `sha256:${'b'.repeat(64)}`) {
  let r = beginRevision(approvalState(), revision);
  const path = r.state.r.workingPath;
  r = stepRevision(r.state, { type: 'AUTHORED', path }); assert.equal(r.state.tag, 'checking-host-event');
  r = stepRevision(r.state, { type: 'SNAPSHOT', effectId: r.effects[0]!.id, fingerprint: FP, diff: { paths: [] } });
  r = stepRevision(r.state, { type: 'ARTIFACT_PARSED', effectId: r.effects[0]!.id, kind: 'plan', hash, parsed: plan, defects: [] });
  return r;
}
test('REVISE allowed at governed approval/evidence/failure/review awaits; outstanding write refused', () => {
  const c = approvalState().c;
  for (const parent of [{ tag: 'approval', c }, { tag: 'evidence', c, purpose: 'final', ids: ['SC1'], verify: [] }, { tag: 'failure', c, reason: 'blocked-by-plan', changedPaths: [] }] as ImplementState[]) {
    assert.equal(validateImplement(parent, revision), null);
    assert.equal(host(parent, revision).state.tag, 'revision-request');
  }
  const pending: ImplementState = { tag: 'tasks', c: { ...c, phase: 'tasks' } };
  assert.match(validateImplement(pending, revision) ?? '', /outstanding write/);
});
test('delta review includes governed changes even when criterion IDs and mappings are unchanged', () => {
  const result = parsed({ ...PLAN, keyDecisions: ['new constraint'], governedText: 'new governed context' });
  assert.equal(result.state.tag, 'review');
  const effect = result.effects[0]; assert.equal(effect?.kind, 'prepare-review');
  if (effect?.kind === 'prepare-review') { assert.equal(effect.scope['scope'], 'delta'); assert.equal(effect.scope['sinceHash'], HASH); assert.equal(effect.scope['beforeText'], PLAN.governedText); assert.ok(String(effect.review['context']).includes('new governed context')); }
});
test('unchanged mapped evidence retained; changed/new pending; removed deviations and full revision log', () => {
  const original = asParsedPlan(PLAN)!;
  const revised = asParsedPlan({ ...PLAN, criteria: [PLAN.criteria[0], { ...PLAN.criteria[0], id: 'SC2', title: 'new' }], governedText: 'revised' })!;
  assert.deepEqual(revisionDelta(original, revised).changed, ['SC2']);
  const parent = approvalState();
  const r = beginRevision({ ...parent, c: { ...parent.c, evidence: { SC1: { id: 'SC1', planHash: HASH, mutationEpoch: 0, source: 'verify', outcome: 'pass', evidence: 'passed' } } } }, revision).state.r;
  const resumed: Extract<RevisionState, { tag: 'resume' }> = { tag: 'resume', r: { ...r, plan: revised, hash: `sha256:${'b'.repeat(64)}`, changed: ['SC2'], removed: [], grew: false } };
  const c = reboundRevision(resumed); assert.ok(c.evidence['SC1']); assert.equal(c.evidence['SC2'], undefined); assert.equal(c.evidence['SC1']?.planHash, resumed.r.hash);
  assert.deepEqual(reboundRevision(resumed), c);
  assert.equal(c.revisions[0]?.beforeHash, HASH); assert.equal(c.revisions[0]?.afterHash, resumed.r.hash); assert.deepEqual(c.revisions[0]?.rebind.pending, ['SC2']);
  const removed = reboundRevision({ ...resumed, r: { ...resumed.r, plan: { ...revised, criteria: [] }, changed: [], removed: ['SC1'] } });
  assert.equal(Object.keys(removed.evidence).length, 0); assert.ok(removed.concerns.some((row) => row.includes('removed criterion SC1')));
});
test('objective refusal names TL;DR; approval only for expanded paths or commands', () => {
  const refused = parsed({ ...PLAN, box: { 'TL;DR': 'different objective' } });
  assert.equal(refused.state.tag, 'refused'); if (refused.state.tag === 'refused') assert.match(refused.state.error, /TL;DR/);
  const plan = asParsedPlan(PLAN)!;
  assert.equal(revisionDelta(plan, { ...plan, criteria: [{ ...plan.criteria[0]!, title: 'renamed' }] }).grew, false);
  assert.equal(revisionDelta(plan, { ...plan, changes: [...plan.changes, { ...plan.changes[0]!, path: 'new.ts' }] }).grew, true);
  assert.equal(revisionDelta(plan, { ...plan, criteria: [{ ...plan.criteria[0]!, verify: [{ command: 'new command', final: false }] }] }).grew, true);
});
test('revision author await snapshots drift and refuses incomplete per-path settlement', () => {
  let r = beginRevision(approvalState(), revision);
  r = stepRevision(r.state, { type: 'AUTHORED', path: r.state.r.workingPath });
  r = stepRevision(r.state, { type: 'SNAPSHOT', effectId: r.effects[0]!.id, fingerprint: FP, diff: { paths: ['unexpected'] } });
  assert.equal(r.state.tag, 'drift');
  r = stepRevision(r.state, { type: 'DECISION', kind: 'drift', answer: { unexpected: 'adopt' } });
  assert.equal(r.state.tag, 'parse'); assert.ok(r.state.r.c.finalFocus.includes('unexpected'));
});
