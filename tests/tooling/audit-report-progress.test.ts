import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { finding, opportunity, report, captured, recordTriage, recordProgress, artifact, unchanged, status } from '../helpers/audit-report.ts';

test('audit report progress requires reviewed direct delivery before fixed status', () => {
  const { root, file } = report(finding('A-1'), opportunity());
  recordTriage(root, file, 'A-1'); recordTriage(root, file, 'O-1', { selection: { by: 'user', quote: 'Select O-1.' } });
  const base = { batchId: 'batch-1', plan: artifact(root, 'batch.plan.md'), evidence: 'Plan defines scope and verification.' };
  unchanged(file, () => captured(() => status.cmdSet(root, file, ['set', 'A-1', 'fixed'])), /code-reviewed/);
  recordProgress(root, file, 'A-1,O-1', { ...base, phase: 'planned' });
  assert.match(captured(() => status.cmdBatch(root, file, ['batch'])), /Resume.*batch-1.*planned/);
  unchanged(file, () => recordTriage(root, file, 'A-1'), /active.*Execution/i);
  unchanged(file, () => recordProgress(root, file, 'A-1,O-1', { ...base, phase: 'implemented', implementation: artifact(root, 'implementation.md') }), /phase|transition/);
  const reviewed = { ...base, planReview: artifact(root, 'plan-review.md') };
  recordProgress(root, file, 'A-1,O-1', { ...reviewed, phase: 'plan-reviewed' });
  const implemented = { ...reviewed, implementation: 'implementation.md', evidence: 'All plan Verify commands pass.' };
  recordProgress(root, file, 'A-1,O-1', { ...implemented, phase: 'implemented' });
  unchanged(file, () => captured(() => status.cmdSet(root, file, ['set', 'A-1', 'fixed'])), /code-reviewed/);
  recordProgress(root, file, 'A-1,O-1', { ...implemented, phase: 'code-reviewed', codeReview: artifact(root, 'code-review.md') });
  captured(() => status.cmdSet(root, file, ['set', 'A-1', 'fixed', '--note', 'Verified retry test.']));
  captured(() => status.cmdSet(root, file, ['set', 'O-1', 'fixed', '--note', 'Hypothesis checked; benefit remains unmeasured.']));
  assert.match(captured(() => status.cmdBatch(root, file, ['batch'])), /No actionable items/);
});

test('audit report progress rejects incomplete membership, missing evidence, and escaping paths', () => {
  const { root, file } = report(finding('A-1') + finding('A-2')); recordTriage(root, file, 'A-1'); recordTriage(root, file, 'A-2');
  const base = { batchId: 'batch-1', phase: 'planned', plan: artifact(root, 'batch.plan.md'), evidence: 'Plan authored.' };
  unchanged(file, () => recordProgress(root, file, 'A-1', base), /group|member/);
  for (const plan of ['missing.plan.md', '../outside.plan.md', path.join(root, 'batch.plan.md')]) {
    unchanged(file, () => recordProgress(root, file, 'A-1,A-2', { ...base, plan }), /file|path|relative/i);
  }
  recordProgress(root, file, 'A-1,A-2', base);
  unchanged(file, () => recordProgress(root, file, 'A-1', base), /member/);
  unchanged(file, () => recordProgress(root, file, 'A-1,A-2', { ...base, phase: 'plan-reviewed' }), /planReview/);
  unchanged(file, () => recordProgress(root, file, 'A-1,A-2', { ...base, batchId: 'other' }), /batchId|identity/);
});

test('audit report progress repeat checkpoint and init retain evidence without duplicate lines', () => {
  const { root, file } = report(finding('A-1')); recordTriage(root, file, 'A-1');
  const base = { batchId: 'batch-1', phase: 'planned', plan: artifact(root, 'batch.plan.md'), evidence: 'Plan authored.' };
  recordProgress(root, file, 'A-1', base); recordProgress(root, file, 'A-1', base); captured(() => status.cmdInit(root, file));
  const text = fs.readFileSync(file, 'utf8'); assert.equal(text.match(/^- \*\*Execution\*\*:/gm)?.length, 1); assert.match(text, /Plan authored/);
});
