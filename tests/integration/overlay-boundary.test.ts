import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractImports, resolveRelative, scanOverlay, type FileTable } from './scan.ts';

/** Shipped relative imports stay inside the repository tree. */
export function checkOverlayBoundary(files: FileTable): string[] {
  const errors: string[] = [];
  for (const { path: file, text } of files) {
    if (!file.endsWith('.ts')) continue;
    for (const { specifier } of extractImports(text)) {
      const target = resolveRelative(file, specifier);
      if (target !== null && (target === '..' || target.startsWith('../'))) {
        errors.push(`overlay boundary rule: ${file} imports ${specifier}, which leaves the repository; keep dependencies inside the shipped tree`);
      }
    }
  }
  return errors;
}

test('no shipped import leaves the repository', () => {
  assert.deepEqual(checkOverlayBoundary(scanOverlay()), []);
});

test('implementation scope comes from the parsed plan while design history and scope-rebase remain live', () => {
  const files = new Map(scanOverlay().map((file) => [file.path, file.text]));
  const implement = files.get('skills/dispatch/scripts/machines/implement.ts')!;
  assert.ok(implement);
  assert.doesNotMatch(implement, /effectivePlan|planCriterion|criterionDefinitions|applicableScopeAdjustments|acceptedAdjustments/);
  assert.match(implement, /op: 'scope-rebase'/);
  assert.doesNotMatch(files.get('skills/dispatch/scripts/core/types.ts')!, /ScopeCriterionDefinition|ScopeDeviation|source: 'plan-revision'/);
  assert.match(files.get('skills/dispatch/scripts/machines/design-revision.ts')!, /scopeAdjustments: \[\.\.\.state.c.scopeAdjustments, adjustment\]/);
});

test('an import escaping the repository fails with the rule and the fix', () => {
  const text = ['imp' + 'ort x from', "'../../../scripts/test-reporter.mjs';"].join(' ');
  assert.deepEqual(checkOverlayBoundary([{ path: 'tests/unit/a.test.ts', text }, { path: 'tests/unit/b.test.ts', text: text.replace('../../../', '../../') }]), [
    'overlay boundary rule: tests/unit/a.test.ts imports ../../../scripts/test-reporter.mjs, which leaves the repository; keep dependencies inside the shipped tree',
  ]);
});
