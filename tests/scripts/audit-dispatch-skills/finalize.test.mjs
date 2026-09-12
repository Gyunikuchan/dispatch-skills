import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';

import { moveEntry } from '../../../.agents/skills/audit-dispatch-skills/scripts/finalize.mjs';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-finalize-'));
});

afterEach(() => {
  mock.restoreAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('finalize: moveEntry', () => {
  it('moves a file to the destination', () => {
    const from = path.join(dir, 'report.md');
    const to = path.join(dir, 'moved.md');
    fs.writeFileSync(from, 'body');

    moveEntry(from, to);

    assert.equal(fs.readFileSync(to, 'utf8'), 'body');
    assert.equal(fs.existsSync(from), false);
  });

  it('moves a directory tree', () => {
    const from = path.join(dir, 'run');
    fs.mkdirSync(path.join(from, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(from, 'nested', 'a.txt'), 'a');
    const to = path.join(dir, 'archived');

    moveEntry(from, to);

    assert.equal(fs.readFileSync(path.join(to, 'nested', 'a.txt'), 'utf8'), 'a');
    assert.equal(fs.existsSync(from), false);
  });

  it('falls back to copy+remove when rename fails with EXDEV', () => {
    // The scratch dir and the OS temp dir are routinely on different volumes.
    const from = path.join(dir, 'x.txt');
    const to = path.join(dir, 'y.txt');
    fs.writeFileSync(from, 'payload');

    mock.method(fs, 'renameSync', () => {
      const err = new Error('cross-device link not permitted');
      err.code = 'EXDEV';
      throw err;
    });

    moveEntry(from, to);

    assert.equal(fs.readFileSync(to, 'utf8'), 'payload');
    assert.equal(fs.existsSync(from), false);
  });

  it('falls back on a lingering-handle EPERM as well', () => {
    const from = path.join(dir, 'p.txt');
    const to = path.join(dir, 'q.txt');
    fs.writeFileSync(from, 'payload');

    mock.method(fs, 'renameSync', () => {
      const err = new Error('operation not permitted');
      err.code = 'EPERM';
      throw err;
    });

    moveEntry(from, to);
    assert.equal(fs.readFileSync(to, 'utf8'), 'payload');
  });

  it('rethrows an unexpected rename error rather than copying blindly', () => {
    const from = path.join(dir, 'r.txt');
    fs.writeFileSync(from, 'payload');

    mock.method(fs, 'renameSync', () => {
      const err = new Error('disk on fire');
      err.code = 'EIO';
      throw err;
    });

    assert.throws(() => moveEntry(from, path.join(dir, 's.txt')), /disk on fire/);
  });
});
