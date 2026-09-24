// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { failureAttribution } from '../verification/failure-attribution.mjs';
import { verifySkillIntegrity } from '../lib/integrity.mjs';
import { currentHead, diffHash, indexFingerprint, materializedFingerprint, snapshotContent, snapshotEntries } from '../lib/git-state.mjs';
import { diffRepositoryState } from '../verification/evidence.mjs';
import { readLedger } from '../ledger/ledger.mjs';
import { foldSegments } from '../ledger/events.mjs';
import { emitAction } from './actions.mjs';
import { append, ask, ledgerSegment, ruling } from './implement-state.mjs';
import {
  beginVerification,
  fingerprint,
  repositoryBaseline,
  loadFailureDefect,
  purposeCommands,
  redLoadFailures,
  scopedResult,
  snapshot,
  validateRedAdmission,
  validateRed,
} from './verification.mjs';
import { missingTrace, outcomeTransition, resolveWrite, verificationTransition, writeAction } from './write.mjs';

// SECTION: Task entry and write cascade

/** Enters or reconstructs the implementation task at its canonical next gate. */
export function beginImplementation(state) {
  const data = state.ordinary;
  if (!ledgerSegment(state)?.approved) throw new Error('Implementation requires recorded approval.');
  if (!data.baselineResults || !data.testsOnlyPaths) throw new Error('Implementation requires reconciled baseline and test classification.');
  data.phase = 'implementation';
  data.write ??= resolveWrite(state);
  if (data.failure) return failureQuestion(state);
  if (data.step === 'concern-ruling') return ask(state, 'implementation-concerns', 'Resolve the captured implementation concerns before accepting the outcome.', (data.envelope?.concerns ?? []).map(reason => ({ reason })));
  if (data.step === 'blocking-condition' || data.step === 'missing-context') return ask(state, data.step === 'blocking-condition' ? 'implementation-blocked' : 'implementation-context', 'Supply the changed blocking condition or missing context with {decision:"retry", reason, context}, or stop.');
  if (data.step === 'write-scope') return scopeQuestion(state);
  if (data.step === 'write-pending') {
    const paths = data.launch === 'tests-only' ? data.testsOnlyPaths : data.approvedPaths;
    return ask(state, 'implementation-recovery', 'A write was dispatched before interruption. Return its captured raw terminal envelope. Missing evidence opens failure disposition; the driver will not duplicate the write.', [{ taskId: data.taskId, attempt: data.attempt, paths }]);
  }
  if (data.step === 'red-verify' || data.step === 'completion-verify') return beginVerification(state, data.step === 'red-verify' ? 'red' : 'scoped');
  if (data.redValidated) {
    const task = ledgerSegment(state).tasks.get('implementation');
    if (task?.lastVerification?.data.result !== 'red' || task.lastAttempt?.data.transition !== 'run-red') return openFailure(state, 'Canonical RED verification is absent.');
    if (data.redValidated.scopeHash !== fingerprint(state)) return openFailure(state, 'Tests changed after the validated RED gate.');
    return startTask(state, 'full');
  }
  if (data.testsOnlyAdmitted) return openFailure(state, 'Tests-only admission exists without validated RED evidence.');
  data.taskStart = snapshot(state);
  data.indexStart = indexFingerprint(state.repoRoot).digest;
  data.preEntries = snapshotEntries(state.repoRoot, data.approvedPaths);
  data.preState = fingerprint(state);
  if (!data.redCriteria.length) {
    data.redGate = 'not applicable — no red-class criteria';
    return startTask(state, 'full');
  }
  return startTask(state, 'tests-only');
}
function startTask(state, launch) {
  const data = state.ordinary;
  data.launch = launch;
  data.attempt = 1;
  data.taskId = 'implementation';
  const segment = ledgerSegment(state);
  const existing = segment.tasks.get(data.taskId);
  if (existing) {
    if (launch !== 'full' || existing.lastAttempt?.data.launch !== 'tests-only' || existing.lastVerification?.data.result !== 'red') throw new Error('Task already dispatched; reconstruct its canonical outcome instead of relaunching.');
    // v1 continuation keeps production Attempt 1 separate from the single tests-only launch.
    data.launch = 'continuation';
    data.attempt = existing.lastAttempt.data.attempt;
  } else append(state, 'task-start', { taskId: data.taskId, attemptBudget: 3, paths: data.approvedPaths, preState: fingerprint(state) });
  if (launch === 'tests-only') data.testsOnlyAttempts = 1;
  data.write.candidate = 0;
  data.step = 'write-pending';
  return writeAction(state);
}
function target(data) {
  return { platform: data.write.platform, model: data.write.models[data.write.candidate], ...(data.write.effort ? { effort: data.write.effort } : {}) };
}
// Terminal transport failure kinds (providers.md § Failure classification / Native fallback):
// configuration, integrity, and sandbox-rejection errors never cascade to another configured model.
const TERMINAL_WRITE_KINDS = new Set(['sandbox-unsupported', 'integrity']);

function writeHistoryLine(history) {
  return history.map(({ model, kind }) => `${model} (${kind})`).join(', ');
}

/** Ends the segment on a terminal write-cascade failure or cascade exhaustion; never asks the user. */
function blockedWrite(state, reason) {
  const data = state.ordinary;
  data.failure = { reason, failureSnapshot: snapshot(state) };
  ruling(state, 'failure-disposition', 'blocked-write', reason);
  append(state, 'run-complete', { result: 'stable-failure', evidenceRefs: [state.walkthroughPath] });
  return emitAction(state, 'done', { outcome: 'failed', summary: reason, ledgerPath: state.ledgerPath, command: state.resumeCommand });
}

/** A `rejected` or `failed` reply is a transport hop: it advances the model cascade without
 * consuming an implementation attempt. A `failed` hop's partial diff is inspected for out-of-scope
 * paths before the next hop, which restores them and carries a continuation note. */
function advanceWriteCascade(state, reply) {
  const data = state.ordinary;
  const write = data.write;
  const failedModel = write.models[write.candidate];
  data.writeHistory ??= [];
  if (reply.rejected) {
    data.launchRejections ??= [];
    data.launchRejections.push({ target: target(data), reason: reply.reason });
    data.writeHistory.push({ model: failedModel, kind: 'rejected' });
  } else {
    const { kind, reason } = reply.failed;
    data.writeHistory.push({ model: failedModel, kind });
    if (TERMINAL_WRITE_KINDS.has(kind)) {
      return blockedWrite(state, `Write cascade terminated: ${failedModel} failed with terminal kind "${kind}": ${reason}. Models tried: ${writeHistoryLine(data.writeHistory)}.`);
    }
    const allowed = data.launch === 'tests-only' ? data.testsOnlyPaths : data.approvedPaths;
    const changed = diffRepositoryState(data.taskStart, snapshot(state)).changed;
    const outside = changed.filter(file => !allowed.includes(file));
    data.pendingRestore = outside.length ? { baseline: write.baselineHead, paths: outside } : null;
    data.pendingCascadeContinuation = { kind: 'cascade', failedModel, failureKind: kind };
  }
  if (write.candidate + 1 < write.models.length) {
    write.candidate++;
    return writeAction(state);
  }
  return blockedWrite(state, `Configured write model cascade exhausted. Models tried: ${writeHistoryLine(data.writeHistory)}.`);
}

// SECTION: Write-scope rulings
const MANIFEST = 'skill-hashes.json';
/** Auto-approves dispatch's skill integrity manifest only as the nearest manifest above an approved
 * path, and only when it verifies against the current files and hashes that approved path. */
function integrityManifest(state, file, allowed) {
  if (path.posix.basename(file) !== MANIFEST) return false;
  const dir = path.posix.dirname(file);
  const owned = allowed.filter(item => {
    for (let parent = path.posix.dirname(item); parent !== '.'; parent = path.posix.dirname(parent)) {
      if (fs.existsSync(path.join(state.repoRoot, parent, MANIFEST))) return parent === dir;
    }
    return false;
  });
  if (!owned.length) return false;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(state.repoRoot, file), 'utf8')); } catch { return false; }
  const integrity = verifySkillIntegrity(path.join(state.repoRoot, dir), MANIFEST);
  return integrity.valid && !integrity.missing && owned.some(item => Object.hasOwn(manifest, path.posix.relative(dir, item)));
}
function widenScope(state, files) {
  const data = state.ordinary;
  data.approvedPaths = [...new Set([...data.approvedPaths, ...files])].sort();
  // A path ruled in during tests-only is test support, so RED admission accepts it.
  if (data.launch === 'tests-only') data.testsOnlyPaths = [...new Set([...data.testsOnlyPaths, ...files])].sort();
}
/** Only a path clean or absent at task start, with the index untouched since, has a recoverable prior state. */
function revertable(state, file) {
  const entry = state.ordinary.taskStart.entries[file];
  // A staged edit would survive a worktree restore and keep the path dirty.
  return (!entry || entry.objectId === 'absent') && indexFingerprint(state.repoRoot).digest === state.ordinary.indexStart;
}
function scopeQuestion(state) {
  const data = state.ordinary;
  return ask(state, 'write-scope', 'The write subagent changed paths outside its approved scope. Rule on every path: return {approve:[paths], revert:[paths], reason}, or {decision:"stop", reason} to open failure disposition. Approve widens the scope for this run; revert restores the task-start state and is offered only where recoverable.',
    data.scopeExtras.map(file => ({ path: file, revertable: revertable(state, file) })));
}
function ruleScope(state, answer) {
  const data = state.ordinary, extras = data.scopeExtras;
  if (answer.decision === 'stop') return openFailure(state, `Delegate changed paths outside its approved write scope: ${extras.join(', ')}`);
  const approve = Array.isArray(answer.approve) ? answer.approve : [], revert = Array.isArray(answer.revert) ? answer.revert : [];
  const ruled = [...approve, ...revert];
  if (ruled.length !== extras.length || extras.some(file => !ruled.includes(file))) throw new Error(`write-scope requires exactly one ruling per path: ${extras.join(', ')}`);
  const blocked = revert.filter(file => !revertable(state, file));
  if (blocked.length) throw new Error(`Paths dirty at task start, or with a changed index since, cannot be reverted: ${blocked.join(', ')}`);
  for (const file of revert) {
    const tracked = spawnSync('git', ['-C', state.repoRoot, 'cat-file', '-e', `HEAD:${file}`]).status === 0;
    const absent = data.taskStart.entries[file]?.objectId === 'absent';
    // Worktree-only restore keeps the index fingerprint captured at task start.
    if (tracked && !absent) {
      const restored = spawnSync('git', ['-C', state.repoRoot, 'restore', '--source=HEAD', '--worktree', '--', file], { encoding: 'utf8' });
      if (restored.status !== 0) throw new Error(`Could not restore ${file}: ${restored.stderr.trim()}`);
    } else fs.rmSync(path.join(state.repoRoot, file), { force: true });
    ruling(state, 'write-scope', 'revert', `${file}: ${answer.reason}`);
  }
  if (approve.length) {
    widenScope(state, approve);
    for (const file of approve) ruling(state, 'write-scope', 'approve', `${file}: ${answer.reason}`);
  }
  const reply = data.pendingOutcome;
  for (const key of ['scopeExtras', 'pendingOutcome']) delete data[key];
  data.step = 'write-pending';
  return acceptWrite(state, reply);
}
/**
 * @param {any} state
 * @param {any} reply
 * @param {{ concernsResolved?: boolean }} [options]
 */
export function acceptWrite(state, reply, { concernsResolved = false } = {}) {
  const data = state.ordinary;
  if (reply.rejected || reply.failed) return advanceWriteCascade(state, reply);
  const changed = diffRepositoryState(data.taskStart, snapshot(state)).changed;
  const allowed = data.launch === 'tests-only' ? data.testsOnlyPaths : data.approvedPaths;
  const outside = changed.filter(file => !allowed.includes(file));
  // Production edits during tests-only would precede the RED gate, so they stay a failure.
  if (data.launch === 'tests-only' && outside.some(file => data.approvedPaths.includes(file))) return openFailure(state, 'Delegate changed paths outside its approved write scope.');
  if (outside.length) {
    const manifests = outside.filter(file => integrityManifest(state, file, allowed));
    if (manifests.length) {
      widenScope(state, manifests);
      ruling(state, 'write-scope', 'auto-approve', `Integrity manifest regenerated with its approved skill files: ${manifests.join(', ')}`);
    }
    const extra = outside.filter(file => !manifests.includes(file));
    if (extra.length) {
      data.step = 'write-scope';
      data.scopeExtras = extra;
      data.pendingOutcome = reply;
      return scopeQuestion(state);
    }
  }
  const parsed = outcomeTransition(state, reply, { concernsResolved });
  // A schema-invalid envelope is usually a relay mistake; ask once for the verbatim envelope before spending a launch.
  if (parsed.parseError && !data.relayRetried) {
    data.relayRetried = true;
    return ask(state, 'implementation-recovery', `The relayed terminal envelope failed its schema (${parsed.parseError}). Return {raw} holding the delegate's verbatim terminal envelope; do not retype or reshape fields.`, [{ taskId: data.taskId, attempt: data.attempt, paths: allowed }]);
  }
  delete data.relayRetried;
  data.envelope = parsed.envelope;
  data.mutationEpoch = (data.mutationEpoch ?? 0) + 1;
  if (data.launch === 'tests-only') {
    const defects = parsed.parseError ? [parsed.parseError] : validateRedAdmission(state, parsed.envelope);
    if (defects.length) {
      if (!data.testsOnlyRepair) {
        data.testsOnlyRepair = { defects };
        data.testsOnlyAttempts++;
        data.step = 'write-pending';
        return writeAction(state);
      }
      return openFailure(state, `Tests-only admission failed after ${data.testsOnlyAttempts} launches: ${defects.join('; ')}`);
    }
    data.testsOnlyAdmitted = true;
    delete data.testsOnlyRepair;
  }
  if (parsed.transition.action === 'concern-ruling' && !concernsResolved) {
    data.step = 'concern-ruling';
    data.pendingOutcome = reply;
    return ask(state, 'implementation-concerns', 'Resolve the reported concerns before accepting this outcome. Return {decision:"accept", reason} or stop.', parsed.envelope.concerns.map(reason => ({ reason })));
  }
  append(state, 'implementation-attempt', { taskId: data.taskId, attempt: data.attempt, launch: data.launch,
    target: target(data), terminalEnvelope: parsed.envelope, evidence: parsed.envelope?.evidence ?? [parsed.parseError ?? 'No terminal evidence'], transition: parsed.transition.action });
  data.lastTransition = parsed.transition;
  if (parsed.parseError) data.outcomeError = parsed.parseError;
  if (['run-red', 'verify'].includes(parsed.transition.action)) {
    data.step = parsed.transition.action === 'run-red' ? 'red-verify' : 'completion-verify';
    return beginVerification(state, parsed.transition.action === 'run-red' ? 'red' : 'scoped');
  }
  if (data.launch === 'tests-only') return openFailure(state, parsed.parseError ?? `Tests-only outcome: ${parsed.transition.action}`);
  if (parsed.envelope?.status === 'NEEDS_CONTEXT') {
    data.step = 'missing-context';
    return ask(state, 'implementation-context', 'Supply the missing context before a replacement launch. Return {decision:"retry", reason, context}, or stop.', parsed.envelope.missingContext.map(reason => ({ reason })));
  }
  if (parsed.transition.action === 'change-blocking-condition') {
    data.step = 'blocking-condition';
    return ask(state, 'implementation-blocked', 'A blocking condition must change before another write. Return {decision:"retry", reason, context} with the changed condition, or stop.', (parsed.envelope?.blockers ?? []).map(reason => ({ reason })));
  }
  return retryOrFail(state, parsed.transition);
}
export function retryOrFail(state, transition) {
  const data = state.ordinary;
  if (data.launch === 'tests-only' || data.attempt >= 3 || !['replace', 'escalate', 'change-blocking-condition'].includes(transition.action)) return openFailure(state, `Implementation stopped: ${transition.action}`);
  if (transition.action === 'change-blocking-condition' && data.attempt === 2) {
    if (data.write.escalation.status !== 'available') return openFailure(state, `Implementation escalation exhausted: ${data.write.escalation.reason}`);
    transition = { ...transition, action: 'escalate', target: data.write.escalation };
  }
  data.attempt++;
  if (transition.action === 'escalate') {
    data.write.models = data.write.escalationModels.length ? data.write.escalationModels : [transition.target.model];
    data.write.effort = transition.target.effort;
  }
  data.write.candidate = 0;
  data.launch = 'full';
  data.step = 'write-pending';
  return writeAction(state);
}
export async function afterImplementationVerification(state) {
  const data = state.ordinary;
  if (data.step === 'red-verify') {
    const loadFailures = redLoadFailures(state);
    if (loadFailures.length && data.testsOnlyAttempts < 2) return relaunchTestsOnly(state, [loadFailureDefect(loadFailures)]);
    const defects = [...(loadFailures.length ? [loadFailureDefect(loadFailures)] : []), ...validateRed(state, data.envelope)];
    if (defects.length) return openFailure(state, defects.join('; '), { purpose: 'red', step: 'red-verify' });
    const redCommands = new Set(data.redCriteria.flatMap(item => item.commands));
    const red = data.redResults.find(result => result.exitStatus !== 0 && redCommands.has(result.command));
    const transition = verificationTransition(state, 'red', 'red-gate');
    append(state, 'verification', { taskId: data.taskId, attempt: data.attempt, result: 'red', commandRefs: purposeCommands(data, 'red'), transition: transition.action, failureIdentity: red.identity });
    data.redValidated = { scopeHash: fingerprint(state), evidence: data.envelope.evidence };
    // Code review after production covers test quality; no read pass gates RED.
    return startTask(state, 'full');
  }
  let result = scopedResult(state);
  const untraced = missingTrace(data.criteria, data.envelope);
  if (untraced.length) {
    result = 'regression';
    data.traceabilityDefects = untraced.map(item => `${item.id} lacks delivered observable behavior and owning production path.`);
  }
  const transition = verificationTransition(state, result, 'final');
  append(state, 'verification', { taskId: data.taskId, attempt: data.attempt, result, commandRefs: data.lastGate?.commands ?? [], transition: transition.action });
  if (transition.action !== 'complete') return retryOrFail(state, transition);
  data.implementationComplete = { result, scopeHash: fingerprint(state), envelope: data.envelope };
  data.step = 'implemented';
  return null;
}
/** Relaunches the tests-only writer on its retained changes; each relaunch is a new ledger attempt, so production continues from it. */
function relaunchTestsOnly(state, defects) {
  const data = state.ordinary;
  data.testsOnlyRepair = { defects };
  data.testsOnlyAttempts++;
  data.attempt++;
  data.launch = 'tests-only';
  for (const key of ['testsOnlyAdmitted', 'redValidated']) delete data[key];
  data.write.candidate = 0;
  data.step = 'write-pending';
  return writeAction(state);
}

// SECTION: Host decisions and completion

/** Applies the pending typed implementation decision. */
export function acceptImplementationDecision(state, reply) {
  const data = state.ordinary, answer = reply.answer;
  if (data.step === 'failure-disposition') return resolveFailure(state, answer);
  if (state.pending.question === 'implementation-recovery') {
    if (typeof answer?.raw !== 'string') return openFailure(state, 'Interrupted write has no captured outcome.');
    return acceptWrite(state, { raw: answer.raw });
  }
  if (!answer?.reason?.trim()) throw new Error('Decision requires a nonempty reason.');
  if (data.step === 'write-scope') return ruleScope(state, answer);
  if (data.step === 'concern-ruling') {
    if (answer.decision !== 'accept') return openFailure(state, 'Implementation concerns were not accepted.');
    ruling(state, 'implementation-concerns', 'accept', answer.reason);
    return acceptWrite(state, data.pendingOutcome, { concernsResolved: true });
  }
  if (data.step === 'blocking-condition' || data.step === 'missing-context') {
    if (answer.decision !== 'retry') return openFailure(state, 'Blocking condition unchanged.');
    data.continuationContext = answer.context ?? answer.reason;
    ruling(state, 'blocking-condition', 'changed', answer.reason);
    return retryOrFail(state, data.lastTransition);
  }
  throw new Error('Unknown implementation decision.');
}
/** `verification` marks a failure raised by host evidence alone, which `re-verify` may replace. */
export function openFailure(state, reason, verification = null) {
  const data = state.ordinary;
  data.failure = { reason, failureSnapshot: snapshot(state), ...(verification ? { verification } : {}) };
  data.step = 'failure-disposition';
  ruling(state, 'failure-disposition', 'inspect-first', JSON.stringify(data.failure), 'open');
  return failureQuestion(state);
}
function failureQuestion(state) {
  const data = state.ordinary;
  const attribution = failureAttribution({ baseline: data.baselineSnapshot.entries, taskStart: data.taskStart?.entries ?? data.baselineSnapshot.entries, failureSnapshot: data.failure.failureSnapshot.entries, currentState: snapshot(state).entries, authorized: true });
  const reverify = data.failure.verification ? ` Only when the host evidence itself was wrong: {decision:"re-verify", reason} reruns the ${data.failure.verification.purpose} verification on the unchanged tree.` : '';
  const redRuling = redRulingOffered(state) ? ' When RED cannot fail on this tree: {decision:"red-ruling", reason, rulings:[one per red criterion: {criterionId, kind:"carry-over", runId} citing one earlier segment of this plan that recorded RED, or {criterionId, kind:"no-failing-state", locus:"<repo path>[:line]", reason} where the plan declares its RED exception]}; the driver verifies each entry.' : '';
  const retry = retryable(state) ? ' To continue this segment instead: {decision:"retry", reason, context} keeps the tree and relaunches the writer (tests-only before a validated RED gate, production after) with context carrying the ruling, consuming one attempt.' : '';
  return ask(state, 'failure-disposition', `Choose {decision:"keep-for-repair"|"revert-attributable"|"inspect-first", reason}.${reverify}${redRuling}${retry} Reversion is limited to separately attributable paths; inspect-first keeps the ledger segment open. Only when the user decides to close the run on manual review: {decision:"manual-complete", reason, reviewer, criterionEvidence:[{criterionId, evidence}] for every criterion, redEvidence (host RED observation; required when red criteria exist)}.`, [{ reason: data.failure.reason, paths: attribution.paths, nonSeparable: attribution.nonSeparable, revertAllowed: attribution.allowed }]);
}
function resolveFailure(state, answer) {
  const data = state.ordinary;
  if (!['keep-for-repair', 'revert-attributable', 'inspect-first', 'manual-complete', 're-verify', 'retry', 'red-ruling'].includes(answer?.decision) || !answer.reason?.trim()) throw new Error('Failure disposition requires a typed decision and reason.');
  if (answer.decision === 'manual-complete') return manualComplete(state, answer);
  if (answer.decision === 'red-ruling') return redRuling(state, answer);
  if (answer.decision === 'retry') return retryFailure(state, answer);
  if (answer.decision === 're-verify') return reverify(state, answer);
  if (answer.decision === 'inspect-first') return emitAction(state, 'done', { outcome: 'failed', summary: 'Inspection requested; segment remains unterminated.', ledgerPath: state.ledgerPath, command: state.resumeCommand });
  if (answer.decision === 'revert-attributable') {
    const taskStart = data.taskStart?.entries ?? data.baselineSnapshot.entries;
    const attribution = failureAttribution({ baseline: data.baselineSnapshot.entries, taskStart, failureSnapshot: data.failure.failureSnapshot.entries, currentState: snapshot(state).entries, authorized: true });
    if (!attribution.allowed) throw new Error(`Reversion refused: ${attribution.reason}`);
    if (indexFingerprint(state.repoRoot).digest !== data.indexStart) throw new Error('Index changed after task start; manual attribution is required before reversion.');
    for (const file of attribution.paths) {
      const entry = data.preEntries?.find(item => item.path === file);
      if (!entry) throw new Error(`No task-start content for ${file}; manual attribution required.`);
      if (!['absent', '100644', '100755'].includes(entry.mode)) throw new Error(`Unsupported revert mode for ${file}; manual attribution required.`);
    }
    for (const file of attribution.paths) {
      const entry = data.preEntries.find(item => item.path === file), absolute = path.join(state.repoRoot, file);
      if (entry.mode === 'absent') fs.rmSync(absolute, { force: true });
      else { fs.writeFileSync(absolute, snapshotContent(state.repoRoot, entry)); fs.chmodSync(absolute, entry.mode === '100755' ? 0o755 : 0o644); }
    }
  }
  ruling(state, 'failure-disposition', answer.decision, answer.reason);
  append(state, 'run-complete', { result: 'stable-failure', evidenceRefs: [state.walkthroughPath] });
  return emitAction(state, 'done', { outcome: 'stable-failure', summary: data.failure.reason, ledgerPath: state.ledgerPath, command: state.resumeCommand, handoff: { rulings: data.rulings, retained: [{ path: state.walkthroughPath, reason: 'Repair evidence' }], destinations: [], warning: 'OS temp / Storage Sense may purge the ledger.' } });
}
// SECTION: RED rulings

/** Offered only at the RED verification gate of the recorded tests-only attempt, before RED validates. */
function redRulingOffered(state) {
  const data = state.ordinary;
  if (!data.redCriteria?.length || data.redValidated || data.failure?.verification?.purpose !== 'red') return false;
  const attempt = data.taskId ? ledgerSegment(state)?.tasks.get(data.taskId)?.lastAttempt?.data : null;
  return Boolean(attempt && attempt.launch === 'tests-only' && attempt.transition === 'run-red' && attempt.attempt === data.attempt);
}
const RED_ROW = /^RED-MATRIX\s+(SC\d+)\s*\|/;
const rowFor = (id) => (/** @type {unknown} */ row) => typeof row === 'string' && RED_ROW.exec(row)?.[1] === id;
/** Checks a carry-over entry against its cited segment; returns the cited RED evidence, or null after pushing defects. */
function carryOverEvidence(state, entry, defects) {
  const data = state.ordinary, planPath = path.relative(state.repoRoot, state.planPath).split(path.sep).join('/');
  const read = readLedger(state.ledgerPath);
  const events = read.status === 'ok' ? read.events : [];
  const segment = foldSegments(events).find(item => item.runId === entry.runId);
  if (!segment || segment.runStart?.governingPath !== planPath) {
    defects.push(`${entry.criterionId}: runId ${entry.runId} names no earlier ledger segment of this plan.`);
    return null;
  }
  const own = events.filter(event => event.runId === entry.runId);
  const attemptIndex = own.findLastIndex(event => event.type === 'implementation-attempt' && (event.data.terminalEnvelope?.evidence ?? []).some(rowFor(entry.criterionId)));
  // The driver appends a red verification only after validateRed accepted the whole matrix.
  const red = attemptIndex >= 0 ? own.slice(attemptIndex + 1).find(event => event.type === 'verification' && event.data.result === 'red') : null;
  if (!red) {
    defects.push(`${entry.criterionId}: runId ${entry.runId} recorded no RED verification after an attempt carrying its RED-MATRIX row.`);
    return null;
  }
  const commands = data.redCriteria.find(item => item.id === entry.criterionId)?.commands ?? [];
  if (!commands.length || !commands.every(command => data.redResults?.some(result => result.command === command && result.exitStatus === 0))) {
    defects.push(`${entry.criterionId}: carry-over requires every mapped command to pass in fresh RED results.`);
  }
  return { rows: own[attemptIndex].data.terminalEnvelope.evidence.filter(rowFor(entry.criterionId)), failureIdentity: red.data.failureIdentity };
}
function checkLocus(state, entry, defects) {
  const criterion = state.ordinary.redCriteria.find(item => item.id === entry.criterionId);
  if (!['behavior-preserving', 'already-satisfied'].includes(criterion?.redException)) defects.push(`${entry.criterionId}: no-failing-state requires the plan criterion to declare RED exception: behavior-preserving|already-satisfied.`);
  if (typeof entry.reason !== 'string' || !entry.reason.trim()) defects.push(`${entry.criterionId}: no-failing-state requires a reason.`);
  const match = /^(.+?)(?::(\d+))?$/.exec(typeof entry.locus === 'string' ? entry.locus.trim() : '');
  const file = match?.[1] ?? '', absolute = path.resolve(state.repoRoot, file), inside = path.relative(state.repoRoot, absolute);
  if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..') || !inside || inside.startsWith('..') || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    defects.push(`${entry.criterionId}: locus must name an existing repository-relative file.`);
    return;
  }
  if (match?.[2] !== undefined) {
    const line = Number(match[2]), count = fs.readFileSync(absolute, 'utf8').split('\n').length;
    if (line < 1 || line > count) defects.push(`${entry.criterionId}: locus line ${line} is outside ${file} (${count} lines).`);
  }
}
/** Accepts a driver-verified RED exception, records canonical RED, and continues to production. */
function redRuling(state, answer) {
  const data = state.ordinary;
  if (!redRulingOffered(state)) throw new Error('red-ruling applies only at the RED verification gate before RED validates.');
  const entries = Array.isArray(answer.rulings) ? answer.rulings : [];
  const defects = [];
  if (JSON.stringify(snapshot(state).entries) !== JSON.stringify(data.failure.failureSnapshot.entries)) defects.push('The tree changed after the failure; a ruling applies to the unchanged tree only.');
  const redIds = data.redCriteria.map(item => item.id), ids = entries.map(entry => entry?.criterionId);
  const missing = redIds.filter(id => !ids.includes(id)), unknown = ids.filter(id => !redIds.includes(id));
  const duplicate = [...new Set(ids.filter((id, index) => redIds.includes(id) && ids.indexOf(id) !== index))];
  if (missing.length) defects.push(`Missing ruling for ${missing.join(', ')}.`);
  if (unknown.length) defects.push(`Unknown criterion ${unknown.join(', ')}.`);
  if (duplicate.length) defects.push(`Duplicate ruling for ${duplicate.join(', ')}.`);
  const carried = entries.filter(entry => entry?.kind === 'carry-over');
  const runIds = [...new Set(carried.map(entry => entry.runId))];
  // The canonical red verification holds exactly one failureIdentity.
  if (runIds.length > 1) defects.push(`Carry-over entries must cite one runId; got ${runIds.join(', ')}.`);
  const evidence = [];
  let identity = null;
  for (const entry of entries) {
    if (entry?.kind === 'carry-over') {
      const cited = carryOverEvidence(state, entry, defects);
      if (cited) { evidence.push(...cited.rows); identity = cited.failureIdentity; }
    } else if (entry?.kind === 'no-failing-state') checkLocus(state, entry, defects);
    else defects.push(`${entry?.criterionId ?? 'entry'}: kind must be carry-over or no-failing-state.`);
  }
  // A ruling answers only its criteria's missing-RED defects; any other RED-gate defect still rejects.
  const answered = new Set(['No host-observed RED.', ...redIds.flatMap(id => [`${id} exception requires an explicit evidence-backed ruling.`, `${id} has no matching stable failure in its mapped host command.`])]);
  defects.push(...validateRed(state, data.envelope).filter(defect => !answered.has(defect)));
  if (defects.length) throw new Error(`red-ruling rejected: ${defects.join(' ')}`);
  const exceptions = entries.map(entry => (entry.kind === 'carry-over' ? { criterionId: entry.criterionId, kind: entry.kind, runId: entry.runId }
    : { criterionId: entry.criterionId, kind: entry.kind, locus: entry.locus.trim(), reason: entry.reason.trim() }));
  // Resolving the failure first keeps a resume after acceptance from reopening it.
  ruling(state, 'red-exception', 'accepted', JSON.stringify(exceptions));
  ruling(state, 'failure-disposition', 'red-ruling', answer.reason);
  const failureIdentity = carried.length === entries.length && identity ? identity
    : { exitStatus: 0, identifiers: [], diagnostic: `red-exception: ${redIds.join(', ')}` };
  append(state, 'verification', { taskId: data.taskId, attempt: data.attempt, result: 'red', commandRefs: purposeCommands(data, 'red'), transition: 'run-red', failureIdentity });
  data.redValidated = { scopeHash: fingerprint(state), evidence, exceptions };
  delete data.failure;
  return startTask(state, 'full');
}
/** A failure inside the task, with an attempt left and implementation not yet complete, can continue in-segment. */
function retryable(state) {
  const data = state.ordinary, task = data.taskId ? ledgerSegment(state)?.tasks.get(data.taskId) : null;
  return Boolean(task && task.nextAttempt <= task.maxAttempt && !data.implementationComplete);
}
/** Continues the open segment: the ruling travels to the next writer as context, so a fixable failure needs no new run. */
function retryFailure(state, answer) {
  const data = state.ordinary;
  if (!retryable(state)) throw new Error('retry needs a dispatched task with an attempt left, before implementation completes; choose another disposition.');
  const reason = data.failure.reason, context = (typeof answer.context === 'string' && answer.context.trim()) || answer.reason.trim();
  ruling(state, 'failure-disposition', 'retry', answer.reason);
  delete data.failure;
  // The ledger's next legal attempt: a failure before its outcome was recorded leaves that attempt unspent.
  const next = ledgerSegment(state).tasks.get(data.taskId).nextAttempt;
  if (data.redCriteria.length && !data.redValidated) {
    data.attempt = next - 1;
    return relaunchTestsOnly(state, [`Retry after failure: ${reason}. Ruling: ${context}`]);
  }
  data.continuationContext = `Retry after failure: ${reason}. Ruling: ${context}`;
  data.attempt = next;
  data.launch = 'full';
  data.write.candidate = 0;
  data.step = 'write-pending';
  return writeAction(state);
}
/** Replaces host evidence the user ruled wrong; the tree must still match the failure snapshot. */
function reverify(state, answer) {
  const data = state.ordinary, verification = data.failure.verification;
  if (!verification) throw new Error('re-verify applies only to a failure raised by host verification evidence.');
  if (JSON.stringify(snapshot(state).entries) !== JSON.stringify(data.failure.failureSnapshot.entries)) throw new Error('The tree changed after the failure; re-verify reruns unchanged work only.');
  ruling(state, 'failure-disposition', 're-verify', answer.reason);
  delete data.failure;
  // Merged scoped/final records of the rerun gate's commands must not count as fresh.
  if (['scoped', 'final'].includes(verification.purpose)) data.completionResults = (data.completionResults ?? []).filter(item => !(data.lastGate?.commands ?? []).includes(item.command));
  else delete data[`${verification.purpose}Results`];
  data.step = verification.step;
  return beginVerification(state, verification.purpose);
}
/** User-decided closure of a stuck run: records host evidence, reviewer, reason, and the repository fingerprint. */
function manualComplete(state, answer) {
  const data = state.ordinary;
  const evidence = Array.isArray(answer.criterionEvidence) ? answer.criterionEvidence : [];
  const missing = data.criteria.filter(criterion => !evidence.some(item => item?.criterionId === criterion.id && typeof item.evidence === 'string' && item.evidence.trim()));
  if (!answer.reviewer?.trim() || missing.length || (data.redCriteria.length && !answer.redEvidence?.trim())) {
    throw new Error(`manual-complete requires reviewer, reason, criterionEvidence for every criterion${missing.length ? ` (missing ${missing.map(item => item.id).join(', ')})` : ''}, and redEvidence when red criteria exist.`);
  }
  const criterionEvidence = data.criteria.map(criterion => ({ criterionId: criterion.id, evidence: evidence.find(item => item.criterionId === criterion.id).evidence.trim() }));
  append(state, 'manual-complete', { reviewer: answer.reviewer.trim(), reason: answer.reason.trim(), redEvidence: data.redCriteria.length ? answer.redEvidence.trim() : null, criterionEvidence, fingerprint: repositoryBaseline(state) });
  ruling(state, 'failure-disposition', 'manual-complete', answer.reason);
  append(state, 'run-complete', { result: 'complete', evidenceRefs: [state.walkthroughPath, 'manual-complete'] });
  return emitAction(state, 'done', { outcome: 'complete', summary: `Closed by manual review (${answer.reviewer.trim()}): ${answer.reason.trim()}`, ledgerPath: state.ledgerPath, handoff: { rulings: data.rulings, retained: [{ path: state.walkthroughPath, reason: 'Manual completion evidence' }], destinations: [], warning: 'OS temp / Storage Sense may purge the ledger.' } });
}
export function completeTask(state) {
  const data = state.ordinary, segment = ledgerSegment(state);
  if (segment.completedTasks.has('implementation')) return;
  const after = materializedFingerprint(state.repoRoot, data.approvedPaths);
  const before = data.preEntries.map(({ objectId, ...entry }) => ({ ...entry, content: snapshotContent(state.repoRoot, { objectId, content: entry.content }) }));
  append(state, 'task-complete', { taskId: 'implementation', paths: data.approvedPaths, head: currentHead(state.repoRoot), preState: data.preState, resultState: after.digest, diffHash: diffHash(before, after.entries) });
}
