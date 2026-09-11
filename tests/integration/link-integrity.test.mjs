import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Scans this repo's authored markdown for relative links that resolve to nothing —
 * a missing file/directory, or an `#anchor` that names no heading in the target
 * (or current) file. `http(s):`/`mailto:` links and anything inside fenced code
 * blocks are skipped (code fences routinely show example/placeholder link syntax
 * that isn't meant to resolve).
 */

const SCAN_FILES = [
  path.join(REPO_ROOT, 'README.md'),
  path.join(REPO_ROOT, '.agents', 'AGENTS.md'),
];

// `skills/**/*.md` and `.agents/skills/audit-dispatch-skills/**/*.md`
function walkMarkdown(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkMarkdown(full);
    return entry.name.endsWith('.md') ? [full] : [];
  });
}

SCAN_FILES.push(...walkMarkdown(path.join(REPO_ROOT, 'skills')));
SCAN_FILES.push(...walkMarkdown(path.join(REPO_ROOT, '.agents', 'skills', 'audit-dispatch-skills')));

/** GitHub-style heading slugs for a markdown file. */
function headingSlugs(file) {
  const slugs = new Set();
  for (const [, heading] of readFileSync(file, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)) {
    slugs.add(
      heading
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s/g, '-'),
    );
  }
  return slugs;
}

/** Every relative link in `file` outside fenced code blocks, as `{ file, line, target, reason }` problems. */
function brokenLinks(file) {
  const problems = [];
  let inFence = false;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    for (const [, target] of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue; // http(s):, mailto:, etc.
      const [targetPath, anchor] = target.split('#');

      if (!targetPath) {
        // Same-file #anchor link.
        if (anchor && file.endsWith('.md') && !headingSlugs(file).has(anchor)) {
          problems.push({ line: i + 1, target, reason: 'missing anchor' });
        }
        continue;
      }

      const resolved = path.resolve(path.dirname(file), decodeURIComponent(targetPath));
      if (!existsSync(resolved)) {
        problems.push({ line: i + 1, target, reason: 'missing file or directory' });
        continue;
      }
      if (anchor && resolved.endsWith('.md') && statSync(resolved).isFile() && !headingSlugs(resolved).has(anchor)) {
        problems.push({ line: i + 1, target, reason: 'missing anchor' });
      }
    }
  });
  return problems.map((p) => ({ file, ...p }));
}

describe('link integrity guard (authored markdown)', () => {
  it('resolves every relative link and anchor in authored markdown', () => {
    const offenders = SCAN_FILES.filter((f) => existsSync(f)).flatMap((file) =>
      brokenLinks(file).map((p) => `${path.relative(REPO_ROOT, p.file).split(path.sep).join('/')}:L${p.line} → ${p.target} (${p.reason})`),
    );
    assert.deepEqual(offenders, []);
  });
});
