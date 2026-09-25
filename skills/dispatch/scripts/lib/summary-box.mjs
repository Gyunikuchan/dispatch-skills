// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared summary-box and template-placeholder grammar for plan, design, and walkthrough lint.
 * The box is the contiguous `> **Label:** value` blockquote between the H1 and the first `##`.
 */

const TEMPLATES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'references', 'templates');
const TEMPLATE_FILES = ['design.md', 'plan.md', 'walkthrough.md'];
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const BOX_LINE = /^> \*\*([^*]+?):\*\*(?: (.*))?$/;
const TOKEN = /<[A-Za-z][^<>\n]*>/g;

/** @typedef {{ rule: string, line: number | null, message: string }} BoxDiagnostic */
/** @typedef {{ label: string | null, value: string, line: number, raw: string }} BoxEntry */

/** Value grammar shared by every artifact kind; kind-specific checks pass extra `valueRules`. */
export const BOX_VALUE_RULES = Object.freeze({
  Risk: /^(low|med|high) — \S/,
  Increments: /^[1-9]\d*$/,
  Status: /^(?:\d+\/\d+ SC passing|n\/a)$/,
});

// SECTION: Source helpers

/**
 * Splits raw source into lines, skipping optional `---` JSON frontmatter.
 * @param {string} source
 * @returns {{ lines: string[], offset: number }} lines after frontmatter and their 1-based line offset
 */
export function bodyLines(source) {
  const lines = String(source).split(/\r?\n/);
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (close !== -1) return { lines: lines.slice(close + 1), offset: close + 1 };
  }
  return { lines, offset: 0 };
}

/**
 * Returns the H1 text of raw source, or null.
 * @param {string} source
 */
export function documentTitle(source) {
  const line = bodyLines(source).lines.find(item => item.trim());
  return line && /^#\s+\S/.test(line) ? line.replace(/^#\s+/, '').trim() : null;
}

// SECTION: Summary box

/**
 * Parses the summary box on raw source: H1, one blank line, contiguous blockquote lines, then the first `##`.
 * @param {string} source
 * @returns {{ entries: BoxEntry[], trailing: string | null } | null} null when no box follows the H1
 */
export function parseSummaryBox(source) {
  const { lines, offset } = bodyLines(source);
  let index = lines.findIndex(line => line.trim());
  if (index === -1 || !/^#\s+\S/.test(lines[index])) return null;
  index += 1;
  if (lines[index]?.trim() !== '' || !lines[index + 1]?.startsWith('>')) return null;
  index += 1;
  /** @type {BoxEntry[]} */
  const entries = [];
  for (; index < lines.length && lines[index].startsWith('>'); index += 1) {
    const raw = lines[index].trimEnd();
    const match = BOX_LINE.exec(raw);
    entries.push({ label: match ? match[1] : null, value: match?.[2]?.trim() ?? '', line: index + 1 + offset, raw });
  }
  while (index < lines.length && !lines[index].trim()) index += 1;
  const next = lines[index];
  return { entries, trailing: next === undefined || /^##\s/.test(next) ? null : next };
}

/**
 * Lints the summary box against ordered labels and value rules.
 * @param {string} source
 * @param {string[]} labels
 * @param {{ valueRules?: Record<string, RegExp | ((value: string) => string | null)> }} [options]
 * @returns {BoxDiagnostic[]}
 */
export function lintSummaryBox(source, labels, { valueRules = {} } = {}) {
  const box = parseSummaryBox(source);
  if (!box) return [{ rule: 'missing-summary-box', line: null, message: `Summary box required after the H1: ${labels.map(label => `> **${label}:**`).join(', ')}.` }];
  /** @type {BoxDiagnostic[]} */
  const diagnostics = [];
  const label = (line, message) => diagnostics.push({ rule: 'summary-label', line, message });
  for (const entry of box.entries) if (!entry.label) label(entry.line, `Malformed summary line "${entry.raw}"; use > **Label:** value.`);
  const found = box.entries.filter(entry => entry.label).map(entry => entry.label);
  if (found.join('\n') !== labels.join('\n')) label(box.entries[0]?.line ?? null, `Summary labels must be exactly ${labels.join(', ')} in order; found ${found.join(', ') || 'none'}.`);
  const rules = { ...BOX_VALUE_RULES, ...valueRules };
  for (const entry of box.entries.filter(item => item.label)) {
    if (!entry.value) { label(entry.line, `Summary label ${entry.label} requires a value.`); continue; }
    const rule = rules[entry.label];
    if (rule instanceof RegExp && !rule.test(entry.value)) label(entry.line, `Summary ${entry.label} value "${entry.value}" does not match ${rule}.`);
    if (typeof rule === 'function') {
      const message = rule(entry.value);
      if (message) label(entry.line, message);
    }
  }
  if (box.trailing !== null) label(null, 'The summary box must be followed by the first ## section.');
  return diagnostics;
}

/**
 * Returns the value of one box label, or null.
 * @param {string} source
 * @param {string} label
 */
export function boxValue(source, label) {
  return parseSummaryBox(source)?.entries.find(entry => entry.label === label)?.value || null;
}

// SECTION: Template placeholders

/** @type {Set<string> | null} */
let vocabulary = null;

/**
 * Extracts the innermost angle-bracket tokens from the three templates' fenced bodies, excluding HTML comments.
 * @returns {Set<string>}
 */
export function templatePlaceholders() {
  if (vocabulary) return vocabulary;
  vocabulary = new Set();
  for (const name of TEMPLATE_FILES) {
    const text = fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf8');
    const body = /^(`{4,})markdown\s*\n([\s\S]*?)\n\1\s*$/m.exec(text)?.[2] ?? '';
    for (const token of body.replace(/<!--[\s\S]*?-->/g, '').match(TOKEN) ?? []) vocabulary.add(token);
  }
  return vocabulary;
}

/**
 * Finds template tokens in raw text, including inline code, excluding frontmatter, fenced blocks, and HTML comments.
 * @param {string} source
 * @returns {Array<{ token: string, line: number }>}
 */
export function findPlaceholders(source) {
  const tokens = templatePlaceholders();
  const { lines, offset } = bodyLines(source);
  /** @type {Array<{ token: string, line: number }>} */
  const found = [];
  let fence = null;
  let comment = false;
  lines.forEach((original, index) => {
    const opener = FENCE.exec(original);
    if (opener && !comment) {
      if (!fence) fence = opener[1];
      else if (opener[1][0] === fence[0] && opener[1].length >= fence.length) fence = null;
      return;
    }
    if (fence) return;
    let text = '';
    let rest = original;
    while (rest) {
      if (comment) {
        const close = rest.indexOf('-->');
        if (close === -1) { rest = ''; break; }
        comment = false;
        rest = rest.slice(close + 3);
        continue;
      }
      const open = rest.indexOf('<!--');
      if (open === -1) { text += rest; break; }
      text += rest.slice(0, open);
      comment = true;
      rest = rest.slice(open + 4);
    }
    for (const token of text.match(TOKEN) ?? []) if (tokens.has(token)) found.push({ token, line: index + 1 + offset });
  });
  return found;
}
