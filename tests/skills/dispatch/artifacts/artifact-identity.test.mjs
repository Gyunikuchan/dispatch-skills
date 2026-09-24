import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  SLUG_PATTERN,
  buildScratchPaths,
  canonicalRepositoryRoot,
  defaultNativeCandidateRoots,
  deriveConversationKey,
  deriveSlugFromBranch,
  getCurrentBranch,
  getRepositoryRoot,
  isNativeArtifactPath,
  isReservedOrdinarySlug,
  isValidDate,
  ledgerNamespacePath,
  localDate,
  parseIncrementArtifactPath,
  repositoryRootHash,
  resolveArtifactPath,
  resolveArtifacts,
  resolveLedgerPath,
  resolveSlug,
  sanitizeSlug,
} from '../../../../skills/dispatch/scripts/artifacts/resolve-paths.mjs';
import { AGY_MODE_DATA_DIRS } from '../../../../skills/dispatch/scripts/runners/agy.mjs';

// SECTION: Artifact identities and namespaces

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

// SECTION: Slug derivation and validation

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

// SECTION: Native artifact boundaries

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

// SECTION: Runtime-derived identities

describe('getCurrentBranch', () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'resolve-artifact-paths-git-'));

  before(() => {
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

  after(() => {
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

