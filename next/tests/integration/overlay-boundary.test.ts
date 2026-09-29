import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractImports, resolveRelative, scanOverlay, type FileTable } from './scan.ts';

/** Overlay invariant (spec §21.2): no relative import from next/** resolves outside next/. */
export function checkOverlayBoundary(files: FileTable): string[] {
  const errors: string[] = [];
  for (const { path: file, text } of files) {
    if (!file.endsWith('.ts')) continue;
    for (const { specifier } of extractImports(text)) {
      const target = resolveRelative(file, specifier);
      if (target !== null && (target === '..' || target.startsWith('../'))) {
        errors.push(`overlay boundary rule: ${file} imports ${specifier}, which leaves next/; copy what you need into the overlay instead`);
      }
    }
  }
  return errors;
}

test('no overlay import leaves next/', () => {
  assert.deepEqual(checkOverlayBoundary(scanOverlay()), []);
});

test('an import escaping next/ fails with the rule and the fix', () => {
  const text = ['imp' + 'ort x from', "'../../../scripts/test-reporter.mjs';"].join(' ');
  assert.deepEqual(checkOverlayBoundary([{ path: 'tests/unit/a.test.ts', text }, { path: 'tests/unit/b.test.ts', text: text.replace('../../../', '../../') }]), [
    'overlay boundary rule: tests/unit/a.test.ts imports ../../../scripts/test-reporter.mjs, which leaves next/; copy what you need into the overlay instead',
  ]);
});
