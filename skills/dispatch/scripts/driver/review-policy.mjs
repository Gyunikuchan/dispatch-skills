// @ts-check
import { LEVELS, policyPhase, resolveLevelScalar } from '../lib/config.mjs';
import { resolveExplicitRange } from '../review/range.mjs';
import { gitRoot } from './state.mjs';

// SECTION: Public review policy

/**
 * Infers the standalone review kind and target from an artifact path or Git revision.
 *
 * @param {string | null | undefined} argument
 * @param {{ cwd?: string }} [options]
 * @returns {{ kind: 'design' | 'plan', artifactPath: string } | { kind: 'code', range: string | null } | { kind: 'code', walkthroughPath: string }}
 */
export function inferReviewKind(argument, { cwd = process.cwd() } = {}) {
  if (!argument) return { kind: 'code', range: null };
  const normalized = String(argument).replace(/\\/g, '/');
  if (/\.design\.md$/i.test(normalized)) return { kind: 'design', artifactPath: argument };
  if (/\.walkthrough\.md$/i.test(normalized)) return { kind: 'code', walkthroughPath: argument };
  if (/\.md$/i.test(normalized)) return { kind: 'plan', artifactPath: argument };
  try {
    resolveExplicitRange(gitRoot(cwd), argument);
    return { kind: 'code', range: argument };
  } catch {
    throw new Error(
      `Cannot review "${argument}": pass a design (*.design.md), plan (*.md), or walkthrough (*.walkthrough.md) path, ` +
      'a Git revision or range, or no argument for uncommitted changes.',
    );
  }
}

/**
 * Resolves the effective review level without demoting classified/default levels.
 *
 * @param {{ config: Record<string, any>, kind: string, level?: string, levelSource?: string, pins?: string | null }} options
 */
export function resolveReviewLevel({ config, kind, level = 'medium', levelSource = 'default', pins = null }) {
  const phase = `${kind}-review`;
  const policyKey = policyPhase(phase);
  const policy = config?.phases?.[policyKey];
  const base = { level, levelSource, skipped: null, phase, policyKey, configured: true };
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return { ...base, configured: false };
  const enabled = LEVELS.filter((candidate) => phaseEnabled(policy, candidate, pins));
  if (enabled.length === 0) {
    return { ...base, skipped: { reason: `phases['${policyKey}'] disables ${phase} at every level (rounds or targets is 0).` } };
  }
  if (!phaseEnabled(policy, level, pins)) {
    return {
      ...base,
      skipped: {
        reason: `${phase} is disabled at ${levelSource === 'explicit' ? 'explicit level' : 'level'} "${level}" by phases['${policyKey}'] (rounds or targets is 0).`,
      },
    };
  }
  return base;
}

// SECTION: Policy predicates

function phaseEnabled(policy, level, pins = null) {
  const rounds = resolveLevelScalar(policy.rounds, level) ?? 0;
  if (rounds <= 0) return false;
  if (pins) return true;
  const targets = resolveLevelScalar(policy.targets, level);
  return targets !== 0;
}
