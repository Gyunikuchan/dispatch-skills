import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CliDeps } from './cli.ts';
import type { RepositoryChange, RepositoryCheckState } from './findings.ts';
import { atomic } from './fanout/state.ts';
import { git, splitPaths } from './git.ts';
import { foldLedger } from './ledger.ts';
import { launches } from './writers.ts';

type CheckoutEntryMap = Record<string, string>;
type CheckoutState = { cwd: string; head: string; entries: CheckoutEntryMap };
type CheckoutBaseline = { checkouts: CheckoutState[] };
export type CheckoutBaselineFile = CheckoutBaseline | { state: 'unavailable'; reason: string };
type CheckoutReport = { repositoryChanges?: RepositoryChange[]; repositoryCheck?: RepositoryCheckState; asOfSeq?: number };

const UNAVAILABLE = (reason: string): RepositoryCheckState => ({ state: 'unavailable', reason });

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

// Compared directories are the round cwd, the repository root and, for a task
// review, the launch worktree path resolved against the session, without duplicates.
function comparedDirs(session: string, repositoryRoot: string, cwd: string, taskWorktree?: string): string[] {
  const dirs = [path.resolve(cwd), path.resolve(repositoryRoot)];
  if (taskWorktree) dirs.push(path.resolve(session, taskWorktree));
  return [...new Set(dirs)];
}

function baselineFileFor(dir: string, generation: number): string {
  return path.join(dir, 'gen-' + generation, 'checkout-baseline.json');
}

function checkoutReportFileFor(dir: string, generation: number): string {
  return path.join(dir, 'gen-' + generation, 'checkout-report.json');
}

// Retries never overwrite an unacknowledged report: the first write of a
// generation lands in checkout-report.json and every later write in the next
// free checkout-report-<k>.json, so a restored path or a clean comparison
// cannot erase an earlier report before a closing note exists.
function checkoutReportAttemptFor(dir: string, generation: number): string {
  const canonical = checkoutReportFileFor(dir, generation);
  if (!fs.existsSync(canonical)) return canonical;
  let attempt = 2;
  while (fs.existsSync(path.join(dir, 'gen-' + generation, 'checkout-report-' + attempt + '.json'))) attempt++;
  return path.join(dir, 'gen-' + generation, 'checkout-report-' + attempt + '.json');
}

export function writeCheckoutReport(dir: string, generation: number, checkout: CheckoutReport): void {
  fs.mkdirSync(path.join(dir, 'gen-' + generation), {recursive: true});
  atomic(checkoutReportAttemptFor(dir, generation), checkout);
}

// Durable per-generation evidence that a native voice launched, covering
// every native descriptor (native-first, native-only, reserve substitutes).
// fanout.json carries it; only nativeFirst selects the wave path.
export function generationLaunchedNative(dir: string, generation: number): boolean {
  try {
    const fanout = JSON.parse(fs.readFileSync(path.join(dir, 'gen-' + generation, 'fanout.json'), 'utf8')) as {nativeFirst?: true; nativeLaunched?: true};
    return fanout.nativeFirst === true || fanout.nativeLaunched === true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

function taskWorktreeOf(session: string, task: string): string | undefined {
  try {
    const fold = foldLedger(session);
    const launch = launches(fold, task).findLast(launch => launch.finished);
    return launch?.finished ? launch.record.data['path'] as string : undefined;
  } catch {
    return undefined;
  }
}

export function comparedDirsFor(
  session: string,
  repositoryRoot: string,
  cwd: string,
  taskTarget: boolean,
  requested: string,
): { dirs: string[]; absentWorktree: boolean } {
  const worktree = taskTarget ? taskWorktreeOf(session, requested) : undefined;
  const dirs = comparedDirs(session, repositoryRoot, cwd, worktree);
  const absentWorktree = !!worktree && !fs.existsSync(path.resolve(session, worktree));
  return { dirs, absentWorktree };
}

export async function writeBaselineIfMissing(
  dir: string,
  generation: number,
  dirs: readonly string[],
  sessionDir: string,
  deps: CliDeps,
): Promise<void> {
  const file = baselineFileFor(dir, generation);
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.join(dir, 'gen-' + generation), {recursive: true});
  try {
    const baseline = await captureCheckouts(deps, dirs, sessionDir);
    atomic(file, baseline);
  } catch (error) {
    atomic(file, {state: 'unavailable', reason: error instanceof Error ? error.message : String(error)});
  }
}

export async function compareForRound(
  dir: string,
  generation: number,
  dirs: readonly string[],
  sessionDir: string,
  absentWorktree: boolean,
  deps: CliDeps,
): Promise<CheckoutReport> {
  // A round with no native voice runs no check: no baseline file means no Git
  // commands without a launch flag. A missing baseline after a native launch
  // means the capture was lost; an unreadable or malformed one cannot be
  // trusted. Both report unavailable instead of silently skipping or failing
  // recovery, so the round keeps its replies.
  const file = baselineFileFor(dir, generation);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {repositoryCheck: {state: 'unavailable', reason: 'checkout baseline unreadable: ' + (error instanceof Error ? error.message : String(error))}};
    }
    if (!generationLaunchedNative(dir, generation)) return {};
    return {repositoryCheck: {state: 'unavailable', reason: 'checkout baseline missing after native launch'}};
  }
  let baseline: CheckoutBaselineFile;
  try {
    baseline = JSON.parse(raw) as CheckoutBaselineFile;
  } catch (error) {
    return {repositoryCheck: {state: 'unavailable', reason: 'checkout baseline malformed: ' + (error instanceof Error ? error.message : String(error))}};
  }
  // A corrupted baseline (JSON null or another non-object, or an object
  // without checkouts) cannot be compared; report unavailable instead of
  // throwing past the recovery contract.
  if (baseline === null || typeof baseline !== 'object' || Array.isArray(baseline)) {
    return {repositoryCheck: {state: 'unavailable', reason: 'checkout baseline malformed: expected a checkout baseline object'}};
  }
  if ((baseline as {state?: string}).state === 'unavailable') {
    return {repositoryCheck: {state: 'unavailable', reason: (baseline as {reason?: string}).reason ?? 'checkout capture failed'}};
  }
  if (!Array.isArray((baseline as {checkouts?: unknown}).checkouts)) {
    return {repositoryCheck: {state: 'unavailable', reason: 'checkout baseline malformed: expected a checkouts array'}};
  }
  if (absentWorktree) return {repositoryCheck: {state: 'unavailable', reason: 'Absent task worktree'}};
  try {
    return await compareCheckouts(deps, baseline, dirs, sessionDir);
  } catch (error) {
    return {repositoryCheck: {state: 'unavailable', reason: error instanceof Error ? error.message : String(error)}};
  }
}

export function carryCheckoutBaseline(dir: string, previousGeneration: number): void {
  // Carry the baseline before publishing the new generation, so a crash
  // cannot lose a change made before target movement. The copy publishes
  // atomically (temp + rename, never the final path directly), and an
  // existing destination is only kept when it parses. A predecessor that
  // wrote no baseline and launched no native voice leaves the next
  // generation without one, so a CLI-only superseded round runs no check;
  // only a source that exists but cannot be read or copied becomes a
  // durable unavailable marker. A launched predecessor with a missing
  // baseline lost its required capture and carries unavailable instead.
  const previousBaseline = baselineFileFor(dir, previousGeneration);
  const nextBaseline = baselineFileFor(dir, previousGeneration + 1);
  try {
    fs.mkdirSync(path.join(dir, 'gen-' + (previousGeneration + 1)), {recursive: true});
    const nextValid = (() => {
      try {
        JSON.parse(fs.readFileSync(nextBaseline, 'utf8'));
        return true;
      } catch {
        return false;
      }
    })();
    if (!nextValid) {
      let previousRaw: string | undefined;
      try {
        previousRaw = fs.readFileSync(previousBaseline, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // Absent predecessor baseline with no launched native voice:
          // no native voice ran there. A launched predecessor lost its
          // required capture, so the next generation carries an
          // unavailable marker instead of a fresh capture.
          if (generationLaunchedNative(dir, previousGeneration)) {
            atomic(nextBaseline, {state: 'unavailable', reason: 'checkout baseline missing after native launch in generation ' + previousGeneration});
          }
        } else {
          atomic(nextBaseline, {state: 'unavailable', reason: 'baseline carry-over failed: ' + (error instanceof Error ? error.message : String(error))});
        }
      }
      if (previousRaw !== undefined) {
        try {
          atomic(nextBaseline, JSON.parse(previousRaw) as CheckoutBaselineFile);
        } catch (error) {
          atomic(nextBaseline, {state: 'unavailable', reason: 'baseline carry-over failed: ' + (error instanceof Error ? error.message : String(error))});
        }
      }
    }
  } catch (error) {
    try {
      fs.mkdirSync(path.join(dir, 'gen-' + (previousGeneration + 1)), {recursive: true});
      if (!fs.existsSync(nextBaseline)) atomic(nextBaseline, {state: 'unavailable', reason: 'baseline carry-over failed: ' + (error instanceof Error ? error.message : String(error))});
    } catch {
      // mkdir failed; start still publishes, compare reports unavailable via missing baseline handling.
    }
  }
}
