export function accountRiskReview({ before, riskHeavy, available }) {
  if (!riskHeavy || !available) return { ...before };
  return { ...before, riskReviewDelegates: (before.riskReviewDelegates ?? 0) + 1 };
}

export function describeRiskReviewDegradation({ available }) {
  return available ? 'independent read-delegate review available' : 'independent review unavailable; orchestrator-only gate';
}
