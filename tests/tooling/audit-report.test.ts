import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../helpers/fake-ports.ts';
import {
  cmdBatch,
  cmdInit,
  cmdList,
  loadReport,
  parseFindings,
  // @ts-expect-error -- untyped .mjs helper; its contract is exercised by these tests
} from '../../.agents/skills/audit-dispatch-skills-fix/scripts/status.mjs';

const SENTINEL = 'No defect findings.';
const finding = (id: string, severity: string, status = '') =>
  [
    `#### ${id}: Title of ${id}`,
    `- **${severity}** · correctness · Verified · S1`,
    ...(status ? [`- **Status**: ${status}`] : []),
    '- **Location**: `skills/dispatch/SKILL.md:10`',
    '- **Claim**: claim.',
    '- **Evidence**: evidence.',
    '- **Proposal**: proposal.',
    '',
  ].join('\n');

function report(findingsBody: string, opportunities = '') {
  const file = path.join(tempDir(), '2026-10-07-0000-audit.md');
  const text = [
    '# Audit',
    '',
    '## 1. Summary',
    '',
    'Short static audit.',
    '',
    '## 2. Dispatch platforms',
    '',
    '## 3. Findings',
    '',
    findingsBody,
    '## 4. Opportunities',
    '',
    opportunities,
    '## 5. Coverage and budget',
    '',
    '## 6. Appendix',
    '',
  ].join('\n');
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function captured(run: () => void) {
  const out: string[] = [];
  const log = console.log, error = console.error;
  console.log = (...args: unknown[]) => { out.push(args.join(' ')); };
  console.error = () => {};
  try { run(); } finally { console.log = log; console.error = error; }
  return out.join('\n');
}

const OPPORTUNITY = '#### O-1: Shorten the plan brief\n- **Hypothesis**: fewer tokens.\n- **Benefit**: unmeasured.\n';

test('audit report init preserves existing statuses and notes while backfilling missing ones', () => {
  const file = report(`### High\n\n${finding('A-1', 'high', 'fixed — abc123')}\n${finding('A-2', 'medium')}`);
  const root = path.dirname(file);
  captured(() => cmdInit(root, file));
  captured(() => cmdInit(root, file));
  const findings = parseFindings(loadReport(file));
  assert.deepEqual(findings.map((f: { id: string; status: string; note: string }) => [f.id, f.status, f.note]), [
    ['A-1', 'fixed', 'abc123'],
    ['A-2', 'open', ''],
  ]);
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.match(/^> Fix status:/gm)?.length, 1);
  assert.match(text, /> Fix status: open 1, fixed 1, false-positive 0, decision 0, deferred 0 \(total 2\)\./);
});

test('audit report canonical empty findings section initializes twice without inventing rows', () => {
  const file = report(`${SENTINEL}\n`);
  const root = path.dirname(file);
  const first = captured(() => cmdInit(root, file));
  const second = captured(() => cmdInit(root, file));
  assert.match(first, /0 findings/);
  assert.match(second, /0 findings/);
  assert.deepEqual(parseFindings(loadReport(file)), []);
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.match(/^> Fix status:/gm)?.length, 1);
  assert.match(text, /\(total 0\)\./);
  assert.doesNotMatch(text, /\*\*Status\*\*/);
});

test('audit report canonical empty findings section lists and batches nothing', () => {
  const file = report(`${SENTINEL}\n`);
  const root = path.dirname(file);
  captured(() => cmdInit(root, file));
  assert.equal(captured(() => cmdList(root, file, ['list', '--status', 'open'])), 'No open findings.');
  assert.equal(captured(() => cmdBatch(root, file, ['batch'])), 'No open findings.');
});

test('audit report opportunities outside the findings section never become fix targets', () => {
  const file = report(`${SENTINEL}\n`, OPPORTUNITY);
  const root = path.dirname(file);
  captured(() => cmdInit(root, file));
  assert.deepEqual(parseFindings(loadReport(file)), []);
  assert.doesNotMatch(captured(() => cmdList(root, file, ['list'])), /O-1/);
  assert.doesNotMatch(captured(() => cmdBatch(root, file, ['batch'])), /O-1/);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\*\*Status\*\*/);
});

test('audit report rejects an opportunity heading inside the findings section', () => {
  const file = report(`${finding('A-1', 'high')}\n${OPPORTUNITY}`);
  assert.throws(() => parseFindings(loadReport(file)), /O-1/);
  const empty = report(`${SENTINEL}\n\n${OPPORTUNITY}`);
  assert.throws(() => parseFindings(loadReport(empty)), /O-1/);
});

test('audit report rejects the empty sentinel mixed with findings', () => {
  const file = report(`${SENTINEL}\n\n${finding('A-1', 'high')}`);
  assert.throws(() => parseFindings(loadReport(file)), /No defect findings/);
});

test('audit report rejects an empty findings section without the sentinel', () => {
  assert.throws(() => parseFindings(loadReport(report(''))), /yielded no findings/);
  assert.throws(() => parseFindings(loadReport(report('Nothing worth reporting.\n'))), /yielded no findings/);
});

test('audit report rejects an unknown status', () => {
  const file = report(finding('A-1', 'high', 'done'));
  assert.throws(() => parseFindings(loadReport(file)), /Unknown status.*A-1 \(done\)/);
});

test('audit report rejects a malformed meta delimiter', () => {
  const file = report(finding('A-1', 'high').replace('· correctness ·', '| correctness |'));
  assert.throws(() => parseFindings(loadReport(file)), /Unreadable severity line.*A-1/);
});
