// Plan parse + lint + governed text (spec §8.1). Shared Markdown helpers are exported for domain/design.ts.

import type {
  ChangeAction, EvidenceClass, LintDefect, LintDefectCode, ParsedPlan, PlanChange, PlanCommand, PlanCriterion, PlanTask,
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
    case 'task-heading': case 'task-summary': case 'task-ownership': case 'task-criteria': case 'generated-inputs':
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
const TASK_HEADING = /^###\s+(T[1-9]\d*)\s+[—–-]\s+(\S.*?)\s*$/;
const TASK_FIELD = /^[-*+]\s+(Prerequisites|Criteria):\s*(.*?)\s*$/i;
const ACTION_HEADING = /^####\s+\[(NEW|MODIFY|DELETE|GENERATED)\]\s+(.+?)\s*$/;
const MARKER_HEADING = /^####\s+\[([A-Z][A-Z-]*)\]\s+\S/;
const EXCLUDED_CHANGE_PATH = /^(?:\.git|\.scratch)(?:\/|$)/;
const PROSE_PLACEHOLDER = /\b(?:TODO|TBD|implement later|fill in)\b/i;
const EVIDENCE: readonly EvidenceClass[] = ['red', 'verify', 'review'];
const RED_EXCEPTIONS = ['behavior-preserving', 'already-satisfied'];
// Common test-path conventions; a heuristic, so a miss only warns.
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|specs?)\/|[._-](?:test|spec)s?\.[^/]+$/i;
const CRITICAL = /\b(?:correctness|safety|recovery|durability|protocol)\b/i;

type Criterion = PlanCriterion & { integration: string | null; mapped: boolean; evidenceRaw: string | null; evidenceLine: number; redLine: number; reviewLine: number; critical: boolean; valid: boolean };

export type PlanResult =
  | { ok: true; plan: ParsedPlan; warnings: LintDefect[] }
  | { ok: false; defects: LintDefect[]; warnings: LintDefect[] };

export type PlanOptions = { placeholders?: PlaceholderVocabulary };

/** Carries accepted scope overlays into the editable artifact used for a later plan revision. */
export function materializePlanRevisionSeed(source: string, baseline: ParsedPlan, effective: ParsedPlan): string {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  let lines = source.replace(/\r\n/g, '\n').split('\n');
  const addedPaths = effective.changes.map((change) => change.path).filter((file) => !baseline.changes.some((change) => change.path === file));
  const seedTasks = effective.tasks.map((task) => ({ ...task, paths: [...task.paths] }));
  for (const file of new Set(addedPaths)) {
    if (seedTasks.some((task) => task.paths.includes(file))) continue;
    const criterion = effective.criteria.find((row) => row.changes.includes(file));
    const owner = criterion ? seedTasks.findIndex((task) => task.criteria.includes(criterion.id)) : -1;
    const targetIndex = owner >= 0 ? owner : seedTasks.length ? 0 : -1;
    const target = seedTasks[targetIndex];
    if (target) seedTasks[targetIndex] = { ...target, paths: [...target.paths, file] };
  }
  if (addedPaths.length) {
    const index = lines.findIndex((line) => /^>\s+\*\*Scope:\*\*/.test(line));
    if (index >= 0) {
      const current = lines[index] ?? '';
      const suffix = addedPaths.filter((file) => !current.includes(file));
      if (suffix.length) lines[index] = `${current.replace(/\s*$/, '')}, ${suffix.join(', ')}${current.endsWith('  ') ? '  ' : ''}`;
    }
  }
  const replaceSection = (heading: string, update: (body: string[]) => string[]) => {
    const start = lines.findIndex((line) => line.trimEnd() === heading);
    if (start < 0) return false;
    let end = start + 1;
    while (end < lines.length && !/^##\s/.test(lines[end] ?? '')) end++;
    lines = [...lines.slice(0, start + 1), ...update(lines.slice(start + 1, end)), ...lines.slice(end)];
    return true;
  };

  replaceSection('## Proposed Changes', (body) => {
    const result = [...body];
    const headings = result.flatMap((line, index) => /^###\s+T[1-9]\d*\s+[—–-]\s+/.test(line) ? [index] : []);
    for (const task of [...seedTasks].reverse()) {
      const start = headings.find((index) => new RegExp(`^###\\s+${task.id}\\s+[—–-]\\s+`).test(result[index] ?? ''));
      if (start === undefined) continue;
      const end = headings.find((index) => index > start) ?? result.length;
      const view = taskStructuralView(structuralLines(result.join('\n')));
      let action = result.findIndex((_line, index) => index > start && index < end && /^####\s+\[(?:NEW|MODIFY|DELETE|GENERATED)\]\s+/.test(view[index]?.text ?? ''));
      if (action < 0) action = end;
      const criteriaIndex = result.findIndex((line, index) => index > start && index < action && /^[-*+]\s+Criteria:/i.test(line));
      const criteriaLine = `- Criteria: ${task.criteria.length ? task.criteria.join(', ') : 'none'}`;
      let headerAdded = false;
      if (criteriaIndex >= 0) result[criteriaIndex] = criteriaLine;
      else { result.splice(action, 0, criteriaLine); action++; headerAdded = true; }

      const taskEnd = (headings.find((index) => index > start) ?? result.length) + (headerAdded ? 1 : 0);
      const existing = new Set(taskStructuralView(structuralLines(result.join('\n'))).slice(start + 1, taskEnd).flatMap(({ text }) => {
        const match = /^####\s+\[(?:NEW|MODIFY|DELETE|GENERATED)\]\s+(.+?)\s*$/.exec(text);
        return match?.[1] ? [normalizePlanPath(match[1]).path] : [];
      }));
      const nested = result.slice(start + 1, taskEnd).some((line) => /^- ####\s/.test(line));
      const additions = task.paths.filter((path) => !existing.has(path)).flatMap((path) => {
        const change = effective.changes.find((change) => change.path === path);
        const note = change?.note || 'Accepted implementation scope adjustment.';
        const indent = nested ? '  ' : '';
        const noteLines = note.split('\n');
        const continuationOnly = /^\s+\S/.test(noteLines[0] ?? '');
        return ['', `${nested ? '- ' : ''}#### [${change?.action ?? 'MODIFY'}] ${path}`,
          ...(continuationOnly ? [`${indent}- Changes:`] : []),
          ...noteLines.map((line, index) => `${indent}${/^Invariants:/.test(line) ? '- ' : index === 0 && !continuationOnly ? '- Changes: ' : ''}${line}`),
          ...(change?.command ? [`${indent}- Command: \`${change.command}\``, `${indent}- Inputs: ${task.generated.find((item) => item.path === path)?.inputs.join(', ') ?? ''}`] : [])];
      });
      if (additions.length) result.splice(taskEnd, 0, ...additions);
    }
    return result;
  });

  replaceSection('## Success Criteria', (body) => {
    const first = body.findIndex((line) => /^(?:[-*+] |\d+[.)] )\[SC[1-9]\d*\]\s+/.test(line));
    if (first < 0) return body;
    const prefix = body.slice(0, first);
    const existingGroups = new Map<string, string[]>();
    let currentId: string | null = null;
    for (const line of body.slice(first)) {
      const heading = /^(?:[-*+] |\d+[.)] )\[SC([1-9]\d*)\]\s+/.exec(line);
      if (heading) { currentId = `SC${heading[1]}`; existingGroups.set(currentId, [line]); }
      else if (currentId) existingGroups.get(currentId)!.push(line);
    }
    const render = (criterion: PlanCriterion): string[] => {
      const old = existingGroups.get(criterion.id) ?? [];
      const integration = old.filter((line) => /^ {2,}[-*+] Integration:/i.test(line));
      return [
        `- [${criterion.id}] ${criterion.title}`,
        ...(criterion.changes.length ? [`  - Changes: ${criterion.changes.join(', ')}`] : []),
        ...criterion.verify.map(({ command, final }) => `  - Verify: \`${command}\`${final ? ' [FINAL]' : ''}`),
        ...(criterion.evidence ? [`  - Evidence: ${criterion.evidence}`] : []),
        ...(criterion.preExisting === null ? [] : [`  - Pre-existing: ${criterion.preExisting ? 'yes' : 'no'}`]),
        ...(criterion.redException ? [`  - RED exception: ${criterion.redException}`] : []),
        ...(criterion.testRationale ? [`  - Test rationale: ${criterion.testRationale}`] : []),
        ...(criterion.review ? [`  - Review: ${criterion.review}`] : []),
        ...(criterion.enforcementInfeasibility ? [`  - Enforcement infeasibility: ${criterion.enforcementInfeasibility}`] : []),
        ...integration,
      ];
    };
    const mapped = effective.criteria.flatMap((criterion) => {
      const original = baseline.criteria.find((row) => row.id === criterion.id);
      const unchanged = original && JSON.stringify({ ...original, line: 0 }) === JSON.stringify({ ...criterion, line: 0 });
      return unchanged ? existingGroups.get(criterion.id) ?? render(criterion) : render(criterion);
    });
    return [...prefix, ...mapped];
  });

  const decisionsAdded = effective.keyDecisions.filter((item) => !baseline.keyDecisions.includes(item));
  if (decisionsAdded.length) {
    const found = replaceSection('## Key Decisions & Context', (body) => [...body, ...decisionsAdded.map((item) => `- ${item}`)]);
    if (!found) {
      const at = lines.findIndex((line) => line.trimEnd() === '## Success Criteria');
      if (at >= 0) lines.splice(at, 0, '## Key Decisions & Context', ...decisionsAdded.map((item) => `- ${item}`), '');
    }
  }

  const criterionCommands = new Set(effective.criteria.flatMap((criterion) => criterion.verify.map((item) => item.command)));
  const commandsAdded = effective.verification.automated.filter((command) => !baseline.verification.automated.includes(command) && !criterionCommands.has(command));
  if (commandsAdded.length) replaceSection('## Verification Plan', (body) => {
    const result = [...body];
    const at = result.findIndex((line) => line.trimEnd() === '### Automated Tests');
    if (at < 0) return result;
    let end = at + 1;
    while (end < result.length && !/^#{2,3}\s/.test(result[end] ?? '')) end++;
    result.splice(end, 0, ...commandsAdded.map((command) => `- \`${command}\``));
    return result;
  });

  const dutiesAdded = effective.verification.manual.filter((item) => !baseline.verification.manual.includes(item));
  if (dutiesAdded.length) replaceSection('## Verification Plan', (body) => {
    const result = [...body];
    let at = result.findIndex((line) => line.trimEnd() === '### Manual Verification');
    if (at < 0) { result.push('', '### Manual Verification'); at = result.length - 1; }
    let end = at + 1;
    while (end < result.length && !/^#{2,3}\s/.test(result[end] ?? '')) end++;
    result.splice(end, 0, ...dutiesAdded.map((item) => `- ${item}`));
    return result;
  });

  const representedFinals = new Set(effective.criteria.flatMap((criterion) => criterion.verify.filter((item) => item.final).map((item) => item.command)));
  const extraFinals = effective.finalCommands.filter((command) => !baseline.finalCommands.includes(command) && !representedFinals.has(command));
  if (extraFinals.length && effective.criteria.length) {
    const expandedPath = effective.criteria.find((criterion) => criterion.changes.some((path) => !baseline.changes.some((change) => change.path === path)));
    const owner = expandedPath ?? effective.criteria[0]!;
    replaceSection('## Success Criteria', (body) => {
      const start = body.findIndex((line) => new RegExp(`^(?:[-*+] |\\d+[.)] )\\[${owner.id}\\]\\s+`).test(line));
      if (start < 0) return body;
      let end = start + 1;
      while (end < body.length && !/^(?:[-*+] |\d+[.)] )\[SC[1-9]\d*\]\s+/.test(body[end] ?? '')) end++;
      body.splice(end, 0, ...extraFinals.map((command) => `  - Verify: \`${command}\` [FINAL]`));
      return body;
    });
  }

  return lines.join(newline);
}

/** Parses and lints a plan; any defect-severity diagnostic fails the parse. */
export function parsePlan(source: string, options: PlanOptions = {}): PlanResult {
  const lines = structuralLines(source);
  const out: LintDefect[] = [];
  const { changes, tasks } = parseChanges(lines, out);
  const verification = parseVerification(lines, out);
  const criteria = parseCriteria(lines, changes, out);
  lintTasks(tasks, changes, criteria, out);
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
    tasks: tasks.map(({ id, title, summary, line, prerequisites, criteria: ids, paths, generated }) => ({ id, title, summary, line, prerequisites, criteria: ids, paths, generated })),
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

type DraftTask = PlanTask & { prerequisitesLine: number | null; criteriaLine: number | null; summaryLine: number };

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
  const seen = new Map<string, string>();
  const body = taskStructuralView(lines).slice(range.start + 1, range.end);
  // `task` is null before the first H3 or under a malformed one; `inHeader` spans a task H3 up to its first H4.
  let task: DraftTask | null = null;
  let malformed = false;
  let inHeader = false;
  const summary: string[] = [];
  body.forEach((entry, offset) => {
    if (/^###\s/.test(entry.text)) {
      const heading = TASK_HEADING.exec(entry.text);
      inHeader = true;
      summary.length = 0;
      if (!heading?.[1] || !heading[2]) {
        out.push(lint('task-heading', entry.line, 'Task heading must be "### T<n> — <outcome title>".'));
        task = null; malformed = true;
        return;
      }
      malformed = false;
      task = { id: heading[1], title: heading[2], summary: '', line: entry.line, prerequisites: [], criteria: [], paths: [], generated: [], prerequisitesLine: null, criteriaLine: null, summaryLine: entry.line };
      tasks.push(task);
      return;
    }
    const current = task as DraftTask | null;
    const match = ACTION_HEADING.exec(entry.text);
    if (!match) {
      if (/^\s*[-*+]\s+####\s+\[/.test(entry.text)) out.push(lint('change-heading', entry.line, 'Nested file entries require "- #### [ACTION] path" at task level.'));
      const marker = MARKER_HEADING.exec(entry.text)?.[1];
      if (marker) out.push(lint('unknown-change-marker', entry.line, `Unknown change marker [${marker}]; use [NEW], [MODIFY], [DELETE], or [GENERATED].`));
      if (inHeader && current) readTaskHeader(current, entry, summary, out);
      return;
    }
    inHeader = false;
    const action = match[1] as ChangeAction;
    const normalized = normalizePlanPath(match[2] ?? '');
    if (!normalized.path) { out.push(lint('invalid-change-path', entry.line, `Invalid change path: ${normalized.reason ?? 'empty'}.`)); return; }
    // NOTE: case-insensitive filesystems make case variants one file, so they count as duplicate ownership.
    const folded = normalized.path.toLowerCase();
    const prior = seen.get(folded);
    if (prior !== undefined) out.push(lint('duplicate-change-path', entry.line, prior === normalized.path ? `Change path "${normalized.path}" appears more than once.` : `Change path "${normalized.path}" aliases "${prior}" on case-insensitive filesystems.`));
    seen.set(folded, normalized.path);
    if (EXCLUDED_CHANGE_PATH.test(normalized.path)) out.push(excluded(entry.line, normalized.path));
    if (!current && !malformed) out.push(lint('task-ownership', entry.line, `Change "${normalized.path}" has no owning task; group every change under "### T<n> — <outcome title>" (reauthor component-form plans).`));
    const block: string[] = [];
    for (const next of body.slice(offset + 1)) {
      if (/^#{2,4}\s+/.test(next.text)) break;
      block.push(next.text);
    }
    const bullet = (name: string) => block.find((text) => text.match(/^[-*+]\s+(\w+):/)?.[1] === name);
    const command = action === 'GENERATED' ? /^[-*+]\s+Command:\s*`([^`]+)`\s*$/.exec(bullet('Command') ?? '')?.[1]?.trim() ?? null : null;
    if (action === 'GENERATED' && !command) out.push(lint('generated-command', entry.line, 'A [GENERATED] path requires a "- Command: `<generator>`" bullet.'));
    if (current) {
      current.paths = [...current.paths, normalized.path];
      if (action === 'GENERATED') current.generated = [...current.generated, { path: normalized.path, inputs: generatedInputs(bullet('Inputs'), entry.line, out) }];
    }
    changes.push({ action, path: normalized.path, note: changeNote(block), command, line: entry.line });
  });
  if (!changes.length && !out.some((item) => item.code === 'invalid-change-path' || item.code === 'unknown-change-marker')) {
    out.push(lint('change-heading', lines[range.start]?.line ?? null, 'Proposed Changes requires an H4 action heading.'));
  }
  return { changes, tasks };
}

/** Task metadata bullets; other prose before the first H4 forms the summary. */
function readTaskHeader(task: DraftTask, entry: StructuralLine, summary: string[], out: LintDefect[]): void {
  const field = TASK_FIELD.exec(entry.text);
  if (field?.[1]) {
    // Duplicate IDs collapse; case and code spans are cosmetic.
    const ids = /^none$/i.test(field[2] ?? '') ? [] : [...new Set((field[2] ?? '').split(',').map((item) => item.replace(/`/g, '').trim().toUpperCase()).filter(Boolean))];
    if (field[1].toLowerCase() === 'prerequisites') {
      if (task.prerequisitesLine !== null) out.push(lint('missing-prerequisite', entry.line, `Task ${task.id} requires exactly one Prerequisites bullet.`));
      if (!ids.length && !/^none$/i.test(field[2] ?? '')) out.push(lint('missing-prerequisite', entry.line, `Task ${task.id} Prerequisites must be none or task IDs.`));
      task.prerequisites = ids; task.prerequisitesLine = entry.line;
    } else {
      if (task.criteriaLine !== null) out.push(lint('task-criteria', entry.line, `Task ${task.id} requires exactly one Criteria bullet.`));
      task.criteria = ids; task.criteriaLine = entry.line;
    }
    return;
  }
  const text = entry.text.trim().replace(/^[-*+]\s+Outcome:\s*/i, '').replace(/^[-*+]\s+(Constraints:)/i, '$1');
  if (!text) return;
  if (!summary.length) task.summaryLine = entry.line;
  summary.push(text);
  task.summary = summary.join(' ');
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
  const id = /^\[SC([1-9]\d*)\]\s+/.exec(text);
  const base: Criterion = {
    id: '', title: text, line, changes: [], verify: [], evidence: null, preExisting: null, redException: null, testRationale: null,
    review: null, enforcementInfeasibility: null, integration: null, mapped: false, evidenceRaw: null, evidenceLine: line, redLine: line, reviewLine: line,
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
  const integration = field('Integration');
  if (integration !== undefined) current.integration = integration;
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

// SECTION: Task graph

function lintTasks(tasks: readonly DraftTask[], changes: readonly PlanChange[], criteria: readonly Criterion[], out: LintDefect[]): void {
  const byId = new Map<string, DraftTask>();
  for (const task of tasks) {
    if (byId.has(task.id)) out.push(lint('duplicate-id', task.line, `Duplicate task ${task.id}.`));
    else byId.set(task.id, task);
    const prose = task.summary.replace(/`[^`]*`/g, '');
    if (!prose.trim() || PROSE_PLACEHOLDER.test(prose) || isFillerNote(task.summary)) {
      out.push(lint('task-summary', task.summaryLine, `Task ${task.id} requires a plain-language outcome summary before its file changes.`));
    }
    if (task.prerequisitesLine === null) out.push(lint('missing-prerequisite', task.line, `Task ${task.id} requires "- Prerequisites: none" or task IDs.`));
    if (!task.paths.length) out.push(lint('task-ownership', task.line, `Task ${task.id} owns no file change.`));
    for (const id of task.prerequisites) {
      if (id === task.id || !tasks.some((other) => other.id === id)) out.push(lint('missing-prerequisite', task.prerequisitesLine, `Task ${task.id} names ${id === task.id ? 'itself' : `unknown task ${id}`} as a prerequisite.`));
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
          out.push(lint('generated-inputs', task.line, `Task ${task.id} generates ${path} from ${input}, produced by ${producer.id}; add ${producer.id} as a direct or transitive prerequisite.`));
        }
      }
    }
  }
}

/** Transitive prerequisites per task; reports each cycle entry point once. */
function taskAncestors(byId: ReadonlyMap<string, DraftTask>, out: LintDefect[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const visit = (task: DraftTask): Set<string> => {
    const known = result.get(task.id);
    if (known) return known;
    if (visiting.has(task.id)) { out.push(lint('cycle', task.line, `Task ${task.id} is part of a prerequisite cycle.`)); return new Set(); }
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
    if (!task.criteria.length) out.push(lint('task-criteria', line, `Task ${task.id} requires "- Criteria: SC<n>[, ...]" naming its acceptance criteria.`));
    for (const id of task.criteria) {
      const criterion = known.get(id);
      if (!criterion) { out.push(lint('task-criteria', line, `Task ${task.id} names unknown criterion ${id}.`)); continue; }
      const prior = owner.get(id);
      if (prior) { out.push(lint('task-criteria', line, `Criterion ${id} is mapped to both ${prior} and ${task.id}; use - Integration: <reason> for a cross-task criterion.`)); continue; }
      owner.set(id, task.id);
      if (criterion.integration !== null) out.push(lint('task-criteria', criterion.line, `Criterion ${id} is mapped to ${task.id} and marked Integration; choose one.`));
      const foreign = criterion.changes.filter((path) => !task.paths.includes(path));
      if (foreign.length) out.push(lint('task-criteria', criterion.line, `Criterion ${id} of ${task.id} changes ${foreign.join(', ')} outside the task; move the path or mark the criterion Integration.`));
    }
  }
  if (!tasks.length) return;
  for (const criterion of criteria) {
    if (owner.has(criterion.id)) continue;
    if (criterion.integration === null) out.push(lint('task-criteria', criterion.line, `Criterion ${criterion.id} maps to no task; list it under one task's Criteria or add - Integration: <reason>.`));
    else if (!criterion.integration.trim() || !criterion.verify.length) out.push(lint('task-criteria', criterion.line, `Integration criterion ${criterion.id} requires a reason and a Verify command.`));
  }
}

// SECTION: Derived task views

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
  return {
    task,
    changes: plan.changes.filter((change) => task.paths.includes(change.path)),
    criteria: plan.criteria.filter((criterion) => task.criteria.includes(criterion.id)),
    prerequisites: plan.tasks.filter((item) => task.prerequisites.includes(item.id)),
    dependents: plan.tasks.filter((item) => item.prerequisites.includes(task.id)),
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
  const notes = taskStructuralView(lines).slice(range.start + 1, range.end).flatMap((entry) => {
    const note = /^[-*+]\s+(?:Changes|Purpose):[ \t]*(.*)$/.exec(entry.text)?.[1]?.trim();
    return note ? [{ note, line: entry.line }] : [];
  });
  notes.forEach(({ note, line }, index) => {
    const siblings = notes.filter((_item, other) => other !== index).map((item) => item.note);
    if (isFillerNote(note, siblings)) out.push(lint('filler-note', line, `Change note "${note}" is filler; say what changes in this file.`));
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
