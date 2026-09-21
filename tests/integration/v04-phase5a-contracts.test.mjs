import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { buildScratchPaths, isReservedOrdinarySlug } from '../../skills/dispatch/scripts/resolve-artifact-paths.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('v0.4 Phase 5A contracts', () => {
  it('defines disjoint phased paths and reserved slugs', () => {
    assert.equal(buildScratchPaths('2026-09-20', 'root', 'design'), '.scratch/plan/2026-09-20-root-design.md');
    assert.equal(buildScratchPaths('2026-09-20', 'root-i01-one', 'increment-plan'), '.scratch/plan/2026-09-20-root-i01-one-plan.md');
    assert.equal(isReservedOrdinarySlug('root-design'), true);
  });

  it('ships the design contract with increment execution now available', () => {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'skills/dispatch/references/verbs/design.md')));
    const skill = fs.readFileSync(path.join(REPO_ROOT, 'skills/implement-dispatch/SKILL.md'), 'utf8');
    assert.match(skill, /design-approved-stop/);
    assert.match(skill, /\/implement-dispatch <design-path>/);
    assert.doesNotMatch(skill, /Increment execution, amendments, and integration remain unavailable/);
  });
});
