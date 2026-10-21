import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.env['TEXTSTATS_ROOT'];
if (!root) throw new Error('TEXTSTATS_ROOT must name the sample working copy');
const cli = path.join(root, 'bin', 'textstats.js');

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function withTextFile(text, fn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'textstats-acceptance-'));
  const file = path.join(directory, 'input.txt');
  fs.writeFileSync(file, text);
  try {
    return fn(file);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('textstats prints counts, lines, and ranked words as JSON', () => {
  withTextFile('Red red blue.\nBlue green', (file) => {
    const result = runCli([file, '--top', '2']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      words: 5,
      unique: 3,
      lines: 2,
      top: [
        { word: 'blue', count: 2 },
        { word: 'red', count: 2 },
      ],
    });
  });
});

test('textstats reports a missing file with exit code two and its path', () => {
  const missing = path.join(root, 'missing-input.txt');
  const result = runCli([missing]);
  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes(missing));
});

test('textstats rejects an invalid top value with exit code one', () => {
  withTextFile('one two', (file) => {
    const result = runCli([file, '--top', '1.5']);
    assert.equal(result.status, 1);
    assert.notEqual(result.stderr.trim(), '');
  });
});
