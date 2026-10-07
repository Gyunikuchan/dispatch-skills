import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Await } from '../../../skills/dispatch/scripts/core/types.ts';
import { classifyDrift, permittedPaths, type DriftContext } from '../../../skills/dispatch/scripts/policy/drift.ts';

const ctx: DriftContext = {
  stagePaths: ['skills/foo/SKILL.md', 'skills/foo/lib.mjs', 'tests/foo.test.mjs'],
  testPaths: ['tests/foo.test.mjs'],
  testsOnly: false,
  artifactPath: '.scratch/run/plan.md',
};

test('drift: permitted paths per await', () => {
  const table: [Await, string[]][] = [
    ['write', ctx.stagePaths.slice()], ['fix', ctx.stagePaths.slice()], ['author', ['.scratch/run/plan.md']],
    ['native', []], ['rule', []], ['evidence', []], ['decide', []], ['done', []],
  ];
  for (const [awaiting, expected] of table) assert.deepEqual(permittedPaths(awaiting, ctx), expected, awaiting);
  assert.deepEqual(permittedPaths('write', { ...ctx, testsOnly: true }), ['tests/foo.test.mjs']);
});

test('drift: classifies permitted, caller-dirty, auto-adopted hashes, and drift', () => {
  const result = classifyDrift({
    awaiting: 'write',
    ctx,
    changed: ['skills/foo/lib.mjs', 'README.md', 'skills/foo/skill-hashes.json', 'skills/bar/skill-hashes.json', 'src\\stray.ts'],
    callerDirty: ['README.md'],
    hashManifestDirs: ['skills/foo', 'skills/bar', ''],
  });
  assert.deepEqual(result, {
    permitted: ['skills/foo/lib.mjs'],
    callerDirty: ['README.md'],
    autoAdopt: ['skills/foo/skill-hashes.json'],
    drift: ['skills/bar/skill-hashes.json', 'src/stray.ts'],
  });
});

test('drift: nothing is permitted while deciding', () => {
  const result = classifyDrift({ awaiting: 'decide', ctx, changed: ['skills/foo/lib.mjs'], callerDirty: [], hashManifestDirs: ['skills/foo'] });
  assert.deepEqual(result.drift, ['skills/foo/lib.mjs']);
});

test('drift: driver-rendered walkthroughs in the session folder are never drift', () => {
  const result = classifyDrift({
    awaiting: 'rule',
    ctx: { ...ctx, sessionDir: '.scratch\\run' },
    changed: ['.scratch/run/slug.walkthrough.md', '.scratch/run/notes.md', 'other/slug.walkthrough.md'],
    callerDirty: [],
    hashManifestDirs: [],
  });
  assert.deepEqual(result.permitted, ['.scratch/run/slug.walkthrough.md']);
  assert.deepEqual(result.drift, ['.scratch/run/notes.md', 'other/slug.walkthrough.md']);
});
