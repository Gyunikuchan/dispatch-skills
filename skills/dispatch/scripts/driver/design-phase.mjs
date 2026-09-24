import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { governingHash, resumeDesign, designRootSlug, readLedger, appendEvent } from '../ledger/ledger.mjs';
import { parseIncrementGraph } from '../design/graph.mjs';
import { resolveLedgerPath, sanitizeSlug } from '../artifacts/resolve-paths.mjs';
import { semanticSectionHashes, writeArtifactMetadata } from '../review/preparation.mjs';
import { updateExecutionStatus } from '../design/status.mjs';
import { emitAction } from './actions.mjs';
import { beginReview, continueReview } from './plan-phase.mjs';
import { repositoryBaseline } from './verification.mjs';
import { enterPhase } from './implement-phase.mjs';
import { refuse, relative, restoreEvidence } from './implement-state.mjs';

export function designSlug(file) {
  const named = designRootSlug(file);
  if (named) return named;
  const base = path.basename(file, '.md').replace(/-design$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
  return base || 'design';
}

export function incrementPaths(state, id) {
  const date = path.basename(state.designPath).match(/^(\d{4}-\d{2}-\d{2})-/)?.[1] ?? new Date().toISOString().slice(0, 10);
  const stem = `${designSlug(state.designPath)}-${id.toLowerCase()}-driver`;
  return {
    planPath: path.join(state.repoRoot, '.scratch', 'plan', `${date}-${stem}-plan.md`),
    walkthroughPath: path.join(state.repoRoot, '.scratch', 'plan', `${date}-${stem}-walkthrough.md`),
  };
}

export function startDesign(state) {
  const argument = state.invocation.argument;
  state.designPath = argument.endsWith('-design.md')
    ? path.resolve(state.repoRoot, argument)
    : path.join(state.repoRoot, '.scratch', 'plan', `${new Date().toISOString().slice(0, 10)}-${sanitizeSlug(argument).slice(0, 64) || 'design'}-design.md`);
  state.planPath = state.designPath;
  state.ordinary.phase = 'design';
  state.ordinary.step = 'design-author';
  return emitAction(state, 'author', { path: state.designPath, template: 'design', defects: [] }, [
    `Author the canonical technical design for: ${argument}`,
    'Reply with the canonical design path; design approval stops durably at design-approved-stop.',
  ]);
}

export async function advanceDesign(state, reply) {
  if (state.reviewState) {
    const action = continueReview(state, reply);
    if (action.action !== 'done') return action;
    if (!['complete', 'skipped'].includes(action.outcome)) return action;
    delete state.reviewState;
    state.ordinary.step = 'design-approval';
    return emitAction(state, 'ask-user', { question: 'approval', text: 'Approve this settled technical design at its current revision.', items: [{ governingHash: state.governingHash }] }, ['Return an approved decision bound to the displayed governingHash.']);
  }
  if (state.ordinary.step === 'design-author') {
    if (path.resolve(state.repoRoot, reply.path) !== state.designPath) throw new Error('Author reply must name the requested canonical design.');
    const source = fs.readFileSync(state.designPath, 'utf8');
    const hash = governingHash(source, { kind: 'design' });
    if (hash.status !== 'ok') throw new Error(hash.diagnostic);
    state.governingHash = hash.hash;
    state.ledgerPath = resolveLedgerPath({ slug: designSlug(state.designPath), slugSource: 'explicit', repositoryRoot: state.repoRoot });
    return beginReview(state, 'design');
  }
  if (state.ordinary.step === 'design-approval') {
    const answer = reply.answer ?? {};
    if (answer.decision !== 'approved' || answer.governingHash !== state.governingHash) throw new Error('Design approval must bind the current governingHash.');
    const snapshot = semanticSectionHashes(fs.readFileSync(state.designPath, 'utf8'));
    const now = new Date();
    const metadata = { schemaVersion: 1, kind: 'design', slug: designSlug(state.designPath), invocationId: crypto.randomUUID(), contentHash: snapshot.contentHash, sectionHashes: snapshot.sectionHashes, reviewedAt: now.toISOString(), approvedContentHash: state.governingHash, approvedAt: now.toISOString() };
    writeArtifactMetadata(state.designPath, metadata);
    state.ledgerRunId = state.runId;
    const baseline = repositoryBaseline(state);
    appendEvent(state.ledgerPath, { v: 2, type: 'run-start', runId: state.ledgerRunId, at: now.toISOString(), data: { governingPath: relative(state, state.designPath), governingHash: state.governingHash, rootSlug: designSlug(state.designPath), action: 'design', baseline } });
    appendEvent(state.ledgerPath, { v: 2, type: 'approval', runId: state.ledgerRunId, at: now.toISOString(), data: { governingHash: state.governingHash, decision: 'approved', actor: 'user' } });
    appendEvent(state.ledgerPath, { v: 2, type: 'run-complete', runId: state.ledgerRunId, at: now.toISOString(), data: { result: 'design-approved-stop', evidenceRefs: [relative(state, state.designPath)] } });
    const graph = parseIncrementGraph(fs.readFileSync(state.designPath, 'utf8'));
    const states = Object.fromEntries(graph.increments.map((item, index) => [item.id, index === 0 ? 'ready' : 'pending']));
    const nextAction = `implement:${graph.increments[0]?.id}`;
    updateExecutionStatus({ designPath: state.designPath, states, nextAction });
    return emitAction(state, 'done', { outcome: 'complete', summary: 'Technical design approved at durable stop.', artifactPath: state.designPath, ledgerPath: state.ledgerPath, nextAction, command: state.resumeCommand });
  }
  throw new Error('Unknown design phase transition.');
}

export function resumeDesignPath(state) {
  state.designPath = path.resolve(state.repoRoot, state.invocation.argument);
  state.planPath = state.designPath;
  state.increment = null;
  const designSource = fs.readFileSync(state.designPath, 'utf8');
  const designHash = governingHash(designSource, { kind: 'design' });
  if (designHash.status !== 'ok') return refuse(state, designHash.diagnostic);
  state.governingHash = designHash.hash;
  state.ledgerPath = resolveLedgerPath({ slug: designSlug(state.designPath), slugSource: 'explicit', repositoryRoot: state.repoRoot });
  const resumed = resumeDesign({ ledgerPath: state.ledgerPath, planPath: relative(state, state.designPath), planSource: designSource, repoRoot: state.repoRoot });
  if (resumed.status !== 'resumable') {
    // Increment selection is eligible only when a valid ledger already proves an approved design stop.
    const read = readLedger(state.ledgerPath);
    if (read.status !== 'ok') return refuse(state, resumed.diagnostic ?? read.diagnostic);
    const events = read.events.filter(event => event.v === 2);
    const approvedRuns = new Set(events.filter(event => event.type === 'approval' && event.data?.decision === 'approved' && event.data?.governingHash === state.governingHash).map(event => event.runId));
    const approvedStop = events.some(event => approvedRuns.has(event.runId) && event.type === 'run-complete' && event.data?.result === 'design-approved-stop');
    if (!approvedStop) return refuse(state, resumed.diagnostic ?? 'Design approval evidence is missing.');
    const amendment = events.find(event => event.type === 'amendment' && ['proposed', 'reviewed', 'prepared'].includes(event.data?.state));
    if (amendment) return refuse(state, `Pending amendment ${amendment.data.amendmentId} must be resolved before production.`, `resolve-amendment:${amendment.data.amendmentId}`);
    const graph = parseIncrementGraph(designSource);
    const completed = new Set(events.filter(event => event.type === 'run-complete' && event.data?.result === 'complete').flatMap(event => {
      const start = events.find(candidate => candidate.type === 'run-start' && candidate.runId === event.runId && candidate.data?.action === 'increment');
      return start?.data?.increment?.id ?? event.data?.increment?.id ?? event.data?.incrementId ?? [];
    }));
    const id = graph.increments.find(item => !completed.has(item.id) && item.prerequisites.every(dep => completed.has(dep)))?.id;
    if (!id) {
      if (graph.increments.length > 0 && graph.increments.every(item => completed.has(item.id))) resumed.nextAction = 'final-integration';
      else return refuse(state, resumed.diagnostic ?? 'Design run requires reconciliation.');
    } else resumed.nextAction = `implement:${id}`;
  }
  if (resumed.nextAction?.startsWith('resolve-amendment:')) return refuse(state, `Pending amendment ${resumed.nextAction.slice(18)} must be resolved before production.`, resumed.nextAction);
  if (resumed.nextAction === 'final-integration' || resumed.nextAction === 'complete') {
    const graph = parseIncrementGraph(designSource);
    const incrementArtifacts = graph.increments.flatMap(item => { const paths = incrementPaths(state, item.id); return [paths.planPath, paths.walkthroughPath]; });
    const date = path.basename(state.designPath).match(/^(\d{4}-\d{2}-\d{2})-/)?.[1] ?? new Date().toISOString().slice(0, 10);
    const integrationWalkthrough = path.join(state.repoRoot, '.scratch', 'plan', `${date}-${designSlug(state.designPath)}-integration-walkthrough.md`);
    return emitAction(state, 'verify', { commands: [], phase: 'final-integration', nextAction: 'final-integration', incrementId: null, lifecycle: { terminalEvent: { type: 'integration', result: 'pass', beforeRelocation: true }, relocateAfterPass: [state.designPath, ...incrementArtifacts, integrationWalkthrough], retain: [state.ledgerPath] } }, ['Run fresh integration verification and scoped code review; record the integration event before exact artifact relocation.', 'Next Action: final-integration.']);
  }
  // An in-flight increment resumes by the folded run's active increment.
  const id = resumed.nextAction === 'resume-increment' ? resumed.folded?.activeIncrementId : resumed.nextAction?.match(/^implement:(I\d{2})$/)?.[1];
  if (!id) return refuse(state, `Design Next Action is not an implementable increment: ${resumed.nextAction}`);
  const from = state.invocation.phases?.slice(5);
  const paths = incrementPaths(state, id);
  state.increment = { id, ...paths, designRevision: state.governingHash };
  state.designRevision = state.governingHash;
  state.planPath = paths.planPath;
  state.walkthroughPath = paths.walkthroughPath;
  // An authored plan resumes even before baseline writes its walkthrough.
  if (fs.existsSync(paths.planPath) && from !== 'plan') {
    const planHash = governingHash(fs.readFileSync(paths.planPath, 'utf8'));
    if (planHash.status !== 'ok') return refuse(state, planHash.diagnostic);
    state.governingHash = planHash.hash;
    try {
      const restored = restoreEvidence(state);
      // The driver run adopts the bound increment segment's run identity.
      if (state.ledgerRunId) state.runId = state.ledgerRunId;
      return enterPhase(state, from ?? (restored ? state.ordinary.phase ?? 'implementation' : 'plan-review')).catch(error => refuse(state, error.message));
    } catch (error) {
      return refuse(state, error.message);
    }
  }
  if (from && from !== 'plan') return refuse(state, `${from} requires a canonical plan path; plan produces it.`);
  state.ordinary.phase = 'plan';
  return emitAction(state, 'author', { path: paths.planPath, planPath: paths.planPath, walkthroughPath: paths.walkthroughPath, incrementId: id, template: 'plan', defects: [] }, [
    `Author the canonical plan for ledger-selected ${id}; caller selection is ignored.`,
    `Parent design revision: ${state.governingHash}. Next Action is implement:${id}.`,
  ]);
}
