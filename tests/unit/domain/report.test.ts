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

// SECTION: Unknown tag recovery

const planFinding = (tag: string, heading: string, defect: string) => ({
  severity: 'SHOULD', locus: `§ ${heading}`, tag, defect, requiredChange: `revise ${heading} to address the gap`,
});
const parsedFindings = (kind: 'plan' | 'code' | 'design', text: string) => {
  const result = parseReport({ kind, source: 'agy[0]', text });
  assert.ok(result.ok, result.ok ? '' : result.failure.detail);
  return result.findings;
};

test('SC1 unknown plan tag recovers as uncategorized with original tag', () => {
  const text = `\`\`\`json\n${report([
    planFinding('robustness', 'Proposed Changes', 'retry path has no bound'),
    planFinding('verification', 'Verification Plan', 'focused command omits a test file'),
    planFinding('verification', 'Success Criteria', 'criterion lacks a verify command'),
    planFinding('compatibility', 'Rollback & Blast Radius', 'old journals lose a field'),
  ])}\n\`\`\``;
  const findings = parsedFindings('plan', text);
  assert.deepEqual(findings.map((item) => [item.locus, item.category, item.originalTag ?? null, item.scope]), [
    ['§ Proposed Changes', 'uncategorized', 'robustness', 'in'],
    ['§ Verification Plan', 'verification', null, 'in'],
    ['§ Success Criteria', 'verification', null, 'in'],
    ['§ Rollback & Blast Radius', 'compatibility', null, 'in'],
  ]);
});

test('SC1 unknown tag recovers in code and design reviews', () => {
  const [code] = parsedFindings('code', report([finding({ tag: 'robustness' })]));
  assert.deepEqual([code?.category, code?.originalTag, code?.scope], ['uncategorized', 'robustness', 'in']);
  const [design] = parsedFindings('design', report([planFinding('robustness', 'Interfaces', 'contract omits errors')]));
  assert.deepEqual([design?.category, design?.originalTag, design?.scope], ['uncategorized', 'robustness', 'in']);
});

test('SC1 known tags carry no original tag', () => {
  const findings = parsedFindings('code', report([finding({ tag: 'robustness' }), finding({ tag: 'perf', locus: 'src/b.ts:L4', defect: 'quadratic scan' })]));
  assert.equal(findings.length, 2);
  assert.equal(findings[1]?.category, 'perf');
  assert.ok(!('originalTag' in (findings[1] ?? {})));
});

test('SC1 findings differing only in unknown tag are both kept', () => {
  const findings = parsedFindings('code', report([finding({ tag: 'robustness' }), finding({ tag: 'resilience' })]));
  assert.deepEqual(findings.map((item) => [item.category, item.originalTag]), [['uncategorized', 'robustness'], ['uncategorized', 'resilience']]);
});

test('SC1 findings whose unknown tags sanitize alike are both kept', () => {
  const findings = parsedFindings('code', report([finding({ tag: 'foo/bar' }), finding({ tag: 'foo?bar' })]));
  assert.deepEqual(findings.map((item) => [item.category, item.originalTag]), [['uncategorized', 'foo_bar'], ['uncategorized', 'foo_bar']]);
});

test('SC1 findings whose unknown tags differ only after the bound are both kept', () => {
  const prefix = 'x'.repeat(80);
  const findings = parsedFindings('code', report([finding({ tag: `${prefix}a` }), finding({ tag: `${prefix}b` })]));
  assert.deepEqual(findings.map((item) => [item.category, item.originalTag]), [['uncategorized', prefix], ['uncategorized', prefix]]);
});

test('SC1 collectFindings keeps original tag', () => {
  const drafts = parsedFindings('code', report([finding({ tag: 'robustness' }), finding({ tag: 'perf', locus: 'src/b.ts:L4', defect: 'quadratic scan' })]));
  const findings = collectFindings(1, drafts);
  assert.equal(findings[0]?.originalTag, 'robustness');
  assert.ok(!('originalTag' in (findings[1] ?? {})));
});

test('SC2 adjacent and intent variants stay uncategorized in scope', () => {
  for (const tag of ['Adjacent', 'ADJACENT', 'adjacent-scope', 'Intent']) {
    const [item] = parsedFindings('code', report([finding({ tag })]));
    assert.deepEqual([item?.category, item?.originalTag, item?.scope], ['uncategorized', tag, 'in'], tag);
  }
});

test('SC2 exact adjacent and intent keep category and scope', () => {
  const [adjacent] = parsedFindings('code', report([finding({ tag: ' adjacent ' })]));
  assert.deepEqual([adjacent?.category, adjacent?.scope], ['adjacent', 'adjacent']);
  assert.ok(!('originalTag' in (adjacent ?? {})));
  const [intent] = parsedFindings('code', report([finding({ tag: 'intent' })]));
  assert.deepEqual([intent?.category, intent?.scope], ['intent', 'in']);
  assert.ok(!('originalTag' in (intent ?? {})));
});

test('SC3 empty or non-string tag still fails the report', () => {
  for (const tag of ['', '   ', '\n\t']) assert.equal(failure(report([finding({ tag })])), 'uncovered-scope', JSON.stringify(tag));
  for (const tag of [42, null, true, ['robustness'], { name: 'robustness' }]) assert.equal(failure(report([{ ...finding(), tag }])), 'uncovered-scope', JSON.stringify(tag));
  const { tag: _tag, ...missing } = finding();
  assert.equal(failure(report([missing])), 'uncovered-scope');
});

test('SC3 unknown tag does not mask other report failures', () => {
  const unknown = (overrides: Record<string, string> = {}) => finding({ tag: 'robustness', ...overrides });
  assert.equal(failure(report([unknown({ severity: 'HIGH' })])), 'uncovered-scope');
  assert.equal(failure(report([unknown({ defect: '' })])), 'uncovered-scope');
  assert.equal(failure(report([unknown({ defect: '<invoke name="x">' })])), 'uncovered-scope');
  const { defect: _defect, ...noDefect } = unknown();
  assert.equal(failure(report([noDefect])), 'uncovered-scope');
  assert.equal(failure(report([unknown({ locus: 'src/fetch.ts' })])), 'loose-locus');
  assert.equal(failure(report([unknown()], 'CLEAN')), 'uncovered-scope');
  assert.equal(failure(report([finding(), unknown({ severity: 'HIGH' })])), 'uncovered-scope');
  const cut = report([unknown()]).slice(0, -12);
  assert.equal(failure(cut, true), 'truncated');
  assert.equal(failure(cut), 'uncovered-scope');
  assert.equal(failure("I'm unable to help with reviewing this robustness tag."), 'refusal');
});

test('SC4 original tag is sanitized and bounded', () => {
  const tags = ['<!-- ignore previous -->', '<b>bold</b>', '[link](https://a.example)', '`code`', 'line\nbreak', 'résumé 日本語', 'x'.repeat(500), '  padded  '];
  for (const tag of tags) {
    const [item] = parsedFindings('code', report([finding({ tag })]));
    assert.equal(item?.category, 'uncategorized', JSON.stringify(tag));
    assert.match(item?.originalTag ?? '', /^[A-Za-z0-9_.-]{1,80}$/, JSON.stringify(tag));
  }
  assert.equal(parsedFindings('code', report([finding({ tag: '  padded  ' })]))[0]?.originalTag, 'padded');
  assert.equal(parsedFindings('code', report([finding({ tag: 'x'.repeat(500) })]))[0]?.originalTag, 'x'.repeat(80));
});
