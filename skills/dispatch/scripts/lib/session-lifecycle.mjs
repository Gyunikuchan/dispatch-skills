// @ts-check
/**
 * Owns one folder per chat and moves it as a verified tree between workspace and temp at handoff.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SESSION_MANIFEST = 'manifest.json';
export const CHAT_ID_ENV_VARS = Object.freeze([
  'DISPATCH_CHAT_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'OPENAI_CODEX_THREAD_ID',
  'ANTIGRAVITY_CONVERSATION_ID', 'ANTIGRAVITY_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'COPILOT_CLI_SESSION_ID',
]);

const FOLDER_NAME_PATTERN = /^\d{8}T\d{4}Z-[A-Za-z0-9._-]{1,64}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,11}$/;
const FALLBACK_MOVE_CODES = new Set(['EXDEV']);

/** @typedef {{ schemaVersion: 1, folderName: string, sessionId: string, safeSessionId: string, repositoryRoot: string, sessionTitle: string, createdAt: string, lastUsedAt: string, location?: string }} SessionManifest */
/** @typedef {{ source: string, destination: string, currentRoot: string, moved: boolean, method: 'rename'|'copy'|'existing'|'failed', authoritative: 'source'|'destination', warning: string|null }} SessionMoveResult */

/** @param {string} value */
function safePathId(value) {
  if (SAFE_ID_PATTERN.test(value)) return value;
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/** @param {string} value */
function safeTitle(value) {
  const title = value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20).replace(/-+$/g, '');
  return title || 'session';
}

/** @param {NodeJS.ProcessEnv} env */
function platformSessionId(env) {
  for (const name of CHAT_ID_ENV_VARS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

/** @param {string} repositoryRoot */
function canonicalRepositoryRoot(repositoryRoot) {
  const real = fs.realpathSync(repositoryRoot).normalize('NFC').replaceAll('\\', '/');
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** @param {string} value */
function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** @param {string} left @param {string} right */
function samePath(left, right) { return pathKey(left) === pathKey(right); }

/** @param {string} dir */
function isRealDirectory(dir) {
  try {
    const stat = fs.lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink() && samePath(fs.realpathSync(dir), dir);
  } catch { return false; }
}

/** @param {string} dir */
function assertRealDirectory(dir) {
  if (!isRealDirectory(dir)) throw new Error(`Unsafe session directory: ${dir}`);
}

/** @param {string} base */
function ensureBase(base) {
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  assertRealDirectory(base);
  return fs.realpathSync(base);
}

// NOTE: mirrors this repository's tracked .scratch/dispatch-skills/.gitignore.
export const SESSION_ROOT_GITIGNORE = [
  '# Keep only chat deliverables; the manifest, .state/, logs, and runtime state stay local.',
  '*/*', '!*/*.spec.md', '!*/*.design.md', '!*/*.plan.md', '!*/*.walkthrough.md', '!*/*.report.md', '',
].join('\n');

/** @param {string} repositoryRoot */
export function workspaceSessionRoot(repositoryRoot) {
  const repo = fs.realpathSync(repositoryRoot);
  const scratch = path.join(repo, '.scratch');
  if (fs.existsSync(scratch)) assertRealDirectory(scratch);
  else fs.mkdirSync(scratch, { mode: 0o700 });
  const root = ensureBase(path.join(scratch, 'dispatch-skills'));
  // NOTE: upsert on every call so deleted or stale rules self-repair across skill upgrades.
  const ignore = path.join(root, '.gitignore');
  let current = null;
  try { current = fs.readFileSync(ignore, 'utf8'); } catch {}
  if (current !== SESSION_ROOT_GITIGNORE) fs.writeFileSync(ignore, SESSION_ROOT_GITIGNORE);
  return root;
}

/** @param {{ tempRoot?: string, create?: boolean }} [options] */
export function publishedSessionRoot({ tempRoot = os.tmpdir(), create = false } = {}) {
  const base = path.join(fs.realpathSync(tempRoot), 'dispatch-skills');
  return create ? ensureBase(base) : base;
}

/** @param {string} dir @param {string} repositoryRoot */
export function isWorkspaceSessionDir(dir, repositoryRoot) {
  if (typeof dir !== 'string' || !dir) return false;
  const root = workspaceSessionRoot(repositoryRoot);
  const resolved = path.resolve(dir);
  return samePath(path.dirname(resolved), root) && FOLDER_NAME_PATTERN.test(path.basename(resolved)) && isRealDirectory(resolved);
}

/** @param {string} dir @param {{ tempRoot?: string }} [options] */
export function isPublishedSessionDir(dir, options) {
  if (typeof dir !== 'string' || !dir) return false;
  const root = publishedSessionRoot(options);
  const resolved = path.resolve(dir);
  return samePath(path.dirname(resolved), root) && FOLDER_NAME_PATTERN.test(path.basename(resolved)) && isRealDirectory(resolved);
}

/** @param {string} dir */
export function readLifecycleManifest(dir) {
  assertRealDirectory(path.resolve(dir));
  const manifestPath = path.join(dir, SESSION_MANIFEST);
  let stat;
  try { stat = fs.lstatSync(manifestPath); } catch { throw new Error(`Session manifest is missing: ${manifestPath}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe session manifest: ${manifestPath}`);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch { throw new Error(`Session manifest is invalid JSON: ${manifestPath}`); }
  const folderName = path.basename(path.resolve(dir));
  if (!manifest || manifest.schemaVersion !== 1 || manifest.folderName !== folderName ||
      !FOLDER_NAME_PATTERN.test(folderName) || typeof manifest.sessionId !== 'string' || !manifest.sessionId ||
      manifest.safeSessionId !== safePathId(manifest.sessionId) || typeof manifest.repositoryRoot !== 'string' ||
      typeof manifest.sessionTitle !== 'string' || !manifest.sessionTitle ||
      typeof manifest.createdAt !== 'string' || typeof manifest.lastUsedAt !== 'string') {
    throw new Error(`Session manifest has an unsupported or unsafe identity: ${manifestPath}`);
  }
  return /** @type {SessionManifest} */ (manifest);
}

/** @param {string} dir @param {SessionManifest} manifest */
function writeManifest(dir, manifest) {
  const target = path.join(dir, SESSION_MANIFEST);
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { fs.renameSync(temp, target); }
  finally { fs.rmSync(temp, { force: true }); }
}

/** @param {string} dir @param {{ repositoryRoot: string, sessionId?: string|null, sessionTitle?: string|null, objective?: string|null, env?: NodeJS.ProcessEnv, now?: Date }} options */
function makeManifest(dir, { repositoryRoot, sessionId, sessionTitle, objective, env = process.env, now = new Date() }) {
  const rawId = sessionId ?? platformSessionId(env) ?? crypto.randomUUID();
  const safeId = safePathId(rawId);
  const title = safeTitle(sessionTitle ?? objective ?? 'session');
  const timestamp = `${now.toISOString().slice(0, 16).replace(/[-:]/g, '')}Z`;
  const folderName = `${timestamp}-${safeId}-${title}`;
  const instant = now.toISOString();
  return /** @type {SessionManifest} */ ({
    schemaVersion: 1, folderName, sessionId: rawId, safeSessionId: safeId,
    repositoryRoot: canonicalRepositoryRoot(repositoryRoot), sessionTitle: title,
    createdAt: instant, lastUsedAt: instant, location: 'workspace',
  });
}

/** @param {string} root @param {string} sessionId @param {string} repositoryRoot */
function matchingSessions(root, sessionId, repositoryRoot) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (error) { if (/** @type {NodeJS.ErrnoException} */(error).code === 'ENOENT') return []; throw error; }
  const matches = [];
  const safeId = safePathId(sessionId);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.includes(`-${safeId}-`)) continue;
    const dir = path.join(root, entry.name);
    const manifest = readLifecycleManifest(dir);
    if (manifest.sessionId === sessionId && manifest.repositoryRoot === canonicalRepositoryRoot(repositoryRoot)) matches.push(dir);
  }
  return matches;
}

/** @param {string} root @param {string} sessionId @param {string} repositoryRoot @param {string} claim */
function waitForSessionClaim(root, sessionId, repositoryRoot, claim) {
  const deadline = Date.now() + 5000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    const matches = matchingSessions(root, sessionId, repositoryRoot);
    if (matches.length > 1) throw new Error(`Ambiguous session identity ${sessionId}: ${matches.join(', ')}`);
    if (matches.length === 1) return matches[0];
    if (!fs.existsSync(claim)) return null;
    if (!isRealDirectory(claim)) throw new Error(`Unsafe session claim: ${claim}`);
    Atomics.wait(pause, 0, 0, 10);
  }
  throw new Error(`Session initialization is still claimed at ${claim}; inspect the path and retry.`);
}

/** @param {string} dir */
function treeSnapshot(dir) {
  /** @type {Array<{ path: string, type: string, size: number, hash: string|null }>} */
  const rows = [];
  const walk = (current, relative) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(current, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(child);
      if (stat.isSymbolicLink()) throw new Error(`Session tree contains a symbolic link: ${child}`);
      if (childRelative === SESSION_MANIFEST) continue;
      if (stat.isDirectory()) {
        rows.push({ path: childRelative, type: 'directory', size: 0, hash: null });
        walk(child, childRelative);
      } else if (stat.isFile()) {
        rows.push({ path: childRelative, type: 'file', size: stat.size, hash: crypto.createHash('sha256').update(fs.readFileSync(child)).digest('hex') });
      } else throw new Error(`Session tree contains an unsupported file type: ${child}`);
    }
  };
  walk(dir, '');
  return rows;
}

/** @param {string} left @param {string} right */
function sameTree(left, right) {
  return JSON.stringify(treeSnapshot(left)) === JSON.stringify(treeSnapshot(right));
}

/** @param {string} dir @param {SessionManifest} manifest @param {string} location */
function updateLocation(dir, manifest, location) {
  manifest.location = location;
  manifest.lastUsedAt = new Date().toISOString();
  writeManifest(dir, manifest);
}

/** @param {string} dir @param {string} location */
function normalizeLocation(dir, location) {
  const manifest = readLifecycleManifest(dir);
  if (manifest.location !== location) updateLocation(dir, manifest, location);
}

/** @param {string} source @param {string} destination @param {{ tempRoot?: string, targetLocation?: string }} options */
function moveTree(source, destination, { tempRoot = os.tmpdir(), targetLocation = 'workspace' } = {}) {
  const sourceManifest = readLifecycleManifest(source);
  if (fs.existsSync(destination)) {
    const destManifest = readLifecycleManifest(destination);
    if (destManifest.sessionId !== sourceManifest.sessionId || destManifest.repositoryRoot !== sourceManifest.repositoryRoot) {
      throw new Error(`Session move collision has conflicting identities: ${source} and ${destination}`);
    }
    const destinationPublished = destManifest.location === targetLocation || destManifest.location === `moving-to-${targetLocation}`;
    const sourcePublished = sourceManifest.location === targetLocation;
    if (destinationPublished) {
      if (!sameTree(source, destination) && !String(sourceManifest.location).startsWith('moving-to-')) {
        throw new Error(`Session move collision has conflicting contents: ${source} and ${destination}`);
      }
      fs.rmSync(source, { recursive: true, force: true });
      return { method: 'existing', warning: null };
    }
    if (sourceManifest.location === 'published' && targetLocation === 'workspace') {
      fs.rmSync(destination, { recursive: true, force: true });
    } else if (sourcePublished) {
      fs.rmSync(destination, { recursive: true, force: true });
    } else if (sameTree(source, destination)) {
      fs.rmSync(source, { recursive: true, force: true });
      return { method: 'existing', warning: null };
    } else {
      throw new Error(`Session move collision has conflicting contents: ${source} and ${destination}`);
    }
  }
  updateLocation(source, sourceManifest, `moving-to-${targetLocation}`);
  try {
    fs.renameSync(source, destination);
    try { updateLocation(destination, sourceManifest, targetLocation); }
    catch (error) { return { method: 'rename', warning: `Moved session to ${destination}; manifest update failed: ${error instanceof Error ? error.message : String(error)}` }; }
    return { method: 'rename', warning: null };
  } catch (error) {
    if (!FALLBACK_MOVE_CODES.has(/** @type {NodeJS.ErrnoException} */(error).code ?? '')) throw error;
  }

  const destBase = path.dirname(destination);
  const stage = path.join(destBase, `.${path.basename(destination)}.stage-${crypto.randomUUID()}`);
  try {
    fs.cpSync(source, stage, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: false });
    if (!sameTree(source, stage)) throw new Error(`Session copy verification failed: ${stage}`);
    fs.renameSync(stage, destination);
    try { updateLocation(destination, sourceManifest, targetLocation); }
    catch (error) { /* The published tree remains authoritative even if its marker could not be refreshed. */ }
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  try { fs.rmSync(source, { recursive: true, force: true }); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { method: 'copy', warning: `Published ${destination}; source cleanup failed: ${message}` };
  }
  return { method: 'copy', warning: null };
}

/** @param {string} dir @param {string} repositoryRoot @param {{ tempRoot?: string }} [options] */
export function validateSessionRoot(dir, repositoryRoot, options = {}) {
  const resolved = path.resolve(dir);
  if (!isWorkspaceSessionDir(resolved, repositoryRoot) && !isPublishedSessionDir(resolved, options)) {
    throw new Error(`Session directory is outside the validated workspace or published roots: ${dir}`);
  }
  const manifest = readLifecycleManifest(resolved);
  if (manifest.repositoryRoot !== canonicalRepositoryRoot(repositoryRoot)) throw new Error(`Session belongs to a different repository: ${resolved}`);
  return { dir: fs.realpathSync(resolved), manifest };
}

/** @param {{ repositoryRoot: string, sessionId?: string|null, sessionTitle?: string|null, objective?: string|null, env?: NodeJS.ProcessEnv, tempRoot?: string, now?: Date }} options */
export function initializeSession(options) {
  const { repositoryRoot, tempRoot = os.tmpdir(), env = process.env } = options;
  if (!repositoryRoot) throw new Error('A repository root is required to initialize a chat session.');
  const sessionId = options.sessionId ?? platformSessionId(env) ?? crypto.randomUUID();
  const workspaceRoot = workspaceSessionRoot(repositoryRoot);
  const scratch = matchingSessions(workspaceRoot, sessionId, repositoryRoot);
  if (scratch.length === 1 && readLifecycleManifest(scratch[0]).location === 'workspace') return scratch[0];
  const publishedRoot = publishedSessionRoot({ tempRoot });
  const published = fs.existsSync(publishedRoot) ? matchingSessions(publishedRoot, sessionId, repositoryRoot) : [];
  const all = [...scratch, ...published];
  if (all.length > 2 || scratch.length > 1 || published.length > 1) throw new Error(`Ambiguous session identity ${sessionId}: ${all.join(', ')}`);
  if (scratch.length && published.length) return reactivateSession({ sessionDir: published[0], repositoryRoot, tempRoot }).currentRoot;
  if (scratch.length) {
    normalizeLocation(scratch[0], 'workspace');
    return scratch[0];
  }
  if (published.length) {
    const dest = path.join(workspaceRoot, path.basename(published[0]));
    moveTree(published[0], dest, { tempRoot, targetLocation: 'workspace' });
    return dest;
  }
  const claim = path.join(workspaceRoot, `.claim-${safePathId(sessionId)}`);
  try { fs.mkdirSync(claim, { mode: 0o700 }); }
  catch (error) {
    if (/** @type {NodeJS.ErrnoException} */(error).code !== 'EEXIST') throw error;
    const appeared = waitForSessionClaim(workspaceRoot, sessionId, repositoryRoot, claim);
    if (appeared) return appeared;
    return initializeSession(options);
  }
  try {
    const appeared = matchingSessions(workspaceRoot, sessionId, repositoryRoot);
    if (appeared.length > 1) throw new Error(`Ambiguous session identity ${sessionId}: ${appeared.join(', ')}`);
    if (appeared.length === 1) return appeared[0];
    const manifest = makeManifest(workspaceRoot, { ...options, sessionId, env });
    const dest = path.join(workspaceRoot, manifest.folderName);
    fs.mkdirSync(dest, { mode: 0o700 });
    try { writeManifest(dest, manifest); }
    catch (error) { fs.rmSync(dest, { recursive: true, force: true }); throw error; }
    return fs.realpathSync(dest);
  } finally {
    fs.rmSync(claim, { recursive: true, force: true });
  }
}

/** @param {{ repositoryRoot: string, sessionId?: string|null, sessionTitle?: string|null, objective?: string|null, env?: NodeJS.ProcessEnv, tempRoot?: string }} options */
export function findSession(options) {
  const { repositoryRoot, tempRoot = os.tmpdir(), env = process.env } = options;
  if (!repositoryRoot) throw new Error('A repository root is required to find a chat session.');
  const sessionId = options.sessionId ?? platformSessionId(env);
  if (!sessionId) return null;
  const workspaceRoot = workspaceSessionRoot(repositoryRoot);
  const scratch = matchingSessions(workspaceRoot, sessionId, repositoryRoot);
  if (scratch.length === 1 && readLifecycleManifest(scratch[0]).location === 'workspace') return scratch[0];
  const publishedRoot = publishedSessionRoot({ tempRoot });
  const published = fs.existsSync(publishedRoot) ? matchingSessions(publishedRoot, sessionId, repositoryRoot) : [];
  if (scratch.length > 1 || published.length > 1 || scratch.length + published.length > 2) {
    throw new Error(`Ambiguous session identity ${sessionId}: ${[...scratch, ...published].join(', ')}`);
  }
  if (scratch.length && published.length) return reactivateSession({ sessionDir: published[0], repositoryRoot, tempRoot }).currentRoot;
  if (scratch.length) {
    normalizeLocation(scratch[0], 'workspace');
    return scratch[0];
  }
  if (published.length) {
    const dest = path.join(workspaceRoot, path.basename(published[0]));
    moveTree(published[0], dest, { tempRoot, targetLocation: 'workspace' });
    return dest;
  }
  return null;
}

/** @param {{ sessionDir: string, repositoryRoot: string, tempRoot?: string }} options */
export function reactivateSession({ sessionDir, repositoryRoot, tempRoot = os.tmpdir() }) {
  const { dir, manifest } = validateSessionRoot(sessionDir, repositoryRoot, { tempRoot });
  const workspaceRoot = workspaceSessionRoot(repositoryRoot);
  if (samePath(path.dirname(dir), workspaceRoot)) {
    normalizeLocation(dir, 'workspace');
    return { currentRoot: dir, moved: false, method: 'existing', authoritative: 'source', warning: null, manifest };
  }
  const destination = path.join(workspaceRoot, manifest.folderName);
  const moved = moveTree(dir, destination, { tempRoot, targetLocation: 'workspace' });
  return { currentRoot: destination, moved: moved.method !== 'existing', method: moved.method, authoritative: 'destination', warning: moved.warning, manifest };
}

/** @param {{ sessionDir: string, repositoryRoot: string, tempRoot?: string }} options */
export function handoffSession({ sessionDir, repositoryRoot, tempRoot = os.tmpdir() }) {
  const { dir, manifest } = validateSessionRoot(sessionDir, repositoryRoot, { tempRoot });
  const destinationRoot = publishedSessionRoot({ tempRoot, create: true });
  if (samePath(path.dirname(dir), destinationRoot)) {
    normalizeLocation(dir, 'published');
    return /** @type {SessionMoveResult} */ ({ source: dir, destination: dir, currentRoot: dir, moved: false, method: 'existing', authoritative: 'destination', warning: null });
  }
  const destination = path.join(destinationRoot, manifest.folderName);
  try {
    const result = moveTree(dir, destination, { tempRoot, targetLocation: 'published' });
    return /** @type {SessionMoveResult} */ ({ source: dir, destination, currentRoot: destination, moved: result.method !== 'existing', method: result.method, authoritative: 'destination', warning: result.warning });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /** @type {SessionMoveResult} */ ({ source: dir, destination, currentRoot: dir, moved: false, method: 'failed', authoritative: 'source', warning: message });
  }
}
