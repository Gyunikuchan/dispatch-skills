// Skill-hash integrity check before dispatch. A drifted, missing, or extra
// hashed file is a violation; a missing manifest disables the check with a warning.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalMarkdown } from './canonical-markdown.ts';

export const MANIFEST_NAME = 'skill-hashes.json';
const SCRIPT_EXTENSION = /\.ts$/;
const REFERENCE_EXTENSION = /\.(?:md|json)$/;
const MARKDOWN_EXTENSION = /\.md$/;
const JSON_EXTENSION = /\.json$/;

export const hashFile = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

// SECTION: skill file hashing

// Key-sorted re-serialization so JSON key order and whitespace do not change the hash.
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${sortedJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// NOTE: unparseable JSON hashes as CRLF-normalized text so it still drifts deterministically.
const jsonForm = (text: string): string => {
  try { return sortedJson(JSON.parse(text)); } catch { return text.replaceAll('\r\n', '\n'); }
};

// Markdown and JSON formatter rewrites are not meaning changes, so they hash canonically. `.ts` stays exact
// (CRLF-normalized only) because whitespace there can be meaningful and must not be hidden by a formatter.
// `.gitattributes` checks out LF while `core.autocrlf` checkouts hold CRLF, so CRLF always normalizes to LF.
function hashSkillFile(file: string): string {
  const text = fs.readFileSync(file, 'utf8');
  if (MARKDOWN_EXTENSION.test(file)) return sha256(canonicalMarkdown(text));
  if (JSON_EXTENSION.test(file)) return sha256(jsonForm(text));
  return sha256(text.replaceAll('\r\n', '\n'));
}

const forward = (value: string): string => value.split(path.sep).join('/');

function collect(skillDir: string, sub: string, pattern: RegExp, into: Record<string, string>): void {
  const root = path.join(skillDir, sub);
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { recursive: true })) {
    const relative = `${sub}/${forward(String(entry))}`;
    const absolute = path.join(skillDir, relative);
    if (pattern.test(relative) && fs.statSync(absolute).isFile()) into[relative] = hashSkillFile(absolute);
  }
}

/** Hashes SKILL.md, scripts (.ts), and references (.md/.json), sorted by path. */
export function generateSkillHashes(skillDir: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const skillMd = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(skillMd)) entries['SKILL.md'] = hashSkillFile(skillMd);
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
  // `$`-prefixed keys carry build metadata (`$version`), not file hashes.
  const recorded = Object.fromEntries(Object.entries(manifest).filter(([key]) => !key.startsWith('$')));
  const actual = generateSkillHashes(skillDir);
  const violations = [...new Set([...Object.keys(recorded), ...Object.keys(actual)])].filter((key) => recorded[key] !== actual[key]).sort();
  return violations.length ? { status: 'drift', violations } : { status: 'ok' };
}

/** The dispatch version recorded in the manifest (`$version`), or undefined when absent or unreadable. */
export function readVersion(skillDir: string): string | undefined {
  try {
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(skillDir, MANIFEST_NAME), 'utf8'));
    const version = typeof manifest === 'object' && manifest !== null ? (manifest as Record<string, unknown>)['$version'] : undefined;
    return typeof version === 'string' ? version : undefined;
  } catch { return undefined; }
}

/** One-line INTEGRITY_VIOLATION diagnostic, or null when clean. */
export function integrityDiagnostic(result: IntegrityResult): string | null {
  return result.status === 'drift'
    ? `INTEGRITY_VIOLATION: skill integrity check failed for ${result.violations.join(', ')}; run npm run hashes if these edits are intended.`
    : null;
}
