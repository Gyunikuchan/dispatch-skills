import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  handoffSession, initializeSession, publishedSessionRoot, readLifecycleManifest, reactivateSession,
} from '../../../../skills/dispatch/scripts/lib/session-lifecycle.mjs';

describe('whole chat-folder movement', () => {
  let repositoryRoot;
  let tempRoot;
  let active;
  let chatId;

  beforeEach(() => {
    repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-move-repo-'));
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-move-temp-'));
    chatId = `chat-${process.pid}-${Date.now()}`;
    active = initializeSession({ repositoryRoot, tempRoot, sessionId: chatId, objective: 'Move a chat folder' });
    fs.mkdirSync(path.join(active, 'artifacts'), { recursive: true });
    fs.mkdirSync(path.join(active, 'runs', 'run-1'), { recursive: true });
    fs.writeFileSync(path.join(active, 'artifacts', 'plan.md'), 'canonical');
    fs.writeFileSync(path.join(active, 'runs', 'run-1', 'state.json'), '{"runId":"run-1"}');
  });

  afterEach(() => {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('moves and reactivates the complete folder under the same identity', () => {
    const moved = handoffSession({ sessionDir: active, repositoryRoot, tempRoot });
    assert.equal(moved.method, 'rename');
    assert.equal(moved.authoritative, 'destination');
    assert.equal(moved.currentRoot, path.join(publishedSessionRoot({ tempRoot }), path.basename(active)));
    assert.equal(fs.existsSync(active), false);
    assert.equal(fs.readFileSync(path.join(moved.currentRoot, 'artifacts', 'plan.md'), 'utf8'), 'canonical');
    assert.equal(readLifecycleManifest(moved.currentRoot).location, 'published');

    const activeAgain = reactivateSession({ sessionDir: moved.currentRoot, repositoryRoot, tempRoot });
    assert.equal(activeAgain.moved, true);
    assert.equal(activeAgain.currentRoot, active);
    assert.equal(readLifecycleManifest(activeAgain.currentRoot).sessionId, chatId);
    assert.equal(fs.readFileSync(path.join(activeAgain.currentRoot, 'runs', 'run-1', 'state.json'), 'utf8'), '{"runId":"run-1"}');
  });

  it('uses a verified staging copy after a cross-device rename failure', () => {
    const originalRename = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (path.resolve(source) === path.resolve(active) && path.dirname(path.resolve(destination)) === publishedSessionRoot({ tempRoot })) {
        throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
      }
      return originalRename(source, destination);
    };
    try {
      const moved = handoffSession({ sessionDir: active, repositoryRoot, tempRoot });
      assert.equal(moved.method, 'copy');
      assert.equal(moved.authoritative, 'destination');
      assert.equal(fs.existsSync(active), false);
      assert.equal(fs.readFileSync(path.join(moved.currentRoot, 'artifacts', 'plan.md'), 'utf8'), 'canonical');
      assert.deepEqual(fs.readdirSync(path.dirname(moved.currentRoot)).filter(name => name.includes('.stage-')), []);
    } finally { fs.renameSync = originalRename; }
  });

  it('keeps scratch authoritative when publication is denied', () => {
    const originalRename = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (path.resolve(source) === path.resolve(active) && path.dirname(path.resolve(destination)) === publishedSessionRoot({ tempRoot })) {
        throw Object.assign(new Error('destination denied'), { code: 'EACCES' });
      }
      return originalRename(source, destination);
    };
    try {
      const result = handoffSession({ sessionDir: active, repositoryRoot, tempRoot });
      assert.equal(result.method, 'failed');
      assert.equal(result.authoritative, 'source');
      assert.equal(result.currentRoot, active);
      assert.match(result.warning, /destination denied/);
      assert.equal(fs.existsSync(path.join(active, 'artifacts', 'plan.md')), true);
    } finally { fs.renameSync = originalRename; }
  });

  it('discards a failed partial copy and preserves the source', () => {
    const originalRename = fs.renameSync;
    const originalCopy = fs.cpSync;
    fs.renameSync = (source, destination) => {
      if (path.resolve(source) === path.resolve(active) && path.dirname(path.resolve(destination)) === publishedSessionRoot({ tempRoot })) {
        throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
      }
      return originalRename(source, destination);
    };
    fs.cpSync = (source, destination, options) => {
      originalCopy(source, destination, options);
      throw new Error('copy interrupted');
    };
    try {
      const result = handoffSession({ sessionDir: active, repositoryRoot, tempRoot });
      assert.equal(result.method, 'failed');
      assert.equal(result.authoritative, 'source');
      assert.equal(fs.existsSync(active), true);
      assert.equal(fs.existsSync(path.join(result.destination, 'artifacts', 'plan.md')), false);
      assert.deepEqual(fs.readdirSync(path.dirname(result.destination)).filter(name => name.includes('.stage-')), []);
    } finally {
      fs.renameSync = originalRename;
      fs.cpSync = originalCopy;
    }
  });

  it('treats published temp as authoritative after source cleanup fails', () => {
    const originalRename = fs.renameSync;
    const originalRemove = fs.rmSync;
    fs.renameSync = (source, destination) => {
      if (path.resolve(source) === path.resolve(active) && path.dirname(path.resolve(destination)) === publishedSessionRoot({ tempRoot })) {
        throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
      }
      return originalRename(source, destination);
    };
    fs.rmSync = (target, options) => {
      if (path.resolve(target) === path.resolve(active) && options?.recursive) throw Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
      return originalRemove(target, options);
    };
    let moved;
    try { moved = handoffSession({ sessionDir: active, repositoryRoot, tempRoot }); }
    finally {
      fs.renameSync = originalRename;
      fs.rmSync = originalRemove;
    }
    assert.equal(moved.method, 'copy');
    assert.equal(moved.authoritative, 'destination');
    assert.match(moved.warning, /cleanup denied/);
    assert.equal(readLifecycleManifest(moved.currentRoot).location, 'published');
    const activeAgain = reactivateSession({ sessionDir: moved.currentRoot, repositoryRoot, tempRoot });
    assert.equal(activeAgain.currentRoot, active);
    assert.equal(fs.readFileSync(path.join(active, 'artifacts', 'plan.md'), 'utf8'), 'canonical');
  });

  it('reports a destination identity collision and leaves scratch intact', () => {
    const destinationRoot = publishedSessionRoot({ tempRoot, create: true });
    const destination = path.join(destinationRoot, path.basename(active));
    fs.mkdirSync(destination);
    const manifest = readLifecycleManifest(active);
    fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({
      ...manifest, sessionId: 'other-chat', safeSessionId: 'other-chat', location: 'published',
    }));
    const result = handoffSession({ sessionDir: active, repositoryRoot, tempRoot });
    assert.equal(result.method, 'failed');
    assert.equal(result.authoritative, 'source');
    assert.match(result.warning, /conflicting identities/);
    assert.equal(fs.existsSync(path.join(active, 'artifacts', 'plan.md')), true);
  });
});
