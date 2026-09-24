import fs from 'node:fs';
import path from 'node:path';
import { appendEvent, governingHash, readLedger, resumeOrdinary, slugFromPlanPath } from '../ledger.mjs';
import { parseIncrementGraph } from '../design-graph.mjs';
import { foldSegments } from '../ledger-events.mjs';
import { resolveLedgerPath } from '../resolve-artifact-paths.mjs';
import { emitAction } from './actions.mjs';
import { writeRunState } from './state.mjs';

const MARKER = /\n## Ordinary execution evidence\n```json\n([\s\S]*?)\n```\n?/;
export const relative = (state, file) => path.relative(state.repoRoot, file).split(path.sep).join('/');
export const source = state => fs.readFileSync(state.planPath, 'utf8');
export function bindPlan(state, file) {
  state.planPath = path.resolve(state.repoRoot, file);
  if (/-design\.md$/.test(state.planPath)) throw new Error('Design paths must be bound through resumeDesign.');
  state.slug = slugFromPlanPath(relative(state, state.planPath));
  const hash = governingHash(source(state));
  if (hash.status !== 'ok') throw new Error(hash.diagnostic);
  state.governingHash = hash.hash;
  state.walkthroughPath = state.planPath.replace(/\.md$/, '-walkthrough.md');
  state.ledgerPath = resolveLedgerPath({ slug: state.slug, slugSource: 'explicit', repositoryRoot: state.repoRoot });
}
export function assertBinding(state) {
  if (governingHash(source(state)).hash !== state.governingHash) throw new Error('Plan changed: return to plan-review and approval.');
}
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
const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
/** Readable RED gate evidence: reviewers inspect this table, not the JSON run state. */
function redMatrix(ordinary) {
  const rows = (ordinary.redValidated?.evidence ?? []).filter(item => typeof item === 'string' && item.startsWith('RED-MATRIX '))
    .map(row => /^RED-MATRIX\s+(SC\d+)\s*\|\s*([^|]+?)\s*\|\s*(.+)$/.exec(row)).filter(Boolean);
  if (!rows.length) return [];
  const observed = (ordinary.redResults ?? []).map(result => `\`${cell(result.ran ?? result.command)}\` exit ${result.exitStatus}${result.fail !== undefined ? `, ${result.fail} failing` : ''}`).join('; ');
  // A shared command's failure set repeats per criterion; print each repeated set once as a label.
  const counts = new Map();
  for (const [, , , failure] of rows) counts.set(cell(failure), (counts.get(cell(failure)) ?? 0) + 1);
  const labels = new Map([...counts].filter(([, count]) => count > 1).map(([failure], index) => [failure, `S${index + 1}`]));
  const sets = [...labels].map(([failure, label]) => `- ${label}: ${failure}`);
  return ['### RED matrix', `Host RED run: ${observed || 'not recorded'}.`, '', '| Criterion | Test | Expected failure |', '| --- | --- | --- |',
    ...rows.map(([, id, test, failure]) => `| ${id} | \`${cell(test)}\` | ${labels.has(cell(failure)) ? `see ${labels.get(cell(failure))}` : cell(failure)} |`), '',
    ...(sets.length ? ['Shared failure sets:', ...sets, ''] : [])];
}
function replaceVerification(text, lines) {
  // NOTE: a host-authored walkthrough may use CRLF; an LF-only match would silently skip the rewrite.
  return text.replace(/## Verification & Validation\r?\n[\s\S]*?\r?\n## Outcome Traceability/, () => `## Verification & Validation\n${lines.join('\n')}\n\n## Outcome Traceability`);
}
function renderValidatedEvidence(text, ordinary) {
  const matrix = ordinary ? redMatrix(ordinary) : [];
  if (!ordinary?.implementationComplete || !ordinary.completionResults) {
    return matrix.length ? replaceVerification(text, [...matrix, 'Completion evidence pending.']) : text;
  }
  const records = ordinary.completionResults.flatMap(result => result.criterionEvidence ?? []);
  const trace = ordinary.criteria.map(criterion => {
    const row = ordinary.envelope?.evidence?.find(item => typeof item === 'string' && item.startsWith(`CRITERION ${criterion.id} |`));
    const parts = row?.split('|').map(item => item.trim()) ?? [];
    const evidence = records.find(item => item.criterionId === criterion.id);
    if (!row || (criterion.evidence !== 'red' && !evidence)) return `- [${criterion.id}] Pending — missing validated ${criterion.evidence} evidence.`;
    const fresh = evidence ? `${evidence.evidenceClass}; ${evidence.reviewer}; ${evidence.scenario}; revision ${evidence.inspectedRevision}; ${evidence.observableResult}; limitations: ${evidence.limitations}` : `red; mutation epoch ${ordinary.mutationEpoch}`;
    return `- [${criterion.id}] ${parts[1]} — production path: \`${parts[2]}\`; evidence: ${fresh}.`;
  });
  const manual = records.map(item => `- [${item.criterionId}] ${item.evidenceClass}; reviewer: ${item.reviewer}; scenario: ${item.scenario}; inspected revision: ${item.inspectedRevision}; observable result: ${item.observableResult}; limitations: ${item.limitations}; mutation epoch: ${item.mutationEpoch}.`);
  text = text.replace(/## Outcome Traceability\r?\n[\s\S]*?\r?\n## Key Deviations/, () => `## Outcome Traceability\n${trace.join('\n')}\n\n## Key Deviations`);
  return replaceVerification(text, [...matrix, '### Manual Verification', manual.length ? manual.join('\n') : '- RED evidence captured by mapped host verification.']);
}
export function persistEvidence(state) {
  if (!state.walkthroughPath || !fs.existsSync(state.walkthroughPath)) return;
  // Final review metadata covers the walkthrough body; leave it unchanged after checkpoint.
  if (state.ordinary.checkpoint || state.reviewState?.kind === 'code' || state.riskState) return;
  const record = { schemaVersion: 1, governingHash: state.governingHash, planPath: relative(state, state.planPath), ...(state.designPath ? { designPath: relative(state, state.designPath), designRevision: state.designRevision ?? state.governingHash } : {}), ...(state.increment?.id ? { incrementId: state.increment.id } : {}), ledgerRunId: state.ledgerRunId ?? null, ordinary: state.ordinary };
  const block = `\n## Ordinary execution evidence\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\`\n`;
  const text = renderValidatedEvidence(fs.readFileSync(state.walkthroughPath, 'utf8'), state.ordinary);
  fs.writeFileSync(state.walkthroughPath, MARKER.test(text) ? text.replace(MARKER, () => block) : text + block);
}
export function restoreEvidence(state) {
  if (!fs.existsSync(state.walkthroughPath)) return false;
  const match = MARKER.exec(fs.readFileSync(state.walkthroughPath, 'utf8'));
  if (!match) return false;
  const record = JSON.parse(match[1]);
  // Ordinary evidence from a finished or never-approved run of an earlier plan revision has no authority over a restart.
  const ordinaryRecord = !state.designPath && !record.designPath && !record.incrementId;
  if (ordinaryRecord && record.schemaVersion === 1 && record.governingHash !== state.governingHash && record.planPath === relative(state, state.planPath) && !liveSegment(state, record.ledgerRunId)) return false;
  if (record.schemaVersion !== 1 || record.governingHash !== state.governingHash || record.planPath !== relative(state, state.planPath)) throw new Error('Walkthrough evidence does not bind this governing plan.');
  if (state.designPath) {
    if (record.designPath !== relative(state, state.designPath) || record.designRevision !== state.designRevision && record.designRevision !== state.governingHash) throw new Error('Walkthrough evidence does not bind this parent design identity.');
    if (state.increment?.id && record.incrementId !== state.increment.id) throw new Error('Walkthrough evidence increment ID does not bind the selected increment.');
    if (!state.increment?.id && record.incrementId && !/^I\d{2}$/.test(record.incrementId)) throw new Error('Walkthrough evidence increment ID is invalid.');
  } else if (record.designPath || record.designRevision) throw new Error('Walkthrough evidence contains an unbound parent design identity.');
  if (!state.increment?.id && /-design\.md$/.test(state.planPath) && record.incrementId) {
    const graphIds = new Set(parseIncrementGraph(fs.readFileSync(state.planPath, 'utf8')).increments.map(item => item.id));
    if (!graphIds.has(record.incrementId)) throw new Error('Walkthrough evidence increment ID does not bind a known design increment.');
  }
  state.ordinary = record.ordinary;
  state.ledgerRunId = record.ledgerRunId;
  const segment = ledgerSegment(state) ?? ledgerSegment(state, { terminal: true });
  if (state.ledgerRunId && segment?.runId !== state.ledgerRunId) throw new Error('Canonical ledger segment does not match walkthrough evidence.');
  if (segment?.approved) state.ledgerRunId = segment.runId;
  if (segment?.tasks.size && state.ordinary.step === 'approval') throw new Error('Ledger has dispatched work not present in walkthrough evidence; reconcile before continuing.');
  if (segment && !segment.terminal) {
    // resumeOrdinary only selects ordinary segments; increment segments were matched above.
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
  state.pending = action;
  persistEvidence(state);
  writeRunState(state);
  return action;
}
export function refuse(state, reason, nextAction = null) {
  return emitAction(state, 'done', { outcome: 'refused', summary: reason, reason, command: state.resumeCommand, ...(nextAction ? { nextAction } : {}) });
}
export function ask(state, question, text, items = []) {
  return emitAction(state, 'ask-user', { question, text, items }, ['Relay the typed decision to the user and return its exact keyed answer.']);
}
