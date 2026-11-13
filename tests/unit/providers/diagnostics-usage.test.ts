import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { codex } from '../../../skills/dispatch/scripts/providers/codex.ts';
import { claude } from '../../../skills/dispatch/scripts/providers/claude.ts';
import { agy } from '../../../skills/dispatch/scripts/providers/agy.ts';
import { opencode } from '../../../skills/dispatch/scripts/providers/opencode.ts';
import { normalizeAgyModelEffort, decodeAgyGenMetadata, opencodeDbUsage, readAgySqliteGenMetadata } from '../../../skills/dispatch/scripts/lib/diagnostic-usage.ts';
import type { OpencodeMessage } from '../../../skills/dispatch/scripts/lib/opencode-db.ts';
import type { PlatformEnv } from '../../../skills/dispatch/scripts/providers/types.ts';

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

test('OpenCode DB usage folds messages into per-model and effort keys', () => {
  const usage = opencodeDbUsage([
    { depth: 0, createdMs: 1, model: 'p/a', effort: 'high', input: 10, output: 2, cacheRead: 3, cacheWrite: 0, reasoning: 1 },
    { depth: 1, createdMs: 2, model: 'p/a', effort: 'high', input: 5, output: 1 },
    { depth: 2, createdMs: 3, model: 'p/b', effort: 'low', input: 7, output: 4, reasoning: 2 },
  ]);
  assert.equal(usage?.provenance, 'opencode.db.messages');
  assert.equal(usage?.inputSemantics, 'uncached');
  assert.deepEqual([usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite, usage?.reasoning], [22, 7, 3, 0, 3]);
  assert.deepEqual(usage?.actualModels, ['p/a', 'p/b']);
  assert.equal(usage?.actualEffort, null);
  assert.deepEqual({ ...usage?.models }, {
    'p/a#high': { input: 15, output: 3, cacheRead: 3, cacheWrite: 0, reasoning: 1 },
    'p/b#low': { input: 7, output: 4, reasoning: 2 },
  });
});

test('OpenCode DB usage shares one effort and leaves an empty part for a missing model or effort', () => {
  const shared = opencodeDbUsage([
    { depth: 0, createdMs: 1, model: 'p/a', effort: 'max', input: 1, output: 1 },
    { depth: 1, createdMs: 2, model: 'p/a', effort: 'max', input: 2, output: 3 },
  ]);
  assert.equal(shared?.actualEffort, 'max');
  const missing = opencodeDbUsage([
    { depth: 0, createdMs: 1, model: null, effort: 'max', input: 1, output: 1 },
    { depth: 0, createdMs: 2, model: 'p/a', effort: null, input: 2, output: 2 },
    { depth: 0, createdMs: 3, model: null, effort: null, input: 3, output: 3 },
  ]);
  assert.deepEqual({ ...missing?.models }, {
    '#max': { input: 1, output: 1 },
    'p/a#': { input: 2, output: 2 },
    '#': { input: 3, output: 3 },
  });
  assert.deepEqual(missing?.actualModels, ['p/a']);
  assert.equal(missing?.actualEffort, null);
});

test('OpenCode DB usage caps measured models at eight while keeping every model and effort key', () => {
  const messages: OpencodeMessage[] = Array.from({ length: 10 }, (_, index) => ({
    depth: 0, createdMs: index, model: `p/m${index}`, effort: 'low', input: 1, output: 1,
  }));
  const usage = opencodeDbUsage(messages);
  assert.equal(usage?.actualModels?.length, 8);
  assert.deepEqual(usage?.actualModels, Array.from({ length: 8 }, (_, index) => `p/m${index}`));
  assert.equal(Object.keys(usage?.models ?? {}).length, 10);
  assert.deepEqual([usage?.input, usage?.output, usage?.actualEffort], [10, 10, 'low']);
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
  const equalTurns = codex.usage!([codexStarted(), codexCompleted(100, 10), codexStarted(), codexCompleted(100, 10)].join('\n'));
  assert.equal(equalTurns?.input, 200);
  assert.equal(equalTurns?.output, 20);
});

function encodeVarint(val: number | bigint): number[] {
  const bytes: number[] = [];
  let n = BigInt(val);
  while (n > 0x7fn) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n & 0x7fn));
  return bytes;
}
function encodeTag(fieldNum: number, wireType: number): number[] {
  return encodeVarint((fieldNum << 3) | wireType);
}
function encodeLengthDelimited(fieldNum: number, content: Uint8Array | number[] | string): number[] {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  return [...encodeTag(fieldNum, 2), ...encodeVarint(buf.length), ...buf];
}
function buildGenMetadataBlob(options: {
  input?: number;
  output?: number;
  cacheRead?: number;
  reasoning?: number;
  modelSlug?: string;
  displayName?: string;
  lastStepIndex?: number;
  unknownField?: boolean;
}): Uint8Array {
  const tag1Fields: number[] = [];
  const counters: number[] = [];
  if (options.input !== undefined) counters.push(...encodeTag(2, 0), ...encodeVarint(options.input));
  if (options.output !== undefined) counters.push(...encodeTag(3, 0), ...encodeVarint(options.output));
  if (options.cacheRead !== undefined) counters.push(...encodeTag(5, 0), ...encodeVarint(options.cacheRead));
  if (options.reasoning !== undefined) counters.push(...encodeTag(9, 0), ...encodeVarint(options.reasoning));
  if (counters.length > 0) tag1Fields.push(...encodeLengthDelimited(4, counters));
  if (options.modelSlug !== undefined) tag1Fields.push(...encodeLengthDelimited(19, options.modelSlug));
  if (options.lastStepIndex !== undefined) {
    const kv = [
      ...encodeLengthDelimited(1, 'last_step_index'),
      ...encodeLengthDelimited(2, String(options.lastStepIndex)),
    ];
    tag1Fields.push(...encodeLengthDelimited(20, kv));
  }
  if (options.displayName !== undefined) tag1Fields.push(...encodeLengthDelimited(21, options.displayName));
  if (options.unknownField) {
    tag1Fields.push(...encodeTag(99, 1), 1, 2, 3, 4, 5, 6, 7, 8);
  }
  return new Uint8Array(encodeLengthDelimited(1, tag1Fields));
}

test('agy model and effort normalization and gen_metadata attribution', () => {
  // 1. normalizeAgyModelEffort
  // display-name effort precedence over rawEffort and rawModel suffix
  assert.deepEqual(normalizeAgyModelEffort('gemini-3.8-flash-low', 'high', 'Gemini 3.8 Flash (Medium)'), { model: 'gemini-3.8-flash', effort: 'medium' });
  assert.deepEqual(normalizeAgyModelEffort('gemini-3.8-flash-low', 'high', 'Gemini 3.8 Flash'), { model: 'gemini-3.8-flash', effort: 'high' });
  assert.deepEqual(normalizeAgyModelEffort('gemini-3.8-flash-low', null, 'Gemini 3.8 Flash'), { model: 'gemini-3.8-flash', effort: 'low' });
  assert.deepEqual(normalizeAgyModelEffort('gemini-3.8-flash', null, null), { model: 'gemini-3.8-flash', effort: null });

  // backend suffixes -trial, -tiered, -control, -n
  assert.deepEqual(normalizeAgyModelEffort('gemini-4-argon-trial'), { model: 'gemini-4-argon', effort: null });
  assert.deepEqual(normalizeAgyModelEffort('gemini-3.8-flash-tiered'), { model: 'gemini-3.8-flash', effort: null });
  assert.deepEqual(normalizeAgyModelEffort('gemini-3.8-flash-control'), { model: 'gemini-3.8-flash', effort: null });
  assert.deepEqual(normalizeAgyModelEffort('gemini-3.8-flash-n'), { model: 'gemini-3.8-flash', effort: null });

  // Claude / Gemini / GPT-OSS naming
  assert.deepEqual(normalizeAgyModelEffort('c0', 'low', 'Claude Opus 5.5 (Low)'), { model: 'claude-opus-5-5', effort: 'low' });
  assert.deepEqual(normalizeAgyModelEffort(null, null, 'Gemini 4 Argon (Medium)'), { model: 'gemini-4-argon', effort: 'medium' });
  assert.deepEqual(normalizeAgyModelEffort(null, null, 'GPT-OSS 120B (High)'), { model: 'gpt-oss-120b', effort: 'high' });
  // rawModel containing display name with parenthesized effort
  assert.deepEqual(normalizeAgyModelEffort('Gemini 4 Argon (Medium)'), { model: 'gemini-4-argon', effort: 'medium' });

  // 2. decodeAgyGenMetadata
  const blob = buildGenMetadataBlob({
    input: 1200,
    output: 80,
    cacheRead: 300,
    reasoning: 50,
    modelSlug: 'gemini-4-argon-trial',
    displayName: 'Gemini 4 Argon (Medium)',
    lastStepIndex: 42,
    unknownField: true,
  });
  const decoded = decodeAgyGenMetadata(blob);
  assert.deepEqual(decoded, {
    model: 'gemini-4-argon',
    effort: 'medium',
    hasDisplayName: true,
    lastStepIndex: 42,
    input: 1200,
    output: 80,
    cacheRead: 300,
    reasoning: 50,
  });

  // non-throwing on truncated or malformed buffers
  assert.doesNotThrow(() => decodeAgyGenMetadata(blob.subarray(0, 15)));
  assert.doesNotThrow(() => decodeAgyGenMetadata(new Uint8Array([0xff, 0xff, 0xff])));
  assert.deepEqual(decodeAgyGenMetadata(new Uint8Array(0)), { model: null, effort: null });
  // varint negative/overflow does not hang
  assert.deepEqual(decodeAgyGenMetadata(new Uint8Array([0x0a, 0xfa, 0xff, 0xff, 0xff, 0x0f])), { model: null, effort: null });

  // 3. readAgySqliteGenMetadata
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-usage-test-'));
  try {
    const dbPath = path.join(tmpDir, 'test.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE gen_metadata (idx INTEGER, data BLOB)');
    const insertStmt = db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');
    insertStmt.run(0, blob);
    db.close();

    const readBlobs = readAgySqliteGenMetadata(dbPath);
    assert.equal(readBlobs?.length, 1);
    assert.deepEqual(readBlobs[0], blob);

    // 64 MiB MAX_FILE_BYTES cap
    assert.equal(readAgySqliteGenMetadata(dbPath, { maxBytes: 10 }), null);
    assert.throws(() => readAgySqliteGenMetadata(dbPath, { maxBytes: 10, throwOnError: true }), /maxBytes/);

    // 4. agy.usage with context and profile resolution
    const tempHome = path.join(tmpDir, 'home');
    const cliConvDir = path.join(tempHome, '.gemini', 'antigravity-cli', 'conversations');
    fs.mkdirSync(cliConvDir, { recursive: true });

    // multi-turn DB: turn 0 has effort, turn 1 has no effort
    const conv1Id = 'c1-multi';
    const conv1Path = path.join(cliConvDir, `${conv1Id}.db`);
    const db1 = new DatabaseSync(conv1Path);
    db1.exec('CREATE TABLE gen_metadata (idx INTEGER, data BLOB)');
    const insert1 = db1.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');
    const turn0 = buildGenMetadataBlob({ input: 100, output: 10, displayName: 'Gemini 4 Argon (High)', modelSlug: 'gemini-4-argon' });
    const turn1 = buildGenMetadataBlob({ input: 264, output: 35, displayName: 'Gemini 4 Argon', modelSlug: 'gemini-4-argon' });
    insert1.run(0, turn0);
    insert1.run(1, turn1);
    db1.close();

    const makePlatform = (home: string): PlatformEnv => ({
      os: process.platform as PlatformEnv['os'],
      arch: 'x64',
      wsl: false,
      bubblewrap: false,
      argvLimit: 100000,
      home,
      path: [],
      pathExt: [],
    });

    const stdout1 = JSON.stringify({
      conversation_id: conv1Id,
      usage: { input_tokens: 364, output_tokens: 45, thinking_tokens: 39, cache_read_tokens: 7824 },
    });
    const parsed1 = agy.usage?.(stdout1, {
      mode: 'cli',
      platform: makePlatform(tempHome),
      env: { ANTIGRAVITY_APP_DATA_DIR: '/other/host/dir' },
    });
    assert.deepEqual(parsed1, {
      input: 364,
      output: 45,
      cacheRead: 7824,
      reasoning: 39,
      scope: 'invocation',
      provenance: 'agy.usage',
      inputSemantics: 'uncached',
      actualModels: ['gemini-4-argon'],
      models: {
        'gemini-4-argon': { input: 364, output: 45, cacheRead: 7824, reasoning: 39 },
      },
      actualEffort: null, // turn 1 had Tag 1.21 without effort!
    });

    // DB where Tag 1.21 is absent
    const conv2Id = 'c2-no-display';
    const conv2Path = path.join(cliConvDir, `${conv2Id}.db`);
    const db2 = new DatabaseSync(conv2Path);
    db2.exec('CREATE TABLE gen_metadata (idx INTEGER, data BLOB)');
    const insert2 = db2.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');
    insert2.run(0, buildGenMetadataBlob({ input: 50, output: 5, modelSlug: 'gemini-3.8-flash' }));
    db2.close();

    const stdout2 = JSON.stringify({
      conversation_id: conv2Id,
      usage: { input_tokens: 50, output_tokens: 5 },
    });
    const parsed2 = agy.usage?.(stdout2, {
      mode: 'cli',
      platform: makePlatform(tempHome),
      env: {},
    });
    assert.equal(parsed2?.actualEffort, undefined);
    assert.deepEqual(parsed2?.actualModels, ['gemini-3.8-flash']);

    // Envelope model/effort fallback when DB is absent
    const stdoutEnv = JSON.stringify({
      conversation_id: 'c-no-db',
      model: 'gemini-3.8-flash-tiered',
      effort: 'high',
      usage: { input_tokens: 20, output_tokens: 5 },
    });
    const parsedEnv = agy.usage?.(stdoutEnv, {
      mode: 'cli',
      platform: makePlatform(tempHome),
      env: {},
    });
    assert.deepEqual(parsedEnv, {
      input: 20,
      output: 5,
      scope: 'invocation',
      provenance: 'agy.usage.envelope',
      inputSemantics: 'uncached',
      actualModels: ['gemini-3.8-flash'],
      actualEffort: 'high',
      models: {
        'gemini-3.8-flash': { input: 20, output: 5 },
      },
    });

    // Envelope with display name and per-model usage when DB is absent
    const stdoutEnvModels = JSON.stringify({
      conversation_id: 'c-models-env',
      model: 'Gemini 4 Argon (Medium)',
      usage: { input_tokens: 300, output_tokens: 40 },
      models: {
        'Gemini 4 Argon (Medium)': { input_tokens: 200, output_tokens: 30 },
        'gemini-3.8-flash': { input_tokens: 100, output_tokens: 10 },
      },
    });
    const parsedEnvModels = agy.usage?.(stdoutEnvModels, {
      mode: 'cli',
      platform: makePlatform(tempHome),
      env: {},
    });
    assert.deepEqual(parsedEnvModels?.actualModels, ['gemini-4-argon', 'gemini-3.8-flash']);
    assert.equal(parsedEnvModels?.actualEffort, 'medium');
    assert.equal(parsedEnvModels?.models?.['gemini-4-argon']?.input, 200);

    // Envelope models map keys accumulate counters across identical slugs and infer key effort
    const stdoutCollision = JSON.stringify({
      conversation_id: 'c-collision',
      usage: { input_tokens: 300, output_tokens: 40 },
      models: {
        'Gemini 4 Argon (Low)': { input_tokens: 150, output_tokens: 20 },
        'Gemini 4 Argon (High)': { input_tokens: 150, output_tokens: 20 },
      },
    });
    const parsedCollision = agy.usage?.(stdoutCollision, {
      mode: 'cli',
      platform: makePlatform(tempHome),
      env: {},
    });
    assert.deepEqual(parsedCollision?.actualModels, ['gemini-4-argon']);
    assert.equal(parsedCollision?.actualEffort, null);
    assert.equal(parsedCollision?.models?.['gemini-4-argon']?.input, 300);

    // Consensus key effort when all model keys agree
    const stdoutAgree = JSON.stringify({
      conversation_id: 'c-agree',
      usage: { input_tokens: 300, output_tokens: 40 },
      models: {
        'Gemini 4 Argon (Medium)': { input_tokens: 150, output_tokens: 20 },
        'Gemini 3.8 Flash (Medium)': { input_tokens: 150, output_tokens: 20 },
      },
    });
    const parsedAgree = agy.usage?.(stdoutAgree, {
      mode: 'cli',
      platform: makePlatform(tempHome),
      env: {},
    });
    assert.deepEqual(parsedAgree?.actualModels, ['gemini-4-argon', 'gemini-3.8-flash']);
    assert.equal(parsedAgree?.actualEffort, 'medium');

    // Traversal conversation_id rejection
    const stdoutTraversal = JSON.stringify({
      conversation_id: '../../x',
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const parsedTraversal = agy.usage?.(stdoutTraversal, {
      mode: 'cli',
      platform: makePlatform(tempHome),
      env: {},
    });
    assert.equal(parsedTraversal?.actualModels, undefined);
    assert.equal(parsedTraversal?.actualEffort, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
