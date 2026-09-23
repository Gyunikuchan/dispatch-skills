import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TextDecoder } from 'node:util';

import { canonicalJson, sha256 } from './ledger-events.mjs';

const decoder = new TextDecoder('utf-8', { fatal: true });
const EMPTY = Buffer.alloc(0);

function git(repoRoot, args, { input } = {}) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: null,
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${Buffer.from(result.stderr ?? EMPTY).toString('utf8').trim()}`);
  }
  return Buffer.from(result.stdout ?? EMPTY);
}

export function decodeGitPath(bytes) {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error(`Unsupported non-UTF-8 Git path: ${bytes.toString('hex')}`);
  }
}

function nulRecords(buffer) {
  const records = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] !== 0) continue;
    records.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start !== buffer.length) throw new Error('Git plumbing output was not NUL terminated');
  return records;
}

export function normalizeTaskPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || path.posix.isAbsolute(value)) {
    throw new Error(`Invalid repository-relative task path "${value}"`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../') || normalized === '.git' ||
      normalized.startsWith('.git/') || normalized === '.scratch' || normalized.startsWith('.scratch/')) {
    throw new Error(`Task path "${value}" is excluded`);
  }
  return normalized.replace(/^\.\//, '');
}

function pathBytes(value) {
  return Buffer.from(value, 'utf8');
}

function compareBytes(left, right) {
  return Buffer.compare(pathBytes(left.path), pathBytes(right.path));
}

function frame(parts) {
  const output = [];
  for (const part of parts) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(String(part), 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    output.push(length, bytes);
  }
  return Buffer.concat(output);
}

export function hashRecords(records) {
  const hash = crypto.createHash('sha256');
  for (const record of records) hash.update(frame(record));
  return `sha256:${hash.digest('hex')}`;
}

function indexEntries(repoRoot) {
  const flags = new Map();
  for (const record of nulRecords(git(repoRoot, ['ls-files', '-v', '-z']))) {
    if (record.length < 3 || record[1] !== 0x20) throw new Error('Malformed git ls-files flags record');
    flags.set(decodeGitPath(record.subarray(2)), String.fromCharCode(record[0]));
  }
  const entries = [];
  for (const record of nulRecords(git(repoRoot, ['ls-files', '--stage', '-z']))) {
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error('Malformed git ls-files record');
    const header = record.subarray(0, tab).toString('ascii').split(' ');
    const rawPath = record.subarray(tab + 1);
    entries.push({
      path: decodeGitPath(rawPath),
      pathBytes: rawPath,
      mode: header[0],
      objectId: header[1],
      stage: Number(header[2]),
      flags: flags.get(decodeGitPath(rawPath)) ?? '',
    });
  }
  return entries.sort((a, b) => Buffer.compare(a.pathBytes, b.pathBytes) || a.stage - b.stage);
}

export function indexFingerprint(repoRoot) {
  const entries = indexEntries(repoRoot);
  const records = entries.map(entry => [
    entry.pathBytes, entry.stage, entry.mode, entry.objectId, entry.flags,
  ]);
  return { digest: hashRecords(records), entries };
}

function stageZeroByPath(repoRoot) {
  return new Map(indexEntries(repoRoot).filter(entry => entry.stage === 0).map(entry => [entry.path, entry]));
}

function worktreeRecord(repoRoot, relativePath, indexEntry) {
  const absolute = path.join(repoRoot, ...relativePath.split('/'));
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (indexEntry && (indexEntry.mode === '160000' || indexEntry.flags === 'S')) {
      return {
        path: relativePath, mode: indexEntry.mode, content: Buffer.from(indexEntry.objectId),
        worktreeAbsent: true, submoduleHead: null,
      };
    }
    return { path: relativePath, mode: 'absent', content: EMPTY, worktreeAbsent: false, submoduleHead: null };
  }
  if (stat.isSymbolicLink()) {
    return {
      path: relativePath, mode: '120000', content: Buffer.from(fs.readlinkSync(absolute)),
      worktreeAbsent: false, submoduleHead: null,
    };
  }
  if (indexEntry?.mode === '160000') {
    let head = null;
    try { head = git(absolute, ['rev-parse', 'HEAD']).toString('ascii').trim(); } catch { head = null; }
    return {
      path: relativePath, mode: '160000', content: Buffer.from(indexEntry?.objectId ?? ''),
      worktreeAbsent: false, submoduleHead: head,
    };
  }
  if (stat.isDirectory()) throw new Error(`Unsupported directory task path "${relativePath}"`);
  if (!stat.isFile()) throw new Error(`Unsupported file type for "${relativePath}"`);
  return {
    path: relativePath,
    mode: (stat.mode & 0o111) !== 0 ? '100755' : '100644',
    content: fs.readFileSync(absolute),
    worktreeAbsent: false,
    submoduleHead: null,
  };
}

export function materializedFingerprint(repoRoot, paths) {
  const normalized = [...new Set(paths.map(normalizeTaskPath))];
  const index = stageZeroByPath(repoRoot);
  const entries = normalized.map(item => worktreeRecord(repoRoot, item, index.get(item))).sort(compareBytes);
  const records = entries.map(entry => [
    pathBytes(entry.path), entry.mode, entry.content,
    entry.worktreeAbsent ? 'worktreeAbsent' : 'materialized',
    entry.submoduleHead ?? '',
  ]);
  return { digest: hashRecords(records), entries };
}

function parseStatusPaths(buffer) {
  const records = nulRecords(buffer);
  const paths = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.length < 4) throw new Error('Malformed git status record');
    const status = record.subarray(0, 2).toString('ascii');
    const first = decodeGitPath(record.subarray(3));
    paths.push(first);
    if (status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C') {
      paths.push(decodeGitPath(records[++index]));
    }
  }
  return [...new Set(paths)].filter(item =>
    item !== '.scratch' && !item.startsWith('.scratch/') && item !== '.git' && !item.startsWith('.git/'),
  ).sort((a, b) => Buffer.compare(pathBytes(a), pathBytes(b)));
}

export function dirtyPaths(repoRoot) {
  return parseStatusPaths(git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
}

export function currentHead(repoRoot) {
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  if (head.status === 0) return head.stdout.trim();
  return git(repoRoot, ['hash-object', '-t', 'tree', '--stdin'], { input: EMPTY }).toString('ascii').trim();
}

export function baselineFingerprint(repoRoot) {
  const paths = dirtyPaths(repoRoot);
  const materialized = materializedFingerprint(repoRoot, paths);
  const index = indexFingerprint(repoRoot);
  return {
    commit: currentHead(repoRoot),
    repositoryState: sha256(canonicalJson({
      version: 'dispatch-ledger-repository-state-v1',
      materialized: materialized.digest,
      index: index.digest,
    })),
    dirtyPaths: paths,
    materializedState: materialized.digest,
    indexState: index.digest,
  };
}

export function diffHash(beforeEntries, afterEntries) {
  return sha256(canonicalJson({
    before: beforeEntries.map(entry => ({
      path: entry.path, mode: entry.mode, content: entry.content.toString('base64'),
      worktreeAbsent: entry.worktreeAbsent, submoduleHead: entry.submoduleHead,
    })),
    after: afterEntries.map(entry => ({
      path: entry.path, mode: entry.mode, content: entry.content.toString('base64'),
      worktreeAbsent: entry.worktreeAbsent, submoduleHead: entry.submoduleHead,
    })),
  }));
}

// SECTION: task-start snapshots
// File contents go to the object database, not run evidence: evidence keeps only object IDs.
const BLOB_MODES = new Set(['100644', '100755', '120000']);

/** Materialized entries with blob-backed contents: `{ path, mode, objectId | content(base64), worktreeAbsent, submoduleHead }`. */
export function snapshotEntries(repoRoot, paths) {
  return materializedFingerprint(repoRoot, paths).entries.map(({ content, ...entry }) => (BLOB_MODES.has(entry.mode)
    ? { ...entry, objectId: git(repoRoot, ['hash-object', '-w', '--no-filters', '--stdin'], { input: content }).toString('ascii').trim() }
    : { ...entry, content: content.toString('base64') }));
}

/** Contents of a snapshot entry (legacy entries carry base64 `content`). */
export function snapshotContent(repoRoot, entry) {
  if (entry.objectId) return git(repoRoot, ['cat-file', 'blob', entry.objectId]);
  return Buffer.from(entry.content ?? '', 'base64');
}
