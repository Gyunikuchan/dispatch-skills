// Pure repo-relative line-reference validation for plan and design documents.

import { safeRelativePath } from "./context.ts";
import { defined } from "./defined.ts";
import {
  EXECUTION_STATUS_HEADING,
  RESOLUTION_HEADING,
} from "./document-lint.ts";
import { commentOpenOutsideCode, FENCE } from "./markdown-structure.ts";

export interface CitationDefect {
  code: "broken-citation";
  severity: "defect";
  line: number;
  message: string;
}

type Container = { kind: "quote" } | { kind: "list"; indent: number };

const LINE_REF = /^(?<cap1>.+?):(?<cap2>\d+)(?:-(?<cap3>\d+))?$/u;
const QUOTE_PREFIX = /^ {0,3}> ?/u;
const LIST_PREFIX = /^(?<cap1> {0,3}(?:[-*+]|\d+[.)]) +)/u;
const IPV4 = /^\d+(?:\.\d+){3}$/u;
const HOSTNAME_TLD = /\.(?:com|org|net|io|dev|app|edu|gov|local|internal)$/iu;
const DOTTED_EXT = /\.[A-Za-z][A-Za-z0-9_-]*$/u;

const WELL_KNOWN_ROOT_FILES = new Set([
  "LICENSE",
  "NOTICE",
  "README",
  "COPYING",
  "CHANGELOG",
  "Makefile",
  "Dockerfile",
  "Containerfile",
  "Vagrantfile",
  "Procfile",
  "Gemfile",
  "Rakefile",
  "Justfile",
]);

const lineCount = (content: string) =>
  content === "" ? 0 : content.replace(/\r?\n$/u, "").split(/\r?\n/u).length;

const opensBacktickSpanOnLine = (text: string, marker: string) => {
  if (!marker.startsWith("`")) {
    return false;
  }

  const start = text.indexOf(marker);

  return start !== -1 && text.slice(start + marker.length).includes("`");
};

const stripHeadingPrefix = (heading: string) =>
  heading.replace(/^##\s+/u, "").trim();

const peelContainers = (line: string, stack: readonly Container[]) => {
  let rest = line;
  let matched = 0;

  for (const frame of stack) {
    if (frame.kind === "quote") {
      const match = QUOTE_PREFIX.exec(rest);

      if (!match) {
        break;
      }

      rest = rest.slice(match[0].length);
    } else if (rest.trim() === "") {
      rest = "";
    } else {
      if ((/^ */u.exec(rest)?.[0].length ?? 0) < frame.indent) {
        break;
      }

      rest = rest.slice(frame.indent);
    }

    matched += 1;
  }

  return { rest, matched };
};

const commentFreeText = (line: string, inComment: boolean) => {
  let text = "";
  let cursor = 0;
  let active = inComment;

  while (cursor < line.length) {
    if (active) {
      const close = line.indexOf("-->", cursor);

      if (close === -1) {
        break;
      }

      active = false;
      cursor = close + 3;
      continue;
    }

    const open = commentOpenOutsideCode(line, cursor);

    if (open === -1) {
      text += line.slice(cursor);
      break;
    }

    text += line.slice(cursor, open);
    active = true;
    cursor = open + 4;
  }

  return { text, inComment: active };
};

const openContainers = (line: string, stack: Container[]) => {
  let rest = line;

  for (;;) {
    const quote = QUOTE_PREFIX.exec(rest);

    if (quote) {
      stack.push({ kind: "quote" });
      rest = rest.slice(quote[0].length);
      continue;
    }

    const listPrefix = LIST_PREFIX.exec(rest)?.[1];

    if (listPrefix !== undefined) {
      stack.push({ kind: "list", indent: listPrefix.length });
      rest = rest.slice(listPrefix.length);
      continue;
    }

    break;
  }

  return rest;
};

const governedCitationLines = (source: string, kind: "plan" | "design") => {
  const excludedHeadings = new Set(
    kind === "plan"
      ? [stripHeadingPrefix(RESOLUTION_HEADING)]
      : [
          stripHeadingPrefix(EXECUTION_STATUS_HEADING),
          stripHeadingPrefix(RESOLUTION_HEADING),
        ]
  );

  const out: { line: number; text: string }[] = [];
  const stack: Container[] = [];

  let fence: {
    char: "`" | "~";
    length: number;
    containerDepth: number;
  } | null = null;

  let inComment = false;
  let inExcluded = false;

  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const lineNo = index + 1;
    const peeled = peelContainers(rawLine, stack);
    let { rest } = peeled;

    stack.length = peeled.matched;

    if (fence !== null && stack.length < fence.containerDepth) {
      fence = null;
    }

    if (fence !== null) {
      const closeMatch = /^ {0,3}(?<cap1>`{3,}|~{3,})[ \t]*$/u.exec(rest);
      const closer = closeMatch?.[1];

      if (closer?.[0] === fence.char && closer.length >= fence.length) {
        fence = null;
      }

      continue;
    }

    if (!inComment) {
      rest = openContainers(rest, stack);

      const marker = FENCE.exec(rest)?.[1];

      if (marker !== undefined && !opensBacktickSpanOnLine(rest, marker)) {
        fence = {
          char: marker.startsWith("`") ? "`" : "~",
          length: marker.length,
          containerDepth: stack.length,
        };
        continue;
      }
    }

    const scanned = commentFreeText(rest, inComment);
    const { text } = scanned;

    ({ inComment } = scanned);

    if (!inComment && stack.length === 0) {
      const heading = /^## +(?<cap1>.+?)\s*$/u.exec(text);

      if (heading) {
        inExcluded = excludedHeadings.has(defined(heading[1]).trim());
      }
    }

    if (!inExcluded && text) {
      out.push({ line: lineNo, text });
    }
  }

  return out;
};

const isNonRepoRef = (token: string, prefix: string) =>
  prefix.includes("://") ||
  /^sha256:/iu.test(token) ||
  IPV4.test(prefix) ||
  /^localhost$/iu.test(prefix) ||
  (!prefix.includes("/") && HOSTNAME_TLD.test(prefix));

const skipUnreadableRef = (prefix: string) => {
  if (/\s/u.test(prefix)) {
    const tokens = prefix.trim().split(/\s+/u);
    const firstToken = defined(tokens[0]);
    const lastToken = defined(tokens.at(-1));

    return (
      /\s--?[A-Za-z]/u.test(prefix) ||
      /^localhost$/iu.test(lastToken) ||
      IPV4.test(lastToken) ||
      (!lastToken.includes("/") && HOSTNAME_TLD.test(lastToken)) ||
      !firstToken.includes("/")
    );
  }

  return !(
    prefix.includes("/") ||
    DOTTED_EXT.test(prefix) ||
    WELL_KNOWN_ROOT_FILES.has(prefix)
  );
};

const outOfRange = (start: number, end: number, totalLines: number) =>
  !Number.isSafeInteger(start) ||
  !Number.isSafeInteger(end) ||
  start < 1 ||
  start > end ||
  end > totalLines;

/** Validates backticked exact repo-relative `path:line` and `path:start-end` citations in governed plan/design sections. */
export const lintCitations = (
  source: string,
  kind: "plan" | "design",
  readRepoFile: (relPath: string) => string | null
) => {
  const defects: CitationDefect[] = [];
  const fileCache = new Map<string, string | null>();

  const read = (relPath: string) => {
    const cached = fileCache.get(relPath);

    if (cached !== undefined) {
      return cached;
    }

    let content: string | null = null;

    try {
      content = readRepoFile(relPath);
    } catch {
      void 0;
      /* A failed repository read counts as a missing file. */
    }

    fileCache.set(relPath, content);

    return content;
  };

  for (const { line, text } of governedCitationLines(source, kind)) {
    for (const match of text.matchAll(/`(?<cap1>[^`]+)`/gu)) {
      const token = defined(match[1]).trim();
      const parsed = LINE_REF.exec(token);

      if (!parsed) {
        continue;
      }

      const prefix = defined(parsed[1]);
      const start = Number(parsed[2]);
      const end = parsed[3] === undefined ? start : Number(parsed[3]);

      if (isNonRepoRef(token, prefix)) {
        continue;
      }

      const safe = safeRelativePath(prefix);
      const existing = safe ? read(prefix) : null;

      if (existing === null && skipUnreadableRef(prefix)) {
        continue;
      }

      if (!safe) {
        defects.push({
          code: "broken-citation",
          severity: "defect",
          line,
          message: `Unsafe repository citation path: ${prefix}`,
        });
        continue;
      }

      if (existing === null) {
        defects.push({
          code: "broken-citation",
          severity: "defect",
          line,
          message: `Missing or unreadable cited file: ${prefix}`,
        });
        continue;
      }

      const totalLines = lineCount(existing);

      if (outOfRange(start, end, totalLines)) {
        defects.push({
          code: "broken-citation",
          severity: "defect",
          line,
          message: `Citation line range ${start}${end === start ? "" : `-${end}`} is out of bounds for ${prefix} (${totalLines} lines)`,
        });
      }
    }
  }

  return defects;
};
