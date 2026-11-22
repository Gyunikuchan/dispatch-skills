import type { ChangeAction, LintDefect, LintDefectCode, PlanCriterion } from './types.ts';

export const RESOLUTION_HEADING = '## Review Findings & Resolutions';

// SECTION: Lint severity

const unreachable = (value: never): never => { throw new Error(`unhandled lint code: ${String(value)}`); };

/** Closed mapping; a new code fails to compile until it is classified. */
function lintSeverity(code: LintDefectCode): LintDefect['severity'] {
  switch (code) {
    case 'missing-success-criteria':
    case 'proposed-changes':
    case 'change-heading':
    case 'unknown-change-marker':
    case 'invalid-change-path':
    case 'duplicate-change-path':
    case 'verification-plan':
    case 'automated-tests':
    case 'automated-tests-owner':
    case 'automated-command':
    case 'success-criteria':
    case 'criterion-format':
    case 'criterion-id':
    case 'criterion-mapping':
    case 'criterion-change-path':
    case 'criterion-check':
    case 'criterion-evidence':
    case 'duplicate-id':
    case 'task-heading':
    case 'task-ownership':
    case 'task-criteria':
    case 'criterion-task-changes':
    case 'task-map':
      return 'defect';
    case 'long-paragraph':
    case 'placeholder':
    case 'ambiguous-command':
    case 'automated-tests-unavailable':
    case 'unsatisfied-requirement':
    case 'criterion-red-test-path':
    case 'overlap':
    case 'missing-seams':
    case 'red-downgraded':
    case 'undeclared-test-path':
    case 'missing-summary-box':
    case 'summary-label':
    case 'leftover-placeholder':
    case 'filler-note':
    case 'section-order':
    case 'missing-satisfies':
    case 'missing-requirement-ref':
    case 'unknown-requirement':
    case 'plan-id-in-test-name':
    case 'outside-increment':
    case 'task-summary':
    case 'task-behaviour':
    case 'increment-behaviour':
    case 'task-overlap':
    case 'automated-test-duplicates-check':
    case 'criterion-critical-review':
    case 'change-path-excluded':
    case 'generated-command':
    case 'criterion-red-exception':
    case 'criterion-tests-path':
    case 'criterion-check-tests':
    case 'criterion-red-command':
    case 'criterion-review':
    case 'missing-section':
    case 'missing-increment-details':
    case 'missing-increment-field':
    case 'invalid-priority':
    case 'missing-increments':
    case 'invalid-id-sequence':
    case 'invalid-priority-order':
    case 'missing-prerequisite':
    case 'cycle':
    case 'execution-status':
    case 'generated-inputs':
    case 'glance-restates-task-map':
      return 'warning';
    default: return unreachable(code);
  }
}

export const lint = (code: LintDefectCode, line: number | null, message: string): LintDefect =>
  ({ code, severity: lintSeverity(code), line, message });

// SECTION: Structural lines

export type StructuralLine = { line: number; text: string; original: string; fenced: boolean };

export const FENCE = /^ {0,3}(`{3,}|~{3,})/;

// NOTE: `<!--` inside a closed inline code span is literal (CommonMark); unmatched backticks stay literal too.
export function commentOpenOutsideCode(original: string, from: number): number {
  const run = /`+/g;
  let cursor = from;
  for (;;) {
    const open = original.indexOf('<!--', cursor);
    if (open === -1) return -1;
    run.lastIndex = cursor;
    const opener = run.exec(original);
    if (!opener || opener.index > open) return open;
    cursor = run.lastIndex;
    let closer: RegExpExecArray | null;
    while ((closer = run.exec(original)) && closer[0].length !== opener[0].length);
    if (closer) cursor = run.lastIndex;
  }
}

/** Lines with blockquotes, HTML comments, and fenced content blanked; loci are 1-based source lines. */
export function structuralLines(source: string): StructuralLine[] {
  let fence: string | null = null;
  let inComment = false;
  return source.split(/\r?\n/).map((original, index) => {
    const line = index + 1;
    // Fence state freezes inside an open HTML comment, so a commented-out example cannot swallow later sections.
    const marker = inComment ? undefined : FENCE.exec(original)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      // A closer is bare (no info string), same character, at least the opener's length (CommonMark).
      else if (marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(`+|~+)\s*$/.test(original)) fence = null;
      return { line, text: '', original, fenced: true };
    }
    if (fence !== null) return { line, text: '', original, fenced: true };
    let text = '';
    let cursor = 0;
    while (cursor < original.length) {
      if (inComment) {
        const close = original.indexOf('-->', cursor);
        if (close === -1) { cursor = original.length; break; }
        inComment = false;
        cursor = close + 3;
        continue;
      }
      const open = commentOpenOutsideCode(original, cursor);
      if (open === -1) { text += original.slice(cursor); break; }
      text += original.slice(cursor, open);
      inComment = true;
      cursor = open + 4;
    }
    return { line, text: /^\s*>/.test(text) ? '' : text, original, fenced: false };
  });
}

export const isDetailWrapper = (text: string): boolean => /^(?:<details>|<\/details>|<summary>.*<\/summary>)$/.test(text.trim());

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

type SectionRange = { start: number; end: number };

/** Index ranges of each exact `heading` line up to the next `##` heading. */
export function sectionRanges(lines: readonly StructuralLine[], heading: string): SectionRange[] {
  return lines.flatMap((entry, index) => {
    if (entry.text.trimEnd() !== heading) return [];
    const next = lines.findIndex((later, laterIndex) => laterIndex > index && /^##\s+/.test(later.text));
    return [{ start: index, end: next === -1 ? lines.length : next }];
  });
}

/** Source with each exact `## <heading>` section (heading through the next `##`) removed. */
export function withoutSections(source: string, headings: readonly string[]): string {
  const lines = structuralLines(source);
  const raw = source.split(/\r?\n/);
  const drop = new Set<number>();
  for (const heading of headings) {
    for (const { start, end } of sectionRanges(lines, heading)) for (let index = start; index < end; index++) drop.add(index);
  }
  return raw.filter((_line, index) => !drop.has(index)).join('\n').replace(/\s+$/, '\n');
}

/** Hashing input: the source without review history. */
export function governedPlanText(source: string): string {
  return withoutSections(source, [RESOLUTION_HEADING]);
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

// SECTION: Paths

/** Portable workspace-relative POSIX path, or the rejection reason. */
export function normalizePlanPath(raw: string): { path: string | null; reason: string | null } {
  const trimmed = raw.trim();
  const rawPath = /^`([^`]+)`.*$/.exec(trimmed)?.[1] ?? /^\S+/.exec(trimmed)?.[0];
  if (!rawPath) return { path: null, reason: 'empty' };
  if (rawPath.includes('\\')) return { path: null, reason: 'backslash' };
  // NOTE: drive-qualified (`C:/x`, `C:x`) and home (`~`) forms escape the workspace on resolve.
  if (rawPath.startsWith('/') || /^[A-Za-z]:/.test(rawPath) || rawPath.startsWith('~')) return { path: null, reason: 'absolute' };
  const segments = rawPath.replace(/^\.\/+/, '').split('/');
  if (segments.includes('..')) return { path: null, reason: 'parent-segment' };
  const normalized = segments.filter((segment) => segment && segment !== '.').join('/');
  return normalized ? { path: normalized, reason: null } : { path: null, reason: 'empty' };
}

const LISTED_PATH = /^(`[^`]+`|[^\s,`]+)\s*,\s*/;

/** Paths named by a change heading; only [DELETE] may group comma-separated paths, each bare or backticked. */
export function headingPaths(action: ChangeAction, text: string): { paths: ReturnType<typeof normalizePlanPath>[] } | { error: string } {
  const parts: string[] = [];
  let rest = text.trim();
  // A comma ends a path only directly after it, so a trailing note after the last path may hold commas.
  for (let match = LISTED_PATH.exec(rest); match; match = LISTED_PATH.exec(rest)) {
    parts.push(match[1] ?? '');
    rest = rest.slice(match[0].length);
  }
  parts.push(rest);
  if (parts.length > 1 && action !== 'DELETE') return { error: `List one path per [${action}] heading; only [DELETE] may group comma-separated paths. Split "${text.trim()}".` };
  return { paths: parts.map((part) => normalizePlanPath(part)) };
}

// SECTION: Plan structure

export const TASK_HEADING = /^###\s+(T[1-9]\d*)\s+[—–-]\s+(\S.*?)\s*$/;
export const ACTION_HEADING = /^####\s+\[(NEW|MODIFY|DELETE|GENERATED)\]\s+(.+?)\s*$/;

/** Normalize only task-owned file entries and their detail indentation. */
export function taskStructuralView(lines: readonly StructuralLine[]): StructuralLine[] {
  let task = false;
  let nested = false;
  return lines.map((entry) => {
    let text = entry.text;
    if (/^##\s/.test(text)) { task = false; nested = false; }
    if (/^###\s/.test(text)) { task = TASK_HEADING.test(text); nested = false; }
    if (task && /^- ####\s+\[/.test(text)) { text = text.slice(2); nested = true; }
    else if (/^####\s/.test(text)) nested = false;
    else if (nested && (/^ {2}[-*+]\s/.test(text) || /^ {4,}\S/.test(text))) text = text.slice(2);
    return { ...entry, text };
  });
}

export function splitTaskMapRow(source: string): string[] | null {
  const row = source.trim();
  if (!row.startsWith('|') || !row.endsWith('|')) return null;
  const cells: string[] = [];
  let cell = '';
  const body = row.slice(1, -1);
  for (let index = 0; index < body.length;) {
    const character = body[index]!;
    if (character === '|') {
      let slashes = 0;
      for (let back = cell.length - 1; back >= 0 && cell[back] === '\\'; back--) slashes++;
      if (slashes % 2) {
        cell = `${cell.slice(0, -1)}|`;
        index++;
        continue;
      }
      cells.push(cell.trim());
      cell = '';
      index++;
      continue;
    }
    cell += character;
    index++;
  }
  cells.push(cell.trim());
  return cells;
}

// SECTION: Plan lint

export const PROSE_PLACEHOLDER = /\b(?:TODO|TBD|implement later|fill in)\b/i;
const BEHAVIOUR_PLACEHOLDER = /^(?:TODO|TBD|implement later|fill in|<[^<>]+>)$/i;
const FILE_COUNT_SUMMARY = /^\d+\s+(?:(?:new|modified|deleted|changed)\s+)?files?(?:(?:\s*[,;]\s*|\s+and\s+)\d+\s+(?:(?:new|modified|deleted|changed)\s+)?files?)*(?:\s+(?:touched|changed|modified))?$/i;

export function hasBehaviour(behaviour: readonly string[]): boolean {
  return behaviour.some((bullet) => {
    const value = bullet.replace(CODE_SPAN, '').trim().replace(/\.$/, '').trim();
    return Boolean(value) && !BEHAVIOUR_PLACEHOLDER.test(value) && !FILE_COUNT_SUMMARY.test(value);
  });
}

/** A summary table that repeats Task Map IDs duplicates the map; the summary should link the map instead. */
export function lintGlanceRestatesTaskMap(lines: readonly StructuralLine[], rows: readonly { id: string }[], out: LintDefect[]): void {
  const range = sectionRanges(lines, '## At a Glance')[0];
  const ids = new Set(rows.map((row) => row.id));
  for (const entry of range ? lines.slice(range.start + 1, range.end) : []) {
    const first = entry.fenced ? undefined : splitTaskMapRow(entry.text)?.[0]?.replace(/^`|`$/g, '').trim().toUpperCase();
    if (first && ids.has(first)) out.push(lint('glance-restates-task-map', entry.line, `## At a Glance table row ${first} restates a Task Map row; link ## Task Map instead of repeating it.`));
  }
}

export function lintAutomatedDuplicates(automated: readonly string[], criteria: readonly PlanCriterion[], lines: readonly StructuralLine[], out: LintDefect[]): void {
  const verifies = new Set(criteria.flatMap((criterion) => criterion.verify.map((item) => item.command)));
  for (const command of automated) {
    if (!verifies.has(command)) continue;
    const line = lines.find((entry) => entry.text.includes(`\`${command}\``) && /^-\s+`/.test(entry.text))?.line ?? null;
    out.push(lint('automated-test-duplicates-check', line, `Automated test \`${command}\` repeats a criterion Check command; list only extra commands.`));
  }
}

export function lintNotes(lines: readonly StructuralLine[], out: LintDefect[]): void {
  const range = sectionRanges(lines, '## Proposed Changes')[0];
  if (!range) return;
  let current: string | null = null;
  const notes = taskStructuralView(lines).slice(range.start + 1, range.end).flatMap((entry) => {
    current = ACTION_HEADING.exec(entry.text)?.[1] ?? current;
    const note = /^[-*+]\s+(?:Changes|Purpose):[ \t]*(.*)$/.exec(entry.text)?.[1]?.trim();
    return note ? [{ note, line: entry.line, action: current }] : [];
  });
  notes.forEach(({ note, line, action }, index) => {
    const siblings = notes.filter((_item, other) => other !== index);
    const intrinsic = isFillerNote(note);
    if (!intrinsic && !isFillerNote(note, siblings.map((item) => item.note))) return;
    // A note shared by separate [DELETE] entries belongs on one grouped heading.
    const grouping = action === 'DELETE' && !intrinsic && isFillerNote(note, siblings.filter((item) => item.action === 'DELETE').map((item) => item.note));
    const reason = intrinsic ? 'is filler' : 'repeats a sibling note';
    out.push(lint('filler-note', line, `Change note "${note}" ${reason}; say what changes in this file${grouping ? '; group these [DELETE] paths under one heading' : ''}.`));
  });
}

// SECTION: Test paths

// Common test-path conventions; a lint hint only, so a test-like path outside every `Tests:` warns. Declared `Tests:` drive decisions.
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|specs?)\/|[._-](?:test|spec)s?\.[^/]+$|(?:^|\/)test_[^/]+\.[^/]+$/i;
export const isTestPath = (value: string): boolean => TEST_PATH.test(value);
// Lint hint only: paths under these segments look like support files, so the `undeclared-test-path` check skips them.
const TEST_SUPPORT_PATH = /(?:^|\/)(?:fixtures|helpers|mocks)\//i;
/** A test-like support path (fixture, helper, mock): exempt from the `undeclared-test-path` lint; a RED stage that changes or needs it must still list it in `Tests:`. */
export const isTestSupportPath = (value: string): boolean => isTestPath(value) && TEST_SUPPORT_PATH.test(value);
const unquote = (value: string): string => value.replace(/^[`'"]+|[`'"]+$/g, '');
/** Path-like tokens of a Check command; whitespace inside quotes does not split, so a quoted path with a space stays whole. */
export const checkPathTokens = (command: string): string[] => (command.match(/(?:"[^"]*"|'[^']*'|\S)+/g) ?? []).map((token) => {
  const value = unquote(unquote(token).replace(/^--[^=\s]+=/, ''));
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
});
