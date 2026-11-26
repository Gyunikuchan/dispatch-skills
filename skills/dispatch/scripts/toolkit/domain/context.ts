import path from "node:path";

import { defined } from "./defined.ts";
import { sectionRanges, structuralLines } from "./markdown-structure.ts";

const CONTEXT_SECTIONS = [
  "Map",
  "Flows",
  "Invariants",
  "Coverage",
  "Precedent",
  "Conventions",
  "Surprises",
  "Not covered",
] as const;

type ContextSection = (typeof CONTEXT_SECTIONS)[number];

/** Map byte budget rendered into the explorer brief; the warning threshold for context maps. */
export const DEFAULT_MAP_BUDGET = 16_384;

/** Research explorer inline reply size limit rendered into the explorer brief. */
export const DEFAULT_RESEARCH_REPLY_LIMIT = 8192;

interface ParsedContextMap {
  title: string | null;
  commit: string | null;
  tool: string | null;
  sections: Record<ContextSection, string[]>;
}

interface ContextLintIssue {
  code: string;
  severity: "defect" | "warning";
  line: number | null;
  message: string;
}

interface ContextLintOptions {
  readRepoFile: (relativePath: string) => string | null;
}

interface ContextReference {
  path: string;
  start: number | null;
  end: number | null;
}

const REQUIRED_LINE_SECTIONS = new Set<ContextSection>([
  "Map",
  "Flows",
  "Invariants",
  "Conventions",
  "Surprises",
]);

const OPTIONAL_SECTIONS = new Set<ContextSection>(["Conventions"]);
const REF_LINE = /^(?<cap1>.+):(?<cap2>\d+)(?:-(?<cap3>\d+))?$/u;

const entries = (
  lines: ReturnType<typeof structuralLines>,
  section: ContextSection
) =>
  sectionRanges(lines, `## ${section}`)
    .flatMap((range) => lines.slice(range.start + 1, range.end))
    .filter((entry) => entry.text.trim())
    .map((entry) => ({ line: entry.line, text: entry.text.trim() }));

const metadata = (
  lines: ReturnType<typeof structuralLines>,
  label: "Commit" | "Tool"
) => {
  const marker = new RegExp(`^>\\s*\\*\\*${label}:\\*\\*\\s*(.*?)\\s*$`, "u");

  return (
    lines
      .map((entry) => marker.exec(entry.original)?.[1]?.trim() ?? null)
      .find((value) => value !== null) ?? null
  );
};

const isValidCommit = (commit: string | null): commit is string =>
  commit !== null && /^[0-9a-f]{7,64}$/iu.test(commit);

/** Parses the metadata and each section's entry texts. */
const parseContextMap = (source: string) => {
  const lines = structuralLines(source);

  const texts = (section: ContextSection) =>
    entries(lines, section).map((entry) => entry.text);

  const sections: ParsedContextMap["sections"] = {
    Map: texts("Map"),
    Flows: texts("Flows"),
    Invariants: texts("Invariants"),
    Coverage: texts("Coverage"),
    Precedent: texts("Precedent"),
    Conventions: texts("Conventions"),
    Surprises: texts("Surprises"),
    "Not covered": texts("Not covered"),
  };

  const title =
    lines
      .map(
        (entry) =>
          /^#\s+Context map:\s*(?<cap1>.*?)\s*$/iu
            .exec(entry.text)?.[1]
            ?.trim() ?? null
      )
      .find((value) => value !== null) ?? null;

  const commit = metadata(lines, "Commit");
  const tool = metadata(lines, "Tool");

  return { title, commit, tool, sections };
};

const pathOnlyReference: (
  value: string,
  allowBare?: boolean
) => { path: string; start: number | null; end: number | null } | null = (
  value,
  allowBare = false
) => {
  const ref = value.trim();
  const withLines = REF_LINE.exec(ref);

  if (withLines) {
    return {
      path: defined(withLines[1]),
      start: Number(withLines[2]),
      end:
        withLines[3] === undefined
          ? Number(withLines[2])
          : Number(withLines[3]),
    };
  }

  if (allowBare || /[/.\\]/u.test(ref) || /^[A-Za-z]:/u.test(ref)) {
    return { path: ref, start: null, end: null };
  }

  return null;
};

const inlineReferences = (text: string, allowBare: boolean) =>
  [...text.matchAll(/`(?<cap1>[^`]+)`/gu)].flatMap((match) => {
    const ref = pathOnlyReference(defined(match[1]), allowBare);

    return ref ? [ref] : [];
  });

export const safeRelativePath = (value: string) => {
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return false;
  }

  const normalized = path.posix.normalize(value);

  return (
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    !path.posix.isAbsolute(normalized)
  );
};

const lineCount = (source: string) => {
  if (!source) {
    return 0;
  }

  const breaks = source.match(/\n/gu)?.length ?? 0;

  return source.endsWith("\n") ? breaks : breaks + 1;
};

const quoteFrom = (text: string) => {
  const quotes = [
    ...text.matchAll(/"(?<cap1>(?:\\.|[^"\\])*)"|“(?<cap2>[^”]*)”/gu),
  ];

  const last = quotes.at(-1);

  if (!last) {
    return null;
  }

  return (last[1] ?? last[2] ?? "")
    .replaceAll(String.raw`\"`, '"')
    .replaceAll(String.raw`\\`, "\\");
};

const normalizeWhitespace = (value: string) =>
  value.replaceAll(/\s+/gu, " ").trim();

const sectionReferences = (section: ContextSection, entry: string) =>
  inlineReferences(entry, section === "Coverage" || section === "Precedent");

type AddIssue = (
  severity: ContextLintIssue["severity"],
  code: string,
  line: number | null,
  message: string
) => void;

interface CheckedReference {
  ref: ContextReference;
  content: string | null;
  rangeValid: boolean;
}

const cachedReader = (
  readRepoFile: (relativePath: string) => string | null
) => {
  const cache = new Map<string, string | null>();

  return (ref: string) => {
    const cached = cache.get(ref);

    if (cached !== undefined) {
      return cached;
    }

    let content: string | null = null;

    try {
      content = readRepoFile(ref);
    } catch {
      /* A failed repository read is a missing ref. */
      void 0;
    }

    cache.set(ref, content);

    return content;
  };
};

const checkReference = (
  ref: ContextReference,
  line: number,
  read: (ref: string) => string | null,
  add: AddIssue
): CheckedReference => {
  if (!safeRelativePath(ref.path)) {
    add(
      "defect",
      "context-ref-unsafe",
      line,
      `Reference path "${ref.path}" is absolute or escapes the repository root.`
    );

    return { ref, content: null, rangeValid: false };
  }

  const content = read(ref.path);

  if (content === null) {
    add(
      "defect",
      "context-ref-missing",
      line,
      `Referenced repository file is missing or unreadable: ${ref.path}.`
    );

    return { ref, content: null, rangeValid: false };
  }

  if (ref.start === null) {
    return { ref, content, rangeValid: true };
  }

  const end = ref.end ?? ref.start;

  if (
    !Number.isSafeInteger(ref.start) ||
    !Number.isSafeInteger(end) ||
    ref.start < 1 ||
    end < ref.start ||
    end > lineCount(content)
  ) {
    add(
      "defect",
      "context-ref-range",
      line,
      `Reference line range ${ref.start}-${end} is outside ${ref.path}.`
    );

    return { ref, content, rangeValid: false };
  }

  return { ref, content, rangeValid: true };
};

const checkInvariantQuote = (
  text: string,
  line: number,
  checked: readonly CheckedReference[],
  add: AddIssue
) => {
  const quote = quoteFrom(text);

  if (quote === null || !quote.trim()) {
    add(
      "warning",
      "context-quote-missing",
      line,
      "Invariant entry needs a verbatim quote in double quotes."
    );

    return;
  }

  const cited = checked.find(
    (item) =>
      item.ref.start !== null && item.rangeValid && item.content !== null
  );

  if (!cited || cited.ref.start === null || cited.content === null) {
    return;
  }

  const { start } = cited.ref;
  const end = cited.ref.end ?? start;

  const selected = cited.content
    .split(/\r?\n/u)
    .slice(start - 1, end)
    .join("\n");

  if (!normalizeWhitespace(selected).includes(normalizeWhitespace(quote))) {
    add(
      "defect",
      "context-quote-mismatch",
      line,
      `Invariant quote does not appear in ${cited.ref.path}:${start}-${end}.`
    );
  }
};

const missingRefRequirement = (
  section: ContextSection,
  refs: readonly ContextReference[],
  text: string
) => {
  const missingLineRef =
    REQUIRED_LINE_SECTIONS.has(section) &&
    (refs.length === 0 || refs.some((ref) => ref.start === null));

  const missingPathRef =
    (section === "Coverage" &&
      refs.length === 0 &&
      !/\bnot covered\b/iu.test(text)) ||
    (section === "Precedent" && refs.length === 0);

  if (!missingLineRef && !missingPathRef) {
    return null;
  }

  const requirement = REQUIRED_LINE_SECTIONS.has(section)
    ? "repository path and line ref"
    : "repository path ref";

  return `${section} entry needs a backticked ${requirement}.`;
};

/** Checks map refs and invariant quotes through the caller's repository reader. */
export const lintContextMap = (source: string, options: ContextLintOptions) => {
  const lines = structuralLines(source);
  const map = parseContextMap(source);
  const defects: ContextLintIssue[] = [];
  const warnings: ContextLintIssue[] = [];

  const add: AddIssue = (severity, code, line, message) => {
    (severity === "defect" ? defects : warnings).push({
      code,
      severity,
      line,
      message,
    });
  };

  if (map.commit !== null && !isValidCommit(map.commit)) {
    const line =
      lines.find((entry) => /^>\s*\*\*Commit:\*/u.test(entry.original))?.line ??
      null;

    add(
      "defect",
      "context-commit",
      line,
      "Commit must be a bare hexadecimal revision from 7 to 64 characters."
    );
  }

  const read = cachedReader(options.readRepoFile);

  for (const section of CONTEXT_SECTIONS) {
    const sectionRangesForName = sectionRanges(lines, `## ${section}`);

    if (!sectionRangesForName.length) {
      if (!OPTIONAL_SECTIONS.has(section)) {
        add(
          "warning",
          "context-missing-section",
          null,
          `Context map has no ## ${section} section.`
        );
      }

      continue;
    }

    for (const entry of entries(lines, section)) {
      const refs = sectionReferences(section, entry.text);

      const requirement = missingRefRequirement(section, refs, entry.text);

      if (requirement !== null) {
        add("warning", "context-missing-ref", entry.line, requirement);
      }

      const checked = refs.map((ref) =>
        checkReference(ref, entry.line, read, add)
      );

      if (section === "Invariants") {
        checkInvariantQuote(entry.text, entry.line, checked, add);
      }
    }
  }

  const bytes = Buffer.byteLength(source, "utf-8");
  const hardLimit = 2 * DEFAULT_MAP_BUDGET;

  if (bytes > hardLimit) {
    add(
      "defect",
      "context-size",
      null,
      `Context map is ${bytes} UTF-8 bytes; the hard limit is ${hardLimit}.`
    );
  } else if (bytes > DEFAULT_MAP_BUDGET) {
    add(
      "warning",
      "context-size-warning",
      null,
      `Context map is ${bytes} UTF-8 bytes; the warning budget is ${DEFAULT_MAP_BUDGET}.`
    );
  }

  return { ok: defects.length === 0, defects, warnings, map };
};
