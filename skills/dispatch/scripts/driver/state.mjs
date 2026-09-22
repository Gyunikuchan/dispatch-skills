/**
 * Driver run state: a cache under `os.tmpdir()/dispatch-driver/` (R3). Canonical artifacts stay
 * authoritative; a lost cache is rebuilt from the artifact's resolution log through `--run`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { evaluateConsensus } from '../check-consensus.mjs';
import { safeRenameSync } from '../common.mjs';
import { scanResolutionLog } from '../resolution-log.mjs';

export const STATE_DIR_NAME = 'dispatch-driver';

function stateDir() {
  const dir = path.join(fs.realpathSync(os.tmpdir()), STATE_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
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

/** Creates a fresh run state with a new run ID. */
export function createRunState(fields) {
  const runId = crypto.randomUUID();
  const stateFile = path.join(stateDir(), `${runId}.json`);
  return { v: 1, runId, stateFile, ...fields };
}

/** Reads a state file; throws with `code: 'STATE_UNREADABLE'` when missing or corrupt. */
export function readRunState(stateFile) {
  const resolved = path.resolve(stateFile);
  // Trust only files directly under the OS-temp state dir: state names artifacts and argv.
  let real = null;
  try { real = fs.realpathSync(resolved); } catch { real = null; }
  const inside = real !== null && path.dirname(real) === path.join(fs.realpathSync(os.tmpdir()), STATE_DIR_NAME);
  let state = null;
  try {
    if (inside) state = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch {
    state = null;
  }
  if (!state || state.v !== 1 || !state.runId) {
    throw Object.assign(new Error(`Driver state ${stateFile} is missing or unreadable.`), { code: 'STATE_UNREADABLE' });
  }
  return state;
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

/**
 * Counts only the rounds of the unsettled run: rounds after the latest log prefix that settled,
 * so earlier runs' history does not consume this run's round cap.
 */
function roundsSinceSettled(markdown, total) {
  const headings = [...markdown.matchAll(/^### Round \d+\b.*$/gm)].map((match) => match.index);
  for (let index = headings.length - 1; index >= 1; index--) {
    if (evaluateConsensus(markdown.slice(0, headings[index])).exit === 0) return total - index;
  }
  return total;
}

/**
 * Removes run states and sidecars untouched for `maxAgeMs`, finished or abandoned (an in-flight
 * wave relaunches whole via the sidecar anyway), plus orphaned sidecars; best-effort.
 */
export function pruneFinishedStates({ maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
  const dir = stateDir();
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs < maxAgeMs) continue;
      fs.rmSync(file, { force: true });
      if (!name.endsWith('.run.json')) fs.rmSync(sidecarPathFor(file), { force: true });
    } catch {
      // NOTE: pruning never blocks a run.
    }
  }
}

/**
 * Rebuilds the review position from an artifact: rounds already logged and the unsettled items
 * (pending rebuttals and disputes). Returns null when the log is settled or absent.
 */
export function rebuildFromArtifact(artifactPath) {
  if (!artifactPath || !fs.existsSync(artifactPath)) return null;
  const markdown = fs.readFileSync(artifactPath, 'utf8');
  const consensus = evaluateConsensus(markdown);
  if (consensus.exit !== 1) return null;
  const scan = scanResolutionLog(markdown, { strict: true });
  return {
    rounds: roundsSinceSettled(markdown, scan.rounds.length),
    unsettled: consensus.unsettledItems,
    pending: consensus.unsettledItems.filter((item) => item.status === 'pendingConfirmation').map((item) => item.key),
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
export function unappliedFixesFromArtifact(artifactPath) {
  if (!artifactPath || !fs.existsSync(artifactPath)) return null;
  const markdown = fs.readFileSync(artifactPath, 'utf8');
  const scan = scanResolutionLog(markdown, { strict: true });
  const pending = [];
  const adjacent = [];
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
  if (pending.length === 0 && adjacent.length === 0) return null;
  return { rounds: roundsSinceSettled(markdown, scan.rounds.length), pending, adjacent };
}
