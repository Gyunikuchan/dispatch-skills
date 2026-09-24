#!/usr/bin/env node
// @ts-check

import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { isMainModule } from '../lib/platform.mjs';
import { semanticSectionHashes } from '../review/preparation.mjs';
import { isReservedOrdinarySlug, ledgerNamespacePath } from '../artifacts/resolve-paths.mjs';
import { materializedFingerprint } from '../lib/git-state.mjs';
import {
  foldSegments,
  foldDesignRun,
  nextDesignAction,
  parseEventLine,
  selectOrdinarySegment,
  selectDesignSegment,
  serializeEvent,
} from './events.mjs';
import { parseIncrementGraph } from '../design/graph.mjs';
import { captureRepositoryState } from '../verification/evidence.mjs';

/** @typedef {{ platform?: NodeJS.Platform, uid?: number }} OwnershipOptions */
/** @typedef {{ tempRoot?: string, repoHash?: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, uid?: number }} LedgerNamespaceOptions */

// SECTION: Artifact identity

export const CANONICAL_PLAN = /^\.scratch\/plan\/\d{4}-\d{2}-\d{2}-(?!.*-walkthrough\.md$)([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
export const CANONICAL_DESIGN = /^\.scratch\/plan\/\d{4}-\d{2}-\d{2}-([a-z0-9]+(?:-[a-z0-9]+)*)-design\.md$/;

/** Returns a canonical design artifact's root slug, or null for invalid/reserved paths. */
export function designRootSlug(planPath) {
  const match = CANONICAL_DESIGN.exec(String(planPath).replaceAll('\\', '/').replace(/^\.\//, ''));
  return match && !isReservedOrdinarySlug(match[1]) ? match[1] : null;
}

/** Returns a canonical ordinary plan slug and rejects phased artifact identities. */
export function slugFromPlanPath(planPath) {
  const normalized = planPath.replaceAll('\\', '/').replace(/^\.\//, '');
  const match = CANONICAL_PLAN.exec(normalized);
  if (!match) {
    throw new Error('Resume plan path must match .scratch/plan/<yyyy-mm-dd>-<slug>.md');
  }
  if (isReservedOrdinarySlug(match[1])) {
    throw new Error(`Resume plan slug "${match[1]}" is reserved for phased artifacts; use the explicit design-run artifact path.`);
  }
  return match[1];
}

// SECTION: Private ledger storage

/** @param {string} directory @param {OwnershipOptions} [options] */
function inspectDirectory(directory, { platform = process.platform, uid = process.getuid?.() } = {}) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe ledger directory: ${directory}`);
  if (platform !== 'win32') {
    if (uid !== undefined && stat.uid !== uid) throw new Error(`Ledger directory is owned by another user: ${directory}`);
    if ((stat.mode & 0o022) !== 0) throw new Error(`Ledger directory is group/other writable: ${directory}`);
  }
}

function ensurePrivateChild(parent, name, options) {
  inspectDirectory(parent, options);
  const child = path.join(parent, name);
  try {
    fs.mkdirSync(child, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  inspectDirectory(child, options);
  if ((options?.platform ?? process.platform) !== 'win32') fs.chmodSync(child, 0o700);
  return child;
}

/**
 * Creates and validates the private, per-repository durable ledger namespace.
 * @param {LedgerNamespaceOptions} [options]
 */
export function ensureLedgerNamespace({
  tempRoot = os.tmpdir(),
  repoHash,
  env = process.env,
  platform = process.platform,
  uid = process.getuid?.(),
} = {}) {
  if (!/^[a-f0-9]{12}$/.test(repoHash ?? '')) throw new Error('repoHash must be 12 lowercase hexadecimal characters');
  const options = { platform, uid };
  inspectDirectory(tempRoot, { platform: 'win32', uid });
  const target = ledgerNamespacePath({ tempRoot, repoHash, env });
  const relative = path.relative(tempRoot, target);
  let current = tempRoot;
  for (const component of relative.split(path.sep)) current = ensurePrivateChild(current, component, options);
  return current;
}

function validateLedgerParents(ledgerPath, options = {}) {
  const tempRoot = path.resolve(options.tempRoot ?? os.tmpdir());
  const parent = path.resolve(path.dirname(ledgerPath));
  const relative = path.relative(tempRoot, parent);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Ledger path must be below the OS temp directory: ${ledgerPath}`);
  }
  let current = tempRoot;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    inspectDirectory(current, options);
  }
}

/** @param {string} ledgerPath @param {OwnershipOptions} [options] */
function inspectLedgerFile(ledgerPath, { platform = process.platform, uid = process.getuid?.() } = {}) {
  let stat;
  try { stat = fs.lstatSync(ledgerPath); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe ledger file: ${ledgerPath}`);
  if (platform !== 'win32') {
    if (uid !== undefined && stat.uid !== uid) throw new Error(`Ledger file is owned by another user: ${ledgerPath}`);
    if ((stat.mode & 0o077) !== 0) throw new Error(`Ledger file permissions are too broad: ${ledgerPath}`);
  }
}

// SECTION: Ledger reads

/** Reads without mutation, preserving torn bytes for explicit reconciliation. */
export function readLedger(ledgerPath) {
  let bytes;
  try { bytes = fs.readFileSync(ledgerPath); } catch (error) {
    if (error.code === 'ENOENT')     return { status: 'missing', issue: 'missing', events: [], diagnostic: 'Ledger is missing; reconstruct state from governing artifacts and working tree.' };
    throw error;
  }
  const finalNewline = bytes.length === 0 || bytes.at(-1) === 0x0a;
  let completeEnd = finalNewline ? bytes.length : bytes.lastIndexOf(0x0a) + 1;
  // NOTE: a malformed final line is an interrupted append even when newline-terminated.
  if (finalNewline && bytes.length > 0) {
    const lastStart = bytes.lastIndexOf(0x0a, bytes.length - 2) + 1;
    const lastLine = bytes.subarray(lastStart, bytes.length - 1).toString('utf8');
    if (lastLine.length > 0) {
      try { parseEventLine(lastLine); } catch { completeEnd = lastStart; }
    }
  }
  const validBytes = bytes.subarray(0, completeEnd);
  const tornBytes = bytes.subarray(completeEnd);
  // Only the terminator after the last line is dropped; an empty interior line is malformed.
  const lines = validBytes.toString('utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const events = [];
  let segments;
  try {
    for (const line of lines) events.push(parseEventLine(line));
    segments = foldSegments(events);
  } catch (error) {
    return { status: 'needs-reconciliation', issue: 'invalid', events, diagnostic: error.message, tornBytes };
  }
  if (tornBytes.length > 0) {
    return {
      status: 'needs-reconciliation',
      issue: 'torn-tail',
      events,
      diagnostic: `Interrupted append; explicit repair required. Torn bytes (base64): ${tornBytes.toString('base64')}`,
      tornBytes,
      truncateOffset: completeEnd,
    };
  }
  if (segments.at(-1)?.needsReconciliation) {
    return {
      status: 'needs-reconciliation',
      issue: 'reconciliation',
      events,
      tornBytes,
      diagnostic: 'Ledger has an unresolved reconciliation ruling.',
    };
  }
  return { status: 'ok', events, tornBytes };
}

// SECTION: Exclusive locking

function lockPath(ledgerPath) {
  return `${ledgerPath}.lock`;
}

function acquireLock(ledgerPath) {
  const target = lockPath(ledgerPath);
  const { O_CREAT, O_EXCL, O_WRONLY, O_NOFOLLOW = 0 } = fs.constants;
  let fd;
  try {
    fd = fs.openSync(target, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Ledger lock is held: ${target}`);
    throw error;
  }
  try {
    const record = JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
      nonce: crypto.randomUUID(),
    });
    fs.writeSync(fd, `${record}\n`);
    fs.fsyncSync(fd);
  } catch (error) {
    try { fs.unlinkSync(target); } catch {}
    throw error;
  } finally {
    fs.closeSync(fd);
  }
  return target;
}

function releaseLock(target) {
  fs.unlinkSync(target);
}

/**
 * Removes a lock only after its recorded process is proven absent.
 * @param {string} ledgerPath @param {{ kill?: typeof process.kill }} [options]
 */
export function breakStaleLock(ledgerPath, { kill = process.kill } = {}) {
  validateLedgerParents(ledgerPath);
  const target = lockPath(ledgerPath);
  let record;
  try { record = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new Error(`Ledger lock requires user ruling before removal: ${target}`);
  }
  if (!Number.isSafeInteger(record.pid) || record.pid < 1) throw new Error('Ledger lock has no valid holder PID');
  try {
    kill(record.pid, 0);
    throw new Error(`Ledger lock holder ${record.pid} is still alive`);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  fs.unlinkSync(target);
  return true;
}

// SECTION: Durable mutations

/** Truncates an interrupted append and records an open reconciliation ruling. */
export function repairTornTail(ledgerPath) {
  validateLedgerParents(ledgerPath);
  inspectLedgerFile(ledgerPath);
  const held = acquireLock(ledgerPath);
  try {
    const read = readLedger(ledgerPath);
    if (!read.tornBytes?.length || read.truncateOffset === undefined) return { repaired: false, diagnostic: read.diagnostic ?? 'No torn tail.' };
    const segment = foldSegments(read.events).at(-1);
    if (!segment?.runId) throw new Error('Torn ledger has no valid run-start segment');
    const nextSeq = (read.events.at(-1)?.seq ?? 0) + 1;
    const reconciliationRunId = segment.terminal ? crypto.randomUUID() : segment.runId;
    const repairEvents = [];
    if (segment.terminal) {
      repairEvents.push({
        v: segment.version ?? 1,
        seq: nextSeq,
        type: 'run-start',
        runId: reconciliationRunId,
        at: new Date().toISOString(),
        data: { ...segment.runStart, repair: true },
      });
    }
    repairEvents.push({
      v: segment.version ?? 1,
      seq: nextSeq + repairEvents.length,
      type: 'ruling',
      runId: reconciliationRunId,
      at: new Date().toISOString(),
      data: {
        key: 'reconciliation',
        decision: 'repair-tail',
        reason: read.diagnostic,
        costIfWrong: 'Further dispatch may duplicate or misattribute work.',
        state: 'open',
      },
    });
    const repairLines = repairEvents.map(serializeEvent).join('');
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const fd = fs.openSync(ledgerPath, fs.constants.O_WRONLY | noFollow);
    try {
      fs.ftruncateSync(fd, read.truncateOffset);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const appendFd = fs.openSync(ledgerPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | noFollow);
    try {
      fs.writeSync(appendFd, repairLines, null, 'utf8');
      fs.fsyncSync(appendFd);
    } finally {
      fs.closeSync(appendFd);
    }
    return { repaired: true, diagnostic: read.diagnostic, tornBytes: read.tornBytes, events: repairEvents };
  } finally {
    releaseLock(held);
  }
}

/** Appends one validated sequential event under the ledger's exclusive lock. */
export function appendEvent(ledgerPath, event) {
  validateLedgerParents(ledgerPath);
  inspectLedgerFile(ledgerPath);
  const held = acquireLock(ledgerPath);
  try {
    const read = readLedger(ledgerPath);
    const resolvesReconciliation =
      event.type === 'ruling' && event.data?.key === 'reconciliation' && event.data?.state === 'resolved';
    if (read.status === 'needs-reconciliation' &&
        !(read.issue === 'reconciliation' && resolvesReconciliation)) {
      throw new Error(`Ledger append refused: ${read.diagnostic}`);
    }
    const latestSeq = read.events.at(-1)?.seq ?? 0;
    const next = { ...event, seq: event.seq ?? latestSeq + 1 };
    if (next.seq !== latestSeq + 1) throw new Error(`Ledger seq must be ${latestSeq + 1}`);
    const line = serializeEvent(next);
    const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW = 0 } = fs.constants;
    const fd = fs.openSync(ledgerPath, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error('Ledger target is not a regular file');
      fs.writeSync(fd, line, null, 'utf8');
      fs.fsyncSync(fd);
      if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    } finally {
      fs.closeSync(fd);
    }
    return next;
  } finally {
    releaseLock(held);
  }
}

// SECTION: Resume APIs

/**
 * Computes the semantic governing hash, excluding mutable design execution status.
 * @param {string} planSource @param {{ kind?: 'plan'|'design' }} [options]
 */
export function governingHash(planSource, { kind = 'plan' } = {}) {
  try {
    return {
      status: 'ok',
      hash: semanticSectionHashes(planSource, {
        excludedSections: kind === 'design' ? ['Execution Status'] : [],
      }).contentHash,
    };
  } catch (error) {
    return { status: 'needs-reconciliation', hash: null, diagnostic: `Governing plan cannot be normalized: ${error.message}` };
  }
}

/** Reconstructs an ordinary run and verifies completed-task materialization. */
export function resumeOrdinary({ ledgerPath, planPath, planSource, repoRoot }) {
  const designMatch = CANONICAL_DESIGN.exec(planPath.replaceAll('\\', '/').replace(/^\.\//, ''));
  if (designMatch) return resumeDesign({ ledgerPath, planPath, planSource, repoRoot });
  const slug = slugFromPlanPath(planPath);
  const hash = governingHash(planSource);
  if (hash.status !== 'ok') return { ...hash, slug, requiresFlowConfirmation: true };
  const read = readLedger(ledgerPath);
  if (read.status !== 'ok') return { ...read, slug, governingHash: hash.hash, requiresFlowConfirmation: true };
  const segment = selectOrdinarySegment(read.events, hash.hash);
  if (!segment) {
    return {
      status: 'needs-reconciliation', slug, governingHash: hash.hash,
      diagnostic: 'No matching unterminated ordinary run segment.',
      requiresFlowConfirmation: true,
    };
  }
  const disposition = segment.rulings?.get('failure-disposition');
  if (disposition?.state === 'open') {
    let captured;
    try { captured = JSON.parse(disposition.reason).failureSnapshot; } catch { captured = null; }
    if (!captured) {
      return { status: 'needs-reconciliation', slug, governingHash: hash.hash, diagnostic: 'Failure disposition snapshot is missing or invalid.', requiresFlowConfirmation: true };
    }
    let current;
    try { current = captureRepositoryState(repoRoot); } catch (error) {
      return { status: 'needs-reconciliation', slug, governingHash: hash.hash, diagnostic: `Failure snapshot capture failed: ${error.message}`, requiresFlowConfirmation: true };
    }
    // Driver snapshots exclude `.scratch/` (plan and walkthrough evidence rewrite there on every step).
    const unscratched = entries => Object.fromEntries(Object.entries(entries ?? {}).filter(([file]) => !file.startsWith('.scratch/')));
    if (current.available === captured.available && JSON.stringify(unscratched(current.entries)) === JSON.stringify(unscratched(captured.entries))) {
      return { status: 'resumable', slug, governingHash: hash.hash, segment, nextAction: 'failure-disposition', requiresFlowConfirmation: true };
    }
    return { status: 'needs-reconciliation', slug, governingHash: hash.hash, diagnostic: 'Failure snapshot drifted after disposition.', requiresFlowConfirmation: true };
  }
  const completions = [...segment.completedTasks.entries()];
  const laterOwners = new Map();
  for (const [taskId, complete] of completions) for (const owned of complete.paths) laterOwners.set(owned, taskId);
  const drift = [];
  for (const [taskId, complete] of completions) {
    const authoritative = complete.paths.filter(owned => laterOwners.get(owned) === taskId);
    if (authoritative.length === 0) continue;
    if (authoritative.length !== complete.paths.length) {
      drift.push({ taskId, paths: authoritative, reason: 'partial-overlap-cannot-prove-subset' });
      continue;
    }
    const current = materializedFingerprint(repoRoot, complete.paths);
    if (current.digest !== complete.resultState) drift.push({ taskId, paths: complete.paths });
  }
  if (drift.length) {
    return {
      status: 'needs-reconciliation', slug, governingHash: hash.hash, segment, drift,
      diagnostic: 'Completed task result state drifted; attribute the live diff before dispatch.',
      requiresFlowConfirmation: true,
    };
  }
  const activeTask = [...segment.tasks.entries()].find(([, task]) => !task.complete);
  let nextAction = 'dispatch';
  if (activeTask?.[1].lastVerification?.data.result === 'red') nextAction = 'continuation';
  return {
    status: 'resumable', slug, governingHash: hash.hash, segment,
    completedTaskIds: [...segment.completedTasks.keys()],
    activeTaskId: activeTask?.[0] ?? null,
    nextAction,
    requiresFlowConfirmation: true,
  };
}

/** Reconstructs legacy or phased design execution and returns its next action. */
export function resumeDesign({ ledgerPath, planPath, planSource, repoRoot }) {
  const artifact = typeof planSource === 'string'
    ? { source: planSource, metadata: null }
    : planSource;
  const hash = governingHash(artifact.source, { kind: 'design' });
  if (hash.status !== 'ok') return { ...hash, status: 'needs-reconciliation', requiresFlowConfirmation: true };
  const read = readLedger(ledgerPath);
  if (read.status !== 'ok') return { ...read, governingHash: hash.hash, requiresFlowConfirmation: true };
  const hasPhasedEvents = read.events.some(event =>
    event.type === 'amendment' || event.type === 'increment-state' ||
    event.type === 'adjacent-fix' || event.type === 'integration' ||
    (event.type === 'run-start' && event.v === 2 && ['increment', 'integration'].includes(event.data?.action)));
  if (!hasPhasedEvents) {
    return resumeDesignSegment({ planPath, artifact, hash, read });
  }
  return resumeDesignRun({ planPath, artifact, hash, read, repoRoot });
}

/** Pre-5B path: the design-review segment itself is the only design identity. */
function resumeDesignSegment({ planPath, artifact, hash, read }) {
  const segment = selectDesignSegment(read.events, hash.hash);
  if (!segment) return { status: 'needs-reconciliation', governingHash: hash.hash, diagnostic: 'No matching design segment.', requiresFlowConfirmation: true };
  if (segment.needsReconciliation || !segment.approved || (segment.terminal && segment.result !== 'design-approved-stop')) {
    return { status: 'needs-reconciliation', governingHash: hash.hash, diagnostic: 'Latest design segment is not an approved durable stop.', requiresFlowConfirmation: true };
  }
  const approvedHash = artifact.metadata?.approvedContentHash;
  const ledgerApproval = segment.approval?.governingHash;
  if (approvedHash !== hash.hash || ledgerApproval !== hash.hash) {
    return { status: 'needs-reconciliation', governingHash: hash.hash, diagnostic: 'Design approval revision is stale or missing.', requiresFlowConfirmation: true };
  }
  if (segment.result !== 'design-approved-stop') {
    return { status: 'resumable', kind: 'design', planPath, governingHash: hash.hash, segment, nextAction: 'design-review', requiresFlowConfirmation: true };
  }
  // Post-approval: derive the named ready increment from the design's graph exactly as the
  // phased path does.
  const graph = parseIncrementGraph(artifact.source);
  const merged = mergedIncrementStates(graph, new Map());
  const priorities = new Map((graph.increments ?? []).map(increment => [increment.id, increment.priority]));
  const action = nextDesignAction({
    incrementStates: merged, incrementPriorities: priorities,
    amendments: new Map(), needsReconciliation: false,
    activeIncrementId: null, integrationPassed: false,
  });
  return {
    status: 'resumable', kind: 'design', planPath, governingHash: hash.hash, segment,
    nextAction: formatNextAction(action), requiresFlowConfirmation: true,
  };
}

/** Phased path: fold every matching segment across revisions and derive one next action. */
function resumeDesignRun({ planPath, artifact, hash, read, repoRoot }) {
  const folded = foldDesignRun(read.events);
  if (!folded || folded.status === 'needs-reconciliation') {
    return {
      status: 'needs-reconciliation', governingHash: hash.hash,
      diagnostic: folded?.diagnostic ?? 'No design-run segments in the ledger.',
      requiresFlowConfirmation: true,
    };
  }
  const activatedAmendments = [...folded.amendments.entries()]
    .filter(([, amendment]) => amendment.state === 'activated')
    .map(([, amendment]) => amendment);
  const approvedRevision = activatedAmendments.at(-1)?.candidateHash ?? folded.approvalRevision;
  if (!approvedRevision) {
    return { status: 'needs-reconciliation', governingHash: hash.hash, diagnostic: 'No approved design revision in the folded run.', requiresFlowConfirmation: true };
  }
  if (approvedRevision !== hash.hash || artifact.metadata?.approvedContentHash !== approvedRevision) {
    return { status: 'needs-reconciliation', governingHash: hash.hash, diagnostic: 'Design approval revision is stale or missing.', requiresFlowConfirmation: true };
  }
  const laterOwners = new Map();
  for (const [taskId, completion] of folded.completedTasks) {
    for (const owned of completion.paths) laterOwners.set(owned, taskId);
  }
  const drift = [];
  for (const [taskId, completion] of folded.completedTasks) {
    const authoritative = completion.paths.filter(owned => laterOwners.get(owned) === taskId);
    if (authoritative.length === 0) continue;
    if (authoritative.length !== completion.paths.length) {
      drift.push({ taskId, paths: authoritative, reason: 'partial-overlap-cannot-prove-subset' });
      continue;
    }
    const current = materializedFingerprint(repoRoot, authoritative);
    if (current.digest !== completion.resultState) drift.push({ taskId, paths: authoritative });
  }
  if (drift.length) {
    return {
      status: 'needs-reconciliation', governingHash: hash.hash, drift,
      diagnostic: 'Completed task result state drifted; attribute the live diff before dispatch.',
      requiresFlowConfirmation: true,
    };
  }
  const graph = parseIncrementGraph(artifact.source);
  if (!graph.valid || !(graph.increments ?? []).length) {
    return { status: 'needs-reconciliation', governingHash: hash.hash, diagnostic: 'Increment Dependency Graph is invalid or empty.', requiresFlowConfirmation: true };
  }
  const merged = mergedIncrementStates(graph, folded.incrementStates);
  const priorities = new Map((graph.increments ?? []).map(increment => [increment.id, increment.priority]));
  const action = nextDesignAction({ ...folded, incrementStates: merged, incrementPriorities: priorities });
  const nextAction = formatNextAction(action);
  return {
    status: 'resumable', kind: 'design', planPath, governingHash: hash.hash,
    slug: designRootSlug(planPath), folded,
    nextAction, requiresFlowConfirmation: true,
  };
}

function mergedIncrementStates(graph, foldedStates) {
  const merged = new Map(foldedStates);
  for (const increment of graph.increments ?? []) {
    if (!merged.has(increment.id)) merged.set(increment.id, 'pending');
  }
  // A graph increment still 'pending' becomes ready once every prerequisite is complete.
  let changed = true;
  while (changed) {
    changed = false;
    for (const increment of graph.increments ?? []) {
      if (merged.get(increment.id) !== 'pending') continue;
      const prerequisitesReady = increment.prerequisites.length === 0 ||
        increment.prerequisites.every(prerequisite => merged.get(prerequisite) === 'complete');
      if (prerequisitesReady) {
        merged.set(increment.id, 'ready');
        changed = true;
      }
    }
  }
  return merged;
}

function formatNextAction(action) {
  switch (action.action) {
    case 'implement': return `implement:${action.incrementId}`;
    case 'resolve-amendment': return `resolve-amendment:${action.amendmentId ?? 'unknown'}`;
    default: return action.action;
  }
}

// SECTION: CLI

function help() {
  console.log(`Usage:
  node ledger/ledger.mjs inspect <ledger-path>
  node ledger/ledger.mjs repair-tail <ledger-path>
  node ledger/ledger.mjs break-stale-lock <ledger-path>`);
}

if (isMainModule(import.meta.url)) {
  const [action, ledgerPath] = process.argv.slice(2);
  try {
    if (!action || action === '--help' || action === '-h') {
      help();
    } else if (action === 'inspect' && ledgerPath) {
      console.log(JSON.stringify(readLedger(ledgerPath), (_, value) => Buffer.isBuffer(value) ? value.toString('base64') : value, 2));
    } else if (action === 'repair-tail' && ledgerPath) {
      console.log(JSON.stringify(repairTornTail(ledgerPath), (_, value) => Buffer.isBuffer(value) ? value.toString('base64') : value, 2));
    } else if (action === 'break-stale-lock' && ledgerPath) {
      console.log(JSON.stringify({ broken: breakStaleLock(ledgerPath) }));
    } else {
      throw new Error('Invalid ledger command');
    }
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  }
}
