import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { relocatedArtifactsPath } from '../../../../skills/dispatch/scripts/artifacts/resolve-paths.mjs';
import { prepareCodeReview } from '../../../../skills/dispatch/scripts/review/prepare.mjs';
import { loadBatchFile } from '../../../../skills/dispatch/scripts/dispatch.mjs';
import {
  cleanupPreparationManifest,
  createReviewPreparationFixture,
  makeDirtyCodeRepository,
} from '../../../helpers/review-preparation-fixture.mjs';

const BATCH_CONFIG = {
  platforms: {
    claude: { model: 'opus', effort: 'medium' },
  },
};

const fixture = createReviewPreparationFixture();
const makeRepo = () => makeDirtyCodeRepository(fixture.makeDirectory);
const cleanupManifest = cleanupPreparationManifest;

beforeEach(fixture.beforeEach);
afterEach(fixture.afterEach);

describe('code review preparation', () => {
  it('generates a missing walkthrough and prepares an orchestrated review', () => {
    const repo = makeRepo();
    const manifest = prepareCodeReview({
      mode: 'orchestrated',
      slug: 'feature',
      summary: 'Update the exported value',
      verification: { command: 'npm test', result: 'Passed' },
      roundId: 'code-review:R1',
      targets: [{ roundId: 'code-review:R1', candidateId: 'code-review:claude:0', platform: 'claude', model: 'opus', effort: 'medium'}],
    }, { repoRoot: repo });
    try {
      assert.equal(manifest.status, 'ready');
      assert.equal(manifest.artifact.generated, true);
      const walkthrough = fs.readFileSync(path.join(repo, manifest.artifact.canonicalPath), 'utf8');
      assert.match(walkthrough, /Update the exported value/);
      assert.match(walkthrough, /Command: `npm test` — exit unknown; Passed/);
      assert.ok(manifest.dispatch.argv.includes('--batch-file'));
      assert.deepEqual(manifest.reviewRange.paths, ['app.js']);
    } finally {
      cleanupManifest(manifest);
    }
  });

  it('reuses an existing relocated walkthrough in OS temp rather than generating a new one', () => {
    const repo = makeRepo();
    // The temp tier reads only this repository's relocated directory (O1).
    const relocated = relocatedArtifactsPath({ projectRoot: repo });
    fs.mkdirSync(relocated, { recursive: true });
    const tempWalkthrough = path.join(relocated, `2026-09-20-feature-walkthrough-${Date.now()}.md`);
    fs.writeFileSync(tempWalkthrough, '# Walkthrough — Existing in Temp\n\n## Changes Made\n- **[MODIFY]** `app.js` — Custom change description.\n\n## Verification & Validation\n### Automated Tests\n- Command: `npm test` — exit 0; Custom verification.\n');
    try {
      const manifest = prepareCodeReview({
        mode: 'orchestrated',
        slug: 'feature',
        summary: 'Update the exported value',
        verification: { command: 'npm test', result: 'Passed' },
        targets: [{ candidateId: 'code-review:claude:0', platform: 'claude', model: 'opus', effort: 'medium' }],
      }, { repoRoot: repo });
      assert.equal(manifest.status, 'ready');
      assert.equal(manifest.artifact.generated, false);
      assert.equal(manifest.artifact.canonicalPath, tempWalkthrough.split(path.sep).join('/'));
      cleanupManifest(manifest);
    } finally {
      fs.rmSync(tempWalkthrough, { force: true });
      // Non-recursive: removes only the now-empty per-test namespace directories.
      for (const dir of [relocated, path.dirname(relocated)]) { try { fs.rmdirSync(dir); } catch { /* not empty or gone */ } }
    }
  });

  it('accepts targets/reserves without a per-entry roundId, defaulting to the resolved round', () => {
    const repo = makeRepo();
    const manifest = prepareCodeReview({
      mode: 'orchestrated',
      slug: 'feature',
      summary: 'Update the exported value',
      verification: { command: 'npm test', result: 'Passed' },
      targets: [{ candidateId: 'code-review:claude:0', platform: 'claude', model: 'opus', effort: 'medium' }],
      reserves: [{ candidateId: 'code-review:agy:1', platform: 'agy', model: 'gemini', effort: 'medium' }],
    }, { repoRoot: repo });
    try {
      assert.equal(manifest.status, 'ready');
      assert.equal(manifest.roundId, 'code-review:R1');
    } finally {
      cleanupManifest(manifest);
    }
  });

  describe('increment design context', () => {
    function writeDesign(repo) {
      const design = [
        '---',
        JSON.stringify({ dispatch: { schemaVersion: 1, kind: 'design', slug: 'demo-design' } }),
        '---',
        '# Demo design',
        '',
        '## Architecture & Boundaries',
        'approved boundaries',
        '## Alternatives & Decisions',
        'choices',
        '## Risks, Security & Operations',
        'risks',
        '## Increment Dependency Graph',
        '| ID | Priority | Summary | Prerequisites | Paths |',
        '| --- | ---: | --- | --- | --- |',
        '| I01 | 1 | one | none | app.js |',
        '',
        '## Execution Status',
        '<!-- machine-managed -->',
        '',
        '## Review Findings & Resolutions',
        '*No reviews conducted yet.*',
      ].join('\n');
      fs.mkdirSync(path.join(repo, '.scratch', 'plan'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.scratch', 'plan', '2026-09-20-demo-design.md'), design);
      return design;
    }

    it('attaches bounded approved-design context and revision to prompts', () => {
      const repo = makeRepo();
      const design = writeDesign(repo);
      const manifest = prepareCodeReview({
        mode: 'orchestrated',
        slug: 'feature',
        summary: 'Update the exported value',
        verification: { command: 'npm test', result: 'Passed' },
        designPath: '.scratch/plan/2026-09-20-demo-design.md',
        designRevision: null,
        incrementId: 'I01',
        targets: [{ candidateId: 'code-review:claude:0', platform: 'claude', model: 'opus', effort: 'medium' }],
      }, { repoRoot: repo });
      try {
        assert.equal(manifest.status, 'ready');
        assert.equal(manifest.designContext.revision, null);
        assert.match(manifest.designContext.governedHash, /^sha256:[a-f0-9]{64}$/);
        assert.match(manifest.designContext.excerpt, /## Architecture & Boundaries/);
        assert.doesNotMatch(manifest.designContext.excerpt, /## Execution Status/);
        assert.equal(manifest.designContext.incrementId, 'I01');
        const prompt = fs.readFileSync(manifest.promptPath, 'utf8');
        assert.match(prompt, /Approved technical-design context/i);
        assert.match(prompt, /I01/);
      } finally {
        cleanupManifest(manifest);
      }
    });

    it('rejects an invalid design path or revision', () => {
      const repo = makeRepo();
      writeDesign(repo);
      assert.throws(() => prepareCodeReview({
        mode: 'orchestrated',
        slug: 'feature',
        summary: 'Update the exported value',
        verification: { command: 'npm test', result: 'Passed' },
        designPath: '.scratch/plan/2026-09-20-missing-design.md',
        incrementId: 'I01',
        targets: [{ candidateId: 'code-review:claude:0', platform: 'claude', model: 'opus', effort: 'medium' }],
      }, { repoRoot: repo }), /design/i);
    });
  });

  it('accepts a request with no top-level roundId and no per-entry roundId', () => {
    const repo = makeRepo();
    const manifest = prepareCodeReview({
      mode: 'orchestrated',
      slug: 'feature',
      summary: 'Update the exported value',
      verification: { command: 'npm test', result: 'Passed' },
      targets: [{ candidateId: 'code-review:claude:0', platform: 'claude', model: 'opus', effort: 'medium' }],
    }, { repoRoot: repo });
    try {
      assert.equal(manifest.status, 'ready');
      assert.equal(manifest.roundId, 'code-review:R1');
    } finally {
      cleanupManifest(manifest);
    }
  });

  it('rejects a per-entry roundId that mismatches the resolved round', () => {
    const repo = makeRepo();
    assert.throws(() => prepareCodeReview({
      mode: 'orchestrated',
      slug: 'feature',
      summary: 'Update the exported value',
      verification: { command: 'npm test', result: 'Passed' },
      targets: [{ roundId: 'code-review:R2', candidateId: 'code-review:claude:0', platform: 'claude', model: 'opus', effort: 'medium' }],
    }, { repoRoot: repo }), /roundId/);
  });

  it('writes a batch file whose every entry carries the resolved roundId and loads via loadBatchFile', () => {
    const repo = makeRepo();
    const manifest = prepareCodeReview({
      mode: 'orchestrated',
      slug: 'feature',
      summary: 'Update the exported value',
      verification: { command: 'npm test', result: 'Passed' },
      targets: [{ candidateId: 'code-review:claude:0', platform: 'claude', model: 'opus', effort: 'medium' }],
      reserves: [{ candidateId: 'code-review:claude:1', platform: 'claude', model: 'sonnet', effort: 'medium' }],
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

  it('reviews an existing metadata-less walkthrough', () => {
    const repo = makeRepo();
    const dir = path.join(repo, '.scratch', 'plan');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-09-17-feature-walkthrough.md'), '# Walkthrough — Old\n');
    const manifest = prepareCodeReview({ summary: 'New work' }, { repoRoot: repo });
    try {
      assert.equal('choices' in manifest, false);
      assert.ok(manifest.status === 'ready' || manifest.decision === 'walkthrough-inputs', JSON.stringify(manifest));
    } finally {
      cleanupManifest(manifest);
    }
  });

  it('rejects unsupported request fields', () => {
    const repo = makeRepo();
    assert.throws(() => prepareCodeReview({ slug: 'feature', decision: 'overwrite' }, { repoRoot: repo }), /unsupported field "decision"/);
    assert.throws(() => prepareCodeReview({ slug: 'feature', ['artifact' + 'Owned']: true }, { repoRoot: repo }), /unsupported field "artifactOwned"/);
  });

  it('accepts a minimum-contract baseline walkthrough without rewriting it', () => {
    const repo = makeRepo();
    const dir = path.join(repo, '.scratch', 'plan');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-09-17-feature-walkthrough.md'), [
      '# Walkthrough — Feature',
      '## Changes Made',
      'No implementation changes yet.',
      '## Verification & Validation',
      '- Command: `npm test` — exit 0; 1 test passed.',
      '## Key Deviations',
      'None.',
      '## Review Findings & Resolutions',
      '*No reviews conducted yet.*',
      '## Follow-ups',
      'None.',
    ].join('\n'));
    const manifest = prepareCodeReview({
      slug: 'feature',
      walkthroughPath: '.scratch/plan/2026-09-17-feature-walkthrough.md',
    }, { repoRoot: repo });
    try {
      assert.equal(manifest.status, 'ready');
      assert.equal(manifest.artifact.generated, false);
      assert.match(fs.readFileSync(path.join(repo, manifest.artifact.canonicalPath), 'utf8'), /exit 0; 1 test passed/);
    } finally {
      cleanupManifest(manifest);
    }
  });

  it('checkpoints declared code and walkthrough edits', () => {
    const repo = makeRepo();
    const prepared = prepareCodeReview({
      slug: 'feature',
      summary: 'Update value',
      verification: { command: 'npm test', result: 'Passed' },
    }, { repoRoot: repo });
    const walkthrough = path.join(repo, prepared.artifact.canonicalPath);
    fs.writeFileSync(path.join(repo, 'app.js'), 'export const value = 3;\n');
    fs.writeFileSync(walkthrough, fs.readFileSync(walkthrough, 'utf8').replace(
      '## Key Deviations\nNone.',
      '## Key Deviations\nChanged the constant again.',
    ));
    assert.throws(() => prepareCodeReview({
      action: 'checkpoint',
      invocationContext: prepared.invocationContext,
      settlement: { consensusExit: 1, terminalSourceKeys: [] },
      settledWrites: { paths: ['app.js'], walkthroughSections: ['Key Deviations'] },
    }, { repoRoot: repo }), /continue review rounds until consensus settles \(exit 0\)/);
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
    const entry = { roundId: 'code-review:R1', candidateId: 'code-review:claude:0', platform: 'claude', candidateIndex: 0 };
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
    }, { repoRoot: repo });
    assert.throws(() => prepareCodeReview({
      action: 'checkpoint',
      invocationContext: prepared.invocationContext,
      settlement: { consensusExit: 0, terminalSourceKeys: [] },
      settledWrites: { paths: ['package-lock.json'], walkthroughSections: [] },
    }, { repoRoot: repo }), /not an eligible working-tree change|do not match observed/);
    cleanupManifest(prepared);
  });

  it('carries the rerun remedy on checkpoint drift', () => {
    const repo = makeRepo();
    const first = prepareCodeReview({
      slug: 'feature',
      summary: 'Update value',
      verification: { command: 'npm test', result: 'Passed' },
    }, { repoRoot: repo });
    const second = prepareCodeReview({
      walkthroughPath: path.join(repo, first.artifact.canonicalPath),
      slug: 'feature',
    }, { repoRoot: repo });
    // The second invocation writes metadata, superseding what the first one recorded.
    prepareCodeReview({
      action: 'checkpoint',
      invocationContext: second.invocationContext,
      settlement: { consensusExit: 0, terminalSourceKeys: [] },
      settledWrites: { paths: [], walkthroughSections: [] },
    }, { repoRoot: repo });
    assert.throws(() => prepareCodeReview({
      action: 'checkpoint',
      invocationContext: first.invocationContext,
      settlement: { consensusExit: 0, terminalSourceKeys: [] },
      settledWrites: { paths: [], walkthroughSections: [] },
    }, { repoRoot: repo }), /superseded by another invocation\. Rerun preparation; the prior checkpoint is retained\./);
    cleanupManifest(first);
    cleanupManifest(second);
  });

  it('names both sides of a settled-path delta and the recovery', () => {
    const repo = makeRepo();
    const prepared = prepareCodeReview({
      slug: 'feature',
      summary: 'Update value',
      verification: { command: 'npm test', result: 'Passed' },
    }, { repoRoot: repo });
    fs.writeFileSync(path.join(repo, 'app.js'), 'export const value = 3;\n');
    assert.throws(() => prepareCodeReview({
      action: 'checkpoint',
      invocationContext: prepared.invocationContext,
      settlement: { consensusExit: 0, terminalSourceKeys: [] },
      settledWrites: { paths: ['other.js'], walkthroughSections: [] },
    }, { repoRoot: repo }), /do not match observed code changes.*declared but unchanged: other\.js.*changed but undeclared: app\.js.*set to \["app\.js"\].*rerun preparation/s);
    cleanupManifest(prepared);
  });
  it('hints the intended field for a guessed request key', () => {
    const repo = makeRepo();
    assert.throws(() => prepareCodeReview({ walkthrough: 'x.md' }, { repoRoot: repo }), /did you mean "walkthroughPath"\?/);
    assert.throws(() => prepareCodeReview({ context: {} }, { repoRoot: repo }), /did you mean "invocationContext"\?/);
  });

  it('previews exactly the checkpoint that succeeds, and a live log that it rejects', () => {
    const repo = makeRepo();
    const prepared = prepareCodeReview({
      slug: 'feature',
      summary: 'Update value',
      verification: { command: 'npm test', result: 'Passed' },
    }, { repoRoot: repo });
    const walkthrough = path.join(repo, prepared.artifact.canonicalPath);
    fs.writeFileSync(path.join(repo, 'app.js'), 'export const value = 3;\n');
    fs.writeFileSync(walkthrough, fs.readFileSync(walkthrough, 'utf8').replace(
      '## Key Deviations\nNone.',
      '## Key Deviations\nChanged the constant again.',
    ));
    try {
      assert.throws(() => prepareCodeReview({ action: 'checkpoint-preview', invocationContext: prepared.invocationContext, settlement: {} }, { repoRoot: repo }), /inapplicable field "settlement"/);
      const reviewed = fs.readFileSync(walkthrough, 'utf8');
      const live = reviewed.replace(/## Review Findings & Resolutions[^\n]*\n/, (head) => `${head}\n### Round 1 — agy\n- **[Disputed]** [R1-F001] [MUST] [sources=agy] app.js — tag: x → y\n`);
      fs.writeFileSync(walkthrough, live);
      const unsettled = prepareCodeReview({ action: 'checkpoint-preview', invocationContext: prepared.invocationContext }, { repoRoot: repo });
      assert.equal(unsettled.settlement.consensusExit, 1);
      assert.deepEqual(unsettled.settledWrites, { paths: [], walkthroughSections: [] });
      fs.writeFileSync(walkthrough, reviewed);
      const preview = prepareCodeReview({ action: 'checkpoint-preview', invocationContext: prepared.invocationContext }, { repoRoot: repo });
      assert.deepEqual(preview, {
        schemaVersion: 1,
        kind: 'code',
        action: 'checkpoint-preview',
        status: 'preview',
        settlement: { consensusExit: 0, terminalSourceKeys: [] },
        settledWrites: { paths: ['app.js'], walkthroughSections: ['Key Deviations'] },
        unsettled: [],
      });
      assert.equal(fs.readFileSync(walkthrough, 'utf8'), reviewed);
      const done = prepareCodeReview({
        action: 'checkpoint',
        invocationContext: prepared.invocationContext,
        settlement: preview.settlement,
        settledWrites: preview.settledWrites,
      }, { repoRoot: repo });
      assert.equal(done.status, 'checkpointed');
    } finally {
      cleanupManifest(prepared);
    }
  });
});
