import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { designSnapshot, prepareDesignReview } from '../../../../skills/dispatch/scripts/review/prepare.mjs';
import { withDispatchFrontmatter } from '../../../../skills/dispatch/scripts/review/resolution-log.mjs';

import { designExtras } from '../../../helpers/design-sections.mjs';

const validDesign = `# Design
${designExtras(['I01'])}
## Architecture & Boundaries
A.

## Alternatives & Decisions
B.

## Risks, Security & Operations
C.

## Increment Dependency Graph
| ID | Priority | Summary | Prerequisites | Paths |
| --- | ---: | --- | --- | --- |
| I01 | 1 | Base | none | src/base.js |

## Execution Status
Ready.

## Review Findings & Resolutions
*No reviews conducted yet.*
`;

describe('design review preparation', () => {
  it('returns design authoring state for a missing canonical design', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-prepare-'));
    try {
      const result = prepareDesignReview({ action: 'prepare', slug: 'platform', date: '2026-09-20', requirement: 'large change' }, { repoRoot: root });
      assert.equal(result.kind, 'design');
      assert.equal(result.status, 'authoring-required');
      assert.match(result.artifact.canonicalPath, /2026-09-20-platform-design\.md$/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('prepares an existing valid design', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-prepare-'));
    try {
      const design = path.join(root, '.scratch/plan/2026-09-20-platform-design.md');
      fs.mkdirSync(path.dirname(design), { recursive: true });
      const snapshot = designSnapshot(validDesign);
      fs.writeFileSync(design, withDispatchFrontmatter(validDesign, {
        schemaVersion: 1, kind: 'design', slug: 'platform', invocationId: 'existing-design',
        contentHash: snapshot.contentHash, sectionHashes: snapshot.sectionHashes,
        reviewedAt: '2026-09-20T00:00:00.000Z', approvedContentHash: null, approvedAt: null,
      }));
      const result = prepareDesignReview({
        action: 'prepare', slug: 'platform', date: '2026-09-20',
        selector: { provider: 'claude', candidateIndex: 0 },
      }, { repoRoot: root });
      assert.equal(result.status, 'ready');
      for (const cleanup of result.cleanupPaths) fs.rmSync(cleanup, { recursive: true, force: true });
      fs.rmSync(path.dirname(result.invocationContext.statePath), { recursive: true, force: true });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('blocks an existing design with a dependency cycle', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-prepare-'));
    try {
      const design = path.join(root, '.scratch/plan/2026-09-20-platform-design.md');
      fs.mkdirSync(path.dirname(design), { recursive: true });
      const cyclic = validDesign.replace('| I01 | 1 | Base | none |', '| I01 | 1 | Base | I01 |');
      const snapshot = designSnapshot(cyclic);
      fs.writeFileSync(design, withDispatchFrontmatter(cyclic, {
        schemaVersion: 1, kind: 'design', slug: 'platform', invocationId: 'cyclic-design',
        contentHash: snapshot.contentHash, sectionHashes: snapshot.sectionHashes,
        reviewedAt: '2026-09-20T00:00:00.000Z', approvedContentHash: null, approvedAt: null,
      }));
      const result = prepareDesignReview({ action: 'prepare', slug: 'platform', date: '2026-09-20' }, { repoRoot: root });
      assert.equal(result.status, 'decision-required');
      assert.equal(result.decision, 'design-lint');
      assert.ok(result.defects.some(defect => defect.code === 'cycle'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('prepares a design rebuttal manifest from the shared rebuttal frame', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-prepare-'));
    try {
      const design = path.join(root, '.scratch/plan/2026-09-20-platform-design.md');
      fs.mkdirSync(path.dirname(design), { recursive: true });
      const snapshot = designSnapshot(validDesign);
      fs.writeFileSync(design, withDispatchFrontmatter(validDesign, {
        schemaVersion: 1, kind: 'design', slug: 'platform', invocationId: 'existing-design',
        contentHash: snapshot.contentHash, sectionHashes: snapshot.sectionHashes,
        reviewedAt: '2026-09-20T00:00:00.000Z', approvedContentHash: null, approvedAt: null,
      }));
      const packet = path.join(root, 'packet.json');
      fs.writeFileSync(packet, '{}');
      const result = prepareDesignReview({
        action: 'prepare', slug: 'platform', date: '2026-09-20',
        selector: { provider: 'claude', candidateIndex: 0 },
        reviewMode: 'rebuttal', findingPacketPath: packet, findingKeys: ['R1-F001'],
      }, { repoRoot: root });
      try {
        assert.equal(result.status, 'ready');
        const prompt = fs.readFileSync(result.promptPath, 'utf8');
        assert.match(prompt, /R1-F001/);
        assert.match(prompt, /CONFIRM/);
        assert.match(prompt, /REBUT/);
        assert.match(prompt, /INTENT-DISPUTE/);
        assert.doesNotMatch(prompt, /<<slot:/);
        assert.doesNotMatch(prompt, /{{[A-Z_]+}}/);
      } finally {
        for (const cleanup of result.cleanupPaths) fs.rmSync(cleanup, { recursive: true, force: true });
        fs.rmSync(path.dirname(result.invocationContext.statePath), { recursive: true, force: true });
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects unsupported request fields', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-prepare-'));
    try {
      assert.throws(() => prepareDesignReview({ action: 'prepare', slug: 'platform', decision: 'as-is' }, { repoRoot: root }), /unsupported field "decision"/);
      assert.throws(() => prepareDesignReview({ action: 'prepare', slug: 'platform', ['artifact' + 'Owned']: true }, { repoRoot: root }), /unsupported field "artifactOwned"/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('SC1 prepares a verb-approved design whose metadata slug omits -design', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-prepare-'));
    try {
      const design = path.join(root, '.scratch/plan/2026-09-20-platform-design.md');
      fs.mkdirSync(path.dirname(design), { recursive: true });
      const snapshot = designSnapshot(validDesign);
      fs.writeFileSync(design, withDispatchFrontmatter(validDesign, {
        schemaVersion: 1, kind: 'design', slug: 'platform', invocationId: 'verb-approved-design',
        contentHash: snapshot.contentHash, sectionHashes: snapshot.sectionHashes,
        reviewedAt: '2026-09-20T00:00:00.000Z', approvedContentHash: null, approvedAt: null,
      }));
      const result = prepareDesignReview({
        action: 'prepare', artifactPath: design,
        selector: { provider: 'claude', candidateIndex: 0 },
      }, { repoRoot: root });
      assert.equal(result.status, 'ready');
      assert.equal(result.artifact.slug, 'platform');
      for (const cleanup of result.cleanupPaths) fs.rmSync(cleanup, { recursive: true, force: true });
      fs.rmSync(path.dirname(result.invocationContext.statePath), { recursive: true, force: true });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('reviews a metadata-less existing design', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-prepare-'));
    try {
      const design = path.join(root, '.scratch/plan/2026-09-20-platform-design.md');
      fs.mkdirSync(path.dirname(design), { recursive: true });
      fs.writeFileSync(design, validDesign);
      const result = prepareDesignReview({ action: 'prepare', artifactPath: design, slug: 'platform', requirement: 'other' }, { repoRoot: root });
      try {
        assert.equal(result.status, 'ready');
        assert.equal(result.freshness.status, 'untracked');
      } finally {
        for (const cleanup of result.cleanupPaths ?? []) fs.rmSync(cleanup, { recursive: true, force: true });
        if (result.invocationContext) fs.rmSync(path.dirname(result.invocationContext.statePath), { recursive: true, force: true });
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
