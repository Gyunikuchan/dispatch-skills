import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { OVERLAY_ROOT, scanOverlay, type FileTable } from './scan.ts';

// Count the real Git/subprocess suites and their shared repository helper.
export const E2E_CAP = 15;
const e2eFiles = () => scanOverlay(path.join(OVERLAY_ROOT, 'tests/e2e')).map(file => ({ ...file, path: 'tests/e2e/' + file.path }));

export function checkE2eCap(files: FileTable, cap = E2E_CAP): string[] {
  const e2e = files.filter((file) => file.path.startsWith('tests/e2e/'));
  return e2e.length > cap
    ? [`e2e cap rule: tests/e2e/ holds ${e2e.length} files (cap ${cap}); cover the behaviour in tiers 1-5, or raise E2E_CAP in an explicit edit`]
    : [];
}

test('tests/e2e/ stays within the cap', () => {
  const files = e2eFiles();
  assert.equal(files.filter(file => file.path.startsWith('tests/e2e/')).length, 15);
  assert.deepEqual(checkE2eCap(files), []);
});

test('exceeding the cap fails with the rule and the fix', () => {
  const files = ['a', 'b', 'c', 'd'].map((name) => ({ path: `tests/e2e/${name}.test.ts`, text: '' }));
  assert.deepEqual(checkE2eCap(files, 3), ['e2e cap rule: tests/e2e/ holds 4 files (cap 3); cover the behaviour in tiers 1-5, or raise E2E_CAP in an explicit edit']);
});
