// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertClassifiableLevel } from '../lib/config.mjs';
import { ensureLedgerNamespace } from '../ledger/ledger.mjs';
import { lintPlan } from '../plan/lint.mjs';
import { DriverError } from './actions.mjs';
import { append, ask, ledgerSegment, pendingRows, refuse, relative, ruling, source } from './implement-state.mjs';
import { documentTitle } from '../lib/summary-box.mjs';
import { lintWalkthrough } from '../walkthrough/lint.mjs';
import { cell, changeEntries, renderChangesMade, renderVerification } from '../walkthrough/traceability.mjs';
import { extractChangeNotes } from '../plan/structure.mjs';
import { requireSettledPlan } from './plan-phase.mjs';
import { designSlug } from './design-phase.mjs';
import { beginHotfix, checkProgress, hotfixOption, resumeHotfix } from './hotfix.mjs';
import { beginVerification, cachedBaseline, repositoryBaseline, snapshot, verificationPlan } from './verification.mjs';

// SECTION: Baseline phase

/** Enters baseline verification after requiring a settled governing plan. */
export function beginBaseline(state) {
  // An interrupted baseline hot fix settles before the baseline is re-captured.
  if (state.ordinary.hotfix?.source === 'baseline') return resumeHotfix(state);
  state.ordinary.planReview = requireSettledPlan(state);
  Object.assign(state.ordinary, verificationPlan(state), { phase: 'baseline', step: 'baseline-verify', mutationEpoch: 0 });
  state.ordinary.baseline = repositoryBaseline(state);
  state.ordinary.baselineSnapshot = snapshot(state);
  if (!fs.existsSync(state.walkthroughPath)) {
    // Planned notes until the writer reports what changed; `+0 −0` stands in for a heading with no note.
    const notes = extractChangeNotes(source(state));
    const planned = changeEntries({ paths: state.ordinary.approvedPaths, stats: new Map(), planNotes: notes });
    fs.writeFileSync(state.walkthroughPath, [
      `# ${cell(documentTitle(source(state)) ?? 'Implementation walkthrough')}`, '',
      '> **Delivered:** pending', `> **Parent:** \`${relative(state, state.planPath)}\``,
      `> **Status:** 0/${state.ordinary.criteria.length} SC passing`, '> **Deviations:** none', '',
      '## Changes Made', renderChangesMade(planned), '',
      '## Verification', renderVerification(pendingRows(state.ordinary.criteria), 'pending'), '',
      '## Deviations & Follow-ups', 'None.', '', '## Review Findings & Resolutions', '*No reviews conducted yet.*', '',
    ].join('\n'));
  }
  const scaffoldDefects = lintWalkthrough(fs.readFileSync(state.walkthroughPath, 'utf8'), { criteria: state.ordinary.criteria }).defects;
  if (scaffoldDefects.length) return refuse(state, `Walkthrough scaffold failed lint: ${[...new Set(scaffoldDefects.map(item => item.rule))].join(', ')}`);
  // Identical content reuses cached per-command results; the baseline runs only the misses.
  const cached = cachedBaseline(state);
  delete state.ordinary.baselineResults;
  delete state.ordinary.baselineReused;
  if (cached.hits.length) {
    state.ordinary.baselineResults = cached.hits;
    state.ordinary.baselineReused = cached.hits.length;
  }
  if (!cached.misses.length) return baselineDecision(state);
  return beginVerification(state, 'baseline');
}

// SECTION: Baseline decisions

/** Emits the baseline ruling or approval gate implied by captured results. */
export function baselineDecision(state) {
  const data = state.ordinary;
  const problematic = data.baselineResults.filter(result => result.exitStatus !== 0 || result.changed.length);
  if (problematic.length && !data.baselineAccepted) {
    checkProgress(state, 'baseline');
    data.step = 'baseline-ruling';
    return ask(state, 'baseline-red', `Reconcile baseline failures/unavailable commands and command side effects before approval.${hotfixOption(state, { hostOnly: true })} Otherwise choose {decision:"accept", reason}, or fix-first.`, problematic);
  }
  data.phase = 'baseline';
  data.step = 'approval';
  data.approvalSnapshot = repositoryBaseline(state);
  // Surfaced here too because a low run skips the plan review that would otherwise relay it.
  const testPathWarnings = lintPlan(source(state)).warnings.filter(item => item.rule === 'criterion-red-test-path').map(item => item.message);
  return ask(state, 'approval', 'Approve this governing plan and reconciled baseline; approval also authorizes the driver to run its commands and generators. Return {decision:"approved", governingHash, testPaths, reason, level?}. testPaths may be empty only when no criterion uses red evidence. To stop instead, return {decision:"rejected", reason}.', [{ governingHash: state.governingHash, baseline: data.approvalSnapshot, approvedPaths: data.approvedPaths, redCriteria: data.redCriteria.map(item => ({ id: item.id, paths: item.paths })), commands: data.commands, ...(data.hotfixes?.length ? { hotfixes: data.hotfixes.map(fix => ({ paths: fix.paths, rootCause: fix.rootCause, ledgerRef: 'hotfix (appended at approval)' })) } : {}), ...(data.generators?.length ? { generators: data.generators } : {}), ...(testPathWarnings.length ? { warnings: testPathWarnings } : {}) }]);
}
export function acceptBaselineRuling(state, reply) {
  const answer = reply.answer;
  if (answer?.decision === 'hotfix') return beginHotfix(state, answer, 'baseline');
  if (answer?.decision !== 'accept' || typeof answer.reason !== 'string' || !answer.reason.trim()) throw new DriverError('reply', 'Baseline ruling requires {decision:"accept", reason}; fix-first returns to plan-review.');
  state.ordinary.baselineAccepted = { reason: answer.reason };
  return baselineDecision(state);
}
/**
 * Answers the approval gate without asking when the user typed `low` and it has nothing to rule on:
 * clean baseline, no red criteria, not a design increment.
 */
export function autoApproval(state) {
  const { invocation, ordinary: data } = state;
  if (invocation.level !== 'low' || invocation.levelSource !== 'explicit' || state.designPath || data.baselineAccepted || data.redCriteria.length) return null;
  return { answer: { decision: 'approved', governingHash: state.governingHash, testPaths: [], reason: 'Auto-approved: explicit low level, clean baseline, no red criteria.' } };
}
export function approve(state, reply, actor = 'user') {
  const answer = reply.answer, data = state.ordinary;
  if (answer?.decision !== 'approved' || answer.governingHash !== state.governingHash || !answer.reason?.trim()) throw new DriverError('reply', 'Approval requires the current governingHash, decision approved, and reason.');
  if (JSON.stringify(repositoryBaseline(state)) !== JSON.stringify(data.approvalSnapshot)) throw new DriverError('state', 'Repository drifted during approval.', 'recapture baseline.');
  const redPaths = new Set(data.redCriteria.flatMap(item => item.paths));
  // Approved paths are POSIX repository-relative; replies may use backslashes or a leading "./".
  if (Array.isArray(answer.testPaths)) answer.testPaths = answer.testPaths.map(file => typeof file === 'string' ? path.posix.normalize(file.replace(/\\/g, '/')).replace(/^\.\//, '') : file);
  if (!Array.isArray(answer.testPaths) || (data.redCriteria.length > 0 && !answer.testPaths.length) || answer.testPaths.some(file => !data.approvedPaths.includes(file) || !redPaths.has(file))) throw new DriverError('reply', 'Approval must classify tests-only paths mapped to red criteria; nonempty paths are required only for red criteria.');
  let reevaluatedLevel;
  if (answer.level !== undefined && state.invocation.levelSource !== 'explicit') {
    try {
      assertClassifiableLevel(answer.level, 'classified');
    } catch (err) {
      throw new DriverError('reply', err.message);
    }
    state.invocation.level = answer.level;
    state.invocation.levelSource = 'classified';
    reevaluatedLevel = answer.level;
  }
  data.testsOnlyPaths = [...new Set(answer.testPaths)].sort();
  data.testPaths = data.testsOnlyPaths;
  data.baselineSnapshot = snapshot(state);
  // Baseline no-progress judgments do not carry into the implementation segment.
  delete data.hotfixTarget;
  delete data.hotfixWithdrawn;
  ensureLedgerNamespace();
  const segment = ledgerSegment(state);
  if (segment?.approved) { state.ledgerRunId = segment.runId; return; }
  if (segment && segment.tasks.size) throw new Error('Unapproved ledger contains task activity; reconcile first.');
  const design = state.designPath && { path: relative(state, state.designPath), revision: state.designRevision };
  state.ledgerRunId = segment?.runId ?? crypto.randomUUID();
  if (!segment) append(state, 'run-start', design
    ? { governingPath: design.path, governingHash: design.revision, rootSlug: designSlug(state.designPath), action: 'increment', design, baseline: data.baseline,
      increment: { id: state.increment.id, planPath: relative(state, state.planPath), walkthroughPath: relative(state, state.walkthroughPath), planHash: state.governingHash } }
    : { governingPath: relative(state, state.planPath), governingHash: state.governingHash, rootSlug: state.slug, action: 'ordinary', baseline: data.baseline });
  append(state, 'approval', {
    governingHash: design?.revision ?? state.governingHash,
    decision: 'approved',
    actor,
    ...(reevaluatedLevel ? { level: reevaluatedLevel } : {}),
  });
  if (data.baselineAccepted) ruling(state, 'baseline-red', 'accept', data.baselineAccepted.reason);
  // Hot fixes before approval had no ledger segment to record into.
  for (const { source, ...fix } of data.hotfixes ?? []) if (source === 'baseline') append(state, 'hotfix', fix);
  data.approval = {
    governingHash: state.governingHash,
    reason: answer.reason,
    actor,
    ...(reevaluatedLevel ? { level: reevaluatedLevel } : {}),
  };
}
