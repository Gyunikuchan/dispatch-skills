import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { designSnapshot, prepareDesignReview } from '../../../skills/dispatch-design-review/scripts/prepare-review.mjs';
import { withDispatchFrontmatter } from '../../../skills/dispatch/scripts/resolution-log.mjs';

import { designExtras } from '../../fixtures/design-sections.mjs';

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
        selector: { provider: 'claude', candidateIndex: 0 }, artifactOwned: true,
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
      const result = prepareDesignReview({ action: 'prepare', slug: 'platform', date: '2026-09-20', artifactOwned: true }, { repoRoot: root });
      assert.equal(result.status, 'decision-required');
      assert.equal(result.decision, 'design-lint');
      assert.ok(result.defects.some(defect => defect.code === 'cycle'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
