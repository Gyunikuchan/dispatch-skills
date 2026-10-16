// @ts-check

import { qualitySections } from '../domain/prompt.ts';
import type { Await, CheckoutOp, Effect, Event, HostEvent, Machine, RunStartedEvent, TreeFingerprint, VerifyCommand, LevelGateScope, LevelClassificationAnswer, LevelRecommendationAnswer, ScopeAdjustment, PlanAmendment, PlanEdit, ChangeNotice, ChangeObservation, DriftResolution, AmendEvent, ReplacePlanEvent, PlanReconciliation, WriterRetirement, WriteReceiptEvent, ConflictDecision, RequestDecision, RequestUserDecision, SpecIdentity } from '../core/types.ts';
import { stableValue } from '../domain/stable-value.ts';
import { renderWalkthrough, walkthroughPathOf } from '../domain/render.ts';
import type { ParsedPlan, PlanCriterion, PlanTask, WalkthroughView } from '../domain/types.ts';
import { generatedCommands, approvedPaths, approvalAnswer, asParsedPlan, commandEffect, commandMappings, criterionEvidenceRows, isFingerprint, isTestPath, isWriterEnvelope, parseRedMatrix, sameFingerprint, settledPlanInput, writerConfig, type CommandMapping, type EvidenceRecord, type RedMatrixRow, type VerifyRecord, type WriterConfig } from './implement-types.ts';
import { beginReview, reviewArtifactId, resolutionRounds, reviewAwait, reviewData, reviewSpecFromRun, stepReview, validateReview, type ReviewState } from './review.ts';
import { answers, isRecord, launchDrift, launchMismatch, never, nextId, staleGoverning, stay, type Counters, type Step } from './types.ts';
import { recoveryRef, failureAnswer, artifactRelative, type FailureAnswer } from './implement-types.ts';
import { applyDispositions, bindingHash, evidenceAssessment, observe, openObservations, refreshEvidence, resolution, suggestedCriteria, validateDispositions } from './change-resolution.ts';
import type { EvidenceObligation } from './implement-types.ts';
import { HOTFIX_MAX_FILES, HOTFIX_MAX_LINES } from '../policy/hotfix.ts';
import { selectTaskBrief, taskMapRows, validateDesignTraceability } from '../domain/plan.ts';
import { activeTasks, slotTasks, checkpointPathOf, failureItems, initialTasks, readyTasks, taskCriteria, taskRedCriteria, taskScope, taskTestPaths, worktreeName, writeConcurrency, type TaskAmendment, type TaskBriefHistory, type RetiredTask, type TaskRecord, type Tasks } from './implement-tasks.ts';
import { amendPlan, replacementPlan, type RevisedPlan } from './revision.ts';
import { reconcilePlan } from './plan-reconciliation.ts';
import { slugOf } from './plan.ts';
import type { DesignBinding } from './implement-types.ts';

export const IMPLEMENT_TEMPLATE = 'references/templates/plan.md';
export const MAX_WRITE_ATTEMPTS = 3;

type PlanReviewResult = 'initial' | 'rebind';
export type Context = {
  /** Settled governing spec root passed at boot; null for standalone boots. */
  governingSpec?: SpecIdentity | null;
  specEpoch?: number; planAuthoredHere?: boolean;
  designPin?: string | null;
  existingPlan?: boolean;
  pendingWriter?: WriterConfig;
  designBinding?: DesignBinding;
  machinePath?: string;
  run: RunStartedEvent;
  planPath: string;
  counters: Counters;
  writer: WriterConfig | null;
  writerError: string | null;
  plan: ParsedPlan | null;
  planHash: string | null;
  planReview: ReviewState | null;
  codeReview: ReviewState | null;
  startFingerprint: TreeFingerprint | null;
  lastFingerprint: TreeFingerprint | null;
  mutationEpoch: number;
  criterionMutation: Readonly<Record<string, number>>;
  baseline: readonly VerifyRecord[];
  acceptedBaseline: readonly string[];
  records: Readonly<Record<string, VerifyRecord>>;
  evidence: Readonly<Record<string, EvidenceRecord>>;
  /** Evidence a refresh disposition superseded; retained for provenance, never relied on. */
  evidenceHistory?: readonly EvidenceRecord[];
  /** Criteria the orchestrator asked to re-verify; accepted work and attempts stay as recorded. */
  obligations?: Readonly<Record<string, EvidenceObligation>>;
  /** Advisory change observations; open ones ride every frame until a disposition names them. */
  observations?: readonly ChangeObservation[];
  redMatrix: readonly RedMatrixRow[];
  concerns: readonly string[];
  approvedRedExceptions: readonly string[];
  redExceptionRulings: Readonly<Record<string, { decision: 'accept'; by: string; quote: string }>>;
  concernRulings: Readonly<Record<string, { decision: 'accept'; by: string; quote: string }>>;
  /** `tasks` from approval until verified delivery; caller checkout effects and drift checks apply outside it. */
  phase: 'setup' | 'tasks' | 'delivered';
  tasks: Tasks;
  integration: { path: string; base: string; head: string; links: readonly string[]; ignored: readonly string[] } | null;
  archivedIntegrations?: readonly { archivedName: string; base: string; head: string }[];
  /** An incomplete replay retains its original archive range until every accepted commit is reconciled. */
  pendingReplay?: { input: { rebase: true; archivedName: string; replay: { base: string; head: string } }; sources: readonly string[]; conflict?: Conflict };
  approval: { by: string; quote: string } | null;
  changedPaths: readonly string[];
  finalGate: string;
  failureReason: string | null;
  finalFocus: readonly string[];
  withdrawnHotfix: readonly string[];
  retryContext: { rationale: string; failure: string } | null;
  stalled: { purpose: 'baseline' | 'final'; rows: readonly VerifyRecord[] } | null;
  revisions: readonly { artifact: 'plan'; reason: string; beforeHash: string; afterHash: string; rebind: { retained: readonly string[]; pending: readonly string[]; removed: readonly string[] } }[];
  revisionReviewRound: number;
  levelGatePassed: boolean;
  gateScope: LevelGateScope | null;
  levelAssessment: LevelClassificationAnswer | null;
  levelChoice: LevelRecommendationAnswer | null;
  scopeAdjustments: readonly ScopeAdjustment[];
  scopeNotice: { requestId: string; approvedBy: 'orchestrator' | 'user'; rationale: string; quote?: string } | null;
  amendments: readonly AmendmentRecord[];
  /** Briefs regenerated by the latest `AMEND`; the write frame relays each notice and new brief hash. */
  amended: readonly { task: string; briefPath: string; briefHash: string; notice: string }[];
  rebriefQueue: readonly { task: string; notice: string }[];
  reverifyQueue: readonly string[];
  amendResume: AmendResume | null;
  /** Tasks a revision retired; candidate and integration commits stay addressable and integrated bytes stay delivered. */
  retiredTasks?: readonly RetiredTask[];
  /** Latest rejected `REPLACE_PLAN`; every record stayed unchanged. */
  planRejection?: { path: string; error: string } | null;
  requestCount: number;
  /** Git blob ids of the delivered revision; `trim` deletes a transient test only while the caller copy still matches. */
  deliveredBlobs: Readonly<Record<string, string>>;
  /** Test files removed by `trim`; null until the post-review trim step has run. */
  trimmed: readonly string[] | null;
  /** Paths named by applied code-review fixes; trim rebinds these transient tests to their observed post-review content. */
  reviewFixed?: readonly string[];
};

/** The integrating task's conflict; `head` is the revision the next resolution attempt starts from. */
/** `retry` binds a failed resolve's effect id and input for replay; `outside` lists recovered paths beyond the current scope. */
/** `affected` accumulates every resolution delta and `failed` the unresolved check commands, so repairs re-verify both. */
type ReplayOwner = { task: string; paths: readonly string[]; commands: readonly string[] };
export type Conflict = { task: string; candidate: string; base: string; head: string; attempt: number; paths: readonly string[]; detail: string; evidence: readonly string[]; replay?: { archivedName: string; base: string; head: string; owners?: readonly ReplayOwner[] }; affected?: readonly string[]; failed?: readonly string[]; retry?: { id: string; input: Readonly<Record<string, unknown>> }; outside?: readonly string[] };
/** A live writer's need (`writer`), a submitted candidate outside its amended scope (`admission`), or envelope diff paths outside the task scope (`scope`). */
export type WriterRequest = { requestId: string; task: string; attempt: number; need: string; paths: readonly string[]; rationale: string; source: 'writer' | 'admission' | 'scope' };
/** `text` is the amended governed plan; root render writes it to `path` so the plan file matches the bound hash. */
/** `kind: 'replace'` binds a `REPLACE_PLAN` file at `path`; the prior plan file stays as written. */
export type AmendmentRecord = { id: string; kind?: 'amend' | 'replace'; reconciliation?: PlanReconciliation; retire?: readonly WriterRetirement[]; delta: readonly PlanEdit[]; notify: readonly { task: string; notice: string }[]; rationale: string; by: { by: 'user'; quote: string } | null; beforeHash: string; afterHash: string; removed: readonly string[]; dropped: Readonly<Record<string, readonly string[]>>; path: string; text: string };
type AmendResume = { kind: 'schedule' } | { kind: 'admit'; task: string } | { kind: 'recheck'; task: string } | { kind: 'conflict'; conflict: Conflict };

type CheckoutStep = 'observe' | 'init' | 'task' | 'relaunch' | 'scope-rebase' | 'commit' | 'red' | 'integrate' | 'resolve' | 'discard' | 'reset' | 'rebase' | 'deliver' | 'trim' | 'cleanup';

export type ImplementState =

  | { tag: 'checking-host-event'; c: Context; parent: ImplementState; parked: Event; effectId: string; resolution?: DriftResolution }
  | { tag: 'assessing-host-event'; c: Context; parent: ImplementState; parked: Event; effectId: string; fingerprint: TreeFingerprint; resolution?: DriftResolution }
  | { tag: 'drift'; c: Context; parent: ImplementState; parked: Event; paths: readonly string[]; fingerprint: TreeFingerprint; notice: ChangeNotice }
  | { tag: 'hotfix-brief'; c: Context; origin: RecoveryOrigin; before: TreeFingerprint; effectId: string; answer: Extract<FailureAnswer, { action: 'hotfix' }> }
  | { tag: 'hotfix-write'; c: Context; origin: RecoveryOrigin; before: TreeFingerprint; brief: { path: string; sha256: string; envelopePath: string }; answer: Extract<FailureAnswer, { action: 'hotfix' }> }
  | { tag: 'hotfix-envelope'; c: Context; origin: RecoveryOrigin; before: TreeFingerprint; effectId: string; answer: Extract<FailureAnswer, { action: 'hotfix' }> }
  | { tag: 'hotfix-snapshot'; c: Context; origin: RecoveryOrigin; before: TreeFingerprint; effectId: string; answer: Extract<FailureAnswer, { action: 'hotfix' }> }
  | { tag: 'hotfix-assessment'; c: Context; origin: RecoveryOrigin; before: TreeFingerprint; fingerprint: TreeFingerprint; effectId: string; answer: Extract<FailureAnswer, { action: 'hotfix' }> }
  | { tag: 'hotfix-verify'; c: Context; origin: RecoveryOrigin; before: TreeFingerprint; effectId: string; changedPaths: readonly string[] }
  | { tag: 'booting'; counters: Counters }
  | { tag: 'starting'; c: Context; effectId: string; next: 'author' | 'parse' }
  | { tag: 'author'; c: Context; defects: readonly Readonly<Record<string, unknown>>[] }
  | { tag: 'parsing'; c: Context; effectId: string; phase: PlanReviewResult }
  | { tag: 'plan-review'; c: Context; review: ReviewState }
  | { tag: 'baseline-preflight'; c: Context; effectId: string }
  | { tag: 'baseline'; c: Context; effectId: string }
  | { tag: 'baseline-snapshot'; c: Context; effectId: string; results: readonly VerifyRecord[] }
  | { tag: 'baseline-decision'; c: Context; items: readonly VerifyRecord[] }
  | { tag: 'level-classification'; c: Context; gateScope: LevelGateScope; resume: LevelGateResume }
  | { tag: 'level-recommendation'; c: Context; assessment: LevelClassificationAnswer; resume: LevelGateResume }
  | { tag: 'integration-conflict'; c: Context; conflict: Conflict }
  | { tag: 'request-decision'; c: Context; request: WriterRequest; stage: 'orchestrator' | 'user'; orchestratorRationale: string | null }
  | { tag: 'approval'; c: Context }
  | { tag: 'needs-user'; c: Context; ids: readonly string[] }
  | { tag: 'task-checkout'; c: Context; effectId: string; step: CheckoutStep; task: string | null; reason: string | null; conflict?: Conflict; input?: Readonly<Record<string, unknown>>; observe?: { durable: readonly string[]; rebind: readonly string[] } }
  | { tag: 'task-brief'; c: Context; effectId: string; task: string; notice?: string }
  | { tag: 'task-prewrite-snapshot'; c: Context; effectId: string; task: string }
  | { tag: 'tasks'; c: Context }
  | { tag: 'plan-replacement'; c: Context; origin: Extract<ImplementState, { tag: 'tasks' | 'request-decision' | 'integration-conflict' | 'failure' }>; event: ReplacePlanEvent; effectId: string }
  | { tag: 'task-envelope'; c: Context; effectId: string; task: string }
  | { tag: 'task-verify'; c: Context; effectId: string; task: string; purpose: 'red' | 'green' | 'integration' | 'resolution' | 'reverify'; previous: string | null; conflict?: Conflict }
  | { tag: 'delivered-snapshot'; c: Context; effectId: string }
  | { tag: 'evidence'; c: Context; purpose: 'final'; ids: readonly string[]; verify: readonly VerifyRecord[] }
  | { tag: 'concerns'; c: Context; items: readonly string[] }
  | { tag: 'code-review'; c: Context; review: ReviewState }
  | { tag: 'post-review-snapshot'; c: Context; effectId: string }
  | { tag: 'trim-snapshot'; c: Context; effectId: string }
  | { tag: 'generated-verify'; c: Context; effectId: string; count: number; before: TreeFingerprint }
  | { tag: 'generated-snapshot'; c: Context; effectId: string; before: TreeFingerprint; paths: readonly string[] }
  | { tag: 'final-verify'; c: Context; effectId: string; before: TreeFingerprint }
  | { tag: 'failure-snapshot'; c: Context; effectId: string; reason: string }
  | { tag: 'failure'; c: Context; reason: string; changedPaths: readonly string[] }
  | { tag: 'complete'; c: Context; summary: string }
  | { tag: 'stopped'; c: Context; summary: string; code?: 'stale-spec' | 'stale-design-spec' }
  | { tag: 'failed'; c: Context | null; summary: string };

type S = Step<ImplementState>;
type RecoveryOrigin = Extract<ImplementState, { tag: 'failure' | 'baseline-decision' }>;
type LevelGateResume = { kind: 'tasks' } | { kind: 'baseline-hotfix'; origin: Extract<ImplementState, { tag: 'baseline-decision' }>; answer: Extract<FailureAnswer, { action: 'hotfix' }> };

const emptyCounters: Counters = {};
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function planPathFromRun(run: RunStartedEvent): string {
  const override = run.overrides['path'];
  if (typeof override === 'string' && override.trim()) return override.trim();
  const argument = run.argument.trim();
  if (/\.plan\.md$/i.test(argument)) return argument;
  const settled = settledPlanInput(run.overrides['settledPlan']);
  if (settled) return settled.path;
  const sessionDir = typeof run.overrides['sessionDir'] === 'string' ? run.overrides['sessionDir'].replace(/[\\/]+$/, '') : null;
  const slug = argument.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '') || 'implementation';
  return sessionDir ? `${sessionDir}/${slug}.plan.md` : `${slug}.plan.md`;
}

function diffPaths(event: Event): string[] {
  if (!('diff' in event) || !isRecord(event['diff'])) return [];
  const paths = event['diff']['paths'];
  return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : [];
}

function baseContext(run: RunStartedEvent): Context {
  const planPath = planPathFromRun(run);
  const writer = writerConfig(run.config, run.orchestrator, run.level);
  return {
    governingSpec: null, specEpoch: 0, planAuthoredHere: false, run, planPath, counters: {}, writer: writer.ok ? writer.value : null, writerError: writer.ok ? null : writer.error,
    plan: null, planHash: null, planReview: null, codeReview: null, startFingerprint: null, lastFingerprint: null,
    mutationEpoch: 0, criterionMutation: {}, baseline: [], acceptedBaseline: [], records: {}, evidence: {}, redMatrix: [], concerns: [],
    approvedRedExceptions: [], redExceptionRulings: {}, concernRulings: {}, phase: 'setup', tasks: {}, integration: null,
    approval: null, changedPaths: [], finalGate: 'pending', failureReason: null,
    finalFocus: [], withdrawnHotfix: [], retryContext: null, stalled: null, revisions: [], revisionReviewRound: 0,
    levelGatePassed: false, gateScope: null, levelAssessment: null, levelChoice: null, scopeAdjustments: [], scopeNotice: null,
    amendments: [], amended: [], rebriefQueue: [], reverifyQueue: [], amendResume: null, requestCount: 0, deliveredBlobs: {}, trimmed: null,
  };
}

function effectId(c: Context, kind: Effect['kind']): { c: Context; id: string } {
  const next = nextId(c.counters, c.machinePath ?? 'implement', kind);
  return { c: { ...c, counters: next.counters }, id: next.id };
}

function snapshot(c0: Context, next: 'author' | 'parse'): S {
  const { c, id } = effectId(c0, 'snapshot');
  return { state: { tag: 'starting', c, effectId: id, next }, effects: [{ kind: 'snapshot', id, since: null }] };
}

function parsePlan(c0: Context, phase: PlanReviewResult): S {
  const { c, id } = effectId(c0, 'parse-artifact');
  return { state: { tag: 'parsing', c, effectId: id, phase }, effects: [{ kind: 'parse-artifact', id, path: c.planPath, artifact: 'plan', ...(c.governingSpec ? { governing: c.governingSpec.path } : {}) }] };
}

function authorPlan(c: Context, defects: readonly Readonly<Record<string, unknown>>[] = []): S {
  return stay({ tag: 'author', c, defects });
}

function beginFailure(c0: Context, reason: string): S {
  const { c, id } = effectId(c0, 'snapshot');
  return { state: { tag: 'failure-snapshot', c, effectId: id, reason }, effects: [{ kind: 'snapshot', id, since: c.lastFingerprint }] };
}

function fail(c: Context | null, summary: string): S { return stay({ tag: 'failed', c, summary }); }
function stop(c: Context, summary: string): S { return stay({ tag: 'stopped', c, summary }); }

function reviewCtxCounters(review: ReviewState, fallback: Counters): Counters {
  if (!('c' in review)) return fallback;
  // NOTE: host-boundary snapshots advance parent counters while a nested review retains its older copy.
  return Object.fromEntries([...new Set([...Object.keys(fallback), ...Object.keys(review.c.counters)])]
    .map((key) => [key, Math.max(fallback[key] ?? 0, review.c.counters[key] ?? 0)]));
}

export function planReviewContext(c: Context, invocationContext: string | null | undefined): string | null {
	const context = invocationContext ?? null;
	return c.designBinding ? JSON.stringify({ invocationContext: context, invocationLevel: c.run.level, invocationLevelSource: c.run.levelSource }) : context;
}

function startReview(c0: Context): S {
  const built = reviewSpecFromRun(c0.run, 'plan', c0.planPath, c0.governingSpec ?? null);
  if (!built.ok) return beginFailure(c0, built.error);
  const spec = { ...built.spec, context: planReviewContext(c0, built.spec.context) };
  const result = beginReview(spec, `${c0.machinePath ?? 'implement'}.plan-review${(c0.specEpoch ?? 0) > 0 ? `.s${c0.specEpoch}` : ''}`, c0.counters);
  return fromPlanReview(c0, result);
}

function fromPlanReview(c0: Context, result: Step<ReviewState>): S {
  const review = result.state;
  const c = { ...c0, counters: reviewCtxCounters(review, c0.counters), planReview: review };
  switch (review.tag) {
    case 'settled': case 'skipped': return parsePlan(c, 'rebind');
    case 'failed': return review.code === 'stale-design-spec' ? stay({ tag: 'stopped', c, code: review.code, summary: review.detail }) : beginFailure(c, `plan review failed: ${review.detail}`);
    case 'escalated': case 'empty': return beginFailure(c, `plan review did not settle: ${review.tag}`);
    case 'booting': case 'prepare': case 'wave': case 'native': case 'rule': case 'decide-needs-user': case 'fix': case 'fix-verify':
    case 'decide-escalation': case 'decide-opt-in': case 'decide-verification': case 'target-check': case 'pin-check': return { state: { tag: 'plan-review', c, review }, effects: result.effects };
    default: return never(review, 'plan review state');
  }
}

function beginBaseline(c0: Context): S {
  const { c, id } = effectId(c0, 'snapshot');
  return { state: { tag: 'baseline-preflight', c, effectId: id }, effects: [{ kind: 'snapshot', id, since: c0.lastFingerprint }] };
}

function runBaseline(c0: Context): S {
  const mappings = commandMappings(c0.plan as ParsedPlan);
  const commands = mappings.map((mapping) => commandEffect(mapping.command, mapping, approvedPaths(c0.plan as ParsedPlan), environmentKey(c0)));
  const { c, id } = effectId(c0, 'verify');
  return { state: { tag: 'baseline', c, effectId: id }, effects: [{ kind: 'verify', id, purpose: 'baseline', commands }] };
}

function environmentKey(c: Context): string {
  return JSON.stringify({ platform: c.run.orchestrator, model: c.run.orchestratorModel, level: c.run.level, repo: c.run.repo });
}

function recordsFrom(results: readonly Readonly<Record<string, unknown>>[], c: Context, purpose: 'baseline' | 'red' | 'scoped' | 'final' | 'generated'): VerifyRecord[] | null {
  const rows: VerifyRecord[] = [];
  for (const raw of results) {
    if (!nonEmpty(raw['command']) || typeof raw['exit'] !== 'number' || !nonEmpty(raw['logPath'])) return null;
    const failureId = typeof raw['failureId'] === 'string' ? raw['failureId'] : null;
    const failedTests = Array.isArray(raw['failedTests']) ? raw['failedTests'].filter((item): item is string => typeof item === 'string') : [];
    const status = raw['exit'] === 0 ? 'pass' : purpose === 'baseline' ? 'red' : failureId && c.acceptedBaseline.includes(failureId) ? 'known-red — unchanged' : 'regression';
    rows.push({
      command: raw['command'], exit: raw['exit'], logPath: raw['logPath'], failureId, failedTests,
      diagnostic: typeof raw['diagnostic'] === 'string' ? raw['diagnostic'] : '', loadError: raw['loadError'] === true,
      inputFingerprint: typeof raw['inputFingerprint'] === 'string' ? raw['inputFingerprint'] : '', mutationEpoch: c.mutationEpoch, status,
    });
  }
  return rows;
}

function resultEventRows(event: Extract<Event, { type: 'VERIFY_DONE' }>): Readonly<Record<string, unknown>>[] {
  return event.results.map((result) => result as Readonly<Record<string, unknown>>);
}

function failingBaselineIds(rows: readonly VerifyRecord[]): string[] {
  return [...new Set(rows.flatMap((row) => row.exit === 0 || row.failureId === null ? [] : [row.failureId]))].sort();
}

function afterBaseline(c: Context, results: readonly VerifyRecord[]): S {
  if (!c.startFingerprint) return beginFailure(c, 'Initial repository fingerprint is missing before baseline verification.');
  const { c: next, id } = effectId({ ...c, baseline: results }, 'snapshot');
  return { state: { tag: 'baseline-snapshot', c: next, effectId: id, results }, effects: [{ kind: 'snapshot', id, since: c.startFingerprint }] };
}

export function beginApproval(c: Context): S {
  return c.designBinding ? beginPostApproval({ ...c, approval: { by: 'design', quote: `${c.designBinding.approval.quote} (${c.designBinding.revision}, ${c.designBinding.increment})` } }) : stay({ tag: 'approval', c });
}

function gateScope(c: Context): LevelGateScope {
  const plan = c.plan as ParsedPlan;
  return {
    planHash: c.planHash as string,
    objective: plan.box['TL;DR'] ?? plan.title ?? c.planPath,
    invariants: [...plan.keyDecisions],
    criteria: plan.criteria.map((row) => ({ id: row.id, title: row.title, changes: [...row.changes], verify: row.verify.map((item) => item.command), review: row.review ?? null, evidence: row.evidence ?? 'verify' })),
    approvedPaths: approvedPaths(plan),
    commandMappings: commandMappings(plan).map((row) => ({ command: row.command, criteria: [...row.criteria], paths: [...row.paths], final: row.final })),
    baselineEvidence: c.baseline.map((row) => ({ command: row.command, status: row.status, exit: row.exit, inputFingerprint: row.inputFingerprint })),
    phaseObligations: { writer: c.writer ? [...c.writer.models, ...(c.writer.effort ? [`effort:${c.writer.effort}`] : [])] : [], review: ['code review under the settled level and configured skip policy'] },
    remainingIncrements: [...(c.designBinding?.governingDesign?.remainingIncrements ?? c.designBinding?.remainingIncrements ?? [])],
    design: c.designBinding?.governingDesign ?? null,
  };
}

function beginLevelGate(c: Context, resume: LevelGateResume): S {
  if (c.levelGatePassed) return resumeLevelGate(c, resume);
  if (!c.plan || !c.planHash) return beginFailure(c, 'Cannot classify implementation level before the governing plan is bound.');
  const scope = gateScope(c);
  return stay({ tag: 'level-classification', c: { ...c, gateScope: scope }, gateScope: scope, resume });
}

function resumeLevelGate(c: Context, resume: LevelGateResume): S {
  if (resume.kind === 'tasks') return beginTasks(c);
  return beginHotfix({ ...resume.origin, c }, resume.answer);
}

function finishLevelGate(c0: Context, assessment: LevelClassificationAnswer, choice: LevelRecommendationAnswer | null, resume: LevelGateResume): S {
  const explicit = c0.run.levelSource === 'explicit';
  const selected = explicit ? choice?.choice === 'adopt' ? assessment.evaluatedLevel : c0.run.level : assessment.evaluatedLevel;
  const writer = writerConfig(c0.run.config, c0.run.orchestrator, selected);
  if (!writer.ok) return beginFailure(c0, writer.error);
  const levelChoice = choice;
  const settled = { ...c0 };
  delete settled.pendingWriter;
  const c: Context = {
    ...settled, run: { ...c0.run, level: selected }, writer: writer.value, writerError: null,
    levelGatePassed: true, gateScope: assessment.gateScope, levelAssessment: assessment, levelChoice,
  };
  return resumeLevelGate(c, resume);
}

function levelOf(value: string): number { return value === 'low' ? 0 : value === 'medium' ? 1 : value === 'high' ? 2 : 3; }

function redCriteria(c: Context): PlanCriterion[] {
  return c.plan!.criteria.filter((criterion) => criterion.evidence === 'red');
}

function activeRedCriteria(c: Context): PlanCriterion[] { return redCriteria(c).filter((criterion) => !criterion.redException); }

function beginPostApproval(c: Context): S {
  const exceptionIds = redCriteria(c).filter((criterion) => criterion.redException).map((criterion) => criterion.id);
  if (exceptionIds.some((id) => !c.approvedRedExceptions.includes(id))) return stay({ tag: 'needs-user', c, ids: exceptionIds.filter((id) => !c.approvedRedExceptions.includes(id)) });
  return beginLevelGate(c, { kind: 'tasks' });
}

// SECTION: Task scheduler

function checkout(c0: Context, step: CheckoutStep, op: Exclude<CheckoutOp, 'scope-rebase'>, input: Readonly<Record<string, unknown>>, task: string | null = null, reason: string | null = null, conflict?: Conflict): S {
  if (step === 'rebase') c0 = retainReplay(c0, input, conflict);
  const { c, id } = effectId(c0, 'checkout');
  return { state: { tag: 'task-checkout', c, effectId: id, step, task, reason, ...(conflict ? { conflict, input } : {}) }, effects: [{ kind: 'checkout', id, op, input }] };
}

function retainReplay(c: Context, input: Readonly<Record<string, unknown>>, conflict?: Conflict): Context {
  const replay = input['replay'];
  if (!isRecord(replay) || !nonEmpty(replay['base']) || !nonEmpty(replay['head']) || !nonEmpty(input['archivedName'])) return c;
  const pendingReplay = c.pendingReplay ?? { input: { rebase: true as const, archivedName: input['archivedName'], replay: { base: replay['base'], head: replay['head'] } }, sources: [...new Set([...Object.values(c.tasks), ...(c.retiredTasks ?? [])].flatMap((record) => record.integrated ? [record.integrated] : []).concat(replay['head']))] };
  return { ...c, pendingReplay: { ...pendingReplay, ...(conflict ? { conflict } : {}) } };
}

function resumeReplay(c: Context): S {
  const pending = c.pendingReplay!;
  return checkout(c, 'rebase', 'init', pending.input, null, pending.input.archivedName, pending.conflict);
}

function captureTaskBaseline(c0: Context, id: string, incrementAttempt: boolean): S {
  const record = c0.tasks[id] as TaskRecord;
  if (!record.worktree) return checkout(withTask(c0, id, { worktreeNames: [...new Set([...(record.worktreeNames ?? []), worktreeName('task', id)])] }), 'task', 'task', { name: worktreeName('task', id), revision: c0.integration?.head, reset: true, links: c0.integration?.links ?? [], ignored: c0.integration?.ignored ?? [] }, id);
  const prepared = withTask(c0, id, {
    ...(incrementAttempt ? { attempt: record.attempt + 1 } : {}), status: 'pending', modelIndex: 0, handle: null,
    baseline: null, brief: null, candidate: null, integrated: null, redRows: [], preserveDraft: false,
  });
  const { c, id: snapshotId } = effectId(prepared, 'snapshot');
  return { state: { tag: 'task-prewrite-snapshot', c, effectId: snapshotId, task: id }, effects: [{ kind: 'snapshot', id: snapshotId, since: null, cwd: record.worktree }] };
}

function rebaseTaskDraft(c0: Context, id: string): S {
  const record = c0.tasks[id] as TaskRecord;
  const revision = c0.integration?.head;
  if (!record.worktree || !revision) return schedule(withTask(c0, id, { preserveDraft: false }));
  if (record.input === revision) return captureTaskBaseline(withTask(c0, id, { preserveDraft: true }), id, true);
  const originalName = record.worktree.split(/[\\/]/).at(-1) as string;
  const name = worktreeName('task', `${id}-scope-${record.attempt + 1}`);
  const tracked = withTask(c0, id, { worktreeNames: [...new Set([...(record.worktreeNames ?? []), originalName, name])] });
  const { c, id: effectIdValue } = effectId(tracked, 'checkout');
  const transferKey = `${c0.scopeNotice?.requestId ?? 'scope'}:${id}:${revision}:${record.signature}`;
  return {
    state: { tag: 'task-checkout', c, effectId: effectIdValue, step: 'scope-rebase', task: id, reason: null },
    effects: [{ kind: 'checkout', id: effectIdValue, op: 'scope-rebase', input: { name, originalName, revision, permitted: [...new Set([...(planTask(c0, id)?.paths ?? []), ...(record.admittedPaths ?? [])])].sort(), transferKey, links: c0.integration?.links ?? [], ignored: c0.integration?.ignored ?? [] } }],
  };
}

function beginTasks(c0: Context): S {
  if (c0.pendingWriter) {
    const { pendingWriter, ...bound } = c0;
    c0 = { ...bound, writer: pendingWriter };
  }
  if (!c0.plan || !c0.planHash) return beginFailure(c0, 'Cannot start task writers before the governed plan is bound.');
  if (!c0.writer?.models.length) return beginFailure(c0, c0.writerError ?? 'Implementation writer model is not configured.');
  const c: Context = { ...c0, phase: 'tasks', tasks: Object.keys(c0.tasks).length ? c0.tasks : initialTasks(c0.plan) };
  return c.integration ? schedule(c) : checkout(c, 'init', 'init', {});
}

function withTask(c: Context, id: string, patch: Partial<TaskRecord>): Context {
  return { ...c, tasks: { ...c.tasks, [id]: { ...c.tasks[id] as TaskRecord, ...patch } } };
}

function planTask(c: Context, id: string): PlanTask | undefined { return c.plan!.tasks.find((task) => task.id === id); }

function taskWorktreeName(record: TaskRecord): string {
  return record.worktree?.split(/[\\/]/).at(-1) || worktreeName('task', record.id);
}

/** Prepares the first ready task while a slot is free; otherwise waits on running writers, delivers, or asks once. */
function schedule(c: Context): S {
  if (c.pendingReplay) return resumeReplay(c);
  const reverify = c.reverifyQueue.find((id) => planTask(c, id)?.prerequisites.every((dependency) => c.tasks[dependency]?.status === 'accepted' && !c.reverifyQueue.includes(dependency)));
  if (reverify) {
    const commands = taskVerifyCommands(c, reverify);
    if (!commands.length) return schedule(transientEvidence({ ...c, reverifyQueue: c.reverifyQueue.filter((id) => id !== reverify) }, reverify, c.integration!.head));
    const batch = beginVerify(c, 'scoped', commands, c.integration!.path);
    return { state: { tag: 'task-verify', c: batch.c, effectId: batch.id, task: reverify, purpose: 'reverify', previous: null }, effects: [batch.effect] };
  }
  if (c.pendingWriter && !activeTasks(c.tasks).length) {
    const { pendingWriter, ...bound } = c;
    c = { ...bound, writer: pendingWriter };
  }
  const plan = c.plan!;
  for (const record of Object.values(c.tasks)) {
    // NOTE: an amendment-added prerequisite holds a submission until that producer is accepted, then admits it on the new head.
    if (record.status === 'submitted' && record.parked && planTask(c, record.id)?.prerequisites.every((id) => c.tasks[id]?.status === 'accepted')) return checkEnvelope(withTask(c, record.id, { parked: null }), record.id, record.parked.envelopePath);
  }
  const next = readyTasks(plan, c.tasks, MAX_WRITE_ATTEMPTS)[0];
  // NOTE: a parked submission holds no writer, so it must not block the prerequisite it waits on.
  if (next && slotTasks(c.tasks).length < writeConcurrency(c.run.config)) {
    const record = c.tasks[next.id] as TaskRecord;
    const integration = c.integration!;
    // NOTE: a retried draft may sit on its rejected candidate commit; rewind HEAD to the input but keep the files.
    if (record.preserveDraft && record.worktree && record.input === integration.head && record.candidate) {
      return checkout(withTask(c, next.id, { attempt: record.attempt + 1, modelIndex: 0, handle: null, brief: null, candidate: null, integrated: null, redRows: [], preserveDraft: false }), 'task', 'task', { name: taskWorktreeName(record), revision: record.input, keep: true, links: integration.links, ignored: integration.ignored }, next.id);
    }
    if (record.preserveDraft && record.worktree) return record.input === integration.head ? captureTaskBaseline(c, next.id, true) : rebaseTaskDraft(c, next.id);
    return checkout(withTask(c, next.id, { attempt: record.attempt + 1, modelIndex: 0, handle: null, brief: null, candidate: null, integrated: null, redRows: [], preserveDraft: false }), 'task', 'task',
      { name: worktreeName('task', next.id), revision: integration.head, reset: true, links: integration.links, ignored: integration.ignored }, next.id);
  }
  if (slotTasks(c.tasks).length) return stay({ tag: 'tasks', c });
  if (!c.reverifyQueue.length && plan.tasks.every((task) => c.tasks[task.id]?.status === 'accepted')) {
    const integration = c.integration!;
    return checkout(c, 'deliver', 'deliver', { base: integration.base, revision: integration.head });
  }
  const items = failureItems(plan, c.tasks);
  return beginFailure(c, `Task writers stopped: ${items.map((item) => `${item.task} ${item.status} (${item.reason})`).join('; ') || 'no runnable task'}.`);
}

/** Flags modify/remove targets absent from the plan so the orchestrator sees them before adjudicating. */
function resolveAmendment(plan: ParsedPlan, amendment: PlanAmendment): TaskAmendment {
  const known = new Set([...plan.tasks.map((task) => task.id), ...plan.criteria.flatMap((row) => [row.id, ...row.verify.map((verify) => verify.command)]), ...plan.verification.automated, ...plan.finalCommands, ...plan.changes.map((change) => change.path)]);
  const unresolvedTargets = [...new Set(amendment.proposal.filter((row) => row.kind !== 'add' && !known.has(row.target)).map((row) => row.target))];
  return { ...amendment, unresolvedTargets };
}

function taskFailed(c: Context, id: string, reason: string, amendment: TaskAmendment | null = null): S {
  const record = c.tasks[id] as TaskRecord;
  return schedule(withTask(c, id, { status: 'failed', failures: record.failures + 1, handle: null, reason, amendment }));
}

function briefDesignBinding(c: Context): Readonly<Record<string, unknown>> | null {
  const binding = c.designBinding;
  if (!binding) return null;
  return {
    revision: binding.revision, increment: binding.increment,
    settledLevel: c.run.level, levelSource: c.run.levelSource,
    objective: binding.governingDesign?.objective ?? null,
    invariants: binding.governingDesign?.invariants ?? [],
    fields: binding.governingDesign?.fields ?? {},
    contract: binding.contract, paths: binding.paths,
    remainingIncrements: binding.governingDesign?.remainingIncrements ?? binding.remainingIncrements ?? [],
  };
}

function taskBriefInput(c: Context, record: TaskRecord, notice?: string): Readonly<Record<string, unknown>> {
  const plan = c.plan!;
  const brief = selectTaskBrief(plan, record.id)!;
  const testPaths = taskTestPaths(plan, brief.task);
  return {
    planPath: c.planPath, planHash: c.planHash,
    designBinding: briefDesignBinding(c), reopenedDefects: c.designBinding?.repair,
    governingOutcome: { title: plan.title, outcome: plan.box['TL;DR'] ?? plan.title ?? c.planPath },
    sharedContext: plan.sharedContext,
    siblingTasks: taskMapRows(plan).filter((row) => row.id !== brief.task.id),
    task: {
      id: brief.task.id, title: brief.task.title, summary: brief.task.summary, graph: brief.summary, attempt: record.attempt, signature: record.signature,
      constraints: brief.task.constraints ?? [],
      prerequisites: brief.prerequisites.map((task) => ({ id: task.id, integrated: c.tasks[task.id]?.integrated ?? null })),
      dependents: brief.dependents.map((task) => task.id), worktree: record.worktree, inputRevision: record.input,
      checkpoint: testPaths.length ? { root: record.worktree, paths: testPaths } : null,
      ...(notice ? { amendmentNotice: notice } : {}),
    },
    settledScope: { paths: brief.task.paths, approvedPaths: brief.task.paths, changes: brief.changes },
    ...(notice ? {
      revisionNotice: { notice, revision: c.amendments.at(-1)?.id ?? null, rationale: c.amendments.at(-1)?.rationale ?? null },
      previousBriefs: (record.briefs ?? []).map((row) => ({ path: row.path, sha256: row.sha256, scope: row.scope })),
    } : {}),
    criteria: brief.criteria.map((criterion) => ({ id: criterion.id, title: criterion.title, changes: criterion.changes, verify: criterion.verify, evidence: criterion.evidence, preExisting: criterion.preExisting, redException: criterion.redException, testRationale: criterion.testRationale })),
    envelopeSchema: {
      schemaVersion: 1, stage: 'COMPLETE',
      status: ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED'], summary: 'non-empty string',
      evidence: [
        'CRITERION <SC#> | <one path from that criterion Changes list> | <delivered behavior>',
        ...(testPaths.length ? ['RED-MATRIX <SC#> | <approved-test-path>:<leaf test> | exit <nonzero> test:<exact failing test name>[; test:<exact failing test name>]'] : []),
      ],
      concerns: 'required non-empty string array only for DONE_WITH_CONCERNS',
      missingContext: 'required non-empty string array only for NEEDS_CONTEXT', blockers: 'required non-empty string array only for BLOCKED',
      files: 'optional array of { path, note }; each path must be approved and each note a short clause',
      amendment: 'optional only for BLOCKED or NEEDS_CONTEXT: { finding, evidence: string[], proposal: { kind: modify|remove|add, target: <task id | criterion id | Verify command | change path | new item>, current?, proposed?, rationale }[] }',
    },
    rules: { keyDecisions: plan.keyDecisions, repository: c.run.repo, approval: c.approval, writerStage: 'task' },
    priorFindings: c.planReview && 'c' in c.planReview ? resolutionRounds(c.planReview.c) : [],
    evidence: c.baseline.map((row) => `BASELINE ${row.command} | ${row.status} | ${row.failureId ?? row.logPath}`),
    admissionDefects: record.attempt > 1 && record.reason ? [record.reason] : undefined,
    retryContext: c.retryContext,
  };
}

function taskVerifyCommands(c: Context, id: string): { command: string; mapping: CommandMapping }[] {
  const task = planTask(c, id);
  if (!task) return [];
  const mappings = new Map(commandMappings(c.plan!).map((mapping) => [mapping.command, mapping]));
  return [...mappings.values()].filter((mapping) => !mapping.final && (!mapping.criteria.length || mapping.criteria.some((criterion) => task.criteria.includes(criterion)))).map((mapping) => ({ command: mapping.command, mapping }));
}

function taskVerify(c0: Context, id: string, purpose: 'red' | 'green' | 'integration', cwd: string, commands: readonly { command: string; mapping: CommandMapping | null }[], previous: string | null = null): S {
  const batch = beginVerify(c0, purpose === 'red' ? 'red' : 'scoped', commands, cwd);
  return { state: { tag: 'task-verify', c: batch.c, effectId: batch.id, task: id, purpose, previous }, effects: [batch.effect] };
}

function greenVerify(c: Context, id: string): S {
  const commands = taskVerifyCommands(c, id);
  const record = c.tasks[id] as TaskRecord;
  return commands.length ? taskVerify(c, id, 'green', record.worktree as string, commands) : integrate(c, id);
}

function integrate(c: Context, id: string): S {
  const record = c.tasks[id] as TaskRecord;
  return checkout(c, 'integrate', 'integrate', { task: id, candidate: record.candidate, expected: c.integration!.head }, id);
}

function accept(c0: Context, id: string, revision: string): S {
  const record = c0.tasks[id] as TaskRecord;
  const paths = planTask(c0, id)?.paths ?? [];
  const redMatrix = [...c0.redMatrix.filter((row) => !record.redRows.some((next) => next.id === row.id)), ...record.redRows];
  const c = withTask({ ...c0, integration: { ...c0.integration!, head: revision }, redMatrix }, id, { status: 'accepted', handle: null, integrated: revision, reason: null, amendment: null, parked: null });
  return schedule(transientEvidence(markMutation(c, paths), id, revision));
}

/** Transient criteria are trimmed before the final gate, so their evidence is the integration check at acceptance. */
function transientEvidence(c: Context, id: string, revision: string): Context {
  const task = planTask(c, id);
  if (!task) return c;
  const evidence = { ...c.evidence };
  for (const criterion of taskCriteria(c.plan!, task).filter((row) => row.retain === 'transient')) {
    const redProvenance = criterion.evidence !== 'red' ? 'not-required' : c.redMatrix.some((row) => row.id === criterion.id && row.exit !== 0 && row.tests.length > 0) ? 'observed' : 'waived';
    const waiver = c.redExceptionRulings[criterion.id];
    if (redProvenance === 'waived' && !waiver) continue;
    evidence[criterion.id] = { id: criterion.id, outcome: 'pass', evidence: `verified at ${revision}`, transient: true, planHash: c.planHash ?? '', mutationEpoch: c.mutationEpoch, source: criterion.evidence, redProvenance, ...(redProvenance === 'waived' ? { waiver } : {}) } as EvidenceRecord;
  }
  return { ...c, evidence };
}

/** Transient evidence binds the revision it was verified at, so later mutation and amendment hashes do not stale it. */
function transientCurrent(c: Context, id: string): boolean { return c.evidence[id]?.['transient'] === true; }

/**
 * Re-verifies every accepted task and Integration criterion the committed resolution touches, selected from the full
 * returned resolution delta rather than the original conflict paths; with nothing to run, the resolution is accepted.
 */
function verifyResolution(c: Context, conflict0: Conflict, revision: string, delta: readonly string[]): S {
  const plan = c.plan!;
  const paths = [...new Set([...(conflict0.affected ?? []), ...delta])].sort();
  const conflict: Conflict = { ...conflict0, affected: paths };
  // NOTE: checkout refuses resolutions outside the involved tasks' paths, so only involved tasks can be touched.
  const touched = involvedTasks(c, conflict);
  const commands = new Map<string, { command: string; mapping: CommandMapping }>();
  if (!conflict.replay?.owners) for (const id of touched) for (const item of taskVerifyCommands(c, id)) commands.set(item.command, item);
  for (const owner of conflict.replay?.owners ?? []) for (const command of owner.commands) {
    if (!commands.has(command)) commands.set(command, { command, mapping: { command, criteria: [], paths: owner.paths, final: false } });
  }
  // NOTE: Integration criteria belong to no task, so taskVerifyCommands never selects them; pick those whose Changes meet the resolution.
  const owned = new Set(plan.tasks.flatMap((task) => task.criteria));
  const scope = new Set(conflictScope(c, conflict));
  const integration = new Set(plan.criteria.filter((row) => !owned.has(row.id) && row.changes.some((file) => paths.includes(file) && scope.has(file))).map((row) => row.id));
  for (const mapping of commandMappings(plan)) if (!mapping.final && (mapping.criteria.some((id) => integration.has(id)) || conflict.failed?.includes(mapping.command))) commands.set(mapping.command, { command: mapping.command, mapping });
  const next = conflict.replay ? { ...c, integration: { ...c.integration!, head: revision } } : withTask(c, conflict.task, { integrated: revision });
  if (!commands.size) return completeResolution(next, { ...conflict, head: revision });
  const batch = beginVerify(next, 'scoped', [...commands.values()], c.integration!.path);
  return { state: { tag: 'task-verify', c: batch.c, effectId: batch.id, task: conflict.task, purpose: 'resolution', previous: null, conflict: { ...conflict, head: revision } }, effects: [batch.effect] };
}

function completeResolution(c: Context, conflict: Conflict): S {
  if (!conflict.replay) return accept(c, conflict.task, conflict.head);
  const { archivedName, base, head } = conflict.replay;
  return checkout(c, 'rebase', 'init', { rebase: true, archivedName, replay: { base, head } }, null, archivedName, conflict);
}

/** False once an amendment removed the conflicting task from the plan or its task record. */
function conflictLive(c: Context, conflict: Conflict): boolean { return !!conflict.replay?.owners?.length || !!planTask(c, conflict.task) && !!c.tasks[conflict.task]; }

/** The integrating task plus accepted tasks whose approved paths meet the conflict. */
function involvedTasks(c: Context, conflict: Conflict): string[] {
  if (conflict.replay?.owners) return [...new Set(conflict.replay.owners.map((owner) => owner.task))];
  return [conflict.task, ...Object.values(c.tasks).filter((record) => record.status === 'accepted' && record.id !== conflict.task && [...(planTask(c, record.id)?.paths ?? []), ...(record.admittedPaths ?? [])].some((file) => conflict.paths.includes(file))).map((record) => record.id)];
}

function conflictScope(c: Context, conflict: Conflict): string[] {
  return [...new Set(conflict.replay?.owners ? conflict.replay.owners.flatMap((owner) => owner.paths) : involvedTasks(c, conflict).flatMap((id) => [...(planTask(c, id)?.paths ?? []), ...(c.tasks[id]?.admittedPaths ?? [])]))].sort();
}

/** Retired signatures retain their accepted contract; these checks preserve bytes without restoring requirements. */
function replayOwnership(c: Context, candidate: string, candidatePaths: readonly string[], paths: readonly string[]): ReplayOwner[] | null {
  const records = [...Object.values(c.tasks), ...(c.retiredTasks ?? [])].filter((record) => record.status === 'accepted');
  const contracts = records.map((record) => {
    let signature: Record<string, unknown>;
    try { signature = JSON.parse(record.signature) as Record<string, unknown>; } catch { return null; }
    if (!isRecord(signature) || !Array.isArray(signature['paths']) || !Array.isArray(signature['definitions'])) return null;
    const retainedPaths = [...new Set([...signature['paths'], ...(record.candidatePaths ?? []), ...(record.admittedPaths ?? [])].filter((file): file is string => typeof file === 'string'))];
    const commands = signature['definitions'].filter(isRecord).flatMap((row) => Array.isArray(row['verify']) ? row['verify'].filter(isRecord).flatMap((verify) => typeof verify['command'] === 'string' && verify['command'].trim() ? [verify['command']] : []) : []);
    return { record, owner: { task: record.id, paths: retainedPaths, commands: [...new Set(commands)] } };
  }).filter((row) => row !== null);
  const primary = contracts.find(({ record }) => record.integrated === candidate || record.integratedHistory?.includes(candidate));
  const affected = [...new Set([...candidatePaths, ...paths])];
  const owners = contracts.filter((row) => row === primary || row.owner.paths.some((file) => affected.includes(file))).map((row) => row.owner);
  if ((!primary && !candidatePaths.length) || !owners.length || affected.some((file) => !owners.some((owner) => owner.paths.includes(file)))) return null;
  return primary ? [primary.owner, ...owners.filter((owner) => owner !== primary.owner)] : owners;
}

/** Paths of the brief the writer worked from; an amendment may have narrowed the current scope since. */
function briefScopePaths(record: TaskRecord): string[] {
  const entry = record.briefs?.find((row) => row.envelopePath === record.brief?.envelopePath);
  if (!entry) return [];
  const scope = JSON.parse(entry.scope) as { paths?: unknown };
  return Array.isArray(scope.paths) ? scope.paths.filter((file): file is string => typeof file === 'string') : [];
}

function checkEnvelope(c0: Context, id: string, envelopePath: string): S {
  const record = c0.tasks[id] as TaskRecord;
  const permitted = [...new Set([...(planTask(c0, id)?.paths ?? []), ...briefScopePaths(record), ...(record.admittedPaths ?? [])])].sort();
  const { c, id: effect } = effectId(withTask(c0, id, { status: 'submitted' }), 'check-envelope');
  return { state: { tag: 'task-envelope', c, effectId: effect, task: id }, effects: [{ kind: 'check-envelope', id: effect, envelopePath, permitted, ...(record.baseline ? { since: record.baseline } : {}), cwd: record.worktree as string }] };
}

function admitEnvelope(c: Context, id: string, event: Extract<Event, { type: 'ENVELOPE_CHECKED' }>): S {
  const plan = c.plan!, task = planTask(c, id), record = c.tasks[id] as TaskRecord;
  if (!task) return taskFailed(c, id, 'Task is no longer in the governed plan.');
  const envelope = event.envelope;
  if (event.defects.length || !isWriterEnvelope(envelope)) return taskFailed(c, id, `Envelope rejected: ${event.defects.join('; ') || 'malformed envelope.'}`);
  const allowed = new Set([...task.paths, ...briefScopePaths(record), ...(record.admittedPaths ?? [])]);
  const outside = diffPaths(event).filter((file) => !allowed.has(file));
  // NOTE: hosts produce incidental files (caches, generated output), so the orchestrator judges extra paths instead of a hard failure.
  if (outside.length) return requestDecision(c, { task: id, attempt: record.attempt, need: `Admit writer paths outside the task scope: ${outside.join(', ')}.`, paths: outside, rationale: 'The writer diff changed paths outside the approved task scope.', source: 'scope' });
  if (envelope.stage !== 'COMPLETE') return taskFailed(c, id, `Envelope stage must be COMPLETE; got ${envelope.stage}.`);
  if (envelope.status === 'NEEDS_CONTEXT' || envelope.status === 'BLOCKED') return taskFailed(c, id, `Writer returned ${envelope.status}: ${envelope.summary}`, envelope.amendment ? resolveAmendment(plan, envelope.amendment) : null);
  const missing = criterionEvidenceRows(envelope.evidence, taskCriteria(plan, task));
  if (missing.length) return taskFailed(c, id, `Evidence is missing criterion rows for ${missing.join(', ')}.`);
  const redCriteriaOfTask = taskRedCriteria(plan, task);
  // Amendment overlays add criteria after parse, so their IDs join the recorded plan IDs.
  const planIds = [...new Set([...plan.planIds, ...plan.criteria.map((criterion) => criterion.id)])];
  const red = redCriteriaOfTask.length ? parseRedMatrix(envelope.evidence, redCriteriaOfTask, planIds) : { rows: [], defects: [] };
  if (red.defects.length) return taskFailed(c, id, `RED matrix rejected: ${red.defects.join('; ')}`);
  const concerns = envelope.status === 'DONE_WITH_CONCERNS' ? (envelope.concerns ?? []).map((item) => `${id}: ${item}`) : [];
  const next = withTask({ ...c, concerns: [...new Set([...c.concerns, ...concerns])] }, id, { redRows: red.rows });
  return checkout(next, 'commit', 'commit', { name: taskWorktreeName(record), base: record.input, message: `dispatch task ${id} attempt ${record.attempt}` }, id);
}

/** A committed candidate inside the current scope proceeds; one an amendment narrowed after its brief asks the orchestrator. */
function admitCandidate(c: Context, id: string): S {
  const record = c.tasks[id] as TaskRecord, scope = [...(planTask(c, id)?.paths ?? []), ...(record.admittedPaths ?? [])];
  const outside = (record.candidatePaths ?? []).filter((file) => !scope.includes(file));
  if (!outside.length) return redReplay(c, id);
  const briefPaths = briefScopePaths(record);
  if (outside.every((file) => briefPaths.includes(file))) {
    return requestDecision(c, { task: id, attempt: record.attempt, need: `Admit candidate paths outside the amended scope: ${outside.join(', ')}.`, paths: outside, rationale: 'An amendment narrowed this task after its brief was issued.', source: 'admission' });
  }
  return taskFailed(c, id, `Candidate changes paths outside the task scope: ${outside.join(', ')}.`);
}

function requestDecision(c: Context, request: Omit<WriterRequest, 'requestId'>): S {
  const count = c.requestCount + 1;
  return stay({ tag: 'request-decision', c: { ...c, requestCount: count }, request: { requestId: `request-${count}`, ...request }, stage: 'orchestrator', orchestratorRationale: null });
}

/** A writer need is approved only once its paths are in scope (AMEND widens scope); an admission approval admits the narrowed candidate. */
function resolveRequest(c: Context, request: WriterRequest, approved: boolean): S {
  // NOTE: approval re-runs the envelope check with the admitted paths, so every remaining admission check still applies.
  if (request.source === 'scope') return approved ? admitScopePaths(c, request) : taskFailed(c, request.task, `Writer paths outside the task scope were declined: ${request.paths.join(', ')}.`);
  if (request.source === 'admission') return approved ? continueAdmission(c, request.task, () => redReplay(c, request.task)) : taskFailed(c, request.task, `Candidate paths outside the amended scope were declined: ${request.paths.join(', ')}.`);
  return schedule(c);
}

/** Records the admitted paths before the admission guard, so a parked submission re-checks with them later. */
function admitScopePaths(c0: Context, request: WriterRequest): S {
  const record = c0.tasks[request.task];
  if (!record || record.removed) return continueAdmission(c0, request.task, () => schedule(c0));
  const c = withTask(c0, request.task, { admittedPaths: [...new Set([...(record.admittedPaths ?? []), ...request.paths])].sort() });
  const envelopePath = record.brief?.envelopePath;
  return continueAdmission(c, request.task, () => envelopePath ? checkEnvelope(c, request.task, envelopePath) : taskFailed(c, request.task, 'Admitted scope paths have no submitted envelope to re-check.'));
}

/**
 * Guards every admission continuation: an amendment may have removed the requesting task (resume scheduling) or added an
 * unaccepted prerequisite (park the submission; schedule re-admits it on the integration head once the producer is accepted).
 */
function continueAdmission(c: Context, id: string, admit: () => S): S {
  const record = c.tasks[id];
  if (!record || record.removed || !planTask(c, id)) return schedule(c);
  if (!(planTask(c, id)?.prerequisites ?? []).some((other) => c.tasks[other]?.status !== 'accepted')) return admit();
  const envelopePath = record.brief?.envelopePath;
  if (!envelopePath) return taskFailed(c, id, 'Parked admission has no submitted envelope to re-admit.');
  return schedule(withTask(c, id, { parked: { envelopePath } }));
}

/** Moves a retired writer's record to the archive at its terminal receipt; the slot frees here. */
function retireTask(c: Context, id: string, terminal: string): Context {
  const record = c.tasks[id] as TaskRecord;
  const by = [...c.amendments].reverse().find((row) => row.removed.includes(id))?.id ?? 'revision';
  return {
    ...c, tasks: Object.fromEntries(Object.entries(c.tasks).filter(([key]) => key !== id)),
    retiredTasks: [...(c.retiredTasks ?? []), { ...record, handle: null, reason: terminal, retiredBy: by }],
  };
}

type TaskReceipt = Extract<WriteReceiptEvent, { handle: string }>;

function taskReceipt(c: Context, event: TaskReceipt): S {
  const id = event.task, record = c.tasks[id] as TaskRecord;
  switch (event.status) {
    case 'launched': {
      const next = withTask(c, id, { handle: event.handle, launchedModel: event.model });
      const drift = launchDrift({ model: c.writer?.models[record.modelIndex], effort: c.writer?.effort }, event);
      return stay({ tag: 'tasks', c: drift.length ? { ...next, concerns: [...new Set([...next.concerns, `${id}: writer substitution, launched ${drift.join(', ')}; ${event.substitution ?? 'no reason given'}`])] } : next });
    }
    case 'submitted': {
      // NOTE: a retired writer's submission is kept as evidence and never admitted; `retain` ends here, `stop` waits for cancellation.
      if (record.removed && record.retirement === 'retain') return schedule(retireTask(withTask(c, id, { retainedSubmission: event.envelopePath }), id, `retained submission ${event.envelopePath}`));
      if (record.removed) return stay({ tag: 'tasks', c: { ...withTask(c, id, { retainedSubmission: event.envelopePath }), concerns: [...new Set([...c.concerns, `${id}: retired writer submitted ${event.envelopePath} before cancellation; the submission is retained, not admitted.`])] } });
      const entry = record.briefs?.find((row) => row.envelopePath === event.envelopePath);
      const brief = entry ? { path: entry.path, sha256: entry.sha256, envelopePath: entry.envelopePath, checkpointPath: entry.checkpointPath } : record.brief;
      const next = withTask(c, id, { status: 'submitted', brief });
      // NOTE: an amendment-added prerequisite parks the submission; schedule admits it once the producer is accepted.
      if ((planTask(c, id)?.prerequisites ?? []).some((other) => c.tasks[other]?.status !== 'accepted')) return schedule(withTask(next, id, { parked: { envelopePath: event.envelopePath } }));
      return checkEnvelope(next, id, event.envelopePath);
    }
    case 'failed': {
      if (record.removed) return schedule(retireTask(c, id, `writer failed: ${event.detail}`));
      const reason = `${event.model}: ${event.detail}`;
      if (record.modelIndex + 1 >= (c.writer?.models.length ?? 0)) return taskFailed(c, id, `Writer cascade exhausted: ${reason}`);
      return checkout(withTask(c, id, { status: 'submitted', handle: null }), 'relaunch', 'reset', { name: taskWorktreeName(record), revision: record.input }, id, reason);
    }
    case 'cancelled': return record.removed ? schedule(retireTask(c, id, 'cancellation attested')) : taskFailed(c, id, 'Writer cancelled.');
    default: return never(event, 'write receipt');
  }
}

type AmendOrigin = Extract<ImplementState, { tag: 'tasks' | 'request-decision' | 'integration-conflict' | 'failure' }>;
type RevisionEvent = AmendEvent | ReplacePlanEvent;

/** Structural checks shared by `AMEND` and `REPLACE_PLAN`; summary checks run in `reconcilePlan`. */
function revisionFieldsError(c: Context, event: RevisionEvent): string | null {
  if (c.phase !== 'tasks' || !c.plan || !c.planHash || !c.integration) return `event.type: ${event.type} applies only during the task phase.`;
  if (!nonEmpty(event.rationale)) return 'event.rationale: explain the revision.';
  if (!Array.isArray(event.notify) || event.notify.some((row) => !isRecord(row) || !nonEmpty(row.task) || !nonEmpty(row.notice)) || new Set(event.notify.map((row) => row.task)).size !== event.notify.length) return 'event.notify: name each notified writer once with a non-empty notice.';
  if (event.retire !== undefined && (!Array.isArray(event.retire) || new Set(event.retire.map((row) => row.task)).size !== event.retire.length)) return 'event.retire: name each retired writer once.';
  if (event.by !== undefined && (!isRecord(event.by) || event.by.by !== 'user' || !nonEmpty(event.by.quote))) return 'event.by: a gated revision carries { by: "user", quote }.';
  return null;
}

function revisionPlanPath(c: Context, id: string): string {
  const sessionDir = typeof c.run.overrides['sessionDir'] === 'string' ? c.run.overrides['sessionDir'].replace(/[\\/]+$/, '') : /[\\/]/.test(c.planPath) ? c.planPath.replace(/[\\/][^\\/]*$/, '') : '';
  // NOTE: design increments share one session directory; namespace by the governing plan and design revision so increments never share a file.
  const origin = (c.amendments.find((row) => row.kind !== 'replace')?.path ?? c.planPath).replace(/^.*[\\/]/, '').replace(/\.plan\.md$/i, '').replace(/(?:\.r\d+)?\.amend-\d+$/, '');
  const revision = c.designBinding ? `.r${c.designBinding.revisionIndex ?? 0}` : '';
  const file = `${origin}${revision}.${id}.plan.md`;
  return sessionDir ? `${sessionDir}/${file}` : file;
}

/**
 * Binds the run to a revised plan through one reconcile operation. Work is never discarded: accepted tasks keep their
 * integration, retired tasks move to the archive, changed criteria move their evidence to history, and accepted tasks
 * that gained an unfinished prerequisite get pending validation obligations. An open `conflict` blocks rechecks.
 */
function commitRevision(c: Context, event: RevisionEvent, revised: Extract<RevisedPlan, { ok: true }>, conflict: Conflict | null): { ok: true; c: Context } | { ok: false; error: string } {
  const err = (error: string) => ({ ok: false as const, error });
  const field = event.type === 'AMEND' ? 'event.delta' : 'event.path';
  if (c.designBinding) {
    const defects = validateDesignTraceability(revised.plan, c.designBinding);
    if (defects.length) return err(`${field}: revised plan breaks design traceability: ${defects.join('; ')}`);
  }
  const before = c.plan!;
  const bound: Context = { ...c, plan: revised.plan, planHash: revised.hash };
  const after = bound.plan!;
  const kind = event.type === 'AMEND' ? 'amend' as const : 'replace' as const;
  const id = `${kind}-${c.amendments.filter((row) => (row.kind ?? 'amend') === kind).length + 1}`;
  const result = reconcilePlan({ tasks: c.tasks, before, after, reconciliation: event.reconciliation, notify: event.notify.map((row) => row.task), retire: event.retire ?? [], conflictTask: conflict?.task ?? null, revision: id });
  if (!result.ok) return err(`${event.reconciliation ? 'event.reconciliation' : field}: ${result.error}`);
  const prerequisites = (plan: ParsedPlan) => [...(plan.tasks.find((task) => task.id === conflict?.task)?.prerequisites ?? [])].sort().join(',');
  if (conflict && after.tasks.some((task) => task.id === conflict.task) && prerequisites(before) !== prerequisites(after)) return err(`${field}: resolve or discard the open integration conflict before changing ${conflict.task} prerequisites.`);
  if (result.gates.length && !event.by) return err(`event.by: this revision needs the user's quote: ${result.gates.join('; ')}.`);
  const planPath = event.type === 'AMEND' ? revisionPlanPath(c, id) : event.path;
  const same = (a: PlanCriterion | undefined, b: PlanCriterion | undefined) => !!a && !!b && JSON.stringify({ ...a, line: 0 }) === JSON.stringify({ ...b, line: 0 });
  const kept = (key: string) => same(before.criteria.find((item) => item.id === key), after.criteria.find((item) => item.id === key));
  const evidence = Object.fromEntries(Object.entries(c.evidence).flatMap(([key, row]) => kept(key) ? [[key, { ...row, planHash: revised.hash }]] : []));
  // NOTE: changed or retired criteria keep their evidence as history; it is provenance, never relied on.
  const superseded = Object.entries(c.evidence).filter(([key]) => !kept(key)).map(([, row]) => row);
  // NOTE: a retired running task that never launched has no writer to cancel, so its record goes straight to the archive.
  const unlaunched = Object.values(result.tasks).filter((row) => row.removed && !row.handle);
  const tasks = Object.fromEntries(Object.entries(result.tasks).filter(([, row]) => !(row.removed && !row.handle)));
  const removed = result.summary.retired;
  // NOTE: paths each surviving task lost; a conflict discard must bind to a recorded removal or one of these narrowings.
  const dropped = Object.fromEntries(after.tasks.flatMap((task) => {
    const lost = (before.tasks.find((row) => row.id === task.id)?.paths ?? []).filter((file) => !task.paths.includes(file));
    return lost.length ? [[task.id, lost]] : [];
  }));
  const record: AmendmentRecord = {
    id, kind, delta: event.type === 'AMEND' ? event.delta : [], notify: event.notify, rationale: event.rationale, by: event.by ?? null,
    beforeHash: c.planHash!, afterHash: revised.hash, removed, dropped, path: planPath, text: revised.text, reconciliation: result.summary,
    ...(event.retire?.length ? { retire: event.retire } : {}),
  };
  let next: Context = {
    ...bound, planPath, tasks, evidence, evidenceHistory: [...(c.evidenceHistory ?? []), ...superseded],
    retiredTasks: [...(c.retiredTasks ?? []), ...result.archived, ...unlaunched.map((row) => ({ ...row, retiredBy: id }))],
    planRejection: null,
    amendments: [...c.amendments, record], amended: [],
    rebriefQueue: event.notify.filter((row) => result.rebrief.includes(row.task)), reverifyQueue: [...new Set([...c.reverifyQueue.filter((id) => tasks[id]?.status === 'accepted'), ...result.validate, ...result.reverify])],
    revisions: [...c.revisions, { artifact: 'plan', reason: event.rationale, beforeHash: c.planHash!, afterHash: revised.hash, rebind: { retained: result.summary.retained, pending: Object.keys(tasks).filter((key) => tasks[key]?.status === 'pending' && tasks[key] !== c.tasks[key]), removed } }],
  };
  // NOTE: a retained consumer of a new prerequisite stays accepted; its criteria are re-proved before delivery.
  const consumers = [...new Set(result.validate.flatMap((task) => after.tasks.find((row) => row.id === task)?.criteria ?? []))];
  if (consumers.length) next = refreshEvidence(next, consumers, id, `${id}: ${result.validate.join(', ')} gained an unfinished prerequisite; ${event.rationale}`);
  return { ok: true, c: next };
}

function prepareAmend(c: Context, event: AmendEvent, conflict: Conflict | null): { ok: true; c: Context } | { ok: false; error: string } {
  const fields = revisionFieldsError(c, event);
  if (fields) return { ok: false, error: fields };
  if (!Array.isArray(event.delta) || !event.delta.length) return { ok: false, error: 'event.delta: list at least one exact-text edit.' };
  if (event.delta.some((edit) => !isRecord(edit) || !['modify', 'remove', 'add'].includes(String(edit.kind)) || !nonEmpty(edit.target))) return { ok: false, error: 'event.delta: each edit needs kind modify|remove|add and a target.' };
  const amended = amendPlan(c.plan!, event.delta);
  if (!amended.ok) return { ok: false, error: `event.delta: ${amended.error}` };
  return commitRevision(c, event, amended, conflict);
}

function revisionResume(state: AmendOrigin, c: Context): AmendResume {
  // NOTE: a revision that retired the candidate under admission ends that admission; scheduling resumes instead.
  if (state.tag === 'request-decision' && (state.request.source === 'admission' || state.request.source === 'scope') && !c.tasks[state.request.task]) return { kind: 'schedule' };
  // A revision during a scope request re-checks the submitted envelope against the reconciled scope.
  if (state.tag === 'request-decision' && state.request.source === 'scope') return { kind: 'recheck', task: state.request.task };
  return state.tag === 'integration-conflict' ? { kind: 'conflict', conflict: state.conflict }
    : state.tag === 'request-decision' && state.request.source === 'admission' ? { kind: 'admit', task: state.request.task } : { kind: 'schedule' };
}

function applyAmend(state: AmendOrigin, event: AmendEvent): S {
  const prepared = prepareAmend(state.c, event, state.tag === 'integration-conflict' ? state.conflict : null);
  if (!prepared.ok) return stay(state);
  return continueAmend({ ...prepared.c, amendResume: revisionResume(state, prepared.c) });
}

/** Parses the replacement file; the prior plan file is never rewritten. */
function beginReplacement(state: AmendOrigin, event: ReplacePlanEvent): S {
  const { c, id } = effectId({ ...state.c, planRejection: null }, 'parse-artifact');
  return { state: { tag: 'plan-replacement', c, origin: { ...state, c } as AmendOrigin, event, effectId: id }, effects: [{ kind: 'parse-artifact', id, path: event.path, artifact: 'plan' }] };
}

/** A rejected replacement returns to its origin with every record unchanged; the frame shows the reason. */
function rejectReplacement(state: Extract<ImplementState, { tag: 'plan-replacement' }>, error: string): S {
  return stay({ ...state.origin, c: { ...state.c, planRejection: { path: state.event.path, error } } } as AmendOrigin);
}

function applyReplacement(state: Extract<ImplementState, { tag: 'plan-replacement' }>, payload: Readonly<Record<string, unknown>>): S {
  const revised = replacementPlan({ hash: String(payload['hash'] ?? ''), plan: payload['parsed'] ? asParsedPlan(payload['parsed']) : null, defects: Array.isArray(payload['defects']) ? payload['defects'] as { code?: unknown; message?: unknown }[] : [] });
  if (!revised.ok) return rejectReplacement(state, revised.error);
  if (revised.hash === state.event.expectedHash) return rejectReplacement(state, 'event.path: the replacement plan matches the current plan; send no revision.');
  const origin = state.origin;
  const committed = commitRevision(state.c, state.event, revised, origin.tag === 'integration-conflict' ? origin.conflict : null);
  if (!committed.ok) return rejectReplacement(state, committed.error);
  return continueAmend({ ...committed.c, amendResume: revisionResume(origin, committed.c) });
}

/** Regenerates notified briefs, re-verifies changed accepted tasks on the integration head, then resumes the origin. */
function continueAmend(c: Context): S {
  const [rebrief, ...rest] = c.rebriefQueue;
  if (rebrief) {
    const { c: next, id } = effectId({ ...c, rebriefQueue: rest }, 'write-brief');
    return { state: { tag: 'task-brief', c: next, effectId: id, task: rebrief.task, notice: rebrief.notice }, effects: [{ kind: 'write-brief', id, stage: 'task', input: taskBriefInput(next, next.tasks[rebrief.task] as TaskRecord, rebrief.notice) }] };
  }
  const resume = c.amendResume ?? { kind: 'schedule' as const };
  const done = { ...c, amendResume: null };
  if (resume.kind === 'admit') return continueAdmission(done, resume.task, () => admitCandidate(done, resume.task));
  if (resume.kind === 'recheck') {
    const envelopePath = done.tasks[resume.task]?.brief?.envelopePath;
    return continueAdmission(done, resume.task, () => envelopePath ? checkEnvelope(done, resume.task, envelopePath) : schedule(done));
  }
  if (resume.kind === 'conflict') return stay({ tag: 'integration-conflict', c: done, conflict: resume.conflict });
  return schedule(done);
}
function redReplay(c: Context, id: string): S {
  const record = c.tasks[id] as TaskRecord;
  if (!record.redRows.length) return greenVerify(c, id);
  const plan = c.plan!;
  return checkout(c, 'red', 'red', { name: worktreeName('red', id), base: record.input, checkpointPath: record.brief?.checkpointPath, candidate: record.candidate, permitted: taskTestPaths(plan, planTask(c, id)!), links: c.integration!.links, ignored: c.integration!.ignored }, id);
}

function redCommands(c: Context, id: string): { command: string; mapping: CommandMapping | null }[] | string {
  const plan = c.plan!, rows = (c.tasks[id] as TaskRecord).redRows;
  const mappings = commandMappings(plan);
  const commands = new Map<string, { command: string; mapping: CommandMapping | null }>();
  for (const criterion of taskRedCriteria(plan, planTask(c, id)!)) {
    const paths = [...new Set(rows.filter((row) => row.id === criterion.id).map((row) => row.path))];
    for (const verify of criterion.verify) {
      const mapping = mappings.find((entry) => entry.command === verify.command) ?? null;
      if (!mapping) return `RED command ${verify.command} has no criterion mapping.`;
      const narrowed = narrowToTests(verify.command, paths);
      if (!narrowed) return `RED command cannot be narrowed safely to ${paths.join(', ')}: ${verify.command}`;
      commands.set(narrowed, { command: narrowed, mapping });
    }
  }
  return [...commands.values()];
}

function stepCheckout(state: Extract<ImplementState, { tag: 'task-checkout' }>, event: Event): S {
  if (state.step === 'rebase' && !state.c.pendingReplay) {
    const source = state.conflict?.replay ?? { archivedName: state.reason!, base: state.c.integration!.base, head: state.c.integration!.head };
    state = { ...state, c: retainReplay(state.c, { rebase: true, archivedName: source.archivedName, replay: { base: source.base, head: source.head } }, state.conflict) };
  }
  if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) {
    const detail = `checkout ${state.step} failed: ${event.cls}: ${event.detail}`;
    // NOTE: a failed resolve may have committed; keep the conflict and retry the same effect so checkout replay recovers it.
    if (state.step === 'resolve' && state.conflict) return stay({ tag: 'integration-conflict', c: state.c, conflict: { ...state.conflict, retry: { id: state.effectId, input: state.input ?? {} }, evidence: [`Resolution attempt ${state.conflict.attempt + 1} failed: ${detail}`] } });
    // NOTE: reset is idempotent, so a failed discard keeps the conflict open and a later discard retries it.
    if (state.step === 'discard' && state.conflict) return stay({ tag: 'integration-conflict', c: state.c, conflict: { ...state.conflict, evidence: [`Discard failed: ${detail}`] } });
    return state.task && state.step !== 'reset' ? taskFailed(state.c, state.task, detail) : beginFailure(state.c, detail);
  }
  if (event.type !== 'CHECKOUT_DONE' || !answers(event, state.effectId)) return stay(state);
  const result = event.result, c = state.c, id = state.task as string;
  const text = (key: string): string => typeof result[key] === 'string' ? result[key] as string : '';
  const list = (key: string): string[] => Array.isArray(result[key]) ? (result[key] as unknown[]).filter((item): item is string => typeof item === 'string') : [];
  switch (state.step) {
    case 'init': {
      const manifest = isRecord(result['manifest']) ? result['manifest'] : {};
      const names = (key: string): string[] => Array.isArray(manifest[key]) ? manifest[key].filter((item): item is string => typeof item === 'string') : [];
      if (!text('base') || !text('path')) return beginFailure(c, 'Baseline checkout returned no revision.');
      return schedule({ ...c, integration: { path: text('path'), base: text('base'), head: text('base'), links: names('linked'), ignored: names('copiedIgnored') } });
    }
    case 'task': {
      const worktree = text('path');
      const name = worktree.split(/[\\/]/).at(-1);
      const record = c.tasks[id] as TaskRecord;
      const next = withTask(c, id, { worktree, input: text('revision'), worktreeNames: [...new Set([...(record.worktreeNames ?? []), ...(name ? [name] : [])])] });
      return captureTaskBaseline(next, id, false);
    }
    case 'relaunch': {
      const record = c.tasks[id] as TaskRecord;
      return stay({ tag: 'tasks', c: withTask(c, id, { status: 'running', attempt: record.attempt + 1, handle: null, modelIndex: record.modelIndex + 1 }) });
    }
    case 'scope-rebase': {
      if (result['conflict'] === true || !text('path') || !text('revision')) return taskFailed(c, id, `Scope rebase preserved the original draft but could not apply it cleanly: ${list('conflicts').join(', ') || text('detail') || 'invalid transfer result'}.`);
      return schedule(withTask(c, id, { worktree: text('path'), input: text('revision'), baseline: null, preserveDraft: true, handle: null, brief: null, candidate: null, integrated: null, redRows: [], status: 'pending' }));
    }
    case 'commit': return admitCandidate(withTask(c, id, { candidate: text('revision'), candidatePaths: list('paths') }), id);
    case 'red': {
      if (list('defects').length) return taskFailed(c, id, `RED checkpoint rejected: ${list('defects').join('; ')}`);
      const commands = redCommands(c, id);
      return typeof commands === 'string' ? taskFailed(c, id, commands) : taskVerify(c, id, 'red', text('path'), commands);
    }
    case 'integrate': {
      if (result['conflict'] === true) {
        // NOTE: the checkout keeps the conflicted cherry-pick in the integration tree; the orchestrator resolves it in place.
        const head = c.integration!.head;
        return stay({ tag: 'integration-conflict', c, conflict: { task: id, candidate: (c.tasks[id] as TaskRecord).candidate as string, base: head, head, attempt: 0, paths: list('paths'), detail: text('detail'), evidence: [] } });
      }
      const integrated = withTask(c, id, { integrated: text('revision') });
      const commands = taskVerifyCommands(c, id);
      return commands.length ? taskVerify(integrated, id, 'integration', c.integration!.path, commands, c.integration!.head) : accept(integrated, id, text('revision'));
    }
    case 'resolve': {
      const conflict = state.conflict!;
      // NOTE: out-of-scope paths that earlier attempts committed force discard and must be covered by its authorization; working-tree paths stay repairable.
      if (result['refused'] === 'out-of-scope' && list('retained').length) return stay({ tag: 'integration-conflict', c, conflict: { ...conflict, outside: [...new Set([...(conflict.outside ?? []), ...list('retained')])].sort(), evidence: [`Resolution attempt ${conflict.attempt + 1} refused (out-of-scope): earlier attempts committed ${list('retained').join(', ')} outside the current scope; discard it.`] } });
      if (nonEmpty(result['refused'])) return stay({ tag: 'integration-conflict', c, conflict: { ...conflict, evidence: [`Resolution attempt ${conflict.attempt + 1} refused (${String(result['refused'])}): ${text('detail')}${list('paths').length ? ` [${list('paths').join(', ')}]` : ''}`] } });
      if (!text('revision')) return beginFailure(c, 'Conflict resolution returned no revision.');
      const scope = new Set(conflictScope(c, conflict));
      // NOTE: check the whole retained delta from the pre-pick base; earlier attempts' commits stay in the tree.
      const outside = [...new Set([...list('paths'), ...list('retained')])].filter((file) => !scope.has(file)).sort();
      if (outside.length) return stay({ tag: 'integration-conflict', c, conflict: { ...conflict, attempt: conflict.attempt + 1, head: text('revision'), outside, evidence: [`Resolution attempt ${conflict.attempt + 1} at ${text('revision')} changes paths outside the current scope: ${outside.join(', ')}; discard it.`] } });
      return verifyResolution(c, { ...conflict, attempt: conflict.attempt + 1 }, text('revision'), list('paths'));
    }
    case 'discard': {
      const conflict = state.conflict!;
      const integration = { ...c.integration!, head: conflict.base };
      const record = c.tasks[conflict.task];
      const next = record ? withTask({ ...c, integration }, conflict.task, { status: 'pending', handle: null, baseline: null, brief: null, briefs: [], candidate: null, candidatePaths: [], admittedPaths: [], integrated: null, redRows: [], preserveDraft: false, parked: null }) : { ...c, integration };
      return schedule(next);
    }
    case 'observe': {
      return observedBoundary(c, state.observe ?? { durable: [], rebind: [] }, isRecord(result['observed']) ? result['observed'] : {});
    }
    case 'trim': {
      const refused = Array.isArray(result['refused']) ? (result['refused'] as unknown[]).filter(isRecord).map((row) => `${String(row['path'])} (${String(row['reason'])})`) : [];
      if (refused.length) return beginFailure(c, `Transient trim refused: ${refused.join('; ')}.`);
      const trimmed = [...new Set([...list('trimmed'), ...list('already')])].sort();
      const next = markMutation({ ...c, trimmed }, trimmed);
      const snap = effectId(next, 'snapshot');
      return { state: { tag: 'trim-snapshot', c: snap.c, effectId: snap.id }, effects: [{ kind: 'snapshot', id: snap.id, since: c.lastFingerprint }] };
    }
    case 'reset': return taskFailed(c, id, state.reason ?? 'Integration verification failed.');
    case 'rebase': {
      // NOTE: a replay conflict leaves the caller tree untouched and the prior integration archived; no task is re-pended.
      const manifest = isRecord(result['manifest']) ? result['manifest'] : {};
      const names = (key: string): string[] => Array.isArray(manifest[key]) ? manifest[key].filter((item): item is string => typeof item === 'string') : [];
      if (!text('base') || !text('head') || !text('path')) return beginFailure(c, 'Delivery rebase returned no revision.');
      const integration = { path: text('path'), base: text('base'), head: text('head'), links: names('linked'), ignored: names('copiedIgnored') };
      const sourceArchive = c.pendingReplay ? { archivedName: c.pendingReplay.input.archivedName, ...c.pendingReplay.input.replay } : state.conflict?.replay ?? { archivedName: state.reason!, base: c.integration!.base, head: c.integration!.head };
      const archive = { archivedName: sourceArchive.archivedName, base: sourceArchive.base, head: sourceArchive.head };
      const archivedIntegrations = [...(c.archivedIntegrations ?? []).filter((row) => row.archivedName !== archive.archivedName), archive];
      if (result['conflict'] === true) {
        const owners = replayOwnership(c, text('candidate'), list('candidatePaths'), list('paths'));
        if (!owners) return stay({ tag: 'failed', c: { ...c, integration, archivedIntegrations }, summary: `Delivery replay retained ${text('candidate')} but its accepted ownership cannot be proved; preserve the active pick and archive for scoped reconciliation.` });
        const replay = { ...archive, owners };
        const task = owners[0]!.task;
        const conflict: Conflict = { task, candidate: text('candidate'), base: integration.head, head: integration.head, attempt: 0, paths: list('paths'), detail: text('detail'), evidence: [], replay };
        return stay({ tag: 'integration-conflict', c: { ...c, integration, archivedIntegrations, pendingReplay: { ...c.pendingReplay!, conflict } }, conflict });
      }
      const rows = Array.isArray(result['replayed']) ? result['replayed'] : [];
      const valid = rows.every((row) => isRecord(row) && nonEmpty(row['from']) && nonEmpty(row['to']));
      const replayed = new Map(valid ? rows.map((row) => [(row as Record<string, string>)['from']!, (row as Record<string, string>)['to']!]) : []);
      if (!valid || replayed.size !== rows.length || c.pendingReplay!.sources.some((source) => !replayed.has(source)) || replayed.get(archive.head) !== integration.head) return beginFailure(c, 'Delivery replay returned an incomplete or inconsistent commit mapping; retry the retained archive.');
      const remap = (record: TaskRecord) => {
        const to = record.integrated ? replayed.get(record.integrated) : undefined;
        return to ? { ...record, integrated: to, integratedHistory: [...(record.integratedHistory ?? []), record.integrated as string] } : record;
      };
      const tasks = Object.fromEntries(Object.entries(c.tasks).map(([key, record]) => [key, remap(record)]));
      const retiredTasks = (c.retiredTasks ?? []).map((record) => ({ ...remap(record), retiredBy: record.retiredBy }));
      const { pendingReplay: _completedReplay, ...completed } = c;
      return schedule({ ...completed, tasks, retiredTasks, integration, archivedIntegrations, reverifyQueue: [...new Set([...c.reverifyQueue, ...Object.values(tasks).filter((record) => record.status === 'accepted').map((record) => record.id)])] });
    }
    case 'deliver': {
      if (list('conflicts').length) {
        const next = effectId(c, 'snapshot');
        return { state: { tag: 'checking-host-event', c: next.c, parent: state, parked: event, effectId: next.id }, effects: [{ kind: 'snapshot', id: next.id, since: c.lastFingerprint }] };
      }
      const delivered = [...list('transferred'), ...list('already')];
      const blobs = isRecord(result['blobs']) ? Object.fromEntries(Object.entries(result['blobs']).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
      const names = [...new Set([...[...Object.entries(c.tasks), ...(c.retiredTasks ?? []).map((record) => [record.id, record] as const)].flatMap(([task, record]) => [worktreeName('task', task), worktreeName('red', task), ...(record.worktreeNames ?? []), ...(record.worktree ? [taskWorktreeName(record)] : [])]), 'integration'])];
      return checkout({ ...markMutation(c, delivered), phase: 'delivered', deliveredBlobs: blobs, changedPaths: [...new Set([...c.changedPaths, ...delivered])].sort() }, 'cleanup', 'cleanup', { names, links: c.integration!.links });
    }
    case 'cleanup': {
      const { c: next, id: snapshotId } = effectId(c, 'snapshot');
      return { state: { tag: 'delivered-snapshot', c: next, effectId: snapshotId }, effects: [{ kind: 'snapshot', id: snapshotId, since: c.lastFingerprint }] };
    }
    default: return never(state.step, 'checkout step');
  }
}

function stepTasks(state: Extract<ImplementState, { tag: 'tasks' | 'plan-replacement' | 'task-brief' | 'task-prewrite-snapshot' | 'task-envelope' | 'task-verify' | 'delivered-snapshot' }>, event: Event): S {
  switch (state.tag) {
    case 'task-prewrite-snapshot': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return taskFailed(state.c, state.task, `pre-write snapshot failed: ${event.cls}: ${event.detail}`);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId) || !isFingerprint(event.fingerprint)) return stay(state);
      const next = withTask(state.c, state.task, { baseline: event.fingerprint });
      const { c, id } = effectId(next, 'write-brief');
      return { state: { tag: 'task-brief', c, effectId: id, task: state.task }, effects: [{ kind: 'write-brief', id, stage: 'task', input: taskBriefInput(next, next.tasks[state.task] as TaskRecord) }] };
    }
    case 'task-brief': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return state.notice !== undefined ? beginFailure(state.c, `Amended brief for ${state.task} failed: ${event.cls}: ${event.detail}`) : taskFailed(state.c, state.task, `write-brief failed: ${event.cls}: ${event.detail}`);
      if (event.type !== 'BRIEF_READY' || !answers(event, state.effectId)) return stay(state);
      if (event.stage !== 'task' || !nonEmpty(event.path) || !/^sha256:[a-f0-9]{64}$/.test(event.sha256) || !nonEmpty(event.envelopePath)) return taskFailed(state.c, state.task, 'write-brief returned a mismatched stage, invalid hash, or missing envelope path.');
      const brief = { path: event.path, sha256: event.sha256, envelopePath: event.envelopePath, checkpointPath: checkpointPathOf(event.envelopePath) };
      const entry: TaskBriefHistory = { ...brief, scope: taskScope(state.c.plan!, planTask(state.c, state.task)!) };
      if (state.notice !== undefined) {
        // NOTE: a regenerated brief keeps the live writer; earlier briefs stay valid while their scope equals the current one.
        const record = state.c.tasks[state.task] as TaskRecord;
        const c = withTask(state.c, state.task, { brief, briefs: [...(record.briefs ?? []), entry] });
        return continueAmend({ ...c, amended: [...c.amended, { task: state.task, briefPath: event.path, briefHash: event.sha256, notice: state.notice }] });
      }
      return schedule(withTask(state.c, state.task, { status: 'running', handle: null, brief, briefs: [entry] }));
    }
    case 'tasks': {
      if (event.type === 'WRITE_RECEIPT' && typeof event.task === 'string') return taskReceipt(state.c, event as TaskReceipt);
      if (event.type === 'REQUEST') return requestDecision(state.c, { task: event.task, attempt: event.attempt, need: event.need, paths: [...event.paths], rationale: event.rationale, source: 'writer' });
      if (event.type === 'AMEND') return applyAmend(state, event);
      if (event.type === 'REPLACE_PLAN') return beginReplacement(state, event);
      return stay(state);
    }
    case 'plan-replacement': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return rejectReplacement(state, `parse-artifact failed: ${event.cls}: ${event.detail}`);
      if (event.type !== 'ARTIFACT_PARSED' || !answers(event, state.effectId)) return stay(state);
      if (event.kind !== 'plan') return rejectReplacement(state, 'event.path: the replacement artifact is not a plan.');
      return applyReplacement(state, { hash: event.hash, parsed: event.parsed, defects: event.defects });
    }
    case 'task-envelope': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return taskFailed(state.c, state.task, `envelope check failed: ${event.cls}: ${event.detail}`);
      if (event.type !== 'ENVELOPE_CHECKED' || !answers(event, state.effectId)) return stay(state);
      return admitEnvelope(state.c, state.task, event);
    }
    case 'task-verify': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return failVerify(state, `${state.purpose} verification failed: ${event.cls}: ${event.detail}`);
      if (event.type !== 'VERIFY_DONE' || !answers(event, state.effectId)) return stay(state);
      const rows = recordsFrom(resultEventRows(event), state.c, state.purpose === 'red' ? 'red' : 'scoped');
      if (!rows) return failVerify(state, `${state.purpose} verification returned malformed command results.`);
      if (state.purpose === 'resolution' || state.purpose === 'reverify') {
        const task = state.task;
        const failing = rows.filter((row) => row.status === 'regression');
        if (!failing.length) return state.purpose === 'resolution' ? completeResolution(state.c, state.conflict!) : continueAmend(transientEvidence({ ...state.c, reverifyQueue: state.c.reverifyQueue.filter((id) => id !== task) }, task, state.c.integration!.head));
        if (state.purpose === 'resolution') state = { ...state, conflict: { ...state.conflict!, failed: [...new Set([...(state.conflict!.failed ?? []), ...failing.map((row) => row.command)])] } };
        return failVerify(state, failing.map((row) => `${row.command} (${row.failureId ?? row.logPath})`).join('; '));
      }
      if (state.purpose === 'red') {
        const defects = actualRedDefects(state.c, (state.c.tasks[state.task] as TaskRecord).redRows, rows);
        return defects.length ? taskFailed(state.c, state.task, `RED replay rejected: ${defects.join('; ')}`) : greenVerify(state.c, state.task);
      }
      const regression = rows.filter((row) => row.status === 'regression');
      if (regression.length) return failVerify(state, `${state.purpose === 'green' ? 'Task' : 'Integration'} verification failed: ${regression.map((row) => `${row.command} (${row.failureId ?? row.logPath})`).join('; ')}`);
      return state.purpose === 'green' ? integrate(state.c, state.task) : accept(state.c, state.task, (state.c.tasks[state.task] as TaskRecord).integrated as string);
    }
    case 'delivered-snapshot': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return startFailureFromEffect(state.c, event.cls, event.detail);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId) || !isFingerprint(event.fingerprint)) return stay(state);
      return continueAfterDelivery({ ...state.c, lastFingerprint: event.fingerprint });
    }
    default: return never(state, 'task state');
  }
}

/** Integration failures restore the previous accepted revision before the task is marked failed. */
function failVerify(state: Extract<ImplementState, { tag: 'task-verify' }>, reason: string): S {
  // NOTE: a failed resolution check keeps the committed resolution; the next `resolve` repairs it as attempt n+1.
  if (state.purpose === 'resolution') return stay({ tag: 'integration-conflict', c: state.c, conflict: { ...state.conflict!, evidence: [`Resolution attempt ${state.conflict!.attempt} at ${state.conflict!.head} failed checks: ${reason}`] } });
  if (state.purpose === 'reverify') {
    return beginFailure(state.c, `Retained ${state.task} re-verification failed: ${reason}. Retry checks after repair; accepted history and writer attempts remain unchanged.`);
  }
  if (state.purpose !== 'integration' || !state.previous) return taskFailed(state.c, state.task, reason);
  return checkout(state.c, 'reset', 'reset', { name: 'integration', revision: state.previous }, state.task, reason);
}

/** Failure-decision retry: tasks phase re-pends retryable failed tasks; after delivery the final gates rerun. */
function retryAfterFailure(c: Context): S {
  if (c.pendingReplay) return resumeReplay(c);
  if (c.phase === 'delivered') return startGeneratedOrFinal(c);
  if (c.phase === 'setup') return !c.plan ? parsePlan(c, 'initial') : c.approval ? beginPostApproval(c) : beginBaseline(c);
  const tasks = Object.fromEntries(Object.entries(c.tasks).map(([id, record]) => [id, record.status === 'failed' && record.failures < MAX_WRITE_ATTEMPTS ? { ...record, status: 'pending' as const, amendment: null, preserveDraft: record.worktree !== null } : record]));
  return beginTasks({ ...c, tasks });
}

function markMutation(c: Context, paths: readonly string[]): Context {
  const epoch = c.mutationEpoch + 1;
  const criteria = c.plan ? c.plan!.criteria : [];
  const criterionMutation = { ...c.criterionMutation };
  for (const criterion of criteria) if (!paths.length || criterion.changes.some((file) => paths.includes(file))) criterionMutation[criterion.id] = epoch;
  return { ...c, mutationEpoch: epoch, criterionMutation };
}

function beginVerify(c0: Context, purpose: 'red' | 'scoped' | 'final' | 'generated', commands: readonly { command: string; mapping?: CommandMapping | null; reuse?: VerifyRecord | null }[], cwd?: string): { c: Context; id: string; effect: Effect } {
  const mappings = commandMappings(c0.plan!);
  const prepared: VerifyCommand[] = commands.map((item) => {
    const mapping = item.mapping ?? mappings.find((row) => row.command === item.command) ?? null;
    const command = commandEffect(item.command, mapping, scopePaths(c0), environmentKey(c0));
    return { ...command, planHash: c0.planHash, ...(item.reuse && item.reuse.exit === 0 && item.reuse.mutationEpoch === c0.mutationEpoch ? { reuse: { inputFingerprint: item.reuse.inputFingerprint, exit: item.reuse.exit, logPath: item.reuse.logPath } } : {}) };
  });
  const { c, id } = effectId(c0, 'verify');
  return { c, id, effect: { kind: 'verify', id, purpose, commands: prepared, ...(cwd ? { cwd } : {}) } };
}

// narrowToTests rejects quotes, expansions, and a trailing backslash (escapes the closing quote on Windows), so plain quoting is safe.
function quoteArg(value: string): string { return `"${value}"`; }

function narrowToTests(command: string, paths: readonly string[]): string | null {
  if (!paths.length || /[;&|<>`$\r\n]/.test(command) || paths.some((file) => /["`$%\r\n]|\\$/.test(file))) return null;
  const tokenPattern = /--[a-z-]+=(?:"[^"\n]*"|'[^'\n]*')|"[^"\n]*"|'[^'\n]*'|[^\s"']+/g;
  const tokens: string[] = command.match(tokenPattern) ?? [];
  if (command.replace(tokenPattern, '').trim()) return null;
  if (!/^node(?:\.exe)?$/i.test(tokens[0] ?? '') || !tokens.includes('--test')) return null;
  const kept = [tokens[0] as string];
  const valued = new Set(['--import', '--require', '-r', '--loader', '--test-reporter', '--test-reporter-destination', '--test-name-pattern', '--test-concurrency', '--test-shard', '--test-timeout', '--conditions']);
  const boolean = new Set(['--test', '--test-only', '--test-force-exit', '--experimental-strip-types', '--no-warnings']);
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index] as string;
    if (token === '--') { kept.push(token); break; }
    if (valued.has(token)) {
      const value = tokens[++index];
      if (!value || value.startsWith('-')) return null;
      kept.push(token, value);
    } else if (boolean.has(token) || /^--[a-z-]+=/.test(token)) kept.push(token);
    else if (token.startsWith('-')) return null;
  }
  return `${kept.join(' ')} ${paths.map(quoteArg).join(' ')}`;
}

function actualRedDefects(c: Context, rows: readonly RedMatrixRow[], records: readonly VerifyRecord[]): string[] {
  const defects: string[] = [];
  const criteria = activeRedCriteria(c);
  for (const row of rows) {
    const criterion = criteria.find((item) => item.id === row.id);
    const commands = criterion?.verify.map((item) => narrowToTests(item.command, [row.path])).filter((command): command is string => command !== null) ?? [];
    const results = records.filter((record) => commands.includes(record.command));
    if (!results.length) defects.push(`${row.id} has no RED verification result.`);
    if (results.some((record) => record.exit !== 0 && record.loadError)) defects.push(`${row.id} RED run contains a load, syntax, or missing-file error.`);
    const observed = new Set(results.flatMap((record) => record.failedTests));
    if (!row.tests.every((identifier) => observed.has(identifier))) defects.push(`${row.id} expected failures were not observed: ${row.tests.filter((identifier) => !observed.has(identifier)).join(', ')}. Observed: ${[...observed].join('; ') || 'none'}.`);
    if (!results.some((record) => record.exit !== 0 && record.failedTests.some((identifier) => identifier.startsWith('test:')))) defects.push(`${row.id} did not produce a discriminating asserted test failure.`);
    const baselineCommands = criterion?.verify.map((item) => item.command) ?? [];
    const baseline = c.baseline.filter((record) => baselineCommands.includes(record.command) && record.exit !== 0);
    const redFailures = results.filter((record) => record.exit !== 0 && record.failureId !== null);
    if (baseline.length && redFailures.length && redFailures.some((red) => baseline.some((prior) => prior.failedTests.some((identifier) => red.failedTests.includes(identifier)))) && criterion?.preExisting !== true) {
      defects.push(`${row.id} collides with a pre-existing baseline failure; declare Pre-existing: yes only when this is the intended signal.`);
    }
  }
  return defects;
}

function askEvidence(c0: Context, verify: readonly VerifyRecord[]): S {
  const ids = c0.plan!.criteria.filter((criterion) => {
    if (transientCurrent(c0, criterion.id)) return false;
    const evidence = c0.evidence[criterion.id];
    return !evidence || evidence.planHash !== c0.planHash || evidence.mutationEpoch < (c0.criterionMutation[criterion.id] ?? 0);
  }).map((criterion) => criterion.id);
  return ids.length ? stay({ tag: 'evidence', c: c0, purpose: 'final', ids, verify }) : finishEvidence(c0, verify);
}

function continueAfterDelivery(c: Context): S {
  return c.concerns.length ? stay({ tag: 'concerns', c, items: c.concerns }) : startCodeReview(c);
}

function startCodeReview(c0: Context): S {
  const built = reviewSpecFromRun(c0.run, 'code', '', c0.governingSpec ?? null);
  if (!built.ok) return beginFailure(c0, built.error);
  const plan = c0.plan!;
  const governing = { planPath: c0.planPath, walkthroughPath: walkthroughPathOf(typeof c0.run.overrides['sessionDir'] === 'string' ? c0.run.overrides['sessionDir'] : '.', typeof c0.run.overrides['artifactSlug'] === 'string' ? c0.run.overrides['artifactSlug'] : slugOf(c0.designBinding?.path ?? c0.run.argument, 'implement'), c0.designBinding?.increment), ...(c0.designBinding ? { designPath: c0.designBinding.path } : {}), criteria: plan.criteria.map((row) => ({ id: row.id, changes: row.changes, verify: row.verify.map((v) => v.command) })) };
  const baseContext = built.spec.context ?? c0.run.argument;
  const result = beginReview({ ...built.spec, governing, context: `${baseContext}\nFinal focus paths: ${[...new Set([...c0.changedPaths, ...c0.finalFocus])].join(', ') || 'governed implementation paths'}` }, `${c0.machinePath ?? 'implement'}.code-review`, c0.counters);
  return fromCodeReview(c0, result);
}

function fromCodeReview(c0: Context, result: Step<ReviewState>): S {
  const review = result.state;
  const c = { ...c0, counters: reviewCtxCounters(review, c0.counters), codeReview: review };
  switch (review.tag) {
    case 'settled': case 'skipped': case 'empty': return startGeneratedOrFinal(c);
    case 'failed': return beginFailure(c, `code review failed: ${review.detail}`);
    case 'escalated': return beginFailure(c, `code review did not settle: ${review.tag}`);
    case 'booting': case 'prepare': case 'wave': case 'native': case 'rule': case 'decide-needs-user': case 'fix': case 'fix-verify':
    case 'decide-escalation': case 'decide-opt-in': case 'decide-verification': case 'target-check': case 'pin-check': return { state: { tag: 'code-review', c, review }, effects: result.effects };
    default: return never(review, 'code review state');
  }
}

function startGeneratedOrFinal(c0: Context): S {
  const { c, id } = effectId(c0, 'snapshot');
  return { state: { tag: 'post-review-snapshot', c, effectId: id }, effects: [{ kind: 'snapshot', id, since: c0.lastFingerprint }] };
}

function runGeneratedOrFinal(c0: Context): S {
  const generated = generatedCommands(c0.plan!);
  if (!generated.length) return beginTrimOrFinal(c0);
  const batch = beginVerify(c0, 'generated', generated.map((item) => ({ command: item.command, mapping: null })));
  const before = c0.lastFingerprint;
  if (!before) return beginFailure(c0, 'No tree fingerprint is available before generated verification.');
  return { state: { tag: 'generated-verify', c: batch.c, effectId: batch.id, count: generated.length, before }, effects: [batch.effect] };
}

/**
 * Observes the caller files the review boundary changed: a durable criterion file that disappeared fails the run, and a
 * transient test an applied review fix changed rebinds trim to its verified post-review blob. Other trim bindings stay.
 */
function observeReviewBoundary(c: Context, changed: readonly string[]): S {
  const plan = c.plan!;
  const deleting = new Set(plan.changes.filter((row) => row.action === 'DELETE').map((row) => row.path));
  const durable = [...new Set(plan.criteria.filter((row) => row.retain !== 'transient').flatMap((row) => row.changes))].filter((file) => changed.includes(file) && !deleting.has(file));
  const fixed = new Set(c.reviewFixed ?? []);
  const rebind = c.trimmed === null ? trimmable(c).filter((file) => changed.includes(file) && fixed.has(file)) : [];
  const observe = [...new Set([...durable, ...rebind])].sort();
  if (!observe.length) return runGeneratedOrFinal(c);
  const { c: next, id } = effectId(c, 'checkout');
  return { state: { tag: 'task-checkout', c: next, effectId: id, step: 'observe', task: null, reason: null, observe: { durable, rebind } }, effects: [{ kind: 'checkout', id, op: 'trim', input: { observe } }] };
}

function observedBoundary(c: Context, input: { durable: readonly string[]; rebind: readonly string[] }, observed: Readonly<Record<string, unknown>>): S {
  const blob = (file: string): string | null | undefined => observed[file] === null ? null : typeof observed[file] === 'string' ? observed[file] as string : undefined;
  const unknown = [...input.durable, ...input.rebind].filter((file) => blob(file) === undefined);
  if (unknown.length) return beginFailure(c, `Review boundary observation omitted ${unknown.join(', ')}.`);
  const deleted = input.durable.filter((file) => blob(file) === null);
  if (deleted.length) return beginFailure(c, `A review fix deleted files of durable criteria: ${deleted.join(', ')}.`);
  const deliveredBlobs = { ...c.deliveredBlobs };
  for (const file of input.rebind) {
    const value = blob(file);
    if (value) deliveredBlobs[file] = value; else delete deliveredBlobs[file];
  }
  return runGeneratedOrFinal({ ...c, deliveredBlobs });
}

/** Test files listed only by transient criteria whose delivered blob is known; production paths are never trimmed. */
function trimmable(c: Context): string[] {
  const plan = c.plan!;
  const files = new Set(plan.criteria.flatMap((row) => row.changes.filter(isTestPath)));
  return [...files].filter((file) => !!c.deliveredBlobs[file] && plan.criteria.filter((row) => row.changes.includes(file)).every((row) => row.retain === 'transient')).sort();
}

/** Drops a command mapping only when every owning criterion is transient with all its test files trimmed; `[FINAL]` and durable commands stay. */
function finalMappings(c: Context): CommandMapping[] {
  const plan = c.plan!, trimmed = new Set(c.trimmed ?? []);
  const gone = (id: string): boolean => {
    const row = plan.criteria.find((item) => item.id === id);
    const tests = row?.changes.filter(isTestPath) ?? [];
    return row?.retain === 'transient' && tests.length > 0 && tests.every((file) => trimmed.has(file));
  };
  return commandMappings(plan).filter((mapping) => mapping.final || !mapping.criteria.length || !mapping.criteria.every(gone));
}

/** Trims transient tests from the caller checkout once, after review and generated commands, before the final gate. */
function beginTrimOrFinal(c: Context): S {
  if (c.trimmed !== null) return startFinalVerify(c);
  const files = trimmable(c);
  if (!files.length) return startFinalVerify({ ...c, trimmed: [] });
  const retained = finalMappings({ ...c, trimmed: files }).map((mapping) => mapping.command);
  const named = files.filter((file) => retained.some((command) => command.includes(file)));
  if (named.length) return beginFailure(c, `Transient trim rejected: retained commands name trimmed files ${named.join(', ')}.`);
  return checkout(c, 'trim', 'trim', { files: files.map((file) => ({ path: file, hash: c.deliveredBlobs[file] })), allowed: files });
}

function startFinalVerify(c0: Context): S {
  const mappings = finalMappings(c0);
  const batch = beginVerify(c0, 'final', mappings.map((mapping) => ({ command: mapping.command, mapping, reuse: c0.records[mapping.command] ?? null })));
  const before = c0.lastFingerprint;
  if (!before) return beginFailure(c0, 'No tree fingerprint is available before final verification.');
  return { state: { tag: 'final-verify', c: batch.c, effectId: batch.id, before }, effects: [batch.effect] };
}

function finishEvidence(c: Context, verify: readonly VerifyRecord[]): S {
  const plan = c.plan!;
  const stale = plan.criteria.filter((criterion) => {
    if (transientCurrent(c, criterion.id)) return false;
    const item = c.evidence[criterion.id];
    return !item || !(item['outcome'] === 'pass' || item['outcome'] === 'waived' && isRecord(item['waiver']) && item['waiver']['by'] === 'user') || item.planHash !== c.planHash || item.mutationEpoch < (c.criterionMutation[criterion.id] ?? 0);
  });
  if (stale.length) return stay({ tag: 'evidence', c, purpose: 'final', ids: stale.map((criterion) => criterion.id), verify });
  const summary = `${plan.criteria.length}/${plan.criteria.length} criteria evidenced; ${Object.keys(c.records).filter((key) => !key.startsWith('__')).length} verification records current.`;
  return stay({ tag: 'complete', c, summary });
}

function recordEvidence(c: Context, ids: readonly string[], values: Readonly<Record<string, unknown>>, waiver?: { by: 'user'; quote: string }): Context | null {
  if (Object.keys(values).length !== ids.length || ids.some((id) => !Object.prototype.hasOwnProperty.call(values, id))) return null;
  const evidence = { ...c.evidence };
  for (const id of ids) {
    const value = values[id];
    if (!isRecord(value) || !(value['outcome'] === 'pass' || waiver && value['outcome'] === 'waived') || !nonEmpty(value['evidence'])) return null;
    const dependencies = value['dependencies'];
    if (dependencies !== undefined && (!isRecord(dependencies) || typeof dependencies['complete'] !== 'boolean' || !nonEmpty(dependencies['rationale']) || !Array.isArray(dependencies['inputs']) || !dependencies['inputs'].every((file) => typeof file === 'string' && file.length > 0 && !file.includes('\\') && !file.startsWith('/') && !file.includes(':') && !file.split('/').includes('..')))) return null;
    const criterion = c.plan!.criteria.find((criterion) => criterion.id === id);
    const redProvenance = criterion?.evidence !== 'red' ? 'not-required' : c.redMatrix.some((row) => row.id === id && row.exit !== 0 && row.tests.length > 0) ? 'observed' : 'waived';
    const attribution = waiver ?? c.redExceptionRulings[id];
    if (redProvenance === 'waived' && !attribution) return null;
    evidence[id] = { id, outcome: value['outcome'], evidence: value['evidence'], ...(dependencies !== undefined ? { dependencies } : {}), planHash: c.planHash ?? '', mutationEpoch: c.mutationEpoch, source: criterion?.evidence ?? 'verify', redProvenance, ...(attribution && (value['outcome'] === 'waived' || redProvenance === 'waived') ? { waiver: attribution } : {}) } as EvidenceRecord;
  }
  const obligations = Object.fromEntries(Object.entries(c.obligations ?? {}).filter(([id]) => !ids.includes(id)));
  return { ...c, evidence, obligations };
}

function completeVerification(c0: Context, results: readonly VerifyRecord[]): S {
  return askEvidence(c0, results);
}

function needsUserRuling(ids: readonly string[], answer: unknown): { decision: 'accept' | 'stop'; by: string; quote: string } | null {
  if (!isRecord(answer) || !['accept', 'stop'].includes(String(answer['decision'])) || !nonEmpty(answer['by']) || !nonEmpty(answer['quote'])) return null;
  if (!ids.length) return null;
  return { decision: answer['decision'] as 'accept' | 'stop', by: answer['by'].trim(), quote: answer['quote'].trim() };
}

function startFailureFromEffect(c: Context, cls: string, detail: string): S {
  return beginFailure(c, `${cls}: ${detail}`);
}

export function initialImplement(): ImplementState { return { tag: 'booting', counters: emptyCounters }; }
/** Root entry: the `booting` + `RUN_STARTED` path with the settled governing spec in context. */
export function beginImplement(run: RunStartedEvent, governingSpec: SpecIdentity | null): S {
  const result = stepImplement(initialImplement(), run);
  return 'c' in result.state && result.state.c ? { ...result, state: withContext(result.state, { ...result.state.c, governingSpec }) } : result;
}

export function beginBoundImplement(run: RunStartedEvent, binding: DesignBinding, counters: Counters, governingSpec: SpecIdentity | null = null, specEpoch = 0): S {
  const c = {
    ...baseContext(run), governingSpec, specEpoch, counters, designBinding: binding, machinePath: `design.${binding.increment.toLowerCase()}.implement`,
    levelGatePassed: binding.levelGatePassed ?? false, gateScope: binding.gateScope ?? null,
    levelAssessment: binding.levelAssessment ?? null, levelChoice: binding.levelChoice ?? null,
    scopeAdjustments: binding.scopeAdjustments ?? [],
    scopeNotice: binding.scopeNotice ?? null,
  };
  return snapshot(c, 'author');
}

function applyImplement(state: ImplementState, event: Event): S {
  switch (state.tag) {
    case 'booting': {
      if (event.type !== 'RUN_STARTED' || event.verb !== 'implement') return stay(state);
      const c = baseContext(event);
      const candidate = /\.plan\.md$/i.test(c.planPath) || settledPlanInput(event.overrides['settledPlan']) !== null;
      return candidate ? snapshot(c, 'parse') : snapshot(c, 'author');
    }
    case 'starting': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return fail(state.c, `initial snapshot failed: ${event.cls}: ${event.detail}`);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId) || !isFingerprint(event.fingerprint)) return stay(state);
      const c = { ...state.c, startFingerprint: event.fingerprint, lastFingerprint: event.fingerprint };
      return state.next === 'parse' ? parsePlan(c, 'initial') : authorPlan(c);
    }
    case 'author': {
      if (event.type !== 'AUTHORED' || event.path !== state.c.planPath) return stay(state);
      return parsePlan({ ...state.c, planAuthoredHere: true }, 'initial');
    }
    case 'parsing': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) {
        if (event.detail.startsWith('design pin target unreadable') || event.detail.includes('has no spec pin')) return stay({ tag: 'stopped', c: state.c, summary: `stale-design-spec: ${event.detail}`, code: 'stale-design-spec' });
        if (state.phase === 'initial' && /not found/i.test(event.detail)) return authorPlan(state.c);
        return startFailureFromEffect(state.c, event.cls, event.detail);
      }
      if (event.type !== 'ARTIFACT_PARSED' || !answers(event, state.effectId) || event.kind !== 'plan') return stay(state);
      const plan = asParsedPlan(event.parsed);
      const pinned = { ...state.c, existingPlan: state.c.existingPlan || !state.c.planAuthoredHere, designPin: event.governing?.design ?? null, ...(plan ? { plan, planHash: event.hash } : {}) };
      if (staleGoverning(event, state.c.governingSpec)) return stay({ ...state, c: pinned });
      if (event.defects.length) return authorPlan(pinned, event.defects as readonly Readonly<Record<string, unknown>>[]);
      if (!plan || !/^sha256:[a-f0-9]{64}$/.test(event.hash)) return beginFailure(state.c, 'Plan parser returned an invalid payload or governed hash.');
      const c = { ...state.c, plan, planHash: event.hash, planPath: state.c.planPath };
      if (c.designBinding) {
        const defects = validateDesignTraceability(plan, c.designBinding);
        if (defects.length) return authorPlan(c, defects.map((message) => ({ message })));
      }
      const settled = settledPlanInput(state.c.run.overrides['settledPlan']);
      if (state.phase === 'initial' && settled && settled.path === c.planPath && settled.hash === event.hash) return beginBaseline(c);
      if (state.phase === 'rebind') return beginBaseline(c);
      return startReview(c);
    }
    case 'baseline-preflight': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return startFailureFromEffect(state.c, event.cls, event.detail);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId) || !isFingerprint(event.fingerprint)) return stay(state);
      return runBaseline({ ...state.c, startFingerprint: event.fingerprint, lastFingerprint: event.fingerprint });
    }
    case 'plan-review': {
      if (answers(event, reviewArtifactId(state.review)) && staleGoverning(event, state.c.governingSpec)) return stay({ ...state, c: { ...state.c, designPin: event.governing.design } });
      if (event.type === 'FIXES_APPLIED') {
        const c = markMutation(state.c, []);
        return fromPlanReview(c, stepReview(state.review, event));
      }
      return fromPlanReview(state.c, stepReview(state.review, event));
    }
    case 'baseline': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return startFailureFromEffect(state.c, event.cls, event.detail);
      if (event.type !== 'VERIFY_DONE' || !answers(event, state.effectId) || event.purpose !== 'baseline' || !isFingerprint(event.fingerprint)) return stay(state);
      const rows = recordsFrom(resultEventRows(event), state.c, 'baseline');
      if (!rows) return beginFailure(state.c, 'Baseline verification returned malformed command results.');
      return afterBaseline({ ...state.c, lastFingerprint: event.fingerprint }, rows);
    }
    case 'baseline-snapshot': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return fail(state.c, `baseline snapshot failed: ${event.cls}: ${event.detail}`);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId) || !isFingerprint(event.fingerprint)) return stay(state);
      if (!state.c.startFingerprint) return beginFailure(state.c, 'Missing baseline fingerprint.');
      if (!sameFingerprint(event.fingerprint, state.c.startFingerprint)) return assessBoundary(state.c, state, event, state.c.startFingerprint, event.fingerprint, []);
      const c = { ...state.c, lastFingerprint: event.fingerprint };
      const failures = failingBaselineIds(state.results);
      return failures.length ? stay({ tag: 'baseline-decision', c, items: state.results.filter((row) => row.exit !== 0) }) : beginApproval(c);
    }
    case 'baseline-decision': {
      if (event.type !== 'DECISION' || event.kind !== 'baseline') return stay(state);
      if (event.answer === 'stop') return stop(state.c, 'User stopped after baseline failures; repository work is preserved.');
      const recovery = failureAnswer(event.answer);
      if (recovery?.action === 'hotfix') return beginLevelGate(state.c, { kind: 'baseline-hotfix', origin: state, answer: recovery });
      const available = failingBaselineIds(state.items);
      if (!isRecord(event.answer) || event.answer['action'] !== 'accept-known-red' || !Array.isArray(event.answer['ids'])) return stay(state);
      const ids = event.answer['ids'];
      if (ids.length !== available.length || new Set(ids).size !== ids.length || available.some((id) => !ids.includes(id))) return stay(state);
      return beginApproval({ ...state.c, acceptedBaseline: available });
    }
    case 'approval': {
      if (event.type !== 'DECISION' || event.kind !== 'approval') return stay(state);
      if (event.answer === 'stop') return stop(state.c, 'User declined implementation approval; repository work is preserved.');
      const approval = approvalAnswer(event.answer);
      return approval ? beginPostApproval({ ...state.c, approval }) : stay(state);
    }
    case 'level-classification': {
      if (event.type === 'DECISION' && event.kind === 'run-stop') return stop(state.c, 'User stopped before implementation; no production writer was launched.');
      if (event.type !== 'DECISION' || event.kind !== 'level-classification' || !isRecord(event.answer)) return stay(state);
      const assessment = event.answer as unknown as LevelClassificationAnswer;
      if (state.c.run.levelSource === 'explicit' && levelOf(assessment.evaluatedLevel) > levelOf(state.c.run.level)) {
        return stay({ tag: 'level-recommendation', c: { ...state.c, levelAssessment: assessment }, assessment, resume: state.resume });
      }
      return finishLevelGate(state.c, assessment, null, state.resume);
    }
    case 'level-recommendation': {
      if (event.type === 'DECISION' && event.kind === 'run-stop') return stop(state.c, 'User stopped before implementation; no production writer was launched.');
      if (event.type !== 'DECISION' || event.kind !== 'level-recommendation' || !isRecord(event.answer)) return stay(state);
      return finishLevelGate(state.c, state.assessment, event.answer as unknown as LevelRecommendationAnswer, state.resume);
    }
    case 'integration-conflict': {
      if (event.type === 'AMEND') return applyAmend(state, event);
      if (event.type === 'REPLACE_PLAN') return beginReplacement(state, event);
      if (event.type !== 'DECISION' || event.kind !== 'integration-conflict' || !isRecord(event.answer)) return stay(state);
      const answer = event.answer as unknown as ConflictDecision, conflict = state.conflict, c = state.c;
      if (answer.action === 'resolve') {
        const involved = involvedTasks(c, conflict);
        const permitted = conflictScope(c, conflict);
        const input = { tasks: involved, candidate: conflict.candidate, attempt: conflict.attempt + 1, expected: conflict.head, base: conflict.base, permitted };
        const { retry, ...open } = conflict;
        // NOTE: replay the failed effect's own input so checkout recovers its commit; acceptance rechecks it against current scope.
        if (retry) return { state: { tag: 'task-checkout', c, effectId: retry.id, step: 'resolve', task: conflict.task, reason: null, conflict: open, input: retry.input }, effects: [{ kind: 'checkout', id: retry.id, op: 'resolve', input: retry.input }] };
        return checkout(c, 'resolve', 'resolve', input, conflict.task, null, conflict);
      }
      return conflict.replay ? stay(state) : checkout(c, 'discard', 'reset', { name: 'integration', revision: conflict.base }, conflict.task, null, conflict);
    }
    case 'request-decision': {
      if (event.type === 'AMEND') return applyAmend(state, event);
      if (event.type === 'REPLACE_PLAN') return beginReplacement(state, event);
      if (event.type !== 'DECISION' || !isRecord(event.answer)) return stay(state);
      if (state.stage === 'orchestrator' && event.kind === 'request') {
        const answer = event.answer as unknown as RequestDecision;
        if (answer.action === 'escalate') return stay({ ...state, stage: 'user', orchestratorRationale: answer.rationale });
        return resolveRequest(state.c, state.request, answer.action === 'approve');
      }
      if (state.stage === 'user' && event.kind === 'request-user') return resolveRequest(state.c, state.request, (event.answer as unknown as RequestUserDecision).choice === 'accept');
      return stay(state);
    }
    case 'needs-user': {
      if (event.type !== 'DECISION' || event.kind !== 'needs-user') return stay(state);
      const ruling = needsUserRuling(state.ids, event.answer);
      if (!ruling) return stay(state);
      if (ruling.decision === 'stop') return stop(state.c, `User stopped at RED exception ruling for ${state.ids.join(', ')}.`);
      const redExceptionRulings = { ...state.c.redExceptionRulings, ...Object.fromEntries(state.ids.map((id) => [id, { decision: 'accept' as const, by: ruling.by, quote: ruling.quote }])) };
      const c = { ...state.c, redExceptionRulings, approvedRedExceptions: [...new Set([...state.c.approvedRedExceptions, ...state.ids])] };
      return beginLevelGate(c, { kind: 'tasks' });
    }
    case 'task-checkout': return stepCheckout(state, event);
    case 'tasks': case 'plan-replacement': case 'task-brief': case 'task-prewrite-snapshot': case 'task-envelope': case 'task-verify': case 'delivered-snapshot': return stepTasks(state, event);
    case 'evidence': {
      if (event.type !== 'EVIDENCE') return stay(state);
      const c = recordEvidence(state.c, state.ids, event.criteria, event.waiver);
      if (!c) return stay(state);
      return finishEvidence(c, state.verify);
    }
    case 'concerns': {
      if (event.type !== 'DECISION' || event.kind !== 'concerns') return stay(state);
      const ruling = needsUserRuling(state.items, event.answer);
      if (!ruling) return stay(state);
      if (ruling.decision === 'stop') return stop(state.c, `User stopped with unresolved implementation concerns: ${state.items.join('; ')}`);
      const concernRulings = { ...state.c.concernRulings, ...Object.fromEntries(state.items.map((item) => [item, { decision: 'accept' as const, by: ruling.by, quote: ruling.quote }])) };
      return startCodeReview({ ...state.c, concernRulings });
    }
    case 'code-review': {
      const c = event.type === 'FIXES_APPLIED' ? { ...markMutation(state.c, reviewPaths(event)), reviewFixed: [...new Set([...(state.c.reviewFixed ?? []), ...reviewPaths(event)])].sort() } : state.c;
      return fromCodeReview(c, stepReview(state.review, event));
    }
    case 'post-review-snapshot': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return startFailureFromEffect(state.c, event.cls, event.detail);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId) || !isFingerprint(event.fingerprint)) return stay(state);
      return observeReviewBoundary({ ...state.c, lastFingerprint: event.fingerprint }, diffPaths(event));
    }
    case 'generated-verify': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return startFailureFromEffect(state.c, event.cls, event.detail);
      if (event.type !== 'VERIFY_DONE' || !answers(event, state.effectId) || event.purpose !== 'generated' || !isFingerprint(event.fingerprint)) return stay(state);
      const rows = recordsFrom(resultEventRows(event), state.c, 'generated');
      if (!rows || rows.some((row) => row.exit !== 0)) return beginFailure(state.c, `Generated command failed: ${rows?.filter((row) => row.exit !== 0).map((row) => `${row.command} (${row.logPath})`).join('; ') ?? 'invalid results'}`);
      const paths = generatedCommands(state.c.plan!).map((item) => item.path);
      const { c, id } = effectId({ ...state.c, lastFingerprint: event.fingerprint }, 'snapshot');
      return { state: { tag: 'generated-snapshot', c, effectId: id, before: state.before, paths }, effects: [{ kind: 'snapshot', id, since: state.before }] };
    }
    case 'generated-snapshot': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return startFailureFromEffect(state.c, event.cls, event.detail);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId) || !isFingerprint(event.fingerprint)) return stay(state);
      const changed = diffPaths(event);
      const outside = changed.filter((file) => !state.paths.includes(file));
      if (outside.length) return assessBoundary(state.c, state, event, state.before, event.fingerprint, state.paths);
      if (!sameFingerprint(event.fingerprint, state.before) && !changed.length) return assessBoundary(state.c, state, event, state.before, event.fingerprint, state.paths);
      const c = sameFingerprint(event.fingerprint, state.before) ? { ...state.c, lastFingerprint: event.fingerprint } : markMutation({ ...state.c, lastFingerprint: event.fingerprint }, changed);
      return beginTrimOrFinal(c);
    }
    case 'trim-snapshot': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return startFailureFromEffect(state.c, event.cls, event.detail);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId) || !isFingerprint(event.fingerprint)) return stay(state);
      return startFinalVerify({ ...state.c, lastFingerprint: event.fingerprint });
    }
    case 'final-verify': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return startFailureFromEffect(state.c, event.cls, event.detail);
      if (event.type !== 'VERIFY_DONE' || !answers(event, state.effectId) || event.purpose !== 'final' || !isFingerprint(event.fingerprint)) return stay(state);
      const rows = recordsFrom(resultEventRows(event), state.c, 'final');
      if (!rows) return beginFailure(state.c, 'Final verification returned malformed command results.');
      if (!sameFingerprint(event.fingerprint, state.before)) { const { c, id } = effectId(state.c, 'snapshot'); return { state: { tag: 'checking-host-event', c: { ...c, lastFingerprint: state.before }, parent: state, parked: event, effectId: id }, effects: [{ kind: 'snapshot', id, since: state.before }] }; }
      const regression = rows.filter((row) => row.status === 'regression');
      if (regression.length) return beginFailure({ ...state.c, lastFingerprint: event.fingerprint, stalled: { purpose: 'final', rows: regression } }, `Final verification failed: ${regression.map((row) => `${row.command} (${row.failureId ?? row.logPath})`).join('; ')}`);
      const records = { ...state.c.records, ...Object.fromEntries(rows.map((row) => [row.command, row])) };
      const c = { ...state.c, lastFingerprint: event.fingerprint, records, finalGate: `${rows.length} commands checked; ${rows.filter((row) => row.status === 'pass' || row.status === 'known-red — unchanged').length} accepted.` };
      return completeVerification(c, rows);
    }
    case 'failure-snapshot': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return fail(state.c, `${state.reason} (snapshot failed: ${event.cls}: ${event.detail})`);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId)) return stay(state);
      return stay({ tag: 'failure', c: isFingerprint(event.fingerprint) ? { ...state.c, lastFingerprint: event.fingerprint } : state.c, reason: state.reason, changedPaths: diffPaths(event) });
    }
    case 'failure': {
      if (event.type === 'AMEND') return applyAmend(state, event);
      if (event.type === 'REPLACE_PLAN') return beginReplacement(state, event);
      if (event.type !== 'DECISION' || event.kind !== 'failure') return stay(state);
      const answer = failureAnswer(event.answer);
      if (!answer) return stay(state);
      if (answer.action === 'stop') return stop(state.c, `Stopped after failure: ${state.reason}. Work preserved; changed paths: ${state.changedPaths.join(', ') || 'none reported'}.`);
      if (answer.action === 'retry') return retryAfterFailure({ ...state.c, retryContext: { rationale: answer.rationale, failure: state.reason } });
      if (answer.action === 'hotfix') return beginHotfix(state, answer);
      const c = recordEvidence(state.c, state.c.plan!.criteria.map((row) => row.id), answer.criteria, { by: 'user', quote: answer.quote });
      const waived = c ? Object.values(c.evidence).filter((row) => row['outcome'] === 'waived').length : 0;
      return c ? stay({ tag: 'complete', c: { ...c, finalGate: `Manual completion by user: ${answer.quote}` }, summary: `User manually completed implementation: ${Object.keys(c.evidence).length - waived} passed; ${waived} waived. ${answer.quote}` }) : stay(state);
    }
    case 'checking-host-event': case 'assessing-host-event': case 'drift': case 'hotfix-brief': case 'hotfix-write': case 'hotfix-envelope': case 'hotfix-snapshot': case 'hotfix-assessment': case 'hotfix-verify': return stepRecovery(state, event);
    case 'complete': case 'stopped': case 'failed': return stay(state);
    default: return never(state, 'implement state');
  }
}

function redTestPaths(c: Context): string[] { return c.plan ? [...new Set(activeRedCriteria(c).flatMap((criterion) => criterion.changes.filter(isTestPath)))].sort() : []; }

function scopePaths(c: Context): string[] { return [...new Set([...c.plan ? approvedPaths(c.plan!) : []])].sort(); }
function withContext(state: ImplementState, c: Context): ImplementState { return 'c' in state ? { ...state, c } as ImplementState : state; }
const hostTypes = new Set(['AUTHORED', 'NATIVE_RESULTS', 'RULINGS', 'FIXES_APPLIED', 'WRITE_RECEIPT', 'REQUEST', 'AMEND', 'REPLACE_PLAN', 'EVIDENCE', 'DECISION', 'REVISE', 'REVIEW_USE']);

/** KD-6: before a parsed plan nothing pins the old spec; after it, the run halts for re-planning or design revision. */
function respecImplement(state: ImplementState, identity: SpecIdentity): S {
  if (!('c' in state) || !state.c) return stay(state);
  const c = { ...state.c, governingSpec: identity };
  if (c.designPin) return stay({ tag: 'stopped', c, code: 'stale-design-spec', summary: `stale-design-spec: ${c.designPin} pins a revised spec; revise the design first.` });
  if (c.plan === null) return c.existingPlan && !c.planAuthoredHere
    ? stay({ tag: 'stopped', c, code: 'stale-spec', summary: `stale-spec: governing spec revised to ${identity.hash}; re-plan.` })
    : authorPlan(c, [{ code: 'stale-spec', message: `Governing spec revised to ${identity.hash}; re-author against it.` }]);
  const parent = c.plan.box?.['Parent']?.replace(/`/g, '').trim() ?? '';
  const increment = /^(.+?)\s*·\s*I\d{2}$/.exec(parent);
  if (increment) return stay({ tag: 'stopped', c, code: 'stale-design-spec', summary: `stale-design-spec: ${increment[1]} pins a revised spec; revise the design first.` });
  if (c.planAuthoredHere && c.phase === 'setup' && !Object.keys(c.tasks).length && !c.integration) return authorPlan({ ...c, specEpoch: (c.specEpoch ?? 0) + 1 }, [{ code: 'stale-spec', message: `Governing spec revised to ${identity.hash}; re-author against it.` }]);
  return stay({ tag: 'stopped', c, code: 'stale-spec', summary: `stale-spec: governing spec revised to ${identity.hash}; re-plan.` });
}

export function stepImplement(state: ImplementState, event: Event): S {
  if (event.type === 'SPEC_SETTLED') return respecImplement(state, { path: event.path, hash: event.hash });
  if (state.tag === 'checking-host-event' || state.tag === 'assessing-host-event' || state.tag === 'drift') return stepRecovery(state, event);
  if (hostTypes.has(event.type) && 'c' in state && state.c && implementAwait(state) !== null && implementAwait(state) !== 'done') {
    if (validateImplement(state, event as HostEvent)) return stay(state);
    const { changeDispositions, ...reply } = event as HostEvent;
    if (changeDispositions) {
      const c = applyDispositions(state.c, changeDispositions);
      // A requested recheck at the evidence frame re-runs the selected checks before evidence is asked again.
      if (state.tag === 'evidence' && changeDispositions.some((row) => row.refresh?.length)) return startFinalVerify(c);
      return stepImplement(withContext(state, c), reply as Event);
    }
    // NOTE: caller edits during the task phase are reconciled by delivery drift checks, not host-event snapshots.
    if (state.c.phase === 'tasks') return applyImplement(state, event);
    const { c, id } = effectId(state.c, 'snapshot');
    return { state: { tag: 'checking-host-event', c, parent: state, parked: event as HostEvent, effectId: id }, effects: [{ kind: 'snapshot', id, since: state.c.lastFingerprint }] };
  }
  const result = applyImplement(state, event);
  if (event.type === 'VERIFY_DONE' && 'c' in state && state.c?.lastFingerprint && sameFingerprint(state.c.lastFingerprint, event.fingerprint) && 'c' in result.state && result.state.c) {
    return { ...result, state: withContext(result.state, { ...result.state.c, lastFingerprint: { ...state.c.lastFingerprint, ...event.fingerprint } }) };
  }
  return result;
}

function applyParked(parent: ImplementState, c: Context, parked: Event): S {
  const updated = withContext(parent, c);
  if (['AUTHORED', 'DECISION', 'NATIVE_RESULTS', 'RULINGS', 'FIXES_APPLIED', 'WRITE_RECEIPT', 'REQUEST', 'AMEND', 'REPLACE_PLAN', 'EVIDENCE', 'REVIEW_USE'].includes(parked.type) && validateImplement(updated, parked as HostEvent)) return beginFailure(c, 'Parked host event no longer matches its bound parent.');
  return applyImplement(updated, parked);
}

function beginHotfix(origin: RecoveryOrigin, answer: Extract<FailureAnswer, { action: 'hotfix' }>): S {
  const { pendingWriter, ...bound } = origin.c;
  const c0: Context = pendingWriter ? { ...bound, writer: pendingWriter } : origin.c;
  const stage = origin.tag === 'baseline-decision' ? 'baseline' : 'delivered';
  if (c0.withdrawnHotfix.includes(stage) || origin.tag === 'failure' && c0.phase !== 'delivered') return stay(origin);
  if (!c0.lastFingerprint || !recoveryRef(c0.lastFingerprint)) return beginFailure(c0, 'Hotfix requires concrete snapshot metadata.');
  if (origin.tag === 'baseline-decision' || answer.mode === 'inline') {
    const { c, id } = effectId(c0, 'snapshot');
    return { state: { tag: 'hotfix-snapshot', c, origin, before: c0.lastFingerprint, effectId: id, answer }, effects: [{ kind: 'snapshot', id, since: c0.lastFingerprint }] };
  }
  if (!c0.writer?.models[0] || !c0.stalled) return stay(origin);
  const { c, id } = effectId(c0, 'write-brief');
  const plan = c0.plan!;
  return { state: { tag: 'hotfix-brief', c, origin, before: c0.lastFingerprint, effectId: id, answer }, effects: [{ kind: 'write-brief', id, stage: 'hotfix', input: {
    planPath: c0.planPath, planHash: c0.planHash, designBinding: briefDesignBinding(c0),
    governingOutcome: { title: plan.title, outcome: plan.box['TL;DR'] ?? plan.title ?? c0.planPath },
    sharedContext: plan.sharedContext,
    settledScope: { paths: scopePaths(c0), approvedPaths: scopePaths(c0), changes: plan.changes },
    criteria: plan.criteria.map((criterion) => ({ id: criterion.id, title: criterion.title, changes: criterion.changes, verify: criterion.verify, evidence: criterion.evidence })),
    envelopeSchema: { schemaVersion: 1, stage: 'COMPLETE', status: ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED'], summary: 'non-empty string' },
    rules: { keyDecisions: plan.keyDecisions, repository: c0.run.repo, approval: c0.approval, writerStage: 'hotfix' },
    priorFindings: [], evidence: [], retryContext: c0.retryContext, rootCause: answer.rationale, stalledCheck: c0.stalled,
    hotfix: { maxFiles: HOTFIX_MAX_FILES, maxLines: HOTFIX_MAX_LINES, singleShot: true, model: c0.writer.models[0], external: answer.external, preRed: false, paths: scopePaths(c0) },
  } }] };
}

function hotfixSnapshot(state: Extract<ImplementState, { tag: 'hotfix-write' | 'hotfix-envelope' }>): S {
  const { c, id } = effectId(state.c, 'snapshot');
  return { state: { tag: 'hotfix-snapshot', c, origin: state.origin, before: state.before, effectId: id, answer: state.answer }, effects: [{ kind: 'snapshot', id, since: state.before }] };
}

function assessBoundary(c0: Context, parent: ImplementState, parked: Event, before: TreeFingerprint, after: TreeFingerprint, expectedPaths: readonly string[]): S {
  const { c, id } = effectId({ ...c0, lastFingerprint: before }, 'assess-recovery');
  return { state: { tag: 'assessing-host-event', c, parent, parked, effectId: id, fingerprint: after }, effects: [{ kind: 'assess-recovery', id, purpose: 'drift', before, after, phase: parent.tag, pendingId: parked.type, input: { managedPlans: [artifactRelative(after, c.planPath)], expectedPaths, inputs: scopePaths(c), ...evidenceAssessment(c) } }] };
}

function stepRecovery(state: Extract<ImplementState, { tag: 'checking-host-event' | 'assessing-host-event' | 'drift' | 'hotfix-brief' | 'hotfix-write' | 'hotfix-envelope' | 'hotfix-snapshot' | 'hotfix-assessment' | 'hotfix-verify' }>, event: Event): S {
  switch (state.tag) {
    case 'checking-host-event': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return beginFailure(state.c, `Host-event snapshot failed: ${event.detail}`);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId) || !isFingerprint(event.fingerprint)) return stay(state);
      const hotfixDecision = (state.parent.tag === 'baseline-decision' || state.parent.tag === 'failure') && state.parked.type === 'DECISION' && failureAnswer(state.parked.answer)?.action === 'hotfix';
      if (hotfixDecision || state.parent.tag === 'hotfix-write') return applyParked(state.parent, state.c, state.parked);
      if (!state.c.lastFingerprint) return beginFailure(state.c, 'Missing observed baseline.');
      if (!state.resolution && sameFingerprint(state.c.lastFingerprint, event.fingerprint)
        && !(state.parked.type === 'CHECKOUT_DONE' && state.parked.result['collision'])) return applyParked(state.parent, { ...state.c, lastFingerprint: event.fingerprint }, state.parked);
      const { c, id } = effectId(state.c, 'assess-recovery');
      const artifact = artifactRelative(event.fingerprint, c.planPath);
      const expectedPaths = state.parked.type === 'AUTHORED' ? [artifact] : state.parent.tag === 'generated-snapshot' ? [...state.parent.paths] : [];
      return { state: { tag: 'assessing-host-event', c, parent: state.parent, parked: state.parked, effectId: id, fingerprint: event.fingerprint, ...(state.resolution ? { resolution: state.resolution } : {}) }, effects: [{ kind: 'assess-recovery', id, purpose: 'drift', before: c.lastFingerprint!, after: event.fingerprint, phase: state.parent.tag, pendingId: state.parked.type, input: { collision: state.parked.type === 'CHECKOUT_DONE' && !!state.parked.result['collision'], additionalPaths: state.parked.type === 'CHECKOUT_DONE' ? state.parked.result['conflicts'] : [], expectedPaths, managedPlans: [artifactRelative(event.fingerprint, c.planPath)], ownedPaths: [], inputs: scopePaths(c), ...evidenceAssessment(c) } }] };
    }
    case 'assessing-host-event': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return beginFailure(state.c, event.detail);
      if (event.type !== 'RECOVERY_ASSESSED' || !answers(event, state.effectId) || event.purpose !== 'drift' || event.beforeHash !== bindingHash(state.c.lastFingerprint) || event.afterHash !== bindingHash(state.fingerprint)) return stay(state);
      if (state.resolution && state.resolution.afterHash === event.afterHash) {
        if (state.resolution.action === 'escalate') return stop(state.c, `Changed intent requires a user decision. Evidence retained: ${event.notice.rawDeltaRef.path}`);
        if (state.resolution.action === 'reconcile') return beginFailure(state.c, `Changed inputs need plan reconciliation: ${state.resolution.rationale}. Evidence retained: ${event.notice.rawDeltaRef.path}`);
        const c = state.resolution.action === 'refresh' ? refreshEvidence(state.c, suggestedCriteria(state.c, event.notice), event.notice.id, state.resolution.rationale) : state.c;
        const rebound = { ...c, lastFingerprint: state.fingerprint };
        // NOTE: only a live delivery collision reaches a resolution; its refresh replays accepted integration commits onto the
        // caller's newer base. Tasks, candidates, and prior commits stay as recorded; refreshed criteria wait as obligations.
        if (state.resolution.action === 'refresh' && state.parent.tag === 'task-checkout' && state.parent.step === 'deliver') {
          const archivedName = `integration-${bindingHash({ notice: event.notice.id, counters: rebound.counters }).slice(0, 16)}`;
          const replay = rebound.integration ? { replay: { base: rebound.integration.base, head: rebound.integration.head } } : {};
          return checkout(rebound, 'rebase', 'init', { rebase: true, archivedName, ...replay }, null, archivedName);
        }
        return applyParked(state.parent, rebound, state.parked);
      }
      const collision = state.parked.type === 'CHECKOUT_DONE' && !!state.parked.result['collision'];
      if (collision && event.notice.relevance !== 'expected' && event.notice.relevance !== 'irrelevant') {
        return stay({ tag: 'drift', c: state.c, parent: state.parent, parked: state.parked, paths: event.notice.paths, fingerprint: state.fingerprint, notice: event.notice });
      }
      // Ordinary changes are advisory: record the observation, rebind the fingerprint, and apply the parked receipt once.
      const observed = event.notice.relevance === 'expected' ? state.c : observe(state.c, event.notice);
      const parked = state.parked.type === 'VERIFY_DONE' ? { ...state.parked, fingerprint: state.fingerprint }
        : state.parked.type === 'SNAPSHOT' && state.parent.tag === 'generated-snapshot' ? { ...state.parked, diff: { ...state.parked.diff, paths: diffPaths(state.parked).filter((file) => state.parent.tag === 'generated-snapshot' && state.parent.paths.includes(file)) } } : state.parked;
      // NOTE: a generated snapshot with only outside changes rebinds its baseline, or it would reassess the same change forever.
      const quietGenerated = state.parent.tag === 'generated-snapshot' && parked.type === 'SNAPSHOT' && !diffPaths(parked).length;
      const parent = state.parent.tag === 'final-verify' || state.parent.tag === 'hotfix-verify' || quietGenerated ? { ...state.parent, before: state.fingerprint } as ImplementState : state.parent;
      return applyParked(parent, { ...observed, lastFingerprint: state.fingerprint, ...(state.parent.tag === 'baseline-snapshot' ? { startFingerprint: state.fingerprint } : {}) }, parked);
    }
    case 'drift': {
      if (event.type !== 'DECISION' || event.kind !== 'drift') return stay(state);
      const answer = resolution(event.answer, state.notice);
      if (!answer) return stay(state);
      const { c, id } = effectId(state.c, 'snapshot');
      return { state: { tag: 'checking-host-event', c, parent: state.parent, parked: state.parked, effectId: id, resolution: answer }, effects: [{ kind: 'snapshot', id, since: state.c.lastFingerprint }] };
    }
    case 'hotfix-brief': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return stay(withContext(state.origin, state.c));
      if (event.type !== 'BRIEF_READY' || !answers(event, state.effectId) || event.stage !== 'hotfix' || !/^sha256:[a-f0-9]{64}$/.test(event.sha256) || !nonEmpty(event.path) || !nonEmpty(event.envelopePath)) return stay(state);
      return stay({ tag: 'hotfix-write', c: state.c, origin: state.origin, before: state.before, answer: state.answer, brief: { path: event.path, sha256: event.sha256, envelopePath: event.envelopePath } });
    }
    case 'hotfix-write': {
      if (event.type !== 'WRITE_RECEIPT' || 'task' in event && event.task !== undefined) return stay(state);
      if (event.status === 'failed') return stay(withContext(state.origin, state.c));
      if (event.status !== 'submitted' || event.envelopePath !== state.brief.envelopePath) return stay(state);
      const { c, id } = effectId(state.c, 'check-envelope');
      return { state: { tag: 'hotfix-envelope', c, origin: state.origin, before: state.before, effectId: id, answer: state.answer }, effects: [{ kind: 'check-envelope', id, envelopePath: state.brief.envelopePath, permitted: scopePaths(c), since: state.before }] };
    }
    case 'hotfix-envelope': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return stay(withContext(state.origin, state.c));
      if (event.type !== 'ENVELOPE_CHECKED' || !answers(event, state.effectId)) return stay(state);
      // NOTE: taskless hotfixes have no scope request, so any path outside the approved scope stays a hard failure.
      if (event.defects.length || (Array.isArray(event.diff['outside']) && event.diff['outside'].length) || !isWriterEnvelope(event.envelope) || !['DONE', 'DONE_WITH_CONCERNS'].includes(event.envelope.status)) return stay(withContext(state.origin, state.c));
      return hotfixSnapshot(state);
    }
    case 'hotfix-snapshot': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return beginFailure(state.c, `Hotfix snapshot failed: ${event.detail}`);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId)) return stay(state);
      if (!recoveryRef(state.before) || !recoveryRef(event.fingerprint)) return beginFailure(state.c, 'Hotfix snapshot metadata is malformed.');
      const { c, id } = effectId(state.c, 'assess-recovery');
      return { state: { tag: 'hotfix-assessment', c, origin: state.origin, before: state.before, fingerprint: event.fingerprint, effectId: id, answer: state.answer }, effects: [{ kind: 'assess-recovery', id, purpose: 'hotfix', before: state.before, after: event.fingerprint, phase: 'hotfix', pendingId: state.effectId, input: { external: state.answer.external, productionPaths: scopePaths(c).filter((file) => !isTestPath(file)), ...evidenceAssessment(c) } }] };
    }
    case 'hotfix-assessment': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return beginFailure(state.c, event.detail);
      if (event.type !== 'RECOVERY_ASSESSED' || !answers(event, state.effectId) || event.purpose !== 'hotfix' || event.beforeHash !== bindingHash(state.before) || event.afterHash !== bindingHash(state.fingerprint) || !event.judgement) return stay(state);
      const violations = event.judgement.violations;
      if (violations.length) return stay(withContext(state.origin, { ...state.c, concerns: [...state.c.concerns, ...violations] }));
      const stalled = state.origin.tag === 'baseline-decision' ? { purpose: 'baseline' as const, rows: state.origin.items } : state.c.stalled;
      if (!stalled?.rows.length) return beginFailure(state.c, 'No stalled check is available for hotfix verification.');
      const changedPaths = event.notice.paths;
      const c0 = markMutation({ ...state.c, lastFingerprint: state.fingerprint, stalled, finalFocus: [...new Set([...state.c.finalFocus, ...changedPaths])] }, event.notice.pathCount > changedPaths.length ? [] : changedPaths);
      const { c, id } = effectId(c0, 'verify');
      return { state: { tag: 'hotfix-verify', c, origin: state.origin, before: state.fingerprint, effectId: id, changedPaths }, effects: [{ kind: 'verify', id, purpose: 'hotfix', commands: stalled.rows.map((row) => commandEffect(row.command, commandMappings(c.plan!).find((m) => m.command === row.command) ?? null, scopePaths(c), environmentKey(c))) }] };
    }
    case 'hotfix-verify': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return stay(withContext(state.origin, state.c));
      if (event.type !== 'VERIFY_DONE' || !answers(event, state.effectId) || event.purpose !== 'hotfix') return stay(state);
      const rows = recordsFrom(event.results, state.c, 'scoped');
      if (!rows || !isFingerprint(event.fingerprint)) return beginFailure(state.c, 'Hotfix check returned invalid results.');
      if (!sameFingerprint(state.before, event.fingerprint)) {
        const { c, id } = effectId({ ...state.c, lastFingerprint: state.before }, 'snapshot');
        return { state: { tag: 'checking-host-event', c, parent: state, parked: event, effectId: id }, effects: [{ kind: 'snapshot', id, since: state.before }] };
      }
      const unchanged = rows.some((row) => row.exit !== 0 && state.c.stalled?.rows.some((old) => old.command === row.command && old.failureId !== null && old.failureId === row.failureId));
      const stage = state.origin.tag === 'baseline-decision' ? 'baseline' : 'delivered';
      const c = { ...state.c, withdrawnHotfix: unchanged ? [...new Set([...state.c.withdrawnHotfix, stage])] : state.c.withdrawnHotfix, lastFingerprint: event.fingerprint, records: { ...state.c.records, ...Object.fromEntries(rows.map((r) => [r.command, r])) } };
      if (rows.some((row) => row.exit !== 0)) return stay(withContext(state.origin, c));
      if (state.origin.tag === 'baseline-decision') return beginApproval({ ...c, baseline: c.baseline.map((old) => rows.find((r) => r.command === old.command) ?? old) });
      return c.stalled?.purpose === 'final' ? startFinalVerify(c) : startGeneratedOrFinal(c);
    }
    default: return never(state, 'recovery state');
  }
}

function reviewPaths(event: Extract<Event, { type: 'FIXES_APPLIED' }>): string[] {
  return event.clusters.flatMap((cluster) => Array.isArray(cluster['affectedPaths']) ? cluster['affectedPaths'].filter((file): file is string => typeof file === 'string') : []);
}

function decideData(kind: string, question: string, options: readonly string[], items?: readonly unknown[]): Readonly<Record<string, unknown>> {
  return { kind, question, options, ...(items ? { items } : {}) };
}

export function implementAwait(state: ImplementState): Await | null {
  switch (state.tag) {
    case 'author': return 'author';
    case 'plan-review': case 'code-review': return reviewAwait(state.review);
    case 'tasks': case 'hotfix-write': return 'write';
    case 'baseline-decision': case 'approval': case 'level-classification': case 'level-recommendation': case 'integration-conflict': case 'request-decision':
    case 'needs-user': case 'concerns': case 'failure': case 'drift': return 'decide';
    case 'evidence': return 'evidence';
    case 'complete': case 'stopped': case 'failed': return 'done';
    case 'booting': case 'starting': case 'parsing': case 'baseline-preflight': case 'baseline': case 'baseline-snapshot':
    case 'task-checkout': case 'plan-replacement': case 'task-brief': case 'task-prewrite-snapshot': case 'task-envelope': case 'task-verify': case 'delivered-snapshot': case 'post-review-snapshot': case 'trim-snapshot': case 'generated-verify': case 'generated-snapshot': case 'final-verify': case 'failure-snapshot':
    case 'checking-host-event': case 'assessing-host-event': case 'hotfix-brief': case 'hotfix-envelope': case 'hotfix-snapshot': case 'hotfix-assessment': case 'hotfix-verify': return null;
    default: return never(state, 'implement state');
  }
}

/** Briefs and criteria of each task a conflict involves, so the orchestrator resolves against both intents. */
function conflictTasks(c: Context, conflict: Conflict): readonly Readonly<Record<string, unknown>>[] {
  if (conflict.replay?.owners) return conflict.replay.owners.map((owner) => ({ task: owner.task, status: 'accepted', paths: owner.paths, criteria: [], retainedVerification: owner.commands }));
  const plan = c.plan!;
  return involvedTasks(c, conflict).map((id) => {
    const record = c.tasks[id], task = planTask(c, id);
    return { task: id, status: record?.status ?? null, briefPath: record?.brief?.path ?? null, briefHash: record?.brief?.sha256 ?? null, paths: task?.paths ?? [], criteria: task ? taskCriteria(plan, task).map((row) => ({ id: row.id, title: row.title, verify: row.verify.map((item) => item.command) })) : [] };
  });
}

/** Every frame carries open observations so the orchestrator can dispose of them on its normal reply. */
export function implementData(state: ImplementState): Readonly<Record<string, unknown>> {
  const data = stateData(state);
  const open = 'c' in state && state.c && state.tag !== 'drift' ? openObservations(state.c) : [];
  return open.length ? { ...data, observations: open.map(({ disposition: _disposition, ...row }) => row) } : data;
}

function stateData(state: ImplementState): Readonly<Record<string, unknown>> {
  const data = frameData(state);
  // NOTE: a rejected REPLACE_PLAN returns to its origin frame; the reason rides that frame until the next revision.
  const rejection = (state.tag === 'tasks' || state.tag === 'request-decision' || state.tag === 'integration-conflict' || state.tag === 'failure') ? state.c.planRejection : null;
  return rejection ? { ...data, planRejection: rejection } : data;
}

function frameData(state: ImplementState): Readonly<Record<string, unknown>> {
  switch (state.tag) {
    case 'author': return { artifact: 'plan', path: state.c.planPath, template: IMPLEMENT_TEMPLATE, read: [{ path: 'references/templates/quality-bar.md', sections: qualitySections.plan }], ...(state.defects.length ? { defects: state.defects } : {}) };
    case 'plan-review': case 'code-review': return reviewData(state.review);
    case 'tasks': return {
      stage: 'task', effort: state.c.writer?.effort, concurrency: writeConcurrency(state.c.run.config), settledLevel: state.c.run.level,
      // NOTE: a REPLACE_PLAN binds this hash as `expectedHash`, so a stale revision is rejected before any effect.
      planPath: state.c.planPath, planHash: state.c.planHash,
      levelAssessment: state.c.levelAssessment, levelChoice: state.c.levelChoice, scopeAdjustments: state.c.scopeAdjustments, scopeNotice: state.c.scopeNotice,
      tasks: activeTasks(state.c.tasks).filter((record) => record.status === 'running').map((record) => ({
        task: record.id, action: record.removed ? record.retirement === 'retain' ? 'running' : 'cancel' : record.handle ? 'running' : 'launch', handle: record.handle, attempt: record.attempt, signature: record.signature,
        model: activeModel(state.c, record), briefPath: record.brief?.path, briefSha256: record.brief?.sha256, briefHash: record.brief?.sha256,
        envelopePath: record.brief?.envelopePath, checkpointPath: record.brief?.checkpointPath, worktree: record.worktree, paths: planTask(state.c, record.id)?.paths ?? [],
        ...(record.retainedSubmission ? { retainedSubmission: record.retainedSubmission } : {}),
        ...(record.retirement ? { retirement: record.retirement } : {}),
      })),
      amended: state.c.amended,
    };
    case 'baseline-decision': return decideData('baseline', 'The baseline has nonzero results. Accept every listed failure identity, choose an inline hotfix, or stop.', ['accept-known-red', 'inline-hotfix', 'stop'], state.items.map((row) => ({ command: row.command, failureId: row.failureId, diagnostic: row.diagnostic, logPath: row.logPath })));
    case 'level-classification': return { ...decideData('level-classification', 'Assess the complete settled implementation scope once before the first production write. Return the evaluated level, concise evidence-based rationale and this exact gateScope.', ['low', 'medium', 'high'], [{ level: state.c.run.level, source: state.c.run.levelSource }]), gateScope: state.gateScope, settledLevel: state.c.run.level, stopAllowed: true };
    case 'level-recommendation': return { ...decideData('level-recommendation', `The implementation assessment is ${state.assessment.evaluatedLevel}: ${state.assessment.rationale}. Choose whether to adopt it or retain the explicit ${state.c.run.level}.`, ['adopt', 'retain']), assessedLevel: state.assessment.evaluatedLevel, rationale: state.assessment.rationale, explicitLevel: state.c.run.level, gateScope: state.assessment.gateScope, stopAllowed: true };
    case 'integration-conflict': {
      const conflict = state.conflict;
      return {
        ...(conflict.replay ? decideData('integration-conflict', 'Delivery replay retained the conflicted pick and archived accepted integration. Resolve in the active integration worktree, then resume the remaining picks and delivery checks.', ['resolve']) : conflictLive(state.c, conflict) && !conflict.outside?.length
          ? decideData('integration-conflict', `Integrating ${conflict.task} conflicts with accepted work. Resolve the conflict in the integration worktree, or discard the work after a user-gated AMEND removed it.`, ['resolve', 'discard'])
          : decideData('integration-conflict', `A user-gated AMEND removed ${conflict.task}; discard its conflicted integration naming that amendment.`, ['discard'])),
        task: conflict.task, paths: conflict.paths, candidate: conflict.candidate, head: conflict.head, base: conflict.base, attempt: conflict.attempt,
        detail: conflict.detail, evidence: conflict.evidence, worktree: state.c.integration?.path ?? null, tasks: conflictTasks(state.c, conflict),
      };
    }
    case 'request-decision': {
      const scope = planTask(state.c, state.request.task)?.paths ?? [];
      return state.stage === 'orchestrator'
        ? { ...decideData('request', state.request.source === 'admission' ? `Candidate ${state.request.task} changed paths an amendment removed from its scope. Approve admission, decline it, or escalate to the user.` : state.request.source === 'scope' ? `Submitted task ${state.request.task} changed paths outside its scope: ${state.request.paths.join(', ')}. Inspect them; approve to admit exactly these paths (no AMEND), decline incidental output to fail the task with work preserved, or escalate to the user.` : `Writer ${state.request.task} needs: ${state.request.need}. Approve once the paths are in scope (send AMEND to widen it), decline, or escalate to the user.`, ['approve', 'decline', 'escalate']), request: state.request, requestId: state.request.requestId, scope }
        : { ...decideData('request-user', 'The orchestrator escalated this request. Show the request and rationale, then record the user choice and quote.', ['accept', 'decline']), request: state.request, requestId: state.request.requestId, orchestratorRationale: state.orchestratorRationale, scope };
    }
    case 'approval': return decideData('approval', 'Approve these plan paths and verification commands before any writer stage.', ['approve', 'stop'], [{ by: 'required', quote: 'required', paths: state.c.plan ? approvedPaths(state.c.plan) : [], commands: state.c.plan ? commandMappings(state.c.plan).map((row) => row.command) : [] }]);
    case 'needs-user': return decideData('needs-user', `Rule on RED exceptions for ${state.ids.join(', ')} before production work.`, ['accept', 'stop'], state.ids);
    case 'concerns': return decideData('concerns', 'Resolve the writer concerns before code review.', ['accept', 'stop'], state.items);
    case 'failure': return state.c.phase === 'tasks'
      ? { ...decideData('failure', state.reason, ['retry', 'stop'], [{ tasks: state.c.plan ? failureItems(state.c.plan!, state.c.tasks) : [], maxAttempts: MAX_WRITE_ATTEMPTS, worktrees: state.c.integration?.path ?? null, workPreserved: true }]), amend: 'AMEND may change the plan first; changed failed tasks re-pend.' }
      : decideData('failure', state.reason, ['hotfix', 'retry', 'manual-complete', 'stop'], [{ changedPaths: state.changedPaths, workPreserved: true, hotfixWithdrawn: state.c.withdrawnHotfix.includes(state.c.phase === 'delivered' ? 'delivered' : 'baseline') }]);
    case 'drift': return { ...decideData('drift', 'Resolve the recorded change before applying the parked event.', ['preserve', 'refresh', 'reconcile', 'escalate']), notice: state.notice };
    case 'hotfix-write': {
      return {
      stage: 'hotfix', singleShot: true, model: state.c.writer?.models[0], models: state.c.writer?.models.slice(0, 1),
      briefPath: state.brief.path, briefSha256: state.brief.sha256, envelopePath: state.brief.envelopePath, rationale: state.answer.rationale,
      limits: { files: HOTFIX_MAX_FILES, lines: HOTFIX_MAX_LINES },
      };
    }
    case 'evidence': return {
      purpose: state.purpose,
      waiver: 'Only for a criterion the user explicitly waived: outcome "waived" plus top-level waiver { by: "user", quote: <user words> }.',
      summary: state.verify.map((row) => ({ command: row.command, exit: row.exit, logPath: row.logPath, diagnostic: row.diagnostic, status: row.status, failureId: row.failureId })),
      criteria: state.ids.map((id) => {
        const criterion = state.c.plan!.criteria.find((entry) => entry.id === id);
        return { id, title: criterion?.title ?? id, evidenceClass: criterion?.evidence, planHash: state.c.planHash, mutationEpoch: state.c.mutationEpoch, ...(state.c.obligations?.[id] ? { obligation: state.c.obligations[id] } : {}) };
      }),
    };
    case 'complete': return { outcome: 'complete', summary: state.summary, completion: completionData(state.c) };
    case 'stopped': return { outcome: 'stopped', summary: state.summary, completion: completionData(state.c) };
    case 'failed': return { outcome: 'failed', summary: state.summary, completion: state.c ? completionData(state.c) : {} };
    default: return {};
  }
}

function completionData(c: Context): Readonly<Record<string, unknown>> {
  const review = c.codeReview ? reviewData(c.codeReview) : {};
  return {
    planPath: c.planPath, planHash: c.planHash, mutationEpoch: c.mutationEpoch, acceptedBaseline: c.acceptedBaseline,
    settledLevel: c.run.level, levelSource: c.run.levelSource, levelAssessment: c.levelAssessment, levelChoice: c.levelChoice, gateScope: c.gateScope, scopeAdjustments: c.scopeAdjustments,
    finalFocus: c.finalFocus, revisions: c.revisions,
    approval: c.approval, redExceptionRulings: c.redExceptionRulings, concernRulings: c.concernRulings,
    criteria: (c.plan ? c.plan!.criteria : []).map((criterion) => ({ id: criterion.id, evidence: c.evidence[criterion.id] ?? null, lastMutation: c.criterionMutation[criterion.id] ?? 0, ...(c.obligations?.[criterion.id] ? { obligation: c.obligations[criterion.id] } : {}) })),
    observations: c.observations ?? [],
    review: review['completion'] ?? review, limitations: [...c.concerns, ...Object.values(c.evidence).filter((item) => item['outcome'] === 'waived').map((item) => `${item.id}: user-waived criterion; ${item['evidence']}`)], finalGate: c.finalGate,
  };
}

/** Model behind a task's live handle: the attested launch, else its cascade entry; launch slots always show the configured model. */
function activeModel(c: Context, record: TaskRecord): string | undefined {
  return record.handle && record.launchedModel ? record.launchedModel : c.writer?.models[record.modelIndex];
}

function validateTaskEvent(c: Context, event: HostEvent): string | null {
  if (event.type === 'WRITE_RECEIPT') {
    if (typeof event.task !== 'string') return 'event.task: task writers echo task, attempt, signature and handle; taskless receipts belong to the hotfix writer.';
    const receipt = event as TaskReceipt, record = c.tasks[receipt.task];
    if (!record || record.status !== 'running' || receipt.attempt !== record.attempt || receipt.signature !== record.signature || !nonEmpty(receipt.handle)) return 'event.task: echo a running task with its projected attempt, signature and a non-empty handle.';
    if (receipt.status === 'launched') {
      if (record.handle !== null) return `event.status: ${receipt.task} already launched as ${record.handle}.`;
      const mismatch = launchMismatch({ model: c.writer?.models[record.modelIndex], effort: c.writer?.effort }, receipt);
      return mismatch ? `event: ${mismatch}.` : null;
    }
    if (receipt.handle !== record.handle) return 'event.handle: echo the launched handle.';
    if (receipt.status === 'failed' && receipt.model !== activeModel(c, record)) return 'event.model: name the active writer model.';
    if (receipt.status === 'submitted' && record.removed) return record.retainedSubmission ? `event.status: ${receipt.task} already submitted after retirement; confirm its cancellation.` : null;
    if (receipt.status !== 'submitted') return null;
    const entry = record.briefs?.find((row) => row.envelopePath === receipt.envelopePath);
    if (!entry) return 'event.envelopePath: name the envelope path of a brief issued to this attempt.';
    if (receipt.briefHash !== entry.sha256) return 'event.briefHash: echo the hash of the brief the writer worked from.';
    const task = planTask(c, receipt.task);
    if (entry !== record.briefs?.at(-1) && (!task || entry.scope !== taskScope(c.plan!, task))) return `event.briefHash: stale brief; an amendment changed the paths or criteria of ${receipt.task}. Resubmit against brief ${record.brief?.sha256 ?? 'current'}.`;
    return null;
  }
  if (event.type === 'REQUEST') {
    const record = c.tasks[event.task];
    if (!record || record.status !== 'running' || record.removed || event.attempt !== record.attempt) return 'event.task: REQUEST names a running task and its current attempt.';
    if (!nonEmpty(event.need) || !nonEmpty(event.rationale) || !Array.isArray(event.paths) || !event.paths.every(nonEmpty)) return 'event: REQUEST needs a need, a rationale, and a paths array of repository-relative paths.';
  }
  return null;
}

function decisionAnswer(event: HostEvent, kind: string): Record<string, unknown> | null {
  return event.type === 'DECISION' && event.kind === kind && isRecord(event.answer) ? event.answer : null;
}

export function validateImplement(state: ImplementState, event: HostEvent): string | null {
  if (event.changeDispositions) {
    const error = 'c' in state && state.c ? validateDispositions(state.c, event.changeDispositions) : 'event.changeDispositions: no change observation is open.';
    if (error) return error;
  }
  if (event.type === 'REVISE') return 'event.type: Inside implement runs AMEND replaces REVISE; send AMEND with an exact-text delta against the governed plan.';
  if (event.type === 'AMEND') {
    if ((state.tag !== 'tasks' && state.tag !== 'request-decision' && state.tag !== 'integration-conflict' && state.tag !== 'failure')) return 'event.type: AMEND is accepted only in the task phase at a write, request, conflict, or failure frame.';
    const prepared = prepareAmend(state.c, event, state.tag === 'integration-conflict' ? state.conflict : null);
    return prepared.ok ? null : prepared.error;
  }
  if (event.type === 'REPLACE_PLAN') {
    if ((state.tag !== 'tasks' && state.tag !== 'request-decision' && state.tag !== 'integration-conflict' && state.tag !== 'failure')) return 'event.type: REPLACE_PLAN is accepted only in the task phase at a write, request, conflict, or failure frame.';
    const fields = revisionFieldsError(state.c, event);
    if (fields) return fields;
    // NOTE: a stale revision is rejected before any effect, so work and the bound plan stay unchanged.
    if (event.expectedHash !== state.c.planHash) return `event.expectedHash: the run is bound to ${state.c.planHash}; reconcile against the current plan revision.`;
    if (!nonEmpty(event.path) || event.path === state.c.planPath || event.path === planPathFromRun(state.c.run) || state.c.amendments.some((row) => row.path === event.path)) return 'event.path: name a new replacement plan file; earlier plan revisions stay immutable.';
    if (!isRecord(event.reconciliation)) return 'event.reconciliation: list retained, changed, added, and retired tasks with intentChanged and dependencyChanged.';
    return null;
  }
  if (event.type === 'REQUEST' && state.tag !== 'tasks') return 'event.type: REQUEST is accepted only at the task write frame.';
  if (event.type === 'WRITE_RECEIPT' && state.tag !== 'tasks' && state.tag !== 'hotfix-write') return 'event.type: write receipts are accepted only at a write frame.';
  if (event.type === 'DECISION' && event.kind === 'run-stop' && !['level-classification', 'level-recommendation'].includes(state.tag)) return 'event.kind: run-stop is valid only at a level decision gate.';
  if (state.tag === 'hotfix-write' && event.type === 'WRITE_RECEIPT') {
    if (typeof event.task === 'string') return 'event.task: the hotfix writer sends a taskless receipt.';
    if (event.status !== 'submitted' && event.status !== 'failed') return 'event.status: the hotfix writer reports submitted or failed.';
    if (event.status === 'submitted' && event.envelopePath !== state.brief.envelopePath) return 'event.envelopePath: expected the exact hotfix envelope path.';
    if (event.status === 'failed' && event.model !== undefined && event.model !== state.c.writer?.models[0]) return 'event.model: expected the single-shot configured writer.';
  }
  if (state.tag === 'drift' && (event.type !== 'DECISION' || event.kind !== 'drift' || !resolution(event.answer, state.notice))) return 'event.answer: bind the current notice, afterHash, rationale and affected evidence.';
  if (state.tag === 'author' && event.type === 'AUTHORED' && event.path !== state.c.planPath) return `event.path: expected ${state.c.planPath}.`;
  if (state.tag === 'tasks') return validateTaskEvent(state.c, event);
  if (state.tag === 'integration-conflict') {
    const answer = decisionAnswer(event, 'integration-conflict');
    if (!answer || answer['by'] !== 'orchestrator' || !['resolve', 'discard'].includes(String(answer['action'])) || !nonEmpty(answer['rationale'])) return 'event.answer: rule on the conflict with { by: "orchestrator", action: resolve|discard, rationale }.';
    if (state.conflict.replay && answer['action'] !== 'resolve') return 'event.answer.action: delivery replay preserves accepted work; resolve is the only continuation.';
    if (answer['action'] === 'resolve' && state.conflict.outside?.length) return `event.answer.action: the recovered resolution changes ${state.conflict.outside.join(', ')} outside the current scope; discard is the only continuation.`;
    if (answer['action'] === 'resolve' && !conflictLive(state.c, state.conflict)) return `event.answer.action: ${state.conflict.task} is no longer in the plan; discard is the only continuation.`;
    if (answer['action'] === 'discard') {
      const amendment = state.c.amendments.find((row) => row.id === answer['amendment']);
      const touched = [...state.conflict.paths, ...(state.conflict.outside ?? [])];
      const accounted = !!amendment && (amendment.removed.includes(state.conflict.task) || Object.values(amendment.dropped).some((lost) => lost.some((file) => touched.includes(file))));
      if (!amendment?.by || !accounted) return 'event.answer.amendment: discard names a user-gated AMEND (amend-N) that removed or rescoped the conflicting work.';
    }
    return null;
  }
  if (state.tag === 'request-decision') {
    if (state.stage === 'orchestrator') {
      const answer = decisionAnswer(event, 'request');
      if (!answer || answer['by'] !== 'orchestrator' || !['approve', 'decline', 'escalate'].includes(String(answer['action'])) || !nonEmpty(answer['rationale'])) return 'event.answer: rule on the request with { by: "orchestrator", action: approve|decline|escalate, rationale }, or send AMEND.';
      if (answer['action'] === 'approve' && state.request.source === 'writer') {
        const scope = planTask(state.c, state.request.task)?.paths ?? [];
        const outside = state.request.paths.filter((file) => !scope.includes(file));
        if (outside.length) return `event.answer: ${outside.join(', ')} is outside the scope of ${state.request.task}; send AMEND to widen the scope instead of approve.`;
      }
      return null;
    }
    const answer = decisionAnswer(event, 'request-user');
    if (!answer || answer['by'] !== 'user' || answer['requestId'] !== state.request.requestId || !['accept', 'decline'].includes(String(answer['choice'])) || !nonEmpty(answer['quote'])) return 'event.answer: the user choice binds the pending requestId with accept|decline and a non-empty quote.';
    if (answer['choice'] === 'accept' && state.request.source === 'writer' && state.request.paths.some((file) => !(planTask(state.c, state.request.task)?.paths ?? []).includes(file))) return 'event.answer: accepted paths are outside the task scope; send AMEND with the user quote in by.';
    return null;
  }
  if (state.tag === 'level-classification') {
    if (event.type === 'DECISION' && event.kind === 'run-stop') return nonEmpty((event.answer as Record<string, unknown>)['quote']) ? null : 'event.answer.quote: run stop requires the user quote.';
    if (event.type !== 'DECISION' || event.kind !== 'level-classification' || !isRecord(event.answer)) return 'event.kind: expected level-classification or run-stop at this gate.';
    const answer = event.answer;
    if (!['low', 'medium', 'high'].includes(String(answer['evaluatedLevel'])) || !nonEmpty(answer['rationale']) || answer['rationale'].trim().length > 500) return 'event.answer: level assessment requires a low/medium/high level and rationale up to 500 characters.';
    if (!state.c.gateScope || stableValue(answer['gateScope']) !== stableValue(state.gateScope)) return 'event.answer.gateScope: assessment must include the exact complete scope snapshot shown in the frame.';
    return null;
  }
  if (state.tag === 'level-recommendation') {
    if (event.type === 'DECISION' && event.kind === 'run-stop') return nonEmpty((event.answer as Record<string, unknown>)['quote']) ? null : 'event.answer.quote: run stop requires the user quote.';
    if (event.type !== 'DECISION' || event.kind !== 'level-recommendation' || !isRecord(event.answer) || !['adopt', 'retain'].includes(String(event.answer['choice'])) || !nonEmpty(event.answer['quote'])) return 'event.answer: choose adopt or retain with a non-empty user quote.';
    return null;
  }
  if (state.tag === 'code-review' && event.type === 'FIXES_APPLIED') {
    const durable = new Set(state.c.plan!.criteria.filter((row) => row.retain !== 'transient').flatMap((row) => row.changes));
    const deleted = event.clusters.flatMap((cluster) => Array.isArray(cluster['deletedPaths']) ? cluster['deletedPaths'].filter((file): file is string => typeof file === 'string') : []);
    const durableDeleted = deleted.filter((file) => durable.has(file));
    if (durableDeleted.length) return `event.clusters: a fix may not delete files of durable criteria: ${durableDeleted.join(', ')}.`;
  }
  if (state.tag === 'plan-review' || state.tag === 'code-review') return validateReview(state.review, event);
  if (state.tag === 'approval' && event.type === 'DECISION' && event.kind === 'approval' && event.answer !== 'stop' && !approvalAnswer(event.answer)) return 'event.answer: approval requires non-empty user-attributed by and quote.';
  if (state.tag === 'baseline-decision' && event.type === 'DECISION' && event.kind === 'baseline' && event.answer !== 'stop') {
    const recovery = failureAnswer(event.answer);
    if (recovery?.action === 'hotfix') return recovery.mode === 'inline' ? null : 'event.answer: baseline hotfix is inline-only.';
    const ids = isRecord(event.answer) && Array.isArray(event.answer['ids']) ? event.answer['ids'] : [];
    const available = failingBaselineIds(state.items);
    if (!isRecord(event.answer) || event.answer['action'] !== 'accept-known-red' || ids.length !== available.length || new Set(ids).size !== ids.length || available.some((id) => !ids.includes(id))) return 'event.answer: accept-known-red must name every distinct baseline failure identity.';
  }
  if (state.tag === 'needs-user' && event.type === 'DECISION' && event.kind === 'needs-user' && !needsUserRuling(state.ids, event.answer)) return 'event.answer: RED exception ruling requires accept or stop, by, and quote.';
  if (state.tag === 'concerns' && event.type === 'DECISION' && event.kind === 'concerns' && !needsUserRuling(state.items, event.answer)) return 'event.answer: concerns ruling requires accept or stop, by, and quote.';
  if (state.tag === 'failure' && event.type === 'DECISION' && event.kind === 'failure') {
    const answer = failureAnswer(event.answer);
    if (!answer) return 'event.answer: failure requires { by: "orchestrator", action: stop|retry, rationale }, hotfix with mode inline|writer and rationale, or user manual-complete with quote and criteria; unknown fields such as rootCause are rejected.';
    if (state.c.phase === 'tasks' && (answer.action === 'hotfix' || answer.action === 'manual-complete')) return 'event.answer: task-phase failures accept retry or stop; hotfix and manual completion apply after delivery.';
    if (state.c.phase === 'tasks' && answer.action === 'retry' && Object.values(state.c.tasks).some((task) => task.status === 'failed') && !Object.values(state.c.tasks).some((task) => task.status === 'failed' && task.failures < MAX_WRITE_ATTEMPTS)) return `event.answer: every failed task exhausted the ${MAX_WRITE_ATTEMPTS}-failure limit; send AMEND or stop.`;
    if (answer.action === 'manual-complete' && !recordEvidence(state.c, state.c.plan!.criteria.map((row) => row.id), answer.criteria, { by: 'user', quote: answer.quote })) return 'event.criteria: manual completion needs pass or user-waived evidence for every criterion.';
  }
  if (state.tag === 'evidence' && event.type === 'EVIDENCE' && !recordEvidence(state.c, state.ids, event.criteria, event.waiver)) return `event.criteria: provide one bound evidence item for each of ${state.ids.join(', ')}; outcome "waived" needs event.waiver { by: "user", quote }.`;
  return null;
}

const HOST_EVENTS = ['AUTHORED', 'NATIVE_RESULTS', 'RULINGS', 'FIXES_APPLIED', 'WRITE_RECEIPT', 'REQUEST', 'AMEND', 'REPLACE_PLAN', 'DECISION', 'EVIDENCE'] as const;
const TASK_EXITS = ['task-checkout', 'task-brief', 'task-envelope', 'task-verify', 'tasks', 'request-decision', 'integration-conflict', 'failure-snapshot'] as const;

export const implementTransitions = [
  ...['starting', 'author', 'parsing', 'plan-review'].map((from) => ({ from, on: 'SPEC_SETTLED', to: 'author' })),
  { from: 'parsing', on: 'SPEC_SETTLED', to: 'stopped' },
  { from: 'parsing', on: 'EFFECT_FAILED', to: 'stopped' },
  { from: 'plan-review', on: 'EFFECT_FAILED', to: 'stopped' },
  ...['author', 'plan-review', 'code-review', 'evidence', 'baseline-decision', 'approval', 'level-classification', 'level-recommendation', 'integration-conflict', 'request-decision', 'needs-user', 'concerns', 'failure', 'drift'].map((from) => ({ from, on: 'SPEC_SETTLED', to: 'stopped' })),
  { from: 'checking-host-event', on: 'SNAPSHOT', to: 'assessing-host-event' },
  ...['baseline', 'final-verify', 'hotfix-verify', 'task-checkout', 'parsing', 'plan-review', 'code-review', 'evidence', 'concerns', 'approval', 'failure', 'post-review-snapshot', 'trim-snapshot', 'level-classification', 'level-recommendation', 'drift', 'stopped', 'failure-snapshot'].map((to) => ({ from: 'assessing-host-event', on: 'RECOVERY_ASSESSED', to })),
  { from: 'assessing-host-event', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'drift', on: 'DECISION', to: 'checking-host-event' },
  { from: 'hotfix-snapshot', on: 'SNAPSHOT', to: 'hotfix-assessment' },
  ...['hotfix-verify', 'failure', 'baseline-decision', 'failure-snapshot'].map((to) => ({ from: 'hotfix-assessment', on: 'RECOVERY_ASSESSED', to })),
  { from: 'hotfix-assessment', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  ...['author', 'plan-review', 'code-review', 'tasks', 'hotfix-write', 'baseline-decision', 'approval', 'needs-user', 'concerns', 'failure', 'evidence', 'level-classification', 'level-recommendation', 'integration-conflict', 'request-decision'].flatMap((from) => HOST_EVENTS.map((on) => ({ from, on, to: 'checking-host-event' }))),
  ...['parsing', 'plan-review', 'code-review', 'task-checkout', 'tasks', 'needs-user', 'approval', 'baseline-decision', 'level-classification', 'level-recommendation', 'evidence', 'concerns', 'complete', 'stopped', 'failure', 'failure-snapshot', 'drift', 'hotfix-snapshot', 'hotfix-brief', 'hotfix-envelope', 'post-review-snapshot', 'trim-snapshot', 'final-verify'].map((to) => ({ from: 'checking-host-event', on: 'SNAPSHOT', to })),
  { from: 'checking-host-event', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  ...['task-checkout', 'parsing', 'plan-review', 'code-review', 'evidence', 'concerns', 'approval', 'failure', 'post-review-snapshot'].map((to) => ({ from: 'drift', on: 'DECISION', to })),
  { from: 'drift', on: 'DECISION', to: 'stopped' },
  { from: 'baseline-decision', on: 'DECISION', to: 'approval' }, { from: 'baseline-decision', on: 'DECISION', to: 'level-classification' }, { from: 'baseline-decision', on: 'DECISION', to: 'stopped' }, { from: 'approval', on: 'DECISION', to: 'needs-user' }, { from: 'approval', on: 'DECISION', to: 'level-classification' }, { from: 'approval', on: 'DECISION', to: 'stopped' }, { from: 'needs-user', on: 'DECISION', to: 'level-classification' }, { from: 'needs-user', on: 'DECISION', to: 'stopped' },
  { from: 'approval', on: 'DECISION', to: 'task-checkout' }, { from: 'needs-user', on: 'DECISION', to: 'task-checkout' }, { from: 'failure', on: 'DECISION', to: 'task-checkout' },
  { from: 'failure', on: 'DECISION', to: 'tasks' }, { from: 'failure', on: 'DECISION', to: 'post-review-snapshot' }, { from: 'failure', on: 'DECISION', to: 'failure-snapshot' },
  ...TASK_EXITS.map((to) => ({ from: 'failure', on: 'AMEND', to })),
  ...['tasks', 'request-decision', 'integration-conflict', 'failure'].flatMap((from) => [{ from, on: 'REPLACE_PLAN', to: 'plan-replacement' }]),
  ...['tasks', 'request-decision', 'integration-conflict', 'failure', ...TASK_EXITS].flatMap((to) => [{ from: 'plan-replacement', on: 'ARTIFACT_PARSED', to }, { from: 'plan-replacement', on: 'EFFECT_FAILED', to }]),
  ...['task-checkout', 'task-brief', 'tasks', 'task-verify', 'task-envelope', 'integration-conflict', 'request-decision', 'delivered-snapshot', 'trim-snapshot', 'generated-verify', 'final-verify', 'failure-snapshot'].map((to) => ({ from: 'task-checkout', on: 'CHECKOUT_DONE', to })),
  ...['task-checkout', 'tasks', 'failure-snapshot'].map((to) => ({ from: 'task-checkout', on: 'EFFECT_FAILED', to })),
  ...TASK_EXITS.flatMap((to) => [{ from: 'task-brief', on: 'BRIEF_READY', to }, { from: 'task-brief', on: 'EFFECT_FAILED', to }]),
  ...TASK_EXITS.flatMap((to) => [{ from: 'tasks', on: 'WRITE_RECEIPT', to }, { from: 'tasks', on: 'AMEND', to }]),
  { from: 'tasks', on: 'REQUEST', to: 'request-decision' },
  ...TASK_EXITS.flatMap((to) => [{ from: 'task-envelope', on: 'ENVELOPE_CHECKED', to }, { from: 'task-envelope', on: 'EFFECT_FAILED', to }]),
  ...TASK_EXITS.flatMap((to) => [{ from: 'task-verify', on: 'VERIFY_DONE', to }, { from: 'task-verify', on: 'EFFECT_FAILED', to }]),
  ...['task-checkout', 'task-verify', 'tasks', 'failure-snapshot'].map((to) => ({ from: 'integration-conflict', on: 'DECISION', to })),
  ...TASK_EXITS.map((to) => ({ from: 'integration-conflict', on: 'AMEND', to })),
  ...['request-decision', ...TASK_EXITS].flatMap((to) => [{ from: 'request-decision', on: 'DECISION', to }, { from: 'request-decision', on: 'AMEND', to }]),
  ...['concerns', 'code-review', 'post-review-snapshot', 'failure-snapshot'].map((to) => ({ from: 'delivered-snapshot', on: 'SNAPSHOT', to })),
  { from: 'delivered-snapshot', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'hotfix-brief', on: 'BRIEF_READY', to: 'hotfix-write' }, { from: 'hotfix-brief', on: 'EFFECT_FAILED', to: 'failure' },
  { from: 'hotfix-write', on: 'WRITE_RECEIPT', to: 'hotfix-envelope' }, { from: 'hotfix-write', on: 'WRITE_RECEIPT', to: 'failure' },
  { from: 'hotfix-envelope', on: 'ENVELOPE_CHECKED', to: 'hotfix-snapshot' }, { from: 'hotfix-envelope', on: 'ENVELOPE_CHECKED', to: 'failure' }, { from: 'hotfix-envelope', on: 'EFFECT_FAILED', to: 'failure' },
  ...['hotfix-verify', 'failure', 'baseline-decision', 'failure-snapshot'].map((to) => ({ from: 'hotfix-snapshot', on: 'SNAPSHOT', to })),
  { from: 'hotfix-snapshot', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'hotfix-verify', on: 'EFFECT_FAILED', to: 'failure' }, { from: 'hotfix-verify', on: 'EFFECT_FAILED', to: 'baseline-decision' },
  ...['post-review-snapshot', 'final-verify', 'approval', 'checking-host-event'].map((to) => ({ from: 'hotfix-verify', on: 'VERIFY_DONE', to })),
  { from: 'code-review', on: 'REVIEW_PREPARED', to: 'post-review-snapshot' },
  { from: 'code-review', on: 'VERIFY_DONE', to: 'post-review-snapshot' },
  { from: 'code-review', on: 'DECISION', to: 'post-review-snapshot' },
  { from: 'code-review', on: 'DECISION', to: 'failure-snapshot' },
  { from: 'plan-review', on: 'REVIEW_PREPARED', to: 'parsing' },
  { from: 'plan-review', on: 'VERIFY_DONE', to: 'parsing' },
  { from: 'plan-review', on: 'DECISION', to: 'parsing' },
  { from: 'plan-review', on: 'DECISION', to: 'failure-snapshot' },
  { from: 'booting', on: 'RUN_STARTED', to: 'starting' },
  { from: 'starting', on: 'SNAPSHOT', to: 'author' }, { from: 'starting', on: 'SNAPSHOT', to: 'parsing' }, { from: 'starting', on: 'EFFECT_FAILED', to: 'failed' },
  { from: 'author', on: 'AUTHORED', to: 'parsing' },
  { from: 'parsing', on: 'ARTIFACT_PARSED', to: 'plan-review' }, { from: 'parsing', on: 'ARTIFACT_PARSED', to: 'baseline-preflight' }, { from: 'parsing', on: 'ARTIFACT_PARSED', to: 'author' }, { from: 'parsing', on: 'ARTIFACT_PARSED', to: 'failure-snapshot' },
  { from: 'parsing', on: 'EFFECT_FAILED', to: 'author' }, { from: 'parsing', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'plan-review', on: 'RULINGS', to: 'parsing' }, { from: 'plan-review', on: 'FIXES_APPLIED', to: 'plan-review' }, { from: 'plan-review', on: 'WAVE_DONE', to: 'parsing' }, { from: 'plan-review', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'baseline-preflight', on: 'SNAPSHOT', to: 'baseline' }, { from: 'baseline-preflight', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'baseline', on: 'VERIFY_DONE', to: 'baseline-snapshot' }, { from: 'baseline', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'baseline-snapshot', on: 'SNAPSHOT', to: 'baseline-decision' }, { from: 'baseline-snapshot', on: 'SNAPSHOT', to: 'approval' }, { from: 'baseline-snapshot', on: 'EFFECT_FAILED', to: 'failed' },
  { from: 'evidence', on: 'EVIDENCE', to: 'evidence' }, { from: 'evidence', on: 'EVIDENCE', to: 'complete' },
  { from: 'concerns', on: 'DECISION', to: 'code-review' }, { from: 'concerns', on: 'DECISION', to: 'stopped' },
  { from: 'code-review', on: 'RULINGS', to: 'post-review-snapshot' }, { from: 'code-review', on: 'WAVE_DONE', to: 'post-review-snapshot' }, { from: 'code-review', on: 'FIXES_APPLIED', to: 'code-review' }, { from: 'code-review', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  ...['generated-verify', 'task-checkout', 'final-verify', 'failure-snapshot'].map((to) => ({ from: 'post-review-snapshot', on: 'SNAPSHOT', to })), { from: 'post-review-snapshot', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'generated-verify', on: 'VERIFY_DONE', to: 'generated-snapshot' }, { from: 'generated-verify', on: 'VERIFY_DONE', to: 'failure-snapshot' }, { from: 'generated-verify', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  ...['task-checkout', 'final-verify', 'failure-snapshot', 'assessing-host-event'].map((to) => ({ from: 'generated-snapshot', on: 'SNAPSHOT', to })), { from: 'generated-snapshot', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'trim-snapshot', on: 'SNAPSHOT', to: 'final-verify' }, { from: 'trim-snapshot', on: 'SNAPSHOT', to: 'failure-snapshot' }, { from: 'trim-snapshot', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'final-verify', on: 'VERIFY_DONE', to: 'evidence' }, { from: 'final-verify', on: 'VERIFY_DONE', to: 'complete' }, { from: 'final-verify', on: 'VERIFY_DONE', to: 'checking-host-event' }, { from: 'final-verify', on: 'VERIFY_DONE', to: 'failure-snapshot' }, { from: 'final-verify', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'failure-snapshot', on: 'SNAPSHOT', to: 'failure' }, { from: 'failure-snapshot', on: 'SNAPSHOT', to: 'failed' }, { from: 'failure-snapshot', on: 'EFFECT_FAILED', to: 'failed' },
  { from: 'failure', on: 'DECISION', to: 'stopped' }, { from: 'failure', on: 'DECISION', to: 'complete' }, { from: 'failure', on: 'DECISION', to: 'hotfix-brief' }, { from: 'failure', on: 'DECISION', to: 'hotfix-snapshot' },
] as const;
export function implementWalkthrough(state: ImplementState): WalkthroughView | null {
  if (state.tag !== 'complete' && state.tag !== 'stopped' && state.tag !== 'failed' && state.tag !== 'code-review') return null;
  if (!state.c || !state.c.plan) return null;
  const c = state.c;
  const plan = c.plan!;
  if (!plan) return null;
  const status = state.tag === 'code-review' ? 'review pending' : state.tag;
  const planRounds = c.planReview && 'c' in c.planReview ? resolutionRounds(c.planReview.c) : [];
  const codeRounds = c.codeReview && 'c' in c.codeReview ? resolutionRounds(c.codeReview.c) : [];
  return {
    title: plan.title ?? c.planPath, delivered: plan.box['TL;DR'] ?? plan.title ?? c.planPath, parent: c.planPath, status,
    changes: plan.changes.map((change) => ({ action: change.action, path: change.path, note: change.note || `Plan ${change.action.toLowerCase()} entry.` })),
    verification: plan.criteria.flatMap((criterion) => {
      const item = c.evidence[criterion.id];
      return item ? [{ sc: criterion.id, outcome: String(item['outcome'] ?? 'recorded'), evidence: String(item['evidence'] ?? item.source) }] : [];
    }),
    finalGate: c.finalGate, deviations: c.concerns, followUps: plan.verification.manual,
    revisions: c.revisions, rounds: [...planRounds, ...codeRounds],
  };
}

export function renderImplementWalkthrough(state: ImplementState): string | null {
  const view = implementWalkthrough(state);
  return view ? renderWalkthrough(view) : null;
}

export const implementMachine: Machine<ImplementState> = {
  initial: initialImplement,
  step: stepImplement,
  awaitOf: implementAwait,
  project: (state) => ({ at: `implement › ${state.tag}${state.tag === 'plan-review' || state.tag === 'code-review' ? ` › ${state.review.tag}` : ''}`, data: implementData(state) }),
  transitions: implementTransitions,
  validate: validateImplement,
};
