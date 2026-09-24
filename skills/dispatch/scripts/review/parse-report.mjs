import { parseRebuttalReport, parseReviewReport } from './report.mjs';
import { reviewKind } from './kinds.mjs';

export function parseReport(kind, text) {
  const entry = reviewKind(kind);
  return parseReviewReport(text, {
    kind: entry.kind,
    tags: entry.tags,
    locusPattern: entry.locusPattern,
    locusDescription: entry.locusDescription,
  });
}

export function parseRebuttal(kind, text, expectedKeys) {
  return parseRebuttalReport(text, { kind: reviewKind(kind).kind, expectedKeys });
}
