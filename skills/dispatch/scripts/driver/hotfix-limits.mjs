// @ts-check
/**
 * Hot-fix hard limits: the repository fingerprint captured when a hot fix starts and the violations
 * judged against it. The driver sees effects, not commands, so every limit is an observable change.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { currentHead, indexFingerprint, snapshotContent, snapshotEntries } from '../lib/git-state.mjs';
import { SENSITIVE_DIR_PATTERNS, SENSITIVE_FILE_BASENAME_PATTERNS, SENSITIVE_FILE_PATTERNS } from '../runners/shared.mjs';
import { headContent } from './discard.mjs';

// SECTION: Fingerprint

const sensitive = file => SENSITIVE_FILE_PATTERNS.some(pattern => pattern.test(file)) || SENSITIVE_FILE_BASENAME_PATTERNS.some(pattern => pattern.test(path.posix.basename(file))) || SENSITIVE_DIR_PATTERNS.some(pattern => pattern.test(`/${file}`));
const stashList = repoRoot => spawnSync('git', ['-C', repoRoot, 'stash', 'list', '--format=%H'], { encoding: 'utf8' }).stdout ?? '';
// Git status omits ignored files. Collapsed ignored entries (one per ignored directory) expose deletions;
// secrets files are listed at any depth and hashed, so nested, created, and edited secrets are all visible.
function ignoredManifest(repoRoot) {
  const list = args => {
    const run = spawnSync('git', ['-C', repoRoot, 'ls-files', '--others', '--ignored', '--exclude-standard', ...args, '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 });
    // A partial listing would report false deletions or miss secrets.
    if (run.error || run.status !== 0) throw new Error(`Ignored-path listing failed: ${run.error?.message ?? run.stderr}`);
    return run.stdout.split('\0').filter(Boolean);
  };
  const manifest = Object.fromEntries(list(['--directory']).map(file => [file, 'present']));
  for (const file of list([]).filter(file => sensitive(file))) {
    // An unreadable or vanishing file is still compared for presence.
    try { manifest[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(repoRoot, file))).digest('hex'); } catch { manifest[file] = 'present'; }
  }
  return manifest;
}
// Git reports nothing under .git/, so its mutable configuration is fingerprinted directly.
function gitMetadata(repoRoot) {
  const gitDir = path.resolve(repoRoot, spawnSync('git', ['-C', repoRoot, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).stdout.trim());
  const hash = crypto.createHash('sha256');
  const visit = rel => {
    const full = path.join(gitDir, rel), stat = fs.statSync(full, { throwIfNoEntry: false });
    if (stat?.isDirectory()) for (const name of fs.readdirSync(full).sort()) visit(path.join(rel, name));
    else if (stat) hash.update(`${rel}\0`).update(fs.readFileSync(full));
  };
  for (const rel of ['config', 'hooks', 'info']) visit(rel);
  return hash.digest('hex');
}

/**
 * The fingerprint a hot fix is judged against, from the tree snapshot taken when it starts.
 * @param {string} repoRoot @param {{ entries: Record<string, any> }} start
 */
export function captureLimits(repoRoot, start) {
  return { state: start, entries: snapshotEntries(repoRoot, Object.keys(start.entries)), head: currentHead(repoRoot), index: indexFingerprint(repoRoot).digest, stash: stashList(repoRoot), git: gitMetadata(repoRoot), ignored: ignoredManifest(repoRoot) };
}

// SECTION: Violations

export const inRedWindow = data => data.phase === 'implementation' && data.redCriteria?.length > 0 && !data.redValidated;
function existedAtTaskStart(state, file, before) {
  const entry = state.ordinary.taskStart?.entries?.[file];
  if (!state.ordinary.taskStart) return before !== null;
  return entry ? entry.objectId !== 'absent' : headContent(state.repoRoot, file) !== null;
}
/** A path's content when the hot fix started; null when it was absent. */
export function startContent(state, file) {
  const entry = state.ordinary.hotfix.start.entries.find(item => item.path === file);
  if (entry) return entry.mode === 'absent' ? null : snapshotContent(state.repoRoot, entry);
  return headContent(state.repoRoot, file);
}
/** Hard-limit violations in the tree since the hot fix started. */
export function limitViolations(state, touched) {
  const data = state.ordinary, fix = data.hotfix, repoRoot = state.repoRoot;
  // The driver sees effects, not commands: HEAD, index, and stash fingerprints expose git writes.
  const violations = [
    ...(currentHead(repoRoot) !== fix.start.head ? ['HEAD moved (history-writing git command)'] : []),
    ...(indexFingerprint(repoRoot).digest !== fix.start.index ? ['index changed (staging or restore)'] : []),
    ...(stashList(repoRoot) !== fix.start.stash ? ['stash list changed'] : []),
    ...(gitMetadata(repoRoot) !== fix.start.git ? ['.git/ config, hooks, or info changed'] : []),
  ];
  const ignored = ignoredManifest(repoRoot), started = fix.start.ignored ?? {};
  for (const [file, stamp] of Object.entries(started)) {
    if (!(file in ignored)) violations.push(`${file}: deleted an ignored path`);
    else if (ignored[file] !== stamp) violations.push(`${file}: secrets path (ignored)`);
  }
  for (const file of Object.keys(ignored)) if (!(file in started) && sensitive(file)) violations.push(`${file}: created an ignored secrets path`);
  for (const file of touched) {
    if (sensitive(file)) violations.push(`${file}: secrets path`);
    const content = startContent(state, file);
    if (content !== null && !fs.existsSync(path.join(repoRoot, file)) && existedAtTaskStart(state, file, content)) violations.push(`${file}: deleted a file that existed at task start`);
    if (inRedWindow(data) && !data.testsOnlyPaths.includes(file)) violations.push(`${file}: production path before RED validates`);
  }
  return violations;
}
