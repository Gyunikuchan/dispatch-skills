import fs from 'node:fs';
import path from 'node:path';
import { appendEvent, governingHash, readLedger, resumeOrdinary, slugFromPlanPath } from '../ledger.mjs';
import { foldSegments } from '../ledger-events.mjs';
import { resolveLedgerPath } from '../resolve-artifact-paths.mjs';
import { emitAction } from './actions.mjs';
import { writeRunState } from './state.mjs';

const MARKER = /\n## Ordinary execution evidence\n```json\n([\s\S]*?)\n```\n?/;
export const relative = (state, file) => path.relative(state.repoRoot, file).split(path.sep).join('/');
export const source = state => fs.readFileSync(state.planPath, 'utf8');
export function bindPlan(state, file) {
  state.planPath = path.resolve(state.repoRoot, file);
  if (/-design\.md$/.test(state.planPath)) throw new Error('I05: design execution is not available.');
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
  const segments = foldSegments(read.events).filter(segment => segment.runStart.governingPath === relative(state, state.planPath) && segment.governingHash === state.governingHash);
  return segments.findLast(segment => terminal || !segment.terminal) ?? null;
}
export function append(state, type, data) {
  assertBinding(state);
  const event = { v: 1, type, runId: state.ledgerRunId, at: new Date().toISOString(), data };
  // Validate the prospective fold before the locked canonical append; appendEvent owns sequence allocation.
  const read = readLedger(state.ledgerPath);
  const folded = foldSegments(read.events);
  if (type === 'run-start' && folded.some(segment => !segment.terminal && segment.governingHash === state.governingHash && segment.runId !== state.ledgerRunId)) throw new Error('An ordinary run already owns this governing revision; reconstruct it before approval.');
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
function renderValidatedEvidence(text, ordinary) {
  if (!ordinary?.implementationComplete || !ordinary.completionResults) return text;
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
  text = text.replace(/## Outcome Traceability\n[\s\S]*?\n## Key Deviations/, `## Outcome Traceability\n${trace.join('\n')}\n\n## Key Deviations`);
  text = text.replace(/## Verification & Validation\n[\s\S]*?\n## Outcome Traceability/, `## Verification & Validation\n### Manual Verification\n${manual.length ? manual.join('\n') : '- RED evidence captured by mapped host verification.'}\n\n## Outcome Traceability`);
  return text;
}
export function persistEvidence(state) {
  if (!state.walkthroughPath || !fs.existsSync(state.walkthroughPath)) return;
  // Final review metadata covers the walkthrough body; leave it unchanged after checkpoint.
  if (state.ordinary.checkpoint || state.reviewState?.kind === 'code' || state.riskState) return;
  const record = { schemaVersion: 1, governingHash: state.governingHash, planPath: relative(state, state.planPath), ledgerRunId: state.ledgerRunId ?? null, ordinary: state.ordinary };
  const block = `\n## Ordinary execution evidence\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\`\n`;
  const text = renderValidatedEvidence(fs.readFileSync(state.walkthroughPath, 'utf8'), state.ordinary);
  fs.writeFileSync(state.walkthroughPath, MARKER.test(text) ? text.replace(MARKER, () => block) : text + block);
}
export function restoreEvidence(state) {
  if (!fs.existsSync(state.walkthroughPath)) return false;
  const match = MARKER.exec(fs.readFileSync(state.walkthroughPath, 'utf8'));
  if (!match) return false;
  const record = JSON.parse(match[1]);
  if (record.schemaVersion !== 1 || record.governingHash !== state.governingHash || record.planPath !== relative(state, state.planPath)) throw new Error('Walkthrough evidence does not bind this governing plan.');
  state.ordinary = record.ordinary;
  state.ledgerRunId = record.ledgerRunId;
  const segment = ledgerSegment(state) ?? ledgerSegment(state, { terminal: true });
  if (state.ledgerRunId && segment?.runId !== state.ledgerRunId) throw new Error('Canonical ledger segment does not match walkthrough evidence.');
  if (segment?.approved) state.ledgerRunId = segment.runId;
  if (segment?.tasks.size && state.ordinary.step === 'approval') throw new Error('Ledger has dispatched work not present in walkthrough evidence; reconcile before continuing.');
  if (segment && !segment.terminal) {
    const resumed = resumeOrdinary({ ledgerPath: state.ledgerPath, planPath: relative(state, state.planPath), planSource: source(state), repoRoot: state.repoRoot });
    if (resumed.status !== 'resumable') throw new Error(resumed.diagnostic);
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
export function save(state, action) {
  state.pending = action;
  persistEvidence(state);
  writeRunState(state);
  return action;
}
export function refuse(state, reason) {
  return emitAction(state, 'done', { outcome: 'refused', summary: reason, reason, command: state.resumeCommand });
}
export function ask(state, question, text, items = []) {
  return emitAction(state, 'ask-user', { question, text, items }, ['Relay the typed decision to the user and return its exact keyed answer.']);
}
