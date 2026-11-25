import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatCost,
  resolvePricing,
  sumCost,
  type Cost,
  type Pricer,
} from '../../../../skills/dispatch/scripts/lib/pricing.ts';
import { readHostUsage } from '../../../../skills/dispatch/scripts/lib/usage/index.ts';
import {
  REVIEW_TAGS_BY_KIND,
  collectFindings,
  matchFinding,
  parseReport,
} from '../../../../skills/dispatch/scripts/toolkit/domain/report.ts';
import { IMPACTS, TRIGGERS, severityOf } from '../../../../skills/dispatch/scripts/toolkit/domain/severity.ts';

const finding = (overrides: Record<string, string> = {}) => ({
  impact: 'blocks',
  trigger: 'realistic',
  locus: 'src/fetch.ts:L12',
  tag: 'correctness',
  defect: 'retry loop never terminates on persistent failure',
  requiredChange: 'bound the retry loop with a counter',
  ...overrides,
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
  return result.findings.map((item) => item.locus);
};

// SECTION: Unknown tag recovery

const planFinding = (tag: string, heading: string, defect: string) => ({
  impact: 'degrades',
  trigger: 'realistic',
  locus: `§ ${heading}`,
  tag,
  defect,
  requiredChange: `revise ${heading} to address the gap`,
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
  CATEGORIES,
  COMPONENTS,
  DIAGNOSTIC_LIMITS,
  formatDuration,
  heuristics,
  normalizeUsage,
  renderDiagnostics,
  retroObservations,
  sanitizeFacts,
  type Finding,
  type InvocationFacts,
  type RunFacts,
  type Usage,
} from '../../../../skills/dispatch/scripts/toolkit/domain/diagnostics.ts';
import { TOOL_ACTIONS } from '../../../../skills/dispatch/scripts/toolkit/cli.ts';

const SKILL_ROOT = fileURLToPath(new URL('../../../../skills/dispatch/', import.meta.url));

const invocation = (overrides: Partial<InvocationFacts> = {}): InvocationFacts => ({
  phase: 'review',
  provider: 'codex',
  model: 'gpt-6-sol',
  effort: 'medium',
  mode: 'cli',
  surface: 'cli',
  launched: true,
  durationMs: 60_000,
  outcome: 'ok',
  usage: { input: 1000, cacheRead: 2000, cacheWrite: 300, output: 40 },
  ...overrides,
});
const bare = (overrides: Partial<InvocationFacts> = {}): InvocationFacts => {
  const { usage: _usage, ...rest } = invocation(overrides);
  return rest;
};
const facts = (overrides: Partial<RunFacts> = {}): RunFacts => ({
  version: '0.7.1',
  build: 'ab'.repeat(32),
  os: 'windows',
  host: 'claude',
  verb: 'review',
  level: 'medium',
  outcome: 'complete',
  phases: [
    {
      key: 'review',
      name: 'code review',
      outcome: 'complete',
      wallMs: 3_723_000,
      driverMs: 45_000,
      hostMs: 60_000,
      userMs: 400,
    },
  ],
  invocations: [invocation()],
  reviews: [],
  ...overrides,
});
const observation = (overrides: Record<string, unknown> = {}) => ({
  id: 'o1',
  component: 'scripts/toolkit/records.ts',
  category: 'instruction-clarity',
  evidence: 'The `rule` frame reply template omits the allowed verdict values.',
  impact: 'Hosts send invalid rulings and need a second turn.',
  proposedFix: 'List the verdict values in the reply template and check them in validate.',
  ...overrides,
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

const rejections = (tool: string, action: string, cls: string, count = 2) =>
  Array.from({ length: count }, () => ({ tool, action, cls }));
const h8 = (rejectedTools: NonNullable<RunFacts['rejectedTools']>) => only(heuristics(facts({ rejectedTools })), 'H8');

const stageRows = (text: string) =>
  text
    .split('### Tokens by stage')[1]!
    .split('### Review yield')[0]!
    .split('\n')
    .filter((line) => line.startsWith('|'));

// SECTION: Scope gate and redaction

const LEAKS = [
  'see /home/alice/repo/src/app.ts',
  'at ~/work/app',
  'path C:\\Users\\alice\\repo',
  'path d:/work/repo',
  'share \\\\server\\team\\x',
  'docs at https://intranet.example/x',
  'host www.example.org',
  'host build.example.com',
  'mail alice@example.com',
  'session 123e4567-e89b-12d3-a456-426614174000',
  `hash ${'a1'.repeat(20)}`,
];
const CLEAN =
  'The `/dispatch review` frame in scripts/toolkit/records.ts mixes input/output fields in config.local.jsonc.';

// SECTION: Finding origin

const originReply = (...origins: (string | undefined)[]) =>
  report(
    origins.map((origin, index) =>
      finding({
        defect: 'defect number ' + index + ' with distinct wording ' + 'x'.repeat(index) + ' unique' + index,
        locus: 'src/file' + index + '.ts:L1',
        ...(origin === undefined ? {} : { origin }),
      }),
    ),
  );
const draftsOf = (text: string) => {
  const result = parseReport({ kind: 'code', source: 'codex[0]', text });
  assert.ok(result.ok, JSON.stringify(result));
  return result.findings;
};

// SECTION: Estimated cost rendering

const PRICES = {
  asOf: '2026-11-14',
  source: ['https://example.test/pricing'],
  models: {
    alpha: { rates: { input: 10, output: 20, cacheRead: 1 } },
    beta: { rates: { input: 2, output: 4 } },
    zero: { rates: { input: 0, output: 0 } },
    tiered: {
      rates: { input: 1, output: 2 },
      tiers: [{ abovePromptTokens: 100_000, rates: { input: 5, output: 10 } }],
    },
    ttl: { rates: { input: 1, output: 1, cacheWrite5m: 1.25, cacheWrite1h: 2 } },
  },
};
const pricer = resolvePricing(PRICES, undefined)!;
const costRender = (runs: RunFacts[], priced: Pricer | null = pricer) =>
  renderDiagnostics(runs, priced ?? undefined).text;
const tableLines = (text: string, heading: string) =>
  text
    .split(heading)[1]!
    .split(/\n###|\n<\/details>/)[0]!
    .split('\n')
    .filter((line) => line.startsWith('|'));
const overviewRows = (text: string) => tableLines(text, '### Phases').slice(2);
const lastCells = (line: string, n: number) => line.replace(/ \|$/, '').split(' | ').slice(-n);
const phaseCost = (text: string, phase: string) =>
  lastCells(
    overviewRows(text).find((line) => line.includes(`| ${phase} |`) || line.includes(`| ${phase} · `))!,
    1,
  );
const M = 1_000_000;
const mega = (model: string, effort: string, input: number, overrides: Partial<InvocationFacts> = {}) =>
  invocation({ provider: 'codex', model, effort, usage: { input, output: 0 }, ...overrides });

// SECTION: Cost folding under the byte cap

const CAP = DIAGNOSTIC_LIMITS.reportBytes;
const FOLD_PRICES = {
  asOf: '2026-11-14',
  source: ['https://example.test/pricing'],
  models: {
    flat: { rates: { input: 4, output: 4 } },
    wide: { rates: { input: 1, output: 1 }, tiers: [{ abovePromptTokens: 100_000, rates: { input: 4, output: 4 } }] },
    free: { rates: { input: 0, output: 0 } },
  },
};
const foldPricer = resolvePricing(FOLD_PRICES, undefined)!;
const tableCells = (text: string, heading: string) =>
  tableLines(text, heading)
    .slice(2)
    .map((line) => line.slice(2, -2).split(' | '));
const overviewCells = (text: string) =>
  tableLines(text, '### Phases')
    .slice(2)
    .map((line) => line.slice(2, -2).split(' | '));
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const summaryCost = (text: string) => /^- Estimated cost ([^\s·]+)/m.exec(text)?.[1];

// Generated rows cycle through exact, range, unpriced and zero-rate costs; quarter-million token counts keep every cost exact in binary.
type Source = { key: string; tokens: number; cost: Cost };
const exactCost = (usd: number): Cost => ({ low: usd, high: usd, priced: true, reasons: new Set() });
function sourceRow(index: number): { model: string; tokens: number; cost: Cost } {
  const m = (index % 7) + 1,
    quarter = 250_000 * m;
  switch (index % 4) {
    case 0:
      return { model: 'flat', tokens: quarter, cost: exactCost(m) };
    case 1:
      return {
        model: 'wide',
        tokens: quarter,
        cost: { low: m / 4, high: m, priced: true, reasons: new Set(['tier unknown']) },
      };
    case 2:
      return {
        model: 'mystery',
        tokens: 1000 * ((index % 11) + 1),
        cost: { low: 0, high: 0, priced: false, reasons: new Set(['unpriced model']) },
      };
    default:
      return { model: 'free', tokens: 1000 * ((index % 13) + 1), cost: exactCost(0) };
  }
}
const rankOrder = (rows: readonly Source[]) =>
  [...rows].sort(
    (a, b) => b.cost.high - a.cost.high || b.cost.low - a.cost.low || b.tokens - a.tokens || byKey(a.key, b.key),
  );
const totalOf = (rows: readonly Source[]) => formatCost(sumCost(rows.map((r) => r.cost)));
const reasonsOf = (rows: readonly Source[]) => [...new Set(rows.flatMap((r) => [...r.cost.reasons]))].sort();

/** Asserts the kept rows are the best-ranked ones and the folded row sums, dimension-marks and unions the rest; returns the folded oracle rows. */
function assertFolded(
  kept: readonly string[][],
  folded: readonly string[],
  keyOf: (cells: string[]) => string,
  all: readonly Source[],
  tokensColumn: number,
  costColumn: number,
): Source[] {
  const keptKeys = kept.map(keyOf);
  assert.equal(new Set(keptKeys).size, kept.length, 'kept rows are distinct');
  assert.deepEqual(
    [...keptKeys].sort(),
    rankOrder(all)
      .slice(0, kept.length)
      .map((r) => r.key)
      .sort(),
    'kept rows follow the rank',
  );
  const rest = all.filter((r) => !keptKeys.includes(r.key));
  assert.equal(folded[0], `${rest.length} smaller rows`);
  assert.equal(folded[tokensColumn], rest.reduce((n, r) => n + r.tokens, 0).toLocaleString('en-US'));
  assert.equal(folded[costColumn], totalOf(rest));
  return rest;
}

test('cost cells price units, sum phases and attribute coverage across tables', () => {
  // cost cells show estimated cost in the Summary, Phases, Tokens by platform and Tokens by stage
  {
    const run = facts({ invocations: [mega('alpha', 'high', M)] });
    const text = costRender([run]);
    assert.match(text, /^- Estimated cost ~\$10\.00 \(partial\) · priced 1 · unpriced 0/m);
    assert.deepEqual(phaseCost(text, 'code review'), ['~$10.00']);
    assert.ok(
      tableLines(text, '### Tokens by platform').some((line) => line.endsWith('| delegates 1/1 | — | ~$10.00 |')),
      text,
    );
    assert.ok(
      tableLines(text, '### Tokens by stage').some((line) =>
        line.endsWith('| alpha (configured) | high | 1,000,000 | — | — | 0 | — | 1/1 | — | ~$10.00 |'),
      ),
      text,
    );
    assert.match(text, /\| Phase \| .* \| Coverage \| Cost \|$/m);
    assert.match(text, /\| Stage \| Platform \| Role \| Model \| Effort \| .* \| Coverage \| Cost notes \| Cost \|$/m);
    assert.match(text, /^\| Platform \| .* \| Coverage \| Cost notes \| Cost \|$/m);

    const plain = costRender([run], null);
    assert.match(plain, /^- Estimated cost not estimated \(rate table unavailable\)/m);
    assert.deepEqual(phaseCost(plain, 'code review'), ['—']);
    assert.ok(
      tableLines(plain, '### Tokens by platform').some((line) => line.endsWith('| delegates 1/1 | — | — |')),
      plain,
    );
    assert.ok(
      tableLines(plain, '### Tokens by stage').some((line) => line.endsWith('| 1/1 | — | — |')),
      plain,
    );
    const roleLine = (t: string) => /^\| CLI delegates \|.*$/m.exec(t)?.[0];
    assert.ok(roleLine(text) && roleLine(plain));
  }

  // cost cells keep unpriced units out of the sum
  {
    const cost = (invocations: InvocationFacts[]) => phaseCost(costRender([facts({ invocations })]), 'code review')[0];
    assert.equal(cost([mega('beta', 'low', M), mega('mystery', 'low', M)]), '~$2.00');
    assert.equal(cost([mega('mystery', 'low', M)]), '—');
    const text = costRender([
      facts({ invocations: [mega('beta', 'low', M), mega('mystery', 'low', M), bare({ provider: 'codex' })] }),
    ]);
    assert.match(text, /priced 1 · unpriced 2/m);
  }

  // phase cost sums CLI delegates and host rows by phase, with the rest in unattributed phase and a run total
  {
    const host = (phase: string | undefined, role: 'host' | 'subagent', model: string, input: number) => ({
      stage: 'plan' as const,
      ...(phase ? { phase } : {}),
      role,
      model,
      effort: null,
      input,
      output: 0,
    });
    const run = facts({
      phases: [
        { key: 'p1', name: 'plan', outcome: 'complete' },
        { key: 'p2', name: 'implementation', outcome: 'complete' },
      ],
      hostUsage: {
        platform: 'claude',
        rows: [
          host('p1', 'host', 'alpha', M),
          host('p2', 'subagent', 'beta', M),
          host(undefined, 'host', 'alpha', M / 2),
          host('ghost', 'host', 'beta', M / 2),
        ],
      },
      invocations: [mega('alpha', 'low', M / 10, { phase: 'p2' }), mega('beta', 'low', M, { phase: 'orphan' })],
    });
    const text = costRender([run]);
    const rows = overviewRows(text);
    const costOf = (phase: string) =>
      lastCells(
        rows.find((line) => line.includes(`| ${phase} |`))!,
        1,
      )[0];
    assert.equal(costOf('plan · p1'), '~$10.00');
    assert.equal(costOf('implementation · p2'), '~$3.00');
    assert.equal(costOf('unattributed phase'), '~$8.00');
    assert.equal(costOf('all phases'), '~$21.00');
    assert.match(text, /^- Estimated cost ~\$21\.00 \(partial\) · priced 6 · unpriced 0/m);
    assert.ok(
      rows.find((line) => line.includes('| unattributed phase |'))!.includes('| — | 1 | 1,000,000 |'),
      'only the orphan CLI invocation fills the token columns',
    );
    const none = costRender([
      facts({ hostUsage: { platform: 'claude', rows: [host('review', 'host', 'alpha', M)] }, invocations: [] }),
    ]);
    assert.ok(!none.includes('unattributed phase'), 'a phased host row leaves no unattributed phase row');
  }

  // phase cost adds reasoning at the output rate only when the platform reports it apart from output
  {
    const usage = { input: 0, output: M, reasoning: M };
    const run = (provider: string, extra: Partial<Usage> = {}) =>
      facts({ invocations: [mega('alpha', 'low', 0, { provider, usage: { ...usage, ...extra } })] });
    const cost = (provider: string, extra?: Partial<Usage>) =>
      phaseCost(costRender([run(provider, extra)]), 'code review')[0];
    assert.equal(cost('opencode'), '~$40.00');
    assert.equal(cost('agy'), '~$40.00');
    assert.equal(cost('claude'), '~$20.00');
    assert.equal(cost('codex'), '~$20.00');
    assert.equal(cost('opencode', { reasoningInOutput: true }), '~$20.00');
    assert.equal(cost('claude', { reasoningInOutput: false }), '~$40.00');
    const host = (reasoningInOutput?: boolean) =>
      facts({
        invocations: [],
        hostUsage: {
          platform: 'opencode',
          rows: [
            {
              stage: 'code review',
              role: 'host',
              model: 'alpha',
              effort: null,
              input: 0,
              output: M,
              reasoning: M,
              ...(reasoningInOutput === undefined ? {} : { reasoningInOutput }),
            },
          ],
        },
      });
    assert.match(costRender([host()]), /^- Estimated cost ~\$40\.00 /m);
    assert.match(costRender([host(true)]), /^- Estimated cost ~\$20\.00 /m);
  }

  // cost drivers share bars rank keys by cost midpoint share, with exact strings for each edge
  {
    const sharesOf = (invocations: InvocationFacts[]) => {
      const text = costRender([facts({ invocations })]);
      return tableLines(text, '## Cost drivers')
        .slice(2)
        .map((l) => {
          const c = l.slice(2, -2).split(' | ');
          return `${c[3]?.replace(' (configured)', '')}${c[4] === '—' ? '' : '/' + c[4]} ${c[6]!.split(' ').at(-1)}`;
        });
    };
    // range-priced key: tiered spans $1-$5 (midpoint 3) against alpha $10
    assert.deepEqual(sharesOf([mega('alpha', 'low', M), mega('tiered', 'high', M)]), [
      'alpha/low 77%',
      'tiered/high 23%',
    ]);
    // an unpriced key takes no share and renders —
    assert.deepEqual(sharesOf([mega('alpha', 'low', M), mega('tiered', 'high', M), mega('mystery', 'low', 5)]), [
      'alpha/low 77%',
      'tiered/high 23%',
      'mystery/low —',
    ]);
    // shares total 100% by largest remainder
    assert.deepEqual(sharesOf([mega('alpha', 'low', 0.605 * M), mega('alpha', 'high', 0.395 * M)]), [
      'alpha/low 61%',
      'alpha/high 39%',
    ]);
    // no priced key: token shares
    assert.deepEqual(sharesOf([mega('mystery', 'medium', 30), mega('lost', 'medium', 10)]), [
      'mystery/medium 75%',
      'lost/medium 25%',
    ]);
    // zero priced total: shares unavailable
    assert.deepEqual(sharesOf([mega('zero', 'high', 300), mega('zero', 'low', 100)]), ['zero/high —', 'zero/low —']);
  }

  // cost coverage names each reason in Tokens by platform and in host and subagent stage rows
  {
    const platform = (text: string, name: string) =>
      tableLines(text, '### Tokens by platform').find((line) => line.startsWith(`| ${name} |`))!;
    const covAndNotes = (line: string) => lastCells(line, 3).slice(0, 2);
    const run = facts({
      invocations: [
        mega('mystery', 'low', 10, { provider: 'unpriced' }),
        mega('tiered', 'low', 150_000, { provider: 'tier' }),
        invocation({ provider: 'ttl', model: 'ttl', usage: { input: 0, output: 0, cacheWrite: 1000 } }),
        bare({ provider: 'copilot', coverage: ['no usage'] }),
        mega('beta', 'low', 10, { provider: 'transcript', coverage: ['transcript unavailable'] }),
      ],
    });
    const text = costRender([run]);
    assert.deepEqual(covAndNotes(platform(text, 'unpriced')), ['delegates 1/1', 'unpriced model']);
    assert.deepEqual(covAndNotes(platform(text, 'tier')), ['delegates 1/1', 'tier unknown']);
    assert.deepEqual(covAndNotes(platform(text, 'ttl')), ['delegates 1/1', 'cache TTL unknown']);
    assert.deepEqual(covAndNotes(platform(text, 'copilot')), ['delegates 0/1 no usage', 'no usage']);
    assert.deepEqual(covAndNotes(platform(text, 'transcript')), ['delegates 1/1 transcript unavailable', '—']);
    assert.match(text, /priced 3 · unpriced 2/m);

    const hosted = costRender([
      facts({
        invocations: [],
        hostUsage: {
          platform: 'claude',
          rows: [
            { stage: 'plan', role: 'host', model: 'tiered', effort: null, input: 150_000, output: 0 },
            { stage: 'plan', role: 'subagent', model: 'mystery', effort: null, input: 5, output: 0 },
            { stage: 'plan', role: 'subagent', model: 'beta', effort: null, input: 5, output: 0 },
          ],
        },
      }),
    ]);
    const stages = tableLines(hosted, '### Tokens by stage');
    assert.ok(
      stages.some(
        (line) =>
          line.startsWith('| plan | claude | host | tiered |') && line.endsWith('| — | tier unknown | ~$0.15–$0.75 |'),
      ),
      hosted,
    );
    assert.ok(
      stages.some(
        (line) =>
          line.startsWith('| plan | claude | subagent | mystery |') && line.endsWith('| — | unpriced model | — |'),
      ),
      hosted,
    );
    assert.ok(
      stages.some(
        (line) => line.startsWith('| plan | claude | subagent | beta |') && line.endsWith('| — | — | ~$<0.01 |'),
      ),
      hosted,
    );
  }
});
test('cost folding folds the lowest-ranked Tokens by stage rows into one trailing row', () => {
  const rows = Array.from({ length: 3000 }, (_, index) => ({
    ...sourceRow(index),
    effort: `e${String(index).padStart(4, '0')}`,
  }));
  const all: Source[] = rows.map((r) => ({ key: `${r.model}/${r.effort}`, tokens: r.tokens, cost: r.cost }));
  const hostRows = rows.map((r) => ({
    stage: 'plan' as const,
    phase: 'p',
    role: 'host' as const,
    model: r.model,
    effort: r.effort,
    input: r.tokens,
    output: 0,
  }));
  const run = facts({
    phases: [{ key: 'p', name: 'plan', outcome: 'complete' }],
    hostUsage: { platform: 'claude', rows: hostRows },
    invocations: [],
  });
  const text = renderDiagnostics([run], foldPricer).text;

  assert.ok(Buffer.byteLength(text) <= CAP);
  assert.ok(Buffer.byteLength(text) > CAP - 400, 'the largest row count that fits stays');
  const stage = tableCells(text, '### Tokens by stage');
  const folded = stage.at(-1)!,
    kept = stage.slice(0, -1);
  assert.deepEqual(folded.slice(1, 5), ['—', '—', '—', '—'], 'dimension cells other than the count');
  const rest = assertFolded(kept, folded, (cells) => `${cells[3]}/${cells[4]}`, all, 5, 12);
  assert.deepEqual(folded[11]!.split(', ').sort(), reasonsOf(rest), 'Cost notes unions the folded reasons');
  assert.deepEqual(
    kept,
    [...kept].sort((a, b) => a[3]!.localeCompare(b[3]!) || a[4]!.localeCompare(b[4]!)),
    'kept rows keep their normal order',
  );
  assert.ok(
    rest.some((r) => r.cost.priced && r.cost.low < r.cost.high),
    'the fold reaches range-priced rows',
  );
  assert.ok(
    rest.some((r) => !r.cost.priced) && rest.some((r) => r.cost.priced && r.cost.high === 0),
    'the fold holds unpriced and zero-rate rows',
  );

  const expected = totalOf(all);
  assert.equal(summaryCost(text), expected, 'the Summary total predates folding');
  assert.equal(overviewCells(text)[0]!.at(-1), expected);
  assert.equal(tableCells(text, '### Tokens by platform')[0]![8], expected);
  assert.ok(
    !tableCells(text, '### Tokens by platform')
      .flat()
      .some((cell) => /smaller rows/.test(cell)),
    'later tables stay whole',
  );
});

test('cost folding folds Phases rows for many review subjects and keeps the run total', () => {
  const rows = Array.from({ length: 1200 }, (_, index) => ({
    ...sourceRow(index),
    key: `review-${index.toString(16).padStart(16, '0')}`,
    wallMs: 1000 * (index + 1),
  }));
  const all: Source[] = rows.map(({ key, tokens, cost }) => ({ key, tokens, cost }));
  const run = facts({
    phases: rows.map((r) => ({ key: r.key, name: 'code review', outcome: 'complete', wallMs: r.wallMs })),
    invocations: rows.map((r) => mega(r.model, 'low', r.tokens, { phase: r.key })),
  });
  const text = renderDiagnostics([run], foldPricer).text;

  assert.ok(Buffer.byteLength(text) <= CAP);
  assert.match(text, /Omitted at the report size limit\./);
  const overview = overviewCells(text),
    subject = 'code review · subject ';
  const everything = overview.find((cells) => cells[0] === 'all phases')!,
    folded = overview.at(-1)!;
  const kept = overview.filter((cells) => cells[0]!.startsWith(subject));
  assert.equal(folded[1], '—', 'dimension cells other than the count');
  const rest = assertFolded(kept, folded, (cells) => `review-${cells[0]!.slice(subject.length)}`, all, 4, 9);
  assert.equal(
    folded[2],
    formatDuration(rows.filter((r) => rest.some((x) => x.key === r.key)).reduce((n, r) => n + r.wallMs, 0)),
  );
  assert.equal(folded[3], String(rest.length), 'Invocations sum');
  assert.equal(overview.filter((cells) => /smaller rows$/.test(cells[0]!)).length, 1);

  const expected = totalOf(all);
  assert.equal(everything[9], expected, 'the all phases row never folds and holds the run total');
  assert.equal(summaryCost(text), expected);
  assert.equal(tableCells(text, '### Tokens by platform')[0]![8], expected);
});

test('cost folding folds Tokens by platform rows last, after earlier tables fold to one row each', () => {
  const rows = Array.from({ length: 3000 }, (_, index) => ({
    ...sourceRow(index),
    platform: `p${String(index).padStart(4, '0')}`,
  }));
  const all: Source[] = rows.map((r) => ({ key: r.platform, tokens: r.tokens, cost: r.cost }));
  const text = renderDiagnostics(
    [facts({ invocations: rows.map((r) => mega(r.model, 'low', r.tokens, { provider: r.platform })) })],
    foldPricer,
  ).text;

  assert.ok(Buffer.byteLength(text) <= CAP);
  const platform = tableCells(text, '### Tokens by platform');
  const folded = platform.at(-1)!,
    kept = platform.slice(0, -1);
  const rest = assertFolded(kept, folded, (cells) => cells[0]!, all, 1, 8);
  assert.equal(folded[6], 'delegates 1/1', 'Coverage unions the folded segments');
  assert.deepEqual(folded[7]!.split(', ').sort(), reasonsOf(rest), 'Cost notes unions the folded reasons');
  assert.deepEqual(
    kept.map((cells) => cells[0]),
    kept.map((cells) => cells[0]!).sort(),
    'kept rows keep their normal order',
  );

  const expected = totalOf(all);
  assert.equal(summaryCost(text), expected);
  const stage = tableCells(text, '### Tokens by stage'),
    overview = overviewCells(text);
  assert.deepEqual([stage.length, stage[0]![0], stage[0]![12]], [1, '3000 smaller rows', expected]);
  assert.deepEqual([overview.length, overview[0]![0], overview[0]!.at(-1)], [1, '1 smaller rows', expected]);

  // Boundary: a small table never folds.
  const small = renderDiagnostics([facts({ invocations: [mega('flat', 'low', 1000)] })], foldPricer).text;
  assert.ok(
    !tableCells(small, '### Tokens by platform')
      .flat()
      .some((cell) => /smaller rows/.test(cell)),
    'small tables stay whole',
  );
});
test('cost end to end: mixed-platform facts price in all four locations and survive an oversized report', () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(SKILL_ROOT, 'references/pricing.json'), 'utf8'));
  const endPricer = resolvePricing(shipped, { 'lmstudio/*': { rates: { input: 0, output: 0 } } })!;
  const lmstudio = 'lmstudio/qwen3.8-27b-ridge';
  const phase = (key: string, name: string) => ({ key, name, outcome: 'complete' });
  const run = (extra: InvocationFacts[] = []) =>
    facts({
      phases: [phase('plan', 'plan'), phase('review', 'code review')],
      hostUsage: {
        platform: 'claude',
        rows: [
          // two haiku requests of 90,000 and 110,000 prompt tokens, one on each side of the tier threshold
          {
            stage: 'plan',
            phase: 'plan',
            role: 'host',
            model: 'claude-haiku-5-5',
            effort: 'low',
            input: 200_000,
            output: 0,
            bands: { le100k: { input: 90_000, output: 0 }, le200k: { input: 110_000, output: 0 } },
          },
          {
            stage: 'plan',
            phase: 'plan',
            role: 'subagent',
            model: 'claude-sonnet-5-5',
            effort: null,
            input: 1_000_000,
            output: 100_000,
          },
        ],
      },
      invocations: [
        // the grandchild subagent counts under the Codex delegate invocation as its own model key; bands keep both below the 272K tier
        mega('gpt-6.1-terra', 'high', 0, {
          phase: 'review',
          usage: {
            input: 3_000_000,
            output: 100_000,
            models: {
              'gpt-6.1-terra#high': {
                input: 1_000_000,
                output: 100_000,
                bands: { le100k: { input: 1_000_000, output: 100_000 } },
              },
              'gpt-6-luna#low': { input: 2_000_000, output: 0, bands: { le100k: { input: 2_000_000, output: 0 } } },
            },
          },
        }),
        // OpenCode reports reasoning apart from output, so it adds at the output rate
        mega('gemini-4-hydrogen', 'low', 0, {
          provider: 'opencode',
          phase: 'review',
          usage: { input: 0, output: 100_000, reasoning: 100_000 },
        }),
        mega(lmstudio, 'low', 1_000_000, {
          provider: 'opencode',
          phase: 'review',
          usageSource: 'session',
          reportedModels: [lmstudio],
        }),
        ...extra,
      ],
    });
  const assertCosts = (text: string) => {
    assert.equal(summaryCost(text), '~$6.26');
    assert.deepEqual(
      overviewCells(text).map((cells) => [cells[0], cells[8]]),
      [
        ['plan', '~$3.06'],
        ['code review · review', '~$3.20'],
        ['all phases', '~$6.26'],
      ],
    );
    assert.deepEqual(
      tableCells(text, '### Tokens by platform').map((cells) => [cells[0], cells[8]]),
      [
        ['claude', '~$3.06'],
        ['codex', '~$1.70'],
        ['opencode', '~$1.50'],
      ],
    );
    const stages = tableLines(text, '### Tokens by stage');
    const cost = (prefix: string, expected: string) =>
      assert.ok(
        stages.some((line) => line.startsWith(prefix) && line.endsWith(` | ${expected} |`)),
        `${prefix} ${expected}\n${stages.join('\n')}`,
      );
    cost('| plan | claude | host | claude-haiku-5-5 | low |', '~$0.06');
    cost('| plan | claude | subagent | claude-sonnet-5-5 |', '~$3.00');
    cost('| code review | codex | delegate | gpt-6.1-terra | high |', '~$1.50');
    cost('| code review | codex | delegate | gpt-6-luna | low |', '~$0.20');
    cost('| code review | opencode | delegate | gemini-4-hydrogen (configured) |', '~$1.50');
    cost(`| code review | opencode | delegate | ${lmstudio} |`, '~$0');
  };

  const text = renderDiagnostics([run()], endPricer).text;
  assert.ok(!text.includes('Omitted at the report size limit'));
  assertCosts(text);

  const filler = Array.from({ length: 1500 }, () =>
    mega(lmstudio, 'low', 1000, {
      provider: 'opencode',
      phase: 'review',
      usageSource: 'session',
      reportedModels: [lmstudio],
    }),
  );
  const large = renderDiagnostics([run(filler)], endPricer).text;
  assert.ok(Buffer.byteLength(large) <= CAP);
  assert.match(large, /Omitted at the report size limit\./);
  assert.ok(!large.includes('smaller rows'));
  assert.match(large, /^\| Host \|[^|]+\| ~\$0\.06 \| 200,000 \|/m);
  assert.match(large, /^\| Subagents \|[^|]+\| ~\$3\.00 \| 1,100,000 \|/m);
  assert.match(large, /^\| CLI delegates \|[^|]+\| ~\$3\.20 \| 5,800,000 \|/m);
  assertCosts(large);
});

test('usage-less launched unit shows no usage instead of unpriced model', () => {
  const text = costRender([facts({ invocations: [bare({ provider: 'codex', model: 'alpha' })] })]);
  const stage = tableLines(text, '### Tokens by stage').find((line) => line.includes('| codex | delegate | alpha'))!;
  assert.ok(stage.endsWith('| 0/1 | no usage | — |'), stage);
  assert.ok(!stage.includes('unpriced model'), stage);
  const plat = tableLines(text, '### Tokens by platform').find((line) => line.startsWith('| codex |'))!;
  assert.ok(plat.includes('| delegates 0/1 | no usage | — |') && !plat.includes('unpriced model'), plat);
});

test('apart reasoning counts once in every token total and token share', () => {
  const run = facts({
    invocations: [
      mega('mystery', 'low', 100, { provider: 'opencode', usage: { input: 100, output: 20, reasoning: 30 } }),
      mega('lost', 'low', 100, { provider: 'claude', usage: { input: 100, output: 20, reasoning: 30 } }),
    ],
  });
  const text = costRender([run]);
  // opencode adds reasoning (150), claude does not (120) -> total 270
  assert.match(text, /^\| CLI delegates \|[^|]+\| — \| 270 \|/m);
  // token shares: 150/270 = 56%, 120/270 = 44%
  assert.match(text, /mystery \(configured\).*56% \| 150/);
  assert.match(text, /lost \(configured\).*44% \| 120/);
  // appendix Reasoning and Total columns: opencode 30/150, claude 30 (in output)/120
  assert.ok(text.includes('| 30 | 150 | ok |'), text);
  assert.ok(text.includes('| 30 (in output) | 120 | ok |'), text);
});

test('run start date selects rate period and falls back to base rates when absent', () => {
  const datedPricer = resolvePricing(
    {
      asOf: '2026-11-16',
      source: ['https://example.test/pricing'],
      models: {
        alpha: {
          rates: { input: 1, output: 2 },
          periods: [{ from: '2026-12-01', rates: { input: 4, output: 8 } }],
        },
      },
    },
    undefined,
  )!;
  const run = (startedAt?: string) =>
    facts({ ...(startedAt ? { startedAt } : {}), invocations: [mega('alpha', 'low', M)] });
  assert.equal(summaryCost(costRender([run('2026-11-30')], datedPricer)), '~$1.00');
  assert.equal(summaryCost(costRender([run('2026-12-01')], datedPricer)), '~$4.00');
  assert.equal(summaryCost(costRender([run()], datedPricer)), '~$1.00');
});

test('multi-host Summary lists every host and names the covered host thread', () => {
  const known = costRender([
    facts({
      hosts: ['claude', 'agy'],
      hostUsage: {
        platform: 'agy',
        rows: [{ stage: 'code review', role: 'host', model: 'zero', effort: null, input: 0, output: 0 }],
      },
      invocations: [],
    }),
  ]);
  assert.match(
    known,
    /^- Host: claude, agy · host rows measure the agy thread; other hosts' threads are unmeasured · OS: windows$/m,
  );

  const nullHost = costRender([
    facts({ hosts: ['claude', 'agy'], hostUsage: { platform: null, rows: [] }, invocations: [] }),
  ]);
  assert.match(nullHost, /^- Host: claude, agy · no host thread is measured · OS: windows$/m);

  const noHostUsage = costRender([facts({ hosts: ['claude', 'agy'], invocations: [] })]);
  assert.match(noHostUsage, /^- Host: claude, agy · no host thread is measured · OS: windows$/m);
});

test('Cost drivers ranks up to five groups with remainder summing to 100% and cache-hit ratio', () => {
  const drivers = (text: string) => text.split('## Cost drivers')[1]!.split('\n## ')[0]!;
  const rows = (text: string) =>
    drivers(text)
      .split('\n')
      .filter((l) => l.startsWith('|'))
      .slice(2)
      .map((l) => l.slice(2, -2).split(' | '));
  const shareNum = (cell: string) => Number(cell.split(' ').at(-1)!.replace('%', ''));

  // 7 priced groups -> top 5 + remainder, shares total 100%, cache-hit = 50%
  const pricedRun = facts({
    invocations: [
      mega('alpha', 'high', 500_000, { provider: 'claude', usage: { input: 500_000, cacheRead: 500_000, output: 0 } }),
      mega('alpha', 'low', 400_000, { provider: 'claude' }),
      mega('alpha', 'medium', 300_000, { provider: 'claude' }),
      mega('beta', 'high', 500_000, { provider: 'codex' }),
      mega('beta', 'low', 400_000, { provider: 'codex' }),
      mega('beta', 'medium', 300_000, { provider: 'codex' }),
      mega('beta', 'xhigh', 200_000, { provider: 'codex' }),
    ],
  });
  const pricedRows = rows(costRender([pricedRun]));
  assert.equal(pricedRows.length, 6);
  assert.equal(pricedRows[0]![8], '50%');
  assert.equal(pricedRows[1]![8], '—');
  assert.equal(pricedRows[5]![0], '2 more');
  assert.equal(
    pricedRows.reduce((n, r) => n + shareNum(r[6]!), 0),
    100,
  );

  // Priced + unpriced + remainder: 2 priced, 5 unpriced -> 5 listed (2 priced + 3 unpriced), 2 more (2 unpriced)
  const mixedRun = facts({
    invocations: [
      mega('alpha', 'high', M, { provider: 'claude' }),
      mega('beta', 'low', M, { provider: 'codex' }),
      mega('mystery', 'low', 500, { provider: 'p1' }),
      mega('mystery', 'low', 400, { provider: 'p2' }),
      mega('mystery', 'low', 300, { provider: 'p3' }),
      mega('mystery', 'low', 200, { provider: 'p4' }),
      mega('mystery', 'low', 100, { provider: 'p5' }),
    ],
  });
  const mixedRows = rows(costRender([mixedRun]));
  assert.equal(mixedRows.length, 6);
  assert.deepEqual(
    mixedRows.slice(2, 5).map((r) => r[6]),
    ['—', '—', '—'],
  );
  assert.equal(mixedRows[5]![0], '2 more (2 unpriced)');
  assert.equal(mixedRows[5]![6], '—');
  assert.equal(
    mixedRows.slice(0, 2).reduce((n, r) => n + shareNum(r[6]!), 0),
    100,
  );

  // Zero priced total with billed tokens -> distinguishes no priced unit vs $0 priced cost
  const unpricedText = costRender([
    facts({
      invocations: [
        mega('mystery', 'low', 300, { provider: 'claude' }),
        mega('mystery', 'high', 100, { provider: 'codex' }),
      ],
    }),
  ]);
  const unpricedRows = rows(unpricedText);
  assert.deepEqual(
    unpricedRows.map((r) => r[6]!.split(' ').at(-1)),
    ['75%', '25%'],
  );

  const zeroPricedText = costRender([
    facts({
      invocations: [
        mega('zero', 'low', 100, { provider: 'claude' }),
        mega('mystery', 'low', 500, { provider: 'codex' }),
      ],
    }),
  ]);
  assert.deepEqual(
    rows(zeroPricedText).map((r) => [r[3], r[5], r[6]]),
    [
      ['zero (configured)', '~$0', '—'],
      ['mystery (configured)', '—', '—'],
    ],
  );

  // Only usage-less launched units -> No priced cost or billed tokens, zero cache-hit denominator -> —
  const bareText = costRender([facts({ invocations: [bare({ provider: 'codex' })] })]);
  assert.match(drivers(bareText), /No priced cost or billed tokens\./);
  assert.equal(rows(bareText).length, 0);

  const outputOnlyText = costRender([
    facts({ invocations: [mega('alpha', 'low', 0, { usage: { input: 0, output: 100 } })] }),
  ]);
  assert.equal(rows(outputOnlyText)[0]![8], '—');
});

test('Role cost and usage coverage reconcile', () => {
  const run = facts({
    hosts: ['claude', 'codex'],
    hostUsage: {
      platform: 'claude',
      rows: [{ stage: 'code review', role: 'host', model: 'zero', effort: null, input: 0, output: 0 }],
    },
    invocations: [
      mega('alpha', 'low', M, { usageSource: 'session', reportedModels: ['beta'] }),
      mega('alpha', 'low', 5, {
        usageSource: 'stdout',
        coverage: ['transcript unavailable'],
        reportedModels: ['beta', 'invalid model'],
      }),
      bare({ coverage: ['no usage'] }),
    ],
  });
  const text = costRender([run]);
  assert.match(text, /^\| Host \| ░░░░░░░░░░ 0% \| ~\$0 \| 0 \| .*host threads unmeasured/m);
  assert.match(text, /^\| Subagents \| — \| — \| — \| .*unavailable/m);
  assert.match(
    text,
    /^\| CLI delegates \| ██████████ 100% \| ~\$2\.00 \| 1,000,005 \| .*1 session.*1 stdout fallback.*1 unmeasured/m,
  );
  assert.match(text, /cost-midpoint share/);
  assert.match(text, /1 observed unit unpriced/);
});
