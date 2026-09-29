// Plan parse + lint + governed text (spec §8.1; ports legacy plan/lint.mjs, plan/structure.mjs,
// lib/summary-box.mjs, lib/filler.mjs). Shared Markdown helpers are exported for domain/design.ts.

import type {
  ChangeAction, EvidenceClass, LintDefect, LintDefectCode, ParsedPlan, PlanChange, PlanCommand, PlanCriterion,
} from './types.ts';

export const RESOLUTION_HEADING = '## Review Findings & Resolutions';

// SECTION: Lint severity

const unreachable = (value: never): never => { throw new Error(`unhandled lint code: ${String(value)}`); };

/** Closed mapping; a new code fails to compile until it is classified. */
export function lintSeverity(code: LintDefectCode): LintDefect['severity'] {
  switch (code) {
    case 'placeholder': case 'ambiguous-command': case 'automated-tests-unavailable': case 'missing-success-criteria':
    case 'criterion-red-test-path':
      return 'warning';
    case 'missing-summary-box': case 'summary-label': case 'leftover-placeholder': case 'filler-note': case 'proposed-changes':
    case 'change-heading': case 'unknown-change-marker': case 'invalid-change-path': case 'duplicate-change-path':
    case 'change-path-excluded': case 'generated-command': case 'verification-plan': case 'automated-tests':
    case 'automated-tests-owner': case 'automated-command': case 'automated-test-duplicates-verify': case 'success-criteria':
    case 'criterion-format': case 'criterion-id': case 'criterion-mapping': case 'criterion-change-path': case 'criterion-verify':
    case 'final-in-code-span': case 'criterion-evidence': case 'criterion-test-rationale': case 'criterion-red-exception':
    case 'criterion-review': case 'criterion-critical-review': case 'missing-section': case 'missing-increment-details':
    case 'missing-increment-field': case 'invalid-priority': case 'duplicate-id': case 'missing-increments':
    case 'invalid-id-sequence': case 'invalid-priority-order': case 'missing-prerequisite': case 'cycle': case 'execution-status':
      return 'defect';
    default:
      return unreachable(code);
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

/** Hashing input: the source without the driver-owned trailing resolution section. */
export function governedPlanText(source: string): string {
  return withoutSections(source, [RESOLUTION_HEADING]);
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

/** H1, one blank line, contiguous `> **Label:** value` lines, then the first `##`; null when absent. */
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

// SECTION: Plan parse

const BOX_LABELS = ['TL;DR', 'Parent', 'Decide', 'Risk', 'Scope'];
/** Parent forms: the user's request, an external spec pinned by checksum, or a design increment. */
export const PARENT_VALUE = /^(?:user request|`?[^`\s]+`? · (?:sha256:[0-9a-f]{64}|I\d{2}))$/;
const ACTION_HEADING = /^####\s+\[(NEW|MODIFY|DELETE|GENERATED)\]\s+(.+?)\s*$/;
const MARKER_HEADING = /^####\s+\[([A-Z][A-Z-]*)\]\s+\S/;
const EXCLUDED_CHANGE_PATH = /^(?:\.git|\.scratch)(?:\/|$)/;
const PROSE_PLACEHOLDER = /\b(?:TODO|TBD|implement later|fill in)\b/i;
const EVIDENCE: readonly EvidenceClass[] = ['red', 'verify', 'review'];
const RED_EXCEPTIONS = ['behavior-preserving', 'already-satisfied'];
// Common test-path conventions; a heuristic, so a miss only warns.
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|specs?)\/|[._-](?:test|spec)s?\.[^/]+$/i;
const CRITICAL = /\b(?:correctness|safety|recovery|durability|protocol)\b/i;

type Criterion = PlanCriterion & { mapped: boolean; evidenceRaw: string | null; evidenceLine: number; redLine: number; reviewLine: number; critical: boolean; valid: boolean };

export type PlanResult =
  | { ok: true; plan: ParsedPlan; warnings: LintDefect[] }
  | { ok: false; defects: LintDefect[]; warnings: LintDefect[] };

export type PlanOptions = { placeholders?: PlaceholderVocabulary };

/** Parses and lints a plan; any defect-severity diagnostic fails the parse. */
export function parsePlan(source: string, options: PlanOptions = {}): PlanResult {
  const lines = structuralLines(source);
  const out: LintDefect[] = [];
  const changes = parseChanges(lines, out);
  const verification = parseVerification(lines, out);
  const criteria = parseCriteria(lines, changes, out);
  lintAutomatedDuplicates(verification.automated, criteria, lines, out);
  lintNotes(lines, out);
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
    criteria: criteria.map(({ id, title, line, changes: paths, verify, evidence, preExisting, redException, testRationale, review, enforcementInfeasibility }) =>
      ({ id, title, line, changes: paths, verify, evidence, preExisting, redException, testRationale, review, enforcementInfeasibility })),
    changes,
    verification,
    finalCommands: criteria.flatMap((criterion) => criterion.verify.filter((item) => item.final).map((item) => item.command)),
    traceability: keyValues(lines, '## Technical-Design Traceability'),
    governedText: governedPlanText(source),
  };
  return { ok: true, plan, warnings };
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

function parseChanges(lines: readonly StructuralLine[], out: LintDefect[]): PlanChange[] {
  const ranges = sectionRanges(lines, '## Proposed Changes');
  const range = ranges[0];
  if (ranges.length !== 1 || !range) {
    out.push(lint('proposed-changes', null, 'Expected exactly one ## Proposed Changes section.'));
    return [];
  }
  const changes: PlanChange[] = [];
  const seen = new Set<string>();
  const body = lines.slice(range.start + 1, range.end);
  body.forEach((entry, offset) => {
    const match = ACTION_HEADING.exec(entry.text);
    if (!match) {
      const marker = MARKER_HEADING.exec(entry.text)?.[1];
      if (marker) out.push(lint('unknown-change-marker', entry.line, `Unknown change marker [${marker}]; use [NEW], [MODIFY], [DELETE], or [GENERATED].`));
      return;
    }
    const action = match[1] as ChangeAction;
    const normalized = normalizePlanPath(match[2] ?? '');
    if (!normalized.path) { out.push(lint('invalid-change-path', entry.line, `Invalid change path: ${normalized.reason ?? 'empty'}.`)); return; }
    if (seen.has(normalized.path)) out.push(lint('duplicate-change-path', entry.line, `Change path "${normalized.path}" appears more than once.`));
    seen.add(normalized.path);
    if (EXCLUDED_CHANGE_PATH.test(normalized.path)) out.push(excluded(entry.line, normalized.path));
    const block: string[] = [];
    for (const next of body.slice(offset + 1)) {
      if (/^#{2,4}\s+/.test(next.text)) break;
      block.push(next.text);
    }
    const command = action === 'GENERATED' ? /^[-*+]\s+Command:\s*`([^`]+)`\s*$/.exec(block.map((text) => text.trim()).find((text) => /^[-*+]\s+Command:/.test(text)) ?? '')?.[1]?.trim() ?? null : null;
    if (action === 'GENERATED' && !command) out.push(lint('generated-command', entry.line, 'A [GENERATED] path requires a "- Command: `<generator>`" bullet.'));
    changes.push({ action, path: normalized.path, note: changeNote(block), command, line: entry.line });
  });
  if (!changes.length && !out.some((item) => item.code === 'invalid-change-path' || item.code === 'unknown-change-marker')) {
    out.push(lint('change-heading', lines[range.start]?.line ?? null, 'Proposed Changes requires an H4 action heading.'));
  }
  return changes;
}

/** The `Changes:`/`Purpose:` bullet (or its first sub-bullet), else the first bullet. */
function changeNote(block: readonly string[]): string {
  const labelled = block.findIndex((text) => /^[-*+]\s+(?:Changes|Purpose):/.test(text));
  let note = '';
  if (labelled !== -1) {
    note = (block[labelled] ?? '').replace(/^[-*+]\s+(?:Changes|Purpose):\s*/, '').trim();
    if (!note) note = (block.slice(labelled + 1).find((text) => /^\s+[-*+]\s+\S/.test(text)) ?? '').replace(/^\s+[-*+]\s+/, '').trim();
  } else note = (block.find((text) => /^[-*+]\s+\S/.test(text)) ?? '').replace(/^[-*+]\s+/, '').trim();
  return note.replace(/;$/, '');
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
  const id = /^\[SC([1-9]\d*)\]\s+/.exec(text);
  const base: Criterion = {
    id: '', title: text, line, changes: [], verify: [], evidence: null, preExisting: null, redException: null, testRationale: null,
    review: null, enforcementInfeasibility: null, mapped: false, evidenceRaw: null, evidenceLine: line, redLine: line, reviewLine: line,
    critical: CRITICAL.test(text), valid: false,
  };
  if (!id?.[1]) { out.push(lint('criterion-id', line, 'Success criterion requires a stable [SC#] identifier.')); return base; }
  if (ids.has(id[1])) out.push(lint('criterion-id', line, `Duplicate criterion SC${id[1]}.`));
  ids.add(id[1]);
  return { ...base, id: `SC${id[1]}`, title: text.slice(id[0].length).trim(), valid: true };
}

function readMapping(current: Criterion, entry: StructuralLine, approved: ReadonlySet<string>, out: LintDefect[]): void {
  const field = (name: string) => new RegExp(`^ {2,}[-*+] ${name}:\\s*(.*)$`, 'i').exec(entry.text)?.[1]?.trim();
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
  const enforcement = field('Enforcement infeasibility');
  if (enforcement !== undefined && enforcement.trim()) current.enforcementInfeasibility = enforcement.trim();
}

function finishCriterion(current: Criterion, out: LintDefect[]): void {
  const name = current.id || 'without an ID';
  if (!current.mapped) out.push(lint('criterion-mapping', current.line, 'Criterion requires Changes or Verify mapping.'));
  if (current.evidenceRaw === null) out.push(lint('criterion-evidence', current.line, `Criterion ${name} requires exactly one Evidence mapping: red, verify, or review.`));
  else if (!current.evidence) out.push(lint('criterion-evidence', current.evidenceLine, `Unknown Evidence class "${current.evidenceRaw}"; accepted classes are red, verify, review.`));
  if (current.testRationale === null) out.push(lint('criterion-test-rationale', current.line, 'Criterion requires a concrete Test rationale describing retained RED signal or why a new retained test is low-signal.'));
  if (current.redException !== null && (!RED_EXCEPTIONS.includes(current.redException) || current.evidence !== 'red')) {
    out.push(lint('criterion-red-exception', current.redLine, `RED exception must be ${RED_EXCEPTIONS.join(' or ')} on an Evidence: red criterion.`));
  }
  if (current.evidence === 'red' && current.redException === null && current.changes.length && !current.changes.some((file) => TEST_PATH.test(file))) {
    out.push(lint('criterion-red-test-path', current.line, `Criterion ${name} uses red evidence but its Changes line names no conventional test path.`));
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
  const notes = lines.slice(range.start + 1, range.end).flatMap((entry) => {
    const note = /^[-*+]\s+(?:Changes|Purpose):[ \t]*(.*)$/.exec(entry.text)?.[1]?.trim();
    return note ? [{ note, line: entry.line }] : [];
  });
  notes.forEach(({ note, line }, index) => {
    const siblings = notes.filter((_item, other) => other !== index).map((item) => item.note);
    if (isFillerNote(note, siblings)) out.push(lint('filler-note', line, `Change note "${note}" is filler; say what changes in this file.`));
  });
}
