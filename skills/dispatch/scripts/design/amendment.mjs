// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { appendEvent, governingHash, readLedger } from '../ledger/ledger.mjs';
import { foldEvents, foldDesignRun } from '../ledger/events.mjs';
import { parseIncrementGraph } from './graph.mjs';

function repoRootOf(absolute) {
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: path.dirname(absolute), encoding: 'utf8', timeout: 5000 });
  return res.status === 0 && res.stdout.trim() ? path.resolve(res.stdout.trim()) : process.cwd();
}

// Ledger paths are repository-relative regardless of the caller's cwd.
function canonicalPath(value) {
  const absolute = path.resolve(String(value));
  const relative = path.relative(repoRootOf(absolute), absolute);
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path "${value}" is outside the repository`);
  }
  return relative.replaceAll('\\', '/');
}

function nowTimestamp() {
  return `${new Date().toISOString().slice(0, 23)}Z`;
}

function stagingPaths(designPath) {
  const base = path.join(path.dirname(designPath), `.${path.basename(designPath)}`);
  const normalized = canonicalPath(designPath);
  const dir = normalized.slice(0, normalized.lastIndexOf('/') + 1);
  return {
    backup: `${base}.bak`,
    candidate: `${base}.tmp`,
    relativeCandidate: `${dir}.${normalized.slice(normalized.lastIndexOf('/') + 1)}.tmp`,
  };
}

function foldState(ledgerPath) {
  const read = readLedger(ledgerPath);
  if (read.status !== 'ok') throw new Error(`Ledger append refused: ${read.diagnostic ?? read.status}`);
  return read;
}

function currentRunId(events) {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].type === 'run-complete') break;
    if (events[index].type === 'run-start') return events[index].runId;
  }
  throw new Error('No open segment run-start in the ledger; open the amendment segment first');
}

function latestAmendment(events, amendmentId) {
  const found = [];
  for (const event of events) {
    if (event.type !== 'amendment') continue;
    if (amendmentId && event.data.amendmentId !== amendmentId) continue;
    found.push(event);
  }
  return found.at(-1) ?? null;
}

function nextSeq(read) {
  return read.events.at(-1)?.seq ?? 0;
}

function fsyncFile(pathValue) {
  const fd = fs.openSync(pathValue, fs.constants.O_WRONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Makes created/renamed directory entries durable. NOTE: win32 cannot open a directory for fsync.
export function fsyncDir(dirPath) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dirPath, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function candidateWithApprovalMetadata(source, approvedContentHash) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
  if (!frontmatter) return null;
  let parsed;
  try { parsed = JSON.parse(frontmatter[1].replace(/\r\n/g, '\n')); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.dispatch !== 'object') return null;
  parsed.dispatch = parsed.dispatch ?? {};
  parsed.dispatch.approvedContentHash = approvedContentHash;
  parsed.dispatch.approvedAt = nowTimestamp();
  const rest = source.slice(frontmatter[0].length);
  return `---\n${JSON.stringify(parsed, null, 2)}\n---\n${rest}`;
}

/** Refuses a no-op amendment, records the proposal/review history plus the write-ahead
 *  `prepared` event, then stages `.bak` and `.tmp` beside the canonical design. */
export function prepareAmendment({
  designPath,
  candidatePath,
  ledgerPath,
  baseRevision,
  affectedIncrements = [],
  amendmentId = `A-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
}) {
  const { backup, candidate, relativeCandidate: relative } = stagingPaths(designPath);
  for (const stagingPath of [backup, candidate]) {
    if (fs.existsSync(stagingPath)) {
      throw new Error(`Amendment prepare refused: staging file "${stagingPath}" already exists from an unsettled amendment; recover or reconcile first`);
    }
  }
  const canonicalSource = fs.readFileSync(designPath, 'utf8');
  const canonicalHash = governingHash(canonicalSource, { kind: 'design' });
  if (canonicalHash.status !== 'ok') {
    throw new Error(`Canonical design cannot be normalized: ${canonicalHash.diagnostic}`);
  }
  if (canonicalHash.hash !== baseRevision) {
    throw new Error(`Amendment prepare refused: the canonical design does not carry the prior approved revision (${canonicalHash.hash} != ${baseRevision})`);
  }
  const candidateSource = fs.readFileSync(candidatePath, 'utf8');
  const candidateHash = governingHash(candidateSource, { kind: 'design' });
  if (candidateHash.status !== 'ok') {
    throw new Error(`Amendment candidate cannot be normalized: ${candidateHash.diagnostic}`);
  }
  if (candidateHash.hash === baseRevision) {
    throw new Error('Amendment prepare refused: the candidate governed content is identical to the base revision (no-op amendment)');
  }
  const read = foldState(ledgerPath);
  const latestStates = new Map();
  for (const event of read.events) {
    if (event.type !== 'amendment') continue;
    latestStates.set(event.data.amendmentId, event.data.state);
  }
  const live = [...latestStates.entries()].find(([, state]) => ['proposed', 'reviewed', 'prepared'].includes(state));
  if (live) {
    throw new Error(`Amendment prepare refused: amendment "${live[0]}" is still ${live[1]}; settle it first`);
  }
  let seq = nextSeqOf(read);
  const preparedData = {
    amendmentId,
    baseRevision,
    candidateHash: candidateHash.hash,
    affectedIncrements: [...affectedIncrements],
    targetPath: canonicalPath(designPath),
    replacementPath: relative,
  };
  // Record the orchestrator-level proposal/review history, then the write-ahead prepared event.
  amendmentEvent({ ledgerPath, seq: ++seq, data: { amendmentId, state: 'proposed', affectedIncrements: preparedData.affectedIncrements } });
  amendmentEvent({ ledgerPath, seq: seq + 1, data: { amendmentId, state: 'reviewed', affectedIncrements: preparedData.affectedIncrements } });
  amendmentEvent({ ledgerPath, seq: seq + 2, data: { ...preparedData, state: 'prepared' } });
  fs.copyFileSync(designPath, backup);
  fs.copyFileSync(candidatePath, candidate);
  fsyncFile(candidate);
  fsyncFile(backup);
  fsyncDir(path.dirname(designPath));
  return { ...preparedData, state: 'prepared' };
}

function nextSeqOf(read) {
  return read.events.at(-1)?.seq ?? 0;
}

function amendmentEvent({ ledgerPath, seq, data }) {
  return phasedEvent({ ledgerPath, seq, type: 'amendment', data });
}

function phasedEvent({ ledgerPath, seq, type, data }) {
  const runId = currentRunId(foldState(ledgerPath).events);
  return appendEvent(ledgerPath, { v: 2, seq, type, runId, at: nowTimestamp(), data });
}

/** Verifies the prior revision and candidate hash, bakes the updated frontmatter approval
 *  metadata onto the staged candidate, atomically renames over the canonical design, appends
 *  `activated` plus the increment-state transitions for in-flight affected increments, and
 *  removes the staging files. Reopening completed increments is an orchestrator ruling when the
 *  amendment changes their contracts or shared invariants. */
export function activateAmendment({ designPath, ledgerPath, amendmentId }) {
  const staging = stagingPaths(designPath);
  const read = foldState(ledgerPath);
  const prepared = latestAmendment(read.events, amendmentId);
  if (!prepared || prepared.data.state !== 'prepared') {
    throw new Error(`Amendment "${amendmentId}" has no prepared event to activate`);
  }
  const { baseRevision, candidateHash } = prepared.data;
  const canonicalSource = fs.readFileSync(designPath, 'utf8');
  const canonicalHash = governingHash(canonicalSource, { kind: 'design' });
  if (canonicalHash.status !== 'ok' || canonicalHash.hash !== baseRevision) {
    throw new Error('Amendment activate refused: canonical revision does not match the prepared base revision');
  }
  const staged = fs.existsSync(staging.candidate) ? fs.readFileSync(staging.candidate, 'utf8') : null;
  if (!staged || governingHash(staged, { kind: 'design' }).hash !== candidateHash) {
    throw new Error('Amendment activate refused: staged candidate hash does not match the prepared candidateHash');
  }
  const metadataCandidate = candidateWithApprovalMetadata(staged, candidateHash);
  if (!metadataCandidate) {
    throw new Error('Amendment activate refused: the candidate carries no dispatch frontmatter, so approval metadata cannot be written');
  }
  fs.writeFileSync(staging.candidate, metadataCandidate);
  fsyncFile(staging.candidate);
  fs.renameSync(staging.candidate, designPath);
  fsyncDir(path.dirname(designPath));
  const activatedHash = governingHash(fs.readFileSync(designPath, 'utf8'), { kind: 'design' });
  if (activatedHash.status !== 'ok' || activatedHash.hash !== candidateHash) {
    throw new Error('Amendment activation mismatch: canonical governed hash does not match the activated candidateHash; needs-reconciliation');
  }
  const { dependents } = withDependents(canonicalSource, prepared.data.affectedIncrements);
  const read2 = foldState(ledgerPath);
  amendmentEvent({
    ledgerPath,
    seq: nextSeqOf(read2) + 1,
    data: { amendmentId, state: 'activated', baseRevision, candidateHash, affectedIncrements: prepared.data.affectedIncrements },
  });
  recordIncrementInvalidation({
    ledgerPath,
    incrementStates: incrementStatesOf(read2),
    amendmentId,
    affectedIncrements: prepared.data.affectedIncrements,
    dependents,
  });
  for (const stagingPath of [staging.backup, staging.candidate]) {
    if (fs.existsSync(stagingPath)) fs.rmSync(stagingPath, { force: true });
  }
  return { amendmentId, state: 'activated', baseRevision, candidateHash, affectedIncrements: prepared.data.affectedIncrements };
}

/** Transitive downstream dependents of the affected increments in the approved graph. */
function withDependents(source, affectedIncrements) {
  const graph = parseIncrementGraph(source);
  const affected = new Set(affectedIncrements);
  const dependents = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const increment of graph.increments ?? []) {
      if (affected.has(increment.id) || !increment.prerequisites.some(id => affected.has(id))) continue;
      affected.add(increment.id);
      dependents.push(increment.id);
      changed = true;
    }
  }
  return { dependents };
}

/** Derives current increment states from the folded ledger events (multi-segment safe). */
function incrementStatesOf(read) {
  const states = new Map();
  try {
    const folded = foldDesignRun(read.events);
    if (folded && folded.status === 'ok') return folded.incrementStates ?? states;
  } catch {}
  try {
    const folded = foldEvents(read.events, { incrementStates: new Map(), amendments: new Map() });
    return folded.increments ?? states;
  } catch {
    return states;
  }
}

/** Affected increments of an activated amendment whose invalidation event never landed. */
function missingInvalidations(read, amendmentData) {
  const recorded = new Set(read.events
    .filter(event => event.type === 'increment-state' &&
      event.data.cause === `amendment:${amendmentData.amendmentId}` &&
      event.data.next === 'invalidated')
    .map(event => event.data.incrementId));
  const states = incrementStatesOf(read);
  return (amendmentData.affectedIncrements ?? []).filter(incrementId => {
    if (recorded.has(incrementId)) return false;
    const current = states.get(incrementId) ?? 'pending';
    return ['pending', 'ready', 'active', 'reopened'].includes(current);
  });
}

/** Records the activation's increment-state transitions: each affected increment that is still
 *  in flight (pending/ready/active/reopened) becomes `invalidated`. Completed, blocked, and
 *  already-invalidated increments are skipped (the orchestrator rules on reopening completed
 *  ones; non-in-flight states are not legal sources for ->invalidated). */
function recordIncrementInvalidation({ ledgerPath, incrementStates, amendmentId, affectedIncrements, dependents = [] }) {
  let seq = nextSeqOf(foldState(ledgerPath));
  for (const incrementId of [...affectedIncrements, ...dependents]) {
    const current = incrementStates?.get?.(incrementId) ?? 'pending';
    if (!['pending', 'ready', 'active', 'reopened'].includes(current)) continue;
    phasedEvent({
      ledgerPath,
      seq: ++seq,
      type: 'increment-state',
      data: {
        incrementId, prior: current, next: 'invalidated',
        cause: `amendment:${amendmentId}`,
        affectedDependents: affectedIncrements.includes(incrementId) ? dependents : [],
      },
    });
  }
  return seq;
}

function terminalAmendment({ designPath, ledgerPath, amendmentId, state }) {
  const staging = stagingPaths(designPath);
  const read = foldState(ledgerPath);
  const live = latestAmendment(read.events, amendmentId);
  if (!live || !['proposed', 'reviewed', 'prepared'].includes(live.data.state)) {
    throw new Error(`Amendment "${amendmentId}" has no pre-activation amendment event to ${state}`);
  }
  // Post-rename window: the candidate is already canonical, so only recovery may settle it.
  if (live.data.state === 'prepared' &&
      governingHash(fs.readFileSync(designPath, 'utf8'), { kind: 'design' }).hash !== live.data.baseRevision) {
    throw new Error(`Amendment ${state} refused: canonical design no longer matches the base revision; run recover`);
  }
  amendmentEvent({
    ledgerPath,
    seq: nextSeqOf(read) + 1,
    data: {
      amendmentId, state,
      affectedIncrements: live.data.affectedIncrements ?? [],
      reconciliationState: 'live-diff-reconciliation-required',
    },
  });
  if (fs.existsSync(staging.candidate)) fs.rmSync(staging.candidate, { force: true });
  if (fs.existsSync(staging.backup) &&
      fs.readFileSync(staging.backup, 'utf8') === fs.readFileSync(designPath, 'utf8')) {
    fs.rmSync(staging.backup, { force: true });
  }
  return { amendmentId, state };
}

export function rejectAmendment({ designPath, ledgerPath, amendmentId }) {
  return terminalAmendment({ designPath, ledgerPath, amendmentId, state: 'rejected' });
}

export function abortAmendment({ designPath, ledgerPath, amendmentId }) {
  return terminalAmendment({ designPath, ledgerPath, amendmentId, state: 'aborted' });
}

/** Startup recovery. The crash window is discriminated by staging-file presence; hashes
 *  corroborate: prepared with canonical == candidateHash is the post-rename window. */
export function recoverAmendment({ designPath, ledgerPath }) {
  const staging = stagingPaths(designPath);
  const stagedExists = fs.existsSync(staging.candidate) || fs.existsSync(staging.backup);
  const read = foldState(ledgerPath);
  const lastAmendment = [...read.events].filter(event => event.type === 'amendment').at(-1) ?? null;
  if (!lastAmendment) return { state: 'none' };
  const { amendmentId, state: amendmentState, baseRevision, candidateHash } = lastAmendment.data;
  const canonicalHash = governingHash(fs.readFileSync(designPath, 'utf8'), { kind: 'design' }).hash;

  if (amendmentState === 'activated') {
    if (canonicalHash !== candidateHash) {
      return { state: 'needs-reconciliation', amendmentId, diagnostic: 'Activated amendment with canonical governed-hash mismatch.' };
    }
    // A crash between the `activated` append and the increment-state invalidation leaves
    // affected in-flight increments without their invalidation event; repair that here.
    const missing = missingInvalidations(read, lastAmendment.data);
    if (missing.length > 0) {
      recordIncrementInvalidation({
        ledgerPath,
        incrementStates: incrementStatesOf(read),
        amendmentId,
        affectedIncrements: missing,
      });
    }
    if (stagedExists) {
      for (const stagingPath of [staging.backup, staging.candidate]) {
        if (fs.existsSync(stagingPath)) fs.rmSync(stagingPath, { force: true });
      }
      return { state: 'cleanup-complete', amendmentId };
    }
    return { state: 'none', amendmentId };
  }
  if (amendmentState !== 'prepared') return { state: 'none', amendmentId };

  if (canonicalHash === candidateHash) {
    const repaired = candidateWithApprovalMetadata(fs.readFileSync(designPath, 'utf8'), candidateHash);
    if (!repaired) {
      return {
        state: 'needs-reconciliation',
        amendmentId,
        preserved: [staging.backup, staging.candidate],
        diagnostic: 'Post-rename recovery could not write approval metadata: the canonical design carries no dispatch frontmatter.',
      };
    }
    fs.writeFileSync(designPath, repaired);
    fsyncFile(designPath);
    const read2 = foldState(ledgerPath);
    amendmentEvent({
      ledgerPath,
      seq: nextSeqOf(read2) + 1,
      data: { amendmentId, state: 'activated', baseRevision, candidateHash, affectedIncrements: lastAmendment.data.affectedIncrements },
    });
    recordIncrementInvalidation({
      ledgerPath,
      incrementStates: incrementStatesOf(read2),
      amendmentId,
      affectedIncrements: lastAmendment.data.affectedIncrements ?? [],
    });
    for (const stagingPath of [staging.backup, staging.candidate]) {
      if (fs.existsSync(stagingPath)) fs.rmSync(stagingPath, { force: true });
    }
    return { state: 'activated-recovered', amendmentId, candidateHash };
  }
  if (canonicalHash === baseRevision) {
    if (stagedExists) {
      return { state: 'pre-rename', amendmentId, choices: ['resume', 'discard'], preserved: [staging.backup, staging.candidate] };
    }
    // Crash after the prepared append but before any staging: the canonical file still matches
    // the prior revision and nothing was staged — a clean pre-staging window.
    return {
      state: 'pre-staging',
      amendmentId,
      choices: ['resume', 'discard'],
      diagnostic: 'The prepared event landed before any staging; the canonical design still matches the prior revision.',
    };
  }
  return {
    state: 'needs-reconciliation',
    amendmentId,
    preserved: [staging.backup, staging.candidate],
    diagnostic: 'Neither the prior revision nor the candidate hash matches the canonical design; both copies preserved.',
  };
}
