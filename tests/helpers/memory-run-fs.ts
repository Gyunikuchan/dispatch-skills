import crypto from 'node:crypto';
import path from 'node:path';
import type { TestFs } from './fake-ports.ts';

/** In-memory run storage; caller files and external artifacts retain their real filesystem port. */
export function memoryRunFs(ports: { fs: TestFs }, root: string): void {
  const real = ports.fs, base = path.resolve(root);
  type Entry = { kind: 'file' | 'directory' | 'symlink'; bytes: Buffer; mode: number };
  const entries = new Map<string, Entry>();
  const key = (file: string) => path.resolve(file);
  const managed = (file: string) => key(file) === base || key(file).startsWith(`${base}${path.sep}`);
  const fail = (code: string, file: string): never => { throw Object.assign(new Error(`${code}: ${file}`), { code }); };
  const get = (file: string): Entry => entries.get(key(file)) ?? fail('ENOENT', file);
  const mkdir = (dir: string, recursive: boolean): void => {
    if (!managed(dir)) { real.mkdir(dir, { recursive }); return; }
    const current = entries.get(key(dir));
    if (current) { if (current.kind !== 'directory' || !recursive) fail('EEXIST', dir); return; }
    const parent = path.dirname(key(dir));
    if (managed(parent) && !entries.has(parent)) {
      if (!recursive) fail('ENOENT', parent);
      mkdir(parent, true);
    }
    if (managed(parent) && get(parent).kind !== 'directory') fail('ENOTDIR', parent);
    entries.set(key(dir), { kind: 'directory', bytes: Buffer.alloc(0), mode: 0o700 });
  };
  const write = (file: string, bytes: Buffer, exclusive = false): void => {
    mkdir(path.dirname(key(file)), true);
    const current = entries.get(key(file));
    if (current && exclusive) fail('EEXIST', file);
    if (current?.kind === 'directory') fail('EISDIR', file);
    entries.set(key(file), { kind: 'file', bytes: Buffer.from(bytes), mode: current?.mode ?? 0o600 });
  };
  const read = (file: string): Buffer => {
    const entry = get(file);
    if (entry.kind !== 'file') fail(entry.kind === 'directory' ? 'EISDIR' : 'ELOOP', file);
    return entry.bytes;
  };
  const copy = (source: string, destination: string, exclusive: boolean): boolean => {
    const bytes = managed(source) ? read(source) : Buffer.from(real.readBase64(source), 'base64');
    if (!managed(destination)) {
      if (exclusive && real.exists(destination)) return false;
      real.writeBase64Atomic(destination, bytes.toString('base64')); return true;
    }
    if (exclusive && entries.has(key(destination))) return false;
    write(destination, bytes, exclusive); return true;
  };
  const overlay: TestFs = {
    hashFile: file => managed(file) ? crypto.createHash('sha256').update(read(file)).digest('hex') : real.hashFile(file),
    copyFileAtomic: (source, destination) => { if (!managed(source) && !managed(destination)) real.copyFileAtomic(source, destination); else copy(source, destination, false); },
    copyFileExclusive: (source, destination) => !managed(source) && !managed(destination) ? real.copyFileExclusive(source, destination) : copy(source, destination, true),
    listFiles: dir => [...new Set([...(managed(dir) ? [] : real.listFiles(dir)), ...[...entries].filter(([file, entry]) => entry.kind !== 'directory' && file.startsWith(`${key(dir)}${path.sep}`)).map(([file]) => path.relative(dir, file).split(path.sep).join('/'))])].sort(),
    inspectPath: file => {
      if (!managed(file)) return real.inspectPath(file);
      const entry = entries.get(key(file));
      return entry ? { kind: entry.kind, mode: entry.mode, linkTarget: entry.kind === 'symlink' ? entry.bytes.toString('base64') : null, realPath: entry.kind === 'symlink' ? null : key(file) } : null;
    },
    setMode: (file, mode) => { if (managed(file)) get(file).mode = mode; else real.setMode(file, mode); },
    writeLinkAtomic: (file, target) => { if (!managed(file)) real.writeLinkAtomic(file, target); else { mkdir(path.dirname(file), true); entries.set(key(file), { kind: 'symlink', bytes: Buffer.from(target, 'base64'), mode: 0o777 }); } },
    readText: file => managed(file) ? read(file).toString('utf8') : real.readText(file),
    *readChunks(file, chunkBytes = 64 * 1024) {
      if (!managed(file)) { yield* real.readChunks(file, chunkBytes); return; }
      if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 1024 * 1024) throw new Error('Invalid chunk size.');
      const bytes = read(file);
      for (let offset = 0; offset < bytes.length; offset += chunkBytes) yield Buffer.from(bytes.subarray(offset, offset + chunkBytes));
    },
    readBase64: file => managed(file) ? read(file).toString('base64') : real.readBase64(file),
    writeBase64Atomic: (file, bytes) => { if (managed(file)) write(file, Buffer.from(bytes, 'base64')); else real.writeBase64Atomic(file, bytes); },
    exists: file => managed(file) ? entries.has(key(file)) : real.exists(file),
    size: file => managed(file) ? read(file).length : real.size(file),
    mkdir: (dir, options) => mkdir(dir, options.recursive),
    appendDurable: (file, text) => { if (managed(file)) write(file, Buffer.concat([entries.has(key(file)) ? read(file) : Buffer.alloc(0), Buffer.from(text)])); else real.appendDurable(file, text); },
    writeExclusive: (file, text) => { if (managed(file)) write(file, Buffer.from(text), true); else real.writeExclusive(file, text); },
    publishExclusive: (file, text) => { if (!managed(file)) return real.publishExclusive(file, text); if (entries.has(key(file))) return false; write(file, Buffer.from(text), true); return true; },
    writeAtomic: (file, text) => { if (managed(file)) write(file, Buffer.from(text)); else real.writeAtomic(file, text); },
    truncate: (file, length) => { if (!managed(file)) real.truncate(file, length); else { const bytes = read(file), next = Buffer.alloc(length); bytes.copy(next); write(file, next); } },
    remove: file => { if (!managed(file)) real.remove(file); else { const entry = entries.get(key(file)); if (entry?.kind === 'directory' && [...entries.keys()].some(child => child.startsWith(`${key(file)}${path.sep}`))) fail('ENOTEMPTY', file); entries.delete(key(file)); } },
  };
  ports.fs = overlay;
}
