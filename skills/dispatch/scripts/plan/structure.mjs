// @ts-check
import path from 'node:path';

const ACTION_HEADING = /^####\s+\[(NEW|MODIFY|DELETE|GENERATED)\]\s+(.+?)\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const PROPOSED_CHANGES = /^## Proposed Changes\s*$/;

// SECTION: Public plan structure API

/**
 * Removes blockquotes, comments, and fenced content while retaining source loci.
 * @param {string} source
 * @returns {Array<{line: number, text: string, original: string, fenced?: boolean, commented?: boolean}>}
 */
export function structuralLines(source) {
  const state = { fence: /** @type {string | null} */ (null), inComment: false };
  return source.split(/\r?\n/).map((original, index) => parseStructuralLine(original, index + 1, state));
}

/**
 * Normalizes a plan path to a portable workspace-relative POSIX path.
 * @param {string} raw
 * @returns {{rawPath: string | undefined, path: string | null, rejectionReason: string | null}}
 */
export function normalizePlanPath(raw) {
  const trimmed = raw.trim();
  const quoted = /^`([^`]+)`.*$/.exec(trimmed);
  const rawPath = quoted?.[1] ?? /^\S+/.exec(trimmed)?.[0];
  if (!rawPath) return rejectedPath(rawPath, 'empty');
  if (rawPath.includes('\\')) return rejectedPath(rawPath, 'backslash');
  if (path.posix.isAbsolute(rawPath)) return rejectedPath(rawPath, 'absolute');
  if (rawPath.split('/').includes('..')) return rejectedPath(rawPath, 'parent-segment');

  const normalized = path.posix.normalize(rawPath.replace(/^\.\/+/, ''));
  if (normalized === '.' || normalized === '') return rejectedPath(rawPath, 'empty');
  return { rawPath, path: normalized, rejectionReason: null };
}

/**
 * Extracts every action heading owned by the plan's unique Proposed Changes section.
 * @param {string} source
 */
export function extractActionHeadingRecords(source) {
  const lines = structuralLines(source);
  const owners = lines.filter(({ text }) => PROPOSED_CHANGES.test(text));
  if (owners.length !== 1) return [];

  const records = [];
  for (const entry of lines.slice(lines.indexOf(owners[0]) + 1)) {
    if (/^##\s+/.test(entry.text)) break;
    const match = ACTION_HEADING.exec(entry.text);
    if (!match) continue;
    records.push({ action: match[1], ...normalizePlanPath(match[2]), line: entry.line });
  }
  return records;
}

/** @param {string} source @returns {string[]} */
export function extractApprovedPathSet(source) {
  return [...new Set(extractActionHeadingRecords(source)
    .filter(({ path: value }) => value)
    .map(({ path: value }) => /** @type {string} */ (value)))].sort();
}

/**
 * Extracts `[GENERATED]` paths and the first generator command under each heading.
 * @param {string} source
 * @returns {Array<{path: string | null, command: string | null, line: number}>}
 */
export function extractGeneratedPaths(source) {
  const lines = structuralLines(source);
  return extractActionHeadingRecords(source)
    .filter(({ action }) => action === 'GENERATED')
    .map(record => ({ ...record, command: generatedCommandAfter(lines, record.line) }))
    .map(({ path: value, command, line }) => ({ path: value, command, line }));
}

// SECTION: Structural parsing

function parseStructuralLine(original, line, state) {
  const fenceMatch = FENCE.exec(original);
  if (fenceMatch) {
    if (!state.fence) state.fence = fenceMatch[1];
    else if (fenceMatch[1][0] === state.fence[0] && fenceMatch[1].length >= state.fence.length) state.fence = null;
    return { line, text: '', original, fenced: true };
  }
  if (state.fence) return { line, text: '', original, fenced: true };

  let text = '';
  let cursor = 0;
  while (cursor < original.length) {
    if (state.inComment) {
      const close = original.indexOf('-->', cursor);
      if (close === -1) return { line, text, original, commented: true };
      state.inComment = false;
      cursor = close + 3;
      continue;
    }
    const open = original.indexOf('<!--', cursor);
    if (open === -1) {
      text += original.slice(cursor);
      break;
    }
    text += original.slice(cursor, open);
    state.inComment = true;
    cursor = open + 4;
  }
  return { line, text: /^\s*>/.test(text) ? '' : text, original };
}

function generatedCommandAfter(lines, recordLine) {
  const start = lines.findIndex(({ line }) => line === recordLine);
  for (const entry of lines.slice(start + 1)) {
    if (/^#{2,4}\s+/.test(entry.text)) break;
    const match = /^[-*+]\s+Command:\s*`([^`]+)`\s*$/.exec(entry.text.trim());
    if (match) return match[1].trim();
  }
  return null;
}

function rejectedPath(rawPath, rejectionReason) {
  return { rawPath, path: null, rejectionReason };
}
