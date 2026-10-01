// The single git module of the effects layer (ADR 0002 §2, ADR 0006). Caching rules: a successful toplevel lookup
// is cached per instance (a work-tree root cannot move within a process; a failure may become a repo later); index
// entries are cached by the SHA-256 of the index file's bytes (any index write changes the key); working-tree
// reads are never cached.

import crypto from 'node:crypto';
import type { GitPort } from '../core/types.ts';

export type TreeFingerprint = { head: string | null; index: string; worktree: string };
export type PathDiff = { paths: string[] };

export type ReviewSnapshot = { governedPaths?: string[]; head: string; target: string; comparison: string; index: Record<string, string>; working: Record<string, string | null>; untracked: Record<string, string | null> };
export type ReviewDelta = { staged: string[]; unstaged: string[]; untracked: string[]; deleted: string[]; paths: string[] };

export type Git = {
  reviewSnapshot?(cwd: string, target: string, paths?: readonly string[]): Promise<ReviewSnapshot>;
  reviewDelta?(cwd: string, prior: ReviewSnapshot, current?: ReviewSnapshot): Promise<ReviewDelta>;
  ancestor?(cwd: string, baseline: string): Promise<boolean>;
  baselineDiff?(cwd: string, baseline: string): Promise<string[]>;
  recoveryFiles?(cwd: string): Promise<{ files: string[]; dirty: string[]; ignored: string[]; stash: string; gitDir: string }>;
  toplevel(cwd: string): Promise<string>;
  /** `git ls-files --stage` output, cached by index content hash. */
  indexEntries(cwd: string): Promise<string>;
  /** Changed paths for a range (`a..b`, a commit) or, when empty, the working tree against HEAD plus untracked. */
  diffNames(cwd: string, range: string): Promise<string[]>;
  fingerprint(cwd: string): Promise<TreeFingerprint>;
  /** Paths changed since a fingerprint's HEAD (tracked and untracked). */
  changedSince(cwd: string, since: TreeFingerprint | null): Promise<string[]>;
  /** Formatted commit log (%s%n%b) for a range, or empty string on failure or option-like range. */
  log?(cwd: string, range: string): Promise<string>;
};

/** Reads the index file's bytes; null when git is redirected or the work tree is linked (read uncached). */
export type ReadIndex = (toplevel: string) => string | null;

const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');
export const isCommitHash = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const reviewOwned = (file: string): boolean => !/^\.scratch\/(?:dispatch-skills|audits)\/|(?:^|\/)\.state\//.test(file);
const lines = (text: string): string[] => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

export function createGit(port: GitPort, readIndex: ReadIndex = () => null): Git {
  const toplevels = new Map<string, string>();
  const indexCache = new Map<string, string>();

  const git: Git = {
    async reviewSnapshot(cwd, target, paths) {
      if (target.trim().startsWith('-')) throw new Error('review comparison must be a revision');
      const root = await git.toplevel(cwd);
      const listed = async (args: string[]) => (await port.run(args, root)).split('\0').filter(Boolean);
      const head = (await port.run(['rev-parse', 'HEAD'], root)).trim();
      const comparison = target ? (await port.run(['rev-parse', '--revs-only', target], root)).trim() : head;
      const allowed = paths ? new Set(paths) : null;
      const owned = (file: string) => reviewOwned(file) && (!allowed || allowed.has(file));
      const index: Record<string, string> = {};
      for (const entry of await listed(['ls-files', '--stage', '-z'])) {
        const at = entry.indexOf('\t');
        if (at >= 0 && owned(entry.slice(at + 1))) index[entry.slice(at + 1)] = entry.slice(0, at);
      }
      const tracked = await listed(['ls-files', '-z']);
      const other = await listed(['ls-files', '--others', '--exclude-standard', '-z']);
      const deleted = new Set(await listed(['diff', '--name-only', '--diff-filter=D', '-z', '--']));
      const hash = async (file: string): Promise<string | null> => {
        if (deleted.has(file)) return null;
        if (port.fileContent) {
          const value = port.fileContent(file, root);
          if (value === null) return null;
          if (Buffer.byteLength(value) > 8 * 1024 * 1024) throw new Error(`review snapshot file exceeds 8 MiB: ${file}`);
          return sha256(value);
        }
        return port.run(['hash-object', '--', file], root).then((s) => s.trim()).catch(() => null);
      };
      const manifest = async (files: string[]) => {
        const out: Record<string, string | null> = {};
        for (const file of [...new Set(files)].filter(owned).sort()) out[file] = await hash(file);
        return out;
      };
      return { ...(paths ? { governedPaths: [...new Set(paths)].filter(reviewOwned).sort() } : {}), head, target, comparison, index, working: await manifest(tracked), untracked: await manifest(other) };
    },
    async reviewDelta(cwd, prior, captured) {
      const current = captured ?? await git.reviewSnapshot!(cwd, prior.target, prior.governedPaths);
      if (current.head !== prior.head || current.comparison !== prior.comparison) throw new Error('review-round-binding-drift: HEAD or comparison changed');
      const changed = (a: Record<string, unknown>, b: Record<string, unknown>) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((file) => a[file] !== b[file]).sort();
      const staged = changed(prior.index, current.index);
      const unstaged = changed(prior.working, current.working);
      const untracked = changed(prior.untracked, current.untracked);
      const paths = [...new Set([...staged, ...unstaged, ...untracked])].sort();
      const deleted = paths.filter((file) => current.working[file] == null && current.untracked[file] == null);
      return { staged, unstaged, untracked, deleted, paths };
    },
    async ancestor(cwd, baseline) {
      if (!isCommitHash(baseline)) throw new Error('Integration baseline must be a concrete commit hash.');
      const root = await git.toplevel(cwd);
      try { await port.run(['merge-base', '--is-ancestor', baseline, 'HEAD'], root); return true; } catch { return false; }
    },
    async baselineDiff(cwd, baseline) {
      if (!isCommitHash(baseline)) throw new Error('Integration baseline must be a concrete commit hash.');
      const root = await git.toplevel(cwd);
      const tracked = (await port.run(['diff', '--name-only', '-z', baseline, '--'], root)).split('\0').filter(Boolean);
      const untracked = (await port.run(['ls-files', '--others', '--exclude-standard', '-z'], root)).split('\0').filter(Boolean);
      return [...new Set([...tracked, ...untracked])].sort();
    },
    async recoveryFiles(cwd) {
      const root = await git.toplevel(cwd);
      const listed = async (args: string[]) => (await port.run(args, root)).split('\0').filter(Boolean);
      return {
        files: [...new Set([...await listed(['ls-files', '-z']), ...await listed(['ls-files', '--others', '--exclude-standard', '-z'])])].sort(),
        dirty: await git.diffNames(root, ''), ignored: await listed(['ls-files', '--others', '--ignored', '--exclude-standard', '-z']),
        stash: await port.run(['rev-parse', '--verify', 'refs/stash'], root).then((s) => s.trim()).catch(() => ''),
        gitDir: (await port.run(['rev-parse', '--absolute-git-dir'], root)).trim(),
      };
    },
    async toplevel(cwd) {
      const cached = toplevels.get(cwd);
      if (cached !== undefined) return cached;
      const root = (await port.run(['rev-parse', '--show-toplevel'], cwd)).trim();
      toplevels.set(cwd, root);
      return root;
    },
    async indexEntries(cwd) {
      const root = await git.toplevel(cwd);
      const bytes = readIndex(root);
      const key = bytes === null ? null : `${root}\0${sha256(bytes)}`;
      if (key !== null) {
        const hit = indexCache.get(key);
        if (hit !== undefined) return hit;
      }
      const entries = await port.run(['ls-files', '--stage'], root);
      if (key !== null) indexCache.set(key, entries);
      return entries;
    },
    async diffNames(cwd, range) {
      const root = await git.toplevel(cwd);
      // NOTE: a leading '-' would parse as a git option (e.g. --output=<path> writes files), so ranges must be revisions.
      if (range.trim().startsWith('-')) throw new Error(`review range must be a revision, got option-like ${range.trim()}`);
      if (range.trim()) return lines(await port.run(['diff', '--name-only', range.trim(), '--'], root)).filter(reviewOwned);
      const tracked = lines(await port.run(['diff', '--name-only', 'HEAD'], root));
      const untracked = lines(await port.run(['ls-files', '--others', '--exclude-standard'], root));
      return [...new Set([...tracked, ...untracked])].filter(reviewOwned);
    },
    async fingerprint(cwd) {
      const root = await git.toplevel(cwd);
      let head: string | null;
      try { head = (await port.run(['rev-parse', 'HEAD'], root)).trim() || null; } catch { head = null; }
      const index = sha256(await git.indexEntries(cwd));
      const status = await port.run(['status', '--porcelain=v1', '-uall'], root);
      const diff = await port.run(['diff', 'HEAD'], root).catch(() => '');
      // NOTE: status/diff omit untracked contents, so hash them to catch edits to already-untracked files.
      const untracked = lines(await port.run(['ls-files', '--others', '--exclude-standard'], root));
      const blobs = port.fileContent ? JSON.stringify(untracked.map((file) => [file, port.fileContent!(file, root)])) : untracked.length ? await port.run(['hash-object', '--', ...untracked], root) : '';
      return { head, index, worktree: sha256(`${status}\0${diff}\0${blobs}`) };
    },
    async changedSince(cwd, since) {
      const root = await git.toplevel(cwd);
      const tracked = lines(await port.run(['diff', '--name-only', since?.head ?? 'HEAD'], root));
      const untracked = lines(await port.run(['ls-files', '--others', '--exclude-standard'], root));
      return [...new Set([...tracked, ...untracked])].sort();
    },
    async log(cwd, range) {
      if (range.trim().startsWith('-')) return '';
      const root = await git.toplevel(cwd);
      try {
        const query = range.includes('...') ? range.replace('...', '..') : range.trim();
        return (await port.run(['log', '--format=%s%n%b', query], root)).trim();
      } catch {
        return '';
      }
    },
  };
  return git;
}
