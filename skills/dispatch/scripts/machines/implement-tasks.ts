// Task records for the isolated-writer phase: readiness and blocking derive from the plan graph; records persist only
// what the journal cannot recompute (attempts, worktree, launch handle, brief paths, candidate and integrated revisions).

import type { ParsedPlan, PlanCriterion, PlanTask } from '../domain/types.ts';
import { isTestPath, type RedMatrixRow } from './implement-types.ts';

export type TaskStatus = 'pending' | 'running' | 'submitted' | 'accepted' | 'failed';
export type TaskBriefPaths = { path: string; sha256: string; envelopePath: string; checkpointPath: string };
export type TaskRecord = {
  id: string;
  status: TaskStatus;
  attempt: number;
  signature: string;
  input: string | null;
  worktree: string | null;
  handle: string | null;
  modelIndex: number;
  brief: TaskBriefPaths | null;
  candidate: string | null;
  integrated: string | null;
  redRows: readonly RedMatrixRow[];
  reason: string | null;
};
export type Tasks = Readonly<Record<string, TaskRecord>>;

/** Paths, criteria, and prerequisites define a task's work; any change re-pends it and its descendants. */
export function taskSignature(task: PlanTask): string {
  return JSON.stringify({ paths: [...task.paths].sort(), criteria: [...task.criteria].sort(), prerequisites: [...task.prerequisites].sort() });
}

function fresh(task: PlanTask): TaskRecord {
  return { id: task.id, status: 'pending', attempt: 0, signature: taskSignature(task), input: null, worktree: null, handle: null, modelIndex: 0, brief: null, candidate: null, integrated: null, redRows: [], reason: null };
}

/** Validated config caps concurrent task writers; an absent or invalid value runs one writer at a time. */
export function writeConcurrency(config: Readonly<Record<string, unknown>>): number {
  const value = config['write-concurrency'];
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : 1;
}

export function initialTasks(plan: ParsedPlan): Tasks {
  return Object.fromEntries(plan.tasks.map((task) => [task.id, fresh(task)]));
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
  const changed = new Set(plan.tasks.filter((task) => tasks[task.id]?.signature !== taskSignature(task)).map((task) => task.id));
  const repend = descendants(plan, changed);
  return Object.fromEntries(plan.tasks.map((task) => {
    const old = tasks[task.id];
    return [task.id, !old || repend.has(task.id) ? { ...fresh(task), attempt: old && old.status !== 'accepted' ? old.attempt : 0 } : old];
  }));
}

export function readyTasks(plan: ParsedPlan, tasks: Tasks, maxAttempts: number): PlanTask[] {
  return plan.tasks.filter((task) => tasks[task.id]?.status === 'pending' && tasks[task.id]!.attempt < maxAttempts
    && task.prerequisites.every((id) => tasks[id]?.status === 'accepted'));
}

export function activeTasks(tasks: Tasks): TaskRecord[] {
  return Object.values(tasks).filter((task) => task.status === 'running' || task.status === 'submitted');
}

/** Failed tasks plus every pending task that can no longer run because an ancestor failed. */
export type FailureItem = { task: string; status: 'failed' | 'blocked'; reason: string; attempt: number };
export function failureItems(plan: ParsedPlan, tasks: Tasks): FailureItem[] {
  const failed = new Set(plan.tasks.filter((task) => tasks[task.id]?.status === 'failed').map((task) => task.id));
  const blocked = descendants(plan, failed);
  return plan.tasks.flatMap((task): FailureItem[] => {
    const record = tasks[task.id];
    if (!record) return [];
    if (record.status === 'failed') return [{ task: task.id, status: 'failed', reason: record.reason ?? 'failed', attempt: record.attempt }];
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
  return envelopePath.replace(/\.outcome\.json$/, '') + '.red.json';
}
