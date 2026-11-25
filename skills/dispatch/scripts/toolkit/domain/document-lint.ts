import { isDetailWrapper, structuralLines, type StructuralLine } from './markdown-structure.ts';

export const RESOLUTION_TITLE = 'Review Findings & Resolutions';
export const EXECUTION_STATUS_TITLE = 'Execution Status';
export const RESOLUTION_HEADING = `## ${RESOLUTION_TITLE}`;
export const EXECUTION_STATUS_HEADING = `## ${EXECUTION_STATUS_TITLE}`;
export const SPEC_PIN_VALUE = /^`([^`\s]+\.spec\.md)` · sha256:([0-9a-f]{64})$/;

// SECTION: Lint severity

const LINT_SEVERITIES = {
  'missing-success-criteria': 'defect',
  'proposed-changes': 'defect',
  'change-heading': 'defect',
  'unknown-change-marker': 'defect',
  'invalid-change-path': 'defect',
  'duplicate-change-path': 'defect',
  'verification-plan': 'defect',
  'automated-tests': 'defect',
  'automated-tests-owner': 'defect',
  'automated-command': 'defect',
  'success-criteria': 'defect',
  'criterion-format': 'defect',
  'criterion-id': 'defect',
  'criterion-mapping': 'defect',
  'criterion-change-path': 'defect',
  'criterion-check': 'defect',
  'criterion-evidence': 'defect',
  'duplicate-id': 'defect',
  'task-heading': 'defect',
  'task-ownership': 'defect',
  'task-criteria': 'defect',
  'criterion-task-changes': 'defect',
  'task-map': 'defect',
  'long-paragraph': 'warning',
  'placeholder': 'warning',
  'ambiguous-command': 'warning',
  'automated-tests-unavailable': 'warning',
  'unsatisfied-requirement': 'warning',
  'criterion-red-test-path': 'warning',
  'overlap': 'warning',
  'missing-seams': 'warning',
  'red-downgraded': 'warning',
  'undeclared-test-path': 'warning',
  'missing-summary-box': 'warning',
  'summary-label': 'warning',
  'leftover-placeholder': 'warning',
  'filler-note': 'warning',
  'section-order': 'warning',
  'missing-satisfies': 'warning',
  'missing-requirement-ref': 'warning',
  'unknown-requirement': 'warning',
  'plan-id-in-test-name': 'warning',
  'outside-increment': 'warning',
  'task-summary': 'warning',
  'task-behaviour': 'warning',
  'increment-behaviour': 'warning',
  'task-overlap': 'warning',
  'automated-test-duplicates-check': 'warning',
  'criterion-critical-review': 'warning',
  'change-path-excluded': 'warning',
  'generated-command': 'warning',
  'criterion-red-exception': 'warning',
  'criterion-tests-path': 'warning',
  'criterion-check-tests': 'warning',
  'criterion-red-command': 'warning',
  'criterion-review': 'warning',
  'missing-section': 'warning',
  'missing-increment-details': 'warning',
  'missing-increment-field': 'warning',
  'invalid-priority': 'warning',
  'missing-increments': 'warning',
  'invalid-id-sequence': 'warning',
  'invalid-priority-order': 'warning',
  'missing-prerequisite': 'warning',
  'cycle': 'warning',
  'execution-status': 'warning',
  'generated-inputs': 'warning',
  'glance-restates-task-map': 'warning',
} as const;

export type LintDefectCode = keyof typeof LINT_SEVERITIES;
export type LintDefect = { code: LintDefectCode; severity: 'defect' | 'warning'; line: number | null; message: string };

export function lint(code: LintDefectCode, line: number | null, message: string): LintDefect {
  if (!Object.hasOwn(LINT_SEVERITIES, code)) throw new Error(`unhandled lint code: ${String(code)}`);
  return { code, severity: LINT_SEVERITIES[code], line, message };
}

export const LONG_PARAGRAPH_WORDS = 60;

/** Count prose only; structural boundaries also stop a preceding paragraph. */
export function lintLongParagraphs(lines: readonly StructuralLine[]): { line: number; words: number }[] {
  const out: { line: number; words: number }[] = [];
  let paragraph: { line: number; words: number } | null = null;
  const finish = () => { if (paragraph && paragraph.words > LONG_PARAGRAPH_WORDS) out.push(paragraph); paragraph = null; };
  for (const entry of lines) {
    const text = entry.text;
    if (!text.trim() || /^(?:#{1,6}\s|\s*(?:[-*+]\s|\d+[.)]\s|\|))/.test(text) || isDetailWrapper(text)) { finish(); continue; }
    if (!paragraph && /^\s/.test(text)) continue;
    if (!paragraph) paragraph = { line: entry.line, words: 0 };
    paragraph.words += text.trim().split(/\s+/).length;
  }
  finish();
  return out;
}

/** Each present `order` heading must follow every earlier-listed present heading; absent and unlisted `##` sections are ignored. */
export function lintSectionOrder(lines: readonly StructuralLine[], order: readonly string[]): LintDefect[] {
  const out: LintDefect[] = [];
  let latest: { rank: number; heading: string } | null = null;
  for (const entry of lines) {
    const heading = entry.text.trimEnd();
    const rank = order.indexOf(heading);
    if (rank === -1) continue;
    if (latest && rank < latest.rank) out.push(lint('section-order', entry.line, `Move "${heading}" before "${latest.heading}"; sections follow the template order.`));
    else latest = { rank, heading };
  }
  return out;
}

// SECTION: Summary box

type BoxEntry = { label: string | null; value: string; line: number; raw: string };
type ValueRule = RegExp | ((value: string) => string | null);

const BOX_LINE = /^> \*\*([^*]+?):\*\*(?: (.*))?$/;
const BOX_VALUE_RULES: Readonly<Record<string, RegExp>> = {
  Risk: /^(low|med|high) — \S/,
  Increments: /^[1-9]\d*$/,
  Status: /^(?:\d+\/\d+ SC passing|n\/a)$/,
};

/** Lines after optional `---` frontmatter and their 1-based line offset. */
function bodyLines(source: string): { lines: string[]; offset: number } {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (close !== -1) return { lines: lines.slice(close + 1), offset: close + 1 };
  }
  return { lines, offset: 0 };
}

export function documentTitle(source: string): string | null {
  const line = bodyLines(source).lines.find((item) => item.trim());
  return line && /^#\s+\S/.test(line) ? line.replace(/^#\s+/, '').trim() : null;
}

/** H1, one blank line, `> **Label:** value` lines with optional blank quote separators, then the first `##`; null when absent. */
export function parseSummaryBox(source: string): { entries: BoxEntry[]; trailing: string | null } | null {
  const { lines, offset } = bodyLines(source);
  let index = lines.findIndex((line) => line.trim());
  if (index === -1 || !/^#\s+\S/.test(lines[index] ?? '')) return null;
  index += 1;
  if (lines[index]?.trim() !== '' || !lines[index + 1]?.startsWith('>')) return null;
  index += 1;
  const entries: BoxEntry[] = [];
  for (; index < lines.length && (lines[index] ?? '').startsWith('>'); index += 1) {
    const raw = (lines[index] ?? '').trimEnd();
    if (/^>\s*$/.test(raw)) continue;
    const match = BOX_LINE.exec(raw);
    entries.push({ label: match?.[1] ?? null, value: match?.[2]?.trim() ?? '', line: index + 1 + offset, raw });
  }
  while (index < lines.length && !(lines[index] ?? '').trim()) index += 1;
  const next = lines[index];
  return { entries, trailing: next === undefined || /^##\s/.test(next) ? null : next };
}

export function boxValues(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const entry of parseSummaryBox(source)?.entries ?? []) if (entry.label) values[entry.label] = entry.value;
  return values;
}

export function lintSummaryBox(source: string, labels: readonly string[], valueRules: Readonly<Record<string, ValueRule>> = {}): LintDefect[] {
  const box = parseSummaryBox(source);
  if (!box) return [lint('missing-summary-box', null, `Summary box required after the H1: ${labels.map((label) => `> **${label}:**`).join(', ')}.`)];
  const out: LintDefect[] = [];
  const label = (line: number | null, message: string) => out.push(lint('summary-label', line, message));
  for (const entry of box.entries) if (!entry.label) label(entry.line, `Malformed summary line "${entry.raw}"; use > **Label:** value.`);
  const found = box.entries.flatMap((entry) => entry.label ? [entry.label] : []);
  if (found.join('\n') !== labels.join('\n')) label(box.entries[0]?.line ?? null, `Summary labels must be exactly ${labels.join(', ')} in order; found ${found.join(', ') || 'none'}.`);
  const rules: Record<string, ValueRule> = { ...BOX_VALUE_RULES, ...valueRules };
  for (const entry of box.entries) {
    if (!entry.label) continue;
    if (!entry.value) { label(entry.line, `Summary label ${entry.label} requires a value.`); continue; }
    const rule = rules[entry.label];
    if (rule instanceof RegExp && !rule.test(entry.value)) label(entry.line, `Summary ${entry.label} value "${entry.value}" does not match ${String(rule)}.`);
    if (typeof rule === 'function') {
      const message = rule(entry.value);
      if (message) label(entry.line, message);
    }
  }
  if (box.trailing !== null) label(null, 'The summary box must be followed by the first ## section.');
  return out;
}

// SECTION: Template placeholders

export type PlaceholderVocabulary = { all: ReadonlySet<string>; code: ReadonlySet<string> };

// CommonMark spans close on a backtick run of the opener's exact length.
const CODE_SPAN = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
const TOKEN = /<[A-Za-z][^<>\n]*>/g;

/** Innermost `<...>` tokens of the templates' fenced bodies; `code` holds those the templates put in inline code. */
export function placeholderVocabulary(templates: readonly string[]): PlaceholderVocabulary {
  const all = new Set<string>();
  const code = new Set<string>();
  for (const text of templates) {
    const body = /^(`{4,})markdown\s*\n([\s\S]*?)\n\1\s*$/m.exec(text.replace(/\r\n/g, '\n'))?.[2] ?? '';
    for (const token of body.match(TOKEN) ?? []) { if (!/^<\/?(?:details|summary)>$/.test(token)) all.add(token); }
    for (const span of body.match(CODE_SPAN) ?? []) for (const token of span.match(TOKEN) ?? []) { if (!/^<\/?(?:details|summary)>$/.test(token)) code.add(token); }
  }
  return { all, code };
}

/** Vocabulary tokens left in prose or inline code, outside frontmatter, fences, and comments. */
export function findPlaceholders(source: string, vocabulary: PlaceholderVocabulary): { token: string; line: number }[] {
  const { lines, offset } = bodyLines(source);
  const structural = structuralLines(lines.join('\n'));
  return structural.flatMap(({ text, line }) => {
    const code = (text.match(CODE_SPAN) ?? []).flatMap((span) => span.match(TOKEN) ?? []).filter((token) => vocabulary.code.has(token));
    const prose = (text.replace(CODE_SPAN, '').match(TOKEN) ?? []).filter((token) => vocabulary.all.has(token));
    return [...prose, ...code].map((token) => ({ token, line: line + offset }));
  });
}

// SECTION: Filler notes

const FILLER = new Set(['same', 'see above', 'unchanged', 'n/a', 'approved implementation scope', 'included in the selected review scope']);
const DELTA = /^\+\d+ −\d+$/;
const FIXES_SUFFIX = /(?:^|; )fixes (R\d+-F\d{3,}(?:, R\d+-F\d{3,})*)$/;

const normalizeNote = (note: string) => note.replace(/\s+/g, ' ').trim().toLowerCase().replace(/\.$/, '');
const baseNote = (note: string) => {
  const match = FIXES_SUFFIX.exec(note.trim());
  return match ? note.trim().slice(0, match.index) : note;
};

/** Empty, a stock phrase, or a copy of a sibling note (ignoring `fixes <IDs>` suffixes). */
export function isFillerNote(note: string, siblings: readonly string[] = []): boolean {
  const value = normalizeNote(note);
  if (!value || FILLER.has(value)) return true;
  const base = normalizeNote(baseNote(note));
  if (!base || DELTA.test(base)) return false;
  return siblings.some((sibling) => normalizeNote(baseNote(sibling)) === base);
}

const BEHAVIOUR_PLACEHOLDER = /^(?:TODO|TBD|implement later|fill in|<[^<>]+>)$/i;
const FILE_COUNT_SUMMARY = /^\d+\s+(?:(?:new|modified|deleted|changed)\s+)?files?(?:(?:\s*[,;]\s*|\s+and\s+)\d+\s+(?:(?:new|modified|deleted|changed)\s+)?files?)*(?:\s+(?:touched|changed|modified))?$/i;

export function hasBehaviour(behaviour: readonly string[]): boolean {
  return behaviour.some((bullet) => {
    const value = bullet.replace(CODE_SPAN, '').trim().replace(/\.$/, '').trim();
    return Boolean(value) && !BEHAVIOUR_PLACEHOLDER.test(value) && !FILE_COUNT_SUMMARY.test(value);
  });
}
