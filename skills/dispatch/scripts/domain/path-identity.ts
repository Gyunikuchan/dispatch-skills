// Path identity shared by spec, design, and plan lookups. Pure: callers supply any base directory.

import path from 'node:path';

/**
 * Comparable identity for `file`: separators and dot segments normalize, and Windows paths compare case-insensitively.
 * With `base`, a relative `file` resolves against it; without, `file` should already be absolute (no cwd is read).
 */
export function pathIdentity(file: string, base?: string): string {
  const slashed = file.replace(/\\/g, '/');
  const normalized = base === undefined ? path.posix.normalize(slashed) : path.resolve(base, slashed).replace(/\\/g, '/');
  return path.sep === '\\' ? normalized.toLowerCase() : normalized;
}
