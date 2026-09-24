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

const entry = (fromName, toName, contents = 'payload') => {
  const from = path.join(dir, fromName);
  const to = path.join(dir, toName);
  fs.writeFileSync(from, contents);
  return { from, to };
};

describe('finalize: moveEntry', () => {
  // SECTION: Native moves

  it('moves a file to the destination', () => {
    const { from, to } = entry('report.md', 'moved.md', 'body');

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

  // SECTION: Portable fallbacks

  for (const code of ['EXDEV', 'EPERM', 'EBUSY']) {
    it(`falls back to copy+remove when rename fails with ${code}`, () => {
      const { from, to } = entry(`${code}-from.txt`, `${code}-to.txt`);
      mock.method(fs, 'renameSync', () => {
        const err = new Error(`rename failed with ${code}`);
        err.code = code;
        throw err;
      });

      moveEntry(from, to);

      assert.equal(fs.readFileSync(to, 'utf8'), 'payload');
      assert.equal(fs.existsSync(from), false);
    });
  }

  // SECTION: Failure boundaries

  it('rethrows an unexpected rename error rather than copying blindly', () => {
    const { from, to } = entry('r.txt', 's.txt');

    mock.method(fs, 'renameSync', () => {
      const err = new Error('disk on fire');
      err.code = 'EIO';
      throw err;
    });

    assert.throws(() => moveEntry(from, to), /disk on fire/);
    assert.equal(fs.readFileSync(from, 'utf8'), 'payload');
    assert.equal(fs.existsSync(to), false);
  });
});
