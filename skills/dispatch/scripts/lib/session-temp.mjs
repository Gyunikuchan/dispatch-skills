// @ts-check
/** Session binding and run areas backed by the chat folder managed by `session-lifecycle.mjs`. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  findSession, handoffSession, initializeSession, isPublishedSessionDir, isWorkspaceSessionDir,
  publishedSessionRoot, readLifecycleManifest, reactivateSession, validateSessionRoot, workspaceSessionRoot,
} from './session-lifecycle.mjs';

export const SESSION_ENV = 'DISPATCH_SESSION_DIR';
export const SESSION_FLAG = '--session-dir';
export const RUN_ENV = 'DISPATCH_RUN_ID';
export const RUN_FLAG = '--session-run-id';
export const MANIFEST_NAME = 'manifest.json';

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RUN_ID_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,120}$/;
const DURABLE_AREAS = new Set(['artifacts', 'ledger', 'telemetry', 'cache']);
const RUN_AREAS = new Set(['logs', 'prompts', 'packets', 'reports', 'verify', 'cache', 'tmp']);

/** @param {string} dir */
function isRealDirectory(dir) {
  try {
    const stat = fs.lstatSync(dir);
    const real = path.resolve(fs.realpathSync(dir));
    const resolved = path.resolve(dir);
    return stat.isDirectory() && !stat.isSymbolicLink() && (process.platform === 'win32' ? real.toLowerCase() === resolved.toLowerCase() : real === resolved);
  } catch { return false; }
}

/** @param {string} left @param {string} right */
function sameFilesystemPath(left, right) {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function canonicalRepositoryRoot(root) {
  const real = fs.realpathSync(root).normalize('NFC').replaceAll('\\', '/');
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** @param {string} repositoryRoot */
function checkedRepositoryRoot(repositoryRoot) { return canonicalRepositoryRoot(repositoryRoot); }

/** Reads a manifest only from a validated workspace or published session root. */
export function readSessionManifest(dir) {
  if (isWorkspaceSessionDir(dir, readRepositoryFromManifest(dir)) || isPublishedSessionDir(dir)) return readLifecycleManifest(dir);
  throw new Error(`Session directory is outside the validated workspace or terminal roots: ${dir}`);
}

function readRepositoryFromManifest(dir) {
  const file = path.join(path.resolve(dir), MANIFEST_NAME);
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof value?.repositoryRoot === 'string' ? value.repositoryRoot : process.cwd();
  } catch { return process.cwd(); }
}

function setBoundSession(dir) {
  process.env[SESSION_ENV] = dir;
  delete process.env.DISPATCH_SESSION_TERMINAL;
}

/** @param {string} id */
export function bindRun(id) {
  if (!RUN_ID_PATTERN.test(id)) throw new Error(`Invalid run id "${id}".`);
  process.env[RUN_ENV] = id;
  return id;
}

function randomRunId() { return crypto.randomBytes(8).toString('hex'); }

/** The active run id, opening one for a stand-alone invocation when needed. */
export function runId() {
  const bound = process.env[RUN_ENV];
  return bound && RUN_ID_PATTERN.test(bound) ? bound : bindRun(randomRunId());
}

/** @param {string|{id?: string, repositoryRoot?: string|null, artifactPath?: string|null, slug?: string|null, sessionTitle?: string|null, objective?: string|null, tempRoot?: string}} [value] */
export function openSession(value) {
  const options = typeof value === 'string' ? { id: value } : (value ?? {});
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const explicit = process.env[SESSION_ENV];
  const sessionId = options.id ?? null;
  let dir;
  if (explicit) {
    dir = bindSession(explicit);
    const manifest = readSessionManifest(dir);
    if (manifest.repositoryRoot !== checkedRepositoryRoot(repositoryRoot)) throw new Error(`Bound session belongs to a different repository: ${dir}`);
  } else {
    dir = initializeSession({
      repositoryRoot,
      sessionId,
      sessionTitle: options.sessionTitle ?? options.objective ?? options.slug ?? null,
      objective: options.objective ?? options.artifactPath ?? options.slug ?? null,
      ...(options.tempRoot ? { tempRoot: options.tempRoot } : {}),
    });
    setBoundSession(dir);
  }
  bindRun(randomRunId());
  return dir;
}

/** Binds one chat root. Workflow identity selects artifacts; it does not create another session. */
/** @param {{ repositoryRoot?: string, artifactPath?: string, artifactKind?: string|null, slug?: string|null, objective?: string|null, sessionTitle?: string|null, tempRoot?: string }} [options] */
export function bindWorkflowSession({ repositoryRoot, artifactPath, slug, objective, sessionTitle, tempRoot } = {}) {
  if (!repositoryRoot) throw new Error('A repository root is required to bind a workflow session.');
  const bound = process.env[SESSION_ENV];
  let dir = null;
  if (bound) {
    dir = bindSession(bound);
    const manifest = readSessionManifest(dir);
    if (manifest.repositoryRoot !== checkedRepositoryRoot(repositoryRoot)) throw new Error(`Bound session belongs to a different repository: ${dir}`);
  } else {
    dir = findSession({ repositoryRoot, ...(tempRoot ? { tempRoot } : {}) });
    if (!dir) dir = initializeSession({ repositoryRoot, sessionTitle: sessionTitle ?? objective ?? slug ?? 'dispatch', objective: objective ?? artifactPath ?? slug ?? 'dispatch', ...(tempRoot ? { tempRoot } : {}) });
    setBoundSession(dir);
  }
  if (!process.env[RUN_ENV]) bindRun(randomRunId());
  touchSession(dir);
  return dir;
}

/** Confirms a chat binding before artifact resolution. */
/** @param {{ repositoryRoot?: string, artifactKind?: string, slug?: string }} [options] */
export function assertWorkflowSession({ repositoryRoot } = {}) {
  if (!process.env[SESSION_ENV]) throw new Error('A chat session must be bound before resolving repository artifacts.');
  const dir = sessionDir();
  const manifest = readSessionManifest(dir);
  if (repositoryRoot && manifest.repositoryRoot !== checkedRepositoryRoot(repositoryRoot)) throw new Error(`Bound session belongs to a different repository: ${dir}`);
  return dir;
}

/** @param {any} value @param {string} root @param {boolean} restore */
function mapSessionPaths(value, root, restore) {
  if (typeof value === 'string') {
    if (restore) {
      const currentRoot = path.resolve(root);
      return value.replace(/@session(?:\/[A-Za-z0-9._-]+)*/g, marker => {
        const parts = marker.slice('@session'.length).split('/').filter(Boolean);
        if (parts.includes('..')) throw new Error('Stored session path escapes its session root.');
        return parts.length ? path.join(currentRoot, ...parts) : currentRoot;
      });
    }
    const variants = [root, root.replaceAll('\\', '/'), root.replaceAll('/', '\\')];
    let result = value;
    for (const variant of [...new Set(variants)]) result = result.replaceAll(variant, '@session');
    return result.includes('@session') ? result.replaceAll('\\', '/') : result;
  }
  if (Array.isArray(value)) return value.map(item => mapSessionPaths(item, root, restore));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapSessionPaths(item, root, restore)]));
  }
  return value;
}

/** @param {any} value @param {string} [root] */
export function restoreSessionPaths(value, root = sessionDir()) { return mapSessionPaths(value, root, true); }

/** @param {any} value @param {string} [root] */
export function storeSessionPaths(value, root = sessionDir()) { return mapSessionPaths(value, root, false); }

/** Moves the active chat folder after its terminal state has been written. */
/** @param {string} repositoryRoot */
export function handoffCurrentSession(repositoryRoot) {
  const result = handoffSession({ sessionDir: sessionDir(), repositoryRoot });
  setBoundSession(result.currentRoot);
  process.env.DISPATCH_SESSION_TERMINAL = '1';
  return result;
}

/** Binds an explicit session root, reactivating a terminal folder into workspace scratch. */
/** @param {string} dir */
export function bindSession(dir) {
  const manifest = readSessionManifest(dir);
  const result = reactivateSession({ sessionDir: dir, repositoryRoot: manifest.repositoryRoot });
  const real = fs.realpathSync(result.currentRoot);
  setBoundSession(real);
  if (!process.env[RUN_ENV]) bindRun(randomRunId());
  touchSession(real);
  return real;
}

/** @param {string} dir */
function touchSession(dir) {
  const now = new Date();
  try { fs.utimesSync(dir, now, now); } catch { /* Activity timestamps are advisory. */ }
  try {
    const manifest = readLifecycleManifest(dir);
    manifest.lastUsedAt = now.toISOString();
    const temp = `${path.join(dir, MANIFEST_NAME)}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { fs.renameSync(temp, path.join(dir, MANIFEST_NAME)); }
    finally { fs.rmSync(temp, { force: true }); }
  } catch { /* Failed activity metadata must not stop artifact work. */ }
}

/** The bound root; opens a new chat folder only when no binding exists. */
export function sessionDir() {
  const bound = process.env[SESSION_ENV];
  if (!bound) return openSession();
  if (isWorkspaceSessionDir(bound, readRepositoryFromManifest(bound))) {
    readLifecycleManifest(bound);
    return fs.realpathSync(bound);
  }
  if (isPublishedSessionDir(bound)) {
    if (process.env.DISPATCH_SESSION_TERMINAL === '1') return fs.realpathSync(bound);
    return bindSession(bound);
  }
  throw new Error(`Bound session directory is invalid or unsafe: ${bound}`);
}

/** @param {string} area */
function ensureSubdirectory(parent, area) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(area)) throw new Error(`Invalid dispatch path component "${area}".`);
  const dir = path.join(parent, area);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe dispatch directory: ${dir}`);
  const real = fs.realpathSync(dir);
  const relative = path.relative(path.resolve(parent), real);
  if (relative !== area || path.isAbsolute(relative)) throw new Error(`Dispatch directory escaped its owner: ${dir}`);
  return real;
}

/** Returns a durable area owned by the bound chat folder. */
export function sessionArea(area) {
  if (!DURABLE_AREAS.has(area)) throw new Error(`Unknown durable session area "${area}".`);
  return ensureSubdirectory(sessionDir(), area);
}

/** Returns `<session>/runs/<run-id>`, creating it inside the active chat folder. */
export function runDir(id = runId()) {
  if (!RUN_ID_PATTERN.test(id)) throw new Error(`Invalid run id "${id}".`);
  return ensureSubdirectory(ensureSubdirectory(sessionDir(), 'runs'), id);
}

/** @param {string} area @param {string} [id] */
export function runArea(area, id = runId()) {
  if (!RUN_AREAS.has(area)) throw new Error(`Unknown run area "${area}".`);
  return ensureSubdirectory(runDir(id), area);
}

/** @param {string} area @param {string} prefix */
export function runTempDir(area, prefix) {
  if (!/^[A-Za-z0-9._-]+$/.test(prefix)) throw new Error('Temp directory prefix must be a safe filename prefix.');
  const dir = fs.mkdtempSync(path.join(runArea(area), prefix));
  return fs.realpathSync(dir);
}

/** @param {string} prefix */
export function sessionTempDir(prefix) { return runTempDir('tmp', prefix); }

/** @param {string} target */
export function isSessionPath(target) {
  if (typeof target !== 'string' || !target) return false;
  let root;
  try { root = sessionDir(); } catch { return false; }
  const absolute = path.resolve(target);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  try {
    const real = fs.realpathSync(absolute);
    const realRelative = path.relative(root, real);
    return realRelative !== '..' && !realRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(realRelative);
  } catch {
    const parent = path.dirname(absolute);
    try {
      const realRelative = path.relative(root, fs.realpathSync(parent));
      return realRelative !== '..' && !realRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(realRelative);
    } catch { return false; }
  }
}

/** Path to a new run state file. */
/** @param {string} id */
export function runStatePath(id) {
  bindRun(id);
  return path.join(runDir(id), 'state.json');
}

// SECTION: Argument propagation

/** Removes session/run binding flags from argv before ordinary dispatch parsing. */
export function consumeSessionFlag(args) {
  const out = [];
  let session = null, run = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') { out.push(...args.slice(index)); break; }
    if (arg === SESSION_FLAG || arg === RUN_FLAG) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      if (arg === SESSION_FLAG) { if (session !== null) throw new Error(`${SESSION_FLAG} was given twice.`); session = value; }
      else { if (run !== null) throw new Error(`${RUN_FLAG} was given twice.`); run = value; }
      continue;
    }
    const flags = [[SESSION_FLAG, 'session'], [RUN_FLAG, 'run']];
    const pair = flags.find(([flag]) => arg.startsWith(`${flag}=`));
    if (pair) {
      const value = arg.slice(pair[0].length + 1);
      if (!value) throw new Error(`${pair[0]} requires a value.`);
      if (pair[1] === 'session') { if (session !== null) throw new Error(`${SESSION_FLAG} was given twice.`); session = value; }
      else { if (run !== null) throw new Error(`${RUN_FLAG} was given twice.`); run = value; }
      continue;
    }
    out.push(arg);
  }
  if (session !== null) bindSession(session);
  if (run !== null) bindRun(run);
  return out;
}

/** Session and run flags for processes launched in another shell. */
export function sessionArgs() {
  const dir = sessionDir();
  return [SESSION_FLAG, dir, RUN_FLAG, runId()];
}

/** Prunes only aged run and cache directories; session manifests and canonical evidence remain. */
/** @param {{ maxAgeMs?: number, now?: number, tempRoot?: string }} [options] */
export function pruneSessions({ maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now(), tempRoot = os.tmpdir() } = {}) {
  const bound = process.env[SESSION_ENV] ? path.resolve(process.env[SESSION_ENV]) : null;
  const bases = [];
  try { bases.push(publishedSessionRoot({ tempRoot })); } catch { /* Temp access is optional during active workspace work. */ }
  let repositoryRoot = process.cwd();
  if (bound) {
    try { repositoryRoot = readSessionManifest(bound).repositoryRoot ?? repositoryRoot; }
    catch { /* A stale binding cannot authorize pruning outside the current repository. */ }
  }
  try { bases.push(workspaceSessionRoot(repositoryRoot)); } catch { /* The current folder may not be a repository. */ }
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    let entries;
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(base, entry.name);
      try {
        if (!isRealDirectory(dir)) continue;
        const manifest = readSessionManifest(dir);
        const stat = fs.statSync(dir);
        const lastUsed = Date.parse(manifest.lastUsedAt ?? '') || stat.mtimeMs;
        if (now - lastUsed < maxAgeMs || (bound && sameFilesystemPath(dir, bound))) continue;
        for (const area of ['runs', 'cache']) {
          const target = path.join(dir, area);
          if (fs.existsSync(target) && isRealDirectory(target)) fs.rmSync(target, { recursive: true, force: true });
        }
      } catch { /* Retention never blocks a run or follows an invalid session. */ }
    }
  }
}

export { findSession, handoffSession, initializeSession, isPublishedSessionDir, isWorkspaceSessionDir, publishedSessionRoot, reactivateSession, validateSessionRoot, workspaceSessionRoot };
