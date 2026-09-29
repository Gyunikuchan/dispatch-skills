// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { snapshotContent } from '../lib/git-state.mjs';
import { sessionDir } from '../lib/session-temp.mjs';
import { stateDir } from '../lib/session-paths.mjs';
import { DriverError } from './actions.mjs';
import { relative } from './implement-state.mjs';

// SECTION: File content and diffs
// Every tree-discarding operation lives here: a discard first saves a patch, and a user revert also
// carries the user's approval, so no work is lost silently.

/** HEAD content of a repository path, or null when HEAD lacks it. */
export function headContent(repoRoot, file) {
  const shown = spawnSync('git', ['-C', repoRoot, 'show', `HEAD:${file}`], { maxBuffer: 1 << 30 });
  return shown.status === 0 ? shown.stdout : null;
}
/** Content a path had at task start: its task-start blob, else HEAD, else null (absent). */
export function startContent(state, file) {
  const entry = state.ordinary.preEntries?.find(item => item.path === file);
  if (entry) return entry.mode === 'absent' ? null : snapshotContent(state.repoRoot, entry);
  return headContent(state.repoRoot, file);
}
const worktree = (state, file) => {
  const absolute = path.join(state.repoRoot, file);
  return fs.existsSync(absolute) && fs.statSync(absolute).isFile() ? fs.readFileSync(absolute) : null;
};
/**
 * Runs `git diff --no-index` for one path from `before` to its worktree content in a scratch copy,
 * so headers read `a/<path> b/<path>`; git exits 1 when the sides differ.
 * @param {any} state
 * @param {string} file
 * @param {Buffer|null} before
 * @param {string[]} args
 */
function diffOne(state, file, before, args) {
  const after = worktree(state, file);
  if (before === null && after === null) return '';
  fs.mkdirSync(path.join(stateDir(), 'scratch'), { recursive: true });
  const scratch = fs.mkdtempSync(path.join(stateDir(), 'scratch', 'diff-'));
  try {
    const side = (prefix, content) => {
      if (content === null) return '/dev/null';
      const target = path.join(scratch, prefix, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      return path.posix.join(prefix, file);
    };
    const run = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=off', 'diff', '--no-index', '--no-prefix', ...args, side('a', before), side('b', after)], { cwd: scratch, encoding: 'utf8', maxBuffer: 1 << 30 });
    if (run.status !== 0 && run.status !== 1) throw new Error(`git diff failed for ${file}: ${(run.stderr || String(run.error ?? '')).trim()}`);
    return run.stdout;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
/** Changed lines of one path since `before`; null for a binary change, which callers treat as over budget. */
export function changedLines(state, file, before) {
  const row = diffOne(state, file, before, ['--numstat']).split('\n')[0] ?? '';
  const [added, removed] = row.split('\t');
  // numstat reports `-` for binaries, which have no line count.
  if (added === '-') return null;
  return (Number(added) || 0) + (Number(removed) || 0);
}

// SECTION: Patch before discard

/**
 * Saves `<session>/reverts/<runId>-<seq>.patch` holding each path's change since task start;
 * binaries are also copied beside it. Throws DriverError('reply') when the patch cannot be written.
 * @param {any} state
 * @param {string[]} paths
 * @param {string} reason
 */
export function savePatch(state, paths, reason) {
  const runId = state.ledgerRunId ?? state.runId;
  try {
    const dir = path.join(sessionDir(), 'reverts');
    fs.mkdirSync(dir, { recursive: true });
    const taken = fs.readdirSync(dir).map(name => (name.startsWith(`${runId}-`) && name.endsWith('.patch') ? Number(name.slice(runId.length + 1, -6)) : 0));
    const base = path.join(dir, `${runId}-${Math.max(0, ...taken.filter(Number.isSafeInteger)) + 1}`);
    const parts = [`# ${reason.replace(/\s+/g, ' ')}\n`];
    for (const file of paths) {
      parts.push(diffOne(state, file, startContent(state, file), ['--binary']));
      const after = worktree(state, file);
      if (after?.includes(0)) {
        const copy = path.join(`${base}.files`, file);
        fs.mkdirSync(path.dirname(copy), { recursive: true });
        fs.writeFileSync(copy, after);
      }
    }
    fs.writeFileSync(`${base}.patch`, parts.join(''));
    return relative(state, `${base}.patch`);
  } catch (error) {
    throw new DriverError('reply', `Patch save failed: ${error.message}; nothing discarded.`);
  }
}
/** A revert is the user's call: `{by, quote}` names who approved and their chat wording. */
const headMode = (repoRoot, file) => spawnSync('git', ['-C', repoRoot, 'ls-tree', 'HEAD', '--', file], { encoding: 'utf8' }).stdout?.split(' ')[0] || null;
export function requireUserApproval(userApproved, key) {
  if (!userApproved || typeof userApproved.by !== 'string' || !userApproved.by.trim() || typeof userApproved.quote !== 'string' || !userApproved.quote.trim()) {
    throw new DriverError('reply', `${key} revert requires userApproved: {by, quote} carrying the user's explicit approval from chat; revert is a last resort.`);
  }
}
/**
 * Restores `paths` to task-start content after saving a patch; returns the patch path.
 * @param {any} state
 * @param {string[]} paths
 * @param {{ userApproved: any, reason: string, key: string }} options
 */
export function discardPaths(state, paths, { userApproved, reason, key }) {
  requireUserApproval(userApproved, key);
  // Out-of-scope paths have no pre-attempt entry; HEAD carries their mode.
  const modes = new Map(paths.map(file => [file, state.ordinary.preEntries?.find(item => item.path === file)?.mode ?? headMode(state.repoRoot, file)]));
  const gitlinks = paths.filter(file => modes.get(file) === '160000');
  if (gitlinks.length) throw new DriverError('reply', `${key} cannot restore submodule paths: ${gitlinks.join(', ')}; attribute them manually.`);
  const patch = savePatch(state, paths, `${key}: ${reason}`);
  for (const file of paths) {
    const before = startContent(state, file), absolute = path.join(state.repoRoot, file), mode = modes.get(file);
    // Remove first so a substituted symlink is replaced, never followed out of the repository.
    fs.rmSync(absolute, { force: true });
    if (before === null) continue;
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    if (mode === '120000') { fs.symlinkSync(before.toString('utf8'), absolute); continue; }
    fs.writeFileSync(absolute, before);
    if (mode) fs.chmodSync(absolute, mode === '100755' ? 0o755 : 0o644);
  }
  const data = state.ordinary;
  data.retained ??= [];
  data.retained.push({ path: patch, reason: `Discarded ${paths.join(', ')} (${key}; approved by ${userApproved.by.trim()})` });
  return patch;
}
