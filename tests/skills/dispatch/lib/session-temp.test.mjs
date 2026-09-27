import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  LEGACY_STATE_FLAG, MANIFEST_NAME, RUN_ENV, RUN_FLAG, SESSION_ENV, SESSION_FLAG,
  assertWorkflowSession, bindRun, bindSession, bindWorkflowSession, completeSession, consumeSessionFlag,
  isSessionDir, openSession, pruneSessions, readSessionManifest, runDir, runId,
  sessionArgs, sessionDir, sessionTempDir, sessionsRoot, workflowSessionDirs,
} from '../../../../skills/dispatch/scripts/lib/session-temp.mjs';

const HELPER = pathToFileURL(fileURLToPath(new URL('../../../../skills/dispatch/scripts/lib/session-temp.mjs', import.meta.url))).href;

describe('workflow session temp directory', () => {
  let saved;
  beforeEach(() => {
    saved = Object.fromEntries(['DISPATCH_SESSION_DIR', 'DISPATCH_RUN_ID', 'DISPATCH_LEGACY_SESSION', 'DISPATCH_LEGACY_STATE_FILE'].map(key => [key, process.env[key]]));
    for (const key of Object.keys(saved)) delete process.env[key];
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it('opens a direct session and organizes temp files below its active run', () => {
    const dir = sessionDir();
    assert.equal(path.dirname(dir), sessionsRoot());
    assert.ok(isSessionDir(dir));
    assert.equal(process.env[SESSION_ENV], dir);
    assert.equal(readSessionManifest(dir).status, 'active');
    const temp = sessionTempDir('dispatch-x-');
    assert.equal(path.dirname(temp), path.join(runDir(), 'tmp'));
    assert.ok(!isSessionDir(temp), 'a nested directory is not a session');
    assert.ok(!isSessionDir(os.tmpdir()));
  });

  it('propagates direct session and run identity before the command separator', () => {
    const dir = openSession('flag-session');
    const args = sessionArgs();
    assert.deepEqual(args.slice(0, 2), [SESSION_FLAG, dir]);
    assert.deepEqual(args.slice(2, 4), [RUN_FLAG, runId()]);
    delete process.env[SESSION_ENV];
    delete process.env[RUN_ENV];
    assert.deepEqual(consumeSessionFlag(['--run', ...args, 'implement', '--', SESSION_FLAG, 'kept']), ['--run', 'implement', '--', SESSION_FLAG, 'kept']);
    assert.equal(process.env[SESSION_ENV], dir);
    assert.equal(process.env[RUN_ENV], args[3]);
    assert.throws(() => consumeSessionFlag([SESSION_FLAG, os.tmpdir()]), /direct child/);
    assert.throws(() => openSession('../escape'), /Invalid session id/);
    assert.throws(() => openSession('.'), /Invalid session id/);
    assert.throws(() => openSession('..'), /Invalid session id/);
    assert.throws(() => bindRun('..'), /Invalid run id/);
    assert.throws(() => runDir('..'), /Invalid run id/);
    assert.equal(path.dirname(runDir()), path.join(dir, 'runs'));
  });

  it('binds nested state only from a validated legacy run directory', () => {
    const legacy = path.join(sessionsRoot(), 'sessions', `legacy-nested-${process.pid}-${Date.now()}`);
    const id = '22222222-2222-4222-8222-222222222222';
    const stateFile = path.join(legacy, 'runs', id, 'state.json');
    const arbitraryFile = path.join(legacy, 'other', id, 'state.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.mkdirSync(path.dirname(arbitraryFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ v: 1, runId: id }));
    fs.writeFileSync(arbitraryFile, JSON.stringify({ v: 1, runId: id }));
    try {
      assert.deepEqual(consumeSessionFlag([LEGACY_STATE_FLAG, stateFile]), []);
      assert.equal(process.env[SESSION_ENV], legacy);
      assert.equal(process.env[RUN_ENV], id);
      assert.throws(() => consumeSessionFlag([LEGACY_STATE_FLAG, arbitraryFile]), /recognized in-flight legacy layout/);
    } finally {
      fs.rmSync(legacy, { recursive: true, force: true });
    }
  });

  it('fails a repository-scoped assertion without opening an ungoverned session', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-session-unbound-'));
    try {
      assert.throws(() => assertWorkflowSession({ repositoryRoot: repo, artifactKind: 'plan', slug: 'sample' }), /must be bound/);
      assert.equal(process.env[SESSION_ENV], undefined);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('claims concurrent starts once and advances after a completed generation', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-session-repo-'));
    const childEnv = { ...process.env, DISPATCH_TEST_REPO: repo };
    for (const key of ['DISPATCH_SESSION_DIR', 'DISPATCH_RUN_ID', 'DISPATCH_LEGACY_SESSION', 'DISPATCH_LEGACY_STATE_FILE']) delete childEnv[key];
    const script = `import { bindWorkflowSession } from ${JSON.stringify(HELPER)}; console.log(bindWorkflowSession({ repositoryRoot: process.env.DISPATCH_TEST_REPO, artifactKind: 'plan', slug: 'shared-work' }));`;
    const claim = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { env: childEnv, windowsHide: true });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
      child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
    });
    try {
      const [first, second] = await Promise.all([claim(), claim()]);
      assert.equal(first, second);
      assert.equal(workflowSessionDirs({ repositoryRoot: repo, artifactKind: 'plan', slug: 'shared-work' }).length, 1);
      bindWorkflowSession({ repositoryRoot: repo, artifactKind: 'plan', slug: 'shared-work' });
      completeSession();
      const next = bindWorkflowSession({ repositoryRoot: repo, artifactKind: 'plan', slug: 'shared-work' });
      assert.notEqual(next, first);
      assert.equal(readSessionManifest(first).status, 'completed');
      assert.equal(readSessionManifest(next).generation, 2);
      assertWorkflowSession({ repositoryRoot: repo, artifactKind: 'plan', slug: 'shared-work' });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('ignores an interrupted unpublished claim and keeps completion terminal after a touch', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-session-orphan-'));
    const staging = fs.mkdtempSync(path.join(sessionsRoot(), '.claim-'));
    try {
      const claimed = bindWorkflowSession({ repositoryRoot: repo, artifactKind: 'plan', slug: 'orphan-work' });
      assert.equal(readSessionManifest(claimed).status, 'active');
      assert.equal(workflowSessionDirs({ repositoryRoot: repo, artifactKind: 'plan', slug: 'orphan-work' }).length, 1);
      completeSession();
      bindSession(claimed);
      assert.equal(readSessionManifest(claimed).status, 'completed');
      assert.equal(fs.existsSync(staging), true, 'an interrupted unpublished claim cannot own a workflow');
      const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      fs.utimesSync(staging, old, old);
      pruneSessions();
      assert.equal(fs.existsSync(staging), false, 'aged unpublished claims are pruned');
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('retries a transient rename while publishing a new session', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-session-rename-'));
    const original = fs.renameSync;
    let attempts = 0;
    fs.renameSync = (source, destination) => {
      if (path.basename(source).startsWith('.claim-')) {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error('transient claim contention'), { code: 'EPERM' });
      }
      return original(source, destination);
    };
    try {
      const claimed = bindWorkflowSession({ repositoryRoot: repo, artifactKind: 'plan', slug: 'retry-work' });
      assert.equal(attempts, 2);
      assert.equal(readSessionManifest(claimed).status, 'active');
    } finally {
      fs.renameSync = original;
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('names the recovery path for a legacy manifest-less candidate', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-session-stale-'));
    let orphan;
    try {
      const first = bindWorkflowSession({ repositoryRoot: repo, artifactKind: 'plan', slug: 'stale-work' });
      completeSession();
      orphan = path.join(path.dirname(first), `${path.basename(first).replace(/-1$/, '')}-2`);
      fs.mkdirSync(orphan);
      assert.throws(() => bindWorkflowSession({ repositoryRoot: repo, artifactKind: 'plan', slug: 'stale-work' }),
        (error) => error.message.includes(orphan) && /Inspect and remove that stale directory/.test(error.message));
    } finally {
      if (orphan) fs.rmSync(orphan, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('prunes aged run and cache content while retaining the manifest and durable ledger', () => {
    const stale = openSession('stale-session');
    const bound = openSession('bound-session');
    for (const area of ['runs', 'cache', 'artifacts', 'ledger', 'telemetry']) fs.mkdirSync(path.join(stale, area), { recursive: true });
    fs.writeFileSync(path.join(stale, 'ledger', 'kept-ledger.md'), 'evidence');
    const manifestFile = path.join(stale, MANIFEST_NAME);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.lastUsedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    pruneSessions();
    assert.equal(fs.existsSync(stale), true);
    assert.equal(fs.existsSync(path.join(stale, MANIFEST_NAME)), true);
    assert.equal(fs.existsSync(path.join(stale, 'ledger', 'kept-ledger.md')), true);
    assert.equal(fs.existsSync(path.join(stale, 'runs')), false);
    assert.equal(fs.existsSync(path.join(stale, 'cache')), false);
    assert.equal(fs.existsSync(bound), true);
  });
});
