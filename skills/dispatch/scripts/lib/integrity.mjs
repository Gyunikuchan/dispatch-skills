/**
 * @file integrity.mjs
 * @description Skill integrity manifest: file hashing, `skill-hashes.json` generation, and verification.
 *
 * Supports Windows, macOS, Linux (bash, zsh, PowerShell).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// SECTION: Skill Hash Validation
// ============================================================================

/**
 * Computes SHA-256 hash of a file's contents.
 */
export function hashFile(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Verifies skill file integrity against a manifest of expected hashes.
 * Returns an object with `valid` (boolean) and `violations` (array of paths).
 *
 * @param {string} skillDir - Root directory of the skill
 * @param {string} [manifestName='skill-hashes.json'] - Name of the hash manifest file
 */
export function verifySkillIntegrity(skillDir, manifestName = 'skill-hashes.json') {
  const manifestPath = path.join(skillDir, manifestName);
  if (!fs.existsSync(manifestPath)) {
    process.stderr.write(
      `[dispatch] WARNING: Skill integrity manifest '${manifestName}' not found in ${skillDir}. ` +
        `Integrity verification is disabled — run generate-hashes.mjs to create it.\n`,
    );
    return { valid: true, violations: [], missing: true };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { valid: false, violations: [manifestPath], missing: false };
  }

  const violations = [];
  for (const [relativePath, expectedHash] of Object.entries(manifest)) {
    const absPath = path.join(skillDir, relativePath);
    if (!fs.existsSync(absPath)) {
      violations.push(relativePath);
      continue;
    }
    const actualHash = hashFile(absPath);
    if (actualHash !== expectedHash) {
      violations.push(relativePath);
    }
  }

  return { valid: violations.length === 0, violations, missing: false };
}

/**
 * Generates a hash manifest for all tracked files in a skill directory: SKILL.md, every .mjs
 * under scripts/, and every .md/.json under references/ (recursively). Config
 * files (`config*.jsonc`) are never hashed — they're user-edited/dynamic by design, not part of the skill's integrity surface.
 * Entries are sorted alphabetically for a stable, diff-friendly manifest.
 */
export function generateSkillHashes(skillDir) {
  const entries = {};
  const skillMd = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(skillMd)) {
    entries['SKILL.md'] = hashFile(skillMd);
  }

  const scriptsDir = path.join(skillDir, 'scripts');
  if (fs.existsSync(scriptsDir)) {
    // Recursive so script subdirectories (scripts/driver/**) stay integrity-checked.
    for (const entry of fs.readdirSync(scriptsDir, { recursive: true })) {
      const rel = `scripts/${String(entry).split(path.sep).join('/')}`;
      if (rel.endsWith('.mjs') && fs.statSync(path.join(skillDir, rel)).isFile()) entries[rel] = hashFile(path.join(skillDir, rel));
    }
  }

  const referencesDir = path.join(skillDir, 'references');
  if (fs.existsSync(referencesDir)) {
    // Recursive so nested templates (references/templates/**) stay integrity-checked.
    for (const entry of fs.readdirSync(referencesDir, { recursive: true })) {
      const rel = `references/${String(entry).split(path.sep).join('/')}`;
      const abs = path.join(skillDir, rel);
      if (/\.(?:md|json)$/.test(rel) && fs.statSync(abs).isFile()) entries[rel] = hashFile(abs);
    }
  }

  const manifest = {};
  for (const key of Object.keys(entries).sort()) {
    manifest[key] = entries[key];
  }
  return manifest;
}
