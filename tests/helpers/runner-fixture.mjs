import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @template T @param {Record<string, string | undefined>} changes @param {() => T} run @returns {T} */
export function withEnv(changes, run) {
  const original = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * @template T
 * @param {string} prefix
 * @param {string[]} names
 * @param {(dirs: Record<string, string>) => T} run
 * @returns {T}
 */
export function withTempDirs(prefix, names, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const dirs = Object.fromEntries(names.map((name) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    return [name, dir];
  }));
  try {
    return run({ root, ...dirs });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
