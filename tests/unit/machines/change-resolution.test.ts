import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refreshEvidence, resolution } from '../../../skills/dispatch/scripts/machines/change-resolution.ts';
import { initialTasks } from '../../../skills/dispatch/scripts/machines/implement-tasks.ts';
import type { ChangeNotice } from '../../../skills/dispatch/scripts/core/types.ts';
import { stepImplement, type ImplementState } from '../../../skills/dispatch/scripts/machines/implement.ts';
import type { Event } from '../../../skills/dispatch/scripts/core/types.ts';
import { approvalState, FP, assessed } from './fixtures/implement-recovery.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { publishRecovery } from '../../../skills/dispatch/scripts/effects/recovery-manifest.ts';
import { createAssessRecovery } from '../../../skills/dispatch/scripts/effects/assess-recovery.ts';
import type { RecoveryManifest } from '../../../skills/dispatch/scripts/core/types.ts';
const notice: ChangeNotice = { id: 'n', phase: 'host', pendingId: 'approval', beforeHash: 'b', afterHash: 'a', paths: ['src/a.ts'], pathCount: 1, relevance: 'relevant', reason: 'input changed', affectedEvidence: ['SC1'], rawDeltaRef: { version: 1, sha256: 'a'.repeat(64), bytes: 10, path: 'recovery-deltas/a.json' } };
const answer = { by: 'orchestrator', noticeId: 'n', afterHash: 'a', action: 'refresh', rationale: 'Same approved intent; redo affected checks.', evidenceIds: ['SC1'] };
test('phase adapter: real assessment preserves proven independent evidence and classifies disjoint coverage', async () => {
  const ports = fakePorts(), runDir = tempDir();
  const manifest: RecoveryManifest = { repoRoot: '/repo', contentStore: 'recovery-contents', contents: { 'src/a.ts': null }, entries: { 'src/a.ts': { kind: 'symlink', mode: 0o777, linkTarget: 'b25l' } }, taskStartFiles: [], callerDirty: [], git: { head: 'h', index: 'i', stash: '', gitDir: 'g' }, changed: [], verifiedManifestDirs: [], hashManifestDirs: [] };
  const before = { ...FP, recovery: publishRecovery(ports, runDir, manifest) }, after = { ...FP, worktree: 'new', recovery: publishRecovery(ports, runDir, { ...manifest, entries: { 'src/a.ts': { kind: 'symlink', mode: 0o777, linkTarget: 'dHdv' } } }) };
  const original = approvalState(), criterion = original.c.plan!.criteria[0]!;
  const row = (id: string, inputs: string[]) => ({ id, planHash: original.c.planHash!, mutationEpoch: 0, source: 'verify', dependencies: { inputs, complete: true, rationale: 'All transitive command/tool/config inputs inspected.' } });
  const c = { ...original.c, lastFingerprint: before, plan: { ...original.c.plan!, criteria: [{ ...criterion, id: 'SC1' }, { ...criterion, id: 'SC2' }] }, evidence: { SC1: row('SC1', ['src/a.ts']), SC2: row('SC2', ['src/b.ts']) } };
  const parked = stepImplement({ ...original, c }, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } });
  const assessing = stepImplement(parked.state, { type: 'SNAPSHOT', effectId: parked.effects[0]!.id, fingerprint: after, diff: { paths: ['src/a.ts'] } });
  const effect = assessing.effects[0]!; assert.equal(effect.kind, 'assess-recovery'); if (effect.kind !== 'assess-recovery') return;
  const receipt = (await createAssessRecovery()(effect, ports, { runDir, attempt: 1 }))[0]!;
  assert.equal(receipt.type, 'RECOVERY_ASSESSED'); if (receipt.type !== 'RECOVERY_ASSESSED') return;
  assert.deepEqual(receipt.notice.affectedEvidence, ['SC1']);
  const rebound = refreshEvidence(c, receipt.notice); assert.deepEqual(rebound.evidence['SC2'], c.evidence.SC2); assert.equal(rebound.evidence['SC1'], undefined);
  assert.equal(stepImplement(assessing.state, receipt).state.tag, 'drift');
  const independent = await createAssessRecovery()({ ...effect, input: { ...effect.input, inputs: [], evidenceDependencies: { SC1: row('SC1', ['src/b.ts']).dependencies, SC2: row('SC2', ['src/b.ts']).dependencies } } }, ports, { runDir, attempt: 1 });
  assert.equal(independent[0]?.type === 'RECOVERY_ASSESSED' && independent[0].notice.relevance, 'irrelevant');
  assert.notEqual(stepImplement(assessing.state, independent[0]!).state.tag, 'drift');
});
test('phase adapter: refresh retains independent criteria and preserves attempt failure and live writer identities', () => {
  const c = approvalState().c, plan = c.plan!;
  const independent = { ...plan.criteria[0]!, id: 'SC2', changes: ['src/b.ts'], verify: [{ command: 'check-b', final: false }] };
  const revised = { ...plan, criteria: [...plan.criteria, independent], tasks: [...plan.tasks, { ...plan.tasks[0]!, id: 'T2', paths: ['src/b.ts'], criteria: ['SC2'] }] };
  const initial = initialTasks(revised);
  const evidence = (id: string) => ({ id, outcome: 'pass' as const, evidence: 'checked', planHash: c.planHash!, mutationEpoch: 0, source: 'verify', redProvenance: 'not-required' as const });
  const tasks = { ...initial, T1: { ...initial['T1']!, status: 'accepted' as const, attempt: 2, failures: 1 }, T2: { ...initial['T2']!, status: 'running' as const, handle: 'live', attempt: 3, failures: 2 } };
  const before = { ...c, plan: revised, evidence: { SC1: evidence('SC1'), SC2: evidence('SC2') }, tasks, integration: { path: 'integration', base: 'base', head: 'head', links: [], ignored: [] } };
  const after = refreshEvidence(before, notice);
  assert.equal(after.evidence['SC1'], undefined); assert.deepEqual(after.evidence['SC2'], before.evidence.SC2);
  assert.deepEqual([after.tasks['T1']?.status, after.tasks['T1']?.attempt, after.tasks['T1']?.failures], ['pending', 2, 1]);
  assert.deepEqual(after.tasks['T2'], before.tasks.T2); assert.equal(after.integration?.rewind, true);
  assert.equal(after.criterionMutation['SC2'], undefined);
});
test('change contract: actor binding rationale and evidence are required; preserve is restricted', () => {
  assert.ok(resolution(answer, notice));
  for (const change of [{ by: 'user' }, { noticeId: 'old' }, { afterHash: 'old' }, { rationale: ' ' }, { evidenceIds: [] }, { evidenceIds: ['SC1', 'SC1'] }, { action: 'preserve' }]) assert.equal(resolution({ ...answer, ...change }, notice), null);
  assert.ok(resolution({ ...answer, action: 'preserve' }, { ...notice, relevance: 'irrelevant' }));
});
test('phase adapter: parked approval resolves once and does not grant observed paths', () => {
  const original = approvalState();
  const check = stepImplement(original, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } });
  const changed = assessed(stepImplement(check.state, { type: 'SNAPSHOT', effectId: check.effects[0]!.id, fingerprint: { ...FP, worktree: 'new' }, diff: { paths: ['caller.ts'] } }), ['caller.ts']);
  assert.equal(changed.state.tag, 'drift'); if (changed.state.tag !== 'drift') return;
  const response = { ...answer, noticeId: changed.state.notice.id, afterHash: changed.state.notice.afterHash, evidenceIds: changed.state.notice.affectedEvidence };
  const fresh = stepImplement(changed.state, { type: 'DECISION', kind: 'drift', answer: response });
  const resumed = assessed(stepImplement(fresh.state, { type: 'SNAPSHOT', effectId: fresh.effects[0]!.id, fingerprint: changed.state.fingerprint, diff: { paths: ['caller.ts'] } }), ['caller.ts']);
  assert.equal(resumed.state.tag, 'level-classification');
  assert.deepEqual(stepImplement(resumed.state, { type: 'DECISION', kind: 'drift', answer: response }).state, resumed.state);
  assert.ok('c' in resumed.state && resumed.state.c && !('adoptedPaths' in resumed.state.c));
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
for (const phase of ['baseline', 'generated', 'final', 'hotfix', 'delivery'] as const) test(`phase adapter: ${phase} refresh emits a new dependent check without reusing the parked result`, () => {
  const c = approvalState().c, changed = { ...FP, worktree: 'new' };
  const row = { command: 'check', exit: 0, logPath: 'check.log' };
  let parent: ImplementState, event: Event;
  if (phase === 'baseline') {
    parent = { tag: 'baseline-snapshot', c, effectId: 'old', results: [] };
    event = { type: 'SNAPSHOT', effectId: 'old', fingerprint: changed, diff: { paths: ['caller.ts'] } };
  } else if (phase === 'generated') {
    parent = { tag: 'generated-snapshot', c, effectId: 'old', before: FP, paths: ['generated.ts'] };
    event = { type: 'SNAPSHOT', effectId: 'old', fingerprint: changed, diff: { paths: ['caller.ts'] } };
  } else if (phase === 'delivery') {
    parent = { tag: 'task-checkout', c: { ...c, phase: 'tasks' }, effectId: 'old', step: 'deliver', task: null, reason: null };
    event = { type: 'CHECKOUT_DONE', effectId: 'old', op: 'deliver', result: { conflicts: ['caller.ts'], collision: { kind: 'newer-content' } } };
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
  assert.equal(result.state.tag, 'drift'); if (result.state.tag !== 'drift') return;
  const response = { ...answer, noticeId: result.state.notice.id, afterHash: result.state.notice.afterHash, evidenceIds: result.state.notice.affectedEvidence };
  const current = result.state.fingerprint;
  result = stepImplement(result.state, { type: 'DECISION', kind: 'drift', answer: response });
  result = assessed(stepImplement(result.state, { type: 'SNAPSHOT', effectId: result.effects[0]!.id, fingerprint: current, diff: { paths: ['caller.ts'] } }), ['caller.ts']);
  if (phase === 'generated' && result.state.tag === 'post-review-snapshot') result = stepImplement(result.state, { type: 'SNAPSHOT', effectId: result.effects[0]!.id, fingerprint: current, diff: { paths: [] } });
  assert.equal(result.effects[0]?.kind, phase === 'delivery' ? 'checkout' : 'verify');
  assert.notEqual(result.effects[0]?.id, 'old');
  if (phase === 'delivery' && result.effects[0]?.kind === 'checkout') assert.equal((result.effects[0].input as Readonly<Record<string, unknown>>)['rebase'], true);
});
