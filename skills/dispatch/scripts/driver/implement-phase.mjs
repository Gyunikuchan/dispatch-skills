// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { emitAction } from './actions.mjs';
import { createRunState, writeRunSidecar, writeRunState } from './state.mjs';
import { assertBinding, bindPlan, ledgerSegment, refuse, restoreEvidence, save } from './implement-state.mjs';
import { acceptPlan, authorPlan, beginReview, continueReview, finishPlanReview, requireSettledPlan } from './plan-phase.mjs';
import { acceptBaselineRuling, approve, baselineDecision, beginBaseline } from './baseline-phase.mjs';
import { acceptVerification, beginVerification, completionResult, fingerprint } from './verification.mjs';
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
  if (invocation.argument?.endsWith('.md')) bindPlan(state, path.resolve(cwd, invocation.argument));
  else if (from && from !== 'plan') return save(state, refuse(state, `${from} requires a canonical plan path; plan produces it.`));
  if (!state.planPath) return save(state, authorPlan(state));
  if (from === 'plan') {
    const prior = ledgerSegment(state);
    if (prior?.approved) return save(state, refuse(state, 'An approved active run already binds this plan; resume its phase or use a new plan identity.'));
    return save(state, authorPlan(state));
  }
  try {
    const restored = invocation.verb === 'implement' && restoreEvidence(state);
    // An implement run over a plan whose settled checkpoint matches its content needs no new review round.
    if (!from && !restored && invocation.verb === 'implement' && settledPlan(state)) return save(state, beginBaseline(state));
    const entry = from ?? (restored ? state.ordinary.phase : 'plan-review');
    return save(state, await enterPhase(state, entry));
  } catch (error) {
    // Refusal must not overwrite the canonical evidence that failed reconstruction.
    state.pending = refuse(state, error.message);
    writeRunState(state);
    return state.pending;
  }
}
function settledPlan(state) {
  try { return requireSettledPlan(state).outcome === 'complete'; } catch { return false; }
}
export async function enterPhase(state, phase) {
  if (phase === 'plan-review') return consumeReview(state, await beginReview(state, 'plan'));
  requireSettledPlan(state);
  if (phase === 'baseline') {
    if (ledgerSegment(state)?.tasks.size) return refuse(state, 'Baseline cannot be replaced after task dispatch; resume implementation.');
    return beginBaseline(state);
  }
  const segment = ledgerSegment(state) ?? ledgerSegment(state, { terminal: true });
  if (segment?.terminal && phase !== 'handoff') return refuse(state, 'The matching segment is terminal; start a new governed repair plan.');
  if (!segment?.approved) {
    if (!state.ordinary.baselineResults) return refuse(state, `${phase} requires reconciled baseline; baseline produces it.`);
    state.ordinary.afterApproval = phase;
    return baselineDecision(state);
  }
  if (phase === 'implementation') {
    // An open post-review failure disposition outranks re-entering code review.
    if (state.ordinary.implementationComplete && !state.ordinary.failure) { requireImplementation(state); return consumeReview(state, await beginReview(state, 'code')); }
    return beginImplementation(state);
  }
  requireImplementation(state);
  if (phase === 'code-review') return consumeReview(state, await beginReview(state, 'code'));
  if (phase === 'handoff') return handoff(state);
  return refuse(state, `Unknown ordinary phase ${phase}.`);
}
async function consumeReview(state, action) {
  if (action.action !== 'done') return action;
  if (state.ordinary.phase === 'plan-review') {
    if (!finishPlanReview(state, action)) return action;
    if (state.invocation.verb === 'plan') return emitAction(state, 'done', { outcome: 'complete', summary: 'Plan authored and plan review settled; baseline has not started.', artifactPath: state.planPath, checkpointed: action.checkpointed ?? false });
    return beginBaseline(state);
  }
  if (!finishCodeReview(state, action)) return action;
  delete state.reviewState;
  if (completionResult(state) === 'regression') {
    delete state.ordinary.checkpoint;
    state.ordinary.step = 'post-review-verify';
    return beginVerification(state, 'completion');
  }
  state.ordinary.phase = 'handoff';
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
      action = await consumeReview(state, await beginReview(state, 'plan'));
    } else if (state.reviewState) {
      action = await consumeReview(state, continueReview(state, reply));
    } else {
      assertBinding(state);
      if (state.pending.action === 'verify') {
        action = acceptVerification(state, reply);
        if (!action) {
          if (data.phase === 'baseline') action = baselineDecision(state);
          else if (data.step === 'post-review-verify') {
            if (completionResult(state) === 'regression') action = openFailure(state, 'Final post-review verification failed or is stale.', { purpose: 'completion', step: 'post-review-verify' });
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
