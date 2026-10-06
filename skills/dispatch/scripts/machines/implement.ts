// @ts-check

import type { Await, CheckoutOp, Effect, Event, HostEvent, Machine, RunStartedEvent, TreeFingerprint, VerifyCommand, LevelGateScope, LevelClassificationAnswer, LevelRecommendationAnswer, ScopeAdjustment, ScopeCriterionDefinition, ScopeDeviation, ScopeProposal, PlanAmendment } from '../core/types.ts';
import { stableValue } from '../domain/stable-value.ts';
import { renderWalkthrough, walkthroughPathOf } from '../domain/render.ts';
import type { ParsedPlan, PlanCriterion, PlanTask, WalkthroughView } from '../domain/types.ts';
import { generatedCommands, approvedPaths, approvalAnswer, asParsedPlan, commandEffect, commandMappings, criterionEvidenceRows, isFingerprint, isTestPath, isWriterEnvelope, parseRedMatrix, sameFingerprint, settledPlanInput, writerConfig, type CommandMapping, type EvidenceRecord, type RedMatrixRow, type VerifyRecord, type WriterConfig } from './implement-types.ts';
import { beginReview, resolutionRounds, reviewAwait, reviewData, reviewSpecFromRun, stepReview, validateReview, type ReviewState } from './review.ts';
import { answers, isRecord, launchDrift, launchMismatch, never, nextId, stay, type Counters, type Step } from './types.ts';
import { recoverySnapshot, failureAnswer, driftAnswer, artifactRelative, type FailureAnswer } from './implement-types.ts';
import { classifyDrift } from '../policy/drift.ts';
import { judgeHotfix, HOTFIX_MAX_FILES, HOTFIX_MAX_LINES } from '../policy/hotfix.ts';
import { selectTaskBrief, validateDesignTraceability } from '../domain/plan.ts';
import { activeTasks, checkpointPathOf, failureItems, initialTasks, invalidatesIntegration, rependTasks, readyTasks, reconcileTasks, taskCriteria, taskRedCriteria, taskTestPaths, worktreeName, writeConcurrency, type TaskAmendment, type TaskRecord, type Tasks } from './implement-tasks.ts';
import { slugOf } from './plan.ts';
import type { DesignBinding } from './implement-types.ts';

export const IMPLEMENT_TEMPLATE = 'references/templates/plan.md';
export const MAX_WRITE_ATTEMPTS = 3;

type PlanReviewResult = 'initial' | 'rebind';
export type Context = {
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
  redMatrix: readonly RedMatrixRow[];
  concerns: readonly string[];
  approvedRedExceptions: readonly string[];
  redExceptionRulings: Readonly<Record<string, { decision: 'accept'; by: string; quote: string }>>;
  concernRulings: Readonly<Record<string, { decision: 'accept'; by: string; quote: string }>>;
  /** `tasks` from approval until verified delivery; caller checkout effects and drift checks apply outside it. */
  phase: 'setup' | 'tasks' | 'delivered';
  tasks: Tasks;
  integration: { path: string; base: string; head: string; links: readonly string[]; ignored: readonly string[]; rewind?: boolean } | null;
  approval: { by: string; quote: string } | null;
  changedPaths: readonly string[];
  finalGate: string;
  failureReason: string | null;
  adoptedPaths: readonly string[];
  finalFocus: readonly string[];
  withdrawnHotfix: readonly string[];
  retryContext: { rootCause: string; failure: string } | null;
  stalled: { purpose: 'baseline' | 'final'; rows: readonly VerifyRecord[] } | null;
  revisions: readonly { artifact: 'plan'; reason: string; beforeHash: string; afterHash: string; rebind: { retained: readonly string[]; pending: readonly string[]; removed: readonly string[] } }[];
  revisionReviewRound: number;
  levelGatePassed: boolean;
  gateScope: LevelGateScope | null;
  levelAssessment: LevelClassificationAnswer | null;
  levelChoice: LevelRecommendationAnswer | null;
  scopeAdjustments: readonly ScopeAdjustment[];
  scopeNotice: { requestId: string; approvedBy: 'orchestrator' | 'user'; rationale: string; quote?: string } | null;
  scopeRebaseQueue: readonly string[];
};

type CheckoutStep = 'init' | 'task' | 'relaunch' | 'scope-rebase' | 'commit' | 'red' | 'integrate' | 'reset' | 'rewind' | 'deliver' | 'cleanup';

export type ImplementState =
  | { tag: 'revision-request'; c: Context; parent: ImplementState; event: Extract<HostEvent, { type: 'REVISE' }> }
  | { tag: 'checking-host-event'; c: Context; parent: ImplementState; parked: HostEvent; effectId: string }
  | { tag: 'drift'; c: Context; parent: ImplementState; parked: HostEvent; paths: readonly string[]; fingerprint: TreeFingerprint }
  | { tag: 'hotfix-brief'; c: Context; origin: RecoveryOrigin; before: TreeFingerprint; effectId: string; answer: Extract<FailureAnswer, { action: 'hotfix' }> }
  | { tag: 'hotfix-write'; c: Context; origin: RecoveryOrigin; before: TreeFingerprint; brief: { path: string; sha256: string; envelopePath: string }; answer: Extract<FailureAnswer, { action: 'hotfix' }> }
  | { tag: 'hotfix-envelope'; c: Context; origin: RecoveryOrigin; before: TreeFingerprint; effectId: string; answer: Extract<FailureAnswer, { action: 'hotfix' }> }
  | { tag: 'hotfix-snapshot'; c: Context; origin: RecoveryOrigin; before: TreeFingerprint; effectId: string; answer: Extract<FailureAnswer, { action: 'hotfix' }> }
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
  | { tag: 'scope-adjudication'; c: Context; request: ScopeProposal; task: string | null; active: readonly string[]; hotfixResume: HotfixResume | null }
  | { tag: 'scope-user-decision'; c: Context; request: ScopeProposal; task: string | null; active: readonly string[]; orchestratorRationale: string; hotfixResume: HotfixResume | null }
  | { tag: 'scope-draining'; c: Context; request: ScopeProposal | null; adjustment: ScopeAdjustment | null; requester: string | null; active: readonly string[]; drained: readonly string[]; stopAfterDrain: boolean; hotfixResume: HotfixResume | null; rejectedScopeRequests?: readonly { task: string; requestId: string | null; summary: string }[] }
  | { tag: 'scope-drain-envelope'; c: Context; parent: Extract<ImplementState, { tag: 'scope-draining' }>; effectId: string; task: string }
  | { tag: 'approval'; c: Context }
  | { tag: 'needs-user'; c: Context; ids: readonly string[] }
  | { tag: 'task-checkout'; c: Context; effectId: string; step: CheckoutStep; task: string | null; reason: string | null }
  | { tag: 'task-brief'; c: Context; effectId: string; task: string }
  | { tag: 'task-prewrite-snapshot'; c: Context; effectId: string; task: string }
  | { tag: 'tasks'; c: Context }
  | { tag: 'task-envelope'; c: Context; effectId: string; task: string }
  | { tag: 'task-verify'; c: Context; effectId: string; task: string; purpose: 'red' | 'green' | 'integration'; previous: string | null }
  | { tag: 'delivered-snapshot'; c: Context; effectId: string }
  | { tag: 'evidence'; c: Context; purpose: 'final'; ids: readonly string[]; verify: readonly VerifyRecord[] }
  | { tag: 'concerns'; c: Context; items: readonly string[] }
  | { tag: 'code-review'; c: Context; review: ReviewState }
  | { tag: 'post-review-snapshot'; c: Context; effectId: string }
  | { tag: 'generated-verify'; c: Context; effectId: string; count: number; before: TreeFingerprint }
  | { tag: 'generated-snapshot'; c: Context; effectId: string; before: TreeFingerprint; paths: readonly string[] }
  | { tag: 'final-verify'; c: Context; effectId: string; before: TreeFingerprint }
  | { tag: 'failure-snapshot'; c: Context; effectId: string; reason: string }
  | { tag: 'failure'; c: Context; reason: string; changedPaths: readonly string[] }
  | { tag: 'complete'; c: Context; summary: string }
  | { tag: 'stopped'; c: Context; summary: string }
  | { tag: 'failed'; c: Context | null; summary: string };

type S = Step<ImplementState>;
type RecoveryOrigin = Extract<ImplementState, { tag: 'failure' | 'baseline-decision' }>;
type LevelGateResume = { kind: 'tasks' } | { kind: 'baseline-hotfix'; origin: Extract<ImplementState, { tag: 'baseline-decision' }>; answer: Extract<FailureAnswer, { action: 'hotfix' }> };
type HotfixResume = { origin: RecoveryOrigin; answer: Extract<FailureAnswer, { action: 'hotfix' }> };
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
    run, planPath, counters: {}, writer: writer.ok ? writer.value : null, writerError: writer.ok ? null : writer.error,
    plan: null, planHash: null, planReview: null, codeReview: null, startFingerprint: null, lastFingerprint: null,
    mutationEpoch: 0, criterionMutation: {}, baseline: [], acceptedBaseline: [], records: {}, evidence: {}, redMatrix: [], concerns: [],
    approvedRedExceptions: [], redExceptionRulings: {}, concernRulings: {}, phase: 'setup', tasks: {}, integration: null,
    approval: null, changedPaths: [], finalGate: 'pending', failureReason: null,
    adoptedPaths: [], finalFocus: [], withdrawnHotfix: [], retryContext: null, stalled: null, revisions: [], revisionReviewRound: 0,
    levelGatePassed: false, gateScope: null, levelAssessment: null, levelChoice: null, scopeAdjustments: [], scopeNotice: null, scopeRebaseQueue: [],
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
  return { state: { tag: 'parsing', c, effectId: id, phase }, effects: [{ kind: 'parse-artifact', id, path: c.planPath, artifact: 'plan' }] };
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
  return 'c' in review ? review.c.counters : fallback;
}

export function planReviewContext(c: Context, invocationContext: string | null | undefined): string | null {
	const context = invocationContext ?? null;
	return c.designBinding ? JSON.stringify({ invocationContext: context, invocationLevel: c.run.level, invocationLevelSource: c.run.levelSource }) : context;
}

function startReview(c0: Context): S {
  const built = reviewSpecFromRun(c0.run, 'plan', 'fix', c0.planPath);
  if (!built.ok) return beginFailure(c0, built.error);
  const spec = { ...built.spec, context: planReviewContext(c0, built.spec.context) };
  const result = beginReview(spec, `${c0.machinePath ?? 'implement'}.plan-review`, c0.counters);
  return fromPlanReview(c0, result);
}

function fromPlanReview(c0: Context, result: Step<ReviewState>): S {
  const review = result.state;
  const c = { ...c0, counters: reviewCtxCounters(review, c0.counters), planReview: review };
  switch (review.tag) {
    case 'settled': case 'skipped': return parsePlan(c, 'rebind');
    case 'failed': return beginFailure(c, `plan review failed: ${review.detail}`);
    case 'escalated': case 'empty': return beginFailure(c, `plan review did not settle: ${review.tag}`);
    case 'booting': case 'prepare': case 'wave': case 'native': case 'rule': case 'decide-needs-user': case 'fix': case 'fix-verify':
    case 'decide-escalation': case 'decide-opt-in': return { state: { tag: 'plan-review', c, review }, effects: result.effects };
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
  return effectivePlan(c).criteria.filter((criterion) => criterion.evidence === 'red');
}

function activeRedCriteria(c: Context): PlanCriterion[] { return redCriteria(c).filter((criterion) => !criterion.redException); }

function beginPostApproval(c: Context): S {
  const exceptionIds = redCriteria(c).filter((criterion) => criterion.redException).map((criterion) => criterion.id);
  if (exceptionIds.some((id) => !c.approvedRedExceptions.includes(id))) return stay({ tag: 'needs-user', c, ids: exceptionIds.filter((id) => !c.approvedRedExceptions.includes(id)) });
  return beginLevelGate(c, { kind: 'tasks' });
}

// SECTION: Task scheduler

function checkout(c0: Context, step: CheckoutStep, op: Exclude<CheckoutOp, 'scope-rebase'>, input: Readonly<Record<string, unknown>>, task: string | null = null, reason: string | null = null): S {
  const { c, id } = effectId(c0, 'checkout');
  return { state: { tag: 'task-checkout', c, effectId: id, step, task, reason }, effects: [{ kind: 'checkout', id, op, input }] };
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
    effects: [{ kind: 'checkout', id: effectIdValue, op: 'scope-rebase', input: { name, originalName, revision, permitted: planTask(c0, id)?.paths ?? [], transferKey, links: c0.integration?.links ?? [], ignored: c0.integration?.ignored ?? [] } }],
  };
}

function nextScopeRebase(c: Context): S {
  const [id, ...rest] = c.scopeRebaseQueue;
  if (!id) return schedule({ ...c, scopeRebaseQueue: [] });
  return rebaseTaskDraft({ ...c, scopeRebaseQueue: rest }, id);
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

function applicableScopeAdjustments(c: Context): ScopeAdjustment[] {
  return c.scopeAdjustments.filter((adjustment) => {
    const { proposal } = adjustment;
    if (c.designBinding) {
      if (proposal.source === 'design-revision') {
        if (!proposal.affectedIncrements.includes(c.designBinding.increment)) return false;
      } else if (adjustment.ownerIncrement !== c.designBinding.increment) return false;
    } else if (adjustment.ownerIncrement !== undefined) return false;
    return proposal.source === 'design-revision'
      ? c.designBinding?.revision === proposal.proposedArtifactHash
      : proposal.baseArtifactHash === c.planHash;
  });
}

function planCriterion(definition: ScopeCriterionDefinition): PlanCriterion {
  return {
    ...definition, line: 0, verify: definition.verify.map((command) => ({ ...command })),
  };
}

export function effectivePlan(c: Context): ParsedPlan {
  const base = c.plan as ParsedPlan;
  // NOTE: Revisions fold earlier overlays into their artifact; retain only overlays based on the current artifact.
  const applicable = applicableScopeAdjustments(c);
  const implementationAdjustments = applicable.filter(({ proposal }) => proposal.source !== 'design-revision');
  const taskAdjustments = (id: string) => implementationAdjustments.filter(({ proposal }) =>
    proposal.source === 'task' && proposal.task === id || proposal.source === 'plan-revision' && proposal.affectedTasks.includes(id));
  const tasks = base.tasks.map((task) => {
    const adjustments = taskAdjustments(task.id);
    const paths = [...new Set([...task.paths, ...adjustments.flatMap(({ proposal }) => [
      ...proposal.delta.paths,
      ...(proposal.delta.criterionDefinitions ?? []).flatMap((definition) => definition.changes),
    ])])].sort();
    const criteria = [...new Set([...task.criteria, ...adjustments.flatMap(({ proposal }) => proposal.delta.criteria)])].sort();
    const obligations = adjustments.flatMap(({ proposal }) => proposal.delta.obligations);
    const summary = obligations.length ? `${task.summary}\nApproved obligations: ${obligations.join('; ')}` : task.summary;
    return { ...task, paths, criteria, summary };
  });
  const definitions = implementationAdjustments.flatMap(({ proposal }) => proposal.delta.criterionDefinitions ?? []);
  const criteria = [...base.criteria];
  for (const definition of definitions) {
    const replacement = planCriterion(definition);
    const index = criteria.findIndex((row) => row.id === replacement.id);
    if (index < 0) criteria.push(replacement); else criteria[index] = replacement;
  }
  const extraPaths = [...new Set(applicable.flatMap(({ proposal }) => [
    ...proposal.delta.paths,
    ...(proposal.delta.criterionDefinitions ?? []).flatMap((definition) => definition.changes),
  ]))];
  const changes = [...base.changes, ...extraPaths.filter((file) => !base.changes.some((row) => row.path === file)).map((file) => ({ action: 'MODIFY' as const, path: file, note: 'Accepted implementation scope adjustment', command: null, line: 0 }))];
  const commands = implementationAdjustments.flatMap(({ proposal }) => proposal.delta.commands);
  const finalCommands = implementationAdjustments.flatMap(({ proposal }) => [
    ...(proposal.delta.finalCommands ?? []),
    ...(proposal.delta.criterionDefinitions ?? []).flatMap((definition) => definition.verify.filter((item) => item.final).map((item) => item.command)),
  ]);
  const criterionCommands = definitions.flatMap((definition) => definition.verify.filter((item) => !item.final).map((item) => item.command));
  const phaseDuties = implementationAdjustments.flatMap(({ proposal }) => proposal.delta.phaseDuties);
  const keyDecisions = [...base.keyDecisions, ...applicable.flatMap(({ proposal }) => proposal.delta.obligations)];
  return {
    ...base, tasks, criteria, changes, keyDecisions,
    verification: { ...base.verification, automated: [...new Set([...base.verification.automated, ...commands, ...criterionCommands])], manual: [...new Set([...base.verification.manual, ...phaseDuties])] },
    finalCommands: [...new Set([...base.finalCommands, ...finalCommands])],
  };
}

function planTask(c: Context, id: string): PlanTask | undefined { return effectivePlan(c).tasks.find((task) => task.id === id); }

function taskWorktreeName(record: TaskRecord): string {
  return record.worktree?.split(/[\\/]/).at(-1) || worktreeName('task', record.id);
}

/** Prepares the first ready task while a slot is free; otherwise waits on running writers, delivers, or asks once. */
function schedule(c: Context): S {
  if (c.pendingWriter && !activeTasks(c.tasks).length) {
    const { pendingWriter, ...bound } = c;
    c = { ...bound, writer: pendingWriter };
  }
  const plan = effectivePlan(c);
  // NOTE: a revision invalidated accepted work; once writers drain, rebuild integration from the baseline.
  if (c.integration?.rewind) {
    if (activeTasks(c.tasks).length) return stay({ tag: 'tasks', c });
    return checkout({ ...c, tasks: rependTasks(c.tasks, plan) }, 'rewind', 'reset', { name: 'integration', revision: c.integration.base });
  }
  if (c.scopeRebaseQueue.length) return nextScopeRebase(c);
  const next = readyTasks(plan, c.tasks, MAX_WRITE_ATTEMPTS)[0];
  if (next && activeTasks(c.tasks).length < writeConcurrency(c.run.config)) {
    const record = c.tasks[next.id] as TaskRecord;
    const integration = c.integration!;
    if (record.preserveDraft && record.worktree) return record.input === integration.head ? captureTaskBaseline(c, next.id, true) : rebaseTaskDraft(c, next.id);
    return checkout(withTask(c, next.id, { attempt: record.attempt + 1, modelIndex: 0, handle: null, brief: null, candidate: null, integrated: null, redRows: [], preserveDraft: false }), 'task', 'task',
      { name: worktreeName('task', next.id), revision: integration.head, reset: true, links: integration.links, ignored: integration.ignored }, next.id);
  }
  if (activeTasks(c.tasks).length) return stay({ tag: 'tasks', c });
  if (plan.tasks.every((task) => c.tasks[task.id]?.status === 'accepted')) {
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

function taskBriefInput(c: Context, record: TaskRecord): Readonly<Record<string, unknown>> {
  const plan = effectivePlan(c);
  const brief = selectTaskBrief(plan, record.id)!;
  const testPaths = taskTestPaths(plan, brief.task);
  return {
    planPath: c.planPath, planHash: c.planHash,
    designBinding: briefDesignBinding(c), reopenedDefects: c.designBinding?.repair,
    governingOutcome: { title: plan.title, outcome: plan.box['TL;DR'] ?? plan.title ?? c.planPath },
    task: {
      id: brief.task.id, title: brief.task.title, summary: brief.task.summary, graph: brief.summary, attempt: record.attempt, signature: record.signature,
      prerequisites: brief.prerequisites.map((task) => ({ id: task.id, integrated: c.tasks[task.id]?.integrated ?? null })),
      dependents: brief.dependents.map((task) => task.id), worktree: record.worktree, inputRevision: record.input,
      checkpoint: testPaths.length ? { root: record.worktree, paths: testPaths } : null,
    },
    settledScope: { paths: brief.task.paths, approvedPaths: brief.task.paths, changes: brief.changes, acceptedAdjustments: applicableScopeAdjustments(c).filter(({ proposal }) => proposal.source === 'task' && proposal.task === record.id || proposal.source === 'plan-revision' && proposal.affectedTasks.includes(record.id)).map(({ proposal, approvedBy }) => ({
      requestId: proposal.requestId, source: proposal.source, ...(proposal.source === 'task' ? { task: proposal.task } : proposal.source === 'plan-revision' ? { affectedTasks: proposal.affectedTasks } : {}),
      approvedBy, delta: proposal.delta,
    })) },
    criteria: brief.criteria.map((criterion) => ({ id: criterion.id, title: criterion.title, changes: criterion.changes, verify: criterion.verify, evidence: criterion.evidence, preExisting: criterion.preExisting, redException: criterion.redException, testRationale: criterion.testRationale })),
    envelopeSchema: {
      schemaVersion: 1, stage: 'COMPLETE',
      status: ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED', 'SCOPE_REQUEST'], summary: 'non-empty string',
      scopeRequest: { requestId: '<stable id>', source: 'task', task: record.id, baseArtifactHash: c.planHash, writerRationale: '<why expansion is required>', delta: { paths: [], criteria: [], criterionDefinitions: [], obligations: [], commands: [], finalCommands: [], phaseDuties: [], increments: [] } },
      evidence: [
        'CRITERION <SC#> | <one path from that criterion Changes list> | <delivered behavior>',
        ...(testPaths.length ? ['RED-MATRIX <SC#> | <approved-test-path>:<leaf test> | exit <nonzero> test:<observed failure identifier>'] : []),
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
  const mappings = new Map(commandMappings(effectivePlan(c)).map((mapping) => [mapping.command, mapping]));
  for (const adjustment of applicableScopeAdjustments(c)) {
    const proposal = adjustment.proposal;
    if (!(proposal.source === 'task' && proposal.task === id || proposal.source === 'plan-revision' && proposal.affectedTasks.includes(id))) continue;
    for (const command of proposal.delta.commands) {
      const old = mappings.get(command);
      mappings.set(command, { command, criteria: [...new Set([...(old?.criteria ?? []), ...proposal.delta.criteria])], paths: [...new Set([...(old?.paths ?? []), ...proposal.delta.paths])], final: false });
    }
  }
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
  const c = withTask({ ...c0, integration: { ...c0.integration!, head: revision }, redMatrix }, id, { status: 'accepted', handle: null, integrated: revision, reason: null, amendment: null });
  return schedule(markMutation(c, paths));
}

function admitEnvelope(c: Context, id: string, event: Extract<Event, { type: 'ENVELOPE_CHECKED' }>): S {
  const plan = effectivePlan(c), task = planTask(c, id), record = c.tasks[id] as TaskRecord;
  if (!task) return taskFailed(c, id, 'Task is no longer in the governed plan.');
  const envelope = event.envelope;
  if (isRecord(envelope) && envelope['status'] === 'SCOPE_REQUEST') {
    const outside = diffPaths(event).filter((file) => !task.paths.includes(file));
    if (outside.length) return taskFailed(c, id, `Scope request rejected after out-of-envelope edits: ${outside.join(', ')}.`);
    const request = envelope['scopeRequest'] as ScopeDeviation | undefined;
    if (event.defects.length || !request || request.source !== 'task' || request.task !== id || request.baseArtifactHash !== c.planHash) return taskFailed(c, id, `Scope request rejected: ${event.defects.join('; ') || 'request must bind this task and the active plan hash.'}`);
    const defect = scopeDeltaDefect(plan, request);
    if (defect) return taskFailed(c, id, `Scope request rejected: ${defect}`);
    if (request.delta.paths.every((file) => task.paths.includes(file)) && !request.delta.criteria.length && !request.delta.obligations.length && !request.delta.commands.length && !(request.delta.finalCommands?.length) && !request.delta.phaseDuties.length && !(request.delta.criterionDefinitions?.length) && !request.delta.increments.length) return taskFailed(c, id, 'Scope request does not add any work outside its current brief.');
    return beginScopeAdjudication(c, request, id, null);
  }
  if (event.defects.length || !isWriterEnvelope(envelope)) return taskFailed(c, id, `Envelope rejected: ${event.defects.join('; ') || 'malformed envelope.'}`);
  const outside = diffPaths(event).filter((file) => !task.paths.includes(file));
  if (outside.length) return taskFailed(c, id, `Writer changed paths outside the task scope: ${outside.join(', ')}.`);
  if (envelope.stage !== 'COMPLETE') return taskFailed(c, id, `Envelope stage must be COMPLETE; got ${envelope.stage}.`);
  if (envelope.status === 'NEEDS_CONTEXT' || envelope.status === 'BLOCKED') return taskFailed(c, id, `Writer returned ${envelope.status}: ${envelope.summary}`, envelope.amendment ? resolveAmendment(plan, envelope.amendment) : null);
  const missing = criterionEvidenceRows(envelope.evidence, taskCriteria(plan, task));
  if (missing.length) return taskFailed(c, id, `Evidence is missing criterion rows for ${missing.join(', ')}.`);
  const redCriteriaOfTask = taskRedCriteria(plan, task);
  const red = redCriteriaOfTask.length ? parseRedMatrix(envelope.evidence, redCriteriaOfTask) : { rows: [], defects: [] };
  if (red.defects.length) return taskFailed(c, id, `RED matrix rejected: ${red.defects.join('; ')}`);
  const concerns = envelope.status === 'DONE_WITH_CONCERNS' ? (envelope.concerns ?? []).map((item) => `${id}: ${item}`) : [];
  const next = withTask({ ...c, concerns: [...new Set([...c.concerns, ...concerns])] }, id, { redRows: red.rows });
  return checkout(next, 'commit', 'commit', { name: taskWorktreeName(record), base: record.input, message: `dispatch task ${id} attempt ${record.attempt}` }, id);
}

function scopeDeltaDefect(plan: ParsedPlan, request: ScopeDeviation): string | null {
  if (request.delta.increments.length) return 'task and hotfix requests cannot add design increments.';
  const known = new Set(plan.criteria.map((criterion) => criterion.id));
  const definitions = request.delta.criterionDefinitions ?? [];
  const defined = new Set(definitions.map((definition) => definition.id));
  const missing = request.delta.criteria.filter((id) => !known.has(id) && !defined.has(id));
  if (missing.length) return `new criteria require full definitions: ${[...new Set(missing)].join(', ')}.`;
  if (definitions.some((definition) => !request.delta.criteria.includes(definition.id))) return 'every criterion definition must appear in delta.criteria.';
  const allowed = new Set([...approvedPaths(plan), ...request.delta.paths]);
  const outside = definitions.flatMap((definition) => definition.changes.filter((file) => !allowed.has(file)));
  if (outside.length) return `criterion changes must be declared in delta.paths or already approved: ${[...new Set(outside)].join(', ')}.`;
  return null;
}

function beginScopeAdjudication(c: Context, request: ScopeProposal, task: string | null, hotfixResume: HotfixResume | null): S {
  let tasks = c.tasks;
  for (const record of activeTasks(c.tasks)) {
    if (record.id === task || record.handle) continue;
    tasks = { ...tasks, [record.id]: { ...record, status: 'pending', handle: null, baseline: null, preserveDraft: false, brief: null, candidate: null, integrated: null, redRows: [] } };
  }
  const settled = tasks === c.tasks ? c : { ...c, tasks };
  const active = activeTasks(settled.tasks).map((record) => record.id).filter((id) => id !== task);
  return stay({ tag: 'scope-adjudication', c: settled, request, task, active, hotfixResume });
}

function scopeDrain(c: Context, request: ScopeProposal | null, adjustment: ScopeAdjustment | null, requester: string | null, active: readonly string[], stopAfterDrain: boolean, hotfixResume: HotfixResume | null): S {
  if (!active.length) {
    if (stopAfterDrain) return stop(c, 'User stopped at scope adjudication after all active writer attempts were drained.');
    return finishScopeDrain(c, request, adjustment, requester, [], hotfixResume);
  }
  return stay({ tag: 'scope-draining', c, request, adjustment, requester, active, drained: [], stopAfterDrain, hotfixResume });
}

function acceptScopeRuling(c: Context, request: ScopeProposal, requester: string | null, active: readonly string[], hotfixResume: HotfixResume | null, adjustment: ScopeAdjustment | null): S {
  const next = adjustment ? {
    ...c,
    scopeAdjustments: [...c.scopeAdjustments, { ...adjustment, ...(c.designBinding ? { ownerIncrement: c.designBinding.increment } : {}) }],
    scopeNotice: { requestId: request.requestId, approvedBy: adjustment.approvedBy, rationale: adjustment.rationale, ...(adjustment.quote ? { quote: adjustment.quote } : {}) },
  } : c;
  return scopeDrain(next, request, adjustment, requester, active, false, hotfixResume);
}

function finishScopeDrain(c: Context, request: ScopeProposal | null, adjustment: ScopeAdjustment | null, requester: string | null, drained: readonly string[], hotfixResume: HotfixResume | null): S {
  if (hotfixResume) return beginHotfix({ ...hotfixResume.origin, c }, hotfixResume.answer);
  const parked = [...new Set([...(requester ? [requester] : []), ...drained])];
  if (!c.plan || !parked.length) return beginTasks(c);
  const rebound = reconcileTasks(c.tasks, effectivePlan(c));
  const tasks = { ...rebound };
  for (const id of parked) {
    const before = c.tasks[id], after = tasks[id];
    if (!before || !after) continue;
    tasks[id] = {
      ...after, status: 'pending', attempt: before.attempt,
      failures: before.signature === after.signature ? before.failures : after.failures,
      worktree: before.worktree, input: before.input, baseline: null, preserveDraft: !!before.worktree,
      handle: null, brief: null, candidate: null, integrated: null, redRows: [],
    };
  }
  const integration = c.integration && invalidatesIntegration(c.tasks, tasks) ? { ...c.integration, rewind: true } : c.integration;
  const next: Context = { ...c, tasks, integration, scopeRebaseQueue: parked.filter((id) => !!tasks[id]?.worktree) };
  return schedule(next);
}

function terminalDuringScopeDrain(state: Extract<ImplementState, { tag: 'scope-draining' }>, task: string, failed: boolean): S {
  const before = state.c.tasks[task];
  if (!before || !state.active.includes(task)) return stay(state);
  const after = withTask(state.c, task, {
    status: 'pending', handle: null, baseline: null, brief: null, candidate: null,
    preserveDraft: !!before.worktree, ...(failed ? { failures: before.failures + 1 } : {}),
  });
  const active = state.active.filter((id) => id !== task), drained = [...state.drained, task];
  const next = { ...state, c: after, active, drained };
  if (active.length) return stay(next);
  if (state.stopAfterDrain) return stop(after, 'User stopped after every original writer attempt produced terminal evidence.');
  return finishScopeDrain(after, state.request, state.adjustment, state.requester, drained, state.hotfixResume);
}

function drainEnvelope(state: Extract<ImplementState, { tag: 'scope-draining' }>, event: Extract<HostEvent, { type: 'WRITE_ENVELOPE' }>): S {
  if (!event.task) return stay(state);
  const record = state.c.tasks[event.task] as TaskRecord;
  const { c, id } = effectId(state.c, 'check-envelope');
  const adjustmentId = state.adjustment?.proposal.requestId;
  const priorScope = adjustmentId ? { ...c, scopeAdjustments: c.scopeAdjustments.filter((item) => item.proposal.requestId !== adjustmentId) } : c;
  return { state: { tag: 'scope-drain-envelope', c, parent: state, effectId: id, task: event.task }, effects: [{ kind: 'check-envelope', id, envelopePath: event.envelopePath, permitted: planTask(priorScope, event.task)?.paths ?? [], ...(record.baseline ? { since: record.baseline } : {}), ...(record.worktree ? { cwd: record.worktree } : {}) }] };
}

function redReplay(c: Context, id: string): S {
  const record = c.tasks[id] as TaskRecord;
  if (!record.redRows.length) return greenVerify(c, id);
  const plan = effectivePlan(c);
  return checkout(c, 'red', 'red', { name: worktreeName('red', id), base: record.input, checkpointPath: record.brief?.checkpointPath, candidate: record.candidate, permitted: taskTestPaths(plan, planTask(c, id)!), links: c.integration!.links, ignored: c.integration!.ignored }, id);
}

function redCommands(c: Context, id: string): { command: string; mapping: CommandMapping | null }[] | string {
  const plan = effectivePlan(c), rows = (c.tasks[id] as TaskRecord).redRows;
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
  if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) {
    const detail = `checkout ${state.step} failed: ${event.cls}: ${event.detail}`;
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
      const next = withTask(c, id, { worktree: text('path'), input: text('revision'), baseline: null, preserveDraft: true, handle: null, brief: null, candidate: null, integrated: null, redRows: [], status: 'pending' });
      return nextScopeRebase(next);
    }
    case 'commit': {
      const outside = list('paths').filter((file) => !planTask(c, id)!.paths.includes(file));
      if (outside.length) return taskFailed(c, id, `Candidate changes paths outside the task scope: ${outside.join(', ')}.`);
      return redReplay(withTask(c, id, { candidate: text('revision') }), id);
    }
    case 'red': {
      if (list('defects').length) return taskFailed(c, id, `RED checkpoint rejected: ${list('defects').join('; ')}`);
      const commands = redCommands(c, id);
      return typeof commands === 'string' ? taskFailed(c, id, commands) : taskVerify(c, id, 'red', text('path'), commands);
    }
    case 'integrate': {
      if (result['conflict'] === true) return taskFailed(c, id, `Integration conflict on ${list('paths').join(', ') || 'unattributed paths'}: ${text('detail')}`);
      const integrated = withTask(c, id, { integrated: text('revision') });
      const commands = taskVerifyCommands(c, id);
      return commands.length ? taskVerify(integrated, id, 'integration', c.integration!.path, commands, c.integration!.head) : accept(integrated, id, text('revision'));
    }
    case 'reset': return taskFailed(c, id, state.reason ?? 'Integration verification failed.');
    case 'rewind': return schedule({ ...c, integration: { ...c.integration!, head: c.integration!.base, rewind: false } });
    case 'deliver': {
      if (list('conflicts').length) return beginFailure(c, `Delivery refused: caller paths changed since the baseline: ${list('conflicts').join(', ')}. Integrated work is preserved in ${c.integration!.path}.`);
      const delivered = [...list('transferred'), ...list('already')];
      const names = [...new Set([...Object.entries(c.tasks).flatMap(([task, record]) => [worktreeName('task', task), worktreeName('red', task), ...(record.worktreeNames ?? []), ...(record.worktree ? [taskWorktreeName(record)] : [])]), 'integration'])];
      return checkout({ ...markMutation(c, delivered), phase: 'delivered', changedPaths: [...new Set([...c.changedPaths, ...delivered])].sort() }, 'cleanup', 'cleanup', { names, links: c.integration!.links });
    }
    case 'cleanup': {
      const { c: next, id: snapshotId } = effectId(c, 'snapshot');
      return { state: { tag: 'delivered-snapshot', c: next, effectId: snapshotId }, effects: [{ kind: 'snapshot', id: snapshotId, since: c.lastFingerprint }] };
    }
    default: return never(state.step, 'checkout step');
  }
}

function stepTasks(state: Extract<ImplementState, { tag: 'tasks' | 'task-brief' | 'task-prewrite-snapshot' | 'task-envelope' | 'task-verify' | 'delivered-snapshot' }>, event: Event): S {
  switch (state.tag) {
    case 'task-prewrite-snapshot': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return taskFailed(state.c, state.task, `pre-write snapshot failed: ${event.cls}: ${event.detail}`);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId) || !isFingerprint(event.fingerprint)) return stay(state);
      const next = withTask(state.c, state.task, { baseline: event.fingerprint });
      const { c, id } = effectId(next, 'write-brief');
      return { state: { tag: 'task-brief', c, effectId: id, task: state.task }, effects: [{ kind: 'write-brief', id, stage: 'task', input: taskBriefInput(next, next.tasks[state.task] as TaskRecord) }] };
    }
    case 'task-brief': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return taskFailed(state.c, state.task, `write-brief failed: ${event.cls}: ${event.detail}`);
      if (event.type !== 'BRIEF_READY' || !answers(event, state.effectId)) return stay(state);
      if (event.stage !== 'task' || !nonEmpty(event.path) || !/^sha256:[a-f0-9]{64}$/.test(event.sha256) || !nonEmpty(event.envelopePath)) return taskFailed(state.c, state.task, 'write-brief returned a mismatched stage, invalid hash, or missing envelope path.');
      return schedule(withTask(state.c, state.task, { status: 'running', handle: null, brief: { path: event.path, sha256: event.sha256, envelopePath: event.envelopePath, checkpointPath: checkpointPathOf(event.envelopePath) } }));
    }
    case 'tasks': {
      if (event.type === 'WRITE_LAUNCHED') {
        let c = state.c;
        for (const row of event.tasks) c = withTask(c, row.task, { handle: row.handle, launchedModel: row.model });
        const substitutions = event.tasks.flatMap((row) => {
          const drift = launchDrift({ model: c.writer?.models[(c.tasks[row.task] as TaskRecord).modelIndex], effort: c.writer?.effort }, row);
          return drift.length ? [`${row.task}: writer substitution, launched ${drift.join(', ')}; ${row.substitution}`] : [];
        });
        return stay({ tag: 'tasks', c: substitutions.length ? { ...c, concerns: [...new Set([...c.concerns, ...substitutions])] } : c });
      }
      if (event.type === 'WRITE_ENVELOPE' && event.task) {
        const record = state.c.tasks[event.task] as TaskRecord;
        const { c, id } = effectId(withTask(state.c, event.task, { status: 'submitted' }), 'check-envelope');
        return { state: { tag: 'task-envelope', c, effectId: id, task: event.task }, effects: [{ kind: 'check-envelope', id, envelopePath: event.envelopePath, permitted: [...planTask(c, event.task)?.paths ?? []], ...(record.baseline ? { since: record.baseline } : {}), cwd: record.worktree as string }] };
      }
      if (event.type === 'WRITE_FAILED' && event.task) {
        const record = state.c.tasks[event.task] as TaskRecord;
        const terminal = event.kind === 'sandbox-unsupported' || event.kind === 'integrity';
        const reason = `${event.model}: ${event.kind}: ${event.reason}`;
        if (terminal || record.modelIndex + 1 >= (state.c.writer?.models.length ?? 0)) return taskFailed(state.c, event.task, `Writer cascade exhausted or reached a terminal failure: ${reason}`);
        return checkout(withTask(state.c, event.task, { status: 'submitted', handle: null }), 'relaunch', 'reset', { name: taskWorktreeName(record), revision: record.input }, event.task, reason);
      }
      return stay(state);
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
  if (state.purpose !== 'integration' || !state.previous) return taskFailed(state.c, state.task, reason);
  return checkout(state.c, 'reset', 'reset', { name: 'integration', revision: state.previous }, state.task, reason);
}

/** Failure-decision retry: tasks phase re-pends retryable failed tasks; after delivery the final gates rerun. */
function retryAfterFailure(c: Context): S {
  if (c.phase === 'delivered') return startGeneratedOrFinal(c);
  if (c.phase === 'setup') return !c.plan ? parsePlan(c, 'initial') : c.approval ? beginPostApproval(c) : beginBaseline(c);
  const tasks = Object.fromEntries(Object.entries(c.tasks).map(([id, record]) => [id, record.status === 'failed' && record.failures < MAX_WRITE_ATTEMPTS ? { ...record, status: 'pending' as const, amendment: null } : record]));
  return beginTasks({ ...c, tasks });
}

function markMutation(c: Context, paths: readonly string[]): Context {
  const epoch = c.mutationEpoch + 1;
  const criteria = c.plan ? effectivePlan(c).criteria : [];
  const criterionMutation = { ...c.criterionMutation };
  for (const criterion of criteria) if (!paths.length || criterion.changes.some((file) => paths.includes(file))) criterionMutation[criterion.id] = epoch;
  return { ...c, mutationEpoch: epoch, criterionMutation };
}

function beginVerify(c0: Context, purpose: 'red' | 'scoped' | 'final' | 'generated', commands: readonly { command: string; mapping?: CommandMapping | null; reuse?: VerifyRecord | null }[], cwd?: string): { c: Context; id: string; effect: Effect } {
  const mappings = commandMappings(effectivePlan(c0));
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
    if (!row.tests.every((identifier) => observed.has(identifier))) defects.push(`${row.id} expected failures were not observed: ${row.tests.filter((identifier) => !observed.has(identifier)).join(', ')}.`);
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
  const ids = effectivePlan(c0).criteria.filter((criterion) => {
    const evidence = c0.evidence[criterion.id];
    return !evidence || evidence.planHash !== c0.planHash || evidence.mutationEpoch < (c0.criterionMutation[criterion.id] ?? 0);
  }).map((criterion) => criterion.id);
  return ids.length ? stay({ tag: 'evidence', c: c0, purpose: 'final', ids, verify }) : finishEvidence(c0, verify);
}

function continueAfterDelivery(c: Context): S {
  return c.concerns.length ? stay({ tag: 'concerns', c, items: c.concerns }) : startCodeReview(c);
}

function startCodeReview(c0: Context): S {
  const built = reviewSpecFromRun(c0.run, 'code', 'fix', '');
  if (!built.ok) return beginFailure(c0, built.error);
  const plan = effectivePlan(c0);
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
    case 'decide-escalation': case 'decide-opt-in': return { state: { tag: 'code-review', c, review }, effects: result.effects };
    default: return never(review, 'code review state');
  }
}

function startGeneratedOrFinal(c0: Context): S {
  const { c, id } = effectId(c0, 'snapshot');
  return { state: { tag: 'post-review-snapshot', c, effectId: id }, effects: [{ kind: 'snapshot', id, since: c0.lastFingerprint }] };
}

function runGeneratedOrFinal(c0: Context): S {
  const generated = generatedCommands(effectivePlan(c0));
  if (!generated.length) return startFinalVerify(c0);
  const batch = beginVerify(c0, 'generated', generated.map((item) => ({ command: item.command, mapping: null })));
  const before = c0.lastFingerprint;
  if (!before) return beginFailure(c0, 'No tree fingerprint is available before generated verification.');
  return { state: { tag: 'generated-verify', c: batch.c, effectId: batch.id, count: generated.length, before }, effects: [batch.effect] };
}

function startFinalVerify(c0: Context): S {
  const mappings = commandMappings(effectivePlan(c0));
  const batch = beginVerify(c0, 'final', mappings.map((mapping) => ({ command: mapping.command, mapping, reuse: c0.records[mapping.command] ?? null })));
  const before = c0.lastFingerprint;
  if (!before) return beginFailure(c0, 'No tree fingerprint is available before final verification.');
  return { state: { tag: 'final-verify', c: batch.c, effectId: batch.id, before }, effects: [batch.effect] };
}

function finishEvidence(c: Context, verify: readonly VerifyRecord[]): S {
  const plan = effectivePlan(c);
  const stale = plan.criteria.filter((criterion) => {
    const item = c.evidence[criterion.id];
    return !item || item['outcome'] !== 'pass' || item.planHash !== c.planHash || item.mutationEpoch < (c.criterionMutation[criterion.id] ?? 0);
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
    const criterion = effectivePlan(c).criteria.find((criterion) => criterion.id === id);
    const redProvenance = criterion?.evidence !== 'red' ? 'not-required' : c.redMatrix.some((row) => row.id === id && row.exit !== 0 && row.tests.length > 0) ? 'observed' : 'waived';
    const attribution = waiver ?? c.redExceptionRulings[id];
    if (redProvenance === 'waived' && !attribution) return null;
    evidence[id] = { id, outcome: value['outcome'], evidence: value['evidence'], planHash: c.planHash ?? '', mutationEpoch: c.mutationEpoch, source: criterion?.evidence ?? 'verify', redProvenance, ...(attribution && (value['outcome'] === 'waived' || redProvenance === 'waived') ? { waiver: attribution } : {}) } as EvidenceRecord;
  }
  return { ...c, evidence };
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
export function beginBoundImplement(run: RunStartedEvent, binding: DesignBinding, counters: Counters): S {
  const c = {
    ...baseContext(run), counters, designBinding: binding, machinePath: `design.${binding.increment.toLowerCase()}.implement`,
    levelGatePassed: binding.levelGatePassed ?? false, gateScope: binding.gateScope ?? null,
    levelAssessment: binding.levelAssessment ?? null, levelChoice: binding.levelChoice ?? null,
    scopeAdjustments: binding.scopeAdjustments ?? [],
    scopeNotice: binding.scopeNotice ?? null,
  };
  return snapshot(c, 'author');
}

function applyImplement(state: ImplementState, event: Event): S {
  if (event.type === 'REVISE' && 'c' in state && state.c && !validateImplement(state, event)) return stay({ tag: 'revision-request', c: state.c, parent: state, event });
  switch (state.tag) {
    case 'booting': {
      if (event.type !== 'RUN_STARTED' || event.verb !== 'implement') return stay(state);
      const c = baseContext(event);
      const candidate = /\.plan\.md$/i.test(c.planPath) || settledPlanInput(event.overrides['settledPlan']) !== null;
      return snapshot(c, candidate ? 'parse' : 'author');
    }
    case 'starting': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return fail(state.c, `initial snapshot failed: ${event.cls}: ${event.detail}`);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId) || !isFingerprint(event.fingerprint)) return stay(state);
      const c = { ...state.c, startFingerprint: event.fingerprint, lastFingerprint: event.fingerprint };
      return state.next === 'parse' ? parsePlan(c, 'initial') : authorPlan(c);
    }
    case 'author': {
      if (event.type !== 'AUTHORED' || event.path !== state.c.planPath) return stay(state);
      return parsePlan(state.c, 'initial');
    }
    case 'parsing': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) {
        if (state.phase === 'initial' && /not found/i.test(event.detail)) return authorPlan(state.c);
        return startFailureFromEffect(state.c, event.cls, event.detail);
      }
      if (event.type !== 'ARTIFACT_PARSED' || !answers(event, state.effectId) || event.kind !== 'plan') return stay(state);
      if (event.defects.length) return authorPlan(state.c, event.defects as readonly Readonly<Record<string, unknown>>[]);
      const plan = asParsedPlan(event.parsed);
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
      if (!state.c.startFingerprint || !sameFingerprint(event.fingerprint, state.c.startFingerprint)) return beginFailure({ ...state.c, lastFingerprint: event.fingerprint }, `Baseline commands changed the repository: ${diffPaths(event).join(', ') || 'fingerprint changed'}.`);
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
    case 'scope-adjudication': {
      if (event.type === 'DECISION' && event.kind === 'run-stop') return scopeDrain(state.c, null, null, null, state.active, true, state.hotfixResume);
      if (event.type !== 'DECISION' || event.kind !== 'scope-deviation' || !isRecord(event.answer)) return stay(state);
      const rationale = String(event.answer['rationale']).trim();
      if (event.answer['ruling'] === 'disagree') return stay({ tag: 'scope-user-decision', c: state.c, request: state.request, task: state.task, active: state.active, orchestratorRationale: rationale, hotfixResume: state.hotfixResume });
      const adjustment: ScopeAdjustment = { proposal: state.request, approvedBy: 'orchestrator', rationale };
      return acceptScopeRuling(state.c, state.request, state.task, state.active, state.hotfixResume, adjustment);
    }
    case 'scope-user-decision': {
      if (event.type === 'DECISION' && event.kind === 'run-stop') return scopeDrain(state.c, null, null, null, state.active, true, state.hotfixResume);
      if (event.type !== 'DECISION' || event.kind !== 'scope-deviation-user' || !isRecord(event.answer)) return stay(state);
      if (event.answer['choice'] === 'decline') return acceptScopeRuling(state.c, state.request, state.task, state.active, state.hotfixResume, null);
      const quote = String(event.answer['quote']).trim();
      const adjustment: ScopeAdjustment = { proposal: state.request, approvedBy: 'user', rationale: `Accepted after orchestrator disagreement: ${state.orchestratorRationale}`, quote };
      return acceptScopeRuling(state.c, state.request, state.task, state.active, state.hotfixResume, adjustment);
    }
    case 'scope-draining': {
      if (event.type === 'WRITE_CANCELLED') return terminalDuringScopeDrain(state, event.task, false);
      if (event.type === 'WRITE_FAILED') return event.task ? terminalDuringScopeDrain(state, event.task, true) : stay(state);
      if (event.type === 'WRITE_ENVELOPE' && event.task) return drainEnvelope(state, event);
      return stay(state);
    }
    case 'scope-drain-envelope': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return terminalDuringScopeDrain({ ...state.parent, c: state.c }, state.task, true);
      if (event.type !== 'ENVELOPE_CHECKED' || !answers(event, state.effectId)) return stay(state);
      if (isRecord(event.envelope) && event.envelope['status'] === 'SCOPE_REQUEST') {
        const request = event.envelope['scopeRequest'];
        const rejectedScopeRequest = {
          task: state.task,
          requestId: isRecord(request) && typeof request['requestId'] === 'string' ? request['requestId'] : null,
          summary: typeof event.envelope['summary'] === 'string' ? event.envelope['summary'] : 'Writer requested a scope change during an active scope drain.',
        };
        return stay({
          ...state.parent,
          c: state.c,
          rejectedScopeRequests: [...(state.parent.rejectedScopeRequests ?? []), rejectedScopeRequest],
        });
      }
      return terminalDuringScopeDrain({ ...state.parent, c: state.c }, state.task, event.defects.length > 0 || !isWriterEnvelope(event.envelope));
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
    case 'tasks': case 'task-brief': case 'task-prewrite-snapshot': case 'task-envelope': case 'task-verify': case 'delivered-snapshot': return stepTasks(state, event);
    case 'evidence': {
      if (event.type !== 'EVIDENCE') return stay(state);
      const c = recordEvidence(state.c, state.ids, event.criteria);
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
      const c = event.type === 'FIXES_APPLIED' ? markMutation(state.c, reviewPaths(event)) : state.c;
      return fromCodeReview(c, stepReview(state.review, event));
    }
    case 'post-review-snapshot': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return startFailureFromEffect(state.c, event.cls, event.detail);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId) || !isFingerprint(event.fingerprint)) return stay(state);
      return runGeneratedOrFinal({ ...state.c, lastFingerprint: event.fingerprint });
    }
    case 'generated-verify': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return startFailureFromEffect(state.c, event.cls, event.detail);
      if (event.type !== 'VERIFY_DONE' || !answers(event, state.effectId) || event.purpose !== 'generated' || !isFingerprint(event.fingerprint)) return stay(state);
      const rows = recordsFrom(resultEventRows(event), state.c, 'generated');
      if (!rows || rows.some((row) => row.exit !== 0)) return beginFailure(state.c, `Generated command failed: ${rows?.filter((row) => row.exit !== 0).map((row) => `${row.command} (${row.logPath})`).join('; ') ?? 'invalid results'}`);
      const paths = generatedCommands(effectivePlan(state.c)).map((item) => item.path);
      const { c, id } = effectId({ ...state.c, lastFingerprint: event.fingerprint }, 'snapshot');
      return { state: { tag: 'generated-snapshot', c, effectId: id, before: state.before, paths }, effects: [{ kind: 'snapshot', id, since: state.before }] };
    }
    case 'generated-snapshot': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return startFailureFromEffect(state.c, event.cls, event.detail);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId) || !isFingerprint(event.fingerprint)) return stay(state);
      const changed = diffPaths(event);
      const outside = changed.filter((file) => !state.paths.includes(file));
      if (outside.length) return beginFailure({ ...state.c, lastFingerprint: event.fingerprint }, `Generated verification changed out-of-scope paths: ${outside.join(', ')}.`);
      if (!sameFingerprint(event.fingerprint, state.before) && !changed.length) return beginFailure({ ...state.c, lastFingerprint: event.fingerprint }, 'Generated verification changed the repository without attributable paths.');
      const c = sameFingerprint(event.fingerprint, state.before) ? { ...state.c, lastFingerprint: event.fingerprint } : markMutation({ ...state.c, lastFingerprint: event.fingerprint }, changed);
      return startFinalVerify(c);
    }
    case 'final-verify': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return startFailureFromEffect(state.c, event.cls, event.detail);
      if (event.type !== 'VERIFY_DONE' || !answers(event, state.effectId) || event.purpose !== 'final' || !isFingerprint(event.fingerprint)) return stay(state);
      const rows = recordsFrom(resultEventRows(event), state.c, 'final');
      if (!rows) return beginFailure(state.c, 'Final verification returned malformed command results.');
      if (!sameFingerprint(event.fingerprint, state.before)) return beginFailure({ ...state.c, lastFingerprint: event.fingerprint }, 'Final verification changed the repository; evidence is stale.');
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
      if (event.type !== 'DECISION' || event.kind !== 'failure') return stay(state);
      const answer = failureAnswer(event.answer);
      if (!answer) return stay(state);
      if (answer.action === 'stop') return stop(state.c, `Stopped after failure: ${state.reason}. Work preserved; changed paths: ${state.changedPaths.join(', ') || 'none reported'}.`);
      if (answer.action === 'retry') return retryAfterFailure({ ...state.c, retryContext: { rootCause: answer.rootCause, failure: state.reason } });
      if (answer.action === 'hotfix') return beginHotfix(state, answer);
      const c = recordEvidence(state.c, effectivePlan(state.c).criteria.map((row) => row.id), answer.criteria, { by: 'user', quote: answer.quote });
      const waived = c ? Object.values(c.evidence).filter((row) => row['outcome'] === 'waived').length : 0;
      return c ? stay({ tag: 'complete', c: { ...c, finalGate: `Manual completion by user: ${answer.quote}` }, summary: `User manually completed implementation: ${Object.keys(c.evidence).length - waived} passed; ${waived} waived. ${answer.quote}` }) : stay(state);
    }
    case 'checking-host-event': case 'drift': case 'hotfix-brief': case 'hotfix-write': case 'hotfix-envelope': case 'hotfix-snapshot': case 'hotfix-verify': return stepRecovery(state, event);
    case 'complete': case 'stopped': case 'failed': case 'revision-request': return stay(state);
    default: return never(state, 'implement state');
  }
}

function redTestPaths(c: Context): string[] { return c.plan ? [...new Set(activeRedCriteria(c).flatMap((criterion) => criterion.changes.filter(isTestPath)))].sort() : []; }

function scopePaths(c: Context): string[] { return [...new Set([...c.plan ? approvedPaths(effectivePlan(c)) : [], ...c.adoptedPaths])].sort(); }
function withContext(state: ImplementState, c: Context): ImplementState { return 'c' in state ? { ...state, c } as ImplementState : state; }
const hostTypes = new Set(['AUTHORED', 'NATIVE_RESULTS', 'RULINGS', 'FIXES_APPLIED', 'WRITE_LAUNCHED', 'WRITE_ENVELOPE', 'WRITE_FAILED', 'WRITE_CANCELLED', 'EVIDENCE', 'DECISION', 'REVISE']);

export function stepImplement(state: ImplementState, event: Event): S {
  if (state.tag === 'checking-host-event' || state.tag === 'drift' && event.type !== 'REVISE') return stepRecovery(state, event);
  if (hostTypes.has(event.type) && 'c' in state && state.c && implementAwait(state) !== null && implementAwait(state) !== 'done') {
    if (validateImplement(state, event as HostEvent)) return stay(state);
    // NOTE: caller edits during the task phase are reconciled by delivery drift checks, not host-event snapshots.
    if (state.c.phase === 'tasks' && event.type !== 'REVISE') return applyImplement(state, event);
    const { c, id } = effectId(state.c, 'snapshot');
    return { state: { tag: 'checking-host-event', c, parent: state, parked: event as HostEvent, effectId: id }, effects: [{ kind: 'snapshot', id, since: state.c.lastFingerprint }] };
  }
  const result = applyImplement(state, event);
  if (event.type === 'VERIFY_DONE' && 'c' in state && state.c?.lastFingerprint && sameFingerprint(state.c.lastFingerprint, event.fingerprint) && 'c' in result.state && result.state.c) {
    return { ...result, state: withContext(result.state, { ...result.state.c, lastFingerprint: { ...state.c.lastFingerprint, ...event.fingerprint } }) };
  }
  return result;
}

function applyParked(parent: ImplementState, c: Context, parked: HostEvent): S {
  const updated = withContext(parent, c);
  if (validateImplement(updated, parked)) return beginFailure(c, 'Parked host event no longer matches its bound parent.');
  return applyImplement(updated, parked);
}

function beginHotfix(origin: RecoveryOrigin, answer: Extract<FailureAnswer, { action: 'hotfix' }>): S {
  const { pendingWriter, ...bound } = origin.c;
  const c0: Context = pendingWriter ? { ...bound, writer: pendingWriter } : origin.c;
  const stage = origin.tag === 'baseline-decision' ? 'baseline' : 'delivered';
  if (c0.withdrawnHotfix.includes(stage) || origin.tag === 'failure' && c0.phase !== 'delivered') return stay(origin);
  if (!c0.lastFingerprint || !recoverySnapshot(c0.lastFingerprint)) return beginFailure(c0, 'Hotfix requires concrete snapshot metadata.');
  if (origin.tag === 'baseline-decision' || answer.mode === 'inline') {
    const { c, id } = effectId(c0, 'snapshot');
    return { state: { tag: 'hotfix-snapshot', c, origin, before: c0.lastFingerprint, effectId: id, answer }, effects: [{ kind: 'snapshot', id, since: c0.lastFingerprint }] };
  }
  if (!c0.writer?.models[0] || !c0.stalled) return stay(origin);
  const { c, id } = effectId(c0, 'write-brief');
  const plan = effectivePlan(c0);
  return { state: { tag: 'hotfix-brief', c, origin, before: c0.lastFingerprint, effectId: id, answer }, effects: [{ kind: 'write-brief', id, stage: 'hotfix', input: {
    planPath: c0.planPath, planHash: c0.planHash, designBinding: briefDesignBinding(c0),
    governingOutcome: { title: plan.title, outcome: plan.box['TL;DR'] ?? plan.title ?? c0.planPath },
    settledScope: { paths: scopePaths(c0), approvedPaths: scopePaths(c0), changes: plan.changes, acceptedAdjustments: applicableScopeAdjustments(c0).filter(({ proposal }) => proposal.source === 'hotfix').map(({ proposal, approvedBy }) => ({ requestId: proposal.requestId, source: proposal.source, approvedBy, delta: proposal.delta })) },
    criteria: plan.criteria.map((criterion) => ({ id: criterion.id, title: criterion.title, changes: criterion.changes, verify: criterion.verify, evidence: criterion.evidence })),
    envelopeSchema: { schemaVersion: 1, stage: 'COMPLETE', status: ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED', 'SCOPE_REQUEST'], summary: 'non-empty string' },
    rules: { keyDecisions: plan.keyDecisions, repository: c0.run.repo, approval: c0.approval, writerStage: 'hotfix' },
    priorFindings: [], evidence: [], retryContext: c0.retryContext, rootCause: answer.rootCause, stalledCheck: c0.stalled,
    hotfix: { maxFiles: HOTFIX_MAX_FILES, maxLines: HOTFIX_MAX_LINES, singleShot: true, model: c0.writer.models[0], external: answer.external, preRed: false, paths: scopePaths(c0) },
  } }] };
}

function hotfixSnapshot(state: Extract<ImplementState, { tag: 'hotfix-write' | 'hotfix-envelope' }>): S {
  const { c, id } = effectId(state.c, 'snapshot');
  return { state: { tag: 'hotfix-snapshot', c, origin: state.origin, before: state.before, effectId: id, answer: state.answer }, effects: [{ kind: 'snapshot', id, since: state.before }] };
}

function stepRecovery(state: Extract<ImplementState, { tag: 'checking-host-event' | 'drift' | 'hotfix-brief' | 'hotfix-write' | 'hotfix-envelope' | 'hotfix-snapshot' | 'hotfix-verify' }>, event: Event): S {
  switch (state.tag) {
    case 'checking-host-event': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return beginFailure(state.c, `Host-event snapshot failed: ${event.detail}`);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId) || !isFingerprint(event.fingerprint)) return stay(state);
      const metadata = recoverySnapshot(event.fingerprint);
      const changed = diffPaths(event);
      const awaiting = implementAwait(state.parent) ?? 'done';
      const hotfixDecision = (state.parent.tag === 'baseline-decision' || state.parent.tag === 'failure') && state.parked.type === 'DECISION' && failureAnswer(state.parked.answer)?.action === 'hotfix';
      if (hotfixDecision) return applyParked(state.parent, state.c, state.parked);
      if (state.parent.tag === 'hotfix-write') return applyParked(state.parent, state.c, state.parked);
      const classified = classifyDrift({ awaiting, ctx: { stagePaths: scopePaths(state.c), testPaths: redTestPaths(state.c), testsOnly: false, artifactPath: artifactRelative(event.fingerprint, state.c.planPath) }, changed, callerDirty: recoverySnapshot(state.c.startFingerprint)?.callerDirty ?? [], hashManifestDirs: metadata?.hashManifestDirs ?? [] });
      classified.drift.push(...classified.autoAdopt.filter((file) => !(metadata?.verifiedManifestDirs ?? []).includes(file.slice(0, -'skill-hashes.json'.length).replace(/\/$/, ''))));
      classified.autoAdopt = classified.autoAdopt.filter((file) => !classified.drift.includes(file));
      const adoptedPaths = [...new Set([...state.c.adoptedPaths, ...classified.autoAdopt])];
      const c = { ...state.c, adoptedPaths, finalFocus: [...new Set([...state.c.finalFocus, ...classified.autoAdopt])] };
      if (classified.drift.length) return stay({ tag: 'drift', c, parent: state.parent, parked: state.parked, paths: classified.drift, fingerprint: event.fingerprint });
      return applyParked(state.parent, { ...c, lastFingerprint: event.fingerprint }, state.parked);
    }
    case 'drift': {
      if (event.type !== 'DECISION' || event.kind !== 'drift') return stay(state);
      const answer = driftAnswer(event.answer, state.paths);
      if (!answer) return stay(state);
      if (Object.values(answer).includes('stop')) return stop(state.c, 'User stopped at per-path drift reconciliation; files preserved.');
      const c = markMutation({ ...state.c, adoptedPaths: [...new Set([...state.c.adoptedPaths, ...state.paths])], finalFocus: [...new Set([...state.c.finalFocus, ...state.paths])] }, state.paths);
      return applyParked(state.parent, { ...c, lastFingerprint: state.fingerprint }, state.parked);
    }
    case 'hotfix-brief': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return stay(withContext(state.origin, state.c));
      if (event.type !== 'BRIEF_READY' || !answers(event, state.effectId) || event.stage !== 'hotfix' || !/^sha256:[a-f0-9]{64}$/.test(event.sha256) || !nonEmpty(event.path) || !nonEmpty(event.envelopePath)) return stay(state);
      return stay({ tag: 'hotfix-write', c: state.c, origin: state.origin, before: state.before, answer: state.answer, brief: { path: event.path, sha256: event.sha256, envelopePath: event.envelopePath } });
    }
    case 'hotfix-write': {
      if (event.type === 'WRITE_FAILED') return stay(withContext(state.origin, state.c));
      if (event.type !== 'WRITE_ENVELOPE' || event.envelopePath !== state.brief.envelopePath) return stay(state);
      const { c, id } = effectId(state.c, 'check-envelope');
      return { state: { tag: 'hotfix-envelope', c, origin: state.origin, before: state.before, effectId: id, answer: state.answer }, effects: [{ kind: 'check-envelope', id, envelopePath: state.brief.envelopePath, permitted: scopePaths(c), since: state.before }] };
    }
    case 'hotfix-envelope': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return stay(withContext(state.origin, state.c));
      if (event.type !== 'ENVELOPE_CHECKED' || !answers(event, state.effectId)) return stay(state);
      if (!event.defects.length && isRecord(event.envelope) && event.envelope['status'] === 'SCOPE_REQUEST') {
        const request = event.envelope['scopeRequest'] as ScopeDeviation | undefined;
        const defect = request ? scopeDeltaDefect(effectivePlan(state.c), request) : 'request is missing or malformed.';
        if (request?.source === 'hotfix' && request.baseArtifactHash === state.c.planHash && !defect) return beginScopeAdjudication(state.c, request, null, { origin: state.origin, answer: state.answer });
        return stay(withContext(state.origin, { ...state.c, concerns: [...state.c.concerns, `Hotfix scope request rejected: ${defect ?? 'request did not bind to the active plan hash.'}`] }));
      }
      if (event.defects.length || !isWriterEnvelope(event.envelope) || !['DONE', 'DONE_WITH_CONCERNS'].includes(event.envelope.status)) return stay(withContext(state.origin, state.c));
      return hotfixSnapshot(state);
    }
    case 'hotfix-snapshot': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return beginFailure(state.c, `Hotfix snapshot failed: ${event.detail}`);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId)) return stay(state);
      const before = recoverySnapshot(state.before), after = recoverySnapshot(event.fingerprint);
      if (!before || !after) return beginFailure(state.c, 'Hotfix snapshot metadata is malformed.');
      const judgement = judgeHotfix({ repoRoot: '', changed: after.changed, external: state.answer.external, before: before.git, after: after.git, taskStartFiles: before.taskStartFiles, ignoredBefore: before.ignored, ignoredAfter: after.ignored, preRed: false, productionPaths: scopePaths(state.c).filter((file) => !isTestPath(file)), failureIdentityBefore: null, failureIdentityAfter: null });
      const violations = judgement.violations;
      if (violations.length) return stay(withContext(state.origin, { ...state.c, concerns: [...state.c.concerns, ...violations] }));
      const stalled = state.origin.tag === 'baseline-decision' ? { purpose: 'baseline' as const, rows: state.origin.items } : state.c.stalled;
      if (!stalled?.rows.length) return beginFailure(state.c, 'No stalled check is available for hotfix verification.');
      const changedPaths = after.changed.map((item) => item.path);
      const c0 = markMutation({ ...state.c, lastFingerprint: event.fingerprint, stalled, adoptedPaths: [...new Set([...state.c.adoptedPaths, ...changedPaths])], finalFocus: [...new Set([...state.c.finalFocus, ...changedPaths])] }, changedPaths);
      const { c, id } = effectId(c0, 'verify');
      return { state: { tag: 'hotfix-verify', c, origin: state.origin, before: event.fingerprint, effectId: id, changedPaths }, effects: [{ kind: 'verify', id, purpose: 'hotfix', commands: stalled.rows.map((row) => commandEffect(row.command, commandMappings(effectivePlan(c)).find((m) => m.command === row.command) ?? null, scopePaths(c), environmentKey(c))) }] };
    }
    case 'hotfix-verify': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return stay(withContext(state.origin, state.c));
      if (event.type !== 'VERIFY_DONE' || !answers(event, state.effectId) || event.purpose !== 'hotfix') return stay(state);
      const rows = recordsFrom(event.results, state.c, 'scoped');
      if (!rows || !isFingerprint(event.fingerprint) || !sameFingerprint(state.before, event.fingerprint)) return beginFailure(state.c, 'Hotfix check mutated the tree or returned invalid results.');
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
    case 'baseline-decision': return 'decide';
    case 'approval': case 'level-classification': case 'level-recommendation': case 'scope-adjudication': case 'scope-user-decision': case 'needs-user': case 'concerns': case 'failure': case 'drift': return 'decide';
    case 'scope-draining': return 'write';
    case 'evidence': return 'evidence';
    case 'complete': case 'stopped': case 'failed': return 'done';
    case 'booting': case 'starting': case 'parsing': case 'baseline-preflight': case 'baseline': case 'baseline-snapshot':
    case 'task-checkout': case 'task-brief': case 'task-prewrite-snapshot': case 'task-envelope': case 'task-verify': case 'scope-drain-envelope': case 'delivered-snapshot': case 'post-review-snapshot': case 'generated-verify': case 'generated-snapshot': case 'final-verify': case 'failure-snapshot':
    case 'checking-host-event': case 'hotfix-brief': case 'hotfix-envelope': case 'hotfix-snapshot': case 'hotfix-verify': case 'revision-request': return null;
    default: return never(state, 'implement state');
  }
}

export function implementData(state: ImplementState): Readonly<Record<string, unknown>> {
  switch (state.tag) {
    case 'author': return { artifact: 'plan', path: state.c.planPath, template: IMPLEMENT_TEMPLATE, ...(state.defects.length ? { defects: state.defects } : {}) };
    case 'plan-review': case 'code-review': return reviewData(state.review);
    case 'tasks': return {
      stage: 'task', effort: state.c.writer?.effort, concurrency: writeConcurrency(state.c.run.config), settledLevel: state.c.run.level,
      levelAssessment: state.c.levelAssessment, levelChoice: state.c.levelChoice, scopeAdjustments: state.c.scopeAdjustments, scopeNotice: state.c.scopeNotice,
      tasks: activeTasks(state.c.tasks).filter((record) => record.status === 'running').map((record) => ({
        task: record.id, action: record.handle ? 'running' : 'launch', handle: record.handle, attempt: record.attempt, signature: record.signature,
        model: activeModel(state.c, record), briefPath: record.brief?.path, briefSha256: record.brief?.sha256,
        envelopePath: record.brief?.envelopePath, checkpointPath: record.brief?.checkpointPath, worktree: record.worktree, paths: planTask(state.c, record.id)?.paths ?? [],
      })),
    };
    case 'baseline-decision': return decideData('baseline', 'The baseline has nonzero results. Accept every listed failure identity, choose an inline hotfix, or stop.', ['accept-known-red', 'inline-hotfix', 'stop'], state.items.map((row) => ({ command: row.command, failureId: row.failureId, diagnostic: row.diagnostic, logPath: row.logPath })));
    case 'level-classification': return { ...decideData('level-classification', 'Assess the complete settled implementation scope once before the first production write. Return the evaluated level, concise evidence-based rationale and this exact gateScope.', ['low', 'medium', 'high'], [{ level: state.c.run.level, source: state.c.run.levelSource }]), gateScope: state.gateScope, settledLevel: state.c.run.level, stopAllowed: true };
    case 'level-recommendation': return { ...decideData('level-recommendation', `The implementation assessment is ${state.assessment.evaluatedLevel}: ${state.assessment.rationale}. Choose whether to adopt it or retain the explicit ${state.c.run.level}.`, ['adopt', 'retain']), assessedLevel: state.assessment.evaluatedLevel, rationale: state.assessment.rationale, explicitLevel: state.c.run.level, gateScope: state.assessment.gateScope, stopAllowed: true };
    case 'scope-adjudication': return { ...decideData('scope-deviation', 'Adjudicate this required scope delta against the task objective and invariants. Approve it to continue under the settled level, or disagree so the user can decide.', ['approve', 'disagree', 'stop']), pendingProposal: state.request, writerRationale: state.request.source === 'task' || state.request.source === 'hotfix' ? state.request.writerRationale : state.request.rationale, activeWriters: state.active, stopAllowed: true, settledLevel: state.c.run.level };
    case 'scope-user-decision': return { ...decideData('scope-deviation-user', 'The orchestrator disagrees with the proposed delta. Show both rationales and ask the user whether to accept or decline it.', ['accept', 'decline', 'stop']), pendingProposal: state.request, writerRationale: state.request.source === 'task' || state.request.source === 'hotfix' ? state.request.writerRationale : state.request.rationale, orchestratorRationale: state.orchestratorRationale, activeWriters: state.active, stopAllowed: true, settledLevel: state.c.run.level };
    case 'scope-draining': return {
      stage: 'scope-draining', stopAfterDrain: state.stopAfterDrain, settledLevel: state.c.run.level, scopeNotice: state.c.scopeNotice,
      pendingProposal: state.request, tasks: state.active.map((id) => {
        const record = state.c.tasks[id] as TaskRecord;
        return { task: id, attempt: record.attempt, signature: record.signature, handle: record.handle, envelopePath: record.brief?.envelopePath, model: activeModel(state.c, record), paths: planTask(state.c, id)?.paths ?? [] };
      }),
      rejectedScopeRequests: state.rejectedScopeRequests ?? [],
    };
    case 'approval': return decideData('approval', 'Approve these plan paths and verification commands before any writer stage.', ['approve', 'stop'], [{ by: 'required', quote: 'required', paths: state.c.plan ? approvedPaths(state.c.plan) : [], commands: state.c.plan ? commandMappings(state.c.plan).map((row) => row.command) : [] }]);
    case 'needs-user': return decideData('needs-user', `Rule on RED exceptions for ${state.ids.join(', ')} before production work.`, ['accept', 'stop'], state.ids);
    case 'concerns': return decideData('concerns', 'Resolve the writer concerns before code review.', ['accept', 'stop'], state.items);
    case 'failure': return state.c.phase === 'tasks'
      ? decideData('failure', state.reason, ['retry', 'revise', 'stop'], [{ tasks: state.c.plan ? failureItems(state.c.plan, state.c.tasks) : [], maxAttempts: MAX_WRITE_ATTEMPTS, worktrees: state.c.integration?.path ?? null, workPreserved: true }])
      : decideData('failure', state.reason, ['hotfix', 'retry', 'manual-complete', 'revise', 'stop'], [{ changedPaths: state.changedPaths, workPreserved: true, hotfixWithdrawn: state.c.withdrawnHotfix.includes(state.c.phase === 'delivered' ? 'delivered' : 'baseline') }]);
    case 'drift': return decideData('drift', 'Rule adopt or stop for every changed path before applying the parked event.', ['adopt', 'stop'], state.paths);
    case 'hotfix-write': {
      const acceptedHotfixAdjustments = applicableScopeAdjustments(state.c).filter(({ proposal }) => proposal.source === 'hotfix');
      const scopeNotice = state.c.scopeNotice && acceptedHotfixAdjustments.some(({ proposal }) => proposal.requestId === state.c.scopeNotice?.requestId)
        ? state.c.scopeNotice : null;
      return {
      stage: 'hotfix', singleShot: true, model: state.c.writer?.models[0], models: state.c.writer?.models.slice(0, 1),
      briefPath: state.brief.path, briefSha256: state.brief.sha256, envelopePath: state.brief.envelopePath, rootCause: state.answer.rootCause,
      scopeNotice,
      acceptedAdjustments: acceptedHotfixAdjustments.map(({ proposal, approvedBy, rationale, quote }) => ({
        requestId: proposal.requestId, approvedBy, rationale, ...(quote ? { quote } : {}), delta: proposal.delta,
      })),
      limits: { files: HOTFIX_MAX_FILES, lines: HOTFIX_MAX_LINES },
      };
    }
    case 'evidence': return {
      purpose: state.purpose,
      summary: state.verify.map((row) => ({ command: row.command, exit: row.exit, logPath: row.logPath, diagnostic: row.diagnostic, status: row.status, failureId: row.failureId })),
      criteria: state.ids.map((id) => {
        const criterion = effectivePlan(state.c).criteria.find((entry) => entry.id === id);
        return { id, title: criterion?.title ?? id, evidenceClass: criterion?.evidence, planHash: state.c.planHash, mutationEpoch: state.c.mutationEpoch };
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
    adoptedPaths: c.adoptedPaths, finalFocus: c.finalFocus, revisions: c.revisions,
    approval: c.approval, redExceptionRulings: c.redExceptionRulings, concernRulings: c.concernRulings,
    criteria: (c.plan ? effectivePlan(c).criteria : []).map((criterion) => ({ id: criterion.id, evidence: c.evidence[criterion.id] ?? null, lastMutation: c.criterionMutation[criterion.id] ?? 0 })),
    review: review['completion'] ?? review, limitations: [...c.concerns, ...Object.values(c.evidence).filter((item) => item['outcome'] === 'waived').map((item) => `${item.id}: user-waived criterion; ${item['evidence']}`)], finalGate: c.finalGate,
  };
}

/** Model behind a task's live handle: the attested launch, else its cascade entry; launch slots always show the configured model. */
function activeModel(c: Context, record: TaskRecord): string | undefined {
  return record.handle && record.launchedModel ? record.launchedModel : c.writer?.models[record.modelIndex];
}

function validateTaskEvent(c: Context, event: HostEvent): string | null {
  const running = (id: string | undefined) => id ? c.tasks[id]?.status === 'running' ? c.tasks[id] : undefined : undefined;
  if (event.type === 'WRITE_LAUNCHED') {
    const ids = event.tasks.map((row) => row.task);
    if (!ids.length || new Set(ids).size !== ids.length || event.tasks.some((row) => !running(row.task) || running(row.task)!.handle !== null || row.attempt !== running(row.task)!.attempt || row.signature !== running(row.task)!.signature || !row.handle.trim())) return 'event.tasks: name each launch slot once and echo its projected attempt and signature with a non-empty handle.';
    for (const row of event.tasks) {
      const mismatch = launchMismatch({ model: c.writer?.models[running(row.task)!.modelIndex], effort: c.writer?.effort }, row);
      if (mismatch) return `event.tasks[${row.task}]: ${mismatch}.`;
    }
  }
  if (event.type === 'WRITE_ENVELOPE') {
    const record = running(event.task);
    if (!event.task || !record || record.brief?.envelopePath !== event.envelopePath || event.attempt !== record.attempt || event.signature !== record.signature || !record.handle || event.handle !== record.handle) return 'event.task: echo the active task, attempt, signature, handle and exact envelope path from the write frame.';
  }
  if (event.type === 'WRITE_FAILED') {
    const record = running(event.task);
    if (!event.task || !record || event.model !== activeModel(c, record) || event.attempt !== record.attempt || event.signature !== record.signature || !record.handle || event.handle !== record.handle) return 'event.task: echo the active task, attempt, signature and handle and name its current model id.';
  }
  return null;
}

export function validateImplement(state: ImplementState, event: HostEvent): string | null {
  if (event.type === 'WRITE_CANCELLED' && state.tag !== 'scope-draining') return 'event.type: cancellation receipts are accepted only while draining scope changes.';
  if (event.type === 'REVISE') {
    if (event.artifact !== 'plan') return 'event.artifact: only plan revision is available.';
    if (state.tag === 'level-classification' || state.tag === 'level-recommendation') return 'event.type: finish the pending level gate before REVISE so a revised plan cannot reuse stale classification.';
    if ((state.tag === 'scope-adjudication' || state.tag === 'scope-user-decision') && state.active.length) return 'event.type: drain every active writer before REVISE so original attempt identities remain available.';
    if (implementAwait(state) === 'write' || implementAwait(state) === null) return 'event.type: outstanding write/effect must finish before REVISE.';
    if (!('c' in state) || !state.c?.plan) return 'event.type: a governed plan must be bound before REVISE.';
    return null;
  }
  if (event.type === 'DECISION' && event.kind === 'run-stop' && !['level-classification', 'level-recommendation', 'scope-adjudication', 'scope-user-decision'].includes(state.tag)) return 'event.kind: run-stop is valid only at a level or scope decision gate.';
  if (state.tag === 'hotfix-write' && event.type === 'WRITE_ENVELOPE' && event.envelopePath !== state.brief.envelopePath) return 'event.envelopePath: expected the exact hotfix envelope path.';
  if (state.tag === 'hotfix-write' && event.type === 'WRITE_FAILED' && event.model !== state.c.writer?.models[0]) return 'event.model: expected the single-shot configured writer.';
  if (state.tag === 'drift' && (event.type !== 'DECISION' || event.kind !== 'drift' || !driftAnswer(event.answer, state.paths))) return 'event.answer: rule adopt or stop for each drift path.';
  if (state.tag === 'author' && event.type === 'AUTHORED' && event.path !== state.c.planPath) return `event.path: expected ${state.c.planPath}.`;
  if (state.tag === 'tasks') return validateTaskEvent(state.c, event);
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
  if (state.tag === 'scope-adjudication') {
    if (event.type === 'DECISION' && event.kind === 'run-stop') return nonEmpty((event.answer as Record<string, unknown>)['quote']) ? null : 'event.answer.quote: run stop requires the user quote.';
    if (event.type !== 'DECISION' || event.kind !== 'scope-deviation' || !isRecord(event.answer) || event.answer['by'] !== 'orchestrator' || stableValue(event.answer['request']) !== stableValue(state.request) || !['approve', 'disagree'].includes(String(event.answer['ruling'])) || !nonEmpty(event.answer['rationale'])) return 'event.answer: orchestrator ruling must bind the pending proposal and include a rationale.';
    return null;
  }
  if (state.tag === 'scope-user-decision') {
    if (event.type === 'DECISION' && event.kind === 'run-stop') return nonEmpty((event.answer as Record<string, unknown>)['quote']) ? null : 'event.answer.quote: run stop requires the user quote.';
    if (event.type !== 'DECISION' || event.kind !== 'scope-deviation-user' || !isRecord(event.answer) || event.answer['by'] !== 'user' || event.answer['requestId'] !== state.request.requestId || !['accept', 'decline'].includes(String(event.answer['choice'])) || !nonEmpty(event.answer['quote'])) return 'event.answer: user choice must bind the pending request id and include a quote.';
    return null;
  }
  if (state.tag === 'scope-draining') {
    if (event.type !== 'WRITE_ENVELOPE' && event.type !== 'WRITE_FAILED' && event.type !== 'WRITE_CANCELLED') return 'event.type: scope draining accepts only terminal receipts for original writer attempts.';
    if (!('task' in event) || typeof event.task !== 'string') return 'event.task: receipt must name an original active attempt.';
    if (!state.active.includes(event.task)) return 'event.task: receipt does not name an original active attempt being drained.';
    const record = state.c.tasks[event.task];
    if (!record || event.attempt !== record.attempt || event.signature !== record.signature || !record.handle || event.handle !== record.handle) return 'event.task: receipt must echo the active task attempt, signature and handle.';
    if (event.type === 'WRITE_ENVELOPE' && record.brief?.envelopePath !== event.envelopePath) return 'event.envelopePath: expected the exact original brief envelope.';
    if (event.type === 'WRITE_FAILED' && event.model !== activeModel(state.c, record)) return 'event.model: expected the active writer model.';
    return null;
  }
  if (state.tag === 'plan-review' || state.tag === 'code-review') return validateReview(state.review, event);
  if (state.tag === 'approval' && event.type === 'DECISION' && event.kind === 'approval' && event.answer !== 'stop' && !approvalAnswer(event.answer)) return 'event.answer: approval requires non-empty user-attributed by and quote.';
  if (state.tag === 'baseline-decision' && event.type === 'DECISION' && event.kind === 'baseline' && event.answer !== 'stop') {
    if (isRecord(event.answer) && isRecord(event.answer['hotfix']) && event.answer['hotfix']['mode'] === 'writer') return 'event.answer: baseline hotfix is inline-only.';
    if (failureAnswer(event.answer)?.action === 'hotfix') return null;
    const ids = isRecord(event.answer) && Array.isArray(event.answer['ids']) ? event.answer['ids'] : [];
    const available = failingBaselineIds(state.items);
    if (!isRecord(event.answer) || event.answer['action'] !== 'accept-known-red' || ids.length !== available.length || new Set(ids).size !== ids.length || available.some((id) => !ids.includes(id))) return 'event.answer: accept-known-red must name every distinct baseline failure identity.';
  }
  if (state.tag === 'needs-user' && event.type === 'DECISION' && event.kind === 'needs-user' && !needsUserRuling(state.ids, event.answer)) return 'event.answer: RED exception ruling requires accept or stop, by, and quote.';
  if (state.tag === 'concerns' && event.type === 'DECISION' && event.kind === 'concerns' && !needsUserRuling(state.items, event.answer)) return 'event.answer: concerns ruling requires accept or stop, by, and quote.';
  if (state.tag === 'failure' && event.type === 'DECISION' && event.kind === 'failure') {
    const answer = failureAnswer(event.answer);
    if (!answer) return 'event.answer: failure requires hotfix/retry with rootCause, user manual completion with quote and criteria, or stop.';
    if (state.c.phase === 'tasks' && (answer.action === 'hotfix' || answer.action === 'manual-complete')) return 'event.answer: task-phase failures accept retry or stop; hotfix and manual completion apply after delivery.';
    if (state.c.phase === 'tasks' && answer.action === 'retry' && Object.values(state.c.tasks).some((task) => task.status === 'failed') && !Object.values(state.c.tasks).some((task) => task.status === 'failed' && task.failures < MAX_WRITE_ATTEMPTS)) return `event.answer: every failed task exhausted the ${MAX_WRITE_ATTEMPTS}-failure limit; revise or stop.`;
    if (answer.action === 'manual-complete' && !recordEvidence(state.c, effectivePlan(state.c).criteria.map((row) => row.id), answer.criteria, { by: 'user', quote: answer.quote })) return 'event.criteria: manual completion needs pass or user-waived evidence for every criterion.';
  }
  if (state.tag === 'evidence' && event.type === 'EVIDENCE' && !recordEvidence(state.c, state.ids, event.criteria)) return `event.criteria: provide one bound evidence item for each of ${state.ids.join(', ')}.`;
  return null;
}

export const implementTransitions = [
  ...['author', 'plan-review', 'code-review', 'tasks', 'hotfix-write', 'baseline-decision', 'approval', 'needs-user', 'concerns', 'failure', 'evidence', 'level-classification', 'level-recommendation'].flatMap((from) => ['AUTHORED', 'NATIVE_RESULTS', 'RULINGS', 'FIXES_APPLIED', 'WRITE_LAUNCHED', 'WRITE_ENVELOPE', 'WRITE_FAILED', 'DECISION', 'EVIDENCE', 'REVISE'].map((on) => ({ from, on, to: 'checking-host-event' }))),
  ...['scope-adjudication', 'scope-user-decision'].map((from) => ({ from, on: 'DECISION', to: 'checking-host-event' })),
  ...['parsing', 'plan-review', 'code-review', 'task-checkout', 'tasks', 'needs-user', 'approval', 'baseline-decision', 'level-classification', 'level-recommendation', 'scope-adjudication', 'scope-user-decision', 'scope-draining', 'evidence', 'concerns', 'complete', 'stopped', 'failure', 'failure-snapshot', 'drift', 'hotfix-snapshot', 'hotfix-brief', 'hotfix-envelope', 'post-review-snapshot', 'revision-request'].map((to) => ({ from: 'checking-host-event', on: 'SNAPSHOT', to })),
  { from: 'checking-host-event', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  ...['task-checkout', 'parsing', 'plan-review', 'code-review', 'evidence', 'concerns', 'approval', 'failure', 'post-review-snapshot', 'revision-request'].map((to) => ({ from: 'drift', on: 'DECISION', to })),
  { from: 'drift', on: 'DECISION', to: 'stopped' },
  { from: 'baseline-decision', on: 'DECISION', to: 'approval' }, { from: 'baseline-decision', on: 'DECISION', to: 'level-classification' }, { from: 'baseline-decision', on: 'DECISION', to: 'stopped' }, { from: 'approval', on: 'DECISION', to: 'needs-user' }, { from: 'approval', on: 'DECISION', to: 'level-classification' }, { from: 'approval', on: 'DECISION', to: 'stopped' }, { from: 'needs-user', on: 'DECISION', to: 'level-classification' }, { from: 'needs-user', on: 'DECISION', to: 'stopped' },
  { from: 'approval', on: 'DECISION', to: 'task-checkout' }, { from: 'needs-user', on: 'DECISION', to: 'task-checkout' }, { from: 'failure', on: 'DECISION', to: 'task-checkout' },
  ...['scope-user-decision', 'scope-draining', 'task-checkout', 'tasks', 'hotfix-snapshot', 'hotfix-brief', 'stopped', 'failure'].map((to) => ({ from: 'scope-adjudication', on: 'DECISION', to })),
  ...['scope-draining', 'task-checkout', 'tasks', 'hotfix-snapshot', 'hotfix-brief', 'stopped', 'failure'].map((to) => ({ from: 'scope-user-decision', on: 'DECISION', to })),
  { from: 'failure', on: 'DECISION', to: 'tasks' }, { from: 'failure', on: 'DECISION', to: 'post-review-snapshot' }, { from: 'failure', on: 'DECISION', to: 'failure-snapshot' },
  ...['task-checkout', 'task-brief', 'tasks', 'task-verify', 'delivered-snapshot', 'failure-snapshot'].map((to) => ({ from: 'task-checkout', on: 'CHECKOUT_DONE', to })),
  ...['task-checkout', 'tasks', 'failure-snapshot'].map((to) => ({ from: 'task-checkout', on: 'EFFECT_FAILED', to })),
  ...['task-checkout', 'tasks', 'failure-snapshot'].flatMap((to) => [{ from: 'task-brief', on: 'BRIEF_READY', to }, { from: 'task-brief', on: 'EFFECT_FAILED', to }]),
  { from: 'tasks', on: 'WRITE_LAUNCHED', to: 'tasks' }, { from: 'tasks', on: 'WRITE_ENVELOPE', to: 'task-envelope' },
  ...['task-checkout', 'tasks', 'failure-snapshot'].map((to) => ({ from: 'tasks', on: 'WRITE_FAILED', to })),
  ...['task-checkout', 'tasks', 'scope-adjudication', 'failure-snapshot'].flatMap((to) => [{ from: 'task-envelope', on: 'ENVELOPE_CHECKED', to }, { from: 'task-envelope', on: 'EFFECT_FAILED', to }]),
  { from: 'scope-draining', on: 'WRITE_ENVELOPE', to: 'scope-drain-envelope' },
  ...['scope-draining', 'task-checkout', 'tasks', 'hotfix-snapshot', 'hotfix-brief', 'stopped', 'failure'].flatMap((to) => ['WRITE_FAILED', 'WRITE_CANCELLED'].map((on) => ({ from: 'scope-draining', on, to }))),
  ...['scope-draining', 'task-checkout', 'tasks', 'hotfix-snapshot', 'hotfix-brief', 'stopped', 'failure'].map((to) => ({ from: 'scope-drain-envelope', on: 'ENVELOPE_CHECKED', to })),
  ...['scope-draining', 'task-checkout', 'tasks', 'hotfix-snapshot', 'hotfix-brief', 'stopped', 'failure'].map((to) => ({ from: 'scope-drain-envelope', on: 'EFFECT_FAILED', to })),
  ...['task-checkout', 'task-verify', 'tasks', 'failure-snapshot'].flatMap((to) => [{ from: 'task-verify', on: 'VERIFY_DONE', to }, { from: 'task-verify', on: 'EFFECT_FAILED', to }]),
  ...['concerns', 'code-review', 'post-review-snapshot', 'failure-snapshot'].map((to) => ({ from: 'delivered-snapshot', on: 'SNAPSHOT', to })),
  { from: 'delivered-snapshot', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'hotfix-brief', on: 'BRIEF_READY', to: 'hotfix-write' }, { from: 'hotfix-brief', on: 'EFFECT_FAILED', to: 'failure' },
  { from: 'hotfix-envelope', on: 'ENVELOPE_CHECKED', to: 'hotfix-snapshot' }, { from: 'hotfix-envelope', on: 'ENVELOPE_CHECKED', to: 'failure' }, { from: 'hotfix-envelope', on: 'EFFECT_FAILED', to: 'failure' },
  ...['hotfix-verify', 'failure', 'baseline-decision', 'failure-snapshot'].map((to) => ({ from: 'hotfix-snapshot', on: 'SNAPSHOT', to })),
  { from: 'hotfix-snapshot', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'hotfix-verify', on: 'EFFECT_FAILED', to: 'failure' }, { from: 'hotfix-verify', on: 'EFFECT_FAILED', to: 'baseline-decision' },
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
  { from: 'post-review-snapshot', on: 'SNAPSHOT', to: 'generated-verify' }, { from: 'post-review-snapshot', on: 'SNAPSHOT', to: 'final-verify' }, { from: 'post-review-snapshot', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'generated-verify', on: 'VERIFY_DONE', to: 'generated-snapshot' }, { from: 'generated-verify', on: 'VERIFY_DONE', to: 'failure-snapshot' }, { from: 'generated-verify', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'generated-snapshot', on: 'SNAPSHOT', to: 'final-verify' }, { from: 'generated-snapshot', on: 'SNAPSHOT', to: 'failure-snapshot' }, { from: 'generated-snapshot', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'final-verify', on: 'VERIFY_DONE', to: 'evidence' }, { from: 'final-verify', on: 'VERIFY_DONE', to: 'failure-snapshot' }, { from: 'final-verify', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'failure-snapshot', on: 'SNAPSHOT', to: 'failure' }, { from: 'failure-snapshot', on: 'SNAPSHOT', to: 'failed' }, { from: 'failure-snapshot', on: 'EFFECT_FAILED', to: 'failed' },
  { from: 'failure', on: 'DECISION', to: 'stopped' },
] as const;

export function implementWalkthrough(state: ImplementState): WalkthroughView | null {
  if (state.tag !== 'complete' && state.tag !== 'stopped' && state.tag !== 'failed' && state.tag !== 'code-review') return null;
  if (!state.c || !state.c.plan) return null;
  const c = state.c;
  const plan = effectivePlan(c);
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
