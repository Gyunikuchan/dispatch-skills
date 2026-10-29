// Session paths and lifecycle. Sessions live under
// `<repo>/.scratch/dispatch-skills/<folder>/`. The repo root is found by upward `.git` traversal, never git.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MANIFEST = 'manifest.json';
export const SLUG_MAX = 40;
export const CHAT_ID_ENV_VARS = [
  'DISPATCH_CHAT_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'OPENAI_CODEX_THREAD_ID',
  'ANTIGRAVITY_CONVERSATION_ID', 'ANTIGRAVITY_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'COPILOT_CLI_SESSION_ID',
] as const;

export type Location = 'workspace' | 'published' | 'moving-to-workspace' | 'moving-to-published';

export const FOLDER_NAME = /^\d{8}T\d{4}Z-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,11}$/;
const WIN = process.platform === 'win32';

export type Manifest = {
  schemaVersion: 1; folderName: string; sessionId: string; safeSessionId: string; repositoryRoot: string;
  sessionTitle: string; createdAt: string; lastUsedAt: string; location: Location;
};

// SECTION: Repository root

/** Nearest ancestor of `start` holding a `.git` directory or file (worktrees), or null. */
export function findRepoRoot(start: string, exists: (file: string) => boolean = fs.existsSync): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (exists(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function canonicalRepositoryRoot(root: string): string {
  const real = fs.realpathSync(root).normalize('NFC').replaceAll('\\', '/');
  return WIN ? real.toLowerCase() : real;
}

// SECTION: Naming grammar

export const safePathId = (value: string): string => (SAFE_ID.test(value) ? value : crypto.createHash('sha256').update(value).digest('hex').slice(0, 12));

export function safeTitle(value: string): string {
  const title = value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, SLUG_MAX).replace(/-+$/g, '');
  return title || 'session';
}

/** `<YYYYMMDDTHHMMZ>-<title>`. */
export const folderName = (now: Date, title: string): string =>
  `${now.toISOString().slice(0, 16).replace(/[-:]/g, '')}Z-${safeTitle(title)}`;

export function platformSessionId(env: (name: string) => string | undefined): string | null {
  for (const name of CHAT_ID_ENV_VARS) {
    const value = env(name)?.trim();
    if (value) return value;
  }
  return null;
}

// SECTION: Roots and manifest

const samePath = (a: string, b: string): boolean => (WIN ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

function isRealDirectory(dir: string): boolean {
  try {
    const stat = fs.lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink() && samePath(fs.realpathSync(dir), dir);
  } catch { return false; }
}

function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!isRealDirectory(dir)) throw new Error(`Unsafe session directory: ${dir}`);
  return fs.realpathSync(dir);
}

export const workspaceSessionRoot = (repositoryRoot: string): string => ensureDir(path.join(fs.realpathSync(repositoryRoot), '.scratch', 'dispatch-skills'));

export function readManifest(dir: string): Manifest {
  const file = path.join(dir, MANIFEST);
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`Session manifest is missing or invalid: ${file}`); }
  const manifest = value as Partial<Manifest> | null;
  const name = path.basename(path.resolve(dir));
  if (!manifest || manifest.schemaVersion !== 1 || manifest.folderName !== name || !FOLDER_NAME.test(name) || typeof manifest.sessionId !== 'string'
    || manifest.safeSessionId !== safePathId(manifest.sessionId) || typeof manifest.repositoryRoot !== 'string') {
    throw new Error(`Session manifest has an unsupported or unsafe identity: ${file}`);
  }
  return manifest as Manifest;
}

function writeManifest(dir: string, manifest: Manifest): void {
  const target = path.join(dir, MANIFEST);
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try { fs.renameSync(temp, target); } finally { fs.rmSync(temp, { force: true }); }
}

function matching(root: string, sessionId: string, repo: string): string[] {
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return []; }
  return names.filter((name) => FOLDER_NAME.test(name)).map((name) => path.join(root, name)).filter((dir) => {
    try {
      const manifest = readManifest(dir);
      return manifest.sessionId === sessionId && manifest.repositoryRoot === repo;
    } catch {
      return false;
    }
  });
}

// SECTION: Lifecycle

export type InitOptions = { repositoryRoot: string; sessionId: string; sessionTitle: string; now: Date; tempRoot?: string; waitMs?: number };

/**
 * Finds or creates the chat's session folder. A published folder for the same identity is reactivated;
 * creation is collision-safe: an exclusive claim directory serialises creators, and a same-minute name
 * collision with another identity takes a numeric title suffix.
 */
export function initializeSession(options: InitOptions): string {
  return initSession(options).path;
}

/** As `initializeSession`, and reports whether an existing folder was returned rather than created. */
export function initSession(options: InitOptions): { path: string; reused: boolean } {
  const repo = canonicalRepositoryRoot(options.repositoryRoot);
  const root = workspaceSessionRoot(options.repositoryRoot);
  const found = matching(root, options.sessionId, repo);
  if (found.length > 1) throw new Error(`Ambiguous session identity ${options.sessionId}: ${found.join(', ')}`);
  if (found[0] !== undefined) return { path: fs.realpathSync(found[0]), reused: true };
  const claim = path.join(root, `.claim-${safePathId(options.sessionId)}`);
  try { fs.mkdirSync(claim, { mode: 0o700 }); } catch (error) {
    if ((error as { code?: unknown }).code !== 'EEXIST') throw error;
    // Another creator holds the claim: reuse its folder once published, or retry after it releases.
    const appeared = waitForClaim(root, options.sessionId, repo, claim, options.waitMs ?? CLAIM_WAIT_MS);
    return appeared !== null ? { path: appeared, reused: true } : initSession(options);
  }
  try {
    const raced = matching(root, options.sessionId, repo);
    if (raced[0] !== undefined) return { path: fs.realpathSync(raced[0]), reused: true };
    const baseTitle = safeTitle(options.sessionTitle);
    const baseName = folderName(options.now, baseTitle);
    for (let n = 0; ; n++) {
      const name = n === 0 ? baseName : `${baseName}-${n}`;
      const dir = path.join(root, name);
      try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) {
        if ((error as { code?: unknown }).code === 'EEXIST') continue;
        throw error;
      }
      const instant = options.now.toISOString();
      try {
        writeManifest(dir, {
          schemaVersion: 1, folderName: name, sessionId: options.sessionId, safeSessionId: safePathId(options.sessionId), repositoryRoot: repo,
          sessionTitle: baseTitle, createdAt: instant, lastUsedAt: instant, location: 'workspace',
        });
      } catch (error) {
        // A folder without a manifest would break later identity matching.
        fs.rmSync(dir, { recursive: true, force: true });
        throw error;
      }
      return { path: fs.realpathSync(dir), reused: false };
    }
  } finally {
    fs.rmSync(claim, { recursive: true, force: true });
  }
}

export const CLAIM_WAIT_MS = 5000;

function waitForClaim(root: string, sessionId: string, repo: string, claim: string, waitMs: number): string | null {
  const deadline = Date.now() + waitMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const found = matching(root, sessionId, repo);
    if (found.length > 1) throw new Error(`Ambiguous session identity ${sessionId}: ${found.join(', ')}`);
    if (found[0] !== undefined) return fs.realpathSync(found[0]);
    if (!fs.existsSync(claim)) return null;
    if (Date.now() >= deadline) throw new Error(`Session initialization is still claimed at ${claim}; inspect the path and retry.`);
    Atomics.wait(pause, 0, 0, 10);
  }
}

/** Validates that a session belongs to the repository workspace root and sits under `.scratch/dispatch-skills`. */
export function reactivateSession(sessionDir: string, repositoryRoot: string): string {
  const manifest = readManifest(sessionDir);
  if (manifest.repositoryRoot !== canonicalRepositoryRoot(repositoryRoot)) throw new Error(`Session belongs to a different repository: ${sessionDir}`);
  const expected = path.join(workspaceSessionRoot(repositoryRoot), manifest.folderName);
  if (!samePath(sessionDir, expected)) throw new Error(`Session directory is outside the workspace session root: ${sessionDir}`);
  return fs.realpathSync(sessionDir);
}
