// Skill-hash integrity check before dispatch (ports legacy lib/integrity.mjs). A drifted, missing, or extra
// hashed file is a violation; a missing manifest disables the check with a warning, as legacy did.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MANIFEST_NAME = 'skill-hashes.json';
const SCRIPT_EXTENSION = /\.(?:mjs|ts)$/;
const REFERENCE_EXTENSION = /\.(?:md|json)$/;

export const hashFile = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const forward = (value: string): string => value.split(path.sep).join('/');

function collect(skillDir: string, sub: string, pattern: RegExp, into: Record<string, string>): void {
  const root = path.join(skillDir, sub);
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { recursive: true })) {
    const relative = `${sub}/${forward(String(entry))}`;
    const absolute = path.join(skillDir, relative);
    if (pattern.test(relative) && fs.statSync(absolute).isFile()) into[relative] = hashFile(absolute);
  }
}

/** Hashes SKILL.md, scripts (.mjs/.ts), and references (.md/.json), sorted by path. */
export function generateSkillHashes(skillDir: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const skillMd = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(skillMd)) entries['SKILL.md'] = hashFile(skillMd);
  collect(skillDir, 'scripts', SCRIPT_EXTENSION, entries);
  collect(skillDir, 'references', REFERENCE_EXTENSION, entries);
  return Object.fromEntries(Object.keys(entries).sort().map((key) => [key, entries[key] ?? '']));
}

export type IntegrityResult =
  | { status: 'ok' }
  | { status: 'missing-manifest'; warning: string }
  | { status: 'drift'; violations: string[] };

/** Compares the manifest with a fresh hash of the skill; run before any dispatch. */
export function checkIntegrity(skillDir: string): IntegrityResult {
  const manifestPath = path.join(skillDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) {
    return { status: 'missing-manifest', warning: `Skill integrity manifest '${MANIFEST_NAME}' not found in ${skillDir}; integrity verification is disabled.` };
  }
  let manifest: unknown;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return { status: 'drift', violations: [MANIFEST_NAME] }; }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return { status: 'drift', violations: [MANIFEST_NAME] };
  const recorded = manifest as Record<string, unknown>;
  const actual = generateSkillHashes(skillDir);
  const violations = [...new Set([...Object.keys(recorded), ...Object.keys(actual)])].filter((key) => recorded[key] !== actual[key]).sort();
  return violations.length ? { status: 'drift', violations } : { status: 'ok' };
}

/** One-line INTEGRITY_VIOLATION diagnostic, or null when clean. */
export function integrityDiagnostic(result: IntegrityResult): string | null {
  return result.status === 'drift'
    ? `INTEGRITY_VIOLATION: skill integrity check failed for ${result.violations.join(', ')}; run npm run hashes if these edits are intended.`
    : null;
}
