import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTestSource, scanOverlay, type FileTable } from './scan.ts';

/** Justified exceptions as `<overlay path>: <reason>`; raising it is an explicit, reviewed edit. */
export const ALLOW_TIMING: readonly string[] = [
  'tests/helpers/e2e.ts: E2E-only real CLI deadlines and detached-worker polling.',
  'tests/helpers/stub-provider.ts: E2E-only provider delay keeps a real worker live for sender-kill recovery.',
];

// NOTE: tokens are assembled so this guard's own source never matches them.
const TOKENS = ['set' + 'Timeout', 'set' + 'Interval', 'sle' + 'ep(', 'Date' + '.now', 'performance' + '.now'];

export function checkTiming(files: FileTable, allow: readonly string[] = ALLOW_TIMING): string[] {
  const allowed = new Set(allow.map((entry) => entry.split(':')[0]));
  const errors: string[] = [];
  for (const { path: file, text } of files) {
    if (!isTestSource(file) || file.startsWith('tests/e2e/') || allowed.has(file)) continue;
    for (const token of TOKENS) {
      if (text.includes(token)) {
        errors.push(`timing rule: ${file} uses ${token}; non-e2e tests never sleep or time, so inject Ports.clock (or list a justified exception in ALLOW_TIMING)`);
      }
    }
  }
  return errors;
}

test('non-e2e tests contain no sleeps or timing', () => {
  assert.deepEqual(checkTiming(scanOverlay()), []);
});

test('a timing call fails with the rule and the fix unless allowed or e2e', () => {
  const text = `await new Promise((r) => ${TOKENS[0]}(r, 10));`;
  assert.deepEqual(checkTiming([{ path: 'tests/unit/core/a.test.ts', text }, { path: 'tests/e2e/b.test.ts', text }]), [
    `timing rule: tests/unit/core/a.test.ts uses ${TOKENS[0]}; non-e2e tests never sleep or time, so inject Ports.clock (or list a justified exception in ALLOW_TIMING)`,
  ]);
  assert.deepEqual(checkTiming([{ path: 'tests/unit/core/a.test.ts', text }], ['tests/unit/core/a.test.ts: reason']), []);
});
