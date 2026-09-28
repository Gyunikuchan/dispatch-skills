// @ts-check
/**
 * Resolves plan/walkthrough artifact paths deterministically, so the review-flow skills (see
 * `references/review.md`) — run together or independently — converge on the same on-disk
 * file for a given change instead of each inventing its own slug or re-authoring a copy.
 *
 * Resolution order per kind (native artifacts always win over scratch):
 *   1. Platform-native artifact (currently: Antigravity's brain dir) — only scanned
 *      when the orchestrator actually is that platform; scoped to the exact active
 *      conversation when its id is known, else a same-platform recency guess.
 *   2. Existing scratch artifact matching the slug — reuse, don't re-author.
 *   3. Session-new: the deterministic `<session>/artifacts/<slug>[-walkthrough].md` path.
 *
 * Usage:
 *   node artifacts/resolve-paths.mjs [--slug <kebab-slug>] [--kind plan|walkthrough|both] [--orchestrator <name>]
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
 * Outputs JSON: `{ slug, slugSource, ledgerPath, plan?: { tier, path, exists }, walkthrough?: { tier, path, exists } }`.
 * `tier` is `native`, `session-import`, `scratch-existing`, or `scratch-new`. `slugSource` is
 * `explicit`, `branch`, or `conversation`.
 */

import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { showToplevel } from '../lib/git-root.mjs';
import { PROJECT_ROOT, spawnCliSync } from '../lib/platform.mjs';
import { detectOrchestrator } from '../lib/providers.mjs';
import { AGY_MODE_DATA_DIRS } from '../runners/agy.mjs';
import { assertWorkflowSession, sessionArea } from '../lib/session-temp.mjs';

/** @typedef {'design'|'plan'|'increment-plan'|'walkthrough'|'increment-walkthrough'|'integration-walkthrough'} ArtifactKind */
/** @typedef {'native'|'session-import'|'scratch-existing'|'scratch-new'} ArtifactTier */
/** @typedef {{ roots?: string[], orchestrator?: string|null, conversationId?: string|null }} NativeOptions */
/** @typedef {{ tier: ArtifactTier, path: string, exists: boolean, scratchOnly?: boolean }} ResolvedArtifact */

export const SCRATCH_DIR = 'artifacts';
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const PHASED_KINDS = /** @type {readonly ArtifactKind[]} */ (Object.freeze(['design', 'increment-plan', 'increment-walkthrough', 'integration-walkthrough']));
export const RESERVED_SLUG_PATTERN = /(?:-design|-integration(?:-walkthrough)?|-i\d{2}-.+)$/;

const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop', 'trunk', 'head']);
const BRANCH_PREFIX_PATTERN = /^(feature|feat|fix|bugfix|hotfix|chore|refactor|release)\//;
const MAX_SLUG_LENGTH = 60;
const NATIVE_ARTIFACT_ORCHESTRATORS = new Set(['agy']);
const NATIVE_FILENAME = Object.freeze({
  design: 'technical_design.md',
  plan: 'implementation_plan.md',
  walkthrough: 'walkthrough.md',
});
const INCREMENT_ARTIFACT_PATTERN = /(?:^|\/)artifacts\/([a-z0-9]+(?:-[a-z0-9]+)*?)-i(\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)-(plan|walkthrough)\.md$/;

/** Env vars carrying conversation/session identity, scoped to the detected orchestrator. */
const CONVERSATION_ID_ENV_VARS = Object.freeze({
  agy: ['ANTIGRAVITY_CONVERSATION_ID', 'ANTIGRAVITY_SESSION_ID'],
  claude: ['CLAUDE_CODE_SESSION_ID'],
  copilot: ['COPILOT_CLI_SESSION_ID'],
  // OpenCode exposes no documented identity env var to tool subprocesses.
  opencode: [],
});

// SECTION: Public validation and path APIs

/** @param {unknown} slug */
export function isReservedOrdinarySlug(slug) {
  return typeof slug === 'string' && RESERVED_SLUG_PATTERN.test(slug);
}

/**
 * Builds canonical scratch paths. The default returns the ordinary plan/walkthrough map;
 * an explicit phased kind returns only that kind's path.
 *
 * @param {string} slug - Kebab-case artifact identity.
 * @param {ArtifactKind} [kind]
 * @returns {Record<ArtifactKind, string>|string}
 */
export function buildScratchPaths(slug, kind = 'plan') {
  const artifacts = sessionArea('artifacts');
  const paths = {
    plan: path.join(artifacts, `${slug}.md`),
    walkthrough: path.join(artifacts, `${slug}-walkthrough.md`),
    design: path.join(artifacts, `${slug}-design.md`),
    'increment-plan': path.join(artifacts, `${slug}-plan.md`),
    'increment-walkthrough': path.join(artifacts, `${slug}-walkthrough.md`),
    'integration-walkthrough': path.join(artifacts, `${slug}-integration-walkthrough.md`),
  };
  if (!Object.hasOwn(paths, kind)) throw new Error(`Unknown artifact kind "${kind}"`);
  return kind === 'plan' || kind === 'walkthrough' ? paths : paths[kind];
}

export function getRepositoryRoot(cwd = PROJECT_ROOT) {
  return showToplevel(cwd);
}

/** @param {{ slug?: string, slugSource?: string|null, repositoryRoot?: string|null, artifactKind?: ArtifactKind }} [options] */
export function resolveLedgerPath({ slug, slugSource, repositoryRoot } = {}) {
  if (!repositoryRoot || !['explicit', 'branch'].includes(slugSource)) return null;
  assertWorkflowSession({ repositoryRoot });
  return path.join(ledgerNamespacePath(), `${slug}-ledger.md`);
}

export function ledgerNamespacePath() { return sessionArea('ledger'); }

/**
 * Slug of this session's most recent ordinary run whose baseline commit lies within the reviewed
 * bounds (`baseSha` ancestor-or-equal, `headSha` descendant-or-equal) and whose walkthrough exists,
 * so a code review finds an implement run's plan-named walkthrough. Working-tree reviews pass no
 * bounds, which requires the baseline to equal HEAD.
 *
 * @param {string} repoRoot
 * @param {{ baseSha?: string|null, headSha?: string|null }} [bounds]
 * @returns {string|null}
 */
export function ledgerWalkthroughSlug(repoRoot, { baseSha = null, headSha = null } = {}) {
  let files;
  try { files = readdirSync(ledgerNamespacePath()).filter((name) => name.endsWith('-ledger.md')); } catch { return null; }
  const candidates = [];
  for (const name of files) {
    const slug = name.slice(0, -'-ledger.md'.length);
    if (!SLUG_PATTERN.test(slug) || isReservedOrdinarySlug(slug)) continue;
    let text;
    try { text = fs.readFileSync(path.join(ledgerNamespacePath(), name), 'utf8'); } catch { continue; }
    // NOTE: parsed inline because ledger.mjs imports this module; torn or malformed lines are skipped.
    for (const line of text.split('\n')) {
      const json = /^- event: (\{.*\})$/.exec(line)?.[1];
      if (!json) continue;
      let event;
      try { event = JSON.parse(json); } catch { continue; }
      const commit = event?.data?.baseline?.commit;
      if (event.type === 'run-start' && event.data.action === 'ordinary' && typeof commit === 'string') {
        candidates.push({ slug, at: String(event.at ?? ''), commit });
      }
    }
  }
  candidates.sort((a, b) => b.at.localeCompare(a.at));
  const isAncestor = (older, newer) => spawnCliSync('git', ['merge-base', '--is-ancestor', older, newer], { cwd: repoRoot, encoding: 'utf8', timeout: 5000 }).status === 0;
  for (const { slug, commit } of candidates) {
    const walkthrough = /** @type {Record<ArtifactKind, string>} */ (buildScratchPaths(slug)).walkthrough;
    if (!existsSync(walkthrough)) continue;
    if (isAncestor(commit, headSha ?? 'HEAD') && isAncestor(baseSha ?? 'HEAD', commit)) return slug;
  }
  return null;
}

// SECTION: Slug derivation

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

// SECTION: Native artifact discovery

/**
 * Known platform-native artifact locations, newest-file-wins across all of them.
 * Covers every Antigravity execution mode's own data dir (`AGY_MODE_DATA_DIRS`:
 * 2.0, VS Code extension, CLI) — each keeps its own `brain/` directory. Extend
 * this list as more platforms grow a discoverable native artifact.
 *
 * @param {{ platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv }} [options]
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

/**
 * Tests whether a path has the exact native filename under a configured platform root.
 *
 * @param {string} file
 * @param {'design'|'plan'|'walkthrough'} [kind]
 * @param {{ roots?: string[] }} [options]
 * @returns {boolean}
 */
export function isNativeArtifactPath(file, kind = 'plan', { roots = defaultNativeCandidateRoots() } = {}) {
  const absolute = path.resolve(file);
  if (path.basename(absolute) !== NATIVE_FILENAME[kind]) return false;
  return roots.some((root) => {
    const relative = path.relative(path.resolve(root), absolute);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

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
 * @param {string} kind
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
 * Finds an existing scratch artifact for the slug (a review can run in a later chat turn than
 * planning). Returns its path, or null.
 *
 * @param {string} kind
 * @param {string} slug
 * @param {string} projectRoot
 * @returns {string|null}
 */
export function findExistingScratchArtifact(kind, slug, projectRoot = PROJECT_ROOT) {
  // Guards callers that bypass `resolveArtifacts`' validation; `typeof` first because
  // `RegExp.test` coerces `undefined`/`null` to strings that satisfy SLUG_PATTERN.
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
    throw new Error(`Slug "${slug}" must be kebab-case (${SLUG_PATTERN.source})`);
  }
  const paths = /** @type {Record<ArtifactKind, string>} */ (buildScratchPaths(slug));
  const candidate = paths[kind === 'walkthrough' ? 'walkthrough' : 'plan'];
  // lstat: a symlinked artifact could pull content from outside the session into a brief.
  try { return lstatSync(candidate).isFile() ? candidate : null; } catch { return null; }
}

// ============================================================================
// SECTION: Core resolution
// ============================================================================

/** Canonical increment artifact path:
 *  `<session>/artifacts/<design-slug>-i<NN>-<increment-slug>-plan|walkthrough>.md`.
 *  Returns `{designRootSlug, incrementId, incrementSlug, kind}` or null. */
export function parseIncrementArtifactPath(value) {
  const normalized = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  const match = INCREMENT_ARTIFACT_PATTERN.exec(normalized);
  if (!match) return null;
  const [, designRootSlug, digits, incrementSlug, suffix] = match;
  if (/(^|-)i\d{2}-/.test(incrementSlug) || /(^|-)i\d{2}$/.test(incrementSlug)) {
    throw new Error(`Increment artifact path "${normalized}" is ambiguous: the increment slug contains a second -i${digits}- segment.`);
  }
  return {
    designRootSlug,
    incrementId: `I${digits}`,
    incrementSlug,
    kind: suffix === 'plan' ? 'increment-plan' : 'increment-walkthrough',
  };
}

/** Refuses a symlink at a canonical path: following it would read content from outside the session. */
function assertNotSymlink(file) {
  let stat;
  try { stat = lstatSync(file); } catch { return; }
  if (stat.isSymbolicLink()) throw new Error(`Canonical artifact path ${file} is a symlink; replace it with a regular file.`);
}

/**
 * Resolves one artifact kind: native working copy, existing session artifact, or new session path.
 *
 * @param {ArtifactKind} kind
 * @param {{ slug?: string, projectRoot?: string, repositoryRoot?: string|null, native?: NativeOptions }} options
 * @returns {ResolvedArtifact}
 */
export function resolveArtifactPath(kind, { slug, projectRoot = PROJECT_ROOT, repositoryRoot, native: nativeOptions = {} } = {}) {
  if (PHASED_KINDS.includes(kind)) {
    const canonical = /** @type {string} */ (buildScratchPaths(slug, kind));
    const absolute = canonical;
    assertNotSymlink(absolute);
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
  if (native) {
    const built = buildScratchPaths(slug, kind === 'plan' || kind === 'walkthrough' ? 'plan' : kind);
    const target = kind === 'plan' || kind === 'walkthrough'
      ? /** @type {Record<ArtifactKind, string>} */ (built)[kind]
      : /** @type {string} */ (built);
    if (path.resolve(native) === path.resolve(target)) return { tier: 'native', path: target, exists: true };
    assertNotSymlink(target);
    if (!existsSync(target)) {
      try { fs.copyFileSync(native, target, fs.constants.COPYFILE_EXCL); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    return { tier: 'session-import', path: target, exists: true };
  }

  const existing = findExistingScratchArtifact(kind, slug, projectRoot);
  if (existing) return { tier: 'scratch-existing', path: existing, exists: true };

  const paths = /** @type {Record<ArtifactKind, string>} */ (buildScratchPaths(slug));
  return { tier: 'scratch-new', path: paths[kind], exists: false };
}

/**
 * Resolves plan and/or walkthrough artifact paths together.
 *
 * @param {{ slug: string, slugSource?: string|null, kinds?: ArtifactKind[], projectRoot?: string, repositoryRoot?: string|null, native?: NativeOptions }} options
 * @returns {{ slug: string, plan?: Record<string, any>, walkthrough?: Record<string, any> }}
 */
export function resolveArtifacts({
  slug,
  slugSource = null,
  kinds = ['plan', 'walkthrough'],
  projectRoot = PROJECT_ROOT,
  repositoryRoot,
  native,
}) {
  // See findExistingScratchArtifact for why `typeof` is checked before SLUG_PATTERN.
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
    throw new Error(`Slug "${slug}" must be kebab-case (${SLUG_PATTERN.source})`);
  }
  if ((kinds.includes('plan') || kinds.includes('walkthrough')) && isReservedOrdinarySlug(slug)) {
    throw new Error(`Slug "${slug}" is reserved for phased artifacts; choose a non-reserved ordinary slug.`);
  }
  if (kinds.some(kind => ['design', 'integration-walkthrough'].includes(kind)) && isReservedOrdinarySlug(slug)) {
    throw new Error(`Design root slug "${slug}" contains a reserved phased suffix; choose an unambiguous root slug.`);
  }
  const resolvedRepositoryRoot =
    repositoryRoot === undefined && ['explicit', 'branch'].includes(slugSource)
      ? getRepositoryRoot(projectRoot)
      : repositoryRoot ?? null;
  const result = {
    slug,
    ledgerPath: resolveLedgerPath({
      slug,
      slugSource,
      repositoryRoot: resolvedRepositoryRoot,
      artifactKind: kinds.some(kind => kind === 'design' || kind.startsWith('increment-') || kind === 'integration-walkthrough') ? 'design' : 'plan',
    }),
  };
  for (const kind of kinds) {
    result[kind] = resolveArtifactPath(kind, { slug, projectRoot, repositoryRoot: resolvedRepositoryRoot ?? projectRoot, native });
  }
  return result;
}
