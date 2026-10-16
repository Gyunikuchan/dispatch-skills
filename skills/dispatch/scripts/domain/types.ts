// Concrete payload shapes produced by domain/ and policy/. `type` aliases (not interfaces) so they stay
// assignable to the core/types.ts `Payload` placeholders; core-owned unions are imported, never redeclared.

import type { FindingId, SlotId } from '../core/types.ts';

// SECTION: Findings

export type Severity = 'MUST' | 'SHOULD' | 'CONSIDER';
export type ReviewKind = 'code' | 'plan' | 'design';
export type FindingScope = 'in' | 'adjacent';

export type FindingFix = { paths: readonly string[]; dependencies: readonly FindingId[]; verification: readonly string[] };

/** Spec §7.7; `dupOf` names the first finding a duplicate repeats. */
export type Finding = {
  id: FindingId;
  severity: Severity;
  category: string;
  locus: string;
  defect: string;
  requiredChange: string;
  sources: readonly SlotId[];
  scope: FindingScope;
  fix?: FindingFix;
  dupOf?: FindingId;
  /** Sanitized reviewer tag kept when the category is `uncategorized`. */
  originalTag?: string;
};

/** A parsed finding before the round assigns its id. */
export type DraftFinding = Omit<Finding, 'id' | 'dupOf'>;

// SECTION: Lint

export type LintDefectCode =
  // Summary box and placeholders
  | 'missing-summary-box' | 'summary-label' | 'leftover-placeholder' | 'placeholder' | 'filler-note'
  // Plan structure
  | 'proposed-changes' | 'change-heading' | 'unknown-change-marker' | 'invalid-change-path' | 'duplicate-change-path'
  | 'change-path-excluded' | 'generated-command' | 'verification-plan' | 'automated-tests' | 'automated-tests-owner'
  | 'automated-command' | 'ambiguous-command' | 'automated-tests-unavailable' | 'automated-test-duplicates-verify' | 'missing-seams'
  // Plan criteria
  | 'missing-success-criteria' | 'success-criteria' | 'criterion-format' | 'criterion-id' | 'criterion-mapping'
  | 'criterion-change-path' | 'criterion-verify' | 'final-in-code-span' | 'criterion-evidence' | 'criterion-test-rationale'
  | 'criterion-red-exception' | 'criterion-red-test-path' | 'criterion-review' | 'criterion-critical-review'
  | 'transient-coverage' | 'criterion-retain-required' | 'transient-test-path' | 'retired-section' | 'missing-satisfies' | 'missing-requirement-ref' | 'plan-id-in-test-name'
  // Plan tasks
  | 'task-heading' | 'task-summary' | 'task-ownership' | 'task-criteria' | 'task-map' | 'generated-inputs' | 'overlap' | 'task-overlap'
  // Design
  | 'missing-section' | 'missing-increment-details' | 'missing-increment-field' | 'invalid-priority' | 'duplicate-id'
  | 'missing-increments' | 'invalid-id-sequence' | 'invalid-priority-order' | 'missing-prerequisite' | 'cycle'
  | 'execution-status'
  // Shared document structure
  | 'section-order' | 'unknown-requirement' | 'unsatisfied-requirement';

export type LintDefect = { code: LintDefectCode; severity: 'defect' | 'warning'; line: number | null; message: string };

// SECTION: Plan

export type EvidenceClass = 'red' | 'verify' | 'review';
export type ChangeAction = 'NEW' | 'MODIFY' | 'DELETE' | 'GENERATED';

export type PlanCommand = { command: string; final: boolean };

export type PlanCriterion = {
  satisfies?: readonly string[];
  id: string;
  title: string;
  line: number;
  changes: readonly string[];
  verify: readonly PlanCommand[];
  evidence: EvidenceClass | null;
  preExisting: boolean | null;
  redException: string | null;
  testRationale: string | null;
  review: string | null;
  enforcementInfeasibility: string | null;
  /** `transient` tests are trimmed after the final review; `coveredBy` names the durable SC# or FINAL gate that keeps the behaviour covered. */
  retain: 'durable' | 'transient';
  coveredBy: string | null;
};

export type PlanChange = { action: ChangeAction; path: string; note: string; command: string | null; line: number };

/** One Task Map row joined to an H3 task; `line` remains the H3 source line. */
export type PlanTask = {
  id: string;
  title: string;
  summary: string;
  /** Task-specific instructions for its writer; absent in older serialized plans. */
  constraints?: readonly string[];
  line: number;
  prerequisites: readonly string[];
  criteria: readonly string[];
  paths: readonly string[];
  generated: readonly { path: string; inputs: readonly string[] }[];
  /** `Overlap: <path> — <reason>` justifications for paths shared with an unordered task. */
  overlaps: readonly { path: string; reason: string }[];
};

/** A write path shared by tasks with no transitive `Requires` path between them and no `Overlap:` justification. */
export type PlanWarning = { kind: 'overlap'; tasks: readonly string[]; path: string };

export type ParsedPlan = {
  title: string | null;
  box: Readonly<Record<string, string>>;
  keyDecisions: readonly string[];
  criteria: readonly PlanCriterion[];
  /** Plan-ordered task graph; `changes` is its flattened aggregate. */
  tasks: readonly PlanTask[];
  changes: readonly PlanChange[];
  verification: { automated: readonly string[]; none: string | null; manual: readonly string[] };
  finalCommands: readonly string[];
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
};

// SECTION: Design

export type DesignIncrement = { id: string; priority: number; summary: string; prerequisites: readonly string[]; paths: readonly string[] };
export type IncrementState = 'complete' | 'active' | 'ready' | 'blocked' | 'invalidated';
export type ExecutionStatusRow = { id: string; state: IncrementState; summary: string; nextAction: string };

export type ParsedDesign = {
  approachRequirements?: readonly string[];
  title: string | null;
  box: Readonly<Record<string, string>>;
  increments: readonly DesignIncrement[];
  details: Readonly<Record<string, Readonly<Record<string, string>>>>;
  executionStatus: { rows: readonly ExecutionStatusRow[]; nextAction: string | null } | null;
  /** Source without `## Execution Status` and `## Review Findings & Resolutions`; the caller hashes it. */
  governedText: string;
};

// SECTION: Roster

export type RosterSlot = {
  slot: SlotId;
  provider: string;
  index: number;
  model?: string | readonly string[];
  effort?: string;
  sandbox?: boolean;
  native: boolean;
  reserve: boolean;
};

// SECTION: Rendered views

export type ResolutionStatus =
  | 'accepted' | 'fixed' | 'rejected' | 'pending-rejection' | 'downgraded' | 'needs-user'
  | 'closed-by-reviewer' | 'closed-by-orchestrator' | 'superseded' | 'duplicate' | 'deferred';

export type ResolutionEntry = {
  id: FindingId;
  severity: Severity;
  status: ResolutionStatus;
  sources: readonly SlotId[];
  locus: string;
  category: string;
  defect: string;
  resolution?: string;
  requiredChange?: string;
  dupOf?: FindingId;
  /** Sanitized reviewer tag kept when the category is `uncategorized`. */
  originalTag?: string;
};

export type ReviewerView = { slot: SlotId; model?: string; effort?: string };
export type FailedTargetView = { slot: SlotId; reason: string };
/** Host applicability of a round's findings to a later target revision; absent `action` means not assessed. */
export type ApplicabilityView = { afterHash: string; reason: string; action?: 'reuse' | 'targeted' | 'full'; rationale?: string; paths?: readonly string[]; launchedRound?: number };
export type ResolutionRound = {
  round: number;
  heading?: string;
  /** Target revision the round's reviewers actually reviewed. */
  revision?: string;
  applicability?: readonly ApplicabilityView[];
  reviewers: readonly ReviewerView[];
  failed: readonly FailedTargetView[];
  entries: readonly ResolutionEntry[];
};

export type ChangeView = { action: ChangeAction; path: string; note: string };
export type VerificationRow = { sc: string; outcome: string; evidence: string };
export type RevisionView = { artifact: 'plan' | 'design'; reason: string };
export type WalkthroughContext = {
  ask: string;
  decisions?: readonly string[];
  assumptions?: readonly string[];
  outOfScope?: readonly string[];
  focus?: string;
};

export type WalkthroughView = {
  title: string;
  delivered: string;
  /** `user request`, or the governing plan path. */
  parent: string;
  status: string;
  context?: WalkthroughContext;
  changes: readonly ChangeView[];
  verification: readonly VerificationRow[];
  finalGate: string;
  deviations: readonly string[];
  followUps: readonly string[];
  revisions: readonly RevisionView[];
  rounds: readonly ResolutionRound[];
};

export type ReportView = { title: string; kind: ReviewKind; target: string; summary: string; rounds: readonly ResolutionRound[] };
