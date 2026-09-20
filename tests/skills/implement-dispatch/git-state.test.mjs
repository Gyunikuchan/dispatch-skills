import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  baselineFingerprint,
  currentHead,
  decodeGitPath,
  diffHash,
  dirtyPaths,
  indexFingerprint,
  materializedFingerprint,
  normalizeTaskPath,
} from '../../../skills/implement-dispatch/scripts/git-state.mjs';

describe('Git ledger state', () => {
  let repo;
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };

  beforeEach(() => {
    repo = mkdtempSync(path.join(os.tmpdir(), 'ledger-git-'));
    git('init', '--quiet', '--initial-branch=work');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
    git('add', 'tracked.txt');
    git('commit', '--quiet', '--no-gpg-sign', '-m', 'base');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('captures dirty tracked, untracked, binary, mode, symlink, deletion, and rename state', () => {
    writeFileSync(path.join(repo, 'tracked.txt'), Buffer.from([0, 1, 13, 10]));
    chmodSync(path.join(repo, 'tracked.txt'), 0o755);
    writeFileSync(path.join(repo, 'untracked.bin'), Buffer.from([255, 0, 10]));
    symlinkSync('tracked.txt', path.join(repo, 'link'));
    git('mv', 'tracked.txt', 'renamed.txt');
    const paths = dirtyPaths(repo);
    assert.ok(paths.includes('tracked.txt'));
    assert.ok(paths.includes('renamed.txt'));
    assert.ok(paths.includes('untracked.bin'));
    assert.ok(paths.includes('link'));
    const snapshot = materializedFingerprint(repo, paths);
    assert.match(snapshot.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(snapshot.entries.find(entry => entry.path === 'tracked.txt').mode, 'absent');
    assert.equal(snapshot.entries.find(entry => entry.path === 'renamed.txt').mode, '100755');
    assert.equal(snapshot.entries.find(entry => entry.path === 'link').mode, '120000');
  });

  it('excludes scratch and ignored files from the baseline universe', () => {
    writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n');
    git('add', '.gitignore');
    git('commit', '--quiet', '--no-gpg-sign', '-m', 'ignore');
    mkdirSync(path.join(repo, '.scratch'));
    writeFileSync(path.join(repo, '.scratch', 'plan.md'), 'artifact');
    writeFileSync(path.join(repo, 'ignored.txt'), 'ignored');
    assert.deepEqual(dirtyPaths(repo), []);
    assert.throws(() => normalizeTaskPath('.scratch/plan.md'), /excluded/);
  });

  it('uses the empty tree in repositories without commits', () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'ledger-empty-'));
    try {
      const result = spawnSync('git', ['init', '--quiet', '--initial-branch=work'], { cwd: empty, encoding: 'utf8' });
      assert.equal(result.status, 0);
      assert.match(currentHead(empty), /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('keeps materialized completion identity after commit', () => {
    writeFileSync(path.join(repo, 'tracked.txt'), 'changed\r\n');
    const before = materializedFingerprint(repo, ['tracked.txt']).digest;
    git('add', 'tracked.txt');
    git('commit', '--quiet', '--no-gpg-sign', '-m', 'change');
    assert.equal(materializedFingerprint(repo, ['tracked.txt']).digest, before);
    assert.match(baselineFingerprint(repo).repositoryState, /^sha256:[a-f0-9]{64}$/);
  });

  it('hashes index and before/after records deterministically', () => {
    const first = indexFingerprint(repo);
    assert.equal(first.digest, indexFingerprint(repo).digest);
    const before = materializedFingerprint(repo, ['tracked.txt']).entries;
    writeFileSync(path.join(repo, 'tracked.txt'), 'after\n');
    const after = materializedFingerprint(repo, ['tracked.txt']).entries;
    assert.equal(diffHash(before, after), diffHash(before, after));
    assert.notEqual(diffHash(before, after), diffHash(after, before));
  });

  it('rejects non-UTF-8 path bytes and ordinary directory task paths', () => {
    assert.throws(() => decodeGitPath(Buffer.from([0xff])), /Unsupported non-UTF-8 Git path/);
    mkdirSync(path.join(repo, 'directory'));
    assert.throws(() => materializedFingerprint(repo, ['directory']), /Unsupported directory/);
  });
});
