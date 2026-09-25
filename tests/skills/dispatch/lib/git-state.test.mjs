import assert from 'node:assert/strict';
import fs, { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  snapshotContent,
  snapshotEntries,
} from '../../../../skills/dispatch/scripts/lib/git-state.mjs';

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

  // SECTION: Materialized snapshots

  it('snapshots file contents as Git blobs and restores them byte-exact', () => {
    const bytes = Buffer.from([0, 1, 13, 10, 255]);
    writeFileSync(path.join(repo, 'tracked.txt'), bytes);
    const entries = snapshotEntries(repo, ['tracked.txt', 'missing.txt']);
    const entry = entries.find(item => item.path === 'tracked.txt'), absent = entries.find(item => item.path === 'missing.txt');
    assert.match(entry.objectId, /^[0-9a-f]{40,64}$/);
    assert.equal(entry.content, undefined, 'blob entries carry no inline content');
    assert.deepEqual(snapshotContent(repo, entry), bytes);
    assert.equal(absent.mode, 'absent');
    assert.deepEqual(snapshotContent(repo, { content: Buffer.from('non-blob').toString('base64') }), Buffer.from('non-blob'));
  });

  it('captures dirty tracked, untracked, binary, mode, symlink, deletion, and rename state', () => {
    writeFileSync(path.join(repo, 'tracked.txt'), Buffer.from([0, 1, 13, 10]));
    if (process.platform !== 'win32') chmodSync(path.join(repo, 'tracked.txt'), 0o755);
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
    if (process.platform !== 'win32') {
      assert.equal(snapshot.entries.find(entry => entry.path === 'renamed.txt').mode, '100755');
    } else {
      assert.equal(snapshot.entries.find(entry => entry.path === 'renamed.txt').mode, '100644');
    }
    assert.equal(snapshot.entries.find(entry => entry.path === 'link').mode, '120000');
  });

  // SECTION: Repository boundaries and identity

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

  it('re-reads the index after each same-process index write', () => {
    const tracked = () => indexFingerprint(repo).entries.map(entry => `${entry.path}:${entry.objectId}:${entry.flags}`);
    const initial = tracked();
    writeFileSync(path.join(repo, 'staged.txt'), 'new\n');
    git('add', 'staged.txt');
    const added = tracked();
    assert.notDeepEqual(added, initial);
    writeFileSync(path.join(repo, 'staged.txt'), 'two\n');
    git('add', 'staged.txt');
    assert.notDeepEqual(tracked(), added, 'an object id change keeps the index size but is still observed');
    git('update-index', '--skip-worktree', 'tracked.txt');
    assert.equal(indexFingerprint(repo).entries.find(entry => entry.path === 'tracked.txt').flags, 'S');
  });

  it('re-reads an index whose bytes change under an unchanged stat identity', () => {
    const indexPath = path.join(repo, '.git', 'index');
    const before = indexFingerprint(repo).digest;
    writeFileSync(path.join(repo, 'tracked.txt'), 'next\n');
    // Simulate a same-tick rewrite that recycles the inode: every stat of the index reports its old identity.
    const frozen = { plain: fs.statSync(indexPath), bigint: fs.statSync(indexPath, { bigint: true }) };
    const realStat = fs.statSync;
    fs.statSync = (file, options) => path.resolve(String(file)) === indexPath
      ? (options?.bigint ? frozen.bigint : frozen.plain)
      : realStat(file, options);
    try {
      git('add', 'tracked.txt');
      assert.notEqual(indexFingerprint(repo).digest, before);
    } finally {
      fs.statSync = realStat;
    }
  });

  it('reads uncached while GIT_DIR redirects the repository', () => {
    const other = mkdtempSync(path.join(os.tmpdir(), 'ledger-other-'));
    const saved = process.env.GIT_DIR;
    try {
      spawnSync('git', ['init', '--quiet', '--initial-branch=work'], { cwd: other });
      process.env.GIT_DIR = path.join(other, '.git');
      const empty = indexFingerprint(repo).entries;
      assert.deepEqual(empty, [], 'the redirected repository has an empty index');
      writeFileSync(path.join(repo, 'added.txt'), 'x\n');
      git('add', 'added.txt');
      assert.deepEqual(indexFingerprint(repo).entries.map(entry => entry.path), ['added.txt']);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('keeps the index digest of separate tag and stage listings', () => {
    git('update-index', '--assume-unchanged', 'tracked.txt');
    const records = args => spawnSync('git', ['ls-files', ...args, '-z'], { cwd: repo }).stdout.toString('utf8').split('\0').filter(Boolean);
    const tags = new Map(records(['-v']).map(record => [record.slice(2), record[0]]));
    const expected = records(['--stage']).map(record => {
      const [header, file] = record.split('\t');
      const [mode, objectId, stage] = header.split(' ');
      return { file, mode, objectId, stage: Number(stage), flags: tags.get(file) };
    });
    const actual = indexFingerprint(repo).entries.map(entry => ({ file: entry.path, mode: entry.mode, objectId: entry.objectId, stage: entry.stage, flags: entry.flags }));
    assert.deepEqual(actual, expected);
    assert.equal(actual[0].flags, 'h');
  });

  it('rejects non-UTF-8 path bytes and ordinary directory task paths', () => {
    assert.throws(() => decodeGitPath(Buffer.from([0xff])), /Unsupported non-UTF-8 Git path/);
    mkdirSync(path.join(repo, 'directory'));
    assert.throws(() => materializedFingerprint(repo, ['directory']), /Unsupported directory/);
  });
});
