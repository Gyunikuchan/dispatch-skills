import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import {
  hashFile,
  verifySkillIntegrity,
  generateSkillHashes,
  PROJECT_ROOT,
} from '../../../skills/dispatch/scripts/common.mjs';

// ---------------------------------------------------------------------------
// SECTION: Skill Hash Validation
// ---------------------------------------------------------------------------

describe('common: skill hash validation', () => {
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
