import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isSecretPath, judgeHotfix, type HotfixInput } from '../../../skills/dispatch/scripts/policy/hotfix.ts';

const fingerprint = { head: 'h1', index: 'i1', stash: 's1', gitDir: 'g1' };
const input = (overrides: Partial<HotfixInput> = {}): HotfixInput => ({
  repoRoot: '/repo',
  changed: [{ path: 'src/a.ts', added: 5, removed: 2, deleted: false, outsideRepo: false }],
  external: [],
  before: fingerprint,
  after: fingerprint,
  taskStartFiles: ['src/a.ts', 'src/old.ts'],
  preRed: false,
  productionPaths: ['src/a.ts'],
  failureIdentityBefore: 'tests/a.test.ts#cap',
  failureIdentityAfter: null,
  ...overrides,
});
const change = (path: string, lines = 1) => ({ path, added: lines, removed: 0, deleted: false, outsideRepo: false });

test('hotfix: a small in-budget fix passes', () => {
  assert.deepEqual(judgeHotfix(input()), { violations: [], withdrawn: false, files: 1, lines: 7 });
});

test('hotfix: budget is 10 files and 150 lines, excluding reasoned external paths', () => {
  const eleven = Array.from({ length: 11 }, (_item, index) => change(`src/f${index}.ts`));
  assert.ok(judgeHotfix(input({ changed: eleven })).violations.some((item) => item.startsWith('budget: 11 files')));
  assert.ok(judgeHotfix(input({ changed: [change('src/a.ts', 151)] })).violations.some((item) => item.startsWith('budget: 151 lines')));
  const external = judgeHotfix(input({ changed: [...eleven.slice(0, 10), change('vendor/x.js', 400)], external: [{ path: 'vendor/x.js', reason: 'generated bundle' }] }));
  assert.deepEqual([external.violations, external.files], [[], 10]);
  assert.ok(judgeHotfix(input({ external: [{ path: 'vendor/x.js', reason: ' ' }] })).violations.some((item) => item.includes('needs a reason')));
});

test('observation boundary: hard limits — outside repo, .git/, secrets, task-start deletion, git fingerprints', () => {
  const violations = judgeHotfix(input({
    changed: [
      { path: '../x.ts', added: 1, removed: 0, deleted: false, outsideRepo: true },
      change('.git/hooks/pre-commit'),
      change('config/.env.local'),
      change('home/.ssh/config'),
      { path: 'src/old.ts', added: 0, removed: 10, deleted: true, outsideRepo: false },
    ],
    after: { head: 'h2', index: 'i2', stash: 's2', gitDir: 'g2' },
  })).violations;
  for (const expected of ['outside the repository', '.git/ path', 'config/.env.local: secrets path', 'home/.ssh/config: secrets path', 'deleted a file that existed at task start',
    'HEAD moved', 'index changed', 'stash list changed', '.git/ config']) {
    assert.ok(violations.some((item) => item.includes(expected)), expected);
  }
  assert.ok(isSecretPath('keys\\deploy.pem'));
  assert.ok(!isSecretPath('src/tokenizer.ts'));
});

test('hotfix: pre-RED restricts production paths; a surviving failure identity withdraws the hotfix', () => {
  assert.ok(judgeHotfix(input({ preRed: true })).violations.some((item) => item.includes('production path before RED')));
  assert.equal(judgeHotfix(input({ failureIdentityAfter: 'tests/a.test.ts#cap' })).withdrawn, true);
  assert.equal(judgeHotfix(input({ failureIdentityAfter: 'tests/a.test.ts#other' })).withdrawn, false);
});

test('hotfix: caller-supplied dir patterns match any directory segment', () => {
  assert.ok(isSecretPath('src/secrets/config.txt', { file: [], basename: [], dir: ['^secrets$'] }));
  assert.ok(!isSecretPath('src/secrets.txt', { file: [], basename: [], dir: ['^secrets$'] }));
});
