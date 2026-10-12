// Task records for the isolated-writer phase: readiness and blocking derive from the plan graph; records persist only
// what the journal cannot recompute (attempts, worktree, launch handle, brief paths, candidate and integrated revisions).

import type { ParsedPlan, PlanCriterion, PlanTask } from '../domain/types.ts';
import type { PlanAmendment, TreeFingerprint } from '../core/types.ts';
import { isTestPath, type RedMatrixRow } from './implement-types.ts';

export type TaskStatus = 'pending' | 'running' | 'submitted' | 'accepted' | 'failed';
export type TaskBriefPaths = { path: string; sha256: string; envelopePath: string; checkpointPath: string };
export type TaskRecord = {
  id: string;
  status: TaskStatus;
  attempt: number;
  failures: number;
  signature: string;
  input: string | null;
  worktree: string | null;
  /** Keeps prior and rebased trees addressable for retries and final cleanup. */
  worktreeNames?: readonly string[];
  handle: string | null;
  baseline: TreeFingerprint | null;
  preserveDraft: boolean;
  modelIndex: number;
  /** Model the host reported launching for the active handle; differs from the cascade entry only under a disclosed substitution. */
  launchedModel?: string;
  brief: TaskBriefPaths | null;
  candidate: string | null;
  integrated: string | null;
  redRows: readonly RedMatrixRow[];
  reason: string | null;
  /** Latest writer amendment for this failure; null clears a prior attempt's proposal. */
  amendment?: TaskAmendment | null;
  /** Every brief issued to the current attempt, with the task scope it was written for; a stale receipt binds one of these. */
  briefs?: readonly TaskBriefHistory[];
  /** Envelope of a submission held until every prerequisite added by an amendment is accepted. */
  parked?: { envelopePath: string } | null;
  /** Paths the committed candidate changed; admission compares them with the current scope. */
  candidatePaths?: readonly string[];
  /** An amendment removed this running task; the record is dropped at its `cancelled` receipt. */
  removed?: boolean;
  /** Envelope a removed writer submitted before its cancellation was confirmed; kept as terminal evidence, never admitted. */
  discardedSubmission?: string | null;
};
export type TaskBriefHistory = TaskBriefPaths & { scope: string };
export type Tasks = Readonly<Record<string, TaskRecord>>;

/** Paths, criterion definitions, and prerequisites define a task's work; any change re-pends it and its descendants. */
export function taskSignature(plan: ParsedPlan, task: PlanTask): string {
  const criteria = taskCriteria(plan, task).map(({ line: _line, ...criterion }) => criterion).sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ paths: [...task.paths].sort(), criteria: [...task.criteria].sort(), definitions: criteria, summary: task.summary, prerequisites: [...task.prerequisites].sort() });
}

function fresh(plan: ParsedPlan, task: PlanTask): TaskRecord {
  return { id: task.id, status: 'pending', attempt: 0, failures: 0, signature: taskSignature(plan, task), input: null, worktree: null, worktreeNames: [], handle: null, baseline: null, preserveDraft: false, modelIndex: 0, brief: null, candidate: null, integrated: null, redRows: [], reason: null };
}

/** Paths and criterion definitions bound by a brief; a stale brief stays valid only while this is unchanged. */
export function taskScope(plan: ParsedPlan, task: PlanTask): string {
  const criteria = taskCriteria(plan, task).map(({ line: _line, ...criterion }) => criterion).sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ paths: [...task.paths].sort(), definitions: criteria });
}

/** Validated config caps concurrent task writers; an absent or invalid value runs one writer at a time. */
export function writeConcurrency(config: Readonly<Record<string, unknown>>): number {
  const value = config['write-concurrency'];
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : 1;
}

export function initialTasks(plan: ParsedPlan): Tasks {
  return Object.fromEntries(plan.tasks.map((task) => [task.id, fresh(plan, task)]));
}

/** Rewinds integrated work without reusing an earlier writer identity or replenishing failure budget. */
export function rependTasks(tasks: Tasks, plan: ParsedPlan): Tasks {
  return Object.fromEntries(plan.tasks.map((task) => {
    const old = tasks[task.id];
    return [task.id, {
      ...fresh(plan, task), attempt: old?.attempt ?? 0, failures: old?.failures ?? 0,
      worktreeNames: old?.worktreeNames ?? [],
      ...(old?.preserveDraft && old.worktree ? { worktree: old.worktree, input: old.input, preserveDraft: true, reason: old.reason } : {}),
    }];
  }));
}

function descendants(plan: ParsedPlan, ids: ReadonlySet<string>): Set<string> {
  const out = new Set(ids);
  for (let grew = true; grew;) {
    grew = false;
    for (const task of plan.tasks) if (!out.has(task.id) && task.prerequisites.some((id) => out.has(id))) { out.add(task.id); grew = true; }
  }
  return out;
}

/** Observation refresh preserves attempts, failure budgets, and live writer identities. */
export function invalidateTaskEvidence(tasks: Tasks, plan: ParsedPlan, affected: ReadonlySet<string>): Tasks {
  const invalid = descendants(plan, new Set(plan.tasks.filter((task) => task.criteria.some((id) => affected.has(id))).map((task) => task.id)));
  const pending = rependTasks(tasks, plan);
  return Object.fromEntries(Object.entries(tasks).map(([id, old]) => [id, !invalid.has(id) || old.status === 'running' || old.status === 'submitted' ? old : pending[id]! ]));
}

/** Rebinds records to a revised plan: unchanged tasks keep their records; changed, new, and dependent tasks re-pend. */
export function reconcileTasks(tasks: Tasks, plan: ParsedPlan): Tasks {
  const changed = new Set(plan.tasks.filter((task) => tasks[task.id]?.signature !== taskSignature(plan, task)).map((task) => task.id));
  const repend = descendants(plan, changed);
  return Object.fromEntries(plan.tasks.map((task) => {
    const old = tasks[task.id];
    return [task.id, !old ? fresh(plan, task) : repend.has(task.id) ? { ...fresh(plan, task), attempt: old.attempt, failures: old.signature === taskSignature(plan, task) ? old.failures : 0, worktreeNames: old.worktreeNames ?? [] } : old];
  }));
}

/** `removedRunning` lists launched writers an amendment removes; they discard live work, so the amendment is user-gated. */
export type AmendResult = { ok: true; tasks: Tasks; rebrief: string[]; reverify: string[]; removedAccepted: string[]; discarded: string[]; removedRunning: string[] } | { ok: false; error: string };

/**
 * Rebinds records to an amended plan without draining writers: pending and failed tasks re-pend on a changed signature;
 * running tasks keep their launch identity and need a notice when their scope changes; submitted candidates wait for
 * admission against the new scope; accepted tasks with a changed scope are re-verified on the integration head.
 */
export function amendTasks(tasks: Tasks, before: ParsedPlan, after: ParsedPlan, notify: readonly string[]): AmendResult {
  const next: Record<string, TaskRecord> = {};
  const rebrief: string[] = [], reverify: string[] = [], removedAccepted: string[] = [], discarded: string[] = [], removedRunning: string[] = [];
  for (const task of after.tasks) {
    const old = tasks[task.id];
    const prior = before.tasks.find((row) => row.id === task.id);
    if (!old || !prior) { next[task.id] = fresh(after, task); continue; }
    const signature = taskSignature(after, task);
    const scopeChanged = taskScope(before, prior) !== taskScope(after, task);
    const unaccepted = task.prerequisites.filter((id) => !prior.prerequisites.includes(id) && tasks[id]?.status !== 'accepted');
    switch (old.status) {
      case 'pending': case 'failed':
        next[task.id] = signature === old.signature ? old : { ...fresh(after, task), attempt: old.attempt, worktreeNames: old.worktreeNames ?? [] };
        break;
      case 'running':
        if (scopeChanged && !notify.includes(task.id)) return { ok: false, error: `AMEND changes running task ${task.id}; name it in notify so its brief is regenerated.` };
        if (notify.includes(task.id)) rebrief.push(task.id);
        next[task.id] = old;
        break;
      case 'submitted':
        next[task.id] = old;
        break;
      case 'accepted':
        if (unaccepted.length) return { ok: false, error: `AMEND adds unaccepted prerequisite ${unaccepted.join(', ')} to accepted task ${task.id}; reorder the tasks or discard the accepted work with a user-gated amendment.` };
        if (scopeChanged) reverify.push(task.id);
        next[task.id] = { ...old, signature };
        break;
      default: return { ok: false, error: `Unknown task status for ${task.id}.` };
    }
  }
  for (const [id, old] of Object.entries(tasks)) {
    if (after.tasks.some((task) => task.id === id)) continue;
    if (old.status === 'running') {
      if (old.handle && !old.removed) removedRunning.push(id);
      next[id] = { ...old, removed: true };
      continue;
    }
    if (old.status === 'accepted') removedAccepted.push(id);
    if (old.status === 'submitted') discarded.push(id);
  }
  for (const id of notify) if (!next[id] || next[id]!.status !== 'running' || next[id]!.removed) return { ok: false, error: `notify names ${id}, which is not a live writer in the amended plan.` };
  return { ok: true, tasks: next, rebrief, reverify, removedAccepted, discarded, removedRunning };
}

/** Accepted work is already integrated; losing any accepted record means integration must be rebuilt. */
export function invalidatesIntegration(before: Tasks, after: Tasks): boolean {
  return Object.values(before).some((record) => record.status === 'accepted' && after[record.id]?.status !== 'accepted');
}

export function readyTasks(plan: ParsedPlan, tasks: Tasks, maxFailures: number): PlanTask[] {
  return plan.tasks.filter((task) => tasks[task.id]?.status === 'pending' && tasks[task.id]!.failures < maxFailures
    && task.prerequisites.every((id) => tasks[id]?.status === 'accepted'));
}

export function activeTasks(tasks: Tasks): TaskRecord[] {
  return Object.values(tasks).filter((task) => task.status === 'running' || task.status === 'submitted');
}

/** Records that hold a writer slot: a parked submission has finished writing, so it waits without one. */
export function slotTasks(tasks: Tasks): TaskRecord[] {
  return activeTasks(tasks).filter((task) => !(task.status === 'submitted' && task.parked));
}

/** Failed tasks plus every pending task that can no longer run because an ancestor failed. */
export type TaskAmendment = PlanAmendment & { unresolvedTargets: readonly string[] };
export type FailureItem = { task: string; status: 'failed' | 'blocked'; reason: string; attempt: number; amendment?: TaskAmendment };
export function failureItems(plan: ParsedPlan, tasks: Tasks): FailureItem[] {
  const failed = new Set(plan.tasks.filter((task) => tasks[task.id]?.status === 'failed').map((task) => task.id));
  const blocked = descendants(plan, failed);
  return plan.tasks.flatMap((task): FailureItem[] => {
    const record = tasks[task.id];
    if (!record) return [];
    if (record.status === 'failed') return [{ task: task.id, status: 'failed', reason: record.reason ?? 'failed', attempt: record.attempt, ...(record.amendment ? { amendment: record.amendment } : {}) }];
    if (blocked.has(task.id) && record.status === 'pending') return [{ task: task.id, status: 'blocked', reason: `waits on ${task.prerequisites.filter((id) => blocked.has(id)).join(', ')}`, attempt: record.attempt }];
    return [];
  });
}

/** Worktree names are short slugs under `<runDir>/wt/`; `red-*` trees replay checkpoints at the input revision. */
export function worktreeName(kind: 'task' | 'red', id: string): string {
  return `${kind}-${id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`.slice(0, 32);
}

export function taskCriteria(plan: ParsedPlan, task: PlanTask): PlanCriterion[] {
  return plan.criteria.filter((criterion) => task.criteria.includes(criterion.id));
}

export function taskRedCriteria(plan: ParsedPlan, task: PlanTask): PlanCriterion[] {
  return taskCriteria(plan, task).filter((criterion) => criterion.evidence === 'red' && !criterion.redException);
}

export function taskTestPaths(plan: ParsedPlan, task: PlanTask): string[] {
  return [...new Set(taskRedCriteria(plan, task).flatMap((criterion) => criterion.changes.filter((file) => isTestPath(file) && task.paths.includes(file))))].sort();
}

export function checkpointPathOf(envelopePath: string): string {
  return envelopePath.replace(/outcome\.json$/, 'red.json');
}
