// One pure reconcile operation for every plan revision (`AMEND` adapter or `REPLACE_PLAN`): it binds current task records
// to the revised plan without discarding work. Retained, changed, added and retired tasks follow the orchestrator's
// summary; the driver checks that summary against the records instead of inferring intent or dependency changes.

import type { PlanReconciliation, WriterRetirement } from '../core/types.ts';
import type { ParsedPlan } from '../domain/types.ts';
import { fresh, taskScope, taskSignature, type RetiredTask, type TaskRecord, type Tasks } from './implement-tasks.ts';

export type ReconcileInput = {
  tasks: Tasks;
  before: ParsedPlan;
  after: ParsedPlan;
  /** Absent only for the `AMEND` adapter; the derived summary then attests no intent or dependency change. */
  reconciliation?: PlanReconciliation | undefined;
  notify: readonly string[];
  retire: readonly WriterRetirement[];
  /** Task of an open integration conflict; changing its prerequisites or rechecking accepted work waits for the conflict. */
  conflictTask: string | null;
  /** Revision id (`amend-N` or `replace-N`) recorded on archived records. */
  revision: string;
};

export type Reconciled = {
  ok: true;
  tasks: Tasks;
  archived: readonly RetiredTask[];
  summary: PlanReconciliation;
  /** Live writers whose regenerated brief carries a notice. */
  rebrief: readonly string[];
  /** Accepted tasks whose scope changed; their checks re-run on the integration head. */
  reverify: readonly string[];
  /** Accepted tasks that gained an unfinished prerequisite; their criteria become pending validation obligations. */
  validate: readonly string[];
  /** Reasons the revision needs the user's quote. */
  gates: readonly string[];
} | { ok: false; error: string };

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join('\0') === [...b].sort().join('\0');

/** The summary the records imply; the orchestrator's summary must name exactly these sets. */
export function deriveSummary(tasks: Tasks, after: ParsedPlan): Omit<PlanReconciliation, 'intentChanged' | 'dependencyChanged'> {
  const live = Object.values(tasks).filter((record) => !record.removed);
  const retained: string[] = [], changed: string[] = [], added: string[] = [];
  for (const task of after.tasks) {
    const old = tasks[task.id];
    if (!old || old.removed) added.push(task.id);
    else if (old.signature === taskSignature(after, task)) retained.push(task.id);
    else changed.push(task.id);
  }
  const retired = live.filter((record) => !after.tasks.some((task) => task.id === record.id)).map((record) => record.id);
  return { retained, changed, added, retired };
}

function checkSummary(summary: PlanReconciliation, derived: ReturnType<typeof deriveSummary>, after: ParsedPlan): string | null {
  for (const key of ['retained', 'changed', 'added', 'retired'] as const) {
    if (new Set(summary[key]).size !== summary[key].length) return `reconciliation.${key}: name each task once.`;
    if (!same(summary[key], derived[key])) return `reconciliation.${key}: expected [${derived[key].join(', ')}] for the current task records; got [${summary[key].join(', ')}].`;
  }
  const compensating = summary.compensating ?? [];
  const unknown = compensating.filter((id) => !summary.added.includes(id));
  if (unknown.length) return `reconciliation.compensating: ${unknown.join(', ')} must be added tasks.`;
  if (compensating.length && !summary.retired.length && !after.tasks.some((task) => compensating.includes(task.id))) return 'reconciliation.compensating: name the added task that removes retired bytes.';
  return null;
}

/**
 * Binds records to the revised plan: unchanged tasks keep their records; changed pending or failed tasks re-pend while
 * keeping attempt history and an explicit draft; running writers keep their identity and need a notice when their scope
 * changes; submitted candidates wait for admission; accepted work stays integrated. A retired task is archived; a
 * retired live writer keeps its slot under a stop/retain disposition until its terminal receipt.
 */
export function reconcilePlan(input: ReconcileInput): Reconciled {
  const { tasks, before, after, notify, retire, conflictTask } = input;
  const derived = deriveSummary(tasks, after);
  const summary: PlanReconciliation = input.reconciliation ?? { ...derived, intentChanged: false, dependencyChanged: false };
  const summaryError = input.reconciliation ? checkSummary(input.reconciliation, derived, after) : null;
  if (summaryError) return { ok: false, error: summaryError };
  const reused = after.tasks.filter((task) => tasks[task.id]?.removed).map((task) => task.id);
  if (reused.length) return { ok: false, error: `${reused.join(', ')} is still retiring a live writer; give the new task another id.` };
  const next: Record<string, TaskRecord> = {};
  const archived: RetiredTask[] = [];
  const rebrief: string[] = [], reverify: string[] = [], validate: string[] = [], gates: string[] = [];
  for (const task of after.tasks) {
    const old = tasks[task.id];
    const prior = before.tasks.find((row) => row.id === task.id);
    if (!old || !prior) { next[task.id] = fresh(after, task); continue; }
    const signature = taskSignature(after, task);
    const scopeChanged = taskScope(before, prior) !== taskScope(after, task);
    const unfinished = task.prerequisites.filter((id) => !prior.prerequisites.includes(id) && tasks[id]?.status !== 'accepted');
    switch (old.status) {
      case 'pending': case 'failed':
        // NOTE: an explicit draft rebase keeps its worktree; only the definition changed, so the draft is not rewound.
        next[task.id] = signature === old.signature ? old : {
          ...fresh(after, task), attempt: old.attempt, failures: old.failures, worktreeNames: old.worktreeNames ?? [],
          ...(old.preserveDraft && old.worktree ? { worktree: old.worktree, input: old.input, preserveDraft: true, reason: old.reason } : {}),
        };
        break;
      case 'running':
        if (scopeChanged && !notify.includes(task.id)) return { ok: false, error: `revision changes running task ${task.id}; name it in notify so its brief is regenerated.` };
        if (notify.includes(task.id)) rebrief.push(task.id);
        next[task.id] = old;
        break;
      case 'submitted':
        next[task.id] = old;
        break;
      case 'accepted':
        if (unfinished.length) validate.push(task.id);
        if (scopeChanged) reverify.push(task.id);
        next[task.id] = { ...old, signature };
        break;
      default: return { ok: false, error: `Unknown task status for ${task.id}.` };
    }
  }
  for (const [id, old] of Object.entries(tasks)) {
    if (after.tasks.some((task) => task.id === id)) continue;
    if (old.removed) { next[id] = old; continue; }
    const disposition = retire.find((row) => row.task === id)?.disposition;
    if (old.status === 'running' && old.handle) {
      if (!disposition) return { ok: false, error: `retire: name a stop or retain disposition for live writer ${id}.` };
      if (disposition === 'stop') gates.push(`stops live writer ${id}`);
      next[id] = { ...old, removed: true, retirement: disposition };
      continue;
    }
    if (id === conflictTask) gates.push(`discards conflicted integration of ${id}`);
    archived.push({ ...old, retiredBy: input.revision });
  }
  const unknownRetire = retire.filter((row) => next[row.task]?.retirement !== row.disposition || tasks[row.task]?.removed).map((row) => row.task);
  if (unknownRetire.length) return { ok: false, error: `retire names ${unknownRetire.join(', ')}, which is not a live writer this revision retires.` };
  for (const id of notify) if (!next[id] || next[id]!.status !== 'running' || next[id]!.removed) return { ok: false, error: `notify names ${id}, which is not a live writer in the revised plan.` };
  if (conflictTask && (reverify.length || validate.length)) return { ok: false, error: 'resolve or discard the open integration conflict before a revision that rechecks accepted work.' };
  if (summary.intentChanged) gates.push('attested intent change');
  if (summary.dependencyChanged) gates.push('attested new external dependency');
  if (summary.compensating?.length) gates.push(`compensating removal by ${summary.compensating.join(', ')}`);
  return { ok: true, tasks: next, archived, summary, rebrief, reverify, validate, gates };
}
