import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanOverlay, type FileTable } from './scan.ts';

// The root manifest is not shipped, so the script tree declares its own type; other subtrees must not introduce package boundaries.
export function checkRuntimeVersion(files: FileTable): string[] {
  const errors: string[] = [];
  for (const { path: file } of files) {
    if (file.endsWith('.mjs')) errors.push(`runtime rule: ${file} is .mjs; shipped code is TypeScript run by type stripping, so rename it to .ts`);
    // The sample manifest belongs to a disposable external repository. The scripts manifest declares the shipped module type.
    if (file !== 'package.json' && file !== 'docs/evaluations/samples/textstats/package.json' && file !== 'skills/dispatch/scripts/package.json' && file.split('/').pop() === 'package.json') errors.push(`runtime rule: ${file} is a nested package.json; the root manifest is not shipped, so only skills/dispatch/scripts/package.json may declare the module type`);
  }
  return errors;
}

test('shipped code has no .mjs or nested package.json and violations identify the runtime rule', () => {
  assert.deepEqual(checkRuntimeVersion(scanOverlay(undefined, false)), []);
  const errors = checkRuntimeVersion([{ path: 'skills/dispatch/scripts/guard.mjs', text: '' }, { path: 'skills/dispatch/package.json', text: '{}' }]);
  assert.deepEqual(errors, [
    'runtime rule: skills/dispatch/scripts/guard.mjs is .mjs; shipped code is TypeScript run by type stripping, so rename it to .ts',
    'runtime rule: skills/dispatch/package.json is a nested package.json; the root manifest is not shipped, so only skills/dispatch/scripts/package.json may declare the module type',
  ]);
  assert.deepEqual(checkRuntimeVersion([{ path: 'skills/dispatch/scripts/package.json', text: '{"type":"module"}' }]), []);
  assert.equal(checkRuntimeVersion([{ path: 'skills/dispatch/scripts/lib/package.json', text: '{}' }]).length, 1);
  assert.deepEqual(checkRuntimeVersion([{ path: 'docs/evaluations/samples/textstats/package.json', text: '{}' }]), []);
  assert.equal(checkRuntimeVersion([{ path: 'docs/evaluations/samples/textstats/src/package.json', text: '{}' }]).length, 1);
});
