// @ts-check
/**
 * Consensus gate for a plan or walkthrough: settled (exit 0) when `## Review Findings & Resolutions`
 * holds no `[Disputed]` or `[Rejected — pending confirmation]` line, or the section is absent; live
 * (exit 1) listing each unsettled line; invalid (exit 2) when the strict parser rejects the log.
 */

import { scanResolutionLog } from './resolution-log.mjs';

// SECTION: Consensus gate

/**
 * Runs the gate's strict scan; preparation's checkpoint-preview shares it so both agree.
 *
 * @param {string} markdown
 * @returns {{ exit: 0 | 1 | 2, unsettled: string[], unsettledItems: Record<string, unknown>[], error?: string }}
 */
export function evaluateConsensus(markdown) {
  let scan;
  try {
    // NOTE: strict so the gate never settles a log that preparation rejects.
    scan = scanResolutionLog(markdown, { strict: true });
  } catch (err) {
    return { exit: 2, unsettled: [], unsettledItems: [], error: err.message };
  }
  return {
    exit: scan.unsettled.length === 0 ? 0 : 1,
    unsettled: scan.unsettled,
    unsettledItems: scan.unsettledItems,
  };
}
