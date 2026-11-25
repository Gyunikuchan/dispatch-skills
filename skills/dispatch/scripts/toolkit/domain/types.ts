// Concrete payload shapes produced by toolkit domain modules and policy.

import type { FindingId, SlotId } from '../types.ts';

// SECTION: Findings

export type Severity = 'MUST' | 'SHOULD' | 'CONSIDER';
export type Impact = 'critical' | 'blocks' | 'degrades' | 'minor';
export type Trigger = 'realistic' | 'contrived';
export type ReviewKind = 'code' | 'plan' | 'design';
type FindingScope = 'in' | 'adjacent';
export type FindingOrigin = 'original' | 'fix-induced' | 'unknown';

/** Spec §7.7; `dupOf` names the first finding a duplicate repeats. */
export type Finding = {
  id: FindingId;
  severity: Severity;
  /** Reviewer rating; absent on findings stored before the two-dimension format. */
  impact?: Impact;
  trigger?: Trigger;
  category: string;
  locus: string;
  defect: string;
  requiredChange: string;
  sources: ReadonlyArray<SlotId>;
  scope: FindingScope;
  dupOf?: FindingId;
  /** Sanitized reviewer tag kept when the category is `uncategorized`. */
  originalTag?: string;
  /** Whether an earlier fix caused the defect; absent on findings stored before origin existed. */
  origin?: FindingOrigin;
};

/** A parsed finding before the round assigns its id. */
export type DraftFinding = Omit<Finding, 'id' | 'dupOf'>;

// SECTION: Lint

export type { LintDefect, LintDefectCode } from './document-lint.ts';

// SECTION: Plan

export type EvidenceClass = 'red' | 'check' | 'review';
export type ChangeAction = 'NEW' | 'MODIFY' | 'DELETE' | 'GENERATED';

type PlanCommand = { command: string };

export type PlanCriterion = {
  satisfies?: ReadonlyArray<string>;
  id: string;
  title: string;
  line: number;
  changes: ReadonlyArray<string>;
  /** Declared `Tests:` paths, a subset of `changes`; RED capture and brief rendering use these. */
  tests: ReadonlyArray<string>;
  verify: ReadonlyArray<PlanCommand>;
  evidence: EvidenceClass | null;
  preExisting: boolean | null;
  redException: string | null;
  /** Focused failing-test command from `RED:`; `{files}` expands to declared `Tests:` paths. A missing command downgrades red evidence to check. */
  red: string | null;
  review: string | null;
  enforcementInfeasibility: string | null;
};

export type PlanChange = { action: ChangeAction; path: string; note: string; command: string | null; line: number };

/** One Task Map row joined to an H3 task; `line` remains the H3 source line. */
export type PlanTask = {
  id: string;
  title: string;
  summary: string;
  behaviour: ReadonlyArray<string>;
  /** Task-specific instructions for its writer; absent in older serialized plans. */
  constraints?: ReadonlyArray<string>;
  line: number;
  prerequisites: ReadonlyArray<string>;
  criteria: ReadonlyArray<string>;
  paths: ReadonlyArray<string>;
  generated: ReadonlyArray<{ path: string; inputs: ReadonlyArray<string> }>;
  /** `Overlap: <path> — <reason>` justifications for paths shared with an unordered task. */
  overlaps: ReadonlyArray<{ path: string; reason: string }>;
};

/** A write path shared by tasks with no transitive `Requires` path between them and no `Overlap:` justification. */
export type PlanWarning = { kind: 'overlap'; tasks: ReadonlyArray<string>; path: string };

export type Glance = { what: string; how: string; visuals: string };

export type ParsedPlan = {
  title: string | null;
  box: Readonly<Record<string, string>>;
  glance: Glance | null;
  keyDecisions: ReadonlyArray<string>;
  criteria: ReadonlyArray<PlanCriterion>;
  /** Plan-ordered task graph; `changes` is its flattened aggregate. */
  tasks: ReadonlyArray<PlanTask>;
  changes: ReadonlyArray<PlanChange>;
  verification: { automated: ReadonlyArray<string>; none: string | null; manual: ReadonlyArray<string> };
  /** Plan-level test entry points that criteria verify through. */
  seams: ReadonlyArray<string>;
  warnings: ReadonlyArray<PlanWarning>;
  traceability: Readonly<Record<string, string>> | null;
  /** Source with only `## Review Findings & Resolutions` excluded; the caller hashes it. */
  governedText: string;
  /** Criterion IDs plus review finding IDs recorded in the plan, sorted and unique. */
  planIds: ReadonlyArray<string>;
  /** Source from the start through the `## Task Map` section: the context every task writer shares. */
  sharedContext: string;
};

// SECTION: Design

export type DesignIncrement = {
  id: string;
  priority: number;
  summary: string;
  behaviour: ReadonlyArray<string>;
  prerequisites: ReadonlyArray<string>;
  paths: ReadonlyArray<string>;
};
export type IncrementState = 'complete' | 'active' | 'ready' | 'blocked' | 'invalidated';
export type ExecutionStatusRow = { id: string; state: IncrementState; nextAction: string };

export type ParsedDesign = {
  approachRequirements?: ReadonlyArray<string>;
  title: string | null;
  box: Readonly<Record<string, string>>;
  increments: ReadonlyArray<DesignIncrement>;
  details: Readonly<Record<string, Readonly<Record<string, string>>>>;
  executionStatus: { rows: ReadonlyArray<ExecutionStatusRow>; nextAction: string | null } | null;
  /** Source without `## Execution Status` and `## Review Findings & Resolutions`; the caller hashes it. */
  governedText: string;
};

// SECTION: Roster

export type RosterSlot = {
  slot: SlotId;
  provider: string;
  index: number;
  model?: string | ReadonlyArray<string>;
  effort?: string;
  sandbox?: boolean;
  native: boolean;
  reserve: boolean;
};
