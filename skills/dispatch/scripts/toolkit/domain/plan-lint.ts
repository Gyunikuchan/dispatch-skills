import type { ChangeAction, LintDefect, PlanCriterion } from './types.ts';
import { sectionRanges, withoutSections, type StructuralLine } from './markdown-structure.ts';
import { RESOLUTION_HEADING, isFillerNote, lint } from './document-lint.ts';

/** Hashing input: the source without review history. */
export function governedPlanText(source: string): string {
  return withoutSections(source, [RESOLUTION_HEADING]);
}

// SECTION: Paths

/** Portable workspace-relative POSIX path, or the rejection reason. */
export function normalizePlanPath(raw: string): { path: string | null; reason: string | null } {
  const trimmed = raw.trim();
  const rawPath = /^`([^`]+)`.*$/.exec(trimmed)?.[1] ?? /^\S+/.exec(trimmed)?.[0];
  if (!rawPath) return { path: null, reason: 'empty' };
  if (rawPath.includes('\\')) return { path: null, reason: 'backslash' };
  // NOTE: drive-qualified (`C:/x`, `C:x`) and home (`~`) forms escape the workspace on resolve.
  if (rawPath.startsWith('/') || /^[A-Za-z]:/.test(rawPath) || rawPath.startsWith('~'))
    return { path: null, reason: 'absolute' };
  const segments = rawPath.replace(/^\.\/+/, '').split('/');
  if (segments.includes('..')) return { path: null, reason: 'parent-segment' };
  const normalized = segments.filter((segment) => segment && segment !== '.').join('/');
  return normalized ? { path: normalized, reason: null } : { path: null, reason: 'empty' };
}

const LISTED_PATH = /^(`[^`]+`|[^\s,`]+)\s*,\s*/;

/** Paths named by a change heading; only [DELETE] may group comma-separated paths, each bare or backticked. */
export function headingPaths(
  action: ChangeAction,
  text: string,
): { paths: ReturnType<typeof normalizePlanPath>[] } | { error: string } {
  const parts: string[] = [];
  let rest = text.trim();
  // A comma ends a path only directly after it, so a trailing note after the last path may hold commas.
  for (let match = LISTED_PATH.exec(rest); match; match = LISTED_PATH.exec(rest)) {
    parts.push(match[1] ?? '');
    rest = rest.slice(match[0].length);
  }
  parts.push(rest);
  if (parts.length > 1 && action !== 'DELETE')
    return {
      error: `List one path per [${action}] heading; only [DELETE] may group comma-separated paths. Split "${text.trim()}".`,
    };
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
    if (/^##\s/.test(text)) {
      task = false;
      nested = false;
    }
    if (/^###\s/.test(text)) {
      task = TASK_HEADING.test(text);
      nested = false;
    }
    if (task && /^- ####\s+\[/.test(text)) {
      text = text.slice(2);
      nested = true;
    } else if (/^####\s/.test(text)) nested = false;
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
/** A summary table that repeats Task Map IDs duplicates the map; the summary should link the map instead. */
export function lintGlanceRestatesTaskMap(
  lines: readonly StructuralLine[],
  rows: readonly { id: string }[],
  out: LintDefect[],
): void {
  const range = sectionRanges(lines, '## At a Glance')[0];
  const ids = new Set(rows.map((row) => row.id));
  for (const entry of range ? lines.slice(range.start + 1, range.end) : []) {
    const first = entry.fenced
      ? undefined
      : splitTaskMapRow(entry.text)?.[0]?.replace(/^`|`$/g, '').trim().toUpperCase();
    if (first && ids.has(first))
      out.push(
        lint(
          'glance-restates-task-map',
          entry.line,
          `## At a Glance table row ${first} restates a Task Map row; link ## Task Map instead of repeating it.`,
        ),
      );
  }
}

export function lintAutomatedDuplicates(
  automated: readonly string[],
  criteria: readonly PlanCriterion[],
  lines: readonly StructuralLine[],
  out: LintDefect[],
): void {
  const verifies = new Set(criteria.flatMap((criterion) => criterion.verify.map((item) => item.command)));
  for (const command of automated) {
    if (!verifies.has(command)) continue;
    const line =
      lines.find((entry) => entry.text.includes(`\`${command}\``) && /^-\s+`/.test(entry.text))?.line ?? null;
    out.push(
      lint(
        'automated-test-duplicates-check',
        line,
        `Automated test \`${command}\` repeats a criterion Check command; list only extra commands.`,
      ),
    );
  }
}

export function lintNotes(lines: readonly StructuralLine[], out: LintDefect[]): void {
  const range = sectionRanges(lines, '## Proposed Changes')[0];
  if (!range) return;
  let current: string | null = null;
  const notes = taskStructuralView(lines)
    .slice(range.start + 1, range.end)
    .flatMap((entry) => {
      current = ACTION_HEADING.exec(entry.text)?.[1] ?? current;
      const note = /^[-*+]\s+(?:Changes|Purpose):[ \t]*(.*)$/.exec(entry.text)?.[1]?.trim();
      return note ? [{ note, line: entry.line, action: current }] : [];
    });
  notes.forEach(({ note, line, action }, index) => {
    const siblings = notes.filter((_item, other) => other !== index);
    const intrinsic = isFillerNote(note);
    if (
      !intrinsic &&
      !isFillerNote(
        note,
        siblings.map((item) => item.note),
      )
    )
      return;
    // A note shared by separate [DELETE] entries belongs on one grouped heading.
    const grouping =
      action === 'DELETE' &&
      !intrinsic &&
      isFillerNote(
        note,
        siblings.filter((item) => item.action === 'DELETE').map((item) => item.note),
      );
    const reason = intrinsic ? 'is filler' : 'repeats a sibling note';
    out.push(
      lint(
        'filler-note',
        line,
        `Change note "${note}" ${reason}; say what changes in this file${grouping ? '; group these [DELETE] paths under one heading' : ''}.`,
      ),
    );
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
export const checkPathTokens = (command: string): string[] =>
  (command.match(/(?:"[^"]*"|'[^']*'|\S)+/g) ?? []).map((token) => {
    const value = unquote(unquote(token).replace(/^--[^=\s]+=/, ''));
    return value.replace(/\\/g, '/').replace(/^\.\//, '');
  });
