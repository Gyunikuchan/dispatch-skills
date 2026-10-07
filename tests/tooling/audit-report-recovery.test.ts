import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { finding, report, captured, recordTriage, recordProgress, artifact, unchanged, status } from '../helpers/audit-report.ts';

test('audit report progress abandonment preserves history and permits regrouping', () => {
  const { root, file } = report(finding('A-1')); recordTriage(root, file, 'A-1');
  const base = { batchId: 'batch-1', phase: 'planned', plan: artifact(root, 'batch.plan.md'), evidence: 'Plan authored.' };
  recordProgress(root, file, 'A-1', base);
  recordProgress(root, file, 'A-1', { ...base, phase: 'abandoned', evidence: 'Plan review found wrong scope.' });
  assert.match(fs.readFileSync(file, 'utf8'), /Execution history.*Plan review found wrong scope/);
  assert.match(fs.readFileSync(file, 'utf8'), /Execution history.*Plan authored/);
  recordTriage(root, file, 'A-1', { group: 'corrected-scope' }); assert.match(captured(() => status.cmdBatch(root, file, ['batch'])), /# Batch: A-1/);
});

test('audit report progress partial state corruption cannot be used as completion evidence', () => {
  const { root, file } = report(finding('A-1') + finding('A-2'));
  recordTriage(root, file, 'A-1'); recordTriage(root, file, 'A-2');
  const base = { batchId: 'batch-1', phase: 'planned', plan: artifact(root, 'batch.plan.md'), evidence: 'Plan authored.' };
  recordProgress(root, file, 'A-1,A-2', base);
  const text = fs.readFileSync(file, 'utf8').replace(/(- \*\*Execution\*\*: .*?)"phase":"planned"/, '$1"phase":"code-reviewed"');
  fs.writeFileSync(file, text);
  unchanged(file, () => status.cmdInit(root, file), /planReview|mismatch/);
});

test('audit report progress abandonment releases unfinished members and preserves fixed evidence', () => {
  const { root, file } = report(finding('A-1') + finding('A-2'));
  recordTriage(root, file, 'A-1'); recordTriage(root, file, 'A-2');
  const base = { batchId: 'batch-1', plan: artifact(root, 'batch.plan.md'), evidence: 'Verified direct delivery.' };
  recordProgress(root, file, 'A-1,A-2', { ...base, phase: 'planned' });
  recordProgress(root, file, 'A-1,A-2', { ...base, phase: 'plan-reviewed', planReview: artifact(root, 'plan-review.md') });
  recordProgress(root, file, 'A-1,A-2', { ...base, phase: 'implemented', implementation: artifact(root, 'implementation.md') });
  recordProgress(root, file, 'A-1,A-2', { ...base, phase: 'code-reviewed', codeReview: artifact(root, 'code-review.md') });
  captured(() => status.cmdSet(root, file, ['set', 'A-1', 'fixed']));
  recordProgress(root, file, 'A-1,A-2', { ...base, phase: 'abandoned', evidence: 'A-2 cannot satisfy its acceptance check; release it for re-triage.' });
  recordTriage(root, file, 'A-2', { ruling: 'defer' });
  const out = captured(() => status.cmdList(root, file, ['list', '--full']));
  const fixedBlock = out.split('#### A-2:')[0] ?? '';
  assert.match(fixedBlock, /Status\*\*: fixed/);
  assert.match(fixedBlock, /Execution\*\*:.*code-reviewed.*"members":\["A-1"\]/);
  assert.match(out, /A-2[\s\S]*Status\*\*: deferred/);
  assert.match(captured(() => status.cmdBatch(root, file, ['batch'])), /No actionable items/);
  unchanged(file, () => recordTriage(root, file, 'A-1'), /fixed/);
});

test('audit report progress first checkpoint refuses a hidden second active batch', () => {
  const { root, file } = report(finding('A-1') + finding('A-2'));
  recordTriage(root, file, 'A-1', { group: 'first' }); recordTriage(root, file, 'A-2', { group: 'second' });
  const base = { batchId: 'first-1', phase: 'planned', plan: artifact(root, 'first.plan.md'), evidence: 'First plan authored.' };
  recordProgress(root, file, 'A-1', base);
  unchanged(file, () => recordProgress(root, file, 'A-2', { ...base, batchId: 'second-1' }), /active.*batch/i);
});
