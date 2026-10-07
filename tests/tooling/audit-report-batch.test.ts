import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { SENTINEL, finding, opportunity, report, captured, recordTriage, unchanged, status } from '../helpers/audit-report.ts';

test('audit report batch refuses untriaged items and unselected opportunities', () => {
  const { root, file } = report(finding('A-1'), opportunity());
  assert.doesNotMatch(captured(() => status.cmdBatch(root, file, ['batch'])), /# Batch:/);
  unchanged(file, () => recordTriage(root, file, 'O-1'), /selection/); recordTriage(root, file, 'A-1');
  assert.match(captured(() => status.cmdBatch(root, file, ['batch'])), /# Batch: A-1/);
  assert.doesNotMatch(captured(() => status.cmdBatch(root, file, ['batch'])), /# Batch:.*O-1/);
});
test('audit report batch groups coherent mixed items without unrelated filler', () => {
  const { root, file } = report(finding('A-1', 'high') + finding('A-2'), opportunity());
  recordTriage(root, file, 'A-1'); recordTriage(root, file, 'A-2', { group: 'unrelated-fix' });
  recordTriage(root, file, 'O-1', { selection: { by: 'user', quote: 'Select O-1.' }, dependsOn: ['A-1'] });
  const out = captured(() => status.cmdBatch(root, file, ['batch']));
  assert.match(out, /# Batch: A-1, O-1/); assert.doesNotMatch(out, /#### A-2/); assert.match(out, /unmeasured/);
});
test('audit report batch priority ranks opportunities without assigning defect severity', () => {
  const { root, file } = report(SENTINEL, opportunity('O-1') + opportunity('O-2'));
  recordTriage(root, file, 'O-1', { group: 'low-improvement', priority: 'low', selection: { by: 'user', quote: 'Select both.' } });
  recordTriage(root, file, 'O-2', { group: 'high-improvement', priority: 'high', selection: { by: 'user', quote: 'Select both.' } });
  assert.match(captured(() => status.cmdBatch(root, file, ['batch'])), /# Batch: O-2/);
});
test('audit report batch blocks cross-group dependencies but selects independent work', () => {
  const { root, file } = report(finding('A-1', 'high') + finding('A-2') + finding('A-3'));
  recordTriage(root, file, 'A-1', { group: 'dependent', dependsOn: ['A-2'] });
  recordTriage(root, file, 'A-2', { group: 'prerequisite' }); recordTriage(root, file, 'A-3', { group: 'independent' });
  const out = captured(() => status.cmdBatch(root, file, ['batch']));
  assert.match(out, /Blocked.*A-1.*A-2/); assert.match(out, /# Batch: A-2/);
});
test('audit report batch detects cycles and oversized groups without splitting them', () => {
  const { root, file } = report(finding('A-1') + finding('A-2'));
  recordTriage(root, file, 'A-1', { dependsOn: ['A-2'] }); recordTriage(root, file, 'A-2', { dependsOn: ['A-1'] });
  assert.match(captured(() => status.cmdBatch(root, file, ['batch'])), /cycle/i); recordTriage(root, file, 'A-2');
  assert.match(captured(() => status.cmdBatch(root, file, ['batch', '--size', '1'])), /exceeds.*1/i);
  assert.match(captured(() => status.cmdBatch(root, file, ['batch'])), /# Batch: A-2, A-1/);
});
test('audit report batch triage maps rulings and rejects invalid metadata atomically', () => {
  const { root, file } = report(finding('A-1'), opportunity());
  recordTriage(root, file, 'A-1', { ruling: 'reject' }); recordTriage(root, file, 'O-1', { ruling: 'reject' });
  const out = captured(() => status.cmdList(root, file, ['list']));
  assert.match(out, /A-1.*false-positive/); assert.match(out, /O-1.*deferred/);
  recordTriage(root, file, 'A-1', { ruling: 'decision' }); assert.match(captured(() => status.cmdList(root, file, ['list'])), /A-1.*decision/);
  recordTriage(root, file, 'A-1', { ruling: 'defer' }); assert.match(captured(() => status.cmdList(root, file, ['list'])), /A-1.*deferred/);
  for (const changes of [{ evidence: '' }, { dependsOn: ['A-99'] }, { dependsOn: ['A-1'] },
    { affectedPaths: ['../outside.ts'] }, { priority: 'critical' }, { verification: [] }]) {
    unchanged(file, () => recordTriage(root, file, 'A-1', changes), /evidence|depend|path|priority|verification/i);
  }
});
test('audit report batch legacy dispatched notes require an explicit tree inspection', () => {
  const { root, file } = report(finding('A-1', 'high', 'open — dispatched prior-batch'));
  captured(() => status.cmdInit(root, file)); assert.match(fs.readFileSync(file, 'utf8'), /dispatched prior-batch/);
  unchanged(file, () => recordTriage(root, file, 'A-1'), /legacyInspection/);
  recordTriage(root, file, 'A-1', { legacyInspection: 'Checked current source; fix absent.' });
  assert.match(captured(() => status.cmdBatch(root, file, ['batch'])), /# Batch: A-1/);
});
test('audit report batch zero items prints a completion result', () => {
  const { root, file } = report(SENTINEL); assert.match(captured(() => status.cmdBatch(root, file, ['batch'])), /No actionable items/);
});
test('audit report batch distinguishes blocked accepted items from missing triage', () => {
  const { root, file } = report(finding('A-1') + finding('A-2') + finding('A-3'));
  recordTriage(root, file, 'A-1', { dependsOn: ['A-2'] }); recordTriage(root, file, 'A-2', { dependsOn: ['A-1'] });
  const out = captured(() => status.cmdBatch(root, file, ['batch']));
  assert.match(out, /Blocked accepted items: A-1, A-2/); assert.match(out, /Needs triage or decision: A-3/);
});
