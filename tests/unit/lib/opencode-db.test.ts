import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { opencodeDbPath, readOpencodeMessages } from '../../../skills/dispatch/scripts/lib/opencode-db.ts';

type SessionSeed = { id: string; parentId?: string };
type MessageSeed = { sessionId: string; seq: number; createdMs: number; data: unknown; type?: string; id?: string };

function databasePath(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'opencode.db');
}

function seedDatabase(dbPath: string, sessions: SessionSeed[], messages: MessageSeed[]): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT)');
    db.exec('CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)');
    const insertSession = db.prepare('INSERT INTO session_v2 (id, parent_id) VALUES (?, ?)');
    for (const session of sessions) insertSession.run(session.id, session.parentId ?? null);
    const insertMessage = db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)');
    messages.forEach((message, index) => insertMessage.run(
      message.id ?? `m${index}`,
      message.sessionId,
      message.type ?? 'assistant',
      message.seq,
      message.createdMs,
      JSON.stringify(message.data),
    ));
  } finally {
    db.close();
  }
}

const assistant = (tokens: unknown, model?: unknown) => ({
  ...(model === undefined ? {} : { model }),
  ...(tokens === undefined ? {} : { tokens }),
});

test('readOpencodeMessages returns root and nested descendant messages with model effort and counters', t => {
  const dbPath = databasePath(t);
  seedDatabase(dbPath,
    [{ id: 'root' }, { id: 'child', parentId: 'root' }, { id: 'grandchild', parentId: 'child' }],
    [
      { sessionId: 'root', seq: 1, createdMs: 1000, data: assistant(
        { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
        { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'max' },
      ) },
      { sessionId: 'child', seq: 1, createdMs: 2000, data: assistant(
        { input: 20, output: 5 },
        { providerID: 'opencode-go', id: 'muse-spark', variant: 'high' },
      ) },
      { sessionId: 'grandchild', seq: 1, createdMs: 3000, data: assistant(
        { input: 30, output: 6 },
        { providerID: 'opencode-go', id: 'muse-spark' },
      ) },
    ]);

  assert.deepEqual(readOpencodeMessages(dbPath, 'root', { fromMs: 0, toMs: 5000 }), {
    messages: [
      { depth: 0, createdMs: 1000, model: 'opencode-go/deepseek-v4.1-flash', effort: 'max', input: 10, output: 4, reasoning: 2, cacheRead: 3, cacheWrite: 1 },
      { depth: 1, createdMs: 2000, model: 'opencode-go/muse-spark', effort: 'high', input: 20, output: 5 },
      { depth: 2, createdMs: 3000, model: 'opencode-go/muse-spark', effort: null, input: 30, output: 6 },
    ],
    skipped: 0,
    truncated: null,
  });
});

test('readOpencodeMessages filters to the window and counts rows without valid counters as skipped', t => {
  const dbPath = databasePath(t);
  const model = { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'max' };
  seedDatabase(dbPath, [{ id: 'root' }], [
    { sessionId: 'root', seq: 1, createdMs: 500, data: assistant({ input: 1, output: 1 }, model) },
    { sessionId: 'root', seq: 2, createdMs: 1500, data: assistant({ input: 5, output: 1 }, model) },
    { sessionId: 'root', seq: 3, createdMs: 2000, type: 'user', data: assistant({ input: 99, output: 99 }, model) },
    { sessionId: 'root', seq: 4, createdMs: 2000, data: assistant(undefined, model) },
    { sessionId: 'root', seq: 5, createdMs: 2500, data: assistant({ input: -1, output: 2 }, model) },
    { sessionId: 'root', seq: 6, createdMs: 3000, data: assistant({ input: 7, output: 2, reasoning: 'none' }, model) },
    { sessionId: 'root', seq: 7, createdMs: 3500, data: assistant({ input: 2, output: 2 }, model) },
  ]);

  assert.deepEqual(readOpencodeMessages(dbPath, 'root', { fromMs: 1000, toMs: 3000 }), {
    messages: [
      { depth: 0, createdMs: 1500, model: 'opencode-go/deepseek-v4.1-flash', effort: 'max', input: 5, output: 1 },
    ],
    skipped: 3,
    truncated: null,
  });
});

test('readOpencodeMessages returns descendant messages when the root has none', t => {
  const dbPath = databasePath(t);
  seedDatabase(dbPath, [{ id: 'root' }, { id: 'child', parentId: 'root' }], [
    { sessionId: 'root', seq: 1, createdMs: 1000, type: 'model-switched', data: { model: { providerID: 'opencode-go', id: 'other' } } },
    { sessionId: 'child', seq: 1, createdMs: 2000, data: assistant({ input: 8, output: 3 }, { providerID: 'opencode-go', id: 'child-model' }) },
    { sessionId: 'child', seq: 2, createdMs: 3000, data: assistant({ input: 9, output: 2 }, { providerID: 'opencode-go' }) },
  ]);

  assert.deepEqual(readOpencodeMessages(dbPath, 'root', { fromMs: 0, toMs: 5000 }).messages, [
    { depth: 1, createdMs: 2000, model: 'opencode-go/child-model', effort: null, input: 8, output: 3 },
    { depth: 1, createdMs: 3000, model: null, effort: null, input: 9, output: 2 },
  ]);
});

test('readOpencodeMessages caps descendant sessions with one session cap across breadth and depth', t => {
  const breadthPath = databasePath(t);
  seedDatabase(breadthPath, [
    { id: 'root' },
    { id: 'a', parentId: 'root' },
    { id: 'b', parentId: 'root' },
    { id: 'c', parentId: 'root' },
    { id: 'a1', parentId: 'a' },
  ], [
    { sessionId: 'root', seq: 1, createdMs: 1000, data: assistant({ input: 1, output: 1 }) },
    { sessionId: 'a', seq: 1, createdMs: 2000, data: assistant({ input: 2, output: 1 }) },
    { sessionId: 'b', seq: 1, createdMs: 3000, data: assistant({ input: 3, output: 1 }) },
    { sessionId: 'c', seq: 1, createdMs: 4000, data: assistant({ input: 4, output: 1 }) },
    { sessionId: 'a1', seq: 1, createdMs: 5000, data: assistant({ input: 5, output: 1 }) },
  ]);

  const breadth = readOpencodeMessages(breadthPath, 'root', { fromMs: 0, toMs: 10000, maxSessions: 2 });

  assert.equal(breadth.truncated, 'sessions');
  assert.deepEqual(breadth.messages.map(message => [message.depth, message.input]), [[0, 1], [1, 2], [1, 3]]);

  const chainPath = databasePath(t);
  seedDatabase(chainPath, [
    { id: 'root' },
    { id: 'a', parentId: 'root' },
    { id: 'b', parentId: 'a' },
    { id: 'c', parentId: 'b' },
  ], [
    { sessionId: 'root', seq: 1, createdMs: 1000, data: assistant({ input: 1, output: 1 }) },
    { sessionId: 'a', seq: 1, createdMs: 2000, data: assistant({ input: 2, output: 1 }) },
    { sessionId: 'b', seq: 1, createdMs: 3000, data: assistant({ input: 3, output: 1 }) },
    { sessionId: 'c', seq: 1, createdMs: 4000, data: assistant({ input: 4, output: 1 }) },
  ]);

  const chain = readOpencodeMessages(chainPath, 'root', { fromMs: 0, toMs: 10000, maxSessions: 2 });

  assert.equal(chain.truncated, 'sessions');
  assert.deepEqual(chain.messages.map(message => [message.depth, message.input]), [[0, 1], [1, 2], [2, 3]]);
});

test('readOpencodeMessages caps message rows and reports row truncation', t => {
  const dbPath = databasePath(t);
  seedDatabase(dbPath, [{ id: 'root' }], [1000, 2000, 3000, 4000].map((createdMs, index) => ({
    sessionId: 'root',
    seq: index + 1,
    createdMs,
    data: assistant({ input: index + 1, output: 1 }),
  })));

  const read = readOpencodeMessages(dbPath, 'root', { fromMs: 0, toMs: 10000, maxRows: 2 });
  assert.deepEqual(read.messages.map(message => message.createdMs), [1000, 2000]);
  assert.equal(read.truncated, 'rows');
  assert.equal(read.skipped, 0);

  assert.deepEqual(readOpencodeMessages(dbPath, 'root', { fromMs: 0, toMs: 10000, maxRows: 0 }), {
    messages: [],
    skipped: 0,
    truncated: 'rows',
  });
});

test('readOpencodeMessages throws ENOENT for a missing database without creating it', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'nested', 'opencode.db');

  assert.throws(
    () => readOpencodeMessages(dbPath, 'root', { fromMs: 0, toMs: 1000 }),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
  );
  assert.equal(fs.existsSync(dbPath), false);
});

test('readOpencodeMessages resolves its database under XDG_DATA_HOME or the home data directory', () => {
  assert.equal(
    opencodeDbPath('/home/me', name => name === 'XDG_DATA_HOME' ? '/data/opencode' : undefined),
    path.join('/data/opencode', 'opencode', 'opencode.db'),
  );
  assert.equal(
    opencodeDbPath('/home/me', () => undefined),
    path.join('/home/me', '.local', 'share', 'opencode', 'opencode.db'),
  );
  assert.equal(
    opencodeDbPath('/home/me', name => name === 'XDG_DATA_HOME' ? '' : undefined),
    path.join('/home/me', '.local', 'share', 'opencode', 'opencode.db'),
  );
});
