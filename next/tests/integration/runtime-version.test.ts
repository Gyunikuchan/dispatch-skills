import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanOverlay, type FileTable } from './scan.ts';

// NOTE: overlay-side facts only; engines.node and README runtime-range assertions arrive in I08/I09.
export function checkRuntimeVersion(files: FileTable): string[] {
  const errors: string[] = [];
  for (const { path: file } of files) {
    if (file.endsWith('.mjs')) errors.push(`runtime rule: ${file} is .mjs; the overlay is TypeScript run by type stripping, so rename it to .ts`);
    if (file.split('/').pop() === 'package.json') errors.push(`runtime rule: ${file} is an overlay package.json; .ts resolve as ESM through the root package.json, so delete it`);
  }
  return errors;
}

test('the overlay has no .mjs and no package.json', () => {
  assert.deepEqual(checkRuntimeVersion(scanOverlay()), []);
});

test('violations name the rule and the fix', () => {
  const errors = checkRuntimeVersion([{ path: 'skills/dispatch/scripts/guard.mjs', text: '' }, { path: 'package.json', text: '{}' }]);
  assert.deepEqual(errors, [
    'runtime rule: skills/dispatch/scripts/guard.mjs is .mjs; the overlay is TypeScript run by type stripping, so rename it to .ts',
    'runtime rule: package.json is an overlay package.json; .ts resolve as ESM through the root package.json, so delete it',
  ]);
});
