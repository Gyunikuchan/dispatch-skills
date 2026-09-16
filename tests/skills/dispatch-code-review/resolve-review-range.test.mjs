import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  resolveExplicitRange,
  resolveReviewScope,
} from '../../../skills/dispatch-code-review/scripts/resolve-review-range.mjs';

let repo;

function git(...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commit(name, contents) {
  fs.writeFileSync(path.join(repo, name), contents);
  git('add', name);
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', name);
  return git('rev-parse', 'HEAD');
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-range-'));
  git('init', '--quiet', '-b', 'main');
});

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('code-review range preflight', () => {
  it('reports no reviewable changes on a clean base branch without using HEAD~1', () => {
    commit('value.mjs', 'export const value = 1;\n');
    const scope = resolveReviewScope({ repoRoot: repo });
    assert.equal(scope.reviewable, false);
    assert.match(scope.message, /name a commit or range/);
  });

  it('ignores scratch-only and generated changes', () => {
    commit('value.mjs', 'export const value = 1;\n');
    fs.mkdirSync(path.join(repo, '.scratch'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.scratch', 'plan.md'), '# plan');
    fs.writeFileSync(path.join(repo, 'package-lock.json'), '{}');
    assert.equal(resolveReviewScope({ repoRoot: repo }).reviewable, false);
  });

  it('returns working-tree scope for source changes', () => {
    commit('value.mjs', 'export const value = 1;\n');
    fs.writeFileSync(path.join(repo, 'value.mjs'), 'export const value = 2;\n');
    const scope = resolveReviewScope({ repoRoot: repo });
    assert.equal(scope.kind, 'working-tree');
    assert.deepEqual(scope.paths, ['value.mjs']);
  });

  it('validates single commits and two-dot/three-dot ranges', () => {
    const first = commit('a.txt', 'a');
    const second = commit('b.txt', 'b');
    assert.equal(resolveExplicitRange(repo, second), `${second}^..${second}`);
    assert.equal(resolveExplicitRange(repo, `${first}..${second}`), `${first}..${second}`);
    assert.equal(resolveExplicitRange(repo, `${first}...${second}`), `${first}...${second}`);
  });

  it('supports a root commit and rejects option-like or missing revisions', () => {
    const first = commit('a.txt', 'a');
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'dirty');
    const range = resolveExplicitRange(repo, first);
    assert.deepEqual(git('diff', '--name-only', range).split('\n'), ['a.txt']);
    assert.throws(() => resolveExplicitRange(repo, '--all'), /Invalid revision/);
    assert.throws(() => resolveExplicitRange(repo, 'missing'), /not a commit/);
  });

  it('does not merge dirty changes into an explicit range', () => {
    const first = commit('a.txt', 'a');
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'dirty');
    const scope = resolveReviewScope({ repoRoot: repo, explicitRange: first });
    assert.equal(scope.kind, 'explicit-range');
    assert.deepEqual(git('diff', '--name-only', scope.range).split('\n'), ['a.txt']);
  });

  it('handles an unborn repository as empty', () => {
    assert.equal(resolveReviewScope({ repoRoot: repo }).reviewable, false);
  });
});
