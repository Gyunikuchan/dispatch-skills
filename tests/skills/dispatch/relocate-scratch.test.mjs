import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, beforeEach, afterEach } from 'node:test';

import {
  isScratchPath,
  resolveUniqueDest,
  relocateScratchItem,
  relocateScratchPaths,
} from '../../../skills/dispatch/scripts/relocate-scratch.mjs';

const SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../skills/dispatch/scripts/relocate-scratch.mjs',
);

describe('relocate-scratch', () => {
  let tmpWorkspace;
  let tmpDestDir;

  beforeEach(() => {
    tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-test-ws-'));
    tmpDestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-test-dest-'));
    fs.mkdirSync(path.join(tmpWorkspace, '.scratch', 'plan'), { recursive: true });
    fs.mkdirSync(path.join(tmpWorkspace, '.scratch', 'audits', 'run-1-work'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
    fs.rmSync(tmpDestDir, { recursive: true, force: true });
  });

  describe('isScratchPath', () => {
    it('accepts paths within .scratch/', () => {
      assert.equal(isScratchPath('.scratch/plan/doc.md', tmpWorkspace), true);
      assert.equal(isScratchPath('.scratch/audits/run-1-work', tmpWorkspace), true);
      assert.equal(isScratchPath(path.join(tmpWorkspace, '.scratch', 'test.txt'), tmpWorkspace), true);
    });

    it('rejects paths outside .scratch/', () => {
      assert.equal(isScratchPath('src/index.ts', tmpWorkspace), false);
      assert.equal(isScratchPath('../outside.md', tmpWorkspace), false);
      assert.equal(isScratchPath('package.json', tmpWorkspace), false);
    });
  });

  describe('resolveUniqueDest', () => {
    it('returns original name when destination does not exist', () => {
      const dest = resolveUniqueDest(tmpDestDir, 'sample.md');
      assert.equal(dest, path.join(tmpDestDir, 'sample.md'));
    });

    it('disambiguates name when destination already exists', () => {
      fs.writeFileSync(path.join(tmpDestDir, 'sample.md'), 'existing');
      const dest = resolveUniqueDest(tmpDestDir, 'sample.md');
      assert.notEqual(dest, path.join(tmpDestDir, 'sample.md'));
      assert.match(path.basename(dest), /^sample-\d+\.md$/);
    });

    it('does not treat dotted directory names as extensions', () => {
      fs.mkdirSync(path.join(tmpDestDir, 'run.v2'), { recursive: true });
      const dest = resolveUniqueDest(tmpDestDir, 'run.v2', true);
      assert.match(path.basename(dest), /^run\.v2-\d+$/);
    });
  });

  describe('relocateScratchItem', () => {
    it('relocates a scratch file successfully', () => {
      const srcFile = path.join(tmpWorkspace, '.scratch', 'plan', '2026-09-14-plan.md');
      fs.writeFileSync(srcFile, '# Plan Content');

      const dest = relocateScratchItem(srcFile, { targetDir: tmpDestDir, cwd: tmpWorkspace });
      assert.ok(dest);
      assert.equal(fs.existsSync(srcFile), false);
      assert.equal(fs.existsSync(dest), true);
      assert.equal(fs.readFileSync(dest, 'utf8'), '# Plan Content');
    });

    it('relocates a scratch directory recursively', () => {
      const srcDir = path.join(tmpWorkspace, '.scratch', 'audits', 'run-1-work');
      fs.writeFileSync(path.join(srcDir, 'audit-work.json'), '{"key":"val"}');

      const dest = relocateScratchItem(srcDir, { targetDir: tmpDestDir, cwd: tmpWorkspace });
      assert.ok(dest);
      assert.equal(fs.existsSync(srcDir), false);
      assert.equal(fs.existsSync(dest), true);
      assert.equal(fs.readFileSync(path.join(dest, 'audit-work.json'), 'utf8'), '{"key":"val"}');
    });

    it('handles EXDEV cross-device copy fallback for files', () => {
      const srcFile = path.join(tmpWorkspace, '.scratch', 'plan', 'exdev-file.md');
      fs.writeFileSync(srcFile, 'EXDEV File Content');

      const origRename = fs.renameSync;
      try {
        fs.renameSync = () => {
          const err = new Error('Cross-device link');
          err.code = 'EXDEV';
          throw err;
        };

        const dest = relocateScratchItem(srcFile, { targetDir: tmpDestDir, cwd: tmpWorkspace });
        assert.ok(dest);
        assert.equal(fs.existsSync(srcFile), false);
        assert.equal(fs.existsSync(dest), true);
        assert.equal(fs.readFileSync(dest, 'utf8'), 'EXDEV File Content');
      } finally {
        fs.renameSync = origRename;
      }
    });

    it('handles EXDEV cross-device copy fallback for directories', () => {
      const srcDir = path.join(tmpWorkspace, '.scratch', 'audits', 'exdev-dir');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'data.txt'), 'nested exdev');

      const origRename = fs.renameSync;
      try {
        fs.renameSync = () => {
          const err = new Error('Cross-device link');
          err.code = 'EXDEV';
          throw err;
        };

        const dest = relocateScratchItem(srcDir, { targetDir: tmpDestDir, cwd: tmpWorkspace });
        assert.ok(dest);
        assert.equal(fs.existsSync(srcDir), false);
        assert.equal(fs.existsSync(dest), true);
        assert.equal(fs.readFileSync(path.join(dest, 'data.txt'), 'utf8'), 'nested exdev');
      } finally {
        fs.renameSync = origRename;
      }
    });

    it('returns null for non-existent source without throwing', () => {
      const nonExistent = path.join(tmpWorkspace, '.scratch', 'plan', 'missing.md');
      const dest = relocateScratchItem(nonExistent, { targetDir: tmpDestDir, cwd: tmpWorkspace });
      assert.equal(dest, null);
    });

    it('throws error for source path escaping .scratch/', () => {
      const outsideFile = path.join(tmpWorkspace, 'outside.txt');
      fs.writeFileSync(outsideFile, 'secret');
      assert.throws(() => {
        relocateScratchItem(outsideFile, { targetDir: tmpDestDir, cwd: tmpWorkspace });
      }, /outside the \.scratch/);
    });
  });

  describe('relocateScratchPaths', () => {
    it('relocates multiple paths in one call', () => {
      const file1 = path.join(tmpWorkspace, '.scratch', 'plan', 'plan.md');
      const file2 = path.join(tmpWorkspace, '.scratch', 'plan', 'walkthrough.md');
      fs.writeFileSync(file1, 'Plan');
      fs.writeFileSync(file2, 'Walkthrough');

      const results = relocateScratchPaths([file1, file2], { targetDir: tmpDestDir, cwd: tmpWorkspace });
      assert.equal(results.length, 2);
      assert.equal(fs.existsSync(file1), false);
      assert.equal(fs.existsSync(file2), false);
      assert.equal(fs.existsSync(results[0]), true);
      assert.equal(fs.existsSync(results[1]), true);
    });
  });

  describe('CLI execution', () => {
    it('prints help message on --help', () => {
      const res = cp.spawnSync(process.execPath, [SCRIPT_PATH, '--help'], { encoding: 'utf8' });
      assert.equal(res.status, 0);
      assert.match(res.stdout, /relocate-scratch\.mjs/);
    });

    it('exits with code 2 on empty arguments', () => {
      const res = cp.spawnSync(process.execPath, [SCRIPT_PATH], { encoding: 'utf8' });
      assert.equal(res.status, 2);
      assert.match(res.stderr, /Usage:/);
    });

    it('exits with error on path outside scratch', () => {
      const outside = path.join(tmpWorkspace, 'outside.md');
      fs.writeFileSync(outside, 'content');
      const res = cp.spawnSync(process.execPath, [SCRIPT_PATH, outside], {
        cwd: tmpWorkspace,
        encoding: 'utf8',
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /outside the \.scratch/);
    });
  });
});
