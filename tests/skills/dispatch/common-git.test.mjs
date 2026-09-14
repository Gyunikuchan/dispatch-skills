import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import {
  describeGitStatusDiff,
  checkGitIntegrity,
  getGitStatus,
  hashFile,
  verifySkillIntegrity,
  generateSkillHashes,
  PROJECT_ROOT,
} from '../../../skills/dispatch/scripts/common.mjs';

// ---------------------------------------------------------------------------
// SECTION: Git Status Fingerprints & Integrity
// ---------------------------------------------------------------------------

describe('common: git status fingerprints & integrity', () => {
  it('describeGitStatusDiff returns null when statuses match or are null', () => {
    assert.equal(describeGitStatusDiff(null, null), null);
    assert.equal(describeGitStatusDiff('M file.ts', 'M file.ts'), null);
  });

  it('describeGitStatusDiff returns added lines when status diverges', () => {
    const before = ' M abc123 file.ts';
    const after = ' M abc123 file.ts\n?? def456 new.ts';
    const diff = describeGitStatusDiff(before, after);
    assert.ok(diff !== null);
    assert.ok(diff.includes('new.ts'));
  });

  it('describeGitStatusDiff reports a removed entry, not just added ones', () => {
    // Deleting an untracked file is a workspace mutation; it used to report violation with no detail.
    const before = ' M abc123 file.ts\n?? def456 scratch.ts';
    const after = ' M abc123 file.ts';
    const diff = describeGitStatusDiff(before, after);
    assert.ok(diff !== null);
    assert.ok(diff.includes('scratch.ts'));
  });

  it('describeGitStatusDiff reports a re-modified file once, not twice', () => {
    // The same path occupies a record in both snapshots under different hashes — one change.
    const diff = describeGitStatusDiff(' M aaa file.ts', ' M bbb file.ts');
    assert.equal(diff, 'M file.ts');
  });

  it('describeGitStatusDiff strips the hash column from displayed entries', () => {
    const diff = describeGitStatusDiff('', '?? deadbeef new.ts');
    assert.equal(diff, '?? new.ts');
  });

  it('checkGitIntegrity treats a null baseline as no violation', () => {
    assert.equal(checkGitIntegrity(null).violation, false);
  });

  describe('getGitStatus content fingerprints', () => {
    /** Builds a throwaway git repo so the fingerprint can be observed against real git output. */
    const makeRepo = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-git-'));
      const git = (...args) => cp.spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      git('config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\n');
      git('add', '.');
      git('commit', '-qm', 'init');
      return { dir, git };
    };

    it('flags a content change to an already-modified file', () => {
      // The defect this replaced: both snapshots read ` M tracked.txt`, so a second edit by a
      // delegate was invisible to a status-line comparison.
      const { dir } = makeRepo();
      try {
        const file = path.join(dir, 'tracked.txt');
        fs.writeFileSync(file, 'two\n');
        const before = getGitStatus(dir);
        fs.writeFileSync(file, 'three\n');
        const after = getGitStatus(dir);

        assert.ok(before && after, 'both snapshots resolve inside a real repo');
        assert.notEqual(before, after);
        assert.equal(describeGitStatusDiff(before, after), 'M tracked.txt');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('records a deleted file with a tombstone instead of failing', () => {
      const { dir } = makeRepo();
      try {
        fs.rmSync(path.join(dir, 'tracked.txt'));
        const status = getGitStatus(dir);
        assert.ok(status, 'a deletion still produces a snapshot');
        assert.match(status, /tracked\.txt$/m);
        assert.match(status, /^.D - tracked\.txt$/m);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('lists new files individually under an untracked directory', () => {
      // Without -uall these collapse into one `?? sub/` line, hiding per-file writes.
      const { dir } = makeRepo();
      try {
        fs.mkdirSync(path.join(dir, 'sub'));
        fs.writeFileSync(path.join(dir, 'sub/a.txt'), 'a');
        fs.writeFileSync(path.join(dir, 'sub/b.txt'), 'b');
        const status = getGitStatus(dir);
        assert.match(status, /sub\/a\.txt$/m);
        assert.match(status, /sub\/b\.txt$/m);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('fingerprints the destination of a rename without consuming the next entry', () => {
      // `-z` emits a rename as two NUL-terminated tokens; mis-parsing shifts every later entry.
      const { dir, git } = makeRepo();
      try {
        git('mv', 'tracked.txt', 'renamed.txt');
        fs.writeFileSync(path.join(dir, 'later.txt'), 'later');
        const status = getGitStatus(dir);
        assert.match(status, /renamed\.txt$/m);
        assert.match(status, /later\.txt$/m);
        assert.ok(!status.includes('tracked.txt'), 'the rename origin is not a separate entry');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns null outside a git repository', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-nogit-'));
      try {
        assert.equal(getGitStatus(dir), null);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// SECTION: Skill Integrity & Hashes
// ---------------------------------------------------------------------------

describe('common: skill integrity & hashes', () => {
  it('hashFile matches a crypto-computed SHA-256 of the file bytes', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-hashfile-'));
    try {
      const file = path.join(tmpDir, 'payload.bin');
      const bytes = Buffer.from(['binary', 'content', 'with', 'üñíçödé'].join('\n'), 'utf8');
      fs.writeFileSync(file, bytes);
      const expected = crypto.createHash('sha256').update(bytes).digest('hex');
      assert.equal(hashFile(file), expected);
      assert.match(hashFile(file), /^[0-9a-f]{64}$/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('verifySkillIntegrity returns missing:true when no manifest exists', () => {
    const result = verifySkillIntegrity(os.tmpdir(), 'nonexistent-manifest.json');
    assert.equal(result.missing, true);
    assert.equal(result.valid, true);
    assert.deepEqual(result.violations, []);
  });

  it('generateSkillHashes lists SKILL.md and .mjs scripts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-hash-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'SKILL.md'), '# Skill', 'utf8');
      const scriptsDir = path.join(tmpDir, 'scripts');
      fs.mkdirSync(scriptsDir);
      fs.writeFileSync(path.join(scriptsDir, 'runner.mjs'), '// runner', 'utf8');

      const manifest = generateSkillHashes(tmpDir);
      assert.ok('SKILL.md' in manifest);
      assert.ok('scripts/runner.mjs' in manifest);
      assert.ok(typeof manifest['SKILL.md'] === 'string');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('generateSkillHashes hashes references/*.md and excludes config files', () => {
    const manifest = generateSkillHashes(path.join(PROJECT_ROOT, 'skills', 'dispatch'));
    assert.ok('references/alignment.md' in manifest);
    assert.ok(!Object.keys(manifest).some((k) => k.startsWith('config')));
    assert.deepEqual(Object.keys(manifest), [...Object.keys(manifest)].sort());
  });

  it('verifySkillIntegrity detects a tampered file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-tamper-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'SKILL.md'), '# Skill', 'utf8');
      const manifest = generateSkillHashes(tmpDir);
      const manifestPath = path.join(tmpDir, 'skill-hashes.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

      // Tamper with the file
      fs.writeFileSync(path.join(tmpDir, 'SKILL.md'), '# Tampered', 'utf8');

      const result = verifySkillIntegrity(tmpDir);
      assert.equal(result.valid, false);
      assert.ok(result.violations.includes('SKILL.md'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('verifySkillIntegrity passes when all hashes match', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-ok-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'SKILL.md'), '# Skill', 'utf8');
      const manifest = generateSkillHashes(tmpDir);
      const manifestPath = path.join(tmpDir, 'skill-hashes.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

      const result = verifySkillIntegrity(tmpDir);
      assert.equal(result.valid, true);
      assert.deepEqual(result.violations, []);
      assert.equal(result.missing, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
