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
    const plan = resolveArtifactPath('plan', { slug: 'auth-v2', projectRoot: repositoryRoot, repositoryRoot });
    const walkthrough = resolveArtifactPath('walkthrough', { slug: 'auth-v2', projectRoot: repositoryRoot, repositoryRoot });
    assert.equal(normalized(plan.path), normalized(path.join(session, 'auth-v2.plan.md')));
    assert.equal(normalized(walkthrough.path), normalized(path.join(session, 'auth-v2.walkthrough.md')));
    assert.equal(plan.exists, false);
    fs.writeFileSync(plan.path, 'plan');
    assert.equal(normalized(findExistingScratchArtifact('plan', 'auth-v2', repositoryRoot)), normalized(plan.path));
    assert.equal(normalized(resolveArtifactPath('plan', { slug: 'auth-v2', projectRoot: repositoryRoot, repositoryRoot }).path), normalized(plan.path));
  });

  it('ignores a symlink at the canonical artifact path', (t) => {
    const outside = path.join(repositoryRoot, 'outside.md');
    fs.writeFileSync(outside, 'outside');
    const plan = resolveArtifactPath('plan', { slug: 'linked', projectRoot: repositoryRoot, repositoryRoot });
    try { fs.symlinkSync(outside, plan.path, 'file'); }
    catch (error) { if (error.code === 'EPERM') return t.skip('symlinks need elevated rights'); throw error; }
    assert.equal(findExistingScratchArtifact('plan', 'linked', repositoryRoot), null);
  });

  it('refuses a symlink at a phased or native-import canonical path', (t) => {
    const outside = path.join(repositoryRoot, 'outside.md');
    fs.writeFileSync(outside, 'outside');
    const design = resolveArtifactPath('design', { slug: 'linked', projectRoot: repositoryRoot, repositoryRoot });
    try { fs.symlinkSync(outside, design.path, 'file'); }
    catch (error) { if (error.code === 'EPERM') return t.skip('symlinks need elevated rights'); throw error; }
    assert.throws(() => resolveArtifactPath('design', { slug: 'linked', projectRoot: repositoryRoot, repositoryRoot }), /is a symlink/);
    const nativeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'native-link-root-'));
    try {
      const native = path.join(nativeRoot, 'brain', 'conversation-7', 'implementation_plan.md');
      fs.mkdirSync(path.dirname(native), { recursive: true });
      fs.writeFileSync(native, '# Native plan');
      fs.symlinkSync(outside, path.join(session, 'native-link.plan.md'), 'file');
      assert.throws(() => resolveArtifactPath('plan', {
        slug: 'native-link', projectRoot: repositoryRoot, repositoryRoot,
        native: { roots: [nativeRoot], orchestrator: 'agy', conversationId: 'conversation-7' },
      }), /is a symlink/);
    } finally { fs.rmSync(nativeRoot, { recursive: true, force: true }); }
  });

  it('keeps ledger and phased artifacts in the same session root', () => {
    const resolved = resolveArtifacts({
      slug: 'design-root', slugSource: 'explicit', kinds: ['design', 'integration-walkthrough'],
      projectRoot: repositoryRoot, repositoryRoot,
    });
    const increment = resolveArtifacts({
      slug: 'design-root-i01-core', slugSource: 'explicit', kinds: ['increment-plan'],
      projectRoot: repositoryRoot, repositoryRoot,
    });
    assert.equal(normalized(path.dirname(resolved.ledgerPath)), normalized(path.join(session, '.state')));
    for (const artifact of [resolved.design, resolved['integration-walkthrough'], increment['increment-plan']]) {
      assert.equal(normalized(path.dirname(artifact.path)), normalized(session));
    }
  });

  it('imports a platform-native plan as a session working copy', () => {
    const nativeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'native-plan-root-'));
    const native = path.join(nativeRoot, 'brain', 'conversation-42', 'implementation_plan.md');
    fs.mkdirSync(path.dirname(native), { recursive: true });
    fs.writeFileSync(native, '# Native plan');
    try {
      const result = resolveArtifactPath('plan', {
        slug: 'native-plan', projectRoot: repositoryRoot, repositoryRoot,
        native: { roots: [nativeRoot], orchestrator: 'agy', conversationId: 'conversation-42' },
      });
      assert.equal(result.tier, 'session-import');
      assert.equal(normalized(result.path), normalized(path.join(session, 'native-plan.plan.md')));
      assert.notEqual(normalized(result.path), normalized(native));
      assert.equal(fs.readFileSync(result.path, 'utf8'), '# Native plan');
      fs.writeFileSync(native, '# Updated native plan');
      assert.equal(fs.readFileSync(result.path, 'utf8'), '# Native plan');
    } finally { fs.rmSync(nativeRoot, { recursive: true, force: true }); }
  });
});
