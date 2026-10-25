// Plan parse + lint + governed text (spec §8.1). Shared Markdown helpers are exported for domain/design.ts.

import type {
  ChangeAction, EvidenceClass, LintDefect, LintDefectCode, ParsedPlan, PlanChange, PlanCommand, PlanCriterion, PlanTask, PlanWarning,
} from './types.ts';
import { criterionHeading, isCriterionId } from './criterion-id.ts';

export const RESOLUTION_HEADING = '## Review Findings & Resolutions';
export const TASK_MAP_HEADING = '## Task Map';

/** Plan section order after the title and summary box; every section is optional to this lint. */
export const PLAN_SECTION_ORDER = [
  '## Background', '## Key Decisions & Context', '## Open Questions & Assumptions', '## Out of Scope',
  TASK_MAP_HEADING, '## Technical-Design Traceability', '## Proposed Changes', '## Success Criteria', '## Verification Plan',
  '## Rollback & Blast Radius', RESOLUTION_HEADING,
] as const;

// SECTION: Lint severity

const unreachable = (value: never): never => { throw new Error(`unhandled lint code: ${String(value)}`); };

/** Closed mapping; a new code fails to compile until it is classified. */
export function lintSeverity(code: LintDefectCode): LintDefect['severity'] {
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
    case 'criterion-verify':
    case 'final-in-code-span':
    case 'duplicate-id':
    case 'task-heading':
    case 'task-ownership':
    case 'task-criteria':
    case 'criterion-task-changes':
    case 'task-map':
      return 'defect';
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
    case 'retired-section':
    case 'missing-satisfies':
    case 'missing-requirement-ref':
    case 'unknown-requirement':
    case 'plan-id-in-test-name':
    case 'task-summary':
    case 'task-overlap':
    case 'automated-test-duplicates-verify':
    case 'criterion-test-rationale':
    case 'criterion-critical-review':
    case 'change-path-excluded':
    case 'generated-command':
    case 'criterion-evidence':
    case 'criterion-red-exception':
    case 'criterion-tests-path':
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
    case 'transient-coverage':
    case 'criterion-retain-required':
    case 'transient-test-path':
      return 'warning';
    default: return unreachable(code);
  }
}

export const lint = (code: LintDefectCode, line: number | null, message: string): LintDefect =>
  ({ code, severity: lintSeverity(code), line, message });

// SECTION: Structural lines

export type StructuralLine = { line: number; text: string; original: string; fenced: boolean };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

// NOTE: `<!--` inside a closed inline code span is literal (CommonMark); unmatched backticks stay literal too.
function commentOpenOutsideCode(original: string, from: number): number {
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

export type SectionRange = { start: number; end: number };

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

export type BoxEntry = { label: string | null; value: string; line: number; raw: string };
export type ValueRule = RegExp | ((value: string) => string | null);

const BOX_LINE = /^> \*\*([^*]+?):\*\*(?: (.*))?$/;
export const BOX_VALUE_RULES: Readonly<Record<string, RegExp>> = {
  Risk: /^(low|med|high) — \S/,
  Increments: /^[1-9]\d*$/,
  Status: /^(?:\d+\/\d+ SC passing|n\/a)$/,
};

/** Lines after optional `---` frontmatter and their 1-based line offset. */
export function bodyLines(source: string): { lines: string[]; offset: number } {
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
    for (const token of body.match(TOKEN) ?? []) all.add(token);
    for (const span of body.match(CODE_SPAN) ?? []) for (const token of span.match(TOKEN) ?? []) code.add(token);
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

// SECTION: Plan parse

const BOX_LABELS = ['TL;DR', 'Parent', 'Decide', 'Risk', 'Scope'];
/** Parent forms: a governing spec pinned by checksum or a design increment. */
export const SPEC_PIN_VALUE = /^`([^`\s]+\.spec\.md)` · sha256:([0-9a-f]{64})$/;
export const DESIGN_PIN_VALUE = /^`([^`\s]+\.design\.md)` · (I\d{2})$/;
export const PARENT_VALUE = new RegExp(`(?:${SPEC_PIN_VALUE.source})|(?:${DESIGN_PIN_VALUE.source})`);
const TASK_HEADING = /^###\s+(T[1-9]\d*)\s+[—–-]\s+(\S.*?)\s*$/;
const TASK_FIELD = /^[-*+]\s+(Outcome|Prerequisites|Criteria):\s*(.*?)\s*$/i;
const CONSTRAINT_FIELD = /^[-*+]\s+Constraints:\s*(.*?)\s*$/i;
const OVERLAP_FIELD = /^[-*+]\s+Overlap:\s*(.*?)\s*$/i;
const ACTION_HEADING = /^####\s+\[(NEW|MODIFY|DELETE|GENERATED)\]\s+(.+?)\s*$/;
const MARKER_HEADING = /^####\s+\[([A-Z][A-Z-]*)\]\s+\S/;
const EXCLUDED_CHANGE_PATH = /^(?:\.git|\.scratch)(?:\/|$)/;
const PROSE_PLACEHOLDER = /\b(?:TODO|TBD|implement later|fill in)\b/i;
const EVIDENCE: readonly EvidenceClass[] = ['red', 'verify', 'review'];
const RED_EXCEPTIONS = ['behavior-preserving', 'already-satisfied'];
// Common test-path conventions; a lint hint only, so a test-like path outside every `Tests:` warns. Declared `Tests:` drive decisions.
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|specs?)\/|[._-](?:test|spec)s?\.[^/]+$|(?:^|\/)test_[^/]+\.[^/]+$/i;
export const isTestPath = (value: string): boolean => TEST_PATH.test(value);
// Lint hint only: paths under these segments look like support files, so transient naming and `undeclared-test-path` skip them; trim never uses path shape.
const TEST_SUPPORT_PATH = /(?:^|\/)(?:fixtures|helpers|mocks)\//i;
/** A test-like support path (fixture, helper, mock): exempt from the `undeclared-test-path` and transient naming lints; a RED stage that changes or needs it must still list it in `Tests:`. */
export const isTestSupportPath = (value: string): boolean => isTestPath(value) && TEST_SUPPORT_PATH.test(value);

/** Matches any plan-defined ID as a whole token, case-insensitively; null when the plan defines none. */
export function planIdPattern(ids: readonly string[]): RegExp | null {
  if (!ids.length) return null;
  const escaped = ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?<![A-Za-z0-9-])(?:${escaped.join('|')})(?![A-Za-z0-9])`, 'i');
}

const FINDING_ID = /\bR\d+-F\d+\b/gi;
const CRITICAL = /\b(?:correctness|safety|recovery|durability|protocol)\b/i;

type Criterion = PlanCriterion & { satisfies: readonly string[]; retainLine: number | null; verifyLines: number[]; testsLine: number | null; redCommandLine: number | null; integration: string | null; mapped: boolean; evidenceRaw: string | null; evidenceLine: number; redLine: number; reviewLine: number; coveredLine: number; critical: boolean; valid: boolean };

export type PlanResult =
  | { ok: true; plan: ParsedPlan; warnings: LintDefect[] }
  | { ok: false; defects: LintDefect[]; warnings: LintDefect[] };

export type PlanOptions = { placeholders?: PlaceholderVocabulary };

/** Parses and lints a plan; any defect-severity diagnostic fails the parse. */
export function parsePlan(source: string, options: PlanOptions = {}): PlanResult {
  const lines = structuralLines(source);
  const out: LintDefect[] = [];
  const { changes, tasks: sections } = parseChanges(lines, out);
  const tasks = joinTaskMap(sections, parseTaskMap(lines, out), out);
  const verification = parseVerification(lines, out);
  const criteria = parseCriteria(lines, changes, out);
  const seamDeclarations = parseSeamDeclarations(lines);
  const seams = seamsFromDeclarations(seamDeclarations);
  if (criteria.some((criterion) => criterion.verify.length) && !seams.length && !seamDeclarations.some(({ value }) => /^none$/i.test(value))) {
    const range = sectionRanges(lines, '## Verification Plan')[0];
    out.push(lint('missing-seams', range ? lines[range.start]?.line ?? null : null, 'Automated criteria have no test seams; declare Seams: <entry points> or Seams: none when inapplicable.'));
  }
  const finalCommands = criteria.flatMap((criterion) => criterion.verify.filter((item) => item.final).map((item) => item.command));
  lintTransientCoverage(criteria, finalCommands, out);
  lintTransientTestPaths(criteria, changes, out);
  lintUndeclaredTestPaths(criteria, out);
  const planIds = collectPlanIds(lines, criteria);
  lintPlanIdNames(criteria, changes, planIds, out);
  lintTaskSections(sections, out);
  const overlapWarnings = lintTasks(tasks, changes, criteria, out);
  lintAutomatedDuplicates(verification.automated, criteria, lines, out);
  lintNotes(lines, out);
  out.push(...lintSectionOrder(lines, PLAN_SECTION_ORDER));
  for (const entry of lines) if (entry.text.trimEnd() === '## User Review Required') out.push(lint('retired-section', entry.line, 'Move user questions to the governing spec Open Questions.'));
  for (const entry of lines) {
    if (PROSE_PLACEHOLDER.test(entry.text.replace(/`[^`]*`/g, ''))) out.push(lint('placeholder', entry.line, 'Plan contains a prose placeholder.'));
  }
  out.push(...lintSummaryBox(source, BOX_LABELS, { Parent: PARENT_VALUE }));
  if (options.placeholders) {
    for (const { token, line } of findPlaceholders(source, options.placeholders)) out.push(lint('leftover-placeholder', line, `Leftover template placeholder ${token}.`));
  }
  const defects = out.filter((item) => item.severity === 'defect');
  const warnings = out.filter((item) => item.severity === 'warning');
  if (defects.length) return { ok: false, defects, warnings };
  const plan: ParsedPlan = {
    title: documentTitle(source),
    box: boxValues(source),
    keyDecisions: bullets(lines, '## Key Decisions & Context'),
    criteria: criteria.map(({ id, title, line, satisfies, changes: paths, tests, verify, evidence, preExisting, redException, red, testRationale, review, enforcementInfeasibility, retain, coveredBy }) =>
      ({ id, title, line, satisfies, changes: paths, tests, verify, evidence, preExisting, redException, red, testRationale, review, enforcementInfeasibility, retain, coveredBy })),
    tasks: tasks.map(({ id, title, summary, constraints, line, prerequisites, criteria: ids, paths, generated, overlaps }) => ({ id, title, summary, constraints, line, prerequisites, criteria: ids, paths, generated, overlaps })),
    changes,
    verification,
    finalCommands,
    seams,
    warnings: overlapWarnings,
    traceability: keyValues(lines, '## Technical-Design Traceability'),
    governedText: governedPlanText(source),
    planIds,
    sharedContext: '',
  };
  return { ok: true, plan: { ...plan, sharedContext: sharedPlanContext(plan.governedText) }, warnings };
}

/** Index of the first line after the Task Map, or of the first later-ordered section when the plan has no Task Map. */
function sharedContextEnd(lines: readonly StructuralLine[]): number {
  const map = sectionRanges(lines, TASK_MAP_HEADING)[0];
  if (map) return map.end;
  const later = new Set<string>(PLAN_SECTION_ORDER.slice(PLAN_SECTION_ORDER.indexOf(TASK_MAP_HEADING) + 1));
  const next = lines.findIndex((entry) => later.has(entry.text.trimEnd()));
  return next === -1 ? lines.length : next;
}

/** Shared writer context preserves the authored map bytes used by the governed hash. */
function sharedPlanContext(text: string): string {
  return text.split(/\r?\n/).slice(0, sharedContextEnd(structuralLines(text))).join('\n').replace(/\s+$/, '\n');
}

function bullets(lines: readonly StructuralLine[], heading: string): string[] {
  const range = sectionRanges(lines, heading)[0];
  if (!range) return [];
  return lines.slice(range.start + 1, range.end).flatMap(({ text }) => {
    const match = /^[-*+]\s+(.+)$/.exec(text);
    return match?.[1] ? [match[1].trim()] : [];
  });
}

function keyValues(lines: readonly StructuralLine[], heading: string): Record<string, string> | null {
  const range = sectionRanges(lines, heading)[0];
  if (!range) return null;
  const values: Record<string, string> = {};
  for (const { text } of lines.slice(range.start + 1, range.end)) {
    const match = /^[-*+]\s+([^:]+):\s*(.*)$/.exec(text);
    if (match?.[1]) values[match[1].trim()] = (match[2] ?? '').trim();
  }
  return values;
}

type DraftTask = PlanTask & { constraints: string[]; prerequisitesLine: number | null; criteriaLine: number | null; summaryLine: number; overlapLines: number[] };

type AuthoredTaskRow = { id: string; title: string; outcome: string; prerequisites: string[]; criteria: string[]; line: number };

/** Normalize only task-owned file entries and their detail indentation. */
function taskStructuralView(lines: readonly StructuralLine[]): StructuralLine[] {
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

function parseChanges(lines: readonly StructuralLine[], out: LintDefect[]): { changes: PlanChange[]; tasks: DraftTask[] } {
  const ranges = sectionRanges(lines, '## Proposed Changes');
  const range = ranges[0];
  if (ranges.length !== 1 || !range) {
    out.push(lint('proposed-changes', null, 'Expected exactly one ## Proposed Changes section.'));
    return { changes: [], tasks: [] };
  }
  const changes: PlanChange[] = [];
  const tasks: DraftTask[] = [];
  // Same-owner repeats are malformed; lintOverlaps classifies cross-task repeats once the task graph is known.
  const seen = new Map<DraftTask | null, Map<string, string>>();
  const body = taskStructuralView(lines).slice(range.start + 1, range.end);
  // `task` is null before the first H3 or under a malformed one; `inHeader` spans a task H3 up to its first H4.
  let task: DraftTask | null = null;
  let malformed = false;
  let inHeader = false;
  body.forEach((entry, offset) => {
    if (/^###\s/.test(entry.text)) {
      const heading = TASK_HEADING.exec(entry.text);
      inHeader = true;
      if (!heading?.[1] || !heading[2]) {
        out.push(lint('task-heading', entry.line, 'Task heading must be "### T<n> — <outcome title>".'));
        task = null; malformed = true;
        return;
      }
      malformed = false;
      task = { id: heading[1], title: heading[2], summary: '', constraints: [], line: entry.line, prerequisites: [], criteria: [], paths: [], generated: [], overlaps: [], prerequisitesLine: null, criteriaLine: null, summaryLine: entry.line, overlapLines: [] };
      tasks.push(task);
      return;
    }
    const current = task as DraftTask | null;
    const match = ACTION_HEADING.exec(entry.text);
    if (!match) {
      if (/^\s*[-*+]\s+####\s+\[/.test(entry.text)) out.push(lint('change-heading', entry.line, 'Nested file entries require "- #### [ACTION] path" at task level.'));
      const marker = MARKER_HEADING.exec(entry.text)?.[1];
      if (marker) out.push(lint('unknown-change-marker', entry.line, `Unknown change marker [${marker}]; use [NEW], [MODIFY], [DELETE], or [GENERATED].`));
      if (inHeader && current) readTaskHeader(current, entry, out);
      return;
    }
    inHeader = false;
    const action = match[1] as ChangeAction;
    const listed = headingPaths(action, match[2] ?? '');
    if ('error' in listed) { out.push(lint('change-heading', entry.line, listed.error)); return; }
    const paths: string[] = [];
    for (const normalized of listed.paths) {
      if (!normalized.path) { out.push(lint('invalid-change-path', entry.line, `Invalid change path: ${normalized.reason ?? 'empty'}.`)); continue; }
      // NOTE: case-insensitive filesystems make case variants one file, so they count as duplicate ownership.
      const folded = normalized.path.toLowerCase();
      const owned = seen.get(current) ?? new Map<string, string>();
      seen.set(current, owned);
      const prior = owned.get(folded);
      if (prior !== undefined) out.push(lint('duplicate-change-path', entry.line, prior === normalized.path ? `Change path "${normalized.path}" appears more than once.` : `Change path "${normalized.path}" aliases "${prior}" on case-insensitive filesystems.`));
      owned.set(folded, normalized.path);
      if (EXCLUDED_CHANGE_PATH.test(normalized.path)) out.push(excluded(entry.line, normalized.path));
      if (!current && !malformed) out.push(lint('task-ownership', entry.line, `Change "${normalized.path}" has no owning task; group every change under "### T<n> — <outcome title>" (reauthor component-form plans).`));
      paths.push(normalized.path);
    }
    if (!paths.length) return;
    const block: string[] = [];
    for (const next of body.slice(offset + 1)) {
      if (/^#{2,4}\s+/.test(next.text)) break;
      block.push(next.text);
    }
    const bullet = (name: string) => block.find((text) => text.match(/^[-*+]\s+(\w+):/)?.[1] === name);
    const command = action === 'GENERATED' ? /^[-*+]\s+Command:\s*`([^`]+)`\s*$/.exec(bullet('Command') ?? '')?.[1]?.trim() ?? null : null;
    if (action === 'GENERATED' && !command) out.push(lint('generated-command', entry.line, 'A [GENERATED] path requires a "- Command: `<generator>`" bullet.'));
    // Only [DELETE] lists several paths, so GENERATED inputs stay single-path.
    if (current) {
      current.paths = [...current.paths, ...paths];
      if (action === 'GENERATED') current.generated = [...current.generated, ...paths.map((path) => ({ path, inputs: generatedInputs(bullet('Inputs'), entry.line, out) }))];
    }
    const note = changeNote(block);
    for (const path of paths) changes.push({ action, path, note, command, line: entry.line });
  });
  if (!changes.length && !out.some((item) => item.code === 'invalid-change-path' || item.code === 'unknown-change-marker' || item.code === 'change-heading')) {
    out.push(lint('change-heading', lines[range.start]?.line ?? null, 'Proposed Changes requires an H4 action heading.'));
  }
  return { changes, tasks };
}

function splitTaskMapRow(source: string): string[] | null {
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

function parseTaskMap(lines: readonly StructuralLine[], out: LintDefect[]): AuthoredTaskRow[] {
  const ranges = sectionRanges(lines, TASK_MAP_HEADING);
  if (ranges.length !== 1 || !ranges[0]) {
    out.push(lint('task-map', ranges[0] ? lines[ranges[0].start]?.line ?? null : null, 'Expected exactly one ## Task Map section with the authored task table.'));
    return [];
  }
  const range = ranges[0];
  const entries = lines.slice(range.start + 1, range.end).filter((entry) => entry.text.trim());
  const failRow = (line: number | null, detail: string) => out.push(lint('task-map', line, detail));
  if (entries.length < 2) {
    failRow(lines[range.start]?.line ?? null, 'Task Map requires one header, one delimiter, and at least one task row.');
    return [];
  }
  const expected = ['ID', 'Title', 'Outcome', 'Prerequisites', 'Criteria'];
  const header = splitTaskMapRow(entries[0]!.text);
  const divider = splitTaskMapRow(entries[1]!.text);
  if (!header || header.length !== expected.length || header.some((value, index) => value !== expected[index])) {
    failRow(entries[0]!.line, 'Task Map columns must be ID, Title, Outcome, Prerequisites, Criteria in that order.');
    return [];
  }
  if (!divider || divider.length !== expected.length || divider.some((value) => !/^:?-{3,}:?$/.test(value))) {
    failRow(entries[1]!.line, 'Task Map requires a Markdown delimiter row with five cells.');
    return [];
  }
  if (entries.length === 2) {
    failRow(entries[1]!.line, 'Task Map requires at least one task row.');
    return [];
  }
  const rows: AuthoredTaskRow[] = [];
  const seen = new Set<string>();
  for (const entry of entries.slice(2)) {
    const cells = splitTaskMapRow(entry.text);
    if (!cells || cells.length !== expected.length) {
      failRow(entry.line, 'Task Map rows require exactly five cells; escape literal pipes as \\|, including inside inline code.');
      continue;
    }
    const id = cells[0]!.replace(/^`|`$/g, '').trim().toUpperCase();
    const title = cells[1]!.trim();
    const outcome = cells[2]!.trim();
    if (!/^T[1-9]\d*$/.test(id)) failRow(entry.line, 'Task Map ID must use T[1-9][0-9]*.');
    if (!title) failRow(entry.line, `Task ${id || '(blank)'} requires a nonempty Title cell.`);
    if (!outcome) failRow(entry.line, `Task ${id || '(blank)'} requires a nonempty Outcome cell.`);
    if (seen.has(id)) out.push(lint('duplicate-id', entry.line, `Task Map contains duplicate task ${id}.`));
    seen.add(id);
    const list = (value: string, label: 'Prerequisites' | 'Criteria', noneAllowed: boolean): string[] => {
      const text = value.trim();
      if (!text) {
        failRow(entry.line, `Task ${id || '(blank)'} requires an explicit ${label} cell; use none only for an empty Prerequisites list.`);
        return [];
      }
      if (/^none$/i.test(text)) {
        if (!noneAllowed) failRow(entry.line, `Task ${id || '(blank)'} Criteria cell must name at least one criterion.`);
        return [];
      }
      const values = text.split(',').map((item) => item.trim().replace(/^`|`$/g, '').toUpperCase());
      if (values.some((item) => !item)) failRow(entry.line, `Task ${id || '(blank)'} ${label} must be a comma-separated list of IDs.`);
      const pattern = label === 'Prerequisites' ? /^T[1-9]\d*$/ : /^SC[1-9]\d*$/;
      if (values.some((item) => !pattern.test(item))) failRow(entry.line, `Task ${id || '(blank)'} ${label} must contain ${label === 'Prerequisites' ? 'task IDs T[1-9][0-9]*' : 'criterion IDs SC[1-9][0-9]*'}.`);
      return [...new Set(values.filter((item) => pattern.test(item)))];
    };
    rows.push({ id, title, outcome, prerequisites: list(cells[3]!, 'Prerequisites', true), criteria: list(cells[4]!, 'Criteria', false), line: entry.line });
  }
  return rows;
}

function joinTaskMap(sections: readonly DraftTask[], rows: readonly AuthoredTaskRow[], out: LintDefect[]): DraftTask[] {
  const byId = new Map<string, DraftTask[]>();
  for (const section of sections) byId.set(section.id, [...(byId.get(section.id) ?? []), section]);
  const rowIds = new Set(rows.map((row) => row.id));
  const joined = new Map<string, DraftTask>();
  for (const row of rows) {
    const matches = byId.get(row.id) ?? [];
    if (!matches.length) {
      out.push(lint('task-map', row.line, `Task Map row ${row.id} has no matching Proposed Changes task.`));
      continue;
    }
    for (const task of matches) {
      if (task.title !== row.title) out.push(lint('task-map', row.line, `Task Map title for ${row.id} must match its Proposed Changes heading "${task.title}".`));
      task.summary = row.outcome;
      task.prerequisites = row.prerequisites;
      task.criteria = row.criteria;
      task.prerequisitesLine = row.line;
      task.criteriaLine = row.line;
      task.summaryLine = row.line;
    }
    if (!joined.has(row.id)) joined.set(row.id, matches[0]!);
  }
  for (const task of sections) {
    if (!rowIds.has(task.id)) out.push(lint('task-map', task.line, `Task ${task.id} has no Task Map row.`));
  }
  return rows.flatMap((row) => joined.has(row.id) ? [joined.get(row.id)!] : []);
}

/** Task sections keep only task-owned constraints and overlap justifications. */
function readTaskHeader(task: DraftTask, entry: StructuralLine, out: LintDefect[]): void {
  const overlap = OVERLAP_FIELD.exec(entry.text);
  if (overlap) {
    const parts = /^(.+?)\s+[—–-]\s+(\S.*)$/.exec(overlap[1] ?? '');
    const normalized = parts?.[1] ? normalizePlanPath(parts[1]) : null;
    if (!parts?.[2] || !normalized?.path) { out.push(lint('task-overlap', entry.line, `Task ${task.id} Overlap requires "- Overlap: <path> — <reason>".`)); return; }
    task.overlaps = [...task.overlaps, { path: normalized.path, reason: parts[2].trim() }];
    task.overlapLines.push(entry.line);
    return;
  }
  const constraint = CONSTRAINT_FIELD.exec(entry.text);
  if (constraint) {
    const value = constraint[1]?.trim() ?? '';
    if (!value) out.push(lint('task-map', entry.line, `Task ${task.id} Constraints must contain a task-specific instruction.`));
    else task.constraints.push(value);
    return;
  }
  const field = TASK_FIELD.exec(entry.text);
  if (field?.[1]) {
    out.push(lint('task-map', entry.line, `Task ${task.id} ${field[1]} belongs in Task Map; remove this task-section field.`));
    return;
  }
  if (entry.text.trim()) out.push(lint('task-map', entry.line, `Task ${task.id} outcome belongs in Task Map; keep task-specific detail under Constraints or Overlap.`));
}

function generatedInputs(raw: string | undefined, line: number, out: LintDefect[]): string[] {
  const value = raw?.replace(/^[-*+]\s+Inputs:\s*/, '').trim();
  if (!value) { out.push(lint('generated-inputs', line, 'A [GENERATED] path requires a "- Inputs: <path>[, <path>...]" bullet.')); return []; }
  return value.split(',').flatMap((item) => {
    const normalized = normalizePlanPath(item.replace(/`/g, ''));
    if (normalized.path) return [normalized.path];
    out.push(lint('generated-inputs', line, `Invalid generated input "${item.trim()}": ${normalized.reason ?? 'empty'}.`));
    return [];
  });
}

/** Keep primary change detail and explicitly labelled file invariants in the owned brief. */
function changeNote(block: readonly string[]): string {
  const labelled = block.findIndex((text) => /^[-*+]\s+(?:Changes|Purpose):/.test(text));
  const continuations = (index: number) => {
    const result: string[] = [];
    for (const text of block.slice(index + 1)) {
      if (/^[-*+]\s/.test(text) || /^\S/.test(text)) break;
      if (text.trim()) result.push(text);
    }
    return result;
  };
  const detail = labelled >= 0 ? (block[labelled] ?? '').replace(/^[-*+]\s+(?:Changes|Purpose):\s*/, '').trim().replace(/;$/, '') : '';
  const fallback = block.find((text) => /^[-*+]\s+\S/.test(text) && !/^[-*+]\s+\w+:/.test(text));
  const primary = labelled >= 0 ? [detail, ...continuations(labelled)].filter(Boolean).join('\n')
    : (fallback ?? '').replace(/^[-*+]\s+/, '').trim().replace(/;$/, '');
  const invariants = block.flatMap((text, index) => /^[-*+]\s+Invariants:/.test(text)
    ? [text.replace(/^[-*+]\s+/, ''), ...continuations(index)] : []);
  return [primary, ...invariants].filter(Boolean).join('\n');
}

function excluded(line: number, value: string): LintDefect {
  return lint('change-path-excluded', line, `Change path "${value}" is under .git/ or .scratch/; implementation never writes there.`);
}

function parseVerification(lines: readonly StructuralLine[], out: LintDefect[]): ParsedPlan['verification'] {
  const empty = { automated: [], none: null, manual: [] };
  const ranges = sectionRanges(lines, '## Verification Plan');
  const range = ranges[0];
  if (ranges.length !== 1 || !range) { out.push(lint('verification-plan', null, 'Expected exactly one ## Verification Plan section.')); return empty; }
  const headings = lines.flatMap((entry, index) => entry.text.trimEnd() === '### Automated Tests' ? [index] : []);
  const owned = headings.filter((index) => index > range.start && index < range.end);
  if (owned.length !== 1) out.push(lint('automated-tests', null, 'Expected exactly one ### Automated Tests under Verification Plan.'));
  if (headings.some((index) => !owned.includes(index))) out.push(lint('automated-tests-owner', null, 'Automated Tests must belong to Verification Plan.'));
  const start = owned[0];
  if (owned.length !== 1 || start === undefined) return empty;
  const subsection = (from: number) => {
    let end = range.end;
    for (let index = from + 1; index < end; index++) if (/^#{2,3}\s+/.test(lines[index]?.text ?? '')) { end = index; break; }
    return lines.slice(from + 1, end);
  };
  const section = subsection(start);
  const automated: string[] = [];
  for (const entry of section) {
    const direct = /^-\s+`([^`]+)`\s*$/.exec(entry.text)?.[1];
    if (direct) automated.push(direct.trim());
    if (/^-\s+.*`[^`]+`.*`[^`]+`/.test(entry.text)) out.push(lint('ambiguous-command', entry.line, 'Automated-test bullet contains multiple inline-code spans.'));
  }
  const noneEntry = section.find(({ text }) => /^-\s+None:\s*\S.*$/.test(text));
  const none = noneEntry ? noneEntry.text.replace(/^-\s+None:\s*/, '').trim() : null;
  if (noneEntry) out.push(lint('automated-tests-unavailable', noneEntry.line, 'Automated tests are explicitly unavailable.'));
  // Fenced commands are not parsed into `automated`, so they cannot satisfy the section.
  if (!automated.length && !noneEntry) out.push(lint('automated-command', lines[start]?.line ?? null, 'Automated Tests requires a command or - None: <reason>.'));
  const manualIndex = lines.findIndex((entry, index) => index > range.start && index < range.end && entry.text.trimEnd() === '### Manual Verification');
  const manual = manualIndex === -1 ? [] : subsection(manualIndex).flatMap(({ text }) => /^[-*+]\s+(.+)$/.exec(text)?.[1]?.trim() ?? []);
  return { automated, none, manual };
}

function parseCriteria(lines: readonly StructuralLine[], changes: readonly PlanChange[], out: LintDefect[]): Criterion[] {
  const ranges = sectionRanges(lines, '## Success Criteria');
  if (!ranges.length) { out.push(lint('missing-success-criteria', null, 'Plan has no Success Criteria section.')); return []; }
  const range = ranges[0];
  if (ranges.length > 1 || !range) { out.push(lint('success-criteria', null, 'Expected at most one Success Criteria section.')); return []; }
  const approved = new Set(changes.map((change) => change.path));
  const ids = new Set<string>();
  const criteria: Criterion[] = [];
  let current: Criterion | null = null;
  const finish = () => { if (current) { finishCriterion(current, out); if (current.valid) criteria.push(current); } };
  for (const entry of lines.slice(range.start + 1, range.end)) {
    if (entry.text.trim().startsWith('|')) { out.push(lint('criterion-format', entry.line, 'Success Criteria requires detailed [SC#] entries.')); continue; }
    const item = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(entry.text)?.[1];
    if (item) { finish(); current = startCriterion(item, entry.line, ids, out); continue; }
    if (current) readMapping(current, entry, approved, out);
  }
  finish();
  if (!ids.size) out.push(lint('success-criteria', lines[range.start]?.line ?? null, 'Success Criteria requires at least one detailed [SC#] entry.'));
  return criteria;
}

function startCriterion(text: string, line: number, ids: Set<string>, out: LintDefect[]): Criterion {
  const id = criterionHeading(text);
  const base: Criterion = {
    id: '', title: text, line, satisfies: [], changes: [], tests: [], verify: [], evidence: null, preExisting: null, redException: null, red: null, testRationale: null,
    review: null, enforcementInfeasibility: null, retain: 'durable', retainLine: null, verifyLines: [], testsLine: null, redCommandLine: null, coveredBy: null, integration: null, mapped: false, evidenceRaw: null,
    evidenceLine: line, redLine: line, reviewLine: line, coveredLine: line,
    critical: CRITICAL.test(text), valid: false,
  };
  if (!id) { out.push(lint('criterion-id', line, 'Success criterion requires a stable [SC#] identifier.')); return base; }
  if (ids.has(id.id)) out.push(lint('criterion-id', line, `Duplicate criterion ${id.id}.`));
  ids.add(id.id);
  return { ...base, id: id.id, title: id.title, valid: true };
}

function readMapping(current: Criterion, entry: StructuralLine, approved: ReadonlySet<string>, out: LintDefect[]): void {
  const field = (name: string) => new RegExp(`^ {2,}[-*+] ${name}:\\s*(.*)$`, 'i').exec(entry.text)?.[1]?.trim();
  const satisfies = field('Satisfies');
  if (satisfies !== undefined) {
    const ids = satisfies.split(',').map((value) => value.trim());
    if (ids.some((id) => !/^REQ-[1-9]\d*$/.test(id))) {
      if (!out.some((defect) => defect.code === 'missing-satisfies' && defect.line !== null && defect.line >= current.line)) out.push(lint('missing-satisfies', entry.line, 'Satisfies requires comma-separated REQ-<n> IDs.'));
    }
    else current.satisfies = ids;
  }
  const changes = field('Changes');
  if (changes !== undefined && changes !== '') {
    current.mapped = true;
    const paths: string[] = [...current.changes];
    for (const value of changes.split(',')) {
      const normalized = normalizePlanPath(value);
      if (normalized.path && EXCLUDED_CHANGE_PATH.test(normalized.path)) out.push(excluded(entry.line, normalized.path));
      else if (!normalized.path || !approved.has(normalized.path)) out.push(lint('criterion-change-path', entry.line, `Criterion references unknown change path "${value.trim()}".`));
      if (normalized.path) paths.push(normalized.path);
    }
    current.changes = paths;
  }
  const tests = field('Tests');
  if (tests !== undefined) {
    current.testsLine ??= entry.line;
    const paths: string[] = [...current.tests];
    for (const value of tests.split(',')) {
      const normalized = normalizePlanPath(value);
      if (normalized.path) paths.push(normalized.path);
      else out.push(lint('criterion-tests-path', entry.line, `Tests requires comma-separated relative test paths; "${value.trim()}" is ${normalized.reason}.`));
    }
    current.tests = [...new Set(paths)];
  }
  // `RED exception:` cannot match: the field name must end at the colon.
  const redCommand = field('RED');
  if (redCommand !== undefined) {
    const command = /^`([^`]+)`\s*$/.exec(redCommand)?.[1]?.trim();
    if (current.redCommandLine !== null) out.push(lint('criterion-red-command', entry.line, 'Criterion requires at most one RED command.'));
    else if (!command) out.push(lint('criterion-red-command', entry.line, 'RED requires exactly one inline-code command.'));
    else current.red = command;
    current.redCommandLine = entry.line;
  }
  const verify = field('Verify');
  if (verify !== undefined) {
    current.mapped = true;
    const command = /^`([^`]+)`\s*(\[FINAL\])?\s*$/.exec(verify);
    if (!command?.[1]) out.push(lint('criterion-verify', entry.line, 'Verify requires exactly one inline-code command, optionally followed by [FINAL].'));
    else if (/\s*\[FINAL\]\s*$/.test(command[1])) {
      out.push(lint('final-in-code-span', entry.line, `[FINAL] sits inside the code span; write \`${command[1].replace(/\s*\[FINAL\]\s*$/, '')}\` [FINAL] with the marker after the closing backtick.`));
    } else {
      const next: PlanCommand = { command: command[1].trim(), final: Boolean(command[2]) };
      current.verify = [...current.verify, next];
      current.verifyLines = [...current.verifyLines, entry.line];
    }
  }
  const evidence = /^ {2,}[-*+] Evidence:\s*(\S+)\s*$/.exec(entry.text)?.[1];
  if (evidence) {
    if (current.evidenceRaw !== null) out.push(lint('criterion-evidence', entry.line, 'Criterion requires exactly one Evidence mapping.'));
    current.evidenceRaw = evidence.toLowerCase();
    current.evidenceLine = entry.line;
    current.evidence = EVIDENCE.find((item) => item === current.evidenceRaw) ?? null;
  }
  const preExisting = field('Pre-existing');
  if (preExisting !== undefined) {
    if (!/^(yes|no)$/i.test(preExisting)) out.push(lint('criterion-format', entry.line, 'Pre-existing must be yes or no.'));
    current.preExisting = /^yes$/i.test(preExisting);
  }
  const rationale = field('Test rationale');
  if (rationale !== undefined) {
    if (current.testRationale !== null) out.push(lint('criterion-test-rationale', entry.line, 'Criterion requires exactly one Test rationale.'));
    if (rationale.length < 12) out.push(lint('criterion-test-rationale', entry.line, 'Test rationale must concretely explain signal and regression value or why a retained test is low-signal.'));
    current.testRationale = rationale;
  }
  const review = field('Review');
  if (review !== undefined) { current.review = review; current.reviewLine = entry.line; }
  const red = field('RED exception');
  if (red !== undefined) { current.redException = red.toLowerCase(); current.redLine = entry.line; }
  const integration = field('Integration');
  if (integration !== undefined) current.integration = integration;
  const enforcement = field('Enforcement infeasibility');
  if (enforcement !== undefined && enforcement.trim()) current.enforcementInfeasibility = enforcement.trim();
  const retain = field('Retain');
  if (retain !== undefined) {
    if (current.retainLine !== null) out.push(lint('criterion-format', entry.line, 'Criterion requires exactly one Retain.'));
    current.retainLine = entry.line;
    const value = retain.replace(/`/g, '').trim().toLowerCase();
    if (value === 'durable' || value === 'transient') current.retain = value;
    else out.push(lint('criterion-format', entry.line, 'Retain must be durable or transient.'));
  }
  const covered = field('Covered by');
  if (covered !== undefined) { current.coveredBy = covered.replace(/`/g, '').trim().toUpperCase() || null; current.coveredLine = entry.line; }
}

/** Transient tests are trimmed after the final review, so a durable criterion or the FINAL gate must keep covering the behaviour. */
function lintTransientCoverage(criteria: readonly Criterion[], finalCommands: readonly string[], out: LintDefect[]): void {
  const byId = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  for (const criterion of criteria) {
    const target = criterion.coveredBy;
    const fail = (message: string) => out.push(lint('transient-coverage', criterion.coveredLine, `Criterion ${criterion.id} ${message}`));
    if (criterion.retain === 'durable') { if (target !== null) fail('sets Covered by without Retain: transient.'); continue; }
    if (target === null) { fail('is Retain: transient and requires Covered by: <SC#|FINAL>.'); continue; }
    if (target !== 'FINAL' && !isCriterionId(target)) { fail(`names Covered by "${target}"; use a criterion ID (SC#) or FINAL.`); continue; }
    if (target === 'FINAL') { if (!finalCommands.length) fail('is Covered by FINAL, but the plan has no [FINAL] Verify command.'); continue; }
    const covering = byId.get(target);
    if (!covering) fail(`is Covered by unknown criterion ${target}.`);
    else if (covering.retain === 'transient') fail(`is Covered by ${target}, which is also transient; name a durable criterion or FINAL.`);
  }
}

/** Trim is file-level, so a transient test must live in a [NEW] transient-named file that no durable criterion lists; support-shaped paths are exempt as a hint, and a file shared with a durable criterion is never trimmed. */
function lintTransientTestPaths(criteria: readonly Criterion[], changes: readonly PlanChange[], out: LintDefect[]): void {
  const actions = new Map(changes.map((change) => [change.path, change.action]));
  const durable = new Set(criteria.filter((criterion) => criterion.retain === 'durable').flatMap((criterion) => criterion.changes));
  for (const criterion of criteria) {
    if (criterion.retain !== 'transient') continue;
    for (const path of criterion.tests.filter((file) => !isTestSupportPath(file))) {
      const fail = (reason: string) => out.push(lint('transient-test-path', criterion.retainLine ?? criterion.line, `Criterion ${criterion.id} transient test ${path} ${reason}`));
      const action = actions.get(path);
      if (action !== 'NEW') fail(`is [${action ?? 'unknown'}]; transient tests need a [NEW] file.`);
      else if (!/transient/i.test(path.slice(path.lastIndexOf('/') + 1))) fail('needs "transient" in its file name.');
      else if (durable.has(path)) fail('is also listed by a durable criterion; isolate transient tests in their own file.');
    }
  }
}

/** A test-like Changes path outside every `Tests:` gets no RED, trim, or envelope handling, so the author declares it or confirms it is not a test. */
function lintUndeclaredTestPaths(criteria: readonly Criterion[], out: LintDefect[]): void {
  const declared = new Set(criteria.flatMap((criterion) => criterion.tests));
  const warned = new Set<string>();
  for (const criterion of criteria) {
    for (const path of criterion.changes) {
      if (declared.has(path) || warned.has(path) || !isTestPath(path) || isTestSupportPath(path)) continue;
      warned.add(path);
      out.push(lint('undeclared-test-path', criterion.line, `Criterion ${criterion.id} changes test-like path ${path} that no criterion lists in Tests:.`));
    }
  }
}

/** Criterion IDs plus finding IDs recorded under Review Findings, which governedText strips. */
function collectPlanIds(lines: readonly StructuralLine[], criteria: readonly Criterion[]): string[] {
  const ids = new Set(criteria.map((criterion) => criterion.id));
  for (const range of sectionRanges(lines, RESOLUTION_HEADING)) {
    for (const { text } of lines.slice(range.start + 1, range.end)) for (const id of text.match(FINDING_ID) ?? []) ids.add(id.toUpperCase());
  }
  return [...ids].sort();
}

/** Tests outlive plans, so Verify commands and test file names must not carry plan-scoped IDs. */
function lintPlanIdNames(criteria: readonly Criterion[], changes: readonly PlanChange[], ids: readonly string[], out: LintDefect[]): void {
  const pattern = planIdPattern(ids);
  if (!pattern) return;
  const check = (where: string, value: string, line: number) => {
    const id = pattern.exec(value)?.[0];
    if (id) out.push(lint('plan-id-in-test-name', line, `${where} names plan ID ${id.toUpperCase()}; name the behavior instead.`));
  };
  for (const criterion of criteria) {
    criterion.verify.forEach((item, index) => check(`Criterion ${criterion.id} Verify`, item.command, criterion.verifyLines[index] ?? criterion.line));
    if (criterion.red !== null) check(`Criterion ${criterion.id} RED`, criterion.red, criterion.redCommandLine ?? criterion.line);
  }
  const declared = new Set(criteria.flatMap((criterion) => criterion.tests));
  for (const change of changes) {
    if (declared.has(change.path)) check(`Test path ${change.path}`, change.path.slice(change.path.lastIndexOf('/') + 1), change.line);
  }
}

/** `- Seams: <entry>[, <entry>...]` bullets directly under Verification Plan, before its first subsection. */
function parseSeamDeclarations(lines: readonly StructuralLine[]): { value: string }[] {
  const range = sectionRanges(lines, '## Verification Plan')[0];
  if (!range) return [];
  const declarations: { value: string }[] = [];
  for (const { text } of lines.slice(range.start + 1, range.end)) {
    if (/^###\s/.test(text)) break;
    const value = /^[-*+]\s+Seams:\s*(.*?)\s*$/i.exec(text)?.[1];
    if (value !== undefined) declarations.push({ value });
  }
  return declarations;
}

function seamsFromDeclarations(declarations: readonly { value: string }[]): string[] {
  const seams: string[] = [];
  for (const { value } of declarations) {
    if (/^none$/i.test(value)) continue;
    // A comma inside a code span belongs to its entry.
    for (const item of value.match(/(?:`[^`]*`|[^,])+/g) ?? []) {
      const seam = item.replace(/`/g, '').trim();
      if (seam) seams.push(seam);
    }
  }
  return seams;
}

function finishCriterion(current: Criterion, out: LintDefect[]): void {
  if (!current.satisfies?.length && !out.some((defect) => defect.code === 'missing-satisfies' && defect.line !== null && defect.line >= current.line)) out.push(lint('missing-satisfies', current.line, 'Criterion requires Satisfies: REQ-<n>.'));
  const name = current.id || 'without an ID';
  if (!current.mapped) out.push(lint('criterion-mapping', current.line, 'Criterion requires Changes or Verify mapping.'));
  if (current.evidenceRaw === null) out.push(lint('criterion-evidence', current.line, `Criterion ${name} requires exactly one Evidence mapping: red, verify, or review.`));
  else if (!current.evidence) out.push(lint('criterion-evidence', current.evidenceLine, `Unknown Evidence class "${current.evidenceRaw}"; accepted classes are red, verify, review.`));
  if (current.tests.length > 0 && current.retain === 'durable' && current.testRationale === null) out.push(lint('criterion-test-rationale', current.line, 'Criterion with durable declared tests requires a Test rationale.'));
  if (current.redException !== null && (!RED_EXCEPTIONS.includes(current.redException) || current.evidence !== 'red')) {
    out.push(lint('criterion-red-exception', current.redLine, `RED exception must be ${RED_EXCEPTIONS.join(' or ')} on an Evidence: red criterion.`));
  }
  const changes = new Set(current.changes);
  for (const path of current.tests.filter((item) => !changes.has(item))) {
    out.push(lint('criterion-tests-path', current.testsLine ?? current.line, `Criterion ${name} Tests path ${path} is not in its Changes.`));
  }
  if (current.evidence === 'red' && current.redException === null && !current.tests.length) {
    out.push(lint('criterion-red-test-path', current.line, `Criterion ${name} uses red evidence but declares no Tests: path; its red evidence downgrades to verify.`));
  }
  if (current.evidence === 'red' && current.redException === null && current.red === null) {
    out.push(lint('red-downgraded', current.line, `Criterion ${name} declares no RED: \`<command>\`; its red evidence downgrades to verify.`));
  }
  if (current.retainLine === null && current.tests.length) {
    out.push(lint('criterion-retain-required', current.line, `Criterion ${name} changes tests; state Retain: transient or Retain: durable (durable tests meet the durable bar in the plan template).`));
  }
  if (current.evidence !== 'review') return;
  if (current.review === null) { out.push(lint('criterion-review', current.line, 'Review evidence requires Review: <artifact>; scenario: <scenario>; pass: <observable condition>.')); return; }
  // Each label needs a non-empty value up to the next `;`.
  if (!/(?:artifact|file|path)\s*:\s*[^;\s]/i.test(current.review)) out.push(lint('criterion-review', current.reviewLine, 'Review must name the artifact with artifact:, file:, or path:.'));
  if (!/scenario\s*:\s*[^;\s]/i.test(current.review)) out.push(lint('criterion-review', current.reviewLine, 'Review must name a bounded scenario with scenario:.'));
  if (!/(?:pass|observable)\s*:\s*[^;\s]/i.test(current.review)) out.push(lint('criterion-review', current.reviewLine, 'Review must name the observable pass condition with pass: or observable:.'));
  if (current.critical && current.enforcementInfeasibility === null) {
    out.push(lint('criterion-critical-review', current.line, 'Critical correctness, safety, recovery, durability, or protocol review evidence requires Enforcement infeasibility: <reason>.'));
  }
}

// SECTION: Task graph

function lintTaskSections(tasks: readonly DraftTask[], out: LintDefect[]): void {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) out.push(lint('duplicate-id', task.line, `Duplicate task ${task.id}.`));
    else seen.add(task.id);
    if (!task.paths.length) out.push(lint('task-ownership', task.line, `Task ${task.id} owns no file change.`));
  }
}

function lintTasks(tasks: readonly DraftTask[], changes: readonly PlanChange[], criteria: readonly Criterion[], out: LintDefect[]): PlanWarning[] {
  const byId = new Map<string, DraftTask>();
  for (const task of tasks) {
    byId.set(task.id, task);
    const prose = task.summary.replace(/`[^`]*`/g, '');
    if (!prose.trim() || PROSE_PLACEHOLDER.test(prose) || isFillerNote(task.summary)) {
      out.push(lint('task-summary', task.summaryLine, `Task ${task.id} requires a meaningful plain-language Outcome in its Task Map row.`));
    }
    if (task.prerequisitesLine === null) out.push(lint('missing-prerequisite', task.line, `Task ${task.id} requires Prerequisites: none or task IDs in its Task Map row.`));
    for (const id of task.prerequisites) {
      if (id === task.id || !tasks.some((other) => other.id === id)) out.push(lint('missing-prerequisite', task.prerequisitesLine, `Task ${task.id} lists ${id === task.id ? 'itself' : `unknown task ${id}`} in its Task Map Prerequisites cell.`));
    }
  }
  const ancestors = taskAncestors(byId, out);
  lintTaskCriteria(tasks, criteria, out);
  for (const task of tasks) {
    for (const { path, inputs } of task.generated) {
      for (const input of inputs) {
        if (changes.some((change) => change.action === 'DELETE' && change.path.toLowerCase() === input.toLowerCase())) {
          out.push(lint('generated-inputs', task.line, `Task ${task.id} generates ${path} from ${input}, which the plan deletes.`));
          continue;
        }
        // An input no task owns is a pre-existing file; a self-owned input needs no ordering.
        const producer = tasks.find((other) => other.paths.some((owned) => owned.toLowerCase() === input.toLowerCase()));
        if (producer && producer.id !== task.id && !ancestors.get(task.id)?.has(producer.id)) {
          out.push(lint('generated-inputs', task.line, `Task ${task.id} generates ${path} from ${input}, produced by ${producer.id}; add ${producer.id} to its Task Map Prerequisites cell as a direct or transitive prerequisite.`));
        }
      }
    }
  }
  return lintOverlaps(tasks, ancestors, out);
}

/** Write paths shared by tasks with no transitive Task Map prerequisite path warn unless either task justifies them with Overlap:. */
function lintOverlaps(tasks: readonly DraftTask[], ancestors: ReadonlyMap<string, ReadonlySet<string>>, out: LintDefect[]): PlanWarning[] {
  // NOTE: case-insensitive filesystems make case variants one file.
  const owned = tasks.map((task) => new Map(task.paths.map((path) => [path.toLowerCase(), path] as const)));
  const justified = tasks.map((task) => new Set(task.overlaps.map(({ path }) => path.toLowerCase())));
  tasks.forEach((task, index) => task.overlaps.forEach(({ path }, entry) => {
    if (!owned[index]?.has(path.toLowerCase())) out.push(lint('task-overlap', task.overlapLines[entry] ?? task.line, `Task ${task.id} justifies an overlap on "${path}", which it does not write.`));
  }));
  const warnings: PlanWarning[] = [];
  tasks.forEach((first, i) => tasks.forEach((second, j) => {
    if (j <= i || ancestors.get(first.id)?.has(second.id) || ancestors.get(second.id)?.has(first.id)) return;
    for (const [folded, path] of owned[i] ?? []) {
      const other = owned[j]?.get(folded);
      if (other === undefined || justified[i]?.has(folded) || justified[j]?.has(folded)) continue;
      warnings.push({ kind: 'overlap', tasks: [first.id, second.id], path });
      const alias = other === path ? '' : ` (as "${other}" in ${second.id})`;
      out.push(lint('overlap', second.line, `Tasks ${first.id} and ${second.id} both write "${path}"${alias} with no prerequisite path between them; add an entry to Task Map Prerequisites, merge the tasks, or add "- Overlap: ${path} — <reason>".`));
    }
  }));
  return warnings;
}

/** Transitive prerequisites per task; reports each cycle entry point once. */
function taskAncestors(byId: ReadonlyMap<string, DraftTask>, out: LintDefect[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const visit = (task: DraftTask): Set<string> => {
    const known = result.get(task.id);
    if (known) return known;
    if (visiting.has(task.id)) { out.push(lint('cycle', task.line, `Task ${task.id} is part of a prerequisite cycle in the Task Map.`)); return new Set(); }
    visiting.add(task.id);
    const set = new Set<string>();
    for (const id of task.prerequisites) {
      const parent = byId.get(id);
      if (!parent || parent === task) continue;
      set.add(id);
      for (const ancestor of visit(parent)) set.add(ancestor);
    }
    visiting.delete(task.id);
    result.set(task.id, set);
    return set;
  };
  for (const task of byId.values()) visit(task);
  return result;
}

function lintTaskCriteria(tasks: readonly DraftTask[], criteria: readonly Criterion[], out: LintDefect[]): void {
  const known = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const owner = new Map<string, string>();
  for (const task of tasks) {
    const line = task.criteriaLine ?? task.line;
    if (!task.criteria.length) out.push(lint('task-criteria', line, `Task ${task.id} requires one or more acceptance criteria in its Task Map Criteria cell.`));
    for (const id of task.criteria) {
      if (!isCriterionId(id)) { out.push(lint('task-criteria', line, `Task ${task.id} names invalid criterion ${id}; use SC[1-9][0-9]*.`)); continue; }
      const criterion = known.get(id);
      if (!criterion) { out.push(lint('task-criteria', line, `Task ${task.id} names unknown criterion ${id}.`)); continue; }
      const prior = owner.get(id);
      if (prior) { out.push(lint('task-criteria', line, `Criterion ${id} is mapped to both ${prior} and ${task.id}; use - Integration: <reason> for a cross-task criterion.`)); continue; }
      owner.set(id, task.id);
      if (criterion.integration !== null) out.push(lint('task-criteria', criterion.line, `Criterion ${id} is mapped to ${task.id} and marked Integration; choose one.`));
      // Admission requires each evidence row path in Changes, so a task-owned criterion without Changes can never pass.
      else if (!criterion.changes.length) out.push(lint('criterion-task-changes', criterion.line, `Criterion ${id} is task-owned but has no Changes; list the task paths it proves in Changes, or mark it Integration: <reason> with Verify.`));
      const foreign = criterion.changes.filter((path) => !task.paths.includes(path));
      if (foreign.length) out.push(lint('task-criteria', criterion.line, `Criterion ${id} of ${task.id} changes ${foreign.join(', ')} outside the task; move the path or mark the criterion Integration.`));
    }
  }
  if (!tasks.length) return;
  for (const criterion of criteria) {
    if (owner.has(criterion.id)) continue;
    if (criterion.integration === null) out.push(lint('task-criteria', criterion.line, `Criterion ${criterion.id} maps to no Task Map row; add it to a task's Criteria cell or provide Integration: <reason>.`));
    else if (!criterion.integration.trim() || !criterion.verify.length) out.push(lint('task-criteria', criterion.line, `Integration criterion ${criterion.id} requires a reason and a Verify command.`));
  }
}

// SECTION: Derived task views

export type TaskMapRow = { id: string; outcome: string; prerequisites: readonly string[]; criteria: readonly string[]; paths: readonly string[]; overlap: readonly { path: string; tasks: readonly string[] }[] };

/** One row per task in Task Map order; Overlap names each written path that other tasks also write. */
export function taskMapRows(plan: Pick<ParsedPlan, 'tasks'>): TaskMapRow[] {
  return plan.tasks.map((task) => {
    return {
      id: task.id,
      outcome: task.summary ? `${task.title} — ${task.summary}` : task.title,
      prerequisites: task.prerequisites,
      criteria: task.criteria,
      paths: task.paths,
      // NOTE: case-insensitive filesystems make case variants one file, as in the overlap lint.
      overlap: task.paths.flatMap((path) => {
        const tasks = plan.tasks.filter((other) => other !== task && other.paths.some((owned) => owned.toLowerCase() === path.toLowerCase())).map((other) => other.id);
        return tasks.length ? [{ path, tasks }] : [];
      }),
    };
  });
}

/** One human line per task in plan order: `T2 — title (after T1)` or `(start)`. */
export function taskExecutionSummary(tasks: readonly PlanTask[]): string[] {
  return tasks.map((task) => `${task.id} — ${task.title} (${task.prerequisites.length ? `after ${task.prerequisites.join(', ')}` : 'start'})`);
}

export type TaskBrief = {
  task: PlanTask;
  changes: readonly PlanChange[];
  criteria: readonly PlanCriterion[];
  prerequisites: readonly PlanTask[];
  dependents: readonly PlanTask[];
  summary: readonly string[];
};

/** The focused selection a task writer receives; the full plan stays read-only context. */
export function selectTaskBrief(plan: ParsedPlan, id: string): TaskBrief | null {
  const task = plan.tasks.find((item) => item.id === id);
  if (!task) return null;
  const graphTask = (item: PlanTask): PlanTask => ({ ...item, constraints: [] });
  // An overlapped path has one change entry per owning task; prefer the entry under this task's own heading.
  const next = Math.min(...plan.tasks.map((item) => item.line).filter((line) => line > task.line));
  const inTask = (change: PlanChange) => change.line > task.line && change.line < next;
  return {
    task,
    changes: plan.changes.filter((change) => task.paths.includes(change.path)
      && (inTask(change) || !plan.changes.some((other) => other.path === change.path && inTask(other)))),
    criteria: plan.criteria.filter((criterion) => task.criteria.includes(criterion.id)),
    prerequisites: plan.tasks.filter((item) => task.prerequisites.includes(item.id)).map(graphTask),
    dependents: plan.tasks.filter((item) => item.prerequisites.includes(task.id)).map(graphTask),
    summary: taskExecutionSummary(plan.tasks),
  };
}

function lintAutomatedDuplicates(automated: readonly string[], criteria: readonly Criterion[], lines: readonly StructuralLine[], out: LintDefect[]): void {
  const verifies = new Set(criteria.flatMap((criterion) => criterion.verify.map((item) => item.command)));
  for (const command of automated) {
    if (!verifies.has(command)) continue;
    const line = lines.find((entry) => entry.text.includes(`\`${command}\``) && /^-\s+`/.test(entry.text))?.line ?? null;
    out.push(lint('automated-test-duplicates-verify', line, `Automated test \`${command}\` repeats a criterion Verify command; list only extra commands.`));
  }
}

function lintNotes(lines: readonly StructuralLine[], out: LintDefect[]): void {
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
export function incrementPathMatches(file: string, scope: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '');
  const target = normalize(file), pattern = normalize(scope);
  if (target.split('/').some((part) => part === '.' || part === '..') || target.startsWith('/') || /^[a-z]:/i.test(target)) return false;
  if (pattern.endsWith('/')) return target.startsWith(pattern);
  const braces = /\{([^{}]+)\}/.exec(pattern);
  if (braces) return braces[1]!.split(',').some((part) => incrementPathMatches(target, pattern.replace(braces[0], part)));
  let expression = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; expression += '(?:.*/)?'; }
      else expression += '.*';
    } else if (ch === '*') expression += '[^/]*';
    else if (ch === '?') expression += '[^/]';
    else expression += ch.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(`^${expression}$`).test(target);
}

/** Admission uses the journal-owned design binding, never artifact metadata as approval. */
export function validateDesignTraceability(plan: ParsedPlan, binding: { path: string; revision: string; increment: string; contract: Readonly<Record<string, string>>; paths?: readonly string[] }): string[] {
  const trace = plan.traceability;
  if (!trace) return ['Technical-Design Traceability is required for a design-bound plan.'];
  const value = (name: string) => Object.entries(trace).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]?.replace(/`/g, '').trim();
  const defects: string[] = [];
  for (const change of plan.changes ?? []) if (binding.paths && !binding.paths.some((owned) => incrementPathMatches(change.path, owned))) defects.push(`Plan path ${change.path} is outside increment ${binding.increment} scope.`);
  if (value('Approved revision') !== undefined) {
    const parent = plan.box?.['Parent']?.replace(/`/g, '').trim();
    if (parent !== `${binding.path} · ${binding.increment}`) defects.push(`Parent must equal ${binding.path} · ${binding.increment}.`);
    if (value('Approved revision') !== binding.revision) defects.push(`Approved revision must equal ${binding.revision}.`);
    const inherited = value('Increment ID and inherited contract') ?? '';
    if (!new RegExp(`^${binding.increment}(?:\\s|$)`).test(inherited)) defects.push(`Increment ID and inherited contract must name ${binding.increment}.`);
    for (const [key, expected] of Object.entries(binding.contract)) if (!inherited.includes(expected)) defects.push(`Inherited contract must cover ${key}: ${expected}.`);
    for (const key of ['Prerequisite evidence', 'Acceptance mapping']) if (!value(key)) defects.push(`Technical-Design Traceability requires ${key}.`);
    return defects;
  }
  for (const [key, expected] of Object.entries({ Design: binding.path, Revision: binding.revision, Increment: binding.increment })) {
    if (value(key) !== expected) defects.push(`Technical-Design Traceability ${key} must equal ${expected}.`);
  }
  for (const [key, expected] of Object.entries(binding.contract)) {
    if (value(key) !== expected) defects.push(`Technical-Design Traceability must inherit ${key}: ${expected}.`);
  }
  return defects;
}

export function parentPin(source: string): { kind: 'spec'; path: string; hash: string } | { kind: 'design'; path: string; increment: string } | null {
  const value = parseSummaryBox(source)?.entries.find(entry => entry.label === 'Parent')?.value.trim();
  if (!value) return null;
  const spec = SPEC_PIN_VALUE.exec(value);
  if (spec) return { kind: 'spec', path: spec[1]!, hash: `sha256:${spec[2]!}` };
  const design = DESIGN_PIN_VALUE.exec(value);
  return design ? { kind: 'design', path: design[1]!, increment: design[2]! } : null;
}

export function validateSpecTraceability(plan: ParsedPlan, reqIds: readonly string[]): LintDefect[] {
  const known = new Set(reqIds), cited = new Set<string>(), defects: LintDefect[] = [];
  for (const criterion of plan.criteria) for (const id of criterion.satisfies ?? []) {
    cited.add(id);
    if (!known.has(id)) defects.push(lint('unknown-requirement', criterion.line, `Criterion ${criterion.id} cites unknown requirement ${id}.`));
  }
  for (const id of known) if (!cited.has(id)) defects.push(lint('unsatisfied-requirement', null, `Requirement ${id} is not cited by a criterion.`));
  return defects;
}
