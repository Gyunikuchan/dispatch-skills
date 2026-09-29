// @ts-check
import path from 'node:path';
import { diffRepositoryState } from '../verification/evidence.mjs';
import { DriverError } from './actions.mjs';
import { captureLimits, inRedWindow, limitViolations, startContent } from './hotfix-limits.mjs';
import { append, ask, ledgerSegment, ruling } from './implement-state.mjs';
import { beginVerification, gateCommands, snapshot } from './verification.mjs';
import { changedLines } from './discard.mjs';
import { writeAction } from './write.mjs';
import { beginImplementation, continueWriter, failureQuestion, retryable, retryOrFail } from './task-phase.mjs';
import { baselineDecision } from './baseline-phase.mjs';

// SECTION: Offer
// A hot fix repairs a stall directly on the kept tree instead of opening a nested writer/review loop.
// It spends no writer attempt; the final code review covers it through `finalFocus`.

/** Fixed, not configurable: the budget only separates host edits from a single-shot writer. */
export const HOTFIX_BUDGET = { files: 10, lines: 150 };
const normalize = value => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Offer clause for a stall question; after a no-progress hot fix it names the surviving identity instead. */
export function hotfixOption(state, { hostOnly = false } = {}) {
  const withdrawn = state.ordinary.hotfixWithdrawn;
  if (withdrawn) return ` Hot fix withdrawn: the last hot fix left its target failure unchanged (${withdrawn.slice(0, 200)}); choose retry or keep-for-repair.`;
  const mode = hostOnly ? '"host"' : '"host"|"writer"';
  return ` First choice when evidence points to a specific locus: {decision:"hotfix", mode:${mode}, rootCause, reason, external?:[{path, reason}]} repairs it on the kept tree (host edits inline within ${HOTFIX_BUDGET.files} files/${HOTFIX_BUDGET.lines} lines${hostOnly ? '' : '; writer launches one single-shot write subagent'}), then re-runs the stalled check; it spends no writer attempt.`;
}
/** The failure identity a hot fix targets: extracted gate identities for verification failures, else the normalized reason. */
export function failureKey(state, source = 'failure') {
  const data = state.ordinary;
  if (source === 'baseline') return (data.baselineResults ?? []).filter(item => item.exitStatus !== 0 || item.changed?.length).map(item => `${item.command} ${JSON.stringify(item.identity ?? item.changed)}`).sort().join('\n');
  if (source !== 'failure') return normalize([...(data.envelope?.blockers ?? []), ...(data.envelope?.missingContext ?? [])].join('; '));
  const purpose = data.failure?.verification?.purpose;
  const results = purpose === 'baseline' ? data.baselineResults : ['scoped', 'final'].includes(purpose) ? data.completionResults : purpose ? data[`${purpose}Results`] : null;
  const failing = (results ?? []).filter(item => item.exitStatus !== 0).map(item => `${item.command} ${JSON.stringify(item.identity ?? null)}`).sort();
  return failing.length ? failing.join('\n') : normalize(data.failure?.reason);
}
/** Withdraws hot-fix for the segment when the failure a hot fix targeted survived it unchanged. */
export function checkProgress(state, source = 'failure') {
  const data = state.ordinary;
  if (data.hotfixTarget === undefined) return;
  if (failureKey(state, source) === data.hotfixTarget) data.hotfixWithdrawn = data.hotfixTarget;
  delete data.hotfixTarget;
}

// SECTION: Start

function repoPath(value) {
  const file = typeof value === 'string' ? path.posix.normalize(value.replace(/\\/g, '/')).replace(/^\.\//, '') : '';
  if (!file || path.posix.isAbsolute(file) || /^[A-Za-z]:/.test(file) || file.split('/').includes('..')) throw new DriverError('reply', `external path must be repository-relative inside the repository: ${value}`);
  return file;
}
/**
 * Starts a host or single-shot writer hot fix from a stall question.
 * @param {any} state
 * @param {any} answer
 * @param {'failure'|'blocking-condition'|'missing-context'|'baseline'} source
 */
export function beginHotfix(state, answer, source) {
  const data = state.ordinary, baseline = source === 'baseline';
  if (data.hotfixWithdrawn) throw new DriverError('reply', `Hot fix is withdrawn for this segment: its last hot fix left the target failure unchanged. Choose another decision.`);
  if (!['host', 'writer'].includes(answer.mode) || typeof answer.rootCause !== 'string' || !answer.rootCause.trim() || !answer.reason?.trim()) throw new DriverError('reply', 'hotfix requires {decision:"hotfix", mode:"host"|"writer", rootCause, reason, external?:[{path, reason}]}.');
  // Production writes require recorded approval, so a baseline hot fix is the host's own edit.
  if (baseline && answer.mode === 'writer') throw new DriverError('reply', 'A baseline hot fix is host-only: the write subagent needs recorded plan approval.');
  const external = answer.external ?? [];
  if (!Array.isArray(external) || external.some(item => typeof item?.reason !== 'string' || !item.reason.trim())) throw new DriverError('reply', 'Each external entry needs {path, reason}.');
  const start = snapshot(state);
  data.hotfix = {
    mode: answer.mode, rootCause: answer.rootCause.trim(), reason: answer.reason.trim(), source, openStep: data.step,
    external: external.map(item => ({ path: repoPath(item.path), reason: item.reason.trim() })),
    target: failureKey(state, source), failureReason: baseline ? 'Baseline commands failed or changed the repository.' : data.failure?.reason ?? data.envelope?.summary ?? source,
    start: captureLimits(state.repoRoot, start),
  };
  if (!baseline) {
    // The resolving ruling precedes hotfix-start, so the ledger fold sees the hot fix as open until it settles.
    ruling(state, source === 'failure' ? 'failure-disposition' : 'blocking-condition', 'hotfix', answer.reason);
    append(state, 'hotfix-start', { mode: answer.mode, failureSnapshot: start.entries, head: data.hotfix.start.head, index: data.hotfix.start.index, stash: data.hotfix.start.stash, targetIdentity: data.hotfix.target, openStep: data.step ?? 'unknown' });
  }
  return answer.mode === 'host' ? editQuestion(state) : launchWriter(state);
}
function editQuestion(state, prefix = '') {
  const data = state.ordinary, fix = data.hotfix;
  data.step = 'hotfix-edit';
  const red = inRedWindow(data) ? ` Before RED validates, edit only tests-only paths: ${data.testsOnlyPaths.join(', ')}.` : '';
  return ask(state, 'hotfix-edit', `${prefix}Apply the hot fix now by editing inline (no subagent), then return {done:true}. Root cause: ${fix.rootCause}. Scope: approved plan paths plus any repository path needed to unblock the run; each out-of-plan path is recorded as a scope extension. Budget: ${HOTFIX_BUDGET.files} files / ${HOTFIX_BUDGET.lines} changed lines, excluding declared external paths. Never edit outside the repository, in .git/, or secrets files; never delete a file that existed at task start; never run git commands that write history or discard state (add/stage, commit, reset, file checkout/restore, stash, rebase, merge --abort).${red}`,
    [{ failure: fix.failureReason, rootCause: fix.rootCause, approvedPaths: data.approvedPaths ?? [], budget: HOTFIX_BUDGET, external: fix.external }]);
}
function launchWriter(state) {
  const data = state.ordinary, fix = data.hotfix;
  fix.priorLaunch = data.launch ?? null;
  data.launch = 'hotfix';
  data.write.candidate = 0;
  data.step = 'write-pending';
  return writeAction(state);
}

// SECTION: Replies

/** Routes `hotfix-edit` and `hotfix-budget` answers. */
export function acceptHotfixReply(state, reply) {
  const data = state.ordinary, answer = reply?.answer;
  if (data.step === 'hotfix-edit') {
    if (answer?.done !== true) throw new DriverError('reply', 'Return {done:true} after applying the hot fix.');
    return applyHotfix(state);
  }
  if (!['writer', 'disposition'].includes(answer?.decision) || !answer.reason?.trim()) throw new DriverError('reply', 'hotfix-budget requires {decision:"writer"|"disposition", reason}.');
  if (answer.decision === 'disposition') return reopen(state, 'Over-budget host hot fix returned to the stall decision; its edits are kept.');
  if (data.hotfix.source === 'baseline') throw new DriverError('reply', 'A baseline hot fix is host-only; choose disposition.');
  data.hotfix.mode = 'writer';
  return launchWriter(state);
}
/** Single-shot writer reply: a transport failure advances the model cascade; any non-DONE outcome returns to the stall decision. */
export function acceptHotfixWrite(state, reply, inspect) {
  const data = state.ordinary, fix = data.hotfix;
  if (reply?.rejected || reply?.failed) {
    if (data.write.candidate + 1 < data.write.models.length) { data.write.candidate++; return writeAction(state); }
    // Partial edits are judged against the hard limits before the stall reopens.
    const violations = limitViolations(state, diffRepositoryState(fix.start.state, snapshot(state)).changed);
    if (violations.length) { data.launch = fix.priorLaunch; data.write.candidate = 0; return limitAsk(state, violations); }
    return reopen(state, `Hot-fix writer unavailable: ${reply.reason ?? reply.failed?.reason ?? 'cascade exhausted'}; its partial edits are kept.`);
  }
  const inspected = inspect(state, reply?.envelopePath);
  if (inspected.errors.length) throw new DriverError('reply', `Hot-fix envelope rejected: ${inspected.errors.join('; ')} Repair it at ${data.expectedEnvelopePath}.`);
  data.launch = fix.priorLaunch;
  data.write.candidate = 0;
  if (!['DONE', 'DONE_WITH_CONCERNS'].includes(inspected.envelope.status)) {
    const violations = limitViolations(state, diffRepositoryState(fix.start.state, snapshot(state)).changed);
    if (violations.length) return limitAsk(state, violations);
    return reopen(state, `Hot-fix writer returned ${inspected.envelope.status}: ${inspected.envelope.summary}; its edits are kept.`);
  }
  return applyHotfix(state);
}

// SECTION: Apply

/** A host reply is refused in place; a writer's violations hand the tree to the host to undo. */
function limitAsk(state, violations) {
  const fix = state.ordinary.hotfix;
  const text = `Hot fix violates hard limits: ${violations.join('; ')}. Nothing was reverted; undo these yourself, then return {done:true}.`;
  if (fix.mode === 'host') throw new DriverError('reply', text);
  fix.mode = 'host';
  return editQuestion(state, `${text} `);
}
/** Judges the hot-fix diff against hard limits and budget, records it, and resumes at the stalled check. */
export function applyHotfix(state) {
  const data = state.ordinary, fix = data.hotfix;
  const touched = diffRepositoryState(fix.start.state, snapshot(state)).changed;
  const violations = limitViolations(state, touched);
  if (violations.length) return limitAsk(state, violations);
  const before = file => startContent(state, file);
  const external = new Map(fix.external.map(item => [item.path, item.reason]));
  const counted = touched.filter(file => !external.has(file));
  const lines = counted.reduce((sum, file) => sum + (changedLines(state, file, before(file)) ?? HOTFIX_BUDGET.lines + 1), 0);
  if (fix.mode === 'host' && (counted.length > HOTFIX_BUDGET.files || lines > HOTFIX_BUDGET.lines)) {
    data.step = 'hotfix-budget';
    return ask(state, 'hotfix-budget', `The host hot fix changed ${counted.length} files / ${lines} lines, over the ${HOTFIX_BUDGET.files}/${HOTFIX_BUDGET.lines} budget (a binary change counts as over); nothing was reverted. ${fix.source === 'baseline' ? '' : 'Return {decision:"writer", reason} to finish it with one single-shot writer on the current tree, or '}{decision:"disposition", reason} to return to the stall decision with the edits kept.`, [{ files: counted.length, lines, paths: counted }]);
  }
  return recordHotfix(state, { touched, lines });
}
/** Adds paths the final code review must look at; the first reason for a path wins. */
export function addFocus(state, entries) {
  const data = state.ordinary, focus = new Map((data.finalFocus ?? []).map(item => [item.path, item]));
  for (const item of entries) if (!focus.has(item.path)) focus.set(item.path, item);
  data.finalFocus = [...focus.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
function recordHotfix(state, { touched, lines }) {
  const data = state.ordinary, fix = data.hotfix;
  const external = new Map(fix.external.map(item => [item.path, item.reason]));
  const callerDirty = new Set(Object.keys(data.baselineSnapshot?.entries ?? {}));
  const planned = new Set(data.approvedPaths ?? []);
  const scopeExtensions = touched.filter(file => !planned.has(file) || callerDirty.has(file)).map(file => ({ path: file,
    reason: external.get(file) ?? (callerDirty.has(file) ? 'caller-dirty path edited by hot fix; stays non-revertable' : `hot fix: ${fix.rootCause}`) }));
  if (data.approvedPaths) data.approvedPaths = [...new Set([...data.approvedPaths, ...touched])].sort();
  data.mutationEpoch = (data.mutationEpoch ?? 0) + 1;
  const verification = data.failure?.verification;
  const record = { mode: fix.mode, paths: touched, lines, rootCause: fix.rootCause, scopeExtensions, external: fix.external,
    evidenceRef: fix.source === 'baseline' ? 'verify:baseline' : verification ? `verify:${verification.purpose}` : 'writer-continuation' };
  data.hotfixes ??= [];
  data.hotfixes.push({ ...record, source: fix.source });
  addFocus(state, touched.map(file => ({ path: file, reason: `hot fix: ${fix.rootCause}` })));
  // Before approval no ledger segment exists; approval appends baseline hot fixes.
  if (fix.source !== 'baseline') append(state, 'hotfix', record);
  data.hotfixTarget = fix.target;
  delete data.hotfix;
  return resume(state, fix, touched);
}
/** A verification failure re-runs that verification; a baseline re-captures its touched commands; other stalls continue the writer. */
function resume(state, fix, touched) {
  const data = state.ordinary;
  if (fix.source === 'baseline') {
    const stale = command => (data.scopes?.[command] ?? []).some(file => touched.includes(file));
    data.baselineResults = (data.baselineResults ?? []).filter(item => item.exitStatus === 0 && !item.changed?.length && !stale(item.command));
    data.baselineSnapshot = snapshot(state);
    data.step = 'baseline-verify';
    return gateCommands(state, 'baseline').length ? beginVerification(state, 'baseline') : baselineDecision(state);
  }
  const verification = data.failure?.verification;
  if (verification) {
    delete data.failure;
    if (['scoped', 'final'].includes(verification.purpose)) data.completionResults = (data.completionResults ?? []).filter(item => !(data.lastGate?.commands ?? []).includes(item.command));
    else delete data[`${verification.purpose}Results`];
    // A rerun RED gate re-derives its validation from the hot-fixed tests.
    if (verification.purpose === 'red') delete data.redValidated;
    data.step = verification.step;
    return beginVerification(state, verification.purpose);
  }
  const context = `Hot fix applied (${fix.rootCause}); continue from the current tree.`;
  if (fix.source !== 'failure') {
    data.continuationContext = context;
    return retryOrFail(state, data.lastTransition);
  }
  // Before RED validates the next launch would be tests-only, which a hot fix does not continue.
  if (!retryable(state) || (data.redCriteria?.length && !data.redValidated)) {
    // The stalled check never re-runs here, so no-progress cannot be judged.
    delete data.hotfixTarget;
    return reopen(state, `Hot fix applied (${touched.join(', ')}); no writer attempt remains to continue from it.`, { keepFailure: true });
  }
  delete data.failure;
  return continueWriter(state, context);
}
/** Returns to the stall decision the hot fix came from, with the tree kept. */
function reopen(state, note, { keepFailure = true } = {}) {
  const data = state.ordinary, fix = data.hotfix;
  delete data.hotfix;
  if (fix && fix.priorLaunch !== undefined) data.launch = fix.priorLaunch;
  const source = fix?.source ?? (data.failure ? 'failure' : 'baseline');
  data.step = fix?.openStep ?? data.step;
  const action = source === 'baseline' ? baselineDecision(state) : source === 'failure' && keepFailure ? (data.step = 'failure-disposition', failureQuestion(state)) : beginImplementation(state);
  return action.action === 'ask-user' ? { ...action, text: `${note} ${action.text}` } : action;
}
/** Re-enters an interrupted hot fix at its open question; its kept edits are judged when the host replies. */
export function resumeHotfix(state) {
  if (state.ordinary.step === 'hotfix-edit') return editQuestion(state, 'Resumed after interruption. ');
  return applyHotfix(state);
}
