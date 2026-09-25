// @ts-check
import { bodyLines, boxValue, findPlaceholders, lintSummaryBox } from '../lib/summary-box.mjs';
import { isPassing, parseTraceability, sectionBody } from './traceability.mjs';

const LABELS = ['TL;DR', 'Status', 'Deviations'];
// Minimum walkthrough contract order (references/review.md); other sections may sit between them.
const SECTIONS = ['Changes Made', 'Verification & Validation', 'Outcome Traceability', 'Key Deviations', 'Review Findings & Resolutions', 'Follow-ups'];

/** @typedef {{ rule: string, locus: string, message: string }} WalkthroughDiagnostic */

/**
 * Lints walkthrough structure; with `criteria`, traceability rows must equal the criterion IDs in order.
 * @param {string} source
 * @param {{ criteria?: Array<{ id: string }> }} [options]
 * @returns {{ defects: WalkthroughDiagnostic[], warnings: WalkthroughDiagnostic[] }}
 */
export function lintWalkthrough(source, { criteria } = {}) {
  /** @type {WalkthroughDiagnostic[]} */
  const defects = [];
  const defect = (rule, message, line = null) => defects.push({ rule, locus: line ? `line ${line}` : 'walkthrough', message });
  for (const item of lintSummaryBox(source, LABELS)) defect(item.rule, item.message, item.line);
  lintSections(source, defect);

  const body = sectionBody(source, 'Outcome Traceability');
  const trace = body ? parseTraceability(body) : null;
  if (trace && 'error' in trace) defect('traceability-not-table', trace.error);
  const rows = trace && 'table' in trace ? trace.rows : null;
  if (rows && criteria && rows.map(row => row.id).join(',') !== criteria.map(item => item.id).join(',')) {
    defect('traceability-rows', `Traceability rows ${rows.map(row => row.id).join(', ') || 'none'} must equal plan criteria ${criteria.map(item => item.id).join(', ')} in order.`);
  }
  if (trace && 'planless' in trace && criteria?.length) defect('traceability-rows', 'A walkthrough with a governing plan requires one traceability row per criterion.');

  const status = boxValue(source, 'Status');
  if (status && trace && !('error' in trace)) {
    const expected = rows ? `${rows.filter(isPassing).length}/${criteria ? criteria.length : rows.length} SC passing` : 'n/a';
    if (status !== expected) defect('status-mismatch', `Status "${status}" must be "${expected}".`);
  }

  const deviations = boxValue(source, 'Deviations');
  const key = sectionBody(source, 'Key Deviations');
  if (deviations && key) {
    const none = key.map(line => line.trim()).filter(Boolean).join('\n') === 'None.';
    if (none !== (deviations === 'none')) defect('deviations-mismatch', 'Deviations must be "none" exactly when Key Deviations is "None.".');
  }

  for (const { token, line } of findPlaceholders(source)) defect('leftover-placeholder', `Leftover template placeholder ${token}.`, line);
  return { defects, warnings: [] };
}

function lintSections(source, defect) {
  let fence = null;
  // Fenced lines (evidence JSON, shell comments) never count as headings.
  const lines = bodyLines(source).lines.map(line => {
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opener && !fence) { fence = opener[1]; return ''; }
    if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length) { fence = null; return ''; }
    return fence ? '' : line;
  });
  const h1 = lines.filter(line => /^#\s+\S/.test(line)).length;
  if (h1 !== 1) defect('section-order', `Walkthrough requires exactly one H1; found ${h1}.`);
  const positions = SECTIONS.map(heading => lines.filter(line => line.trimEnd() === `## ${heading}`).length === 1 ? lines.findIndex(line => line.trimEnd() === `## ${heading}`) : -1);
  const missing = SECTIONS.filter((_, index) => positions[index] === -1);
  if (missing.length) defect('section-order', `Walkthrough requires exactly one of each section: ${missing.join(', ')}.`);
  else if (positions.some((position, index) => index && position < positions[index - 1])) defect('section-order', `Walkthrough sections must appear in order: ${SECTIONS.join(', ')}.`);
}
