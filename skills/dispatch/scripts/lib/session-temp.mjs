// @ts-check
/**
 * A workflow session owns its durable artifacts and its per-invocation run directories:
 * `<os.tmpdir()>/dispatch-skills-<user>/<session-id>/`. Manifests bind sessions to a canonical
 * repository and governing artifact; `runs/<run-id>/` holds transient state and outputs.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { safeRenameSync } from './platform.mjs';
import { userSlug } from './telemetry.mjs';

export const SESSION_ENV = 'DISPATCH_SESSION_DIR';
export const SESSION_FLAG = '--session-dir';
export const RUN_ENV = 'DISPATCH_RUN_ID';
export const RUN_FLAG = '--session-run-id';
export const LEGACY_STATE_FLAG = '--legacy-state-file';
export const MANIFEST_NAME = 'manifest.json';

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MANIFEST_WAIT_MS = 5000;
const SESSION_ID_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,120}$/;
const RUN_ID_PATTERN = SESSION_ID_PATTERN;
const LEGACY_STATE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const DURABLE_AREAS = new Set(['artifacts', 'ledger', 'telemetry', 'cache']);
const RUN_AREAS = new Set(['logs', 'prompts', 'packets', 'reports', 'verify', 'cache', 'tmp']);

// SECTION: Roots and validation

/** `<realpath(os.tmpdir())>/dispatch-skills-<user>`: the parent of direct session children. */
export function dispatchTempRoot({ env = process.env, tempRoot = os.tmpdir() } = {}) {
  return path.join(fs.realpathSync(tempRoot), `dispatch-skills-${userSlug({ env })}`);
}

/** Kept as the session-parent API name used by state pruning and filesystem callers. */
export function sessionsRoot(options) {
  return dispatchTempRoot(options);
}

function legacySessionsRoot(options) {
  return path.join(dispatchTempRoot(options), 'sessions');
}

function isRealDirectory(dir) {
  try {
    const stat = fs.lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(dir) === dir;
  } catch {
    return false;
  }
}

function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe dispatch directory: ${dir}`);
  try { fs.chmodSync(dir, 0o700); } catch { /* NOTE: win32 ignores POSIX modes. */ }
  return fs.realpathSync(dir);
}

/** True when `dir` is a direct, non-symlink child of this user's dispatch temp root. */
export function isSessionDir(dir, options) {
  if (typeof dir !== 'string' || !dir) return false;
  const root = dispatchTempRoot(options);
  const resolved = path.resolve(dir);
  if (path.dirname(resolved) !== root || !SESSION_ID_PATTERN.test(path.basename(resolved))) return false;
  try {
    const stat = fs.lstatSync(resolved);
    return stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(resolved) === resolved;
  } catch {
    return false;
  }
}

function isLegacySessionDir(dir) {
  if (typeof dir !== 'string' || !dir) return false;
  const resolved = path.resolve(dir);
  if (path.dirname(resolved) !== legacySessionsRoot() || !SESSION_ID_PATTERN.test(path.basename(resolved))) return false;
  return isRealDirectory(resolved);
}

export function canonicalRepositoryRoot(root) {
  const real = fs.realpathSync(root).normalize('NFC').replaceAll('\\', '/');
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

function canonicalArtifactIdentity({ repositoryRoot, artifactPath, artifactKind, slug }) {
  if (typeof artifactKind === 'string' && typeof slug === 'string' && slug) {
    return `artifact:${artifactKind}:${slug.normalize('NFC')}`;
  }
  if (typeof artifactPath === 'string' && artifactPath) {
    const absolute = path.resolve(repositoryRoot ?? process.cwd(), artifactPath);
    const root = repositoryRoot ? path.resolve(repositoryRoot) : null;
    if (root) {
      const relative = path.relative(root, absolute);
      if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        return `path:${relative.replaceAll('\\', '/').normalize('NFC')}`;
      }
    }
    const owner = sessionForArtifactPath(absolute);
    if (owner) {
      const manifest = readSessionManifest(owner);
      if (repositoryRoot && manifest.repositoryRoot !== canonicalRepositoryRoot(repositoryRoot)) {
        throw new Error(`Relocated artifact belongs to a different repository: ${artifactPath}`);
      }
      return manifest.artifactIdentity;
    }
    return `path:${absolute.normalize('NFC').replaceAll('\\', '/')}`;
  }
  return null;
}

/** Reads and validates the root manifest before a session can be reused. */
export function readSessionManifest(dir) {
  if (!isSessionDir(dir)) throw new Error(`Session directory must be a direct child of ${dispatchTempRoot()}: ${dir}`);
  const file = path.join(dir, MANIFEST_NAME);
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    throw new Error(`Session manifest is missing or unreadable: ${file}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe session manifest: ${file}`);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    throw new Error(`Session manifest is invalid JSON: ${file}`);
  }
  if (!manifest || manifest.schemaVersion !== 1 || manifest.sessionId !== path.basename(dir) ||
      !['active', 'completed'].includes(manifest.status) ||
      !(manifest.repositoryRoot === null || typeof manifest.repositoryRoot === 'string') ||
      !(manifest.artifactIdentity === null || typeof manifest.artifactIdentity === 'string') ||
      !Number.isSafeInteger(manifest.generation) || manifest.generation < 1 ||
      typeof manifest.createdAt !== 'string' || typeof manifest.lastUsedAt !== 'string') {
    throw new Error(`Session manifest has an unsupported or unsafe identity: ${file}`);
  }
  return manifest;
}

function manifestPath(dir) {
  return path.join(dir, MANIFEST_NAME);
}

function writeManifest(dir, manifest) {
  const target = manifestPath(dir);
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { safeRenameSync(temp, target); }
  finally { fs.rmSync(temp, { force: true }); }
}

function touchManifest(dir) {
  const manifest = readSessionManifest(dir);
  // Activity changes directory metadata, leaving terminal manifest status immutable to touches.
  const now = new Date();
  fs.utimesSync(dir, now, now);
  return manifest;
}

function renameClaim(staging, destination) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 6; attempt++) {
    try { fs.renameSync(staging, destination); return true; }
    catch (error) {
      if (fs.existsSync(destination)) return false;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 5) throw error;
      Atomics.wait(pause, 0, 0, 20);
    }
  }
  throw new Error(`Could not publish session directory: ${destination}`);
}

/** Publishes a complete session directory in one rename; losers inspect the winner's manifest. */
function publishSession(base, id, manifest) {
  const destination = path.join(base, id);
  const staging = fs.mkdtempSync(path.join(base, '.claim-'));
  try {
    try { fs.chmodSync(staging, 0o700); } catch { /* NOTE: win32 ignores POSIX modes. */ }
    writeManifest(staging, manifest);
    return renameClaim(staging, destination);
  } finally {
    const resolved = path.resolve(staging);
    if (path.dirname(resolved) === base && path.basename(resolved).startsWith('.claim-') && fs.existsSync(resolved)) {
      const stat = fs.lstatSync(resolved);
      if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

function setBoundSession(dir, { legacy = false, stateFile = null } = {}) {
  process.env[SESSION_ENV] = dir;
  if (legacy) {
    process.env.DISPATCH_LEGACY_SESSION = '1';
    process.env.DISPATCH_LEGACY_STATE_FILE = stateFile;
  } else {
    delete process.env.DISPATCH_LEGACY_SESSION;
    delete process.env.DISPATCH_LEGACY_STATE_FILE;
  }
}

export function bindRun(id) {
  if (!RUN_ID_PATTERN.test(id)) throw new Error(`Invalid run id "${id}".`);
  process.env[RUN_ENV] = id;
  return id;
}

function randomRunId() {
  return crypto.randomUUID();
}

/** The active run id, opening one for a stand-alone dispatch invocation when needed. */
export function runId() {
  const bound = process.env[RUN_ENV];
  return bound && RUN_ID_PATTERN.test(bound) ? bound : bindRun(randomRunId());
}

/**
 * Opens a standalone session or reuses an explicit test/session id. Production governed work uses
 * `bindWorkflowSession`, which derives an identity and claims a deterministic generation.
 * @param {string|{id?: string, repositoryRoot?: string|null, artifactKind?: string|null, artifactPath?: string|null, artifactIdentity?: string|null, slug?: string|null, generation?: number, tempRoot?: string}} [value]
 */
export function openSession(value) {
  const options = typeof value === 'string' ? { id: value } : (value ?? {});
  const id = options.id ?? `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
  if (!SESSION_ID_PATTERN.test(id)) throw new Error(`Invalid session id "${id}".`);
  const root = dispatchTempRoot({ tempRoot: options.tempRoot });
  privateDirectory(root);
  const dir = path.join(root, id);
  const now = new Date().toISOString();
  const created = publishSession(root, id, {
    schemaVersion: 1,
    sessionId: id,
    repositoryRoot: options.repositoryRoot ? canonicalRepositoryRoot(options.repositoryRoot) : null,
    artifactIdentity: options.artifactIdentity ?? null,
    artifactKind: options.artifactKind ?? null,
    artifactPath: options.artifactPath ?? null,
    slug: options.slug ?? null,
    generation: options.generation ?? 1,
    status: 'active',
    createdAt: now,
    lastUsedAt: now,
  });
  if (!created) {
    if (!isSessionDir(dir, { tempRoot: options.tempRoot })) throw new Error(`Unsafe session directory: ${dir}`);
    const prior = readSessionManifest(dir);
    if (prior.status === 'completed' || prior.artifactIdentity !== (options.artifactIdentity ?? null)) {
      throw new Error(`Session id is already owned by another workflow: ${id}`);
    }
  }
  const real = fs.realpathSync(dir);
  setBoundSession(real);
  bindRun(randomRunId());
  pruneSessions();
  return real;
}

function identityHash(repositoryRoot, artifactIdentity) {
  return crypto.createHash('sha256').update(`${repositoryRoot}\0${artifactIdentity}`).digest('hex').slice(0, 24);
}

function waitForManifest(dir) {
  const deadline = Date.now() + MANIFEST_WAIT_MS;
  const shared = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (fs.existsSync(manifestPath(dir))) return readSessionManifest(dir);
    Atomics.wait(shared, 0, 0, 10);
  }
  throw new Error(`A manifest-less session candidate remains at ${dir}. Inspect and remove that stale directory, then retry the workflow.`);
}

function sameWorkflow(manifest, repositoryRoot, artifactIdentity) {
  return manifest.repositoryRoot === repositoryRoot && manifest.artifactIdentity === artifactIdentity;
}

/** Returns all validated generations for an exact repository and governed artifact identity. */
/** @param {{ repositoryRoot?: string, artifactKind?: string, slug?: string }} [options] */
export function workflowSessionDirs({ repositoryRoot, artifactKind, slug } = {}) {
  if (!repositoryRoot || typeof artifactKind !== 'string' || typeof slug !== 'string' || !slug) {
    throw new Error('Repository root, artifact kind, and slug are required for workflow discovery.');
  }
  const canonicalRoot = canonicalRepositoryRoot(repositoryRoot);
  const artifactIdentity = `artifact:${artifactKind}:${slug.normalize('NFC')}`;
  const prefix = identityHash(canonicalRoot, artifactIdentity);
  const base = dispatchTempRoot();
  let entries;
  try { entries = fs.readdirSync(base, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const sessions = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(`${prefix}-`)) continue;
    const dir = path.join(base, entry.name);
    if (!entry.isDirectory()) throw new Error(`Unsafe session candidate for ${artifactIdentity}: ${dir}`);
    const manifest = readSessionManifest(dir);
    if (!sameWorkflow(manifest, canonicalRoot, artifactIdentity)) {
      throw new Error(`Session candidate identity mismatch for ${artifactIdentity}: ${dir}`);
    }
    sessions.push({ dir, manifest });
  }
  return sessions.sort((left, right) => left.manifest.generation - right.manifest.generation).map(item => item.dir);
}

function claimWorkflowSession({ repositoryRoot, artifactIdentity, artifactKind, artifactPath, slug, tempRoot }) {
  const base = dispatchTempRoot({ tempRoot });
  privateDirectory(base);
  const canonicalRoot = canonicalRepositoryRoot(repositoryRoot);
  const prefix = identityHash(canonicalRoot, artifactIdentity);
  const candidates = fs.readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith(`${prefix}-`))
    .map(entry => path.join(base, entry.name));
  const active = [];
  for (const dir of candidates) {
    let manifest;
    try { manifest = readSessionManifest(dir); }
    catch (error) {
      if (!fs.existsSync(manifestPath(dir))) manifest = waitForManifest(dir);
      else throw error;
    }
    if (sameWorkflow(manifest, canonicalRoot, artifactIdentity) && manifest.status === 'active') active.push(dir);
  }
  if (active.length > 1) throw new Error(`Ambiguous active session manifests match ${artifactIdentity}: ${active.join(', ')}`);
  if (active.length === 1) {
    const dir = fs.realpathSync(active[0]);
    setBoundSession(dir);
    touchManifest(dir);
    bindRun(randomRunId());
    return dir;
  }

  for (let generation = 1; generation < 100000; generation++) {
    const id = `${prefix}-${generation}`;
    const dir = path.join(base, id);
    const now = new Date().toISOString();
    const created = publishSession(base, id, {
      schemaVersion: 1,
      sessionId: id,
      repositoryRoot: canonicalRoot,
      artifactIdentity,
      artifactKind: artifactKind ?? null,
      artifactPath: artifactPath ?? null,
      slug: slug ?? null,
      generation,
      status: 'active',
      createdAt: now,
      lastUsedAt: now,
    });
    if (created) {
      const real = fs.realpathSync(dir);
      setBoundSession(real);
      bindRun(randomRunId());
      pruneSessions();
      return real;
    }
    const manifest = readSessionManifest(dir);
    if (!sameWorkflow(manifest, canonicalRoot, artifactIdentity)) throw new Error(`Session candidate is bound to another workflow: ${dir}`);
    if (manifest.status === 'active') {
      const real = fs.realpathSync(dir);
      setBoundSession(real);
      touchManifest(real);
      bindRun(randomRunId());
      return real;
    }
  }
  throw new Error(`Could not claim a session generation for ${artifactIdentity}.`);
}

/** Finds an artifact's owner only when it is below a validated session's `artifacts/` directory. */
function sessionForArtifactPath(file) {
  const root = dispatchTempRoot();
  const absolute = path.resolve(file);
  const relative = path.relative(root, absolute);
  const parts = relative.split(path.sep);
  if (parts.length < 3 || parts[1] !== 'artifacts' || parts[0] === '..' || path.isAbsolute(relative)) return null;
  const owner = path.join(root, parts[0]);
  return isSessionDir(owner) ? owner : null;
}

/** Binds or atomically claims the session for one repository artifact. */
/** @param {{ repositoryRoot?: string, artifactPath?: string, artifactKind?: string|null, slug?: string|null, tempRoot?: string }} [options] */
export function bindWorkflowSession({ repositoryRoot, artifactPath, artifactKind = null, slug = null, tempRoot } = {}) {
  if (!repositoryRoot) throw new Error('A repository root is required to bind a workflow session.');
  const canonicalRoot = canonicalRepositoryRoot(repositoryRoot);
  const artifactIdentity = canonicalArtifactIdentity({ repositoryRoot, artifactPath, artifactKind, slug });
  if (!artifactIdentity) throw new Error('A governing artifact identity is required to bind a workflow session.');
  const bound = process.env[SESSION_ENV];
  if (bound && process.env.DISPATCH_LEGACY_SESSION !== '1' && isSessionDir(bound, { tempRoot })) {
    const manifest = readSessionManifest(bound);
    if (sameWorkflow(manifest, canonicalRoot, artifactIdentity) && manifest.status === 'active') {
      touchManifest(bound);
      if (!process.env[RUN_ENV]) bindRun(randomRunId());
      return fs.realpathSync(bound);
    }
  }
  return claimWorkflowSession({ repositoryRoot, artifactIdentity, artifactKind, artifactPath, slug, tempRoot });
}

/** Confirms that path resolution is still running inside the requested workflow session. */
/** @param {{ repositoryRoot?: string, artifactKind?: string, slug?: string }} [options] */
export function assertWorkflowSession({ repositoryRoot, artifactKind, slug } = {}) {
  if (!process.env[SESSION_ENV]) throw new Error('A workflow session must be bound before resolving repository artifacts.');
  const dir = sessionDir();
  if (process.env.DISPATCH_LEGACY_SESSION === '1') return dir;
  const manifest = readSessionManifest(dir);
  if (repositoryRoot && manifest.repositoryRoot !== canonicalRepositoryRoot(repositoryRoot)) {
    throw new Error(`Bound session belongs to a different repository: ${dir}`);
  }
  if (artifactKind && slug && manifest.artifactIdentity !== `artifact:${artifactKind}:${slug.normalize('NFC')}`) {
    throw new Error(`Bound session belongs to a different workflow artifact: ${dir}`);
  }
  if (manifest.status !== 'active') throw new Error(`Completed workflow session cannot accept new writes: ${dir}`);
  return dir;
}

/** Marks the bound generation complete after its governed workflow reaches successful handoff. */
export function completeSession() {
  const dir = sessionDir();
  if (process.env.DISPATCH_LEGACY_SESSION === '1') return null;
  const manifest = readSessionManifest(dir);
  if (manifest.status !== 'completed') {
    manifest.status = 'completed';
    manifest.completedAt = new Date().toISOString();
    manifest.lastUsedAt = manifest.completedAt;
    writeManifest(dir, manifest);
  }
  return dir;
}

/** Binds a validated direct session from `--session-dir`. */
export function bindSession(dir) {
  if (!isSessionDir(dir)) throw new Error(`Session directory must be a direct child of ${dispatchTempRoot()}: ${dir}`);
  readSessionManifest(dir);
  const real = privateDirectory(dir);
  setBoundSession(real);
  if (!process.env[RUN_ENV]) bindRun(randomRunId());
  touchManifest(real);
  return real;
}

/** Explicit compatibility binding used only when resuming a pre-change state file. */
export function bindLegacyStateSession(stateFile) {
  const resolved = path.resolve(stateFile);
  const real = fs.realpathSync(resolved);
  const parent = path.dirname(real);
  const flatId = path.basename(real).match(/^([0-9a-f]{8}-[0-9a-f-]{27})\.json$/i)?.[1];
  let dir = parent;
  let id = flatId;
  const flatState = Boolean(flatId && isLegacySessionDir(parent));
  if (!flatState) {
    const runsDir = path.dirname(parent);
    const legacyDir = path.dirname(runsDir);
    const nestedId = path.basename(parent);
    const nestedState = path.basename(real) === 'state.json' && path.basename(runsDir) === 'runs' &&
      LEGACY_STATE_ID_PATTERN.test(nestedId) && isLegacySessionDir(legacyDir) &&
      isRealDirectory(runsDir) && isRealDirectory(parent);
    if (!nestedState) {
      throw new Error(`State file is not in the recognized in-flight legacy layout: ${stateFile}`);
    }
    dir = legacyDir;
    id = nestedId;
  }
  const stat = fs.lstatSync(real);
  if (!stat.isFile() || stat.isSymbolicLink() || !id) {
    throw new Error(`State file is not in the recognized in-flight legacy layout: ${stateFile}`);
  }
  const state = JSON.parse(fs.readFileSync(real, 'utf8'));
  if (!state || state.v !== 1 || state.runId !== id) throw new Error(`Legacy state identity does not match its path: ${stateFile}`);
  setBoundSession(dir, { legacy: true, stateFile: real });
  bindRun(id);
  return dir;
}

/** The bound session, opening a standalone session when none exists. */
export function sessionDir() {
  const bound = process.env[SESSION_ENV];
  if (!bound) return openSession();
  if (process.env.DISPATCH_LEGACY_SESSION === '1' && isLegacySessionDir(bound)) return bound;
  if (isSessionDir(bound)) {
    readSessionManifest(bound);
    return fs.realpathSync(bound);
  }
  throw new Error(`Bound session directory is invalid or unsafe: ${bound}`);
}

function ensureSubdirectory(parent, name) {
  if (!SESSION_ID_PATTERN.test(name)) throw new Error(`Invalid dispatch path component "${name}".`);
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe dispatch directory: ${dir}`);
  try { fs.chmodSync(dir, 0o700); } catch { /* NOTE: win32 ignores POSIX modes. */ }
  const real = fs.realpathSync(dir);
  const relative = path.relative(path.resolve(parent), real);
  if (relative !== name || path.isAbsolute(relative)) throw new Error(`Dispatch directory escaped its owner: ${dir}`);
  return real;
}

/** Returns the private durable area owned by the bound workflow. */
export function sessionArea(area) {
  if (!DURABLE_AREAS.has(area)) throw new Error(`Unknown durable session area "${area}".`);
  return ensureSubdirectory(sessionDir(), area);
}

/** Returns `<session>/runs/<run-id>`, creating it with private permissions. */
export function runDir(id = runId()) {
  if (!RUN_ID_PATTERN.test(id)) throw new Error(`Invalid run id "${id}".`);
  return ensureSubdirectory(ensureSubdirectory(sessionDir(), 'runs'), id);
}

/** Returns a private organized directory for one transient output class in the active run. */
export function runArea(area, id = runId()) {
  if (!RUN_AREAS.has(area)) throw new Error(`Unknown run area "${area}".`);
  return ensureSubdirectory(runDir(id), area);
}

/** A unique private directory in an organized run area. */
export function runTempDir(area, prefix) {
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9._-]+$/.test(prefix)) throw new Error('Temp directory prefix must be a safe filename prefix.');
  const dir = fs.mkdtempSync(path.join(runArea(area), prefix));
  try { fs.chmodSync(dir, 0o700); } catch { /* NOTE: win32 ignores POSIX modes. */ }
  return fs.realpathSync(dir);
}

/** A unique private scratch directory in the bound run. */
export function sessionTempDir(prefix) {
  return runTempDir('tmp', prefix);
}

/** True when a path is contained in the bound direct session without crossing a symlink. */
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
      const realParent = fs.realpathSync(parent);
      const realRelative = path.relative(root, realParent);
      return realRelative !== '..' && !realRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(realRelative);
    } catch { return false; }
  }
}

/** Path to a new run state file. */
export function runStatePath(id) {
  bindRun(id);
  return path.join(runDir(id), 'state.json');
}

// SECTION: Argument propagation

/** Removes session/run flags from argv; legacy binding also requires its existing state file. */
export function consumeSessionFlag(args) {
  const out = [];
  let session = null, legacyStateFile = null, run = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') { out.push(...args.slice(index)); break; }
    if (arg === SESSION_FLAG || arg === RUN_FLAG || arg === LEGACY_STATE_FLAG) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      if (arg === SESSION_FLAG) {
        if (session !== null) throw new Error(`${SESSION_FLAG} was given twice.`);
        session = value;
      } else if (arg === RUN_FLAG) {
        if (run !== null) throw new Error(`${RUN_FLAG} was given twice.`);
        run = value;
      } else {
        if (legacyStateFile !== null) throw new Error(`${LEGACY_STATE_FLAG} was given twice.`);
        legacyStateFile = value;
      }
      continue;
    }
    if (arg.startsWith(`${SESSION_FLAG}=`)) {
      if (session !== null) throw new Error(`${SESSION_FLAG} was given twice.`);
      session = arg.slice(SESSION_FLAG.length + 1);
      continue;
    }
    if (arg.startsWith(`${RUN_FLAG}=`)) {
      if (run !== null) throw new Error(`${RUN_FLAG} was given twice.`);
      run = arg.slice(RUN_FLAG.length + 1);
      continue;
    }
    if (arg.startsWith(`${LEGACY_STATE_FLAG}=`)) {
      if (legacyStateFile !== null) throw new Error(`${LEGACY_STATE_FLAG} was given twice.`);
      legacyStateFile = arg.slice(LEGACY_STATE_FLAG.length + 1);
      continue;
    }
    out.push(arg);
  }
  if (legacyStateFile !== null) {
    const bound = bindLegacyStateSession(legacyStateFile);
    if (session !== null && path.resolve(session) !== path.resolve(bound)) {
      throw new Error(`${LEGACY_STATE_FLAG} does not belong to ${SESSION_FLAG}.`);
    }
  } else if (session !== null) bindSession(session);
  if (run !== null) bindRun(run);
  return out;
}

/** Session and run flags for argv launched in a new shell. */
export function sessionArgs() {
  const dir = sessionDir();
  return [SESSION_FLAG, dir,
    ...(process.env.DISPATCH_LEGACY_SESSION === '1' ? [LEGACY_STATE_FLAG, process.env.DISPATCH_LEGACY_STATE_FILE] : []),
    RUN_FLAG, runId()];
}

// SECTION: Retention

/** Prunes transient areas of aged sessions while retaining manifests and workflow evidence. */
export function pruneSessions({ maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() } = {}) {
  let root;
  try { root = dispatchTempRoot(); } catch { return; }
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  const bound = process.env[SESSION_ENV] ? path.resolve(process.env[SESSION_ENV]) : null;
  for (const entry of entries) {
    if (entry.name.startsWith('.claim-')) {
      const staging = path.join(root, entry.name);
      try {
        const stat = fs.lstatSync(staging);
        if (path.dirname(staging) === root && stat.isDirectory() && !stat.isSymbolicLink() &&
            fs.realpathSync(staging) === staging && now - stat.mtimeMs >= maxAgeMs) {
          fs.rmSync(staging, { recursive: true, force: true });
        }
      } catch { /* NOTE: retention never blocks a run or follows unsafe paths. */ }
      continue;
    }
    if (!entry.isDirectory() || !SESSION_ID_PATTERN.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    if (bound && dir === bound) continue;
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !isSessionDir(dir)) continue;
      const manifest = readSessionManifest(dir);
      const lastUsed = Math.max(Date.parse(manifest.lastUsedAt), stat.mtimeMs);
      if (!Number.isFinite(lastUsed) || now - lastUsed < maxAgeMs) continue;
      for (const area of ['runs', 'cache']) {
        const target = path.join(dir, area);
        if (path.dirname(target) !== dir || !fs.existsSync(target)) continue;
        const child = fs.lstatSync(target);
        if (!child.isDirectory() || child.isSymbolicLink()) continue;
        fs.rmSync(target, { recursive: true, force: true });
      }
    } catch {
      // NOTE: retention never blocks a run or follows unsafe paths.
    }
  }
}
