import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanOverlay, type FileTable } from './scan.ts';

export const GOLDEN_DIR = 'tests/fixtures/review-prompt-golden/';

/** Snapshots, golden files, and expected-output `.md` fixtures live only in the review-prompt golden dir. */
export function checkSnapshots(files: FileTable): string[] {
  const errors: string[] = [];
  for (const { path: file } of files) {
    if (file.startsWith(GOLDEN_DIR)) continue;
    const name = file.split('/').pop() ?? '';
    const snapshot = name.endsWith('.snap') || name.includes('.golden.') || (file.startsWith('tests/') && name.endsWith('.md'));
    if (snapshot) errors.push(`snapshot rule: ${file} is a full-file snapshot; assert observable fields inline instead, or move a review-prompt golden file under ${GOLDEN_DIR}`);
  }
  return errors;
}

test('snapshots stay confined to the review-prompt golden dir', () => {
  assert.deepEqual(checkSnapshots(scanOverlay()), []);
});

test('a snapshot outside the golden dir fails with the rule and the fix', () => {
  const files = ['tests/unit/a.snap', 'tests/unit/b.golden.json', 'tests/fixtures/plan.md', `${GOLDEN_DIR}ok.md`, 'skills/dispatch/SKILL.md'];
  const errors = checkSnapshots(files.map((path) => ({ path, text: '' })));
  assert.equal(errors.length, 3);
  assert.match(errors[0] ?? '', /^snapshot rule: tests\/unit\/a\.snap .*assert observable fields inline/);
});
