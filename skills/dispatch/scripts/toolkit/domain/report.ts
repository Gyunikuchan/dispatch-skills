import { isRecord } from "../../lib/config.ts";
import type { JsonObject, JsonValue } from "../../lib/integrity.ts";
import type { SlotId } from "../types.ts";
import { sanitizeText } from "./sanitize.ts";
import { IMPACTS, TRIGGERS, severityOf } from "./severity.ts";
import type {
  DraftFinding,
  Finding,
  FindingOrigin,
  ReviewKind,
} from "./types.ts";

const SECTION_LOCUS = /^§\s+\S.*$/u;

const CODE_LOCUS =
  /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))[^:\\\r\n]+:L[1-9]\d*$/u;

const BASE_REVIEW_TAGS = [
  "intent",
  "spec",
  "correctness",
  "reliability",
  "security",
  "performance",
  "compatibility",
  "maintainability",
  "operability",
  "testing",
  "usability",
  "standards",
  "adjacent",
] as const;

const PLAN_DESIGN_TAGS: ReadonlySet<string> = new Set([
  ...BASE_REVIEW_TAGS,
  "architecture",
  "decomposition",
]);

export const REVIEW_TAGS_BY_KIND: Readonly<
  Record<ReviewKind, ReadonlySet<string>>
> = {
  code: new Set(BASE_REVIEW_TAGS),
  plan: PLAN_DESIGN_TAGS,
  design: PLAN_DESIGN_TAGS,
};

const LOCUS: Readonly<Record<ReviewKind, RegExp>> = {
  code: CODE_LOCUS,
  plan: SECTION_LOCUS,
  design: SECTION_LOCUS,
};

const FINDING_FIELDS = [
  "defect",
  "impact",
  "locus",
  "requiredChange",
  "tag",
  "trigger",
];

const OPTIONAL_FIELDS = new Set(["origin"]);

const ORIGINS: readonly FindingOrigin[] = [
  "original",
  "fix-induced",
  "unknown",
];

const originRank = (origin: FindingOrigin | undefined) => {
  if (origin === "fix-induced") {
    return 2;
  }

  if (origin === "original") {
    return 1;
  }

  return 0;
};

const mergeOrigin = (
  a: FindingOrigin | undefined,
  b: FindingOrigin | undefined
) => (originRank(b) > originRank(a) ? b : a);

const categoryOf = (tag: string, known: boolean) => {
  if (!known) {
    return "uncategorized";
  }

  return tag === "spec" ? "intent" : tag;
};

const originOf = (round: number, candidate: FindingOrigin | undefined) => {
  if (round === 1) {
    return "original";
  }

  if (candidate === "original" || candidate === "fix-induced") {
    return candidate;
  }

  return "unknown";
};

const REFUSAL =
  /\b(?:I(?:'m| am) (?:unable|not able) to (?:help|assist|comply|review)|I (?:can(?:no|')t|won't|will not) (?:help|assist|comply|do that|review)|I must decline|against my (?:guidelines|policies))\b/iu;

const normalizeLocus = (kind: ReviewKind, locus: string) => {
  const trimmed = locus.trim();

  if (kind === "code") {
    return trimmed
      .replace(/^(?<cap1>[^:#]+)#L(?<cap2>[1-9]\d*)$/u, "$1:L$2")
      .replace(/^(?<cap1>[^:#]+):(?<cap2>[1-9]\d*)$/u, "$1:L$2");
  }

  return trimmed.replace(/^§(?=\S)/u, "§ ");
};

const UNRESOLVED_LOCUS = "unresolved-locus: ";
const UNRESOLVED_LOCUS_BYTES = 120;

export const isUnresolvedLocus = (locus: string) =>
  locus.startsWith(UNRESOLVED_LOCUS);

const unresolvedLocus = (reported: unknown) => {
  const text =
    (typeof reported === "string" && sanitizeText(reported)) || "(none)";

  if (Buffer.byteLength(text, "utf-8") <= UNRESOLVED_LOCUS_BYTES) {
    return `${UNRESOLVED_LOCUS}${text}`;
  }

  return `${UNRESOLVED_LOCUS}${Buffer.from(text, "utf-8")
    .subarray(0, UNRESOLVED_LOCUS_BYTES - 3)
    .toString("utf-8")
    .replace(/\uFFFD$/u, "")}…`;
};

const parses = (text: string) => {
  try {
    JSON.parse(text);

    return true;
  } catch {
    return false;
  }
};

const MAX_CANDIDATES = 1024;
const FENCE = "```";

const endOfPrior = (text: string, i: number) => {
  let index = i;

  while (index > 0 && /\s/u.test(text.charAt(index - 1))) {
    index -= 1;
  }

  return index;
};

const fencedBody = (text: string) => {
  const close = text.length - FENCE.length;

  for (
    let open = text.lastIndexOf(FENCE, close - 1);
    open >= 0;
    open = open === 0 ? -1 : text.lastIndexOf(FENCE, open - 1)
  ) {
    const body = text.slice(open + FENCE.length, close);
    let lineStart = open;

    while (
      lineStart > 0 &&
      (text[lineStart - 1] === " " || text[lineStart - 1] === "\t")
    ) {
      lineStart -= 1;
    }

    const tagged = /^json[ \t]*\r?\n/iu.test(body);

    if (tagged || lineStart === 0 || text[lineStart - 1] === "\n") {
      return (tagged ? body.slice(4) : body).trim();
    }
  }

  return null;
};

const continuesContainer = (text: string, lineStart: number) => {
  const end = endOfPrior(text, lineStart);
  const line = text.slice(text.lastIndexOf("\n", end - 1) + 1, end).trim();

  if (parses(line)) {
    return false;
  }

  if (line.endsWith(",") && parses(line.slice(0, -1))) {
    return true;
  }

  return (
    /^[{[,][{[,\s]*"[^"]*"\s*:/u.test(line) ||
    /^"[^"]*"\s*:\s*(?:$|[{["]|(?:-?\d[\d.eE+-]*|true|false|null)\s*,?$)/u.test(
      line
    ) ||
    /^(?:[{[]|[}\]]\s*,)$/u.test(line)
  );
};

const extractJsonText = (raw: string) => {
  const text = raw.trim();

  if (parses(text)) {
    return text;
  }

  if (text.endsWith(FENCE)) {
    return fencedBody(text) ?? text;
  }

  if (!text.endsWith("}")) {
    return text;
  }

  let tried = 0;

  for (
    let brace = text.lastIndexOf("{");
    brace >= 0 && tried < MAX_CANDIDATES;
    brace = brace === 0 ? -1 : text.lastIndexOf("{", brace - 1)
  ) {
    let lineStart = brace;

    while (
      lineStart > 0 &&
      (text[lineStart - 1] === " " || text[lineStart - 1] === "\t")
    ) {
      lineStart -= 1;
    }

    if (lineStart > 0 && text[lineStart - 1] !== "\n") {
      continue;
    }

    if (continuesContainer(text, lineStart)) {
      continue;
    }

    tried += 1;
    const candidate = text.slice(brace);

    if (parses(candidate)) {
      return candidate;
    }
  }

  return text;
};

type ReportFailureKind =
  | "empty-output"
  | "refusal"
  | "blocked"
  | "truncated"
  | "uncovered-scope";

interface ReportFailure {
  kind: ReportFailureKind;
  detail: string;
}

type ReportResult =
  | {
      ok: true;
      status: "CLEAN" | "FINDINGS";
      findings: DraftFinding[];
      confirmations?: Confirmation[];
    }
  | { ok: false; failure: ReportFailure };

interface Confirmation {
  requestId: string;
  decision: "agree" | "disagree";
  rationale: string;
}

interface ReportInput {
  kind: ReviewKind;
  source: SlotId;
  text: string;
  truncated?: boolean;
  expectedRequestIds?: readonly string[];
}

const nonEmpty = (value: JsonValue | undefined): value is string =>
  typeof value === "string" && value.trim().length > 0;

const fail = (kind: ReportFailureKind, detail: string): ReportResult => ({
  ok: false,
  failure: { kind, detail },
});

const parseJson = (
  text: string
): { ok: true; value: unknown } | { ok: false } => {
  try {
    // SAFETY: JSON.parse returns any; narrowing to unknown forces downstream validation via isRecord.
    return { ok: true, value: JSON.parse(extractJsonText(text)) as unknown };
  } catch {
    return { ok: false };
  }
};

type ParseResult<T> = { ok: true; value: T } | { ok: false; detail: string };

const CONFIRMATION_FAILURE =
  "confirmation needs a unique requestId, explicit decision and rationale";

const parseConfirmations = (
  raw: JsonValue | undefined,
  expectedIds: readonly string[] | undefined
): ParseResult<Confirmation[]> => {
  if (raw === undefined) {
    if (expectedIds !== undefined && expectedIds.length !== 0) {
      return {
        ok: false,
        detail:
          "each assigned confirmation request requires exactly one explicit reply",
      };
    }

    return { ok: true, value: [] };
  }

  if (!Array.isArray(raw)) {
    return { ok: false, detail: "confirmations must be an array" };
  }

  const confirmations: Confirmation[] = [];

  for (const item of raw) {
    if (
      item === null ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).toSorted().join("\0") !==
        "decision\0rationale\0requestId"
    ) {
      return {
        ok: false,
        detail:
          "confirmation fields must be exactly requestId, decision, rationale",
      };
    }

    const { requestId, decision, rationale } = item;

    if (
      !nonEmpty(requestId) ||
      (decision !== "agree" && decision !== "disagree") ||
      !nonEmpty(rationale)
    ) {
      return { ok: false, detail: CONFIRMATION_FAILURE };
    }

    const safe = sanitizeText(rationale);

    if (!safe || confirmations.some((reply) => reply.requestId === requestId)) {
      return { ok: false, detail: CONFIRMATION_FAILURE };
    }

    confirmations.push({ requestId, decision, rationale: safe });
  }

  if (
    expectedIds !== undefined &&
    (confirmations.length !== expectedIds.length ||
      confirmations.some((reply) => !expectedIds.includes(reply.requestId)))
  ) {
    return {
      ok: false,
      detail:
        "each assigned confirmation request requires exactly one explicit reply",
    };
  }

  return { ok: true, value: confirmations };
};

const findingFieldsFailure = (item: JsonObject, index: number) => {
  const missing = FINDING_FIELDS.filter((field) => !Object.hasOwn(item, field));

  const unexpected = Object.keys(item).filter(
    (field) => !FINDING_FIELDS.includes(field) && !OPTIONAL_FIELDS.has(field)
  );

  const others = unexpected.filter((field) => field !== "severity").length;

  const unsupported = [
    ...(unexpected.includes("severity") ? ["severity"] : []),
    ...(others ? [`${others} other field(s)`] : []),
  ];

  if (!missing.length && !unsupported.length) {
    return null;
  }

  return `finding ${index} fields must be exactly: impact, trigger, locus, tag, defect, requiredChange, plus optional origin${missing.length ? `; missing: ${missing.join(", ")}` : ""}${unsupported.length ? `; unsupported: ${unsupported.join(", ")}` : ""}`;
};

const sanitizedTexts = (
  defect: JsonValue | undefined,
  requiredChange: JsonValue | undefined
): ParseResult<{ defect: string; requiredChange: string }> => {
  if (!nonEmpty(defect) || !nonEmpty(requiredChange)) {
    return {
      ok: false,
      detail: "needs a defect and a requiredChange",
    };
  }

  const safeDefect = sanitizeText(defect);
  const safeChange = sanitizeText(requiredChange);

  if (!safeDefect || !safeChange) {
    return {
      ok: false,
      detail: "needs a defect and a requiredChange after sanitization",
    };
  }

  return {
    ok: true,
    value: { defect: safeDefect, requiredChange: safeChange },
  };
};

interface ParsedFinding {
  draft: DraftFinding;
  dedupKey: string;
}

const parseFinding = (
  item: JsonValue | undefined,
  index: number,
  kind: ReviewKind,
  source: SlotId,
  pattern: RegExp
): ParseResult<ParsedFinding> => {
  if (!isRecord(item)) {
    return {
      ok: false,
      detail: `finding ${index} must be a JSON object`,
    };
  }

  const fieldsFailure = findingFieldsFailure(item, index);

  if (fieldsFailure !== null) {
    return { ok: false, detail: fieldsFailure };
  }

  const impact = IMPACTS.find((candidate) => candidate === item["impact"]);

  if (impact === undefined) {
    return {
      ok: false,
      detail: `finding ${index} impact must be one of ${IMPACTS.join(", ")}`,
    };
  }

  const trigger = TRIGGERS.find((candidate) => candidate === item["trigger"]);

  if (trigger === undefined) {
    return {
      ok: false,
      detail: `finding ${index} trigger must be one of ${TRIGGERS.join(", ")}`,
    };
  }

  const { locus, tag, defect, requiredChange } = item;

  if (!nonEmpty(tag)) {
    return { ok: false, detail: `finding ${index} needs a nonempty tag` };
  }

  const normalizedTag = tag.trim();
  const known = REVIEW_TAGS_BY_KIND[kind].has(normalizedTag);

  const texts = sanitizedTexts(defect, requiredChange);

  if (!texts.ok) {
    return { ok: false, detail: `finding ${index} ${texts.detail}` };
  }

  const { defect: safeDefect, requiredChange: safeChange } = texts.value;

  const normalizedLocus = nonEmpty(locus) ? normalizeLocus(kind, locus) : "";
  const resolved = pattern.test(normalizedLocus);

  const category = categoryOf(normalizedTag, known);

  const originalTag = known
    ? undefined
    : normalizedTag.replaceAll(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 80);

  const origin = ORIGINS.find((candidate) => candidate === item["origin"]);

  const draft: DraftFinding = {
    impact,
    trigger,
    severity: severityOf(impact, trigger),
    category,
    locus: resolved ? normalizedLocus : unresolvedLocus(locus),
    defect: safeDefect,
    requiredChange: safeChange,
    sources: [source],
    scope: category === "adjacent" ? "adjacent" : "in",
    ...(!(originalTag === undefined) && { originalTag }),
    ...(origin !== undefined && { origin }),
  };

  const dedupKey = JSON.stringify([
    draft.severity,
    resolved ? normalizedLocus : locus,
    draft.category,
    draft.defect,
    draft.requiredChange,
    known ? null : normalizedTag,
  ]);

  return { ok: true, value: { draft, dedupKey } };
};

const unparsedFailure = (
  text: string,
  truncated: boolean | undefined
): ReportResult => {
  if (truncated === true) {
    return fail("truncated", "output was cut off before a complete report");
  }

  if (REFUSAL.test(text)) {
    return fail("refusal", sanitizeText(text).slice(0, 200));
  }

  return fail("uncovered-scope", "no JSON report object found");
};

const blockedDetail = (value: JsonObject) => {
  if (value["status"] !== "BLOCKED") {
    return null;
  }

  const { reason } = value;

  return typeof reason === "string" && reason.trim().length > 0
    ? reason.trim()
    : null;
};

const reportFieldsFailure = (value: JsonObject) => {
  const fields = Object.keys(value).toSorted().join("\0");

  return fields !== "findings\0status" &&
    fields !== "confirmations\0findings\0status"
    ? "report fields must be status, findings and optional confirmations"
    : null;
};

const isReportStatus = (
  value: JsonValue | undefined
): value is "CLEAN" | "FINDINGS" => value === "CLEAN" || value === "FINDINGS";

const statusAndItems = (value: JsonObject) => {
  const { status } = value;
  const items = value["findings"];

  if (!isReportStatus(status) || !Array.isArray(items)) {
    return null;
  }

  return { status, items };
};

const consistencyFailure = (
  status: "CLEAN" | "FINDINGS",
  findings: readonly unknown[]
) => {
  if (status === "CLEAN" && findings.length > 0) {
    return "CLEAN requires an empty findings array";
  }

  if (status === "FINDINGS" && findings.length === 0) {
    return "FINDINGS requires at least one finding";
  }

  return null;
};

/**
 * Parses one delegate report. Failures: empty output; truncation (runner-reported and unparseable); refusal;
 * blocked (a `BLOCKED` report with a reason); uncovered scope (no structured `{status, findings}` review of the
 * requested scope). A truncated report that still parses is accepted. A nonempty
 * tag outside the shared vocabulary is recovered, not a failure: the finding becomes `uncategorized` with a
 * sanitized `originalTag`. A locus outside the kind's grammar is also recovered: the finding keeps it marked with `UNRESOLVED_LOCUS`.
 */

export const parseReport = (input: ReportInput): ReportResult => {
  const { kind, source } = input;
  const text = input.text.trim();

  if (!text) {
    return fail("empty-output", "the delegate returned no text");
  }

  const parsed = parseJson(text);

  if (!parsed.ok) {
    return unparsedFailure(text, input.truncated);
  }

  const { value } = parsed;

  if (!isRecord(value)) {
    return fail("uncovered-scope", "report must be a JSON object");
  }

  const blocked = blockedDetail(value);

  if (blocked !== null) {
    return fail("blocked", blocked);
  }

  const fieldsFailure = reportFieldsFailure(value);

  if (fieldsFailure !== null) {
    return fail("uncovered-scope", fieldsFailure);
  }

  const parsedConfirmations = parseConfirmations(
    Object.hasOwn(value, "confirmations") ? value["confirmations"] : undefined,
    input.expectedRequestIds
  );

  if (!parsedConfirmations.ok) {
    return fail("uncovered-scope", parsedConfirmations.detail);
  }

  const confirmations = parsedConfirmations.value;

  const shape = statusAndItems(value);

  if (shape === null) {
    return fail(
      "uncovered-scope",
      "report must carry status CLEAN|FINDINGS and a findings array"
    );
  }

  const { status, items } = shape;
  const findings: DraftFinding[] = [];
  const seen = new Map<string, DraftFinding>();
  const pattern = LOCUS[kind];

  for (const [index, item] of items.entries()) {
    const parsedFinding = parseFinding(item, index, kind, source, pattern);

    if (!parsedFinding.ok) {
      return fail("uncovered-scope", parsedFinding.detail);
    }

    const { draft, dedupKey } = parsedFinding.value;
    const kept = seen.get(dedupKey);

    if (kept) {
      const merged = mergeOrigin(kept.origin, draft.origin);

      if (merged) {
        kept.origin = merged;
      }

      continue;
    }

    seen.set(dedupKey, draft);
    findings.push(draft);
  }

  const inconsistent = consistencyFailure(status, findings);

  if (inconsistent !== null) {
    return fail("uncovered-scope", inconsistent);
  }

  return {
    ok: true,
    status,
    findings,
    ...(Object.hasOwn(value, "confirmations") && { confirmations }),
  };
};

const MATCH_LINE_WINDOW = 5;
const MATCH_JACCARD = 0.3;

const STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "any",
  "can",
  "has",
  "had",
  "its",
  "was",
  "were",
  "will",
  "with",
  "this",
  "that",
  "from",
  "into",
  "when",
  "then",
  "than",
  "them",
  "they",
  "which",
  "while",
  "where",
  "there",
  "their",
  "these",
  "those",
  "should",
  "would",
  "could",
  "must",
  "does",
  "did",
  "have",
  "been",
  "being",
  "also",
  "only",
  "each",
  "other",
  "such",
  "what",
  "who",
  "how",
  "why",
  "our",
  "out",
  "use",
  "uses",
  "used",
]);

const tokens = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
  );

const similarity = (a: string, b: string) => {
  const left = tokens(a);
  const right = tokens(b);

  if (!left.size || !right.size) {
    return 0;
  }

  let shared = 0;

  for (const token of left) {
    if (right.has(token)) {
      shared += 1;
    }
  }

  return shared / (left.size + right.size - shared);
};

interface MatchKey {
  locus: string;
  category: string;
  text: string;
}

const codeLocation = (locus: string) =>
  /^(?<cap1>.+?):L(?<cap2>\d+)/u.exec(locus.trim());

const sameLocation = (a: string, b: string, caseInsensitive: boolean) => {
  if (isUnresolvedLocus(a) || isUnresolvedLocus(b)) {
    return false;
  }

  const left = codeLocation(a);
  const right = codeLocation(b);

  if (left && right) {
    const fold = (file: string) =>
      caseInsensitive
        ? file.replaceAll("\\", "/").toLowerCase()
        : file.replaceAll("\\", "/");

    return (
      fold(left[1] ?? "") === fold(right[1] ?? "") &&
      Math.abs(Number(left[2]) - Number(right[2])) <= MATCH_LINE_WINDOW
    );
  }

  if (left || right) {
    return false;
  }

  return a.trim().toLowerCase() === b.trim().toLowerCase();
};

/** Location + category with loose text similarity (spec §7.5). */
export const matchFinding = (
  a: MatchKey,
  b: MatchKey,
  caseInsensitive = false
) =>
  a.category === b.category &&
  sameLocation(a.locus, b.locus, caseInsensitive) &&
  similarity(a.text, b.text) >= MATCH_JACCARD;

const findingId = (round: number, ordinal: number) =>
  `R${round}-F${String(ordinal).padStart(3, "0")}`;

/**
 * Assigns round ids in report order and dedups across sources: a duplicate keeps its own id with `dupOf`
 * naming the first, and the first cites every source that reported it.
 */
export const collectFindings = (
  round: number,
  drafts: readonly DraftFinding[],
  firstOrdinal = 1
) => {
  const out: Finding[] = [];

  for (const [index, draft] of drafts.entries()) {
    const id = findingId(round, firstOrdinal + index);

    const key: MatchKey = {
      locus: draft.locus,
      category: draft.category,
      text: `${draft.defect} ${draft.requiredChange}`,
    };

    const origin: FindingOrigin = originOf(round, draft.origin);

    const first = out.find(
      (prior) =>
        prior.dupOf === undefined &&
        matchFinding(
          {
            locus: prior.locus,
            category: prior.category,
            text: `${prior.defect} ${prior.requiredChange}`,
          },
          key
        )
    );

    if (first) {
      first.sources = [...new Set([...first.sources, ...draft.sources])];
      first.origin = mergeOrigin(first.origin, origin) ?? "unknown";
      out.push({ ...draft, id, origin, dupOf: first.id });
    } else {
      out.push({ ...draft, id, origin });
    }
  }

  return out;
};
