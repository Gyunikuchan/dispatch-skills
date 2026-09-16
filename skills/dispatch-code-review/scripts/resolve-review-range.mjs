#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isMainModule, verifySkillIntegrity } from '../../dispatch/scripts/common.mjs';

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

function currentPaths(repoRoot) {
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

export function resolveReviewScope({ repoRoot = process.cwd(), explicitRange = null } = {}) {
  repoRoot = path.resolve(repoRoot);
  if (explicitRange) {
    const range = resolveExplicitRange(repoRoot, explicitRange);
    return { reviewable: true, kind: 'explicit-range', range, paths: [], reviewScope: `Explicit Git range: ${range}` };
  }
  const paths = currentPaths(repoRoot);
  if (paths.length > 0) {
    return {
      reviewable: true,
      kind: 'working-tree',
      range: null,
      paths,
      reviewScope: 'Current staged, unstaged, and untracked changes',
    };
  }
  const head = git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}'], { allowFailure: true });
  if (head.status !== 0) {
    return { reviewable: false, kind: 'empty', range: null, paths: [], message: 'No reviewable changes; name a commit or range to review.' };
  }
  const base = resolveBase(repoRoot);
  if (!base) {
    return { reviewable: false, kind: 'empty', range: null, paths: [], message: 'No reviewable changes; name a commit or range to review.' };
  }
  const mergeBase = git(repoRoot, ['merge-base', base, 'HEAD'], { allowFailure: true });
  if (mergeBase.status !== 0) {
    throw new Error(`Cannot resolve merge-base for ${base}; history may be shallow or unrelated.`);
  }
  if (mergeBase.stdout.trim() === head.stdout.trim()) {
    return { reviewable: false, kind: 'empty', range: null, paths: [], message: 'No reviewable changes; name a commit or range to review.' };
  }
  const range = `${mergeBase.stdout.trim()}..HEAD`;
  return { reviewable: true, kind: 'branch', range, paths: [], reviewScope: `Branch range: ${range}` };
}

function parseArgs(argv) {
  const out = { repoRoot: process.cwd(), explicitRange: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo-root') out.repoRoot = path.resolve(argv[++i] ?? '');
    else if (arg === '--range') out.explicitRange = argv[++i] ?? '';
    else if (arg === '-h' || arg === '--help') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

const USAGE = `Usage:
  node resolve-review-range.mjs [--repo-root <path>] [--range <commit|a..b|a...b>]
`;

function main() {
  const integrity = verifySkillIntegrity(path.resolve(__dirname, '..'));
  if (!integrity.valid && !integrity.missing) throw new Error(`Skill integrity failure: ${integrity.violations.join(', ')}`);
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return process.stdout.write(USAGE);
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
