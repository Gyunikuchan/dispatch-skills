import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  findExistingScratchArtifact, resolveArtifactPath, resolveArtifacts,
} from '../../../../skills/dispatch/scripts/artifacts/resolve-paths.mjs';
import { bindWorkflowSession } from '../../../../skills/dispatch/scripts/lib/session-temp.mjs';

describe('canonical artifacts in the active chat folder', () => {
  let repositoryRoot;
  let session;
  let saved;
  const normalized = value => path.resolve(value).replaceAll('\\', '/');

  beforeEach(() => {
    const keys = ['DISPATCH_SESSION_DIR', 'DISPATCH_RUN_ID', 'DISPATCH_CHAT_ID'];
    saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-session-artifact-'));
    process.env.DISPATCH_CHAT_ID = `resolve-${process.pid}-${Date.now()}`;
    session = bindWorkflowSession({ repositoryRoot, artifactKind: 'plan', slug: 'auth-v2' });
  });

  afterEach(() => {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it('resolves plans and walkthroughs below the active session artifacts directory', () => {
    const plan = resolveArtifactPath('plan', { slug: 'auth-v2', date: '2026-09-27', projectRoot: repositoryRoot, repositoryRoot });
    const walkthrough = resolveArtifactPath('walkthrough', { slug: 'auth-v2', date: '2026-09-27', projectRoot: repositoryRoot, repositoryRoot });
    assert.equal(normalized(plan.path), normalized(path.join(session, 'artifacts', '2026-09-27-auth-v2.md')));
    assert.equal(normalized(walkthrough.path), normalized(path.join(session, 'artifacts', '2026-09-27-auth-v2-walkthrough.md')));
    assert.equal(plan.exists, false);
    fs.writeFileSync(plan.path, 'plan');
    assert.equal(normalized(findExistingScratchArtifact('plan', 'auth-v2', repositoryRoot)), normalized(plan.path));
    assert.equal(normalized(resolveArtifactPath('plan', { slug: 'auth-v2', projectRoot: repositoryRoot, repositoryRoot }).path), normalized(plan.path));
  });

  it('keeps ledger and phased artifacts in the same session root', () => {
    const resolved = resolveArtifacts({
      slug: 'design-root', slugSource: 'explicit', date: '2026-09-27', kinds: ['design', 'increment-plan', 'integration-walkthrough'],
      projectRoot: repositoryRoot, repositoryRoot,
    });
    assert.equal(normalized(path.dirname(resolved.ledgerPath)), normalized(path.join(session, 'ledger')));
    for (const kind of ['design', 'increment-plan', 'integration-walkthrough']) {
      assert.equal(normalized(path.dirname(resolved[kind].path)), normalized(path.join(session, 'artifacts')));
    }
  });

  it('imports a platform-native plan as a session working copy', () => {
    const nativeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'native-plan-root-'));
    const native = path.join(nativeRoot, 'brain', 'conversation-42', 'implementation_plan.md');
    fs.mkdirSync(path.dirname(native), { recursive: true });
    fs.writeFileSync(native, '# Native plan');
    try {
      const result = resolveArtifactPath('plan', {
        slug: 'native-plan', date: '2026-09-27', projectRoot: repositoryRoot, repositoryRoot,
        native: { roots: [nativeRoot], orchestrator: 'agy', conversationId: 'conversation-42' },
      });
      assert.equal(result.tier, 'session-import');
      assert.equal(normalized(result.path), normalized(path.join(session, 'artifacts', '2026-09-27-native-plan.md')));
      assert.notEqual(normalized(result.path), normalized(native));
      assert.equal(fs.readFileSync(result.path, 'utf8'), '# Native plan');
      fs.writeFileSync(native, '# Updated native plan');
      assert.equal(fs.readFileSync(result.path, 'utf8'), '# Native plan');
    } finally { fs.rmSync(nativeRoot, { recursive: true, force: true }); }
  });
});
