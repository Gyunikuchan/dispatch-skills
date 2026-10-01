import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanOverlay, type FileTable } from './scan.ts';

export const TIERS = [
  'tests/unit/core/', 'tests/unit/policy/', 'tests/unit/domain/', 'tests/unit/providers/', 'tests/unit/lib/', 'tests/unit/machines/',
  'tests/integration/', 'tests/tooling/', 'tests/e2e/',
] as const;

export function checkTestLayout(files: FileTable): string[] {
  return files
    .filter(({ path }) => path.endsWith('.test.ts') && !TIERS.some((tier) => path.startsWith(tier)))
    .map(({ path }) => `test layout rule: ${path} is outside every tier; move it under one of ${TIERS.join(', ')}`);
}

test('every test file sits under a known tier', () => {
  assert.deepEqual(checkTestLayout(scanOverlay()), []);
});

test('a misplaced test fails with the rule and the fix', () => {
  const errors = checkTestLayout([{ path: 'tests/misc/a.test.ts', text: '' }, { path: 'tests/unit/core/b.test.ts', text: '' }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /^test layout rule: tests\/misc\/a\.test\.ts is outside every tier; move it under one of tests\/unit\/core\//);
});
