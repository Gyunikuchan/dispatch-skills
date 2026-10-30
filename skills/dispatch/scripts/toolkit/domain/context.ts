import path from 'node:path';
import { sectionRanges, structuralLines } from './plan.ts';

export const CONTEXT_SECTIONS = ['Map', 'Flows', 'Invariants', 'Coverage', 'Precedent', 'Conventions', 'Surprises', 'Not covered'] as const;
export type ContextSection = typeof CONTEXT_SECTIONS[number];
export type ContextStrategy = 'single' | 'outside-in' | 'inside-out' | 'merged';

export type ParsedContextMap = {
  title: string | null;
  commit: string | null;
  strategy: ContextStrategy | null;
  tool: string | null;
  sections: Record<ContextSection, string[]>;
};

export type ContextLintIssue = {
  code: string;
  severity: 'defect' | 'warning';
  line: number | null;
  message: string;
};

export type ContextLintResult = {
  ok: boolean;
  defects: ContextLintIssue[];
  warnings: ContextLintIssue[];
  map: ParsedContextMap;
};

export type ContextLintOptions = { readRepoFile: (relativePath: string) => string | null };

type ContextReference = { path: string; start: number | null; end: number | null };
type ContextEntry = { line: number; text: string };

const REQUIRED_LINE_SECTIONS = new Set<ContextSection>(['Map', 'Flows', 'Invariants', 'Conventions', 'Surprises']);
const OPTIONAL_SECTIONS = new Set<ContextSection>(['Conventions']);
const REF_LINE = /^(.+):(\d+)(?:-(\d+))?$/;

function entries(lines: ReturnType<typeof structuralLines>, section: ContextSection): ContextEntry[] {
  return sectionRanges(lines, `## ${section}`).flatMap(range => lines.slice(range.start + 1, range.end))
    .filter(entry => entry.text.trim())
    .map(entry => ({ line: entry.line, text: entry.text.trim() }));
}
function metadata(lines: ReturnType<typeof structuralLines>, label: 'Commit' | 'Strategy' | 'Tool'): string | null {
  const marker = new RegExp(`^>\\s*\\*\\*${label}:\\*\\*\\s*(.*?)\\s*$`);
  return lines.map(entry => marker.exec(entry.original)?.[1]?.trim() ?? null).find(value => value !== null) ?? null;
}
function isValidCommit(commit: string | null): commit is string {
  return commit !== null && /^[0-9a-f]{7,64}$/i.test(commit);
}

function strategyValue(value: string | null): ContextStrategy | null {
  return value === 'single' || value === 'outside-in' || value === 'inside-out' || value === 'merged' ? value : null;
}

/** Parses the structured sections while preserving each entry for deterministic map merging. */
export function parseContextMap(source: string): ParsedContextMap {
  const lines = structuralLines(source);
  const sections = Object.fromEntries(CONTEXT_SECTIONS.map(section => [section, entries(lines, section).map(entry => entry.text)])) as Record<ContextSection, string[]>;
  const title = lines.map(entry => /^#\s+Context map:\s*(.*?)\s*$/i.exec(entry.text)?.[1]?.trim() ?? null).find(value => value !== null) ?? null;
  const commit = metadata(lines, 'Commit');
  const strategy = strategyValue(metadata(lines, 'Strategy'));
  const tool = metadata(lines, 'Tool');
  return { title, commit, strategy, tool, sections };
}

function pathOnlyReference(value: string, allowBare = false): ContextReference | null {
  const ref = value.trim();
  const withLines = REF_LINE.exec(ref);
  if (withLines) return { path: withLines[1]!, start: Number(withLines[2]), end: withLines[3] === undefined ? Number(withLines[2]) : Number(withLines[3]) };
  if (allowBare || /[/.\\]/.test(ref) || /^[A-Za-z]:/.test(ref)) return { path: ref, start: null, end: null };
  return null;
}

function inlineReferences(text: string, allowBare: boolean): ContextReference[] {
  return [...text.matchAll(/`([^`]+)`/g)].flatMap(match => {
    const ref = pathOnlyReference(match[1]!, allowBare);
    return ref ? [ref] : [];
  });
}
function safeRelativePath(value: string): boolean {
  if (!value || value.includes('\\') || value.includes('\0') || path.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized !== '.' && normalized !== '..' && !normalized.startsWith('../') && !path.posix.isAbsolute(normalized);
}

function lineCount(source: string): number {
  if (!source) return 0;
  const breaks = source.match(/\n/g)?.length ?? 0;
  return source.endsWith('\n') ? breaks : breaks + 1;
}

function quoteFrom(text: string): string | null {
  const quotes = [...text.matchAll(/"((?:\\.|[^"\\])*)"|“([^”]*)”/g)];
  const last = quotes.at(-1);
  if (!last) return null;
  return (last[1] ?? last[2] ?? '').replaceAll('\\"', '"').replaceAll('\\\\', '\\');
}

const normalizeWhitespace = (value: string) => value.replace(/\s+/gu, ' ').trim();
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function sectionReferences(section: ContextSection, entry: string): ContextReference[] {
  return inlineReferences(entry, section === 'Coverage' || section === 'Precedent');
}

function coverageKey(entry: string): string | null {
  const match = /^(?:-\s*)?(?:\[disputed\]\s*)?([^:]+):/.exec(entry.trim());
  return match?.[1]?.trim().toLocaleLowerCase('en-US') ?? null;
}

function isNotCovered(entry: string): boolean {
  return /\bnot covered\b/i.test(entry);
}

function isDisputed(entry: string): boolean {
  return /^(?:-\s+)?\[disputed\]\s+/i.test(entry);
}

function markDisputed(entry: string): string {
  if (isDisputed(entry)) return entry;
  return /^-\s+/.test(entry) ? entry.replace(/^(-\s+)/, '$1[disputed] ') : `[disputed] ${entry}`;
}

export const commitsMatch = (left: string | null, right: string | null): boolean => (left === null && right === null) || (
    isValidCommit(left) && isValidCommit(right)
      && (left.toLowerCase().startsWith(right.toLowerCase()) || right.toLowerCase().startsWith(left.toLowerCase()))
  );

/** Produces a stable union: same-key Coverage/Precedent claims merge unless `not covered` or a dispute opposes them; other one-sided claims are disputed. */
export function mergeContextMaps(a: ParsedContextMap, b: ParsedContextMap): { source: string; disputed: number } {
  if (!commitsMatch(a.commit, b.commit)) {
    throw new Error(`Context maps have different commits: ${a.commit ?? '(missing)'} and ${b.commit ?? '(missing)'}.`);
  }
  const mergedCommit = (a.commit?.length ?? -1) >= (b.commit?.length ?? -1) ? a.commit : b.commit;

  const files = (map: ParsedContextMap): Set<string> => new Set(CONTEXT_SECTIONS.flatMap(section =>
    map.sections[section].flatMap(entry => sectionReferences(section, entry).map(ref => ref.path))));
  const filesA = files(a);
  const filesB = files(b);

  const keyed = (map: ParsedContextMap, section: ContextSection): Map<string, string[]> => {
    const grouped = new Map<string, string[]>();
    for (const entry of map.sections[section]) {
      const key = coverageKey(entry);
      if (!key) continue;
      grouped.set(key, [...(grouped.get(key) ?? []), entry]);
    }
    return grouped;
  };
  const coverageA = keyed(a, 'Coverage');
  const coverageB = keyed(b, 'Coverage');
  const oneSidedCoverage = (entry: string, key: string, opposite: Map<string, string[]>): boolean =>
    !isNotCovered(entry) && (opposite.get(key) ?? []).some(isNotCovered);

  let disputed = 0;
  const sections = new Map<ContextSection, string[]>();
  for (const section of CONTEXT_SECTIONS) {
    const candidates = new Map<string, string[]>();
    // Same-key Coverage/Precedent claims that both maps cite become one undisputed entry; the first claim keeps its text, the other refs follow.
    const shared = new Map<string, string>();
    if (section === 'Coverage' || section === 'Precedent') {
      const right = keyed(b, section);
      for (const [key, left] of keyed(a, section)) {
        const entries = [...left, ...(right.get(key) ?? [])];
        if (!right.has(key) || entries.some(entry => isNotCovered(entry) || isDisputed(entry))) continue;
        const [first, ...rest] = entries.map(normalizeWhitespace).sort(compareText);
        const cited = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map(match => match[1]!);
        const added = [...new Set(rest.flatMap(cited))].filter(ref => !cited(first!).includes(ref)).sort(compareText);
        shared.set(key, [first!, ...added.map(ref => `\`${ref}\``)].join(', '));
      }
    }
    const collect = (map: ParsedContextMap, ownFiles: Set<string>, otherFiles: Set<string>, oppositeCoverage: Map<string, string[]>) => {
      for (const entry of map.sections[section]) {
        const identity = normalizeWhitespace(entry);
        const key = coverageKey(entry);
        if (key !== null && shared.has(key)) continue;
        const refs = sectionReferences(section, entry);
        const singleMapFile = refs.some(ref => ownFiles.has(ref.path) && !otherFiles.has(ref.path));
        const coverageDispute = section === 'Coverage' && key !== null && oneSidedCoverage(entry, key, oppositeCoverage);
        const marked = singleMapFile || coverageDispute || isDisputed(entry);
        const value = marked ? markDisputed(entry) : entry;
        candidates.set(identity, [...(candidates.get(identity) ?? []), value]);
      }
    };
    collect(a, filesA, filesB, coverageB);
    collect(b, filesB, filesA, coverageA);
    for (const text of shared.values()) candidates.set(text, [text]);

    const merged = [...candidates.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([, values]) => values.sort(compareText)[0]!);
    disputed += merged.filter(isDisputed).length;
    sections.set(section, merged);
  }

  const title = [a.title, b.title].filter((value): value is string => Boolean(value)).sort(compareText)[0] ?? 'merged';
  const tools = [...new Set([a.tool, b.tool].filter((value): value is string => Boolean(value)))].sort(compareText);
  const lines = [
    `# Context map: ${title}`, '',
    ...(mergedCommit === null ? [] : [`> **Commit:** ${mergedCommit}`]),
    '>',
    '> **Strategy:** merged',
    '>',
    `> **Tool:** ${tools.join(', ')}`, '',
  ];
  for (const section of CONTEXT_SECTIONS) lines.push(`## ${section}`, ...(sections.get(section) ?? []), '');
  return { source: lines.join('\n'), disputed };
}

/** Checks map refs and invariant quotes through the caller's repository reader. */
export function lintContextMap(source: string, options: ContextLintOptions): ContextLintResult {
  const lines = structuralLines(source);
  const map = parseContextMap(source);
  const defects: ContextLintIssue[] = [];
  const warnings: ContextLintIssue[] = [];
  const add = (severity: ContextLintIssue['severity'], code: string, line: number | null, message: string) => {
    (severity === 'defect' ? defects : warnings).push({ code, severity, line, message });
  };
  if (map.commit !== null && !isValidCommit(map.commit)) {
    const line = lines.find(entry => /^>\s*\*\*Commit:\*/.test(entry.original))?.line ?? null;
    add('defect', 'context-commit', line, 'Commit must be a bare hexadecimal revision from 7 to 64 characters.');
  }
  const fileCache = new Map<string, string | null>();
  const read = (ref: string): string | null => {
    if (fileCache.has(ref)) return fileCache.get(ref)!;
    let content: string | null = null;
    try { content = options.readRepoFile(ref); } catch { /* A failed repository read is a missing ref. */ }
    fileCache.set(ref, content);
    return content;
  };

  for (const section of CONTEXT_SECTIONS) {
    const sectionRangesForName = sectionRanges(lines, `## ${section}`);
    if (!sectionRangesForName.length) {
      if (!OPTIONAL_SECTIONS.has(section)) add('warning', 'context-missing-section', null, `Context map has no ## ${section} section.`);
      continue;
    }
    for (const entry of entries(lines, section)) {
      const refs = sectionReferences(section, entry.text);
      const missingLineRef = REQUIRED_LINE_SECTIONS.has(section) && (!refs.length || refs.some(ref => ref.start === null));
      const missingPathRef = section === 'Coverage' && !refs.length && !/\bnot covered\b/i.test(entry.text)
        || section === 'Precedent' && !refs.length;
      if (missingLineRef || missingPathRef) {
        const requirement = REQUIRED_LINE_SECTIONS.has(section) ? 'repository path and line ref' : 'repository path ref';
        add('warning', 'context-missing-ref', entry.line, `${section} entry needs a backticked ${requirement}.`);
      }
      const checked: { ref: ContextReference; content: string | null; rangeValid: boolean }[] = [];
      for (const ref of refs) {
        if (!safeRelativePath(ref.path)) {
          add('defect', 'context-ref-unsafe', entry.line, `Reference path "${ref.path}" is absolute or escapes the repository root.`);
          checked.push({ ref, content: null, rangeValid: false });
          continue;
        }
        const content = read(ref.path);
        if (content === null) {
          add('defect', 'context-ref-missing', entry.line, `Referenced repository file is missing or unreadable: ${ref.path}.`);
          checked.push({ ref, content: null, rangeValid: false });
          continue;
        }
        if (ref.start === null) {
          checked.push({ ref, content, rangeValid: true });
          continue;
        }
        const end = ref.end ?? ref.start;
        if (!Number.isSafeInteger(ref.start) || !Number.isSafeInteger(end) || ref.start < 1 || end < ref.start || end > lineCount(content)) {
          add('defect', 'context-ref-range', entry.line, `Reference line range ${ref.start}-${end} is outside ${ref.path}.`);
          checked.push({ ref, content, rangeValid: false });
          continue;
        }
        checked.push({ ref, content, rangeValid: true });
      }

      if (section === 'Invariants') {
        const quote = quoteFrom(entry.text);
        if (quote === null || !quote.trim()) {
          add('warning', 'context-quote-missing', entry.line, 'Invariant entry needs a verbatim quote in double quotes.');
          continue;
        }
        const cited = checked.find(item => item.ref.start !== null && item.rangeValid && item.content !== null);
        if (!cited || cited.ref.start === null || cited.content === null) continue;
        const end = cited.ref.end ?? cited.ref.start;
        const selected = cited.content.split(/\r?\n/).slice(cited.ref.start - 1, end).join('\n');
        if (!normalizeWhitespace(selected).includes(normalizeWhitespace(quote))) {
          add('defect', 'context-quote-mismatch', entry.line, `Invariant quote does not appear in ${cited.ref.path}:${cited.ref.start}-${end}.`);
        }
      }
    }
  }

  const bytes = Buffer.byteLength(source, 'utf8');
  if (map.strategy === 'merged') {
    if (bytes > 24_576) add('warning', 'context-size-warning', null, `Merged context map is ${bytes} UTF-8 bytes; the warning budget is 24576.`);
  } else if (bytes > 32_768) {
    add('defect', 'context-size', null, `Context map is ${bytes} UTF-8 bytes; the hard limit is 32768.`);
  } else if (bytes > 16_384) {
    add('warning', 'context-size-warning', null, `Context map is ${bytes} UTF-8 bytes; the warning budget is 16384.`);
  }

  return { ok: defects.length === 0, defects, warnings, map };
}
