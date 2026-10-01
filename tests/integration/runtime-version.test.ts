import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanOverlay, type FileTable } from './scan.ts';

// The root package supplies ESM; shipped subtrees must not introduce package boundaries.
export function checkRuntimeVersion(files: FileTable): string[] {
  const errors: string[] = [];
  for (const { path: file } of files) {
    if (file.endsWith('.mjs')) errors.push(`runtime rule: ${file} is .mjs; shipped code is TypeScript run by type stripping, so rename it to .ts`);
    if (file !== 'package.json' && file.split('/').pop() === 'package.json') errors.push(`runtime rule: ${file} is a nested package.json; .ts resolve as ESM through the root package.json, so delete it`);
  }
  return errors;
}

test('shipped code has no .mjs or nested package.json', () => {
  assert.deepEqual(checkRuntimeVersion(scanOverlay()), []);
});

test('violations name the rule and the fix', () => {
  const errors = checkRuntimeVersion([{ path: 'skills/dispatch/scripts/guard.mjs', text: '' }, { path: 'skills/dispatch/package.json', text: '{}' }]);
  assert.deepEqual(errors, [
    'runtime rule: skills/dispatch/scripts/guard.mjs is .mjs; shipped code is TypeScript run by type stripping, so rename it to .ts',
    'runtime rule: skills/dispatch/package.json is a nested package.json; .ts resolve as ESM through the root package.json, so delete it',
  ]);
});
