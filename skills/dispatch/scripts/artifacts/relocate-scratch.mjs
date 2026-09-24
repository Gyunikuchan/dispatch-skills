// @ts-check
/**
 * Relocates `.scratch/` artifacts into this repository's private OS-temp namespace.
 * Moves are atomic when possible, with verified copy/remove fallbacks across devices.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureLedgerNamespace } from '../ledger/ledger.mjs';
import { getRepositoryRoot, relocatedArtifactsPath, repositoryRootHash } from './resolve-paths.mjs';

/** @typedef {{ targetDir?: string, tempRoot?: string, cwd?: string }} RelocationOptions */

const SCRATCH_DIRECTORY = '.scratch';
const PRIVATE_DIRECTORY_MODE = 0o700;
const MOVE_FALLBACK_CODES = new Set(['EXDEV', 'EPERM', 'EBUSY']);
const MESSAGE_PREFIX = '[relocate-scratch]';

// SECTION: Path safety and destinations

/**
 * Tests whether a source resolves inside the workspace's `.scratch/` directory.
 * Existing symlinks are resolved so lexical containment cannot bypass the boundary.
 *
 * @param {string} sourcePath
 * @param {string} [cwd]
 * @returns {boolean}
 */
export function isScratchPath(sourcePath, cwd = process.cwd()) {
  const realSource = resolveExistingPath(path.resolve(cwd, sourcePath));
  const realScratch = resolveExistingPath(path.resolve(cwd, SCRATCH_DIRECTORY));
  const relative = path.relative(realScratch, realSource);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Returns a path unchanged when available, otherwise appends a timestamp and counter.
 *
 * @param {string} targetDir
 * @param {string} baseName
 * @param {boolean} [isDirectory]
 * @returns {string}
 */
export function resolveUniqueDest(targetDir, baseName, isDirectory = false) {
  const original = path.join(targetDir, baseName);
  if (!fs.existsSync(original)) return original;

  const extension = isDirectory ? '' : path.extname(baseName);
  const stem = extension ? baseName.slice(0, -extension.length) : baseName;
  const stampedStem = `${stem}-${Date.now()}`;
  let destination = path.join(targetDir, `${stampedStem}${extension}`);
  let counter = 1;
  while (fs.existsSync(destination)) {
    destination = path.join(targetDir, `${stampedStem}-${counter}${extension}`);
    counter += 1;
  }
  return destination;
}

/** Resolves an existing path, or its existing parent when the leaf does not exist. */
function resolveExistingPath(absolutePath) {
  try {
    return fs.realpathSync(absolutePath);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(absolutePath)), path.basename(absolutePath));
    } catch {
      return absolutePath;
    }
  }
}

/** Creates and returns the private relocated directory inside the ledger namespace. */
function ensureRelocatedDir({ cwd, tempRoot }) {
  const repoHash = repositoryRootHash(getRepositoryRoot(cwd) ?? cwd);
  ensureLedgerNamespace({ tempRoot, repoHash });
  const directory = relocatedArtifactsPath({ projectRoot: cwd, tempRoot });
  fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  return directory;
}

// SECTION: Move lifecycle

/**
 * Relocates one file or directory from `.scratch/` into the repo-scoped destination.
 *
 * @param {string} srcPath
 * @param {RelocationOptions} [options]
 * @returns {string|null} Destination path, or `null` when the source does not exist.
 */
export function relocateScratchItem(
  srcPath,
  { targetDir, tempRoot = os.tmpdir(), cwd = process.cwd() } = {},
) {
  const absoluteSource = path.resolve(cwd, srcPath);
  if (!fs.existsSync(absoluteSource)) {
    process.stderr.write(`${MESSAGE_PREFIX} skipped: '${srcPath}' (not found)\n`);
    return null;
  }
  assertScratchPath(srcPath, absoluteSource, cwd);

  const destinationDirectory = targetDir ?? ensureRelocatedDir({ cwd, tempRoot });
  const sourceStat = fs.statSync(absoluteSource);
  const isDirectory = sourceStat.isDirectory();
  const destination = resolveUniqueDest(destinationDirectory, path.basename(absoluteSource), isDirectory);

  try {
    fs.renameSync(absoluteSource, destination);
  } catch (error) {
    if (!isMoveFallbackError(error)) throw error;
    copyVerifyAndRemove({
      absoluteSource,
      destination,
      isDirectory,
      sourceSize: sourceStat.size,
      displayPath: srcPath,
    });
  }
  return destination;
}

/**
 * Validates all existing sources before moving any, then relocates them in order.
 *
 * @param {string[]} paths
 * @param {RelocationOptions} [options]
 * @returns {string[]} Destination paths for sources that existed.
 */
export function relocateScratchPaths(paths, options = {}) {
  const cwd = options.cwd || process.cwd();
  for (const sourcePath of paths) {
    if (!sourcePath) continue;
    const absoluteSource = path.resolve(cwd, sourcePath);
    if (fs.existsSync(absoluteSource)) assertScratchPath(sourcePath, absoluteSource, cwd);
  }

  const destinations = [];
  for (const sourcePath of paths) {
    if (!sourcePath) continue;
    const destination = relocateScratchItem(sourcePath, options);
    if (destination) destinations.push(destination);
  }
  return destinations;
}

function assertScratchPath(displayPath, absoluteSource, cwd) {
  if (!isScratchPath(absoluteSource, cwd)) {
    throw new Error(`Source path '${displayPath}' is outside the .scratch/ directory.`);
  }
}

/** @returns {error is NodeJS.ErrnoException} */
function isMoveFallbackError(error) {
  return error instanceof Error && MOVE_FALLBACK_CODES.has(/** @type {NodeJS.ErrnoException} */ (error).code ?? '');
}

/** Copy fallback preserves the source when removal fails, avoiding data loss. */
function copyVerifyAndRemove({ absoluteSource, destination, isDirectory, sourceSize, displayPath }) {
  if (isDirectory) {
    fs.cpSync(absoluteSource, destination, { recursive: true });
    if (!fs.existsSync(destination)) {
      throw new Error(`Cross-device copy verification failed for directory '${displayPath}'`);
    }
  } else {
    fs.copyFileSync(absoluteSource, destination);
    const destinationStat = fs.existsSync(destination) ? fs.statSync(destination) : null;
    if (!destinationStat || destinationStat.size !== sourceSize) {
      throw new Error(`Cross-device copy verification failed for file '${displayPath}' (size mismatch)`);
    }
  }

  try {
    fs.rmSync(absoluteSource, isDirectory ? { recursive: true, force: true } : { force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${MESSAGE_PREFIX} Warning: copied '${displayPath}' to '${destination}' but failed to remove source: ${message}\n`);
  }
}
