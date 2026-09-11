import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { PROJECT_ROOT } from '../../skills/dispatch/scripts/common.mjs';
import {
  findConfigFiles,
  validateConfigFile,
  validateAllConfigs,
  runCli,
} from '../../scripts/validate-configs.mjs';

describe('validate-configs', () => {
  it('validates shipped repository configs cleanly', () => {
    const shippedFiles = [
      'skills/dispatch/config.default.jsonc',
      'skills/implement-dispatch/config.default.jsonc',
      '.opencode/opencode.jsonc',
      'skills/dispatch/skill-hashes.json',
      'skills-lock.json',
    ];

    const { valid, results } = validateAllConfigs({
      projectRoot: PROJECT_ROOT,
      files: shippedFiles,
    });

    assert.equal(valid, true);
    assert.equal(results.length, shippedFiles.length);
    for (const res of results) {
      assert.equal(res.valid, true, `Expected ${res.relativePath} to be valid`);
      assert.deepEqual(res.problems, []);
    }
  });

  it('validates a complete project workspace fixture cleanly', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'val-conf-workspace-'));
    try {
      // Setup skills/implement-dispatch, .opencode, skills/dispatch, and skills-lock.json
      const implDir = path.join(tempDir, 'skills', 'implement-dispatch');
      const opencodeDir = path.join(tempDir, '.opencode');
      const dispatchDir = path.join(tempDir, 'skills', 'dispatch');
      mkdirSync(implDir, { recursive: true });
      mkdirSync(opencodeDir, { recursive: true });
      mkdirSync(dispatchDir, { recursive: true });

      copyFileSync(
        path.join(PROJECT_ROOT, 'skills', 'implement-dispatch', 'config.default.jsonc'),
        path.join(implDir, 'config.default.jsonc')
      );
      copyFileSync(
        path.join(PROJECT_ROOT, '.opencode', 'opencode.jsonc'),
        path.join(opencodeDir, 'opencode.jsonc')
      );
      copyFileSync(
        path.join(PROJECT_ROOT, 'skills', 'dispatch', 'skill-hashes.json'),
        path.join(dispatchDir, 'skill-hashes.json')
      );
      copyFileSync(
        path.join(PROJECT_ROOT, 'skills', 'dispatch', 'config.default.jsonc'),
        path.join(dispatchDir, 'config.default.jsonc')
      );
      copyFileSync(
        path.join(PROJECT_ROOT, 'skills-lock.json'),
        path.join(tempDir, 'skills-lock.json')
      );

      const { valid, results } = validateAllConfigs({ projectRoot: tempDir });
      assert.equal(valid, true);
      assert.equal(results.length, 5);
      for (const res of results) {
        assert.equal(res.valid, true);
        assert.deepEqual(res.problems, []);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('findConfigFiles', () => {
    it('skips missing optional config files like config.local.jsonc without throwing', () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), 'val-conf-find-'));
      try {
        const found = findConfigFiles(tempDir);
        assert.deepEqual(found, []);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('discovers newly added config files in project root or .implement-dispatch', () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), 'val-conf-find-'));
      try {
        const implDir = path.join(tempDir, '.implement-dispatch');
        mkdirSync(implDir, { recursive: true });
        writeFileSync(path.join(implDir, 'config.local.jsonc'), '{}', 'utf8');
        writeFileSync(path.join(tempDir, 'opencode.jsonc'), '{}', 'utf8');

        const found = findConfigFiles(tempDir);
        const relPaths = found.map(f => path.relative(tempDir, f.path).replace(/\\/g, '/'));
        assert.ok(relPaths.includes('.implement-dispatch/config.local.jsonc'));
        assert.ok(relPaths.includes('opencode.jsonc'));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('discovers a dispatch config in the project-root .dispatch override dir, typed "dispatch"', () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), 'val-conf-find-dispatch-'));
      try {
        const overrideDir = path.join(tempDir, '.dispatch');
        mkdirSync(overrideDir, { recursive: true });
        writeFileSync(path.join(overrideDir, 'config.jsonc'), '{}', 'utf8');

        const found = findConfigFiles(tempDir);
        const match = found.find(f => path.relative(tempDir, f.path).replace(/\\/g, '/') === '.dispatch/config.jsonc');
        assert.ok(match, 'expected .dispatch/config.jsonc to be discovered');
        assert.equal(match.type, 'dispatch');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('discovers the shipped skills/dispatch/config.default.jsonc, typed "dispatch"', () => {
      const found = findConfigFiles(PROJECT_ROOT);
      const match = found.find(
        f => path.relative(PROJECT_ROOT, f.path).replace(/\\/g, '/') === 'skills/dispatch/config.default.jsonc'
      );
      assert.ok(match, 'expected skills/dispatch/config.default.jsonc to be discovered');
      assert.equal(match.type, 'dispatch');
    });
  });

  describe('validateConfigFile', () => {
    it('reports missing file', () => {
      const res = validateConfigFile('/path/that/does/not/exist.jsonc', 'implement-dispatch');
      assert.equal(res.valid, false);
      assert.match(res.problems[0], /File not found/);
    });

    it('reports JSON/JSONC syntax error with malformed content', () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), 'val-conf-syntax-'));
      try {
        const badFile = path.join(tempDir, 'bad.jsonc');
        writeFileSync(badFile, '{ "broken": /* unterminated comment', 'utf8');
        const res = validateConfigFile(badFile, 'implement-dispatch');
        assert.equal(res.valid, false);
        assert.match(res.problems[0], /Syntax error/);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    describe('dispatch schema validation', () => {
      it('rejects a platforms map missing or malformed', () => {
        const tempDir = mkdtempSync(path.join(os.tmpdir(), 'val-conf-dispatch-'));
        try {
          const file = path.join(tempDir, 'config.jsonc');
          writeFileSync(file, '{}', 'utf8');
          const res = validateConfigFile(file, 'dispatch');
          assert.equal(res.valid, false);
          assert.ok(res.problems.length > 0);
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      });

      it('accepts the shipped dispatch default config', () => {
        const validPath = path.join(PROJECT_ROOT, 'skills', 'dispatch', 'config.default.jsonc');
        const res = validateConfigFile(validPath, 'dispatch');
        assert.equal(res.valid, true);
        assert.deepEqual(res.problems, []);
      });
    });

    describe('implement-dispatch schema validation', () => {
      it('rejects an empty object missing required sections', () => {
        const tempDir = mkdtempSync(path.join(os.tmpdir(), 'val-conf-impl-'));
        try {
          const file = path.join(tempDir, 'config.jsonc');
          writeFileSync(file, '{}', 'utf8');
          const res = validateConfigFile(file, 'implement-dispatch');
          assert.equal(res.valid, false);
          assert.ok(res.problems.some(p => p.includes('Missing required section')));
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      });

      it('accepts a valid implement-dispatch config', () => {
        const validPath = path.join(PROJECT_ROOT, 'skills', 'implement-dispatch', 'config.default.jsonc');
        const res = validateConfigFile(validPath, 'implement-dispatch');
        assert.equal(res.valid, true);
        assert.deepEqual(res.problems, []);
      });
    });

    describe('opencode schema validation', () => {
      it('accepts valid opencode config', () => {
        const tempDir = mkdtempSync(path.join(os.tmpdir(), 'val-conf-opencode-'));
        try {
          const file = path.join(tempDir, 'opencode.jsonc');
          writeFileSync(
            file,
            '{\n  // comment\n  "model": "anthropic/claude-opus-5",\n  "agent": { "delegate": {} }\n}',
            'utf8'
          );
          const res = validateConfigFile(file, 'opencode');
          assert.equal(res.valid, true);
          assert.deepEqual(res.problems, []);
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      });

      it('rejects opencode config with invalid field types', () => {
        const tempDir = mkdtempSync(path.join(os.tmpdir(), 'val-conf-opencode-'));
        try {
          const file = path.join(tempDir, 'opencode.jsonc');
          writeFileSync(file, '{\n  "model": 12345,\n  "agent": "not-an-object"\n}', 'utf8');
          const res = validateConfigFile(file, 'opencode');
          assert.equal(res.valid, false);
          assert.ok(res.problems.some(p => p.includes('model')));
          assert.ok(res.problems.some(p => p.includes('agent')));
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      });
    });

    describe('skill-hashes validation', () => {
      it('accepts valid skill-hashes file', () => {
        const manifestPath = path.join(PROJECT_ROOT, 'skills', 'dispatch', 'skill-hashes.json');
        const res = validateConfigFile(manifestPath, 'skill-hashes');
        assert.equal(res.valid, true);
        assert.deepEqual(res.problems, []);
      });

      it('rejects invalid hash entries', () => {
        const tempDir = mkdtempSync(path.join(os.tmpdir(), 'val-conf-hash-'));
        try {
          const file = path.join(tempDir, 'skill-hashes.json');
          writeFileSync(file, JSON.stringify({ 'SKILL.md': 'not-a-valid-sha256-hex' }), 'utf8');
          const res = validateConfigFile(file, 'skill-hashes');
          assert.equal(res.valid, false);
          assert.ok(res.problems.some(p => p.includes('SHA-256')));
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      });
    });

    describe('skills-lock validation', () => {
      it('accepts valid skills-lock file', () => {
        const lockPath = path.join(PROJECT_ROOT, 'skills-lock.json');
        const res = validateConfigFile(lockPath, 'skills-lock');
        assert.equal(res.valid, true);
        assert.deepEqual(res.problems, []);
      });

      it('rejects skills-lock without version', () => {
        const tempDir = mkdtempSync(path.join(os.tmpdir(), 'val-conf-lock-'));
        try {
          const file = path.join(tempDir, 'skills-lock.json');
          writeFileSync(file, JSON.stringify({ skills: {} }), 'utf8');
          const res = validateConfigFile(file, 'skills-lock');
          assert.equal(res.valid, false);
          assert.ok(res.problems.some(p => p.includes('version')));
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      });
    });
  });

  describe('runCli', () => {
    it('returns 0 with --help flag', () => {
      const code = runCli(['--help']);
      assert.equal(code, 0);
    });

    it('returns 0 when run against an empty directory with --quiet', () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), 'val-conf-cli-clean-'));
      try {
        const code = runCli(['--project-root', tempDir, '--quiet']);
        assert.equal(code, 0);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('returns 1 when encountering an invalid config file', () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), 'val-conf-cli-'));
      try {
        const implDir = path.join(tempDir, '.implement-dispatch');
        mkdirSync(implDir, { recursive: true });
        writeFileSync(path.join(implDir, 'config.local.jsonc'), '{ invalid json', 'utf8');

        const code = runCli(['--project-root', tempDir, '--quiet']);
        assert.equal(code, 1);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('returns 1 on unrecognized argument', () => {
      const code = runCli(['--unknown-arg']);
      assert.equal(code, 1);
    });
  });
});
