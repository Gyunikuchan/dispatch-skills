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
import { loadBatchFile } from '../../../skills/dispatch/scripts/dispatch.mjs';

const BATCH_CONFIG = {
  platforms: {
    claude: { model: 'opus', effort: 'medium' },
  },
};

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

const planBody = [
  '# Plan',
  '',
  '## Success Criteria',
  '',
  '- [SC1] Implement and verify the sample.',
  '  - Changes: `src/sample.js`',
  '  - Verify: `node --test tests/sample.test.mjs`',
  '',
  '## Proposed Changes',
  '',
  '#### [MODIFY] src/sample.js',
  '',
  '- First.',
  '',
  '## Verification Plan',
  '',
  '### Automated Tests',
  '',
  '- `node --test tests/sample.test.mjs`',
  '',
  '## Review Findings & Resolutions',
  '',
  '*No reviews conducted yet.*',
  '',
].join('\n');

describe('plan review preparation', () => {
  it('stops owned invalid plans before creating any review artifacts', () => {
    const repo = makeRepo();
    const plan = path.join(repo, '.scratch/plan/2026-09-17-invalid.md');
    fs.writeFileSync(plan, '# Invalid\n\nTODO implement later\n');
    const manifest = preparePlanReview({
      artifactPath: plan,
      slug: 'invalid',
      artifactOwned: true,
    }, { repoRoot: repo });

    assert.deepEqual(Object.keys(manifest).sort(), [
      'action', 'artifact', 'cleanupPaths', 'decision', 'defects', 'freshness', 'kind', 'schemaVersion', 'status',
    ]);
    assert.equal(manifest.status, 'decision-required');
    assert.equal(manifest.decision, 'plan-lint');
    assert.equal('choices' in manifest, false);
    assert.deepEqual(manifest.cleanupPaths, []);
    assert.equal('promptPath' in manifest, false);
    assert.equal('dispatch' in manifest, false);
    assert.equal(manifest.freshness.status, 'legacy');
    assert.ok(manifest.defects.some(({ rule }) => rule === 'proposed-changes'));
  });

  it('returns lint before strict resolution-log parsing', () => {
    const repo = makeRepo();
    const plan = path.join(repo, '.scratch/plan/2026-09-17-invalid.md');
    fs.writeFileSync(plan, '# Invalid\n\n## Review Findings & Resolutions\n\nmalformed');
    const manifest = preparePlanReview({
      artifactPath: plan,
      slug: 'invalid',
      artifactOwned: true,
    }, { repoRoot: repo });
    assert.equal(manifest.decision, 'plan-lint');
  });

  it('reports persisted-plan lint loci against canonical source lines', () => {
    const repo = makeRepo();
    const plan = path.join(repo, '.scratch/plan/2026-09-17-persisted.md');
    const metadata = {
      schemaVersion: 1,
      kind: 'plan',
      slug: 'persisted',
      invocationId: 'invocation-1',
      reviewedAt: '2026-09-17T00:00:00Z',
      contentHash: `sha256:${'0'.repeat(64)}`,
      sectionHashes: { 'Proposed Changes': `sha256:${'0'.repeat(64)}` },
    };
    const body = planBody.replace('#### [MODIFY] src/sample.js', '#### [MODIFY] ../escape.js');
    const source = `---\n${JSON.stringify({ dispatch: metadata }, null, 2)}\n---\n${body}`;
    fs.writeFileSync(plan, source);
    const manifest = preparePlanReview({
      artifactPath: plan,
      slug: 'persisted',
      artifactOwned: true,
    }, { repoRoot: repo });
    const expectedLine = source.split('\n').findIndex(line => line.includes('../escape.js')) + 1;
    assert.equal(
      manifest.defects.find(({ rule }) => rule === 'invalid-change-path').locus,
      `line ${expectedLine}`,
    );
  });

  it('keeps explicit native plan lint defects warning-only', () => {
    const repo = makeRepo();
    const nativeRoot = path.join(repo, 'native');
    const plan = path.join(nativeRoot, 'conversation', 'implementation_plan.md');
    fs.mkdirSync(path.dirname(plan), { recursive: true });
    fs.writeFileSync(plan, planBody.replace('## Proposed Changes', '## Changes'));
    const manifest = preparePlanReview({
      artifactPath: plan,
      slug: 'native',
      artifactOwned: true,
    }, { repoRoot: repo, nativeRoots: [nativeRoot] });
    try {
      assert.equal(manifest.status, 'ready');
      assert.match(manifest.scope, /proposed-changes/);
      assert.doesNotMatch(manifest.scope, /severity/);
    } finally {
      cleanManifest(manifest);
    }
  });

  it('keeps legacy coverage precedence and promotes defects after as-is', () => {
    const repo = makeRepo();
    const plan = path.join(repo, '.scratch/plan/2026-09-17-legacy.md');
    fs.writeFileSync(plan, '# Legacy\n');
    const first = preparePlanReview({
      slug: 'legacy',
      requirement: 'Use the existing plan',
    }, { repoRoot: repo });
    assert.equal(first.decision, 'legacy-plan-coverage');
    assert.deepEqual(first.choices, ['overwrite', 'as-is', 'fresh-slug']);
    assert.ok(first.defects.length > 0);
    assert.ok(first.defects.every(({ severity }) => severity === 'warning'));

    const promoted = preparePlanReview({
      slug: 'legacy',
      requirement: 'Use the existing plan',
      decision: 'as-is',
    }, { repoRoot: repo });
    assert.equal(promoted.decision, 'plan-lint');
    assert.equal('choices' in promoted, false);
  });

  it('returns legacy coverage for a non-owned scratch plan without requirement text', () => {
    const repo = makeRepo();
    const plan = path.join(repo, '.scratch/plan/2026-09-17-legacy.md');
    fs.writeFileSync(plan, '# Legacy\n');

    const manifest = preparePlanReview({ slug: 'legacy' }, { repoRoot: repo });

    assert.equal(manifest.status, 'decision-required');
    assert.equal(manifest.decision, 'legacy-plan-coverage');
  });

  it('includes every lint warning in full and rebuttal prompt scope', () => {
    const repo = makeRepo();
    const plan = path.join(repo, '.scratch/plan/2026-09-17-warning.md');
    const legacy = planBody
      .replace(/## Success Criteria[\s\S]*?(?=## Proposed Changes)/, '')
      .replace('- `node --test tests/sample.test.mjs`', '- None: no compatible runner')
      .replace('- First.', '- First. TBD');
    fs.writeFileSync(plan, legacy);
    const packet = path.join(repo, 'findings.json');
    fs.writeFileSync(packet, '{}');

    for (const request of [
      { reviewMode: 'full' },
      { reviewMode: 'rebuttal', findingPacketPath: packet, findingKeys: ['R1-F001'] },
    ]) {
      const manifest = preparePlanReview({
        ...request,
        artifactPath: plan,
        slug: 'warning',
        artifactOwned: true,
      }, { repoRoot: repo });
      try {
        assert.equal(manifest.status, 'ready');
        assert.match(manifest.scope, /missing-success-criteria/);
        assert.match(manifest.scope, /automated-tests-unavailable/);
        assert.match(manifest.scope, /placeholder/);
        const prompt = fs.readFileSync(manifest.promptPath, 'utf8');
        for (const rule of ['missing-success-criteria', 'automated-tests-unavailable', 'placeholder']) {
          assert.match(prompt, new RegExp(rule));
        }
      } finally {
        cleanManifest(manifest);
      }
    }
  });

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
      targets: [{ roundId: 'plan-review:R1', candidateId: 'plan-review:claude:0', platform: 'claude', model: 'opus', effort: 'medium'}],
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

  it('reuses an existing relocated plan in OS temp rather than requiring authoring', () => {
    const repo = makeRepo();
    const tempPlan = path.join(os.tmpdir(), `2026-09-20-sample-${Date.now()}.md`);
    fs.writeFileSync(tempPlan, planBody);
    try {
      const manifest = preparePlanReview({
        mode: 'orchestrated',
        slug: 'sample',
        artifactOwned: true,
        requirement: 'Implement sample',
        targets: [{ candidateId: 'plan-review:claude:0', platform: 'claude', model: 'opus', effort: 'medium' }],
      }, { repoRoot: repo });
      assert.equal(manifest.status, 'ready');
      assert.equal(manifest.artifact.canonicalPath, tempPlan.split(path.sep).join('/'));
      cleanManifest(manifest);
    } finally {
      fs.rmSync(tempPlan, { force: true });
    }
  });

  it('accepts targets/reserves without a per-entry roundId, defaulting to the resolved round', () => {
    const repo = makeRepo();
    const plan = path.join(repo, '.scratch/plan/2026-09-17-sample.md');
    fs.writeFileSync(plan, planBody);
    const manifest = preparePlanReview({
      mode: 'orchestrated',
      artifactPath: plan,
      slug: 'sample',
      artifactOwned: true,
      requirement: 'Implement sample',
      targets: [{ candidateId: 'plan-review:claude:0', platform: 'claude', model: 'opus', effort: 'medium' }],
      reserves: [{ candidateId: 'plan-review:agy:1', platform: 'agy', model: 'gemini', effort: 'medium' }],
    }, { repoRoot: repo });
    try {
      assert.equal(manifest.status, 'ready');
      assert.equal(manifest.roundId, 'plan-review:R1');
    } finally {
      cleanManifest(manifest);
    }
  });

  it('accepts a request with no top-level roundId and no per-entry roundId', () => {
    const repo = makeRepo();
    const plan = path.join(repo, '.scratch/plan/2026-09-17-sample.md');
    fs.writeFileSync(plan, planBody);
    const manifest = preparePlanReview({
      mode: 'orchestrated',
      artifactPath: plan,
      slug: 'sample',
      artifactOwned: true,
      requirement: 'Implement sample',
      targets: [{ candidateId: 'plan-review:claude:0', platform: 'claude', model: 'opus', effort: 'medium' }],
    }, { repoRoot: repo });
    try {
      assert.equal(manifest.status, 'ready');
      assert.equal(manifest.roundId, 'plan-review:R1');
    } finally {
      cleanManifest(manifest);
    }
  });

  it('rejects a per-entry roundId that mismatches the resolved round', () => {
    const repo = makeRepo();
    const plan = path.join(repo, '.scratch/plan/2026-09-17-sample.md');
    fs.writeFileSync(plan, planBody);
    assert.throws(() => preparePlanReview({
      mode: 'orchestrated',
      artifactPath: plan,
      slug: 'sample',
      artifactOwned: true,
      requirement: 'Implement sample',
      targets: [{ roundId: 'plan-review:R2', candidateId: 'plan-review:claude:0', platform: 'claude', model: 'opus', effort: 'medium' }],
    }, { repoRoot: repo }), /roundId/);
  });

  it('writes a batch file whose every entry carries the resolved roundId and loads via loadBatchFile', () => {
    const repo = makeRepo();
    const plan = path.join(repo, '.scratch/plan/2026-09-17-sample.md');
    fs.writeFileSync(plan, planBody);
    const manifest = preparePlanReview({
      mode: 'orchestrated',
      artifactPath: plan,
      slug: 'sample',
      artifactOwned: true,
      requirement: 'Implement sample',
      targets: [{ candidateId: 'plan-review:claude:0', platform: 'claude', model: 'opus', effort: 'medium' }],
      reserves: [{ candidateId: 'plan-review:claude:1', platform: 'claude', model: 'sonnet', effort: 'medium' }],
    }, { repoRoot: repo });
    try {
      const batchIndex = manifest.dispatch.argv.indexOf('--batch-file');
      assert.ok(batchIndex !== -1);
      const batchFilePath = manifest.dispatch.argv[batchIndex + 1];
      const batch = loadBatchFile(batchFilePath, BATCH_CONFIG);
      assert.ok(batch.targets.length > 0);
      for (const entry of [...batch.targets, ...batch.reserves]) {
        assert.equal(entry.roundId, manifest.roundId);
      }
    } finally {
      cleanManifest(manifest);
    }
  });

  it('rejects standalone targets and orchestrated selectors', () => {
    const repo = makeRepo();
    const plan = path.join(repo, '.scratch/plan/2026-09-17-sample.md');
    fs.writeFileSync(plan, planBody);
    const target = { roundId: 'plan-review:R1', candidateId: 'plan-review:claude:0', platform: 'claude', candidateIndex: 0 };
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
    execFileSync('git', ['commit', '--no-gpg-sign', '-qm', 'initial'], { cwd: repo });
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
    assert.throws(() => preparePlanReview({
      action: 'checkpoint',
      invocationContext: prepared.invocationContext,
      settlement: { consensusExit: 1, terminalSourceKeys: [] },
      settledWrites: { sections: [] },
    }, { repoRoot: repo }), /run dispatch\/scripts\/check-consensus\.mjs until it exits 0/);
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
    }, { repoRoot: repo }), /declared but unchanged: Verification Plan.*changed but undeclared: Proposed Changes.*set to \["Proposed Changes"\].*rerun preparation/s);
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
    cleanManifest(prepared);
    cleanManifest(next);
  });
  it('hints the intended field for a guessed request key', () => {
    const repo = makeRepo();
    assert.throws(() => preparePlanReview({ plan: 'x.md' }, { repoRoot: repo }), /unsupported field "plan".*did you mean "artifactPath"\?/s);
    assert.throws(() => preparePlanReview({ roundid: 'plan-review:R1' }, { repoRoot: repo }), /did you mean "roundId"\?/);
    // walkthroughPath is a code-review field, so plan review must not suggest it.
    assert.throws(() => preparePlanReview({ walkthrough: 'x.md' }, { repoRoot: repo }), (err) => !/did you mean/.test(err.message));
  });

  it('previews exactly the checkpoint that succeeds, without writing', () => {
    const repo = makeRepo();
    const plan = path.join(repo, '.scratch/plan/2026-09-17-sample.md');
    fs.writeFileSync(plan, planBody);
    const prepared = preparePlanReview({ artifactPath: plan, slug: 'sample', artifactOwned: true }, { repoRoot: repo });
    fs.writeFileSync(plan, fs.readFileSync(plan, 'utf8').replace('- First.', '- Changed.'));
    const before = fs.readFileSync(plan, 'utf8');
    assert.throws(() => preparePlanReview({ action: 'checkpoint-preview', invocationContext: prepared.invocationContext, settledWrites: { sections: [] } }, { repoRoot: repo }), /inapplicable field "settledWrites"; allowed: action, invocationContext/);
    assert.throws(() => preparePlanReview({ action: 'checkpoint-preview' }, { repoRoot: repo }), /requires invocationContext/);
    const preview = preparePlanReview({ action: 'checkpoint-preview', invocationContext: prepared.invocationContext }, { repoRoot: repo });
    assert.deepEqual(preview, {
      schemaVersion: 1,
      kind: 'plan',
      action: 'checkpoint-preview',
      status: 'preview',
      settlement: { consensusExit: 0, terminalSourceKeys: [] },
      settledWrites: { sections: ['Proposed Changes'] },
      unsettled: [],
    });
    assert.equal(fs.readFileSync(plan, 'utf8'), before);
    const done = preparePlanReview({ action: 'checkpoint', invocationContext: prepared.invocationContext, settlement: preview.settlement, settledWrites: preview.settledWrites }, { repoRoot: repo });
    assert.equal(done.status, 'checkpointed');
    cleanManifest(prepared);
  });

  it('previews a nonzero consensus exit that the echoed checkpoint rejects', () => {
    const repo = makeRepo();
    const plan = path.join(repo, '.scratch/plan/2026-09-17-sample.md');
    fs.writeFileSync(plan, planBody);
    const prepared = preparePlanReview({ artifactPath: plan, slug: 'sample', artifactOwned: true }, { repoRoot: repo });
    const log = (line) => fs.writeFileSync(plan, fs.readFileSync(plan, 'utf8').replace(
      /## Review Findings & Resolutions[\s\S]*$/,
      `## Review Findings & Resolutions\n\n### Round 1 — agy\n${line}\n`,
    ));
    log('- **[Disputed]** § Proposed Changes — tag: x → y');
    const live = preparePlanReview({ action: 'checkpoint-preview', invocationContext: prepared.invocationContext }, { repoRoot: repo });
    assert.equal(live.settlement.consensusExit, 1);
    assert.deepEqual(live.settledWrites, { sections: [] });
    assert.deepEqual(live.unsettled, ['- **[Disputed]** § Proposed Changes — tag: x → y']);
    assert.throws(() => preparePlanReview({ action: 'checkpoint', invocationContext: prepared.invocationContext, settlement: live.settlement, settledWrites: live.settledWrites }, { repoRoot: repo }), /requires consensusExit 0/);
    // Leniently settled, strictly invalid: the unpadded ID must not preview as settled.
    log('- **[Accepted]** [R1-F1] [MUST] [sources=plan-review:R1:agy:0] § Proposed Changes — tag: x → y');
    const invalid = preparePlanReview({ action: 'checkpoint-preview', invocationContext: prepared.invocationContext }, { repoRoot: repo });
    assert.equal(invalid.settlement.consensusExit, 2);
    assert.match(invalid.error, /malformed enriched finding prefix/);
    cleanManifest(prepared);
  });
});
