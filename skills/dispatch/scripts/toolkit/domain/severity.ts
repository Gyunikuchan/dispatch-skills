import { isRecord } from "../../lib/config.ts";
import type { Impact, Severity, Trigger } from "./types.ts";

export const IMPACTS = ["critical", "blocks", "degrades", "minor"] as const;
export const TRIGGERS = ["realistic", "contrived"] as const;

const TABLE: Readonly<Record<Impact, Readonly<Record<Trigger, Severity>>>> = {
  critical: { realistic: "MUST", contrived: "MUST" },
  blocks: { realistic: "MUST", contrived: "SHOULD" },
  degrades: { realistic: "SHOULD", contrived: "CONSIDER" },
  minor: { realistic: "CONSIDER", contrived: "CONSIDER" },
};

export const RANK: Readonly<Record<Severity, number>> = {
  MUST: 2,
  SHOULD: 1,
  CONSIDER: 0,
};

export const severityOf = (impact: Impact, trigger: Trigger) =>
  TABLE[impact][trigger];

interface Ruling {
  data: unknown;
}

const isImpact = (value: unknown): value is Impact =>
  IMPACTS.some((impact) => impact === value);

const isTrigger = (value: unknown): value is Trigger =>
  TRIGGERS.some((trigger) => trigger === value);

const latestCorrection = (rulings: readonly Ruling[]) =>
  rulings
    .flatMap(({ data }) =>
      isRecord(data) && isImpact(data["impact"]) && isTrigger(data["trigger"])
        ? [{ impact: data["impact"], trigger: data["trigger"] }]
        : []
    )
    .at(-1);

/** `rulings` holds the finding's rulings in ledger order; a later ruling without values leaves a correction in force. */
export const effectiveSeverity = (
  finding: { severity: Severity },
  rulings: readonly Ruling[]
) => {
  const correction = latestCorrection(rulings);

  if (!correction) {
    return finding.severity;
  }

  const corrected = severityOf(correction.impact, correction.trigger);

  const decision = rulings.findLast(
    ({ data }) =>
      isRecord(data) &&
      (data["ruling"] === "accepted" || data["ruling"] === "rejected")
  )?.data;

  if (isRecord(decision) && decision["ruling"] === "rejected") {
    return RANK[corrected] > RANK[finding.severity]
      ? corrected
      : finding.severity;
  }

  return corrected;
};

export const currentRating = (
  finding: { impact?: Impact; trigger?: Trigger },
  rulings: readonly Ruling[]
) => {
  const correction = latestCorrection(rulings);

  if (correction) {
    return correction;
  }

  return {
    ...(!(finding.impact === undefined) && { impact: finding.impact }),
    ...(!(finding.trigger === undefined) && { trigger: finding.trigger }),
  };
};
