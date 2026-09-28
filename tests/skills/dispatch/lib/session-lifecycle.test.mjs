import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findSession, initializeSession, readLifecycleManifest } from '../../../../skills/dispatch/scripts/lib/session-lifecycle.mjs';

const LIFECYCLE = pathToFileURL(fileURLToPath(new URL('../../../../skills/dispatch/scripts/lib/session-lifecycle.mjs', import.meta.url))).href;

describe('chat session lifecycle identity', () => {
  let repositoryRoot;
  let tempRoot;

  beforeEach(() => {
    repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-lifecycle-repo-'));
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-lifecycle-temp-'));
  });

  afterEach(() => {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('uses a sortable timestamp, safe ID, fixed objective title, and raw ID manifest', () => {
    const now = new Date('2026-09-27T01:02:03.456Z');
    const dir = initializeSession({ repositoryRoot, tempRoot, sessionId: 'chat/unsafe id', objective: 'Build a widget!', now });
    const name = path.basename(dir);
    assert.match(name, /^20260927T0102Z-[a-f0-9]{12}-build-a-widget$/);
    const manifest = readLifecycleManifest(dir);
    assert.equal(manifest.sessionId, 'chat/unsafe id');
    assert.equal(manifest.sessionTitle, 'build-a-widget');
    const expectedRoot = fs.realpathSync(repositoryRoot).replaceAll('\\', '/');
    assert.equal(manifest.repositoryRoot, process.platform === 'win32' ? expectedRoot.toLowerCase() : expectedRoot);
    assert.equal(manifest.location, 'workspace');
  });

  it('session.mjs runs when invoked through a symlinked skill directory', () => {
    const skillDir = fileURLToPath(new URL('../../../../skills/dispatch', import.meta.url));
    const link = path.join(tempRoot, 'linked-dispatch');
    // NOTE: a junction needs no Windows symlink privilege; elsewhere the type is ignored.
    fs.symlinkSync(skillDir, link, 'junction');
    const stdout = execFileSync(process.execPath, [path.join(link, 'scripts', 'session.mjs'), 'lookup', '--repository-root', repositoryRoot, '--temp-root', tempRoot], { encoding: 'utf8' });
    assert.equal(JSON.parse(stdout).command, 'lookup');
  });

  it('reuses the first title for the same chat and keeps separate chat identities apart', () => {
    const first = initializeSession({ repositoryRoot, tempRoot, sessionId: 'chat-1', objective: 'First objective' });
    const same = initializeSession({ repositoryRoot, tempRoot, sessionId: 'chat-1', objective: 'Changed objective' });
    const second = initializeSession({ repositoryRoot, tempRoot, sessionId: 'chat-2', objective: 'First objective' });
    assert.equal(first, same);
    assert.notEqual(first, second);
    assert.equal(readLifecycleManifest(same).sessionTitle, 'first-objective');
    assert.equal(findSession({ repositoryRoot, tempRoot, sessionId: 'chat-1' }), first);
  });

  it('claims one stable folder when independent processes initialize the same chat', async () => {
    const env = { ...process.env, SESSION_TEST_REPO: repositoryRoot, SESSION_TEST_TEMP: tempRoot };
    const script = `import { initializeSession } from ${JSON.stringify(LIFECYCLE)}; console.log(initializeSession({ repositoryRoot: process.env.SESSION_TEST_REPO, tempRoot: process.env.SESSION_TEST_TEMP, sessionId: 'same-chat', objective: 'parallel start' }));`;
    const claim = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { env, windowsHide: true });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
    });
    const [first, second] = await Promise.all([claim(), claim()]);
    assert.equal(first, second);
    assert.equal(readLifecycleManifest(first).sessionId, 'same-chat');
  });
});
