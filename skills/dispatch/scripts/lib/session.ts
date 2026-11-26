// Session paths and lifecycle. Sessions live under
// `<repo>/.scratch/dispatch-skills/<folder>/`. The repo root is found by upward `.git` traversal, never git.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { hasErrorCode, isRecord } from "./config.ts";

const waitForClaim = (
  root: string,
  sessionId: string,
  repo: string,
  claim: string,
  waitMs: number
) => {
  const deadline = Date.now() + waitMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));

  for (;;) {
    const found = matchingSession(root, sessionId, repo);

    if (found !== undefined) {
      return fs.realpathSync(found);
    }

    if (!fs.existsSync(claim)) {
      return null;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Session initialization is still claimed at ${claim}; inspect the path and retry.`
      );
    }

    Atomics.wait(pause, 0, 0, 10);
  }
};

const MANIFEST = "manifest.json";
const SLUG_MAX = 40;

const CHAT_ID_ENV_VARS = [
  "DISPATCH_CHAT_ID",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "OPENAI_CODEX_THREAD_ID",
  "ANTIGRAVITY_CONVERSATION_ID",
  "ANTIGRAVITY_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID",
  "COPILOT_CLI_SESSION_ID",
] as const;

type Location =
  | "workspace"
  | "published"
  | "moving-to-workspace"
  | "moving-to-published";

export const FOLDER_NAME = /^\d{8}T\d{4}Z-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,11}$/u;

/** Shell-safe session ids only: ids ride on argv and the win32 batch launcher. */
const VALID_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

export const validSessionId = (id: string | null | undefined) =>
  typeof id === "string" && VALID_SESSION_ID.test(id) ? id : null;

const WIN = process.platform === "win32";

export interface Manifest {
  schemaVersion: 1;
  folderName: string;
  sessionId: string;
  safeSessionId: string;
  repositoryRoot: string;
  sessionTitle: string;
  createdAt: string;
  lastUsedAt: string;
  location: Location;
  // canonical ProviderKey; absent before host declaration
  host?: string;
}

// SECTION: Repository root

/** Nearest ancestor of `start` holding a `.git` directory or file (worktrees), or null. */
export const findRepoRoot = (
  start: string,
  exists: (file: string) => boolean = fs.existsSync
) => {
  let dir = path.resolve(start);

  for (;;) {
    if (exists(path.join(dir, ".git"))) {
      return dir;
    }

    const parent = path.dirname(dir);

    if (parent === dir) {
      return null;
    }

    dir = parent;
  }
};

export const canonicalRepositoryRoot = (root: string) => {
  const real = fs.realpathSync(root).normalize("NFC").replaceAll("\\", "/");

  return WIN ? real.toLowerCase() : real;
};

// SECTION: Naming grammar

const safePathId = (value: string) =>
  SAFE_ID.test(value)
    ? value
    : crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);

const safeTitle = (value: string) => {
  const title = value
    .normalize("NFKD")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, SLUG_MAX)
    .replaceAll(/-+$/gu, "");

  return title || "session";
};

/** `<YYYYMMDDTHHMMZ>-<title>`. */
export const folderName = (now: Date, title: string) =>
  `${now.toISOString().slice(0, 16).replaceAll(/[-:]/gu, "")}Z-${safeTitle(title)}`;

export const platformSessionId = (
  env: (name: string) => string | undefined
) => {
  for (const name of CHAT_ID_ENV_VARS) {
    const value = env(name)?.trim();

    if (value !== undefined && value !== "") {
      return value;
    }
  }

  return null;
};

// SECTION: Roots and manifest

const samePath = (a: string, b: string) =>
  WIN
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);

const isRealDirectory = (dir: string) => {
  try {
    const stat = fs.lstatSync(dir);

    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      samePath(fs.realpathSync(dir), dir)
    );
  } catch {
    return false;
  }
};

const ensureDir = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  if (!isRealDirectory(dir)) {
    throw new Error(`Unsafe session directory: ${dir}`);
  }

  return fs.realpathSync(dir);
};

const workspaceSessionRoot = (repositoryRoot: string) =>
  ensureDir(
    path.join(fs.realpathSync(repositoryRoot), ".scratch", "dispatch-skills")
  );

// Validates the identity fields only; the writer owns the rest of the shape.
const isOwnManifest = (value: unknown, name: string): value is Manifest =>
  isRecord(value) &&
  value["schemaVersion"] === 1 &&
  value["folderName"] === name &&
  FOLDER_NAME.test(name) &&
  typeof value["sessionId"] === "string" &&
  value["safeSessionId"] === safePathId(value["sessionId"]) &&
  typeof value["repositoryRoot"] === "string";

export const readManifest = (dir: string) => {
  const file = path.join(dir, MANIFEST);
  let value: unknown;

  try {
    value = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    throw new Error(`Session manifest is missing or invalid: ${file}`);
  }

  if (!isOwnManifest(value, path.basename(path.resolve(dir)))) {
    throw new Error(
      `Session manifest has an unsupported or unsafe identity: ${file}`
    );
  }

  return value;
};

const writeManifest = (dir: string, manifest: Manifest) => {
  const target = path.join(dir, MANIFEST);
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });

  try {
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
};

export class AmbiguousSessionIdentityError extends Error {
  readonly candidates: string[];

  constructor(sessionId: string, matches: string[]) {
    super(`Ambiguous session identity ${sessionId}`);
    this.name = "AmbiguousSessionIdentityError";
    this.candidates = matches.map((dir) => path.basename(dir)).toSorted();
  }
}

const matchingSession = (
  root: string,
  sessionId: string,
  repo: string
): string | undefined => {
  let names: string[];

  try {
    names = fs.readdirSync(root);
  } catch {
    return undefined;
  }

  const found = names
    .filter((name) => FOLDER_NAME.test(name))
    .map((name) => path.join(root, name))
    .filter((dir) => {
      try {
        const manifest = readManifest(dir);

        return (
          manifest.sessionId === sessionId && manifest.repositoryRoot === repo
        );
      } catch {
        return false;
      }
    });

  if (found.length > 1) {
    throw new AmbiguousSessionIdentityError(sessionId, found);
  }

  return found[0];
};

// SECTION: Lifecycle

/** Replaces the recorded orchestrator host; callers pass a validated canonical ProviderKey. */
export const recordHost = (sessionDir: string, host: string) => {
  writeManifest(sessionDir, { ...readManifest(sessionDir), host });
};

interface InitOptions {
  repositoryRoot: string;
  sessionId: string;
  sessionTitle: string;
  now: Date;
  waitMs?: number;
}

interface SessionLocation {
  path: string;
  reused: boolean;
}

/**
 * Finds or creates the chat's session folder. A published folder for the same identity is reactivated;
 * creation is collision-safe: an exclusive claim directory serialises creators, and a same-minute name
 * collision with another identity takes a numeric title suffix.
 */
export const initSession: (options: InitOptions) => SessionLocation = (
  options
) => {
  const repo = canonicalRepositoryRoot(options.repositoryRoot);
  const root = workspaceSessionRoot(options.repositoryRoot);
  const found = matchingSession(root, options.sessionId, repo);

  if (found !== undefined) {
    return { path: fs.realpathSync(found), reused: true };
  }

  const claim = path.join(root, `.claim-${safePathId(options.sessionId)}`);

  try {
    fs.mkdirSync(claim, { mode: 0o700 });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }

    // Another creator holds the claim: reuse its folder once published, or retry after it releases.
    const appeared = waitForClaim(
      root,
      options.sessionId,
      repo,
      claim,
      options.waitMs ?? CLAIM_WAIT_MS
    );

    return appeared === null
      ? initSession(options)
      : { path: appeared, reused: true };
  }

  try {
    const raced = matchingSession(root, options.sessionId, repo);

    if (raced !== undefined) {
      return { path: fs.realpathSync(raced), reused: true };
    }

    const baseTitle = safeTitle(options.sessionTitle);
    const baseName = folderName(options.now, baseTitle);

    for (let n = 0; ; n += 1) {
      const name = n === 0 ? baseName : `${baseName}-${n}`;
      const dir = path.join(root, name);

      try {
        fs.mkdirSync(dir, { mode: 0o700 });
      } catch (error) {
        if (hasErrorCode(error, "EEXIST")) {
          continue;
        }

        throw error;
      }

      const instant = options.now.toISOString();

      try {
        writeManifest(dir, {
          schemaVersion: 1,
          folderName: name,
          sessionId: options.sessionId,
          safeSessionId: safePathId(options.sessionId),
          repositoryRoot: repo,
          sessionTitle: baseTitle,
          createdAt: instant,
          lastUsedAt: instant,
          location: "workspace",
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
};

const CLAIM_WAIT_MS = 5000;

/** Validates that a session belongs to the repository workspace root and sits under `.scratch/dispatch-skills`. */
export const reactivateSession = (
  sessionDir: string,
  repositoryRoot: string
) => {
  const manifest = readManifest(sessionDir);

  if (manifest.repositoryRoot !== canonicalRepositoryRoot(repositoryRoot)) {
    throw new Error(`Session belongs to a different repository: ${sessionDir}`);
  }

  const expected = path.join(
    workspaceSessionRoot(repositoryRoot),
    manifest.folderName
  );

  if (!samePath(sessionDir, expected)) {
    throw new Error(
      `Session directory is outside the workspace session root: ${sessionDir}`
    );
  }

  return fs.realpathSync(sessionDir);
};
