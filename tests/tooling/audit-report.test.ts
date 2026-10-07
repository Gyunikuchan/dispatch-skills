import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { SENTINEL, finding, opportunity, report, captured, recordTriage, unchanged, status } from '../helpers/audit-report.ts';

test('audit report init tracks both kinds and preserves statuses and notes on repeat', () => {
  const { root, file } = report(finding('A-1', 'high', 'fixed — abc123') + finding('A-2'), opportunity());
  captured(() => status.cmdInit(root, file)); captured(() => status.cmdInit(root, file));
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.match(/^> Fix status:/gm)?.length, 1); assert.equal(text.match(/^> Opportunity status:/gm)?.length, 1);
  assert.match(text, /Fix status: open 1, fixed 1.*total 2/);
  assert.match(text, /Opportunity status: open 0, fixed 0, false-positive 0, decision 1.*total 1/);
  assert.match(text, /fixed — abc123/);
  assert.match(captured(() => status.cmdList(root, file, ['list'])), /O-1\s.*decision/);
});
test('audit report init opportunity-only reports retain the zero-defect sentinel', () => {
  const { root, file } = report(SENTINEL, opportunity());
  captured(() => status.cmdInit(root, file)); captured(() => status.cmdInit(root, file));
  assert.deepEqual(status.parseFindings(status.loadReport(file)), []);
  assert.match(captured(() => status.cmdList(root, file, ['list', '--kind', 'opportunity'])), /O-1/);
  assert.match(fs.readFileSync(file, 'utf8'), /No defect findings\./);
});
test('audit report init list tolerates untriaged and uninitialized reports without writing', () => {
  const { root, file } = report(finding('A-1'), opportunity()), before = fs.readFileSync(file, 'utf8');
  const out = captured(() => status.cmdList(root, file, ['list']));
  assert.match(out, /A-1/); assert.match(out, /O-1/); assert.equal(fs.readFileSync(file, 'utf8'), before);
});
test('audit report init rejects malformed sections and duplicate IDs before mutation', () => {
  for (const body of [finding('A-1') + finding('A-1'), `${SENTINEL}\n${finding('A-1')}`,
    finding('A-1').replace('· correctness ·', '| correctness |'), opportunity()]) {
    const { root, file } = report(body); unchanged(file, () => status.cmdInit(root, file), /duplicate|mixes|severity|opportunit/i);
  }
  const { root, file } = report(finding('A-1'), opportunity() + opportunity());
  unchanged(file, () => status.cmdInit(root, file), /duplicate/i);
});
test('audit report init rejects invalid status and malformed remediation JSON', () => {
  const { root, file } = report(finding('A-1', 'high', 'done'));
  unchanged(file, () => status.cmdInit(root, file), /Unknown status/);
  const second = report(finding('A-1') + '- **Triage**: {invalid}\n');
  unchanged(second.file, () => status.cmdInit(second.root, second.file), /Triage/);
});
test('audit report init malformed opportunity fields leave both sections unchanged', () => {
  const { root, file } = report(finding('A-1'), opportunity().replace('- **Cost**: state and frame changes.', ''));
  unchanged(file, () => status.cmdInit(root, file), /Cost/);
});
test('audit report init Markdown heading whitespace does not hide opportunities', () => {
  const { root, file } = report(finding('A-1'), opportunity());
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## 3. Findings', '## 3. Findings  ').replace('## 4. Opportunities', '## 4. Opportunities\t'));
  captured(() => status.cmdInit(root, file));
  assert.match(captured(() => status.cmdList(root, file, ['list'])), /O-1/);
});
test('audit report init metadata preserves the severity line directly below the heading', () => {
  const { root, file } = report(finding('A-1'));
  captured(() => status.cmdInit(root, file)); recordTriage(root, file, 'A-1');
  assert.match(fs.readFileSync(file, 'utf8'), /#### A-1: Title of A-1\n- \*\*medium\*\* · correctness/);
});
