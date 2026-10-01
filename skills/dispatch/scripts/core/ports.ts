// Real Node `Ports`; tests inject fakes (tests/helpers/fake-ports.ts).

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FsPort, Ports } from './types.ts';

function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return;
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR', 'EPERM'].includes(String((error as { code?: string }).code))) throw error;
  }
}

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

export const nodeFs: FsPort = {
  hashFile,
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
    const fd = fs.openSync(file, 'a');
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  },
  writeExclusive(file, text) {
    const fd = fs.openSync(file, 'wx');
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  },
  writeAtomic(file, text) {
    publishAtomic(file, text);
  },
  truncate(file, length) {
    const fd = fs.openSync(file, 'r+');
    try { fs.ftruncateSync(fd, length); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  },
  remove: (file) => { fs.rmSync(file, { force: true }); },
};

function run(argv: readonly string[], cwd: string): Promise<{ exit: number; stdout: string; stderr: string }> {
  const [command, ...args] = argv;
  if (!command) return Promise.reject(new Error('spawn: empty argv'));
  return new Promise((resolve) => {
    const commandShell = process.platform === 'win32' && /(?:^|[/\\])cmd(?:\.exe)?$/i.test(command);
    execFile(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, windowsVerbatimArguments: commandShell }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0;
      resolve({ exit: code, stdout, stderr });
    });
  });
}

export function nodePorts(): Ports {
  return {
    fs: nodeFs,
    spawn: { run: (argv, options) => run(argv, options.cwd) },
    git: {
      fileContent(file, cwd) {
        let current = path.resolve(cwd);
        for (const part of file.replace(/\\/g, '/').split('/').slice(0, -1)) { current = path.join(current, part); if (nodeFs.inspectPath(current)?.kind === 'symlink') throw new Error(`Git fingerprint ancestor link: ${file}`); }
        const absolute = path.resolve(cwd, file), info = nodeFs.inspectPath(absolute);
        const digest = crypto.createHash('sha256').update(JSON.stringify([info?.kind ?? null, info?.mode ?? null, info?.linkTarget ?? null]));
        if (info?.kind === 'file') digest.update(hashFile(absolute));
        return digest.digest('hex');
      },
      async run(args, cwd) {
        const result = await run(['git', ...args], cwd);
        if (result.exit !== 0) throw new Error(`git ${args.join(' ')} failed (${result.exit}): ${result.stderr.trim()}`);
        return result.stdout;
      },
    },
    clock: {
      now: () => Date.now(),
      every(ms, fn) {
        const handle = setInterval(fn, ms);
        handle.unref();
        return () => clearInterval(handle);
      },
    },
    env: { get: (name) => process.env[name] },
    proc: {
      pid: process.pid,
      host: os.hostname(),
      isAlive(pid) {
        try { process.kill(pid, 0); return true; } catch (error) {
          // NOTE: EPERM means the pid exists under another user.
          return (error as { code?: unknown }).code === 'EPERM';
        }
      },
      stderr: (text) => { process.stderr.write(text); },
    },
  };
}
