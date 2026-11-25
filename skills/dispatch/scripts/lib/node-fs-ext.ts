// Real `LinkFs` over node:fs.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LinkFs } from './fs-ext.ts';

function writeSynced(file: string, text: string): void {
  // Effect folders appear lazily, so the first write into one creates it.
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

const tempBeside = (file: string): string =>
  path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);

// NOTE: Windows refuses a rename onto a file another process briefly holds open (EPERM/EACCES/EBUSY); cap each wait at 640 ms within a ~5 s total retry budget.
const TRANSIENT_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);
export function renameRetrying(
  from: string,
  to: string,
  { platform = process.platform, rename = fs.renameSync } = {},
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (platform !== 'win32' || !code || !TRANSIENT_RENAME.has(code) || attempt >= 14) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(5 * 2 ** attempt, 640));
    }
  }
}

export const nodeLinkFs: LinkFs = {
  writeTemp(near, text) {
    const temp = tempBeside(near);
    writeSynced(temp, text);
    return temp;
  },
  link: (temp, final) => {
    fs.linkSync(temp, final);
  },
  writeAtomic(file, text) {
    const temp = tempBeside(file);
    writeSynced(temp, text);
    try {
      renameRetrying(temp, file);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw error;
    }
  },
  readText(file) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  },
  list(dir) {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  },
  remove: (file) => {
    fs.rmSync(file, { force: true });
  },
};
