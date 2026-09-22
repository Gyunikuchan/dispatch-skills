import fs from 'node:fs';
import crypto from 'node:crypto';
import { ensureLedgerNamespace } from '../ledger.mjs';
import { repositoryRootHash } from '../resolve-artifact-paths.mjs';
import { append, ask, ledgerSegment, relative, ruling } from './ordinary-state.mjs';
import { requireSettledPlan } from './plan-phase.mjs';
import { beginVerification, repositoryBaseline, snapshot, verificationPlan } from './verification.mjs';

export function beginBaseline(state) {
  state.ordinary.planReview = requireSettledPlan(state);
  Object.assign(state.ordinary, verificationPlan(state), { phase: 'baseline', step: 'baseline-verify', mutationEpoch: 0 });
  state.ordinary.baseline = repositoryBaseline(state);
  state.ordinary.baselineSnapshot = snapshot(state);
  if (!fs.existsSync(state.walkthroughPath)) fs.writeFileSync(state.walkthroughPath, [
    '# Implementation walkthrough', '', 'Implementation of the approved governing plan.', '', '## Changes Made',
    ...state.ordinary.approvedPaths.map(file => `- **[MODIFY]** \`${file}\` — Approved implementation scope.`), '',
    '## Verification & Validation', 'Host verification is recorded in Ordinary execution evidence.', '',
    '## Key Deviations', 'None.', '', '## Review Findings & Resolutions', '*No reviews conducted yet.*', '', '## Follow-ups', 'None.', '',
  ].join('\n'));
  return beginVerification(state, 'baseline');
}
export function baselineDecision(state) {
  const data = state.ordinary;
  const problematic = data.baselineResults.filter(result => result.exitStatus !== 0 || result.changed.length);
  if (problematic.length && !data.baselineAccepted) {
    data.step = 'baseline-ruling';
    return ask(state, 'baseline-red', 'Reconcile baseline failures/unavailable commands and command side effects before approval. Choose accept with reason, or fix-first.', problematic);
  }
  data.phase = 'baseline';
  data.step = 'approval';
  data.approvalSnapshot = repositoryBaseline(state);
  return ask(state, 'approval', 'Approve this governing plan and reconciled baseline. Return {decision:"approved", governingHash, testPaths, reason}. Classify only approved paths that may be changed by the tests-only delegate.', [{ governingHash: state.governingHash, baseline: data.approvalSnapshot, approvedPaths: data.approvedPaths, commands: data.commands }]);
}
export function acceptBaselineRuling(state, reply) {
  const answer = reply.answer;
  if (answer?.decision !== 'accept' || typeof answer.reason !== 'string' || !answer.reason.trim()) throw new Error('Baseline ruling requires {decision:"accept", reason}; fix-first returns to plan-review.');
  state.ordinary.baselineAccepted = { reason: answer.reason };
  return baselineDecision(state);
}
export function approve(state, reply) {
  const answer = reply.answer, data = state.ordinary;
  if (answer?.decision !== 'approved' || answer.governingHash !== state.governingHash || !answer.reason?.trim()) throw new Error('Approval requires the current governingHash, decision approved, and reason.');
  if (JSON.stringify(repositoryBaseline(state)) !== JSON.stringify(data.approvalSnapshot)) throw new Error('Repository drifted during approval; recapture baseline.');
  if (!Array.isArray(answer.testPaths) || !answer.testPaths.length || answer.testPaths.some(file => !data.approvedPaths.includes(file))) throw new Error('Approval must classify nonempty tests-only paths within the approved scope.');
  data.testPaths = [...new Set(answer.testPaths)];
  data.baselineSnapshot = snapshot(state);
  ensureLedgerNamespace({ repoHash: repositoryRootHash(state.repoRoot) });
  const segment = ledgerSegment(state);
  if (segment?.approved) { state.ledgerRunId = segment.runId; return; }
  if (segment && segment.tasks.size) throw new Error('Unapproved ledger contains task activity; reconcile first.');
  state.ledgerRunId = segment?.runId ?? crypto.randomUUID();
  if (!segment) append(state, 'run-start', { governingPath: relative(state, state.planPath), governingHash: state.governingHash, rootSlug: state.slug, action: 'ordinary', baseline: data.baseline });
  append(state, 'approval', { governingHash: state.governingHash, decision: 'approved', actor: 'user' });
  if (data.baselineAccepted) ruling(state, 'baseline-red', 'accept', data.baselineAccepted.reason);
  data.approval = { governingHash: state.governingHash, reason: answer.reason };
}
