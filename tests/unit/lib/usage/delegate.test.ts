import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readDelegateSession } from '../../../../skills/dispatch/scripts/lib/usage/delegate.ts';
import type { DelegateQuery, HostUsageFs } from '../../../../skills/dispatch/scripts/lib/usage/rows.ts';
import type { OpencodeMessage, OpencodeRead, OpencodeReadOptions } from '../../../../skills/dispatch/scripts/lib/opencode-db.ts';
import { lines, memoryFs } from './helpers/memory-fs.ts';

function buildVarint(n: number): number[] {
  const bytes: number[] = [];
  let v = n >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return bytes;
}

function buildField(fieldNum: number, wireType: number, payload: number[]): number[] {
  return [...buildVarint((fieldNum << 3) | wireType), ...payload];
}

function buildLengthDelimited(fieldNum: number, data: number[] | Uint8Array): number[] {
  return [...buildField(fieldNum, 2, buildVarint(data.length)), ...data];
}

function buildString(fieldNum: number, s: string): number[] {
  return buildLengthDelimited(fieldNum, Buffer.from(s, 'utf8'));
}

function buildGenMetadataBlob(opts: {
  input?: number;
  output?: number;
  cacheRead?: number;
  reasoning?: number;
  modelSlug?: string;
  displayName?: string;
  lastStepIndex?: number;
}): Uint8Array {
  const tag1: number[] = [];
  const counters: number[] = [];
  if (opts.input !== undefined) counters.push(...buildField(2, 0, buildVarint(opts.input)));
  if (opts.output !== undefined) counters.push(...buildField(3, 0, buildVarint(opts.output)));
  if (opts.cacheRead !== undefined) counters.push(...buildField(5, 0, buildVarint(opts.cacheRead)));
  if (opts.reasoning !== undefined) counters.push(...buildField(9, 0, buildVarint(opts.reasoning)));
  if (counters.length > 0) tag1.push(...buildLengthDelimited(4, counters));
  if (opts.modelSlug !== undefined) tag1.push(...buildString(19, opts.modelSlug));
  if (opts.lastStepIndex !== undefined) {
    const kv = [...buildString(1, 'last_step_index'), ...buildString(2, String(opts.lastStepIndex))];
    tag1.push(...buildLengthDelimited(20, kv));
  }
  if (opts.displayName !== undefined) tag1.push(...buildString(21, opts.displayName));
  return new Uint8Array(buildLengthDelimited(1, tag1));
}

function baseQuery(overrides: Partial<DelegateQuery> & { fs: HostUsageFs }): DelegateQuery {
  return {
    platform: 'claude',
    sessionId: 'sess-1',
    startMs: 10_000,
    endMs: 20_000,
    resumed: true,
    stdoutHasUsage: true,
    home: '/home',
    env: () => undefined,
    cwd: '/repo/my app',
    budget: { remaining: 1024 * 1024 },
    ...overrides,
  };
}

test('claude delegate reads encoded cwd path, nested subagents, and window boundaries without scanning other projects', () => {
  const encoded = '-repo-my-app';
  const sessionFile = `/home/.claude/projects/${encoded}/sess-1.jsonl`;
  const nestedSubagent = `/home/.claude/projects/${encoded}/sess-1/subagents/deep/agent-sub1.jsonl`;
  const otherProject = '/home/.claude/projects/other-proj/sess-1.jsonl';

  const msg = (id: string, atMs: number, input: number, model = 'claude-haiku-5-5', effort?: string) => ({
    type: 'assistant',
    timestamp: new Date(atMs).toISOString(),
    ...(effort ? { effort } : {}),
    message: {
      id,
      model,
      usage: {
        input_tokens: input,
        output_tokens: 10,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 20,
        cache_creation: { ephemeral_5m_input_tokens: 12, ephemeral_1h_input_tokens: 8 },
      },
    },
  });

  const baseFs = memoryFs({
    [sessionFile]: lines(
      msg('before', 9_999, 100),
      msg('at-start', 10_000, 1000, 'claude-haiku-5-5', 'low'),
      msg('at-end', 20_000, 120_000, 'claude-haiku-5-5', 'low'),
      msg('after', 20_001, 100),
    ),
    [nestedSubagent]: lines(msg('sub', 15_000, 500, 'claude-sonnet-5-5', 'high')),
    [otherProject]: lines(msg('other', 15_000, 9999)),
  }, { [nestedSubagent]: 15_000 });

  let listRootCalls = 0;
  const fs: HostUsageFs = {
    ...baseFs,
    list(dir) {
      if (path.normalize(dir) === path.normalize('/home/.claude/projects')) listRootCalls++;
      return baseFs.list(dir);
    },
  };

  const res = readDelegateSession(baseQuery({ platform: 'claude', fs }));
  assert.equal(listRootCalls, 0);
  assert.ok(baseFs.reads.every((r) => !r.includes('other-proj')));
  assert.equal(res.complete, true);
  assert.equal(res.usage?.provenance, 'session');
  assert.equal(res.usage?.scope, 'invocation');
  assert.equal(res.usage?.inputSemantics, 'uncached');
  assert.equal(res.usage?.input, 121_500);
  assert.equal(res.usage?.cacheWrite5m, 36);
  assert.equal(res.usage?.cacheWrite1h, 24);
  assert.deepEqual(res.usage?.models?.['claude-haiku-5-5#low']?.bands, {
    le100k: { input: 1000, output: 10, cacheRead: 5, cacheWrite: 20, cacheWrite5m: 12, cacheWrite1h: 8 },
    le200k: { input: 120_000, output: 10, cacheRead: 5, cacheWrite: 20, cacheWrite5m: 12, cacheWrite1h: 8 },
  });
  assert.deepEqual(res.usage?.models?.['claude-sonnet-5-5#high']?.bands, {
    le100k: { input: 500, output: 10, cacheRead: 5, cacheWrite: 20, cacheWrite5m: 12, cacheWrite1h: 8 },
  });
});

test('codex delegate reads session in window, ignores unrelated concurrent rollout, and handles wholeSecond by resume flag', () => {
  const dateDir = '/home/.codex/sessions/2026/11/14';
  const mainFile = `${dateDir}/rollout-2026-11-14T08-00-00-sess-1.jsonl`;
  const unrelatedFile = `${dateDir}/rollout-2026-11-14T08-00-00-other-sess.jsonl`;

  const turnCtx = (model: string, effort: string) => ({ type: 'turn_context', payload: { model, effort } });
  const tokenCount = (ts: string, total: number, input: number, cached = 0) => ({
    type: 'event_msg',
    timestamp: ts,
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { total_tokens: total },
        last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: 10 },
      },
    },
  });

  const startMs = Date.parse('2026-11-14T08:00:10.500Z');
  const endMs = Date.parse('2026-11-14T08:00:20.000Z');

  const fsWithMs = memoryFs({
    [mainFile]: lines(
      turnCtx('gpt-6.1-terra', 'high'),
      tokenCount('2026-11-14T08:00:15.100Z', 100, 120, 20),
    ),
    [unrelatedFile]: lines(
      { type: 'session_meta', payload: { id: 'other-sess', thread_source: 'cli' } },
      turnCtx('gpt-6.1-terra', 'low'),
      tokenCount('2026-11-14T08:00:15.100Z', 999, 999, 0),
    ),
  }, { [mainFile]: startMs, [unrelatedFile]: startMs });

  const res = readDelegateSession(baseQuery({ platform: 'codex', startMs, endMs, fs: fsWithMs }));
  assert.equal(res.complete, true);
  assert.equal(res.usage?.input, 100);
  assert.equal(res.usage?.cacheRead, 20);
  assert.deepEqual(res.usage?.models?.['gpt-6.1-terra#high']?.bands, {
    le100k: { input: 100, output: 10, cacheRead: 20 },
  });

  const fsWholeSec = memoryFs({
    [mainFile]: lines(
      turnCtx('gpt-6.1-terra', 'high'),
      tokenCount('2026-11-14T08:00:10Z', 100, 50, 0),
    ),
  }, { [mainFile]: startMs });

  assert.equal(readDelegateSession(baseQuery({ platform: 'codex', startMs, endMs, resumed: true, fs: fsWholeSec })).complete, false);
  const freshRes = readDelegateSession(baseQuery({ platform: 'codex', startMs, endMs, resumed: false, fs: fsWholeSec }));
  assert.equal(freshRes.complete, true);
  assert.equal(freshRes.usage?.input, 50);
});

test('opencode delegate reads DB in window, marks truncated or skipped incomplete, and skips query when budget is spent', () => {
  const makeFs = (readImpl: (dbPath: string, sessionId: string, opts: OpencodeReadOptions) => OpencodeRead): HostUsageFs => ({
    ...memoryFs({}),
    opencodeMessages: readImpl,
  });

  const okFs = makeFs(() => ({
    messages: [
      { depth: 0, createdMs: 10_000, model: 'opencode-go/m1', effort: 'high', input: 40, output: 5, reasoning: 2 },
      { depth: 1, createdMs: 15_000, model: 'opencode-go/m1', effort: 'high', input: 60, output: 5 },
    ],
    skipped: 0,
    truncated: null,
  }));
  const ok = readDelegateSession(baseQuery({ platform: 'opencode', fs: okFs }));
  assert.equal(ok.complete, true);
  assert.equal(ok.usage?.input, 100);
  assert.equal(ok.usage?.reasoningInOutput, false);
  assert.deepEqual(ok.usage?.models?.['opencode-go/m1#high']?.bands, {
    le100k: { input: 100, output: 10, reasoning: 2 },
  });

  const truncatedFs = makeFs(() => ({
    messages: [{ depth: 0, createdMs: 12_000, model: 'm', effort: null, input: 10, output: 1 }],
    skipped: 0,
    truncated: 'rows',
  }));
  assert.equal(readDelegateSession(baseQuery({ platform: 'opencode', fs: truncatedFs })).complete, false);

  const skippedFs = makeFs(() => ({
    messages: [{ depth: 0, createdMs: 12_000, model: 'm', effort: null, input: 10, output: 1 }],
    skipped: 1,
    truncated: null,
  }));
  assert.equal(readDelegateSession(baseQuery({ platform: 'opencode', fs: skippedFs })).complete, false);

  let called = 0;
  const spentFs = makeFs((_db, _id, _opts) => {
    called++;
    return { messages: [] as OpencodeMessage[], skipped: 0, truncated: null };
  });
  const spent = readDelegateSession(baseQuery({ platform: 'opencode', fs: spentFs, budget: { remaining: 0 } }));
  assert.equal(spent.complete, false);
  assert.equal(called, 0);
});

test('agy delegate reads mode-profile appDataDir and treats wholeSecond created_at as incomplete on resume and complete when fresh', () => {
  const appDataDir = '/home/.gemini/antigravity-cli';
  const transcript = `${appDataDir}/brain/sess-1/.system_generated/logs/transcript.jsonl`;
  const dbFile = `${appDataDir}/conversations/sess-1.db`;
  const startMs = Date.parse('2026-11-14T08:00:10.500Z');
  const endMs = Date.parse('2026-11-14T08:00:20.000Z');

  const blob = buildGenMetadataBlob({
    input: 200,
    output: 20,
    cacheRead: 50,
    reasoning: 10,
    modelSlug: 'gemini-4-argon',
    displayName: 'Gemini 4 Argon (High)',
    lastStepIndex: 0,
  });

  const makeAgyFs = (createdAt: string): HostUsageFs => ({
    ...memoryFs({
      [transcript]: lines({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: createdAt,
        input_tokens: 200,
        output_tokens: 20,
        cache_read_tokens: 50,
      }),
      [dbFile]: Buffer.from('sqlite'),
    }),
    sqliteGenMetadata: () => [blob],
  });

  const resumedWhole = readDelegateSession(baseQuery({
    platform: 'agy',
    appDataDir,
    startMs,
    endMs,
    resumed: true,
    fs: makeAgyFs('2026-11-14T08:00:10Z'),
  }));
  assert.equal(resumedWhole.complete, false);

  const freshWhole = readDelegateSession(baseQuery({
    platform: 'agy',
    appDataDir,
    startMs,
    endMs,
    resumed: false,
    fs: makeAgyFs('2026-11-14T08:00:10Z'),
  }));
  assert.equal(freshWhole.complete, true);
  assert.equal(freshWhole.usage?.input, 200);
  assert.equal(freshWhole.usage?.reasoning, 10);
  assert.deepEqual(freshWhole.usage?.models?.['gemini-4-argon#high']?.bands, {
    le100k: { input: 200, output: 20, cacheRead: 50, reasoning: 10 },
  });

  // Missing SQLite metadata makes an agy delegate read incomplete
  const noDbFs: HostUsageFs = memoryFs({
    [transcript]: lines({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-14T08:00:12.100Z',
      input_tokens: 200,
      output_tokens: 20,
      cache_read_tokens: 50,
    }),
  });
  assert.equal(readDelegateSession(baseQuery({
    platform: 'agy',
    appDataDir,
    startMs,
    endMs,
    resumed: false,
    fs: noDbFs,
  })).complete, false);
});

test('incomplete reads: missing, unreadable, budget-exhausted, empty window with stdout usage, and traversal id', () => {
  const emptyFs = memoryFs({});
  assert.equal(readDelegateSession(baseQuery({ platform: 'claude', fs: emptyFs })).complete, false);

  const encoded = '-repo-my-app';
  const sessionFile = `/home/.claude/projects/${encoded}/sess-1.jsonl`;
  const noRowsFs = memoryFs({ [sessionFile]: lines({ type: 'system', text: 'hi' }) });
  assert.equal(readDelegateSession(baseQuery({ platform: 'claude', stdoutHasUsage: true, fs: noRowsFs })).complete, false);
  const noUsageOk = readDelegateSession(baseQuery({ platform: 'claude', stdoutHasUsage: false, fs: noRowsFs }));
  assert.equal(noUsageOk.complete, true);
  assert.equal(noUsageOk.usage, undefined);

  const validFileFs = memoryFs({
    [sessionFile]: lines({
      type: 'assistant',
      timestamp: new Date(15_000).toISOString(),
      message: { id: 'm1', model: 'm', usage: { input_tokens: 10, output_tokens: 2 } },
    }),
  });
  assert.equal(readDelegateSession(baseQuery({ platform: 'claude', fs: validFileFs, budget: { remaining: 5 } })).complete, false);

  const throwingFs: HostUsageFs = {
    ...validFileFs,
    read() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  };
  assert.equal(readDelegateSession(baseQuery({ platform: 'claude', fs: throwingFs })).complete, false);

  let accesses = 0;
  const spyFs: HostUsageFs = {
    list() { accesses++; return []; },
    stat() { accesses++; return null; },
    read() { accesses++; return Buffer.alloc(0); },
    decompress: null,
    opencodeMessages() { accesses++; return { messages: [], skipped: 0, truncated: null }; },
    sqliteGenMetadata() { accesses++; return null; },
  };
  for (const platform of ['claude', 'codex', 'opencode', 'agy'] as const) {
    assert.equal(readDelegateSession(baseQuery({ platform, sessionId: '../x', fs: spyFs })).complete, false);
  }
  assert.equal(accesses, 0);
});
