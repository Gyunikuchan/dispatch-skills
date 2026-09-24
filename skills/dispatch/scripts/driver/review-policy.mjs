// @ts-check
import { CLASSIFIABLE_LEVELS, LEVELS, policyPhase, resolveLevelScalar } from '../lib/config.mjs';
import { resolveExplicitRange } from '../review/range.mjs';
import { gitRoot } from './state.mjs';

// SECTION: Public review policy

/**
 * Infers the standalone review kind and target from an artifact path or Git revision.
 *
 * @param {string | null | undefined} argument
 * @param {{ cwd?: string }} [options]
 * @returns {{ kind: 'code', range: string | null } | { kind: 'code', walkthroughPath: string } | { kind: 'plan' | 'design', artifactPath: string }}
 */
export function inferReviewKind(argument, { cwd = process.cwd() } = {}) {
  if (!argument) return { kind: 'code', range: null };
  const normalized = String(argument).replace(/\\/g, '/');
  if (/-design\.md$/i.test(normalized)) return { kind: 'design', artifactPath: argument };
  if (/-walkthrough\.md$/i.test(normalized)) return { kind: 'code', walkthroughPath: argument };
  if (/\.md$/i.test(normalized)) return { kind: 'plan', artifactPath: argument };
  try {
    resolveExplicitRange(gitRoot(cwd), argument);
    return { kind: 'code', range: argument };
  } catch {
    throw new Error(
      `Cannot review "${argument}": pass a plan (*.md), design (*-design.md), or walkthrough (*-walkthrough.md) path, ` +
      'a Git revision or range, or no argument for uncommitted changes.',
    );
  }
}

/**
 * Resolves the effective review level without demoting classified/default levels.
 *
 * @param {{ config: Record<string, any>, kind: string, level?: string, levelSource?: string }} options
 */
export function resolveReviewLevel({ config, kind, level = 'medium', levelSource = 'default' }) {
  const phase = `${kind}-review`;
  const policyKey = policyPhase(phase);
  const policy = config?.phases?.[policyKey];
  const base = { level, levelSource, raised: false, skipped: null, phase, policyKey, configured: true };
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return { ...base, configured: false };
  const enabled = LEVELS.filter((candidate) => phaseEnabled(policy, candidate));
  if (enabled.length === 0) {
    return { ...base, skipped: { reason: `phases['${policyKey}'] disables ${phase} at every level (rounds or targets is 0).` } };
  }
  if (enabled.includes(level)) return base;
  if (levelSource === 'explicit') {
    return { ...base, skipped: { reason: `${phase} is disabled at explicit level "${level}" by phases['${policyKey}'] (rounds or targets is 0).` } };
  }
  const index = LEVELS.indexOf(level);
  const raisedTo = enabled.find((candidate) => CLASSIFIABLE_LEVELS.includes(candidate) && LEVELS.indexOf(candidate) > index);
  if (!raisedTo) {
    const elevated = enabled.find((candidate) => !CLASSIFIABLE_LEVELS.includes(candidate) && LEVELS.indexOf(candidate) > index);
    const reason = elevated
      ? `${phase} requires explicit user selection of "${elevated}" or higher; automatic escalation stops at "high".`
      : `${phase} is disabled at "${level}" and every higher level by phases['${policyKey}'].`;
    return { ...base, skipped: { reason } };
  }
  return { ...base, level: raisedTo, raised: true };
}

// SECTION: Policy predicates

function phaseEnabled(policy, level) {
  const rounds = resolveLevelScalar(policy.rounds, level) ?? 0;
  const targets = resolveLevelScalar(policy.targets, level);
  return rounds > 0 && targets !== 0;
}
