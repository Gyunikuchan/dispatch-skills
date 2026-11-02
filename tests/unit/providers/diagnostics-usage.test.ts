import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { codex } from '../../../skills/dispatch/scripts/providers/codex.ts';
import { claude } from '../../../skills/dispatch/scripts/providers/claude.ts';
import { agy } from '../../../skills/dispatch/scripts/providers/agy.ts';
import { opencode } from '../../../skills/dispatch/scripts/providers/opencode.ts';

const rawFixtures: Record<string, { cliVersion: string; stdout: string }> = {
  codex: JSON.parse(fs.readFileSync(new URL('./fixtures/diagnostics-codex.json', import.meta.url), 'utf8')),
  claude: JSON.parse(fs.readFileSync(new URL('./fixtures/diagnostics-claude.json', import.meta.url), 'utf8')),
};
const fixture = (provider: string): { cliVersion: string; stdout: string } => {
  const base = rawFixtures[provider]!;
  return { cliVersion: base.cliVersion, stdout: base.stdout };
};

test('Codex completed turn maps token usage and retains cache overlap semantics', () => {
  const f = fixture('codex'), result = codex.usage!(f.stdout);
  assert.deepEqual(result, {
    input: 275615,
    output: 1468,
    scope: 'invocation',
    provenance: 'codex.turn.completed',
    inputSemantics: 'includes-cache',
    cacheRead: 221056,
    cacheWrite: 0,
    reasoning: 70,
  });
});

test('repeated completed summaries never add counters', () => {
  const f = fixture('codex');
  assert.deepEqual(codex.usage!(`${f.stdout}\n${f.stdout}`), codex.usage!(f.stdout));
});

test('malformed or truncated structured output is unavailable', () => {
  for (const p of [codex, claude]) for (const raw of ['text only', '{', '{"type":"result","usage":{"input_tokens":-1,"output_tokens":1}}']) assert.equal(p.usage!(raw), undefined);
});

test('Claude whole-tree thinking counters remain separate and reject unsafe sums', () => {
  const event = JSON.parse(fixture('claude').stdout);
  const model = Object.keys(event.modelUsage)[0]!;
  event.modelUsage[model].thinkingTokens = 4;
  event.modelUsage.second = { inputTokens: 1, outputTokens: 2, thinkingTokens: 7 };
  const parsed = claude.usage!(JSON.stringify(event));
  assert.equal(parsed?.reasoning, 11);
  assert.equal(parsed?.models?.[model]?.reasoning, 4);
  assert.equal(parsed?.models?.['second']?.reasoning, 7);
  event.modelUsage['second'].thinkingTokens = Number.MAX_SAFE_INTEGER;
  assert.equal(claude.usage!(JSON.stringify(event)), undefined);
});

test('Claude modelUsage keeps per-model counters beside the aggregate; Codex reports none', () => {
  const f = fixture('claude'), base = claude.usage!(f.stdout);
  assert.equal(base?.input, 2759);
  assert.equal(base?.actualModels?.[0], 'claude-haiku-4-5-20251001');
  assert.equal(base?.inputSemantics, 'uncached');

  const event = JSON.parse(f.stdout);
  event.modelUsage['claude-opus-4-1'] = { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 };
  const result = claude.usage!(JSON.stringify(event));
  assert.deepEqual(result?.models, {
    'claude-haiku-4-5-20251001': { input: 2759, output: 16, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    'claude-opus-4-1': { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
  });
  assert.equal(result?.input, 2769);
  assert.equal(codex.usage!(fixture('codex').stdout)?.models, undefined);
});

test('agy usage maps the print JSON usage block to uncached counters', () => {
  // Shape of a recorded agy `--output-format json` envelope; counts are synthetic.
  const stdout = JSON.stringify({ conversation_id: 'c1', status: 'success', response: 'ok', duration_seconds: 12, num_turns: 3, usage: { input_tokens: 364, output_tokens: 45, thinking_tokens: 39, cache_read_tokens: 7824, total_tokens: 409 } });
  assert.deepEqual(agy.usage?.(stdout), { input: 364, output: 45, cacheRead: 7824, reasoning: 39, scope: 'invocation', provenance: 'agy.usage', inputSemantics: 'uncached' });
  for (const raw of ['text only', '{', '{"usage":{"input_tokens":-1,"output_tokens":1}}']) assert.equal(agy.usage?.(raw), undefined);
});

const opencodeProbe = fs.readFileSync(new URL('./fixtures/opencode-format-json.jsonl', import.meta.url), 'utf8');

test('opencode json usage parses probe fixture', () => {
  // Copy of the sanitized live probe: `tokens.input` excludes cache reads (installed v2.2.5 maps
  // nonCachedInputTokens to input and cache.read to cacheReadInputTokens).
  assert.deepEqual(opencode.usage?.(opencodeProbe), {
    input: 1491, output: 8, reasoning: 40, cacheRead: 70, cacheWrite: 0,
    scope: 'invocation', provenance: 'opencode.step.finish', inputSemantics: 'uncached',
  });
});

const codexStarted = () => JSON.stringify({ type: 'turn.started' });
const codexCompleted = (input: number, output: number) => JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: input, output_tokens: output, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 },
});

test('codex sums distinct turns', () => {
  const usage = codex.usage!([codexStarted(), codexCompleted(100, 10), codexStarted(), codexCompleted(200, 20)].join('\n'));
  assert.deepEqual(usage, {
    input: 300, output: 30, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    scope: 'invocation', provenance: 'codex.turn.completed', inputSemantics: 'includes-cache',
  });
});

test('codex equal distinct turns both count', () => {
  const usage = codex.usage!([codexStarted(), codexCompleted(100, 10), codexStarted(), codexCompleted(100, 10)].join('\n'));
  assert.equal(usage?.input, 200);
  assert.equal(usage?.output, 20);
});

test('codex replayed completion counts once', () => {
  const usage = codex.usage!([codexCompleted(100, 10), codexCompleted(100, 10)].join('\n'));
  assert.equal(usage?.input, 100);
  assert.equal(usage?.output, 10);
});

test('codex lone completed turn counts', () => {
  const usage = codex.usage!(codexCompleted(100, 10));
  assert.equal(usage?.input, 100);
  assert.equal(usage?.output, 10);
});
