// The single delegate-report parse path for every source (spec §6.5 step 5).
// Parse failures are named so the wave can fall back; findings dedup with `dupOf`.

import type { FindingId, SlotId } from '../core/types.ts';
import { sanitizeText } from './sanitize.ts';
import type { DraftFinding, Finding, ReviewKind, Severity } from './types.ts';

// SECTION: Kind contracts

const SECTION_LOCUS = /^§\s+\S.*$/;
const CODE_LOCUS = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))[^:\\\r\n]+:L[1-9]\d*$/;

export const REVIEW_TAGS: Readonly<Record<ReviewKind, ReadonlySet<string>>> = {
  plan: new Set([
    'adjacent', 'approach', 'architecture', 'auth', 'blast-radius', 'coherence', 'compatibility', 'correctness', 'domain-logic',
    'edge-case', 'intent', 'invariant', 'migration', 'partial-failure', 'perf', 'race', 'rollback', 'scope-creep', 'security',
    'simplicity', 'spec-gap', 'standards', 'state-machine', 'testability', 'user-gap', 'validation', 'verification', 'yagni',
  ]),
  code: new Set([
    'a11y', 'adjacent', 'auth', 'breaking', 'compatibility', 'correctness', 'coupling', 'domain-logic', 'edge-case', 'intent',
    'invariant', 'migration', 'partial-failure', 'perf', 'race', 'resource-leak', 'reuse', 'root-cause', 'runtime', 'scope-creep',
    'seam', 'security', 'shallow', 'standards', 'test-gap', 'test-leak', 'type', 'ui', 'yagni',
  ]),
  // NOTE: Supported review tags plus those the design prompt block lists (scope, dependency-graph, invariant, testability, standards).
  design: new Set([
    'adjacent', 'alternatives', 'architecture', 'boundaries', 'compatibility', 'correctness', 'data-flow', 'dependency-graph',
    'graph-correctness', 'integration', 'intent', 'interfaces', 'invariant', 'migration', 'operations', 'parallel-safety', 'risk',
    'rollback', 'scope', 'scope-creep', 'security', 'simplicity', 'standards', 'testability', 'verification',
  ]),
};

const LOCUS: Readonly<Record<ReviewKind, { pattern: RegExp; description: string }>> = {
  code: { pattern: CODE_LOCUS, description: '"<relative-file>:L<line>"' },
  plan: { pattern: SECTION_LOCUS, description: '"§ <Plan heading>"' },
  design: { pattern: SECTION_LOCUS, description: '"§ <Design heading>"' },
};

const SEVERITIES: ReadonlySet<string> = new Set<Severity>(['MUST', 'SHOULD', 'CONSIDER']);
const FINDING_FIELDS = ['defect', 'locus', 'requiredChange', 'severity', 'tag'];
const REFUSAL = /\b(?:I(?:'m| am) (?:unable|not able) to (?:help|assist|comply|review)|I (?:can(?:no|')t|won't|will not) (?:help|assist|comply|do that|review)|I must decline|against my (?:guidelines|policies))\b/i;

/** Rewrites only the line prefix; ranges and columns keep their extent and fail the locus check. */
export function normalizeLocus(kind: ReviewKind, locus: string): string {
  const trimmed = locus.trim();
  if (kind === 'code') {
    return trimmed.replace(/^([^:#]+)#L([1-9]\d*)$/, '$1:L$2').replace(/^([^:#]+):([1-9]\d*)$/, '$1:L$2');
  }
  return trimmed.replace(/^§(?=\S)/, '§ ');
}

// SECTION: JSON extraction

const isContainer = (text: string) => (text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'));

// String-aware so brackets inside JSON strings never close the container early.
function containerEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth++;
    else if ((char === '}' || char === ']') && --depth === 0) return index + 1;
  }
  return -1;
}

/** The last fenced or bare JSON container in the text: banners and earlier cited snippets never win. */
export function extractJsonText(raw: string): string {
  const text = raw.trim();
  if (isContainer(text)) return text;
  const candidates: { at: number; text: string }[] = [];
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
  for (const match of fences) {
    const candidate = (match[1] ?? '').trim();
    if (isContainer(candidate)) candidates.push({ at: match.index, text: candidate });
  }
  const insideFence = (offset: number) => fences.some((match) => offset > match.index && offset < match.index + match[0].length);
  let resumeAt = 0;
  for (const match of text.matchAll(/^[ \t]*[{[]/gm)) {
    const start = match.index + match[0].length - 1;
    if (start < resumeAt || insideFence(start)) continue;
    const end = containerEnd(text, start);
    if (end === -1) continue;
    resumeAt = end;
    candidates.push({ at: start, text: text.slice(start, end) });
  }
  candidates.sort((left, right) => left.at - right.at);
  return candidates.at(-1)?.text ?? text;
}

// SECTION: Parse

export type ReportFailureKind = 'empty-output' | 'refusal' | 'truncated' | 'uncovered-scope' | 'loose-locus';
export type ReportFailure = { kind: ReportFailureKind; detail: string };
export type ReportInput = { kind: ReviewKind; source: SlotId; text: string; truncated?: boolean };
export type ReportResult =
  | { ok: true; status: 'CLEAN' | 'FINDINGS'; findings: DraftFinding[] }
  | { ok: false; failure: ReportFailure };

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const fail = (kind: ReportFailureKind, detail: string): ReportResult => ({ ok: false, failure: { kind, detail } });

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  for (const candidate of [text, extractJsonText(text)]) {
    try { return { ok: true, value: JSON.parse(candidate) as unknown }; } catch { /* try the extracted candidate */ }
  }
  return { ok: false };
}

/**
 * Parses one delegate report. Failures: empty output; truncation (runner-reported and unparseable); refusal;
 * uncovered scope (no structured `{status, findings}` review of the requested scope); loose locus (a finding
 * whose locus does not pin the kind's locus grammar). A truncated report that still parses is accepted.
 */
export function parseReport(input: ReportInput): ReportResult {
  const { kind, source } = input;
  const text = input.text.trim();
  if (!text) return fail('empty-output', 'the delegate returned no text');
  const parsed = parseJson(text);
  if (!parsed.ok) {
    if (input.truncated) return fail('truncated', 'output was cut off before a complete report');
    if (REFUSAL.test(text)) return fail('refusal', sanitizeText(text).slice(0, 200));
    return fail('uncovered-scope', 'no JSON report object found');
  }
  const value = parsed.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('uncovered-scope', 'report must be a JSON object');
  const record = value as Record<string, unknown>;
  const status = record['status'];
  const items = record['findings'];
  if (Object.keys(record).sort().join('\0') !== 'findings\0status') return fail('uncovered-scope', 'report fields must be exactly: status, findings');
  if ((status !== 'CLEAN' && status !== 'FINDINGS') || !Array.isArray(items)) {
    return fail('uncovered-scope', 'report must carry status CLEAN|FINDINGS and a findings array');
  }
  const findings: DraftFinding[] = [];
  const seen = new Set<string>();
  const { pattern, description } = LOCUS[kind];
  for (const [index, item] of items.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return fail('uncovered-scope', `finding ${index} must be a JSON object`);
    const finding = item as Record<string, unknown>;
    if (Object.keys(finding).sort().join('\0') !== FINDING_FIELDS.join('\0')) return fail('uncovered-scope', `finding ${index} fields must be exactly: severity, locus, tag, defect, requiredChange`);
    const { severity, locus, tag, defect, requiredChange } = finding;
    if (typeof severity !== 'string' || !SEVERITIES.has(severity)) return fail('uncovered-scope', `finding ${index} severity must be MUST, SHOULD, or CONSIDER`);
    if (!nonEmpty(tag) || !REVIEW_TAGS[kind].has(tag.trim())) return fail('uncovered-scope', `finding ${index} tag is not an allowed ${kind} review tag`);
    if (!nonEmpty(defect) || !nonEmpty(requiredChange)) return fail('uncovered-scope', `finding ${index} needs a defect and a requiredChange`);
    if (!nonEmpty(locus) || !pattern.test(normalizeLocus(kind, locus))) return fail('loose-locus', `finding ${index} locus must match ${description}`);
    // Sanitization can strip a whole value (e.g. a tool-call line), so emptiness is re-checked after it.
    if (!sanitizeText(defect) || !sanitizeText(requiredChange)) return fail('uncovered-scope', `finding ${index} needs a defect and a requiredChange after sanitization`);
    const draft: DraftFinding = {
      severity: severity as Severity,
      category: tag.trim(),
      locus: normalizeLocus(kind, locus),
      defect: sanitizeText(defect),
      requiredChange: sanitizeText(requiredChange),
      sources: [source],
      scope: tag.trim() === 'adjacent' ? 'adjacent' : 'in',
    };
    const key = JSON.stringify([draft.severity, draft.locus, draft.category, draft.defect, draft.requiredChange]);
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(draft);
  }
  if (status === 'CLEAN' && findings.length) return fail('uncovered-scope', 'CLEAN requires an empty findings array');
  if (status === 'FINDINGS' && !findings.length) return fail('uncovered-scope', 'FINDINGS requires at least one finding');
  return { ok: true, status, findings };
}

// SECTION: Matching

export const MATCH_LINE_WINDOW = 5;
export const MATCH_JACCARD = 0.3;
const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'has', 'had', 'its', 'was', 'were', 'will',
  'with', 'this', 'that', 'from', 'into', 'when', 'then', 'than', 'them', 'they', 'which', 'while', 'where', 'there',
  'their', 'these', 'those', 'should', 'would', 'could', 'must', 'does', 'did', 'have', 'been', 'being', 'also', 'only',
  'each', 'other', 'such', 'what', 'who', 'how', 'why', 'our', 'out', 'use', 'uses', 'used',
]);

const tokens = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !STOPWORDS.has(token)));

/** Token Jaccard; two empty sets score 0 so location and category alone never match. */
export function similarity(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export type MatchKey = { locus: string; category: string; text: string };

/** Code loci: same path (case-folded when `caseInsensitive`) within ±MATCH_LINE_WINDOW lines; section loci: same heading. */
function sameLocation(a: string, b: string, caseInsensitive: boolean): boolean {
  const code = (locus: string) => /^(.+?):L(\d+)/.exec(locus.trim());
  const left = code(a);
  const right = code(b);
  if (left && right) {
    const fold = (file: string) => (caseInsensitive ? file.replace(/\\/g, '/').toLowerCase() : file.replace(/\\/g, '/'));
    return fold(left[1] ?? '') === fold(right[1] ?? '') && Math.abs(Number(left[2]) - Number(right[2])) <= MATCH_LINE_WINDOW;
  }
  if (left || right) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Location + category with loose text similarity (spec §7.5). */
export function matchFinding(a: MatchKey, b: MatchKey, caseInsensitive = false): boolean {
  return a.category === b.category && sameLocation(a.locus, b.locus, caseInsensitive) && similarity(a.text, b.text) >= MATCH_JACCARD;
}

// SECTION: Collect and dedup

export const findingId = (round: number, ordinal: number): FindingId => `R${round}-F${String(ordinal).padStart(3, '0')}`;

/**
 * Assigns round ids in report order and dedups across sources: a duplicate keeps its own id with `dupOf`
 * naming the first, and the first cites every source that reported it.
 */
export function collectFindings(round: number, drafts: readonly DraftFinding[], firstOrdinal = 1): Finding[] {
  const out: Finding[] = [];
  drafts.forEach((draft, index) => {
    const id = findingId(round, firstOrdinal + index);
    const key: MatchKey = { locus: draft.locus, category: draft.category, text: `${draft.defect} ${draft.requiredChange}` };
    const first = out.find((prior) => prior.dupOf === undefined && matchFinding({ locus: prior.locus, category: prior.category, text: `${prior.defect} ${prior.requiredChange}` }, key));
    if (first) {
      first.sources = [...new Set([...first.sources, ...draft.sources])];
      out.push({ ...draft, id, dupOf: first.id });
    } else out.push({ ...draft, id });
  });
  return out;
}
