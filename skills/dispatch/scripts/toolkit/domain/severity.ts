// The one impact x trigger table that derives finding severity, shared by reply parsing and rulings.

import type { Impact, Severity, Trigger } from './types.ts';
import { isRecord } from '../../lib/config.ts';

export const IMPACTS = ['critical', 'blocks', 'degrades', 'minor'] as const;
export const TRIGGERS = ['realistic', 'contrived'] as const;

const TABLE: Readonly<Record<Impact, Readonly<Record<Trigger, Severity>>>> = {
  critical: { realistic: 'MUST', contrived: 'MUST' },
  blocks: { realistic: 'MUST', contrived: 'SHOULD' },
  degrades: { realistic: 'SHOULD', contrived: 'CONSIDER' },
  minor: { realistic: 'CONSIDER', contrived: 'CONSIDER' },
};

export const RANK: Readonly<Record<Severity, number>> = { MUST: 2, SHOULD: 1, CONSIDER: 0 };

export function severityOf(impact: Impact, trigger: Trigger): Severity {
  return TABLE[impact][trigger];
}

type Ruling = { data: unknown };

const isImpact = (value: unknown): value is Impact => IMPACTS.some((impact) => impact === value);
const isTrigger = (value: unknown): value is Trigger => TRIGGERS.some((trigger) => trigger === value);

/** The latest ruling that carries a valid corrected pair. */
function latestCorrection(rulings: ReadonlyArray<Ruling>): { impact: Impact; trigger: Trigger } | undefined {
  for (let index = rulings.length - 1; index >= 0; index--) {
    const data = rulings[index]?.data;
    if (isRecord(data) && isImpact(data['impact']) && isTrigger(data['trigger'])) {
      const { impact, trigger } = data;
      return { impact, trigger };
    }
  }
  return undefined;
}

/** `rulings` holds the finding's rulings in ledger order; a later ruling without values leaves a correction in force. */
export function effectiveSeverity(finding: { severity: Severity }, rulings: ReadonlyArray<Ruling>): Severity {
  const correction = latestCorrection(rulings);
  if (!correction) {
    return finding.severity;
  }
  const corrected = severityOf(correction.impact, correction.trigger);
  const decision = rulings.findLast(
    ({ data }) => isRecord(data) && (data['ruling'] === 'accepted' || data['ruling'] === 'rejected'),
  )?.data;
  // NOTE: a rejection uses the higher rating so a correction cannot avoid MUST rejection confirmation in either direction.
  if (isRecord(decision) && decision['ruling'] === 'rejected') {
    return RANK[corrected] > RANK[finding.severity] ? corrected : finding.severity;
  }
  return corrected;
}

export function currentRating(finding: { impact?: Impact; trigger?: Trigger }, rulings: ReadonlyArray<Ruling>) {
  const correction = latestCorrection(rulings);
  if (correction) {
    return correction;
  }
  return {
    ...(!(finding.impact === undefined) && { impact: finding.impact }),
    ...(!(finding.trigger === undefined) && { trigger: finding.trigger }),
  };
}
