import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CliDeps } from './cli.ts';
import { git, splitPaths } from './git.ts';

export type RepositoryChange = { cwd: string; paths: string[] };
export type RepositoryCheck = { state: 'unavailable'; reason: string };
export type CheckoutEntryMap = Record<string, string>;
export type CheckoutState = { cwd: string; head: string; entries: CheckoutEntryMap };
export type CheckoutBaseline = { checkouts: CheckoutState[] };
export type CheckoutBaselineFile = CheckoutBaseline | { state: 'unavailable'; reason: string };
export type CheckoutReport = { repositoryChanges?: RepositoryChange[]; repositoryCheck?: RepositoryCheck; asOfSeq?: number };

const UNAVAILABLE = (reason: string): RepositoryCheck => ({ state: 'unavailable', reason });

// Fingerprints stream file contents in bounded chunks: the plan requires an
// uncapped content hash, but the read itself stays proportional to the chunk,
// not the file. Error mapping is unchanged (ENOENT becomes deleted, any other
// error throws).
function hashFileContents(full: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(full, 'r');
  try {
    const chunk = Buffer.alloc(64 * 1024);
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read <= 0) break;
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    try { fs.closeSync(fd); } catch { /* the content hash already settled; a close failure carries no fingerprint */ }
  }
  return hash.digest('hex');
}

// One entry per path keeps the raw porcelain record (modes, index hash, XY state),
// the lstat executable bit (covers untracked and index-flagged files) and a content
// fingerprint (covers a second edit of a dirty path). No size cap applies.
function fingerprintFor(cwd: string, rel: string): { exec: string; fingerprint: string } {
  const full = path.join(cwd, ...rel.split('/'));
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(full);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exec: 'missing', fingerprint: 'deleted' };
    throw error;
  }
  if (stat.isSymbolicLink()) {
    try {
      const target = fs.readlinkSync(full);
      return { exec: 'link', fingerprint: 'symlink:' + target };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exec: 'link', fingerprint: 'deleted' };
      throw error;
    }
  }
  if (stat.isDirectory()) return { exec: 'dir', fingerprint: 'directory' };
  const exec = (stat.mode & 0o111) !== 0 ? 'x' : '-';
  if (!stat.isFile()) return { exec, fingerprint: 'unsupported' };
  let fingerprint: string;
  try {
    fingerprint = hashFileContents(full);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fingerprint = 'deleted';
    else throw error;
  }
  return { exec, fingerprint };
}

function sessionPrefix(cwd: string, sessionDir: string): string | undefined {
  const rel = path.relative(cwd, sessionDir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}

function excludedBySession(relPath: string, prefix: string | undefined): boolean {
  if (!prefix) return false;
  return relPath === prefix || relPath.startsWith(prefix + '/');
}

function parseStatus(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of raw.split('\0')) {
    if (!entry) continue;
    if (entry.startsWith('? ')) {
      out.set(entry.slice(2), entry);
      continue;
    }
    if (entry.startsWith('! ')) continue;
    if (entry.startsWith('1 ')) {
      const parts = entry.split(' ');
      // 1 <XY> <subm> <mH> <mI> <mW> <hH> <hI> <path>
      if (parts.length >= 9) out.set(parts.slice(8).join(' '), entry);
      continue;
    }
    if (entry.startsWith('2 ')) {
      const parts = entry.split(' ');
      if (parts.length >= 10) out.set(parts.slice(9).join(' '), entry);
      continue;
    }
    if (entry.startsWith('u ')) {
      const parts = entry.split(' ');
      if (parts.length >= 11) out.set(parts.slice(10).join(' '), entry);
      continue;
    }
  }
  return out;
}

function parseFlagged(raw: string): Set<string> {
  const out = new Set<string>();
  for (const entry of raw.split('\0')) {
    if (!entry) continue;
    const tag = entry[0];
    if (tag === undefined || entry[1] !== ' ') continue;
    if (tag === tag.toLowerCase() || tag === 'S' || tag === 's') out.add(entry.slice(2));
  }
  return out;
}

function isGitlinkDirty(statusRaw: string, fingerprint: string): boolean {
  if (fingerprint !== 'directory') return false;
  if (!statusRaw.startsWith('1 ')) return false;
  const parts = statusRaw.split(' ');
  // Empirical porcelain v2 shape: clean has no entry; dirty worktree shows
  // subm S.M. (modified), S..U (untracked) or SCM. (commit plus dirty).
  // S prefix alone marks a gitlink; S... (staged, clean worktree) and
  // SC.. (commit changed, clean worktree) are not dirty worktree state.
  const subm = parts[2] ?? '';
  return subm.includes('M') || subm.includes('U');
}

export async function captureCheckouts(
  deps: CliDeps,
  dirs: readonly string[],
  sessionDir: string,
): Promise<CheckoutBaseline> {
  const checkouts: CheckoutState[] = [];
  for (const cwd of dirs) {
    if (!fs.existsSync(cwd)) throw new Error('Absent checkout ' + cwd);
    const headResult = await git(deps, cwd, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
    if (headResult.exit) throw new Error('Cannot resolve HEAD in ' + cwd);
    const head = headResult.stdout.trim();
    const statusResult = await git(deps, cwd, ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '-uall', '--no-renames', '--ignore-submodules=none']);
    if (statusResult.exit) throw new Error('Cannot capture status in ' + cwd);
    const flaggedResult = await git(deps, cwd, ['ls-files', '-v', '-z']);
    if (flaggedResult.exit) throw new Error('Cannot list index flags in ' + cwd);
    const statusMap = parseStatus(statusResult.stdout);
    const flagged = parseFlagged(flaggedResult.stdout);
    const prefix = sessionPrefix(path.resolve(cwd), path.resolve(sessionDir));
    const names = new Set([...statusMap.keys(), ...flagged]);
    // A null-prototype map: a repository-root path named __proto__ must create
    // an entry instead of invoking Object.prototype's setter.
    const entries: CheckoutEntryMap = Object.create(null);
    for (const name of [...names].sort()) {
      if (excludedBySession(name, prefix)) continue;
      const statusRaw = statusMap.get(name) ?? '';
      const { exec, fingerprint } = fingerprintFor(path.resolve(cwd), name);
      entries[name] = statusRaw + ' ' + exec + ' ' + fingerprint;
    }
    checkouts.push({ cwd: path.resolve(cwd), head, entries });
  }
  return { checkouts };
}

function diffEntries(baseline: CheckoutEntryMap, current: CheckoutEntryMap): string[] {
  const changed: string[] = [];
  for (const name of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
    // Own-property reads: a "__proto__" entry must compare its stored value,
    // never Object.prototype on a side that lacks the path.
    const left = Object.hasOwn(baseline, name) ? baseline[name] : undefined;
    const right = Object.hasOwn(current, name) ? current[name] : undefined;
    if (left !== right) changed.push(name);
  }
  return changed.sort();
}

// Stored entries keep trailing ` <exec> <fingerprint>` tokens without spaces, so the
// raw porcelain record is everything before those two tokens.
function splitStored(stored: string | undefined): { raw: string; fingerprint: string } {
  if (stored === undefined) return { raw: '', fingerprint: '' };
  const last = stored.lastIndexOf(' ');
  const fingerprint = last < 0 ? '' : stored.slice(last + 1);
  const rest = last < 0 ? '' : stored.slice(0, last);
  const second = rest.lastIndexOf(' ');
  const raw = second < 0 ? '' : rest.slice(0, second);
  return { raw, fingerprint };
}

export async function compareCheckouts(
  deps: CliDeps,
  baseline: CheckoutBaselineFile,
  dirs: readonly string[],
  sessionDir: string,
): Promise<CheckoutReport> {
  if ((baseline as { state?: string }).state === 'unavailable') {
    const reason = (baseline as { reason?: string }).reason ?? 'checkout capture failed';
    return { repositoryCheck: UNAVAILABLE(reason) };
  }
  const typed = baseline as CheckoutBaseline;
  let current: CheckoutBaseline;
  try {
    current = await captureCheckouts(deps, dirs, sessionDir);
  } catch (error) {
    return { repositoryCheck: UNAVAILABLE(error instanceof Error ? error.message : String(error)) };
  }
  const byCwd = new Map(typed.checkouts.map(checkout => [path.resolve(checkout.cwd), checkout]));
  const repositoryChanges: RepositoryChange[] = [];
  for (const next of current.checkouts) {
    const key = path.resolve(next.cwd);
    const prev = byCwd.get(key);
    if (!prev) continue;
    const paths = new Set<string>();
    // A moved HEAD that leaves the target unchanged still lists its diff, so both
    // sides of a committed rename appear in the report.
    if (prev.head !== next.head) {
      const diff = await git(deps, key, ['diff', '--name-only', '--no-renames', '-z', prev.head, next.head, '--']);
      if (diff.exit) return { repositoryCheck: UNAVAILABLE('Cannot compare ' + key) };
      for (const name of splitPaths(diff.stdout)) paths.add(name);
    }
    // A dirty gitlink in both snapshots keeps the same porcelain record and
    // directory fingerprint, so diffEntries omits it. Check every entry present
    // in both snapshots for dirty worktree in both, including ignore=dirty
    // (captured with --ignore-submodules=none), and report unavailable.
    for (const name of Object.keys(prev.entries)) {
      // Own-property gate: "__proto__" is an inherited member of every plain
      // parsed object, so `in` alone would compare a missing path against
      // Object.prototype instead of skipping it.
      if (!Object.hasOwn(next.entries, name)) continue;
      const prevParts = splitStored(prev.entries[name]);
      const nextParts = splitStored(next.entries[name]);
      if (
        isGitlinkDirty(prevParts.raw, prevParts.fingerprint) &&
        isGitlinkDirty(nextParts.raw, nextParts.fingerprint)
      ) {
        return { repositoryCheck: UNAVAILABLE('Dirty submodule re-edited in ' + key) };
      }
    }
    for (const name of diffEntries(prev.entries, next.entries)) {
      paths.add(name);
    }
    const sorted = [...paths].sort();
    if (sorted.length) repositoryChanges.push({ cwd: key, paths: sorted });
  }
  if (!repositoryChanges.length) return {};
  repositoryChanges.sort((left, right) => (left.cwd < right.cwd ? -1 : left.cwd > right.cwd ? 1 : 0));
  return { repositoryChanges };
}
