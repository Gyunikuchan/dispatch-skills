import fs from 'node:fs';
import path from 'node:path';
import { failureAttribution } from '../failure-attribution.mjs';
import { currentHead, diffHash, indexFingerprint, materializedFingerprint } from '../git-state.mjs';
import { diffRepositoryState } from '../verification-evidence.mjs';
import { emitAction } from './actions.mjs';
import { append, ask, ledgerSegment, persistEvidence, ruling } from './ordinary-state.mjs';
import { advanceReview, startReview } from './review-phase.mjs';
import { readRunState } from './state.mjs';
import { beginVerification, completionResult, fingerprint, snapshot, validateRed, validateRedAdmission } from './verification.mjs';
import { outcomeTransition, resolveWrite, verificationTransition, writeAction } from './write.mjs';

function serializedEntries(state) {
  return materializedFingerprint(state.repoRoot, state.ordinary.approvedPaths).entries.map(entry => ({ ...entry, content: entry.content.toString('base64') }));
}
export function beginImplementation(state) {
  const data = state.ordinary;
  if (!ledgerSegment(state)?.approved) throw new Error('Implementation requires recorded approval.');
  if (!data.baselineResults || !data.testsOnlyPaths) throw new Error('Implementation requires reconciled baseline and test classification.');
  data.phase = 'implementation';
  data.write ??= resolveWrite(state);
  if (data.failure) return failureQuestion(state);
  if (data.step === 'concern-ruling') return ask(state, 'implementation-concerns', 'Resolve the captured implementation concerns before accepting the outcome.', (data.envelope?.concerns ?? []).map(reason => ({ reason })));
  if (data.step === 'blocking-condition' || data.step === 'missing-context') return ask(state, data.step === 'blocking-condition' ? 'implementation-blocked' : 'implementation-context', 'Supply the changed blocking condition or missing context with {decision:"retry", reason, context}, or stop.');
  if (data.step === 'risk-degradation') return ask(state, 'risk-review-degradation', 'Inspect the validated RED matrix and record an evidence-backed orchestrator-only gate, or stop.', [{ reason: data.riskFailure }]);
  if (data.step === 'write-pending') {
    const paths = data.launch === 'tests-only' ? data.testsOnlyPaths : data.approvedPaths;
    return ask(state, 'implementation-recovery', 'A write was dispatched before interruption. Return its captured raw terminal envelope. Missing evidence opens failure disposition; the driver will not duplicate the write.', [{ taskId: data.taskId, attempt: data.attempt, paths }]);
  }
  if (data.step === 'red-verify' || data.step === 'completion-verify') return beginVerification(state, data.step === 'red-verify' ? 'red' : 'completion');
  if (data.step === 'risk-review' && !data.riskReview) return beginRiskReview(state);
  if (data.redValidated && data.riskReview) {
    const task = ledgerSegment(state).tasks.get('implementation');
    if (task?.lastVerification?.data.result !== 'red' || task.lastAttempt?.data.transition !== 'run-red') return openFailure(state, 'Canonical RED verification is absent.');
    if (data.redValidated.scopeHash !== fingerprint(state)) return openFailure(state, 'Tests changed after the validated RED gate.');
    return startTask(state, 'full');
  }
  if (data.testsOnlyAdmitted) return openFailure(state, 'Tests-only admission exists without validated RED evidence.');
  data.taskStart = snapshot(state);
  data.indexStart = indexFingerprint(state.repoRoot).digest;
  data.preEntries = serializedEntries(state);
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

export function acceptWrite(state, reply, { concernsResolved = false } = {}) {
  const data = state.ordinary;
  if (reply.rejected || reply.failed) return advanceWriteCascade(state, reply);
  const changed = diffRepositoryState(data.taskStart, snapshot(state)).changed;
  const allowed = data.launch === 'tests-only' ? data.testsOnlyPaths : data.approvedPaths;
  if (changed.some(file => !allowed.includes(file))) return openFailure(state, 'Delegate changed paths outside its approved write scope.');
  const parsed = outcomeTransition(state, reply, { concernsResolved });
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
    return beginVerification(state, parsed.transition.action === 'run-red' ? 'red' : 'completion');
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
    const defects = validateRed(state, data.envelope);
    if (defects.length) return openFailure(state, defects.join('; '));
    const redCommands = new Set(data.redCriteria.flatMap(item => item.commands));
    const red = data.redResults.find(result => result.exitStatus !== 0 && redCommands.has(result.command));
    const transition = verificationTransition(state, 'red', 'red-gate');
    append(state, 'verification', { taskId: data.taskId, attempt: data.attempt, result: 'red', commandRefs: data.commands, transition: transition.action, failureIdentity: red.identity });
    data.redValidated = { scopeHash: fingerprint(state), evidence: data.envelope.evidence };
    return beginRiskReview(state);
  }
  let result = completionResult(state);
  const traceRows = data.envelope?.evidence?.filter(item => typeof item === 'string' && item.startsWith('CRITERION ')) ?? [];
  const missingTrace = data.criteria.filter(criterion => !traceRows.some(row => row.startsWith(`CRITERION ${criterion.id} |`) && criterion.paths.some(file => row.includes(file))));
  if (missingTrace.length) {
    result = 'regression';
    data.traceabilityDefects = missingTrace.map(item => `${item.id} lacks delivered observable behavior and owning production path.`);
  }
  const transition = verificationTransition(state, result, 'final');
  append(state, 'verification', { taskId: data.taskId, attempt: data.attempt, result, commandRefs: data.commands, transition: transition.action });
  if (transition.action !== 'complete') return retryOrFail(state, transition);
  data.implementationComplete = { result, scopeHash: fingerprint(state), envelope: data.envelope };
  data.step = 'implemented';
  return null;
}
async function beginRiskReview(state) {
  const data = state.ordinary;
  data.step = 'risk-review';
  persistEvidence(state);
  // Bounded mode reuses configured transport, parser and source-attributed adjudication, but never checkpoints or writes review rounds.
  const action = await startReview({ invocation: { ...state.invocation, verb: 'review', kind: 'code', argument: state.walkthroughPath, fix: false }, cwd: state.repoRoot, resumeCommand: state.resumeCommand, transient: true });
  state.riskState = readRunState(action.stateFile);
  return handleRiskAction(state, action);
}
export function continueRiskReview(state, reply) {
  return handleRiskAction(state, advanceReview(state.riskState, reply));
}
function handleRiskAction(state, action) {
  if (action.action !== 'done') return { ...action, stateFile: state.stateFile };
  if (action.outcome === 'refused' || action.outcome === 'lint-defects') return openFailure(state, action.summary);
  if (action.outcome !== 'complete') {
    state.ordinary.step = 'risk-degradation';
    state.ordinary.riskFailure = action.summary;
    return ask(state, 'risk-review-degradation', 'Independent read review failed or was unavailable. Inspect the changed tests and RED matrix before accepting an orchestrator-only gate. Return {decision:"accept", reason} or stop.', [{ reason: action.summary }]);
  }
  if (state.ordinary.redValidated.scopeHash !== fingerprint(state)) return openFailure(state, 'Tests changed during independent RED review.');
  state.ordinary.riskReview = { outcome: action.outcome, sourceMap: state.riskState.collect?.sourceMap ?? {}, summary: action.summary };
  delete state.riskState;
  return startTask(state, 'full');
}
export function acceptImplementationDecision(state, reply) {
  const data = state.ordinary, answer = reply.answer;
  if (data.step === 'failure-disposition') return resolveFailure(state, answer);
  if (state.pending.question === 'implementation-recovery') {
    if (typeof answer?.raw !== 'string') return openFailure(state, 'Interrupted write has no captured outcome.');
    return acceptWrite(state, { raw: answer.raw });
  }
  if (!answer?.reason?.trim()) throw new Error('Decision requires a nonempty reason.');
  if (data.step === 'concern-ruling') {
    if (answer.decision !== 'accept') return openFailure(state, 'Implementation concerns were not accepted.');
    ruling(state, 'implementation-concerns', 'accept', answer.reason);
    return acceptWrite(state, data.pendingOutcome, { concernsResolved: true });
  }
  if (data.step === 'risk-degradation') {
    if (answer.decision !== 'accept') return openFailure(state, 'Risk review degradation not accepted.');
    if (data.redValidated.scopeHash !== fingerprint(state)) return openFailure(state, 'Tests changed during risk review degradation ruling.');
    data.riskReview = { outcome: 'orchestrator-only', failure: data.riskFailure, evidence: answer.reason };
    delete state.riskState;
    return startTask(state, 'full');
  }
  if (data.step === 'blocking-condition' || data.step === 'missing-context') {
    if (answer.decision !== 'retry') return openFailure(state, 'Blocking condition unchanged.');
    data.continuationContext = answer.context ?? answer.reason;
    ruling(state, 'blocking-condition', 'changed', answer.reason);
    return retryOrFail(state, data.lastTransition);
  }
  throw new Error('Unknown implementation decision.');
}
export function openFailure(state, reason) {
  const data = state.ordinary;
  data.failure = { reason, failureSnapshot: snapshot(state) };
  data.step = 'failure-disposition';
  ruling(state, 'failure-disposition', 'inspect-first', JSON.stringify(data.failure), 'open');
  return failureQuestion(state);
}
function failureQuestion(state) {
  const data = state.ordinary;
  const attribution = failureAttribution({ baseline: data.baselineSnapshot.entries, taskStart: data.taskStart?.entries ?? data.baselineSnapshot.entries, failureSnapshot: data.failure.failureSnapshot.entries, currentState: snapshot(state).entries, authorized: true });
  return ask(state, 'failure-disposition', 'Choose {decision:"keep-for-repair"|"revert-attributable"|"inspect-first", reason}. Reversion is limited to separately attributable paths; inspect-first keeps the ledger segment open.', [{ reason: data.failure.reason, paths: attribution.paths, nonSeparable: attribution.nonSeparable, revertAllowed: attribution.allowed }]);
}
function resolveFailure(state, answer) {
  const data = state.ordinary;
  if (!['keep-for-repair', 'revert-attributable', 'inspect-first'].includes(answer?.decision) || !answer.reason?.trim()) throw new Error('Failure disposition requires a typed decision and reason.');
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
      else { fs.writeFileSync(absolute, Buffer.from(entry.content, 'base64')); fs.chmodSync(absolute, entry.mode === '100755' ? 0o755 : 0o644); }
    }
  }
  ruling(state, 'failure-disposition', answer.decision, answer.reason);
  append(state, 'run-complete', { result: 'stable-failure', evidenceRefs: [state.walkthroughPath] });
  return emitAction(state, 'done', { outcome: 'stable-failure', summary: data.failure.reason, ledgerPath: state.ledgerPath, command: state.resumeCommand, handoff: { rulings: data.rulings, retained: [{ path: state.walkthroughPath, reason: 'Repair evidence' }], destinations: [], warning: 'OS temp / Storage Sense may purge the ledger.' } });
}
export function completeTask(state) {
  const data = state.ordinary, segment = ledgerSegment(state);
  if (segment.completedTasks.has('implementation')) return;
  const after = materializedFingerprint(state.repoRoot, data.approvedPaths);
  const before = data.preEntries.map(entry => ({ ...entry, content: Buffer.from(entry.content, 'base64') }));
  append(state, 'task-complete', { taskId: 'implementation', paths: data.approvedPaths, head: currentHead(state.repoRoot), preState: data.preState, resultState: after.digest, diffHash: diffHash(before, after.entries) });
}
