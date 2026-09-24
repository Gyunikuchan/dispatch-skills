// @ts-check
/**
 * @file integrity.mjs
 * @description Skill integrity manifest: file hashing, `skill-hashes.json` generation, and verification.
 *
 * Supports Windows, macOS, Linux (bash, zsh, PowerShell).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MANIFEST_NAME = 'skill-hashes.json';
const HASHED_REFERENCE_EXTENSION = /\.(?:md|json)$/;

// SECTION: Hashing and verification

/**
 * Computes a file's SHA-256 digest.
 *
 * @param {string} filePath
 * @returns {string}
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
export function verifySkillIntegrity(skillDir, manifestName = DEFAULT_MANIFEST_NAME) {
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

// SECTION: Manifest generation

/**
 * Generates a stable manifest for SKILL.md, recursive script modules, and recursive Markdown/JSON
 * references. Config files remain outside the integrity surface because users edit
 * them at runtime.
 *
 * @param {string} skillDir
 * @returns {Record<string, string>}
 */
export function generateSkillHashes(skillDir) {
  const entries = {};
  const skillMd = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(skillMd)) entries['SKILL.md'] = hashFile(skillMd);

  const scriptsDir = path.join(skillDir, 'scripts');
  if (fs.existsSync(scriptsDir)) {
    for (const entry of fs.readdirSync(scriptsDir, { recursive: true })) {
      const relativePath = `scripts/${String(entry).split(path.sep).join('/')}`;
      const absolutePath = path.join(skillDir, relativePath);
      if (relativePath.endsWith('.mjs') && fs.statSync(absolutePath).isFile()) {
        entries[relativePath] = hashFile(absolutePath);
      }
    }
  }

  const referencesDir = path.join(skillDir, 'references');
  if (fs.existsSync(referencesDir)) {
    for (const entry of fs.readdirSync(referencesDir, { recursive: true })) {
      const relativePath = `references/${String(entry).split(path.sep).join('/')}`;
      const absolutePath = path.join(skillDir, relativePath);
      if (HASHED_REFERENCE_EXTENSION.test(relativePath) && fs.statSync(absolutePath).isFile()) {
        entries[relativePath] = hashFile(absolutePath);
      }
    }
  }

  return Object.fromEntries(Object.keys(entries).sort().map((key) => [key, entries[key]]));
}
