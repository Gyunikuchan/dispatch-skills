import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  createRun, findRepoRoot, folderName, FOLDER_NAME, handoffSession, initializeSession, isRunId, readManifest, restoreSessionPaths, storeSessionPaths,
  truncateSlug,
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

test('session-lifecycle: naming grammar and repo root by upward traversal', () => {
  assert.equal(folderName(now, 'abc', 'Rewrite Dispatch As!'), '20260929T1754Z-abc-rewrite-dispatch-as');
  assert.match(folderName(now, 'a/very/long/session/id', 'x'), FOLDER_NAME);
  assert.equal(truncateSlug('a'.repeat(30) + '-' + 'b'.repeat(30)), 'a'.repeat(30));
  const existing = new Set([path.resolve('/w/repo/.git')]);
  assert.equal(findRepoRoot('/w/repo/src/deep', (file) => existing.has(path.resolve(file))), path.resolve('/w/repo'));
  assert.equal(findRepoRoot('/nowhere', () => false), null);
});

test('session-lifecycle: collision-safe creation, manifest, handoff move, reactivation, relative references', () => {
  const { root, temp } = repo();
  const dir = initializeSession({ repositoryRoot: root, sessionId: 's1', sessionTitle: 'demo', now, tempRoot: temp });
  assert.equal(path.basename(dir), '20260929T1754Z-s1-demo');
  assert.equal(readManifest(dir).location, 'workspace');
  assert.equal(initializeSession({ repositoryRoot: root, sessionId: 's1', sessionTitle: 'other', now, tempRoot: temp }), dir);
  // Another repository's session holding the same name in the same minute forces a numeric title suffix.
  const taken = path.join(path.dirname(dir), '20260929T1754Z-s2-demo');
  fs.mkdirSync(taken);
  fs.writeFileSync(path.join(taken, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, folderName: '20260929T1754Z-s2-demo', sessionId: 's2', safeSessionId: 's2', repositoryRoot: 'elsewhere',
  }));
  const suffixed = initializeSession({ repositoryRoot: root, sessionId: 's2', sessionTitle: 'demo', now, tempRoot: temp });
  assert.equal(path.basename(suffixed), '20260929T1754Z-s2-demo-2');
  const run = createRun(dir, 'plan-review');
  assert.deepEqual([run.id, isRunId(run.id), createRun(dir, 'implement').id], ['001-plan-review', true, '002-implement']);
  const stored = storeSessionPaths({ log: path.join(dir, '.state', 'x.log') }, dir);
  assert.equal(stored.log, '@session/.state/x.log');
  assert.equal(storeSessionPaths(`${dir}-sibling/file.txt`, dir), `${dir}-sibling/file.txt`);
  const published = handoffSession(dir, temp);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(readManifest(published).location, 'published');
  assert.equal(restoreSessionPaths(stored, published).log, path.join(path.resolve(published), '.state', 'x.log'));
  const back = initializeSession({ repositoryRoot: root, sessionId: 's1', sessionTitle: 'demo', now, tempRoot: temp });
  assert.equal(path.basename(back), path.basename(dir));
  assert.equal(readManifest(back).location, 'workspace');
  assert.throws(() => restoreSessionPaths('@session/../escape', back), /escapes/);
  // Damaged session directory with existing data refuses initialization rather than abandoning state.
  const damaged = path.join(path.dirname(dir), '20260929T1754Z-s3-damaged');
  fs.mkdirSync(damaged);
  fs.writeFileSync(path.join(damaged, 'corrupt.txt'), 'data');
  assert.throws(() => initializeSession({ repositoryRoot: root, sessionId: 's3', sessionTitle: 'damaged', now, tempRoot: temp }), /damaged/);
});

test('session-lifecycle: handoff across filesystems (EXDEV) copies, verifies, and removes the source', () => {
  const { root, temp } = repo();
  const dir = initializeSession({ repositoryRoot: root, sessionId: 'x1', sessionTitle: 'demo', now, tempRoot: temp });
  fs.writeFileSync(path.join(dir, 'a.md'), 'body');
  let calls = 0;
  const published = handoffSession(dir, temp, () => { calls++; throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); });
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.readFileSync(path.join(published, 'a.md'), 'utf8'), 'body');
  assert.equal(readManifest(published).location, 'published');
  assert.throws(() => handoffSession(published, path.join(temp, 'other'), () => { throw Object.assign(new Error('no'), { code: 'EPERM' }); }), /no/);
});

test('session-lifecycle: a held claim waits for the winner and reuses its folder', () => {
  const { root, temp } = repo();
  const first = initializeSession({ repositoryRoot: root, sessionId: 'c1', sessionTitle: 'demo', now, tempRoot: temp });
  const claim = path.join(path.dirname(first), '.claim-c2');
  fs.mkdirSync(claim);
  const winner = path.join(path.dirname(first), '20260929T1754Z-c2-demo');
  fs.mkdirSync(winner);
  fs.writeFileSync(path.join(winner, 'manifest.json'), fs.readFileSync(path.join(first, 'manifest.json'), 'utf8').replace(/"c1"/g, '"c2"').replace('20260929T1754Z-c1-demo', '20260929T1754Z-c2-demo'));
  assert.equal(initializeSession({ repositoryRoot: root, sessionId: 'c2', sessionTitle: 'demo', now, tempRoot: temp, waitMs: 50 }), fs.realpathSync(winner));
  fs.rmSync(winner, { recursive: true });
  assert.throws(() => initializeSession({ repositoryRoot: root, sessionId: 'c2', sessionTitle: 'demo', now, tempRoot: temp, waitMs: 30 }), /still claimed/);
});

test('session-lifecycle: an interrupted move with an identical destination completes; conflicting contents and symlinks are refused', () => {
  const { root, temp } = repo();
  const dir = initializeSession({ repositoryRoot: root, sessionId: 'i1', sessionTitle: 'demo', now, tempRoot: temp });
  const dest = path.join(temp, 'dispatch-skills', path.basename(dir));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(dir, dest, { recursive: true });
  assert.equal(handoffSession(dir, temp), fs.realpathSync(dest));
  assert.equal(fs.existsSync(dir), false);
  const other = initializeSession({ repositoryRoot: root, sessionId: 'i2', sessionTitle: 'demo', now, tempRoot: temp });
  const clash = path.join(temp, 'dispatch-skills', path.basename(other));
  fs.mkdirSync(clash);
  fs.writeFileSync(path.join(clash, 'x'), 'y');
  assert.throws(() => handoffSession(other, temp), /conflicting contents/);
  fs.rmSync(clash, { recursive: true });
  try { fs.symlinkSync(path.join(other, 'manifest.json'), path.join(other, 'link'), 'file'); } catch { return; }
  assert.throws(() => handoffSession(other, temp, () => { throw Object.assign(new Error('x'), { code: 'EXDEV' }); }), /symbolic link/);
});
