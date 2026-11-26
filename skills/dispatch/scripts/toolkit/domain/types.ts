import type { FindingId, SlotId } from "../types.ts";

export type Severity = "MUST" | "SHOULD" | "CONSIDER";

export type Impact = "critical" | "blocks" | "degrades" | "minor";

export type Trigger = "realistic" | "contrived";

export type ReviewKind = "code" | "plan" | "design";

type FindingScope = "in" | "adjacent";

export type FindingOrigin = "original" | "fix-induced" | "unknown";

/** Spec §7.7; `dupOf` names the first finding a duplicate repeats. */
export interface Finding {
  id: FindingId;
  severity: Severity;
  /** Reviewer rating; absent on findings stored before the two-dimension format. */
  impact?: Impact;
  trigger?: Trigger;
  category: string;
  locus: string;
  defect: string;
  requiredChange: string;
  sources: readonly SlotId[];
  scope: FindingScope;
  dupOf?: FindingId;
  /** Sanitized reviewer tag kept when the category is `uncategorized`. */
  originalTag?: string;
  /** Whether an earlier fix caused the defect; absent on findings stored before origin existed. */
  origin?: FindingOrigin;
}

/** A parsed finding before the round assigns its id. */
export type DraftFinding = Omit<Finding, "id" | "dupOf">;

export type { LintDefect, LintDefectCode } from "./document-lint.ts";

export type EvidenceClass = "red" | "check" | "review";

export type ChangeAction = "NEW" | "MODIFY" | "DELETE" | "GENERATED";

interface PlanCommand {
  command: string;
}

export interface PlanCriterion {
  satisfies?: readonly string[];
  id: string;
  title: string;
  line: number;
  changes: readonly string[];
  /** Declared `Tests:` paths, a subset of `changes`; RED capture and brief rendering use these. */
  tests: readonly string[];
  verify: readonly PlanCommand[];
  evidence: EvidenceClass | null;
  preExisting: boolean | null;
  redException: string | null;
  /** Focused failing-test command from `RED:`; `{files}` expands to declared `Tests:` paths. A missing command downgrades red evidence to check. */
  red: string | null;
  review: string | null;
  enforcementInfeasibility: string | null;
}

export interface PlanChange {
  action: ChangeAction;
  path: string;
  note: string;
  command: string | null;
  line: number;
}

/** One Task Map row joined to an H3 task; `line` remains the H3 source line. */
export interface PlanTask {
  id: string;
  title: string;
  summary: string;
  behaviour: readonly string[];
  /** Task-specific instructions for its writer; absent in older serialized plans. */
  constraints?: readonly string[];
  line: number;
  prerequisites: readonly string[];
  criteria: readonly string[];
  paths: readonly string[];
  generated: readonly { path: string; inputs: readonly string[] }[];
  /** `Overlap: <path> — <reason>` justifications for paths shared with an unordered task. */
  overlaps: readonly { path: string; reason: string }[];
}

/** A write path shared by tasks with no transitive `Requires` path between them and no `Overlap:` justification. */
export interface PlanWarning {
  kind: "overlap";
  tasks: readonly string[];
  path: string;
}

export interface Glance {
  what: string;
  how: string;
  visuals: string;
}

export interface ParsedPlan {
  title: string | null;
  box: Readonly<Record<string, string>>;
  glance: Glance | null;
  keyDecisions: readonly string[];
  criteria: readonly PlanCriterion[];
  /** Plan-ordered task graph; `changes` is its flattened aggregate. */
  tasks: readonly PlanTask[];
  changes: readonly PlanChange[];
  verification: {
    automated: readonly string[];
    none: string | null;
    manual: readonly string[];
  };
  /** Plan-level test entry points that criteria verify through. */
  seams: readonly string[];
  warnings: readonly PlanWarning[];
  traceability: Readonly<Record<string, string>> | null;
  /** Source with only `## Review Findings & Resolutions` excluded; the caller hashes it. */
  governedText: string;
  /** Criterion IDs plus review finding IDs recorded in the plan, sorted and unique. */
  planIds: readonly string[];
  /** Source from the start through the `## Task Map` section: the context every task writer shares. */
  sharedContext: string;
}

export interface DesignIncrement {
  id: string;
  priority: number;
  summary: string;
  behaviour: readonly string[];
  prerequisites: readonly string[];
  paths: readonly string[];
}

export type IncrementState =
  | "complete"
  | "active"
  | "ready"
  | "blocked"
  | "invalidated";

export interface ExecutionStatusRow {
  id: string;
  state: IncrementState;
  nextAction: string;
}

export interface ParsedDesign {
  approachRequirements?: readonly string[];
  title: string | null;
  box: Readonly<Record<string, string>>;
  increments: readonly DesignIncrement[];
  details: Readonly<Record<string, Readonly<Record<string, string>>>>;
  executionStatus: {
    rows: readonly ExecutionStatusRow[];
    nextAction: string | null;
  } | null;
  /** Source without `## Execution Status` and `## Review Findings & Resolutions`; the caller hashes it. */
  governedText: string;
}

export interface RosterSlot {
  slot: SlotId;
  provider: string;
  index: number;
  model?: string | readonly string[];
  effort?: string;
  sandbox?: boolean;
  native: boolean;
  reserve: boolean;
}
