// Pure repo-relative line-reference validation for plan and design documents.

import { safeRelativePath } from './context.ts';
import { EXECUTION_STATUS_HEADING, RESOLUTION_HEADING } from './document-lint.ts';
import { defined } from './defined.ts';
import { commentOpenOutsideCode, FENCE } from './markdown-structure.ts';

export type CitationDefect = { code: 'broken-citation'; severity: 'defect'; line: number; message: string };

type Container = { kind: 'quote' } | { kind: 'list'; indent: number };

const LINE_REF = /^(.+?):(\d+)(?:-(\d+))?$/;
const QUOTE_PREFIX = /^ {0,3}> ?/;
const LIST_PREFIX = /^( {0,3}(?:[-*+]|\d+[.)]) +)/;
const IPV4 = /^\d+(?:\.\d+){3}$/;
const HOSTNAME_TLD = /\.(?:com|org|net|io|dev|app|edu|gov|local|internal)$/i;
const DOTTED_EXT = /\.[A-Za-z][A-Za-z0-9_-]*$/;
const WELL_KNOWN_ROOT_FILES = new Set([
  'LICENSE',
  'NOTICE',
  'README',
  'COPYING',
  'CHANGELOG',
  'Makefile',
  'Dockerfile',
  'Containerfile',
  'Vagrantfile',
  'Procfile',
  'Gemfile',
  'Rakefile',
  'Justfile',
]);

function lineCount(content: string): number {
  return content === '' ? 0 : content.replace(/\r?\n$/, '').split(/\r?\n/).length;
}

function opensBacktickSpanOnLine(text: string, marker: string): boolean {
  if (marker[0] !== '`') {
    return false;
  }
  const start = text.indexOf(marker);
  return start >= 0 && text.slice(start + marker.length).includes('`');
}

const stripHeadingPrefix = (heading: string): string => heading.replace(/^##\s+/, '').trim();

function governedCitationLines(source: string, kind: 'plan' | 'design'): Array<{ line: number; text: string }> {
  const excludedHeadings = new Set(
    kind === 'plan'
      ? [stripHeadingPrefix(RESOLUTION_HEADING)]
      : [stripHeadingPrefix(EXECUTION_STATUS_HEADING), stripHeadingPrefix(RESOLUTION_HEADING)],
  );
  const out: Array<{ line: number; text: string }> = [];
  const stack: Array<Container> = [];
  let fence: { char: '`' | '~'; length: number; containerDepth: number } | null = null;
  let inComment = false;
  let inExcluded = false;

  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const lineNo = index + 1;
    let rest = rawLine;
    let matched = 0;
    for (const frame of stack) {
      if (frame.kind === 'quote') {
        const match = QUOTE_PREFIX.exec(rest);
        if (!match) {
          break;
        }
        rest = rest.slice(match[0].length);
      } else if (rest.trim() === '') {
        rest = '';
      } else {
        if ((/^ */.exec(rest)?.[0].length ?? 0) < frame.indent) {
          break;
        }
        rest = rest.slice(frame.indent);
      }
      matched++;
    }
    stack.length = matched;

    if (fence !== null && stack.length < fence.containerDepth) {
      fence = null;
    }

    if (fence !== null) {
      const closeMatch = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(rest);
      const closer = closeMatch?.[1];
      if (closer?.[0] === fence.char && closer.length >= fence.length) {
        fence = null;
      }
      continue;
    }

    if (!inComment) {
      for (;;) {
        const quote = QUOTE_PREFIX.exec(rest);
        if (quote) {
          stack.push({ kind: 'quote' });
          rest = rest.slice(quote[0].length);
          continue;
        }
        const listPrefix = LIST_PREFIX.exec(rest)?.[1];
        if (listPrefix !== undefined) {
          stack.push({ kind: 'list', indent: listPrefix.length });
          rest = rest.slice(listPrefix.length);
          continue;
        }
        break;
      }

      const marker = FENCE.exec(rest)?.[1];
      if (marker && !opensBacktickSpanOnLine(rest, marker)) {
        fence = { char: marker.startsWith('`') ? '`' : '~', length: marker.length, containerDepth: stack.length };
        continue;
      }
    }

    let text = '';
    let cursor = 0;
    while (cursor < rest.length) {
      if (inComment) {
        const close = rest.indexOf('-->', cursor);
        if (close === -1) {
          break;
        }
        inComment = false;
        cursor = close + 3;
        continue;
      }
      const open = commentOpenOutsideCode(rest, cursor);
      if (open === -1) {
        text += rest.slice(cursor);
        break;
      }
      text += rest.slice(cursor, open);
      inComment = true;
      cursor = open + 4;
    }

    if (!inComment && stack.length === 0) {
      const heading = /^## +(.+?)\s*$/.exec(text);
      if (heading) {
        inExcluded = excludedHeadings.has(defined(heading[1]).trim());
      }
    }
    if (!inExcluded && text) {
      out.push({ line: lineNo, text });
    }
  }
  return out;
}

/** Validates backticked exact repo-relative `path:line` and `path:start-end` citations in governed plan/design sections. */
export function lintCitations(
  source: string,
  kind: 'plan' | 'design',
  readRepoFile: (relPath: string) => string | null,
): Array<CitationDefect> {
  const defects: Array<CitationDefect> = [];
  const fileCache = new Map<string, string | null>();
  const read = (relPath: string): string | null => {
    const cached = fileCache.get(relPath);
    if (cached !== undefined) {
      return cached;
    }
    let content: string | null = null;
    try {
      content = readRepoFile(relPath);
    } catch {
      /* A failed repository read counts as a missing file. */
    }
    fileCache.set(relPath, content);
    return content;
  };

  for (const { line, text } of governedCitationLines(source, kind)) {
    for (const match of text.matchAll(/`([^`]+)`/g)) {
      const token = defined(match[1]).trim();
      const parsed = LINE_REF.exec(token);
      if (!parsed) {
        continue;
      }
      const prefix = defined(parsed[1]);
      const start = Number(parsed[2]);
      const end = parsed[3] === undefined ? start : Number(parsed[3]);

      if (
        prefix.includes('://') ||
        /^sha256:/i.test(token) ||
        IPV4.test(prefix) ||
        /^localhost$/i.test(prefix) ||
        (!prefix.includes('/') && HOSTNAME_TLD.test(prefix))
      ) {
        continue;
      }

      const safe = safeRelativePath(prefix);
      const existing = safe ? read(prefix) : null;
      if (existing === null) {
        if (/\s/.test(prefix)) {
          const tokens = prefix.trim().split(/\s+/);
          const firstToken = defined(tokens[0]);
          const lastToken = defined(tokens.at(-1));
          if (
            /\s--?[A-Za-z]/.test(prefix) ||
            /^localhost$/i.test(lastToken) ||
            IPV4.test(lastToken) ||
            (!lastToken.includes('/') && HOSTNAME_TLD.test(lastToken)) ||
            !firstToken.includes('/')
          ) {
            continue;
          }
        } else if (!(prefix.includes('/') || DOTTED_EXT.test(prefix) || WELL_KNOWN_ROOT_FILES.has(prefix))) {
          continue;
        }
      }

      if (!safe) {
        defects.push({
          code: 'broken-citation',
          severity: 'defect',
          line,
          message: `Unsafe repository citation path: ${prefix}`,
        });
        continue;
      }
      if (existing === null) {
        defects.push({
          code: 'broken-citation',
          severity: 'defect',
          line,
          message: `Missing or unreadable cited file: ${prefix}`,
        });
        continue;
      }
      const totalLines = lineCount(existing);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || start > end || end > totalLines) {
        defects.push({
          code: 'broken-citation',
          severity: 'defect',
          line,
          message: `Citation line range ${start}${end === start ? '' : `-${end}`} is out of bounds for ${prefix} (${totalLines} lines)`,
        });
      }
    }
  }
  return defects;
}
