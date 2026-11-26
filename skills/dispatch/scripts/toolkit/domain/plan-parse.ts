import { criterionHeading } from "./criterion-id.ts";
import { defined } from "./defined.ts";
import {
  boxValues,
  documentTitle,
  findPlaceholders,
  lint,
  lintLongParagraphs,
  lintSectionOrder,
  lintSummaryBox,
  LONG_PARAGRAPH_WORDS,
  parseSummaryBox,
  RESOLUTION_HEADING,
  SPEC_PIN_VALUE,
} from "./document-lint.ts";
import type { PlaceholderVocabulary } from "./document-lint.ts";
import {
  isDetailWrapper,
  sectionRanges,
  structuralLines,
} from "./markdown-structure.ts";
import type { StructuralLine } from "./markdown-structure.ts";
import { joinTaskMap, lintTaskSections, lintTasks } from "./plan-graph.ts";
import {
  ACTION_HEADING,
  TASK_HEADING,
  PROSE_PLACEHOLDER,
  checkPathTokens,
  governedPlanText,
  headingPaths,
  isTestPath,
  isTestSupportPath,
  lintAutomatedDuplicates,
  lintGlanceRestatesTaskMap,
  lintNotes,
  normalizePlanPath,
  splitTaskMapRow,
  taskStructuralView,
} from "./plan-lint.ts";
import type {
  ChangeAction,
  EvidenceClass,
  LintDefect,
  ParsedPlan,
  PlanChange,
  PlanCriterion,
  PlanTask,
} from "./types.ts";

const TASK_MAP_HEADING = "## Task Map";

const CHANGE_ACTIONS: readonly ChangeAction[] = [
  "NEW",
  "MODIFY",
  "DELETE",
  "GENERATED",
];

/** Plan section order after the title and summary box; every section is optional to this lint. */
const PLAN_SECTION_ORDER = [
  "## At a Glance",
  "## Background",
  "## Key Interfaces & Data",
  "## Key Decisions & Context",
  "## Constraints",
  "## Open Questions & Assumptions",
  "## Out of Scope",
  TASK_MAP_HEADING,
  "## Technical-Design Traceability",
  "## Proposed Changes",
  "## Success Criteria",
  "## Verification Plan",
  "## Rollback & Blast Radius",
  RESOLUTION_HEADING,
] as const;

// SECTION: Plan parse

const BOX_LABELS = ["Parent", "Decide", "Risk", "Scope"];

/** Parent forms: a governing spec pinned by checksum or a design increment. */
const DESIGN_PIN_VALUE = /^`(?<cap1>[^`\s]+\.design\.md)` · (?<cap2>I\d{2})$/u;

// NOTE: names are stripped because Node 22 (V8 12.4) rejects duplicate named groups, even across alternatives.
const unnamed = (pattern: RegExp) =>
  pattern.source.replaceAll(/\(\?<[A-Za-z]\w*>/gu, "(");

const PARENT_VALUE = new RegExp(
  `(?:${unnamed(SPEC_PIN_VALUE)})|(?:${unnamed(DESIGN_PIN_VALUE)})`,
  "u"
);

const TASK_FIELD =
  /^[-*+]\s+(?<cap1>Outcome|Prerequisites|Criteria):\s*(?<cap2>.*?)\s*$/iu;

const CONSTRAINT_FIELD = /^[-*+]\s+Constraints:\s*(?<cap1>.*?)\s*$/iu;
const OVERLAP_FIELD = /^[-*+]\s+Overlap:\s*(?<cap1>.*?)\s*$/iu;
const MARKER_HEADING = /^####\s+\[(?<cap1>[A-Z][A-Z-]*)\]\s+\S/u;
const EXCLUDED_CHANGE_PATH = /^(?:\.git|\.scratch)(?:\/|$)/u;
const EVIDENCE: readonly EvidenceClass[] = ["red", "check", "review"];
const RED_EXCEPTIONS = ["behavior-preserving", "already-satisfied"];

/** Matches any plan-defined ID as a whole token, case-insensitively; null when the plan defines none. */
const planIdPattern = (ids: readonly string[]) => {
  if (!ids.length) {
    return null;
  }

  const escaped = ids.map((id) =>
    id.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)
  );

  return new RegExp(
    `(?<![A-Za-z0-9-])(?:${escaped.join("|")})(?![A-Za-z0-9])`,
    "iu"
  );
};

const FINDING_ID = /\bR\d+-F\d+\b/giu;
const CRITICAL = /\b(?:correctness|safety|recovery|durability|protocol)\b/iu;

export type Criterion = PlanCriterion & {
  satisfies: readonly string[];
  verifyLines: number[];
  testsLine: number | null;
  redCommandLine: number | null;
  integration: string | null;
  mapped: boolean;
  evidenceRaw: string | null;
  evidenceLine: number;
  redLine: number;
  reviewLine: number;
  critical: boolean;
  valid: boolean;
};

interface PlanOptions {
  placeholders?: PlaceholderVocabulary;
}

type PlanResult =
  | { ok: true; plan: ParsedPlan; warnings: LintDefect[] }
  | { ok: false; defects: LintDefect[]; warnings: LintDefect[] };

/** Parses and lints a plan; any defect-severity diagnostic fails the parse. */
export const parsePlan = (
  source: string,
  options: PlanOptions = {}
): PlanResult => {
  const lines = structuralLines(source);
  const out: LintDefect[] = [];
  const { changes, tasks: sections } = parseChanges(lines, out);
  const taskRows = parseTaskMap(lines, out);
  const tasks = joinTaskMap(sections, taskRows, out);
  const verification = parseVerification(lines, out);
  const criteria = parseCriteria(lines, changes, out);
  const seamDeclarations = parseSeamDeclarations(lines);
  const seams = seamsFromDeclarations(seamDeclarations);

  if (
    criteria.some((criterion) => criterion.verify.length) &&
    !seams.length &&
    !seamDeclarations.some(({ value }) => /^none$/iu.test(value))
  ) {
    const [range] = sectionRanges(lines, "## Verification Plan");
    out.push(
      lint(
        "missing-seams",
        range ? (lines[range.start]?.line ?? null) : null,
        "Automated criteria have no test seams; declare Seams: <entry points> or Seams: none when inapplicable."
      )
    );
  }

  lintUndeclaredTestPaths(criteria, out);
  const planIds = collectPlanIds(lines, criteria);
  lintPlanIdNames(criteria, changes, planIds, out);
  lintTaskSections(sections, out);
  const overlapWarnings = lintTasks(tasks, changes, criteria, out);
  lintAutomatedDuplicates(verification.automated, criteria, lines, out);
  lintNotes(lines, out);

  if (!sectionRanges(lines, "## At a Glance").length) {
    out.push(
      lint("missing-section", null, "Plan has no ## At a Glance section.")
    );
  }

  lintGlanceRestatesTaskMap(lines, taskRows, out);

  for (const { line, words } of lintLongParagraphs(lines)) {
    out.push(
      lint(
        "long-paragraph",
        line,
        `Prose paragraph has ${words} words; use bullets or shorten it to ${LONG_PARAGRAPH_WORDS} words.`
      )
    );
  }

  out.push(...lintSectionOrder(lines, PLAN_SECTION_ORDER));

  for (const entry of lines) {
    if (PROSE_PLACEHOLDER.test(entry.text.replaceAll(/`[^`]*`/gu, ""))) {
      out.push(
        lint("placeholder", entry.line, "Plan contains a prose placeholder.")
      );
    }
  }

  out.push(...lintSummaryBox(source, BOX_LABELS, { Parent: PARENT_VALUE }));

  if (options.placeholders) {
    for (const { token, line } of findPlaceholders(
      source,
      options.placeholders
    )) {
      out.push(
        lint(
          "leftover-placeholder",
          line,
          `Leftover template placeholder ${token}.`
        )
      );
    }
  }

  const defects = out.filter((item) => item.severity === "defect");
  const warnings = out.filter((item) => item.severity === "warning");

  if (defects.length) {
    return { ok: false, defects, warnings };
  }

  const plan: ParsedPlan = {
    title: documentTitle(source),
    box: boxValues(source),
    glance: parseGlance(lines),
    keyDecisions: bullets(lines, "## Key Decisions & Context"),
    criteria: criteria.map(
      ({
        id,
        title,
        line,
        satisfies,
        changes: paths,
        tests,
        verify,
        evidence,
        preExisting,
        redException,
        red,
        review,
        enforcementInfeasibility,
      }) => ({
        id,
        title,
        line,
        satisfies,
        changes: paths,
        tests,
        verify,
        evidence,
        preExisting,
        redException,
        red,
        review,
        enforcementInfeasibility,
      })
    ),
    tasks: tasks.map(
      ({
        id,
        title,
        summary,
        behaviour,
        constraints,
        line,
        prerequisites,
        criteria: ids,
        paths,
        generated,
        overlaps,
      }) => ({
        id,
        title,
        summary,
        behaviour,
        constraints,
        line,
        prerequisites,
        criteria: ids,
        paths,
        generated,
        overlaps,
      })
    ),
    changes,
    verification,
    seams,
    warnings: overlapWarnings,
    traceability: keyValues(lines, "## Technical-Design Traceability"),
    governedText: governedPlanText(source),
    planIds,
    sharedContext: "",
  };

  return {
    ok: true,
    plan: { ...plan, sharedContext: sharedPlanContext(plan.governedText) },
    warnings,
  };
};

/** Index of the first line after the Task Map, or of the first later-ordered section when the plan has no Task Map. */
const sharedContextEnd = (lines: readonly StructuralLine[]) => {
  const [map] = sectionRanges(lines, TASK_MAP_HEADING);

  if (map) {
    return map.end;
  }

  const later = new Set<string>(
    PLAN_SECTION_ORDER.slice(PLAN_SECTION_ORDER.indexOf(TASK_MAP_HEADING) + 1)
  );

  const next = lines.findIndex((entry) => later.has(entry.text.trimEnd()));

  return next === -1 ? lines.length : next;
};

/** Shared writer context preserves the authored map bytes used by the governed hash. */
const sharedPlanContext = (text: string) =>
  text
    .split(/\r?\n/u)
    .slice(0, sharedContextEnd(structuralLines(text)))
    .join("\n")
    .replace(/\s+$/u, "\n");

const bullets = (lines: readonly StructuralLine[], heading: string) => {
  const [range] = sectionRanges(lines, heading);

  if (!range) {
    return [];
  }

  return lines.slice(range.start + 1, range.end).flatMap(({ text }) => {
    const match = /^[-*+]\s+(?<cap1>.+)$/u.exec(text);

    return match?.[1] === undefined ? [] : [match[1].trim()];
  });
};

export const parseGlance = (lines: readonly StructuralLine[]) => {
  const [range] = sectionRanges(lines, "## At a Glance");

  if (!range) {
    return null;
  }

  const entries = lines.slice(range.start + 1, range.end);
  const values = { what: "", how: "" };
  let active: keyof typeof values | null = null;
  let lastSummaryIndex = -1;
  let visualStart: number | null = null;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = defined(entries[index]);

    if (entry.fenced) {
      if (lastSummaryIndex !== -1 && visualStart === null) {
        visualStart = index;
      }

      active = null;
      continue;
    }

    const bullet =
      /^[-*+]\s+\*\*(?<cap1>What|How it works):\*\*\s*(?<cap2>.*)$/iu.exec(
        entry.text
      );

    if (bullet) {
      active = bullet[1]?.toLowerCase() === "what" ? "what" : "how";
      values[active] = bullet[2]?.trim() ?? "";
      lastSummaryIndex = index;
      continue;
    }

    if (active && /^ {2,}\S/u.test(entry.text)) {
      values[active] += `${values[active] ? "\n" : ""}${entry.text.trim()}`;
      lastSummaryIndex = index;
      continue;
    }

    if (entry.text.trim()) {
      active = null;

      if (lastSummaryIndex !== -1 && visualStart === null) {
        visualStart = index;
      }
    }
  }

  const visuals =
    visualStart === null
      ? ""
      : entries
          .slice(visualStart)
          .map(({ original }) => original)
          .join("\n")
          .replaceAll(/^(?:\r?\n)+|(?:\r?\n)+$/gu, "");

  return { ...values, visuals };
};

const keyValues = (lines: readonly StructuralLine[], heading: string) => {
  const [range] = sectionRanges(lines, heading);

  if (!range) {
    return null;
  }

  const values: Record<string, string> = {};

  for (const { text } of lines.slice(range.start + 1, range.end)) {
    const match = /^[-*+]\s+(?<cap1>[^:]+):\s*(?<cap2>.*)$/u.exec(text);

    if (match?.[1] !== undefined) {
      values[match[1].trim()] = (match[2] ?? "").trim();
    }
  }

  return values;
};

export const parentPin = (source: string) => {
  const value = parseSummaryBox(source)
    ?.entries.find((entry) => entry.label === "Parent")
    ?.value.trim();

  if (value === undefined || value === "") {
    return null;
  }

  const spec = SPEC_PIN_VALUE.exec(value);

  if (spec) {
    return {
      kind: "spec",
      path: defined(spec[1]),
      hash: `sha256:${defined(spec[2])}`,
    };
  }

  const design = DESIGN_PIN_VALUE.exec(value);

  return design
    ? {
        kind: "design",
        path: defined(design[1]),
        increment: defined(design[2]),
      }
    : null;
};

// SECTION: Proposed changes and authored tasks

export type DraftTask = Omit<PlanTask, "constraints" | "behaviour"> & {
  constraints: string[];
  behaviour: string[];
  prerequisitesLine: number | null;
  criteriaLine: number | null;
  summaryLine: number;
  overlapLines: number[];
};

export interface AuthoredTaskRow {
  id: string;
  title: string;
  outcome: string;
  prerequisites: string[];
  criteria: string[];
  line: number;
}

const lintNonActionEntry = (
  entry: StructuralLine,
  current: DraftTask | null,
  inHeader: boolean,
  beforeDetails: boolean,
  out: LintDefect[]
) => {
  if (/^\s*[-*+]\s+####\s+\[/u.test(entry.text)) {
    out.push(
      lint(
        "change-heading",
        entry.line,
        'Nested file entries require "- #### [ACTION] path" at task level.'
      )
    );
  }

  const marker = MARKER_HEADING.exec(entry.text)?.[1];

  if (marker !== undefined) {
    out.push(
      lint(
        "unknown-change-marker",
        entry.line,
        `Unknown change marker [${marker}]; use [NEW], [MODIFY], [DELETE], or [GENERATED].`
      )
    );
  }

  if (inHeader && current !== null) {
    readTaskHeader(current, entry, out, beforeDetails);
  }
};

const resolvedPaths = (
  entries: readonly ReturnType<typeof normalizePlanPath>[],
  current: DraftTask | null,
  malformed: boolean,
  seen: Map<DraftTask | null, Map<string, string>>,
  entry: StructuralLine,
  out: LintDefect[]
) => {
  const paths: string[] = [];

  for (const normalized of entries) {
    if (normalized.path === null) {
      out.push(
        lint(
          "invalid-change-path",
          entry.line,
          `Invalid change path: ${normalized.reason ?? "empty"}.`
        )
      );
      continue;
    }

    // NOTE: case-insensitive filesystems make case variants one file, so they count as duplicate ownership.
    const folded = normalized.path.toLowerCase();
    const owned = seen.get(current) ?? new Map<string, string>();

    seen.set(current, owned);

    const prior = owned.get(folded);

    if (prior !== undefined) {
      out.push(
        lint(
          "duplicate-change-path",
          entry.line,
          prior === normalized.path
            ? `Change path "${normalized.path}" appears more than once.`
            : `Change path "${normalized.path}" aliases "${prior}" on case-insensitive filesystems.`
        )
      );
    }

    owned.set(folded, normalized.path);

    if (EXCLUDED_CHANGE_PATH.test(normalized.path)) {
      out.push(excluded(entry.line, normalized.path));
    }

    if (current === null && !malformed) {
      out.push(
        lint(
          "task-ownership",
          entry.line,
          `Change "${normalized.path}" has no owning task; group every change under "### T<n> — <outcome title>" (reauthor component-form plans).`
        )
      );
    }

    paths.push(normalized.path);
  }

  return paths;
};

const bulletOf = (block: readonly string[], name: string) =>
  block.find((text) => /^[-*+]\s+(?<cap1>\w+):/u.exec(text)?.[1] === name);

const changeBlock = (body: readonly StructuralLine[], offset: number) => {
  const block: string[] = [];

  for (const next of body.slice(offset + 1)) {
    if (/^#{2,4}\s+/u.test(next.text)) {
      break;
    }

    if (!isDetailWrapper(next.text)) {
      block.push(next.text);
    }
  }

  return block;
};

const changeCommand = (action: ChangeAction, block: readonly string[]) => {
  if (action !== "GENERATED") {
    return null;
  }

  return (
    /^[-*+]\s+Command:\s*`(?<cap1>[^`]+)`\s*$/u
      .exec(bulletOf(block, "Command") ?? "")?.[1]
      ?.trim() ?? null
  );
};

const recordChange = (
  current: DraftTask | null,
  action: ChangeAction,
  paths: readonly string[],
  command: string | null,
  block: readonly string[],
  entry: StructuralLine,
  out: LintDefect[],
  changes: PlanChange[]
) => {
  // Only [DELETE] lists several paths, so GENERATED inputs stay single-path.
  if (current !== null) {
    current.paths = [...current.paths, ...paths];

    if (action === "GENERATED") {
      current.generated = [
        ...current.generated,
        ...paths.map((path) => ({
          path,
          inputs: generatedInputs(bulletOf(block, "Inputs"), entry.line, out),
        })),
      ];
    }
  }

  const note = changeNote(block);

  for (const path of paths) {
    changes.push({ action, path, note, command, line: entry.line });
  }
};

const taskFromHeading = (
  entry: StructuralLine,
  out: LintDefect[]
): DraftTask | null => {
  const heading = TASK_HEADING.exec(entry.text);

  if (
    heading?.[1] === undefined ||
    heading[1] === "" ||
    heading?.[2] === undefined ||
    heading[2] === ""
  ) {
    out.push(
      lint(
        "task-heading",
        entry.line,
        'Task heading must be "### T<n> — <outcome title>".'
      )
    );

    return null;
  }

  return {
    id: heading[1],
    title: heading[2],
    summary: "",
    behaviour: [],
    constraints: [],
    line: entry.line,
    prerequisites: [],
    criteria: [],
    paths: [],
    generated: [],
    overlaps: [],
    prerequisitesLine: null,
    criteriaLine: null,
    summaryLine: entry.line,
    overlapLines: [],
  };
};

const needsActionHeading = (
  changes: readonly PlanChange[],
  out: readonly LintDefect[]
) =>
  !changes.length &&
  !out.some(
    (item) =>
      item.code === "invalid-change-path" ||
      item.code === "unknown-change-marker" ||
      item.code === "change-heading"
  );

const parseChanges = (lines: readonly StructuralLine[], out: LintDefect[]) => {
  const ranges = sectionRanges(lines, "## Proposed Changes");
  const [range] = ranges;

  if (ranges.length !== 1 || !range) {
    out.push(
      lint(
        "proposed-changes",
        null,
        "Expected exactly one ## Proposed Changes section."
      )
    );

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
  let beforeDetails = true;

  for (const [offset, entry] of body.entries()) {
    if (inHeader && task && entry.text.trim() === "<details>") {
      beforeDetails = false;
    }

    if (isDetailWrapper(entry.text)) {
      continue;
    }

    if (/^###\s/u.test(entry.text)) {
      inHeader = true;
      beforeDetails = true;

      const nextTask = taskFromHeading(entry, out);

      if (nextTask === null) {
        task = null;
        malformed = true;

        continue;
      }

      malformed = false;
      task = nextTask;
      tasks.push(task);

      continue;
    }

    const current = task;
    const match = ACTION_HEADING.exec(entry.text);

    if (!match) {
      lintNonActionEntry(entry, current, inHeader, beforeDetails, out);

      continue;
    }

    inHeader = false;

    const action = defined(
      CHANGE_ACTIONS.find((candidate) => candidate === match[1])
    );

    const listed = headingPaths(action, match[2] ?? "");

    if ("error" in listed) {
      out.push(lint("change-heading", entry.line, listed.error));

      continue;
    }

    const paths = resolvedPaths(
      listed.paths,
      current,
      malformed,
      seen,
      entry,
      out
    );

    if (!paths.length) {
      continue;
    }

    const block = changeBlock(body, offset);
    const command = changeCommand(action, block);

    if (action === "GENERATED" && (command === null || command === "")) {
      out.push(
        lint(
          "generated-command",
          entry.line,
          'A [GENERATED] path requires a "- Command: `<generator>`" bullet.'
        )
      );
    }

    recordChange(current, action, paths, command, block, entry, out, changes);
  }

  if (needsActionHeading(changes, out)) {
    out.push(
      lint(
        "change-heading",
        lines[range.start]?.line ?? null,
        "Proposed Changes requires an H4 action heading."
      )
    );
  }

  return { changes, tasks };
};

type FailRow = (line: number | null, detail: string) => void;

const taskMapHeaderOk = (
  entries: readonly StructuralLine[],
  expected: readonly string[],
  failRow: FailRow
) => {
  const header = splitTaskMapRow(defined(entries[0]).text);

  if (
    !header ||
    header.length !== expected.length ||
    header.some((value, index) => value !== expected[index])
  ) {
    failRow(
      defined(entries[0]).line,
      "Task Map columns must be ID, Title, Outcome, Prerequisites, Criteria in that order."
    );

    return false;
  }

  const divider = splitTaskMapRow(defined(entries[1]).text);

  if (
    !divider ||
    divider.length !== expected.length ||
    divider.some((value) => !/^:?-{3,}:?$/u.test(value))
  ) {
    failRow(
      defined(entries[1]).line,
      "Task Map requires a Markdown delimiter row with five cells."
    );

    return false;
  }

  return true;
};

const taskMapList = (
  value: string,
  label: "Prerequisites" | "Criteria",
  noneAllowed: boolean,
  id: string,
  line: number,
  failRow: FailRow
) => {
  const text = value.trim();

  if (!text) {
    failRow(
      line,
      `Task ${id || "(blank)"} requires an explicit ${label} cell; use none only for an empty Prerequisites list.`
    );

    return [];
  }

  if (/^none$/iu.test(text)) {
    if (!noneAllowed) {
      failRow(
        line,
        `Task ${id || "(blank)"} Criteria cell must name at least one criterion.`
      );
    }

    return [];
  }

  const values = text
    .split(",")
    .map((item) => item.trim().replaceAll(/^`|`$/gu, "").toUpperCase());

  if (values.some((item) => !item)) {
    failRow(
      line,
      `Task ${id || "(blank)"} ${label} must be a comma-separated list of IDs.`
    );
  }

  const pattern = label === "Prerequisites" ? /^T[1-9]\d*$/u : /^SC[1-9]\d*$/u;

  if (values.some((item) => !pattern.test(item))) {
    failRow(
      line,
      `Task ${id || "(blank)"} ${label} must contain ${label === "Prerequisites" ? "task IDs T[1-9][0-9]*" : "criterion IDs SC[1-9][0-9]*"}.`
    );
  }

  return [...new Set(values.filter((item) => pattern.test(item)))];
};

const parseTaskMap = (lines: readonly StructuralLine[], out: LintDefect[]) => {
  const ranges = sectionRanges(lines, TASK_MAP_HEADING);

  if (ranges.length !== 1 || !ranges[0]) {
    out.push(
      lint(
        "task-map",
        ranges[0] ? (lines[ranges[0].start]?.line ?? null) : null,
        "Expected exactly one ## Task Map section with the authored task table."
      )
    );

    return [];
  }

  const [range] = ranges;

  const entries = lines
    .slice(range.start + 1, range.end)
    .filter((entry) => entry.text.trim());

  const failRow: FailRow = (line, detail): void => {
    out.push(lint("task-map", line, detail));
  };

  if (entries.length < 2) {
    failRow(
      lines[range.start]?.line ?? null,
      "Task Map requires one header, one delimiter, and at least one task row."
    );

    return [];
  }

  const expected = ["ID", "Title", "Outcome", "Prerequisites", "Criteria"];

  if (!taskMapHeaderOk(entries, expected, failRow)) {
    return [];
  }

  if (entries.length === 2) {
    failRow(
      defined(entries[1]).line,
      "Task Map requires at least one task row."
    );

    return [];
  }

  const rows: AuthoredTaskRow[] = [];
  const seen = new Set<string>();

  for (const entry of entries.slice(2)) {
    const cells = splitTaskMapRow(entry.text);

    if (!cells || cells.length !== expected.length) {
      failRow(
        entry.line,
        String.raw`Task Map rows require exactly five cells; escape literal pipes as \|, including inside inline code.`
      );
      continue;
    }

    const id = defined(cells[0]).replaceAll(/^`|`$/gu, "").trim().toUpperCase();
    const title = defined(cells[1]).trim();
    const outcome = defined(cells[2]).trim();

    if (!/^T[1-9]\d*$/u.test(id)) {
      failRow(entry.line, "Task Map ID must use T[1-9][0-9]*.");
    }

    if (!title) {
      failRow(
        entry.line,
        `Task ${id || "(blank)"} requires a nonempty Title cell.`
      );
    }

    if (!outcome) {
      failRow(
        entry.line,
        `Task ${id || "(blank)"} requires a nonempty Outcome cell.`
      );
    }

    if (seen.has(id)) {
      out.push(
        lint(
          "duplicate-id",
          entry.line,
          `Task Map contains duplicate task ${id}.`
        )
      );
    }

    seen.add(id);

    rows.push({
      id,
      title,
      outcome,
      prerequisites: taskMapList(
        defined(cells[3]),
        "Prerequisites",
        true,
        id,
        entry.line,
        failRow
      ),
      criteria: taskMapList(
        defined(cells[4]),
        "Criteria",
        false,
        id,
        entry.line,
        failRow
      ),
      line: entry.line,
    });
  }

  return rows;
};

const readOverlap = (
  task: DraftTask,
  entry: StructuralLine,
  out: LintDefect[]
) => {
  const overlap = OVERLAP_FIELD.exec(entry.text);

  if (!overlap) {
    return false;
  }

  const parts = /^(?<cap1>.+?)\s+[—–-]\s+(?<cap2>\S.*)$/u.exec(
    overlap[1] ?? ""
  );

  const normalized =
    parts?.[1] === undefined ? null : normalizePlanPath(parts[1]);

  if (
    parts?.[2] === undefined ||
    parts[2] === "" ||
    normalized === null ||
    normalized.path === null ||
    normalized.path === ""
  ) {
    out.push(
      lint(
        "task-overlap",
        entry.line,
        `Task ${task.id} Overlap requires "- Overlap: <path> — <reason>".`
      )
    );

    return true;
  }

  task.overlaps = [
    ...task.overlaps,
    { path: normalized.path, reason: parts[2].trim() },
  ];
  task.overlapLines.push(entry.line);

  return true;
};

const readConstraint = (
  task: DraftTask,
  entry: StructuralLine,
  out: LintDefect[]
) => {
  const constraint = CONSTRAINT_FIELD.exec(entry.text);

  if (!constraint) {
    return false;
  }

  const value = constraint[1]?.trim() ?? "";

  if (value) {
    task.constraints.push(value);
  } else {
    out.push(
      lint(
        "task-map",
        entry.line,
        `Task ${task.id} Constraints must contain a task-specific instruction.`
      )
    );
  }

  return true;
};

/** Task headers accept visible behaviour and owned constraint/overlap fields; Task Map fields stay outside the header. */
const readTaskHeader = (
  task: DraftTask,
  entry: StructuralLine,
  out: LintDefect[],
  beforeDetails: boolean
) => {
  if (!beforeDetails || entry.fenced || isDetailWrapper(entry.text)) {
    return;
  }

  if (readOverlap(task, entry, out)) {
    return;
  }

  if (readConstraint(task, entry, out)) {
    return;
  }

  const field = TASK_FIELD.exec(entry.text);

  if (field?.[1] !== undefined) {
    out.push(
      lint(
        "task-map",
        entry.line,
        `Task ${task.id} ${field[1]} belongs in Task Map; remove this task-section field.`
      )
    );

    return;
  }

  const behaviour = /^[-*+]\s+(?<cap1>.+?)\s*$/u.exec(entry.text);

  if (behaviour?.[1] !== undefined) {
    task.behaviour.push(behaviour[1].trim());

    return;
  }

  const trimmed = entry.text.trim();

  if (trimmed.startsWith("|") || /^Text summary:\s*\S/iu.test(trimmed)) {
    return;
  }

  if (trimmed) {
    out.push(
      lint(
        "task-map",
        entry.line,
        `Task ${task.id} outcome belongs in Task Map; keep task-specific detail under Constraints or Overlap.`
      )
    );
  }
};

const generatedInputs = (
  raw: string | undefined,
  line: number,
  out: LintDefect[]
) => {
  const value = raw?.replace(/^[-*+]\s+Inputs:\s*/u, "").trim();

  if (value === undefined || value === "") {
    out.push(
      lint(
        "generated-inputs",
        line,
        'A [GENERATED] path requires a "- Inputs: <path>[, <path>...]" bullet.'
      )
    );

    return [];
  }

  return value.split(",").flatMap((item) => {
    const normalized = normalizePlanPath(item.replaceAll("`", ""));

    if (normalized.path !== null && normalized.path !== "") {
      return [normalized.path];
    }

    out.push(
      lint(
        "generated-inputs",
        line,
        `Invalid generated input "${item.trim()}": ${normalized.reason ?? "empty"}.`
      )
    );

    return [];
  });
};

/** Keep primary change detail and explicitly labelled file invariants in the owned brief. */
const changeNote = (block: readonly string[]) => {
  const labelled = block.findIndex((text) =>
    /^[-*+]\s+(?:Changes|Purpose):/u.test(text)
  );

  const continuations = (index: number) => {
    const result: string[] = [];

    for (const text of block.slice(index + 1)) {
      if (/^[-*+]\s/u.test(text) || /^\S/u.test(text)) {
        break;
      }

      if (text.trim()) {
        result.push(text);
      }
    }

    return result;
  };

  const detail =
    labelled === -1
      ? ""
      : (block[labelled] ?? "")
          .replace(/^[-*+]\s+(?:Changes|Purpose):\s*/u, "")
          .trim()
          .replace(/;$/u, "");

  const fallback = block.find(
    (text) => /^[-*+]\s+\S/u.test(text) && !/^[-*+]\s+\w+:/u.test(text)
  );

  const primary =
    labelled === -1
      ? (fallback ?? "")
          .replace(/^[-*+]\s+/u, "")
          .trim()
          .replace(/;$/u, "")
      : [detail, ...continuations(labelled)].filter(Boolean).join("\n");

  const invariants = block.flatMap((text, index) =>
    /^[-*+]\s+Invariants:/u.test(text)
      ? [text.replace(/^[-*+]\s+/u, ""), ...continuations(index)]
      : []
  );

  return [primary, ...invariants].filter(Boolean).join("\n");
};

const excluded = (line: number, value: string) =>
  lint(
    "change-path-excluded",
    line,
    `Change path "${value}" is under .git/ or .scratch/; implementation never writes there.`
  );

// SECTION: Verification and criteria

const parseVerification = (
  lines: readonly StructuralLine[],
  out: LintDefect[]
) => {
  const empty = { automated: [], none: null, manual: [] };
  const ranges = sectionRanges(lines, "## Verification Plan");
  const [range] = ranges;

  if (ranges.length !== 1 || !range) {
    out.push(
      lint(
        "verification-plan",
        null,
        "Expected exactly one ## Verification Plan section."
      )
    );

    return empty;
  }

  const headings = lines.flatMap((entry, index) =>
    entry.text.trimEnd() === "### Automated Tests" ? [index] : []
  );

  const owned = headings.filter(
    (index) => index > range.start && index < range.end
  );

  if (owned.length !== 1) {
    out.push(
      lint(
        "automated-tests",
        null,
        "Expected exactly one ### Automated Tests under Verification Plan."
      )
    );
  }

  if (headings.some((index) => !owned.includes(index))) {
    out.push(
      lint(
        "automated-tests-owner",
        null,
        "Automated Tests must belong to Verification Plan."
      )
    );
  }

  const [start] = owned;

  if (owned.length !== 1 || start === undefined) {
    return empty;
  }

  const subsection = (from: number) => {
    let { end } = range;

    for (let index = from + 1; index < end; index += 1) {
      if (/^#{2,3}\s+/u.test(lines[index]?.text ?? "")) {
        end = index;
        break;
      }
    }

    return lines.slice(from + 1, end);
  };

  const section = subsection(start);
  const automated: string[] = [];

  for (const entry of section) {
    const direct = /^-\s+`(?<cap1>[^`]+)`\s*$/u.exec(entry.text)?.[1];

    if (direct !== undefined) {
      automated.push(direct.trim());
    }

    if (/^-\s+.*`[^`]+`.*`[^`]+`/u.test(entry.text)) {
      out.push(
        lint(
          "ambiguous-command",
          entry.line,
          "Automated-test bullet contains multiple inline-code spans."
        )
      );
    }
  }

  const noneEntry = section.find(({ text }) =>
    /^-\s+None:\s*\S.*$/u.test(text)
  );

  const none = noneEntry
    ? noneEntry.text.replace(/^-\s+None:\s*/u, "").trim()
    : null;

  if (noneEntry) {
    out.push(
      lint(
        "automated-tests-unavailable",
        noneEntry.line,
        "Automated tests are explicitly unavailable."
      )
    );
  }

  // Fenced commands are not parsed into `automated`, so they cannot satisfy the section.
  if (!automated.length && !noneEntry) {
    out.push(
      lint(
        "automated-command",
        lines[start]?.line ?? null,
        "Automated Tests requires a command or - None: <reason>."
      )
    );
  }

  const manualIndex = lines.findIndex(
    (entry, index) =>
      index > range.start &&
      index < range.end &&
      entry.text.trimEnd() === "### Manual Verification"
  );

  const manual =
    manualIndex === -1
      ? []
      : subsection(manualIndex).flatMap(
          ({ text }) => /^[-*+]\s+(?<cap1>.+)$/u.exec(text)?.[1]?.trim() ?? []
        );

  return { automated, none, manual };
};

const parseCriteria = (
  lines: readonly StructuralLine[],
  changes: readonly PlanChange[],
  out: LintDefect[]
) => {
  const ranges = sectionRanges(lines, "## Success Criteria");

  if (!ranges.length) {
    out.push(
      lint(
        "missing-success-criteria",
        null,
        "Plan has no Success Criteria section."
      )
    );

    return [];
  }

  const [range] = ranges;

  if (ranges.length > 1 || !range) {
    out.push(
      lint(
        "success-criteria",
        null,
        "Expected at most one Success Criteria section."
      )
    );

    return [];
  }

  const approved = new Set(changes.map((change) => change.path));
  const ids = new Set<string>();
  const criteria: Criterion[] = [];
  let current: Criterion | null = null;

  const finish = () => {
    if (current) {
      finishCriterion(current, out);

      if (current.valid) {
        criteria.push(current);
      }
    }
  };

  for (const entry of lines.slice(range.start + 1, range.end)) {
    if (isDetailWrapper(entry.text)) {
      continue;
    }

    if (entry.text.trim().startsWith("|")) {
      out.push(
        lint(
          "criterion-format",
          entry.line,
          "Success Criteria requires detailed [SC#] entries."
        )
      );
      continue;
    }

    const item = /^(?:[-*+]|\d+[.)])\s+(?<cap1>.+)$/u.exec(entry.text)?.[1];

    if (item !== undefined) {
      finish();
      current = startCriterion(item, entry.line, ids, out);
      continue;
    }

    if (current) {
      readMapping(current, entry, approved, out);
    }
  }

  finish();

  if (!ids.size) {
    out.push(
      lint(
        "success-criteria",
        lines[range.start]?.line ?? null,
        "Success Criteria requires at least one detailed [SC#] entry."
      )
    );
  }

  return criteria;
};

const startCriterion = (
  text: string,
  line: number,
  ids: Set<string>,
  out: LintDefect[]
) => {
  const id = criterionHeading(text);

  const base: Criterion = {
    id: "",
    title: text,
    line,
    satisfies: [],
    changes: [],
    tests: [],
    verify: [],
    evidence: null,
    preExisting: null,
    redException: null,
    red: null,
    review: null,
    enforcementInfeasibility: null,
    verifyLines: [],
    testsLine: null,
    redCommandLine: null,
    integration: null,
    mapped: false,
    evidenceRaw: null,
    evidenceLine: line,
    redLine: line,
    reviewLine: line,
    critical: CRITICAL.test(text),
    valid: false,
  };

  if (!id) {
    out.push(
      lint(
        "criterion-id",
        line,
        "Success criterion requires a stable [SC#] identifier."
      )
    );

    return base;
  }

  if (ids.has(id.id)) {
    out.push(lint("criterion-id", line, `Duplicate criterion ${id.id}.`));
  }

  ids.add(id.id);

  return { ...base, id: id.id, title: id.title, valid: true };
};

const readSatisfies = (
  current: Criterion,
  raw: string | undefined,
  entry: StructuralLine,
  out: LintDefect[]
) => {
  if (raw === undefined) {
    return;
  }

  const ids = raw.split(",").map((value) => value.trim());

  if (ids.some((id) => !/^REQ-[1-9]\d*$/u.test(id))) {
    if (
      !out.some(
        (defect) =>
          defect.code === "missing-satisfies" &&
          defect.line !== null &&
          defect.line >= current.line
      )
    ) {
      out.push(
        lint(
          "missing-satisfies",
          entry.line,
          "Satisfies requires comma-separated REQ-<n> IDs."
        )
      );
    }

    return;
  }

  current.satisfies = ids;
};

const readChangesMapping = (
  current: Criterion,
  raw: string | undefined,
  approved: ReadonlySet<string>,
  entry: StructuralLine,
  out: LintDefect[]
) => {
  if (raw === undefined || raw === "") {
    return;
  }

  current.mapped = true;
  const paths: string[] = [...current.changes];

  for (const value of raw.split(",")) {
    const normalized = normalizePlanPath(value);

    if (
      normalized.path !== null &&
      normalized.path !== "" &&
      EXCLUDED_CHANGE_PATH.test(normalized.path)
    ) {
      out.push(excluded(entry.line, normalized.path));
    } else if (
      normalized.path === null ||
      normalized.path === "" ||
      !approved.has(normalized.path)
    ) {
      out.push(
        lint(
          "criterion-change-path",
          entry.line,
          `Criterion references unknown change path "${value.trim()}".`
        )
      );
    }

    if (normalized.path !== null && normalized.path !== "") {
      paths.push(normalized.path);
    }
  }

  current.changes = paths;
};

const readTestsMapping = (
  current: Criterion,
  raw: string | undefined,
  entry: StructuralLine,
  out: LintDefect[]
) => {
  if (raw === undefined) {
    return;
  }

  current.testsLine ??= entry.line;
  const paths: string[] = [...current.tests];

  for (const value of raw.split(",")) {
    const normalized = normalizePlanPath(value);

    if (normalized.path !== null && normalized.path !== "") {
      paths.push(normalized.path);
    } else {
      out.push(
        lint(
          "criterion-tests-path",
          entry.line,
          `Tests requires comma-separated relative test paths; "${value.trim()}" is ${normalized.reason}.`
        )
      );
    }
  }

  current.tests = [...new Set(paths)];
};

const readRedMapping = (
  current: Criterion,
  raw: string | undefined,
  entry: StructuralLine,
  out: LintDefect[]
) => {
  if (raw === undefined) {
    return;
  }

  const command = /^`(?<cap1>[^`]+)`\s*$/u.exec(raw)?.[1]?.trim();

  if (current.redCommandLine !== null) {
    out.push(
      lint(
        "criterion-red-command",
        entry.line,
        "Criterion requires at most one RED command."
      )
    );
  } else if (command !== undefined && command !== "") {
    current.red = command;
  } else {
    out.push(
      lint(
        "criterion-red-command",
        entry.line,
        "RED requires exactly one inline-code command."
      )
    );
  }

  current.redCommandLine = entry.line;
};

const readCheckMapping = (
  current: Criterion,
  raw: string | undefined,
  entry: StructuralLine,
  out: LintDefect[]
) => {
  if (raw === undefined) {
    return;
  }

  current.mapped = true;
  const command = /^`(?<cap1>[^`]+)`\s*$/u.exec(raw);

  if (command?.[1] !== undefined && command[1] !== "") {
    current.verify = [...current.verify, { command: command[1].trim() }];
    current.verifyLines = [...current.verifyLines, entry.line];
  } else {
    out.push(
      lint(
        "criterion-check",
        entry.line,
        "Check requires exactly one inline-code command."
      )
    );
  }
};

const readMapping = (
  current: Criterion,
  entry: StructuralLine,
  approved: ReadonlySet<string>,
  out: LintDefect[]
) => {
  const field = (name: string) =>
    new RegExp(`^ {2,}[-*+] ${name}:\\s*(.*)$`, "iu")
      .exec(entry.text)?.[1]
      ?.trim();

  readSatisfies(current, field("Satisfies"), entry, out);
  readChangesMapping(current, field("Changes"), approved, entry, out);
  readTestsMapping(current, field("Tests"), entry, out);
  // `RED exception:` cannot match: the field name must end at the colon.
  readRedMapping(current, field("RED"), entry, out);
  readCheckMapping(current, field("Check"), entry, out);

  if (field("Verify") !== undefined) {
    out.push(
      lint(
        "criterion-check",
        entry.line,
        "Verify: is retired; use Check: instead."
      )
    );
  }

  const evidence = /^ {2,}[-*+] Evidence:\s*(?<cap1>\S+)\s*$/u.exec(
    entry.text
  )?.[1];

  if (evidence !== undefined) {
    if (current.evidenceRaw !== null) {
      out.push(
        lint(
          "criterion-evidence",
          entry.line,
          "Criterion requires exactly one Evidence mapping."
        )
      );
    }

    current.evidenceRaw = evidence.toLowerCase();
    current.evidenceLine = entry.line;
    current.evidence =
      EVIDENCE.find((item) => item === current.evidenceRaw) ?? null;
  }

  const preExisting = field("Pre-existing");

  if (preExisting !== undefined) {
    if (!/^(?<cap1>yes|no)$/iu.test(preExisting)) {
      out.push(
        lint("criterion-format", entry.line, "Pre-existing must be yes or no.")
      );
    }

    current.preExisting = /^yes$/iu.test(preExisting);
  }

  const review = field("Review");

  if (review !== undefined) {
    current.review = review;
    current.reviewLine = entry.line;
  }

  const red = field("RED exception");

  if (red !== undefined) {
    current.redException = red.toLowerCase();
    current.redLine = entry.line;
  }

  const integration = field("Integration");

  if (integration !== undefined) {
    current.integration = integration;
  }

  const enforcement = field("Enforcement infeasibility");

  if (enforcement !== undefined && enforcement.trim()) {
    current.enforcementInfeasibility = enforcement.trim();
  }
};

/** A test-like Changes path outside every `Tests:` cannot feed RED capture, so the author declares it or confirms it is not a test. */
const lintUndeclaredTestPaths = (
  criteria: readonly Criterion[],
  out: LintDefect[]
) => {
  const declared = new Set(criteria.flatMap((criterion) => criterion.tests));
  const warned = new Set<string>();

  for (const criterion of criteria) {
    for (const path of criterion.changes) {
      if (
        declared.has(path) ||
        warned.has(path) ||
        !isTestPath(path) ||
        isTestSupportPath(path)
      ) {
        continue;
      }

      warned.add(path);
      out.push(
        lint(
          "undeclared-test-path",
          criterion.line,
          `Criterion ${criterion.id} changes test-like path ${path} that no criterion lists in Tests:.`
        )
      );
    }
  }
};

/** Criterion IDs plus finding IDs recorded under Review Findings, which governedText strips. */
const collectPlanIds = (
  lines: readonly StructuralLine[],
  criteria: readonly Criterion[]
) => {
  const ids = new Set(criteria.map((criterion) => criterion.id));

  for (const range of sectionRanges(lines, RESOLUTION_HEADING)) {
    for (const { text } of lines.slice(range.start + 1, range.end)) {
      for (const id of text.match(FINDING_ID) ?? []) {
        ids.add(id.toUpperCase());
      }
    }
  }

  return [...ids].toSorted();
};

/** Tests outlive plans, so Check commands and test file names must not carry plan-scoped IDs. */
const lintPlanIdNames = (
  criteria: readonly Criterion[],
  changes: readonly PlanChange[],
  ids: readonly string[],
  out: LintDefect[]
) => {
  const pattern = planIdPattern(ids);

  if (!pattern) {
    return;
  }

  const check = (where: string, value: string, line: number) => {
    const id = pattern.exec(value)?.[0];

    if (id !== undefined) {
      out.push(
        lint(
          "plan-id-in-test-name",
          line,
          `${where} names plan ID ${id.toUpperCase()}; name the behavior instead.`
        )
      );
    }
  };

  for (const criterion of criteria) {
    for (const [index, item] of criterion.verify.entries()) {
      check(
        `Criterion ${criterion.id} Check`,
        item.command,
        criterion.verifyLines[index] ?? criterion.line
      );
    }

    if (criterion.red !== null) {
      check(
        `Criterion ${criterion.id} RED`,
        criterion.red,
        criterion.redCommandLine ?? criterion.line
      );
    }
  }

  const declared = new Set(criteria.flatMap((criterion) => criterion.tests));

  for (const change of changes) {
    if (declared.has(change.path)) {
      check(
        `Test path ${change.path}`,
        change.path.slice(change.path.lastIndexOf("/") + 1),
        change.line
      );
    }
  }
};

/** `- Seams: <entry>[, <entry>...]` bullets directly under Verification Plan, before its first subsection. */
const parseSeamDeclarations = (lines: readonly StructuralLine[]) => {
  const [range] = sectionRanges(lines, "## Verification Plan");

  if (!range) {
    return [];
  }

  const declarations: { value: string }[] = [];

  for (const { text } of lines.slice(range.start + 1, range.end)) {
    if (/^###\s/u.test(text)) {
      break;
    }

    const value = /^[-*+]\s+Seams:\s*(?<cap1>.*?)\s*$/iu.exec(text)?.[1];

    if (value !== undefined) {
      declarations.push({ value });
    }
  }

  return declarations;
};

const seamsFromDeclarations = (declarations: readonly { value: string }[]) => {
  const seams: string[] = [];

  for (const { value } of declarations) {
    if (/^none$/iu.test(value)) {
      continue;
    }

    // A comma inside a code span belongs to its entry.
    for (const item of value.match(/(?:`[^`]*`|[^,])+/gu) ?? []) {
      const seam = item.replaceAll("`", "").trim();

      if (seam) {
        seams.push(seam);
      }
    }
  }

  return seams;
};

const checkCoverageDefects = (
  current: Criterion,
  name: string,
  out: LintDefect[]
) => {
  // Only test-like Check paths count: an aggregate Check such as `npm test` names no file and stays exempt.
  const runnable = current.tests.filter((item) => !isTestSupportPath(item));
  const named = current.verify.flatMap((item) => checkPathTokens(item.command));

  const covers = (token: string) =>
    runnable.some(
      (item) =>
        item === token ||
        item.startsWith(token.endsWith("/") ? token : `${token}/`)
    );

  if (runnable.length && named.some(isTestPath) && !named.some(covers)) {
    out.push(
      lint(
        "criterion-check-tests",
        current.verifyLines[0] ?? current.line,
        `Criterion ${name} Check names none of its Tests paths: ${runnable.join(", ")}.`
      )
    );
  }
};

const reviewEvidenceDefects = (current: Criterion, out: LintDefect[]) => {
  if (current.evidence !== "review") {
    return;
  }

  if (current.review === null) {
    out.push(
      lint(
        "criterion-review",
        current.line,
        "Review evidence requires Review: <artifact>; scenario: <scenario>; pass: <observable condition>."
      )
    );

    return;
  }

  // Each label needs a non-empty value up to the next `;`.
  if (!/(?:artifact|file|path)\s*:\s*[^;\s]/iu.test(current.review)) {
    out.push(
      lint(
        "criterion-review",
        current.reviewLine,
        "Review must name the artifact with artifact:, file:, or path:."
      )
    );
  }

  if (!/scenario\s*:\s*[^;\s]/iu.test(current.review)) {
    out.push(
      lint(
        "criterion-review",
        current.reviewLine,
        "Review must name a bounded scenario with scenario:."
      )
    );
  }

  if (!/(?:pass|observable)\s*:\s*[^;\s]/iu.test(current.review)) {
    out.push(
      lint(
        "criterion-review",
        current.reviewLine,
        "Review must name the observable pass condition with pass: or observable:."
      )
    );
  }

  if (current.critical && current.enforcementInfeasibility === null) {
    out.push(
      lint(
        "criterion-critical-review",
        current.line,
        "Critical correctness, safety, recovery, durability, or protocol review evidence requires Enforcement infeasibility: <reason>."
      )
    );
  }
};

const finishCriterion = (current: Criterion, out: LintDefect[]) => {
  if (
    !current.satisfies?.length &&
    !out.some(
      (defect) =>
        defect.code === "missing-satisfies" &&
        defect.line !== null &&
        defect.line >= current.line
    )
  ) {
    out.push(
      lint(
        "missing-satisfies",
        current.line,
        "Criterion requires Satisfies: REQ-<n>."
      )
    );
  }

  const name = current.id || "without an ID";

  if (!current.mapped) {
    out.push(
      lint(
        "criterion-mapping",
        current.line,
        "Criterion requires Changes or Check mapping."
      )
    );
  }

  if (current.evidenceRaw === null) {
    out.push(
      lint(
        "criterion-evidence",
        current.line,
        `Criterion ${name} requires exactly one Evidence mapping: red, check, or review.`
      )
    );
  } else if (!current.evidence) {
    out.push(
      lint(
        "criterion-evidence",
        current.evidenceLine,
        `Unknown Evidence class "${current.evidenceRaw}"; accepted classes are red, check, review.`
      )
    );
  }

  if (
    current.redException !== null &&
    (!RED_EXCEPTIONS.includes(current.redException) ||
      current.evidence !== "red")
  ) {
    out.push(
      lint(
        "criterion-red-exception",
        current.redLine,
        `RED exception must be ${RED_EXCEPTIONS.join(" or ")} on an Evidence: red criterion.`
      )
    );
  }

  const changes = new Set(current.changes);

  for (const path of current.tests.filter((item) => !changes.has(item))) {
    out.push(
      lint(
        "criterion-tests-path",
        current.testsLine ?? current.line,
        `Criterion ${name} Tests path ${path} is not in its Changes.`
      )
    );
  }

  checkCoverageDefects(current, name, out);

  if (
    current.evidence === "red" &&
    current.redException === null &&
    !current.tests.length
  ) {
    out.push(
      lint(
        "criterion-red-test-path",
        current.line,
        `Criterion ${name} uses red evidence but declares no Tests: path; its red evidence downgrades to check.`
      )
    );
  }

  if (
    current.evidence === "red" &&
    current.redException === null &&
    current.red === null
  ) {
    out.push(
      lint(
        "red-downgraded",
        current.line,
        `Criterion ${name} declares no RED: \`<command>\`; its red evidence downgrades to check.`
      )
    );
  }

  reviewEvidenceDefects(current, out);
};
