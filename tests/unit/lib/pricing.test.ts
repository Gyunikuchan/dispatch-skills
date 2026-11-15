import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseJsonc } from '../../../skills/dispatch/scripts/lib/config.ts';
import { formatCost, loadPricing, pricingProblems, resolvePricing, sumCost, type Cost, type Pricer } from '../../../skills/dispatch/scripts/lib/pricing.ts';

const SKILL_ROOT = fileURLToPath(new URL('../../../skills/dispatch/', import.meta.url));
const TABLE_FILE = path.join(SKILL_ROOT, 'references', 'pricing.json');
const tableText = fs.readFileSync(TABLE_FILE, 'utf8');
const table = JSON.parse(tableText) as { models: Record<string, unknown> };

// Serves only the shipped table so a maintainer's local config never leaks into a test.
const readShipped = (config?: string) => (file: string): string | null =>
  file.endsWith('pricing.json') ? tableText : /config\.jsonc$/.test(file) && config !== undefined ? config : null;
const shipped = (config?: string): Pricer => {
  const pricer = loadPricing('/skill', readShipped(config));
  assert.ok(pricer, 'shipped table loads');
  return pricer;
};

const near = (actual: number, expected: number, message?: string) =>
  assert.ok(Math.abs(actual - expected) <= 1e-12, `${message ?? ''} ${actual} vs ${expected}`);
const perMillion = (tokens: number, rate: number) => (tokens * rate) / 1_000_000;
const ZERO = { rates: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } };
const custom = (models: Record<string, unknown>): Pricer => {
  const pricer = resolvePricing({ asOf: '2026-01-01', source: ['test'], models }, undefined);
  assert.ok(pricer);
  return pricer;
};
const reasonsOf = (cost: Cost) => [...cost.reasons].sort();

// SECTION: Model id matching

test('model id matching strips provider prefixes and version suffixes and takes the longest boundary match', () => {
  const pricer = shipped();
  const usage = { input: 1000, output: 1000 };
  const opus = pricer.price('claude-opus-5-5', usage);
  assert.equal(opus.priced, true);
  for (const id of ['bedrock.claude-opus-5-5', 'vertex.claude-opus-5-5', 'us.anthropic.claude-opus-5-5-v1:0', 'claude-opus-5-5@20261001', 'claude-opus-5-5[1m]', 'Claude-Opus-5-5', 'claude-opus-5-5-20261001', 'opencode-go/claude-opus-5-5', 'claude-opus-5-5#high']) {
    assert.deepEqual(pricer.price(id, usage), opus, id);
  }
  assert.deepEqual(pricer.price('anthropic.claude-sonnet-5-5-20261001-v2:0', usage), pricer.price('claude-sonnet-5-5', usage));
  assert.equal(pricer.price('gpt-6.1-terra', usage).priced, true);
  assert.notDeepEqual(pricer.price('gpt-6.1-terra', usage), pricer.price('gpt-6.1-sol', usage));
  for (const id of ['opus', 'gpt-6-terra', 'gpt-6.1', 'xclaude-opus-5-5', 'claude-opus-5-5-fast', 'other', 'other#high', '', 'unknown-model']) {
    const cost = pricer.price(id, usage);
    assert.equal(cost.priced, false, id);
    assert.deepEqual(reasonsOf(cost), ['unpriced model'], id);
  }
});

test('model id matching lets a provider wildcard override win and a longer override key beat a shorter one', () => {
  const pricer = resolvePricing({ asOf: '2026-01-01', source: [], models: { 'claude-opus-5-5': { rates: { input: 4, output: 20 } } } }, {
    'lmstudio/*': ZERO,
    'acme.claude-opus-5-5': { rates: { input: 1, output: 1 } },
  });
  assert.ok(pricer);
  const usage = { input: 1_000_000, output: 0 };
  for (const id of ['lmstudio/qwen3.8-27b-ridge', 'lmstudio/claude-opus-5-5', 'LMStudio/Qwen']) {
    assert.deepEqual([pricer.price(id, usage).low, pricer.price(id, usage).priced], [0, true], id);
  }
  assert.equal(pricer.price('other/claude-opus-5-5', usage).low, 4);
  assert.equal(pricer.price('acme.claude-opus-5-5', usage).low, 1);
  assert.equal(pricer.price('bedrock.claude-opus-5-5', usage).low, 4);
  assert.equal(pricer.price('other/qwen', usage).priced, false);
});

// SECTION: Cost pricing

const haiku = 'claude-haiku-5-5';
const TIER_AT_150K = { rates: { input: 1, output: 2 }, tiers: [{ abovePromptTokens: 150_000, rates: { input: 3, output: 6 } }] };
const TIER_AT_200K = { rates: { input: 1, output: 2 }, tiers: [{ abovePromptTokens: 200_000, rates: { input: 3, output: 6 } }] };

test('cost pricing takes the tier of each prompt-size band and ranges a band that an off-edge threshold splits', () => {
  const pricer = shipped();
  const at90k = pricer.price(haiku, { input: 90_000, output: 1000, bands: { le100k: { input: 90_000, output: 1000 } } });
  near(at90k.low, perMillion(90_000, 0.10) + perMillion(1000, 0.50), 'base tier');
  assert.equal(at90k.high, at90k.low);
  assert.equal(at90k.reasons.size, 0);
  const at110k = pricer.price(haiku, { input: 110_000, output: 1000, bands: { le200k: { input: 110_000, output: 1000 } } });
  near(at110k.low, perMillion(110_000, 0.50) + perMillion(1000, 2.50), 'upper tier');
  assert.equal(at110k.high, at110k.low);
  const both = pricer.price(haiku, { input: 200_000, output: 0, bands: { le100k: { input: 90_000, output: 0 }, le200k: { input: 110_000, output: 0 } } });
  near(both.low, at90k.low - perMillion(1000, 0.50) + perMillion(110_000, 0.50));
  // A request of exactly 100,000 prompt tokens is in the lowest band and takes the base tier.
  near(pricer.price(haiku, { input: 100_000, output: 0, bands: { le100k: { input: 100_000, output: 0 } } }).low, perMillion(100_000, 0.10));

  const split = custom({ x: TIER_AT_150K });
  const ranged = split.price('x', { input: 120_000, output: 0, bands: { le200k: { input: 120_000, output: 0 } } });
  near(ranged.low, perMillion(120_000, 1));
  near(ranged.high, perMillion(120_000, 3));
  assert.deepEqual(reasonsOf(ranged), ['tier unknown']);
  const exact = split.price('x', { input: 50_000, output: 0, bands: { le100k: { input: 50_000, output: 0 } } });
  assert.equal(exact.low, exact.high);
  assert.equal(exact.reasons.size, 0);
  const top = split.price('x', { input: 300_000, output: 0, bands: { gt272k: { input: 300_000, output: 0 } } });
  near(top.low, perMillion(300_000, 3));
  assert.equal(top.high, top.low);
});

test('cost pricing ranges an aggregate only when its prompt exceeds the lowest tier threshold', () => {
  const pricer = shipped();
  const small = pricer.price(haiku, { input: 80_000, output: 0 });
  near(small.low, perMillion(80_000, 0.10));
  assert.equal(small.high, small.low);
  assert.equal(small.reasons.size, 0);
  const large = pricer.price(haiku, { input: 250_000, output: 0 });
  near(large.low, perMillion(250_000, 0.10));
  near(large.high, perMillion(250_000, 0.50));
  assert.deepEqual(reasonsOf(large), ['tier unknown']);
  // The prompt counts cache reads and writes.
  assert.deepEqual(reasonsOf(pricer.price(haiku, { input: 10, output: 0, cacheRead: 150_000 })), ['tier unknown']);

  const model = custom({ y: TIER_AT_200K });
  const exact = model.price('y', { input: 150_000, output: 0 });
  assert.equal(exact.low, exact.high);
  const range = model.price('y', { input: 250_000, output: 0 });
  near(range.low, perMillion(250_000, 1));
  near(range.high, perMillion(250_000, 3));
  const middle = custom({ z: { rates: { input: 1, output: 1 }, tiers: [{ abovePromptTokens: 100_000, rates: { input: 2, output: 2 } }, { abovePromptTokens: 200_000, rates: { input: 4, output: 4 } }] } });
  near(middle.price('z', { input: 150_000, output: 0 }).high, perMillion(150_000, 2), 'a prompt below the second threshold never reaches its tier');
});

test('cost pricing splits cache writes by TTL and ranges an unsplit remainder', () => {
  const pricer = shipped();
  const opus = 'claude-opus-5-5#high';
  near(pricer.price(opus, { input: 0, output: 0, cacheWrite: 1000, cacheWrite1h: 1000 }).low, perMillion(1000, 8), '1h rate');
  near(pricer.price(opus, { input: 0, output: 0, cacheWrite: 1000, cacheWrite5m: 1000 }).low, perMillion(1000, 5), '5m rate');
  near(pricer.price(opus, { input: 1000, output: 1000, cacheRead: 1000 }).low, perMillion(1000, 4) + perMillion(1000, 20) + perMillion(1000, 0.20), 'effort never changes the rate');
  const mixed = pricer.price(opus, { input: 0, output: 0, cacheWrite: 3000, cacheWrite5m: 1000, cacheWrite1h: 1000 });
  near(mixed.low, perMillion(2000, 5) + perMillion(1000, 8), 'remainder at the 5m rate');
  near(mixed.high, perMillion(1000, 5) + perMillion(2000, 8), 'remainder at the 1h rate');
  assert.deepEqual(reasonsOf(mixed), ['cache TTL unknown']);
  const unsplit = pricer.price(opus, { input: 0, output: 0, cacheWrite: 1000 });
  near(unsplit.low, perMillion(1000, 5));
  near(unsplit.high, perMillion(1000, 8));
  assert.deepEqual(reasonsOf(unsplit), ['cache TTL unknown']);

  const equal = custom({ eq: { rates: { input: 1, output: 1, cacheWrite5m: 2, cacheWrite1h: 2 } } });
  const exact = equal.price('eq', { input: 0, output: 0, cacheWrite: 1000 });
  assert.equal(exact.low, exact.high);
  assert.equal(exact.reasons.size, 0);
});

test('cost pricing leaves a unit unpriced when a nonzero counter has no rate', () => {
  const only5m = custom({ one: { rates: { input: 1, output: 1, cacheWrite5m: 2 } }, none: { rates: { input: 1, output: 1 } }, read: { rates: { input: 1, output: 1, cacheRead: 1 } } });
  const cases: [string, Cost][] = [
    ['unsplit write with one TTL rate', only5m.price('one', { input: 0, output: 0, cacheWrite: 1000 })],
    ['split 1h write without the 1h rate', only5m.price('one', { input: 0, output: 0, cacheWrite: 1000, cacheWrite1h: 1000 })],
    ['cache read without a rate', only5m.price('none', { input: 0, output: 0, cacheRead: 1000 })],
    ['cache write without a rate', only5m.price('read', { input: 0, output: 0, cacheWrite: 1000 })],
    ['cache write on an OpenAI entry', shipped().price('gpt-6.1-terra', { input: 0, output: 0, cacheWrite: 1000 })],
  ];
  for (const [name, cost] of cases) {
    assert.deepEqual([cost.priced, cost.low, cost.high, reasonsOf(cost)], [false, 0, 0, ['unpriced model']], name);
  }
  assert.equal(only5m.price('one', { input: 0, output: 0, cacheWrite: 0 }).priced, true, 'a zero counter needs no rate');
  assert.equal(only5m.price('none', { input: 5, output: 5, cacheRead: 0 }).priced, true);
});

test('cost pricing adds reasoning at the output rate only when the unit counts it apart from output', () => {
  const pricer = shipped();
  const usage = { input: 0, output: 1000, reasoning: 500 };
  const inside = pricer.price('claude-opus-5-5', usage);
  near(inside.low, perMillion(1000, 20));
  assert.deepEqual(pricer.price('claude-opus-5-5', usage, true), inside);
  assert.deepEqual(pricer.price('claude-opus-5-5', { input: 0, output: 1000 }, false), inside, 'no reasoning counter adds nothing');
  near(pricer.price('claude-opus-5-5', usage, false).low, perMillion(1500, 20));
  const banded = pricer.price(haiku, { ...usage, bands: { le100k: usage } }, false);
  near(banded.low, perMillion(1500, 0.50));
  const bare = custom({ 'gemini-4-hydrogen': { rates: { input: 3, output: 15, cacheRead: 0.15 } } });
  near(bare.price('gemini-4-hydrogen', { input: 0, output: 100000, reasoning: 100000 }, false).low, 3.0);
});

test('cost pricing never throws and keeps finite non-negative ordered costs for hostile counters', () => {
  const pricer = shipped();
  const hostile = [
    { input: -5, output: Number.NaN }, { input: Number.POSITIVE_INFINITY, output: 1 }, { input: 1e308, output: 1e308, cacheRead: 1e308 },
    { input: '5', output: null, bands: { le100k: 'x', gt272k: null, bogus: { input: 1, output: 1 } } }, {}, { input: 1, output: 1, bands: {} },
  ] as unknown as Parameters<Pricer['price']>[1][];
  for (const usage of hostile) {
    for (const model of ['claude-haiku-5-5', 'gpt-6.1-sol', 'nope']) {
      const cost = pricer.price(model, usage);
      assert.ok(Number.isFinite(cost.low) && Number.isFinite(cost.high) && cost.low >= 0 && cost.low <= cost.high, `${model} ${JSON.stringify(usage)}`);
    }
  }
});

test('cost pricing sums unit costs, formats them with an estimate mark and marks unpriced cells', () => {
  const exact: Cost = { low: 0.5, high: 0.5, priced: true, reasons: new Set() };
  const ranged: Cost = { low: 0.1, high: 0.25, priced: true, reasons: new Set(['tier unknown']) };
  const unpriced: Cost = { low: 0, high: 0, priced: false, reasons: new Set(['unpriced model']) };
  const total = sumCost([exact, ranged, unpriced]);
  assert.deepEqual([total.low, total.high, total.priced, reasonsOf(total)], [0.6, 0.75, true, ['tier unknown', 'unpriced model']]);
  const none = sumCost([unpriced]);
  assert.deepEqual([none.priced, reasonsOf(none)], [false, ['unpriced model']]);
  assert.equal(sumCost([]).priced, false);

  assert.equal(formatCost(undefined), '—');
  assert.equal(formatCost(unpriced), '—');
  assert.equal(formatCost(exact), '~$0.50');
  assert.equal(formatCost(ranged), '~$0.10–$0.25');
  assert.equal(formatCost({ ...exact, low: 0, high: 0 }), '~$0');
  assert.equal(formatCost({ ...exact, low: 0.004, high: 0.004 }), '~$<0.01');
  assert.equal(formatCost({ ...exact, low: 0, high: 12.345 }), '~$0–$12.35');
  assert.equal(formatCost({ ...exact, low: 1.234, high: 1.234 }), '~$1.23');
});

// SECTION: Shipped rate table

const rates = (input: number, output: number, cacheRead: number, cacheWrite5m?: number, cacheWrite1h?: number) =>
  ({ input, output, cacheRead, ...(cacheWrite5m === undefined ? {} : { cacheWrite5m, cacheWrite1h }) });
const tier = (abovePromptTokens: number, r: object) => ({ tiers: [{ abovePromptTokens, rates: r }] });
const EXPECTED = {
  'claude-opus-5-5': { reasoning: 'output', rates: rates(4, 20, 0.20, 5, 8) },
  'claude-sonnet-5-5': { reasoning: 'output', rates: rates(2, 10, 0.10, 2.50, 4) },
  'claude-haiku-5-5': { reasoning: 'output', rates: rates(0.10, 0.50, 0.01, 0.125, 0.20), ...tier(100_000, rates(0.50, 2.50, 0.05, 0.625, 1)) },
  'gpt-6.1-sol': { reasoning: 'output', rates: rates(2, 10, 0.10), ...tier(272_000, rates(4, 15, 0.20)) },
  'gpt-6.1-terra': { reasoning: 'output', rates: rates(1, 5, 0.05), ...tier(272_000, rates(2, 7.50, 0.10)) },
  'gpt-6-luna': { reasoning: 'output', rates: rates(0.10, 0.50, 0.01), ...tier(272_000, rates(0.20, 0.75, 0.02)) },
  'gemini-3.8-flash': { reasoning: 'output', rates: rates(0.75, 3.75, 0.075) },
  'gemini-4-hydrogen': { reasoning: 'output', rates: rates(1.50, 7.50, 0.075) },
};

test('shipped rate table holds the recorded official rates per model and no unconfirmed model', () => {
  const file = JSON.parse(tableText) as Record<string, unknown>;
  assert.equal(file['asOf'], '2026-11-14');
  assert.ok(Array.isArray(file['source']) && file['source'].length > 0 && file['source'].every((url) => typeof url === 'string' && url.startsWith('https://')));
  assert.deepEqual(table.models, EXPECTED);
  const pricer = shipped();
  assert.equal(pricer.meta.asOf, '2026-11-14');
  assert.deepEqual(pricer.meta.source, file['source']);
});

test('shipped rate table prices every confirmed model in the sample config', () => {
  const pricer = shipped();

  const sample = parseJsonc(fs.readFileSync(path.join(SKILL_ROOT, 'config.sample.jsonc'), 'utf8'));
  const override = (sample as Record<string, unknown>)['pricing'];
  assert.deepEqual(pricingProblems(override), []);
  assert.equal(resolvePricing(JSON.parse(tableText), override)?.price('lmstudio/qwen3.8-27b-ridge', { input: 1000, output: 1000 }).priced, true);
  const models = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (key === 'model') [item].flat().forEach((model) => { if (typeof model === 'string') models.add(model); });
        else walk(item);
      }
    }
  };
  walk(sample);
  assert.ok(models.size >= 8, [...models].join());
  // No official rate exists for these: they stay unpriced until a maintainer confirms them or a user overrides them.
  const unconfirmed = new Set(['gpt-6-terra', 'opencode-go/muse-spark-1.3-contributor', 'lmstudio/qwen3.8-27b-ridge']);
  for (const model of models) {
    assert.equal(pricer.price(model, { input: 1000, output: 1000 }).priced, !unconfirmed.has(model), model);
  }
});

test('shipped rate table yields no pricer when it is unreadable, unparsable or invalid', () => {
  const only = (text: string | null | Error) => (file: string): string | null => {
    if (!file.endsWith('pricing.json')) return null;
    if (text instanceof Error) throw text;
    return text;
  };
  assert.equal(loadPricing('/skill', only(null)), undefined);
  assert.equal(loadPricing('/skill', only(new Error('EACCES'))), undefined);
  assert.equal(loadPricing('/skill', only('{ not json')), undefined);
  const valid = JSON.parse(tableText) as Record<string, unknown>;
  const invalid: unknown[] = [
    null, [], { ...valid, asOf: 'yesterday' }, { ...valid, asOf: undefined }, { ...valid, source: 'https://x.test' }, { ...valid, source: [1] }, { ...valid, models: [] },
    { ...valid, models: { bad: { rates: { input: 1 } } } }, { ...valid, models: { ...table.models, bad: 5 } },
  ];
  for (const candidate of invalid) {
    assert.equal(resolvePricing(candidate, undefined), undefined, JSON.stringify(candidate));
    assert.equal(loadPricing('/skill', only(JSON.stringify(candidate))), undefined);
  }
});

// SECTION: Pricing override

test('pricing override replaces a shipped rate, adds ids and keeps absent ids on shipped rates', () => {
  const pricer = shipped(JSON.stringify({ pricing: {
    'claude-opus-5-5': { rates: { input: 1, output: 1 } },
    'house-model': { rates: { input: 3, output: 3 } },
    'lmstudio/*': ZERO,
  } }));
  const usage = { input: 1_000_000, output: 0 };
  assert.equal(pricer.price('claude-opus-5-5', usage).low, 1);
  assert.equal(pricer.price('bedrock.claude-opus-5-5', usage).low, 1);
  assert.equal(pricer.price('house-model', usage).low, 3);
  near(pricer.price('claude-sonnet-5-5', usage).low, 2);
  const local = pricer.price('lmstudio/qwen3.8-27b-ridge', { input: 1000, output: 1000, cacheRead: 5000, cacheWrite: 3000 });
  assert.equal(formatCost(local), '~$0');
  // JSONC comments and trailing commas in the config parse like any other config.
  const commented = shipped('{ // local\n "pricing": { "house-model": { "rates": { "input": 3, "output": 3, }, }, }, }');
  assert.equal(commented.price('house-model', usage).low, 3);
});

test('pricing override entries that are malformed are skipped and named by key and reason', () => {
  const OK = { rates: { input: 1, output: 1 } };
  const bad: Record<string, [unknown, RegExp]> = {
    notEntry: [5, /^pricing\.notEntry: not an object$/],
    unknownKey: [{ ...OK, extra: 1 }, /^pricing\.unknownKey: unknown key extra$/],
    noInput: [{ rates: { output: 1 } }, /^pricing\.noInput: rates\.input missing$/],
    noRates: [{}, /^pricing\.noRates: rates not an object$/],
    unknownRate: [{ rates: { input: 1, output: 1, thinking: 1 } }, /^pricing\.unknownRate: rates\.thinking unknown key$/],
    negative: [{ rates: { input: -1, output: 1 } }, /^pricing\.negative: rates\.input must be a finite number >= 0$/],
    infinite: [{ rates: { input: Number.POSITIVE_INFINITY, output: 1 } }, /^pricing\.infinite: rates\.input must be a finite number >= 0$/],
    stringRate: [{ rates: { input: '1', output: 1 } }, /^pricing\.stringRate: rates\.input must be/],
    reasoning: [{ ...OK, reasoning: 'input' }, /^pricing\.reasoning: reasoning must be "output"$/],
    unordered: [{ ...OK, tiers: [{ abovePromptTokens: 200_000, rates: OK.rates }, { abovePromptTokens: 100_000, rates: OK.rates }] }, /^pricing\.unordered: tiers\[1\]\.abovePromptTokens must be/],
    zeroThreshold: [{ ...OK, tiers: [{ abovePromptTokens: 0, rates: OK.rates }] }, /^pricing\.zeroThreshold: tiers\[0\]\.abovePromptTokens must be/],
    fractional: [{ ...OK, tiers: [{ abovePromptTokens: 1.5, rates: OK.rates }] }, /^pricing\.fractional: tiers\[0\]\.abovePromptTokens must be/],
    tierKeys: [{ ...OK, tiers: [{ abovePromptTokens: 100_000, rates: { input: 2, output: 2, cacheRead: 1 } }] }, /^pricing\.tierKeys: tiers\[0\]\.rates keys differ from rates$/],
    tierExtra: [{ ...OK, tiers: [{ abovePromptTokens: 100_000, rates: OK.rates, note: 1 }] }, /^pricing\.tierExtra: tiers\[0\] must hold only/],
    tiersShape: [{ ...OK, tiers: {} }, /^pricing\.tiersShape: tiers not an array$/],
  };
  const good = { 'house-model': { ...OK, tiers: [{ abovePromptTokens: 100_000, rates: { input: 2, output: 2 } }], reasoning: 'output' } };
  assert.deepEqual(pricingProblems(good), []);
  assert.deepEqual(pricingProblems(undefined), []);
  for (const [key, [entry, message]] of Object.entries(bad)) {
    const problems = pricingProblems({ ...good, [key]: entry });
    assert.equal(problems.length, 1, key);
    assert.match(problems[0]!, message, key);
    const pricer = resolvePricing(JSON.parse(tableText), { ...good, [key]: entry });
    assert.ok(pricer, key);
    assert.equal(pricer.price(key, { input: 1, output: 1 }).priced, false, `${key} is skipped`);
    assert.equal(pricer.price('house-model', { input: 1, output: 1 }).priced, true, `${key} leaves valid entries`);
    assert.equal(pricer.price('claude-opus-5-5', { input: 1, output: 1 }).priced, true, `${key} keeps shipped rates`);
  }
  assert.equal(pricingProblems(Object.fromEntries(Object.entries(bad).map(([key, [entry]]) => [key, entry]))).length, Object.keys(bad).length);
  for (const whole of ['x', 5, null, [], true]) {
    assert.deepEqual(pricingProblems(whole), ['pricing: not an object']);
    assert.equal(resolvePricing(JSON.parse(tableText), whole)?.price('claude-opus-5-5', { input: 1, output: 1 }).priced, true);
  }
});

test('pricing override falls back to the shipped table when the config is missing, unparsable or unreadable', () => {
  const usage = { input: 1_000_000, output: 0 };
  assert.equal(loadPricing('/skill', readShipped())?.price('claude-opus-5-5', usage).low, 4);
  assert.equal(shipped('{ broken').price('claude-opus-5-5', usage).low, 4);
  assert.equal(shipped('[1, 2]').price('claude-opus-5-5', usage).low, 4);
  assert.equal(shipped(JSON.stringify({ pricing: 'cheap' })).price('claude-opus-5-5', usage).low, 4);
  const unreadable = loadPricing('/skill', (file) => {
    if (file.endsWith('pricing.json')) return tableText;
    throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
  });
  assert.equal(unreadable?.price('claude-opus-5-5', usage).low, 4);
  const mixed = shipped(JSON.stringify({ pricing: { 'claude-opus-5-5': { rates: { input: -1, output: 1 } }, 'house-model': { rates: { input: 3, output: 3 } } } }));
  assert.equal(mixed.price('claude-opus-5-5', usage).low, 4, 'a malformed entry keeps the shipped rate');
  assert.equal(mixed.price('house-model', usage).low, 3);
});
