import type { Bands } from '../../lib/usage/bands.ts';
import type { CopilotActor, CopilotEvidence, Counters, HostUsageFacts, ResponseStage } from '../../lib/usage/rows.ts';
import type { LifecycleStep } from '../../providers/types.ts';
import type { CoverageReason, DelegateResponse, FailureClass, UsageSource } from '../types.ts';
import type { ReviewKind } from './types.ts';


export const PHASE_NAMES = ['plan', 'plan review', 'implementation', 'code review', 'design', 'design review', 'integration review', 'ask'] as const;

/** The review machine's halt on a re-raised fix (regression) or a pending rejection re-raised twice (deadlock). */
type Escalation = { kind: 'regression' | 'deadlock'; ids: readonly string[] };

/** Review phases carry the review machine's convergence result (findings re-raised across rounds, any escalation) and the resolved round `cap`. */
export type Phase = { key: string; name: typeof PHASE_NAMES[number]; outcome?: string; reraised?: readonly string[]; escalation?: Escalation; cap?: number };

/** Key order is severity order. Hosts send the keys; the report renders the labels. */
export const CATEGORIES = {
  correctness: 'Correctness / protocol',
  'token-economy': 'Token economy',
  speed: 'Speed',
  'review-convergence': 'Review convergence',
  'instruction-clarity': 'Instruction clarity',
  'information-access': 'Information access',
} as const;
export type Category = keyof typeof CATEGORIES;

export type ModelUsage = Counters & { bands?: Bands; turns?: number; toolCalls?: number; toolTurns?: number };

/** `input` is canonical uncached input; `models` holds per-model counters, with `<model>#<effort>` keys when effort varies. */
export type Usage = ModelUsage & { copilot?: CopilotEvidence; actors?: CopilotActor[]; models?: Record<string, ModelUsage>; reasoningInOutput?: boolean };

/** Tool-call durations can overlap; they do not measure session elapsed time. */
export type PhaseFacts = { key: string; name: string; outcome?: string; wallMs?: number; driverMs?: number; hostMs?: number; userMs?: number };

/** One launch attempt (`phase` is a phase key; `outcome` is `ok` or a failure class). */
export type DiagnosticEvent = {
  subject: string; slot: string; provider?: string; model?: string; effort?: string; attempt: number; targetSlot?: string;
} & (
  {kind:'validation'; outcome:string; surface:'cli'|'native'} |
  {kind:'routing'; cls?:FailureClass; state:'next-model'|'next-mode'|'reserve'|'stop'} |
  {kind:'native'; state:'pending'|'completed'|'invalid'|'failed'; replay?: boolean} |
  {kind:'slot'; cls?:FailureClass; state:'done'|'native'|'failed'; replay?: boolean}
);
export type DelegateResponseFacts = DelegateResponse & { stage: ResponseStage; agent?: string };

export type InvocationFacts = {
  phase: string; provider: string; model: string; effort?: string; configuredEffort?: string; mode?: string; surface: 'cli' | 'native';
  launched: boolean; durationMs?: number; startMs?: number; endMs?: number; outcome: string; usage?: Usage; usageSource?: UsageSource; reportedModels?: string[]; reportedModelAmbiguous?: true; coverage?: CoverageReason[];
  responses?: DelegateResponseFacts[];
  superseded?: true;
  slot?: string; lifecycleSteps?: LifecycleStep[]; nudge?: true; wrapUp?: true;
  routingOutcome?: string; slotState?: 'done'|'native'|'failed'; validationOutcome?: string; nativeState?: 'pending'|'completed'|'invalid'|'failed'; subject?: string; attempt?: number; targetSlot?: string;
};

/**
 * `reraised` and `escalation` sit on a review's last round; they are the driver's own convergence result, never a re-derivation.
 * `cap` is the phase's resolved round cap on every round; absent, H2 falls back to `DIAGNOSTIC_THRESHOLDS.reviewRounds`.
 */
export type ReviewFacts = { phase?: string; round: number; accepted: number; rejected: number; recurring?: number; reraised?: readonly string[]; escalation?: Escalation; cap?: number };

/** `calls` is absent when the round has no start; `hostTokens` is absent when host usage is unavailable. */
export type RoundWorkload = { review: string; round: number; calls?: {total: number; phases: {key: string; count: number}[]}; hostTokens?: number; hostTurns?: number; reviewerTurns?: number; reviewerTurnsPartial?: true; kind?: ReviewKind };

export type SlotYieldAttempt = Pick<InvocationFacts, 'provider' | 'model' | 'usage' | 'usageSource' | 'reportedModels' | 'reportedModelAmbiguous' | 'coverage'> & { effort: string | null };

/** Per-responder review yield: findings raised and ruled, plus the slot's measured token cost. */
export type SlotYieldFacts = {
  kind: 'provider' | 'native' | 'tool'; provider: string; model: string | null;
  raised: { MUST: number; SHOULD: number; CONSIDER: number };
  accepted: number; rejected: number; deferred: number; duplicate: number; unruled: number;
  tokens?: number; measured: number; launched: number;
  attempts?: SlotYieldAttempt[];
  priorLaunches?: number;
  /** Findings whose origin is `fix-induced`; present only when nonzero. */
  fixInduced?: number;
};
/** Adds one responder's yield to another's; absent tokens stay absent. */
export function addYield(current: SlotYieldFacts, row: SlotYieldFacts): void {
  for (const severity of ['MUST', 'SHOULD', 'CONSIDER'] as const) current.raised[severity] += row.raised[severity];
  for (const key of ['accepted', 'rejected', 'deferred', 'duplicate', 'unruled', 'measured', 'launched'] as const) current[key] += row[key];
  if (row.tokens !== undefined) current.tokens = (current.tokens ?? 0) + row.tokens;
  if (row.attempts?.length) current.attempts = [...(current.attempts ?? []), ...row.attempts];
  if (row.priorLaunches) current.priorLaunches = (current.priorLaunches ?? 0) + row.priorLaunches;
  if (row.fixInduced) current.fixInduced = (current.fixInduced ?? 0) + row.fixInduced;
}
export type RunFacts = {
  hostUsage?: HostUsageFacts;
  startedAt?: string;
  hosts?: string[];
  timingScope?: 'tool-calls';
  capture?: {state:'opened'|'completed'; start:number; end?:number; storageFailed?:number};
  retroState?: 'missing'|'unreadable'|'malformed'|'invalid'|'empty'|'collected';
  collection?: {completed?:number; partial?:number; corrupt?:number; unreadable?:number; incomplete?:number; storageFailed?:number};
  provenance?: {version?:string; build?:string; config?:Record<string,unknown>}[];
  rejectedTools?: {tool:string; action:string; cls:string}[];
  relaunches?: number;
  version?: string; build?: string; os?: string; host?: string; hostThread?: string; verb?: string; level?: string; pins?: string;
  config?: Record<string, unknown>; outcome?: string;
  /** `hostWaitMs` is the wait before the failed send; `waitBy` says whether a person or the host held it. */
  fault?: { effectId?: string; cls: string; hostWaitMs?: number; waitBy?: 'user' | 'host'; driverMs?: number };
  phases: PhaseFacts[];
  invocations: InvocationFacts[];
  reviews: ReviewFacts[];
  slotYield?: SlotYieldFacts[];
  roundTiming?: {review:string; round:number; slots:{slot:string; attempts:{startMs?:number; endMs?:number; surface?:'cli'|'native'}[]}[]}[];
  roundWorkload?: RoundWorkload[];
  /** Raw `RETRO` items; gated by `retroObservations` at render time. */
  observations?: unknown;
};

export type RetroObservation = { id: string; component: string; category: Category; evidence: string; impact: string; proposedFix: string };

/** `source` is a heuristic id (`H1`…) or `retro`. */
export type Finding = { source: string; run?: number; id?: string; category: Category; component: string; evidence: string; impact: string; proposedFix: string };

// NOTE: 1640 leaves room for the grounding token-source rule in references/diagnostics.md.
export const DIAGNOSTIC_LIMITS = { observations: 20, fieldBytes: 512, reportBytes: 131_072, instructionBytes: 1640 } as const;

const files = (dir: string, names: string, ext: string) => names.split(' ').map((name) => `${dir}/${name}${ext}`);

/** Dispatch-owned files a finding may name, relative to the skill root; mirrors the shipped tree. */
export const COMPONENTS: ReadonlySet<string> = new Set([
  'SKILL.md',
  'references/pricing.json',
  ...files('references/readme', 'ask concepts configuration design implement plan review troubleshooting verify', '.md'),
  ...files('references/templates', 'context-map design explorer-brief fix-review-lite-brief increment-orchestrator-brief plan plan-field-notes quality-bar review-prompt review-prompt-code review-prompt-design review-prompt-plan review-severity spec test-cleanup-brief verifier-brief walkthrough writer-brief', '.md'),
  ...files('references/verbs', 'ask design implement plan review verify', '.md'),
  ...files('references', 'artifact-readability decision-frame diagnostics glossary grounding providers review-coverage review-fixes review-rules self-build spec-authoring spec-stage toolkit worktree-cleanup', '.md'),
  ...files('scripts/lib', 'canonical-markdown cli config fs-ext integrity node-fs-ext opencode-db platform pricing quota-store session', '.ts'),
  ...files('scripts/lib/usage', 'agy bands claude codex copilot delegate index opencode read rows', '.ts'),
  ...files('scripts/policy', 'cascade quota roster', '.ts'),
  ...files('scripts/providers', 'agy claude codex copilot discovery index node-process opencode opencode-runtime probe runner types', '.ts'),
  ...files('scripts/toolkit/domain', 'citations context criterion-id design diagnostics diagnostics-gates diagnostics-heuristics diagnostics-render diagnostics-types fix-review-lite plan plan-graph plan-lint plan-parse prompt report sanitize severity spec stable-value types', '.ts'),
  ...files('scripts/toolkit', 'artifacts ask brief check cli confirmations contracts coverage deliver diagnostics doctor evidence fanout fanout/state fanout/voice fanout/native fanout/wave findings fix-review-lite git hints input integrate integration ledger lint lock output plan-view prompts records red report review review-capture review-checkout review-findings review-identity review-notices status types walkthrough writers', '.ts'),
  ...files('scripts', 'dispatch', '.ts'),
  'scripts/package.json',
]);

export const DASH = '—';
