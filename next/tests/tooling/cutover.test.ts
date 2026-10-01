import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutoverCli, planCutover } from '../../scripts/cutover.ts';
test('pure per-file planner removes designated tracked legacy, renames contracts, preserves unrelated trees and itself', () => {
  const tracked = ['skills/dispatch/SKILL.md', 'tests/old.test.mjs', 'scripts/old.mjs', 'docs/dispatch-implement-notes.md', 'README.md', '.agents/skills/x/SKILL.md', 'next/skills/dispatch/SKILL.next.md', 'next/scripts/generate-hashes.ts', 'next/scripts/cutover.ts'];
  const plan = planCutover(tracked, (file) => tracked.includes(file));
  assert.deepEqual(plan, [
    { kind: 'remove', path: 'docs/dispatch-implement-notes.md' }, { kind: 'remove', path: 'scripts/old.mjs' }, { kind: 'remove', path: 'skills/dispatch/SKILL.md' }, { kind: 'remove', path: 'tests/old.test.mjs' },
    { kind: 'move', from: 'next/scripts/generate-hashes.ts', to: 'scripts/generate-hashes.ts' }, { kind: 'move', from: 'next/skills/dispatch/SKILL.next.md', to: 'skills/dispatch/SKILL.md' },
  ]);
});
test('planner refuses ignored destinations, unsafe paths, unknown overlay trees and duplicate destinations', () => {
  assert.throws(() => planCutover(['next/skills/dispatch/config.local.jsonc'], () => true), /untracked/);
  assert.throws(() => planCutover(['next/../secrets'], () => false), /Unsafe/);
  assert.throws(() => planCutover(['next/README.md'], () => false), /outside/);
  assert.throws(() => planCutover(['next/skills/dispatch/SKILL.md', 'next/skills/dispatch/SKILL.next.md'], () => false), /Duplicate/);
});
test('guarded CLI refuses invalid invocation before any Git call', () => {
  assert.throws(() => cutoverCli([]), /--dry-run or --execute/); assert.throws(() => cutoverCli(['--execute', 'extra']), /--dry-run or --execute/);
});
