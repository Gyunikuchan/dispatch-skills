import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { zstdCompressSync } from 'node:zlib';
import { nodeHostUsageFs, readHostUsage } from '../../../../skills/dispatch/scripts/toolkit/host-usage/index.ts';
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
