// The one impact x trigger table that derives finding severity, shared by reply parsing and rulings.

import type { Impact, Severity, Trigger } from './types.ts';

export const IMPACTS = ['critical', 'blocks', 'degrades', 'minor'] as const;
export const TRIGGERS = ['realistic', 'contrived'] as const;

const TABLE: Readonly<Record<Impact, Readonly<Record<Trigger, Severity>>>> = {
  critical: {realistic: 'MUST', contrived: 'MUST'},
  blocks: {realistic: 'MUST', contrived: 'SHOULD'},
  degrades: {realistic: 'SHOULD', contrived: 'CONSIDER'},
  minor: {realistic: 'CONSIDER', contrived: 'CONSIDER'},
};

export const RANK: Readonly<Record<Severity, number>> = {MUST: 2, SHOULD: 1, CONSIDER: 0};

export function severityOf(impact: Impact, trigger: Trigger): Severity {
  return TABLE[impact][trigger];
}

type Ruling = {data: Record<string, any>};

const isImpact = (value: unknown): value is Impact => IMPACTS.includes(value as Impact);
const isTrigger = (value: unknown): value is Trigger => TRIGGERS.includes(value as Trigger);

/** The latest ruling that carries a valid corrected pair. */
function latestCorrection(rulings: readonly Ruling[]): {impact: Impact; trigger: Trigger} | undefined {
  for (let index = rulings.length - 1; index >= 0; index--) {
    const {impact, trigger} = rulings[index]!.data;
    if (isImpact(impact) && isTrigger(trigger)) return {impact, trigger};
  }
  return undefined;
}

/** `rulings` holds the finding's rulings in ledger order; a later ruling without values leaves a correction in force. */
export function effectiveSeverity(finding: {severity: Severity}, rulings: readonly Ruling[]): Severity {
  const correction = latestCorrection(rulings);
  if (!correction) return finding.severity;
  const corrected = severityOf(correction.impact, correction.trigger);
  const decided = [...rulings].reverse().find(ruling => ruling.data['ruling'] === 'accepted' || ruling.data['ruling'] === 'rejected');
  // NOTE: a rejection uses the higher rating so a correction cannot avoid MUST rejection confirmation in either direction.
  if (decided?.data['ruling'] === 'rejected') return RANK[corrected] > RANK[finding.severity] ? corrected : finding.severity;
  return corrected;
}

export function currentRating(finding: {impact?: Impact; trigger?: Trigger}, rulings: readonly Ruling[]): {impact?: Impact; trigger?: Trigger} {
  const correction = latestCorrection(rulings);
  if (correction) return correction;
  return {...(finding.impact === undefined ? {} : {impact: finding.impact}), ...(finding.trigger === undefined ? {} : {trigger: finding.trigger})};
}
