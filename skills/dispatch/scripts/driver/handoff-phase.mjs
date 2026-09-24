// @ts-check
import { evaluateConsensus } from '../review/consensus.mjs';
import { readArtifact, semanticSectionHashes } from '../review/preparation.mjs';
import { scanResolutionLog } from '../review/resolution-log.mjs';
import { relocateScratchPaths } from '../artifacts/relocate-scratch.mjs';
import { emitAction } from './actions.mjs';
import { append, ledgerSegment, persistEvidence, relative } from './implement-state.mjs';
import { completeTask } from './task-phase.mjs';
import { completionResult, fingerprint } from './verification.mjs';
import { reviewPolicy } from './plan-phase.mjs';

// SECTION: Handoff preconditions

/** Requires canonical completion evidence for the current implementation scope. */
export function requireImplementation(state) {
  const data = state.ordinary;
  const segment = ledgerSegment(state) ?? ledgerSegment(state, { terminal: true });
  const task = segment?.tasks.get('implementation');
  if (!segment?.approved || !data.implementationComplete || task?.lastVerification?.data.transition !== 'complete' || task.lastAttempt?.data.terminalEnvelope?.stage !== 'COMPLETE') throw new Error('code-review requires approved implementation outcome and canonical complete verification; implementation produces them.');
  if (data.implementationComplete.scopeHash !== fingerprint(state) || completionResult(state) === 'regression') throw new Error('Implementation verification is missing or stale; resume implementation verification.');
}
export function codeCheckpoint(state) {
  const artifact = readArtifact(state.walkthroughPath, { kind: 'code' });
  if (evaluateConsensus(artifact.source).exit !== 0 || !artifact.metadata || artifact.metadata.contentHash !== semanticSectionHashes(artifact.source).contentHash) throw new Error('handoff requires settled code-review checkpoint; code-review produces it.');
  return artifact.metadata;
}
export function finishCodeReview(state, action) {
  if (action.outcome === 'skipped' && reviewPolicy(state, 'code').skipped) {
    state.ordinary.codeReview = { outcome: 'skipped', reason: action.reason };
    return true;
  }
  if (action.outcome !== 'complete' || !action.checkpointed) return false;
  state.ordinary.checkpoint = codeCheckpoint(state);
  state.ordinary.codeReview = { outcome: 'complete' };
  return true;
}

// SECTION: Terminal handoff

/** Settles the ledger and emits the successful terminal handoff. */
export function handoff(state) {
  requireImplementation(state);
  persistEvidence(state);
  const walkthrough = readArtifact(state.walkthroughPath, { kind: 'code' }).source;
  for (const criterion of state.ordinary.criteria) {
    const row = walkthrough.split(/\r?\n/).find(line => line.startsWith(`- [${criterion.id}]`));
    if (!row || /Pending|missing validated/i.test(row)) throw new Error(`handoff requires complete outcome traceability for ${criterion.id}.`);
  }
  const disabled = reviewPolicy(state, 'code').skipped;
  const checkpoint = disabled ? null : codeCheckpoint(state);
  const segment = ledgerSegment(state, { terminal: true });
  if (segment.terminal && segment.result !== 'complete') throw new Error('A stable failure requires repair, not successful handoff.');
  if (!segment.terminal) {
    completeTask(state);
    if (checkpoint && !segment.reviews.some(review => review.checkpointRef === checkpoint.invocationId)) {
      const log = scanResolutionLog(readArtifact(state.walkthroughPath).source, { strict: true });
      const counts = { accepted: 0, rejected: 0, resolvedDispute: 0, disputed: 0, pendingConfirmation: 0, unknown: 0 };
      for (const round of log.rounds) for (const entry of round.entries) if (entry.status in counts) counts[entry.status]++;
      append(state, 'review', { kind: 'code', round: Math.max(1, log.rounds.length), counts, checkpointRef: checkpoint.invocationId });
    }
    append(state, 'run-complete', { result: 'complete', evidenceRefs: [relative(state, state.planPath), relative(state, state.walkthroughPath), ...(checkpoint ? [checkpoint.invocationId] : [disabled.reason])] });
  }
  // Design-run artifacts relocate together only after final integration.
  const retained = state.designPath ? [state.planPath, state.walkthroughPath].map(file => ({ path: relative(state, file), reason: 'Design-run artifact; relocates after final integration' })) : [];
  const destinations = state.designPath ? [] : relocateScratchPaths([state.planPath, state.walkthroughPath], { cwd: state.repoRoot });
  return emitAction(state, 'done', { outcome: 'complete', summary: 'Implementation verified and code review settled.', checkpointed: Boolean(checkpoint),
    ledgerPath: state.ledgerPath, command: state.resumeCommand, handoff: { checkpoint, resumeCommand: state.resumeCommand, ledgerPath: state.ledgerPath,
      rulings: state.ordinary.rulings ?? [], warning: 'OS temp / Storage Sense may purge the ledger and relocated artifacts.', retained, destinations, ...(disabled ? { reviewDisabled: disabled.reason } : {}) } });
}
