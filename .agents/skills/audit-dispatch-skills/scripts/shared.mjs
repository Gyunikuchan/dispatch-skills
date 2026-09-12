/**
 * @file shared.mjs
 * @description Run-directory layout and repo-integrity helpers shared by audit-dispatch-skills scripts.
 *
 * Layout: `.scratch/audits/<run>-audit.md` is the only file that outlives the run;
 * every working file lives under `.scratch/audits/<run>-work/` until `finalize.mjs` relocates it.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Audit output is excluded from integrity snapshots: `.scratch/` is tracked-visible, and the
// audit's own writes would otherwise read as repo changes.
const AUDIT_PREFIX = '.scratch/audits/';
const RUN_ID = /^\d{4}-\d{2}-\d{2}-\d{4}$/;

export function resolveRepoRoot() {
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error('Run from inside the dispatch-skills repository.');
  return path.resolve(res.stdout.trim());
}

/** Converts platform path separators to forward slashes. */
export function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** Binds `root` and returns a `(p) => string` that resolves a repo-relative forward-slash path. */
export function relTo(root) {
  return (p) => toPosix(path.relative(root, p));
}

/**
 * Reads `--run <yyyy-mm-dd-hhmm>` and derives the run's two paths: the report that outlives the
 * run and the work directory beside it. A run id, not a directory, so both live flat in
 * `.scratch/audits/` and the report needs no nesting to be found.
 */
export function resolveRunDirs(root, argv) {
  const index = argv.indexOf('--run');
  const value = index === -1 ? null : argv[index + 1];
  if (!value) throw new Error('Missing --run <yyyy-mm-dd-hhmm>');
  // A bare id keeps callers off path separators; a full report path is accepted for convenience.
  const runId = RUN_ID.test(value) ? value : /(\d{4}-\d{2}-\d{2}-\d{4})-(?:audit\.md|work)$/.exec(toPosix(value))?.[1];
  if (!runId) throw new Error(`--run must be a run id like 2026-09-11-1853 (got ${value})`);
  const auditsDir = path.join(root, ...AUDIT_PREFIX.split('/').filter(Boolean));
  return {
    runId,
    reportPath: path.join(auditsDir, `${runId}-audit.md`),
    workDir: path.join(auditsDir, `${runId}-work`),
    rel: relTo(root),
  };
}

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
