// `checkout`: driver-owned private Git worktrees under `<runDir>/wt/`. Every op is idempotent on retry; only
// `deliver` and `trim` write the caller checkout, and both refuse paths the caller changed since the driver bound them.

import path from 'node:path';
import crypto from 'node:crypto';
import { stableValue } from '../domain/stable-value.ts';
import type { CheckoutOp, Effect, Handler, Ports, RecoveryCapability } from '../core/types.ts';
import { effectDigest } from '../domain/effect-digest.ts';
import { portableEffect } from '../lib/portable-effect.ts';

type CheckoutEffect = Extract<Effect, { kind: 'checkout' }>;
type Row = Readonly<Record<string, unknown>>;

export type CheckoutDeps = {
  cwd: string;
  /** Directory links (junctions on Windows) let worktrees reuse ignored dependency directories without copying. */
  links: { create(target: string, link: string): void; remove(link: string): void };
};

// NOTE: private checkpoint commits must not run caller hooks (slow gates, commit-msg policy) or prompt for signing.
const COMMIT = ['-c', 'user.name=dispatch', '-c', 'user.email=dispatch@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=.dispatch-no-hooks'];
export const BASELINE_TRAILER = 'Dispatch-Baseline:';
export const CANDIDATE_TRAILER = 'Dispatch-Candidate:';
export const RESOLVES_TRAILER = 'Dispatch-Resolves:';
// NOTE: only whole-line start/end markers count; a bare `=======` line is valid Markdown and test-fixture content.
const CONFLICT_MARKER = /^(?:<{7}|>{7})(?: |$)/m;

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const bindingHash = (value: unknown): string => crypto.createHash('sha256').update(stableValue(value)).digest('hex');
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const split = (output: string): string[] => output.split('\0').filter(Boolean);
const safe = (file: string): boolean => !!file && !file.includes('\\') && !file.startsWith('/') && !/^[A-Za-z]:/.test(file)
  && !/[\x00-\x1f]/.test(file) && !file.split('/').some((part) => !part || part === '.' || part === '..' || part.includes(':') || part.endsWith('.') || part.endsWith(' ')) && !/^\.git(?:\/|$)/i.test(file);

/** Shared shape, path and content validation for the RED replay and read-only submission preview. */
export function validateRedCheckpoint(value: unknown, permittedPaths: readonly string[]): { files: Record<string, string | null>; defects: string[] } {
  const defects: string[] = [];
  const object = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Row : null;
  let inputFiles: Record<string, unknown> = {};
  if (!object || object['schemaVersion'] !== 1 || typeof object['files'] !== 'object' || object['files'] === null || Array.isArray(object['files'])) defects.push('RED checkpoint must be { schemaVersion: 1, files }.');
  else inputFiles = object['files'] as Record<string, unknown>;
  const entries = Object.entries(inputFiles);
  if (!defects.length && !entries.length) defects.push('RED checkpoint lists no test files.');
  const permitted = new Set(permittedPaths);
  const files = Object.fromEntries(entries.flatMap(([file, content]) => {
    if (!safe(file) || !permitted.has(file)) { defects.push(`RED checkpoint path is not an approved task test path: ${file}`); return []; }
    if (content !== null && typeof content !== 'string') { defects.push(`RED checkpoint content must be base64 or null: ${file}`); return []; }
    return [[file, content as string | null]];
  }));
  return { files, defects };
}

export function worktreePath(runDir: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) throw new Error(`Invalid worktree name: ${name}`);
  return path.join(runDir, 'wt', name);
}

async function head(ports: Ports, cwd: string): Promise<string> { return (await ports.git.run(['rev-parse', 'HEAD'], cwd)).trim(); }
async function clean(ports: Ports, cwd: string): Promise<boolean> { return !(await ports.git.run(['status', '--porcelain', '-uall'], cwd)).trim(); }
async function commit(ports: Ports, cwd: string, message: string): Promise<string> {
  await ports.git.run(['add', '-A'], cwd);
  await ports.git.run([...COMMIT, 'commit', '-q', '--allow-empty', '--no-verify', '-m', message], cwd);
  return head(ports, cwd);
}

function link(deps: CheckoutDeps, ports: Ports, root: string, links: readonly string[]): void {
  for (const name of links) {
    if (!safe(name) || name.includes('/')) throw new Error(`Invalid dependency link: ${name}`);
    const target = path.join(deps.cwd, name), at = path.join(root, name);
    if (!ports.fs.inspectPath(at)) deps.links.create(target, at);
  }
}

function unlink(deps: CheckoutDeps, ports: Ports, root: string, links: readonly string[]): void {
  for (const name of links) if (ports.fs.inspectPath(path.join(root, name))?.kind === 'symlink') deps.links.remove(path.join(root, name));
}

/** Creates or reuses a detached worktree at `revision`; a reused tree is reset when requested. */
async function worktree(deps: CheckoutDeps, ports: Ports, root: string, revision: string, reset: boolean, keep = false): Promise<void> {
  if (ports.fs.inspectPath(root)?.kind === 'directory') {
    if (keep) { await ports.git.run(['reset', '-q', '--mixed', revision], root); return; }
    if (reset) { await ports.git.run(['reset', '-q', '--hard', revision], root); await ports.git.run(['clean', '-q', '-fd'], root); }
    return;
  }
  ports.fs.mkdir(path.dirname(root), { recursive: true });
  await ports.git.run(['worktree', 'add', '-q', '--detach', root, revision], deps.cwd);
}

// NOTE: segments start alphanumeric and never hold `..`, so a ref is a valid Git ref name confined to the drafts namespace.
const DRAFT_SEGMENT = '[a-z0-9][a-z0-9.-]*';
const DRAFT_RUN = new RegExp(`^refs/dispatch/drafts/${DRAFT_SEGMENT}$`), DRAFT_REF = new RegExp(`^refs/dispatch/drafts/${DRAFT_SEGMENT}/${DRAFT_SEGMENT}$`);
const draftName = (ref: string, pattern: RegExp): boolean => pattern.test(ref) && !ref.includes('..') && !/(?:\.|\.lock)(?:\/|$)/.test(ref);

/**
 * Keeps a task draft under its run-owned ref before a hard reset discards it. An existing ref proves an earlier attempt of
 * this effect kept the draft, so a replay goes straight to the reset and never overwrites it. Without `snapshot` it is a no-op.
 */
async function snapshotDraft(ports: Ports, root: string, input: Row, resets: boolean): Promise<Row> {
  if (input['snapshot'] === undefined) return {};
  const ref = text(input['snapshot']);
  if (!draftName(ref, DRAFT_REF)) throw new Error(`Invalid draft snapshot ref: ${ref || '(none)'}`);
  if (!resets || ports.fs.inspectPath(root)?.kind !== 'directory') return { snapshot: null };
  if ((await ports.git.run(['rev-parse', '-q', '--verify', ref], root).catch(() => '')).trim()) return { snapshot: ref };
  const dirty = !await clean(ports, root), current = await head(ports, root);
  // A clean tree at the input (or the prior input the worktree was created at) holds no draft.
  if (!dirty && [text(input['revision']), text(input['draftBase'])].includes(current)) return { snapshot: null };
  if (dirty) {
    await ports.git.run(['add', '-A'], root);
    await ports.git.run([...COMMIT, 'commit', '-q', '--no-verify', '-m', `dispatch draft ${ref}`], root);
  }
  const revision = await head(ports, root);
  // NOTE: the zero old value makes Git refuse to move an existing ref, so a concurrent or replayed write cannot replace a kept draft.
  await ports.git.run(['update-ref', ref, revision, '0'.repeat(revision.length)], root);
  return { snapshot: ref };
}

/** Copies content and permission bits so executable files survive baseline capture and delivery. */
function copy(ports: Ports, from: string, to: string): void {
  ports.fs.mkdir(path.dirname(to), { recursive: true });
  ports.fs.writeBase64Atomic(to, ports.fs.readBase64(from));
  const mode = ports.fs.inspectPath(from)?.mode;
  if (mode !== undefined) ports.fs.setMode(to, mode & 0o777);
}

/** Task and RED trees get the dependency links and the ignored root files (local config) the baseline copied. */
function prepare(deps: CheckoutDeps, ports: Ports, root: string, input: Row): void {
  link(deps, ports, root, strings(input['links']));
  for (const file of strings(input['ignored'])) {
    if (!safe(file) || file.includes('/')) throw new Error(`Invalid ignored input: ${file}`);
    if (ports.fs.inspectPath(path.join(deps.cwd, file))?.kind === 'file') copy(ports, path.join(deps.cwd, file), path.join(root, file));
  }
}

/** Discards uncommitted leftovers (verification output, an interrupted cherry-pick) at the recorded head. */
// NOTE: `reset --hard` also removes CHERRY_PICK_HEAD, so a discard aborts an in-progress cherry-pick.
async function discard(ports: Ports, root: string, revision: string): Promise<void> {
  await ports.git.run(['reset', '-q', '--hard', revision], root);
  await ports.git.run(['clean', '-q', '-fd'], root);
}

async function pickHead(ports: Ports, root: string): Promise<string> {
  return (await ports.git.run(['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'], root).catch(() => '')).trim();
}
async function unmerged(ports: Ports, root: string): Promise<string[]> {
  return [...new Set(split(await ports.git.run(['diff', '--name-only', '--diff-filter=U', '-z'], root).catch(() => '')))].sort();
}

/** True when the path or an ancestor is not a plain file/directory inside the caller checkout (a link would redirect a write or delete). */
function redirected(deps: CheckoutDeps, ports: Ports, callerRoot: string, file: string): boolean {
  const info = ports.fs.inspectPath(path.join(deps.cwd, file)), parts = file.split('/');
  const ancestors = parts.slice(0, -1).map((_, index) => ports.fs.inspectPath(path.join(deps.cwd, ...parts.slice(0, index + 1))));
  return (!!info && info.kind !== 'file') || ancestors.some((item) => item && (item.kind !== 'directory' || !item.realPath || path.relative(callerRoot, item.realPath).startsWith('..') || path.isAbsolute(path.relative(callerRoot, item.realPath))));
}

// SECTION: Ops

async function init(deps: CheckoutDeps, ports: Ports, runDir: string, input: Row): Promise<Row> {
  const root = worktreePath(runDir, 'integration');
  if (input['rebase'] === true && !ports.fs.inspectPath(worktreePath(runDir, text(input['archivedName']))) && ports.fs.inspectPath(root)) {
    await ports.git.run(['worktree', 'move', root, worktreePath(runDir, text(input['archivedName']))], deps.cwd);
  }
  const runRelative = path.relative(deps.cwd, runDir).split(path.sep).join('/');
  const ignored = split(await ports.git.run(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], deps.cwd));
  const linked = ignored.filter((entry) => /^[^/]+\/$/.test(entry) && !runRelative.startsWith(entry)).map((entry) => entry.slice(0, -1));
  const copiedIgnored = ignored.filter((entry) => !entry.includes('/'));
  const unreproduced = ignored.filter((entry) => !linked.includes(entry.replace(/\/$/, '')) && !copiedIgnored.includes(entry) && !runRelative.startsWith(entry));
  const replayInput = isRow(input['replay']) ? input['replay'] : null;
  if (ports.fs.inspectPath(root)?.kind === 'directory') {
    const baseline = replayInput ? (await ports.git.run(['rev-list', '-1', `--grep=${BASELINE_TRAILER}`, '--fixed-strings', 'HEAD', '--'], root).catch(() => '')).trim() : '';
    const message = await ports.git.run(['log', '-1', '--format=%B', ...(baseline ? [baseline] : [])], root);
    if (message.includes(BASELINE_TRAILER) && (replayInput || await clean(ports, root))) {
      const reused = { path: root, base: baseline || await head(ports, root), manifest: JSON.parse(message.slice(message.indexOf(BASELINE_TRAILER) + BASELINE_TRAILER.length).trim()) as Row };
      return replayInput ? replay(ports, root, reused, replayInput) : reused;
    }
    throw new Error('Integration worktree exists without a completed baseline; inspect or remove it before retrying.');
  }
  await worktree(deps, ports, root, 'HEAD', false);
  const tracked = split(await ports.git.run(['diff', '--name-only', '-z', 'HEAD', '--'], deps.cwd));
  const untracked = split(await ports.git.run(['ls-files', '--others', '--exclude-standard', '-z'], deps.cwd)).filter((file) => !file.endsWith('/'));
  const copied: string[] = [], deleted: string[] = [];
  for (const file of [...new Set([...tracked, ...untracked])].sort()) {
    if (!safe(file)) throw new Error(`Unsupported caller path: ${file}`);
    const source = path.join(deps.cwd, file), info = ports.fs.inspectPath(source);
    if (info?.kind === 'symlink' || info?.kind === 'directory') throw new Error(`Caller baseline cannot reproduce ${info.kind}: ${file}`);
    if (info) { copy(ports, source, path.join(root, file)); copied.push(file); } else { ports.fs.remove(path.join(root, file)); deleted.push(file); }
  }
  for (const file of copiedIgnored) if (ports.fs.inspectPath(path.join(deps.cwd, file))?.kind === 'file') copy(ports, path.join(deps.cwd, file), path.join(root, file));
  link(deps, ports, root, linked);
  for (const file of copied) if (ports.fs.hashFile(path.join(deps.cwd, file)) !== ports.fs.hashFile(path.join(root, file))) throw new Error(`Caller baseline copy differs: ${file}`);
  for (const file of deleted) if (ports.fs.inspectPath(path.join(root, file))) throw new Error(`Caller baseline deletion was not reproduced: ${file}`);
  const manifest = { copied, deleted, linked, copiedIgnored, unreproduced };
  const base = await commit(ports, root, `dispatch baseline\n\n${BASELINE_TRAILER} ${JSON.stringify(manifest)}`);
  return replayInput ? replay(ports, root, { path: root, base, manifest }, replayInput) : { path: root, base, manifest };
}

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Replays archived commits in order. Commit provenance proves completed picks on retry; conflicts stay in place.
 */
async function replay(ports: Ports, root: string, baseline: { path: string; base: string; manifest: Row }, input: Row): Promise<Row> {
  const from = text(input['base']), to = text(input['head']);
  if (!from || !to) throw new Error('replay requires the archived integration base and head');
  // NOTE: `--` skips Git's filename check, which fails with ENAMETOOLONG for a range under a deep Windows worktree.
  const commits = (await ports.git.run(['rev-list', '--reverse', `${from}..${to}`, '--'], root)).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const replayed: { from: string; to: string }[] = [];
  const retained = (await ports.git.run(['rev-list', '--reverse', `${baseline.base}..HEAD`, '--'], root)).trim().split(/\r?\n/).filter(Boolean);
  for (const revision of retained) {
    const message = await ports.git.run(['log', '-1', '--format=%B', revision], root);
    const source = commits.find((candidate) => message.includes(`(cherry picked from commit ${candidate})`) || message.includes(`${CANDIDATE_TRAILER} ${candidate}`));
    if (!source) throw new Error(`Delivery replay contains an unbound commit: ${revision}`);
    const prior = replayed.find((row) => row.from === source);
    if (prior) prior.to = revision;
    else {
      if (source !== commits[replayed.length]) throw new Error('Delivery replay commits are out of order');
      replayed.push({ from: source, to: revision });
    }
  }
  for (const commit of commits) {
    if (replayed.some((row) => row.from === commit)) continue;
    const active = (await ports.git.run(['rev-parse', '--verify', 'CHERRY_PICK_HEAD'], root).catch(() => '')).trim();
    if (active && active !== commit) throw new Error('Delivery replay has an unrelated cherry-pick');
    try {
      if (active) throw new Error('retained cherry-pick needs resolution');
      await ports.git.run([...COMMIT, 'cherry-pick', '--allow-empty', '--keep-redundant-commits', '-x', commit], root);
    } catch (error) {
      if (await pickHead(ports, root) !== commit) throw error;
      const paths = await unmerged(ports, root);
      const candidatePaths = split(await ports.git.run(['diff', '--name-only', '-z', `${commit}^`, commit, '--'], root)).sort();
      return { ...baseline, head: await head(ports, root), candidate: commit, candidatePaths, conflict: true, paths, detail: `replay of ${commit}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`, replayed };
    }
    replayed.push({ from: commit, to: await head(ports, root) });
  }
  return { ...baseline, head: await head(ports, root), conflict: false, replayed };
}

async function submit(ports: Ports, root: string, base: string, message: string): Promise<Row> {
  const current = await head(ports, root);
  const revision = current !== base && await clean(ports, root) ? current : await commit(ports, root, message);
  const parent = (await ports.git.run(['rev-parse', `${revision}^`], root)).trim();
  if (parent !== base) throw new Error(`Task candidate ${revision} does not descend directly from its input ${base}.`);
  return { revision, paths: split(await ports.git.run(['diff', '--name-only', '-z', base, revision, '--'], root)).sort() };
}

async function red(deps: CheckoutDeps, ports: Ports, root: string, input: Row): Promise<Row> {
  const defects: string[] = [];
  const permitted = new Set(strings(input['permitted']));
  let files: Record<string, unknown> = {};
  const checkpoint = text(input['checkpointPath']);
  if (!checkpoint || !ports.fs.exists(checkpoint)) defects.push(`RED checkpoint is missing: ${checkpoint || '(none)'}`);
  else {
    try {
      const checked = validateRedCheckpoint(JSON.parse(ports.fs.readText(checkpoint)), [...permitted]);
      files = checked.files;
      defects.push(...checked.defects);
    } catch (error) { defects.push(`RED checkpoint is invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const entries = Object.entries(files);
  if (defects.length) return { path: root, defects };
  await worktree(deps, ports, root, text(input['base']), true);
  prepare(deps, ports, root, input);
  const candidate = text(input['candidate']);
  for (const [file, value] of entries) {
    const target = path.join(root, file);
    if (value === null) ports.fs.remove(target);
    else { ports.fs.mkdir(path.dirname(target), { recursive: true }); ports.fs.writeBase64Atomic(target, value as string); }
    // NOTE: checkpointed tests are immutable; GREEN must run the same tests RED replayed.
    const replayed = value === null ? null : (await ports.git.run(['hash-object', '--', file], root)).trim();
    if (replayed !== ((await entry(ports, root, candidate, file))?.blob ?? null)) defects.push(`Submitted test differs from its RED checkpoint: ${file}`);
  }
  return { path: root, defects, files: entries.map(([file]) => file).sort() };
}

async function integrate(ports: Ports, root: string, input: Row): Promise<Row> {
  const candidate = text(input['candidate']), expected = text(input['expected']);
  const current = await head(ports, root);
  if (current !== expected) {
    const log = await ports.git.run(['log', '--format=%B', `${expected}..${current}`], root).catch(() => '');
    if (log.includes(`${CANDIDATE_TRAILER} ${candidate}`)) return { revision: current, conflict: false, reused: true };
    throw new Error(`Integration head ${current} moved from the recorded revision ${expected}.`);
  }
  // NOTE: a kept conflict for this candidate holds the orchestrator's in-progress resolution; never reset it on retry.
  if (await pickHead(ports, root) === candidate) return { revision: expected, conflict: true, paths: await unmerged(ports, root), reused: true };
  await discard(ports, root, expected);
  try {
    await ports.git.run([...COMMIT, 'cherry-pick', '--no-commit', candidate], root);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    const conflicts = await unmerged(ports, root);
    if (!conflicts.length) { await discard(ports, root, expected); throw new Error(`Cherry-pick of ${candidate} failed without conflicts: ${detail}`); }
    // NOTE: `cherry-pick --no-commit` records no CHERRY_PICK_HEAD; record it so a retry or crash recovery finds this conflict.
    await ports.git.run(['update-ref', 'CHERRY_PICK_HEAD', candidate], root);
    return { revision: expected, conflict: true, paths: conflicts, detail };
  }
  const revision = await commit(ports, root, `dispatch integrate ${text(input['task'])}\n\n${CANDIDATE_TRAILER} ${candidate}`);
  return { revision, conflict: false };
}

/**
 * Commits the orchestrator's conflict resolution in the integration worktree. Attempt 1 starts at the pre-pick head with
 * the candidate's cherry-pick in progress; a repair attempt starts at the prior resolution. Refusals leave the tree as is.
 */
async function resolve(ports: Ports, root: string, input: Row): Promise<Row> {
  const candidate = text(input['candidate']), expected = text(input['expected']), attempt = input['attempt'];
  // NOTE: `base` is the pre-pick head; scope covers the whole retained delta from it, not only this attempt's.
  const base = text(input['base']) || expected;
  const tasks = strings(input['tasks']), permitted = new Set(strings(input['permitted']));
  if (!candidate || !expected || !Number.isSafeInteger(attempt) || Number(attempt) < 1 || !tasks.length || tasks.some((task) => !task.trim() || /[\s,]/.test(task)) || [...permitted].some((file) => !safe(file))) {
    throw new Error('resolve requires a candidate, an expected head, a positive attempt, task ids, and repository-relative permitted paths');
  }
  const resolves = `${RESOLVES_TRAILER} ${tasks.join(',')} attempt ${Number(attempt)}`;
  const carries = (message: string, trailer: string) => message.split(/\r?\n/).some((line) => line.trim() === trailer);
  const current = await head(ports, root);
  if (current !== expected) {
    // Replay of a completed attempt: the head is this attempt's commit directly on `expected` and nothing changed since.
    const message = await ports.git.run(['log', '-1', '--format=%B', current], root);
    const parent = (await ports.git.run(['rev-parse', `${current}^`], root).catch(() => '')).trim();
    if (parent === expected && carries(message, resolves) && carries(message, `${CANDIDATE_TRAILER} ${candidate}`) && await clean(ports, root)) {
      const paths = split(await ports.git.run(['diff', '--name-only', '-z', expected, current, '--'], root)).sort();
      // NOTE: a replay must not accept a commit made under a wider permitted set than this input carries.
      const retained = split(await ports.git.run(['diff', '--name-only', '-z', base, current, '--'], root)).sort();
      const outside = [...new Set([...paths, ...retained])].filter((file) => !safe(file) || !permitted.has(file));
      if (outside.length) throw new Error(`Recovered resolution ${current} changes paths outside the permitted set: ${outside.join(', ')}.`);
      return { revision: current, paths, retained, reused: true };
    }
    throw new Error(`Integration head ${current} moved from the resolution input ${expected}.`);
  }
  if (Number(attempt) === 1) {
    if (await pickHead(ports, root) !== candidate) throw new Error(`No cherry-pick of ${candidate} is in progress at ${expected}.`);
  } else if (!carries(await ports.git.run(['log', '-1', '--format=%B', expected], root), `${CANDIDATE_TRAILER} ${candidate}`)) {
    throw new Error(`Repair input ${expected} is not a resolution of ${candidate}.`);
  }
  const refuse = (refused: string, paths: readonly string[], detail: string): Row => ({ revision: expected, refused, paths: [...paths].sort(), detail });
  const conflicted = await unmerged(ports, root);
  // NOTE: include staged changes: a staged blob whose working file was restored would otherwise reach the commit unscanned.
  const tracked = split(await ports.git.run(['diff', '--name-only', '-z', expected, '--'], root));
  const staged = split(await ports.git.run(['diff', '--cached', '--name-only', '-z', expected, '--'], root));
  const untracked = split(await ports.git.run(['ls-files', '--others', '--exclude-standard', '-z'], root));
  const changed = [...new Set([...tracked, ...staged, ...untracked, ...conflicted])].sort();
  // NOTE: scan every changed file, not only unmerged entries: repair attempts have none, and staging drops a file from them.
  const marked = changed.filter((file) => {
    if (!safe(file)) return false;
    const absolute = path.join(root, file);
    return ports.fs.inspectPath(absolute)?.kind === 'file' && CONFLICT_MARKER.test(ports.fs.readText(absolute));
  });
  if (marked.length) return refuse('markers', marked, 'conflict markers remain in resolution files');
  const prior = base === expected ? [] : split(await ports.git.run(['diff', '--name-only', '-z', base, expected, '--'], root));
  const outside = [...new Set([...changed, ...prior])].filter((file) => !safe(file) || !permitted.has(file));
  // NOTE: `retained` names out-of-scope paths earlier attempts already committed; only those need a discard, working-tree paths stay repairable.
  if (outside.length) return { ...refuse('out-of-scope', outside, 'resolution retains paths outside the permitted set'), retained: prior.filter((file) => outside.includes(file)).sort() };
  if (!changed.length) return refuse('empty', [], 'resolution has no changes against the expected head');
  // NOTE: stage working content for every inspected path so the commit equals the scanned, verified working tree.
  await ports.git.run(['add', '-A', '--', ...changed], root);
  const remaining = await unmerged(ports, root);
  if (remaining.length) return refuse('unmerged', remaining, 'unmerged index entries remain after staging the resolution');
  if (!split(await ports.git.run(['diff', '--cached', '--name-only', '-z', expected, '--'], root)).length) return refuse('empty', [], 'resolution has no changes against the expected head');
  await ports.git.run([...COMMIT, 'commit', '-q', '--no-verify', '-m', `dispatch resolve ${tasks.join(',')}\n\n${CANDIDATE_TRAILER} ${candidate}\n${resolves}`], root);
  const revision = await head(ports, root);
  const paths = split(await ports.git.run(['diff', '--name-only', '-z', expected, revision, '--'], root)).sort();
  return { revision, paths, retained: split(await ports.git.run(['diff', '--name-only', '-z', base, revision, '--'], root)).sort() };
}

async function entry(ports: Ports, cwd: string, revision: string, file: string): Promise<{ mode: string; blob: string } | null> {
  const row = (await ports.git.run(['ls-tree', '-z', revision, '--', file], cwd)).split('\0')[0] ?? '';
  const match = /^(\d+) blob ([a-f0-9]+)\t/.exec(row);
  return match ? { mode: match[1]!, blob: match[2]! } : null;
}

async function deliver(deps: CheckoutDeps, ports: Ports, root: string, input: Row, probe = false): Promise<Row> {
  const base = text(input['base']), revision = text(input['revision']);
  if (await head(ports, root) !== revision) throw new Error(`Integration checkout is not at ${revision}.`);
  if (!probe) await discard(ports, root, revision);
  else if (!await clean(ports, root)) throw new Error('Recovery integration checkout has uncommitted content.');
  const files = split(await ports.git.run(['diff', '--name-only', '-z', base, revision, '--'], root)).sort();
  const callerRoot = ports.fs.inspectPath(deps.cwd)?.realPath ?? path.resolve(deps.cwd);
  const fileModes = (await ports.git.run(['config', '--bool', '--default=true', 'core.filemode'], deps.cwd)).trim() === 'true';
  const plan: { file: string; action: 'write' | 'delete' | 'already' }[] = [], conflicts: string[] = [];
  // Delivered blob ids bind a later transient trim to the exact content the driver verified.
  const blobs: Record<string, string> = {};
  for (const file of files) {
    if (!safe(file)) throw new Error(`Unsafe delivery path: ${file}`);
    const info = ports.fs.inspectPath(path.join(deps.cwd, file));
    // NOTE: a linked or replaced ancestor would redirect the write outside the caller checkout.
    if (redirected(deps, ports, callerRoot, file)) { conflicts.push(file); continue; }
    const caller = info ? (await ports.git.run(['hash-object', '--', file], deps.cwd)).trim() : null;
    const before = await entry(ports, root, base, file), after = await entry(ports, root, revision, file);
    const mode = info && fileModes ? info.mode & 0o111 ? '100755' : '100644' : null;
    const matches = (entry: { mode: string; blob: string } | null) => caller === (entry?.blob ?? null) && (!fileModes || (entry?.mode ?? null) === mode);
    if (after) blobs[file] = after.blob;
    if (matches(after)) plan.push({ file, action: 'already' });
    else if (matches(before)) plan.push({ file, action: after === null ? 'delete' : 'write' });
    else conflicts.push(file);
  }
  if (conflicts.length) return { conflicts, transferred: [], already: [], collision: { kind: 'newer-content', paths: conflicts, binding: bindingHash({ base, revision, conflicts }) } };
  if (probe && plan.some((item) => item.action !== 'already')) return { incomplete: true };
  for (const item of plan) {
    const target = path.join(deps.cwd, item.file);
    if (item.action === 'write') copy(ports, path.join(root, item.file), target);
    else if (item.action === 'delete') ports.fs.remove(target);
  }
  return { conflicts: [], transferred: plan.filter((item) => item.action !== 'already').map((item) => item.file), already: plan.filter((item) => item.action === 'already').map((item) => item.file), blobs };
}

export function checkoutRecovery(deps: CheckoutDeps): RecoveryCapability<CheckoutEffect> {
  return { async probe(effect, ports, ctx) {
    const unresolved = { status: 'unresolved' as const, evidence: 'No complete checkout proof; retry retains the original all-path preflight and scope' };
    const input = effect.input as Row, root = worktreePath(ctx.runDir, 'integration');
    let result: Row;
    if (effect.op === 'init' && !input['rebase'] && !input['replay']) {
      if (ports.fs.inspectPath(root)?.kind !== 'directory' || !await clean(ports, root)) return unresolved;
      const message = await ports.git.run(['log', '-1', '--format=%B'], root);
      const trailer = message.split(/\r?\n/).find((line) => line.startsWith(`${BASELINE_TRAILER} `));
      if (!trailer) return unresolved;
      const manifest = JSON.parse(trailer.slice(BASELINE_TRAILER.length).trim()) as Row;
      if (!['copied', 'deleted', 'linked', 'copiedIgnored', 'unreproduced'].every((key) => Array.isArray(manifest[key]) && strings(manifest[key]).length === (manifest[key] as unknown[]).length)) return unresolved;
      result = { path: root, base: await head(ports, root), manifest };
    } else if (effect.op === 'commit') {
      const taskRoot = worktreePath(ctx.runDir, text(input['name']));
      const revision = await head(ports, taskRoot), base = text(input['base']);
      if (revision === base || !await clean(ports, taskRoot) || (await ports.git.run(['rev-parse', `${revision}^`], taskRoot)).trim() !== base) return unresolved;
      result = { revision, paths: split(await ports.git.run(['diff', '--name-only', '-z', base, revision, '--'], taskRoot)).sort() };
    } else if (effect.op === 'resolve') {
      if (await head(ports, root) === text(input['expected'])) return unresolved;
      result = await resolve(ports, root, input);
    } else if (effect.op === 'deliver') {
      result = await deliver(deps, ports, root, input, true);
      if (result['incomplete'] || strings(result['conflicts']).length) return unresolved;
    } else if (effect.op === 'integrate') {
      const candidate = text(input['candidate']), expected = text(input['expected']), current = await head(ports, root);
      const parent = (await ports.git.run(['rev-parse', `${current}^`], root)).trim();
      const message = await ports.git.run(['log', '-1', '--format=%B', current], root);
      if (parent !== expected || !message.split(/\r?\n/).some((line) => line.trim() === `${CANDIDATE_TRAILER} ${candidate}`) || !await clean(ports, root)) return unresolved;
      result = { revision: current, conflict: false, reused: true };
    } else return unresolved;
    return { status: 'complete', effectId: effect.id, attempt: ctx.attempt, descriptorHash: effectDigest(portableEffect(effect, ctx.runDir)), evidence: `checkout ${effect.op} immutable revision and live byte proof`, results: [{ type: 'CHECKOUT_DONE', effectId: effect.id, op: effect.op, result }] };
  } };
}

/**
 * Deletes bound transient test files from the caller checkout. `hash` is the Git blob id (`git hash-object`) the driver
 * bound; every file is checked before any deletion, and an absent file counts as already trimmed. With `observe` it only
 * reports each listed caller file's blob id (null when absent), so the driver can bind trim and durable files at the review boundary.
 */
async function trim(deps: CheckoutDeps, ports: Ports, input: Row): Promise<Row> {
  if (input['observe'] !== undefined) {
    const files = strings(input['observe']);
    if (!files.length || files.some((file) => !safe(file))) throw new Error('trim observe requires repository-relative paths');
    const callerRoot = ports.fs.inspectPath(deps.cwd)?.realPath ?? path.resolve(deps.cwd);
    const observed: Record<string, string | null> = {};
    for (const file of files) {
      if (redirected(deps, ports, callerRoot, file)) throw new Error(`Observed path is redirected: ${file}`);
      observed[file] = ports.fs.inspectPath(path.join(deps.cwd, file))?.kind === 'file' ? (await ports.git.run(['hash-object', '--', file], deps.cwd)).trim() : null;
    }
    return { observed };
  }
  const allowed = new Set(strings(input['allowed']));
  const files = (Array.isArray(input['files']) ? input['files'] : []).map((item) => {
    const row = typeof item === 'object' && item !== null ? item as Row : {};
    return { file: text(row['path']), hash: text(row['hash']) };
  });
  if (!files.length || files.some((item) => !item.file || !item.hash)) throw new Error('trim requires files as { path, hash } entries');
  const callerRoot = ports.fs.inspectPath(deps.cwd)?.realPath ?? path.resolve(deps.cwd);
  const refused: { path: string; reason: string }[] = [], remove: string[] = [], already: string[] = [];
  for (const { file, hash } of files) {
    if (!allowed.has(file)) { refused.push({ path: file, reason: 'not-allowed' }); continue; }
    if (!safe(file)) { refused.push({ path: file, reason: 'unsafe' }); continue; }
    if (redirected(deps, ports, callerRoot, file)) { refused.push({ path: file, reason: 'redirected' }); continue; }
    if (!ports.fs.inspectPath(path.join(deps.cwd, file))) { already.push(file); continue; }
    if ((await ports.git.run(['hash-object', '--', file], deps.cwd)).trim() !== hash) { refused.push({ path: file, reason: 'changed' }); continue; }
    remove.push(file);
  }
  if (refused.length) return { trimmed: [], already: [], refused };
  for (const file of remove) ports.fs.remove(path.join(deps.cwd, file));
  return { trimmed: remove.sort(), already: already.sort(), refused: [] };
}

/** Replays a parked in-scope draft onto a new prerequisite base without modifying its original worktree. */
async function scopeRebase(deps: CheckoutDeps, ports: Ports, runDir: string, input: Row): Promise<Row> {
  const name = text(input['name']), originalName = text(input['originalName']), revision = text(input['revision']);
  const permitted = strings(input['permitted']), key = text(input['transferKey']);
  if (!key || !permitted.length || permitted.some((file) => !safe(file)) || new Set(permitted).size !== permitted.length) throw new Error('scope rebase requires a transfer key and unique repository-relative permitted paths');
  const marker = path.join(runDir, 'scope-transfers', `${crypto.createHash('sha256').update(key).digest('hex')}.json`);
  if (ports.fs.exists(marker)) {
    const prior = JSON.parse(ports.fs.readText(marker)) as Row;
    if (prior['revision'] !== revision || prior['path'] !== worktreePath(runDir, name)) throw new Error('scope transfer key was reused for a different destination or base');
    return prior;
  }
  const original = worktreePath(runDir, originalName), target = worktreePath(runDir, name);
  if (ports.fs.inspectPath(original)?.kind !== 'directory') throw new Error('scope rebase source worktree is missing');
  const targetInfo = ports.fs.inspectPath(target);
  if (targetInfo && targetInfo.kind !== 'directory') return { path: target, revision, conflict: true, conflicts: permitted, detail: 'scope rebase destination is not a worktree directory' };
  await worktree(deps, ports, target, revision, !!targetInfo);
  prepare(deps, ports, target, input);
  const quoted = ['--', ...permitted];
  const tracked = (await ports.git.run(['diff', '--name-only', '-z', 'HEAD', ...quoted], original)).split('\0').filter((file) => file && permitted.includes(file));
  const untracked = (await ports.git.run(['ls-files', '--others', '--exclude-standard', '-z'], original)).split('\0').filter((file) => file && permitted.includes(file));
  const changed = [...new Set([...tracked, ...untracked])].sort();
  const redirected = changed.filter((file) => {
    let ancestor = target;
    for (const part of file.split('/').slice(0, -1)) {
      ancestor = path.join(ancestor, part);
      if (ports.fs.inspectPath(ancestor)?.kind === 'symlink') return true;
    }
    return false;
  });
  if (redirected.length) return { path: target, revision, conflict: true, conflicts: redirected, detail: 'destination has a symlink ancestor for a permitted draft path' };
  const collisions = untracked.filter((file) => !!ports.fs.inspectPath(path.resolve(target, file)));
  if (collisions.length) return { path: target, revision, conflict: true, conflicts: collisions, detail: 'a new prerequisite already owns an untracked draft path' };

  const patch = await ports.git.run(['diff', '--binary', 'HEAD', ...quoted], original);
  const patchPath = path.join(runDir, `scope-${crypto.createHash('sha256').update(key).digest('hex')}.patch`);
  try {
    if (patch) {
      ports.fs.writeBase64Atomic(patchPath, Buffer.from(patch).toString('base64'));
      try { await ports.git.run(['apply', '--3way', '--whitespace=nowarn', patchPath], target); }
      catch (error) { return { path: target, revision, conflict: true, conflicts: tracked, detail: error instanceof Error ? error.message : String(error) }; }
    }
    for (const file of untracked) {
      const from = path.resolve(original, file), to = path.resolve(target, file);
      let ancestor = original;
      for (const part of file.split('/').slice(0, -1)) { ancestor = path.join(ancestor, part); if (ports.fs.inspectPath(ancestor)?.kind === 'symlink') throw new Error(`scope draft ancestor is a symlink: ${file}`); }
      const info = ports.fs.inspectPath(from);
      if (info?.kind === 'file') copy(ports, from, to);
      else if (info?.kind === 'symlink') { ports.fs.mkdir(path.dirname(to), { recursive: true }); ports.fs.writeLinkAtomic(to, info.linkTarget ?? ''); }
      else throw new Error(`unsupported untracked scope draft: ${file}`);
    }
    const stagedPaths = (await ports.git.run(['diff', '--name-only', '-z', revision, '--'], target)).split('\0').filter(Boolean);
    const transferredUntracked = (await ports.git.run(['ls-files', '--others', '--exclude-standard', '-z'], target)).split('\0').filter(Boolean);
    const outside = [...new Set([...stagedPaths, ...transferredUntracked])].filter((file) => !permitted.includes(file));
    if (outside.length) return { path: target, revision, conflict: true, conflicts: outside, detail: 'scope transfer produced paths outside its permitted set' };
    for (const file of untracked) {
      const from = ports.fs.inspectPath(path.resolve(original, file)), to = ports.fs.inspectPath(path.resolve(target, file));
      if (!from || !to || from.kind !== to.kind || from.kind === 'file' && ports.fs.readBase64(path.resolve(original, file)) !== ports.fs.readBase64(path.resolve(target, file)) || from.kind === 'symlink' && from.linkTarget !== to.linkTarget) return { path: target, revision, conflict: true, conflicts: [file], detail: 'untracked draft transfer verification failed' };
    }
    const result = { path: target, revision, conflict: false, transferred: changed, transferKey: key };
    ports.fs.mkdir(path.dirname(marker), { recursive: true });
    ports.fs.writeBase64Atomic(marker, Buffer.from(JSON.stringify(result)).toString('base64'));
    return result;
  } finally {
    if (ports.fs.exists(patchPath)) ports.fs.remove(patchPath);
  }
}

async function cleanup(deps: CheckoutDeps, ports: Ports, runDir: string, input: Row): Promise<Row> {
  const drafts = input['drafts'] === undefined ? null : text(input['drafts']);
  if (drafts !== null && !draftName(drafts, DRAFT_RUN)) throw new Error(`Invalid draft ref prefix: ${drafts || '(none)'}`);
  const removed: string[] = [];
  for (const name of strings(input['names'])) {
    const root = worktreePath(runDir, name);
    if (!ports.fs.inspectPath(root)) continue;
    // NOTE: unlink dependency links first so recursive removal never follows them into the caller checkout.
    unlink(deps, ports, root, strings(input['links']));
    await ports.git.run(['worktree', 'remove', '--force', root], deps.cwd);
    removed.push(name);
  }
  await ports.git.run(['worktree', 'prune'], deps.cwd);
  if (drafts === null) return { removed };
  // NOTE: only refs below `<prefix>/` belong to this run; `for-each-ref` also matches a sibling run whose id extends the prefix.
  const refs = (await ports.git.run(['for-each-ref', '--format=%(refname)', drafts], deps.cwd)).split(/\r?\n/).map((ref) => ref.trim()).filter((ref) => ref.startsWith(`${drafts}/`));
  for (const ref of refs) await ports.git.run(['update-ref', '-d', ref], deps.cwd);
  return { removed, drafts: refs.sort() };
}

export function createCheckout(deps: CheckoutDeps): Handler<CheckoutEffect> {
  return async (effect, ports, ctx) => {
    const input = effect.input as Readonly<Record<string, unknown>>;
    const done = (op: CheckoutOp, result: Row) => [{ type: 'CHECKOUT_DONE' as const, effectId: effect.id, op, result }];
    try {
      switch (effect.op) {
        case 'init': return done('init', await init(deps, ports, ctx.runDir, input));
        case 'task': {
          const root = worktreePath(ctx.runDir, text(input['name']));
          const snapshot = await snapshotDraft(ports, root, input, input['reset'] === true && input['keep'] !== true);
          await worktree(deps, ports, root, text(input['revision']), input['reset'] === true, input['keep'] === true);
          prepare(deps, ports, root, input);
          return done('task', { path: root, revision: await head(ports, root), ...snapshot });
        }
        case 'scope-rebase': return done('scope-rebase', await scopeRebase(deps, ports, ctx.runDir, effect.input));
        case 'commit': return done('commit', await submit(ports, worktreePath(ctx.runDir, text(input['name'])), text(input['base']), text(input['message']) || 'dispatch task'));
        case 'red': return done('red', await red(deps, ports, worktreePath(ctx.runDir, text(input['name'])), input));
        case 'integrate': return done('integrate', await integrate(ports, worktreePath(ctx.runDir, 'integration'), input));
        case 'resolve': return done('resolve', await resolve(ports, worktreePath(ctx.runDir, 'integration'), input));
        case 'trim': return done('trim', await trim(deps, ports, input));
        case 'reset': {
          // NOTE: the hard reset also aborts a kept integration conflict (it removes CHERRY_PICK_HEAD and unmerged entries).
          const root = worktreePath(ctx.runDir, text(input['name']));
          const snapshot = await snapshotDraft(ports, root, input, true);
          await worktree(deps, ports, root, text(input['revision']), true);
          return done('reset', { path: root, revision: await head(ports, root), ...snapshot });
        }
        case 'deliver': return done('deliver', await deliver(deps, ports, worktreePath(ctx.runDir, 'integration'), input));
        case 'cleanup': return done('cleanup', await cleanup(deps, ports, ctx.runDir, input));
      }
    } catch (error) {
      return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: error instanceof Error ? error.message : String(error) }];
    }
  };
}

/** Captures the listed worktree files for RED replay; absent files record deletion. */
export function writeCheckpoint(ports: Pick<Ports, 'fs'>, root: string, out: string, files: readonly string[]): { files: string[] } {
  if (!files.length) throw new Error('checkpoint requires at least one repository path after --');
  const captured: Record<string, string | null> = {};
  for (const file of files) {
    const normalized = file.replace(/\\/g, '/');
    if (!safe(normalized)) throw new Error(`checkpoint path must be repository-relative: ${file}`);
    const absolute = path.join(root, normalized), info = ports.fs.inspectPath(absolute);
    if (info && info.kind !== 'file') throw new Error(`checkpoint path is not a regular file: ${file}`);
    captured[normalized] = info ? ports.fs.readBase64(absolute) : null;
  }
  ports.fs.mkdir(path.dirname(out), { recursive: true });
  ports.fs.writeAtomic(out, `${JSON.stringify({ schemaVersion: 1, files: captured })}\n`);
  return { files: Object.keys(captured).sort() };
}
