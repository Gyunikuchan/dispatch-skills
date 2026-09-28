// @ts-check
import { isFillerNote, normalizeNote } from '../lib/filler.mjs';

/** Walkthrough `## Verification` table and `## Changes Made` grammar shared by the driver, review preparation, and lint. */

export const TRACEABILITY_HEADER = Object.freeze(['SC', 'Outcome', 'Evidence']);
export const FINAL_GATE = 'Final gate:';
export const DEFERRED = 'Deferred to final gate';

/** @typedef {{ id: string, behavior: string, evidence: string }} TraceRow */
/** @typedef {{ tag: string, path: string, note: string }} ChangeEntry */

// SECTION: Rendering

/**
 * Escapes `|` and collapses whitespace runs so a value fits one table cell.
 * @param {unknown} value
 */
/** Collapses whitespace for single-line prose such as bullets and summary-box values. */
export const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim();
export const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/**
 * Renders header, separator, and rows; cells are escaped here.
 * @param {TraceRow[]} rows
 * @returns {string}
 */
export function renderTraceability(rows) {
  return [
    `| ${TRACEABILITY_HEADER.join(' | ')} |`,
    `| ${TRACEABILITY_HEADER.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${[row.id, row.behavior, row.evidence].map(cell).join(' | ')} |`),
  ].join('\n');
}

/**
 * Renders the `## Verification` body: the criterion table (omitted plan-less) and the final-gate line.
 * @param {TraceRow[] | null} rows
 * @param {string} finalGate
 */
export function renderVerification(rows, finalGate) {
  return [...(rows ? [renderTraceability(rows), ''] : []), `${FINAL_GATE} ${finalGate}`].join('\n');
}

/**
 * Renders `## Changes Made` bullets as `- **[TAG]** \`path\` — note`.
 * @param {ChangeEntry[]} entries
 */
export function renderChangesMade(entries) {
  return entries.map(({ tag, path, note }) => `- **[${tag}]** \`${path}\` — ${oneLine(note)}`).join('\n');
}

/**
 * Builds Changes Made entries for every changed path. Note precedence: the writer's `files[].note`,
 * then the plan's Proposed Changes note, then the `+N −M` line delta.
 * @param {{ paths: string[], stats: Map<string, { tag: string, added: number, removed: number }>, files?: Array<{ path: string, note: string }>, planNotes?: Map<string, { tag: string, note: string }> }} input
 * @returns {ChangeEntry[]}
 */
export function changeEntries({ paths, stats, files = [], planNotes = new Map() }) {
  // Filler writer notes fall through to the plan note or line delta; walkthrough lint would reject them.
  const written = new Map(files.filter(item => !isFillerNote(item.note)).map(item => [item.path, item.note]));
  const planned = [...planNotes.entries()];
  // Writer and plan notes are deduplicated only within their own source; a cross-source repeat would fail walkthrough lint.
  const used = new Set();
  return paths.map(file => {
    const stat = stats.get(file);
    const plan = planNotes.get(file);
    const planNote = plan?.note && !isFillerNote(plan.note, planned.filter(([other]) => other !== file).map(([, item]) => item.note)) ? plan.note : '';
    const note = [written.get(file), planNote].find(value => value && !used.has(normalizeNote(value))) || `+${stat?.added ?? 0} −${stat?.removed ?? 0}`;
    used.add(normalizeNote(note));
    return { tag: stat?.tag ?? plan?.tag ?? 'MODIFY', path: file, note };
  });
}

// SECTION: Parsing

/** @param {string} line */
const split = line => line.trim().split(/(?<!\\)\|/).slice(1, -1).map(value => value.trim());

/**
 * Parses `## Changes Made` bullets; other lines are ignored.
 * @param {string[]} sectionLines
 * @returns {Array<ChangeEntry & { index: number }>}
 */
export function parseChangesMade(sectionLines) {
  return sectionLines.flatMap((line, index) => {
    const match = /^- \*\*\[([A-Z]+)\]\*\* `([^`]+)`(?: — (.*))?$/.exec(line.trim());
    return match ? [{ tag: match[1], path: match[2], note: (match[3] ?? '').trim(), index }] : [];
  });
}

/**
 * Parses the `## Verification` body: the criterion table then one trailing `Final gate:` line,
 * or the final-gate line alone for a plan-less walkthrough.
 * @param {string[]} sectionLines
 * @returns {{ table: true, rows: TraceRow[], finalGate: string | null } | { planless: true, finalGate: string } | { error: string }}
 */
export function parseTraceability(sectionLines) {
  const lines = sectionLines.map(line => line.trim()).filter(Boolean);
  const gates = lines.filter(line => line.startsWith(FINAL_GATE));
  if (gates.length > 1 || (gates.length && lines.at(-1) !== gates[0])) return { error: `Verification allows one trailing "${FINAL_GATE}" line.` };
  const finalGate = gates.length ? gates[0].slice(FINAL_GATE.length).trim() : null;
  const table = gates.length ? lines.slice(0, -1) : lines;
  if (!table.length && finalGate !== null) return { planless: true, finalGate };
  const [header, separator, ...rest] = table;
  if (!header?.startsWith('|') || split(header).join('|') !== TRACEABILITY_HEADER.join('|')) return { error: `Verification requires the | ${TRACEABILITY_HEADER.join(' | ')} | table, or only a "${FINAL_GATE}" line without a plan.` };
  if (!separator || split(separator).length !== 3 || !split(separator).every(value => /^:?-{3,}:?$/.test(value))) return { error: 'Verification table requires a separator row.' };
  /** @type {TraceRow[]} */
  const rows = [];
  for (const line of rest) {
    const cells = line.startsWith('|') && line.endsWith('|') ? split(line) : [];
    if (cells.length !== 3) return { error: `Verification row must have three cells: ${line}` };
    const [id, behavior, evidence] = cells;
    rows.push({ id, behavior, evidence });
  }
  return { table: true, rows, finalGate };
}

/**
 * Returns the body lines of `## <heading>` in raw source, or null when absent.
 * @param {string} source
 * @param {string} heading
 */
export function sectionBody(source, heading) {
  const lines = String(source).split(/\r?\n/);
  const start = lines.findIndex(line => line.trimEnd() === `## ${heading}`);
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

/**
 * Replaces the body of `## <heading>` up to the next `##`; throws when the heading is absent.
 * @param {string} source
 * @param {string} heading
 * @param {string} body
 */
export function replaceSection(source, heading, body) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex(line => line.trimEnd() === `## ${heading}`);
  if (start === -1) throw new Error(`Walkthrough requires a ## ${heading} section.`);
  const next = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  const end = next === -1 ? lines.length : next;
  const tail = next === -1 ? [] : [''];
  return [...lines.slice(0, start + 1), ...body.split('\n'), ...tail, ...lines.slice(end)].join(eol);
}

/**
 * True unless the Evidence cell is pending, deferred, or missing validated evidence.
 * @param {TraceRow} row
 */
export function isPassing(row) {
  return !/^Pending\b|^Deferred to final gate\b|\bmissing validated\b/i.test(row.evidence);
}

/**
 * Reports `- Deviation:` bullets in `## Deviations & Follow-ups`.
 * @param {string} source
 */
export function hasDeviation(source) {
  return (sectionBody(source, 'Deviations & Follow-ups') ?? []).some(line => /^-\s+Deviation:/.test(line.trim()));
}

// SECTION: Box rewriting

/**
 * Replaces exactly one `> **<label>:**` line in the leading blockquote; throws on zero or multiple.
 * @param {string} source
 * @param {string} label
 * @param {string} value
 */
export function replaceBoxLine(source, label, value) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const h1 = lines.findIndex(line => /^#\s+\S/.test(line));
  let start = h1 + 1;
  while (start < lines.length && !lines[start].trim()) start += 1;
  const matches = [];
  for (let index = start; h1 !== -1 && index < lines.length && lines[index].startsWith('>'); index += 1) {
    if (lines[index].startsWith(`> **${label}:**`)) matches.push(index);
  }
  if (matches.length !== 1) throw new Error(`Walkthrough summary box requires exactly one > **${label}:** line; found ${matches.length}.`);
  lines[matches[0]] = `> **${label}:** ${value}`;
  return lines.join(eol);
}

/**
 * Replaces the single `> **Status:**` line in the leading blockquote.
 * @param {string} source
 * @param {string} status
 */
export const replaceStatusLine = (source, status) => replaceBoxLine(source, 'Status', status);
