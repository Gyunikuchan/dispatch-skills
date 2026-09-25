// @ts-check

/** Walkthrough `## Outcome Traceability` table grammar shared by the driver, review preparation, and lint. */

export const TRACEABILITY_HEADER = Object.freeze(['SC', 'Behavior', 'Production path', 'Evidence']);
export const PLANLESS = 'None — no governing plan.';
export const DEFERRED = 'Deferred to final gate';

/** @typedef {{ id: string, behavior: string, path: string, evidence: string }} TraceRow */

// SECTION: Rendering

/**
 * Escapes `|` and collapses whitespace runs so a value fits one table cell.
 * @param {unknown} value
 */
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
    ...rows.map(row => `| ${[row.id, row.behavior, row.path, row.evidence].map(cell).join(' | ')} |`),
  ].join('\n');
}

// SECTION: Parsing

/** @param {string} line */
const split = line => line.trim().split(/(?<!\\)\|/).slice(1, -1).map(value => value.trim());

/**
 * Parses the section body: at most one intro line, header, separator, then rows; or the plan-less line.
 * @param {string[]} sectionLines
 * @returns {{ table: true, rows: TraceRow[] } | { planless: true } | { error: string }}
 */
export function parseTraceability(sectionLines) {
  const lines = sectionLines.map(line => line.trim()).filter(Boolean);
  if (lines.length === 1 && lines[0] === PLANLESS) return { planless: true };
  const start = lines[0] && !lines[0].startsWith('|') ? 1 : 0;
  const [header, separator, ...rest] = lines.slice(start);
  if (!header?.startsWith('|') || split(header).join('|') !== TRACEABILITY_HEADER.join('|')) return { error: 'Outcome Traceability requires the | SC | Behavior | Production path | Evidence | table after at most one intro line.' };
  if (!separator || split(separator).length !== 4 || !split(separator).every(value => /^:?-{3,}:?$/.test(value))) return { error: 'Outcome Traceability table requires a separator row.' };
  /** @type {TraceRow[]} */
  const rows = [];
  for (const line of rest) {
    const cells = line.startsWith('|') && line.endsWith('|') ? split(line) : [];
    if (cells.length !== 4) return { error: `Outcome Traceability row must have four cells: ${line}` };
    const [id, behavior, file, evidence] = cells;
    rows.push({ id, behavior, path: file, evidence });
  }
  return { table: true, rows };
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
 * True unless the Evidence cell is pending, deferred, or missing validated evidence.
 * @param {TraceRow} row
 */
export function isPassing(row) {
  return !/^Pending\b|^Deferred to final gate\b|\bmissing validated\b/i.test(row.evidence);
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
