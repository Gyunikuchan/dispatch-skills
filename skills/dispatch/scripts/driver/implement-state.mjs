// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { appendEvent, governingHash, readLedger, resumeOrdinary, slugFromPlanPath } from '../ledger/ledger.mjs';
import { parseIncrementGraph } from '../design/graph.mjs';
import { foldSegments } from '../ledger/events.mjs';
import { resolveLedgerPath } from '../artifacts/resolve-paths.mjs';
import { DriverError, emitAction } from './actions.mjs';
import { finish as persistAction } from './state.mjs';
import { restoreSessionPaths, storeSessionPaths } from '../lib/session-temp.mjs';
import { FIXES_SUFFIX, withFixes } from '../lib/filler.mjs';
import { captureRepositoryState } from '../verification/evidence.mjs';
import { DEFERRED, cell, oneLine, changeEntries, hasDeviation, isPassing, parseChangesMade, renderChangesMade, renderVerification, replaceBoxLine, replaceSection, replaceStatusLine, sectionBody } from '../walkthrough/traceability.mjs';
import { evidenceFile } from '../lib/session-paths.mjs';
import { changeStats } from '../lib/git-state.mjs';
import { safeRenameSync } from '../lib/platform.mjs';
import { extractChangeNotes } from '../plan/structure.mjs';

// SECTION: Governing artifact binding

/** Returns a repository-relative, slash-normalized artifact path. */
export const relative = (state, file) => path.relative(state.repoRoot, file).split(path.sep).join('/');
export const source = state => fs.readFileSync(state.planPath, 'utf8');
export function bindPlan(state, file) {
  state.planPath = path.resolve(state.repoRoot, file);
  if (/\.design\.md$/.test(state.planPath)) throw new Error('Design paths must be bound through resumeDesign.');
  state.slug = slugFromPlanPath(relative(state, state.planPath));
  const hash = governingHash(source(state));
  if (hash.status !== 'ok') throw new Error(hash.diagnostic);
  state.governingHash = hash.hash;
  state.walkthroughPath = state.planPath.replace(/\.plan\.md$/, '.walkthrough.md');
  state.ledgerPath = resolveLedgerPath({ slug: state.slug, slugSource: 'explicit', repositoryRoot: state.repoRoot, artifactKind: 'plan' });
}
export function assertBinding(state) {
  if (governingHash(source(state)).hash !== state.governingHash) throw new DriverError('state', 'Plan changed.', 'return to plan-review and approval.');
}
/**
 * @param {any} state
 * @param {{ terminal?: boolean }} [options]
 */
export function ledgerSegment(state, { terminal = false } = {}) {
  const read = readLedger(state.ledgerPath);
  if (read.status === 'missing') return null;
  if (read.status !== 'ok') throw new Error(read.diagnostic);
  const segments = foldSegments(read.events).filter(state.designPath ? segment => ownsIncrement(state, segment) && segment.runStart.increment.planHash === state.governingHash
    : segment => segment.runStart.governingPath === relative(state, state.planPath) && segment.governingHash === state.governingHash);
  return segments.findLast(segment => terminal || !segment.terminal) ?? null;
}
// Design increments bind by increment identity and approved design revision, not plan path.
const ownsIncrement = (state, segment) => segment.runStart.action === 'increment' && segment.runStart.increment.id === state.increment?.id && segment.governingHash === state.designRevision;
export function append(state, type, data) {
  assertBinding(state);
  const event = { v: state.designPath ? 2 : 1, type, runId: state.ledgerRunId, at: new Date().toISOString(), data };
  // Validate the prospective fold before the locked canonical append; appendEvent owns sequence allocation.
  const read = readLedger(state.ledgerPath);
  const folded = foldSegments(read.events);
  if (type === 'run-start' && folded.some(segment => !segment.terminal && (state.designPath ? ownsIncrement(state, segment) : segment.governingHash === state.governingHash) && segment.runId !== state.ledgerRunId)) throw new Error('An ordinary run already owns this governing revision; reconstruct it before approval.');
  const prior = read.events.findLast(item => item.runId === state.ledgerRunId && item.type === type && JSON.stringify(item.data) === JSON.stringify(data));
  if (prior && type !== 'ruling') return prior;
  foldSegments([...read.events, { ...event, seq: (read.events.at(-1)?.seq ?? 0) + 1 }]);
  return appendEvent(state.ledgerPath, { ...event, seq: (read.events.at(-1)?.seq ?? 0) + 1 });
}
export function ruling(state, key, decision, reason, status = 'resolved') {
  const data = { key, decision, reason, costIfWrong: 'Incorrect attribution could overwrite caller work or certify unverified implementation.', state: status };
  append(state, 'ruling', data);
  state.ordinary.rulings ??= [];
  state.ordinary.rulings.push(data);
}
/** Pending rows until completion evidence exists; never bullets. */
export const pendingRows = criteria => criteria.map(criterion => ({ id: criterion.id, behavior: criterion.title ?? criterion.text ?? '', evidence: 'Pending' }));
/** Red evidence names the failing test the RED gate observed, or the accepted exception. */
function redEvidence(ordinary, criterion) {
  const exception = (ordinary.redValidated?.exceptions ?? []).find(item => item.criterionId === criterion.id);
  if (exception?.kind === 'no-failing-state') return `N/A — ${exception.locus ? `${exception.locus} — ` : ''}exception (${criterion.redException ?? 'ruled'}): ${exception.reason}`;
  const row = (ordinary.redValidated?.evidence ?? []).map(item => typeof item === 'string' && /^RED-MATRIX\s+(SC\d+)\s*\|\s*([^|]+?)\s*\|/.exec(item)).find(match => match?.[1] === criterion.id);
  const commands = criterion.commands.map(command => `\`${command}\``).join(', ');
  return `red→green ${row ? `\`${row[2]}\` via ` : ''}${commands || 'mapped host verification'}${exception?.kind === 'carry-over' ? ` (carried over from ${exception.runId})` : ''}`;
}
function traceRows(ordinary, records) {
  if (!ordinary.implementationComplete || !ordinary.completionResults) return pendingRows(ordinary.criteria);
  return ordinary.criteria.map(criterion => {
    const row = ordinary.envelope?.evidence?.find(item => typeof item === 'string' && item.startsWith(`CRITERION ${criterion.id} |`));
    // Rows are `CRITERION SC# | <path> | <behavior>` (write.mjs); only the first two pipes delimit, so the behavior keeps its own.
    const behavior = row ? row.split('|').slice(2).join('|').trim() : '';
    // Evidence at the current epoch; an earlier record for the same criterion is stale.
    const evidence = records.find(item => item.criterionId === criterion.id && item.mutationEpoch === (ordinary.mutationEpoch ?? 0));
    const base = { id: criterion.id, behavior: behavior || criterion.title || '' };
    if (row && !evidence && criterion.evidence !== 'red' && criterion.commands.length && criterion.commands.every(command => (ordinary.finalOnly ?? []).includes(command))) return { ...base, evidence: DEFERRED };
    if (!row || (criterion.evidence !== 'red' && !evidence)) return { ...base, evidence: `Pending — missing validated ${criterion.evidence} evidence.` };
    return { ...base, evidence: evidence ? `${evidence.evidenceClass}; ${evidence.scenario}; ${evidence.observableResult}` : redEvidence(ordinary, criterion) };
  });
}
function finalGate(ordinary) {
  if (!ordinary.finalVerified) return 'pending';
  const finals = new Set(ordinary.finalOnly ?? []);
  const results = (ordinary.completionResults ?? []).filter(item => !finals.size || finals.has(item.command));
  return results.map(item => `\`${item.command}\` exit ${item.exitStatus}`).join('; ') || 'no final-only commands; scoped gates passed';
}
/** Changes Made from every path changed since the write baseline, keeping review `fixes <IDs>` suffixes. */
function renderChanges(state, text) {
  const data = state.ordinary;
  if (data.envelope?.stage !== 'COMPLETE' || data.write?.baselineHead === undefined) return text;
  const stats = changeStats(state.repoRoot, { base: data.write.baselineHead });
  // Session artifacts and this run's own documents and sidecar are not production changes.
  const own = new Set([state.planPath, state.walkthroughPath, evidenceFile(state.walkthroughPath)].filter(Boolean).map(file => path.relative(state.repoRoot, file).split(path.sep).join('/')));
  // Paths already dirty at baseline and untouched since belong to the user, not this run.
  const before = data.baselineSnapshot?.entries ?? {};
  const now = Object.keys(before).length ? captureRepositoryState(state.repoRoot).entries : {};
  const preexisting = file => before[file] && now[file]?.objectId === before[file].objectId;
  const paths = [...stats.keys()].filter(file => !/^\.scratch(?:\/|$)/.test(file) && !own.has(file) && !preexisting(file)).sort();
  const summary = oneLine(data.envelope.summary);
  const same = (a, b) => a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // Walkthrough lint rejects a Delivered line that repeats the H1.
  const delivered = same(summary, /^# (.+)$/m.exec(text)?.[1] ?? '') ? `Implemented: ${summary}` : summary;
  if (!paths.length) return replaceBoxLine(text, 'Delivered', delivered);
  const fixes = new Map(parseChangesMade(sectionBody(text, 'Changes Made') ?? []).flatMap(item => { const match = FIXES_SUFFIX.exec(item.note); return match ? [[item.path, match[1].split(', ')]] : []; }));
  const entries = changeEntries({ paths, stats, files: data.envelope.files ?? [], planNotes: extractChangeNotes(source(state)) })
    .map(entry => (fixes.has(entry.path) ? { ...entry, note: withFixes(entry.note, fixes.get(entry.path)) } : entry));
  text = replaceSection(text, 'Changes Made', renderChangesMade(entries));
  return replaceBoxLine(text, 'Delivered', delivered);
}
// Driver-owned deviation bullets are re-rendered from run state; authored bullets are kept.
const RECOVERY_BULLET = /^- Deviation: (?:Hot fix|Discarded)\b/;
/** Discloses hot fixes, their scope extensions, and discard patches as Deviation bullets. */
function renderRecovery(state, text) {
  const data = state.ordinary, body = sectionBody(text, 'Deviations & Follow-ups');
  if (!body) return text;
  const extensions = fix => (fix.scopeExtensions.length ? `; scope extensions: ${fix.scopeExtensions.map(item => `${item.path} (${oneLine(item.reason)})`).join(', ')}` : '');
  const bullets = [
    ...(data.hotfixes ?? []).map(fix => `- Deviation: Hot fix (${fix.mode}) — ${oneLine(fix.rootCause)}; paths ${fix.paths.join(', ') || 'none'}${extensions(fix)}.`),
    ...(data.retained ?? []).map(item => `- Deviation: Discarded — ${oneLine(item.reason)}; patch \`${item.path}\`.`),
  ];
  const kept = body.filter(line => !RECOVERY_BULLET.test(line.trim()) && !/^None\.?$/.test(line.trim()));
  while (kept.length && !kept.at(-1).trim()) kept.pop();
  while (kept.length && !kept[0].trim()) kept.shift();
  if (!bullets.length && kept.length === body.filter(line => line.trim()).length) return text;
  const lines = [...kept, ...bullets];
  text = replaceSection(text, 'Deviations & Follow-ups', lines.length ? lines.join('\n') : 'None.');
  if (bullets.length && /^> \*\*Deviations:\*\* none\s*$/m.test(text)) {
    const parts = [data.hotfixes?.length ? `${data.hotfixes.length} hot fix(es)` : '', data.retained?.length ? `${data.retained.length} user-approved discard(s) with saved patches` : ''].filter(Boolean);
    text = replaceBoxLine(text, 'Deviations', parts.join('; '));
  }
  return text;
}
function renderValidatedEvidence(state, text) {
  const ordinary = state.ordinary;
  if (!ordinary || !Array.isArray(ordinary.criteria)) return text;
  const records = (ordinary.completionResults ?? []).flatMap(result => result.criterionEvidence ?? []);
  const rows = traceRows(ordinary, records);
  text = renderChanges(state, text);
  text = renderRecovery(state, text);
  text = replaceSection(text, 'Verification', renderVerification(rows, finalGate(ordinary)));
  text = replaceStatusLine(text, `${rows.filter(isPassing).length}/${ordinary.criteria.length} SC passing`);
  // The driver owns none-ness only; an authored one-line summary is kept (lint checks none-ness alone).
  if (!hasDeviation(text)) text = replaceBoxLine(text, 'Deviations', 'none');
  else if (/^> \*\*Deviations:\*\* none\s*$/m.test(text)) throw new Error('Deviations summary required: Deviations & Follow-ups records a "- Deviation:" bullet; replace "> **Deviations:** none" with a one-line summary.');
  return text;
}
// SECTION: Durable evidence

/** Persists reconstructable ordinary evidence in the walkthrough's `.state/` sidecar and re-renders the walkthrough. */
export function persistEvidence(state) {
  if (!state.walkthroughPath || !fs.existsSync(state.walkthroughPath)) return;
  // Final review metadata covers the walkthrough body; leave it unchanged after checkpoint.
  // A passed final gate renders its evidence before the deferred code-review checkpoint is recorded.
  if (state.ordinary.checkpoint || (state.reviewState?.kind === 'code' && !(state.ordinary.step === 'final-verify' && state.ordinary.finalVerified))) return;
  const record = { schemaVersion: 1, governingHash: state.governingHash, planPath: state.planPath, ...(state.designPath ? { designPath: state.designPath, designRevision: state.designRevision ?? state.governingHash } : {}), ...(state.increment?.id ? { incrementId: state.increment.id } : {}), ledgerRunId: state.ledgerRunId ?? null, ordinary: state.ordinary };
  const text = renderValidatedEvidence(state, fs.readFileSync(state.walkthroughPath, 'utf8'));
  writeAtomic(evidenceFile(state.walkthroughPath), `${JSON.stringify(storeSessionPaths(record))}\n`);
  fs.writeFileSync(state.walkthroughPath, text);
}
function writeAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, contents);
  try { safeRenameSync(temp, file); } finally { fs.rmSync(temp, { force: true }); }
}
export function restoreEvidence(state) {
  if (!state.walkthroughPath || !fs.existsSync(state.walkthroughPath)) return false;
  const sidecar = evidenceFile(state.walkthroughPath);
  if (!fs.existsSync(sidecar)) return false;
  const record = restoreSessionPaths(JSON.parse(fs.readFileSync(sidecar, 'utf8')));
  const planMatches = typeof record.planPath === 'string' && path.resolve(state.repoRoot, record.planPath) === path.resolve(state.planPath);
  // Ordinary evidence from a finished or never-approved run of an earlier plan revision has no authority over a restart.
  const ordinaryRecord = !state.designPath && !record.designPath && !record.incrementId;
  if (ordinaryRecord && record.schemaVersion === 1 && record.governingHash !== state.governingHash && planMatches && !liveSegment(state, record.ledgerRunId)) return false;
  if (record.schemaVersion !== 1 || record.governingHash !== state.governingHash || !planMatches) throw new Error('Walkthrough evidence does not bind this governing plan.');
  if (state.designPath) {
    if (typeof record.designPath !== 'string' || path.resolve(state.repoRoot, record.designPath) !== path.resolve(state.designPath) || record.designRevision !== state.designRevision && record.designRevision !== state.governingHash) throw new Error('Walkthrough evidence does not bind this parent design identity.');
    if (state.increment?.id && record.incrementId !== state.increment.id) throw new Error('Walkthrough evidence increment ID does not bind the selected increment.');
    if (!state.increment?.id && record.incrementId && !/^I\d{2}$/.test(record.incrementId)) throw new Error('Walkthrough evidence increment ID is invalid.');
  } else if (record.designPath || record.designRevision) throw new Error('Walkthrough evidence contains an unbound parent design identity.');
  if (!state.increment?.id && /\.design\.md$/.test(state.planPath) && record.incrementId) {
    const graphIds = new Set(parseIncrementGraph(fs.readFileSync(state.planPath, 'utf8')).increments.map(item => item.id));
    if (!graphIds.has(record.incrementId)) throw new Error('Walkthrough evidence increment ID does not bind a known design increment.');
  }
  state.ordinary = record.ordinary;
  state.ledgerRunId = record.ledgerRunId;
  const segment = ledgerSegment(state) ?? ledgerSegment(state, { terminal: true });
  if (state.ledgerRunId && segment?.runId !== state.ledgerRunId) throw new Error('Canonical ledger segment does not match walkthrough evidence.');
  if (segment?.approved) {
    state.ledgerRunId = segment.runId;
    if (segment.approval?.level && state.invocation?.levelSource !== 'explicit') {
      state.invocation = { ...state.invocation, level: segment.approval.level, levelSource: 'classified' };
    }
  }
  if (segment?.tasks.size && state.ordinary.step === 'approval') throw new Error('Ledger has dispatched work not present in walkthrough evidence; reconcile before continuing.');
  if (segment && !segment.terminal) {
    // resumeOrdinary only selects ordinary segments; increment segments were matched above.
    /** @type {Record<string, any>} */
    const resumed = state.designPath ? { nextAction: segment.rulings.get('failure-disposition')?.state === 'open' ? 'failure-disposition' : null }
      : resumeOrdinary({ ledgerPath: state.ledgerPath, planPath: relative(state, state.planPath), planSource: source(state), repoRoot: state.repoRoot });
    if (resumed.status && resumed.status !== 'resumable') throw new Error(resumed.diagnostic);
    if (resumed.nextAction === 'failure-disposition') {
      state.ordinary.failure = JSON.parse(segment.rulings.get('failure-disposition').reason);
      state.ordinary.phase = 'implementation';
      state.ordinary.step = 'failure-disposition';
    }
    const task = segment.tasks.get('implementation');
    if (task?.lastAttempt && state.ordinary.step === 'write-pending' && task.lastAttempt.data.attempt === state.ordinary.attempt && task.lastAttempt.data.launch === state.ordinary.launch) {
      const attempt = task.lastAttempt.data;
      state.ordinary.envelope = attempt.terminalEnvelope;
      if (attempt.transition === 'run-red') state.ordinary.step = 'red-verify';
      else if (attempt.transition === 'verify') state.ordinary.step = 'completion-verify';
      else throw new Error('Interrupted outcome requires explicit transition reconciliation before another write.');
    }
  }
  return true;
}
function liveSegment(state, runId) {
  if (!runId) return null;
  const read = readLedger(state.ledgerPath);
  if (read.status === 'missing') return null;
  if (read.status !== 'ok') throw new Error(read.diagnostic);
  return foldSegments(read.events).find(segment => segment.runId === runId && !segment.terminal) ?? null;
}
export function save(state, action) {
  const durable = state.pending;
  state.pending = action;
  try {
    try {
      persistEvidence(state);
    } catch (error) {
      // A refusal is often about the walkthrough itself, so evidence it cannot hold must not block recording it.
      if (action.action !== 'done' || action.outcome === 'complete') throw error;
    }
    // The state layer performs terminal chat-folder movement after this action is ready to persist.
    return persistAction(state, action);
  } catch (error) {
    // Error replies re-emit state.pending, so it must stay the action the state file holds.
    state.pending = durable;
    throw error;
  }
}
export function refuse(state, reason, nextAction = null) {
  return emitAction(state, 'done', { outcome: 'refused', summary: reason, reason, command: state.resumeCommand, ...(nextAction ? { nextAction } : {}) });
}
export function ask(state, question, text, items = []) {
  return emitAction(state, 'ask-user', { question, text, items }, ['Relay the typed decision to the user; reply {"answer": <the shape the text names>}.']);
}
