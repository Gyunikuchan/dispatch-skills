import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { ADAPTERS, nodeHostUsageFs, readHostUsage } from '../../../../skills/dispatch/scripts/toolkit/host-usage/index.ts';
import { readOpencodeMessages } from '../../../../skills/dispatch/scripts/lib/opencode-db.ts';
import { readTranscript, stageAt } from '../../../../skills/dispatch/scripts/toolkit/host-usage/read.ts';
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES } from '../../../../skills/dispatch/scripts/toolkit/host-usage/types.ts';
import { memoryFs, query } from './helpers/memory-fs.ts';

const input = { ...query, env: (_: string): string | undefined => undefined };

test('registry requires a registered host and its declared safe session id', () => {
  const fs = memoryFs({});
  assert.equal(readHostUsage(null, input, fs).unavailable, 'no adapter');
  assert.equal(readHostUsage('codex', { ...input, env: name => name === 'DISPATCH_CHAT_ID' ? 'host' : undefined }, fs).unavailable, 'no host id');
  assert.equal(readHostUsage('codex', { ...input, env: () => '../host' }, fs).unavailable, 'invalid host id');
  const invalidStart = readHostUsage('codex', { ...input, startMs: NaN, env: () => 'host' }, fs);
  assert.equal(invalidStart.unavailable, 'invalid session start');
  assert.deepEqual(fs.reads, []);
  const result = readHostUsage('codex', { ...input, env: () => 'host' }, fs, {
    codex: { sessionEnv: ['CODEX_THREAD_ID'], read: q => ({ rows: [{ stage: 'spec', role: 'host', model: 'm', effort: null, input: q.budget.remaining, output: 0 }] }) },
  });
  assert.equal(result.rows[0]?.input, MAX_TOTAL_BYTES);
});

test('registry covers every host platform and accepts OpenCode host ids', () => {
  assert.deepEqual(Object.keys(ADAPTERS).sort(), ['agy', 'claude', 'codex', 'opencode']);
  assert.equal(typeof nodeHostUsageFs.opencodeMessages, 'function');
  assert.equal(nodeHostUsageFs.opencodeMessages, readOpencodeMessages);
  let calls = 0;
  const read = (id: string | undefined) => readHostUsage('opencode', { ...input, env: () => id }, {
    ...memoryFs({}),
    opencodeMessages: () => { calls++; return { messages: [], skipped: 0, truncated: null }; },
  });
  assert.equal(read(undefined).unavailable, 'no host id');
  assert.equal(read('ses_session-1').unavailable, 'no usage records');
  assert.equal(calls, 1);
  for (const id of ['ses/1', 'ses_1.2', '../ses_1']) {
    assert.equal(read(id).unavailable, 'invalid host id');
  }
  assert.equal(calls, 1);
});

test('reader caps growing plain files and decoded compressed data', () => {
  let readMax = 0; let size = 1; let reads = 0;
  assert.ok(nodeHostUsageFs.decompress);
  const fs = {
    list: () => [],
    stat: () => ({ size, mtimeMs: 0 }),
    read: (_: string, max: number) => { reads++; readMax = max; return Buffer.alloc(max); },
    decompress: nodeHostUsageFs.decompress,
  };
  const budget = { remaining: 4 };
  assert.equal(readTranscript(fs, 'x', budget).stop, 'budget');
  assert.equal(readMax, 5);
  assert.equal(budget.remaining, 0);

  let budgetReads = 0;
  const budgetFs = {
    ...fs,
    stat: () => ({ size: 6, mtimeMs: 0 }),
    read: () => { budgetReads++; return Buffer.alloc(0); },
  };
  assert.equal(readTranscript(budgetFs, 'x', { remaining: 5 }).stop, 'budget');
  assert.equal(budgetReads, 0);

  const compressed = zstdCompressSync(Buffer.from('abcdefghij'));
  const compressedFs = { ...fs, stat: () => ({ size: compressed.length, mtimeMs: 0 }), read: () => compressed };
  const decoded = { remaining: 20 };
  assert.equal(readTranscript(compressedFs, 'x.zst', decoded).text, 'abcdefghij');
  assert.equal(decoded.remaining, 10);
  const stopped = { remaining: 5 };
  assert.equal(readTranscript(compressedFs, 'x.zst', stopped).stop, 'budget');
  assert.equal(stopped.remaining, 0);

  size = MAX_FILE_BYTES + 1;
  assert.equal(readTranscript(fs, 'x', { remaining: MAX_TOTAL_BYTES }).stop, 'file cap');
  size = MAX_FILE_BYTES * 2 + 1;
  assert.equal(readTranscript(fs, 'x.zst', { remaining: 1 }).stop, 'file cap');
  assert.equal(reads, 1);

  const overflowFs = { list: () => [], stat: () => ({ size: 1, mtimeMs: 0 }), read: () => Buffer.from('x'), decompress: () => { throw Object.assign(Error('large'), { code: 'ERR_BUFFER_TOO_LARGE' }); } }; const overflowBudget = { remaining: MAX_FILE_BYTES * 2 };
  assert.equal(readTranscript(overflowFs, 'a.zst', overflowBudget).stop, 'file cap'); assert.equal(overflowBudget.remaining, MAX_FILE_BYTES);
  assert.equal(readTranscript(overflowFs, 'b.zst', overflowBudget).stop, 'file cap'); assert.equal(overflowBudget.remaining, 0);
  assert.equal(readTranscript(overflowFs, 'c.zst', overflowBudget).stop, 'budget');
});

test('adapter exceptions expose allowlisted codes without their messages', () => {
  const invoke = (code: string) => readHostUsage('codex', { ...input, env: () => 'host' }, memoryFs({}), {
    codex: { sessionEnv: ['CODEX_THREAD_ID'], read: () => { throw Object.assign(new Error('secret'), { code }); } },
  });
  assert.equal(invoke('EACCES').unavailable, 'read-error:EACCES');
  assert.equal(invoke('SECRET').unavailable, 'read-error:EUNKNOWN');
  assert.ok(!JSON.stringify(invoke('SECRET')).includes('secret'));
});

test('events before all stage milestones use the first stage', () => {
  assert.equal(stageAt([{ stage: 'spec', atMs: 100 }, { stage: 'plan', atMs: 200 }], 0), 'spec');
});

test('node filesystem treats paths beneath regular files as absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-usage-')); const file = path.join(dir, 'file');
  try { fs.writeFileSync(file, 'x'); assert.deepEqual(nodeHostUsageFs.list(path.join(file, 'missing')), []); assert.equal(nodeHostUsageFs.stat(path.join(file, 'missing')), null); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('host discovery ignores non-directory entries without masking missing ids', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-discovery-'));
  try {
    const projects = path.join(home, '.claude', 'projects'); const sessions = path.join(home, '.codex', 'sessions');
    fs.mkdirSync(path.join(projects, 'project'), { recursive: true }); fs.mkdirSync(path.join(sessions, '1970', '01', '01'), { recursive: true });
    fs.writeFileSync(path.join(projects, '.DS_Store'), 'x'); fs.writeFileSync(path.join(sessions, '1999'), 'x');
    const claude = { type: 'assistant', timestamp: new Date(3000).toISOString(), message: { id: 'x', model: 'm', usage: { input_tokens: 2, output_tokens: 1 } } };
    const context = { type: 'turn_context', payload: { model: 'm' } }; const event = { type: 'event_msg', timestamp: new Date(3000).toISOString(), payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 3 }, last_token_usage: { input_tokens: 2, output_tokens: 1 } } } };
    fs.writeFileSync(path.join(projects, 'project', 'host.jsonl'), JSON.stringify(claude)); fs.writeFileSync(path.join(sessions, '1970', '01', '01', 'rollout-1970-01-01T00-00-01-host.jsonl'), [context, event].map(x => JSON.stringify(x)).join('\n'));
    for (const platform of ['claude', 'codex'] as const) {
      const result = readHostUsage(platform, { ...input, home, env: name => name === 'CODEX_THREAD_ID' || name === 'CLAUDE_CODE_SESSION_ID' ? 'host' : undefined }, nodeHostUsageFs); assert.equal(result.unavailable, undefined); assert.equal(result.rows.length, 1);
      const missing = readHostUsage(platform, { ...input, home, env: name => name === 'CODEX_THREAD_ID' || name === 'CLAUDE_CODE_SESSION_ID' ? 'missing' : undefined }, nodeHostUsageFs); assert.equal(missing.unavailable, 'host id file missing');
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('agy adapter is registered and reads sqlite gen_metadata via nodeHostUsageFs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-discovery-'));
  try {
    const brain = path.join(home, '.gemini', 'antigravity', 'brain', 'host-session', '.system_generated', 'logs');
    const conv = path.join(home, '.gemini', 'antigravity', 'conversations');
    fs.mkdirSync(brain, { recursive: true });
    fs.mkdirSync(conv, { recursive: true });

    const step = {
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      created_at: new Date(3000).toISOString(),
      input_tokens: 120,
      output_tokens: 15,
      cache_read_tokens: 30,
    };
    fs.writeFileSync(path.join(brain, 'transcript.jsonl'), JSON.stringify(step) + '\n');

    const dbPath = path.join(conv, 'host-session.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE gen_metadata (idx INTEGER, data BLOB)');
      // Build protobuf blob: Tag 1.4 (input: 120, output: 15, cacheRead: 30, reasoning: 10), Tag 1.19, Tag 1.20, Tag 1.21
      const tag14 = [
        ...[0x10, 120], // tag 2, varint 120
        ...[0x18, 15],  // tag 3, varint 15
        ...[0x28, 30],  // tag 5, varint 30
        ...[0x48, 10],  // tag 9, varint 10
      ];
      const kv = [
        ...[0x0a, 15], ...Buffer.from('last_step_index', 'utf8'),
        ...[0x12, 1], ...Buffer.from('1', 'utf8'),
      ];
      const modelSlug = Buffer.from('gemini-4-argon-trial', 'utf8');
      const dispName = Buffer.from('Gemini 4 Argon (Medium)', 'utf8');
      const tag1 = [
        ...[0x22, tag14.length], ...tag14,
        ...[0x9a, 0x01, modelSlug.length], ...modelSlug,
        ...[0xa2, 0x01, kv.length], ...kv,
        ...[0xaa, 0x01, dispName.length], ...dispName,
      ];
      const blob = new Uint8Array([0x0a, tag1.length, ...tag1]);
      const stmt = db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');
      stmt.run(0, blob);
    } finally {
      db.close();
    }

    assert.ok(nodeHostUsageFs.sqliteGenMetadata, 'sqliteGenMetadata is defined on nodeHostUsageFs');
    const readBlobs = nodeHostUsageFs.sqliteGenMetadata(dbPath);
    assert.equal(readBlobs?.length, 1);

    const result = readHostUsage('agy', {
      ...input,
      home,
      env: (name) => (name === 'ANTIGRAVITY_CONVERSATION_ID' ? 'host-session' : undefined),
    }, nodeHostUsageFs);

    assert.equal(result.unavailable, undefined);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.role, 'host');
    assert.equal(result.rows[0]?.model, 'gemini-4-argon');
    assert.equal(result.rows[0]?.effort, 'medium');
    assert.equal(result.rows[0]?.input, 120);
    assert.equal(result.rows[0]?.output, 15);
    assert.equal(result.rows[0]?.cacheRead, 30);
    assert.equal(result.rows[0]?.reasoning, 10);

    const missing = readHostUsage('agy', {
      ...input,
      home,
      env: (name) => (name === 'ANTIGRAVITY_CONVERSATION_ID' ? 'missing-session' : undefined),
    }, nodeHostUsageFs);
    assert.equal(missing.unavailable, 'host id file missing');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
