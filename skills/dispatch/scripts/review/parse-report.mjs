// @ts-check
import { parseRebuttalReport, parseReviewReport } from './report.mjs';
import { reviewKind } from './kinds.mjs';

// SECTION: Kind-aware parsing API

/** @param {string} kind @param {string} text */

export function parseReport(kind, text) {
  const entry = reviewKind(kind);
  return parseReviewReport(text, {
    kind: entry.kind,
    tags: entry.tags,
    locusPattern: entry.locusPattern,
    locusDescription: entry.locusDescription,
  });
}

/** @param {string} kind @param {string} text @param {string[]} expectedKeys */
export function parseRebuttal(kind, text, expectedKeys) {
  return parseRebuttalReport(text, { kind: reviewKind(kind).kind, expectedKeys });
}
