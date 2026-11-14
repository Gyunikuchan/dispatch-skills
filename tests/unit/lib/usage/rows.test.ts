import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addCounters, splitUsageKey, tokenTotal, usageKey, type Counters } from '../../../../skills/dispatch/scripts/lib/usage/rows.ts';

test('addCounters mutates target and preserves absent vs zero optional counters', () => {
  const total: Counters = { input: 10, output: 5 };
  const returned = addCounters(total, { input: 3, output: 2 });
  assert.equal(returned, total);
  assert.deepEqual(total, { input: 13, output: 7 });
  assert.equal('cacheRead' in total, false);
  assert.equal('cacheWrite' in total, false);
  assert.equal('reasoning' in total, false);

  addCounters(total, { input: 1, output: 1, cacheRead: 0, reasoning: 4 });
  assert.deepEqual(total, { input: 14, output: 8, cacheRead: 0, reasoning: 4 });
  assert.equal('cacheWrite' in total, false);

  addCounters(total, { input: 2, output: 3, cacheRead: 6, cacheWrite: 5 });
  assert.deepEqual(total, { input: 16, output: 11, cacheRead: 6, cacheWrite: 5, reasoning: 4 });
});

test('tokenTotal sums input, cacheRead, cacheWrite, and output while excluding reasoning', () => {
  assert.equal(tokenTotal({ input: 10, output: 5 }), 15);
  assert.equal(tokenTotal({ input: 10, output: 5, cacheRead: 20, cacheWrite: 3, reasoning: 99 }), 38);
});

test('usageKey formats model and effort pairs with empty fallbacks', () => {
  assert.equal(usageKey('claude-opus-5-5[1m]', 'high'), 'claude-opus-5-5[1m]#high');
  assert.equal(usageKey('claude-opus-5-5', null), 'claude-opus-5-5#');
  assert.equal(usageKey(undefined, 'low'), '#low');
  assert.equal(usageKey(null, undefined), '#');
});

test('splitUsageKey separates model and optional effort on the first hash', () => {
  assert.deepEqual(splitUsageKey('claude-opus-5-5'), { model: 'claude-opus-5-5', effort: undefined });
  assert.deepEqual(splitUsageKey('claude-opus-5-5[1m]#high'), { model: 'claude-opus-5-5[1m]', effort: 'high' });
  assert.deepEqual(splitUsageKey('claude-opus-5-5#'), { model: 'claude-opus-5-5', effort: '' });
  assert.deepEqual(splitUsageKey('#high'), { model: '', effort: 'high' });
  assert.deepEqual(splitUsageKey('model#a#b'), { model: 'model', effort: 'a#b' });
});
