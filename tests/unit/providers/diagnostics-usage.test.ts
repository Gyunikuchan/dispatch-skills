import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { codex } from '../../../skills/dispatch/scripts/providers/codex.ts';
import { claude } from '../../../skills/dispatch/scripts/providers/claude.ts';
import { opencode } from '../../../skills/dispatch/scripts/providers/opencode.ts';
const fixture = (provider: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/diagnostics-${provider}.json`, import.meta.url), 'utf8')) as { cliVersion: string; stdout: string };
test('SC4: recorded Codex 0.156.1 completed turn retains cache overlap semantics', () => {
  const f = fixture('codex'), result = codex.usage!(f.stdout), event = JSON.parse(f.stdout);
  assert.equal(f.cliVersion, '0.156.1');
  assert.equal(result?.input, event.usage.input_tokens);
  assert.equal(result?.output, event.usage.output_tokens);
  assert.equal(result?.cacheRead, event.usage.cached_input_tokens);
  assert.equal(result?.inputSemantics, 'includes-cache');
});
test('SC4: recorded Claude 2.1.268 failed invocation accounts whole-tree model usage', () => {
  const f = fixture('claude'), result = claude.usage!(f.stdout);
  assert.equal(f.cliVersion, '2.1.268');
  assert.equal(result?.input, 2759);
  assert.equal(result?.actualModels?.[0], 'claude-haiku-4-5-20251001');
  assert.equal(result?.inputSemantics, 'uncached');
});
test('SC4: repeated completed summaries never add counters', () => {
  const f = fixture('codex');
  assert.deepEqual(codex.usage!(`${f.stdout}\n${f.stdout}`), codex.usage!(f.stdout));
});
test('SC4: malformed or truncated structured output is unavailable', () => {
  for (const p of [codex, claude]) for (const raw of ['text only', '{', '{"type":"result","usage":{"input_tokens":-1,"output_tokens":1}}']) assert.equal(p.usage!(raw), undefined);
});
test('SC4: text-only OpenCode has no usage adapter', () => { assert.equal(opencode.usage, undefined); });

test('SC4: Claude whole-tree thinking counters remain separate and reject unsafe sums', () => {
  const event = JSON.parse(fixture('claude').stdout);
  const model = Object.keys(event.modelUsage)[0]!;
  event.modelUsage[model].thinkingTokens = 4;
  event.modelUsage.second = { inputTokens: 1, outputTokens: 2, thinkingTokens: 7 };
  assert.equal(claude.usage!(JSON.stringify(event))?.reasoning, 11);
  event.modelUsage.second.thinkingTokens = Number.MAX_SAFE_INTEGER;
  assert.equal(claude.usage!(JSON.stringify(event)), undefined);
});

test('SC4: Claude modelUsage keeps per-model counters beside the aggregate; Codex reports none', () => {
  const event = JSON.parse(fixture('claude').stdout);
  event.modelUsage['claude-opus-4-1'] = { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 };
  const result = claude.usage!(JSON.stringify(event));
  assert.deepEqual(result?.models, {
    'claude-haiku-4-5-20251001': { input: 2759, output: 16, cacheRead: 0, cacheWrite: 0 },
    'claude-opus-4-1': { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
  });
  assert.equal(result?.input, 2769);
  assert.equal(codex.usage!(fixture('codex').stdout)?.models, undefined);
});
