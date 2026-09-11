/**
 * @file shared.mjs
 * @description Run-directory layout and repo-integrity helpers shared by audit-dispatch-skills scripts.
 *
 * Layout: `.scratch/audit-dispatch-skills/<run>/report.md` is the only file that outlives the run;
 * every working file lives under `.scratch/audit-dispatch-skills/<run>/work/` until `finalize.mjs` relocates it.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Audit output is excluded from integrity snapshots: `.scratch/` is tracked-visible, and the
// audit's own writes would otherwise read as repo changes.
const AUDIT_PREFIX = '.scratch/audit-dispatch-skills/';

export function resolveRepoRoot() {
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error('Run from inside the dispatch-skills repository.');
  return path.resolve(res.stdout.trim());
}

/** Reads `--run <dir>` and returns the run, work, and repo-relative forward-slash paths. */
export function resolveRunDirs(root, argv) {
  const index = argv.indexOf('--run');
  const value = index === -1 ? null : argv[index + 1];
  if (!value) throw new Error(`Missing --run ${AUDIT_PREFIX}<yyyy-mm-dd-hhmm>`);
  const runDir = path.resolve(root, value);
  const rel = (p) => path.relative(root, p).split(path.sep).join('/');
  if (!rel(runDir).startsWith(AUDIT_PREFIX)) {
    throw new Error(`--run must be under ${AUDIT_PREFIX} (got ${value})`);
  }
  return { runDir, workDir: path.join(runDir, 'work'), rel };
}

/**
 * `git status --porcelain` with every untracked file listed individually (a collapsed `?? dir/`
 * would hide new files beside audit output) and audit output removed.
 */
export function auditGitStatus(root) {
  const res = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
  if (res.status !== 0) return null;
  return res.stdout
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      const entryPath = trimmed.slice(3).replace(/^"/, '');
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
