import { isDetailWrapper, structuralLines } from "./markdown-structure.ts";
import type { StructuralLine } from "./markdown-structure.ts";

export const RESOLUTION_TITLE = "Review Findings & Resolutions";
export const EXECUTION_STATUS_TITLE = "Execution Status";
export const RESOLUTION_HEADING = `## ${RESOLUTION_TITLE}`;
export const EXECUTION_STATUS_HEADING = `## ${EXECUTION_STATUS_TITLE}`;

export const SPEC_PIN_VALUE =
  /^`(?<cap1>[^`\s]+\.spec\.md)` · sha256:(?<cap2>[0-9a-f]{64})$/u;

// SECTION: Lint severity

const LINT_SEVERITIES = {
  "missing-success-criteria": "defect",
  "proposed-changes": "defect",
  "change-heading": "defect",
  "unknown-change-marker": "defect",
  "invalid-change-path": "defect",
  "duplicate-change-path": "defect",
  "verification-plan": "defect",
  "automated-tests": "defect",
  "automated-tests-owner": "defect",
  "automated-command": "defect",
  "success-criteria": "defect",
  "criterion-format": "defect",
  "criterion-id": "defect",
  "criterion-mapping": "defect",
  "criterion-change-path": "defect",
  "criterion-check": "defect",
  "criterion-evidence": "defect",
  "duplicate-id": "defect",
  "task-heading": "defect",
  "task-ownership": "defect",
  "task-criteria": "defect",
  "criterion-task-changes": "defect",
  "task-map": "defect",
  "long-paragraph": "warning",
  placeholder: "warning",
  "ambiguous-command": "warning",
  "automated-tests-unavailable": "warning",
  "unsatisfied-requirement": "warning",
  "criterion-red-test-path": "warning",
  overlap: "warning",
  "missing-seams": "warning",
  "red-downgraded": "warning",
  "undeclared-test-path": "warning",
  "missing-summary-box": "warning",
  "summary-label": "warning",
  "leftover-placeholder": "warning",
  "filler-note": "warning",
  "section-order": "warning",
  "missing-satisfies": "warning",
  "missing-requirement-ref": "warning",
  "unknown-requirement": "warning",
  "plan-id-in-test-name": "warning",
  "outside-increment": "warning",
  "task-summary": "warning",
  "task-behaviour": "warning",
  "increment-behaviour": "warning",
  "task-overlap": "warning",
  "automated-test-duplicates-check": "warning",
  "criterion-critical-review": "warning",
  "change-path-excluded": "warning",
  "generated-command": "warning",
  "criterion-red-exception": "warning",
  "criterion-tests-path": "warning",
  "criterion-check-tests": "warning",
  "criterion-red-command": "warning",
  "criterion-review": "warning",
  "missing-section": "warning",
  "missing-increment-details": "warning",
  "missing-increment-field": "warning",
  "invalid-priority": "warning",
  "missing-increments": "warning",
  "invalid-id-sequence": "warning",
  "invalid-priority-order": "warning",
  "missing-prerequisite": "warning",
  cycle: "warning",
  "execution-status": "warning",
  "generated-inputs": "warning",
  "glance-restates-task-map": "warning",
} as const;

export type LintDefectCode = keyof typeof LINT_SEVERITIES;

export interface LintDefect {
  code: LintDefectCode;
  severity: "defect" | "warning";
  line: number | null;
  message: string;
}

export const lint = (
  code: LintDefectCode,
  line: number | null,
  message: string
) => {
  if (!Object.hasOwn(LINT_SEVERITIES, code)) {
    throw new Error(`unhandled lint code: ${code}`);
  }

  return { code, severity: LINT_SEVERITIES[code], line, message };
};

export const LONG_PARAGRAPH_WORDS = 60;

/** Count prose only; structural boundaries also stop a preceding paragraph. */
export const lintLongParagraphs = (lines: readonly StructuralLine[]) => {
  const out: { line: number; words: number }[] = [];
  let paragraph: { line: number; words: number } | null = null;

  const finish = () => {
    if (paragraph && paragraph.words > LONG_PARAGRAPH_WORDS) {
      out.push(paragraph);
    }

    paragraph = null;
  };

  for (const entry of lines) {
    const { text } = entry;

    if (
      !text.trim() ||
      /^(?:#{1,6}\s|\s*(?:[-*+]\s|\d+[.)]\s|\|))/u.test(text) ||
      isDetailWrapper(text)
    ) {
      finish();
      continue;
    }

    if (!paragraph && /^\s/u.test(text)) {
      continue;
    }

    paragraph ??= { line: entry.line, words: 0 };

    paragraph.words += text.trim().split(/\s+/u).length;
  }

  finish();

  return out;
};

/** Each present `order` heading must follow every earlier-listed present heading; absent and unlisted `##` sections are ignored. */
export const lintSectionOrder = (
  lines: readonly StructuralLine[],
  order: readonly string[]
) => {
  const out: LintDefect[] = [];
  let latest: { rank: number; heading: string } | null = null;

  for (const entry of lines) {
    const heading = entry.text.trimEnd();
    const rank = order.indexOf(heading);

    if (rank === -1) {
      continue;
    }

    if (latest && rank < latest.rank) {
      out.push(
        lint(
          "section-order",
          entry.line,
          `Move "${heading}" before "${latest.heading}"; sections follow the template order.`
        )
      );
    } else {
      latest = { rank, heading };
    }
  }

  return out;
};

// SECTION: Summary box

interface BoxEntry {
  label: string | null;
  value: string;
  line: number;
  raw: string;
}

type ValueRule = RegExp | ((value: string) => string | null);

const BOX_LINE = /^> \*\*(?<cap1>[^*]+?):\*\*(?: (?<cap2>.*))?$/u;

// Keyed by whatever label the author wrote, so any string may be looked up.
interface ValueRules {
  readonly [label: string]: ValueRule | undefined;
}

interface BoxValues {
  [label: string]: string;
}

const BOX_VALUE_RULES: ValueRules = {
  Risk: /^(?<cap1>low|med|high) — \S/u,
  Increments: /^[1-9]\d*$/u,
  Status: /^(?:\d+\/\d+ SC passing|n\/a)$/u,
};

/** Lines after optional `---` frontmatter and their 1-based line offset. */
const bodyLines = (source: string) => {
  const lines = source.split(/\r?\n/u);

  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex(
      (line, index) => index > 0 && line.trim() === "---"
    );

    if (close !== -1) {
      return { lines: lines.slice(close + 1), offset: close + 1 };
    }
  }

  return { lines, offset: 0 };
};

export const documentTitle = (source: string) => {
  const line = bodyLines(source).lines.find((item) => item.trim());

  return line !== undefined && /^#\s+\S/u.test(line)
    ? line.replace(/^#\s+/u, "").trim()
    : null;
};

const parseBoxEntries = (
  lines: readonly string[],
  start: number,
  offset: number
) => {
  const entries: BoxEntry[] = [];
  let index = start;

  for (
    ;
    index < lines.length && (lines[index] ?? "").startsWith(">");
    index += 1
  ) {
    const raw = (lines[index] ?? "").trimEnd();

    if (/^>\s*$/u.test(raw)) {
      continue;
    }

    const match = BOX_LINE.exec(raw);

    entries.push({
      label: match?.[1] ?? null,
      value: match?.[2]?.trim() ?? "",
      line: index + 1 + offset,
      raw,
    });
  }

  return { entries, index };
};

const afterBlankLines = (lines: readonly string[], start: number) => {
  let index = start;

  while (index < lines.length && !(lines[index] ?? "").trim()) {
    index += 1;
  }

  return index;
};

const boxTrailing = (lines: readonly string[], index: number) => {
  const next = lines[index];

  return next === undefined || /^##\s/u.test(next) ? null : next;
};

/** H1, one blank line, `> **Label:** value` lines with optional blank quote separators, then the first `##`; null when absent. */
export const parseSummaryBox = (source: string) => {
  const { lines, offset } = bodyLines(source);
  let index = lines.findIndex((line) => line.trim());

  if (index === -1 || !/^#\s+\S/u.test(lines[index] ?? "")) {
    return null;
  }

  index += 1;

  if (
    lines[index]?.trim() !== "" ||
    lines[index + 1]?.startsWith(">") !== true
  ) {
    return null;
  }

  const parsed = parseBoxEntries(lines, index + 1, offset);

  return {
    entries: parsed.entries,
    trailing: boxTrailing(lines, afterBlankLines(lines, parsed.index)),
  };
};

export const boxValues = (source: string) => {
  const values: BoxValues = {};

  for (const entry of parseSummaryBox(source)?.entries ?? []) {
    if (entry.label !== null && entry.label !== "") {
      values[entry.label] = entry.value;
    }
  }

  return values;
};

const lintBoxEntry = (
  entry: BoxEntry,
  rules: ValueRules,
  label: (line: number, message: string) => void
) => {
  if (entry.label === null || entry.label === "") {
    return;
  }

  if (entry.value === "") {
    label(entry.line, `Summary label ${entry.label} requires a value.`);

    return;
  }

  const rule = rules[entry.label];

  if (typeof rule === "object" && "test" in rule && !rule.test(entry.value)) {
    label(
      entry.line,
      `Summary ${entry.label} value "${entry.value}" does not match ${String(rule)}.`
    );
  }

  if (typeof rule === "function") {
    const message = rule(entry.value);

    if (message !== null && message !== "") {
      label(entry.line, message);
    }
  }
};

export const lintSummaryBox = (
  source: string,
  labels: readonly string[],
  valueRules: Readonly<Record<string, ValueRule>> = {}
) => {
  const box = parseSummaryBox(source);

  if (!box) {
    return [
      lint(
        "missing-summary-box",
        null,
        `Summary box required after the H1: ${labels.map((label) => `> **${label}:**`).join(", ")}.`
      ),
    ];
  }

  const out: LintDefect[] = [];

  const label = (line: number | null, message: string): void => {
    out.push(lint("summary-label", line, message));
  };

  for (const entry of box.entries) {
    if (entry.label === null || entry.label === "") {
      label(
        entry.line,
        `Malformed summary line "${entry.raw}"; use > **Label:** value.`
      );
    }
  }

  const found = box.entries.flatMap((entry) =>
    entry.label !== null && entry.label !== "" ? [entry.label] : []
  );

  if (found.join("\n") !== labels.join("\n")) {
    label(
      box.entries[0]?.line ?? null,
      `Summary labels must be exactly ${labels.join(", ")} in order; found ${found.join(", ") || "none"}.`
    );
  }

  const rules: ValueRules = { ...BOX_VALUE_RULES, ...valueRules };

  for (const entry of box.entries) {
    lintBoxEntry(entry, rules, label);
  }

  if (box.trailing !== null) {
    label(null, "The summary box must be followed by the first ## section.");
  }

  return out;
};

// SECTION: Template placeholders

export interface PlaceholderVocabulary {
  all: ReadonlySet<string>;
  code: ReadonlySet<string>;
}

// CommonMark spans close on a backtick run of the opener's exact length.
const CODE_SPAN = /(?<!`)(?<cap1>`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/gu;
const TOKEN = /<[A-Za-z][^<>\n]*>/gu;

/** Innermost `<...>` tokens of the templates' fenced bodies; `code` holds those the templates put in inline code. */
export const placeholderVocabulary = (templates: readonly string[]) => {
  const all = new Set<string>();
  const code = new Set<string>();

  for (const text of templates) {
    const body =
      /^(?<cap1>`{3,})markdown\s*\n(?<cap2>[\s\S]*?)\n\1\s*$/mu.exec(
        text.replaceAll("\r\n", "\n")
      )?.[2] ?? "";

    for (const token of body.match(TOKEN) ?? []) {
      if (!/^<\/?(?:details|summary)>$/u.test(token)) {
        all.add(token);
      }
    }

    for (const span of body.match(CODE_SPAN) ?? []) {
      for (const token of span.match(TOKEN) ?? []) {
        if (!/^<\/?(?:details|summary)>$/u.test(token)) {
          code.add(token);
        }
      }
    }
  }

  return { all, code };
};

/** Vocabulary tokens left in prose or inline code, outside frontmatter, fences, and comments. */
export const findPlaceholders = (
  source: string,
  vocabulary: PlaceholderVocabulary
) => {
  const { lines, offset } = bodyLines(source);
  const structural = structuralLines(lines.join("\n"));

  return structural.flatMap(({ text, line }) => {
    const code = (text.match(CODE_SPAN) ?? [])
      .flatMap((span) => span.match(TOKEN) ?? [])
      .filter((token) => vocabulary.code.has(token));

    const prose = (text.replaceAll(CODE_SPAN, "").match(TOKEN) ?? []).filter(
      (token) => vocabulary.all.has(token)
    );

    return [...prose, ...code].map((token) => ({ token, line: line + offset }));
  });
};

// SECTION: Filler notes

const FILLER = new Set([
  "same",
  "see above",
  "unchanged",
  "n/a",
  "approved implementation scope",
  "included in the selected review scope",
]);

const DELTA = /^\+\d+ −\d+$/u;
const FIXES_SUFFIX = /(?:^|; )fixes (?<cap1>R\d+-F\d{3,}(?:, R\d+-F\d{3,})*)$/u;

const normalizeNote = (note: string) =>
  note.replaceAll(/\s+/gu, " ").trim().toLowerCase().replace(/\.$/u, "");

const baseNote = (note: string) => {
  const match = FIXES_SUFFIX.exec(note.trim());

  return match ? note.trim().slice(0, match.index) : note;
};

/** Empty, a stock phrase, or a copy of a sibling note (ignoring `fixes <IDs>` suffixes). */
export const isFillerNote = (
  note: string,
  siblings: readonly string[] = []
) => {
  const value = normalizeNote(note);

  if (!value || FILLER.has(value)) {
    return true;
  }

  const base = normalizeNote(baseNote(note));

  if (!base || DELTA.test(base)) {
    return false;
  }

  return siblings.some((sibling) => normalizeNote(baseNote(sibling)) === base);
};

const BEHAVIOUR_PLACEHOLDER =
  /^(?:TODO|TBD|implement later|fill in|<[^<>]+>)$/iu;

const FILE_COUNT_SUMMARY =
  /^\d+\s+(?:(?:new|modified|deleted|changed)\s+)?files?(?:(?:\s*[,;]\s*|\s+and\s+)\d+\s+(?:(?:new|modified|deleted|changed)\s+)?files?)*(?:\s+(?:touched|changed|modified))?$/iu;

export const hasBehaviour = (behaviour: readonly string[]) =>
  behaviour.some((bullet) => {
    const value = bullet
      .replaceAll(CODE_SPAN, "")
      .trim()
      .replace(/\.$/u, "")
      .trim();

    return (
      Boolean(value) &&
      !BEHAVIOUR_PLACEHOLDER.test(value) &&
      !FILE_COUNT_SUMMARY.test(value)
    );
  });
