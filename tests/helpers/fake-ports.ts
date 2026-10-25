// Test-local filesystem fallback and fixed runtime facts for repository tooling.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nodeLinkFs } from '../../skills/dispatch/scripts/lib/node-fs-ext.ts';

export interface TestFs {
  hashFile(file: string): string;
  copyFileAtomic(source: string, destination: string): void;
  copyFileExclusive(source: string, destination: string): boolean;
  listFiles(dir: string): string[];
  inspectPath(file: string): { kind: 'file' | 'directory' | 'symlink'; mode: number; linkTarget: string | null; realPath: string | null } | null;
  setMode(file: string, mode: number): void;
  writeLinkAtomic(file: string, target: string): void;
  readText(file: string): string;
  readChunks(file: string, chunkBytes?: number): Iterable<Uint8Array>;
  /** Byte-preserving content encoded for serializable recovery snapshots. */
  readBase64(file: string): string;
  /** Decode bytes, then temp file + fsync + rename. */
  writeBase64Atomic(file: string, base64: string): void;
  exists(file: string): boolean;
  size(file: string): number;
  mkdir(dir: string, options: { recursive: boolean }): void;
  /** open(a) + write + fsync. */
  appendDurable(file: string, text: string): void;
  /** Exclusive create (`wx`); throws with code EEXIST when present. */
  writeExclusive(file: string, text: string): void;
  /** Atomic exclusive publication; false means the completed target already exists. */
  publishExclusive(file: string, text: string): boolean;
  /** Temp file + fsync + rename. */
  writeAtomic(file: string, text: string): void;
  /** Truncate to length and fsync. */
  truncate(file: string, length: number): void;
  remove(file: string): void;
}

function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return;
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR', 'EPERM'].includes(String((error as { code?: string }).code))) throw error;
  }
}

// Effect folders appear lazily, so every create-style write makes its parent first.
const ensureParent = (file: string): void => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); };

function hashFile(file: string): string {
  const digest = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), chunk = Buffer.allocUnsafe(64 * 1024);
  try { let count: number; while ((count = fs.readSync(fd, chunk)) > 0) digest.update(chunk.subarray(0, count)); }
  finally { fs.closeSync(fd); }
  return digest.digest('hex');
}

function replaceAtomic(temp: string, file: string): void {
  try { fs.renameSync(temp, file); }
  catch (error) {
    if (process.platform !== 'win32' || (error as { code?: string }).code !== 'EPERM') throw error;
    const info = fs.lstatSync(file);
    if (!info.isFile() || (info.mode & 0o200) !== 0) throw error;
    fs.chmodSync(file, info.mode | 0o200);
    try { fs.renameSync(temp, file); }
    catch (retryError) { fs.chmodSync(file, info.mode); throw retryError; }
  }
}

function publishAtomic(file: string, content: string | Buffer): void {
  ensureParent(file);
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(temp, 'wx');
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    replaceAtomic(temp, file);
    syncDirectory(path.dirname(file));
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; }
  }
}

const nodeFs: TestFs = {
  *readChunks(file, chunkBytes = 64 * 1024) {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 1024 * 1024) throw new Error('Invalid chunk size.');
    const fd = fs.openSync(file, 'r');
    try {
      const chunk = Buffer.allocUnsafe(chunkBytes);
      let count: number;
      while ((count = fs.readSync(fd, chunk)) > 0) yield Buffer.from(chunk.subarray(0, count));
    } finally { fs.closeSync(fd); }
  },
  hashFile,
  copyFileExclusive(source, destination) {
    ensureParent(destination);
    const temp = path.join(path.dirname(destination), `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
    try {
      fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL); fs.chmodSync(temp, 0o600);
      const fd = fs.openSync(temp, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try { fs.linkSync(temp, destination); syncDirectory(path.dirname(destination)); return true; }
      catch (error) { if ((error as { code?: string }).code === 'EEXIST') return false; throw error; }
    } finally { try { fs.unlinkSync(temp); } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; } }
  },
  copyFileAtomic(source, destination) {
    const temp = path.join(path.dirname(destination), `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
    try {
      fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(temp, 0o600);
      const fd = fs.openSync(temp, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      replaceAtomic(temp, destination);
      syncDirectory(path.dirname(destination));
    } finally {
      try { fs.unlinkSync(temp); } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; }
    }
  },
  listFiles(dir) {
    const result: string[] = [];
    const walk = (current: string, relative: string) => {
      if (!fs.existsSync(current)) return;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const file = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory() && !entry.isSymbolicLink()) walk(path.join(current, entry.name), file);
        else result.push(file);
      }
    };
    if (fs.existsSync(dir) && !fs.lstatSync(dir).isSymbolicLink()) walk(dir, '');
    return result.sort();
  },
  inspectPath(file) {
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(String((error as { code?: string }).code))) return null; throw error; }
    if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) throw new Error(`Unsupported file type: ${file}`);
    let realPath: string | null;
    try { realPath = fs.realpathSync(file); } catch { realPath = null; }
    return { kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file', mode: stat.mode & 0o7777, linkTarget: stat.isSymbolicLink() ? fs.readlinkSync(file, { encoding: 'buffer' }).toString('base64') : null, realPath };
  },
  setMode: (file, mode) => { fs.chmodSync(file, mode); },
  writeLinkAtomic(file, target) {
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.link.tmp`);
    try { fs.symlinkSync(Buffer.from(target, 'base64'), temporary); replaceAtomic(temporary, file); syncDirectory(path.dirname(file)); }
    finally { try { fs.unlinkSync(temporary); } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; } }
  },
  readText: (file) => fs.readFileSync(file, 'utf8'),
  readBase64: (file) => fs.readFileSync(file).toString('base64'),
  writeBase64Atomic(file, base64) {
    publishAtomic(file, Buffer.from(base64, 'base64'));
  },
  exists: (file) => fs.existsSync(file),
  size: (file) => fs.statSync(file).size,
  mkdir: (dir, options) => { fs.mkdirSync(dir, options); },
  appendDurable(file, text) {
    ensureParent(file);
    const fd = fs.openSync(file, 'a');
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  },
  writeExclusive(file, text) {
    ensureParent(file);
    const fd = fs.openSync(file, 'wx');
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  },
  publishExclusive(file, text) {
    ensureParent(file);
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(temp, 'wx');
      try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try { fs.linkSync(temp, file); syncDirectory(path.dirname(file)); return true; }
      catch (error) { if ((error as { code?: string }).code === 'EEXIST') return false; throw error; }
    } finally { try { fs.unlinkSync(temp); } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; } }
  },
  writeAtomic(file, text) {
    publishAtomic(file, text);
  },
  truncate(file, length) {
    const fd = fs.openSync(file, 'r+');
    try { fs.ftruncateSync(fd, length); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  },
  remove: nodeLinkFs.remove,
};


export interface FakePorts {
  fs: TestFs;
}

export function fakePorts(): FakePorts {
  return { fs: nodeFs };
}

/** Fresh directory under the process's isolated temp dir; the run dir itself is not created. */
export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'core-'));
}
