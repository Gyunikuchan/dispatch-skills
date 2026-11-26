// Pure fix-review-lite helpers: citations from added diff lines and the consumer-search command.

import { defined } from "./defined.ts";

export interface Citation {
  path: string;
  start: number | null;
  end: number | null;
}

const LINE_REF = /^(?<cap1>[^\s:`]+):L?(?<cap2>\d+)(?:-L?(?<cap3>\d+))?$/u;
const CONTINUATION = /^:L?(?<cap1>\d+)(?:-L?(?<cap2>\d+))?$/u;

// A leading-dot name such as `.env` has its extension in the last segment, so it counts.
const WHOLE_FILE = /^[^\s:`]*\.[A-Za-z0-9]{1,8}$/u;

// Rendered pathspecs are double-quoted; these characters pass bash, PowerShell and cmd unchanged.
const SAFE_CHAR = /[A-Za-z0-9._/@+-]/u;

export const safePathspec = (value: string) =>
  value !== "" && Array.from(value).every((char) => SAFE_CHAR.test(char));

// Citations come only from added lines (`+`, not the `+++` header); removed and context lines carry no claim.
export const addedCitations = (diff: string) => {
  const citations: Citation[] = [];

  for (const line of diff.split(/\r?\n/u)) {
    if (!line.startsWith("+") || line.startsWith("+++")) {
      continue;
    }

    let last: string | null = null;

    for (const match of line.matchAll(/`(?<cap1>[^`]+)`/gu)) {
      const citation = citationOf(defined(match[1]), last);

      if (!citation) {
        continue;
      }

      last = citation.path;
      citations.push(citation);
    }
  }

  return citations;
};

const citationOf = (span: string, last: string | null) => {
  const range = LINE_REF.exec(span);

  if (range) {
    return {
      path: defined(range[1]),
      start: Number(range[2]),
      end: Number(range[3] ?? range[2]),
    };
  }

  const continuation = CONTINUATION.exec(span);

  if (continuation) {
    return last === null
      ? null
      : {
          path: last,
          start: Number(continuation[1]),
          end: Number(continuation[2] ?? continuation[1]),
        };
  }

  return WHOLE_FILE.test(span) ? { path: span, start: null, end: null } : null;
};

// `-w` only when the first and last characters of the name are word characters, so `foo(` matches literally.
const wordEdged = (name: string) => /^\w/u.test(name) && /\w$/u.test(name);

const searchFlags = (word: boolean) => [
  "-n",
  "-I",
  "-F",
  "--untracked",
  ...(word ? ["-w"] : []),
];

// Literal for a safe path; otherwise a glob with one `?` per UTF-8 byte outside the safe set, so no shell or pathspec metacharacter survives.
export const excludeSpec = (value: string) =>
  safePathspec(value)
    ? `:(exclude,literal)${value}`
    : `:(exclude,glob)${[...Buffer.from(value, "utf-8")]
        .map((byte) =>
          SAFE_CHAR.test(String.fromCodePoint(byte))
            ? String.fromCodePoint(byte)
            : "?"
        )
        .join("")}`;

export const consumerSearchArgs = (
  excludes: readonly string[],
  name: string
) => [
  "grep",
  ...searchFlags(wordEdged(name)),
  "-e",
  name,
  "--",
  ".",
  ...excludes.map(excludeSpec),
];

// The rendered command the explorer runs with `<name>` replaced; the explorer adds `-w` by the rule the brief states.
export const consumerSearchText = (excludes: readonly string[]) =>
  [
    "git",
    "grep",
    ...searchFlags(false),
    "-e",
    "<name>",
    "--",
    ".",
    ...excludes.map((value) => `"${excludeSpec(value)}"`),
  ].join(" ");
