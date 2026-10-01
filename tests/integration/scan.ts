// Shared overlay file table and import extractor for the static guards. Guards take in-memory tables
// so their failure paths are tested without writing violating files.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the shipped repository root. */
export const OVERLAY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_ROOT = OVERLAY_ROOT;

/** One overlay file: `path` is relative to the repository root with forward slashes. */
export interface FileEntry { path: string; text: string }
export type FileTable = readonly FileEntry[];

const TEXT_EXTENSIONS = new Set(['.ts', '.mjs', '.js', '.json', '.md', '.jsonc']);

export function scanOverlay(root = OVERLAY_ROOT): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!['node_modules', '.git', '.scratch', '.codegraph', '.agents', '.claude', '.codex', '.opencode'].includes(entry.name)) walk(full); continue; }
      const rel = path.relative(root, full).replace(/\\/g, '/');
      out.push({ path: rel, text: TEXT_EXTENSIONS.has(path.extname(entry.name)) ? fs.readFileSync(full, 'utf8') : '' });
    }
  };
  walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export interface ImportRef { specifier: string; typeOnly: boolean }

const STATIC_IMPORT = /(?:^|[\n;])\s*(import|export)\s+(type\s+)?((?:\{[^}]*\}|\*\s+as\s+\w+|\*|\w+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+))?)\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Static, re-export, side-effect, and literal dynamic imports; `typeOnly` when erased at runtime. */
export function extractImports(text: string): ImportRef[] {
  const refs: ImportRef[] = [];
  for (const match of text.matchAll(STATIC_IMPORT)) {
    const clause = match[3] ?? '';
    const specifier = match[4] ?? '';
    if (match[1] === 'export' && !clause) continue;
    const braces = /^\{([^}]*)\}\s+from\s+$/.exec(clause.trim() + ' ');
    const names = braces?.[1]?.split(',').map((name) => name.trim()).filter(Boolean) ?? [];
    const allTypes = names.length > 0 && names.every((name) => name.startsWith('type '));
    refs.push({ specifier, typeOnly: Boolean(match[2]) || allTypes });
  }
  for (const match of text.matchAll(DYNAMIC_IMPORT)) refs.push({ specifier: match[1] ?? '', typeOnly: false });
  return refs;
}

/** Resolves a relative specifier against an overlay-relative importer; null for bare/builtin specifiers. */
export function resolveRelative(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
}

export function isTestSource(file: string): boolean {
  return file.startsWith('tests/') && file.endsWith('.ts');
}
