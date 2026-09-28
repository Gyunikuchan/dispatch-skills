import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  SLUG_PATTERN, buildScratchPaths, deriveConversationKey, deriveSlugFromBranch,
  isReservedOrdinarySlug, parseIncrementArtifactPath,
  resolveArtifacts, resolveLedgerPath, resolveSlug, sanitizeSlug,
} from '../../../../skills/dispatch/scripts/artifacts/resolve-paths.mjs';
import { bindWorkflowSession } from '../../../../skills/dispatch/scripts/lib/session-temp.mjs';

describe('artifact identity is bound to the chat session', () => {
  let repositoryRoot;
  let session;
  let saved;
  let extraRoots;
  const normalized = value => path.resolve(value).replaceAll('\\', '/');

  beforeEach(() => {
    const keys = ['DISPATCH_SESSION_DIR', 'DISPATCH_RUN_ID', 'DISPATCH_CHAT_ID'];
    saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-identity-repo-'));
    extraRoots = [];
    process.env.DISPATCH_CHAT_ID = `artifact-${process.pid}-${Date.now()}`;
    session = bindWorkflowSession({ repositoryRoot, artifactKind: 'plan', slug: 'auth-v2' });
  });

  afterEach(() => {
    for (const root of [repositoryRoot, ...extraRoots]) fs.rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it('builds every canonical artifact under the active session artifacts area', () => {
    const artifacts = path.join(session, 'artifacts');
    const paths = buildScratchPaths('auth-v2');
    assert.equal(normalized(paths.plan), normalized(path.join(artifacts, 'auth-v2.md')));
    assert.equal(normalized(paths.walkthrough), normalized(path.join(artifacts, 'auth-v2-walkthrough.md')));
    assert.equal(normalized(buildScratchPaths('auth', 'design')), normalized(path.join(artifacts, 'auth-design.md')));
    assert.equal(normalized(buildScratchPaths('auth-i01-model', 'increment-plan')), normalized(path.join(artifacts, 'auth-i01-model-plan.md')));
    assert.equal(normalized(buildScratchPaths('auth', 'integration-walkthrough')), normalized(path.join(artifacts, 'auth-integration-walkthrough.md')));
    const resolved = resolveArtifacts({ slug: 'auth-i01-model', slugSource: 'explicit', kinds: ['increment-plan'], repositoryRoot });
    assert.equal(normalized(resolved['increment-plan'].path), normalized(buildScratchPaths('auth-i01-model', 'increment-plan')));
  });

  it('parses increment identities from session paths and rejects ambiguous nested increments', () => {
    const plan = path.join(session, 'artifacts', 'demo-i01-foundation-plan.md');
    assert.deepEqual(parseIncrementArtifactPath(plan), {
      designRootSlug: 'demo', incrementId: 'I01', incrementSlug: 'foundation', kind: 'increment-plan',
    });
    assert.equal(parseIncrementArtifactPath(path.join(session, 'artifacts', 'demo-i01-foundation-walkthrough.md')).kind, 'increment-walkthrough');
    assert.equal(parseIncrementArtifactPath(path.join(session, 'artifacts', 'demo-design.md')), null);
    assert.throws(() => parseIncrementArtifactPath(path.join(session, 'artifacts', 'demo-i01-foundation-i02-switch-plan.md')), /ambiguous|second/);
  });

  it('stores each repository ledger inside its own chat root', () => {
    const first = resolveLedgerPath({ slug: 'auth-v2', slugSource: 'explicit', repositoryRoot, artifactKind: 'plan' });
    const secondRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-identity-other-'));
    extraRoots.push(secondRepo);
    delete process.env.DISPATCH_SESSION_DIR;
    delete process.env.DISPATCH_RUN_ID;
    const otherSession = bindWorkflowSession({ repositoryRoot: secondRepo, artifactKind: 'plan', slug: 'auth-v2' });
    const second = resolveLedgerPath({ slug: 'auth-v2', slugSource: 'explicit', repositoryRoot: secondRepo, artifactKind: 'plan' });
    assert.notEqual(first, second);
    assert.equal(normalized(path.dirname(first)), normalized(path.join(session, 'ledger')));
    assert.equal(normalized(path.dirname(second)), normalized(path.join(otherSession, 'ledger')));
    assert.equal(resolveLedgerPath({ slug: 'conversation-abcd', slugSource: 'conversation', repositoryRoot }), null);
  });
});

describe('slug identities', () => {
  it('sanitizes slugs and rejects reserved ordinary names', () => {
    assert.equal(sanitizeSlug('Auth V2!! Rewrite'), 'auth-v2-rewrite');
    assert.equal(isReservedOrdinarySlug('root-i01-model'), true);
    assert.match(sanitizeSlug('a'.repeat(100)), SLUG_PATTERN);
    assert.equal(deriveSlugFromBranch('feature/Auth-V2'), 'auth-v2');
    assert.equal(deriveSlugFromBranch('main'), null);
  });

  it('reports a conversation key only for known platforms', () => {
    assert.equal(deriveConversationKey({ orchestrator: 'claude', env: { CLAUDE_CODE_SESSION_ID: '12345678abcd' } }), 'conversation-12345678');
    assert.equal(deriveConversationKey({ orchestrator: 'opencode', env: { OPENCODE_SESSION_ID: 'ignored' } }), null);
    assert.deepEqual(resolveSlug({ branch: 'feature/Auth-V2' }), { slug: 'auth-v2', slugSource: 'branch' });
  });

});
