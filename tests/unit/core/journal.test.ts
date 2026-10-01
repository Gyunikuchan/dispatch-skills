import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { appendEvent, EngineFault, journalPath, readJournal } from '../../../skills/dispatch/scripts/core/journal.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';

const line = (seq: number, v = 1) => `${JSON.stringify({ seq, v, at: '2026-01-01T00:00:00.000Z', type: 'LOCK_BROKEN', data: { stalePid: 1 } })}\n`;

test('appends contiguous seq lines with v 1 and an ISO timestamp', () => {
  const ports = fakePorts();
  const run = tempDir();
  appendEvent(ports, run, 'LOCK_BROKEN', { stalePid: 7 });
  const second = appendEvent(ports, run, 'LOCK_BROKEN', { stalePid: 8 });
  assert.deepEqual(second, { seq: 2, v: 1, at: '2026-01-01T00:00:00.000Z', type: 'LOCK_BROKEN', data: { stalePid: 8 } });
  const read = readJournal(ports, run);
  assert.deepEqual(read.lines.map((entry) => entry.seq), [1, 2]);
  assert.equal(read.tornTail, false);
  assert.equal(read.goodBytes, fs.statSync(journalPath(run)).size);
});

test('drops a torn last line without a trailing newline and logs it', () => {
  const ports = fakePorts();
  const run = tempDir();
  fs.writeFileSync(journalPath(run), `${line(1)}{"seq":2,"v":1`);
  const read = readJournal(ports, run);
  assert.equal(read.lines.length, 1);
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
  assert.deepEqual(readJournal(fakePorts(), path.join(tempDir(), 'none')), { lines: [], tornTail: false, goodBytes: 0 });
});
