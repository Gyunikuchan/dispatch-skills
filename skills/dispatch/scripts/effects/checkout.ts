// `checkout`: driver-owned private Git worktrees under `<runDir>/wt/`. Every op is idempotent on retry; only
// `deliver` writes the caller checkout, and it refuses paths the caller changed since the captured baseline.

import path from 'node:path';
import type { CheckoutOp, Effect, Handler, Ports } from '../core/types.ts';

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

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const split = (output: string): string[] => output.split('\0').filter(Boolean);
const safe = (file: string): boolean => !!file && !file.includes('\\') && !file.startsWith('/') && !/^[A-Za-z]:/.test(file)
  && !file.split('/').some((part) => !part || part === '.' || part === '..') && !/^\.git(?:\/|$)/i.test(file);

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
async function worktree(deps: CheckoutDeps, ports: Ports, root: string, revision: string, reset: boolean): Promise<void> {
  if (ports.fs.inspectPath(root)?.kind === 'directory') {
    if (reset) { await ports.git.run(['reset', '-q', '--hard', revision], root); await ports.git.run(['clean', '-q', '-fd'], root); }
    return;
  }
  ports.fs.mkdir(path.dirname(root), { recursive: true });
  await ports.git.run(['worktree', 'add', '-q', '--detach', root, revision], deps.cwd);
}

function copy(ports: Ports, from: string, to: string): void {
  ports.fs.mkdir(path.dirname(to), { recursive: true });
  ports.fs.writeBase64Atomic(to, ports.fs.readBase64(from));
}

// SECTION: Ops

async function init(deps: CheckoutDeps, ports: Ports, runDir: string): Promise<Row> {
  const root = worktreePath(runDir, 'integration');
  const runRelative = path.relative(deps.cwd, runDir).split(path.sep).join('/');
  const ignored = split(await ports.git.run(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], deps.cwd));
  const linked = ignored.filter((entry) => /^[^/]+\/$/.test(entry) && !runRelative.startsWith(entry)).map((entry) => entry.slice(0, -1));
  const copiedIgnored = ignored.filter((entry) => !entry.includes('/'));
  const unreproduced = ignored.filter((entry) => !linked.includes(entry.replace(/\/$/, '')) && !copiedIgnored.includes(entry) && !runRelative.startsWith(entry));
  if (ports.fs.inspectPath(root)?.kind === 'directory') {
    const message = await ports.git.run(['log', '-1', '--format=%B'], root);
    if (message.includes(BASELINE_TRAILER) && await clean(ports, root)) return { path: root, base: await head(ports, root), manifest: JSON.parse(message.slice(message.indexOf(BASELINE_TRAILER) + BASELINE_TRAILER.length).trim()) as Row };
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
  return { path: root, base, manifest };
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
      const parsed = JSON.parse(ports.fs.readText(checkpoint)) as Row;
      if (parsed['schemaVersion'] !== 1 || typeof parsed['files'] !== 'object' || parsed['files'] === null || Array.isArray(parsed['files'])) defects.push('RED checkpoint must be { schemaVersion: 1, files }.');
      else files = parsed['files'] as Record<string, unknown>;
    } catch (error) { defects.push(`RED checkpoint is invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const entries = Object.entries(files);
  if (!defects.length && !entries.length) defects.push('RED checkpoint lists no test files.');
  for (const [file, value] of entries) {
    if (!safe(file) || !permitted.has(file)) defects.push(`RED checkpoint path is not an approved task test path: ${file}`);
    else if (value !== null && typeof value !== 'string') defects.push(`RED checkpoint content must be base64 or null: ${file}`);
  }
  if (defects.length) return { path: root, defects };
  await worktree(deps, ports, root, text(input['base']), true);
  link(deps, ports, root, strings(input['links']));
  for (const [file, value] of entries) {
    const target = path.join(root, file);
    if (value === null) ports.fs.remove(target);
    else { ports.fs.mkdir(path.dirname(target), { recursive: true }); ports.fs.writeBase64Atomic(target, value as string); }
  }
  return { path: root, defects: [], files: entries.map(([file]) => file).sort() };
}

async function integrate(ports: Ports, root: string, input: Row): Promise<Row> {
  const candidate = text(input['candidate']), expected = text(input['expected']);
  const current = await head(ports, root);
  if (current !== expected) {
    const log = await ports.git.run(['log', '--format=%B', `${expected}..${current}`], root).catch(() => '');
    if (log.includes(`${CANDIDATE_TRAILER} ${candidate}`)) return { revision: current, conflict: false, reused: true };
    throw new Error(`Integration head ${current} moved from the recorded revision ${expected}.`);
  }
  try {
    await ports.git.run([...COMMIT, 'cherry-pick', '--no-commit', candidate], root);
  } catch (error) {
    const conflicts = split(await ports.git.run(['diff', '--name-only', '--diff-filter=U', '-z'], root).catch(() => ''));
    await ports.git.run(['reset', '-q', '--hard', expected], root);
    await ports.git.run(['clean', '-q', '-fd'], root);
    return { revision: expected, conflict: true, paths: conflicts, detail: error instanceof Error ? error.message.split('\n')[0] : String(error) };
  }
  const revision = await commit(ports, root, `dispatch integrate ${text(input['task'])}\n\n${CANDIDATE_TRAILER} ${candidate}`);
  return { revision, conflict: false };
}

async function blob(ports: Ports, cwd: string, revision: string, file: string): Promise<string | null> {
  const entry = (await ports.git.run(['ls-tree', '-z', revision, '--', file], cwd)).split('\0')[0] ?? '';
  return /^\d+ blob ([a-f0-9]+)\t/.exec(entry)?.[1] ?? null;
}

async function deliver(deps: CheckoutDeps, ports: Ports, root: string, input: Row): Promise<Row> {
  const base = text(input['base']), revision = text(input['revision']);
  if (await head(ports, root) !== revision || !await clean(ports, root)) throw new Error(`Integration checkout is not clean at ${revision}.`);
  const files = split(await ports.git.run(['diff', '--name-only', '-z', base, revision, '--'], root)).sort();
  const plan: { file: string; action: 'write' | 'delete' | 'already' }[] = [], conflicts: string[] = [];
  for (const file of files) {
    if (!safe(file)) throw new Error(`Unsafe delivery path: ${file}`);
    const absolute = path.join(deps.cwd, file), info = ports.fs.inspectPath(absolute);
    if (info && info.kind !== 'file') { conflicts.push(file); continue; }
    const caller = info ? (await ports.git.run(['hash-object', '--', file], deps.cwd)).trim() : null;
    const before = await blob(ports, root, base, file), after = await blob(ports, root, revision, file);
    if (caller === after) plan.push({ file, action: 'already' });
    else if (caller === before) plan.push({ file, action: after === null ? 'delete' : 'write' });
    else conflicts.push(file);
  }
  if (conflicts.length) return { conflicts, transferred: [], already: [] };
  for (const item of plan) {
    const target = path.join(deps.cwd, item.file);
    if (item.action === 'write') copy(ports, path.join(root, item.file), target);
    else if (item.action === 'delete') ports.fs.remove(target);
  }
  return { conflicts: [], transferred: plan.filter((item) => item.action !== 'already').map((item) => item.file), already: plan.filter((item) => item.action === 'already').map((item) => item.file) };
}

async function cleanup(deps: CheckoutDeps, ports: Ports, runDir: string, input: Row): Promise<Row> {
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
  return { removed };
}

export function createCheckout(deps: CheckoutDeps): Handler<CheckoutEffect> {
  return async (effect, ports, ctx) => {
    const input = effect.input;
    const done = (op: CheckoutOp, result: Row) => [{ type: 'CHECKOUT_DONE' as const, effectId: effect.id, op, result }];
    try {
      switch (effect.op) {
        case 'init': return done('init', await init(deps, ports, ctx.runDir));
        case 'task': {
          const root = worktreePath(ctx.runDir, text(input['name']));
          await worktree(deps, ports, root, text(input['revision']), input['reset'] === true);
          link(deps, ports, root, strings(input['links']));
          return done('task', { path: root, revision: await head(ports, root) });
        }
        case 'commit': return done('commit', await submit(ports, worktreePath(ctx.runDir, text(input['name'])), text(input['base']), text(input['message']) || 'dispatch task'));
        case 'red': return done('red', await red(deps, ports, worktreePath(ctx.runDir, text(input['name'])), input));
        case 'integrate': return done('integrate', await integrate(ports, worktreePath(ctx.runDir, 'integration'), input));
        case 'reset': {
          const root = worktreePath(ctx.runDir, text(input['name']));
          await worktree(deps, ports, root, text(input['revision']), true);
          return done('reset', { path: root, revision: await head(ports, root) });
        }
        case 'deliver': return done('deliver', await deliver(deps, ports, worktreePath(ctx.runDir, 'integration'), input));
        case 'cleanup': return done('cleanup', await cleanup(deps, ports, ctx.runDir, input));
        default: return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'config', detail: `unknown checkout op ${String(effect.op)}` }];
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
