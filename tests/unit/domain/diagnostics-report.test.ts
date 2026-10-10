import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CATEGORIES, COMPONENTS, formatDuration, heuristics, normalizeUsage, rejectionReason, renderDiagnostics, retroObservations, sanitizeFacts,
  type Finding, type InvocationFacts, type RunFacts, type Usage,
} from '../../../skills/dispatch/scripts/domain/diagnostics.ts';

const SKILL_ROOT = fileURLToPath(new URL('../../../skills/dispatch/', import.meta.url));

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
  hostGaps: [], invocations: [invocation()], reviews: [], rejectedEvents: [], ...overrides,
});
const observation = (overrides: Record<string, unknown> = {}) => ({
  id: 'o1', component: 'scripts/core/frame.ts', category: 'instruction-clarity',
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

// SECTION: SC1 — layout, durations, and token columns

test('SC1 renders sections in order', () => {
  const text = render([facts()]);
  const at = ['## Summary', '## Overview', '## Findings', '## Appendix', '<details>'].map((marker) => text.indexOf(marker));
  assert.ok(at.every((index) => index >= 0), `all sections present: ${at.join(',')}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at);
});

test('SC1 summary shows version and build', () => {
  assert.match(render([facts()]), /^- Build: dispatch 0\.7\.1 · build abababababab$/m);
  const { version: _version, ...rest } = facts();
  assert.match(render([{ ...rest, build: 'not-a-hash' }]), /^- Build: dispatch — · build —$/m);
});

test('SC1 formats durations', () => {
  assert.equal(formatDuration(3_723_000), '1h 2m 3s');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(400), '<1s');
  assert.equal(formatDuration(undefined), '—');
});

test('SC1 renders wall driver host and user wait columns', () => {
  const text = render([facts()]);
  assert.match(text, /\| Phase \| Outcome \| Wall \| Driver \| Host \| User wait \|/);
  assert.ok(text.includes('| 1 · review · medium | code review | complete | 1h 2m 3s | 45s | 1m 0s | <1s | 1 |'), text);
  assert.match(text, /^- Runs: 1 · wall time: 1h 2m 3s$/m);
});

test('SC1 renders input cache-read cache-write output tokens', () => {
  const text = render([facts()]);
  assert.match(text, /\| Input \| Cache read \| Cache write \| Output \|/);
  assert.ok(text.includes('| 1 | 1,000 | 2,000 | 300 | 40 | 1/1 |'), text);
  assert.match(text, /^- Measured tokens: 3,340 \(input 1,000 · cache read 2,000 · cache write 300 · output 40\) · coverage 1\/1$/m);
});

test('SC1 renders unavailable as dash', () => {
  const text = render([facts({
    phases: [{ key: 'review', name: 'code review', outcome: 'complete', wallMs: 3_723_000 }],
    invocations: [invocation({ usage: { input: 500, output: 20 } }), bare({ provider: 'claude', model: 'claude-opus-5-5', outcome: 'timeout' })],
  })]);
  assert.ok(text.includes('| 1 · review · medium | code review | complete | 1h 2m 3s | — | — | — | 2 | 500 | — | — | 20 | 1/2 |'), text);
  assert.ok(text.includes('| claude | all models | — | — | — | — | 0/1 |'), text);
  assert.match(text, /orchestrator —/);
});

test('SC1 excludes estimates from measured totals', () => {
  const text = render([facts({
    orchestratorBytes: 4000,
    invocations: [
      invocation(),
      bare({ surface: 'native', provider: 'claude', model: 'claude-opus-5-5', mode: 'native', estimated: true, tokens: 5000 }),
      invocation({ surface: 'native', provider: 'claude', model: 'claude-opus-5-5', mode: 'native', estimated: true, usage: { input: 9000, output: 1000 } }),
    ],
  })]);
  assert.match(text, /^- Measured tokens: 3,340 \(input 1,000 · cache read 2,000 · cache write 300 · output 40\) · coverage 1\/1$/m);
  assert.match(text, /^- Estimated, excluded from measured totals: native and write ~15,000 · orchestrator ~1,000$/m);
  assert.ok(text.includes('| 3 | 1,000 | 2,000 | 300 | 40 | 1/1 |'), text);
  assert.ok(text.includes('| ~5,000 | ok |'), text);
});

// SECTION: SC2 — heuristics, severity, and model attribution

test('SC2 heuristic H1 fires', () => {
  const finding = assertShape(only(heuristics(facts({ invocations: [invocation({ outcome: 'timeout', durationMs: 120_000 }), invocation()] })), 'H1')[0], 'correctness');
  assert.equal(finding.component, 'scripts/providers/runner.ts');
  assert.match(finding.evidence, /`timeout`: 1 of 2 CLI attempts failed \(codex ×1\), 2m 0s of driver time/);
});

test('SC2 heuristic H2 fires', () => {
  const reraised = assertShape(only(heuristics(facts({ reviews: [
    { phase: 'review', round: 1, accepted: 1, rejected: 1 },
    { phase: 'review', round: 2, accepted: 1, rejected: 0, reraised: ['R1-F001'] },
  ] })), 'H2')[0], 'review-convergence');
  assert.match(reraised.evidence, /code review: 2 rounds; 1 finding re-raised across rounds \(R1-F001\)\./);
  const escalated = only(heuristics(facts({ reviews: [
    { phase: 'review', round: 1, accepted: 1, rejected: 0 },
    { phase: 'review', round: 2, accepted: 0, rejected: 0, escalation: { kind: 'regression', ids: ['R1-F001'] } },
  ] })), 'H2');
  assert.match(assertShape(escalated[0], 'review-convergence').evidence, /code review: 2 rounds; regression escalation \(R1-F001\)\./);
  const rounds = only(heuristics(facts({ reviews: [1, 2, 3, 4].map((round) => ({ phase: 'review', round, accepted: 1, rejected: 0, cap: 3 })) })), 'H2');
  assert.match(assertShape(rounds[0], 'review-convergence').evidence, /code review: 4 rounds\./);
});

test('SC2 heuristic H3 fires', () => {
  const finding = assertShape(only(heuristics(facts({ reviews: [{ phase: 'review', round: 1, accepted: 1, rejected: 2 }] })), 'H3')[0], 'review-convergence');
  assert.match(finding.evidence, /code review round 1: 2 of 3 findings rejected \(67%\)/);
});

test('SC2 heuristic H4 fires', () => {
  const finding = assertShape(only(heuristics(facts({ invocations: [invocation({ usage: { input: 700, cacheRead: 300, output: 10 } })] })), 'H4')[0], 'token-economy');
  assert.match(finding.evidence, /codex: cache read 30% of input \(300 of 1,000 tokens\) across 1 invocation\./);
});

test('SC2 heuristic H5 fires', () => {
  const finding = assertShape(only(heuristics(facts({ invocations: [invocation({ usage: { input: 9000, cacheRead: 9000, output: 100 } }), invocation(), invocation()] })), 'H5')[0], 'token-economy');
  assert.match(finding.evidence, /codex gpt-6-sol in code review: 18,100 of 24,780 measured tokens \(73%\)/);
});

test('SC2 heuristic H6 fires', () => {
  const finding = assertShape(only(heuristics(facts({ hostGaps: [{ await: 'native', ms: 60_000 }, { await: 'rule', ms: 600_001 }] })), 'H6')[0], 'speed');
  assert.equal(finding.component, 'references/review-rules.md');
  assert.match(finding.evidence, /`rule` await took 10m 0s \(2 non-user awaits\)/);
});

test('SC2 heuristic H8 fires', () => {
  const finding = assertShape(only(heuristics(facts({ rejectedEvents: [{ eventType: 'RULINGS', reason: 'rulings[0].verdict: expected accept or reject' }] })), 'H8')[0], 'correctness');
  assert.match(finding.evidence, /1 host event rejected \(RULINGS ×1\): "rulings\[0\]\.verdict: expected accept or reject"/);
});

test('SC2 heuristic H9 fires', () => {
  const findings = only(heuristics(facts({ repairs: 2, admissionDefects: 1 })), 'H9');
  assert.match(assertShape(findings.find((f) => /repair/.test(f.evidence)), 'correctness').evidence, /2 implementation repair attempts/);
  assert.match(assertShape(findings.find((f) => /admission/.test(f.evidence)), 'correctness').evidence, /1 admission defect\./);
});

test('SC2 heuristic boundaries stay silent', () => {
  const even = invocation({ usage: { input: 1000, cacheRead: 1000, output: 0 } });
  const run = facts({
    invocations: [even, { ...even, provider: 'claude' }],
    reviews: [{ phase: 'review', round: 1, accepted: 1, rejected: 1 }, { phase: 'review', round: 2, accepted: 1, rejected: 1 }],
    hostGaps: [{ await: 'rule', ms: 600_000 }], rejectedEvents: [], repairs: 0, admissionDefects: 0,
  });
  assert.deepEqual(heuristics(run), []);
  assert.deepEqual(heuristics(facts()), []);
});

test('SC2 orders findings by severity', () => {
  const run = facts({
    invocations: [invocation({ outcome: 'quota' }), invocation({ usage: { input: 9000, cacheRead: 100, output: 0 } })],
    reviews: [1, 2, 3].map((round) => ({ phase: 'review', round, accepted: 1, rejected: 0, cap: 3, ...(round === 3 ? { reraised: ['R1-F001'] } : {}) })),
    hostGaps: [{ await: 'write', ms: 900_000 }],
    observations: [observation()],
  });
  const order = Object.keys(CATEGORIES);
  const categories = heuristics(run).map((f) => order.indexOf(f.category));
  assert.deepEqual([...categories].sort((a, b) => a - b), categories);
  const headings = [...render([run]).matchAll(/^### \d+\. ([^·]+) ·/gm)].map((m) => m[1]!.trim());
  assert.deepEqual([...new Set(headings)], ['Correctness / protocol', 'Token economy', 'Speed', 'Review convergence', 'Instruction clarity']);
});

test('heuristic precision H2 stays silent for rounds within the cap', () => {
  const rounds = (count: number, extra: Partial<RunFacts['reviews'][number]> = {}) => Array.from({ length: count }, (_, i) => ({ phase: 'review', round: i + 1, accepted: 1, rejected: 0, ...extra }));
  assert.deepEqual(only(heuristics(facts({ reviews: rounds(3, { cap: 3 }) })), 'H2'), [], 'three rounds within cap 3 is normal convergence');
  assert.match(assertShape(only(heuristics(facts({ reviews: rounds(4, { cap: 3 }) })), 'H2')[0], 'review-convergence').evidence, /code review: 4 rounds\./);
  const reraised = [...rounds(2, { cap: 3 }), { phase: 'review', round: 3, accepted: 1, rejected: 0, cap: 3, reraised: ['R1-F001'] }];
  assert.equal(only(heuristics(facts({ reviews: reraised })), 'H2').length, 1, 'a re-raise fires within the cap');
  const escalated = [{ phase: 'review', round: 1, accepted: 1, rejected: 0, cap: 3, escalation: { kind: 'deadlock' as const, ids: ['R1-F001'] } }];
  assert.equal(only(heuristics(facts({ reviews: escalated })), 'H2').length, 1, 'an escalation fires within the cap');
  assert.match(assertShape(only(heuristics(facts({ reviews: rounds(3) })), 'H2')[0], 'review-convergence').evidence, /code review: 3 rounds\./, 'an absent cap uses the fallback threshold');
});

test('heuristic precision screens the review cap as a bounded integer', () => {
  const capOf = (cap: unknown) => sanitizeFacts(facts({ reviews: [{ phase: 'review', round: 1, accepted: 0, rejected: 0, cap } as never] })).reviews[0]?.cap;
  assert.equal(capOf(3), 3);
  for (const bad of [-1, 2.5, 1_000_001, '3', null]) assert.equal(capOf(bad), undefined, String(bad));
});

test('heuristic precision H3 needs three findings', () => {
  assert.deepEqual(only(heuristics(facts({ reviews: [{ phase: 'review', round: 1, accepted: 0, rejected: 2 }] })), 'H3'), [], 'two findings are too few to judge a rejection share');
  assert.equal(only(heuristics(facts({ reviews: [{ phase: 'review', round: 1, accepted: 1, rejected: 2 }] })), 'H3').length, 1);
});

test('heuristic precision H5 needs three metered invocations and a share above two over n', () => {
  const big = invocation({ usage: { input: 9000, cacheRead: 9000, output: 100 } });
  assert.deepEqual(only(heuristics(facts({ invocations: [big, invocation()] })), 'H5'), [], 'with two invocations one always holds at least half');
  // 13,360 of 20,040 tokens is exactly 2/3, the bound for three invocations.
  const even = invocation({ usage: { input: 4000, cacheRead: 9000, cacheWrite: 300, output: 60 } });
  assert.deepEqual(only(heuristics(facts({ invocations: [even, invocation(), invocation()] })), 'H5'), [], 'a share at max(0.5, 2/n) stays silent');
  assert.equal(only(heuristics(facts({ invocations: [big, invocation(), invocation()] })), 'H5').length, 1);
});

test('heuristic precision H6 makes no driver-repeat claim', () => {
  const finding = assertShape(only(heuristics(facts({ hostGaps: [{ await: 'rule', ms: 600_001 }] })), 'H6')[0], 'speed');
  assert.equal(finding.impact, 'Long host turns dominate wall time.');
  assert.equal(finding.proposedFix, "Split the `rule` turn's work and record its sub-steps so the cost can be attributed.");
  assert.doesNotMatch(`${finding.impact} ${finding.proposedFix}`, /driver/);
});

test('SC2 equivalent codex and claude usage yield equal totals and heuristics', () => {
  const codex = normalizeUsage({ input: 1000, cacheRead: 300, cacheWrite: 0, output: 50 }, 'includes-cache');
  const claude = normalizeUsage({ input: 700, cacheRead: 300, cacheWrite: 0, output: 50 }, 'uncached');
  assert.deepEqual(codex, { input: 700, cacheRead: 300, cacheWrite: 0, output: 50 });
  assert.deepEqual(codex, claude);
  const run = (provider: string, usage: Usage | undefined) => facts({ invocations: [invocation({ provider, ...(usage ? { usage } : {}) })] });
  const [a, b] = [heuristics(run('codex', codex)), heuristics(run('claude', claude))];
  assert.deepEqual(a.map((f) => [f.source, f.category, f.evidence.replace('codex', 'P')]), b.map((f) => [f.source, f.category, f.evidence.replace('claude', 'P')]));
  assert.deepEqual(a.map((f) => f.source), ['H4']);
  const measuredLine = (text: string) => /^- Measured tokens: .*$/m.exec(text)?.[0];
  assert.equal(measuredLine(render([run('codex', codex)])), measuredLine(render([run('claude', claude)])));
  assert.equal(normalizeUsage({ input: 100, cacheRead: 300, output: 1 }, 'includes-cache')?.input, 0);
});

test('SC2 attributes tokens per reported model', () => {
  const text = render([facts({ invocations: [invocation({
    provider: 'claude', model: 'claude-opus-5-5', reportedModels: ['claude-opus-5-5', 'claude-haiku-5'],
    usage: { input: 150, output: 15, models: { 'claude-opus-5-5': { input: 100, output: 10 }, 'claude-haiku-5': { input: 50, output: 5 } } },
  })] })]);
  assert.ok(text.includes('| claude | all models | 150 | — | — | 15 | 1/1 |'), text);
  assert.ok(text.includes('| claude | claude-opus-5-5 | 100 | — | — | 10 | — |'), text);
  assert.ok(text.includes('| claude | claude-haiku-5 | 50 | — | — | 5 | — |'), text);
  assert.doesNotMatch(text, /\(configured\)/);
});

test('SC2 labels configured-model attribution', () => {
  const text = render([facts({ invocations: [invocation({ reportedModels: ['gpt-6-sol-2026'], usage: { input: 100, output: 10 } })] })]);
  assert.ok(text.includes('| codex | gpt-6-sol (configured) | 100 | — | — | 10 | — |'), text);
  assert.ok(text.includes('gpt-6-sol (reported: gpt-6-sol-2026)'), text);
});

test('SC2 multi-model aggregate leaves model attribution unavailable', () => {
  const text = render([facts({ invocations: [invocation({ provider: 'claude', model: 'claude-opus-5-5', reportedModels: ['claude-opus-5-5', 'claude-haiku-5'], usage: { input: 100, output: 10 } })] })]);
  assert.ok(text.includes('| claude | all models | 100 | — | — | 10 | 1/1 |'), text);
  assert.ok(text.includes('| claude | — | 100 | — | — | 10 | — |'), text);
  assert.doesNotMatch(text, /\(configured\)/);
});

// SECTION: SC3 — scope gate and redaction

test('SC3 rejects more than three observations', () => {
  const result = retroObservations(['a', 'b', 'c', 'd'].map((id) => observation({ id })));
  assert.deepEqual(result.values.map((v) => v.id), ['a', 'b', 'c']);
  assert.equal(result.rejected, 1);
  assert.deepEqual(retroObservations([]), { values: [], rejected: 0 });
});

test('SC3 rejects foreign component', () => {
  for (const component of ['src/app.ts', 'core/frame.ts', '../dispatch/scripts/core/frame.ts', 'skills/dispatch-plan/SKILL.md', 'README.md']) {
    assert.deepEqual(retroObservations([observation({ component })]), { values: [], rejected: 1 }, component);
  }
  assert.equal(retroObservations([observation({ component: 'skills/dispatch/scripts/core/frame.ts' })]).values[0]?.component, 'scripts/core/frame.ts');
  // NOTE: the allowlist mirrors the shipped tree, so adding or removing a script or reference fails here.
  const shipped = ['SKILL.md', ...['scripts', 'references'].flatMap((dir) => fs.readdirSync(path.join(SKILL_ROOT, dir), { recursive: true })
    .map((entry) => path.join(dir, String(entry))).filter((file) => fs.statSync(path.join(SKILL_ROOT, file)).isFile()).map((file) => file.split(path.sep).join('/')))];
  assert.deepEqual([...COMPONENTS].sort(), shipped.sort());
  for (const component of shipped) assert.equal(retroObservations([observation({ component })]).values.length, 1, component);
});

test('SC3 rejects unknown category', () => {
  for (const category of ['vibes', 'driver protocol', '', undefined]) assert.equal(retroObservations([observation({ category })]).rejected, 1, String(category));
  for (const category of [...Object.keys(CATEGORIES), 'Token economy']) assert.equal(retroObservations([observation({ category })]).values.length, 1, category);
});

test('SC3 rejects invalid id', () => {
  for (const id of ['', 'bad id', 'x'.repeat(49), 'a/b', 7]) assert.equal(retroObservations([observation({ id })]).rejected, 1, String(id));
  assert.deepEqual(retroObservations([observation({ id: 'dup' }), observation({ id: 'dup' })]).rejected, 1);
});

const LEAKS = [
  'see /home/alice/repo/src/app.ts', 'at ~/work/app', 'path C:\\Users\\alice\\repo', 'path d:/work/repo', 'share \\\\server\\team\\x',
  'docs at https://intranet.example/x', 'host www.example.org', 'host build.example.com', 'mail alice@example.com',
  'session 123e4567-e89b-12d3-a456-426614174000', `hash ${'a1'.repeat(20)}`,
];
const CLEAN = 'The `/dispatch review` frame in scripts/core/frame.ts mixes input/output fields in config.local.jsonc.';
for (const field of ['evidence', 'impact', 'proposedFix'] as const) {
  test(`SC3 rejects prohibited content in ${field}`, () => {
    for (const leak of LEAKS) assert.equal(retroObservations([observation({ [field]: leak })]).rejected, 1, `${field}: ${leak}`);
    assert.equal(retroObservations([observation({ [field]: CLEAN })]).values[0]?.[field], CLEAN);
  });
}

test('SC3 rejects oversized field', () => {
  assert.equal(retroObservations([observation({ evidence: 'z'.repeat(512) })]).values.length, 1);
  for (const evidence of ['z'.repeat(513), 'é'.repeat(257), '   ', 42]) assert.equal(retroObservations([observation({ evidence })]).rejected, 1, String(evidence).slice(0, 8));
});

test('SC3 sanitizes model and config facts', () => {
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

test('SC3 rejects locators in ids models and config', () => {
  for (const locator of ['123e4567-e89b-12d3-a456-426614174000', 'build.example.com']) {
    const text = render([facts({
      config: { 'read-delegates': { codex: { targets: [{ low: { model: locator } }] }, [locator]: { model: 'gpt-6-sol' } } },
      invocations: [invocation({ model: locator, reportedModels: [locator, 'gpt-6-sol'], usage: { input: 10, output: 1, models: { [locator]: { input: 10, output: 1 } } } })],
      reviews: [{ phase: 'review', round: 1, accepted: 1, rejected: 0, reraised: [locator, 'R1-F001'], escalation: { kind: 'deadlock', ids: [locator] } }],
      observations: [observation({ id: locator })],
    })]);
    assert.ok(!text.includes(locator), `${locator} withheld:\n${text}`);
    assert.match(text, /- Host retro: 0 accepted · 1 rejected/, 'observation id');
    assert.match(text, /code review: 1 round; 1 finding re-raised across rounds \(R1-F001\); deadlock escalation\./, 'review ids');
    assert.ok(text.includes('— (reported: gpt-6-sol)'), 'model and reported-model keys');
    assert.ok(text.includes('| codex | — (configured) | 10 | — | — | 1 | — |'), 'usage.models keys drop the per-model split');
    assert.ok(text.includes('"model": "—"'), 'config strings');
  }
  const names = ['gemini-3.8-flash', 'gpt-6.1-sol', 'opencode-go/muse-spark-1.3-contributor', 'claude-opus-5-5'];
  const text = render([facts({
    config: { 'read-delegates': { codex: { targets: names.map((model) => ({ low: { model } })) } } },
    invocations: names.map((model) => invocation({ model, reportedModels: [model], usage: { input: 10, output: 1, models: { [model]: { input: 10, output: 1 } } } })),
  })]);
  for (const name of names) {
    assert.ok(text.includes(`| ${name} (reported: ${name}) |`), `model ${name}`);
    assert.ok(text.includes(`| codex | ${name} | 10 |`), `usage key ${name}`);
    assert.ok(text.includes(`"model": "${name}"`), `config ${name}`);
  }
});

test('SC3 never renders resume objective or absolute paths', () => {
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
  assert.ok(text.includes('2 host events rejected (RULINGS ×1, — ×1): "state-check"; "state-check".'), text);
  assert.match(text, /- Host retro: 1 accepted · 2 rejected/);
});

test('SC3 reduces rejection reasons to class and allowlisted path', () => {
  const cases: [unknown, string][] = [
    ['event: expected JSON object, got malformed JSON', 'malformed-json'],
    ['event: effect root.handoff.1 is pending; send without --event to resume it', 'effect-pending'],
    ['event.type: expected one of AUTHORED|RULINGS, got "CANARY_TYPE"', 'unknown-type at event.type'],
    ['event.type: RULINGS is not accepted at await author; expected AUTHORED|REVISE', 'wrong-await at event.type'],
    ['event.slots[0].tokens: expected non-negative integer, got "private project objective"', 'invalid-value at event.slots[0].tokens'],
    ['event.CANARY_KEY: unexpected field', 'unexpected-field at event.*'],
    ['event.rulings.canary key: b: expected object, got "canary"', 'invalid-value at event.rulings.*'],
    ['event.answer.R1-F001: expected { ruling: accept|reject|downgrade, quote: <user words>, fix? }', 'invalid-value at event.answer.*'],
    ['event.answer: canary-id was not offered', 'state-check at event.answer'],
    ['Approval requires user attribution, quote, and the current governed hash.', 'state-check'],
    ['eventual canary: expected nothing', 'invalid-value'],
    [undefined, 'state-check'],
  ];
  for (const [raw, reduced] of cases) {
    assert.equal(rejectionReason(raw), reduced, String(raw));
    assert.equal(rejectionReason(reduced), reduced, `idempotent: ${reduced}`);
  }
  assert.equal(rejectionReason('invalid-value at event.canary.path'), 'invalid-value at event.*', 'a reduced path is gated again');
  assert.equal(rejectionReason('canary-class at event.path'), 'state-check', 'an unknown class never renders');
  for (const [raw] of cases) assert.ok(!/canary|private/i.test(rejectionReason(raw)), String(raw));
});
