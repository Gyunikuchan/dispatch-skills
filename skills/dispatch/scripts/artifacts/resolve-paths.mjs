/**
 * Resolves plan/walkthrough artifact paths deterministically, so the review-flow skills (see
 * `references/review.md`) — run together or independently — converge on the same on-disk
 * file for a given change instead of each inventing its own slug or re-authoring a copy.
 *
 * Resolution order per kind (native artifacts always win over scratch):
 *   1. Platform-native artifact (currently: Antigravity's brain dir) — only scanned
 *      when the orchestrator actually is that platform; scoped to the exact active
 *      conversation when its id is known, else a same-platform recency guess.
 *   2. Existing scratch artifact matching the slug (any date) — reuse, don't re-author.
 *   3. Existing relocated artifact in OS temp matching the slug (any date) — reuse, don't re-author.
 *   4. Scratch-new: the deterministic `.scratch/plan/<date>-<slug>[-walkthrough].md` path.
 *
 * Usage:
 *   node artifacts/resolve-paths.mjs [--slug <kebab-slug>] [--date <yyyy-mm-dd>]
 *                                   [--kind plan|walkthrough|both] [--orchestrator <name>]
 *
 * `--slug` is optional: when omitted it is derived, in order, from (1) the current git
 * branch (prefix stripped, kebab-cased) or (2) the active orchestrator's own
 * conversation/session id (truncated to 8 chars, prefixed `conversation-`). Branch
 * derivation fails on a protected branch (main/master/develop/trunk/head) or detached HEAD;
 * conversation-id derivation fails when the orchestrator exposes no such env var (e.g.
 * OpenCode, today) — pass `--slug` explicitly if both fail.
 *
 * `--orchestrator` overrides the auto-detected orchestrator platform (same
 * detection `dispatch` uses); it gates native-tier scanning, which only ever
 * applies to platforms with a known native artifact (currently `agy`), and is also
 * the platform consulted for conversation-id slug derivation.
 *
 * Outputs JSON: `{ slug, slugSource, date, ledgerPath, plan?: { tier, path, exists }, walkthrough?: { tier, path, exists } }`.
 * `tier` is `native`, `scratch-existing`, `temp-existing`, or `scratch-new`. `slugSource` is
 * `explicit`, `branch`, or `conversation`.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { PROJECT_ROOT, spawnCliSync } from '../lib/platform.mjs';
import { detectOrchestrator } from '../lib/providers.mjs';
import { AGY_MODE_DATA_DIRS } from '../runners/agy.mjs';
import { userSlug } from '../lib/telemetry.mjs';

export const SCRATCH_DIR = '.scratch/plan';

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const PHASED_KINDS = Object.freeze(['design', 'increment-plan', 'increment-walkthrough', 'integration-walkthrough']);
export const RESERVED_SLUG_PATTERN = /(?:-design|-integration(?:-walkthrough)?|-i\d{2}-.+)$/;
export function isReservedOrdinarySlug(slug) {
  return typeof slug === 'string' && RESERVED_SLUG_PATTERN.test(slug);
}

/** Antigravity conversation ids are opaque tokens; this rejects anything that could
 *  traverse out of the brain dir (e.g. `../`) when interpolated into a path.join. */
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop', 'trunk', 'head']);
const BRANCH_PREFIX_PATTERN = /^(feature|feat|fix|bugfix|hotfix|chore|refactor|release)\//;
const MAX_SLUG_LENGTH = 60;

// ============================================================================
// SECTION: Date helpers
// ============================================================================

/** Local calendar date as `yyyy-mm-dd` — the filename should match the user's day. */
export function localDate(now = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function isValidDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// ============================================================================
// SECTION: Scratch path template (single source of truth for the canonical shape)
// ============================================================================

/**
 * @param {string} date - yyyy-mm-dd
 * @param {string} slug - kebab-case
 * @returns {{ plan: string, walkthrough: string }}
 */
export function buildScratchPaths(date, slug, kind = 'plan') {
  const paths = {
    plan: path.posix.join(SCRATCH_DIR, `${date}-${slug}.md`),
    walkthrough: path.posix.join(SCRATCH_DIR, `${date}-${slug}-walkthrough.md`),
    design: path.posix.join(SCRATCH_DIR, `${date}-${slug}-design.md`),
    'increment-plan': path.posix.join(SCRATCH_DIR, `${date}-${slug}-plan.md`),
    'increment-walkthrough': path.posix.join(SCRATCH_DIR, `${date}-${slug}-walkthrough.md`),
    'integration-walkthrough': path.posix.join(SCRATCH_DIR, `${date}-${slug}-integration-walkthrough.md`),
  };
  if (!Object.hasOwn(paths, kind)) throw new Error(`Unknown artifact kind "${kind}"`);
  return kind === 'plan' || kind === 'walkthrough' ? paths : paths[kind];
}

export function canonicalRepositoryRoot(
  root,
  { platform = process.platform, realpath = fs.realpathSync.native } = {},
) {
  let canonical = realpath(root).normalize('NFC').replaceAll('\\', '/');
  if (platform === 'win32') canonical = canonical.toLowerCase();
  return canonical;
}

export function repositoryRootHash(root, options) {
  return crypto.createHash('sha256').update(canonicalRepositoryRoot(root, options)).digest('hex').slice(0, 12);
}

export function getRepositoryRoot(cwd = PROJECT_ROOT) {
  const result = spawnCliSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0) return null;
  const root = (result.stdout ?? '').trim();
  return root || null;
}

export function resolveLedgerPath({
  slug,
  slugSource,
  repositoryRoot,
  platform = process.platform,
  tempRoot = os.tmpdir(),
  env = process.env,
  realpath,
} = {}) {
  if (!repositoryRoot || !['explicit', 'branch'].includes(slugSource)) return null;
  const repoHash = repositoryRootHash(repositoryRoot, { platform, realpath });
  return path.join(ledgerNamespacePath({ tempRoot, repoHash, env }), `${slug}-ledger.md`);
}

export function ledgerNamespacePath({ tempRoot = os.tmpdir(), repoHash, env = process.env } = {}) {
  if (!/^[a-f0-9]{12}$/.test(repoHash ?? '')) throw new Error('repoHash must be 12 lowercase hexadecimal characters');
  return path.join(tempRoot, `dispatch-skills-${userSlug({ env })}`, repoHash);
}

/**
 * Repo-scoped home of relocated scratch artifacts: `<ledger namespace>/relocated/`, keyed by the
 * project's Git root (the project root itself outside Git) so another repository's same-slug
 * artifact never resolves here.
 */
export function relocatedArtifactsPath({ projectRoot = PROJECT_ROOT, tempRoot = os.tmpdir(), env = process.env } = {}) {
  const repoHash = repositoryRootHash(getRepositoryRoot(projectRoot) ?? projectRoot);
  return path.join(ledgerNamespacePath({ tempRoot, repoHash, env }), 'relocated');
}

// ============================================================================
// SECTION: Slug derivation
// ============================================================================

/**
 * Kebab-cases arbitrary text: lowercase, non-alphanumeric runs become a single
 * `-`, leading/trailing dashes trimmed, capped to MAX_SLUG_LENGTH.
 *
 * @param {string} raw
 * @returns {string|null} null when nothing kebab-worthy remains
 */
export function sanitizeSlug(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
  return slug.length > 0 && SLUG_PATTERN.test(slug) ? slug : null;
}

/**
 * Derives a kebab-case slug from a branch name, stripping a common type prefix
 * (`feature/`, `fix/`, ...) first. Returns null on a protected branch name
 * (main/master/develop/trunk/head) or when nothing sanitizable remains — callers
 * fall back to an explicit `--slug` in that case.
 *
 * @param {string|null} branch
 * @returns {string|null}
 */
export function deriveSlugFromBranch(branch) {
  if (!branch) return null;
  const stripped = branch.replace(BRANCH_PREFIX_PATTERN, '');
  const slug = sanitizeSlug(stripped);
  if (!slug || PROTECTED_BRANCHES.has(slug)) return null;
  return slug;
}

/**
 * Current git branch, or null when detached HEAD, not a repository, or the
 * lookup fails for any other reason.
 *
 * @param {string} cwd
 * @returns {string|null}
 */
export function getCurrentBranch(cwd = PROJECT_ROOT) {
  const res = spawnCliSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (res.status !== 0) return null;
  const branch = (res.stdout ?? '').trim();
  return branch && branch !== 'HEAD' ? branch : null;
}

/**
 * Env vars that carry a conversation (preferred) or session id for each orchestrator,
 * in preference order — checked only for the orchestrator actually detected, so a stray
 * env var from another tool never leaks into the derived key.
 */
const CONVERSATION_ID_ENV_VARS = {
  agy: ['ANTIGRAVITY_CONVERSATION_ID', 'ANTIGRAVITY_SESSION_ID'],
  // Verified equal to the conversation id; CLAUDE_CODE_HOST_SESSION_ID is the desktop
  // wrapper's own id and is not used here.
  claude: ['CLAUDE_CODE_SESSION_ID'],
  copilot: ['COPILOT_CLI_SESSION_ID'],
  // OpenCode exposes no documented conversation/session id env var to tool subprocesses
  // (checked against `opencode --help` / `opencode run --help` and references/providers.md) —
  // deriving a conversation-slug key for it is not possible; callers fall through to the
  // existing hard error when branch derivation also fails.
  opencode: [],
};

/**
 * Derives a `conversation-<8 chars>` slug fallback key from the active orchestrator's own
 * conversation/session id env var. Used only when both `--slug` and branch derivation have
 * failed (protected branch / detached HEAD).
 *
 * @param {{ orchestrator?: string|null, env?: NodeJS.ProcessEnv }} [options]
 * @returns {string|null} `null` when the orchestrator is unknown, has no id env var
 *   configured, the env var is unset, or sanitization leaves nothing usable.
 */
export function deriveConversationKey({ orchestrator = detectOrchestrator(), env = process.env } = {}) {
  const envVars = CONVERSATION_ID_ENV_VARS[orchestrator] ?? [];
  for (const key of envVars) {
    const raw = env[key];
    if (!raw) continue;
    // Truncate before sanitizing trailing dashes: an 8-char slice of a hyphenated id can
    // itself end in `-`, which would violate SLUG_PATTERN if left untrimmed.
    const truncated = raw.slice(0, 8).replace(/-+$/, '');
    const sanitized = sanitizeSlug(truncated);
    if (sanitized) return `conversation-${sanitized}`;
  }
  return null;
}

/**
 * Resolves the artifact slug and its source, in precedence order: explicit `--slug` →
 * branch-derived → orchestrator conversation id. `null` when every source fails — the
 * caller (CLI) reports a single error naming all three.
 *
 * @param {{ explicit?: string, branch?: string|null, orchestrator?: string|null, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ slug: string, slugSource: 'explicit'|'branch'|'conversation' } | { slug: null, slugSource: null }}
 */
export function resolveSlug({ explicit, branch = getCurrentBranch(), orchestrator = detectOrchestrator(), env = process.env } = {}) {
  if (explicit !== undefined) {
    return { slug: explicit, slugSource: 'explicit' };
  }
  const fromBranch = deriveSlugFromBranch(branch);
  if (fromBranch) {
    return { slug: fromBranch, slugSource: 'branch' };
  }
  const fromConversation = deriveConversationKey({ orchestrator, env });
  if (fromConversation) {
    return { slug: fromConversation, slugSource: 'conversation' };
  }
  return { slug: null, slugSource: null };
}

// ============================================================================
// SECTION: Discovery: native tier
// ============================================================================

/**
 * Known platform-native artifact locations, newest-file-wins across all of them.
 * Covers every Antigravity execution mode's own data dir (`AGY_MODE_DATA_DIRS`:
 * 2.0, VS Code extension, CLI) — each keeps its own `brain/` directory. Extend
 * this list as more platforms grow a discoverable native artifact.
 */
export function defaultNativeCandidateRoots({ platform = process.platform, env = process.env } = {}) {
  const homeDir = os.homedir();
  const dataDirs = Object.values(AGY_MODE_DATA_DIRS);
  const roots = dataDirs.map(dataDir => path.join(homeDir, '.gemini', dataDir));
  // Mirrors runners/agy.mjs's convention (see getNewestBrainConversationId): APPDATA/
  // LOCALAPPDATA are Windows-only env vars, gated on platform rather than mere
  // presence for consistency with it.
  if (platform === 'win32') {
    for (const dataDir of dataDirs) {
      if (env.APPDATA) roots.push(path.join(env.APPDATA, dataDir));
      if (env.LOCALAPPDATA) roots.push(path.join(env.LOCALAPPDATA, dataDir));
    }
  }
  return roots;
}

const NATIVE_FILENAME = { plan: 'implementation_plan.md', walkthrough: 'walkthrough.md', design: 'technical_design.md' };

export function isNativeArtifactPath(file, kind = 'plan', { roots = defaultNativeCandidateRoots() } = {}) {
  const absolute = path.resolve(file);
  if (path.basename(absolute) !== NATIVE_FILENAME[kind]) return false;
  return roots.some((root) => {
    const relative = path.relative(path.resolve(root), absolute);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

/** Platforms with a known, discoverable native artifact. */
const NATIVE_ARTIFACT_ORCHESTRATORS = new Set(['agy']);

/**
 * Resolves the current native artifact, scoped to the running session.
 *
 * The brain directory holds every Antigravity conversation on the machine, not
 * just this one — scanning it cross-conversation by mtime would surface a
 * walkthrough from an unrelated task the moment any other Antigravity session
 * touched its own artifact more recently. Two guards keep this scoped:
 *   1. Only scan at all when the orchestrator actually is `agy` — running under
 *      Claude Code or any other platform has no native artifact to find, so this
 *      short-circuits to null rather than returning someone else's file.
 *   2. When `ANTIGRAVITY_CONVERSATION_ID` names the active conversation, look up
 *      that exact directory instead of guessing from file mtimes. The mtime scan
 *      is a best-effort fallback for the rare case that id isn't available.
 *
 * `roots`, `orchestrator`, and `conversationId` are injectable so callers
 * (tests, or a sandboxed run) can scope the scan away from the real machine's
 * platform directories; they default to `defaultNativeCandidateRoots()`,
 * `detectOrchestrator()`, and `process.env.ANTIGRAVITY_CONVERSATION_ID`.
 *
 * @param {'plan'|'walkthrough'} kind
 * @param {{ roots?: string[], orchestrator?: string|null, conversationId?: string|null }} [options]
 * @returns {string|null} absolute path
 */
function findNativeArtifact(kind, options = {}) {
  const orchestrator = options.orchestrator !== undefined ? options.orchestrator : detectOrchestrator();
  // Checked before constructing `roots` (which stats env vars and joins paths for
  // every AGY_MODE_DATA_DIRS entry) so a non-agy orchestrator short-circuits cheaply.
  if (!NATIVE_ARTIFACT_ORCHESTRATORS.has(orchestrator)) return null;

  const {
    roots = defaultNativeCandidateRoots(),
    conversationId: rawConversationId = process.env.ANTIGRAVITY_CONVERSATION_ID ?? null,
  } = options;
  // Treat a malformed id (e.g. containing `../`) as absent rather than letting it
  // traverse out of the brain dir when interpolated into the path.join below.
  const conversationId =
    rawConversationId && CONVERSATION_ID_PATTERN.test(rawConversationId) ? rawConversationId : null;

  const filename = NATIVE_FILENAME[kind];

  if (conversationId) {
    for (const root of roots) {
      const candidate = path.join(root, 'brain', conversationId, filename);
      if (existsSync(candidate)) return candidate.split(path.sep).join('/');
    }
    return null;
  }

  // Best-effort fallback: no conversation id available, so guess by recency
  // across every conversation this orchestrator has ever touched.
  let newest = null;
  for (const root of roots) {
    const brainDir = path.join(root, 'brain');
    if (!existsSync(brainDir)) continue;
    let entries;
    try {
      entries = readdirSync(brainDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(brainDir, entry.name, filename);
      let stat;
      try {
        stat = statSync(candidate);
      } catch {
        continue;
      }
      if (!newest || stat.mtimeMs > newest.mtimeMs) {
        newest = { path: candidate, mtimeMs: stat.mtimeMs };
      }
    }
  }
  return newest ? newest.path.split(path.sep).join('/') : null;
}

// ============================================================================
// SECTION: Discovery: existing scratch tier
// ============================================================================

/**
 * Finds an existing scratch artifact matching the slug regardless of date
 * (a review can run the day after planning), newest-file-wins if more than
 * one date matches. Returns a repo-relative posix path, or null.
 *
 * @param {'plan'|'walkthrough'} kind
 * @param {string} slug
 * @param {string} projectRoot
 * @returns {string|null}
 */
export function findExistingScratchArtifact(kind, slug, projectRoot = PROJECT_ROOT) {
  // `slug` is interpolated into a RegExp source below; guard against a caller that
  // bypasses `resolveArtifacts`'/the CLI's validation and hands this a slug with
  // regex-special characters. `typeof` is checked first because `RegExp.test`
  // coerces `undefined`/`null` to the string literals "undefined"/"null", both of
  // which satisfy SLUG_PATTERN and would otherwise slip past this guard.
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
    throw new Error(`Slug "${slug}" must be kebab-case (${SLUG_PATTERN.source})`);
  }

  const dir = path.join(projectRoot, ...SCRATCH_DIR.split('/'));
  if (!existsSync(dir)) return null;

  const suffix = kind === 'walkthrough' ? '-walkthrough.md' : '.md';
  const pattern = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${slug}${suffix.replace('.', '\\.')}$`);
  // The plan pattern anchors on `<slug>\.md$`, which cannot match `<slug>-walkthrough.md`
  // (the literal `-walkthrough` before `.md` breaks the anchor) — no extra guard needed.

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  let newest = null;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!pattern.test(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (!newest || stat.mtimeMs > newest.mtimeMs) {
      newest = { name: entry.name, mtimeMs: stat.mtimeMs };
    }
  }

  return newest ? path.posix.join(SCRATCH_DIR, newest.name) : null;
}

// ============================================================================
// SECTION: Discovery: existing temp tier (relocated scratch artifacts)
// ============================================================================

/**
 * Finds an existing artifact in OS temp matching the slug regardless of date
 * (e.g. relocated from .scratch/plan/ during a prior run or step in this session),
 * newest-file-wins if more than one date matches. Returns an absolute posix path, or null.
 *
 * @param {'plan'|'walkthrough'} kind
 * @param {string} slug
 * @param {string} [tempRoot]
 * @returns {string|null}
 */
export function findExistingTempArtifact(kind, slug, tempRoot = os.tmpdir()) {
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
    throw new Error(`Slug "${slug}" must be kebab-case (${SLUG_PATTERN.source})`);
  }
  if (!existsSync(tempRoot)) return null;

  const pattern = kind === 'walkthrough'
    ? new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${slug}-walkthrough(?:-\\d+)*\\.md$`)
    : new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${slug}(?:-\\d+)*\\.md$`);

  let entries;
  try {
    entries = readdirSync(tempRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  let newest = null;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (kind === 'plan' && entry.name.includes('-walkthrough')) continue;
    if (!pattern.test(entry.name)) continue;
    const abs = path.join(tempRoot, entry.name);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (!newest || stat.mtimeMs > newest.mtimeMs) {
      newest = { path: abs.split(path.sep).join('/'), mtimeMs: stat.mtimeMs };
    }
  }

  return newest ? newest.path : null;
}

// ============================================================================
// SECTION: Core resolution
// ============================================================================

/** Canonical increment artifact path:
 *  `.scratch/plan/<yyyy-mm-dd>-<design-slug>-i<NN>-<increment-slug>-plan|walkthrough>.md`.
 *  Returns `{date, designRootSlug, incrementId, incrementSlug, kind}` or null. */
const INCREMENT_ARTIFACT_PATTERN = /^\.scratch\/plan\/(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*?)-i(\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)-(plan|walkthrough)\.md$/;

export function parseIncrementArtifactPath(value) {
  const normalized = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  const match = INCREMENT_ARTIFACT_PATTERN.exec(normalized);
  if (!match) return null;
  const [, date, designRootSlug, digits, incrementSlug, suffix] = match;
  if (/(^|-)i\d{2}-/.test(incrementSlug) || /(^|-)i\d{2}$/.test(incrementSlug)) {
    throw new Error(`Increment artifact path "${normalized}" is ambiguous: the increment slug contains a second -i${digits}- segment.`);
  }
  return {
    date,
    designRootSlug,
    incrementId: `I${digits}`,
    incrementSlug,
    kind: suffix === 'plan' ? 'increment-plan' : 'increment-walkthrough',
  };
}

/** Bounded off-date scan: a reserved-form artifact for the same root slug at another date
 *  must not be silently shadowed by a new-dated phased artifact. */
function assertNoOffDateReservedCollision(kind, slug, projectRoot, resolvedDate) {
  const scratchDir = path.resolve(projectRoot, SCRATCH_DIR);
  let entries;
  try {
    entries = fs.readdirSync(scratchDir);
  } catch {
    return;
  }
  const requestedRoot = kind === 'increment-plan' || kind === 'increment-walkthrough'
    ? /^([a-z0-9]+(?:-[a-z0-9]+)*?)-i\d{2}-(?:[a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(slug)?.[1] ?? slug
    : slug;
  if (!requestedRoot) return;
  for (const entry of entries) {
    const dated = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/.exec(entry);
    if (!dated) continue;
    const [, fileDate, candidateSlug] = dated;
    if (!isReservedOrdinarySlug(candidateSlug) || candidateSlug === slug) continue;
    const reservedRoot = phasedRootSlug(candidateSlug);
    if (reservedRoot && reservedRoot === requestedRoot && fileDate !== resolvedDate) {
      throw new Error(`Phased ${kind} slug "${slug}" collides with reserved artifact "${entry}" for the same root slug "${requestedRoot}" at another date; use the design's canonical date and slug.`);
    }
  }
}

/** Root slug of a reserved-form slug: `X-design`, `X-integration(-walkthrough)`, or `X-i<NN>-…`. */
function phasedRootSlug(candidateSlug) {
  if (/^([a-z0-9]+(?:-[a-z0-9]+)*)-design$/.test(candidateSlug)) {
    return /^([a-z0-9]+(?:-[a-z0-9]+)*)-design$/.exec(candidateSlug)[1];
  }
  if (/^([a-z0-9]+(?:-[a-z0-9]+)*)-integration(?:-walkthrough)?$/.test(candidateSlug)) {
    return /^([a-z0-9]+(?:-[a-z0-9]+)*)-integration(?:-walkthrough)?$/.exec(candidateSlug)[1];
  }
  if (/^([a-z0-9]+(?:-[a-z0-9]+)*?)-i\d{2}-.+$/.test(candidateSlug)) {
    return /^([a-z0-9]+(?:-[a-z0-9]+)*?)-i\d{2}-.+$/.exec(candidateSlug)[1];
  }
  return null;
}

/**
 * Resolves one artifact kind: native tier, then existing scratch, then existing
 * temp artifact (this repository's relocated scratch), then the deterministic scratch-new path.
 *
 * @param {'plan'|'walkthrough'} kind
 * @param {{ slug: string, date: string, projectRoot?: string, tempRoot?: string, native?: { roots?: string[], orchestrator?: string|null, conversationId?: string|null } }} options
 * @returns {{ tier: 'native'|'scratch-existing'|'temp-existing'|'scratch-new', path: string, exists: boolean }}
 */
export function resolveArtifactPath(kind, { slug, date, projectRoot = PROJECT_ROOT, tempRoot = os.tmpdir(), native: nativeOptions = {} } = {}) {
  if (PHASED_KINDS.includes(kind)) {
    const resolvedDate = date ?? localDate();
    const canonical = buildScratchPaths(resolvedDate, slug, kind);
    assertNoOffDateReservedCollision(kind, slug, projectRoot, resolvedDate);
    const absolute = path.resolve(projectRoot, canonical);
    if (existsSync(absolute)) {
      const source = fs.readFileSync(absolute, 'utf8');
      const metadataKind = /^---\n\{\s*"dispatch"\s*:\s*\{[\s\S]*?"kind"\s*:\s*"([^"]+)"/m.exec(source)?.[1] ?? null;
      if (!metadataKind) {
        throw new Error(`Canonical ${kind} path is occupied by a metadata-less artifact; relocate it or choose a non-colliding slug.`);
      }
      if (metadataKind !== kind) {
        throw new Error(`Canonical ${kind} path is occupied by metadata kind "${metadataKind}"; choose a non-colliding slug.`);
      }
      return { tier: 'scratch-existing', path: canonical, exists: true, scratchOnly: true };
    }
    return { tier: 'scratch-new', path: canonical, exists: false, scratchOnly: true };
  }
  const native = findNativeArtifact(kind, nativeOptions);
  if (native) return { tier: 'native', path: native, exists: true };

  const existing = findExistingScratchArtifact(kind, slug, projectRoot);
  if (existing) return { tier: 'scratch-existing', path: existing, exists: true };

  const existingTemp = findExistingTempArtifact(kind, slug, relocatedArtifactsPath({ projectRoot, tempRoot }));
  if (existingTemp) return { tier: 'temp-existing', path: existingTemp, exists: true };

  return { tier: 'scratch-new', path: buildScratchPaths(date ?? localDate(), slug)[kind], exists: false };
}

/**
 * Resolves plan and/or walkthrough artifact paths together.
 *
 * @param {{ slug: string, date?: string, kinds?: ('plan'|'walkthrough')[], projectRoot?: string, tempRoot?: string, native?: { roots?: string[], orchestrator?: string|null, conversationId?: string|null } }} options
 * @returns {{ slug: string, date: string, plan?: object, walkthrough?: object }}
 */
export function resolveArtifacts({
  slug,
  slugSource = null,
  date,
  kinds = ['plan', 'walkthrough'],
  projectRoot = PROJECT_ROOT,
  tempRoot = os.tmpdir(),
  repositoryRoot,
  ledger = {},
  native,
}) {
  // See findExistingScratchArtifact for why `typeof` is checked before SLUG_PATTERN.
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
    throw new Error(`Slug "${slug}" must be kebab-case (${SLUG_PATTERN.source})`);
  }
  if (['plan', 'walkthrough'].some(kind => kinds.includes(kind)) && isReservedOrdinarySlug(slug)) {
    throw new Error(`Slug "${slug}" is reserved for phased artifacts; choose a non-reserved ordinary slug.`);
  }
  if (kinds.some(kind => ['design', 'integration-walkthrough'].includes(kind)) && isReservedOrdinarySlug(slug)) {
    throw new Error(`Design root slug "${slug}" contains a reserved phased suffix; choose an unambiguous root slug.`);
  }
  const resolvedDate = date ?? localDate();
  if (!isValidDate(resolvedDate)) {
    throw new Error(`Date "${resolvedDate}" must be a valid calendar date as yyyy-mm-dd`);
  }

  const resolvedRepositoryRoot =
    repositoryRoot === undefined && ['explicit', 'branch'].includes(slugSource)
      ? getRepositoryRoot(projectRoot)
      : repositoryRoot ?? null;
  const result = {
    slug,
    date: resolvedDate,
    ledgerPath: resolveLedgerPath({
      slug,
      slugSource,
      repositoryRoot: resolvedRepositoryRoot,
      ...ledger,
    }),
  };
  for (const kind of kinds) {
    result[kind] = resolveArtifactPath(kind, { slug, date: resolvedDate, projectRoot, tempRoot, native });
  }
  return result;
}
