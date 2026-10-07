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
test('audit report progress set open cannot bypass triage or opportunity selection', () => {
  const { root, file } = report(finding('A-1'), opportunity());
  unchanged(file, () => captured(() => status.cmdSet(root, file, ['set', 'O-1', 'open'])), /triage|selection/i);
  unchanged(file, () => captured(() => status.cmdSet(root, file, ['set', 'A-1', 'fixed'])), /triage|code-reviewed/i);
});
test('audit report progress legacy fixed disposition cannot be reset by triage', () => {
  const { root, file } = report(finding('A-1', 'high', 'fixed — abc123'));
  unchanged(file, () => recordTriage(root, file, 'A-1'), /fixed/);
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
test('audit report progress set cannot reopen or defer a fixed item', () => {
  const { root, file } = report(finding('A-1', 'medium', 'fixed — retained commit'));
  for (const state of ['open', 'deferred', 'decision', 'false-positive']) {
    unchanged(file, () => captured(() => status.cmdSet(root, file, ['set', 'A-1', state])), /fixed/);
  }
});
test('audit report progress first checkpoint refuses a hidden second active batch', () => {
  const { root, file } = report(finding('A-1') + finding('A-2'));
  recordTriage(root, file, 'A-1', { group: 'first' }); recordTriage(root, file, 'A-2', { group: 'second' });
  const base = { batchId: 'first-1', phase: 'planned', plan: artifact(root, 'first.plan.md'), evidence: 'First plan authored.' };
  recordProgress(root, file, 'A-1', base);
  unchanged(file, () => recordProgress(root, file, 'A-2', { ...base, batchId: 'second-1' }), /active.*batch/i);
});
