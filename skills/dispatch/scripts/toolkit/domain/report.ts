// The single delegate-report parse path for every source (spec §6.5 step 5).
// Parse failures are named so the wave can fall back; findings dedup with `dupOf`.

import type { FindingId, SlotId } from '../types.ts';
import { sanitizeText } from './sanitize.ts';
import { IMPACTS, TRIGGERS, severityOf } from './severity.ts';
import type { DraftFinding, Finding, Impact, ReviewKind, Trigger } from './types.ts';

// SECTION: Kind contracts

const SECTION_LOCUS = /^§\s+\S.*$/;
const CODE_LOCUS = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))[^:\\\r\n]+:L[1-9]\d*$/;

export const REVIEW_TAGS: ReadonlySet<string> = new Set([
  'intent', 'spec', 'correctness', 'reliability', 'security', 'performance', 'compatibility', 'maintainability',
  'architecture', 'decomposition', 'operability', 'testing', 'usability', 'standards', 'adjacent',
]);

const LOCUS: Readonly<Record<ReviewKind, RegExp>> = { code: CODE_LOCUS, plan: SECTION_LOCUS, design: SECTION_LOCUS };

const FINDING_FIELDS = ['defect', 'impact', 'locus', 'requiredChange', 'tag', 'trigger'];
const REFUSAL = /\b(?:I(?:'m| am) (?:unable|not able) to (?:help|assist|comply|review)|I (?:can(?:no|')t|won't|will not) (?:help|assist|comply|do that|review)|I must decline|against my (?:guidelines|policies))\b/i;

/** Rewrites only the line prefix; ranges and columns keep their extent and fail the locus check. */
export function normalizeLocus(kind: ReviewKind, locus: string): string {
  const trimmed = locus.trim();
  if (kind === 'code') {
    return trimmed.replace(/^([^:#]+)#L([1-9]\d*)$/, '$1:L$2').replace(/^([^:#]+):([1-9]\d*)$/, '$1:L$2');
  }
  return trimmed.replace(/^§(?=\S)/, '§ ');
}

export const UNRESOLVED_LOCUS = 'unresolved-locus: ';
const UNRESOLVED_LOCUS_BYTES = 120;
export const isUnresolvedLocus = (locus: string): boolean => locus.startsWith(UNRESOLVED_LOCUS);

/** Its 120-byte bound keeps the marked text visible inside a 200-byte summary item. */
function unresolvedLocus(reported: unknown): string {
  const text = (typeof reported === 'string' && sanitizeText(reported)) || '(none)';
  if (Buffer.byteLength(text, 'utf8') <= UNRESOLVED_LOCUS_BYTES) return UNRESOLVED_LOCUS + text;
  // NOTE: a byte cut can end inside a character, which decodes to one trailing U+FFFD.
  return UNRESOLVED_LOCUS + Buffer.from(text, 'utf8').subarray(0, UNRESOLVED_LOCUS_BYTES - 3).toString('utf8').replace(/\uFFFD$/, '') + '…';
}

// SECTION: JSON extraction

const parses = (text: string): boolean => {try {JSON.parse(text); return true;} catch {return false;}};
const MAX_CANDIDATES = 1024;
const FENCE = '```';

/** Index just past the last character before i that is not whitespace. */
function endOfPrior(text: string, i: number): number {
  while (i > 0 && /\s/.test(text[i - 1]!)) i--;
  return i;
}

/** A line-start or json-tagged opener; a raw newline cannot occur in a JSON string, so embedded fences never qualify. */
function fencedBody(text: string): string | null {
  const close = text.length - FENCE.length;
  for (let open = text.lastIndexOf(FENCE, close - 1); open >= 0; open = open === 0 ? -1 : text.lastIndexOf(FENCE, open - 1)) {
    const body = text.slice(open + FENCE.length, close);
    let lineStart = open;
    while (lineStart > 0 && (text[lineStart - 1] === ' ' || text[lineStart - 1] === '\t')) lineStart--;
    const tagged = /^json[ \t]*\r?\n/i.test(body);
    if (tagged || lineStart === 0 || text[lineStart - 1] === '\n') return (tagged ? body.slice(4) : body).trim();
  }
  return null;
}

/** A prior line that opens an object key, is a bare key with a JSON value, is a value and comma, or is only container punctuation means this object is nested in a cut-off report. */
function continuesContainer(text: string, lineStart: number): boolean {
  const end = endOfPrior(text, lineStart);
  const line = text.slice(text.lastIndexOf('\n', end - 1) + 1, end).trim();
  if (parses(line)) return false;
  if (line.endsWith(',') && parses(line.slice(0, -1))) return true;
  return /^[{[,][{[,\s]*"[^"]*"\s*:/.test(line)
    || /^"[^"]*"\s*:\s*(?:$|[{["]|(?:-?\d[\d.eE+-]*|true|false|null)\s*,?$)/.test(line)
    || /^(?:[{[]|[}\]]\s*,)$/.test(line);
}

/**
 * The report must end the reply: the whole text, a closing fenced block, or a line-start object running to the end.
 * Position decides, not content, so quoted examples and earlier JSON never compete; anything else fails closed.
 */
export function extractJsonText(raw: string): string {
  const text = raw.trim();
  if (parses(text)) return text;
  if (text.endsWith(FENCE)) return fencedBody(text) ?? text;
  if (!text.endsWith('}')) return text;
  let tried = 0;
  for (let brace = text.lastIndexOf('{'); brace >= 0 && tried < MAX_CANDIDATES; brace = brace === 0 ? -1 : text.lastIndexOf('{', brace - 1)) {
    let lineStart = brace;
    while (lineStart > 0 && (text[lineStart - 1] === ' ' || text[lineStart - 1] === '\t')) lineStart--;
    if (lineStart > 0 && text[lineStart - 1] !== '\n') continue;
    if (continuesContainer(text, lineStart)) continue;
    tried++;
    const candidate = text.slice(brace);
    if (parses(candidate)) return candidate;
  }
  return text;
}

// SECTION: Parse

export type ReportFailureKind = 'empty-output' | 'refusal' | 'blocked' | 'truncated' | 'uncovered-scope';
export type ReportFailure = { kind: ReportFailureKind; detail: string };
export type Confirmation = {requestId: string; decision: 'agree' | 'disagree'; rationale: string};
export type ReportInput = { kind: ReviewKind; source: SlotId; text: string; truncated?: boolean; expectedRequestIds?: readonly string[] };
export type ReportResult =
  | { ok: true; status: 'CLEAN' | 'FINDINGS'; findings: DraftFinding[]; confirmations?: Confirmation[] }
  | { ok: false; failure: ReportFailure };
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const fail = (kind: ReportFailureKind, detail: string): ReportResult => ({ ok: false, failure: { kind, detail } });
function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try { return { ok: true, value: JSON.parse(extractJsonText(text)) as unknown }; } catch { return { ok: false }; }
}
/**
 * Parses one delegate report. Failures: empty output; truncation (runner-reported and unparseable); refusal;
 * blocked (a `BLOCKED` report with a reason); uncovered scope (no structured `{status, findings}` review of the
 * requested scope). A truncated report that still parses is accepted. A nonempty
 * tag outside the shared vocabulary is recovered, not a failure: the finding becomes `uncategorized` with a
 * sanitized `originalTag`. A locus outside the kind's grammar is also recovered: the finding keeps it marked with `UNRESOLVED_LOCUS`.
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
  // A capability blocker is a report, not a malformed review: keep the reviewer's own reason.
  if (status === 'BLOCKED') {
    const reason = record['reason'];
    if (nonEmpty(reason)) return fail('blocked', reason.trim());
  }
  const fields = Object.keys(record).sort().join('\0');
  if (fields !== 'findings\0status' && fields !== 'confirmations\0findings\0status') return fail('uncovered-scope', 'report fields must be status, findings and optional confirmations');
  const confirmations: Confirmation[] = [];
  if (Object.hasOwn(record, 'confirmations')) {
    if (!Array.isArray(record['confirmations'])) return fail('uncovered-scope', 'confirmations must be an array');
    for (const item of record['confirmations']) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join('\0') !== 'decision\0rationale\0requestId') return fail('uncovered-scope', 'confirmation fields must be exactly requestId, decision, rationale');
      const {requestId, decision, rationale} = item;
      if (!nonEmpty(requestId) || (decision !== 'agree' && decision !== 'disagree') || !nonEmpty(rationale) || !sanitizeText(rationale) || confirmations.some(reply => reply.requestId === requestId)) return fail('uncovered-scope', 'confirmation needs a unique requestId, explicit decision and rationale');
      confirmations.push({requestId, decision, rationale: sanitizeText(rationale)});
    }
  }
  if (input.expectedRequestIds && (confirmations.length !== input.expectedRequestIds.length || confirmations.some(reply => !input.expectedRequestIds!.includes(reply.requestId)))) return fail('uncovered-scope', 'each assigned confirmation request requires exactly one explicit reply');
  if ((status !== 'CLEAN' && status !== 'FINDINGS') || !Array.isArray(items)) {
    return fail('uncovered-scope', 'report must carry status CLEAN|FINDINGS and a findings array');
  }
  const findings: DraftFinding[] = [];
  const seen = new Set<string>();
  const pattern = LOCUS[kind];
  for (const [index, item] of items.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return fail('uncovered-scope', `finding ${index} must be a JSON object`);
    const finding = item as Record<string, unknown>;
    const missing = FINDING_FIELDS.filter(field => !Object.hasOwn(finding, field)), unexpected = Object.keys(finding).filter(field => !FINDING_FIELDS.includes(field));
    // NOTE: key names are delegate text, so only the retired field is named and other keys are counted.
    const others = unexpected.filter(field => field !== 'severity').length;
    const unsupported = [...(unexpected.includes('severity') ? ['severity'] : []), ...(others ? [others + ' other field(s)'] : [])];
    if (missing.length || unsupported.length) return fail('uncovered-scope', `finding ${index} fields must be exactly: impact, trigger, locus, tag, defect, requiredChange${missing.length ? '; missing: ' + missing.join(', ') : ''}${unsupported.length ? '; unsupported: ' + unsupported.join(', ') : ''}`);
    const { impact, trigger, locus, tag, defect, requiredChange } = finding;
    if (!IMPACTS.includes(impact as Impact)) return fail('uncovered-scope', `finding ${index} impact must be one of ${IMPACTS.join(', ')}`);
    if (!TRIGGERS.includes(trigger as Trigger)) return fail('uncovered-scope', `finding ${index} trigger must be one of ${TRIGGERS.join(', ')}`);
    if (!nonEmpty(tag)) return fail('uncovered-scope', `finding ${index} needs a nonempty tag`);
    const normalizedTag = tag.trim();
    const known = REVIEW_TAGS.has(normalizedTag);
    // `spec` shares the intent gate.
    const category = known ? normalizedTag === 'spec' ? 'intent' : normalizedTag : 'uncategorized';
    // Markup-inert by construction; the raw spelling stays only in the provider log.
    const originalTag = known ? undefined : normalizedTag.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
    if (!nonEmpty(defect) || !nonEmpty(requiredChange)) return fail('uncovered-scope', `finding ${index} needs a defect and a requiredChange`);
    const normalizedLocus = nonEmpty(locus) ? normalizeLocus(kind, locus) : '';
    const resolved = pattern.test(normalizedLocus);
    // Sanitization can strip a whole value (e.g. a tool-call line), so emptiness is re-checked after it.
    if (!sanitizeText(defect) || !sanitizeText(requiredChange)) return fail('uncovered-scope', `finding ${index} needs a defect and a requiredChange after sanitization`);
    const draft: DraftFinding = {
      impact: impact as Impact,
      trigger: trigger as Trigger,
      severity: severityOf(impact as Impact, trigger as Trigger),
      category,
      locus: resolved ? normalizedLocus : unresolvedLocus(locus),
      defect: sanitizeText(defect),
      requiredChange: sanitizeText(requiredChange),
      sources: [source],
      scope: category === 'adjacent' ? 'adjacent' : 'in',
      ...(originalTag === undefined ? {} : { originalTag }),
    };
    // Raw tag and unresolved locus, not their lossy sanitized forms, so distinct values never collide.
    const key = JSON.stringify([draft.severity, resolved ? normalizedLocus : locus, draft.category, draft.defect, draft.requiredChange, known ? null : normalizedTag]);
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(draft);
  }
  if (status === 'CLEAN' && findings.length) return fail('uncovered-scope', 'CLEAN requires an empty findings array');
  if (status === 'FINDINGS' && !findings.length) return fail('uncovered-scope', 'FINDINGS requires at least one finding');
  return { ok: true, status, findings, ...(Object.hasOwn(record,'confirmations') ? {confirmations} : {}) };
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

/** Code loci: same path (case-folded when `caseInsensitive`) within ±MATCH_LINE_WINDOW lines; section loci: same heading; unresolved loci: never. */
function sameLocation(a: string, b: string, caseInsensitive: boolean): boolean {
  if (isUnresolvedLocus(a) || isUnresolvedLocus(b)) return false;
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
