import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  RUN_ENV, RUN_FLAG, SESSION_ENV, SESSION_FLAG, assertWorkflowSession, bindRun,
  bindWorkflowSession, consumeSessionFlag, isPublishedSessionDir, isWorkspaceSessionDir,
  openSession, pruneSessions, readSessionManifest, runDir, runId, sessionArgs, sessionDir, sessionTempDir,
  publishedSessionRoot,
} from '../../../../skills/dispatch/scripts/lib/session-temp.mjs';

describe('chat session binding', () => {
  let saved;
  let repositoryRoot;
  let ownedRoots;

  beforeEach(() => {
    const keys = [
      SESSION_ENV, RUN_ENV, 'DISPATCH_SESSION_TERMINAL', 'DISPATCH_CHAT_ID', 'CODEX_THREAD_ID',
    ];
    saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-session-repo-'));
    ownedRoots = [];
  });

  afterEach(() => {
    for (const root of ownedRoots) fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it('clears inherited dispatch bindings only during the first isolated-temp preload', () => {
    const preload = fileURLToPath(new URL('../../../helpers/isolated-temp.mjs', import.meta.url));
    const env = { ...process.env, DISPATCH_TEST_TEMP_PRELOAD: preload };
    delete env.DISPATCH_TEST_TEMP;
    const flags = [
      'DISPATCH_SESSION_DIR', 'DISPATCH_RUN_ID',
      'DISPATCH_SESSION_TERMINAL',
    ];
    for (const key of flags) env[key] = 'inherited';
    const script = `
      import { pathToFileURL } from 'node:url';
      const flags = ${JSON.stringify(flags)};
      const cleared = flags.every(key => process.env[key] === undefined);
      for (const key of flags) process.env[key] = 'fixture';
      await import(pathToFileURL(process.env.DISPATCH_TEST_TEMP_PRELOAD).href + '?fixture');
      const preserved = flags.every(key => process.env[key] === 'fixture');
      process.stdout.write(JSON.stringify({ cleared, preserved }));
    `;
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, '--input-type=module', '-e', script], { encoding: 'utf8', env, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { cleared: true, preserved: true });
  });

  it('keeps multiple workflows in one chat folder and gives each workflow a distinct run ID', () => {
    process.env.DISPATCH_CHAT_ID = 'chat-123';
    const first = bindWorkflowSession({ repositoryRoot, artifactKind: 'plan', slug: 'first-task', objective: 'Build the first task' });
    ownedRoots.push(first);
    const manifest = readSessionManifest(first);
    assert.equal(path.dirname(first), path.join(repositoryRoot, '.scratch', 'dispatch-skills'));
    assert.equal(manifest.sessionId, 'chat-123');
    assert.equal(manifest.sessionTitle, 'build-the-first-task');
    assert.equal(manifest.location, 'workspace');
    const firstRun = runId();

    delete process.env[SESSION_ENV];
    delete process.env[RUN_ENV];
    const second = bindWorkflowSession({ repositoryRoot, artifactKind: 'design', slug: 'second-task', objective: 'Build a second task' });
    assert.equal(second, first);
    assert.notEqual(runId(), firstRun);
    assertWorkflowSession({ repositoryRoot, artifactKind: 'design', slug: 'second-task' });
  });

  it('organizes run files below the active workspace root and propagates session identity', () => {
    const dir = openSession({ repositoryRoot, id: 'explicit-chat', objective: 'A stable title' });
    ownedRoots.push(dir);
    assert.ok(isWorkspaceSessionDir(dir, repositoryRoot));
    assert.ok(!isPublishedSessionDir(dir));
    assert.equal(process.env[SESSION_ENV], dir);
    const temp = sessionTempDir('dispatch-test-');
    assert.equal(path.dirname(temp), path.join(runDir(), 'tmp'));
    assert.deepEqual(sessionArgs(), [SESSION_FLAG, dir, RUN_FLAG, runId()]);

    delete process.env[SESSION_ENV];
    delete process.env[RUN_ENV];
    assert.deepEqual(consumeSessionFlag([SESSION_FLAG, dir, RUN_FLAG, 'resume-1', '--', SESSION_FLAG, 'kept']), ['--', SESSION_FLAG, 'kept']);
    assert.equal(sessionDir(), dir);
    assert.equal(process.env[RUN_ENV], 'resume-1');
    assert.equal(path.dirname(dir), path.join(repositoryRoot, '.scratch', 'dispatch-skills'));
    assert.equal(path.dirname(publishedSessionRoot()), fs.realpathSync(os.tmpdir()));
  });

  it('keeps a completed workflow chat root reusable', () => {
    process.env.DISPATCH_CHAT_ID = 'reusable-chat';
    const first = bindWorkflowSession({ repositoryRoot, artifactKind: 'plan', slug: 'one' });
    ownedRoots.push(first);
    delete process.env[SESSION_ENV];
    delete process.env[RUN_ENV];
    const next = bindWorkflowSession({ repositoryRoot, artifactKind: 'plan', slug: 'two' });
    assert.equal(next, first);
    assert.equal(readSessionManifest(next).sessionId, 'reusable-chat');
  });

  it('prunes aged run data in another chat while the current chat stays bound', () => {
    const stale = openSession({ repositoryRoot, id: 'stale-chat' });
    ownedRoots.push(stale);
    const staleRun = runDir();
    fs.writeFileSync(path.join(staleRun, 'old.log'), 'old');
    const staleCache = path.join(stale, 'cache');
    fs.mkdirSync(staleCache);
    fs.writeFileSync(path.join(staleCache, 'old.cache'), 'old');
    const artifact = path.join(stale, 'artifacts', 'plan.md');
    fs.mkdirSync(path.dirname(artifact));
    fs.writeFileSync(artifact, '# Plan');
    const markAged = (dir) => {
      const file = path.join(dir, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      manifest.lastUsedAt = '2000-01-01T00:00:00.000Z';
      fs.writeFileSync(file, JSON.stringify(manifest));
    };
    markAged(stale);

    delete process.env[SESSION_ENV];
    delete process.env[RUN_ENV];
    const active = openSession({ repositoryRoot, id: 'active-chat' });
    ownedRoots.push(active);
    const activeRun = runDir();
    fs.writeFileSync(path.join(activeRun, 'live.log'), 'live');
    markAged(active);

    pruneSessions({ maxAgeMs: 1000, now: Date.now() });
    assert.equal(fs.existsSync(path.join(stale, 'runs')), false);
    assert.equal(fs.existsSync(staleCache), false);
    assert.equal(fs.existsSync(artifact), true);
    assert.equal(fs.existsSync(path.join(stale, 'manifest.json')), true);
    assert.equal(fs.existsSync(activeRun), true);
  });

  it('rejects artifact resolution until a chat root is bound', () => {
    assert.throws(() => assertWorkflowSession({ repositoryRoot }), /must be bound/);
    assert.equal(process.env[SESSION_ENV], undefined);
  });

  it('validates run IDs and session containment', () => {
    const dir = openSession({ repositoryRoot, id: 'safe-chat' });
    ownedRoots.push(dir);
    assert.throws(() => bindRun('..'), /Invalid run id/);
    assert.throws(() => runDir('..'), /Invalid run id/);
    assert.throws(() => consumeSessionFlag([SESSION_FLAG, os.tmpdir()]), /outside the validated/);
    assert.equal(isPublishedSessionDir(os.tmpdir()), false);
  });

});
