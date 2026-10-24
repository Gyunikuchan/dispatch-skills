import fs from 'node:fs';
import path from 'node:path';
import { fakePorts } from './fake-ports.ts';
import { memoryRunFs } from './memory-run-fs.ts';

/** Route contained logical fixtures through the existing memory filesystem. */
export function memoryNodeFs(root: string): () => void {
  const paths = new Map<string, string>();
  const key = (file: string) => {
    let resolved = paths.get(file);
    if (resolved === undefined) {resolved = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file); paths.set(file, resolved);}
    return resolved;
  };
  const base = key(root);
  const containment = new Map<string, boolean>();
  const inside = (file: unknown): file is string => {
    if (typeof file !== 'string') return false;
    const cached = containment.get(file);
    if (cached !== undefined) return cached;
    const relative = path.relative(base, key(file));
    const contained = relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    containment.set(file, contained); return contained;
  };
  const ports = fakePorts(); memoryRunFs(ports, base);
  const storage = ports.fs;
  storage.mkdir(base, {recursive: true});
  const descriptors = new Map<number, string>();
  let next = -1;
  const restores: (() => void)[] = [];
  const fail = (code: string, file: string): never => {throw Object.assign(new Error(code + ': ' + file), {code});};
  const bytes = (file: string) => Buffer.from(storage.readBase64(key(file)), 'base64');
  const write = (file: string, data: string | Uint8Array, options?: any) => {
    if (options?.flag?.includes('x') && storage.exists(key(file))) fail('EEXIST', file);
    const encoding = typeof options === 'string' ? options : options?.encoding;
    if (typeof data === 'string' && (!encoding || encoding === 'utf8' || encoding === 'utf-8')) storage.writeAtomic(key(file), data);
    else storage.writeBase64Atomic(key(file), Buffer.from(data as any, encoding).toString('base64'));
  };
  const replace = (name: keyof typeof fs, handler: (original: any, ...args: any[]) => any) => {
    const original = fs[name];
    // Avoid node:test call-history capture for each logical filesystem operation.
    const replacement = (...args: any[]) => handler(original, ...args);
    Object.defineProperty(fs, name, {...Object.getOwnPropertyDescriptor(fs, name), value: replacement});
    restores.push(() => Object.defineProperty(fs, name, {...Object.getOwnPropertyDescriptor(fs, name), value: original}));
    return replacement as any;
  };
  replace('readFileSync', (real, file, options) => {
    if (!inside(file)) return real(file, options);
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return encoding === 'utf8' || encoding === 'utf-8' ? storage.readText(key(file)) : encoding ? bytes(file).toString(encoding) : bytes(file);
  });
  replace('writeFileSync', (real, file, data, options) => inside(file) ? write(file, data, options) : real(file, data, options));
  replace('appendFileSync', (real, file, data) => inside(file) ? write(file, Buffer.concat([storage.exists(key(file)) ? bytes(file) : Buffer.alloc(0), Buffer.from(data)])) : real(file, data));
  replace('copyFileSync', (real, source, target) => inside(target) ? storage.writeBase64Atomic(key(target), (inside(source) ? bytes(source) : fs.readFileSync(source)).toString('base64')) : real(source, target));
  replace('mkdirSync', (real, file, options) => inside(file) ? storage.mkdir(key(file), {recursive: !!options?.recursive}) : real(file, options));
  replace('existsSync', (real, file) => inside(file) ? storage.exists(key(file)) : real(file));
  replace('statSync', (real, file) => {
    if (!inside(file)) return real(file);
    const entry = storage.inspectPath(key(file)) ?? fail('ENOENT', file);
    return {size: entry.kind === 'file' ? bytes(file).length : 0, mode: entry.mode, isFile: () => entry.kind === 'file', isDirectory: () => entry.kind === 'directory', isSymbolicLink: () => entry.kind === 'symlink'};
  });
  replace('lstatSync', (real, file) => inside(file) ? fs.statSync(file) : real(file));
  const resolve = (real: any, file: string) => inside(file) ? (storage.exists(key(file)) ? key(file) : fail('ENOENT', file)) : real(file);
  const native = fs.realpathSync.native;
  const realpath = replace('realpathSync', resolve);
  realpath.native = ((file: string) => resolve(native, file)) as typeof native;
  replace('readdirSync', (real, file, options) => {
    if (!inside(file)) return real(file, options);
    if (!storage.exists(key(file))) fail('ENOENT', file);
    return [...new Set(storage.listFiles(key(file)).map(name => name.split('/')[0]!))];
  });
  replace('renameSync', (real, source, target) => {
    if (!inside(source) || !inside(target)) return real(source, target);
    storage.copyFileAtomic(key(source), key(target)); storage.remove(key(source));
  });
  replace('unlinkSync', (real, file) => {if (!inside(file)) return real(file); if (!storage.exists(key(file))) fail('ENOENT', file); storage.remove(key(file));});
  replace('rmSync', (real, file, options) => {
    if (!inside(file)) return real(file, options);
    const entry = storage.inspectPath(key(file));
    if (!entry) {if (!options?.force) fail('ENOENT', file); return;}
    if (entry.kind === 'directory') throw new Error('Virtual directory removal is not modeled');
    storage.remove(key(file));
  });
  replace('openSync', (real, file, flags, mode) => {
    if (!inside(file)) return real(file, flags, mode);
    if (flags !== 'a') throw new Error('Unscripted virtual open flags ' + flags);
    if (!storage.exists(key(file))) write(file, '');
    const fd = next--; descriptors.set(fd, key(file)); return fd;
  });
  replace('writeSync', (real, fd, data, ...rest) => {
    const file = descriptors.get(fd); if (!file) return real(fd, data, ...rest);
    const value = Buffer.from(data); write(file, Buffer.concat([bytes(file), value])); return value.length;
  });
  replace('fsyncSync', (real, fd) => {if (!descriptors.has(fd)) return real(fd);});
  replace('closeSync', (real, fd) => {if (!descriptors.delete(fd)) return real(fd);});
  replace('truncateSync', (real, file, length) => inside(file) ? storage.truncate(key(file), length) : real(file, length));
  return () => {for (const restore of restores.reverse()) restore();};
}
