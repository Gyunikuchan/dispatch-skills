import crypto from "node:crypto";
import path from "node:path";

import { isRecord } from "../lib/config.ts";
import type { JsonObject } from "../lib/config.ts";
import { IMPACTS, TRIGGERS } from "./domain/severity.ts";
import { stableValue } from "./domain/stable-value.ts";
import { ToolError, clipBytes } from "./output.ts";

export const KINDS = [
  "bind",
  "approval",
  "level",
  "waiver",
  "manual-complete",
  "escalation",
  "ruling",
  "note",
  "edit",
  "evidence",
  "writer",
  "integrate",
  "focus",
  "confirm",
] as const;

export interface LedgerRecord {
  seq: number;
  key: string;
  at: string;
  kind: string;
  by: string;
  quote?: string;
  batchEndSeq?: number;
  data: JsonObject;
}

export type RecordInput = Omit<LedgerRecord, "seq" | "at" | "key"> & {
  key?: string;
};

export interface ReviewFix {
  review: string;
  round: number;
  generation: number;
  findings: string[];
  from: string;
}

type Rule = (value: unknown, field: string) => void;

interface FieldRules {
  [field: string]: Rule;
}

interface PhaseRules {
  [phase: string]: FieldRules;
}

interface OptionalFields {
  readonly [kind: string]: readonly string[] | undefined;
}

function invalid(field: string, expected: string): never {
  throw new ToolError(
    1,
    "invalid-record",
    `${field} is invalid; expected ${expected}`
  );
}

const SHAPES = new WeakMap<Rule, string>();

const shaped = (shape: string, rule: Rule): Rule => {
  SHAPES.set(rule, shape);

  return rule;
};

const shapeOf = (rule: Rule) => SHAPES.get(rule) ?? "a valid value";

const check = (shape: string, ok: (value: unknown) => boolean): Rule =>
  shaped(shape, (value, field) => {
    if (!ok(value)) {
      invalid(field, shape);
    }
  });

const text = check(
  "a non-blank string",
  (value) => typeof value === "string" && !!value.trim()
);

const hash = check(
  "sha256:<64 lowercase hex>",
  (value) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value)
);

const git = check(
  "a full 40- or 64-hex Git object id",
  (value) =>
    typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)
);

const integer = check("an integer", (value) => Number.isSafeInteger(value));
const bool = check("a boolean", (value) => typeof value === "boolean");
const string = check("a string", (value) => typeof value === "string");

const seq = check(
  "a non-negative integer",
  (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
);

const isPositiveInteger = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const launch = check("a positive ledger seq", isPositiveInteger);
const positive = check("a positive integer", isPositiveInteger);

const choice = (...values: string[]): Rule =>
  check(
    `one of ${values.join(", ")}`,
    (value) => typeof value === "string" && values.includes(value)
  );

const array: Rule = shaped("an array of non-blank strings", (value, field) => {
  if (!Array.isArray(value)) {
    invalid(field, shapeOf(array));
  }

  // SAFETY: the Array.isArray guard above narrows value to an array; unknown[] adds no element claim.
  for (const [index, item] of (value as unknown[]).entries()) {
    text(item, `${field}.${index}`);
  }
});

const reviewFindings: Rule = shaped(
  "a non-empty array of unique finding IDs",
  (value, field) => {
    if (!Array.isArray(value) || value.length === 0) {
      invalid(field, shapeOf(reviewFindings));
    }

    // SAFETY: the Array.isArray guard above narrows value to an array; unknown[] adds no element claim.
    for (const [index, item] of (value as unknown[]).entries()) {
      text(item, `${field}.${index}`);
    }

    if (new Set<unknown>(value).size !== value.length) {
      invalid(field, shapeOf(reviewFindings));
    }
  }
);

const correctionPaths = check(
  "a non-empty array of unique, normalized repository-relative file paths with forward slashes",
  (value) =>
    Array.isArray(value) &&
    value.length > 0 &&
    new Set(value).size === value.length &&
    // SAFETY: the Array.isArray guard in this conjunction narrows value to an array; unknown[] adds no element claim.
    [...(value as unknown[])].every(
      (item) =>
        typeof item === "string" &&
        !!item.trim() &&
        !/^[a-z]:/iu.test(item) &&
        !/[\\\0]/u.test(item) &&
        !item
          .split("/")
          .some((segment) => !segment || segment === "." || segment === "..") &&
        path.posix.normalize(item) === item
    )
);

const treeMap: Rule = shaped(
  "an object mapping criterion IDs to 40- or 64-hex Git object ids",
  (value, field) => {
    if (!isRecord(value)) {
      invalid(field, shapeOf(treeMap));
    }

    for (const [criterion, id] of Object.entries(value)) {
      text(criterion, `${field}.${criterion}`);
      git(id, `${field}.${criterion}`);
    }
  }
);

const describe = (
  fields: Record<string, Rule>,
  optional: readonly string[] = []
) =>
  `an object with ${Object.keys(fields)
    .map((key) => (optional.includes(key) ? `${key}?` : key))
    .join(", ")}`;

const object = (
  value: unknown,
  fields: Record<string, Rule>,
  optional: readonly string[] = [],
  prefix = "data"
) => {
  if (!isRecord(value)) {
    invalid(prefix, describe(fields, optional));
  }

  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) {
      invalid(
        `${prefix}.${key}`,
        `no such field; allowed: ${Object.keys(fields).join(", ")}`
      );
    }
  }

  for (const [key, rule] of Object.entries(fields)) {
    if (Object.hasOwn(value, key)) {
      rule(value[key], `${prefix}.${key}`);
    } else if (!optional.includes(key)) {
      invalid(`${prefix}.${key}`, `required ${shapeOf(rule)}`);
    }
  }
};

const nested = (
  fields: Record<string, Rule>,
  optional: readonly string[] = []
): Rule =>
  shaped(describe(fields, optional), (value, field) => {
    object(value, fields, optional, field);
  });

const dest = nested({ branch: text, path: text });
const artifacts = nested({ spec: hash, plan: hash, design: hash }, ["design"]);

const reviewFix = nested({
  review: text,
  round: positive,
  generation: positive,
  findings: reviewFindings,
  from: git,
});

const focusEvidence = check(
  "an HTTPS URL or relative file path without whitespace or a root prefix",
  (value) => {
    if (typeof value !== "string" || !value || /\s/u.test(value)) {
      return false;
    }

    if (/^https:\/\//iu.test(value)) {
      try {
        return new URL(value).protocol === "https:";
      } catch {
        return false;
      }
    }

    if (
      /^[a-z][a-z\d+.-]*:/iu.test(value) ||
      /^[\\/]/u.test(value) ||
      value.includes("\\")
    ) {
      return false;
    }

    return value.includes("/") || /\.[^/.]+$/u.test(value);
  }
);

const focusBullet = nested({ text, evidence: focusEvidence });

const focusBullets: Rule = shaped(
  "an array of zero to five review focus bullets",
  (value, field) => {
    if (!Array.isArray(value) || value.length > 5) {
      invalid(field, shapeOf(focusBullets));
    }

    // SAFETY: the Array.isArray guard above narrows value to an array; unknown[] adds no element claim.
    for (const [index, bullet] of (value as unknown[]).entries()) {
      focusBullet(bullet, `${field}.${index}`);
    }
  }
);

type BasicKind = Exclude<(typeof KINDS)[number], "writer" | "integrate">;

const shapes = {
  bind: { spec: text, plan: text, design: text },
  approval: { spec: hash, plan: hash, design: hash },
  confirm: { spec: hash },
  level: { level: choice("low", "medium", "high", "xhigh", "max") },
  waiver: { criterion: text, reason: text },
  "manual-complete": { criterion: text, evidence: text },
  escalation: { id: text, state: choice("open", "resolved"), summary: text },
  ruling: {
    subject: text,
    ruling: text,
    rationale: text,
    impact: choice(...IMPACTS),
    trigger: choice(...TRIGGERS),
    paths: correctionPaths,
  },
  note: { text },
  edit: {
    artifact: choice("spec", "plan", "design"),
    before: hash,
    after: hash,
    class: choice("non-intent", "intent", "dependency", "discard"),
    affects: array,
    rationale: text,
    diffRef: text,
  },
  evidence: {
    criterion: text,
    commandDigest: hash,
    tree: git,
    clean: bool,
    before: git,
    after: git,
    exit: integer,
    path: text,
    artifacts,
  },
  focus: { bullets: focusBullets, visual: text },
} satisfies Record<BasicKind, Record<string, Rule>>;

const isBasicKind = (kind: string): kind is BasicKind =>
  Object.hasOwn(shapes, kind);

const writers: PhaseRules = {
  launched: {
    task: text,
    path: text,
    base: nested({ commit: git, taskSection: hash, seq }),
  },
  finished: { task: text, launch, candidate: git },
  abandoned: { task: text, launch, reason: text },
};

const integrations: PhaseRules = {
  opened: { path: text, branch: text, base: git, dest },
  verification: {
    cycle: positive,
    outcome: choice("proved", "partial", "no-op"),
    head: git,
    reason: text,
    open: array,
    report: focusEvidence,
    artifacts: shaped("an array of evidence paths", (value, field) => {
      if (!Array.isArray(value)) {
        invalid(field, "an array of evidence paths");
      }

      for (const [index, item] of value.entries()) {
        focusEvidence(item, `${field}.${index}`);
      }
    }),
    dirty: bool,
  },
  "test-cleanup": {
    from: git,
    fromTree: git,
    to: git,
    removed: array,
    deleted: seq,
    merged: seq,
    trees: treeMap,
  },
  started: { task: text, candidate: git },
  conflict: { task: text, paths: array },
  done: { task: text, commit: git },
  abandoned: { task: text, candidate: git, reason: text },
  fix: { commit: git, reason: text, reviewFix },
  "deliver-started": {
    mode: choice("uncommitted"),
    dest,
    from: git,
    source: git,
  },
  delivered: {
    mode: choice("uncommitted"),
    dest,
    from: git,
    source: git,
    noop: bool,
  },
  committed: { commit: git, source: git, differing: array },
  closed: { reason: text },
};

const COVERAGE_SLOT = String.raw`[A-Za-z0-9_-]+\[\d+\]`;

/** The only summaries a `coverage:` escalation may carry: `accept: <slot>[, <slot>]*` or `grant: <reason>`. */
export const coverageDecision = (
  summary: unknown
): { accept: string[] } | { grant: string } | null => {
  const summaryText = String(summary);

  const accept = new RegExp(
    `^accept: (${COVERAGE_SLOT}(?:, ${COVERAGE_SLOT})*)$`,
    "u"
  )
    .exec(summaryText)?.[1]
    ?.split(", ");

  if (accept) {
    return new Set(accept).size === accept.length ? { accept } : null;
  }

  return /^grant: \S/u.test(summaryText)
    ? { grant: summaryText.slice(7) }
    : null;
};

const FLAT_OPTIONAL: OptionalFields = {
  bind: ["plan", "design"],
  approval: ["design"],
  evidence: ["artifacts"],
  focus: ["visual"],
  ruling: ["impact", "trigger", "paths"],
};

const PHASE_OPTIONAL: Readonly<
  Record<"writer" | "integrate", Readonly<Record<string, readonly string[]>>>
> = {
  writer: {},
  integrate: {
    verification: ["report", "artifacts", "dirty"],
    delivered: ["noop"],
    committed: ["differing"],
    fix: ["reviewFix"],
  },
};

const phaseOptional = (kind: string, phase: unknown): readonly string[] =>
  (kind === "writer" || kind === "integrate") && typeof phase === "string"
    ? (PHASE_OPTIONAL[kind][phase] ?? [])
    : [];

export interface FlatRecordSchema {
  kind: string;
  phased: false;
  required: readonly string[];
  optional: readonly string[];
}

export interface PhaseRecordSchema {
  phase: string;
  required: readonly string[];
  optional: readonly string[];
}

export interface PhasedRecordSchema {
  kind: "writer" | "integrate";
  phased: true;
  phases: readonly PhaseRecordSchema[];
}

export type RecordSchema = FlatRecordSchema | PhasedRecordSchema;

const splitFields = (
  fields: Record<string, Rule>,
  optional: readonly string[]
) => {
  const keys = Object.keys(fields);

  return {
    required: keys.filter((key) => !optional.includes(key)),
    optional: keys.filter((key) => optional.includes(key)),
  };
};

/** Returns required and optional data fields for every ledger record kind and phase. */
export const recordSchemas = (): readonly RecordSchema[] =>
  KINDS.map((kind): RecordSchema => {
    if (kind === "writer" || kind === "integrate") {
      const phasesMap = kind === "writer" ? writers : integrations;

      return {
        kind,
        phased: true,
        phases: Object.entries(phasesMap).map(([phase, fields]) => ({
          phase,
          ...splitFields(fields, phaseOptional(kind, phase)),
        })),
      };
    }

    return {
      kind,
      phased: false,
      ...splitFields(shapes[kind], FLAT_OPTIONAL[kind] ?? []),
    };
  });

const assertEnvelope: (
  input: unknown,
  stored: boolean
) => asserts input is LedgerRecord = (input, stored) => {
  const envelope: FieldRules = {
    kind: choice(...KINDS),
    by: choice("user", "orchestrator", "tool"),
    quote: string,
    key: text,
    data: shaped("an object", () => {
      void 0;
    }),
  };

  if (stored) {
    envelope["seq"] = launch;
    envelope["at"] = text;
    envelope["batchEndSeq"] = launch;
  }

  object(
    input,
    envelope,
    stored ? ["quote", "batchEndSeq"] : ["quote", "key"],
    "record"
  );
};

export function validateRecord(input: unknown, stored: true): LedgerRecord;
export function validateRecord(
  input: unknown,
  stored?: boolean
): RecordInput | LedgerRecord;
// oxlint-disable-next-line eslint/complexity -- validation branches per record kind, phase table, and stored/unstored side.
export function validateRecord(
  input: unknown,
  stored = false
): RecordInput | LedgerRecord {
  assertEnvelope(input, stored);
  const value = input;

  if (
    stored &&
    value.batchEndSeq !== undefined &&
    value.batchEndSeq < value.seq
  ) {
    invalid("batchEndSeq", "a ledger seq at or after record.seq");
  }

  let fields: Record<string, Rule> | undefined = isBasicKind(value.kind)
    ? shapes[value.kind]
    : undefined;

  let optional = FLAT_OPTIONAL[value.kind] ?? [];

  if (value.kind === "writer" || value.kind === "integrate") {
    const phases = value.kind === "writer" ? writers : integrations;
    const phaseList = Object.keys(phases).join(", ");

    const phaseSummary = Object.entries(phases)
      .map(([phase, pf]) => {
        const opt = phaseOptional(value.kind, phase);

        return `${phase}(${Object.keys(pf)
          .map((k) => (opt.includes(k) ? `${k}?` : k))
          .join(",")})`;
      })
      .join(", ");

    const phaseShape = `an object with phase: ${phaseSummary}`;

    if (!isRecord(value.data)) {
      invalid("data", `an object; allowed for ${value.kind}: ${phaseShape}`);
    }

    const phase: unknown = value.data["phase"];

    if (typeof phase !== "string" || !Object.hasOwn(phases, phase)) {
      invalid(
        "data.phase",
        `one of ${phaseList}; allowed for ${value.kind}: ${phaseShape}`
      );
    }

    fields = { phase: choice(...Object.keys(phases)), ...phases[phase] };
    optional = phaseOptional(value.kind, phase);
  }

  if (!fields) {
    invalid("record.kind", "a supported ledger kind");
  }

  const shape = describe(fields, optional);

  try {
    object(value.data, fields, optional);

    if (
      value.kind === "bind" &&
      !Object.hasOwn(value.data, "plan") &&
      !Object.hasOwn(value.data, "design")
    ) {
      invalid("data", "a spec and at least one plan or design");
    }

    if (value.kind === "integrate" && value.data["phase"] === "verification") {
      const { data } = value;
      const open: unknown = data["open"];
      // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
      const issueId = new RegExp(`^${String(data["cycle"])}:V[0-9]+$`, "u");

      if (
        !Array.isArray(open) ||
        open.some(
          (item: unknown) => typeof item !== "string" || !issueId.test(item)
        )
      ) {
        invalid("data.open", "issue IDs for the verification cycle");
      }

      if (data["outcome"] !== "partial" && open.length) {
        invalid("data.open", "empty for proved or no-op");
      }

      if (
        data["outcome"] !== "no-op" &&
        (data["report"] === undefined ||
          data["report"] === null ||
          data["report"] === false ||
          data["report"] === "" ||
          data["report"] === 0)
      ) {
        invalid("data.report", "required for proved or partial");
      }
    }

    if (value.kind === "integrate" && value.data["phase"] === "test-cleanup") {
      const removed: unknown = value.data["removed"];
      const trees: unknown = value.data["trees"];

      if (
        !Array.isArray(removed) ||
        !isRecord(trees) ||
        new Set<unknown>(removed).size !== removed.length ||
        Object.keys(trees).length !== removed.length ||
        removed.some(
          (id: unknown) => typeof id !== "string" || !Object.hasOwn(trees, id)
        )
      ) {
        invalid("data.trees", "one entry per removed criterion ID");
      }
    }

    if (value.kind === "ruling") {
      const subject: unknown = value.data["subject"];

      const review =
        typeof subject === "string" && subject.startsWith("review:");

      const acceptedReview = review && value.data["ruling"] === "accepted";

      if (
        review ||
        (typeof subject === "string" && subject.startsWith("verification:"))
      ) {
        choice(
          "accepted",
          "rejected",
          "duplicate",
          "deferred"
        )(value.data["ruling"], "data.ruling");
      }

      if ("impact" in value.data || "trigger" in value.data) {
        for (const dimension of ["impact", "trigger"]) {
          if (!(dimension in value.data)) {
            invalid(
              `data.${dimension}`,
              "required with the other corrected dimension"
            );
          }
        }

        if (!acceptedReview) {
          invalid(
            "data.impact",
            "absent unless an accepted ruling names a review finding"
          );
        }
      }

      if ("paths" in value.data && !acceptedReview) {
        invalid(
          "data.paths",
          "absent unless an accepted ruling names a review finding"
        );
      }
    }

    if (value.kind === "focus") {
      choice("user", "orchestrator")(value.by, "record.by");
    }

    const level: unknown =
      value.kind === "level" ? value.data["level"] : undefined;

    const userOnly =
      ["approval", "confirm", "waiver", "manual-complete"].includes(
        value.kind
      ) ||
      level === "xhigh" ||
      level === "max";

    if (
      userOnly &&
      (value.by !== "user" ||
        value.quote?.trim() === undefined ||
        value.quote.trim() === "")
    ) {
      throw new ToolError(
        1,
        "user-only",
        "record requires by user and non-blank quote"
      );
    }

    if (
      value.kind === "escalation" &&
      value.data["state"] === "resolved" &&
      typeof value.data["id"] === "string" &&
      value.data["id"].startsWith("ceiling:")
    ) {
      const { id } = value.data;

      if (
        value.by !== "user" ||
        value.quote?.trim() === undefined ||
        value.quote.trim() === ""
      ) {
        throw new ToolError(
          1,
          "user-only",
          "ceiling resolution requires by user and non-blank quote"
        );
      }

      const option =
        /^(?<cap1>re-author|model-effort|relax-split|close|defer):/u.exec(
          // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
          String(value.data["summary"])
        );

      if (!option) {
        invalid(
          "data.summary",
          "one of re-author:, model-effort:, relax-split:, close:, defer:"
        );
      }

      if (option[1] === "close" || option[1] === "defer") {
        const review = id.slice("ceiling:".length, id.lastIndexOf(":"));

        if (!/^(?<cap1>plan|design)-/u.test(review)) {
          invalid(
            "data.id",
            "a plan or design review id for a close or defer resolution"
          );
        }
      }
    }

    if (
      value.kind === "escalation" &&
      typeof value.data["id"] === "string" &&
      value.data["id"].startsWith("coverage:")
    ) {
      if (
        value.by !== "user" ||
        value.quote?.trim() === undefined ||
        value.quote.trim() === ""
      ) {
        throw new ToolError(
          1,
          "user-only",
          "coverage decision requires by user and non-blank quote"
        );
      }

      if (!/^coverage:[^:\s]+:[^:\s]+$/u.test(value.data["id"])) {
        invalid("data.id", "coverage:<review>:<key>");
      }

      if (value.data["state"] !== "resolved") {
        invalid("data.state", "resolved");
      }

      if (!coverageDecision(value.data["summary"])) {
        invalid(
          "data.summary",
          "accept: <slot>[, <slot>]* with unique name[index] slots, or grant: <reason>"
        );
      }
    }
  } catch (error) {
    if (
      error instanceof ToolError &&
      error.reason === "invalid-record" &&
      error.message.startsWith("data") &&
      error.message !== `data is invalid; expected ${shape}`
    ) {
      const suffix = `; allowed for ${value.kind}: ${shape}`;
      const maxHead = 1024 - Buffer.byteLength(suffix, "utf-8");
      const head = maxHead > 0 ? clipBytes(error.message, maxHead) : "";
      throw new ToolError(1, "invalid-record", head + suffix);
    }

    throw error;
  }

  if (
    value.kind === "note" &&
    typeof value.key === "string" &&
    value.key.startsWith("repository-rerun:")
  ) {
    if (
      value.by !== "user" ||
      value.quote?.trim() === undefined ||
      value.quote.trim() === ""
    ) {
      throw new ToolError(
        1,
        "user-only",
        "repository rerun requires by user and non-blank quote"
      );
    }

    if (!/^repository-rerun:[^:\s]+:\d+:\d+$/u.test(value.key)) {
      invalid("record.key", "repository-rerun:<review>:<round>:<reportSeq>");
    }
  }

  if (
    value.kind === "note" &&
    typeof value.key === "string" &&
    value.key.startsWith("repository-changes:") &&
    !/^repository-changes:[^:\s]+:\d+:\d+$/u.test(value.key)
  ) {
    invalid("record.key", "repository-changes:<review>:<round>:<reportSeq>");
  }

  if (
    !stored &&
    [
      "approval",
      "confirm",
      "level",
      "bind",
      "escalation",
      "edit",
      "ruling",
      "note",
      "focus",
    ].includes(value.kind) &&
    value.key === undefined
  ) {
    throw new ToolError(1, "missing-key", "record.key is required");
  }

  return value;
}

const assertReviewFix: (input: unknown) => asserts input is ReviewFix = (
  input
) => {
  reviewFix(input, "reviewFix");
};

export const validateReviewFix = (input: unknown): ReviewFix => {
  assertReviewFix(input);

  return input;
};

export const defaultKey = (record: RecordInput): string =>
  `sha256:${crypto
    .createHash("sha256")
    .update(stableValue({ kind: record.kind, data: record.data }))
    .digest("hex")}`;
