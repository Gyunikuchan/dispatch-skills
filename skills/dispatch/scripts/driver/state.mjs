// @ts-check
/**
 * Driver run state: a cache in the run's session directory (`lib/session-temp.mjs`, R3). Canonical
 * artifacts stay authoritative; a lost cache is rebuilt from the artifact's resolution log through `--run`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateConsensus } from '../review/consensus.mjs';
import { showToplevel } from '../lib/git-root.mjs';
import { safeRenameSync } from '../lib/platform.mjs';
import { scanResolutionLog } from '../review/resolution-log.mjs';
import { bindLegacyStateSession, bindRun, bindSession, isSessionDir, openSession, pruneSessions, runStatePath, SESSION_ENV, sessionDir } from '../lib/session-temp.mjs';

// SECTION: State storage

/** Repository root of `cwd`, or `cwd` itself outside a work tree. */
export function gitRoot(cwd) {
  const root = showToplevel(cwd);
  return path.resolve(root ?? cwd);
}

/** Writes a private run-scoped file beside the state file and queues it for cleanup. */
export function runFile(state, name, contents = '') {
  const file = path.join(path.dirname(state.stateFile), `${state.runId}-${name}`);
  fs.writeFileSync(file, contents, { mode: 0o600 });
  state.cleanup.push(file);
  return file;
}

export function sidecarPathFor(stateFile) {
  return stateFile.replace(/\.json$/, '.run.json');
}

function writeAtomic(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    safeRenameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/**
 * Creates a fresh run state with a new run ID. Top-level workflow binding happens before artifact
 * resolution; nested runs keep that session and receive their own `runs/<run-id>/` directory.
 */
export function createRunState(fields) {
  const runId = crypto.randomUUID();
  if (!process.env.DISPATCH_SESSION_DIR) openSession({ repositoryRoot: fields.repoRoot ?? null });
  else sessionDir();
  const stateFile = runStatePath(runId);
  return { v: 1, runId, stateFile, ...fields };
}

/** Binds the session that holds `stateFile`, so a `--next` process and its children share it. */
export function bindStateSession(stateFile) {
  let real;
  try { real = fs.realpathSync(path.resolve(stateFile)); } catch { return null; }
  const runDir = path.dirname(real);
  const runsDir = path.dirname(runDir);
  const session = path.dirname(runsDir);
  if (path.basename(real) === 'state.json' && path.basename(runsDir) === 'runs' && isSessionDir(session)) {
    const bound = bindSession(session);
    bindRun(path.basename(runDir));
    return bound;
  }
  try { return bindLegacyStateSession(real); } catch { return null; }
}

/** Reads a state file; throws with `code: 'STATE_UNREADABLE'` when missing or corrupt. */
export function readRunState(stateFile) {
  const resolved = path.resolve(stateFile);
  const boundSession = bindStateSession(resolved);
  let real = null;
  try { real = fs.realpathSync(resolved); } catch { real = null; }
  const parent = real && path.basename(real) === 'state.json' ? path.dirname(real) : null;
  const runParent = parent && path.basename(path.dirname(parent)) === 'runs' ? path.dirname(path.dirname(parent)) : null;
  const direct = Boolean(real && runParent && isSessionDir(runParent));
  const legacyBinding = Boolean(real && boundSession && process.env.DISPATCH_LEGACY_SESSION === '1' &&
    path.resolve(process.env[SESSION_ENV] ?? '') === path.resolve(boundSession) &&
    path.resolve(process.env.DISPATCH_LEGACY_STATE_FILE ?? '') === real);
  const legacy = Boolean(legacyBinding && path.dirname(real) === boundSession);
  const legacyNested = Boolean(legacyBinding && parent && runParent && path.basename(path.dirname(parent)) === 'runs' &&
    runParent === boundSession);
  let state = null;
  try {
    if (direct || legacy || legacyNested) state = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch {
    state = null;
  }
  const pathRunId = direct || legacyNested ? path.basename(parent) : legacy ? path.basename(real, '.json') : null;
  if (!state || state.v !== 1 || !state.runId || state.runId !== pathRunId) {
    throw Object.assign(new Error(`Driver state ${stateFile} is missing or unreadable.`), { code: 'STATE_UNREADABLE' });
  }
  return state;
}

// Hosted here so implement-phase can rebind it without importing index.mjs (an import cycle).
const DISPATCH_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dispatch.mjs');
const quote = (value) => (/[\s"']/.test(value) ? JSON.stringify(value) : value);

/** The exact `--run` command that resumes (or relaunches) a recorded invocation. */
export function resumeCommand(invocation) {
  const parts = ['node', quote(DISPATCH_SCRIPT), '--run', invocation.verb];
  if (invocation.kind) parts.push('--kind', invocation.kind);
  if (invocation.fix) parts.push('--fix');
  if (invocation.phases) parts.push('--phases', invocation.phases);
  if (invocation.levelSource !== 'default') parts.push('--level', invocation.level, '--level-source', invocation.levelSource);
  if (invocation.pins) parts.push('--pins', quote(invocation.pins));
  parts.push('--orchestrator', invocation.orchestrator);
  if (invocation.orchestratorModel) parts.push('--orchestrator-model', quote(invocation.orchestratorModel));
  if (invocation.argument) parts.push('--', quote(invocation.argument));
  return parts.join(' ');
}

export function writeRunState(state) {
  writeAtomic(state.stateFile, state);
}

/** Records the full normalized invocation so a lost state can name its resuming `--run`. */
export function writeRunSidecar(state, invocation) {
  writeAtomic(sidecarPathFor(state.stateFile), invocation);
}

export function readRunSidecar(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(sidecarPathFor(path.resolve(stateFile)), 'utf8'));
  } catch {
    return null;
  }
}

/** Counts rounds after the latest settled log prefix for standalone review recovery. */
function roundsSinceSettled(markdown, total) {
  const headings = [...markdown.matchAll(/^### Round \d+\b.*$/gm)].map((match) => match.index);
  for (let index = headings.length - 1; index >= 1; index--) {
    if (evaluateConsensus(markdown.slice(0, headings[index])).exit === 0) return total - index;
  }
  return total;
}

/**
 * Removes sessions untouched for `maxAgeMs`, finished or abandoned (an in-flight wave relaunches
 * whole via the sidecar anyway); best-effort.
 *
 * @param {{ maxAgeMs?: number, now?: number }} [options]
 */
export function pruneFinishedStates({ maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
  pruneSessions({ maxAgeMs, now });
}

/**
 * Rebuilds the review position from an artifact: rounds already logged and the unsettled items
 * (pending rebuttals and disputes). Returns null when the log is settled or absent.
 */
export function rebuildFromArtifact(artifactPath, budgetSeed = null) {
  if (!artifactPath || !fs.existsSync(artifactPath)) return null;
  const markdown = fs.readFileSync(artifactPath, 'utf8');
  const consensus = evaluateConsensus(markdown);
  const scan = scanResolutionLog(markdown, { strict: true });
  const pendingUser = scan.rounds.flatMap((round) => round.entries.filter((entry) => entry.status === 'pendingUser'));
  if (consensus.exit !== 1 && pendingUser.length === 0) return null;
  const reviewBudget = recoverReviewBudget(scan, budgetSeed);
  return {
    rounds: reviewBudget?.reviewWaves ?? roundsSinceSettled(markdown, scan.rounds.length),
    ...(reviewBudget ? { reviewBudget } : {}),
    unsettled: consensus.unsettledItems,
    pending: consensus.unsettledItems.filter((item) => item.status === 'pendingConfirmation').map((item) => item.key),
    pendingUser,
  };
}

function recoverReviewBudget(scan, seed) {
  if (!seed?.phase || !seed?.budgetId) return null;
  const matching = scan.reviewBudgetMarkers.filter((item) => item.phase === seed.phase && item.budgetId === seed.budgetId);
  const samePhase = scan.reviewBudgetMarkers.filter((item) => item.phase === seed.phase);
  const selectedId = matching.length ? seed.budgetId : samePhase.at(-1)?.budgetId;
  const selected = samePhase.filter((item) => item.budgetId === selectedId);
  const marker = selected.reduce((latest, item) => latest ? {
    ...latest,
    reviewWaves: Math.max(latest.reviewWaves, item.reviewWaves),
    roundLimit: Math.max(latest.roundLimit, item.roundLimit),
  } : item, null);
  return {
    schemaVersion: 1,
    phase: seed.phase,
    budgetId: marker?.budgetId ?? seed.budgetId,
    reviewWaves: Math.max(seed.reviewWaves ?? 0, marker?.reviewWaves ?? 0),
    roundLimit: Math.max(seed.roundLimit ?? 0, marker?.roundLimit ?? 0),
  };
}

/** Reason on the `unapplied` record a `--fix` run writes when it queues a fix or an adjacent opt-in item. */
export const PENDING_FIX_REASON = 'pending --fix';

// `[sources=…] <locus> — <tag>: <defect> → <resolution>`, the entry shape the driver writes.
const ENTRY_BODY = /\[sources=[^\]]*\]\s+.+? — [^:]+: (.*?) → /;

/**
 * Fixes a `--fix` run queued but never finished (the state cache was lost before apply-fixes or
 * the opt-in settled): accepted entries whose application record is still `unapplied` with the
 * pending reason. The record carries the real fix metadata and scope, so report-only rounds (no
 * records) and finished fixes (`applied`) are never re-derived.
 */
export function unappliedFixesFromArtifact(artifactPath, budgetSeed = null) {
  if (!artifactPath || !fs.existsSync(artifactPath)) return null;
  const markdown = fs.readFileSync(artifactPath, 'utf8');
  const scan = scanResolutionLog(markdown, { strict: true });
  const pending = [];
  const adjacent = [];
  const pendingUser = scan.rounds.flatMap((round) => round.entries.filter((entry) => entry.status === 'pendingUser'));
  for (const round of scan.rounds) {
    for (const entry of round.entries) {
      const record = entry.application;
      if (entry.status !== 'accepted' || record?.state !== 'unapplied' || record.reason !== PENDING_FIX_REASON) continue;
      const finding = {
        id: entry.id,
        severity: entry.severity,
        scope: record.scope,
        defect: ENTRY_BODY.exec(entry.originalLine)?.[1]?.trim() ?? entry.id,
        fix: { affectedPaths: record.affectedPaths, dependsOn: record.dependsOn, verification: record.verification },
        recorded: true,
      };
      (record.scope === 'adjacent' ? adjacent : pending).push(finding);
    }
  }
  if (pending.length === 0 && adjacent.length === 0 && pendingUser.length === 0) return null;
  const reviewBudget = recoverReviewBudget(scan, budgetSeed);
  return {
    rounds: reviewBudget?.reviewWaves ?? roundsSinceSettled(markdown, scan.rounds.length),
    ...(reviewBudget ? { reviewBudget } : {}),
    pending,
    adjacent,
    pendingUser,
  };
}

// SECTION: Shared transitions

// Re-emitted actions leave state untouched, so they are never written back.
export const REEMITTED = new WeakSet();

/** Records the next pending action (cleaning temp files on `done`); a re-emitted action returns untouched. */
export function finish(state, action) {
  if (REEMITTED.has(action)) return action;
  if (action.action === 'done') cleanupRun(state);
  state.pending = action;
  writeRunState(state);
  return action;
}

export function cleanupRun(state) {
  for (const target of state.cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true });
}

export function reemit(state, error) {
  const action = { ...state.pending, error };
  REEMITTED.add(action);
  return action;
}
