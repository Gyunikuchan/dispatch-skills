// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { emitAction } from './actions.mjs';
import { createRunState, resumeCommand, writeRunSidecar, writeRunState } from './state.mjs';
import { assertBinding, bindPlan, ledgerSegment, persistEvidence, refuse, restoreEvidence, save } from './implement-state.mjs';
import { writeCheckpoint } from './review-phase.mjs';
import { acceptPlan, authorPlan, beginReview, continueReview, finishPlanReview, requireSettledPlan } from './plan-phase.mjs';
import { acceptBaselineRuling, approve, autoApproval, baselineDecision, beginBaseline } from './baseline-phase.mjs';
import { acceptVerification, beginVerification, completionResult, fingerprint, gateCommands, scopedResult } from './verification.mjs';
import { acceptImplementationDecision, acceptWrite, afterImplementationVerification, beginImplementation, openFailure } from './task-phase.mjs';
import { finishCodeReview, handoff, requireImplementation } from './handoff-phase.mjs';

// SECTION: Phase entry

/**
 * Creates or reconstructs an ordinary implementation run and emits its first action.
 * @param {{ invocation: Record<string, any>, cwd: string, resumeCommand: string, dispatchScript: string }} options
 */
export async function startImplement({ invocation, cwd, resumeCommand, dispatchScript }) {
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  const state = createRunState({ invocation, repoRoot, resumeCommand, dispatchScript, ordinary: {}, pending: null });
  writeRunSidecar(state, invocation);
  const from = invocation.phases?.slice(5);
  if (invocation.argument?.endsWith('.md')) {
    const fromCwd = path.resolve(cwd, invocation.argument);
    // A repository-relative resume argument run from a subdirectory resolves against the root.
    bindPlan(state, fs.existsSync(fromCwd) ? fromCwd : path.resolve(repoRoot, invocation.argument));
    bindResume(state);
  } else if (from && from !== 'plan') return save(state, refuse(state, `${from} requires a canonical plan path; plan produces it.`));
  if (!state.planPath) return save(state, authorPlan(state));
  if (from === 'plan') {
    const prior = ledgerSegment(state);
    if (prior?.approved) return save(state, refuse(state, 'An approved active run already binds this plan; resume its phase or use a new plan identity.'));
    return save(state, authorPlan(state));
  }
  try {
    if (!from) return save(state, await enterBoundPlan(state));
    if (invocation.verb === 'implement') restoreEvidence(state);
    return save(state, await enterPhase(state, from));
  } catch (error) {
    // Refusal must not overwrite the canonical evidence that failed reconstruction.
    state.pending = refuse(state, error.message);
    writeRunState(state);
    return state.pending;
  }
}
/** Once a plan is bound, the run resumes by its repository-relative path at its recorded phase. */
function bindResume(state) {
  state.invocation = { ...state.invocation, argument: path.relative(state.repoRoot, state.planPath).split(path.sep).join('/'), phases: null };
  state.resumeCommand = resumeCommand(state.invocation);
  writeRunSidecar(state, state.invocation);
}
/** Implement entry over a bound plan: restored evidence resumes its phase; a settled plan passes to baseline; otherwise plan review. */
async function enterBoundPlan(state) {
  const implement = state.invocation.verb === 'implement';
  const restored = implement && restoreEvidence(state);
  // An implement run over a plan whose settled checkpoint matches its content needs no new review round.
  if (!restored && implement && settledPlan(state)) return passGate(state, beginBaseline(state));
  return enterPhase(state, restored ? state.ordinary.phase : 'plan-review');
}
function settledPlan(state) {
  try { return requireSettledPlan(state).outcome === 'complete'; } catch { return false; }
}
export async function enterPhase(state, phase) {
  if (phase === 'plan-review') return consumeReview(state, await beginReview(state, 'plan'));
  requireSettledPlan(state);
  if (phase === 'baseline') {
    if (ledgerSegment(state)?.tasks.size) return refuse(state, 'Baseline cannot be replaced after task dispatch; resume implementation.');
    return passGate(state, beginBaseline(state));
  }
  const segment = ledgerSegment(state) ?? ledgerSegment(state, { terminal: true });
  if (segment?.terminal && phase !== 'handoff') return refuse(state, 'The matching segment is terminal; start a new governed repair plan.');
  if (!segment?.approved) {
    if (!state.ordinary.baselineResults) return refuse(state, `${phase} requires reconciled baseline; baseline produces it.`);
    state.ordinary.afterApproval = phase;
    return passGate(state, baselineDecision(state));
  }
  if (phase === 'implementation') {
    // An open post-review failure disposition outranks re-entering code review.
    if (state.ordinary.implementationComplete && !state.ordinary.failure) { requireImplementation(state); return consumeReview(state, await beginReview(state, 'code')); }
    return beginImplementation(state);
  }
  requireImplementation(state);
  if (phase === 'code-review' && state.ordinary.step === 'final-verify') return beginVerification(state, 'final');
  if (phase === 'code-review') return consumeReview(state, await beginReview(state, 'code'));
  if (phase === 'handoff') return handoff(state);
  return refuse(state, `Unknown ordinary phase ${phase}.`);
}
/** Passes an approval gate that autoApproval answers; any other action goes to the host. */
async function passGate(state, action) {
  const reply = action.question === 'approval' && autoApproval(state);
  if (!reply) return action;
  approve(state, reply, 'driver');
  return enterPhase(state, state.ordinary.afterApproval ?? 'implementation');
}
async function consumeReview(state, action) {
  if (action.action !== 'done') return action;
  if (state.ordinary.phase === 'plan-review') {
    if (!finishPlanReview(state, action)) return action;
    if (state.invocation.verb === 'plan') return emitAction(state, 'done', { outcome: 'complete', summary: 'Plan authored and plan review settled; baseline has not started.', artifactPath: state.planPath, checkpointed: action.checkpointed ?? false });
    return passGate(state, beginBaseline(state));
  }
  // An implementation code review settles without its checkpoint; the final gate precedes it.
  // NOTE: the done schema has no settled field; an implementation review's complete, uncheckpointed outcome is its settlement.
  if (!(action.outcome === 'complete' && action.checkpointed === false && state.reviewState?.invocation?.implementation)) {
    if (!finishCodeReview(state, action)) return action;
    delete state.reviewState;
  }
  const data = state.ordinary;
  if (scopedResult(state) === 'regression') {
    // Accepted fixes changed scope: verify them, then review again.
    delete state.reviewState;
    delete data.checkpoint;
    data.step = 'post-review-verify';
    return beginVerification(state, 'scoped');
  }
  data.step = 'final-verify';
  data.finalVerified = false;
  // Every final-tier record is already fresh: the final gate has nothing to run.
  if (!gateCommands(state, 'final').length && !data.generators?.length) return afterFinalVerification(state);
  return beginVerification(state, 'final');
}
/** Renders final evidence, records the deferred code-review checkpoint, and hands off. */
async function afterFinalVerification(state) {
  const data = state.ordinary;
  if (completionResult(state) === 'regression') return openFailure(state, 'Final verification failed or is stale.', { purpose: 'final', step: 'final-verify' });
  // Generators may rewrite [GENERATED] paths at the final gate.
  data.implementationComplete.scopeHash = fingerprint(state);
  data.finalVerified = true;
  if (!state.reviewState) {
    if (data.checkpoint || data.codeReview?.outcome === 'skipped') { data.phase = 'handoff'; return handoff(state); }
    // NOTE: a resumed run lost its settled review state; review again to reach the checkpoint.
    return consumeReview(state, await beginReview(state, 'code'));
  }
  persistEvidence(state);
  const action = writeCheckpoint(state.reviewState);
  if (!finishCodeReview(state, action)) {
    // A drifted checkpoint restarts a review wave inside the retained review.
    if (action.action !== 'done') data.step = 'code-review';
    return { ...action, stateFile: state.stateFile };
  }
  delete state.reviewState;
  data.phase = 'handoff';
  return handoff(state);
}
/** Captures the governing artifacts so a reply that throws leaves no half-applied round or evidence stub. */
function artifactSnapshot(state) {
  return [state.planPath, state.walkthroughPath].filter(Boolean).map(file => ({ file, content: fs.existsSync(file) ? fs.readFileSync(file) : null }));
}
function restoreArtifacts(snapshot) {
  for (const { file, content } of snapshot) {
    if (content === null) fs.rmSync(file, { force: true });
    else if (!fs.existsSync(file) || !fs.readFileSync(file).equals(content)) fs.writeFileSync(file, content);
  }
}
export async function advanceImplement(state, reply) {
  const artifacts = artifactSnapshot(state);
  try {
    let action;
    const data = state.ordinary;
    if (data.phase === 'plan') {
      acceptPlan(state, reply);
      bindResume(state);
      action = await enterBoundPlan(state);
    } else if (state.reviewState && !['final-verify', 'failure-disposition'].includes(data.step)) {
      action = await consumeReview(state, continueReview(state, reply));
    } else {
      assertBinding(state);
      if (state.pending.action === 'verify') {
        action = acceptVerification(state, reply);
        if (!action) {
          if (data.phase === 'baseline') action = passGate(state, baselineDecision(state));
          else if (data.step === 'final-verify') action = await afterFinalVerification(state);
          else if (data.step === 'post-review-verify') {
            if (scopedResult(state) === 'regression') action = openFailure(state, 'Post-review verification failed or is stale.', { purpose: 'scoped', step: 'post-review-verify' });
            else { data.implementationComplete.scopeHash = fingerprint(state); action = await consumeReview(state, await beginReview(state, 'code')); }
          } else {
            action = await afterImplementationVerification(state);
            if (!action) action = await consumeReview(state, await beginReview(state, 'code'));
          }
        }
      } else if (state.pending.action === 'delegate-write') action = acceptWrite(state, reply);
      else if (data.step === 'baseline-ruling') {
        if (reply.answer?.decision === 'fix-first') { data.baselineAccepted = null; action = await consumeReview(state, await beginReview(state, 'plan')); }
        else action = acceptBaselineRuling(state, reply);
      } else if (data.step === 'approval') {
        approve(state, reply);
        action = await enterPhase(state, data.afterApproval ?? 'implementation');
      } else action = acceptImplementationDecision(state, reply);
    }
    return save(state, await action);
  } catch (error) {
    // Invalid or stale host replies cannot advance the durable state machine or its artifacts.
    restoreArtifacts(artifacts);
    return { ...state.pending, error: error.message };
  }
}
