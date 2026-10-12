import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refreshEvidence } from '../../skills/dispatch/scripts/machines/change-resolution.ts';
import { stepImplement } from '../../skills/dispatch/scripts/machines/implement.ts';
import { approvalState, FP } from '../unit/machines/fixtures/implement-recovery.ts';
import { fakePorts, tempDir } from '../helpers/fake-ports.ts';
import { publishRecovery } from '../../skills/dispatch/scripts/effects/recovery-manifest.ts';
import { createAssessRecovery } from '../../skills/dispatch/scripts/effects/assess-recovery.ts';
import type { RecoveryManifest } from '../../skills/dispatch/scripts/core/types.ts';


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
