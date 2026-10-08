import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { appendEvent, EngineFault, journalPath, readJournal } from '../../../skills/dispatch/scripts/core/journal.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';

const line = (seq: number, v = 1) => `${JSON.stringify({ seq, v, at: '2026-01-01T00:00:00.000Z', type: 'LOCK_BROKEN', data: { stalePid: 1 } })}\n`;

test('journal stream: invalid UTF-8 names the physical mid-file line and preserves final tail repair', () => {
  const ports = fakePorts(), run = tempDir(), bad = Buffer.from([0xff, 10]);
  fs.writeFileSync(journalPath(run), Buffer.concat([Buffer.from(line(1)), bad, Buffer.from(line(3))]));
  assert.throws(() => readJournal(ports, run), /line 2 mid-file \(invalid UTF-8\)/);
  fs.writeFileSync(journalPath(run), Buffer.concat([Buffer.from(line(1)), bad]));
  const read = readJournal(ports, run); assert.equal(read.count, 1); assert.equal(read.tornTail, true); assert.equal(read.goodBytes, Buffer.byteLength(line(1)));
});

test('journal stream: split UTF-8 and byte-accurate torn tails retain bounded summaries', () => {
  const ports = fakePorts(), run = tempDir();
  const complete = `${JSON.stringify({ seq: 1, v: 1, at: 'now', type: 'AUTHORED', data: { path: '日本語.plan.md' } })}\n`;
  const bytes = Buffer.from(complete + '{"seq":2');
  fs.writeFileSync(journalPath(run), bytes);
  let closed = 0;
  ports.fs.readChunks = function* () { try { for (let i = 0; i < bytes.length; i++) yield bytes.subarray(i, i + 1); } finally { closed++; } };
  ports.fs.readText = () => { throw new Error('whole-file read'); };
  const read = readJournal(ports, run);
  assert.equal(read.authored?.data['path'], '日本語.plan.md');
  assert.equal(read.goodBytes, Buffer.byteLength(complete));
  assert.equal(read.count, 1); assert.equal(read.tornTail, true);
  assert.equal(Array.from(read.records).length, 1); assert.equal(closed, 2);
  for (const _ of read.records) break;
  assert.equal(closed, 3);
});

test('appends contiguous seq lines with v 1 and an ISO timestamp', () => {
  const ports = fakePorts();
  const run = tempDir();
  appendEvent(ports, run, 'LOCK_BROKEN', { stalePid: 7 });
  const second = appendEvent(ports, run, 'LOCK_BROKEN', { stalePid: 8 });
  assert.deepEqual(second, { seq: 2, v: 1, at: '2026-01-01T00:00:00.000Z', type: 'LOCK_BROKEN', data: { stalePid: 8 } });
  const read = readJournal(ports, run);
  assert.deepEqual(Array.from(read.records).map((entry) => entry.seq), [1, 2]);
  assert.equal(read.tornTail, false);
  assert.equal(read.goodBytes, fs.statSync(journalPath(run)).size);
});

test('drops a torn last line without a trailing newline and logs it', () => {
  const ports = fakePorts();
  const run = tempDir();
  fs.writeFileSync(journalPath(run), `${line(1)}{"seq":2,"v":1`);
  const read = readJournal(ports, run);
  assert.equal(Array.from(read.records).length, 1);
  assert.equal(read.tornTail, true);
  assert.equal(read.goodBytes, Buffer.byteLength(line(1)));
  assert.match(ports.stderrLines.join(''), /torn last journal line/);
});

test('drops an unparseable last line that has a trailing newline', () => {
  const ports = fakePorts();
  const run = tempDir();
  fs.writeFileSync(journalPath(run), `${line(1)}garbage\n`);
  assert.equal(readJournal(ports, run).tornTail, true);
});

test('mid-file corruption is an engine fault', () => {
  const run = tempDir();
  fs.writeFileSync(journalPath(run), `${line(1)}garbage\n${line(3)}`);
  assert.throws(() => readJournal(fakePorts(), run), (error: unknown) => error instanceof EngineFault && /mid-file/.test(error.message));
});

test('a seq gap is an engine fault', () => {
  const run = tempDir();
  fs.writeFileSync(journalPath(run), `${line(1)}${line(3)}`);
  assert.throws(() => readJournal(fakePorts(), run), /seq gap/);
});

test('v other than 1 is refused as an engine fault', () => {
  const run = tempDir();
  fs.writeFileSync(journalPath(run), `${line(1)}${line(2, 2)}`);
  assert.throws(() => readJournal(fakePorts(), run), /v=2/);
});

test('a missing journal reads as empty', () => {
  const { records, ...metadata } = readJournal(fakePorts(), path.join(tempDir(), 'none')); assert.deepEqual(Array.from(records), []); assert.deepEqual(metadata, { count: 0, recent: [], tornTail: false, goodBytes: 0 });
});
