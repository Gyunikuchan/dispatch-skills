import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  captureReviewSnapshot,
  resolveExplicitRange,
  resolveReviewScope,
  verifyFreshness,
} from '../../../skills/dispatch-code-review/scripts/resolve-review-range.mjs';
import {
  semanticSectionHashes,
  writeArtifactMetadata,
} from '../../../skills/dispatch/scripts/review-preparation.mjs';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../skills/dispatch-code-review/scripts/resolve-review-range.mjs',
);

let repo;

function git(...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commit(name, contents) {
  fs.writeFileSync(path.join(repo, name), contents);
  git('add', name);
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--no-gpg-sign', '--quiet', '-m', name);
  return git('rev-parse', 'HEAD');
}

function createCheckpointedWalkthrough({
  repoRoot,
  walkthroughRelPath = '.scratch/walkthrough.md',
  body = '# Walkthrough\n\n## Changes Made\n- test change\n',
  metadataOverrides = {},
} = {}) {
  const walkthroughPath = path.join(repoRoot, walkthroughRelPath);
  fs.mkdirSync(path.dirname(walkthroughPath), { recursive: true });
  fs.writeFileSync(walkthroughPath, body, 'utf8');

  const scope = { reviewable: true, kind: 'working-tree', range: null, paths: [] };
  const snapshot = captureReviewSnapshot({ repoRoot, scope });
  const artifactSnapshot = semanticSectionHashes(body);

  const metadata = {
    schemaVersion: 1,
    kind: 'code',
    slug: 'test-walkthrough',
    invocationId: 'test-invocation-id-123',
    baseSha: snapshot.baseSha,
    headSha: snapshot.headSha,
    worktreeHash: snapshot.worktreeHash,
    contentHash: artifactSnapshot.contentHash,
    pathHashes: snapshot.pathHashes,
    reviewedAt: new Date().toISOString(),
    ...metadataOverrides,
  };

  writeArtifactMetadata(walkthroughPath, metadata);
  return { walkthroughPath, metadata, snapshot };
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

  describe('allowedPaths restriction for final integration', () => {
    it('restricts an explicit range to the owned-path intersection', () => {
      const first = commit('owned.txt', 'owned');
      commit('unrelated.txt', 'unrelated');
      const scope = resolveReviewScope({ repoRoot: repo, explicitRange: first, allowedPaths: ['owned.txt'] });
      assert.equal(scope.kind, 'explicit-range');
      assert.deepEqual(scope.paths, ['owned.txt']);
    });

    it('fails closed with a distinct diagnostic when the owned intersection is empty', () => {
      const first = commit('unrelated.txt', 'unrelated');
      const scope = resolveReviewScope({ repoRoot: repo, explicitRange: first, allowedPaths: ['owned.txt'] });
      assert.equal(scope.reviewable, false);
      assert.equal(scope.kind, 'empty-owned-intersection');
      assert.notEqual(scope.kind, 'empty');
      assert.match(scope.message, /owned/i);
    });

    it('conservatively includes user-retained changes on owned paths and discloses them', () => {
      const first = commit('owned.txt', 'owned');
      fs.writeFileSync(path.join(repo, 'owned.txt'), 'owned+retained');
      const scope = resolveReviewScope({ repoRoot: repo, explicitRange: first, allowedPaths: ['owned.txt'] });
      assert.equal(scope.reviewable, true);
      assert.deepEqual(scope.paths, ['owned.txt']);
      assert.match(scope.disclosure ?? scope.reviewScope, /owned\.txt/);
    });

    it('unions owned committed-range paths with owned working-tree changes', () => {
      commit('owned.txt', 'owned');
      commit('unrelated.txt', 'unrelated');
      fs.writeFileSync(path.join(repo, 'owned.txt'), 'owned+retained');
      const scope = resolveReviewScope({ repoRoot: repo, allowedPaths: ['owned.txt'] });
      assert.equal(scope.reviewable, true);
      assert.deepEqual(scope.paths, ['owned.txt']);
      assert.match(scope.disclosure, /working-tree owned changes included/);
    });

    it('includes owned working-tree edits in an explicit range ending at HEAD', () => {
      const base = commit('seed.txt', 'seed');
      commit('owned.txt', 'owned');
      fs.writeFileSync(path.join(repo, 'late.txt'), 'uncommitted');
      const scope = resolveReviewScope({ repoRoot: repo, explicitRange: `${base}..HEAD`, allowedPaths: ['owned.txt', 'late.txt'] });
      assert.deepEqual(scope.paths, ['late.txt', 'owned.txt']);
      assert.match(scope.disclosure, /working-tree owned changes included/);
    });

    it('reviews from an explicit baseRevision instead of the merge-base', () => {
      commit('pre.txt', 'pre');
      const baseline = commit('seed.txt', 'seed');
      commit('owned.txt', 'owned');
      const scope = resolveReviewScope({ repoRoot: repo, baseRevision: baseline, allowedPaths: ['owned.txt', 'pre.txt'] });
      assert.equal(scope.range, `${baseline}..HEAD`);
      assert.equal(scope.baseSha, baseline);
      assert.deepEqual(scope.paths, ['owned.txt']);
    });

    it('fails closed when baseRevision is not an ancestor of HEAD', () => {
      commit('seed.txt', 'seed');
      git('checkout', '-q', '-b', 'side');
      const side = commit('side.txt', 'side');
      git('checkout', '-q', '-');
      commit('owned.txt', 'owned');
      assert.throws(
        () => resolveReviewScope({ repoRoot: repo, baseRevision: side, allowedPaths: ['owned.txt'] }),
        /not an ancestor/,
      );
      assert.throws(
        () => resolveReviewScope({ repoRoot: repo, baseRevision: side, explicitRange: side }),
        /not both/,
      );
    });

    it('rejects absolute and escaping allowedPaths entries with a stable diagnostic', () => {
      const first = commit('owned.txt', 'owned');
      assert.throws(
        () => resolveReviewScope({ repoRoot: repo, explicitRange: first, allowedPaths: ['../escape.txt'] }),
        /inside the repository/,
      );
      assert.throws(
        () => resolveReviewScope({ repoRoot: repo, explicitRange: first, allowedPaths: ['C:/absolute.txt'] }),
        /inside the repository/,
      );
    });
  });
});

describe('verifyFreshness', () => {
  it('returns fresh: true when working tree and walkthrough match checkpoint', () => {
    commit('value.mjs', 'export const value = 1;\n');
    fs.writeFileSync(path.join(repo, 'value.mjs'), 'export const value = 2;\n');
    const { walkthroughPath } = createCheckpointedWalkthrough({ repoRoot: repo });
    const result = verifyFreshness({ walkthroughPath, repoRoot: repo });
    assert.deepEqual(result, {
      fresh: true,
      contentFresh: true,
      worktreeFresh: true,
      headFresh: true,
      changedPaths: [],
    });
  });

  it('detects worktree drift when a tracked file is modified', () => {
    commit('value.mjs', 'export const value = 1;\n');
    fs.writeFileSync(path.join(repo, 'value.mjs'), 'export const value = 2;\n');
    const { walkthroughPath } = createCheckpointedWalkthrough({ repoRoot: repo });
    fs.writeFileSync(path.join(repo, 'value.mjs'), 'export const value = 3;\n');
    const result = verifyFreshness({ walkthroughPath, repoRoot: repo });
    assert.equal(result.fresh, false);
    assert.equal(result.worktreeFresh, false);
    assert.ok(result.changedPaths.includes('value.mjs'));
  });

  it('detects worktree drift when a new file is added', () => {
    commit('value.mjs', 'export const value = 1;\n');
    fs.writeFileSync(path.join(repo, 'value.mjs'), 'export const value = 2;\n');
    const { walkthroughPath } = createCheckpointedWalkthrough({ repoRoot: repo });
    fs.writeFileSync(path.join(repo, 'new-file.mjs'), 'export const extra = true;\n');
    const result = verifyFreshness({ walkthroughPath, repoRoot: repo });
    assert.equal(result.fresh, false);
    assert.equal(result.worktreeFresh, false);
    assert.ok(result.changedPaths.includes('new-file.mjs'));
  });

  it('detects content drift when walkthrough markdown body is modified without metadata update', () => {
    commit('value.mjs', 'export const value = 1;\n');
    fs.writeFileSync(path.join(repo, 'value.mjs'), 'export const value = 2;\n');
    const { walkthroughPath } = createCheckpointedWalkthrough({ repoRoot: repo });
    fs.appendFileSync(walkthroughPath, '\n## Additional Section\nExtra drifted text\n');
    const result = verifyFreshness({ walkthroughPath, repoRoot: repo });
    assert.equal(result.fresh, false);
    assert.equal(result.contentFresh, false);
  });

  it('throws when walkthrough file does not exist', () => {
    assert.throws(
      () => verifyFreshness({ walkthroughPath: path.join(repo, '.scratch', 'nonexistent.md'), repoRoot: repo }),
      /ENOENT|no such file/i,
    );
  });

  it('throws when walkthrough has no metadata (uncheckpointed)', () => {
    const uncheckpointed = path.join(repo, '.scratch', 'uncheckpointed.md');
    fs.mkdirSync(path.dirname(uncheckpointed), { recursive: true });
    fs.writeFileSync(uncheckpointed, '# Walkthrough\n\nNo frontmatter.\n', 'utf8');
    assert.throws(
      () => verifyFreshness({ walkthroughPath: uncheckpointed, repoRoot: repo }),
      /metadata|checkpoint/i,
    );
  });

  it('throws when walkthrough has baseSha !== headSha (unsupported range checkpoint)', () => {
    const c1 = commit('value.mjs', 'export const value = 1;\n');
    const c2 = commit('value.mjs', 'export const value = 2;\n');
    fs.writeFileSync(path.join(repo, 'value.mjs'), 'export const value = 3;\n');
    const { walkthroughPath } = createCheckpointedWalkthrough({
      repoRoot: repo,
      metadataOverrides: { baseSha: c1, headSha: c2 },
    });
    assert.throws(
      () => verifyFreshness({ walkthroughPath, repoRoot: repo }),
      /range/i,
    );
  });
});

describe('--verify-freshness CLI', () => {
  it('exits 0 with matching JSON output on fresh walkthrough', () => {
    commit('value.mjs', 'export const value = 1;\n');
    fs.writeFileSync(path.join(repo, 'value.mjs'), 'export const value = 2;\n');
    const { walkthroughPath } = createCheckpointedWalkthrough({ repoRoot: repo });
    const res = spawnSync(process.execPath, [SCRIPT, '--verify-freshness', walkthroughPath, '--repo-root', repo], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const output = JSON.parse(res.stdout);
    assert.deepEqual(output, {
      fresh: true,
      contentFresh: true,
      worktreeFresh: true,
      headFresh: true,
      changedPaths: [],
    });
  });

  it('exits 1 on stale/drifted walkthrough', () => {
    commit('value.mjs', 'export const value = 1;\n');
    fs.writeFileSync(path.join(repo, 'value.mjs'), 'export const value = 2;\n');
    const { walkthroughPath } = createCheckpointedWalkthrough({ repoRoot: repo });
    fs.writeFileSync(path.join(repo, 'value.mjs'), 'export const value = 3;\n');
    const res = spawnSync(process.execPath, [SCRIPT, '--verify-freshness', walkthroughPath, '--repo-root', repo], { encoding: 'utf8' });
    assert.equal(res.status, 1);
    const output = JSON.parse(res.stdout);
    assert.equal(output.fresh, false);
    assert.equal(output.worktreeFresh, false);
    assert.ok(output.changedPaths.includes('value.mjs'));
  });

  it('exits 2 on non-existent file', () => {
    const missing = path.join(repo, '.scratch', 'missing.md');
    const res = spawnSync(process.execPath, [SCRIPT, '--verify-freshness', missing, '--repo-root', repo], { encoding: 'utf8' });
    assert.equal(res.status, 2);
  });

  it('exits 2 on uncheckpointed walkthrough', () => {
    const uncheckpointed = path.join(repo, '.scratch', 'uncheckpointed.md');
    fs.mkdirSync(path.dirname(uncheckpointed), { recursive: true });
    fs.writeFileSync(uncheckpointed, '# Walkthrough\n\nNo frontmatter.\n', 'utf8');
    const res = spawnSync(process.execPath, [SCRIPT, '--verify-freshness', uncheckpointed, '--repo-root', repo], { encoding: 'utf8' });
    assert.equal(res.status, 2);
  });

  it('exits 2 on unsupported range checkpoint (baseSha !== headSha)', () => {
    const c1 = commit('value.mjs', 'export const value = 1;\n');
    const c2 = commit('value.mjs', 'export const value = 2;\n');
    fs.writeFileSync(path.join(repo, 'value.mjs'), 'export const value = 3;\n');
    const { walkthroughPath } = createCheckpointedWalkthrough({
      repoRoot: repo,
      metadataOverrides: { baseSha: c1, headSha: c2 },
    });
    const res = spawnSync(process.execPath, [SCRIPT, '--verify-freshness', walkthroughPath, '--repo-root', repo], { encoding: 'utf8' });
    assert.equal(res.status, 2);
  });
});
