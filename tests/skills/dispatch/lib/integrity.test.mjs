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
} from '../../../../skills/dispatch/scripts/lib/integrity.mjs';

// SECTION: Skill Hash Validation

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

  it('generates a sorted recursive manifest for shipped files only', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-manifest-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'SKILL.md'), '# Skill', 'utf8');
      fs.mkdirSync(path.join(tmpDir, 'scripts', 'driver'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'references', 'templates', 'schemas'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'scripts', 'dispatch.mjs'), '// entry', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'scripts', 'driver', 'index.mjs'), '// router', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'scripts', 'driver', 'notes.txt'), 'excluded', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'references', 'templates', 'review-prompt.md'), '# Frame', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'references', 'templates', 'schemas', 'report-plan.json'), '{}', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'references', 'templates', 'notes.txt'), 'excluded', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'config.jsonc'), '{}', 'utf8');

      const manifest = generateSkillHashes(tmpDir);
      assert.deepEqual(Object.keys(manifest), [
        'SKILL.md',
        'references/templates/review-prompt.md',
        'references/templates/schemas/report-plan.json',
        'scripts/dispatch.mjs',
        'scripts/driver/index.mjs',
      ]);
      for (const digest of Object.values(manifest)) assert.match(digest, /^[0-9a-f]{64}$/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
