import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanOverlay, type FileTable } from './scan.ts';

// Audit subprocess fixtures need audit-tooling.test.ts and audit-probe.test.ts (probe termination/capture flows).
// The approved observation-boundary plan adds one real-Git fixture file.
// The approved plan-replacement plan adds tests/e2e/plan-replacement.test.ts for real-Git retirement and replay.
// The approved authority/continuation plan adds two real-main and real-Git fixture files; the I01 spec-stage plan adds tests/e2e/spec-stage.test.ts.
export const E2E_CAP = 10;

export function checkE2eCap(files: FileTable, cap = E2E_CAP): string[] {
  const e2e = files.filter((file) => file.path.startsWith('tests/e2e/'));
  return e2e.length > cap
    ? [`e2e cap rule: tests/e2e/ holds ${e2e.length} files (cap ${cap}); cover the behaviour in tiers 1-5, or raise E2E_CAP in an explicit edit`]
    : [];
}

test('tests/e2e/ stays within the cap', () => {
  assert.deepEqual(checkE2eCap(scanOverlay()), []);
});

test('exceeding the cap fails with the rule and the fix', () => {
  const files = ['a', 'b', 'c', 'd'].map((name) => ({ path: `tests/e2e/${name}.test.ts`, text: '' }));
  assert.deepEqual(checkE2eCap(files, 3), ['e2e cap rule: tests/e2e/ holds 4 files (cap 3); cover the behaviour in tiers 1-5, or raise E2E_CAP in an explicit edit']);
});
