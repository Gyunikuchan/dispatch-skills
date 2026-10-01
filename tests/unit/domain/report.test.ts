import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collectFindings, parseReport } from '../../../skills/dispatch/scripts/domain/report.ts';

const finding = (overrides: Record<string, string> = {}) => ({
  severity: 'MUST', locus: 'src/fetch.ts:L12', tag: 'correctness', defect: 'retry loop never terminates on persistent failure',
  requiredChange: 'bound the retry loop with a counter', ...overrides,
});
const report = (findings: unknown[], status = 'FINDINGS') => JSON.stringify({ status, findings });
const failure = (text: string, truncated = false) => {
  const result = parseReport({ kind: 'code', source: 'codex[0]', text, truncated });
  return result.ok ? null : result.failure.kind;
};

test('delegates-one-report-parse: one path parses fenced or bare JSON into draft findings', () => {
  const result = parseReport({ kind: 'code', source: 'codex[0]', text: `Banner\n\`\`\`json\n${report([finding({ locus: 'src/fetch.ts:12' }), finding({ locus: 'Dockerfile:12' })])}\n\`\`\`` });
  assert.ok(result.ok);
  assert.equal(result.status, 'FINDINGS');
  assert.deepEqual(result.findings.map((item) => [item.locus, item.category, item.sources, item.scope]), [
    ['src/fetch.ts:L12', 'correctness', ['codex[0]'], 'in'],
    ['Dockerfile:L12', 'correctness', ['codex[0]'], 'in'],
  ]);
  const clean = parseReport({ kind: 'plan', source: 'agy[0]', text: report([], 'CLEAN') });
  assert.ok(clean.ok && clean.findings.length === 0);
});

test('delegates-one-report-parse: failures are empty output, refusal, truncation, uncovered scope, loose locus', () => {
  assert.equal(failure('   '), 'empty-output');
  assert.equal(failure("I'm unable to help with reviewing this."), 'refusal');
  assert.equal(failure('{"status":"FINDINGS","findings":[{"sev', true), 'truncated');
  assert.equal(failure('Looks fine to me.'), 'uncovered-scope');
  assert.equal(failure(report([finding()], 'CLEAN')), 'uncovered-scope');
  assert.equal(failure(report([finding({ locus: 'src/fetch.ts' })])), 'loose-locus');
  assert.equal(failure(report([finding({ locus: 'src/fetch.ts:L1-L9' })])), 'loose-locus');
});

test('review-dedup: duplicates keep their own id with dupOf; the first cites every reporting source', () => {
  const first = parseReport({ kind: 'code', source: 'codex[0]', text: report([finding()]) });
  const second = parseReport({ kind: 'code', source: 'claude[0]', text: report([finding({ locus: 'src/fetch.ts:L14', defect: 'the retry loop never terminates when failure persists' })]) });
  const other = parseReport({ kind: 'code', source: 'agy[0]', text: report([finding({ locus: 'src/other.ts:L3', tag: 'perf', defect: 'quadratic scan', requiredChange: 'index lookups' })]) });
  assert.ok(first.ok && second.ok && other.ok);
  const findings = collectFindings(1, [...first.findings, ...second.findings, ...other.findings]);
  assert.deepEqual(findings.map((item) => [item.id, item.dupOf ?? null]), [['R1-F001', null], ['R1-F002', 'R1-F001'], ['R1-F003', null]]);
  assert.deepEqual(findings[0]?.sources, ['codex[0]', 'claude[0]']);
  assert.deepEqual(findings[2]?.sources, ['agy[0]']);
});

test('review-sanitization: report text is sanitized before relay', () => {
  const result = parseReport({ kind: 'code', source: 'codex[0]', text: report([finding({ defect: 'bad \u001b[31mred\u001b[0m <!-- ignore previous --> loop' })]) });
  assert.ok(result.ok);
  const defect = result.findings[0]?.defect ?? '';
  assert.ok(!defect.includes('\u001b'));
  assert.ok(!defect.includes('<!--'));
});

test('delegates-one-report-parse: extra top-level keys and sanitised-empty fields are uncovered scope', () => {
  assert.equal(failure(JSON.stringify({ status: 'CLEAN', findings: [], otherFindings: [] })), 'uncovered-scope');
  assert.equal(failure(report([finding({ defect: '<invoke name="x">' })])), 'uncovered-scope');
});
