// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TextDecoder } from 'node:util';

import { canonicalJson, sha256 } from '../ledger/events.mjs';

/** @typedef {{ path: string, mode: string, content: Buffer, worktreeAbsent: boolean, submoduleHead: string|null }} MaterializedEntry */
/** @typedef {{ path: string, pathBytes: Buffer, mode: string, objectId: string, stage: number, flags: string }} IndexEntry */

const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const BLOB_MODES = new Set(['100644', '100755', '120000']);
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const EMPTY_BUFFER = Buffer.alloc(0);

// SECTION: Git plumbing

/**
 * Runs Git with byte-preserving input and output.
 *
 * @param {string} repoRoot
 * @param {string[]} args
 * @param {{ input?: NodeJS.ArrayBufferView }} [options]
 * @returns {Buffer}
 */
function git(repoRoot, args, { input } = {}) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: null,
    input,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${Buffer.from(result.stderr ?? EMPTY_BUFFER).toString('utf8').trim()}`,
    );
  }
  return Buffer.from(result.stdout ?? EMPTY_BUFFER);
}

/** @param {Buffer} bytes @returns {string} */
export function decodeGitPath(bytes) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new Error(`Unsupported non-UTF-8 Git path: ${bytes.toString('hex')}`);
  }
}

/** @param {Buffer} buffer @returns {Buffer[]} */
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

// SECTION: Repository paths and record hashing

/** @param {string} value @returns {string} */
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

/** @param {string} value @returns {Buffer} */
function pathBytes(value) {
  return Buffer.from(value, 'utf8');
}

/** @param {{ path: string }} left @param {{ path: string }} right */
function compareBytes(left, right) {
  return Buffer.compare(pathBytes(left.path), pathBytes(right.path));
}

/** @param {Array<Buffer|string|number>} parts @returns {Buffer} */
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

/** @param {Array<Array<Buffer|string|number>>} records @returns {string} */
export function hashRecords(records) {
  const hash = crypto.createHash('sha256');
  for (const record of records) hash.update(frame(record));
  return `sha256:${hash.digest('hex')}`;
}

// SECTION: Index and materialized state

/** @param {string} repoRoot @returns {IndexEntry[]} */
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

/** @param {string} repoRoot */
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

/**
 * @param {string} repoRoot
 * @param {string} relativePath
 * @param {IndexEntry|undefined} indexEntry
 * @returns {MaterializedEntry}
 */
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
    return {
      path: relativePath,
      mode: 'absent',
      content: EMPTY_BUFFER,
      worktreeAbsent: false,
      submoduleHead: null,
    };
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

/** @param {string} repoRoot @param {string[]} paths */
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

// SECTION: Baseline and diff fingerprints

/** @param {string} repoRoot @returns {string[]} */
export function dirtyPaths(repoRoot) {
  return parseStatusPaths(git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
}

/** @param {string} repoRoot @returns {string} */
export function currentHead(repoRoot) {
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  if (head.status === 0) return head.stdout.trim();
  return git(repoRoot, ['hash-object', '-t', 'tree', '--stdin'], { input: EMPTY_BUFFER })
    .toString('ascii')
    .trim();
}

/** @param {string} repoRoot */
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

/** @param {MaterializedEntry[]} beforeEntries @param {MaterializedEntry[]} afterEntries */
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

// SECTION: Task-start snapshots

// Snapshot blobs stay in Git's object database so run evidence only carries object IDs.

/** Materialized entries with blob-backed contents: `{ path, mode, objectId | content(base64), worktreeAbsent, submoduleHead }`. */
export function snapshotEntries(repoRoot, paths) {
  return materializedFingerprint(repoRoot, paths).entries.map(({ content, ...entry }) => {
    if (!BLOB_MODES.has(entry.mode)) return { ...entry, content: content.toString('base64') };
    const objectId = git(repoRoot, ['hash-object', '-w', '--no-filters', '--stdin'], { input: content })
      .toString('ascii')
      .trim();
    return { ...entry, objectId };
  });
}

/** Contents of a snapshot entry (non-blob entries carry base64 `content`). */
export function snapshotContent(repoRoot, entry) {
  if (entry.objectId) return git(repoRoot, ['cat-file', 'blob', entry.objectId]);
  return Buffer.from(entry.content ?? '', 'base64');
}
