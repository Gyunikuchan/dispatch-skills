import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  attemptOf, createRun, runPaths, runSegment, findRepoRoot, folderName, FOLDER_NAME, initializeSession, isRunId, readManifest, reactivateSession, restoreSessionPaths, storeSessionPaths,
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

test('session-naming: timestamp-slug format without session ID', () => {
  assert.equal(folderName(now, 'Rewrite Dispatch As!'), '20260929T1754Z-rewrite-dispatch-as');
  assert.match(folderName(now, 'x'), FOLDER_NAME);
  assert.equal(truncateSlug('a'.repeat(30) + '-' + 'b'.repeat(30)), 'a'.repeat(30));
  const existing = new Set([path.resolve('/w/repo/.git')]);
  assert.equal(findRepoRoot('/w/repo/src/deep', (file) => existing.has(path.resolve(file))), path.resolve('/w/repo'));
  assert.equal(findRepoRoot('/nowhere', () => false), null);
});

test('session-collision: numeric suffix -1 on name collision', () => {
  const { root, temp } = repo();
  const dir = initializeSession({ repositoryRoot: root, sessionId: 's1', sessionTitle: 'demo', now, tempRoot: temp });
  assert.equal(path.basename(dir), '20260929T1754Z-demo');
  assert.equal(readManifest(dir).location, 'workspace');
  assert.equal(initializeSession({ repositoryRoot: root, sessionId: 's1', sessionTitle: 'other', now, tempRoot: temp }), dir);

  // Another session holding the same name in the same minute forces a numeric title suffix -1.
  const suffixed = initializeSession({ repositoryRoot: root, sessionId: 's2', sessionTitle: 'demo', now, tempRoot: temp });
  assert.equal(path.basename(suffixed), '20260929T1754Z-demo-1');

  const run = createRun(dir, 'plan-review');
  assert.deepEqual([run.id, isRunId(run.id), createRun(dir, 'implement').id], ['001-plan-review', true, '002-implement']);
  const stored = storeSessionPaths({ log: path.join(dir, '.state', 'x.log') }, dir);
  assert.equal(stored.log, '@session/.state/x.log');
  assert.equal(storeSessionPaths(`${dir}-sibling/file.txt`, dir), `${dir}-sibling/file.txt`);
  assert.equal(restoreSessionPaths(stored, dir).log, path.join(path.resolve(dir), '.state', 'x.log'));
  assert.throws(() => restoreSessionPaths('@session/../escape', dir), /escapes/);
});

test('session-matching: skips corrupt unrelated directories and matches by manifest', () => {
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

test('session-lifecycle: a held claim waits for the winner and reuses its folder', () => {
  const { root, temp } = repo();
  const first = initializeSession({ repositoryRoot: root, sessionId: 'c1', sessionTitle: 'demo', now, tempRoot: temp });
  const claim = path.join(path.dirname(first), '.claim-c2');
  fs.mkdirSync(claim);
  const winner = path.join(path.dirname(first), '20260929T1754Z-demo-1');
  fs.mkdirSync(winner);
  fs.writeFileSync(path.join(winner, 'manifest.json'), fs.readFileSync(path.join(first, 'manifest.json'), 'utf8').replace(/"c1"/g, '"c2"').replace('20260929T1754Z-demo', '20260929T1754Z-demo-1'));
  assert.equal(initializeSession({ repositoryRoot: root, sessionId: 'c2', sessionTitle: 'demo', now, tempRoot: temp, waitMs: 50 }), fs.realpathSync(winner));
  fs.rmSync(winner, { recursive: true });
  assert.throws(() => initializeSession({ repositoryRoot: root, sessionId: 'c2', sessionTitle: 'demo', now, tempRoot: temp, waitMs: 30 }), /still claimed/);
});

test('session-reactivate: validates repository and rejects external locations', () => {
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


// SECTION: Run paths

test('run paths: effect files sit in a readable folder per dotted effect ID', () => {
  const paths = runPaths(path.join('r'));
  assert.equal(paths.input('review.wave.1'), path.join('r', 'review.wave.1', 'input.json'));
  assert.equal(paths.launch('review.wave.1'), path.join('r', 'review.wave.1', 'launch.json'));
  assert.equal(paths.prompt('review.prepare-review.1', 'opencode-0'), path.join('r', 'review.prepare-review.1', 'opencode-0.prompt.md'));
  assert.equal(paths.slotLog('review.wave.1', 'opencode-0'), path.join('r', 'review.wave.1', 'opencode-0.log'));
  assert.equal(paths.spill('review.wave.1', 'opencode-0'), path.join('r', 'review.wave.1', 'opencode-0.spill.md'));
  assert.equal(paths.brief('implement.write-brief.1'), path.join('r', 'implement.write-brief.1', 'brief.md'));
  assert.equal(paths.envelope('implement.write-brief.1'), path.join('r', 'implement.write-brief.1', 'outcome.json'));
  assert.equal(paths.scope('review.prepare-review.1'), path.join('r', 'review.prepare-review.1', 'scope.json'));
  assert.equal(paths.restore('implement.restore.1'), path.join('r', 'implement.restore.1', 'restore.json'));
  assert.equal(paths.selfCheckEvent('implement.write-brief.1'), path.join('r', 'implement.write-brief.1', 'self-check.event.json'));
  assert.equal(paths.verifyLog('implement.verify.2', 3), path.join('r', 'implement.verify.2', '3.log'));
  assert.equal(paths.event(7, 'rule'), path.join('r', 'events', '7-rule.json'));
});

test('run paths: the first attempt has no infix and later attempts carry .a<n>', () => {
  const paths = runPaths('r');
  assert.equal(paths.claim('review.wave.1', 1), path.join('r', 'review.wave.1', 'claim.json'));
  assert.equal(paths.heartbeat('review.wave.1', 2), path.join('r', 'review.wave.1', 'heartbeat.a2.json'));
  assert.equal(paths.done('review.wave.1', 3), path.join('r', 'review.wave.1', 'done.a3.json'));
  assert.equal(paths.slotOutcome('review.wave.1', 'codex-0', 2), path.join('r', 'review.wave.1', 'codex-0.a2.outcome.json'));
  assert.equal(attemptOf('claim', 'claim.json'), 1);
  assert.equal(attemptOf('claim', 'claim.a4.json'), 4);
  assert.equal(attemptOf('claim', 'heartbeat.json'), null);
});

test('run paths: unsafe segments throw instead of hashing or escaping the run folder', () => {
  for (const bad of ['../x', 'a/b', 'a\b', '.hidden', '', 'a..b', 'a.']) assert.throws(() => runSegment(bad), /Unsafe run path segment/, bad);
  assert.throws(() => runPaths('r').input('../escape'), /Unsafe run path segment/);
  assert.equal(runSegment('review.prepare-review.1'), 'review.prepare-review.1');
});
