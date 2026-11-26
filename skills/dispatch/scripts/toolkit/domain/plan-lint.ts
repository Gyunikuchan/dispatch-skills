import { RESOLUTION_HEADING, isFillerNote, lint } from "./document-lint.ts";
import { sectionRanges, withoutSections } from "./markdown-structure.ts";
import type { StructuralLine } from "./markdown-structure.ts";
import type { ChangeAction, LintDefect, PlanCriterion } from "./types.ts";

/** Hashing input: the source without review history. */
export const governedPlanText = (source: string) =>
  withoutSections(source, [RESOLUTION_HEADING]);

// SECTION: Paths

/** Portable workspace-relative POSIX path, or the rejection reason. */
export const normalizePlanPath = (raw: string) => {
  const trimmed = raw.trim();

  const rawPath =
    /^`(?<cap1>[^`]+)`.*$/u.exec(trimmed)?.[1] ?? /^\S+/u.exec(trimmed)?.[0];

  if (rawPath === undefined || rawPath === "") {
    return { path: null, reason: "empty" };
  }

  if (rawPath.includes("\\")) {
    return { path: null, reason: "backslash" };
  }

  // NOTE: drive-qualified (`C:/x`, `C:x`) and home (`~`) forms escape the workspace on resolve.
  if (
    rawPath.startsWith("/") ||
    /^[A-Za-z]:/u.test(rawPath) ||
    rawPath.startsWith("~")
  ) {
    return { path: null, reason: "absolute" };
  }

  const segments = rawPath.replace(/^\.\/+/u, "").split("/");

  if (segments.includes("..")) {
    return { path: null, reason: "parent-segment" };
  }

  const normalized = segments
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");

  return normalized
    ? { path: normalized, reason: null }
    : { path: null, reason: "empty" };
};

const LISTED_PATH = /^(?<cap1>`[^`]+`|[^\s,`]+)\s*,\s*/u;

/** Paths named by a change heading; only [DELETE] may group comma-separated paths, each bare or backticked. */
export const headingPaths = (action: ChangeAction, text: string) => {
  const parts: string[] = [];
  let rest = text.trim();

  // A comma ends a path only directly after it, so a trailing note after the last path may hold commas.
  for (
    let match = LISTED_PATH.exec(rest);
    match;
    match = LISTED_PATH.exec(rest)
  ) {
    parts.push(match[1] ?? "");
    rest = rest.slice(match[0].length);
  }

  parts.push(rest);

  if (parts.length > 1 && action !== "DELETE") {
    return {
      error: `List one path per [${action}] heading; only [DELETE] may group comma-separated paths. Split "${text.trim()}".`,
    };
  }

  return { paths: parts.map((part) => normalizePlanPath(part)) };
};

// SECTION: Plan structure

export const TASK_HEADING =
  /^###\s+(?<cap1>T[1-9]\d*)\s+[—–-]\s+(?<cap2>\S.*?)\s*$/u;

export const ACTION_HEADING =
  /^####\s+\[(?<cap1>NEW|MODIFY|DELETE|GENERATED)\]\s+(?<cap2>.+?)\s*$/u;

/** Normalize only task-owned file entries and their detail indentation. */
export const taskStructuralView = (lines: readonly StructuralLine[]) => {
  let task = false;
  let nested = false;

  return lines.map((entry) => {
    let { text } = entry;

    if (/^##\s/u.test(text)) {
      task = false;
      nested = false;
    }

    if (/^###\s/u.test(text)) {
      task = TASK_HEADING.test(text);
      nested = false;
    }

    if (task && /^- ####\s+\[/u.test(text)) {
      text = text.slice(2);
      nested = true;
    } else if (/^####\s/u.test(text)) {
      nested = false;
    } else if (
      nested &&
      (/^ {2}[-*+]\s/u.test(text) || /^ {4,}\S/u.test(text))
    ) {
      text = text.slice(2);
    }

    return { ...entry, text };
  });
};

export const splitTaskMapRow = (source: string) => {
  const row = source.trim();

  if (!row.startsWith("|") || !row.endsWith("|")) {
    return null;
  }

  const cells: string[] = [];
  let cell = "";
  const body = row.slice(1, -1);

  for (let index = 0; index < body.length;) {
    const character = body[index];

    if (character === "|") {
      let slashes = 0;

      for (
        let back = cell.length - 1;
        back >= 0 && cell[back] === "\\";
        back -= 1
      ) {
        slashes += 1;
      }

      if (slashes % 2) {
        cell = `${cell.slice(0, -1)}|`;
        index += 1;
        continue;
      }

      cells.push(cell.trim());
      cell = "";
      index += 1;
      continue;
    }

    cell += character;
    index += 1;
  }

  cells.push(cell.trim());

  return cells;
};

// SECTION: Plan lint

export const PROSE_PLACEHOLDER = /\b(?:TODO|TBD|implement later|fill in)\b/iu;

/** A summary table that repeats Task Map IDs duplicates the map; the summary should link the map instead. */
export const lintGlanceRestatesTaskMap = (
  lines: readonly StructuralLine[],
  rows: readonly { id: string }[],
  out: LintDefect[]
) => {
  const [range] = sectionRanges(lines, "## At a Glance");
  const ids = new Set(rows.map((row) => row.id));

  for (const entry of range ? lines.slice(range.start + 1, range.end) : []) {
    const first = entry.fenced
      ? undefined
      : splitTaskMapRow(entry.text)?.[0]
          ?.replaceAll(/^`|`$/gu, "")
          .trim()
          .toUpperCase();

    if (first !== undefined && first !== "" && ids.has(first)) {
      out.push(
        lint(
          "glance-restates-task-map",
          entry.line,
          `## At a Glance table row ${first} restates a Task Map row; link ## Task Map instead of repeating it.`
        )
      );
    }
  }
};

export const lintAutomatedDuplicates = (
  automated: readonly string[],
  criteria: readonly PlanCriterion[],
  lines: readonly StructuralLine[],
  out: LintDefect[]
) => {
  const verifies = new Set(
    criteria.flatMap((criterion) =>
      criterion.verify.map((item) => item.command)
    )
  );

  for (const command of automated) {
    if (!verifies.has(command)) {
      continue;
    }

    const line =
      lines.find(
        (entry) =>
          entry.text.includes(`\`${command}\``) && /^-\s+`/u.test(entry.text)
      )?.line ?? null;

    out.push(
      lint(
        "automated-test-duplicates-check",
        line,
        `Automated test \`${command}\` repeats a criterion Check command; list only extra commands.`
      )
    );
  }
};

export const lintNotes = (
  lines: readonly StructuralLine[],
  out: LintDefect[]
) => {
  const [range] = sectionRanges(lines, "## Proposed Changes");

  if (!range) {
    return;
  }

  let current: string | null = null;

  const notes = taskStructuralView(lines)
    .slice(range.start + 1, range.end)
    .flatMap((entry) => {
      current = ACTION_HEADING.exec(entry.text)?.[1] ?? current;

      const note = /^[-*+]\s+(?:Changes|Purpose):[ \t]*(?<cap1>.*)$/u
        .exec(entry.text)?.[1]
        ?.trim();

      return note !== undefined && note !== ""
        ? [{ note, line: entry.line, action: current }]
        : [];
    });

  for (const [index, { note, line, action }] of notes.entries()) {
    const siblings = notes.filter((_item, other) => other !== index);
    const intrinsic = isFillerNote(note);

    if (
      !intrinsic &&
      !isFillerNote(
        note,
        siblings.map((item) => item.note)
      )
    ) {
      continue;
    }

    // A note shared by separate [DELETE] entries belongs on one grouped heading.
    const grouping =
      action === "DELETE" &&
      !intrinsic &&
      isFillerNote(
        note,
        siblings
          .filter((item) => item.action === "DELETE")
          .map((item) => item.note)
      );

    const reason = intrinsic ? "is filler" : "repeats a sibling note";
    out.push(
      lint(
        "filler-note",
        line,
        `Change note "${note}" ${reason}; say what changes in this file${grouping ? "; group these [DELETE] paths under one heading" : ""}.`
      )
    );
  }
};

// SECTION: Test paths

// Common test-path conventions; a lint hint only, so a test-like path outside every `Tests:` warns. Declared `Tests:` drive decisions.
const TEST_PATH =
  /(?:^|\/)(?:tests?|__tests__|specs?)\/|[._-](?:test|spec)s?\.[^/]+$|(?:^|\/)test_[^/]+\.[^/]+$/iu;

export const isTestPath = (value: string) => TEST_PATH.test(value);

// Lint hint only: paths under these segments look like support files, so the `undeclared-test-path` check skips them.
const TEST_SUPPORT_PATH = /(?:^|\/)(?:fixtures|helpers|mocks)\//iu;
/** A test-like support path (fixture, helper, mock): exempt from the `undeclared-test-path` lint; a RED stage that changes or needs it must still list it in `Tests:`. */

export const isTestSupportPath = (value: string) =>
  isTestPath(value) && TEST_SUPPORT_PATH.test(value);

const unquote = (value: string) => value.replaceAll(/^[`'"]+|[`'"]+$/gu, "");
/** Path-like tokens of a Check command; whitespace inside quotes does not split, so a quoted path with a space stays whole. */

export const checkPathTokens = (command: string) =>
  (command.match(/(?:"[^"]*"|'[^']*'|\S)+/gu) ?? []).map((token) => {
    const value = unquote(unquote(token).replace(/^--[^=\s]+=/u, ""));

    return value.replaceAll("\\", "/").replace(/^\.\//u, "");
  });
