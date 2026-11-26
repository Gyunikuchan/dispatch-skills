import { CRITERION_ID_SOURCE } from "./criterion-id.ts";
import { defined } from "./defined.ts";
import {
  documentTitle,
  lintLongParagraphs,
  LONG_PARAGRAPH_WORDS,
  lintSectionOrder,
} from "./document-lint.ts";
import { sectionRanges, structuralLines } from "./markdown-structure.ts";
import type { StructuralLine } from "./markdown-structure.ts";

const SPEC_SECTION_ORDER = [
  "## At a Glance",
  "## Intent & Problem",
  "## Background",
  "## Requirements",
  "## Non-goals",
  "## Constraints",
  "## Decisions",
  "## Discussion Record",
  "## Open Questions",
] as const;

type SpecDefectCode =
  | "missing-section"
  | "section-order"
  | "missing-requirement"
  | "malformed-id"
  | "colliding-id"
  | "id-sequence"
  | "missing-acceptance"
  | "duplicate-section"
  | "long-paragraph";

interface SpecDefect {
  code: SpecDefectCode;
  severity: "defect" | "warning";
  line: number | null;
  message: string;
}

const defect = (
  code: SpecDefectCode,
  line: number | null,
  message: string,
  blocking = false
) =>
  ({
    code,
    severity: blocking ? "defect" : "warning",
    line,
    message,
  }) satisfies SpecDefect;

/** Governed text is the raw source; `artifactHash` canonicalizes it before hashing. */
export const governedSpecText = (source: string) => source;

const COLLIDING = new RegExp(
  `^(?:T\\d+|${CRITERION_ID_SOURCE}|I\\d{2}|R\\d+(?:-F\\d+)?)\\b`,
  "iu"
);

interface Block {
  id: number;
  heading: StructuralLine;
  body: StructuralLine[];
}

const lintIds = (
  lines: readonly StructuralLine[],
  heading: string,
  prefix: "REQ" | "DEC",
  out: SpecDefect[]
) => {
  const idDefect = (
    code: SpecDefectCode,
    line: number | null,
    message: string
  ) =>
    defect(
      code,
      line,
      message,
      prefix === "REQ" &&
        ["malformed-id", "colliding-id", "id-sequence"].includes(code)
    );

  const ranges = sectionRanges(lines, heading);

  for (const extra of ranges.slice(1)) {
    out.push(
      idDefect(
        "duplicate-section",
        defined(lines[extra.start]).line,
        `${heading} appears more than once; merge it into one section.`
      )
    );
  }

  const pattern = new RegExp(`^${prefix}-([1-9]\\d*) — \\S`, "u");
  const blocks: Block[] = [];

  for (const range of ranges) {
    let current: Block | null = null;

    for (const entry of lines.slice(range.start + 1, range.end)) {
      const sub = /^###\s+(?<cap1>.*)$/u.exec(entry.text.trimEnd())?.[1];

      if (sub === undefined) {
        current?.body.push(entry);
        continue;
      }

      const match = pattern.exec(sub);

      if (match) {
        current = { id: Number(match[1]), heading: entry, body: [] };
        blocks.push(current);
        continue;
      }

      current = null;

      if (COLLIDING.test(sub)) {
        out.push(
          idDefect(
            "colliding-id",
            entry.line,
            `Heading "${sub}" uses a plan, criterion, increment, or finding ID; use ${prefix}-<n>.`
          )
        );
      } else {
        out.push(
          idDefect(
            "malformed-id",
            entry.line,
            `Heading "${sub}" under ${heading} must be "### ${prefix}-<n> — <title>".`
          )
        );
      }
    }
  }

  const seen = new Set<number>();

  for (const [index, block] of blocks.entries()) {
    if (seen.has(block.id)) {
      out.push(
        idDefect(
          "id-sequence",
          block.heading.line,
          `${prefix}-${block.id} appears more than once.`
        )
      );
    } else if (block.id !== index + 1) {
      out.push(
        idDefect(
          "id-sequence",
          block.heading.line,
          `${prefix}-${block.id} is out of sequence; expected ${prefix}-${index + 1}.`
        )
      );
    }

    seen.add(block.id);
  }

  return blocks;
};

/** Parses and lints a spec; any defect fails the parse. Prose is not scanned for IDs. */
export const parseSpec = (source: string) => {
  const lines = structuralLines(source);
  const defects: SpecDefect[] = [];

  for (const heading of SPEC_SECTION_ORDER) {
    if (!sectionRanges(lines, heading).length) {
      defects.push(
        defect(
          "missing-section",
          null,
          `Spec requires ${heading}.`,
          heading === "## Requirements"
        )
      );
    }
  }

  for (const item of lintSectionOrder(lines, SPEC_SECTION_ORDER)) {
    defects.push(defect("section-order", item.line, item.message));
  }

  for (const { line, words } of lintLongParagraphs(lines)) {
    defects.push(
      defect(
        "long-paragraph",
        line,
        `Prose paragraph has ${words} words; use bullets or shorten it to ${LONG_PARAGRAPH_WORDS} words.`
      )
    );
  }

  const reqs = lintIds(lines, "## Requirements", "REQ", defects);
  const decs = lintIds(lines, "## Decisions", "DEC", defects);

  if (sectionRanges(lines, "## Requirements").length && !reqs.length) {
    defects.push(
      defect(
        "missing-requirement",
        null,
        "Requirements needs at least one ### REQ-<n> — <title> block.",
        true
      )
    );
  }

  for (const block of reqs) {
    if (
      !block.body.some(({ text }) => /^\s*[-*]\s+Acceptance:\s*\S/u.test(text))
    ) {
      defects.push(
        defect(
          "missing-acceptance",
          block.heading.line,
          `REQ-${block.id} needs at least one "- Acceptance:" bullet.`
        )
      );
    }
  }

  const warnings = defects.filter((item) => item.severity === "warning");
  const blocking = defects.filter((item) => item.severity === "defect");

  if (blocking.length) {
    return { ok: false, defects: blocking, warnings };
  }

  const sections = lines
    .map((entry) => entry.text.trimEnd())
    .filter((text) => /^##\s+\S/u.test(text) && !text.startsWith("###"));

  return {
    ok: true,
    warnings,
    spec: {
      title: documentTitle(source),
      reqIds: reqs.map((block) => `REQ-${block.id}`),
      decIds: decs.map((block) => `DEC-${block.id}`),
      sections,
    },
  };
};
