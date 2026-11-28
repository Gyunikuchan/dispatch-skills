import type { JsonObject } from "../../lib/integrity.ts";
import type {
  CopilotActor,
  CopilotEvidence,
  CoverageReason,
  DelegateResponse,
  DiagnosticModelUsage,
  HostUsageFacts,
  ResponseStage,
  UsageSource,
} from "../../lib/usage/rows.ts";
import type { LifecycleStep } from "../../providers/types.ts";
import type { RecoverySelection } from "../review-state.ts";
import type { FailureClass } from "../types.ts";
import type {
  ReviewKind,
  RoundCausePrimary,
  STEP_BACK_OUTCOMES,
} from "./types.ts";

export const PHASE_NAMES = [
  "plan",
  "plan review",
  "implementation",
  "code review",
  "design",
  "design review",
  "integration review",
  "ask",
] as const;

/** The review machine's halt on a re-raised fix (regression) or a pending rejection re-raised twice (deadlock). */
interface Escalation {
  kind: "regression" | "deadlock";
  ids: readonly string[];
}

/** Review phases carry the review machine's convergence result (findings re-raised across rounds, any escalation) and the resolved round `cap`. */
export interface Phase {
  key: string;
  name: (typeof PHASE_NAMES)[number];
  outcome?: string;
  reraised?: readonly string[];
  escalation?: Escalation;
  cap?: number;
}

/** Key order is severity order. Hosts send the keys; the report renders the labels. */
export const CATEGORIES = {
  correctness: "Correctness / protocol",
  "token-economy": "Token economy",
  speed: "Speed",
  "review-convergence": "Review convergence",
  "instruction-clarity": "Instruction clarity",
  "information-access": "Information access",
} as const;

export type Category = keyof typeof CATEGORIES;

export type ModelUsage = DiagnosticModelUsage;

/** `input` is canonical uncached input; `models` holds per-model counters, with `<model>#<effort>` keys when effort varies. */
export type Usage = ModelUsage & {
  copilot?: CopilotEvidence;
  actors?: CopilotActor[];
  models?: Record<string, ModelUsage>;
  reasoningInOutput?: boolean;
};

/** Tool-call durations can overlap; they do not measure session elapsed time. */
export interface PhaseFacts {
  key: string;
  name: string;
  outcome?: string;
  wallMs?: number;
  driverMs?: number;
  hostMs?: number;
  userMs?: number;
}

/** One launch attempt (`phase` is a phase key; `outcome` is `ok` or a failure class). */
export type DiagnosticEvent = {
  subject: string;
  slot: string;
  provider?: string;
  model?: string;
  effort?: string;
  attempt: number;
  targetSlot?: string;
} & (
  | { kind: "validation"; outcome: string; surface: "cli" | "native" }
  | {
      kind: "routing";
      cls?: FailureClass;
      state: "next-model" | "next-mode" | "reserve" | "stop";
    }
  | {
      kind: "native";
      state: "pending" | "completed" | "invalid" | "failed";
      replay?: boolean;
    }
  | {
      kind: "slot";
      cls?: FailureClass;
      state: "done" | "native" | "failed";
      replay?: boolean;
    }
);

export type DelegateResponseFacts = DelegateResponse & {
  stage: ResponseStage;
  agent?: string;
};

interface InvocationResponses {
  usageSource?: UsageSource | undefined;
  coverage?: readonly CoverageReason[] | undefined;
  responses?: readonly DelegateResponseFacts[] | undefined;
}

export const isSessionDelegate = (invocation: InvocationResponses) =>
  invocation.usageSource !== "stdout" &&
  invocation.coverage?.includes("transcript unavailable") !== true;

const isObservedResponse = (
  response: DelegateResponseFacts
): response is DelegateResponseFacts & { observed: number } =>
  response.coverage === "complete" && response.observed !== undefined;

export const completeDelegateResponses = (invocation: InvocationResponses) => {
  const delegates = isSessionDelegate(invocation)
    ? invocation.responses?.filter((response) => response.role === "delegate")
    : undefined;

  return delegates !== undefined &&
    delegates.length > 0 &&
    delegates.every(isObservedResponse)
    ? delegates
    : undefined;
};

export interface InvocationFacts {
  phase: string;
  provider: string;
  model: string;
  effort?: string;
  configuredEffort?: string;
  mode?: string;
  surface: "cli" | "native";
  launched: boolean;
  durationMs?: number;
  startMs?: number;
  endMs?: number;
  outcome: string;
  usage?: Usage;
  usageSource?: UsageSource;
  reportedModels?: string[];
  reportedModelAmbiguous?: true;
  coverage?: CoverageReason[];
  responses?: DelegateResponseFacts[];
  superseded?: true;
  slot?: string;
  lifecycleSteps?: LifecycleStep[];
  nudge?: true;
  wrapUp?: true;
  routingOutcome?: string;
  slotState?: "done" | "native" | "failed";
  validationOutcome?: string;
  nativeState?: "pending" | "completed" | "invalid" | "failed";
  subject?: string;
  attempt?: number;
  targetSlot?: string;
}

/**
 * `reraised` and `escalation` sit on a review's last round; they are the driver's own convergence result, never a re-derivation.
 * `cap` is the phase's resolved round cap on every round; absent, H2 falls back to `DIAGNOSTIC_THRESHOLDS.reviewRounds`.
 * `cause` is the saved round cause's primary; absent on round 1, older sessions and invalid values.
 */
export interface ReviewFacts {
  phase?: string;
  round: number;
  accepted: number;
  rejected: number;
  recurring?: number;
  reraised?: readonly string[];
  escalation?: Escalation;
  cap?: number;
  cause?: RoundCausePrimary;
}

/**
 * Per-review fix-choice counts and step-back outcomes, built from ledger rulings alone.
 * `phase` is the review key `ReviewFacts` uses; `stepBacks` keeps ledger order, repeats included.
 */
export interface ReviewChoiceFacts {
  phase: string;
  proposed: number;
  alternative: number;
  stepBacks: { round: number; outcome: (typeof STEP_BACK_OUTCOMES)[number] }[];
}

/** `calls` is absent when the round has no start; `hostTokens` is absent when host usage is unavailable. */
export interface RoundWorkload {
  review: string;
  round: number;
  calls?: { total: number; phases: { key: string; count: number }[] };
  hostTokens?: number;
  hostTurns?: number;
  reviewerTurns?: number;
  reviewerTurnsPartial?: true;
  kind?: ReviewKind;
}

export type SlotYieldAttempt = Pick<
  InvocationFacts,
  | "provider"
  | "model"
  | "usage"
  | "usageSource"
  | "reportedModels"
  | "reportedModelAmbiguous"
  | "coverage"
> & { effort: string | null };

/** Per-responder review yield: findings raised and ruled, plus the slot's measured token cost. */
export interface SlotYieldFacts {
  kind: "provider" | "native" | "tool";
  provider: string;
  model: string | null;
  raised: { MUST: number; SHOULD: number; CONSIDER: number };
  accepted: number;
  rejected: number;
  deferred: number;
  duplicate: number;
  unruled: number;
  tokens?: number;
  measured: number;
  launched: number;
  attempts?: SlotYieldAttempt[];
  priorLaunches?: number;
  /** Findings whose origin is `fix-induced`; present only when nonzero. */
  fixInduced?: number;
}
/** Adds one responder's yield to another's; absent tokens stay absent. */

export const addYield = (current: SlotYieldFacts, row: SlotYieldFacts) => {
  for (const severity of ["MUST", "SHOULD", "CONSIDER"] as const) {
    current.raised[severity] += row.raised[severity];
  }

  for (const key of [
    "accepted",
    "rejected",
    "deferred",
    "duplicate",
    "unruled",
    "measured",
    "launched",
  ] as const) {
    current[key] += row[key];
  }

  if (row.tokens !== undefined) {
    current.tokens = (current.tokens ?? 0) + row.tokens;
  }

  if (row.attempts !== undefined && row.attempts.length > 0) {
    current.attempts = [...(current.attempts ?? []), ...row.attempts];
  }

  if (row.priorLaunches !== undefined && row.priorLaunches > 0) {
    current.priorLaunches = (current.priorLaunches ?? 0) + row.priorLaunches;
  }

  if (row.fixInduced !== undefined && row.fixInduced > 0) {
    current.fixInduced = (current.fixInduced ?? 0) + row.fixInduced;
  }
};

export interface RecoveryExecution {
  ref: string;
  reused?: number;
  launched?: number;
  unresolved?: number;
}

export interface RunFacts {
  recoverySelection?: RecoverySelection;
  recoveryExecution?: RecoveryExecution;
  recoverySelections?: (RecoverySelection & { ref: string })[];
  recoveryExecutions?: RecoveryExecution[];
  hostUsage?: HostUsageFacts;
  startedAt?: string;
  hosts?: string[];
  timingScope?: "tool-calls";
  capture?: {
    state: "opened" | "completed";
    start: number;
    end?: number;
    storageFailed?: number;
  };
  retroState?:
    | "missing"
    | "unreadable"
    | "malformed"
    | "invalid"
    | "empty"
    | "collected";
  collection?: {
    completed?: number;
    partial?: number;
    corrupt?: number;
    unreadable?: number;
    incomplete?: number;
    storageFailed?: number;
  };
  provenance?: { version?: string; build?: string; config?: JsonObject }[];
  rejectedTools?: { tool: string; action: string; cls: string }[];
  relaunches?: number;
  version?: string;
  build?: string;
  os?: string;
  host?: string;
  hostThread?: string;
  verb?: string;
  level?: string;
  pins?: string;
  config?: JsonObject;
  outcome?: string;
  /** `hostWaitMs` is the wait before the failed send; `waitBy` says whether a person or the host held it. */
  fault?: {
    effectId?: string;
    cls: string;
    hostWaitMs?: number;
    waitBy?: "user" | "host";
    driverMs?: number;
  };
  phases: PhaseFacts[];
  invocations: InvocationFacts[];
  reviews: ReviewFacts[];
  reviewChoices?: ReviewChoiceFacts[];
  slotYield?: SlotYieldFacts[];
  roundTiming?: {
    review: string;
    round: number;
    /** The saved round's cap; reviews whose rounds all failed have no findings facts to carry it. */
    cap?: number;
    slots: {
      slot: string;
      /** Reserve slot that served this target slot; omitted when no reserve attempt launched. */
      responder?: string;
      attempts: {
        startMs?: number;
        endMs?: number;
        surface?: "cli" | "native";
      }[];
    }[];
  }[];
  roundWorkload?: RoundWorkload[];
  /** Raw `RETRO` items; gated by `retroObservations` at render time. */
  observations?: unknown;
}

export interface RetroObservation {
  id: string;
  component: string;
  category: Category;
  evidence: string;
  impact: string;
  proposedFix: string;
}

/** `source` is a heuristic id (`H1`…) or `retro`. */
export interface Finding {
  source: string;
  run?: number;
  id?: string;
  category: Category;
  component: string;
  evidence: string;
  impact: string;
  proposedFix: string;
}

// NOTE: 1640 leaves room for the grounding token-source rule in references/diagnostics.md.
export const DIAGNOSTIC_LIMITS = {
  observations: 20,
  fieldBytes: 512,
  reportBytes: 131_072,
  instructionBytes: 1640,
} as const;

const files = (dir: string, names: readonly string[], ext: string) =>
  names.map((name) => `${dir}/${name}${ext}`);

/** Dispatch-owned files a finding may name, relative to the skill root; mirrors the shipped tree. */
// oxfmt-ignore
export const COMPONENTS: ReadonlySet<string> = new Set([
  // BEGIN GENERATED: diagnostic components
  "SKILL.md",
  ...files("references", ["artifact-readability","decision-frame","diagnostics","glossary","grounding","providers","review-coverage","review-fixes","review-rules","self-build","spec-authoring","spec-stage","toolkit","worktree-cleanup"], ".md"),
  "references/pricing.json",
  ...files("references/readme", ["ask","concepts","configuration","design","implement","plan","review","troubleshooting","verify"], ".md"),
  ...files("references/templates", ["context-map","design","explorer-brief","fix-review-lite-brief","increment-orchestrator-brief","plan-field-notes","plan","quality-bar","review-prompt-code","review-prompt-design","review-prompt-plan","review-prompt","review-severity","spec","test-cleanup-brief","verifier-brief","walkthrough","writer-brief"], ".md"),
  ...files("references/verbs", ["ask","design","implement","plan","review","verify"], ".md"),
  "scripts/dispatch.ts",
  ...files("scripts/lib", ["canonical-markdown","cli","config","fs-ext","integrity","node-fs-ext","opencode-db","platform","pricing","quota-store","session-paths","session"], ".ts"),
  ...files("scripts/lib/usage", ["adapters","agy","bands","claude","codex","copilot","delegate","index","opencode","read","rows"], ".ts"),
  "scripts/package.json",
  ...files("scripts/policy", ["cascade","quota","roster"], ".ts"),
  ...files("scripts/providers", ["agy","claude","codex","copilot","discovery","index","node-process","opencode-runtime","opencode","probe","process-policy","response","runner","session-usage","types"], ".ts"),
  ...files("scripts/toolkit", ["artifacts","ask","brief","check","cli","confirmations","contracts","coverage","deliver","diagnostics-capture","diagnostics","doctor","evidence","fanout","findings","fix-review-lite","git","hints","input","integrate","integration-state","integration","land","ledger","lint","lock","narrow","output","plan-view","prompts","records","red","report","review-capture","review-checkout","review-findings","review-fix","review-identity","review-notices","review-round","review-state","review-storage","review","status","types","walkthrough","writers"], ".ts"),
  ...files("scripts/toolkit/domain", ["blocker","citations","context","criterion-id","defined","design","diagnostics-gates","diagnostics-heuristics","diagnostics-render","diagnostics-types","diagnostics","document-lint","fix-review-lite","markdown-structure","plan-graph","plan-lint","plan-parse","plan","prompt","report","sanitize","severity","spec","stable-value","types"], ".ts"),
  ...files("scripts/toolkit/fanout", ["native","state","voice","wave"], ".ts"),
  // END GENERATED: diagnostic components
]);

export const DASH = "—";
