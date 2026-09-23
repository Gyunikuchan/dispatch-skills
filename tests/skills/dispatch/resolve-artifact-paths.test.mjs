import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, beforeEach, afterEach } from 'node:test';

import {
  SCRATCH_DIR,
  SLUG_PATTERN,
  localDate,
  isValidDate,
  buildScratchPaths,
  canonicalRepositoryRoot,
  repositoryRootHash,
  getRepositoryRoot,
  resolveLedgerPath,
  ledgerNamespacePath,
  sanitizeSlug,
  deriveSlugFromBranch,
  deriveConversationKey,
  resolveSlug,
  getCurrentBranch,
  defaultNativeCandidateRoots,
  isNativeArtifactPath,
  isReservedOrdinarySlug,
  parseIncrementArtifactPath,
  findExistingScratchArtifact,
  findExistingTempArtifact,
  resolveArtifactPath,
  resolveArtifacts,
} from '../../../skills/dispatch/scripts/resolve-artifact-paths.mjs';
import { AGY_MODE_DATA_DIRS } from '../../../skills/dispatch/scripts/agy-run.mjs';

// Env vars detectOrchestrator()/deriveConversationKey() consult; stripped so the host agent's session cannot leak into slug derivation.
const CONVERSATION_ENV_KEYS = [
  'ANTIGRAVITY_AGENT', 'ANTIGRAVITY_CONVERSATION_ID', 'ANTIGRAVITY_SESSION_ID', 'GEMINI_CLI',
  'CLAUDECODE', 'CLAUDE_CODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT',
  'COPILOT_CLI_SESSION_ID',
];

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../skills/dispatch/scripts/resolve-artifact-paths.mjs'
);

describe('buildScratchPaths', () => {
  it('matches the canonical shape', () => {
    const paths = buildScratchPaths('2026-09-11', 'auth-v2');
    assert.equal(paths.plan, '.scratch/plan/2026-09-11-auth-v2.md');
    assert.equal(paths.walkthrough, '.scratch/plan/2026-09-11-auth-v2-walkthrough.md');
    assert.equal(buildScratchPaths('2026-09-11', 'auth-i01-model', 'increment-plan'), '.scratch/plan/2026-09-11-auth-i01-model-plan.md');
    assert.equal(buildScratchPaths('2026-09-11', 'auth-i01-model', 'increment-walkthrough'), '.scratch/plan/2026-09-11-auth-i01-model-walkthrough.md');
    assert.equal(buildScratchPaths('2026-09-11', 'auth', 'design'), '.scratch/plan/2026-09-11-auth-design.md');
    assert.equal(buildScratchPaths('2026-09-11', 'auth', 'integration-walkthrough'), '.scratch/plan/2026-09-11-auth-integration-walkthrough.md');
    assert.equal(resolveArtifacts({
      slug: 'auth-i01-model', slugSource: 'explicit', date: '2026-09-11',
      kinds: ['increment-plan'], repositoryRoot: null,
    })['increment-plan'].path, '.scratch/plan/2026-09-11-auth-i01-model-plan.md');
  });

  it('reserves phased identities from ordinary and design root slugs', () => {
    for (const slug of ['root-design', 'root-integration', 'root-integration-walkthrough', 'root-i01-model']) {
      assert.equal(isReservedOrdinarySlug(slug), true, slug);
      assert.throws(() => resolveArtifacts({ slug, slugSource: 'branch', kinds: ['plan'] }), /reserved/);
    }
  });

  describe('increment artifact identity', () => {
    it('parses canonical increment plan and walkthrough paths', () => {
      const parsed = parseIncrementArtifactPath('.scratch/plan/2026-09-21-demo-i01-foundation-plan.md');
      assert.deepEqual(parsed, {
        date: '2026-09-21', designRootSlug: 'demo', incrementId: 'I01',
        incrementSlug: 'foundation', kind: 'increment-plan',
      });
      const walkthrough = parseIncrementArtifactPath('.scratch/plan/2026-09-21-demo-i01-foundation-walkthrough.md');
      assert.equal(walkthrough.kind, 'increment-walkthrough');
      assert.equal(parseIncrementArtifactPath('.scratch/plan/2026-09-21-demo-design.md'), null);
      assert.equal(parseIncrementArtifactPath('.scratch/plan/2026-09-21-demo-plan.md'), null);
      assert.equal(parseIncrementArtifactPath('.scratch/plan/2026-09-21-demo-i1-short-plan.md'), null);
    });

    it('rejects a second -iNN- segment inside the increment slug', () => {
      assert.throws(
        () => parseIncrementArtifactPath('.scratch/plan/2026-09-21-demo-i01-foundation-i02-switch-plan.md'),
        /ambiguous|-i\\d\{2\}-|second/,
      );
    });

    it('fails closed on cross-date reserved-form collisions for the same root slug', () => {
      const root = process.cwd();
      const scratch = path.join(root, '.scratch', 'plan');
      mkdirSync(scratch, { recursive: true });
      const fixture = path.join(scratch, '2026-01-01-collision-design.md');
      writeFileSync(fixture, '# fixture\n');
      try {
        assert.throws(
          () => resolveArtifactPath('increment-plan', { slug: 'collision-i01-one', date: '2026-09-21', projectRoot: root }),
          /collision|reserved|occupied/,
        );
      } finally {
        rmSync(fixture, { force: true });
      }
    });
  });

  describe('ledger path resolution', () => {
    it('canonicalizes roots and emits a stable lowercase 12-hex repository hash', () => {
      const realpath = value => value;
      assert.equal(canonicalRepositoryRoot('C:\\Work\\Repo', { platform: 'win32', realpath }), 'c:/work/repo');
      assert.match(repositoryRootHash(process.cwd(), { realpath }), /^[a-f0-9]{12}$/);
      assert.equal(repositoryRootHash(process.cwd(), { realpath }), repositoryRootHash(process.cwd(), { realpath }));
    });

    it('isolates different worktree roots and sanitizes the username', () => {
      const first = resolveLedgerPath({
        slug: 'phase-two', slugSource: 'explicit', repositoryRoot: '/repo/a',
        tempRoot: '/tmp', env: { USER: 'a/b' }, realpath: value => value,
      });
      const second = resolveLedgerPath({
        slug: 'phase-two', slugSource: 'explicit', repositoryRoot: '/repo/b',
        tempRoot: '/tmp', env: { USER: 'a/b' }, realpath: value => value,
      });
      assert.notEqual(first, second);
      assert.match(first, /dispatch-skills-a_b[/\\][a-f0-9]{12}[/\\]phase-two-ledger\.md$/);
    });

    it('returns null for conversation slugs and outside a Git work tree', () => {
      assert.equal(resolveLedgerPath({
        slug: 'conversation-abcd', slugSource: 'conversation', repositoryRoot: process.cwd(),
      }), null);
      assert.equal(resolveLedgerPath({
        slug: 'phase-two', slugSource: 'explicit', repositoryRoot: null,
      }), null);
      const outside = mkdtempSync(path.join(os.tmpdir(), 'ledger-not-git-'));
      try {
        assert.equal(getRepositoryRoot(outside), null);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('keeps resolveArtifacts ledger-null when slug provenance is omitted or conversational', () => {
      const omitted = resolveArtifacts({
        slug: 'conversation-abcd', kinds: ['plan'], projectRoot: process.cwd(),
        native: { orchestrator: null },
      });
      assert.equal(omitted.ledgerPath, null);
      const conversation = resolveArtifacts({
        slug: 'conversation-abcd', slugSource: 'conversation', kinds: ['plan'],
        projectRoot: process.cwd(), native: { orchestrator: null },
      });
      assert.equal(conversation.ledgerPath, null);
    });
  });
});

describe('sanitizeSlug', () => {
  it('kebab-cases arbitrary text', () => {
    assert.equal(sanitizeSlug('Auth V2!! Rewrite'), 'auth-v2-rewrite');
  });

  it('returns null for text with nothing kebab-worthy', () => {
    assert.equal(sanitizeSlug('###'), null);
    assert.equal(sanitizeSlug(''), null);
    assert.equal(sanitizeSlug(null), null);
  });

  it('caps length and trims a trailing dash left by truncation', () => {
    const slug = sanitizeSlug('a'.repeat(100));
    assert.ok(slug.length <= 60);
    assert.ok(SLUG_PATTERN.test(slug));
  });
});

describe('deriveSlugFromBranch', () => {
  it('strips a type prefix and kebab-cases the remainder', () => {
    assert.equal(deriveSlugFromBranch('feature/Auth-V2'), 'auth-v2');
    assert.equal(deriveSlugFromBranch('fix/billing_engine'), 'billing-engine');
  });

  it('rejects protected branch names', () => {
    for (const branch of ['main', 'master', 'develop', 'trunk', 'HEAD']) {
      assert.equal(deriveSlugFromBranch(branch), null, branch);
    }
  });

  it('returns null for a null or empty branch', () => {
    assert.equal(deriveSlugFromBranch(null), null);
    assert.equal(deriveSlugFromBranch(''), null);
  });
});

describe('deriveConversationKey', () => {
  it('derives a conversation-<8 chars> key from agy env vars, preferring conversation id over session id', () => {
    const key = deriveConversationKey({
      orchestrator: 'agy',
      env: { ANTIGRAVITY_CONVERSATION_ID: 'abcd1234efgh', ANTIGRAVITY_SESSION_ID: 'zzzzzzzzzzzz' },
    });
    assert.equal(key, 'conversation-abcd1234');
  });

  it('falls back to the session id when the conversation id is unset', () => {
    const key = deriveConversationKey({
      orchestrator: 'agy',
      env: { ANTIGRAVITY_SESSION_ID: 'session-9999' },
    });
    assert.equal(key, 'conversation-session');
  });

  it('reads CLAUDE_CODE_SESSION_ID for the claude orchestrator', () => {
    const key = deriveConversationKey({ orchestrator: 'claude', env: { CLAUDE_CODE_SESSION_ID: '12345678abcd' } });
    assert.equal(key, 'conversation-12345678');
  });

  it('reads COPILOT_CLI_SESSION_ID for the copilot orchestrator', () => {
    const key = deriveConversationKey({ orchestrator: 'copilot', env: { COPILOT_CLI_SESSION_ID: 'cop1lot-id' } });
    assert.equal(key, 'conversation-cop1lot');
  });

  it('never reads another orchestrator\'s env var, even when set', () => {
    const key = deriveConversationKey({
      orchestrator: 'claude',
      env: { ANTIGRAVITY_CONVERSATION_ID: 'abcd1234', COPILOT_CLI_SESSION_ID: 'efgh5678' },
    });
    assert.equal(key, null);
  });

  it('returns null for opencode: no documented session/conversation id env var is exposed', () => {
    const key = deriveConversationKey({
      orchestrator: 'opencode',
      env: { OPENCODE_SESSION_ID: 'should-be-ignored' },
    });
    assert.equal(key, null);
  });

  it('returns null when the orchestrator is unknown or the env var is unset', () => {
    assert.equal(deriveConversationKey({ orchestrator: 'unknown-platform', env: {} }), null);
    assert.equal(deriveConversationKey({ orchestrator: 'claude', env: {} }), null);
  });

  it('strips a trailing hyphen left by truncation and sanitizes non-slug characters', () => {
    const key = deriveConversationKey({ orchestrator: 'claude', env: { CLAUDE_CODE_SESSION_ID: 'AB__12-3456' } });
    assert.match(key, SLUG_PATTERN);
  });

  it('returns null when the id sanitizes to nothing usable', () => {
    const key = deriveConversationKey({ orchestrator: 'claude', env: { CLAUDE_CODE_SESSION_ID: '####' } });
    assert.equal(key, null);
  });
});

describe('resolveSlug', () => {
  it('prefers an explicit slug over branch or conversation derivation', () => {
    const result = resolveSlug({
      explicit: 'my-explicit-slug',
      branch: 'feature/other-thing',
      orchestrator: 'claude',
      env: { CLAUDE_CODE_SESSION_ID: 'abcd1234' },
    });
    assert.deepEqual(result, { slug: 'my-explicit-slug', slugSource: 'explicit' });
  });

  it('falls back to the branch-derived slug when no explicit slug is given', () => {
    const result = resolveSlug({
      branch: 'feature/Auth-V2',
      orchestrator: 'claude',
      env: { CLAUDE_CODE_SESSION_ID: 'abcd1234' },
    });
    assert.deepEqual(result, { slug: 'auth-v2', slugSource: 'branch' });
  });

  it('falls back to the conversation key when the branch is protected or detached', () => {
    const result = resolveSlug({
      branch: 'main',
      orchestrator: 'claude',
      env: { CLAUDE_CODE_SESSION_ID: 'abcd1234' },
    });
    assert.deepEqual(result, { slug: 'conversation-abcd1234', slugSource: 'conversation' });
  });

  it('returns { slug: null, slugSource: null } when every source fails', () => {
    const result = resolveSlug({ branch: null, orchestrator: 'opencode', env: {} });
    assert.deepEqual(result, { slug: null, slugSource: null });
  });
});

describe('defaultNativeCandidateRoots', () => {
  it('includes every Antigravity execution mode data dir', () => {
    const roots = defaultNativeCandidateRoots();
    for (const dataDir of Object.values(AGY_MODE_DATA_DIRS)) {
      assert.ok(
        roots.some(root => root.endsWith(path.join('.gemini', dataDir))),
        `expected a root ending in .gemini/${dataDir}, got: ${roots.join(', ')}`
      );
    }
  });

  describe('isNativeArtifactPath', () => {
    it('requires the exact native filename within a configured root', () => {
      const root = path.resolve('test-native-root');
      assert.equal(isNativeArtifactPath(path.join(root, 'conversation', 'implementation_plan.md'), 'plan', { roots: [root] }), true);
      assert.equal(isNativeArtifactPath(path.join(root, 'conversation', 'walkthrough.md'), 'walkthrough', { roots: [root] }), true);
      assert.equal(isNativeArtifactPath(path.join(root, 'implementation_plan.md'), 'plan', { roots: [root] }), true);
      assert.equal(isNativeArtifactPath(path.join(root, 'conversation', 'other.md'), 'plan', { roots: [root] }), false);
      assert.equal(isNativeArtifactPath(path.join(`${root}-sibling`, 'implementation_plan.md'), 'plan', { roots: [root] }), false);
    });
  });

  it('includes APPDATA/LOCALAPPDATA roots on win32', () => {
    const roots = defaultNativeCandidateRoots({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
    });
    assert.ok(roots.some(root => root.startsWith('C:\\Users\\test\\AppData\\Roaming')));
    assert.ok(roots.some(root => root.startsWith('C:\\Users\\test\\AppData\\Local')));
  });

  it('excludes APPDATA/LOCALAPPDATA roots off win32, even when set', () => {
    const roots = defaultNativeCandidateRoots({
      platform: 'linux',
      env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
    });
    assert.ok(!roots.some(root => root.includes('AppData')));
  });
});

describe('getCurrentBranch', () => {
  let repoDir;

  beforeEach(() => {
    repoDir = mkdtempSync(path.join(os.tmpdir(), 'resolve-artifact-paths-git-'));
    const git = (...args) => {
      const res = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
      assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
      return res.stdout;
    };
    git('init', '--quiet', '--initial-branch=work');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(path.join(repoDir, 'file.txt'), 'content');
    git('add', 'file.txt');
    git('commit', '--no-gpg-sign', '--quiet', '-m', 'initial commit');
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('returns the current branch name', () => {
    assert.equal(getCurrentBranch(repoDir), 'work');
  });

  it('returns null on detached HEAD', () => {
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).stdout.trim();
    const checkout = spawnSync('git', ['checkout', '--quiet', sha], { cwd: repoDir, encoding: 'utf8' });
    assert.equal(checkout.status, 0, checkout.stderr);
    assert.equal(getCurrentBranch(repoDir), null);
  });

  it('returns null outside a git repository', () => {
    const nonRepoDir = mkdtempSync(path.join(os.tmpdir(), 'resolve-artifact-paths-non-git-'));
    try {
      assert.equal(getCurrentBranch(nonRepoDir), null);
    } finally {
      rmSync(nonRepoDir, { recursive: true, force: true });
    }
  });
});

describe('isValidDate / localDate', () => {
  it('accepts a real calendar date and rejects a fake one', () => {
    assert.equal(isValidDate('2026-09-11'), true);
    assert.equal(isValidDate('2026-02-30'), false);
    assert.equal(isValidDate('2026-9-1'), false);
  });

  it('formats today as yyyy-mm-dd', () => {
    assert.match(localDate(new Date('2026-01-05T12:00:00Z')), /^2026-01-05$/);
  });
});

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
    writeFileSync(design, '# legacy ordinary plan');
    assert.throws(() => resolveArtifactPath('design', {
      slug: 'platform', date: '2026-09-11', projectRoot,
    }), /metadata-less legacy artifact/);
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

describe('resolve-artifact-paths CLI', () => {
  // Isolate HOME/APPDATA/LOCALAPPDATA to an empty temp dir so a real machine's
  // Antigravity brain directory (which may genuinely hold artifacts) can never
  // surface as a native-tier result and make this suite machine-dependent.
  let isolatedHome;

  beforeEach(() => {
    isolatedHome = mkdtempSync(path.join(os.tmpdir(), 'resolve-artifact-paths-cli-home-'));
  });

  afterEach(() => {
    rmSync(isolatedHome, { recursive: true, force: true });
  });

  function runCli(args) {
    const env = {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      APPDATA: path.join(isolatedHome, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(isolatedHome, 'AppData', 'Local'),
    };
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
  }

  it('rejects a slug that would escape the scratch directory', () => {
    const res = runCli(['--slug', '../evil']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /must be kebab-case/);
  });

  it('rejects an invalid --kind', () => {
    const res = runCli(['--slug', 'auth-v2', '--kind', 'bogus']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /--kind must be one of plan, walkthrough, both/);
  });

  it('emits both artifact paths for an explicit slug, with slugSource "explicit"', () => {
    // Slug scans this repo's real .scratch/plan/ (the CLI runs against PROJECT_ROOT,
    // not an isolated one) — kept implausibly specific so a genuine same-day scratch
    // artifact can never collide and flip the asserted tier to scratch-existing.
    const res = runCli(['--slug', 'cli-scratch-new-tier-test-fixture', '--date', '2026-09-11']);
    assert.equal(res.status, 0);
    const result = JSON.parse(res.stdout);
    assert.equal(result.slug, 'cli-scratch-new-tier-test-fixture');
    assert.equal(result.slugSource, 'explicit');
    assert.equal(result.date, '2026-09-11');
    assert.equal(result.plan.tier, 'scratch-new');
    assert.equal(result.plan.path, '.scratch/plan/2026-09-11-cli-scratch-new-tier-test-fixture.md');
    assert.equal(result.walkthrough.tier, 'scratch-new');
    assert.equal(
      result.walkthrough.path,
      '.scratch/plan/2026-09-11-cli-scratch-new-tier-test-fixture-walkthrough.md'
    );
  });

  it('derives slugSource "branch" when --slug is omitted and the branch yields a slug', () => {
    // Deterministic fixture: a temp repo checked out on a non-protected branch, with every
    // conversation marker stripped, so neither the live repo's branch nor the host agent leaks in.
    const strippedEnv = { ...process.env };
    for (const key of CONVERSATION_ENV_KEYS) {
      delete strippedEnv[key];
    }
    const repo = path.join(isolatedHome, 'repo');
    mkdirSync(repo);
    const git = (...args) =>
      spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
        cwd: repo,
        encoding: 'utf8',
      });
    assert.equal(git('init', '-q').status, 0);
    assert.equal(git('checkout', '-q', '-b', 'feature/branch-slug-fixture').status, 0);
    assert.equal(git('commit', '-q', '--allow-empty', '--no-gpg-sign', '-m', 'fixture').status, 0);

    const res = spawnSync(process.execPath, [SCRIPT, '--date', '2026-09-11'], {
      encoding: 'utf8',
      env: {
        ...strippedEnv,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        APPDATA: path.join(isolatedHome, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(isolatedHome, 'AppData', 'Local'),
      },
      cwd: repo,
    });
    assert.equal(res.status, 0, res.stderr);
    const result = JSON.parse(res.stdout);
    assert.equal(result.slugSource, 'branch');
  });

  it('errors when --slug is omitted and both branch and conversation-id derivation fail', () => {
    // Strip every env var detectOrchestrator()/deriveConversationKey() consult — this
    // suite itself runs under Claude Code, whose own CLAUDE_CODE_SESSION_ID etc. would
    // otherwise leak in via ...process.env and let conversation-id derivation succeed.
    const strippedEnv = { ...process.env };
    for (const key of CONVERSATION_ENV_KEYS) {
      delete strippedEnv[key];
    }
    const res = spawnSync(process.execPath, [SCRIPT, '--date', '2026-09-11'], {
      encoding: 'utf8',
      env: {
        ...strippedEnv,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        APPDATA: path.join(isolatedHome, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(isolatedHome, 'AppData', 'Local'),
        // Force branch derivation to fail (outside any git repo).
        GIT_CEILING_DIRECTORIES: isolatedHome,
      },
      cwd: isolatedHome,
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Could not derive a slug/);
  });

  it('never reports a native tier for an orchestrator with no known native artifact', () => {
    const res = runCli(['--slug', 'cli-scratch-new-tier-test-fixture', '--date', '2026-09-11', '--orchestrator', 'copilot']);
    assert.equal(res.status, 0);
    const result = JSON.parse(res.stdout);
    assert.equal(result.plan.tier, 'scratch-new');
  });

  it('accepts --flag=value form equivalently to space-separated flags', () => {
    const res = runCli([
      '--slug=cli-scratch-new-tier-test-fixture',
      '--date=2026-09-11',
      '--kind=plan',
      '--orchestrator=copilot',
    ]);
    assert.equal(res.status, 0);
    const result = JSON.parse(res.stdout);
    assert.equal(result.slug, 'cli-scratch-new-tier-test-fixture');
    assert.equal(result.date, '2026-09-11');
    assert.equal(result.plan.path, '.scratch/plan/2026-09-11-cli-scratch-new-tier-test-fixture.md');
    assert.equal(result.walkthrough, undefined);
  });
});
