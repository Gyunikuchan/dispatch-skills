import assert from 'node:assert/strict';
import type { Effect, Event, RunStartedEvent } from '../../../../skills/dispatch/scripts/core/types.ts';
import type { ScopeAdjustment } from '../../../../skills/dispatch/scripts/core/types.ts';
import type { ParsedPlan, PlanCriterion, PlanTask } from '../../../../skills/dispatch/scripts/domain/types.ts';
import { parseRedMatrix } from '../../../../skills/dispatch/scripts/machines/implement-types.ts';
import { beginRevision, reboundRevision } from '../../../../skills/dispatch/scripts/machines/revision.ts';
import { effectivePlan, implementData, initialImplement, stepImplement, validateImplement, type ImplementState } from '../../../../skills/dispatch/scripts/machines/implement.ts';
import { reconcileTasks, taskSignature } from '../../../../skills/dispatch/scripts/machines/implement-tasks.ts';

// SECTION: Fixture plan — T1 (RED) and T2 are independent; T3 depends on T1.

export const HASH = `sha256:${'a'.repeat(64)}`;
export const FP = { head: 'h', index: 'i', worktree: 'w' };
export const criterion = (id: string, file: string, evidence: 'red' | 'verify', extra: string[] = []): PlanCriterion => ({
  id, title: `${id} works`, line: 1, changes: [file, ...extra], verify: [{ command: `node --test tests/${id.toLowerCase()}.test.ts`, final: false }],
  evidence, preExisting: false, redException: null, testRationale: evidence === 'red' ? 'discriminates' : null, review: null, enforcementInfeasibility: null,
});
export const task = (id: string, paths: string[], criteria: string[], prerequisites: string[] = []): PlanTask => ({ id, title: id, summary: `Deliver ${id}`, line: 1, paths, criteria, prerequisites, generated: [] });
export const PLAN: ParsedPlan = {
  title: 'Tasks', box: { 'TL;DR': 'Deliver tasks' }, keyDecisions: [],
  criteria: [criterion('SC1', 'src/a.ts', 'red', ['tests/sc1.test.ts']), criterion('SC2', 'src/b.ts', 'verify'), criterion('SC3', 'src/c.ts', 'verify')],
  changes: [{ action: 'MODIFY', path: 'src/a.ts', note: 'a', command: null, line: 1 }, { action: 'NEW', path: 'tests/sc1.test.ts', note: 'tests', command: null, line: 2 }, { action: 'MODIFY', path: 'src/b.ts', note: 'b', command: null, line: 3 }, { action: 'MODIFY', path: 'src/c.ts', note: 'c', command: null, line: 4 }],
  verification: { automated: [], none: null, manual: [] }, finalCommands: [], traceability: null, governedText: '# Tasks',
  tasks: [task('T1', ['src/a.ts', 'tests/sc1.test.ts'], ['SC1']), task('T2', ['src/b.ts'], ['SC2']), task('T3', ['src/c.ts'], ['SC3'], ['T1'])],
};
export const run = (concurrency: number, reviewRounds = 0): RunStartedEvent => ({
  type: 'RUN_STARTED', verb: 'implement', argument: 'x.plan.md', level: 'low', levelSource: 'explicit', pins: null, fix: false, orchestrator: 'claude', orchestratorModel: null, repo: {},
  overrides: { sessionDir: 'session', settledPlan: { path: 'x.plan.md', hash: HASH, outcome: 'settled' } },
  config: { 'write-concurrency': concurrency, 'write-subagents': { claude: { low: { model: ['writer-a', 'writer-b'] } } }, 'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } }, phases: { 'plan-review': { rounds: { low: 1 }, targets: { low: 1 } }, 'code-review': { rounds: { low: reviewRounds }, targets: { low: 1 } } } },
});
export const RED_ROW = 'RED-MATRIX SC1 | tests/sc1.test.ts:rejects bad input | exit 1 test:rejects bad input';

// SECTION: Simulated driver — answers every effect, stopping at host awaits

export type Outcome = { exit: number; failedTests?: string[]; loadError?: boolean };
export type Sim = {
  plan?: ParsedPlan;
  reviewRounds?: number;
  envelope?: (id: string) => Record<string, unknown>;
  diff?: (id: string) => string[];
  verify?: (purpose: string, command: string, task: string | null) => Outcome;
  conflict?: string[];
  redDefects?: string[];
};
export type Result = { state: ImplementState; effects: readonly Effect[] };
export type Trace = { effects: Effect[]; events: Event[] };

export const taskOf = (state: ImplementState): string | null => 'task' in state && typeof state.task === 'string' ? state.task : null;
export const pathsOf = (id: string, plan: ParsedPlan = PLAN) => plan.tasks.find((row) => row.id === id)!.paths;
export const defaultEnvelope = (id: string, plan: ParsedPlan = PLAN) => ({ schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: `Delivered ${id}`, evidence: [...plan.tasks.find((row) => row.id === id)!.criteria.map((sc) => `CRITERION ${sc} | ${plan.criteria.find((row) => row.id === sc)!.changes[0]} | behavior`), ...(id === 'T1' ? [RED_ROW] : [])] });
export const defaultVerify = (purpose: string): Outcome => purpose === 'red' ? { exit: 1, failedTests: ['test:rejects bad input'] } : { exit: 0 };

export function answer(state: ImplementState, effect: Effect, sim: Sim): Event | null {
  const id = taskOf(state), plan = sim.plan ?? PLAN;
  switch (effect.kind) {
    case 'snapshot': return { type: 'SNAPSHOT', effectId: effect.id, fingerprint: FP, diff: { paths: [] } };
    case 'parse-artifact': return { type: 'ARTIFACT_PARSED', effectId: effect.id, kind: 'plan', hash: HASH, parsed: sim.plan ?? PLAN, defects: [] };
    case 'write-brief': return { type: 'BRIEF_READY', effectId: effect.id, stage: 'task', path: `run/${id}.brief.md`, sha256: HASH, envelopePath: `run/${id}-${effect.id}.outcome.json` };
    case 'check-envelope': return { type: 'ENVELOPE_CHECKED', effectId: effect.id, envelope: sim.envelope ? sim.envelope(id!) : defaultEnvelope(id!, plan), defects: [], diff: { paths: sim.diff ? sim.diff(id!) : pathsOf(id!, plan) } };
    case 'verify': return {
      type: 'VERIFY_DONE', effectId: effect.id, purpose: effect.purpose, fingerprint: FP,
      results: effect.commands.map((row) => {
        const outcome = sim.verify?.(effect.purpose, String(row['command']), id) ?? defaultVerify(effect.purpose);
        const failed = outcome.failedTests ?? [];
        return { command: String(row['command']), exit: outcome.exit, logPath: `${effect.id}.log`, failedTests: failed, failureId: outcome.exit ? `${row['command']}::${failed[0] ?? 'load'}` : null, diagnostic: '', loadError: outcome.loadError ?? false, inputFingerprint: effect.id };
      }),
    };
    case 'checkout': {
      const input = effect.input;
      const results: Record<string, Record<string, unknown>> = {
        init: { path: 'run/wt/integration', base: 'b0', manifest: { linked: [] } },
        task: { path: `run/wt/${input['name']}`, revision: input['revision'] },
        commit: { revision: `c-${id}`, paths: pathsOf(id ?? 'T1', plan) },
        red: { path: `run/wt/${input['name']}`, defects: sim.redDefects?.includes(id ?? '') ? ['checkpoint names an unapproved path'] : [], files: [] },
        'scope-rebase': { path: `run/wt/${input['name']}`, revision: input['revision'], conflict: false, conflicts: [] },
        integrate: sim.conflict?.includes(id ?? '') ? { conflict: true, paths: ['src/shared.ts'], detail: 'both modified' } : { revision: `i-${id}`, conflict: false, paths: [] },
        reset: { path: `run/wt/${input['name']}` }, deliver: { conflicts: [], transferred: ['src/a.ts'], already: [] }, cleanup: {},
      };
      return { type: 'CHECKOUT_DONE', effectId: effect.id, op: effect.op, result: results[effect.op] ?? {} };
    }
    default: return null;
  }
}

/** Answers driver effects until the machine awaits the host or emits an effect the simulation leaves to the test. */
export function pump(result: Result, sim: Sim, trace: Trace): Result {
  for (let guard = 0; result.effects.length; guard++) {
    assert.ok(guard < 200, 'driver loop did not settle');
    const effect = result.effects[0]!;
    const event = answer(result.state, effect, sim);
    if (!event) return result;
    trace.effects.push(effect);
    trace.events.push(event);
    result = stepImplement(result.state, event);
  }
  return result;
}

export function host(result: Result, event: Event, sim: Sim, trace: Trace): Result {
  assert.equal(validateImplement(result.state, event as never), null);
  trace.events.push(event);
  return pump(stepImplement(result.state, event), sim, trace);
}

export function classify(result: Result, sim: Sim, trace: Trace): Result {
  if (result.state.tag !== 'level-classification') return result;
  const gateScope = implementData(result.state)['gateScope'];
  return host(result, { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'low', rationale: 'Bounded task with local and recoverable effects.', gateScope } }, sim, trace);
}

export function start(concurrency: number, sim: Sim = {}): { result: Result; trace: Trace } {
  const trace: Trace = { effects: [], events: [] };
  let result = pump(stepImplement(initialImplement(), run(concurrency, sim.reviewRounds)), sim, trace);
  assert.equal(result.state.tag, 'approval');
  result = host(result, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } }, sim, trace);
  result = classify(result, sim, trace);
  return { result, trace };
}

export type Slot = { task: string; action: string; handle: string | null; attempt: number; signature: string; model: string; envelopePath: string; worktree: string };
export const slots = (result: Result): Slot[] => result.state.tag === 'tasks' ? (implementData(result.state)['tasks'] as Slot[]) : [];
export const record = (result: Result, id: string) => 'c' in result.state && result.state.c ? result.state.c.tasks[id] : undefined;
export const launch = (result: Result, sim: Sim, trace: Trace): Result => host(result, { type: 'WRITE_LAUNCHED', tasks: slots(result).filter((slot) => slot.action === 'launch').map((slot) => ({ task: slot.task, attempt: slot.attempt, signature: slot.signature, handle: `agent-${slot.task}-${slot.attempt}`, model: slot.model })) }, sim, trace);
export const submit = (result: Result, id: string, sim: Sim, trace: Trace): Result => {
  const slot = slots(result).find((item) => item.task === id)!;
  return host(result, { type: 'WRITE_ENVELOPE', task: id, attempt: slot.attempt, signature: slot.signature, handle: slot.handle!, envelopePath: slot.envelopePath }, sim, trace);
};
export const launchedTasks = (trace: Trace) => trace.effects.flatMap((effect) => effect.kind === 'checkout' && effect.op === 'task' ? [String(effect.input['name'])] : []);

// SECTION: Scheduling
