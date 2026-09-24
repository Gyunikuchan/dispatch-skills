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

// SECTION: Integrity diagnostics and owned-hash regeneration

import * as integrity from '../../../../skills/dispatch/scripts/lib/integrity.mjs';

/** Builds a temporary skill directory with a manifest, then applies `mutate`. */
function staleSkillDir(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-stale-'));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# Skill', 'utf8');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'a.mjs'), '// a', 'utf8');
  fs.writeFileSync(path.join(dir, 'skill-hashes.json'), `${JSON.stringify(generateSkillHashes(dir), null, 2)}\n`, 'utf8');
  mutate(dir);
  return dir;
}

describe('common: integrity diagnostics (SC3, SC4)', () => {
  it('integrityDiagnostic names each modified file and npm run hashes', () => {
    const dir = staleSkillDir((d) => {
      fs.writeFileSync(path.join(d, 'SKILL.md'), '# Edited', 'utf8');
      fs.writeFileSync(path.join(d, 'scripts', 'a.mjs'), '// edited', 'utf8');
    });
    try {
      assert.equal(typeof integrity.integrityDiagnostic, 'function');
      const message = integrity.integrityDiagnostic(dir);
      assert.equal(typeof message, 'string');
      assert.match(message, /SKILL\.md/);
      assert.match(message, /scripts\/a\.mjs/);
      assert.match(message, /npm run hashes/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('integrityDiagnostic returns null for an intact skill directory', () => {
    const dir = staleSkillDir(() => {});
    try {
      assert.equal(typeof integrity.integrityDiagnostic, 'function');
      assert.equal(integrity.integrityDiagnostic(dir), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('regenerateOwnedHashes rewrites the manifest when every violation is owned', () => {
    const dir = staleSkillDir((d) => fs.writeFileSync(path.join(d, 'SKILL.md'), '# Edited', 'utf8'));
    try {
      assert.equal(typeof integrity.regenerateOwnedHashes, 'function');
      const result = integrity.regenerateOwnedHashes(dir, [path.join(dir, 'SKILL.md')]);
      assert.equal(result.regenerated, true);
      assert.deepEqual(result.violations, ['SKILL.md']);
      assert.equal(
        fs.readFileSync(path.join(dir, 'skill-hashes.json'), 'utf8'),
        `${JSON.stringify(generateSkillHashes(dir), null, 2)}\n`,
      );
      assert.equal(verifySkillIntegrity(dir).valid, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('regenerateOwnedHashes leaves the manifest untouched when a violation is foreign', () => {
    const dir = staleSkillDir((d) => {
      fs.writeFileSync(path.join(d, 'SKILL.md'), '# Edited', 'utf8');
      fs.writeFileSync(path.join(d, 'scripts', 'a.mjs'), '// foreign', 'utf8');
    });
    const manifestPath = path.join(dir, 'skill-hashes.json');
    const before = fs.readFileSync(manifestPath, 'utf8');
    try {
      assert.equal(typeof integrity.regenerateOwnedHashes, 'function');
      const result = integrity.regenerateOwnedHashes(dir, [path.join(dir, 'SKILL.md')]);
      assert.equal(result.regenerated, false);
      assert.ok(result.violations.includes('scripts/a.mjs'));
      assert.equal(fs.readFileSync(manifestPath, 'utf8'), before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('regenerateOwnedHashes treats an unlisted added file as a violation', () => {
    const dir = staleSkillDir((d) => fs.writeFileSync(path.join(d, 'scripts', 'added.mjs'), '// new', 'utf8'));
    const manifestPath = path.join(dir, 'skill-hashes.json');
    const before = fs.readFileSync(manifestPath, 'utf8');
    try {
      assert.equal(typeof integrity.regenerateOwnedHashes, 'function');
      const result = integrity.regenerateOwnedHashes(dir, []);
      assert.equal(result.regenerated, false);
      assert.deepEqual(result.violations, ['scripts/added.mjs']);
      assert.equal(fs.readFileSync(manifestPath, 'utf8'), before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('integrityDiagnostic returns null when the manifest is missing', () => {
    const dir = staleSkillDir((d) => fs.rmSync(path.join(d, 'skill-hashes.json')));
    try {
      assert.equal(typeof integrity.integrityDiagnostic, 'function');
      assert.equal(integrity.integrityDiagnostic(dir), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('regenerateOwnedHashes never regenerates a corrupt manifest', () => {
    const dir = staleSkillDir((d) => fs.writeFileSync(path.join(d, 'skill-hashes.json'), '{ not json', 'utf8'));
    const manifestPath = path.join(dir, 'skill-hashes.json');
    try {
      assert.equal(typeof integrity.regenerateOwnedHashes, 'function');
      let result;
      try {
        result = integrity.regenerateOwnedHashes(dir, [path.join(dir, 'SKILL.md'), manifestPath]);
      } catch {
        result = { regenerated: false };
      }
      assert.equal(result.regenerated, false);
      assert.equal(fs.readFileSync(manifestPath, 'utf8'), '{ not json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('regenerateOwnedHashes compares edited paths as absolute forward-slash paths', () => {
    const dir = staleSkillDir((d) => fs.writeFileSync(path.join(d, 'scripts', 'a.mjs'), '// edited', 'utf8'));
    try {
      assert.equal(typeof integrity.regenerateOwnedHashes, 'function');
      const forward = path.resolve(dir, 'scripts', 'a.mjs').split(path.sep).join('/');
      const result = integrity.regenerateOwnedHashes(dir, [forward]);
      assert.equal(result.regenerated, true);
      assert.deepEqual(result.violations, ['scripts/a.mjs']);
      assert.equal(verifySkillIntegrity(dir).valid, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('regenerateOwnedHashes is a no-op without violations', () => {
    const dir = staleSkillDir(() => {});
    try {
      assert.equal(typeof integrity.regenerateOwnedHashes, 'function');
      assert.deepEqual(integrity.regenerateOwnedHashes(dir, []), { regenerated: false, violations: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
