/**
 * @file shared.mjs
 * @description Run-directory layout and repo-integrity helpers shared by audit-dispatch-skills scripts.
 *
 * Layout: `.scratch/audits/<run>-audit.md` is the only file that outlives the run;
 * every working file lives under `.scratch/audits/<run>-work/` until `finalize.mjs` relocates it.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// SECTION: Configuration
// ============================================================================

const AUDIT_PREFIX = '.scratch/audits/';
const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{4}$/;
const REPORT_OR_WORK_PATTERN = /(\d{4}-\d{2}-\d{2}-\d{4})-(?:audit\.md|work)$/;

// ============================================================================
// SECTION: Run Paths
// ============================================================================

/** @returns {string} Absolute repository root. */
export function resolveRepoRoot() {
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error('Run from inside the dispatch-skills repository.');
  return path.resolve(res.stdout.trim());
}

/** @param {string} value @returns {string} Path using forward slashes. */
export function toPosix(value) {
  return value.split(path.sep).join('/');
}

/** @param {string} root @returns {(value: string) => string} Repo-relative path formatter. */
export function relTo(root) {
  return (value) => toPosix(path.relative(root, value));
}

/**
 * Reads `--run <yyyy-mm-dd-hhmm>` and derives the run's two paths: the report that outlives the
 * run and the work directory beside it. A run id, not a directory, so both live flat in
 * `.scratch/audits/` and the report needs no nesting to be found.
 *
 * @param {string} root
 * @param {string[]} argv
 * @returns {{runId: string, reportPath: string, workDir: string, rel: (value: string) => string}}
 */
export function resolveRunDirs(root, argv) {
  const index = argv.indexOf('--run');
  const value = index === -1 ? null : argv[index + 1];
  if (!value) throw new Error('Missing --run <yyyy-mm-dd-hhmm>');
  // A bare id keeps callers off path separators; a full report path is accepted for convenience.
  const runId = RUN_ID_PATTERN.test(value) ? value : REPORT_OR_WORK_PATTERN.exec(toPosix(value))?.[1];
  if (!runId) throw new Error(`--run must be a run id like 2026-09-11-1853 (got ${value})`);
  const auditsDir = path.join(root, ...AUDIT_PREFIX.split('/').filter(Boolean));
  return {
    runId,
    reportPath: path.join(auditsDir, `${runId}-audit.md`),
    workDir: path.join(auditsDir, `${runId}-work`),
    rel: relTo(root),
  };
}

// ============================================================================
// SECTION: Markdown Frontmatter
// ============================================================================

/**
 * Parses a frontmatter `description:` field as either a single-line scalar or a YAML
 * folded/literal block (`>`, `|`, `>-`, `|-`). Folded lines join with a space (YAML folding
 * semantics), literal lines join with a newline; either way, each continuation line's leading
 * indentation is stripped before joining, and surrounding quotes on a scalar value are stripped.
 * Handles only what a `description:` field in this repo's skill frontmatter actually uses — not
 * a general YAML parser.
 *
 * @param {string} text - Full file text (or just the frontmatter block).
 * @returns {string}
 */
export function frontmatterDescription(text) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? text;
  const lines = frontmatter.split(/\r?\n/);
  const startIndex = lines.findIndex((l) => /^description:/.test(l));
  if (startIndex === -1) return '';

  const inlineValue = lines[startIndex].replace(/^description:\s*/, '');
  const blockMatch = /^([>|][+-]?)\s*$/.exec(inlineValue);
  if (!blockMatch) {
    return inlineValue.trim().replace(/^["']|["']$/g, '');
  }

  const isFolded = blockMatch[1].startsWith('>');
  const continuation = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      if (isFolded) continue;
      continuation.push('');
      continue;
    }
    if (!/^\s/.test(line)) break; // Dedented line ends the block.
    continuation.push(line.replace(/^\s+/, ''));
  }

  return continuation.join(isFolded ? ' ' : '\n').trim();
}

// ============================================================================
// SECTION: Git Status Snapshots
// ============================================================================

/**
 * `git status --porcelain` with every untracked file listed individually (a collapsed `?? dir/`
 * would hide new files beside audit output) and audit output removed.
 */
export function auditGitStatus(root) {
  const res = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
  if (res.status !== 0) return null;
  return filterAuditStatus(res.stdout);
}

/**
 * Drops blank lines and audit-output entries from `git status --porcelain` stdout; sorted output.
 * Audit output is excluded because `.scratch/` is tracked-visible, so the audit's own writes would
 * otherwise read as repo changes.
 * The two-char status column is fixed-width (` M`, `??`), so lines are sliced untrimmed; a rename
 * (`R  old -> new`) is judged by its destination, and C-quoted paths lose both quotes.
 */
export function filterAuditStatus(stdout) {
  return stdout
    .split('\n')
    .filter((line) => {
      if (!line.trim()) return false;
      const entryPath = line.slice(3).split(' -> ').pop().replace(/^"|"$/g, '');
      return !entryPath.startsWith(AUDIT_PREFIX);
    })
    .sort()
    .join('\n');
}

/** Lines present in only one of two snapshots, prefixed `+` (appeared) or `-` (disappeared). */
export function diffStatus(before, after) {
  const a = new Set(before.split('\n').filter(Boolean));
  const b = new Set(after.split('\n').filter(Boolean));
  return [...[...b].filter((l) => !a.has(l)).map((l) => `+ ${l}`), ...[...a].filter((l) => !b.has(l)).map((l) => `- ${l}`)];
}

// ============================================================================
// SECTION: Content Snapshots
// ============================================================================

// Ignored local configs can hold user settings an audit must not alter; they are hashed, never copied.
const PROTECTED_IGNORED = [':(glob)**/config.local.*', ':(glob)**/config.jsonc'];

function gitPaths(root, args) {
  const res = spawnSync('git', ['ls-files', '-z', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) return null;
  return res.stdout.split('\0').filter(Boolean);
}

/**
 * Content fingerprints for tracked, nonignored untracked, and protected ignored local-config
 * files. Status alone misses an edit to an already-dirty file, so each path carries a hash.
 * Symlinks are fingerprinted by their target string, never followed, so an external target is
 * neither read nor attributed to the repo. Only this run's own outputs are excluded; contents are
 * never recorded. A path that exists but cannot be read is `unreadable` and named in `gaps`, since
 * an equal marker in two snapshots proves nothing about its content.
 *
 * @param {string} root
 * @param {{exclude?: string[], fs?: Pick<typeof fs, 'lstatSync' | 'readlinkSync' | 'readFileSync'>}} [options]
 *   Repo-relative paths (files or directories) owned by this run; `fs` replaces the filesystem in tests.
 * @returns {{version: 1, entries: Record<string, string>, exclusions: string[], gaps: string[]}}
 */
export function contentSnapshot(root, options = {}) {
  const io = options.fs ?? fs;
  const exclusions = (options.exclude ?? []).map(toPosix);
  const gaps = [];
  const listed = gitPaths(root, ['--cached', '--others', '--exclude-standard']);
  const ignored = gitPaths(root, ['--others', '--ignored', '--exclude-standard', '--', ...PROTECTED_IGNORED]);
  if (listed === null) gaps.push('git ls-files failed; tracked and untracked content not fingerprinted');
  if (ignored === null) gaps.push('git ls-files failed; ignored local configs not fingerprinted');
  const excluded = (p) => exclusions.some((e) => p === e || p.startsWith(`${e}/`));
  const hash = (data) => createHash('sha256').update(data).digest('hex');
  const entries = {};
  for (const rel of [...new Set([...(listed ?? []), ...(ignored ?? [])])].sort()) {
    if (excluded(rel)) continue;
    const full = path.join(root, rel);
    try {
      const stat = io.lstatSync(full);
      entries[rel] = stat.isSymbolicLink() ? `symlink:${hash(io.readlinkSync(full))}` : `sha256:${hash(io.readFileSync(full))}`;
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
        entries[rel] = 'missing';
      } else {
        entries[rel] = 'unreadable';
        gaps.push(`${rel} unreadable (${err?.code ?? err?.message ?? String(err)}); its content is not compared`);
      }
    }
  }
  return { version: 1, entries, exclusions, gaps };
}

/** `~` changed content, `+` appeared, `-` disappeared, comparing two `contentSnapshot` results. */
export function diffContent(before, after) {
  const lines = [];
  for (const [p, hash] of Object.entries(after.entries)) {
    if (!(p in before.entries)) lines.push(`+ ${p}`);
    else if (before.entries[p] !== hash) lines.push(`~ ${p}`);
  }
  for (const p of Object.keys(before.entries)) if (!(p in after.entries)) lines.push(`- ${p}`);
  return lines.sort((a, b) => a.slice(2).localeCompare(b.slice(2)));
}
