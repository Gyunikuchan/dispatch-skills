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
};
export type Tasks = Readonly<Record<string, TaskRecord>>;

/** Paths, criterion definitions, and prerequisites define a task's work; any change re-pends it and its descendants. */
export function taskSignature(plan: ParsedPlan, task: PlanTask): string {
  const criteria = taskCriteria(plan, task).map(({ line: _line, ...criterion }) => criterion).sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ paths: [...task.paths].sort(), criteria: [...task.criteria].sort(), definitions: criteria, summary: task.summary, prerequisites: [...task.prerequisites].sort() });
}

function fresh(plan: ParsedPlan, task: PlanTask): TaskRecord {
  return { id: task.id, status: 'pending', attempt: 0, failures: 0, signature: taskSignature(plan, task), input: null, worktree: null, worktreeNames: [], handle: null, baseline: null, preserveDraft: false, modelIndex: 0, brief: null, candidate: null, integrated: null, redRows: [], reason: null };
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

/** Rebinds records to a revised plan: unchanged tasks keep their records; changed, new, and dependent tasks re-pend. */
export function reconcileTasks(tasks: Tasks, plan: ParsedPlan): Tasks {
  const changed = new Set(plan.tasks.filter((task) => tasks[task.id]?.signature !== taskSignature(plan, task)).map((task) => task.id));
  const repend = descendants(plan, changed);
  return Object.fromEntries(plan.tasks.map((task) => {
    const old = tasks[task.id];
    return [task.id, !old ? fresh(plan, task) : repend.has(task.id) ? { ...fresh(plan, task), attempt: old.attempt, failures: old.signature === taskSignature(plan, task) ? old.failures : 0, worktreeNames: old.worktreeNames ?? [] } : old];
  }));
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
