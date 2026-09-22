#!/usr/bin/env node

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isMainModule, verifySkillIntegrity } from './common.mjs';
import {
  changedKeys,
  readArtifact,
  semanticSectionHashes,
} from './review-preparation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXCLUDED_SEGMENTS = new Set([
  '.scratch', 'node_modules', 'vendor', 'vendors', 'dist', 'build', 'coverage', '.next',
]);
const GENERATED_NAMES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

function git(repoRoot, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (!allowFailure && result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  }
  return result;
}

export function isReviewablePath(file, repoRoot) {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
  const segments = normalized.split('/');
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return false;
  if (GENERATED_NAMES.has(path.basename(normalized)) || /\.(?:min\.js|map|lock|snap)$/i.test(normalized)) return false;
  const absolute = path.resolve(repoRoot, normalized);
  if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
    const handle = fs.openSync(absolute, 'r');
    try {
      const buffer = Buffer.alloc(8192);
      const bytes = fs.readSync(handle, buffer, 0, buffer.length, 0);
      if (buffer.subarray(0, bytes).includes(0)) return false;
    } finally {
      fs.closeSync(handle);
    }
  }
  return true;
}

export function currentPaths(repoRoot) {
  const commands = [
    ['diff', '--name-only', '--'],
    ['diff', '--cached', '--name-only', '--'],
    ['ls-files', '--others', '--exclude-standard'],
  ];
  return [...new Set(commands.flatMap((args) => {
    const result = git(repoRoot, args);
    return result.stdout.split(/\r?\n/).filter(Boolean);
  }))].filter((file) => isReviewablePath(file, repoRoot)).sort();
}

function digest(chunks) {
  const hash = crypto.createHash('sha256');
  for (const chunk of chunks) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

function rangePaths(repoRoot, range) {
  const binary = new Set(git(repoRoot, ['diff', '--numstat', range, '--']).stdout
    .split(/\r?\n/)
    .filter((line) => /^-\s+-\s+/.test(line))
    .map((line) => line.split('\t').at(-1)));
  return git(repoRoot, ['diff', '--name-only', range, '--']).stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((file) => !binary.has(file))
    .filter((file) => isReviewablePath(file, repoRoot))
    .sort();
}

function resolveRangeShas(repoRoot, range) {
  const separator = range.includes('...') ? '...' : '..';
  const [left, right] = range.split(separator);
  const headSha = verifyCommit(repoRoot, right);
  if (separator === '...') {
    const mergeBase = git(repoRoot, ['merge-base', left, right]);
    return { baseSha: mergeBase.stdout.trim(), headSha };
  }
  const leftCommit = git(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${left}^{commit}`], { allowFailure: true });
  if (leftCommit.status === 0) return { baseSha: leftCommit.stdout.trim(), headSha };
  const leftTree = git(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${left}^{tree}`], { allowFailure: true });
  if (leftTree.status === 0) return { baseSha: leftTree.stdout.trim(), headSha };
  throw new Error(`Range base "${left}" is neither a commit nor a tree.`);
}

export function captureReviewSnapshot({ repoRoot = process.cwd(), scope, includeWorkingTree = [] }) {
  repoRoot = path.resolve(repoRoot);
  if (!scope?.reviewable) throw new Error('A reviewable scope is required to capture a snapshot.');
  let paths;
  let baseSha = null;
  let headSha = null;
  if (scope.kind === 'working-tree') {
    paths = currentPaths(repoRoot);
    const head = git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}'], { allowFailure: true });
    headSha = head.status === 0 ? head.stdout.trim() : null;
    baseSha = headSha;
  } else {
    paths = rangePaths(repoRoot, scope.range);
    ({ baseSha, headSha } = resolveRangeShas(repoRoot, scope.range));
    const working = new Set(currentPaths(repoRoot));
    for (const file of includeWorkingTree) {
      const normalized = file.replace(/\\/g, '/');
      if (
        normalized !== file ||
        path.isAbsolute(file) ||
        normalized.split('/').includes('..') ||
        !working.has(normalized) ||
        !isReviewablePath(normalized, repoRoot)
      ) {
        throw new Error(`Declared settled path "${file}" is not an eligible working-tree change.`);
      }
    }
    paths = [...new Set([...paths, ...includeWorkingTree])].sort();
  }
  const readWorkingPath = (file) => {
    const absolute = path.join(repoRoot, file);
    return fs.lstatSync(absolute).isSymbolicLink()
      ? Buffer.from(`symlink\0${fs.readlinkSync(absolute)}`)
      : fs.readFileSync(absolute);
  };
  // Staged deletions leave the path in neither index nor disk, so hash them via the HEAD diff.
  // lstat, not existsSync: a dangling symlink is still a working-tree entry, as readWorkingPath reads it.
  const lstatExists = (absolute) => {
    try { fs.lstatSync(absolute); return true; } catch { return false; }
  };
  const diffsAgainstHead = (file) => Boolean(headSha) && (
    git(repoRoot, ['ls-files', '--error-unmatch', '--', file], { allowFailure: true }).status === 0 ||
    (!lstatExists(path.join(repoRoot, file)) &&
      git(repoRoot, ['cat-file', '-e', `HEAD:${file}`], { allowFailure: true }).status === 0)
  );
  const pathHashes = {};
  for (const file of paths) {
    if (scope.kind === 'working-tree') {
      pathHashes[file] = diffsAgainstHead(file)
        ? digest([git(repoRoot, ['diff', '--binary', 'HEAD', '--', file]).stdout])
        : digest([readWorkingPath(file)]);
    } else {
      const chunks = [git(repoRoot, ['diff', '--binary', scope.range, '--', file]).stdout];
      if (includeWorkingTree.includes(file)) {
        chunks.push(diffsAgainstHead(file)
          ? git(repoRoot, ['diff', '--binary', 'HEAD', '--', file]).stdout
          : readWorkingPath(file));
      }
      pathHashes[file] = digest(chunks);
    }
  }
  return {
    baseSha,
    headSha,
    paths,
    pathHashes,
    worktreeHash: digest(paths.flatMap((file) => [`${file}\0`, `${pathHashes[file]}\n`])),
  };
}

function verifyCommit(repoRoot, revision) {
  if (!revision || revision.startsWith('-') || /[\s\x00-\x1f]/.test(revision)) {
    throw new Error(`Invalid revision "${revision || ''}".`);
  }
  const result = git(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], { allowFailure: true });
  if (result.status !== 0) throw new Error(`Revision "${revision}" is not a commit in this repository.`);
  return result.stdout.trim();
}

export function resolveExplicitRange(repoRoot, expression) {
  const tripleCount = (expression.match(/\.\.\./g) ?? []).length;
  const withoutTriple = expression.replace(/\.\.\./g, '');
  const doubleCount = (withoutTriple.match(/\.\./g) ?? []).length;
  if (tripleCount + doubleCount > 1) throw new Error('Explicit review scope must contain one commit or one range.');
  if (tripleCount === 1) {
    const [left, right] = expression.split('...');
    verifyCommit(repoRoot, left);
    verifyCommit(repoRoot, right);
    return `${left}...${right}`;
  }
  if (doubleCount === 1) {
    const [left, right] = expression.split('..');
    verifyCommit(repoRoot, left);
    verifyCommit(repoRoot, right);
    return `${left}..${right}`;
  }
  const sha = verifyCommit(repoRoot, expression);
  const parent = git(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${sha}^`], { allowFailure: true });
  if (parent.status === 0) return `${sha}^..${sha}`;
  const emptyTree = spawnSync('git', ['hash-object', '-t', 'tree', '--stdin'], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: '',
  });
  if (emptyTree.status !== 0 || !emptyTree.stdout.trim()) {
    throw new Error((emptyTree.stderr || 'Cannot resolve the empty Git tree.').trim());
  }
  return `${emptyTree.stdout.trim()}..${sha}`;
}

function resolveBase(repoRoot) {
  const originHead = git(repoRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { allowFailure: true });
  const candidates = [
    originHead.status === 0 ? originHead.stdout.trim().replace(/^refs\/remotes\//, '') : null,
    'origin/main', 'main', 'origin/master', 'master',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = git(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${candidate}^{commit}`], { allowFailure: true });
    if (result.status === 0) return candidate;
  }
  return null;
}

function filterAllowed(paths, allowedPaths) {
  if (allowedPaths === null || allowedPaths === undefined) return { paths, restricted: false };
  if (!Array.isArray(allowedPaths)) {
    throw new Error('allowedPaths must be an array of non-empty repository-relative path strings');
  }
  const owned = new Set();
  for (const entry of allowedPaths) {
    if (typeof entry !== 'string' || !entry) {
      throw new Error('allowedPaths must be an array of non-empty repository-relative path strings');
    }
    const normalized = entry.replaceAll('\\', '/').replace(/^\.\//, '');
    if (path.isAbsolute(entry) || path.win32.isAbsolute(entry) || normalized.startsWith('/') || normalized.split('/').includes('..')) {
      throw new Error(`allowedPaths entry must stay inside the repository: ${entry}`);
    }
    owned.add(normalized);
  }
  return { paths: paths.filter(file => owned.has(file)), restricted: true };
}

function emptyOwnedIntersection(message) {
  return {
    reviewable: false,
    kind: 'empty-owned-intersection',
    range: null,
    paths: [],
    disclosure: 'No owned paths in the review selection; the integration gate cannot settle with nothing owned to review. Attribute ownership or replace the baseline before review.',
    message,
  };
}

export function resolveReviewScope({ repoRoot = process.cwd(), explicitRange = null, allowedPaths = null, baseRevision = null } = {}) {
  repoRoot = path.resolve(repoRoot);
  if (explicitRange && baseRevision) throw new Error('Pass either an explicit range or a base revision, not both.');
  if (explicitRange) {
    const range = resolveExplicitRange(repoRoot, explicitRange);
    const rangeResult = rangePaths(repoRoot, range);
    const rangeFiltered = filterAllowed(rangeResult, allowedPaths);
    const { restricted } = rangeFiltered;
    const head = git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}'], { allowFailure: true });
    // Owned selections ending at HEAD also cover uncommitted owned edits so integration never drops them.
    const includeWorking = restricted && head.status === 0 &&
      resolveRangeShas(repoRoot, range).headSha === head.stdout.trim();
    const paths = includeWorking
      ? [...new Set([...rangeFiltered.paths, ...filterAllowed(currentPaths(repoRoot), allowedPaths).paths])].sort()
      : rangeFiltered.paths;
    if (restricted && paths.length === 0) {
      return emptyOwnedIntersection('The ledger-owned path set does not intersect the review range; integration cannot settle on an empty owned intersection.');
    }
    if (paths.length === 0) {
      return { reviewable: false, kind: 'empty', range: null, paths: [], message: 'No reviewable changes; name a commit or range to review.' };
    }
    const shas = resolveRangeShas(repoRoot, range);
    const disclosure = restricted
      ? `Owned-path restriction: ${paths.join(', ')}; unrelated range paths excluded${includeWorking ? '; working-tree owned changes included' : ''}.`
      : null;
    return { reviewable: true, kind: 'explicit-range', range, paths, ...shas, reviewScope: `Explicit Git range: ${range}`, ...(disclosure ? { disclosure } : {}) };
  }
  const current = currentPaths(repoRoot);
  const workingFiltered = filterAllowed(current, allowedPaths);
  if (!workingFiltered.restricted && !baseRevision && workingFiltered.paths.length > 0) {
    return {
      reviewable: true,
      kind: 'working-tree',
      range: null,
      paths: workingFiltered.paths,
      reviewScope: 'Current staged, unstaged, and untracked changes',
    };
  }
  // A restricted selection unions owned committed-range paths with owned working-tree paths so
  // committed increments stay visible next to retained working-tree changes. Unrestricted
  // selections keep the original behavior (working tree wins; empty falls to the range logic).
  const head = git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}'], { allowFailure: true });
  if (head.status !== 0) {
    return workingFiltered.restricted
      ? emptyOwnedIntersection('The ledger-owned path set does not intersect the reviewable changes; integration cannot settle on an empty owned intersection.')
      : { reviewable: false, kind: 'empty', range: null, paths: [], message: 'No reviewable changes; name a commit or range to review.' };
  }
  let range = null;
  let mergeBaseSha = null;
  let rangeOwned = { paths: [], restricted: workingFiltered.restricted };
  let baseSha = null;
  if (baseRevision) {
    // A design-run baseline replaces the merge-base; a non-ancestor (e.g. after rebase) fails closed.
    baseSha = verifyCommit(repoRoot, baseRevision);
    const ancestor = git(repoRoot, ['merge-base', '--is-ancestor', baseSha, 'HEAD'], { allowFailure: true });
    if (ancestor.status !== 0) {
      throw new Error(`Base revision ${baseRevision} is not an ancestor of HEAD; supply a replacement baseline.`);
    }
  } else {
    const base = resolveBase(repoRoot);
    if (base) {
      const mergeBase = git(repoRoot, ['merge-base', base, 'HEAD'], { allowFailure: true });
      if (mergeBase.status !== 0) {
        throw new Error(`Cannot resolve merge-base for ${base}; history may be shallow or unrelated.`);
      }
      baseSha = mergeBase.stdout.trim();
    }
  }
  if (baseSha && baseSha !== head.stdout.trim()) {
    range = `${baseSha}..HEAD`;
    rangeOwned = filterAllowed(rangePaths(repoRoot, range), allowedPaths);
    mergeBaseSha = baseSha;
  }
  const union = [...new Set([...(rangeOwned?.paths ?? []), ...workingFiltered.paths])].sort();
  if (workingFiltered.restricted && union.length === 0) {
    return emptyOwnedIntersection('The ledger-owned path set does not intersect the reviewable changes; integration cannot settle on an empty owned intersection.');
  }
  if (union.length === 0) {
    return { reviewable: false, kind: 'empty', range: null, paths: [], message: 'No reviewable changes; name a commit or range to review.' };
  }
  return {
    reviewable: true,
    kind: range ? 'branch' : 'working-tree',
    range,
    paths: union,
    ...(mergeBaseSha ? { baseSha: mergeBaseSha } : {}),
    headSha: head.stdout.trim(),
    reviewScope: range ? `Branch range: ${range}` : 'Current staged, unstaged, and untracked changes',
    ...(rangeOwned?.restricted ? { disclosure: `Owned-path restriction: ${union.join(', ')}; unrelated range paths excluded; working-tree owned changes included.` } : {}),
  };
}

export function verifyFreshness({ walkthroughPath, repoRoot = process.cwd() }) {
  repoRoot = path.resolve(repoRoot);
  const resolvedPath = path.isAbsolute(walkthroughPath)
    ? walkthroughPath
    : path.resolve(repoRoot, walkthroughPath);

  const artifact = readArtifact(resolvedPath, { kind: 'code' });
  const { metadata } = artifact;
  if (!metadata) {
    throw new Error(`Walkthrough "${walkthroughPath}" is not checkpointed (missing dispatch metadata).`);
  }

  if (metadata.baseSha !== metadata.headSha) {
    throw new Error('Range checkpoints are not statelessly verifiable without invocation state.');
  }

  const contentFresh = semanticSectionHashes(artifact.source).contentHash === metadata.contentHash;
  const snapshot = captureReviewSnapshot({
    repoRoot,
    scope: {
      reviewable: true,
      kind: 'working-tree',
      range: null,
      paths: [],
      reviewScope: 'Current staged, unstaged, and untracked changes',
    },
  });

  const worktreeFresh = snapshot.worktreeHash === metadata.worktreeHash;
  const headFresh = (snapshot.headSha ?? null) === (metadata.headSha ?? null);
  const changedPaths = changedKeys(metadata.pathHashes ?? {}, snapshot.pathHashes ?? {});

  return {
    fresh: contentFresh && worktreeFresh && headFresh,
    contentFresh,
    worktreeFresh,
    headFresh,
    changedPaths,
  };
}

function parseArgs(argv) {
  const out = { repoRoot: process.cwd(), explicitRange: null, verifyFreshness: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo-root') out.repoRoot = path.resolve(argv[++i] ?? '');
    else if (arg === '--range') out.explicitRange = argv[++i] ?? '';
    else if (arg === '--base') out.baseRevision = argv[++i] ?? '';
    else if (arg === '--verify-freshness') out.verifyFreshness = argv[++i] ?? '';
    else if (arg === '-h' || arg === '--help') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

const USAGE = `Usage:
  node resolve-review-range.mjs [--repo-root <path>] [--range <commit|a..b|a...b> | --base <commit>]
  node resolve-review-range.mjs [--repo-root <path>] --verify-freshness <walkthrough>
`;

function main() {
  const integrity = verifySkillIntegrity(path.resolve(__dirname, '..'));
  if (!integrity.valid && !integrity.missing) throw new Error(`Skill integrity failure: ${integrity.violations.join(', ')}`);
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return process.stdout.write(USAGE);
  if (args.verifyFreshness !== null) {
    try {
      const result = verifyFreshness({ walkthroughPath: args.verifyFreshness, repoRoot: args.repoRoot });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.fresh ? 0 : 1;
      return;
    } catch (err) {
      process.stderr.write(`[resolve-review-range] ${err.message}\n`);
      process.exitCode = 2;
      return;
    }
  }
  process.stdout.write(`${JSON.stringify(resolveReviewScope(args), null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[resolve-review-range] ${err.message}\n`);
    process.exit(1);
  }
}
