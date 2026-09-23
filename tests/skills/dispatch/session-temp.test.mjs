import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  SESSION_ENV, SESSION_FLAG, consumeSessionFlag, isSessionDir, openSession, pruneSessions, sessionArgs, sessionDir, sessionTempDir, sessionsRoot,
} from '../../../skills/dispatch/scripts/session-temp.mjs';

describe('per-session temp directory', () => {
  let saved;
  beforeEach(() => { saved = process.env[SESSION_ENV]; delete process.env[SESSION_ENV]; });
  afterEach(() => { if (saved === undefined) delete process.env[SESSION_ENV]; else process.env[SESSION_ENV] = saved; });

  it('opens one session under the dispatch temp root and keeps every temp dir inside it', () => {
    const dir = sessionDir();
    assert.equal(path.dirname(dir), sessionsRoot());
    assert.ok(isSessionDir(dir));
    assert.equal(process.env[SESSION_ENV], dir);
    assert.equal(sessionDir(), dir, 'a bound session is reused');
    const temp = sessionTempDir('dispatch-x-');
    assert.equal(path.dirname(temp), dir);
    assert.ok(!isSessionDir(temp), 'a nested directory is not a session');
    assert.ok(!isSessionDir(os.tmpdir()));
  });

  it('passes the session to host-run argv and binds it from the flag', () => {
    const dir = openSession('flag-session');
    assert.deepEqual(sessionArgs(), [SESSION_FLAG, dir]);
    delete process.env[SESSION_ENV];
    assert.deepEqual(consumeSessionFlag(['--run', SESSION_FLAG, dir, 'implement', '--', SESSION_FLAG, 'kept']), ['--run', 'implement', '--', SESSION_FLAG, 'kept']);
    assert.equal(process.env[SESSION_ENV], dir);
    delete process.env[SESSION_ENV];
    assert.deepEqual(consumeSessionFlag([`${SESSION_FLAG}=${dir}`, '--next']), ['--next']);
    assert.equal(process.env[SESSION_ENV], dir);
  });

  it('refuses a session directory outside the sessions root', () => {
    assert.throws(() => consumeSessionFlag([SESSION_FLAG, os.tmpdir()]), /must be a child of/);
    assert.throws(() => openSession('../escape'), /Invalid session id/);
  });

  it('prunes stale sessions but never the bound one', () => {
    const stale = openSession('stale-session');
    const bound = openSession('bound-session');
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    for (const dir of [stale, bound]) fs.utimesSync(dir, old, old);
    pruneSessions();
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(bound), true);
  });
});
