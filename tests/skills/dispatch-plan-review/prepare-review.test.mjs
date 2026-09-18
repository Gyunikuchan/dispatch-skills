import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  planSnapshot,
  preparePlanReview,
} from '../../../skills/dispatch-plan-review/scripts/prepare-review.mjs';

const tempDirs = [];
const CONVERSATION_ENV_KEYS = [
  'ANTIGRAVITY_AGENT', 'ANTIGRAVITY_CONVERSATION_ID', 'ANTIGRAVITY_SESSION_ID', 'GEMINI_CLI',
];
let originalEnv = {};

const makeRepo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-prepare-test-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.scratch', 'plan'), { recursive: true });
  return dir;
};
const cleanManifest = (manifest) => {
  for (const cleanup of [...(manifest.cleanupPaths ?? []), manifest.invocationContext?.statePath && path.dirname(manifest.invocationContext.statePath)].filter(Boolean)) {
    fs.rmSync(cleanup, { recursive: true, force: true });
  }
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

const planBody = '# Plan\n\n## Proposed Changes\n\n- First.\n\n## Review Findings & Resolutions\n\n*No reviews conducted yet.*\n';

describe('plan review preparation', () => {
  it('prepares an orchestrated full review and emits argv rather than shell text', () => {
    const repo = makeRepo();
    const plan = path.join(repo, '.scratch/plan/2026-09-17-sample.md');
    fs.writeFileSync(plan, planBody);
    const manifest = preparePlanReview({
      mode: 'orchestrated',
      artifactPath: plan,
      slug: 'sample',
      artifactOwned: true,
      requirement: 'Implement sample',
      roundId: 'plan-review:R1',
      targets: [{ roundId: 'plan-review:R1', candidateId: 'plan-review:claude:0', platform: 'claude', model: 'opus', effort: 'medium', metricsFile: path.join(repo, 'slot.json') }],
      reserves: [],
    }, { repoRoot: repo });
    try {
      assert.equal(manifest.status, 'ready');
      assert.equal(manifest.freshness.status, 'legacy');
      assert.ok(Array.isArray(manifest.dispatch.argv));
      assert.ok(manifest.dispatch.argv.includes('--batch-file'));
      assert.equal(manifest.roundId, 'plan-review:R1');
    } finally {
      cleanManifest(manifest);
    }
  });

  it('rejects standalone targets and orchestrated selectors', () => {
    const repo = makeRepo();
    const plan = path.join(repo, '.scratch/plan/2026-09-17-sample.md');
    fs.writeFileSync(plan, planBody);
    const target = { roundId: 'plan-review:R1', candidateId: 'plan-review:claude:0', platform: 'claude', candidateIndex: 0, metricsFile: path.join(repo, 'slot.json') };
    assert.throws(() => preparePlanReview({
      artifactPath: plan, slug: 'sample', artifactOwned: true, roundId: 'plan-review:R1', targets: [target],
    }, { repoRoot: repo }), /standalone requests cannot carry targets/);
    assert.throws(() => preparePlanReview({
      mode: 'orchestrated', artifactPath: plan, slug: 'sample', artifactOwned: true, roundId: 'plan-review:R1',
      targets: [target], selector: { provider: 'claude', candidateIndex: 0 },
    }, { repoRoot: repo }), /not selector/);
  });

  it('scopes a later wave to sections changed since the prior wave', () => {
    const repo = makeRepo();
    const plan = path.join(repo, '.scratch/plan/2026-09-17-sample.md');
    fs.writeFileSync(plan, planBody);
    const first = preparePlanReview({ artifactPath: plan, slug: 'sample', artifactOwned: true }, { repoRoot: repo });
    fs.writeFileSync(plan, planBody
      .replace('- First.', '- First, revised.')
      .replace('*No reviews conducted yet.*', '### Round 1\n- *No actionable findings.*'));
    const second = preparePlanReview({
      artifactPath: plan,
      slug: 'sample',
      artifactOwned: true,
      invocationContext: first.invocationContext,
    }, { repoRoot: repo });
    try {
      assert.match(second.scope, /changed sections: Proposed Changes/);
    } finally {
      cleanManifest(first);
      cleanManifest(second);
    }
  });

  it('returns authoring-required for a missing plan', () => {
    const repo = makeRepo();
    const manifest = preparePlanReview({
      artifactPath: '.scratch/plan/2026-09-17-sample.md',
      slug: 'sample',
      requirement: 'Implement sample',
    }, { repoRoot: repo });
    assert.equal(manifest.status, 'authoring-required');
    assert.equal(manifest.requirement, 'Implement sample');
  });

  it('returns a legacy coverage decision for a resolved existing plan', () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, '.scratch/plan/2026-09-17-feature.md'), planBody);
    execFileSync('git', ['init', '-q', '-b', 'feature'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repo });
    const manifest = preparePlanReview({
      requirement: 'Different requirement',
      orchestrator: 'opencode',
    }, { repoRoot: repo });
    assert.equal(manifest.status, 'decision-required');
    assert.equal(manifest.decision, 'legacy-plan-coverage');
  });

  it('checkpoints declared body edits and treats resolution-only edits as semantic no-ops', () => {
    const repo = makeRepo();
    const plan = path.join(repo, '.scratch/plan/2026-09-17-sample.md');
    fs.writeFileSync(plan, planBody);
    const prepared = preparePlanReview({
      artifactPath: plan,
      slug: 'sample',
      artifactOwned: true,
    }, { repoRoot: repo });
    fs.writeFileSync(plan, planBody
      .replace('- First.', '- First.\n- Second.')
      .replace('*No reviews conducted yet.*', '### Round 1\n- *No actionable findings.*'));
    const checkpoint = preparePlanReview({
      action: 'checkpoint',
      invocationContext: prepared.invocationContext,
      settlement: { consensusExit: 0, terminalSourceKeys: [] },
      settledWrites: { sections: ['Proposed Changes'] },
    }, { repoRoot: repo, now: new Date('2026-09-17T00:00:00Z') });
    try {
      assert.equal(checkpoint.status, 'checkpointed');
      assert.equal(checkpoint.metadata.contentHash, planSnapshot(fs.readFileSync(plan, 'utf8')).contentHash);
      assert.match(fs.readFileSync(plan, 'utf8'), /^---\n\{/);
    } finally {
      cleanManifest(prepared);
    }
  });

  it('carries the rerun remedy on checkpoint drift', () => {
    const repo = makeRepo();
    const plan = path.join(repo, '.scratch/plan/2026-09-17-sample.md');
    fs.writeFileSync(plan, planBody);
    const first = preparePlanReview({ artifactPath: plan, slug: 'sample', artifactOwned: true }, { repoRoot: repo });
    const second = preparePlanReview({ artifactPath: plan, slug: 'sample', artifactOwned: true }, { repoRoot: repo });
    // The second invocation writes metadata, superseding what the first one recorded.
    preparePlanReview({
      action: 'checkpoint',
      invocationContext: second.invocationContext,
      settlement: { consensusExit: 0, terminalSourceKeys: [] },
      settledWrites: { sections: [] },
    }, { repoRoot: repo });
    assert.throws(() => preparePlanReview({
      action: 'checkpoint',
      invocationContext: first.invocationContext,
      settlement: { consensusExit: 0, terminalSourceKeys: [] },
      settledWrites: { sections: [] },
    }, { repoRoot: repo }), /superseded by another invocation\. Rerun preparation; the prior checkpoint is retained\./);
    cleanManifest(first);
    cleanManifest(second);
  });

  it('rejects undeclared edits, replayed contexts, and unknown request fields', () => {
    const repo = makeRepo();
    const plan = path.join(repo, '.scratch/plan/2026-09-17-sample.md');
    fs.writeFileSync(plan, planBody);
    assert.throws(() => preparePlanReview({ surprise: true }, { repoRoot: repo }), /unsupported field/);
    const prepared = preparePlanReview({
      artifactPath: plan,
      slug: 'sample',
      artifactOwned: true,
    }, { repoRoot: repo });
    fs.writeFileSync(plan, planBody.replace('- First.', '- Changed.'));
    assert.throws(() => preparePlanReview({
      action: 'checkpoint',
      invocationContext: prepared.invocationContext,
      settlement: { consensusExit: 0, terminalSourceKeys: [] },
      settledWrites: { sections: [] },
    }, { repoRoot: repo }), /do not match observed/);
    // The rejection names both sides of the delta and the one legal recovery.
    assert.throws(() => preparePlanReview({
      action: 'checkpoint',
      invocationContext: prepared.invocationContext,
      settlement: { consensusExit: 0, terminalSourceKeys: [] },
      settledWrites: { sections: ['Verification Plan'] },
    }, { repoRoot: repo }), /missing: Verification Plan.*unexpected: Proposed Changes.*observed list: Proposed Changes.*rerun preparation/s);
    const next = preparePlanReview({
      artifactPath: plan,
      slug: 'sample',
      artifactOwned: true,
      invocationContext: prepared.invocationContext,
    }, { repoRoot: repo });
    assert.throws(() => preparePlanReview({
      artifactPath: plan,
      slug: 'sample',
      artifactOwned: true,
      invocationContext: prepared.invocationContext,
    }, { repoRoot: repo }), /stale, replayed, forked/);
    cleanManifest(next);
  });
});
