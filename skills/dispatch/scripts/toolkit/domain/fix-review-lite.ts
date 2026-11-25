// Pure fix-review-lite helpers: citations from added diff lines and the consumer-search command.

import { defined } from './defined.ts';

export type Citation = { path: string; start: number | null; end: number | null };

const LINE_REF = /^([^\s:`]+):L?(\d+)(?:-L?(\d+))?$/;
const CONTINUATION = /^:L?(\d+)(?:-L?(\d+))?$/;
// A leading-dot name such as `.env` has its extension in the last segment, so it counts.
const WHOLE_FILE = /^[^\s:`]*\.[A-Za-z0-9]{1,8}$/;
// Rendered pathspecs are double-quoted; these characters pass bash, PowerShell and cmd unchanged.
const SAFE_CHAR = /[A-Za-z0-9._/@+-]/;

export const safePathspec = (value: string): boolean =>
  value !== '' && Array.from(value).every((char) => SAFE_CHAR.test(char));

// Citations come only from added lines (`+`, not the `+++` header); removed and context lines carry no claim.
export function addedCitations(diff: string): Array<Citation> {
  const citations: Array<Citation> = [];
  for (const line of diff.split(/\r?\n/)) {
    if (!line.startsWith('+') || line.startsWith('+++')) {
      continue;
    }
    let last: string | null = null;
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const citation = citationOf(defined(match[1]), last);
      if (!citation) {
        continue;
      }
      last = citation.path;
      citations.push(citation);
    }
  }
  return citations;
}

function citationOf(span: string, last: string | null): Citation | null {
  const range = LINE_REF.exec(span);
  if (range) {
    return { path: defined(range[1]), start: Number(range[2]), end: Number(range[3] ?? range[2]) };
  }
  const continuation = CONTINUATION.exec(span);
  if (continuation) {
    return last === null
      ? null
      : { path: last, start: Number(continuation[1]), end: Number(continuation[2] ?? continuation[1]) };
  }
  return WHOLE_FILE.test(span) ? { path: span, start: null, end: null } : null;
}

// `-w` only when the first and last characters of the name are word characters, so `foo(` matches literally.
const wordEdged = (name: string): boolean => /^\w/.test(name) && /\w$/.test(name);
const searchFlags = (word: boolean): Array<string> => ['-n', '-I', '-F', '--untracked', ...(word ? ['-w'] : [])];

// Literal for a safe path; otherwise a glob with one `?` per UTF-8 byte outside the safe set, so no shell or pathspec metacharacter survives.
export const excludeSpec = (value: string): string =>
  safePathspec(value)
    ? ':(exclude,literal)' + value
    : ':(exclude,glob)' +
      [...Buffer.from(value, 'utf8')]
        .map((byte) => (SAFE_CHAR.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : '?'))
        .join('');

export function consumerSearchArgs(excludes: ReadonlyArray<string>, name: string): Array<string> {
  return ['grep', ...searchFlags(wordEdged(name)), '-e', name, '--', '.', ...excludes.map(excludeSpec)];
}

// The rendered command the explorer runs with `<name>` replaced; the explorer adds `-w` by the rule the brief states.
export function consumerSearchText(excludes: ReadonlyArray<string>): string {
  return [
    'git',
    'grep',
    ...searchFlags(false),
    '-e',
    '<name>',
    '--',
    '.',
    ...excludes.map((value) => '"' + excludeSpec(value) + '"'),
  ].join(' ');
}
