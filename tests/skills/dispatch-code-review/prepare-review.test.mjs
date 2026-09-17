import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { prepareCodeReview } from '../../../skills/dispatch-code-review/scripts/prepare-review.mjs';

const tempDirs = [];
const CONVERSATION_ENV_KEYS = [
  'ANTIGRAVITY_AGENT', 'ANTIGRAVITY_CONVERSATION_ID', 'ANTIGRAVITY_SESSION_ID', 'GEMINI_CLI',
];
let originalEnv = {};

const makeRepo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-prepare-test-'));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'feature'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'app.js'), 'export const value = 1;\n');
  execFileSync('git', ['add', 'app.js'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'app.js'), 'export const value = 2;\n');
  return dir;
};
const cleanupManifest = (manifest) => {
  const paths = [
    ...(manifest.cleanupPaths ?? []),
    manifest.invocationContext?.statePath && path.dirname(manifest.invocationContext.statePath),
  ].filter(Boolean);
  for (const cleanup of paths) fs.rmSync(cleanup, { recursive: true, force: true });
};

beforeEach(() => {
  originalEnv = {};
  for (const key of CONVERSATION_ENV_KEYS) {
    if (key in process.env) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
});

afterEach(() => {
  for (const [key, val] of Object.entries(originalEnv)) {
    process.env[key] = val;
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('code review preparation', () => {
  it('generates a missing walkthrough and prepares an orchestrated review', () => {
    const repo = makeRepo();
    const manifest = prepareCodeReview({
      mode: 'orchestrated',
      slug: 'feature',
      summary: 'Update the exported value',
      verification: { command: 'npm test', result: 'Passed' },
      roundId: 'code-review:R1',
      targets: [{ roundId: 'code-review:R1', candidateId: 'code-review:claude:0', platform: 'claude', model: 'opus', effort: 'medium', metricsFile: path.join(repo, 'slot.json') }],
      artifactOwned: true,
    }, { repoRoot: repo });
    try {
      assert.equal(manifest.status, 'ready');
      assert.equal(manifest.artifact.generated, true);
      assert.match(fs.readFileSync(path.join(repo, manifest.artifact.canonicalPath), 'utf8'), /Update the exported value/);
      assert.ok(manifest.dispatch.argv.includes('--batch-file'));
      assert.deepEqual(manifest.reviewRange.paths, ['app.js']);
    } finally {
      cleanupManifest(manifest);
    }
  });

  it('requires semantic inputs before creating a walkthrough', () => {
    const repo = makeRepo();
    const manifest = prepareCodeReview({ slug: 'feature' }, { repoRoot: repo });
    assert.equal(manifest.status, 'decision-required');
    assert.deepEqual(manifest.missing, ['summary', 'verification.command', 'verification.result']);
    assert.equal(fs.existsSync(path.join(repo, manifest.artifact.canonicalPath)), false);
  });

  it('returns a legacy mismatch decision for an existing resolved walkthrough', () => {
    const repo = makeRepo();
    const dir = path.join(repo, '.scratch', 'plan');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-09-17-feature-walkthrough.md'), '# Walkthrough — Old\n');
    const manifest = prepareCodeReview({ summary: 'New work' }, { repoRoot: repo });
    assert.equal(manifest.status, 'decision-required');
    assert.equal(manifest.decision, 'legacy-walkthrough-coverage');
  });

  it('checkpoints declared code and walkthrough edits', () => {
    const repo = makeRepo();
    const prepared = prepareCodeReview({
      slug: 'feature',
      summary: 'Update value',
      verification: { command: 'npm test', result: 'Passed' },
      artifactOwned: true,
    }, { repoRoot: repo });
    const walkthrough = path.join(repo, prepared.artifact.canonicalPath);
    fs.writeFileSync(path.join(repo, 'app.js'), 'export const value = 3;\n');
    fs.writeFileSync(walkthrough, fs.readFileSync(walkthrough, 'utf8').replace(
      '## Key Deviations\nNone.',
      '## Key Deviations\nChanged the constant again.',
    ));
    const checkpoint = prepareCodeReview({
      action: 'checkpoint',
      invocationContext: prepared.invocationContext,
      settlement: { consensusExit: 0, terminalSourceKeys: [] },
      settledWrites: { paths: ['app.js'], walkthroughSections: ['Key Deviations'] },
    }, { repoRoot: repo, now: new Date('2026-09-17T00:00:00Z') });
    try {
      assert.equal(checkpoint.status, 'checkpointed');
      assert.match(checkpoint.metadata.worktreeHash, /^sha256:/);
      assert.match(checkpoint.metadata.contentHash, /^sha256:/);
    } finally {
      cleanupManifest(prepared);
    }
  });

  it('uses full selected scope for body-only drift', () => {
    const repo = makeRepo();
    const first = prepareCodeReview({
      slug: 'feature',
      summary: 'Update value',
      verification: { command: 'npm test', result: 'Passed' },
      artifactOwned: true,
    }, { repoRoot: repo });
    const walkthrough = path.join(repo, first.artifact.canonicalPath);
    prepareCodeReview({
      action: 'checkpoint',
      invocationContext: first.invocationContext,
      settlement: { consensusExit: 0, terminalSourceKeys: [] },
      settledWrites: { paths: [], walkthroughSections: [] },
    }, { repoRoot: repo });
    fs.writeFileSync(walkthrough, fs.readFileSync(walkthrough, 'utf8').replace('None.', 'Body-only note.'));
    const second = prepareCodeReview({
      walkthroughPath: walkthrough,
      slug: 'feature',
      artifactOwned: true,
    }, { repoRoot: repo });
    try {
      assert.equal(second.freshness.bodyOnly, true);
      assert.match(second.scope, /Current staged, unstaged, and untracked changes/);
    } finally {
      cleanupManifest(first);
      cleanupManifest(second);
    }
  });

  it('returns the exact clean-tree diagnostic and rejects unknown fields', () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'app.js'), 'export const value = 1;\n');
    assert.throws(() => prepareCodeReview({ surprise: true }, { repoRoot: repo }), /unsupported field/);
    const manifest = prepareCodeReview({ slug: 'feature' }, { repoRoot: repo });
    assert.equal(manifest.status, 'no-reviewable-changes');
    assert.equal(manifest.message, 'No reviewable changes; name a commit or range to review.');
  });

  it('rejects standalone targets/reserves and orchestrated selectors', () => {
    const repo = makeRepo();
    const entry = { roundId: 'code-review:R1', candidateId: 'code-review:claude:0', platform: 'claude', candidateIndex: 0, metricsFile: path.join(repo, 'slot.json') };
    assert.throws(() => prepareCodeReview({ roundId: 'code-review:R1', targets: [entry] }, { repoRoot: repo }), /standalone requests cannot carry targets/);
    assert.throws(() => prepareCodeReview({ roundId: 'code-review:R1', reserves: [entry] }, { repoRoot: repo }), /standalone requests cannot carry targets/);
    // Malformed --list-targets entries still get the standalone diagnostic first.
    assert.throws(() => prepareCodeReview({ targets: [{ platform: 'claude', candidateIndex: 0 }] }, { repoRoot: repo }), /standalone requests cannot carry targets/);
    assert.throws(() => prepareCodeReview({ mode: 'orchestrated', roundId: 'code-review:R1', targets: [entry], selector: { provider: 'claude', candidateIndex: 0 } }, { repoRoot: repo }), /not selector/);
  });

  it('rejects inapplicable checkpoint fields and ineligible settled paths', () => {
    const repo = makeRepo();
    assert.throws(() => prepareCodeReview({
      action: 'checkpoint',
      mode: 'standalone',
      invocationContext: {},
      settlement: { consensusExit: 0, terminalSourceKeys: [] },
      settledWrites: { paths: [], walkthroughSections: [] },
    }, { repoRoot: repo }), /inapplicable field "mode"/);
    const prepared = prepareCodeReview({
      slug: 'feature',
      summary: 'Update value',
      verification: { command: 'npm test', result: 'Passed' },
      artifactOwned: true,
    }, { repoRoot: repo });
    assert.throws(() => prepareCodeReview({
      action: 'checkpoint',
      invocationContext: prepared.invocationContext,
      settlement: { consensusExit: 0, terminalSourceKeys: [] },
      settledWrites: { paths: ['package-lock.json'], walkthroughSections: [] },
    }, { repoRoot: repo }), /not an eligible working-tree change|do not match observed/);
    cleanupManifest(prepared);
  });
});
