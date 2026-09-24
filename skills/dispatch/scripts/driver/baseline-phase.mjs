// @ts-check
import fs from 'node:fs';
import crypto from 'node:crypto';
import { ensureLedgerNamespace } from '../ledger/ledger.mjs';
import { repositoryRootHash } from '../artifacts/resolve-paths.mjs';
import { append, ask, ledgerSegment, relative, ruling } from './implement-state.mjs';
import { requireSettledPlan } from './plan-phase.mjs';
import { designSlug } from './design-phase.mjs';
import { beginVerification, cachedBaseline, repositoryBaseline, snapshot, verificationPlan } from './verification.mjs';

export function beginBaseline(state) {
  state.ordinary.planReview = requireSettledPlan(state);
  Object.assign(state.ordinary, verificationPlan(state), { phase: 'baseline', step: 'baseline-verify', mutationEpoch: 0 });
  state.ordinary.baseline = repositoryBaseline(state);
  state.ordinary.baselineSnapshot = snapshot(state);
  if (!fs.existsSync(state.walkthroughPath)) fs.writeFileSync(state.walkthroughPath, [
    '# Implementation walkthrough', '', 'Implementation of the approved governing plan.', '', '## Changes Made',
    ...state.ordinary.approvedPaths.map(file => `- **[MODIFY]** \`${file}\` — Approved implementation scope.`), '',
    '## Verification & Validation', 'Host verification is recorded in Ordinary execution evidence with evidence class, revision, result, and limitations.', '',
    '## Outcome Traceability', ...state.ordinary.criteria.map(item => `- [${item.id}] Pending — evidence: ${item.evidence}; production path: pending implementation.`), '',
    '## Key Deviations', 'None.', '', '## Review Findings & Resolutions', '*No reviews conducted yet.*', '', '## Follow-ups', 'None.', '',
  ].join('\n'));
  const cached = cachedBaseline(state);
  if (cached) {
    // An identical tree reuses its recorded baseline instead of rerunning every command.
    state.ordinary.baselineResults = cached.results;
    state.ordinary.baselineReused = cached.capturedAt;
    return baselineDecision(state);
  }
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
  return ask(state, 'approval', 'Approve this governing plan and reconciled baseline; approval also authorizes the driver to run its commands and generators. Return {decision:"approved", governingHash, testPaths, reason}. testPaths may be empty only when no criterion uses red evidence.', [{ governingHash: state.governingHash, baseline: data.approvalSnapshot, approvedPaths: data.approvedPaths, redCriteria: data.redCriteria.map(item => ({ id: item.id, paths: item.paths })), commands: data.commands, ...(data.generators?.length ? { generators: data.generators } : {}) }]);
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
  const redPaths = new Set(data.redCriteria.flatMap(item => item.paths));
  if (!Array.isArray(answer.testPaths) || (data.redCriteria.length > 0 && !answer.testPaths.length) || answer.testPaths.some(file => !data.approvedPaths.includes(file) || !redPaths.has(file))) throw new Error('Approval must classify tests-only paths mapped to red criteria; nonempty paths are required only for red criteria.');
  data.testsOnlyPaths = [...new Set(answer.testPaths)].sort();
  data.testPaths = data.testsOnlyPaths;
  data.baselineSnapshot = snapshot(state);
  ensureLedgerNamespace({ repoHash: repositoryRootHash(state.repoRoot) });
  const segment = ledgerSegment(state);
  if (segment?.approved) { state.ledgerRunId = segment.runId; return; }
  if (segment && segment.tasks.size) throw new Error('Unapproved ledger contains task activity; reconcile first.');
  const design = state.designPath && { path: relative(state, state.designPath), revision: state.designRevision };
  // Increment segments share the driver run identity, as design segments do.
  state.ledgerRunId = segment?.runId ?? (design ? state.runId : crypto.randomUUID());
  if (!segment) append(state, 'run-start', design
    ? { governingPath: design.path, governingHash: design.revision, rootSlug: designSlug(state.designPath), action: 'increment', design, baseline: data.baseline,
      increment: { id: state.increment.id, planPath: relative(state, state.planPath), walkthroughPath: relative(state, state.walkthroughPath), planHash: state.governingHash } }
    : { governingPath: relative(state, state.planPath), governingHash: state.governingHash, rootSlug: state.slug, action: 'ordinary', baseline: data.baseline });
  append(state, 'approval', { governingHash: design?.revision ?? state.governingHash, decision: 'approved', actor: 'user' });
  if (data.baselineAccepted) ruling(state, 'baseline-red', 'accept', data.baselineAccepted.reason);
  data.approval = { governingHash: state.governingHash, reason: answer.reason };
}
