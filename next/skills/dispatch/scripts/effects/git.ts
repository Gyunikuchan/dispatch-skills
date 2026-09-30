// The single git module of the effects layer (ADR 0002 §2, ADR 0006). Caching rules: a successful toplevel lookup
// is cached per instance (a work-tree root cannot move within a process; a failure may become a repo later); index
// entries are cached by the SHA-256 of the index file's bytes (any index write changes the key); working-tree
// reads are never cached.

import crypto from 'node:crypto';
import type { GitPort } from '../core/types.ts';

export type TreeFingerprint = { head: string | null; index: string; worktree: string };
export type PathDiff = { paths: string[] };

export type Git = {
  toplevel(cwd: string): Promise<string>;
  /** `git ls-files --stage` output, cached by index content hash. */
  indexEntries(cwd: string): Promise<string>;
  /** Changed paths for a range (`a..b`, a commit) or, when empty, the working tree against HEAD plus untracked. */
  diffNames(cwd: string, range: string): Promise<string[]>;
  fingerprint(cwd: string): Promise<TreeFingerprint>;
  /** Paths changed since a fingerprint's HEAD (tracked and untracked). */
  changedSince(cwd: string, since: TreeFingerprint | null): Promise<string[]>;
};

/** Reads the index file's bytes; null when git is redirected or the work tree is linked (read uncached). */
export type ReadIndex = (toplevel: string) => string | null;

const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');
const lines = (text: string): string[] => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

export function createGit(port: GitPort, readIndex: ReadIndex = () => null): Git {
  const toplevels = new Map<string, string>();
  const indexCache = new Map<string, string>();

  const git: Git = {
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
      if (range.trim()) return lines(await port.run(['diff', '--name-only', range.trim(), '--'], root));
      const tracked = lines(await port.run(['diff', '--name-only', 'HEAD'], root));
      const untracked = lines(await port.run(['ls-files', '--others', '--exclude-standard'], root));
      return [...new Set([...tracked, ...untracked])];
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
      const blobs = untracked.length ? await port.run(['hash-object', '--', ...untracked], root) : '';
      return { head, index, worktree: sha256(`${status}\0${diff}\0${blobs}`) };
    },
    async changedSince(cwd, since) {
      const root = await git.toplevel(cwd);
      const tracked = lines(await port.run(['diff', '--name-only', since?.head ?? 'HEAD'], root));
      const untracked = lines(await port.run(['ls-files', '--others', '--exclude-standard'], root));
      return [...new Set([...tracked, ...untracked])].sort();
    },
  };
  return git;
}
