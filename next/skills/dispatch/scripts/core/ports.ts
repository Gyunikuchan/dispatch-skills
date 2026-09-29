// Real Node `Ports`; tests inject fakes (tests/helpers/fake-ports.ts).

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FsPort, Ports } from './types.ts';

export const nodeFs: FsPort = {
  readText: (file) => fs.readFileSync(file, 'utf8'),
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
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
    const fd = fs.openSync(temp, 'w');
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
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
    execFile(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
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
