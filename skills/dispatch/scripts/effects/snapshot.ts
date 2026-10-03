// `snapshot`: tree fingerprint `{ head, index, worktree }` and the paths changed since `since`.

import crypto from 'node:crypto';
import path from 'node:path';
import type { Effect, Handler, RecoverySnapshot, Ports, FileEntry } from '../core/types.ts';
import type { Git, TreeFingerprint } from './git.ts';

type SnapshotEffect = Extract<Effect, { kind: 'snapshot' }>;

export type SnapshotDeps = { cwd: string; git: Git };

const hash = (base64: string) => crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const safe = (f: string) => !!f && !f.includes('\\') && !f.startsWith('/') && !/^[A-Za-z]:/.test(f) && !f.split('/').some((p) => !p || p === '.' || p === '..' || p.includes(':'));
function safeFile(cwd: string, file: string, ports: Ports): boolean {
  if (!safe(file)) return false;
  const root = ports.fs.inspectPath(cwd)?.realPath ?? path.resolve(cwd);
  let current = cwd;
  for (const part of file.split('/')) {
    current = path.join(current, part);
    const info = ports.fs.inspectPath(current);
    if (!info || info.kind === 'symlink') return false;
    if (info.realPath && (path.relative(root, info.realPath).startsWith('..') || path.isAbsolute(path.relative(root, info.realPath)))) return false;
  }
  return ports.fs.inspectPath(current)?.kind === 'file';
}
export function lineChanges(oldBase64: string | null, newBase64: string | null): { added: number; removed: number } {
  const decode = (value: string | null) => value === null ? [] : Buffer.from(value, 'base64').toString('utf8').split('\n').filter((line, index, all) => index < all.length - 1 || line !== '');
  if ([oldBase64, newBase64].some((value) => value !== null && Buffer.from(value, 'base64').includes(0))) return { added: newBase64 === null || oldBase64 === newBase64 ? 0 : 1, removed: oldBase64 === null || oldBase64 === newBase64 ? 0 : 1 };
  const a = decode(oldBase64), b = decode(newBase64), max = a.length + b.length;
  const frontier = new Map<number, number>([[1, 0]]);
  for (let distance = 0; distance <= max; distance++) for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
    let x = diagonal === -distance || diagonal !== distance && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1) ? frontier.get(diagonal + 1) ?? 0 : (frontier.get(diagonal - 1) ?? 0) + 1;
    let y = x - diagonal;
    while (x < a.length && y < b.length && a[x] === b[y]) { x++; y++; }
    frontier.set(diagonal, x);
    if (x >= a.length && y >= b.length) return { added: (distance + b.length - a.length) / 2, removed: (distance + a.length - b.length) / 2 };
  }
  return { added: b.length, removed: a.length };
}

export function verifiedManifests(cwd: string, files: readonly string[], ports: Ports): string[] {
  const result: string[] = [];
  for (const file of files.filter((f) => path.posix.basename(f) === 'skill-hashes.json')) {
    try {
      if (!safeFile(cwd, file, ports)) continue;
      const dir = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);
      const manifest: unknown = JSON.parse(ports.fs.readText(path.resolve(cwd, file)));
      if (!record(manifest) || !Object.keys(manifest).length) continue;
      const entries = Object.entries(manifest);
      if (!entries.every(([relative, expected]) => safe(relative) && safeFile(cwd, dir ? `${dir}/${relative}` : relative, ports) && typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected)
        && ports.fs.hashFile(path.resolve(cwd, dir, relative)) === expected)) continue;
      const governed = [...(ports.fs.inspectPath(path.resolve(cwd, dir, 'SKILL.md'))?.kind === 'file' ? ['SKILL.md'] : []),
        ...ports.fs.listFiles(path.resolve(cwd, dir, 'scripts')).filter((f) => /\.(?:mjs|ts)$/.test(f)).map((f) => `scripts/${f}`),
        ...ports.fs.listFiles(path.resolve(cwd, dir, 'references')).filter((f) => /\.(?:md|json)$/.test(f)).map((f) => `references/${f}`)];
      if (governed.length !== entries.length || governed.some((f) => !Object.hasOwn(manifest, f))) continue;
      result.push(dir);
    } catch { /* Invalid manifests enter ordinary drift. */ }
  }
  return result;
}

export function snapshotContent(snapshot: Pick<RecoverySnapshot, 'contents' | 'contentStore'>, file: string, ports: Ports, runDir: string): string | null {
  const value = snapshot.contents[file] ?? null;
  if (value === null || snapshot.contentStore === undefined) return value;
  if (snapshot.contentStore !== 'recovery-contents' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid recovery content reference.');
  const stored = path.join(runDir, snapshot.contentStore, value);
  if (ports.fs.inspectPath(stored)?.kind !== 'file') throw new Error('Missing recovery content.');
  const bytes = ports.fs.readBase64(stored);
  if (hash(bytes) !== value) throw new Error('Corrupt recovery content.');
  return bytes;
}

async function capture(deps: SnapshotDeps, ports: Ports, since: unknown, fingerprint: TreeFingerprint, runDir: string): Promise<RecoverySnapshot | null> {
  if (!deps.git.recoveryFiles) return null;
  const metadata = await deps.git.recoveryFiles(deps.cwd);
  const previous = record(since) && record(since['recovery']) ? since['recovery'] : null;
  const before = previous && record(previous['contents']) ? previous['contents'] : {};
  const files = [...new Set([...metadata.files, ...Object.keys(before)])].sort();
  const entries: Record<string, FileEntry | null> = {};
  const contents: Record<string, string | null> = {};
  const store = path.join(runDir, 'recovery-contents');
  ports.fs.mkdir(store, { recursive: true });
  if (ports.fs.inspectPath(store)?.kind !== 'directory') throw new Error('Recovery content store must be a directory.');
  for (const file of files) {
    if (!safe(file)) throw new Error(`Invalid snapshot path: ${file}`);
    let current = deps.cwd;
    for (const part of file.split('/').slice(0, -1)) { current = path.join(current, part); if (ports.fs.inspectPath(current)?.kind === 'symlink') throw new Error(`Snapshot ancestor link: ${file}`); }
    const absolute = path.resolve(deps.cwd, file), info = ports.fs.inspectPath(absolute);
    if (info?.kind === 'directory') throw new Error(`Snapshot expected a file: ${file}`);
    entries[file] = info ? { kind: info.kind, mode: info.mode, linkTarget: info.linkTarget } : null;
    contents[file] = info?.kind === 'file' ? ports.fs.hashFile(absolute) : null;
    const digest = contents[file];
    if (digest !== null) {
      const stored = path.join(store, digest);
      if (!ports.fs.exists(stored)) ports.fs.copyFileAtomic(absolute, stored);
      if (ports.fs.inspectPath(stored)?.kind !== 'file' || ports.fs.hashFile(stored) !== digest) throw new Error(`Recovery content changed during capture: ${file}`);
    }
  }
  const oldEntries = previous && record(previous['entries']) ? previous['entries'] : {};
  const oldDigest = (file: string) => typeof before[file] !== 'string' ? null : previous?.['contentStore'] ? before[file] : hash(before[file] as string);
  const changed = previous ? files.filter((file) => oldDigest(file) !== contents[file] || JSON.stringify(oldEntries[file] ?? null) !== JSON.stringify(entries[file])).map((file) => ({ path: file, ...lineChanges(snapshotContent({ contents: before as Record<string, string | null>, ...(previous['contentStore'] ? { contentStore: previous['contentStore'] as 'recovery-contents' } : {}) }, file, ports, runDir), snapshotContent({ contents, contentStore: 'recovery-contents' }, file, ports, runDir)), deleted: entries[file] === null, outsideRepo: false })) : [];
  const gitPaths = ['config', 'hooks', 'info', ...['hooks', 'info'].flatMap((dir) => ports.fs.listFiles(path.join(metadata.gitDir, dir)).map((f) => `${dir}/${f}`))].sort();
  const gitDir = crypto.createHash('sha256').update(JSON.stringify(gitPaths.map((f) => { const absolute = path.join(metadata.gitDir, f), info = ports.fs.inspectPath(absolute); return [f, info?.mode ?? null, info?.kind === 'symlink' ? info.linkTarget : info?.kind === 'file' ? ports.fs.hashFile(absolute) : null]; }))).digest('hex');
  return {
    repoRoot: await deps.git.toplevel(deps.cwd), contents, contentStore: 'recovery-contents', entries, changed, taskStartFiles: previous && Array.isArray(previous['taskStartFiles']) ? previous['taskStartFiles'] as string[] : metadata.files,
    callerDirty: previous && Array.isArray(previous['callerDirty']) ? previous['callerDirty'] as string[] : metadata.dirty,
    ignored: metadata.ignored.map((file) => { const absolute = path.resolve(deps.cwd, file), info = ports.fs.inspectPath(absolute); if (info?.kind !== 'symlink' && !safeFile(deps.cwd, file, ports)) throw new Error(`Ignored snapshot path escape: ${file}`); return { path: file, hash: info?.kind === 'symlink' ? hash(info.linkTarget ?? '') : ports.fs.hashFile(absolute) }; }),
    git: { head: fingerprint.head ?? '', index: fingerprint.index, stash: metadata.stash, gitDir },
    verifiedManifestDirs: verifiedManifests(deps.cwd, metadata.files, ports),
    hashManifestDirs: metadata.files.filter((file) => path.posix.basename(file) === 'skill-hashes.json').map((file) => path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file)),
  };
}

function asFingerprint(value: unknown): TreeFingerprint | null {
  if (typeof value !== 'object' || value === null) return null;
  const { head, index, worktree } = value as Record<string, unknown>;
  if ((head !== null && typeof head !== 'string') || typeof index !== 'string' || typeof worktree !== 'string') return null;
  return { head, index, worktree };
}

export function createSnapshot(base: SnapshotDeps): Handler<SnapshotEffect> {
  return async (effect, ports, ctx) => {
    // A task worktree effect names its checkout; the default remains the caller checkout.
    const deps = effect.cwd ? { ...base, cwd: effect.cwd } : base;
    try {
      const fingerprint = await deps.git.fingerprint(deps.cwd);
      const since = asFingerprint(effect.since);
      const paths = since === null ? [] : await deps.git.changedSince(deps.cwd, since);
      const recovery = await capture(deps, ports, effect.since, fingerprint, ctx.runDir);
      return [{ type: 'SNAPSHOT', effectId: effect.id, fingerprint: { ...fingerprint, ...(recovery ? { recovery } : {}) }, diff: { paths } }];
    } catch (error) {
      return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: error instanceof Error ? error.message : String(error) }];
    }
  };
}
