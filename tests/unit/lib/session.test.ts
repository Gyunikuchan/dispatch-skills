import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  findRepoRoot, folderName, FOLDER_NAME, initializeSession, readManifest, reactivateSession,
} from '../../../skills/dispatch/scripts/lib/session.ts';

const now = new Date('2026-09-29T17:54:00.000Z');

function repo(): { root: string; temp: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'session-'));
  const root = path.join(base, 'repo');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const temp = path.join(base, 'tmp');
  fs.mkdirSync(temp);
  return { root, temp };
}

// SECTION: Session directory and lifecycle

test('timestamp-slug format without session ID', () => {
  assert.equal(folderName(now, 'Rewrite Dispatch As!'), '20260929T1754Z-rewrite-dispatch-as');
  assert.match(folderName(now, 'x'), FOLDER_NAME);
});

test('repository root: ancestor Git metadata identifies the root; absence returns null', () => {
  const existing = new Set([path.resolve('/w/repo/.git')]);
  assert.equal(findRepoRoot('/w/repo/src/deep', (file) => existing.has(path.resolve(file))), path.resolve('/w/repo'));
  assert.equal(findRepoRoot('/nowhere', () => false), null);
});

test('numeric suffix -1 on name collision', () => {
  const { root, temp } = repo();
  const dir = initializeSession({ repositoryRoot: root, sessionId: 's1', sessionTitle: 'demo', now, tempRoot: temp });
  assert.equal(path.basename(dir), '20260929T1754Z-demo');
  assert.equal(readManifest(dir).location, 'workspace');
  assert.equal(initializeSession({ repositoryRoot: root, sessionId: 's1', sessionTitle: 'other', now, tempRoot: temp }), dir);

  // Another session holding the same name in the same minute forces a numeric title suffix -1.
  const suffixed = initializeSession({ repositoryRoot: root, sessionId: 's2', sessionTitle: 'demo', now, tempRoot: temp });
  assert.equal(path.basename(suffixed), '20260929T1754Z-demo-1');

});

test('session matching skips corrupt unrelated directories and matches by manifest', () => {
  const { root, temp } = repo();
  const dir = initializeSession({ repositoryRoot: root, sessionId: 's1', sessionTitle: 'demo', now, tempRoot: temp });

  // Corrupt or unreadable unrelated directory does not block session matching or initialization.
  const damaged = path.join(path.dirname(dir), '20260929T1754Z-damaged');
  fs.mkdirSync(damaged);
  fs.writeFileSync(path.join(damaged, 'corrupt.txt'), 'data');

  // Existing session matching still succeeds despite damaged sibling.
  assert.equal(initializeSession({ repositoryRoot: root, sessionId: 's1', sessionTitle: 'demo', now, tempRoot: temp }), dir);

  // Initializing an unrelated session still succeeds.
  const session = initializeSession({ repositoryRoot: root, sessionId: 's3', sessionTitle: 'healthy', now, tempRoot: temp });
  assert.equal(path.basename(session), '20260929T1754Z-healthy');
  assert.equal(readManifest(session).sessionId, 's3');

  // Initializing with same title as damaged folder avoids conflict by appending suffix.
  const salvaged = initializeSession({ repositoryRoot: root, sessionId: 's4', sessionTitle: 'damaged', now, tempRoot: temp });
  assert.equal(path.basename(salvaged), '20260929T1754Z-damaged-1');
  assert.equal(readManifest(salvaged).sessionId, 's4');
});

test('held claim waits for the winner and reuses its folder', (t) => {
  const { root, temp } = repo();
  const first = initializeSession({ repositoryRoot: root, sessionId: 'c1', sessionTitle: 'demo', now, tempRoot: temp });
  const claim = path.join(path.dirname(first), '.claim-c2');
  fs.mkdirSync(claim);
  const winner = path.join(path.dirname(first), '20260929T1754Z-demo-1');
  fs.mkdirSync(winner);
  fs.writeFileSync(path.join(winner, 'manifest.json'), fs.readFileSync(path.join(first, 'manifest.json'), 'utf8').replace(/"c1"/g, '"c2"').replace('20260929T1754Z-demo', '20260929T1754Z-demo-1'));
  assert.equal(initializeSession({ repositoryRoot: root, sessionId: 'c2', sessionTitle: 'demo', now, tempRoot: temp, waitMs: 50 }), fs.realpathSync(winner));
  fs.rmSync(winner, { recursive: true });
  let elapsed = 0;
  t.mock.method(Date, 'now', () => elapsed);
  t.mock.method(Atomics, 'wait', () => { elapsed += 10; return 'timed-out'; });
  assert.throws(() => initializeSession({ repositoryRoot: root, sessionId: 'c2', sessionTitle: 'demo', now, tempRoot: temp, waitMs: 30 }), /still claimed/);
});

test('session reactivate validates repository and rejects external locations', () => {
  const { root, temp } = repo();
  const dir = initializeSession({ repositoryRoot: root, sessionId: 'r1', sessionTitle: 'demo', now, tempRoot: temp });
  assert.equal(reactivateSession(dir, root), dir);

  // Different repository root is rejected.
  const otherRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'other-repo-'));
  fs.mkdirSync(path.join(otherRepo, '.git'), { recursive: true });
  assert.throws(() => reactivateSession(dir, otherRepo), /different repository/);

  // External location with valid repo in manifest is rejected.
  const external = path.join(temp, path.basename(dir));
  fs.mkdirSync(external, { recursive: true });
  fs.writeFileSync(path.join(external, 'manifest.json'), fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.throws(() => reactivateSession(external, root), /outside the workspace session root/);
});
