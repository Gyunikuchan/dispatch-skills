import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeUsage } from '../../../skills/dispatch/scripts/lib/diagnostic-usage.ts';


test('claude usage keeps per-model counters and aggregate totals', () => {
  const usage = claudeUsage(JSON.stringify({ type: 'result', modelUsage: {
    'claude-sonnet-4-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40 },
    'claude-haiku-4-5': { inputTokens: 5, outputTokens: 1 },
  } }));
  assert.deepEqual(usage?.models, { 'claude-sonnet-4-5': { input: 100, output: 20, cacheRead: 300, cacheWrite: 40 }, 'claude-haiku-4-5': { input: 5, output: 1 } });
  assert.deepEqual([usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite], [105, 21, 300, 40]);
  assert.deepEqual(usage?.actualModels, ['claude-sonnet-4-5', 'claude-haiku-4-5']);
});
