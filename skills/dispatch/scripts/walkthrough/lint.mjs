// @ts-check
import { bodyLines, boxValue, documentTitle, findPlaceholders, lintSummaryBox } from '../lib/summary-box.mjs';
import { isFillerNote } from '../lib/filler.mjs';
import { hasDeviation, isPassing, parseChangesMade, parseTraceability, sectionBody } from './traceability.mjs';

const LABELS = ['Delivered', 'Parent', 'Status', 'Deviations'];
// Minimum walkthrough contract order (references/review.md); `Context` precedes them only for a user-request parent.
const SECTIONS = ['Changes Made', 'Verification', 'Deviations & Follow-ups', 'Review Findings & Resolutions'];
const USER_REQUEST = 'user request';

/** @typedef {{ rule: string, locus: string, message: string }} WalkthroughDiagnostic */

/**
 * Lints walkthrough structure; with `criteria`, Verification rows must equal the criterion IDs in order.
 * @param {string} source
 * @param {{ criteria?: Array<{ id: string }> }} [options]
 * @returns {{ defects: WalkthroughDiagnostic[], warnings: WalkthroughDiagnostic[] }}
 */
export function lintWalkthrough(source, { criteria } = {}) {
  /** @type {WalkthroughDiagnostic[]} */
  const defects = [];
  const defect = (rule, message, line = null) => defects.push({ rule, locus: line ? `line ${line}` : 'walkthrough', message });
  for (const item of lintSummaryBox(source, LABELS)) defect(item.rule, item.message, item.line);
  const parent = boxValue(source, 'Parent');
  lintSections(source, defect, parent === USER_REQUEST);

  const delivered = boxValue(source, 'Delivered');
  const title = documentTitle(source);
  if (delivered && title && normalize(delivered) === normalize(title)) defect('title-repeats-delivered', 'The H1 names the task; Delivered must say what changed, not repeat the title.');

  const body = sectionBody(source, 'Verification');
  const trace = body ? parseTraceability(body) : null;
  if (trace && 'error' in trace) defect('traceability-not-table', trace.error);
  const rows = trace && 'table' in trace ? trace.rows : null;
  if (trace && !('error' in trace) && !trace.finalGate) defect('traceability-not-table', 'Verification requires a non-empty trailing "Final gate:" line.');
  if (rows && criteria && rows.map(row => row.id).join(',') !== criteria.map(item => item.id).join(',')) {
    defect('traceability-rows', `Verification rows ${rows.map(row => row.id).join(', ') || 'none'} must equal plan criteria ${criteria.map(item => item.id).join(', ')} in order.`);
  }
  if (trace && 'planless' in trace && criteria?.length) defect('traceability-rows', 'A walkthrough with a governing plan requires one Verification row per criterion.');

  const status = boxValue(source, 'Status');
  if (status && trace && !('error' in trace)) {
    const expected = rows ? `${rows.filter(isPassing).length}/${criteria ? criteria.length : rows.length} SC passing` : 'n/a';
    if (status !== expected) defect('status-mismatch', `Status "${status}" must be "${expected}".`);
  }

  const deviations = boxValue(source, 'Deviations');
  if (deviations && sectionBody(source, 'Deviations & Follow-ups') && hasDeviation(source) === (deviations === 'none')) {
    defect('deviations-mismatch', 'Deviations must be "none" exactly when Deviations & Follow-ups has no "- Deviation:" bullet.');
  }

  const changes = parseChangesMade(sectionBody(source, 'Changes Made') ?? []);
  changes.forEach(({ path, note }, index) => {
    const siblings = changes.filter((_, other) => other !== index).map(item => item.note);
    if (isFillerNote(note, siblings)) defect('filler-note', `Changes Made note for ${path} is filler; say what changed in this file.`);
  });

  for (const { token, line } of findPlaceholders(source)) defect('leftover-placeholder', `Leftover template placeholder ${token}.`, line);
  return { defects, warnings: [] };
}

/** @param {string} value */
const normalize = value => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function lintSections(source, defect, userRequest) {
  let fence = null;
  // Fenced lines (shell comments, examples) never count as headings.
  const lines = bodyLines(source).lines.map(line => {
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opener && !fence) { fence = opener[1]; return ''; }
    if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length) { fence = null; return ''; }
    return fence ? '' : line;
  });
  const h1 = lines.filter(line => /^#\s+\S/.test(line)).length;
  if (h1 !== 1) defect('section-order', `Walkthrough requires exactly one H1; found ${h1}.`);
  const find = heading => lines.filter(line => line.trimEnd() === `## ${heading}`).length === 1 ? lines.findIndex(line => line.trimEnd() === `## ${heading}`) : -1;
  const context = find('Context');
  const contexts = lines.filter(line => line.trimEnd() === '## Context').length;
  const hasContext = contexts > 0;
  if (contexts > 1) defect('section-order', 'Walkthrough allows at most one ## Context.');
  if (userRequest && !hasContext) defect('context-required', 'A walkthrough whose Parent is "user request" requires ## Context with the original ask.');
  if (!userRequest && hasContext) defect('context-forbidden', 'Only a walkthrough whose Parent is "user request" carries ## Context; the parent artifact holds it otherwise.');
  const positions = SECTIONS.map(find);
  const missing = SECTIONS.filter((_, index) => positions[index] === -1);
  if (missing.length) defect('section-order', `Walkthrough requires exactly one of each section: ${missing.join(', ')}.`);
  else if (positions.some((position, index) => index && position < positions[index - 1]) || (context !== -1 && context > positions[0])) {
    defect('section-order', `Walkthrough sections must appear in order: ${[...(userRequest ? ['Context'] : []), ...SECTIONS].join(', ')}.`);
  }
}
