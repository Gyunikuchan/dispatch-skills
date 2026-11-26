import { isRecord } from "../../lib/config.ts";
import {
  SPEC_PIN_VALUE,
  boxValues,
  documentTitle,
  EXECUTION_STATUS_HEADING,
  findPlaceholders,
  hasBehaviour,
  isFillerNote,
  lintLongParagraphs,
  LONG_PARAGRAPH_WORDS,
  lintSectionOrder,
  lintSummaryBox,
  RESOLUTION_HEADING,
} from "./document-lint.ts";
import type { PlaceholderVocabulary } from "./document-lint.ts";
import {
  sectionRanges,
  structuralLines,
  withoutSections,
} from "./markdown-structure.ts";
import type { StructuralLine } from "./markdown-structure.ts";
import type {
  DesignIncrement,
  ExecutionStatusRow,
  IncrementState,
  LintDefect,
  ParsedDesign,
} from "./types.ts";

const lint = (code: LintDefect["code"], line: number | null, message: string) =>
  ({
    code,
    severity: "warning",
    line,
    message,
  }) satisfies LintDefect;

const BOX_LABELS = ["Parent", "Decide", "Risk", "Increments"];

const REQUIRED_SECTIONS = [
  "At a Glance",
  "Approach",
  "Alternatives & Decisions",
  "Risks, Security & Operations",
  "Architecture & Boundaries",
  "Increment Dependency Graph",
  "Increment Details",
  "Final Integration",
];

const DESIGN_SECTION_ORDER = [
  "## At a Glance",
  EXECUTION_STATUS_HEADING,
  ...REQUIRED_SECTIONS.flatMap((heading) =>
    heading === "At a Glance" ? [] : [`## ${heading}`]
  ),
  RESOLUTION_HEADING,
] as const;

const INCREMENT_FIELDS = [
  "Outcome",
  "Scope",
  "Non-scope",
  "Observable behavior",
  "Affected contracts",
  "Validation",
  "Rollback boundary",
  "Parallel safety",
];

interface StateAliases {
  readonly [word: string]: IncrementState | undefined;
}

const STATES: StateAliases = {
  complete: "complete",
  completed: "complete",
  active: "active",
  ready: "ready",
  blocked: "blocked",
  invalidated: "invalidated",
};

const splitColumns = (line: string) =>
  line
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((column) => column.trim());

const sectionBody = (lines: readonly StructuralLine[], heading: string) => {
  const [range] = sectionRanges(lines, heading);

  return range ? lines.slice(range.start + 1, range.end) : null;
};

/** `| I<nn> | <priority> | <summary> | <prerequisites> | <paths> |` rows of the graph section only. */
export const parseIncrementGraph = (lines: readonly StructuralLine[]) => {
  const defects: LintDefect[] = [];
  const increments: DesignIncrement[] = [];
  const ids = new Set<string>();

  for (const { text, line } of sectionBody(
    lines,
    "## Increment Dependency Graph"
  ) ?? []) {
    if (!/^\|\s*I\d{2}\s*\|/u.test(text)) {
      continue;
    }

    const columns = splitColumns(text);
    const id = columns[0] ?? "";

    const priority = Number(
      /^\|\s*I\d{2}\s*\|\s*(?<cap1>\d+)\s*\|/u.exec(text)?.[1]
    );

    if (Number.isNaN(priority)) {
      defects.push(
        lint(
          "invalid-priority",
          line,
          `Increment ${id} needs an integer priority.`
        )
      );
      continue;
    }

    if (ids.has(id)) {
      defects.push(
        lint("duplicate-id", line, `Increment ${id} appears more than once.`)
      );
    }

    ids.add(id);

    const prerequisites = (columns[3] ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "" && item !== "none");

    const paths = columns
      .slice(4)
      .flatMap((column) => column.split(","))
      .map((item) => item.replaceAll("`", "").trim())
      .filter(Boolean);

    increments.push({
      id,
      priority,
      summary: columns[2] ?? "",
      behaviour: [],
      prerequisites,
      paths,
    });
  }

  if (!increments.length) {
    defects.push(
      lint(
        "missing-increments",
        null,
        "Increment Dependency Graph requires at least one I<nn> row."
      )
    );
  }

  const sequence = increments
    .map((row) => Number(row.id.slice(1)))
    .toSorted((a, b) => a - b);

  if (sequence.some((number, index) => number !== index + 1)) {
    defects.push(
      lint(
        "invalid-id-sequence",
        null,
        "Increment IDs must run I01, I02, … without gaps."
      )
    );
  }

  const priorities = increments
    .map((row) => row.priority)
    .toSorted((a, b) => a - b);

  if (
    new Set(priorities).size !== priorities.length ||
    priorities.some((priority, index) => priority !== index + 1)
  ) {
    defects.push(
      lint(
        "invalid-priority-order",
        null,
        "Increment priorities must be unique and run 1..n."
      )
    );
  }

  const edges = new Map(increments.map((row) => [row.id, row.prerequisites]));

  for (const row of increments) {
    for (const prerequisite of row.prerequisites) {
      if (!ids.has(prerequisite)) {
        defects.push(
          lint(
            "missing-prerequisite",
            null,
            `Increment ${row.id} names unknown prerequisite ${prerequisite}.`
          )
        );
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string) => {
    if (visiting.has(id)) {
      defects.push(
        lint("cycle", null, `Increment ${id} is part of a prerequisite cycle.`)
      );

      return;
    }

    if (visited.has(id) || !edges.has(id)) {
      return;
    }

    visiting.add(id);

    for (const dependency of edges.get(id) ?? []) {
      visit(dependency);
    }

    visiting.delete(id);
    visited.add(id);
  };

  for (const row of increments) {
    visit(row.id);
  }

  return { increments, defects };
};

interface IncrementBlock {
  line: number;
  behaviour: string[];
  fields: StructuralLine[];
}

const incrementDetails = (lines: readonly StructuralLine[]) => {
  const blocks = new Map<string, IncrementBlock>();
  let current: IncrementBlock | null = null;
  let afterDetails = false;

  for (const entry of sectionBody(lines, "## Increment Details") ?? []) {
    const heading = /^###\s+(?<cap1>I\d{2})\b/u.exec(entry.text)?.[1];

    if (heading !== undefined) {
      current = { line: entry.line, behaviour: [], fields: [] };
      blocks.set(heading, current);
      afterDetails = false;
      continue;
    }

    if (!current) {
      continue;
    }

    if (entry.fenced) {
      continue;
    }

    if (entry.text.trim() === "<details>") {
      afterDetails = true;
      continue;
    }

    const text = entry.text.trim();

    if (afterDetails) {
      if (
        text === "</details>" ||
        text.startsWith("<summary>") ||
        text === "</summary>"
      ) {
        continue;
      }

      current.fields.push(entry);
      continue;
    }

    const bullet = /^ {0,3}[-*+]\s+(?<cap1>.+)$/u.exec(entry.text)?.[1]?.trim();

    if (
      bullet === undefined ||
      bullet === "" ||
      /^(?:Constraints|Overlap|Field):/iu.test(bullet)
    ) {
      continue;
    }

    current.behaviour.push(bullet);
  }

  return blocks;
};

const parseExecutionStatus = (
  lines: readonly StructuralLine[],
  ids: ReadonlySet<string>,
  out: LintDefect[]
) => {
  const body = sectionBody(lines, EXECUTION_STATUS_HEADING);

  if (!body) {
    return null;
  }

  const rows: ExecutionStatusRow[] = [];
  let nextAction: string | null = null;

  for (const { text, line } of body) {
    const action = /^Next Action:\s*(?<cap1>.+)$/u.exec(text.trim())?.[1];

    if (action !== undefined) {
      nextAction = action.trim();
      continue;
    }

    if (!/^\|\s*I\d{2}\s*\|/u.test(text)) {
      continue;
    }

    const [id = "", rawState = "", next = ""] = splitColumns(text);
    const state = STATES[rawState.toLowerCase()];

    if (!state) {
      out.push(
        lint(
          "execution-status",
          line,
          `Execution Status ${id} has unknown state "${rawState}"; use complete, active, ready, blocked, or invalidated.`
        )
      );
      continue;
    }

    if (!ids.has(id)) {
      out.push(
        lint(
          "execution-status",
          line,
          `Execution Status names ${id}, which the graph does not define.`
        )
      );
    }

    if (rows.some((row) => row.id === id)) {
      out.push(
        lint(
          "execution-status",
          line,
          `Execution Status lists ${id} more than once.`
        )
      );
    }

    rows.push({ id, state, nextAction: next });
  }

  if (nextAction === null || nextAction === "") {
    out.push(
      lint(
        "execution-status",
        body[0]?.line ?? null,
        "Execution Status requires a non-empty Next Action: line."
      )
    );
  }

  return { rows, nextAction };
};

const isParsedDesign = (value: unknown): value is ParsedDesign => {
  if (
    !isRecord(value) ||
    !isRecord(value["box"]) ||
    !Object.values(value["box"]).every((v) => typeof v === "string") ||
    !isRecord(value["details"]) ||
    typeof value["governedText"] !== "string" ||
    !Array.isArray(value["increments"]) ||
    !value["increments"].length
  ) {
    return false;
  }

  const { details } = value;

  if (
    !Object.values(details).every(
      (row) =>
        isRecord(row) && Object.values(row).every((v) => typeof v === "string")
    )
  ) {
    return false;
  }

  return value["increments"].every(
    (row) =>
      isRecord(row) &&
      typeof row["id"] === "string" &&
      /^I\d{2}$/u.test(row["id"]) &&
      Number.isInteger(row["priority"]) &&
      typeof row["summary"] === "string" &&
      Array.isArray(row["behaviour"]) &&
      row["behaviour"].every((v) => typeof v === "string") &&
      isRecord(details[row["id"]]) &&
      Array.isArray(row["prerequisites"]) &&
      row["prerequisites"].every((v) => typeof v === "string") &&
      Array.isArray(row["paths"]) &&
      row["paths"].length > 0 &&
      row["paths"].every((v) => typeof v === "string" && v.trim() !== "")
  );
};

/** Concrete design guard at journal-consuming machine boundaries. */
export const asParsedDesign = (design: unknown) => {
  if (!isParsedDesign(design)) {
    return null;
  }

  const ids = new Set(design.increments.map((row) => row.id));

  const priorities = design.increments
    .map((row) => row.priority)
    .toSorted((a, b) => a - b);

  if (
    ids.size !== design.increments.length ||
    priorities.some((n, i) => n !== i + 1) ||
    [...ids]
      .toSorted()
      .some((id, i) => id !== `I${String(i + 1).padStart(2, "0")}`)
  ) {
    return null;
  }

  if (
    design.increments.some((row) =>
      row.prerequisites.some((id) => !ids.has(id))
    )
  ) {
    return null;
  }

  const graph = new Map(
    design.increments.map((row) => [row.id, row.prerequisites])
  );

  const visited = new Set<string>();
  const visiting = new Set<string>();

  const acyclic = (id: string) => {
    if (visiting.has(id)) {
      return false;
    }

    if (visited.has(id)) {
      return true;
    }

    visiting.add(id);

    if (!(graph.get(id) ?? []).every(acyclic)) {
      return false;
    }

    visiting.delete(id);
    visited.add(id);

    return true;
  };

  return [...ids].every(acyclic) ? design : null;
};

export const governedDesignText = (source: string) =>
  withoutSections(source, [EXECUTION_STATUS_HEADING, RESOLUTION_HEADING]);

const detailField = (
  details: Record<string, string> | undefined,
  field: string
) =>
  Object.entries(details ?? {}).find(
    ([k]) => k.toLowerCase() === field.toLowerCase()
  )?.[1] ?? "";

export const designScopeGrew = (before: ParsedDesign, after: ParsedDesign) => {
  const beforePaths = new Set(before.increments.flatMap((row) => row.paths));

  for (const afterRow of after.increments) {
    for (const p of afterRow.paths) {
      if (!beforePaths.has(p)) {
        return true;
      }
    }

    const beforeRow = before.increments.find((row) => row.id === afterRow.id);

    if (!beforeRow) {
      return true;
    }

    const beforeVal = detailField(before.details[afterRow.id], "Validation");
    const afterVal = detailField(after.details[afterRow.id], "Validation");

    if (afterVal !== beforeVal) {
      return true;
    }
  }

  const beforeLines = structuralLines(before.governedText);
  const afterLines = structuralLines(after.governedText);

  const beforeIntegration = (
    sectionBody(beforeLines, "## Final Integration") ?? []
  )
    .map((l) => l.text.trim())
    .filter(Boolean)
    .join("\n");

  const afterIntegration = (
    sectionBody(afterLines, "## Final Integration") ?? []
  )
    .map((l) => l.text.trim())
    .filter(Boolean)
    .join("\n");

  if (beforeIntegration !== afterIntegration) {
    return true;
  }

  return false;
};

const incrementCountNote = (value: string, count: number) => {
  if (!/^[1-9]\d*$/u.test(value)) {
    return `Summary Increments value "${value}" must be a positive integer.`;
  }

  return Number(value) === count
    ? null
    : `Summary Increments ${value} must equal the graph increment count ${count}.`;
};

const detailFields = (
  block: IncrementBlock,
  id: string,
  defects: LintDefect[]
) => {
  const fields: Record<string, string> = {};

  for (const { text, line } of block.fields) {
    const match = /^\s*[-*]\s+(?<cap1>[^:]+):\s*(?<cap2>.*)$/u.exec(text);

    if (match?.[1] === undefined || match[1] === "") {
      continue;
    }

    const value = (match[2] ?? "").trim();

    fields[match[1].trim()] = value;

    if (value !== "" && isFillerNote(value)) {
      defects.push(
        lint(
          "filler-note",
          line,
          `Increment ${id} field "${text.trim()}" is filler.`
        )
      );
    }
  }

  return fields;
};

/** Parses and lints a design; warnings preserve the parsed design. */
export const parseDesign = (
  source: string,
  options: { placeholders?: PlaceholderVocabulary } = {}
) => {
  const lines = structuralLines(source);
  const defects: LintDefect[] = [];

  for (const heading of REQUIRED_SECTIONS) {
    if (!sectionRanges(lines, `## ${heading}`).length) {
      defects.push(
        lint("missing-section", null, `Design requires ## ${heading}.`)
      );
    }
  }

  defects.push(...lintSectionOrder(lines, DESIGN_SECTION_ORDER));

  for (const { line, words } of lintLongParagraphs(lines)) {
    defects.push(
      lint(
        "long-paragraph",
        line,
        `Prose paragraph has ${words} words; use bullets or shorten it to ${LONG_PARAGRAPH_WORDS} words.`
      )
    );
  }

  const approach = (sectionBody(lines, "## Approach") ?? [])
    .map((entry) => entry.text)
    .join("\n");

  const approachRequirements = [
    ...new Set(approach.match(/\bREQ-[1-9]\d*\b/gu)),
  ];

  if (!approachRequirements.length) {
    defects.push(
      lint(
        "missing-requirement-ref",
        null,
        "## Approach requires a REQ-<n> reference."
      )
    );
  }

  const graph = parseIncrementGraph(lines);
  const blocks = incrementDetails(lines);
  const details: Record<string, Record<string, string>> = {};

  for (const { id } of graph.increments) {
    const block = blocks.get(id);

    if (!block) {
      defects.push(
        lint(
          "missing-increment-details",
          null,
          `Increment ${id} needs a ### ${id} block under Increment Details.`
        )
      );
      continue;
    }

    const { behaviour } = block;

    if (!hasBehaviour(behaviour)) {
      defects.push(
        lint(
          "increment-behaviour",
          block.line,
          `Increment ${id} needs a behavioural bullet before its details.`
        )
      );
    }

    const fields = detailFields(block, id, defects);

    for (const field of INCREMENT_FIELDS) {
      const found = Object.entries(fields).some(
        ([name, value]) =>
          name.toLowerCase() === field.toLowerCase() && value !== ""
      );

      if (!found) {
        defects.push(
          lint(
            "missing-increment-field",
            null,
            `Increment ${id} requires "- ${field}: <value>".`
          )
        );
      }
    }

    details[id] = fields;
  }

  const count = graph.increments.length;

  defects.push(
    ...lintSummaryBox(source, BOX_LABELS, {
      Parent: SPEC_PIN_VALUE,
      Increments: (value) => incrementCountNote(value, count),
    })
  );

  if (options.placeholders) {
    for (const { token, line } of findPlaceholders(
      source,
      options.placeholders
    )) {
      defects.push(
        lint(
          "leftover-placeholder",
          line,
          `Leftover template placeholder ${token}.`
        )
      );
    }
  }

  defects.push(...graph.defects);

  const executionStatus = parseExecutionStatus(
    lines,
    new Set(graph.increments.map((row) => row.id)),
    defects
  );

  const warnings: LintDefect[] = defects.map((item) => ({
    ...item,
    severity: "warning",
  }));

  const designIncrements = graph.increments.map((increment) => ({
    ...increment,
    behaviour: blocks.get(increment.id)?.behaviour ?? [],
  }));

  return {
    ok: true,
    warnings,
    design: {
      approachRequirements,
      title: documentTitle(source),
      box: boxValues(source),
      increments: designIncrements,
      details,
      executionStatus,
      governedText: governedDesignText(source),
    },
  };
};

export const validateApproachRequirements = (
  design: ParsedDesign,
  reqIds: readonly string[]
) => {
  const known = new Set(reqIds);

  return [...new Set(design.approachRequirements)].flatMap((id) =>
    known.has(id)
      ? []
      : [
          lint(
            "unknown-requirement",
            null,
            `Approach cites unknown requirement ${id}.`
          ),
        ]
  );
};
