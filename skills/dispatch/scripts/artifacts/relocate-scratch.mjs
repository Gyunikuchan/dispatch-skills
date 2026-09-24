// @ts-check
/**
 * @file artifacts/relocate-scratch.mjs
 * @description Cross-platform utility for relocating scratch artifacts (.scratch/) to this
 * repository's OS-temp namespace (`<os.tmpdir()>/dispatch-skills-<user>/<repoHash>/relocated/`),
 * where the temp tier of `resolve-paths.mjs` finds them.
 * Handles atomic moves, cross-device EXDEV fallbacks, collision avoidance, and workspace boundary checks.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureLedgerNamespace } from '../ledger/ledger.mjs';
import { getRepositoryRoot, relocatedArtifactsPath, repositoryRootHash } from './resolve-paths.mjs';

/**
 * Validates that a source path resides within a .scratch directory, resolving symlinks.
 * @param {string} sourcePath
 * @param {string} [cwd]
 * @returns {boolean}
 */
export function isScratchPath(sourcePath, cwd = process.cwd()) {
  const absoluteSource = path.resolve(cwd, sourcePath);
  let realSource = absoluteSource;
  try {
    realSource = fs.realpathSync(absoluteSource);
  } catch {
    try {
      const realParent = fs.realpathSync(path.dirname(absoluteSource));
      realSource = path.join(realParent, path.basename(absoluteSource));
    } catch {
      realSource = absoluteSource;
    }
  }

  const absoluteScratch = path.resolve(cwd, '.scratch');
  let realScratch = absoluteScratch;
  try {
    realScratch = fs.realpathSync(absoluteScratch);
  } catch {
    realScratch = absoluteScratch;
  }

  const relative = path.relative(realScratch, realSource);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Generates a non-colliding destination path in targetDir.
 * @param {string} targetDir
 * @param {string} baseName
 * @param {boolean} [isDirectory]
 * @returns {string}
 */
export function resolveUniqueDest(targetDir, baseName, isDirectory = false) {
  let dest = path.join(targetDir, baseName);
  if (!fs.existsSync(dest)) return dest;

  const ext = isDirectory ? '' : path.extname(baseName);
  const stem = ext ? baseName.slice(0, -ext.length) : baseName;
  const stamp = Date.now();
  dest = path.join(targetDir, `${stem}-${stamp}${ext}`);
  let counter = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(targetDir, `${stem}-${stamp}-${counter}${ext}`);
    counter++;
  }
  return dest;
}

/**
 * Relocates a single file or directory from .scratch to the repo-scoped relocated directory.
 * @param {string} srcPath
 * @param {object} [options]
 * @param {string} [options.targetDir] explicit destination; overrides the repo-scoped default
 * @param {string} [options.tempRoot]
 * @param {string} [options.cwd]
 * @returns {string|null} Resolved destination path, or null if skipped.
 */
export function relocateScratchItem(srcPath, { targetDir, tempRoot = os.tmpdir(), cwd = process.cwd() } = {}) {
  const absSrc = path.resolve(cwd, srcPath);
  if (!fs.existsSync(absSrc)) {
    process.stderr.write(`[relocate-scratch] skipped: '${srcPath}' (not found)\n`);
    return null;
  }

  if (!isScratchPath(absSrc, cwd)) {
    throw new Error(`Source path '${srcPath}' is outside the .scratch/ directory.`);
  }

  targetDir ??= ensureRelocatedDir({ cwd, tempRoot });
  const stat = fs.statSync(absSrc);
  const isDir = stat.isDirectory();
  const baseName = path.basename(absSrc);
  const dest = resolveUniqueDest(targetDir, baseName, isDir);

  try {
    fs.renameSync(absSrc, dest);
  } catch (err) {
    if (!['EXDEV', 'EPERM', 'EBUSY'].includes(err.code)) {
      throw err;
    }
    // Cross-device or lock fallback: copy, verify, then remove.
    if (isDir) {
      fs.cpSync(absSrc, dest, { recursive: true });
      if (!fs.existsSync(dest)) {
        throw new Error(`Cross-device copy verification failed for directory '${srcPath}'`);
      }
      try {
        fs.rmSync(absSrc, { recursive: true, force: true });
      } catch (rmErr) {
        process.stderr.write(`[relocate-scratch] Warning: copied '${srcPath}' to '${dest}' but failed to remove source: ${rmErr.message}\n`);
      }
    } else {
      fs.copyFileSync(absSrc, dest);
      const destStat = fs.existsSync(dest) ? fs.statSync(dest) : null;
      if (!destStat || destStat.size !== stat.size) {
        throw new Error(`Cross-device copy verification failed for file '${srcPath}' (size mismatch)`);
      }
      try {
        fs.rmSync(absSrc, { force: true });
      } catch (rmErr) {
        process.stderr.write(`[relocate-scratch] Warning: copied '${srcPath}' to '${dest}' but failed to remove source: ${rmErr.message}\n`);
      }
    }
  }

  return dest;
}

/** Creates (private) and returns the relocated directory inside the ledger namespace. */
function ensureRelocatedDir({ cwd, tempRoot }) {
  const repoHash = repositoryRootHash(getRepositoryRoot(cwd) ?? cwd);
  ensureLedgerNamespace({ tempRoot, repoHash });
  const dir = relocatedArtifactsPath({ projectRoot: cwd, tempRoot });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Relocates multiple paths.
 * @param {string[]} paths
 * @param {Record<string, any>} [options]
 * @returns {string[]} Destination paths of relocated items.
 */
export function relocateScratchPaths(paths, options = {}) {
  const cwd = options.cwd || process.cwd();
  // Validate boundaries upfront for existing paths
  for (const p of paths) {
    if (!p) continue;
    const absSrc = path.resolve(cwd, p);
    if (fs.existsSync(absSrc) && !isScratchPath(absSrc, cwd)) {
      throw new Error(`Source path '${p}' is outside the .scratch/ directory.`);
    }
  }

  const results = [];
  for (const p of paths) {
    if (!p) continue;
    const dest = relocateScratchItem(p, options);
    if (dest) results.push(dest);
  }
  return results;
}
