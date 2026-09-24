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
import { fileURLToPath } from 'node:url';

export const DEFAULT_MANIFEST_NAME = 'skill-hashes.json';
/** The dispatch skill directory this module ships in. */
export const DISPATCH_SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * `skillDir` as a repo-relative forward-slash path, or null when it is installed outside `repoRoot`.
 *
 * @param {string} repoRoot
 * @param {string} [skillDir]
 * @returns {string | null}
 */
export function skillDirInRepo(repoRoot, skillDir = DISPATCH_SKILL_DIR) {
  const real = (/** @type {string} */ value) => { try { return fs.realpathSync.native(value); } catch { return path.resolve(value); } };
  const relative = path.relative(real(repoRoot), real(skillDir));
  return !relative || relative.startsWith('..') || path.isAbsolute(relative) ? null : relative.split(path.sep).join('/');
}
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

// SECTION: Diagnostics and owned regeneration

const toForward = (/** @type {string} */ value) => value.split(path.sep).join('/');

/**
 * Hashed-surface violations: manifest mismatches plus generated entries the manifest does not list,
 * so an unexplained added file counts too.
 *
 * @param {string} skillDir
 * @returns {{ missing: boolean, corrupt: boolean, violations: string[] }}
 */
function hashedViolations(skillDir) {
  const manifestPath = path.join(skillDir, DEFAULT_MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return { missing: true, corrupt: false, violations: [] };
  /** @type {Record<string, string>} */
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('not an object');
  } catch {
    return { missing: false, corrupt: true, violations: [DEFAULT_MANIFEST_NAME] };
  }
  const generated = generateSkillHashes(skillDir);
  const keys = new Set([...Object.keys(manifest), ...Object.keys(generated)]);
  const violations = [...keys].filter((key) => manifest[key] !== generated[key]).sort();
  return { missing: false, corrupt: false, violations };
}

/**
 * Operator-facing integrity failure, or null when intact (a missing manifest stays a warning elsewhere).
 *
 * @param {string} skillDir
 * @returns {string | null}
 */
export function integrityDiagnostic(skillDir) {
  const { violations } = hashedViolations(skillDir);
  return violations.length
    ? `Skill integrity check failed for ${violations.join(', ')}; run npm run hashes if these edits are intended.`
    : null;
}

/**
 * Rewrites the manifest only when every violation is an edited path; a corrupt manifest never regenerates.
 *
 * @param {string} skillDir
 * @param {string[]} editedAbsolutePaths
 * @returns {{ regenerated: boolean, violations: string[] }}
 */
export function regenerateOwnedHashes(skillDir, editedAbsolutePaths) {
  const { corrupt, violations } = hashedViolations(skillDir);
  if (!violations.length) return { regenerated: false, violations: [] };
  if (corrupt) return { regenerated: false, violations };
  const edited = new Set(editedAbsolutePaths.map((value) => toForward(path.resolve(skillDir, value))));
  const owned = violations.every((relative) => edited.has(toForward(path.resolve(skillDir, relative))));
  if (!owned) return { regenerated: false, violations };
  fs.writeFileSync(path.join(skillDir, DEFAULT_MANIFEST_NAME), `${JSON.stringify(generateSkillHashes(skillDir), null, 2)}\n`, 'utf8');
  return { regenerated: true, violations };
}
