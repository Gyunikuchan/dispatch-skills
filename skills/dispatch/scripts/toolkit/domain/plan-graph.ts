import type { LintDefect, ParsedPlan, PlanChange, PlanCriterion, PlanTask, PlanWarning } from './types.ts';
import { isCriterionId } from './criterion-id.ts';
import { PROSE_PLACEHOLDER, hasBehaviour, isFillerNote, lint } from './plan-lint.ts';
import type { AuthoredTaskRow, Criterion, DraftTask } from './plan-parse.ts';

// SECTION: Task graph

export function joinTaskMap(sections: readonly DraftTask[], rows: readonly AuthoredTaskRow[], out: LintDefect[]): DraftTask[] {
  const byId = new Map<string, DraftTask[]>();
  for (const section of sections) byId.set(section.id, [...(byId.get(section.id) ?? []), section]);
  const rowIds = new Set(rows.map((row) => row.id));
  const joined = new Map<string, DraftTask>();
  for (const row of rows) {
    const matches = byId.get(row.id) ?? [];
    if (!matches.length) {
      out.push(lint('task-map', row.line, `Task Map row ${row.id} has no matching Proposed Changes task.`));
      continue;
    }
    for (const task of matches) {
      if (task.title !== row.title) out.push(lint('task-map', row.line, `Task Map title for ${row.id} must match its Proposed Changes heading "${task.title}".`));
      task.summary = row.outcome;
      task.prerequisites = row.prerequisites;
      task.criteria = row.criteria;
      task.prerequisitesLine = row.line;
      task.criteriaLine = row.line;
      task.summaryLine = row.line;
    }
    if (!joined.has(row.id)) joined.set(row.id, matches[0]!);
  }
  for (const task of sections) {
    if (!rowIds.has(task.id)) out.push(lint('task-map', task.line, `Task ${task.id} has no Task Map row.`));
  }
  return rows.flatMap((row) => joined.has(row.id) ? [joined.get(row.id)!] : []);
}

export function lintTaskSections(tasks: readonly DraftTask[], out: LintDefect[]): void {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) out.push(lint('duplicate-id', task.line, `Duplicate task ${task.id}.`));
    else seen.add(task.id);
    if (!task.paths.length) out.push(lint('task-ownership', task.line, `Task ${task.id} owns no file change.`));
  }
}

export function lintTasks(tasks: readonly DraftTask[], changes: readonly PlanChange[], criteria: readonly Criterion[], out: LintDefect[]): PlanWarning[] {
  const byId = new Map<string, DraftTask>();
  for (const task of tasks) {
    byId.set(task.id, task);
    const prose = task.summary.replace(/`[^`]*`/g, '');
    if (!prose.trim() || PROSE_PLACEHOLDER.test(prose) || isFillerNote(task.summary)) {
      out.push(lint('task-summary', task.summaryLine, `Task ${task.id} requires a meaningful plain-language Outcome in its Task Map row.`));
    }
    if (!hasBehaviour(task.behaviour)) out.push(lint('task-behaviour', task.line, `Task ${task.id} requires a behavioural bullet before its details.`));
    if (task.prerequisitesLine === null) out.push(lint('missing-prerequisite', task.line, `Task ${task.id} requires Prerequisites: none or task IDs in its Task Map row.`));
    for (const id of task.prerequisites) {
      if (id === task.id || !tasks.some((other) => other.id === id)) out.push(lint('missing-prerequisite', task.prerequisitesLine, `Task ${task.id} lists ${id === task.id ? 'itself' : `unknown task ${id}`} in its Task Map Prerequisites cell.`));
    }
  }
  const ancestors = taskAncestors(byId, out);
  lintTaskCriteria(tasks, criteria, out);
  for (const task of tasks) {
    for (const { path, inputs } of task.generated) {
      for (const input of inputs) {
        if (changes.some((change) => change.action === 'DELETE' && change.path.toLowerCase() === input.toLowerCase())) {
          out.push(lint('generated-inputs', task.line, `Task ${task.id} generates ${path} from ${input}, which the plan deletes.`));
          continue;
        }
        // An input no task owns is a pre-existing file; a self-owned input needs no ordering.
        const producer = tasks.find((other) => other.paths.some((owned) => owned.toLowerCase() === input.toLowerCase()));
        if (producer && producer.id !== task.id && !ancestors.get(task.id)?.has(producer.id)) {
          out.push(lint('generated-inputs', task.line, `Task ${task.id} generates ${path} from ${input}, produced by ${producer.id}; add ${producer.id} to its Task Map Prerequisites cell as a direct or transitive prerequisite.`));
        }
      }
    }
  }
  return lintOverlaps(tasks, ancestors, out);
}

/** Write paths shared by tasks with no transitive Task Map prerequisite path warn unless either task justifies them with Overlap:. */
function lintOverlaps(tasks: readonly DraftTask[], ancestors: ReadonlyMap<string, ReadonlySet<string>>, out: LintDefect[]): PlanWarning[] {
  // NOTE: case-insensitive filesystems make case variants one file.
  const owned = tasks.map((task) => new Map(task.paths.map((path) => [path.toLowerCase(), path] as const)));
  const justified = tasks.map((task) => new Set(task.overlaps.map(({ path }) => path.toLowerCase())));
  tasks.forEach((task, index) => task.overlaps.forEach(({ path }, entry) => {
    if (!owned[index]?.has(path.toLowerCase())) out.push(lint('task-overlap', task.overlapLines[entry] ?? task.line, `Task ${task.id} justifies an overlap on "${path}", which it does not write.`));
  }));
  const warnings: PlanWarning[] = [];
  tasks.forEach((first, i) => tasks.forEach((second, j) => {
    if (j <= i || ancestors.get(first.id)?.has(second.id) || ancestors.get(second.id)?.has(first.id)) return;
    for (const [folded, path] of owned[i] ?? []) {
      const other = owned[j]?.get(folded);
      if (other === undefined || justified[i]?.has(folded) || justified[j]?.has(folded)) continue;
      warnings.push({ kind: 'overlap', tasks: [first.id, second.id], path });
      const alias = other === path ? '' : ` (as "${other}" in ${second.id})`;
      out.push(lint('overlap', second.line, `Tasks ${first.id} and ${second.id} both write "${path}"${alias} with no prerequisite path between them; add an entry to Task Map Prerequisites, merge the tasks, or add "- Overlap: ${path} — <reason>".`));
    }
  }));
  return warnings;
}

/** Transitive prerequisites per task; reports each cycle entry point once. */
function taskAncestors(byId: ReadonlyMap<string, DraftTask>, out: LintDefect[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const visit = (task: DraftTask): Set<string> => {
    const known = result.get(task.id);
    if (known) return known;
    if (visiting.has(task.id)) { out.push(lint('cycle', task.line, `Task ${task.id} is part of a prerequisite cycle in the Task Map.`)); return new Set(); }
    visiting.add(task.id);
    const set = new Set<string>();
    for (const id of task.prerequisites) {
      const parent = byId.get(id);
      if (!parent || parent === task) continue;
      set.add(id);
      for (const ancestor of visit(parent)) set.add(ancestor);
    }
    visiting.delete(task.id);
    result.set(task.id, set);
    return set;
  };
  for (const task of byId.values()) visit(task);
  return result;
}

function lintTaskCriteria(tasks: readonly DraftTask[], criteria: readonly Criterion[], out: LintDefect[]): void {
  const known = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const owner = new Map<string, string>();
  for (const task of tasks) {
    const line = task.criteriaLine ?? task.line;
    if (!task.criteria.length) out.push(lint('task-criteria', line, `Task ${task.id} requires one or more acceptance criteria in its Task Map Criteria cell.`));
    for (const id of task.criteria) {
      if (!isCriterionId(id)) { out.push(lint('task-criteria', line, `Task ${task.id} names invalid criterion ${id}; use SC[1-9][0-9]*.`)); continue; }
      const criterion = known.get(id);
      if (!criterion) { out.push(lint('task-criteria', line, `Task ${task.id} names unknown criterion ${id}.`)); continue; }
      const prior = owner.get(id);
      if (prior) { out.push(lint('task-criteria', line, `Criterion ${id} is mapped to both ${prior} and ${task.id}; use - Integration: <reason> for a cross-task criterion.`)); continue; }
      owner.set(id, task.id);
      if (criterion.integration !== null) out.push(lint('task-criteria', criterion.line, `Criterion ${id} is mapped to ${task.id} and marked Integration; choose one.`));
      // Admission requires each evidence row path in Changes, so a task-owned criterion without Changes can never pass.
      else if (!criterion.changes.length) out.push(lint('criterion-task-changes', criterion.line, `Criterion ${id} is task-owned but has no Changes; list the task paths it proves in Changes, or mark it Integration: <reason> with Check.`));
      const foreign = criterion.changes.filter((path) => !task.paths.includes(path));
      if (foreign.length) out.push(lint('task-criteria', criterion.line, `Criterion ${id} of ${task.id} changes ${foreign.join(', ')} outside the task; move the path or mark the criterion Integration.`));
    }
  }
  if (!tasks.length) return;
  for (const criterion of criteria) {
    if (owner.has(criterion.id)) continue;
    if (criterion.integration === null) out.push(lint('task-criteria', criterion.line, `Criterion ${criterion.id} maps to no Task Map row; add it to a task's Criteria cell or provide Integration: <reason>.`));
    else if (!criterion.integration.trim() || !criterion.verify.length) out.push(lint('task-criteria', criterion.line, `Integration criterion ${criterion.id} requires a reason and a Check command.`));
  }
}

// SECTION: Derived task views

type TaskMapRow = { id: string; outcome: string; prerequisites: readonly string[]; criteria: readonly string[]; paths: readonly string[]; overlap: readonly { path: string; tasks: readonly string[] }[] };

/** One row per task in Task Map order; Overlap names each written path that other tasks also write. */
export function taskMapRows(plan: Pick<ParsedPlan, 'tasks'>): TaskMapRow[] {
  return plan.tasks.map((task) => {
    return {
      id: task.id,
      outcome: task.summary ? `${task.title} — ${task.summary}` : task.title,
      prerequisites: task.prerequisites,
      criteria: task.criteria,
      paths: task.paths,
      // NOTE: case-insensitive filesystems make case variants one file, as in the overlap lint.
      overlap: task.paths.flatMap((path) => {
        const tasks = plan.tasks.filter((other) => other !== task && other.paths.some((owned) => owned.toLowerCase() === path.toLowerCase())).map((other) => other.id);
        return tasks.length ? [{ path, tasks }] : [];
      }),
    };
  });
}

/** One human line per task in plan order: `T2 — title (after T1)` or `(start)`. */
export function taskExecutionSummary(tasks: readonly PlanTask[]): string[] {
  return tasks.map((task) => `${task.id} — ${task.title} (${task.prerequisites.length ? `after ${task.prerequisites.join(', ')}` : 'start'})`);
}

type TaskBrief = {
  task: PlanTask;
  changes: readonly PlanChange[];
  criteria: readonly PlanCriterion[];
  prerequisites: readonly PlanTask[];
  dependents: readonly PlanTask[];
  summary: readonly string[];
};

/** The focused selection a task writer receives; the full plan stays read-only context. */
export function selectTaskBrief(plan: ParsedPlan, id: string): TaskBrief | null {
  const task = plan.tasks.find((item) => item.id === id);
  if (!task) return null;
  const graphTask = (item: PlanTask): PlanTask => ({ ...item, constraints: [] });
  // An overlapped path has one change entry per owning task; prefer the entry under this task's own heading.
  const next = Math.min(...plan.tasks.map((item) => item.line).filter((line) => line > task.line));
  const inTask = (change: PlanChange) => change.line > task.line && change.line < next;
  return {
    task,
    changes: plan.changes.filter((change) => task.paths.includes(change.path)
      && (inTask(change) || !plan.changes.some((other) => other.path === change.path && inTask(other)))),
    criteria: plan.criteria.filter((criterion) => task.criteria.includes(criterion.id)),
    prerequisites: plan.tasks.filter((item) => task.prerequisites.includes(item.id)).map(graphTask),
    dependents: plan.tasks.filter((item) => item.prerequisites.includes(task.id)).map(graphTask),
    summary: taskExecutionSummary(plan.tasks),
  };
}

// SECTION: Increment and spec traceability

function incrementPathMatches(file: string, scope: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '');
  const target = normalize(file), pattern = normalize(scope);
  if (target.split('/').some((part) => part === '.' || part === '..') || target.startsWith('/') || /^[a-z]:/i.test(target)) return false;
  if (pattern.endsWith('/')) return target.startsWith(pattern);
  const braces = /\{([^{}]+)\}/.exec(pattern);
  if (braces) return braces[1]!.split(',').some((part) => incrementPathMatches(target, pattern.replace(braces[0], part)));
  let expression = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; expression += '(?:.*/)?'; }
      else expression += '.*';
    } else if (ch === '*') expression += '[^/]*';
    else if (ch === '?') expression += '[^/]';
    else expression += ch.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(`^${expression}$`).test(target);
}

/** One warning per change path outside the increment's Paths, on that change's line. */
export function outsideIncrementWarnings(changes: readonly PlanChange[], paths: readonly string[], increment: string): LintDefect[] {
  return changes.filter(change => !paths.some(owned => incrementPathMatches(change.path, owned)))
    .map(change => lint('outside-increment', change.line, `Plan path ${change.path} is outside increment ${increment} Paths.`));
}

/** Admission uses the journal-owned design binding, never artifact metadata as approval. */
export function validateDesignTraceability(plan: ParsedPlan, binding: { path: string; revision: string; increment: string; contract: Readonly<Record<string, string>>; paths?: readonly string[] }): string[] {
  const trace = plan.traceability;
  if (!trace) return ['Technical-Design Traceability is required for a design-bound plan.'];
  const value = (name: string) => Object.entries(trace).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]?.replace(/`/g, '').trim();
  const defects: string[] = [];
  for (const change of plan.changes ?? []) if (binding.paths && !binding.paths.some((owned) => incrementPathMatches(change.path, owned))) defects.push(`Plan path ${change.path} is outside increment ${binding.increment} scope.`);
  if (value('Approved revision') !== undefined) {
    const parent = plan.box?.['Parent']?.replace(/`/g, '').trim();
    if (parent !== `${binding.path} · ${binding.increment}`) defects.push(`Parent must equal ${binding.path} · ${binding.increment}.`);
    if (value('Approved revision') !== binding.revision) defects.push(`Approved revision must equal ${binding.revision}.`);
    const inherited = value('Increment ID and inherited contract') ?? '';
    if (!new RegExp(`^${binding.increment}(?:\\s|$)`).test(inherited)) defects.push(`Increment ID and inherited contract must name ${binding.increment}.`);
    for (const [key, expected] of Object.entries(binding.contract)) if (!inherited.includes(expected)) defects.push(`Inherited contract must cover ${key}: ${expected}.`);
    for (const key of ['Prerequisite evidence', 'Acceptance mapping']) if (!value(key)) defects.push(`Technical-Design Traceability requires ${key}.`);
    return defects;
  }
  for (const [key, expected] of Object.entries({ Design: binding.path, Revision: binding.revision, Increment: binding.increment })) {
    if (value(key) !== expected) defects.push(`Technical-Design Traceability ${key} must equal ${expected}.`);
  }
  for (const [key, expected] of Object.entries(binding.contract)) {
    if (value(key) !== expected) defects.push(`Technical-Design Traceability must inherit ${key}: ${expected}.`);
  }
  return defects;
}

export function validateSpecTraceability(plan: ParsedPlan, reqIds: readonly string[]): LintDefect[] {
  const known = new Set(reqIds), cited = new Set<string>(), defects: LintDefect[] = [];
  for (const criterion of plan.criteria) for (const id of criterion.satisfies ?? []) {
    cited.add(id);
    if (!known.has(id)) defects.push(lint('unknown-requirement', criterion.line, `Criterion ${criterion.id} cites unknown requirement ${id}.`));
  }
  for (const id of known) if (!cited.has(id)) defects.push(lint('unsatisfied-requirement', null, `Requirement ${id} is not cited by a criterion.`));
  return defects;
}
