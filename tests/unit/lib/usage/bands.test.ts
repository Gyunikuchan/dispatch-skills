import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BAND_EDGES, BANDS, MAX_MODEL_KEYS, OTHER_KEY, bandOf, boundModels, foldRows } from '../../../../skills/dispatch/scripts/lib/usage/bands.ts';
import { tokenTotal, type UsageRow } from '../../../../skills/dispatch/scripts/lib/usage/rows.ts';

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  model: 'claude-sonnet-4-5',
  effort: 'high',
  role: 'host',
  depth: 0,
  atMs: 1000,
  reasoningInOutput: true,
  input: 10,
  output: 5,
  ...over,
});

test('band fold: prompt-size edges take lower band and split fields stay out of totals', () => {
  assert.deepEqual(BAND_EDGES, [100_000, 200_000, 272_000]);
  assert.deepEqual(BANDS, ['le100k', 'le200k', 'le272k', 'gt272k']);

  assert.equal(bandOf({ input: 0, output: 1 }), 'le100k');
  assert.equal(bandOf({ input: 60_000, cacheRead: 30_000, cacheWrite: 10_000, output: 500 }), 'le100k');
  assert.equal(bandOf({ input: 60_001, cacheRead: 30_000, cacheWrite: 10_000, output: 500 }), 'le200k');
  assert.equal(bandOf({ input: 200_000, output: 1 }), 'le200k');
  assert.equal(bandOf({ input: 200_001, output: 1 }), 'le272k');
  assert.equal(bandOf({ input: 272_000, output: 1 }), 'le272k');
  assert.equal(bandOf({ input: 272_001, output: 1 }), 'gt272k');

  const folded = foldRows([
    row({ input: 90_000, output: 10, cacheWrite: 10_000, cacheWrite5m: 6_000, cacheWrite1h: 4_000, reasoning: 3 }),
    row({ input: 150_000, output: 20, cacheRead: 10_000, cacheWrite: 5_000, cacheWrite5m: 5_000, reasoning: 7 }),
  ]);

  assert.equal(folded.reasoningInOutput, true);
  assert.deepEqual(folded.total, {
    input: 240_000,
    output: 30,
    cacheRead: 10_000,
    cacheWrite: 15_000,
    cacheWrite5m: 11_000,
    cacheWrite1h: 4_000,
    reasoning: 10,
  });
  assert.equal(tokenTotal(folded.total), 240_000 + 30 + 10_000 + 15_000);

  const entry = folded.models['claude-sonnet-4-5#high'];
  assert.ok(entry);
  assert.deepEqual(entry.bands, {
    le100k: { input: 90_000, output: 10, cacheWrite: 10_000, cacheWrite5m: 6_000, cacheWrite1h: 4_000, reasoning: 3 },
    le200k: { input: 150_000, output: 20, cacheRead: 10_000, cacheWrite: 5_000, cacheWrite5m: 5_000, reasoning: 7 },
  });
  assert.equal(entry.input, (entry.bands!.le100k?.input ?? 0) + (entry.bands!.le200k?.input ?? 0));
  assert.equal(entry.cacheWrite5m, 11_000);
  assert.equal(entry.cacheWrite1h, 4_000);

  const mixed = foldRows([row({ reasoningInOutput: true }), row({ reasoningInOutput: false })]);
  assert.equal(mixed.reasoningInOutput, undefined);
});

test('key bound: keeps 32 largest keys and merges overflow and existing other into other', () => {
  assert.equal(MAX_MODEL_KEYS, 32);
  assert.equal(OTHER_KEY, 'other');

  const input: Record<string, { input: number; output: number; bands?: { le100k: { input: number; output: number } } }> = {};
  for (let i = 1; i <= 34; i++) {
    const key = `m${String(i).padStart(2, '0')}#high`;
    const tokens = i <= 4 ? 10 : i * 100;
    input[key] = { input: tokens, output: 0, bands: { le100k: { input: tokens, output: 0 } } };
  }
  input['other'] = { input: 5, output: 1 };

  const bounded = boundModels(input);
  const keys = Object.keys(bounded);
  assert.equal(keys.length, 33);
  assert.ok(keys.includes('other'));
  // m01..m04 all tied at 10, smallest -> m01 and m02 merge first (ascending key order), m03 and m04 remain
  assert.equal('m01#high' in bounded, false);
  assert.equal('m02#high' in bounded, false);
  assert.equal('m03#high' in bounded, true);
  assert.equal('m04#high' in bounded, true);
  assert.deepEqual(bounded['other'], { input: 25, output: 1 });
  assert.equal('bands' in bounded['other']!, false);
});
