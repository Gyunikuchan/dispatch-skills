import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanOverlay, type FileTable } from './scan.ts';

// Count the real Git/subprocess suites and their shared repository helper.
export const E2E_CAP = 15;

export function checkE2eCap(files: FileTable, cap = E2E_CAP): string[] {
  const e2e = files.filter((file) => file.path.startsWith('tests/e2e/'));
  return e2e.length > cap
    ? [`e2e cap rule: tests/e2e/ holds ${e2e.length} files (cap ${cap}); cover the behaviour in tiers 1-5, or raise E2E_CAP in an explicit edit`]
    : [];
}

test('tests/e2e/ stays within the cap', () => {
  const files = scanOverlay();
  assert.equal(files.filter(file => file.path.startsWith('tests/e2e/')).length, E2E_CAP);
  assert.deepEqual(checkE2eCap(files), []);
});

test('e2e consumers use toolkit results without legacy frame helpers', () => {
  const files = scanOverlay();
  for (const name of ['driver-authority', 'plan-replacement', 'quota-routing', 'recovery', 'review', 'self-build-preparation', 'spec-stage']) {
    assert.equal(files.some(file => file.path === 'tests/e2e/' + name + '.test.ts'), false, name);
  }
  for (const file of files.filter(file => file.path.startsWith('tests/e2e/') || file.path === 'tests/helpers/e2e.ts')) {
    assert.doesNotMatch(file.text, /import\s+(?:type\s+)?\{[^}]*\bFrame\b[^}]*\}\s+from/, file.path);
  }
  const implement = files.find(file => file.path === 'tests/e2e/implement.test.ts')!;
  const names = [...implement.text.matchAll(/\btest\(['"]([^'"]+)['"]/g)].map(match => match[1]!);
  assert.ok(names.length > 0);
  assert.ok(names.every(name => name.startsWith('checkout:')), names.join(', '));
  for (const name of ['implement', 'observation-boundary']) {
    assert.doesNotMatch(files.find(file => file.path === 'tests/e2e/' + name + '.test.ts')!.text, /\bf\.(?:cli|begin|reply|rebind|initialize)\s*\(/);
  }
});

test('exceeding the cap fails with the rule and the fix', () => {
  const files = ['a', 'b', 'c', 'd'].map((name) => ({ path: `tests/e2e/${name}.test.ts`, text: '' }));
  assert.deepEqual(checkE2eCap(files, 3), ['e2e cap rule: tests/e2e/ holds 4 files (cap 3); cover the behaviour in tiers 1-5, or raise E2E_CAP in an explicit edit']);
});
