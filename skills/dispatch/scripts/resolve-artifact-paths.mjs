#!/usr/bin/env node
/**
 * Resolves plan/walkthrough artifact paths deterministically, so
 * `implement-dispatch`, `dispatch-plan-review`, and `dispatch-code-review` — run
 * together or independently — converge on the same on-disk file for a given
 * change instead of each inventing its own slug or re-authoring a copy.
 *
 * Resolution order per kind (native artifacts always win over scratch):
 *   1. Platform-native artifact (currently: Antigravity's brain dir) — only scanned
 *      when the orchestrator actually is that platform; scoped to the exact active
 *      conversation when its id is known, else a same-platform recency guess.
 *   2. Existing scratch artifact matching the slug (any date) — reuse, don't re-author.
 *   3. Scratch-new: the deterministic `.scratch/plan/<date>-<slug>[-walkthrough].md` path.
 *
 * Usage:
 *   node resolve-artifact-paths.mjs [--slug <kebab-slug>] [--date <yyyy-mm-dd>]
 *                                   [--kind plan|walkthrough|both] [--orchestrator <name>]
 *
 * `--slug` is optional: when omitted it is derived, in order, from (1) the current git
 * branch (prefix stripped, kebab-cased) or (2) the active orchestrator's own
 * conversation/session id (truncated to 8 chars, prefixed `conversation-`). Branch
 * derivation fails on a protected branch (main/master/develop/trunk) or detached HEAD;
 * conversation-id derivation fails when the orchestrator exposes no such env var (e.g.
 * OpenCode, today) — pass `--slug` explicitly if both fail.
 *
 * `--orchestrator` overrides the auto-detected orchestrator platform (same
 * detection `dispatch` uses); it gates native-tier scanning, which only ever
 * applies to platforms with a known native artifact (currently `agy`), and is also
 * the platform consulted for conversation-id slug derivation.
 *
 * Outputs JSON: `{ slug, slugSource, date, plan?: { tier, path, exists }, walkthrough?: { tier, path, exists } }`.
 * `tier` is `native`, `scratch-existing`, or `scratch-new`. `slugSource` is
 * `explicit`, `branch`, or `conversation`.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PROJECT_ROOT, isMainModule, spawnCliSync } from './common.mjs';
import { detectOrchestrator } from './dispatch.mjs';
import { AGY_MODE_DATA_DIRS } from './agy-run.mjs';

export const SCRATCH_DIR = '.scratch/plan';

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Antigravity conversation ids are opaque tokens; this rejects anything that could
 *  traverse out of the brain dir (e.g. `../`) when interpolated into a path.join. */
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop', 'trunk', 'head']);
const BRANCH_PREFIX_PATTERN = /^(feature|feat|fix|bugfix|hotfix|chore|refactor|release)\//;
const MAX_SLUG_LENGTH = 60;

// --- Date helpers ---

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

// --- Scratch path template (single source of truth for the canonical shape) ---

/**
 * @param {string} date - yyyy-mm-dd
 * @param {string} slug - kebab-case
 * @returns {{ plan: string, walkthrough: string }}
 */
export function buildScratchPaths(date, slug) {
  return {
    plan: path.posix.join(SCRATCH_DIR, `${date}-${slug}.md`),
    walkthrough: path.posix.join(SCRATCH_DIR, `${date}-${slug}-walkthrough.md`),
  };
}

// --- Slug derivation ---

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
 * (main/master/develop/trunk) or when nothing sanitizable remains — callers
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

// --- Discovery: native tier ---

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
  // Mirrors agy-run.mjs's convention (see getNewestBrainConversationId): APPDATA/
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

const NATIVE_FILENAME = { plan: 'implementation_plan.md', walkthrough: 'walkthrough.md' };

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
export function findNativeArtifact(kind, options = {}) {
  const orchestrator = options.orchestrator ?? detectOrchestrator();
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

// --- Discovery: existing scratch tier ---

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

// --- Core resolution ---

/**
 * Resolves one artifact kind: native tier, then existing scratch, then the
 * deterministic scratch-new path.
 *
 * @param {'plan'|'walkthrough'} kind
 * @param {{ slug: string, date: string, projectRoot?: string, native?: { roots?: string[], orchestrator?: string|null, conversationId?: string|null } }} options
 * @returns {{ tier: 'native'|'scratch-existing'|'scratch-new', path: string, exists: boolean }}
 */
export function resolveArtifactPath(kind, { slug, date, projectRoot = PROJECT_ROOT, native: nativeOptions = {} } = {}) {
  const native = findNativeArtifact(kind, nativeOptions);
  if (native) return { tier: 'native', path: native, exists: true };

  const existing = findExistingScratchArtifact(kind, slug, projectRoot);
  if (existing) return { tier: 'scratch-existing', path: existing, exists: true };

  return { tier: 'scratch-new', path: buildScratchPaths(date ?? localDate(), slug)[kind], exists: false };
}

/**
 * Resolves plan and/or walkthrough artifact paths together.
 *
 * @param {{ slug: string, date?: string, kinds?: ('plan'|'walkthrough')[], projectRoot?: string, native?: { roots?: string[], orchestrator?: string|null, conversationId?: string|null } }} options
 * @returns {{ slug: string, date: string, plan?: object, walkthrough?: object }}
 */
export function resolveArtifacts({ slug, date, kinds = ['plan', 'walkthrough'], projectRoot = PROJECT_ROOT, native }) {
  // See findExistingScratchArtifact for why `typeof` is checked before SLUG_PATTERN.
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
    throw new Error(`Slug "${slug}" must be kebab-case (${SLUG_PATTERN.source})`);
  }
  const resolvedDate = date ?? localDate();
  if (!isValidDate(resolvedDate)) {
    throw new Error(`Date "${resolvedDate}" must be a valid calendar date as yyyy-mm-dd`);
  }

  const result = { slug, date: resolvedDate };
  for (const kind of kinds) {
    result[kind] = resolveArtifactPath(kind, { slug, date: resolvedDate, projectRoot, native });
  }
  return result;
}

// --- CLI entry point ---

function parseArgs(args) {
  const opts = { kind: 'both' };
  const value = i => {
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`Missing value for ${args[i]}`);
    }
    return next;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      const flag = arg.slice(0, eq);
      const val = arg.slice(eq + 1);
      switch (flag) {
        case '--slug': opts.slug = val; continue;
        case '--date': opts.date = val; continue;
        case '--kind': opts.kind = val; continue;
        case '--orchestrator': opts.orchestrator = val; continue;
        default:
          throw new Error(`Unrecognized argument "${flag}"`);
      }
    }
    switch (arg) {
      case '--slug': opts.slug = value(i); i++; break;
      case '--date': opts.date = value(i); i++; break;
      case '--kind': opts.kind = value(i); i++; break;
      case '--orchestrator': opts.orchestrator = value(i); i++; break;
      default:
        throw new Error(`Unrecognized argument "${arg}"`);
    }
  }
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }

  if (!['plan', 'walkthrough', 'both'].includes(opts.kind)) {
    process.stderr.write(`Error: --kind must be one of plan, walkthrough, both\n`);
    process.exit(1);
  }
  const kinds = opts.kind === 'both' ? ['plan', 'walkthrough'] : [opts.kind];

  // typeof-first for the same reason as findExistingScratchArtifact/resolveArtifacts:
  // harmless today (argv values are always strings) but keeps the guard shape uniform.
  if (opts.slug !== undefined && (typeof opts.slug !== 'string' || !SLUG_PATTERN.test(opts.slug))) {
    process.stderr.write(`Error: Slug "${opts.slug}" must be kebab-case (${SLUG_PATTERN.source})\n`);
    process.exit(1);
  }

  const branch = getCurrentBranch();
  const { slug, slugSource } = resolveSlug({
    explicit: opts.slug,
    branch,
    orchestrator: opts.orchestrator ?? detectOrchestrator(),
  });
  if (!slug) {
    process.stderr.write(
      `Error: Could not derive a slug from the current branch ("${branch ?? 'unknown'}") ` +
        `or the active orchestrator's conversation id. Pass --slug <kebab-case-slug> explicitly.\n`,
    );
    process.exit(1);
  }

  if (opts.date !== undefined && !isValidDate(opts.date)) {
    process.stderr.write(`Error: Date "${opts.date}" must be a valid calendar date as yyyy-mm-dd\n`);
    process.exit(1);
  }

  let result;
  try {
    result = resolveArtifacts({
      slug,
      date: opts.date,
      kinds,
      native: opts.orchestrator !== undefined ? { orchestrator: opts.orchestrator } : undefined,
    });
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({ ...result, slugSource }, null, 2) + '\n');
}

if (isMainModule(import.meta.url)) {
  main();
}
