import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readHostUsage } from '../../../../skills/dispatch/scripts/lib/usage/index.ts';
import { REVIEW_TAGS_BY_KIND, collectFindings, matchFinding, parseReport } from '../../../../skills/dispatch/scripts/toolkit/domain/report.ts';
import { IMPACTS, TRIGGERS, severityOf } from '../../../../skills/dispatch/scripts/toolkit/domain/severity.ts';

const finding = (overrides: Record<string, string> = {}) => ({
  impact: 'blocks', trigger: 'realistic', locus: 'src/fetch.ts:L12', tag: 'correctness', defect: 'retry loop never terminates on persistent failure',
  requiredChange: 'bound the retry loop with a counter', ...overrides,
});
const report = (findings: unknown[], status = 'FINDINGS') => JSON.stringify({ status, findings });


const unknownTags = ['custom-tag', 'unrecognized-label', 'vendor-tag'] as const;

const failure = (text: string, truncated = false) => {
  const result = parseReport({ kind: 'code', source: 'codex[0]', text, truncated });
  return result.ok ? null : result.failure.kind;
};

const parseDetail = (text: string) => {
  const result = parseReport({ kind: 'code', source: 'codex[0]', text });
  return result.ok ? null : result.failure.detail;
};










const MARK = 'unresolved-locus: ';
const planLocus = '§ Work';
const parsedLoci = (kind: 'code' | 'plan', findings: unknown[]) => {
  const result = parseReport({ kind, source: 'codex[0]', text: report(findings) });
  assert.ok(result.ok);
  return result.findings.map(item => item.locus);
};








// SECTION: Unknown tag recovery

const planFinding = (tag: string, heading: string, defect: string) => ({
  impact: 'degrades', trigger: 'realistic', locus: `§ ${heading}`, tag, defect, requiredChange: `revise ${heading} to address the gap`,
});
const parsedFindings = (kind: 'plan' | 'code' | 'design', text: string) => {
  const result = parseReport({ kind, source: 'agy[0]', text });
  assert.ok(result.ok, result.ok ? '' : result.failure.detail);
  return result.findings;
};





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

const only = (findings: readonly Finding[], source: string) => findings.filter((f) => f.source === source);
function assertShape(finding: Finding | undefined, category: keyof typeof CATEGORIES): Finding {
  assert.ok(finding, 'finding expected');
  assert.equal(finding.category, category);
  assert.ok(COMPONENTS.has(finding.component), `dispatch component: ${finding.component}`);
  for (const field of [finding.evidence, finding.impact, finding.proposedFix]) assert.ok(field.trim().length > 0);
  return finding;
}

// SECTION: Layout, durations, and token columns



// SECTION: Heuristics, severity, and model attribution



const rejections = (tool: string, action: string, cls: string, count = 2) => Array.from({ length: count }, () => ({ tool, action, cls }));
const h8 = (rejectedTools: NonNullable<RunFacts['rejectedTools']>) => only(heuristics(facts({ rejectedTools })), 'H8');















const stageRows = (text: string) => text.split('### Tokens by stage')[1]!.split('### Review yield')[0]!.split('\n').filter((line) => line.startsWith('|'));







// SECTION: Scope gate and redaction

const LEAKS = [
  'see /home/alice/repo/src/app.ts', 'at ~/work/app', 'path C:\\Users\\alice\\repo', 'path d:/work/repo', 'share \\\\server\\team\\x',
  'docs at https://intranet.example/x', 'host www.example.org', 'host build.example.com', 'mail alice@example.com',
  'session 123e4567-e89b-12d3-a456-426614174000', `hash ${'a1'.repeat(20)}`,
];
const CLEAN = 'The `/dispatch review` frame in scripts/toolkit/records.ts mixes input/output fields in config.local.jsonc.';











// SECTION: Finding origin

const originReply = (...origins: (string | undefined)[]) => report(origins.map((origin, index) => finding({defect: 'defect number ' + index + ' with distinct wording ' + 'x'.repeat(index) + ' unique' + index, locus: 'src/file' + index + '.ts:L1', ...(origin === undefined ? {} : {origin})})));
const draftsOf = (text: string) => { const result = parseReport({kind: 'code', source: 'codex[0]', text}); assert.ok(result.ok, JSON.stringify(result)); return result.findings; };








test('diagnostics config renders utility-subagents and redacts read-command locators', () => {
  const config = { 'utility-subagents': { codex: { model: 'gpt-6-luna', effort: 'low', 'context-limit': 300000 } } };
  const sanitized = sanitizeFacts(facts({ config }));
  assert.deepEqual(sanitized.config?.['utility-subagents'], config['utility-subagents']);
  const text = render([facts({ config })]);
  assert.match(text, /"utility-subagents": \{/);
  assert.match(text, /"effort": "low"/);
  const redacted = sanitizeFacts(facts({ config: { 'read-commands': ['codegraph explore', 'tool /home/me/x', 'tool https://x.io'] } }));
  assert.deepEqual(redacted.config?.['read-commands'], ['codegraph explore', '—', '—']);
});

test('pricing override snapshot keeps dotted ids and provider wildcards and drops unsafe keys and invalid entries', () => {
  const entry = { rates: { input: 1, output: 5, cacheRead: 0.05 }, tiers: [{ abovePromptTokens: 272000, rates: { input: 2, output: 7.5, cacheRead: 0.1 } }] };
  const zero = { rates: { input: 0, output: 0 } };
  const pricing = {
    'gpt-6.1-terra': entry, 'lmstudio/*': zero, 'bedrock.claude-opus-5-5': zero,
    'build.example.com': zero, 'C:\\canary': zero, 'bad-rate': { rates: { input: -1, output: 1 } }, 'bad-shape': 'x', 'Upper/*': zero,
  };
  const clean = sanitizeFacts(facts({ config: { pricing } })).config?.['pricing'];
  assert.deepEqual(clean, { 'gpt-6.1-terra': entry, 'lmstudio/*': zero, 'bedrock.claude-opus-5-5': zero });
  assert.deepEqual(sanitizeFacts(facts({ config: { pricing: 'cheap' } })).config?.['pricing'], {});
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`model-${i}`, zero]));
  assert.equal(Object.keys(sanitizeFacts(facts({ config: { pricing: many } })).config?.['pricing'] as object).length, 32);
  const text = render([facts({ config: { pricing } })]);
  assert.ok(text.includes('"gpt-6.1-terra"') && text.includes('"lmstudio/*"') && text.includes('"abovePromptTokens": 272000'), text);
  assert.ok(!text.includes('build.example.com') && !text.includes('canary'));
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
  assert.ok(text.includes('| 1 · review · medium | code review · review | complete | 1h 2m 3s | 45s | 1m 0s | <1s | 1 |'), text);
  assert.match(text, /^- Runs: 1 · measured duration: 1h 2m 3s$/m);
  assert.match(text, /\| Input \| Cache read \| Cache write \| Output \|/);
  assert.ok(text.includes('| 1 | 1,000 | 2,000 | 300 | 40 | 1/1 |'), text);
  assert.match(text, /^- Provider CLI measured tokens: 3,340 \(input 1,000 · cache read 2,000 · cache write 300 · output 40\) · launch coverage 1\/1$/m);
  const partial = render([facts({
    phases: [{ key: 'review', name: 'code review', outcome: 'complete', wallMs: 3_723_000 }],
    invocations: [invocation({ usage: { input: 500, output: 20 } }), bare({ provider: 'claude', model: 'claude-opus-5-5', outcome: 'timeout' })],
  })]);
  assert.ok(partial.includes('| 1 · review · medium | code review · review | complete | 1h 2m 3s | 2 | 500 | — | — | 20 | 1/2 |'), partial);
  assert.ok(partial.includes('| code review | claude | delegate | claude-opus-5-5 (configured) | medium | — | — | — | — | — | 0/1 | — | — |'), partial);

  const legacy = render([facts({
    invocations: [
      { ...invocation(), estimated: true, tokens: 5000 } as unknown as InvocationFacts,
      { ...bare({ surface: 'native', provider: 'claude', model: 'claude-opus-5-5', mode: 'native' }), estimated: true, tokens: 5000 } as unknown as InvocationFacts,
    ],
  })]);
  assert.match(legacy, /^- Provider CLI measured tokens: 3,340 \(input 1,000 · cache read 2,000 · cache write 300 · output 40\) · launch coverage 1\/1$/m);
  assert.doesNotMatch(legacy, /Estimated, excluded from measured totals/);
  assert.doesNotMatch(legacy, /~5,000/);
  assert.ok(legacy.includes('| 2 | 1,000 | 2,000 | 300 | 40 | 1/1 |'), legacy);
});

test('elapsed waits and partial usage remain explicit', () => {
  const usage = normalizeUsage({ input: 3000, cacheRead: 2000, output: 40, reasoning: 20 }, 'includes-cache');
  assert.ok(usage);
  const run = facts({
    invocations: [
      invocation({ usage }),
      bare({ provider: 'claude', outcome: 'timeout' }),
      bare({ surface: 'native', mode: 'native' }),
    ],
  });
  const text = render([run]);
  assert.match(text, /Provider CLI measured tokens: 3,040 \(input 1,000 · cache read 2,000 · cache write — · output 40\) · launch coverage 1\/2/);
  assert.match(text, /Full conversation totals are unavailable/);

  assert.ok(text.includes('| — | native completed |'), 'unattested native usage stays unavailable');
  const quota = only(heuristics(facts({ invocations: [invocation({ outcome: 'quota' }), invocation({ outcome: 'quota' })] })), 'H1')[0]!;
  assert.match(quota.proposedFix, /Reorder or remove the exhausted model alias, or check its quota/);
  assert.doesNotMatch(quota.proposedFix, /add another model alias/);
  assert.doesNotMatch(quota.proposedFix, /each model has its own quota/);
});

test('H8 names the handling module of repeated rejections and ignores one-offs', () => {
  const verify = assertShape(h8(rejections('check', 'run', 'invalid-input'))[0], 'correctness');
  assert.equal(verify.component, 'scripts/toolkit/check.ts');
  assert.match(verify.evidence, /2 toolkit operations rejected \(check run: invalid-input ×2\)/);

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

  assert.deepEqual(h8(rejections('check', 'run', 'invalid-input', 1)), []);
  assert.deepEqual(h8([...rejections('check', 'run', 'invalid-input', 1), ...rejections('check', 'run', 'user-only', 1)]), []);
  assert.deepEqual(h8([...rejections('ledger', 'append', 'key-conflict', 1), ...rejections('ledger', 'query', 'key-conflict', 1)]), []);
  const [mixed] = h8([...rejections('check', 'run', 'invalid-input'), ...rejections('check', 'run', 'user-only', 1)]);
  assert.match(mixed!.evidence, /2 toolkit operations rejected \(check run: invalid-input ×2\)/);
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
  assert.ok(mixed.includes('| code review | claude | delegate | claude-opus-5-5 | medium | 100 | — | — | 10 | — | 1/1 |'), mixed);
  const table = mixed.split('### Tokens by stage')[1]!.split('### Review yield')[0]!;
  assert.equal((table.match(/claude-opus-5-5/g) ?? []).length, 2);
  const configured = render([facts({ invocations: [invocation({ reportedModels: ['gpt-6-sol-2026'], usage: { input: 100, output: 10 } })] })]);
  assert.ok(configured.includes('| code review | codex | delegate | gpt-6-sol-2026 | medium | 100 | — | — | 10 | — | 1/1 |'), configured);
  assert.ok(configured.includes('gpt-6-sol (reported: gpt-6-sol-2026)'), configured);

  const multi = render([facts({ invocations: [invocation({ provider: 'claude', model: 'claude-opus-5-5', reportedModels: ['claude-opus-5-5', 'claude-haiku-5'], usage: { input: 100, output: 10 } })] })]);
  assert.ok(multi.includes('| code review | claude | delegate | — | medium | 100 | — | — | 10 | — | 1/1 |'), multi);
  assert.doesNotMatch(multi, /\(configured\)/);
});

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
  assert.ok(text.includes('Cost includes delegate usage in its recorded phase and host and subagent usage in time-estimated phases.'));
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
  const hostUsage = readHostUsage('agy',{startMs:0,endMs:10,home:'unused',env:()=> 'thread',stages:[]},onlyFs,{agy:{sessionEnv:['CUSTOM_THREAD'],read:()=>({rows:[{stage:'plan',role:'host',model:'stub-model',effort:null,depth:0,atMs:0,reasoningInOutput:false,input:17,output:4,cacheRead:2}]})}});
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

test('key bound: sanitize bounds 40 model keys to 32 largest plus other', () => {
  const models: Record<string, { input: number; output: number }> = {};
  for (let i = 0; i < 40; i++) {
    models[`m${String(i).padStart(2, '0')}#high`] = { input: (i + 1) * 10, output: 1 };
  }
  const clean = sanitizeFacts(facts({ invocations: [invocation({ usage: { input: 8200, output: 40, models } })] }));
  const kept = Object.keys(clean.invocations[0]?.usage?.models ?? {});
  assert.equal(kept.length, 33);
  assert.ok(kept.includes('other'));
  assert.equal('m00#high' in (clean.invocations[0]?.usage?.models ?? {}), false);
  assert.equal('m08#high' in (clean.invocations[0]?.usage?.models ?? {}), true);
});

test('banded facts: round-trips valid bands, split, reasoningInOutput and phase, and drops invalid bands or over-total split', () => {
  const valid = sanitizeFacts(facts({
    hostUsage: {
      platform: 'claude',
      rows: [{
        stage: 'plan', phase: 'plan', role: 'host', model: 'm', effort: 'high',
        input: 100, output: 10, cacheWrite: 20, cacheWrite5m: 12, cacheWrite1h: 8, reasoningInOutput: true,
        bands: { le100k: { input: 100, output: 10, cacheWrite: 20, cacheWrite5m: 12, cacheWrite1h: 8 } },
      } as never],
    },
    invocations: [invocation({
      usage: {
        input: 100, output: 10, cacheWrite: 20, cacheWrite5m: 12, cacheWrite1h: 8, reasoningInOutput: false,
        bands: { le100k: { input: 100, output: 10, cacheWrite: 20, cacheWrite5m: 12, cacheWrite1h: 8 } },
      } as never,
    })],
  }));
  const hRow = valid.hostUsage?.rows[0] as Record<string, unknown>;
  assert.equal(hRow['phase'], 'plan');
  assert.equal(hRow['cacheWrite5m'], 12);
  assert.equal(hRow['cacheWrite1h'], 8);
  assert.equal(hRow['reasoningInOutput'], true);
  assert.ok(hRow['bands']);
  const uRow = valid.invocations[0]?.usage as Record<string, unknown>;
  assert.equal(uRow['cacheWrite5m'], 12);
  assert.equal(uRow['cacheWrite1h'], 8);
  assert.equal(uRow['reasoningInOutput'], false);
  assert.ok(uRow['bands']);

  const invalid = sanitizeFacts(facts({
    invocations: [invocation({
      usage: {
        input: 100, output: 10, cacheWrite: 10, cacheWrite5m: 8, cacheWrite1h: 5,
        bands: { le100k: { input: 99, output: 10 }, bogus: { input: 1, output: 0 } },
      } as never,
    })],
  }));
  const badU = invalid.invocations[0]?.usage as Record<string, unknown>;
  assert.equal('bands' in badU, false);
  assert.equal('cacheWrite5m' in badU, false);
  assert.equal('cacheWrite1h' in badU, false);
});

test('coverage list: sanitizes legacy string and renders reasons on measured and unmeasured invocations', () => {
  const { usage: _u, ...unmeasuredCopilot } = invocation({ provider: 'copilot', coverage: 'no usage output' } as unknown as Partial<InvocationFacts>);
  const legacy = sanitizeFacts(facts({ invocations: [unmeasuredCopilot] }));
  assert.deepEqual(legacy.invocations[0]?.coverage, ['no usage']);

  const text = render([facts({
    invocations: [
      unmeasuredCopilot,
      invocation({ provider: 'claude', usage: { input: 50, output: 5 }, coverage: ['transcript unavailable'] }),
    ],
  })]);
  assert.match(text, /\| claude \| 50 \| — \| — \| 5 \| — \| delegates 1\/1 transcript unavailable \|/);
  assert.match(text, /\| copilot \| — \| — \| — \| — \| — \| delegates 0\/1 no usage \|/);
  assert.match(text, /\| code review \| claude \| delegate \| .* \| 50 \| — \| — \| 5 \| — \| 1\/1 transcript unavailable \|/);
  assert.match(text, /\| code review \| copilot \| delegate \| .* \| — \| — \| — \| — \| — \| 0\/1 no usage \|/);
});

test('review timing preserves unknown slots and limits CLI spans to launched attempts', () => {
 const timing=[{review:'review-1234567890abcdef',round:1,slots:[{slot:'codex[0]',attempts:[{startMs:0,endMs:100}]},{slot:'claude[0]',attempts:[{startMs:90,endMs:110}]}]}];
 const text=render([facts({roundTiming:timing} as never)]);
 assert.match(text,/subject 1234567890abcdef/);
 assert.match(text,/claude\[0\].*✓/);
 const unknown=render([facts({roundTiming:[{...timing[0],slots:[...timing[0]!.slots,{slot:'native[0]',attempts:[]}]}]} as never)]);
 assert.doesNotMatch(unknown,/✓/);
 const review='review-1234567890abcdef';
 const cli=(startMs:number,endMs?:number)=>({surface:'cli' as const,startMs,...(endMs===undefined?{}:{endMs})});
 const native={surface:'native' as const};
 const empty={slot:'empty[0]',attempts:[]};
 const nativeOnly={slot:'native[0]',attempts:[native]};
 const prior={slot:'codex[0]',attempts:[cli(1000,2500),native]};
 const last={slot:'native[1]',attempts:[cli(6000,8000)]};
 const cliText=render([facts({roundTiming:[
  {review,round:1,slots:[prior,empty,nativeOnly,last]},
  {review,round:2,slots:[prior,{...last,attempts:[cli(6000)]}]},
  {review,round:3,slots:[empty,nativeOnly]},
  {review,round:4,slots:[prior,{...last,attempts:[{startMs:6000,endMs:8000}]}]},
]} as never)]);
 const spans=cliText.split('### Review CLI attempt spans')[1]!;
 assert.match(spans,/\| 1 \| 7s \| native\[1\] \|/);
 for(const round of [2,3,4]) assert.ok(spans.includes(`| ${round} | — | — |`));
 assert.match(cliText,/\| 1 \| codex\[0\] \| — \| — \|/);
});

test('review timing includes retry gaps, ties and invalid endpoints', () => {
 const slot=(slot:string,...attempts:unknown[])=>({slot,attempts});
 const rounds=[
  {review:'review-1234567890abcdef',round:1,slots:[slot('a[0]',{startMs:0,endMs:1000},{startMs:3000,endMs:5000}),slot('b[0]',{startMs:4000,endMs:5000})]},
  {review:'review-1234567890abcdef',round:2,slots:[slot('a[0]',{startMs:0,endMs:1000},{startMs:3000,endMs:2000}),slot('b[0]',{startMs:0,endMs:5000})]},
  {review:'review-1234567890abcdef',round:3,slots:[slot('native[0]'),slot('a[0]',{startMs:1})]},
 ];
 const text=render([facts({roundTiming:rounds} as never)]);
 assert.match(text,/\| subject 1234567890abcdef \| 1 \| a\[0\] \| 5s \| ✓ \|/);
 assert.match(text,/\| subject 1234567890abcdef \| 1 \| b\[0\] \| 1s \| — \|/);
 assert.match(text,/\| subject 1234567890abcdef \| 2 \| a\[0\] \| — \| — \|/);
 assert.match(text,/\| subject 1234567890abcdef \| 3 \| native\[0\] \| — \| — \|/);
 assert.equal((text.match(/✓/g)??[]).length,1);
 assert.doesNotMatch(text,/slot removal|remove.*slot/i);
});

test('review timing compaction omits complete rounds and retains the omission count', () => {
 const rounds=Array.from({length:3000},(_,i)=>({review:'review-1234567890abcdef',round:i+1,slots:[{slot:'codex[0]',attempts:[{startMs:0,endMs:1000}]}]}));
 const text=render([facts({roundTiming:rounds} as never)]);
 assert.ok(Buffer.byteLength(text)<=DIAGNOSTIC_LIMITS.reportBytes);
 const count=Number(/(\d+) review timing rounds omitted/.exec(text)?.[1]);
 assert.ok(count>1);
 assert.match(text,new RegExp(`\\| subject 1234567890abcdef \\| ${3000-count} \\|`));
 assert.doesNotMatch(text,new RegExp(`\\| subject 1234567890abcdef \\| ${3001-count} \\|`));
 const next=text.replace('\n\n### Review CLI attempt spans', `\n| subject 1234567890abcdef | ${3001-count} | codex[0] | 1s | ✓ |\n\n### Review CLI attempt spans`)
   .replace(`\n\n${count} review timing rounds omitted`, `\n| subject 1234567890abcdef | ${3001-count} | — | — |\n\n${count-1} review timing rounds omitted`);
 assert.ok(Buffer.byteLength(next)>DIAGNOSTIC_LIMITS.reportBytes, 'another complete round exceeds the cap');
});


test('review timing rejects nonopaque identities and invalid endpoints', () => {
 const text=render([facts({roundTiming:[{review:'private/path',round:1,slots:[{slot:'a[0]',attempts:[{startMs:0,endMs:1}]}]},{review:'review-1234567890abcdef',round:2,slots:[{slot:'a[0]',attempts:[{startMs:-1,endMs:5}]}]}]} as never)]);
 assert.doesNotMatch(text,/private\/path/);
 assert.match(text,/\| subject 1234567890abcdef \| 2 \| a\[0\] \| — \| — \|/);
});

test('malformed timing slots and attempts stay unknown without leaking names', () => {
 const text=render([facts({roundTiming:[{review:'review-1234567890abcdef',round:1,slots:[{slot:'private/path',attempts:[{startMs:0,endMs:3}]},{slot:'a[0]',attempts:[{startMs:0,endMs:4},null]},null,{slot:'b[0]',attempts:[{startMs:0,endMs:5}]}]}]} as never)]);
 assert.doesNotMatch(text,/private\/path|✓/);
 const timing=text.split('### Review round timing')[1]!.split('### Review yield')[0]!;
 assert.equal((timing.match(/\| — \| — \| — \|/g)??[]).length,2);
 assert.match(text,/\| a\[0\] \| — \| — \|/);
});

test('round workload renders observed calls, dashes for unavailable cells, and the not-counted note', () => {
 const review='review-1234567890abcdef';
 const text=render([facts({roundWorkload:[
  {review,round:1,calls:{total:9,phases:[{key:'ledger-append',count:4},{key:'lint-run',count:3},{key:'brief-explorer',count:1},{key:'review-run-plan',count:1}]},hostTokens:8214330},
  {review,kind:'plan',round:2,calls:{total:1,phases:[{key:'review-run-plan',count:1}]},hostTokens:2901550},
  {review,round:3},
  {review,round:4,calls:{total:1,phases:[{key:'review-run-plan',count:1}]}},
 ]})]);
 assert.match(text,/### Review round workload\n\n\| Review \| Round \| Toolkit calls \| Host tokens \| Host turns \|\n\| --- \| ---: \| --- \| ---: \| ---: \|/);
 assert.match(text,/\| subject 1234567890abcdef \| 1 \| 9: ledger-append 4 · lint-run 3 · brief-explorer 1 · review-run-plan 1 \| 8,214,330 \|/);
 assert.match(text,/\| subject 1234567890abcdef \| 2 \| 1: review-run-plan 1 \| 2,901,550 \|/);
 assert.match(text,/\| subject 1234567890abcdef \| 3 \| — \| — \|/);
 assert.match(text,/\| subject 1234567890abcdef \| 4 \| 1: review-run-plan 1 \| — \|/);
 assert.match(text,/Observed toolkit calls only: `report` and `diagnostics` calls and work outside round windows are not counted\./);
 assert.match(text,/Advisory budget per round with a lightweight fix review: at most 6 toolkit calls and 25 host turns; over: none/);
 assert.doesNotMatch(text,/capture storage failure/);
});

test('round workload notes storage failures once and is omitted without review rounds', () => {
 const review='review-1234567890abcdef';
 const failed=render([facts({roundWorkload:[{review,round:1,calls:{total:1,phases:[{key:'lint-run',count:1}]}}],collection:{storageFailed:2}})]);
 assert.equal((failed.match(/2 capture storage failures: calls from failed updates may be missing from the counts above\./g)??[]).length,1);
 assert.doesNotMatch(render([facts({})]),/### Review round workload/);
 assert.doesNotMatch(render([facts({roundWorkload:[]})]),/### Review round workload/);
});

test('round workload follows review round timing and precedes review yield by kind, provider and model', () => {
 const review='review-1234567890abcdef';
 const text=render([facts({
  roundTiming:[{review,round:1,slots:[{slot:'claude[0]',attempts:[{startMs:0,endMs:100}]}]}],
  roundWorkload:[{review,round:1,calls:{total:1,phases:[{key:'review-run-plan',count:1}]}}],
 })]);
 const at=(heading:string)=>text.indexOf(heading);
 assert.ok(at('### Review round timing')>=0);
 assert.ok(at('### Review round timing')<at('### Review round workload'));
 assert.ok(at('### Review round workload')<at('### Review yield by kind, provider and model'));
});

test('round workload survives sanitizing and drops malformed rows, keys, and fields', () => {
 const review='review-1234567890abcdef';
 const clean=sanitizeFacts(facts({roundWorkload:[
  {review,round:1,calls:{total:2,phases:[{key:'lint-run',count:2},{key:'Bad Key',count:1}]},hostTokens:40,secret:'/private/path'},
  {review:'plan-x',round:1,calls:{total:1,phases:[]}},
  {review,round:2},
 ] as never}));
 assert.deepEqual(clean.roundWorkload,[
  {review,round:1,calls:{total:2,phases:[{key:'lint-run',count:2}]},hostTokens:40},
  {review,round:2},
 ]);
});

test('the render path keeps allowlisted host response facts and removes raw identities', () => {
  const response = { stage: 'plan', role: 'host', agent: 'host-1', basis: 'claude-assistant-message', coverage: 'complete', observed: 2, uncachedInput: 18 } as const;
  const hostUsage = {
    platform: 'claude',
    rows: [{ stage: 'plan', role: 'host', model: 'fixture-model', effort: null, input: 18, output: 2 }],
    responses: [
      { ...response, actor: 'private-thread', raw: 'secret transcript' },
      { ...response, agent: 'private-thread' },
      { ...response, coverage: 'partial', observed: -1 },
      { ...response, basis: 'unverified-shape' },
      { ...response, stage: 'unattributed', role: 'subagent', agent: undefined, coverage: 'unknown', observed: undefined, uncachedInput: undefined },
    ],
  } as NonNullable<RunFacts['hostUsage']>;
  const run = facts({ hostUsage, invocations: [] });
  const clean = sanitizeFacts(run);
  assert.deepEqual(clean.hostUsage?.responses, [
    response,
    { stage: 'unattributed', role: 'subagent', basis: 'claude-assistant-message', coverage: 'unknown' },
  ]);
  assert.deepEqual(sanitizeFacts(clean).hostUsage?.responses, clean.hostUsage?.responses);
  const report = render([run]);
  assert.match(report, /fixture-model/);
  assert.doesNotMatch(report, /private-thread|secret transcript|unverified-shape/);
  assert.equal(sanitizeFacts(facts({ hostUsage: { platform: 'claude', rows: [] } })).hostUsage?.responses, undefined);
});

test('response tables reconcile matched input while retaining partial and zero evidence', () => {
  const basis = 'claude-assistant-message' as const;
  const text = render([facts({
    hostUsage: { platform: 'claude', rows: [], responses: [
      { stage: 'plan', role: 'host', agent: 'host-1', basis, coverage: 'partial', observed: 2, uncachedInput: 21 },
      { stage: 'plan', role: 'host', basis, coverage: 'partial', observed: 1 },
      { stage: 'plan review', role: 'host', agent: 'host-1', basis, coverage: 'complete', observed: 1, uncachedInput: 80 },
    ] },
    invocations: [
      invocation({ responses: [
        { stage: 'code review', role: 'delegate', agent: 'delegate-0123456789abcdef', basis, coverage: 'complete', observed: 0, uncachedInput: 0 },
      ] }),
      invocation({ responses: [
        { stage: 'code review', role: 'delegate', agent: 'delegate-fedcba9876543210', basis, coverage: 'complete', observed: 2, uncachedInput: 10 },
      ] }),
      invocation(),
    ],
  })]);
  assert.match(text, /\| plan \| host \| claude-assistant-message \| 3 \| partial \| 2 \| 21 \| 10\.50 \|/);
  assert.match(text, /\| plan review \| host \| host-1 \| claude-assistant-message \| 1 \| complete \| 1 \| 80 \| 80\.00 \|/);
  assert.match(text, /\| code review \| delegate \| delegate-2 \| claude-assistant-message \| 0 \| complete \| 0 \| 0 \| — \|/);
  assert.match(text, /\| code review \| delegate \| unavailable \| — \| unavailable \|/);
  assert.doesNotMatch(text, /delegate-0123456789abcdef|delegate-fedcba9876543210/);
});

test('each run retains its own bounded response aliases', () => {
  const invocations = Array.from({ length: 33 }, (_, index) => invocation({ responses: [{
    stage: 'code review', role: 'delegate', agent: `delegate-${index.toString(16).padStart(16, '0')}`,
    basis: 'claude-assistant-message', coverage: 'complete', observed: 1, uncachedInput: 2,
  }] }));
  const returning = invocation({ responses: [{ ...invocations[0]!.responses![0]!, stage: 'plan review' }] });
  const run = facts({ invocations: [...invocations, returning] });
  const text = render([run, run]);
  const detail = text.split('### Responses by agent')[1]!.split('### Review yield')[0]!;
  for (const run of [1, 2]) {
    assert.equal(detail.match(new RegExp(`\\| code review \\| delegate \\| run ${run} delegate-\\d+ \\|`, 'g'))?.length, 32);
    assert.ok(detail.includes(`| plan review | delegate | run ${run} delegate-1 |`));
  }
  assert.match(detail, /\| code review \| delegate \| Unnamed or folded \| claude-assistant-message \| 2 \| partial \| 2 \| 4 \|/);
  assert.match(text, /\| code review \| delegate \| claude-assistant-message \| 66 \| partial \| 66 \| 132 \|/);
});

test('report compaction retains response coverage and totals ahead of bounded agent and workload detail', () => {
  const responses = Array.from({ length: 64 }, (_, i) => ({
    stage: 'code review' as const, role: 'delegate' as const,
    agent: `delegate-${i.toString(16).padStart(16, '0')}`,
    basis: 'claude-assistant-message' as const, coverage: 'complete' as const, observed: 1, uncachedInput: 2,
  }));
  const phases = Array.from({ length: 100 }, (_, i) => ({ key: `ledger-append-${i}`, count: i }));
  const text = render([facts({
    invocations: responses.map(response => invocation({ responses: [response] })),
    roundWorkload: Array.from({ length: 1000 }, (_, i) => ({
      review: 'review-1234567890abcdef', round: i + 1, calls: { total: 4950, phases },
    })),
  })]);
  assert.ok(Buffer.byteLength(text) <= DIAGNOSTIC_LIMITS.reportBytes);
  assert.match(text, /\| code review \| delegate \| claude-assistant-message \| 64 \| partial \| 64 \| 128 \| 2\.00 \|/);
  assert.match(text, /workload rows omitted/);
  assert.doesNotMatch(text, /Truncated at the report size limit/);
});
