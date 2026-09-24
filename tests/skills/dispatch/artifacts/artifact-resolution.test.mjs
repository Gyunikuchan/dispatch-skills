import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  SCRATCH_DIR,
  findExistingScratchArtifact,
  findExistingTempArtifact,
  ledgerNamespacePath,
  localDate,
  repositoryRootHash,
  resolveArtifactPath,
  resolveArtifacts,
} from '../../../../skills/dispatch/scripts/artifacts/resolve-paths.mjs';

// SECTION: Scratch and relocated artifact discovery

describe('findExistingScratchArtifact / resolveArtifactPath (scratch tiers)', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(os.tmpdir(), 'resolve-artifact-paths-test-'));
    mkdirSync(path.join(projectRoot, ...SCRATCH_DIR.split('/')), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns null when no scratch directory exists', () => {
    rmSync(path.join(projectRoot, '.scratch'), { recursive: true, force: true });
    assert.equal(findExistingScratchArtifact('plan', 'auth-v2', projectRoot), null);
  });

  it('rejects a missing or non-string slug rather than coercing it to a matching string', () => {
    for (const badSlug of [undefined, null, 42, {}]) {
      assert.throws(
        () => findExistingScratchArtifact('plan', badSlug, projectRoot),
        /must be kebab-case/,
        `slug: ${JSON.stringify(badSlug)}`
      );
    }
  });

  it('finds an existing plan without matching its walkthrough', () => {
    const dir = path.join(projectRoot, ...SCRATCH_DIR.split('/'));
    writeFileSync(path.join(dir, '2026-09-10-auth-v2.md'), '# plan');
    writeFileSync(path.join(dir, '2026-09-10-auth-v2-walkthrough.md'), '# walkthrough');

    assert.equal(
      findExistingScratchArtifact('plan', 'auth-v2', projectRoot),
      '.scratch/plan/2026-09-10-auth-v2.md'
    );
    assert.equal(
      findExistingScratchArtifact('walkthrough', 'auth-v2', projectRoot),
      '.scratch/plan/2026-09-10-auth-v2-walkthrough.md'
    );
  });

  it('does not match a different slug with a shared prefix', () => {
    const dir = path.join(projectRoot, ...SCRATCH_DIR.split('/'));
    writeFileSync(path.join(dir, '2026-09-10-auth-v2-extended.md'), '# plan');
    assert.equal(findExistingScratchArtifact('plan', 'auth-v2', projectRoot), null);
  });

  it('picks the most recently modified match when multiple dates exist', () => {
    const dir = path.join(projectRoot, ...SCRATCH_DIR.split('/'));
    const older = path.join(dir, '2026-09-09-auth-v2.md');
    const newer = path.join(dir, '2026-09-10-auth-v2.md');
    writeFileSync(older, '# plan');
    writeFileSync(newer, '# plan');
    const now = Date.now() / 1000;
    utimesSync(older, now - 100, now - 100);
    utimesSync(newer, now, now);

    assert.equal(
      findExistingScratchArtifact('plan', 'auth-v2', projectRoot),
      '.scratch/plan/2026-09-10-auth-v2.md'
    );
  });

  describe('findExistingTempArtifact', () => {
    it('finds relocated plan and walkthrough in OS temp', () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), 'test-temp-artifacts-'));
      try {
        writeFileSync(path.join(tempDir, '2026-09-10-auth-v2.md'), '# plan');
        writeFileSync(path.join(tempDir, '2026-09-10-auth-v2-walkthrough.md'), '# walkthrough');

        assert.equal(
          findExistingTempArtifact('plan', 'auth-v2', tempDir),
          path.join(tempDir, '2026-09-10-auth-v2.md').split(path.sep).join('/')
        );
        assert.equal(
          findExistingTempArtifact('walkthrough', 'auth-v2', tempDir),
          path.join(tempDir, '2026-09-10-auth-v2-walkthrough.md').split(path.sep).join('/')
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('matches collision-renamed temp artifacts with timestamps or counters', () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), 'test-temp-artifacts-'));
      try {
        writeFileSync(path.join(tempDir, '2026-09-10-auth-v2-walkthrough-1789912000000-1.md'), '# walkthrough');
        assert.equal(
          findExistingTempArtifact('walkthrough', 'auth-v2', tempDir),
          path.join(tempDir, '2026-09-10-auth-v2-walkthrough-1789912000000-1.md').split(path.sep).join('/')
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  it('resolveArtifactPath reuses an existing canonical design', () => {
    const design = path.join(projectRoot, '.scratch', 'plan', '2026-09-11-platform-design.md');
    writeFileSync(design, '---\n{"dispatch":{"kind":"design"}}\n---\n# design');
    assert.deepEqual(resolveArtifactPath('design', {
      slug: 'platform', date: '2026-09-11', projectRoot,
    }), {
      tier: 'scratch-existing',
      path: '.scratch/plan/2026-09-11-platform-design.md',
      exists: true,
      scratchOnly: true,
    });
  });

  it('rejects a metadata-less canonical design occupant', () => {
    const design = path.join(projectRoot, '.scratch', 'plan', '2026-09-11-platform-design.md');
    writeFileSync(design, '# ordinary plan');
    assert.throws(() => resolveArtifactPath('design', {
      slug: 'platform', date: '2026-09-11', projectRoot,
    }), /metadata-less artifact/);
  });

  it('resolveArtifactPath falls back to scratch-new when nothing exists', () => {
    const resolved = resolveArtifactPath('plan', {
      slug: 'auth-v2',
      date: '2026-09-11',
      projectRoot,
      native: { orchestrator: null },
    });
    assert.deepEqual(resolved, {
      tier: 'scratch-new',
      path: '.scratch/plan/2026-09-11-auth-v2.md',
      exists: false,
    });
  });

  // O1: the temp tier is repo-scoped: `<tempRoot>/dispatch-skills-<user>/<repoHash>/relocated/`, with
  // repoHash from the project's Git root (the project root itself outside Git). No flat-temp fallback (D3).
  const relocatedDir = (tempRoot) => {
    const dir = path.join(ledgerNamespacePath({ tempRoot, repoHash: repositoryRootHash(projectRoot) }), 'relocated');
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  it('resolveArtifactPath ignores a same-slug file in flat temp (O1)', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'test-temp-artifacts-'));
    try {
      writeFileSync(path.join(tempDir, '2026-09-05-auth-v2-walkthrough.md'), '# stray walkthrough');
      writeFileSync(path.join(tempDir, '2026-09-05-auth-v2.md'), '# stray plan');
      for (const kind of ['plan', 'walkthrough']) {
        const resolved = resolveArtifactPath(kind, {
          slug: 'auth-v2',
          date: '2026-09-11',
          projectRoot,
          tempRoot: tempDir,
          native: { orchestrator: null },
        });
        assert.equal(resolved.tier, 'scratch-new', `${kind} must not bind to a flat-temp stray`);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveArtifactPath ignores a same-slug relocated file from another repository (O1)', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'test-temp-artifacts-'));
    const otherRepo = mkdtempSync(path.join(os.tmpdir(), 'resolve-artifact-paths-other-'));
    try {
      const otherDir = path.join(ledgerNamespacePath({ tempRoot: tempDir, repoHash: repositoryRootHash(otherRepo) }), 'relocated');
      mkdirSync(otherDir, { recursive: true });
      writeFileSync(path.join(otherDir, '2026-09-05-auth-v2-walkthrough.md'), '# other repo');
      const resolved = resolveArtifactPath('walkthrough', {
        slug: 'auth-v2',
        date: '2026-09-11',
        projectRoot,
        tempRoot: tempDir,
        native: { orchestrator: null },
      });
      assert.equal(resolved.tier, 'scratch-new');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(otherRepo, { recursive: true, force: true });
    }
  });

  it('resolveArtifactPath reuses an existing temp artifact over scratch-new', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'test-temp-artifacts-'));
    try {
      const tempWalkthrough = path.join(relocatedDir(tempDir), '2026-09-05-auth-v2-walkthrough.md');
      writeFileSync(tempWalkthrough, '# walkthrough');

      const resolved = resolveArtifactPath('walkthrough', {
        slug: 'auth-v2',
        date: '2026-09-11',
        projectRoot,
        tempRoot: tempDir,
        native: { orchestrator: null },
      });
      assert.deepEqual(resolved, {
        tier: 'temp-existing',
        path: tempWalkthrough.split(path.sep).join('/'),
        exists: true,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveArtifactPath reuses an existing scratch artifact over temp and scratch-new', () => {
    const dir = path.join(projectRoot, ...SCRATCH_DIR.split('/'));
    writeFileSync(path.join(dir, '2026-09-05-auth-v2.md'), '# plan');

    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'test-temp-artifacts-'));
    try {
      writeFileSync(path.join(relocatedDir(tempDir), '2026-09-04-auth-v2.md'), '# temp plan');

      const resolved = resolveArtifactPath('plan', {
        slug: 'auth-v2',
        date: '2026-09-11',
        projectRoot,
        tempRoot: tempDir,
        native: { orchestrator: null },
      });
      assert.deepEqual(resolved, {
        tier: 'scratch-existing',
        path: '.scratch/plan/2026-09-05-auth-v2.md',
        exists: true,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveArtifactPath defaults date to today when omitted', () => {
    const resolved = resolveArtifactPath('plan', {
      slug: 'auth-v2',
      projectRoot,
      native: { orchestrator: null },
    });
    assert.equal(resolved.tier, 'scratch-new');
    assert.equal(resolved.path, `.scratch/plan/${localDate()}-auth-v2.md`);
    assert.doesNotMatch(resolved.path, /undefined/);
  });

  // SECTION: Native artifact precedence and isolation

  it('resolveArtifactPath prefers a native artifact over an existing scratch one, scoped to the active conversation', () => {
    const dir = path.join(projectRoot, ...SCRATCH_DIR.split('/'));
    writeFileSync(path.join(dir, '2026-09-05-auth-v2.md'), '# plan');

    const nativeRoot = mkdtempSync(path.join(os.tmpdir(), 'resolve-artifact-paths-native-'));
    try {
      const conversationDir = path.join(nativeRoot, 'brain', 'conv-1');
      mkdirSync(conversationDir, { recursive: true });
      const nativePlan = path.join(conversationDir, 'implementation_plan.md');
      writeFileSync(nativePlan, '# native plan');

      const resolved = resolveArtifactPath('plan', {
        slug: 'auth-v2',
        date: '2026-09-11',
        projectRoot,
        native: { roots: [nativeRoot], orchestrator: 'agy', conversationId: 'conv-1' },
      });
      assert.equal(resolved.tier, 'native');
      assert.equal(resolved.path, nativePlan.split(path.sep).join('/'));
      // Unconditional, not just an identity check on POSIX: exercises the round-1
      // backslash-normalization fix even when this suite runs on a non-Windows CI.
      assert.ok(!resolved.path.includes('\\'));
      assert.equal(resolved.exists, true);
    } finally {
      rmSync(nativeRoot, { recursive: true, force: true });
    }
  });

  it('never surfaces a native artifact when the orchestrator is not agy, even if one exists on disk', () => {
    // Regression: an mtime-based cross-conversation scan with no orchestrator gate
    // would surface a stale Antigravity walkthrough from an unrelated task while
    // running under a different orchestrator (e.g. Claude Code) entirely.
    const nativeRoot = mkdtempSync(path.join(os.tmpdir(), 'resolve-artifact-paths-native-'));
    try {
      const conversationDir = path.join(nativeRoot, 'brain', 'unrelated-conv');
      mkdirSync(conversationDir, { recursive: true });
      writeFileSync(path.join(conversationDir, 'implementation_plan.md'), '# unrelated plan');

      const resolved = resolveArtifactPath('plan', {
        slug: 'auth-v2',
        date: '2026-09-11',
        projectRoot,
        native: { roots: [nativeRoot], orchestrator: 'claude' },
      });
      assert.equal(resolved.tier, 'scratch-new');
    } finally {
      rmSync(nativeRoot, { recursive: true, force: true });
    }
  });

  it('falls back to a same-platform recency guess only when no conversation id is known', () => {
    const nativeRoot = mkdtempSync(path.join(os.tmpdir(), 'resolve-artifact-paths-native-'));
    try {
      const older = path.join(nativeRoot, 'brain', 'conv-old');
      const newer = path.join(nativeRoot, 'brain', 'conv-new');
      mkdirSync(older, { recursive: true });
      mkdirSync(newer, { recursive: true });
      const olderPlan = path.join(older, 'implementation_plan.md');
      const newerPlan = path.join(newer, 'implementation_plan.md');
      writeFileSync(olderPlan, '# older plan');
      writeFileSync(newerPlan, '# newer plan');
      const now = Date.now() / 1000;
      utimesSync(olderPlan, now - 100, now - 100);
      utimesSync(newerPlan, now, now);

      const resolved = resolveArtifactPath('plan', {
        slug: 'auth-v2',
        date: '2026-09-11',
        projectRoot,
        native: { roots: [nativeRoot], orchestrator: 'agy', conversationId: null },
      });
      assert.equal(resolved.tier, 'native');
      assert.equal(resolved.path, newerPlan.split(path.sep).join('/'));
      assert.ok(!resolved.path.includes('\\'));
    } finally {
      rmSync(nativeRoot, { recursive: true, force: true });
    }
  });

  it('prefers the exact conversation id over recency even when another conversation is newer', () => {
    const nativeRoot = mkdtempSync(path.join(os.tmpdir(), 'resolve-artifact-paths-native-'));
    try {
      const active = path.join(nativeRoot, 'brain', 'active-conv');
      const other = path.join(nativeRoot, 'brain', 'other-conv');
      mkdirSync(active, { recursive: true });
      mkdirSync(other, { recursive: true });
      const activePlan = path.join(active, 'implementation_plan.md');
      const otherPlan = path.join(other, 'implementation_plan.md');
      writeFileSync(activePlan, '# active plan');
      writeFileSync(otherPlan, '# other plan');
      const now = Date.now() / 1000;
      utimesSync(activePlan, now - 100, now - 100);
      utimesSync(otherPlan, now, now);

      const resolved = resolveArtifactPath('plan', {
        slug: 'auth-v2',
        date: '2026-09-11',
        projectRoot,
        native: { roots: [nativeRoot], orchestrator: 'agy', conversationId: 'active-conv' },
      });
      assert.equal(resolved.tier, 'native');
      assert.equal(resolved.path, activePlan.split(path.sep).join('/'));
      assert.ok(!resolved.path.includes('\\'));
    } finally {
      rmSync(nativeRoot, { recursive: true, force: true });
    }
  });

  it('rejects a conversation id containing path-traversal characters, falling back to recency', () => {
    const nativeRoot = mkdtempSync(path.join(os.tmpdir(), 'resolve-artifact-paths-native-'));
    try {
      const legit = path.join(nativeRoot, 'brain', 'legit-conv');
      mkdirSync(legit, { recursive: true });
      writeFileSync(path.join(legit, 'implementation_plan.md'), '# legit plan');

      const resolved = resolveArtifactPath('plan', {
        slug: 'auth-v2',
        date: '2026-09-11',
        projectRoot,
        native: { roots: [nativeRoot], orchestrator: 'agy', conversationId: '../../etc' },
      });
      // A malformed id must never be interpolated into the path.join; falls back to
      // the same-platform recency scan (which finds legit-conv) instead of escaping.
      assert.equal(resolved.tier, 'native');
      assert.equal(resolved.path, path.join(legit, 'implementation_plan.md').split(path.sep).join('/'));
    } finally {
      rmSync(nativeRoot, { recursive: true, force: true });
    }
  });
});

// SECTION: Multi-artifact resolution contract

describe('resolveArtifacts', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(os.tmpdir(), 'resolve-artifact-paths-test-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('resolves both kinds by default', () => {
    const result = resolveArtifacts({ slug: 'auth-v2', date: '2026-09-11', projectRoot, native: { orchestrator: null } });
    assert.equal(result.slug, 'auth-v2');
    assert.equal(result.date, '2026-09-11');
    assert.equal(result.plan.path, '.scratch/plan/2026-09-11-auth-v2.md');
    assert.equal(result.walkthrough.path, '.scratch/plan/2026-09-11-auth-v2-walkthrough.md');
  });

  it('resolves only the requested kind', () => {
    const result = resolveArtifacts({
      slug: 'auth-v2',
      date: '2026-09-11',
      kinds: ['plan'],
      projectRoot,
      native: { orchestrator: null },
    });
    assert.ok(result.plan);
    assert.equal(result.walkthrough, undefined);
  });

  it('rejects a non-kebab-case slug', () => {
    assert.throws(
      () => resolveArtifacts({ slug: 'Auth_V2', projectRoot, native: { orchestrator: null } }),
      /must be kebab-case/
    );
  });

  it('rejects a missing or non-string slug rather than coercing it to a matching string', () => {
    // Regression: RegExp.test(undefined) / RegExp.test(null) coerce to the string
    // literals "undefined" / "null", both of which satisfy SLUG_PATTERN and would
    // otherwise silently produce a `...-undefined.md` / `...-null.md` artifact path.
    for (const badSlug of [undefined, null, 42, {}]) {
      assert.throws(
        () => resolveArtifacts({ slug: badSlug, projectRoot, native: { orchestrator: null } }),
        /must be kebab-case/,
        `slug: ${JSON.stringify(badSlug)}`
      );
    }
    assert.throws(
      () => resolveArtifacts({ projectRoot, native: { orchestrator: null } }),
      /must be kebab-case/
    );
  });

  it('rejects an invalid date', () => {
    assert.throws(
      () => resolveArtifacts({ slug: 'auth-v2', date: '2026-02-30', projectRoot, native: { orchestrator: null } }),
      /valid calendar date/
    );
  });
});
