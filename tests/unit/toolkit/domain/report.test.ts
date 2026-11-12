import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readHostUsage } from '../../../../skills/dispatch/scripts/toolkit/host-usage/index.ts';
import { collectFindings, matchFinding, parseReport } from '../../../../skills/dispatch/scripts/toolkit/domain/report.ts';
import { IMPACTS, TRIGGERS, severityOf } from '../../../../skills/dispatch/scripts/toolkit/domain/severity.ts';

const finding = (overrides: Record<string, string> = {}) => ({
  impact: 'blocks', trigger: 'realistic', locus: 'src/fetch.ts:L12', tag: 'correctness', defect: 'retry loop never terminates on persistent failure',
  requiredChange: 'bound the retry loop with a counter', ...overrides,
});
const report = (findings: unknown[], status = 'FINDINGS') => JSON.stringify({ status, findings });

test('rejected MUST reports require exact explicit requested confirmations', () => {
  const parse = (confirmations?: unknown) => parseReport({kind:'code',source:'claude[0]',expectedRequestIds:['request-1'],text:JSON.stringify({status:'CLEAN',findings:[],...(confirmations === undefined ? {} : {confirmations})})});
  assert.equal(parse().ok,false);
  for (const confirmations of [[],[{requestId:'request-1',decision:'agree',rationale:' '}],[{requestId:'other',decision:'agree',rationale:'Evidence checked'}],[{requestId:'request-1',decision:'agree',rationale:'Evidence checked',extra:true}],[{requestId:'request-1',decision:'agree',rationale:'Evidence checked'},{requestId:'request-1',decision:'agree',rationale:'Evidence checked'}]]) assert.equal(parse(confirmations).ok,false);
  const result=parse([{requestId:'request-1',decision:'agree',rationale:'Evidence checked'}]);
  assert.equal(result.ok,true);
  if(result.ok) assert.equal(result.confirmations?.[0]?.decision,'agree');
});

const familyTags = [
  'intent', 'spec', 'correctness', 'reliability', 'security', 'performance', 'compatibility', 'maintainability',
  'architecture', 'decomposition', 'operability', 'testing', 'usability', 'standards', 'adjacent',
] as const;
const unknownTags = ['custom-tag', 'unrecognized-label', 'vendor-tag'] as const;

test('family tags are shared across review kinds and unknown tags fall back to uncategorized', () => {
  for (const kind of ['code', 'plan', 'design'] as const) {
    const locus = kind === 'code' ? 'src/fetch.ts:L12' : '§ Spec: Requirements';
    for (const tag of familyTags) {
      const result = parseReport({ kind, source: 'codex[0]', text: report([finding({ tag, locus })]) });
      assert.ok(result.ok, `${kind} accepts ${tag}`);
      assert.equal(result.findings[0]?.category, tag === 'spec' ? 'intent' : tag, `${kind}: ${tag}`);
      assert.equal(result.findings[0]?.scope, tag === 'adjacent' ? 'adjacent' : 'in', `${kind}: ${tag}`);
      assert.equal(result.findings[0]?.originalTag, undefined, `${kind}: ${tag}`);
    }
    for (const tag of unknownTags) {
      const result = parseReport({ kind, source: 'codex[0]', text: report([finding({ tag, locus })]) });
      assert.ok(result.ok, `${kind} recovers ${tag}`);
      assert.equal(result.findings[0]?.category, 'uncategorized', `${kind}: ${tag}`);
      assert.equal(result.findings[0]?.originalTag, tag, `${kind}: ${tag}`);
    }
  }
});
const failure = (text: string, truncated = false) => {
  const result = parseReport({ kind: 'code', source: 'codex[0]', text, truncated });
  return result.ok ? null : result.failure.kind;
};

const parseDetail = (text: string) => {
  const result = parseReport({ kind: 'code', source: 'codex[0]', text });
  return result.ok ? null : result.failure.detail;
};

test('derives severity from impact and trigger', () => {
  const table = {
    critical: { realistic: 'MUST', contrived: 'MUST' },
    blocks: { realistic: 'MUST', contrived: 'SHOULD' },
    degrades: { realistic: 'SHOULD', contrived: 'CONSIDER' },
    minor: { realistic: 'CONSIDER', contrived: 'CONSIDER' },
  } as const;
  for (const [impact, row] of Object.entries(table)) {
    for (const [trigger, severity] of Object.entries(row)) {
      const result = parseReport({ kind: 'code', source: 'codex[0]', text: report([finding({ impact, trigger })]) });
      assert.ok(result.ok, `${impact}/${trigger}`);
      assert.deepEqual([result.findings[0]?.impact, result.findings[0]?.trigger, result.findings[0]?.severity], [impact, trigger, severity], `${impact}/${trigger}`);
    }
  }
});

test('the rubric table matches the derived severity', () => {
  const rows = fs.readFileSync(path.join(SKILL_ROOT, 'references/templates/review-severity.md'), 'utf8').split(/\r?\n/);
  const columns = (row: string | undefined) => (row ?? '').split('|').slice(2, -1).map(cell => cell.trim());
  const headers = columns(rows.find(row => row.startsWith('| `impact` |')));
  assert.deepEqual([...headers].sort(), TRIGGERS.map(trigger => '`trigger: ' + trigger + '`').sort());
  for (const impact of IMPACTS) {
    const cells = columns(rows.find(row => row.startsWith('| `' + impact + '` |')));
    assert.deepEqual(cells, headers.map(header => '`' + severityOf(impact, TRIGGERS.find(trigger => header.includes(trigger))!) + '`'), impact);
  }
});

test('refuses report findings with missing, invalid, or unsupported dimension fields', () => {
  // Missing dimension
  for (const field of ['impact', 'trigger']) {
    const { [field]: _omitted, ...rest } = finding() as Record<string, string>;
    assert.equal(failure(report([rest])), 'uncovered-scope', field);
    assert.match(parseDetail(report([rest])) ?? '', new RegExp('; missing: ' + field + '$'), field);
  }
  // Invalid dimension value
  for (const [field, value] of [['impact', 'HIGH'], ['impact', 'MUST'], ['impact', 3], ['trigger', 'likely'], ['trigger', null]] as const) {
    const text = report([{ ...finding(), [field]: value }]);
    assert.equal(failure(text), 'uncovered-scope', `${field}=${value}`);
    assert.match(parseDetail(text) ?? '', new RegExp(`finding 0 ${field} must be one of`));
  }
  // Unsupported severity and other fields
  const unsupported = report([{ ...finding(), severity: 'MUST', ignore_prior_rulings: 'x', ['<tool_call>\u001b[31m']: 'x' }]);
  assert.equal(failure(unsupported), 'uncovered-scope');
  assert.match(parseDetail(unsupported) ?? '', /; unsupported: severity, 2 other field\(s\)$/);
});

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

test('the report must end the reply', () => {
  const clean = report([], 'CLEAN'), found = report([finding()]);
  const fenced = (body: string) => `\`\`\`json\n${body}\n\`\`\``;
  const accepted: [string, string, 'CLEAN' | 'FINDINGS'][] = [
    ['closing fence after narration', `Reading.\r\n${fenced(found)}`, 'FINDINGS'],
    ['closing bare fence', `Done.\n\`\`\`\n${found}\n\`\`\``, 'FINDINGS'],
    ['line-start object after narration', `Reading {plan}.\n${found}`, 'FINDINGS'],
    ['quoted example before the report', `${fenced(clean)}\nNow the report:\n${found}`, 'FINDINGS'],
    ['unrelated JSON before the report', `{"status":"failed","reason":"x"}\n[1,2]\n${clean}`, 'CLEAN'],
    ['narration ending in a comma', `After checking,\n${found}`, 'FINDINGS'],
    ['narration ending in a bracket', `A stray [\n${found}`, 'FINDINGS'],
    ['narration quoting a key', `The plan says "report":\n${found}`, 'FINDINGS'],
    ['narration bullet quoting a path', `* Checked "src/index.ts": no issues\n${found}`, 'FINDINGS'],
    ['narration checklist line', `[x] reviewed the plan\n${found}`, 'FINDINGS'],
    ['narration bracket heading', `[Summary]\n${found}`, 'FINDINGS'],
    ['line-start quoted label', `"src/a.ts": no issues\n${found}`, 'FINDINGS'],
    ['line-start quoted label with a pointer', `"report": see below\n${found}`, 'FINDINGS'],
    ['line-start label with a count', `"src/a.ts": 1 finding\n${found}`, 'FINDINGS'],
    ['unbalanced prose before the report', `A stray " and ( and [ and {\n${found}`, 'FINDINGS'],
    ['pretty-printed report', `Report:\n${JSON.stringify({ status: 'FINDINGS', findings: [finding()] }, null, 2)}`, 'FINDINGS'],
  ];
  for (const [name, text, status] of accepted) {
    const result = parseReport({ kind: 'code', source: 'codex[0]', text });
    assert.ok(result.ok, name);
    assert.equal(result.status, status, name);
  }
  const rejected: [string, string][] = [
    ['clean example then a cut-off report', `${clean}\nActual: {"status":"FINDINGS","findings":[`],
    ['clean example then relaxed JSON', `${clean}\nActual: {status:'FINDINGS',findings:[]}`],
    ['clean example then an inline report', `${fenced(clean)}\nActual: ${found}`],
    ['report then trailing prose', `${found}\nReview complete.`],
    ['clean report then a bare findings array', `${clean}\n[${JSON.stringify(finding())}]`],
    ['clean report then a non-report object', `${clean}\n{"status":"FINDNGS","findings":[]}`],
    ['fenced non-report', fenced('{"status":"done"}')],
    ['cut-off report ending at a nested clean report', `Narration
{"status":"FINDINGS","findings":[
${clean}`],
    ['cut-off report with a nested clean report after a comma', `{"status":"FINDINGS","findings":[
${JSON.stringify(finding())},
${clean}`],
    ['cut-off report with a spaced key colon', `{"status":"FINDINGS","findings" :\n${clean}`],
    ['cut-off report with an object value', `{"status":"FINDINGS","notes":{\n${clean}`],
    ['cut-off pretty report after a closing line', `{"status":"FINDINGS","findings":[\n{\n"severity":"MUST"\n},\n${clean}`],
    ['cut-off report after a scalar row', `{"status":"FINDINGS","findings":[\n"a",\n${clean}`],
    ['cut-off report after an array row', `{"status":"FINDINGS","findings":[\n[1,2],\n${clean}`],
    ['cut-off report after a malformed value', `{"status":"FINDINGS","findings":[\n{"severity": MUST,\n${clean}`],
    ['cut-off report ending at a finding', `{"status":"FINDINGS","findings":[\n${JSON.stringify(finding())}`],
  ];
  for (const [name, text] of rejected) assert.equal(failure(text), 'uncovered-scope', name);
});

test('a narrated report with many findings parses', () => {
  const rows = Array.from({ length: 1100 }, (_, i) => JSON.stringify(finding({ locus: `src/fetch.ts:L${i + 1}` }))).join(',\n');
  const result = parseReport({ kind: 'code', source: 'codex[0]', text: `Note:\n{"status":"FINDINGS","findings":[\n${rows}\n]}` });
  assert.ok(result.ok);
  assert.equal(result.findings.length, 1100);
});

test('a fence or tagged fence inside a JSON string does not end the report', () => {
  for (const defect of ['the ``` delimiter', 'use a ```json block']) {
    const body = JSON.stringify({ status: 'FINDINGS', findings: [finding({ defect })] });
    assert.equal(parseReport({ kind: 'code', source: 'codex[0]', text: 'Note\n```json\n' + body + '\n```' }).ok, true);
  }
});

test('degenerate fences and large malformed replies stay bounded', () => {
  const started = Date.now();
  assert.equal(parseReport({ kind: 'code', source: 'codex[0]', text: '```' + ' '.repeat(50000) + 'x\n```y```' }).ok, false);
  const text = `${'{"a":\n'.repeat(2000)}{"status":1}`;
  assert.equal(parseReport({ kind: 'code', source: 'codex[0]', text }).ok, false);
  assert.ok(Date.now() - started < 2000, 'malformed replies exceeded budget');
});

test('delegates-one-report-parse: failures are empty output, refusal, truncation, uncovered scope', () => {
  assert.equal(failure('   '), 'empty-output');
  assert.equal(failure("I'm unable to help with reviewing this."), 'refusal');
  assert.equal(failure('{"status":"FINDINGS","findings":[{"sev', true), 'truncated');
  assert.equal(failure('Looks fine to me.'), 'uncovered-scope');
  assert.equal(failure(report([finding()], 'CLEAN')), 'uncovered-scope');
  assert.equal(failure(JSON.stringify({ status: 'CLEAN', findings: [], otherFindings: [] })), 'uncovered-scope');
  assert.equal(failure(report([finding({ defect: '<invoke name="x">' })])), 'uncovered-scope');
});

const MARK = 'unresolved-locus: ';
const planLocus = '§ Work';
const parsedLoci = (kind: 'code' | 'plan', findings: unknown[]) => {
  const result = parseReport({ kind, source: 'codex[0]', text: report(findings) });
  assert.ok(result.ok);
  return result.findings.map(item => item.locus);
};

test('loose locus keeps findings: only the loose locus of a reply is marked, in every kind', () => {
  assert.deepEqual(parsedLoci('plan', [finding({ locus: 'A – T5 – Fix skill' }), finding({ locus: planLocus, defect: 'second defect' })]), [MARK + 'A – T5 – Fix skill', planLocus]);
  assert.deepEqual(parsedLoci('code', [finding({ locus: 'src/fetch.ts:L1-L9' }), finding({ defect: 'second defect' })]), [MARK + 'src/fetch.ts:L1-L9', 'src/fetch.ts:L12']);
  assert.deepEqual(parsedLoci('code', [finding({ locus: 'src/fetch.ts:12' })]), ['src/fetch.ts:L12']);
  assert.deepEqual(parsedLoci('plan', [finding({ locus: ' a\n\t<!-- b -->\u001b[31m c ' })]), [MARK + 'a &lt;!-- b --&gt; c']);
  for (const locus of ['', '   ', 42, null, ['§ Work']]) assert.deepEqual(parsedLoci('plan', [{ ...finding(), locus }]), [MARK + '(none)'], JSON.stringify(locus));
});

test('loose locus keeps findings: clipping stays within 120 bytes, splits no character and merges no findings', () => {
  const head = 'é'.repeat(100);
  const loci = parsedLoci('plan', [finding({ locus: head + ' first' }), finding({ locus: head + ' second' })]);
  assert.equal(loci.length, 2);
  assert.equal(loci[0], loci[1]);
  const shown = loci[0]!.slice(MARK.length);
  assert.ok(Buffer.byteLength(shown) <= 120, shown);
  assert.ok(shown.endsWith('é…'), shown);
  assert.equal(parsedLoci('plan', [finding({ locus: 'same loose' }), finding({ locus: 'same loose' })]).length, 1);
  assert.deepEqual(parsedLoci('plan', [finding({ locus: 'a\nb' }), finding({ locus: 'a b' })]), [MARK + 'a b', MARK + 'a b']);
});

test('loose locus keeps findings: other malformed replies keep their failure class', () => {
  const loose = { locus: 'src/fetch.ts' };
  assert.equal(failure(report([finding(loose), finding({ impact: 'HIGH' })])), 'uncovered-scope');
  assert.equal(failure(report([finding({ ...loose, defect: '' })])), 'uncovered-scope');
  assert.equal(failure(report([finding(loose)], 'CLEAN')), 'uncovered-scope');
  assert.equal(failure(report([finding(loose)]).slice(0, -12), true), 'truncated');
});

test('loose locus keeps findings: a marked finding never matches by location', () => {
  const parse = (source: string) => {
    const result = parseReport({ kind: 'plan', source, text: report([finding({ locus: 'A – T5' })]) });
    assert.ok(result.ok);
    return result.findings;
  };
  const findings = collectFindings(1, [...parse('codex[0]'), ...parse('claude[0]')]);
  assert.deepEqual(findings.map(item => [item.dupOf ?? null, item.sources]), [[null, ['codex[0]']], [null, ['claude[0]']]]);
  const key = { locus: MARK + 'A – T5', category: 'correctness', text: 'retry loop never terminates' };
  assert.equal(matchFinding(key, key), false);
  assert.equal(matchFinding(key, { ...key, locus: '§ Work' }), false);
  assert.equal(matchFinding({ ...key, locus: '§ Work' }, { ...key, locus: '§ Work' }), true);
});

test('blocked json reports validate and sanitize reason', () => {
  const lineStart = parseReport({ kind: 'code', source: 'codex[0]', text: `Note\n${JSON.stringify({ reason: 'target unreadable', status: 'BLOCKED' })}` });
  assert.ok(!lineStart.ok);
  assert.equal(lineStart.failure.kind, 'blocked');
  assert.match(lineStart.failure.detail, /target unreadable/);
  const valid = parseReport({ kind: 'plan', source: 'codex[0]', text: JSON.stringify({ status: 'BLOCKED', reason: '  Session artifact denied by the guard  ' }) });
  assert.equal(valid.ok, false);
  if (!valid.ok) assert.deepEqual(valid.failure, { kind: 'blocked', detail: 'Session artifact denied by the guard' });

  for (const text of [
    JSON.stringify({ status: 'BLOCKED' }),
    JSON.stringify({ status: 'BLOCKED', reason: '   ' }),
    JSON.stringify({ status: 'BLOCKED', reason: 42 }),
    JSON.stringify({ status: 'BLOCKED', findings: [] }),
  ]) assert.equal(failure(text), 'uncovered-scope', text);
});

test('review-dedup: duplicates keep their own id with dupOf; the first cites every reporting source', () => {
  const first = parseReport({ kind: 'code', source: 'codex[0]', text: report([finding()]) });
  const second = parseReport({ kind: 'code', source: 'claude[0]', text: report([finding({ locus: 'src/fetch.ts:L14', defect: 'the retry loop never terminates when failure persists' })]) });
  const other = parseReport({ kind: 'code', source: 'agy[0]', text: report([finding({ locus: 'src/other.ts:L3', tag: 'performance', defect: 'quadratic scan', requiredChange: 'index lookups' })]) });
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

// SECTION: Unknown tag recovery

const planFinding = (tag: string, heading: string, defect: string) => ({
  impact: 'degrades', trigger: 'realistic', locus: `§ ${heading}`, tag, defect, requiredChange: `revise ${heading} to address the gap`,
});
const parsedFindings = (kind: 'plan' | 'code' | 'design', text: string) => {
  const result = parseReport({ kind, source: 'agy[0]', text });
  assert.ok(result.ok, result.ok ? '' : result.failure.detail);
  return result.findings;
};

test('collected findings preserve unknown tags across review kinds, sanitizing collisions', () => {
  // Plan review recovery
  const planText = `\`\`\`json\n${report([
    planFinding('robustness', 'Proposed Changes', 'retry path has no bound'),
    planFinding('testing', 'Verification Plan', 'focused command omits a test file'),
  ])}\n\`\`\``;
  const planFindings = parsedFindings('plan', planText);
  assert.deepEqual(planFindings.map((item) => [item.locus, item.category, item.originalTag ?? null]), [
    ['§ Proposed Changes', 'uncategorized', 'robustness'],
    ['§ Verification Plan', 'testing', null],
  ]);

  // Code and design review recovery
  const [code] = parsedFindings('code', report([finding({ tag: 'robustness' })]));
  assert.deepEqual([code?.category, code?.originalTag, code?.scope], ['uncategorized', 'robustness', 'in']);
  const [design] = parsedFindings('design', report([planFinding('robustness', 'Interfaces', 'contract omits errors')]));
  assert.deepEqual([design?.category, design?.originalTag, design?.scope], ['uncategorized', 'robustness', 'in']);

  // Collection preserves originalTag alongside known categories
  const drafts = parsedFindings('code', report([finding({ tag: 'robustness' }), finding({ tag: 'performance', locus: 'src/b.ts:L4', defect: 'quadratic scan' })]));
  const findings = collectFindings(1, drafts);
  assert.equal(findings.length, 2);
  assert.equal(findings[0]?.originalTag, 'robustness');
  assert.equal(findings[1]?.category, 'performance');
  assert.ok(!('originalTag' in (findings[1] ?? {})));

  // Distinct, sanitized-alike, and length-bounded unknown tags preserve separate findings
  const diff = parsedFindings('code', report([finding({ tag: 'robustness' }), finding({ tag: 'resilience' })]));
  assert.deepEqual(diff.map((item) => [item.category, item.originalTag]), [['uncategorized', 'robustness'], ['uncategorized', 'resilience']]);

  const alike = parsedFindings('code', report([finding({ tag: 'foo/bar' }), finding({ tag: 'foo?bar' })]));
  assert.deepEqual(alike.map((item) => [item.category, item.originalTag]), [['uncategorized', 'foo_bar'], ['uncategorized', 'foo_bar']]);

  const prefix = 'x'.repeat(80);
  const bounded = parsedFindings('code', report([finding({ tag: `${prefix}a` }), finding({ tag: `${prefix}b` })]));
  assert.deepEqual(bounded.map((item) => [item.category, item.originalTag]), [['uncategorized', prefix], ['uncategorized', prefix]]);
});

test('adjacent and intent tag handling preserves exact keywords and treats variants as uncategorized', () => {
  for (const tag of ['Adjacent', 'ADJACENT', 'adjacent-scope', 'Intent']) {
    const [item] = parsedFindings('code', report([finding({ tag })]));
    assert.deepEqual([item?.category, item?.originalTag, item?.scope], ['uncategorized', tag, 'in'], tag);
  }
  const [adjacent] = parsedFindings('code', report([finding({ tag: ' adjacent ' })]));
  assert.deepEqual([adjacent?.category, adjacent?.scope], ['adjacent', 'adjacent']);
  assert.ok(!('originalTag' in (adjacent ?? {})));
  const [intent] = parsedFindings('code', report([finding({ tag: 'intent' })]));
  assert.deepEqual([intent?.category, intent?.scope], ['intent', 'in']);
  assert.ok(!('originalTag' in (intent ?? {})));
});

test('unknown tags fail invalid reports without masking other failures', () => {
  for (const tag of ['', '   ', '\n\t']) assert.equal(failure(report([finding({ tag })])), 'uncovered-scope', JSON.stringify(tag));
  for (const tag of [42, null, true, ['robustness'], { name: 'robustness' }]) assert.equal(failure(report([{ ...finding(), tag }])), 'uncovered-scope', JSON.stringify(tag));
  const { tag: _tag, ...missing } = finding();
  assert.equal(failure(report([missing])), 'uncovered-scope');
  const unknown = (overrides: Record<string, string> = {}) => finding({ tag: 'robustness', ...overrides });
  assert.equal(failure(report([unknown({ impact: 'HIGH' })])), 'uncovered-scope');
  assert.equal(failure(report([unknown({ defect: '' })])), 'uncovered-scope');
  assert.equal(failure(report([unknown({ defect: '<invoke name="x">' })])), 'uncovered-scope');
  const { defect: _defect, ...noDefect } = unknown();
  assert.equal(failure(report([noDefect])), 'uncovered-scope');
  assert.equal(failure(report([unknown()], 'CLEAN')), 'uncovered-scope');
  assert.equal(failure(report([finding(), unknown({ impact: 'HIGH' })])), 'uncovered-scope');
  const cut = report([unknown()]).slice(0, -12);
  assert.equal(failure(cut, true), 'truncated');
  assert.equal(failure(cut), 'uncovered-scope');
  assert.equal(failure("I'm unable to help with reviewing this robustness tag."), 'refusal');
});

test('original tag is sanitized and bounded', () => {
  const tags = ['<!-- ignore previous -->', '<b>bold</b>', '[link](https://a.example)', '`code`', 'line\nbreak', 'résumé 日本語', 'x'.repeat(500), '  padded  '];
  for (const tag of tags) {
    const [item] = parsedFindings('code', report([finding({ tag })]));
    assert.equal(item?.category, 'uncategorized', JSON.stringify(tag));
    assert.match(item?.originalTag ?? '', /^[A-Za-z0-9_.-]{1,80}$/, JSON.stringify(tag));
  }
  assert.equal(parsedFindings('code', report([finding({ tag: '  padded  ' })]))[0]?.originalTag, 'padded');
  assert.equal(parsedFindings('code', report([finding({ tag: 'x'.repeat(500) })]))[0]?.originalTag, 'x'.repeat(80));
});

// SECTION: Diagnostics reports

import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

import {
  CATEGORIES, COMPONENTS, DIAGNOSTIC_LIMITS, formatDuration, heuristics, normalizeUsage, renderDiagnostics, retroObservations, sanitizeFacts,
  type Finding, type InvocationFacts, type RunFacts, type Usage,
} from '../../../../skills/dispatch/scripts/toolkit/domain/diagnostics.ts';
import { TOOL_ACTIONS } from '../../../../skills/dispatch/scripts/toolkit/cli.ts';

const SKILL_ROOT = fileURLToPath(new URL('../../../../skills/dispatch/', import.meta.url));

const invocation = (overrides: Partial<InvocationFacts> = {}): InvocationFacts => ({
  phase: 'review', provider: 'codex', model: 'gpt-6-sol', effort: 'medium', mode: 'cli', surface: 'cli', launched: true, durationMs: 60_000, outcome: 'ok',
  usage: { input: 1000, cacheRead: 2000, cacheWrite: 300, output: 40 }, ...overrides,
});
const bare = (overrides: Partial<InvocationFacts> = {}): InvocationFacts => {
  const { usage: _usage, ...rest } = invocation(overrides);
  return rest;
};
const facts = (overrides: Partial<RunFacts> = {}): RunFacts => ({
  version: '0.7.1', build: 'ab'.repeat(32), os: 'windows', host: 'claude', verb: 'review', level: 'medium', outcome: 'complete',
  phases: [{ key: 'review', name: 'code review', outcome: 'complete', wallMs: 3_723_000, driverMs: 45_000, hostMs: 60_000, userMs: 400 }],
  invocations: [invocation()], reviews: [], ...overrides,
});
const observation = (overrides: Record<string, unknown> = {}) => ({
  id: 'o1', component: 'scripts/toolkit/records.ts', category: 'instruction-clarity',
  evidence: 'The `rule` frame reply template omits the allowed verdict values.', impact: 'Hosts send invalid rulings and need a second turn.',
  proposedFix: 'List the verdict values in the reply template and check them in validate.', ...overrides,
});
const render = (runs: RunFacts[]) => renderDiagnostics(runs).text;
test('diagnostics config renders explore-subagents and redacts read-command locators', () => {
  const config = { 'explore-subagents': { codex: { model: 'gpt-6-luna', effort: 'low' } } };
  const sanitized = sanitizeFacts(facts({ config }));
  assert.deepEqual(sanitized.config?.['explore-subagents'], config['explore-subagents']);
  const text = render([facts({ config })]);
  assert.match(text, /"explore-subagents": \{/);
  assert.match(text, /"effort": "low"/);
  const redacted = sanitizeFacts(facts({ config: { 'read-commands': ['codegraph explore', 'tool /home/me/x', 'tool https://x.io'] } }));
  assert.deepEqual(redacted.config?.['read-commands'], ['codegraph explore', '—', '—']);
});
test('diagnostics render one subject per phase cell and bound observed collection coverage', () => {
 const subject='1234567890abcdef';
 const generations=['1111222233334444','aaaabbbbccccdddd'];
 const text=render([facts({phases:[{key:'review-'+subject,name:'code review'}],invocations:[
  invocation({phase:'review-'+subject,subject:generations[0]!,attempt:1,slot:'codex[0]'}),
  invocation({phase:'review-'+subject,subject:generations[0]!,attempt:2,slot:'codex[0]'}),
  invocation({phase:'review-'+subject,subject:generations[1]!,attempt:1,slot:'codex[0]'}),
 ]})]);
 for(const line of text.split('\n').filter(line=>line.startsWith('|')&&line.includes('subject')))assert.equal(line.match(/subject /g)?.length,1,line);
 for(const identity of [`${generations[0]}/1`,`${generations[0]}/2`,`${generations[1]}/1`])assert.ok(text.includes(`subject ${subject} · attempt ${identity} · slot codex[0]`),identity);
 const ask=render([facts({phases:[{key:'ask',name:'ask'}],invocations:[invocation({phase:'ask',subject:generations[0]!,attempt:3,slot:'codex[0]'})]})]);
 assert.ok(ask.includes(`ask · subject ${generations[0]} · attempt 3 · slot codex[0]`));
 assert.match(text,/Full collection coverage is unavailable/);
 assert.equal(sanitizeFacts(facts({collection:{completed:9_000_000}})).collection?.completed,1_000_000);
});
test('diagnostics distinguish invalid retro native completion and unavailable coverage', () => {
  for (const observations of [{}, null, 'bad']) {
    assert.equal((retroObservations(observations) as {state?: string}).state, 'invalid');
    assert.match(render([facts({observations})]), /Host retro: invalid/);
  }
  assert.match(render([facts({observations: []})]), /Host retro: empty/);
  for (const retroState of ['missing','malformed','unreadable'] as const) assert.match(render([facts({retroState})]), new RegExp(`Host retro: ${retroState}`));
  const text=render([facts({invocations:[bare({surface:'native',launched:false,nativeState:'completed',outcome:'ok',subject:'a'.repeat(16),attempt:0}),bare({surface:'native',launched:false,nativeState:'pending',outcome:'native-pending',attempt:0})]})]);
  assert.match(text,/native completed/); assert.match(text,/native pending/);
  assert.doesNotMatch(text,/attempt 0\b|\/0\b/);
  assert.doesNotMatch(text,/ok \(not launched\)/);
  assert.match(text,/launch coverage —/);
  assert.match(render([facts({invocations:[invocation({usage:{input:0,output:0}})]})]),/measured tokens: 0 /);
  const semantic=render([facts({invocations:[invocation({slot:'codex[0]',validationOutcome:'schema'}),invocation({slot:'codex[0]',validationOutcome:'schema'})]})]);
  assert.match(semantic,/`schema`: 2 of 2 CLI attempts failed/);
  assert.match(semantic,/ok · validation schema/);
});

test('diagnostics render collection health and provenance within privacy limits', () => {
  const text=render([facts({collection:{corrupt:2,incomplete:1,storageFailed:1},provenance:[{version:'1.2.3',build:'ab'.repeat(32),config:{diagnostics:true,'api-key':'secret-canary','read-delegates':{codex:{model:'/home/canary/model'}}}}]})]);
  assert.match(text,/Collection health: partial/); assert.match(text,/corrupt 2/);assert.match(text,/incomplete 1/);assert.match(text,/storage-failed 1/);
  assert.match(text,/dispatch 1\.2\.3 · build abababababab/);assert.match(text,/Total storage loss can be unobservable/);
  assert.doesNotMatch(text,/canary|api-key|secret/);assert.ok(Buffer.byteLength(text)<=DIAGNOSTIC_LIMITS.reportBytes);
});
const only = (findings: readonly Finding[], source: string) => findings.filter((f) => f.source === source);
function assertShape(finding: Finding | undefined, category: keyof typeof CATEGORIES): Finding {
  assert.ok(finding, 'finding expected');
  assert.equal(finding.category, category);
  assert.ok(COMPONENTS.has(finding.component), `dispatch component: ${finding.component}`);
  for (const field of [finding.evidence, finding.impact, finding.proposedFix]) assert.ok(field.trim().length > 0);
  return finding;
}

// SECTION: Layout, durations, and token columns

test('diagnostics report: renders summary shell with sections, version, and durations', () => {
  const text = render([facts()]);
  const at = ['## Summary', '## Overview', '## Findings', '## Appendix', '<details>'].map((marker) => text.indexOf(marker));
  assert.ok(at.every((index) => index >= 0), `all sections present: ${at.join(',')}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  assert.match(text, /^- Build: dispatch 0\.7\.1 · build abababababab$/m);
  const { version: _version, ...rest } = facts();
  assert.match(render([{ ...rest, build: 'not-a-hash' }]), /^- Build: dispatch — · build —$/m);
  assert.equal(formatDuration(3_723_000), '1h 2m 3s');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(400), '<1s');
  assert.equal(formatDuration(undefined), '—');
});

test('diagnostics report: renders duration, token, and estimate columns with unavailable handling', () => {
  const text = render([facts()]);
  assert.match(text, /\| Phase \| Outcome \| Wall \| Driver \| Host \| User wait \|/);
  assert.ok(text.includes('| 1 · review · medium | code review | complete | 1h 2m 3s | 45s | 1m 0s | <1s | 1 |'), text);
  assert.match(text, /^- Runs: 1 · measured duration: 1h 2m 3s$/m);
  assert.match(text, /\| Input \| Cache read \| Cache write \| Output \|/);
  assert.ok(text.includes('| 1 | 1,000 | 2,000 | 300 | 40 | 1/1 |'), text);
  assert.match(text, /^- Provider CLI measured tokens: 3,340 \(input 1,000 · cache read 2,000 · cache write 300 · output 40\) · launch coverage 1\/1$/m);
  const partial = render([facts({
    phases: [{ key: 'review', name: 'code review', outcome: 'complete', wallMs: 3_723_000 }],
    invocations: [invocation({ usage: { input: 500, output: 20 } }), bare({ provider: 'claude', model: 'claude-opus-5-5', outcome: 'timeout' })],
  })]);
  assert.ok(partial.includes('| 1 · review · medium | code review | complete | 1h 2m 3s | — | — | — | 2 | 500 | — | — | 20 | 1/2 |'), partial);
  assert.ok(partial.includes('| code review | claude | delegate | claude-opus-5-5 (configured) | medium | — | — | — | — | — | 0/1 |'), partial);
  assert.match(partial, /native and write —/);

  const estimated = render([facts({
    invocations: [
      invocation(),
      bare({ surface: 'native', provider: 'claude', model: 'claude-opus-5-5', mode: 'native', estimated: true, tokens: 5000 }),
      invocation({ surface: 'native', provider: 'claude', model: 'claude-opus-5-5', mode: 'native', estimated: true, usage: { input: 9000, output: 1000 } }),
    ],
  })]);
  assert.match(estimated, /^- Provider CLI measured tokens: 3,340 \(input 1,000 · cache read 2,000 · cache write 300 · output 40\) · launch coverage 1\/1$/m);
  assert.match(estimated, /^- Estimated, excluded from measured totals: native and write ~15,000$/m);
  assert.ok(estimated.includes('| 3 | 1,000 | 2,000 | 300 | 40 | 1/1 |'), estimated);
  assert.ok(estimated.includes('| ~5,000 | native completed |'), estimated);
});

// SECTION: Heuristics, severity, and model attribution

test('elapsed waits and partial usage remain explicit', () => {
  const usage = normalizeUsage({ input: 3000, cacheRead: 2000, output: 40, reasoning: 20 }, 'includes-cache');
  assert.ok(usage);
  const run = facts({
    invocations: [
      invocation({ usage }),
      bare({ provider: 'claude', outcome: 'timeout' }),
      bare({ surface: 'native', mode: 'native', estimated: true }),
    ],
  });
  const text = render([run]);
  assert.match(text, /Provider CLI measured tokens: 3,040 \(input 1,000 · cache read 2,000 · cache write — · output 40\) · launch coverage 1\/2/);
  assert.match(text, /native and write —/);
  assert.match(text, /Full conversation totals are unavailable/);

  assert.ok(text.includes('| — | native completed |'), 'unattested native usage stays unavailable');
  const quota = only(heuristics(facts({ invocations: [invocation({ outcome: 'quota' }), invocation({ outcome: 'quota' })] })), 'H1')[0]!;
  assert.match(quota.proposedFix, /Reorder or remove the exhausted model alias, or check its quota/);
  assert.doesNotMatch(quota.proposedFix, /add another model alias/);
  assert.doesNotMatch(quota.proposedFix, /each model has its own quota/);
});

test('H1 quota names model and fallback recoveries', () => {
  const quotaFailure = (subject: string, slot: string, overrides: Partial<InvocationFacts> = {}) => invocation({
    provider: 'agy', model: 'gemini-4-argon', outcome: 'quota', subject, slot, attempt: 1, ...overrides,
  });
  const quotaFinding = (invocations: InvocationFacts[]) => assertShape(
    only(heuristics(facts({ invocations })), 'H1').find(item => item.evidence.startsWith('`quota`')),
    'correctness',
  );
  const repeatedAttempts = quotaFinding([
    quotaFailure('aaaaaaaaaaaaaaaa', 'agy[0]', { routingOutcome: 'next-model' }),
    invocation({ provider: 'agy', model: 'gemini-3.8-flash', subject: 'aaaaaaaaaaaaaaaa', slot: 'agy[0]', attempt: 2 }),
    quotaFailure('bbbbbbbbbbbbbbbb', 'agy[1]', { routingOutcome: 'next-model' }),
    invocation({ provider: 'agy', model: 'gemini-3.8-flash', subject: 'bbbbbbbbbbbbbbbb', slot: 'agy[1]', attempt: 2 }),
  ]);
  assert.match(repeatedAttempts.evidence, /agy\/gemini-4-argon ×2/);
  assert.match(repeatedAttempts.evidence, /2 recovered by fallback/);
  assert.match(repeatedAttempts.proposedFix, /Reorder or remove the exhausted model alias, or check its quota/);

  const reserveFallback = quotaFinding([
    quotaFailure('cccccccccccccccc', 'agy[2]', { routingOutcome: 'next-model' }),
    quotaFailure('cccccccccccccccc', 'agy[2]', { attempt: 2, routingOutcome: 'reserve' }),
    invocation({ provider: 'claude', model: 'sonnet', subject: 'cccccccccccccccc', slot: 'claude[0]', targetSlot: 'agy[2]' }),
  ]);
  assert.match(reserveFallback.evidence, /agy\/gemini-4-argon ×2/);
  assert.match(reserveFallback.evidence, /2 recovered by fallback/);

  const unrecovered = quotaFinding([
    quotaFailure('dddddddddddddddd', 'agy[3]'),
    invocation({ provider: 'agy', model: 'gemini-3.8-flash', subject: 'dddddddddddddddd', slot: 'agy[3]', attempt: 2 }),
    quotaFailure('eeeeeeeeeeeeeeee', 'agy[4]', { routingOutcome: 'stop' }),
    invocation({ provider: 'agy', model: 'gemini-3.8-flash', subject: 'eeeeeeeeeeeeeeee', slot: 'agy[4]', attempt: 2 }),
    quotaFailure('ffffffffffffffff', 'agy[5]', { routingOutcome: 'stop' }),
    quotaFailure('gggggggggggggggg', 'agy[6]', { routingOutcome: 'next-model' }),
    invocation({ provider: 'claude', model: 'sonnet', outcome: 'timeout', subject: 'gggggggggggggggg', slot: 'agy[6]', attempt: 2 }),
    quotaFailure('hhhhhhhhhhhhhhhh', 'agy[7]', { routingOutcome: 'next-model' }),
    invocation({ provider: 'claude', model: 'sonnet', surface: 'native', mode: 'native', outcome: 'native-pending', nativeState: 'pending', subject: 'hhhhhhhhhhhhhhhh', slot: 'claude[1]', targetSlot: 'agy[7]' }),
    quotaFailure('iiiiiiiiiiiiiiii', 'agy[8]', { routingOutcome: 'next-mode' }),
    invocation({ provider: 'claude', model: 'sonnet', outcome: 'ok', validationOutcome: 'invalid', subject: 'iiiiiiiiiiiiiiii', slot: 'agy[8]', attempt: 2 }),
    quotaFailure('jjjjjjjjjjjjjjjj', 'agy[9]', { routingOutcome: 'next-model' }),
    invocation({ provider: 'claude', model: 'sonnet', surface: 'native', launched: false, outcome: 'ok', nativeState: 'completed', subject: 'jjjjjjjjjjjjjjjj', slot: 'claude[2]', targetSlot: 'agy[9]' }),
  ]);
  assert.match(unrecovered.evidence, /agy\/gemini-4-argon ×7/);
  assert.match(unrecovered.evidence, /0 recovered by fallback/);

});

const rejections = (tool: string, action: string, cls: string, count = 2) => Array.from({ length: count }, () => ({ tool, action, cls }));
const h8 = (rejectedTools: NonNullable<RunFacts['rejectedTools']>) => only(heuristics(facts({ rejectedTools })), 'H8');

test('H8 names the handling module of repeated rejections and ignores one-offs', () => {
  const verify = assertShape(h8(rejections('verify', 'run', 'invalid-input'))[0], 'correctness');
  assert.equal(verify.component, 'scripts/toolkit/verify.ts');
  assert.match(verify.evidence, /2 toolkit operations rejected \(verify run: invalid-input ×2\)/);

  const unknown = assertShape(h8(rejections('record', 'append', 'invalid-record'))[0], 'correctness');
  assert.equal(unknown.component, 'scripts/toolkit/cli.ts');
  assert.match(unknown.evidence, /record append: invalid-record ×2/);

  const grouped = h8([...rejections('ledger', 'append', 'approval-stale'), ...rejections('ledger', 'query', 'invalid-input'), ...rejections('worktree', 'create', 'invalid-input')]);
  assert.deepEqual(grouped.map(item => item.component).sort(), ['scripts/toolkit/ledger.ts', 'scripts/toolkit/writers.ts']);
  assert.match(grouped.find(item => item.component === 'scripts/toolkit/ledger.ts')!.evidence, /4 toolkit operations rejected \(ledger append: approval-stale ×2, ledger query: invalid-input ×2\)/);

  for (const name of TOOL_ACTIONS) {
    const [tool, action] = name.split(' ') as [string, string];
    const finding = assertShape(h8(rejections(tool, action, 'invalid-input'))[0], 'correctness');
    assert.notEqual(finding.component, 'scripts/toolkit/cli.ts', `${name} has a module`);
  }

  assert.deepEqual(h8(rejections('verify', 'run', 'invalid-input', 1)), []);
  assert.deepEqual(h8([...rejections('verify', 'run', 'invalid-input', 1), ...rejections('verify', 'run', 'user-only', 1)]), []);
  assert.deepEqual(h8([...rejections('ledger', 'append', 'key-conflict', 1), ...rejections('ledger', 'query', 'key-conflict', 1)]), []);
  const [mixed] = h8([...rejections('verify', 'run', 'invalid-input'), ...rejections('verify', 'run', 'user-only', 1)]);
  assert.match(mixed!.evidence, /2 toolkit operations rejected \(verify run: invalid-input ×2\)/);
});

test('heuristic H1 fires on repeated failures and suppresses isolated failures', () => {
  const cliFinding = assertShape(only(heuristics(facts({ invocations: [invocation({ outcome: 'timeout', durationMs: 60_000, slot: 'codex' }), invocation({ outcome: 'timeout', durationMs: 60_000, slot: 'codex' }), invocation()] })), 'H1')[0], 'correctness');
  assert.equal(cliFinding.component, 'references/providers.md');
  assert.match(cliFinding.evidence, /`timeout`: 2 of 3 CLI attempts failed \(codex ×2\), 2m 0s of driver time/);

  const reserve = facts({ invocations: [invocation({ outcome: 'quota', slot: 'codex' }), invocation({ provider: 'gemini', slot: 'codex' })] });
  assert.deepEqual(only(heuristics(reserve), 'H1'), []);
  const unrelated = facts({ invocations: [invocation({ outcome: 'timeout', slot: 'codex' }), invocation({ provider: 'gemini', outcome: 'quota', slot: 'gemini' }), invocation()] });
  assert.deepEqual(only(heuristics(unrelated), 'H1'), []);

  const run = sanitizeFacts(facts({ invocations: [invocation({ outcome: 'timeout', slot: 'codex[0]' }), invocation({ provider: 'gemini', outcome: 'quota', slot: 'codex[0]' })] }));
  assert.deepEqual(run.invocations.map((row) => row.slot), ['codex[0]', 'codex[0]']);
  assert.equal(only(heuristics(run), 'H1').length > 0, true);

  const findings = only(heuristics(facts({ invocations: [invocation({ outcome: 'model-not-loaded', slot: 'codex' }), invocation({ outcome: 'model-not-loaded', provider: 'gemini', slot: 'codex' })] })), 'H1');
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.evidence, /`model-not-loaded`: 2 of 2 CLI attempts failed/);
  for (const cls of ['quota', 'timeout', 'model-not-loaded', 'unclassified']) {
    const [item] = only(heuristics(facts({ invocations: [invocation({ outcome: cls, slot: 'codex' }), invocation({ outcome: cls, slot: 'codex' })] })), 'H1');
    assert.ok(item, cls);
    assert.doesNotMatch(item.proposedFix, /cascade|reserve.*route|route.*reserve|timeout|retry/i, cls);
  }
});

test('diagnostics fix text for capacity and no-report', () => {
  const h1 = (rows: InvocationFacts[]) => assertShape(only(heuristics(facts({ invocations: rows })), 'H1')[0], 'correctness');
  const repeated = (row: Partial<InvocationFacts>) => [invocation({ ...row, slot: 'codex[0]' }), invocation({ ...row, slot: 'codex[0]' })];
  const capacity = h1(repeated({ outcome: 'capacity' }));
  const noReport = h1(repeated({ outcome: 'ok', validationOutcome: 'no-report' }));
  const unclassified = h1(repeated({ outcome: 'unclassified' }));
  assert.match(capacity.evidence, /`capacity`/);
  assert.match(capacity.proposedFix, /provider capacity and retry delay/i);
  assert.match(noReport.evidence, /`no-report`/);
  assert.match(noReport.proposedFix, /required report JSON/i);
  for (const finding of [capacity, noReport]) assert.notEqual(finding.proposedFix, unclassified.proposedFix, 'own fix text');
  assert.notEqual(capacity.proposedFix, noReport.proposedFix);
});

test('diagnostics report: heuristic H4 fires for cache read share', () => {
  const finding = assertShape(only(heuristics(facts({ invocations: [invocation({ usage: { input: 700, cacheRead: 300, output: 10 } })] })), 'H4')[0], 'token-economy');
  assert.match(finding.evidence, /codex: cache read 30% of input \(300 of 1,000 tokens\) across 1 invocation\./);
});

test('diagnostics report: heuristic boundaries stay silent', () => {
  const even = invocation({ usage: { input: 1000, cacheRead: 1000, output: 0 } });
  const run = facts({
    invocations: [even, { ...even, provider: 'claude' }],
    reviews: [{ phase: 'review', round: 1, accepted: 1, rejected: 1 }, { phase: 'review', round: 2, accepted: 1, rejected: 1 }],
    rejectedTools: [], relaunches: 0,
  });
  assert.deepEqual(heuristics(run), []);
  assert.deepEqual(heuristics(facts()), []);
});

test('diagnostics report: orders findings by severity', () => {
  const run = facts({
    invocations: [invocation({ outcome: 'quota' }), invocation({ outcome: 'quota' }), invocation({ usage: { input: 9000, cacheRead: 100, output: 0 } })],
    reviews: [1, 2, 3].map((round) => ({ phase: 'review', round, accepted: 1, rejected: 0, cap: 3, ...(round === 3 ? { reraised: ['R1-F001'] } : {}) })),
    observations: [observation()],
  });
  const order = Object.keys(CATEGORIES);
  const categories = heuristics(run).map((f) => order.indexOf(f.category));
  assert.deepEqual([...categories].sort((a, b) => a - b), categories);
  const headings = [...render([run]).matchAll(/^### \d+\. ([^·]+) ·/gm)].map((m) => m[1]!.trim());
  assert.deepEqual([...new Set(headings)], ['Correctness / protocol', 'Token economy', 'Review convergence', 'Instruction clarity']);
});

test('diagnostics amendment convergence: evaluates caps, reraises, and escalations', () => {
  const rounds = (count: number, extra: Partial<RunFacts['reviews'][number]> = {}) => Array.from({ length: count }, (_, i) => ({ phase: 'review', round: i + 1, accepted: 1, rejected: 0, ...extra }));
  assert.deepEqual(only(heuristics(facts({ reviews: rounds(3, { cap: 3 }) })), 'H2'), [], 'three rounds within cap 3 is normal convergence');
  assert.deepEqual(only(heuristics(facts({ reviews: rounds(4, { cap: 3 }) })), 'H2'), [], 'plain continuation beyond cap 3 is designed');
  assert.deepEqual(only(heuristics(facts({ reviews: [{ phase: 'review', round: 2, accepted: 1, rejected: 0 }] })), 'H2'), []);

  const reraisedFinding = assertShape(only(heuristics(facts({ reviews: [
    { phase: 'review', round: 4, accepted: 1, rejected: 0, cap: 3, reraised: ['R1-F001'] },
  ] })), 'H2')[0], 'review-convergence');
  assert.match(reraisedFinding.evidence, /4 rounds/);
  assert.match(reraisedFinding.evidence, /1 finding re-raised across rounds \(R1-F001\)/);

  for (const kind of ['regression', 'deadlock'] as const) {
    const escalationOnly = assertShape(only(heuristics(facts({ reviews: [
      { phase: 'review', round: 4, accepted: 1, rejected: 0, cap: 3, escalation: { kind, ids: ['R1-F001'] } },
    ] })), 'H2')[0], 'review-convergence');
    assert.match(escalationOnly.evidence, kind === 'deadlock' ? /continued past the cap \(3\)/ : /regression escalation \(R1-F001\)/);
  }
  assert.match(assertShape(only(heuristics(facts({ reviews: rounds(3) })), 'H2')[0], 'review-convergence').evidence, /code review: 3 rounds\./, 'an absent cap uses the fallback threshold');
  const twoRoundReraised = assertShape(only(heuristics(facts({ reviews: [
    { phase: 'review', round: 1, accepted: 1, rejected: 1 },
    { phase: 'review', round: 2, accepted: 1, rejected: 0, reraised: ['R1-F001'] },
  ] })), 'H2')[0], 'review-convergence');
  assert.match(twoRoundReraised.evidence, /code review: 2 rounds; 1 finding re-raised across rounds \(R1-F001\)\./);
  const twoRoundEscalated = assertShape(only(heuristics(facts({ reviews: [
    { phase: 'review', round: 1, accepted: 1, rejected: 0 },
    { phase: 'review', round: 2, accepted: 0, rejected: 0, escalation: { kind: 'regression', ids: ['R1-F001'] } },
  ] })), 'H2')[0], 'review-convergence');
  assert.match(twoRoundEscalated.evidence, /code review: 2 rounds; regression escalation \(R1-F001\)\./);
});

test('H2 wording separates designed continuation, cap arrival, and deadlock', () => {
  const rounds = (count: number, last: Partial<RunFacts['reviews'][number]> = {}) => Array.from({ length: count }, (_, i) => ({
    phase: 'review', round: i + 1, accepted: 1, rejected: 0, cap: 3, ...(i === count - 1 ? last : {}),
  }));
  const h2 = (reviews: RunFacts['reviews']) => assertShape(only(heuristics(facts({ reviews })), 'H2')[0], 'review-convergence');

  const capEnded = [1, 2, 3].map((round) => ({ phase: 'review', round, accepted: 1, rejected: 0, cap: 3,
    ...(round === 3 ? { escalation: { kind: 'deadlock' as const, ids: ['R3-F001'] } } : {}) }));
  const findingCap = assertShape(only(heuristics(facts({ reviews: capEnded })), 'H2')[0], 'review-convergence');
  assert.match(findingCap.evidence, /cap reached/);
  assert.doesNotMatch(findingCap.evidence, /deadlock/);
  assert.equal(findingCap.proposedFix, 'Raise the round cap or narrow scope.');

  const deadlocked = [1, 2, 3].map((round) => ({ phase: 'review', round, accepted: 1, rejected: 0, cap: 3,
    ...(round === 3 ? { reraised: ['R1-F001'], escalation: { kind: 'deadlock' as const, ids: ['R1-F001'] } } : {}) }));
  const findingDeadlock = assertShape(only(heuristics(facts({ reviews: deadlocked })), 'H2')[0], 'review-convergence');
  assert.match(findingDeadlock.evidence, /deadlock escalation \(R1-F001\)/);
  assert.doesNotMatch(findingDeadlock.evidence, /cap reached/);

  const continued = h2(rounds(4, { reraised: ['R1-F001'] }));
  assert.match(continued.evidence, /continued past the cap \(3\)/);
  assert.doesNotMatch(continued.evidence, /cap reached/);
  assert.doesNotMatch(continued.proposedFix, /raise the (round )?cap/i);

  const deadlockPast = h2(rounds(4, { escalation: { kind: 'deadlock', ids: ['R1-F001'] } }));
  assert.match(deadlockPast.evidence, /continued past the cap \(3\)/);
  assert.match(deadlockPast.evidence, /deadlock escalation \(R1-F001\)/);
  assert.doesNotMatch(deadlockPast.evidence, /cap reached/);
  assert.doesNotMatch(deadlockPast.proposedFix, /raise the (round )?cap/i);
});

test('heuristic precision screens the review cap as a bounded integer', () => {
  const capOf = (cap: unknown) => sanitizeFacts(facts({ reviews: [{ phase: 'review', round: 1, accepted: 0, rejected: 0, cap } as never] })).reviews[0]?.cap;
  assert.equal(capOf(3), 3);
  for (const bad of [-1, 2.5, 1_000_001, '3', null]) assert.equal(capOf(bad), undefined, String(bad));
});

test('H9 points at launch reports', () => {
  const finding = assertShape(only(heuristics(facts({ relaunches: 2 })), 'H9')[0], 'correctness');
  assert.equal(finding.component, 'scripts/toolkit/brief.ts');
  assert.match(finding.proposedFix, /writer launch reports/i);
  assert.match(finding.proposedFix, /\.state\/briefs\/<task>-<launch>\.report\.md/);
  assert.doesNotMatch(finding.proposedFix, /writer brief/i);
});

test('heuristic precision: sample thresholds for H1, H3, H5, and H9 heuristics', () => {
  // H3 needs three findings
  assert.deepEqual(only(heuristics(facts({ reviews: [{ phase: 'review', round: 1, accepted: 0, rejected: 2 }] })), 'H3'), [], 'two findings are too few to judge a rejection share');
  const h3Findings = only(heuristics(facts({ reviews: [{ phase: 'review', round: 1, accepted: 1, rejected: 2 }] })), 'H3');
  assert.equal(h3Findings.length, 1);
  assert.match(assertShape(h3Findings[0], 'review-convergence').evidence, /code review round 1: 2 of 3 findings rejected \(67%\)/);

  // H5 needs three uncached samples and a share above two over n
  const big = invocation({ usage: { input: 9000, cacheRead: 9000, output: 100 } });
  assert.deepEqual(only(heuristics(facts({ invocations: [big, invocation()] })), 'H5'), [], 'with two invocations one always holds at least half');
  const even = invocation({ usage: { input: 5000, cacheRead: 9000, cacheWrite: 300, output: 60 } });
  assert.deepEqual(only(heuristics(facts({ invocations: [even, invocation(), invocation()] })), 'H5'), [], 'a share at max(0.5, 2/n) stays silent');
  const cached = invocation({ usage: { input: 1000, cacheRead: 900_000, output: 40 } });
  assert.deepEqual(only(heuristics(facts({ invocations: [cached, invocation(), invocation()] })), 'H5'), [], 'cache reads do not make a launch dominate');
  const zero = invocation({ outcome: 'quota', usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } });
  assert.deepEqual(only(heuristics(facts({ invocations: [big, invocation(), zero] })), 'H5'), [], 'zero-usage failures are not samples');
  const h5Findings = only(heuristics(facts({ invocations: [big, invocation(), invocation()] })), 'H5');
  assert.equal(h5Findings.length, 1);
  assert.match(assertShape(h5Findings[0], 'token-economy').evidence, /codex gpt-6-sol in code review: 9,100 of 11,780 measured uncached tokens \(77%\)/);

  // H1 ignores quota-store skips that never launched
  const skip = invocation({ outcome: 'quota', launched: false, slot: 'codex' });
  assert.deepEqual(only(heuristics(facts({ invocations: [invocation({ outcome: 'quota', slot: 'codex' }), skip] })), 'H1'), []);
  const [h1Finding] = only(heuristics(facts({ invocations: [invocation({ outcome: 'quota', slot: 'codex' }), invocation({ outcome: 'quota', slot: 'codex' }), skip, skip] })), 'H1');
  assert.match(h1Finding!.evidence, /`quota`: 2 of 2 CLI attempts failed \(codex\/gpt-6-sol ×2\), 0 recovered by fallback, 2m 0s of driver time\./);

  // H9 needs two relaunches
  assert.deepEqual(only(heuristics(facts({ relaunches: 1 })), 'H9'), [], 'one relaunch without a cause is not a pattern');
  assert.match(assertShape(only(heuristics(facts({ relaunches: 2 })), 'H9')[0], 'correctness').evidence, /2 writer relaunches/);
});

test('diagnostics report: equivalent codex and claude usage yield equal totals and heuristics', () => {
  const codex = normalizeUsage({ input: 1000, cacheRead: 300, cacheWrite: 0, output: 50 }, 'includes-cache');
  const claude = normalizeUsage({ input: 700, cacheRead: 300, cacheWrite: 0, output: 50 }, 'uncached');
  assert.deepEqual(codex, { input: 700, cacheRead: 300, cacheWrite: 0, output: 50 });
  assert.deepEqual(codex, claude);
  const run = (provider: string, usage: Usage | undefined) => facts({ invocations: [invocation({ provider, ...(usage ? { usage } : {}) })] });
  const [a, b] = [heuristics(run('codex', codex)), heuristics(run('claude', claude))];
  assert.deepEqual(a.map((f) => [f.source, f.category, f.evidence.replace('codex', 'P')]), b.map((f) => [f.source, f.category, f.evidence.replace('claude', 'P')]));
  assert.deepEqual(a.map((f) => f.source), ['H4']);
  const measuredLine = (text: string) => /^- Provider CLI measured tokens: .*$/m.exec(text)?.[0];
  assert.equal(measuredLine(render([run('codex', codex)])), measuredLine(render([run('claude', claude)])));
  assert.equal(normalizeUsage({ input: 100, cacheRead: 300, output: 1 }, 'includes-cache')?.input, 0);
});

test('diagnostics report: renders per-model token rows across launch states', () => {
  const split = render([facts({ invocations: [invocation({
    provider: 'claude', model: 'claude-opus-5-5', reportedModels: ['claude-opus-5-5', 'claude-haiku-5'],
    usage: { input: 150, output: 15, models: { 'claude-opus-5-5': { input: 100, output: 10 }, 'claude-haiku-5': { input: 50, output: 5 } } },
  })] })]);
  assert.ok(split.includes('| code review | claude | delegate | claude-haiku-5 | medium | 50 | — | — | 5 | — | 1/1 |'), split);
  assert.ok(split.includes('| code review | claude | delegate | claude-opus-5-5 | medium | 100 | — | — | 10 | — | 1/1 |'), split);
  assert.doesNotMatch(split, /\(configured\)/);
  const mixed = render([facts({ invocations: [
    invocation({ provider: 'claude', model: 'claude-opus-5-5', usage: { input: 100, output: 10, models: { 'claude-opus-5-5': { input: 100, output: 10 } } } }),
    bare({ provider: 'claude', model: 'claude-opus-5-5', outcome: 'timeout' }),
  ] })]);
  assert.ok(mixed.includes('| code review | claude | delegate | claude-opus-5-5 (configured) | medium | 100 | — | — | 10 | — | 1/2 |'), mixed);
  const table = mixed.split('### Tokens by stage')[1]!.split('### Review yield')[0]!;
  assert.equal((table.match(/claude-opus-5-5/g) ?? []).length, 1);
  const configured = render([facts({ invocations: [invocation({ reportedModels: ['gpt-6-sol-2026'], usage: { input: 100, output: 10 } })] })]);
  assert.ok(configured.includes('| code review | codex | delegate | gpt-6-sol (configured) | medium | 100 | — | — | 10 | — | 1/1 |'), configured);
  assert.ok(configured.includes('gpt-6-sol (reported: gpt-6-sol-2026)'), configured);

  const multi = render([facts({ invocations: [invocation({ provider: 'claude', model: 'claude-opus-5-5', reportedModels: ['claude-opus-5-5', 'claude-haiku-5'], usage: { input: 100, output: 10 } })] })]);
  assert.ok(multi.includes('| code review | claude | delegate | — | medium | 100 | — | — | 10 | — | 1/1 |'), multi);
  assert.doesNotMatch(multi, /\(configured\)/);
});

// SECTION: Scope gate and redaction

const LEAKS = [
  'see /home/alice/repo/src/app.ts', 'at ~/work/app', 'path C:\\Users\\alice\\repo', 'path d:/work/repo', 'share \\\\server\\team\\x',
  'docs at https://intranet.example/x', 'host www.example.org', 'host build.example.com', 'mail alice@example.com',
  'session 123e4567-e89b-12d3-a456-426614174000', `hash ${'a1'.repeat(20)}`,
];
const CLEAN = 'The `/dispatch review` frame in scripts/toolkit/records.ts mixes input/output fields in config.local.jsonc.';

test('retro observations: validates ids, components, categories, content, and size', () => {
  const ids = Array.from({ length: 21 }, (_, i) => `o${i + 1}`);
  const result = retroObservations(ids.map((id) => observation({ id })));
  assert.deepEqual(result.values.map((v) => v.id), ids.slice(0, 20));
  assert.equal(result.rejected, 1);
  assert.deepEqual(retroObservations([]), { state:'empty', values: [], rejected: 0 });
  for (const component of ['src/app.ts', 'core/frame.ts', '../dispatch/scripts/toolkit/records.ts', 'skills/dispatch-plan/SKILL.md', 'README.md']) {
    assert.deepEqual(retroObservations([observation({ component })]), { state:'collected', values: [], rejected: 1 }, component);
  }
  assert.equal(retroObservations([observation({ component: 'skills/dispatch/scripts/toolkit/records.ts' })]).values[0]?.component, 'scripts/toolkit/records.ts');
  const shipped = ['SKILL.md', ...['scripts', 'references'].flatMap((dir) => fs.readdirSync(path.join(SKILL_ROOT, dir), { recursive: true })
    .map((entry) => path.join(dir, String(entry))).filter((file) => fs.statSync(path.join(SKILL_ROOT, file)).isFile()).map((file) => file.split(path.sep).join('/')))];
  assert.deepEqual([...COMPONENTS].sort(), shipped.sort());
  for (const component of shipped) assert.equal(retroObservations([observation({ component })]).values.length, 1, component);
  assert.equal(retroObservations([observation({ component: 'scripts/toolkit/cli.ts' })]).values.length, 1);
  assert.equal(retroObservations([observation({component:'scripts/toolkit/review-identity.ts'})]).values[0]?.component,'scripts/toolkit/review-identity.ts');
  assert.equal(retroObservations([observation({ component: 'references/templates/writer-brief.md' })]).values.length, 1);
  for (const category of ['vibes', 'driver protocol', '', undefined]) assert.equal(retroObservations([observation({ category })]).rejected, 1, String(category));
  for (const category of [...Object.keys(CATEGORIES), 'Token economy']) assert.equal(retroObservations([observation({ category })]).values.length, 1, category);
  for (const id of ['', 'bad id', 'x'.repeat(49), 'a/b', 7]) assert.equal(retroObservations([observation({ id })]).rejected, 1, String(id));
  assert.deepEqual(retroObservations([observation({ id: 'dup' }), observation({ id: 'dup' })]).rejected, 1);
  for (const field of ['evidence', 'impact', 'proposedFix'] as const) {
    for (const leak of LEAKS) assert.equal(retroObservations([observation({ [field]: leak })]).rejected, 1, `${field}: ${leak}`);
    assert.equal(retroObservations([observation({ [field]: CLEAN })]).values[0]?.[field], CLEAN);
  }
  assert.equal(retroObservations([observation({ evidence: 'z'.repeat(512) })]).values.length, 1);
  for (const evidence of ['z'.repeat(513), 'é'.repeat(257), '   ', 42]) assert.equal(retroObservations([observation({ evidence })]).rejected, 1, String(evidence).slice(0, 8));
});

test('retro observations: sanitizes model and config facts', () => {
  const raw = facts({
    config: {
      diagnostics: true, 'write-concurrency': 2, 'api-key': 'secret-canary',
      'read-delegates': { codex: { sandbox: true, targets: [{ low: { model: 'gpt-6-sol', effort: 'medium' } }] } },
      'write-subagents': { claude: { low: { model: '/opt/models/private' } } },
    },
    invocations: [
      invocation({ model: 'C:\\models\\private', provider: 'Codex Cloud', effort: 'h i g h', reportedModels: ['gpt-6-sol-2026', 'https://host/model', 'user@example.com'] }),
      invocation({ model: 'opencode-go/glm-5.3-flash', provider: 'opencode', effort: 'max' }),
    ],
  });
  const clean = sanitizeFacts({ ...raw, invocations: [{ ...raw.invocations[0]!, resume: 'resume-canary' } as InvocationFacts, raw.invocations[1]!] });
  assert.deepEqual(clean.config, {
    diagnostics: true, 'write-concurrency': 2,
    'read-delegates': { codex: { sandbox: true, targets: [{ low: { model: 'gpt-6-sol', effort: 'medium' } }] } },
    'write-subagents': { claude: { low: { model: '—' } } },
  });
  const [bad, good] = clean.invocations;
  assert.deepEqual([bad?.model, bad?.provider, bad?.effort, bad?.reportedModels], ['—', '—', '—', ['gpt-6-sol-2026']]);
  assert.deepEqual([good?.model, good?.provider, good?.effort], ['opencode-go/glm-5.3-flash', 'opencode', 'max']);
  assert.ok(!('resume' in bad!));
});

test('retro observations: rejects locators in ids models and config', () => {
  for (const locator of ['123e4567-e89b-12d3-a456-426614174000', 'build.example.com']) {
    const text = render([facts({
      config: { 'read-delegates': { codex: { targets: [{ low: { model: locator } }] }, [locator]: { model: 'gpt-6-sol' } } },
      invocations: [invocation({ model: locator, reportedModels: [locator, 'gpt-6-sol'], usage: { input: 10, output: 1, models: { [locator]: { input: 10, output: 1 } } } })],
      reviews: [{ phase: 'review', round: 1, accepted: 1, rejected: 0, reraised: [locator, 'R1-F001'], escalation: { kind: 'deadlock', ids: [locator] } }],
      observations: [observation({ id: locator })],
    })]);
    assert.ok(!text.includes(locator), `${locator} withheld:\n${text}`);
    assert.match(text, /- Host retro: collected · 0 accepted · 1 rejected/, 'observation id');
    assert.match(text, /code review: 1 round; 1 finding re-raised across rounds \(R1-F001\); deadlock escalation\./, 'review ids');
    assert.ok(text.includes('— (reported: gpt-6-sol)'), 'model and reported-model keys');
    assert.ok(text.includes('| code review | codex | delegate | — | medium | 10 | — | — | 1 | — | 1/1 |'), 'usage.models keys drop the per-model split');
    assert.ok(text.includes('"model": "—"'), 'config strings');
  }
  const names = ['gemini-3.8-flash', 'gpt-6.1-sol', 'opencode-go/muse-spark-1.3-contributor', 'claude-opus-5-5'];
  const text = render([facts({
    config: { 'read-delegates': { codex: { targets: names.map((model) => ({ low: { model } })) } } },
    invocations: names.map((model) => invocation({ model, reportedModels: [model], usage: { input: 10, output: 1, models: { [model]: { input: 10, output: 1 } } } })),
  })]);
  for (const name of names) {
    assert.ok(text.includes(`| ${name} (reported: ${name}) |`), `model ${name}`);
    assert.ok(text.includes(`| code review | codex | delegate | ${name} | medium | 10 |`), `usage key ${name}`);
    assert.ok(text.includes(`"model": "${name}"`), `config ${name}`);
  }
});

test('diagnostics report: never renders resume objective or absolute paths', () => {
  const run = {
    ...facts(), objective: 'objective-canary', argument: 'argument-canary', sessionPath: 'C:/sessions/canary', version: '/opt/canary',
    config: { diagnostics: true, 'canary-key': 'value', phases: { 'plan-review': { only: ['C:\\canary'] } } },
    pins: '/home/canary', fault: { cls: 'timeout', effectId: 'C:/canary/effect', detail: 'canary detail' },
    phases: [{ key: 'review', name: 'canary phase', outcome: 'complete', wallMs: 1000 }],
    hostGaps: [{ await: '/canary', ms: 1000 }],
    invocations: [{ ...invocation({ model: '/Users/canary/model', reportedModels: ['C:/canary'] }), resume: 'resume-canary', sessionId: 'canary-session', stdoutPath: 'C:/canary/out' }],
    reviews: [{ phase: 'review', round: 1, reraised: ['C:/canary', 'F1'], escalation: { kind: 'deadlock', ids: ['/home/canary'] }, accepted: 0, rejected: 1 }],
    rejectedEvents: [{ eventType: 'RULINGS', reason: 'bad path /Users/canary/repo/file.ts' }, { eventType: 'canary', reason: 'ok' }],
    observations: [observation({ evidence: 'canary at /home/canary/x' }), observation({ id: 'o2', component: 'canary.ts' }), { ...observation({ id: 'o3' }), extra: 'canary-extra' }],
  } as unknown as RunFacts;
  const { text } = renderDiagnostics([run]);
  assert.doesNotMatch(text, /canary/i);
  assert.doesNotMatch(text,/host event/);
  assert.match(text, /- Host retro: collected · 1 accepted · 2 rejected/);
});

test('host rows preserve totals and notes, scrub labels, and surface unavailability', () => {
  const run=facts({hostUsage:{platform:'claude',rows:[{stage:'plan',role:'host',model:'m',effort:null,input:10,output:2,cacheRead:5,cacheWrite:2,reasoning:4},{stage:'plan',role:'subagent',model:'m',effort:null,input:20,output:3}],notes:{host:{'unparsed lines':2},subagent:{'read budget reached':1}}},invocations:[invocation({provider:'claude',usage:{input:7,output:1}})]});
  (run.hostUsage!.rows[0] as unknown as Record<string,unknown>)['text']='secret transcript';
  const text=render([run]);
  assert.ok(text.includes('| claude | 37 | 5 | 2 | 6 | 4 | host measured (unparsed lines 2) · subagents measured (read budget reached 1) · delegates 1/1 |'));
  assert.ok(text.includes('| plan | claude | host | m | — | 10 | 5 | 2 | 2 | 4 | — |'));
  assert.ok(text.includes('| plan | claude | subagent | m | — | 20 | — | — | 3 | — | — |'));
  assert.ok(text.includes('| code review | claude | delegate | gpt-6-sol (configured) | medium | 7 | — | — | 1 | — | 1/1 |'));
  assert.ok(text.includes('Overview token columns count CLI delegates only.'));
  assert.ok(text.includes('other threads are unavailable. Full collection coverage is unavailable. Total storage loss can be unobservable.'));
  assert.ok(!text.includes('secret transcript'));
  const invalidUsage={platform:'claude',rows:[{stage:'plan',role:'host',model:'C:/private/path',effort:'C:/private',input:4,output:1}],unavailable:'read-error:EACCES',notes:{subagent:{'unreadable files':2}}} as NonNullable<RunFacts['hostUsage']>;
  const sanitized=render([facts({hostUsage:invalidUsage,invocations:[]})]);
  assert.ok(sanitized.includes('| plan | claude | host | — | — | 4 | — | — | 1 | — | — |'));
  assert.ok(sanitized.includes('host unavailable: read-error:EACCES'));
  assert.ok(sanitized.includes('subagents not measured (unreadable files 2)'));
  assert.ok(!sanitized.includes('C:/private'));
});


test('Codex delegates keep their own platform under a Claude host and timing scope reports native timing', () => {
  const run=facts({timingScope:'tool-calls',hostUsage:{platform:'claude',rows:[{stage:'plan',role:'host',model:'claude-model',effort:null,input:10,output:2}]},invocations:[invocation({provider:'claude',usage:{input:3,output:1}}),invocation({provider:'codex',usage:{input:7,output:4}})]});
  const text=render([run]);
  assert.ok(text.includes('| claude | 13 | — | — | 3 | — | host measured · delegates 1/1 |'));
  assert.ok(text.includes('| codex | 7 | — | — | 4 | — | delegates 1/1 |'));
  assert.ok(text.includes('| code review | codex | delegate | gpt-6-sol (configured) | medium | 7 | — | — | 4 | — | 1/1 |'));
  assert.match(text, /Timing scope:.*native\/writer timing/);
});

test('host platform edges render adapter coverage or explicit unavailability', () => {
  const missing = render([facts({hostUsage:{platform:null,rows:[],unavailable:'no adapter'},invocations:[]})]);
  assert.ok(missing.includes('| — | — | — | — | — | — | host unavailable: no adapter |'));
  const onlyFs = {list:()=>[],stat:()=>null,read:()=>Buffer.alloc(0),decompress:null};
  const hostUsage = readHostUsage('agy',{startMs:0,endMs:10,home:'unused',env:()=> 'thread',stages:[]},onlyFs,{agy:{sessionEnv:['CUSTOM_THREAD'],read:()=>({rows:[{stage:'plan',role:'host',model:'stub-model',effort:null,input:17,output:4,cacheRead:2}]})}});
  const covered = render([facts({hostUsage,invocations:[]})]);
  assert.ok(covered.includes('| agy | 17 | 2 | — | 4 | — | host measured |'));
  assert.ok(covered.includes('| plan | agy | host | stub-model | — | 17 | 2 | — | 4 | — | — |'));
});
test('diagnostics report names each lifecycle step outcome and keeps raw details out', () => {
  const step = (name: string, outcome: string, extra: Record<string, unknown> = {}) => ({ step: name, elapsedMs: 120, budgetMs: 5000, outcome, ...extra });
  const hostile = { lifecycleSteps: [step('debug-config', 'timeout'), step('prepare', 'failed', { detail: '/home/me/.config/opencode' }), step('teardown', 'unconfirmed')] } as unknown as Partial<InvocationFacts>;
  const text = render([facts({ invocations: [bare(hostile)] })]);
  assert.match(text, /lifecycle debug-config timeout 120\/5000 ms, teardown unconfirmed 120\/5000 ms/);
  assert.doesNotMatch(text, /prepare failed|home\/me|opencode/);
});

test('grounding phase retro observation passes gate and renders evidence in report', () => {
  const item = {
    id: 'grounding-spec',
    component: 'references/grounding.md',
    category: 'information-access' as const,
    evidence: 'map 1, gap 2, scout 1, not-covered 0, yield 2/3, tokens unavailable',
    impact: 'Keep the follow-up limit at 3.',
    proposedFix: 'Keep the current discovery bounds.',
  };
  const gated = retroObservations([item]);
  assert.equal(gated.state, 'collected');
  assert.equal(gated.rejected, 0);
  assert.equal(gated.values.length, 1);
  assert.deepEqual(gated.values[0], item);

  const text = render([facts({ observations: [item] })]);
  assert.match(text, /host retro `grounding-spec`/);
  assert.match(text, /Information access · `references\/grounding\.md`/);
  assert.match(text, /map 1, gap 2, scout 1, not-covered 0, yield 2\/3, tokens unavailable/);
});

// SECTION: Finding origin

const originReply = (...origins: (string | undefined)[]) => report(origins.map((origin, index) => finding({defect: 'defect number ' + index + ' with distinct wording ' + 'x'.repeat(index) + ' unique' + index, locus: 'src/file' + index + '.ts:L1', ...(origin === undefined ? {} : {origin})})));
const draftsOf = (text: string) => { const result = parseReport({kind: 'code', source: 'codex[0]', text}); assert.ok(result.ok, JSON.stringify(result)); return result.findings; };

test('origin: a reply with a valid, absent or invalid origin stays valid and keeps only known values', () => {
  const drafts = draftsOf(originReply('fix-induced', 'original', 'unknown', undefined, 'bogus'));
  assert.deepEqual(drafts.map(draft => draft.origin), ['fix-induced', 'original', 'unknown', undefined, undefined]);
});

test('origin: collected origin follows the round table', () => {
  const drafts = draftsOf(originReply('fix-induced', 'original', 'unknown', undefined, 'bogus'));
  assert.deepEqual(collectFindings(1, drafts).map(entry => entry.origin), ['original', 'original', 'original', 'original', 'original']);
  assert.deepEqual(collectFindings(2, drafts).map(entry => entry.origin), ['fix-induced', 'original', 'unknown', 'unknown', 'unknown']);
});

test('origin: duplicate findings merge to fix-induced within one reply and across replies', () => {
  const duplicate = (origin?: string) => finding(origin === undefined ? {} : {origin});
  assert.deepEqual(draftsOf(report([duplicate('original'), duplicate('fix-induced')])).map(draft => draft.origin), ['fix-induced']);
  assert.deepEqual(draftsOf(report([duplicate('fix-induced'), duplicate('original')])).map(draft => draft.origin), ['fix-induced']);
  assert.deepEqual(draftsOf(report([duplicate('unknown'), duplicate('original')])).map(draft => draft.origin), ['original']);
  assert.deepEqual(draftsOf(report([duplicate(), duplicate('original')])).map(draft => draft.origin), ['original']);
  const parse = (source: string, origin?: string) => { const result = parseReport({kind: 'code', source, text: report([finding(origin === undefined ? {} : {origin})])}); assert.ok(result.ok); return result.findings; };
  const merged = collectFindings(2, [...parse('codex[0]', 'original'), ...parse('claude[0]', 'fix-induced')]);
  assert.equal(merged[0]?.origin, 'fix-induced');
  assert.equal(merged[1]?.dupOf, merged[0]?.id);
  assert.equal(collectFindings(2, [...parse('codex[0]'), ...parse('claude[0]', 'original')])[0]?.origin, 'original');
});
