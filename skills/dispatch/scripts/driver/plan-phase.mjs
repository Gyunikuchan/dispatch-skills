// @ts-check
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateConsensus } from '../review/consensus.mjs';
import { loadDispatchConfig } from '../lib/config.mjs';
import { lintPlan } from '../plan/lint.mjs';
import { readArtifact } from '../review/preparation.mjs';
import { sanitizeSlug } from '../artifacts/resolve-paths.mjs';
import { emitAction } from './actions.mjs';
import { governingHash } from '../ledger/ledger.mjs';
import { bindPlan, persistEvidence, source } from './implement-state.mjs';
import { advanceReview, regenerateRepoHashes, startReview } from './review-phase.mjs';
import { resolveReviewLevel } from './review-policy.mjs';
import { readRunState } from './state.mjs';

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// SECTION: Plan policy and checkpoint

/** Resolves the configured review policy for a governing artifact kind. */
export function reviewPolicy(state, kind) {
  const { config } = loadDispatchConfig({ skillRoot: SKILL_ROOT });
  return resolveReviewLevel({ config, kind, level: state.invocation.level, levelSource: state.invocation.levelSource });
}
export function requireSettledPlan(state) {
  const lint = lintPlan(source(state));
  if (lint.defects.length) throw new Error(`Plan lint defects: ${lint.defects.map(item => item.message).join('; ')}`);
  const disabled = reviewPolicy(state, 'plan').skipped;
  if (disabled) return { outcome: 'skipped', reason: disabled.reason };
  const artifact = readArtifact(state.planPath, { kind: 'plan' });
  if (!artifact.metadata || artifact.metadata.contentHash !== state.governingHash || evaluateConsensus(artifact.source).exit !== 0) {
    throw new Error('Settled plan checkpoint is missing or stale; plan-review produces it.');
  }
  return { outcome: 'complete', checkpoint: artifact.metadata };
}
export function authorPlan(state) {
  state.ordinary.phase = 'plan';
  if (!state.planPath) {
    const slug = sanitizeSlug(state.invocation.argument).slice(0, 64) || 'implementation';
    state.planPath = path.join(state.repoRoot, '.scratch', 'plan', `${new Date().toISOString().slice(0, 10)}-${slug}.md`);
  }
  return emitAction(state, 'author', { path: state.planPath, template: 'plan', defects: [] }, [
    `Author the canonical plan for: ${state.invocation.argument}`,
    'Use references/templates/plan.md. Map every success criterion to approved production and test paths and exact verification commands. Reply with the canonical path; do not modify production files.',
  ]);
}
export function acceptPlan(state, reply) {
  if (path.resolve(state.repoRoot, reply.path) !== state.planPath) throw new Error('Author reply must name the requested canonical plan.');
  rebindPlan(state, reply.path);
}
export async function beginReview(state, kind) {
  state.ordinary.phase = `${kind}-review`;
  persistEvidence(state);
  // NOTE: hashes regenerate only at the final gate, so a run editing dispatch itself fails the runner's
  // integrity check here; approved paths are owned, and unowned drift fails by name before any launch.
  const integrity = kind === 'code' ? regenerateRepoHashes(state.repoRoot, state.ordinary.approvedPaths) : null;
  if (integrity) return emitAction(state, 'done', { outcome: 'failed', summary: integrity, command: state.resumeCommand });
  const action = await startReview({
    invocation: { ...state.invocation, verb: 'review', kind, fix: true, implementation: kind === 'code', phases: null, argument: ['plan', 'design'].includes(kind) ? state.planPath : state.walkthroughPath },
    cwd: state.repoRoot, resumeCommand: state.resumeCommand,
  });
  state.reviewState = readRunState(action.stateFile);
  return forwardReview(state, action);
}
// Plan and design review may only amend their governing artifact; code review uses approved paths.
const reviewsGoverningArtifact = (state) => ['plan-review', 'design-review'].includes(state.ordinary.phase);
export function continueReview(state, reply) {
  if (state.reviewState.pending.action === 'adjudicate') {
    const allowed = reviewsGoverningArtifact(state) ? [path.relative(state.repoRoot, state.planPath).split(path.sep).join('/')] : state.ordinary.approvedPaths;
    for (const item of reply.rulings) for (const file of item.fix?.affectedPaths ?? []) {
      if (!allowed.includes(file)) throw new Error(`Review fix path is outside approved scope: ${file}`);
    }
  }
  return forwardReview(state, advanceReview(state.reviewState, reply));
}
function forwardReview(state, action) {
  if (action.action === 'apply-fixes' && reviewsGoverningArtifact(state)) {
    const target = path.relative(state.repoRoot, state.planPath).split(path.sep).join('/');
    if (action.clusters.some(cluster => cluster.affectedPaths.some(file => file !== target))) throw new Error('Plan review may only amend the governing plan before approval.');
  }
  return { ...action, stateFile: state.stateFile };
}
export function finishPlanReview(state, action) {
  if (!['complete', 'skipped'].includes(action.outcome)) return false;
  rebindPlan(state, state.planPath);
  state.ordinary.planReview = requireSettledPlan(state);
  delete state.reviewState;
  return true;
}
// Design increments keep the design slug and ledger; only the approved plan revision changes.
function rebindPlan(state, file) {
  if (!state.designPath) return bindPlan(state, file);
  const hash = governingHash(source(state));
  if (hash.status !== 'ok') throw new Error(hash.diagnostic);
  state.governingHash = hash.hash;
}
