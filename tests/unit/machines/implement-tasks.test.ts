import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effect, Event, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import type { ScopeAdjustment } from '../../../skills/dispatch/scripts/core/types.ts';
import type { ParsedPlan, PlanCriterion, PlanTask } from '../../../skills/dispatch/scripts/domain/types.ts';
import { parseRedMatrix } from '../../../skills/dispatch/scripts/machines/implement-types.ts';
import { beginRevision, reboundRevision } from '../../../skills/dispatch/scripts/machines/revision.ts';
import { effectivePlan, implementData, initialImplement, stepImplement, validateImplement, type ImplementState } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { reconcileTasks, taskSignature } from '../../../skills/dispatch/scripts/machines/implement-tasks.ts';

// SECTION: Fixture plan — T1 (RED) and T2 are independent; T3 depends on T1.

const HASH = `sha256:${'a'.repeat(64)}`;
const FP = { head: 'h', index: 'i', worktree: 'w' };
const criterion = (id: string, file: string, evidence: 'red' | 'verify', extra: string[] = []): PlanCriterion => ({
  id, title: `${id} works`, line: 1, changes: [file, ...extra], verify: [{ command: `node --test tests/${id.toLowerCase()}.test.ts`, final: false }],
  evidence, preExisting: false, redException: null, testRationale: evidence === 'red' ? 'discriminates' : null, review: null, enforcementInfeasibility: null,
});
const task = (id: string, paths: string[], criteria: string[], prerequisites: string[] = []): PlanTask => ({ id, title: id, summary: `Deliver ${id}`, line: 1, paths, criteria, prerequisites, generated: [] });
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
const RED_ROW = 'RED-MATRIX SC1 | tests/sc1.test.ts:rejects bad input | exit 1 test:rejects bad input';

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

const taskOf = (state: ImplementState): string | null => 'task' in state && typeof state.task === 'string' ? state.task : null;
const pathsOf = (id: string, plan: ParsedPlan = PLAN) => plan.tasks.find((row) => row.id === id)!.paths;
const defaultEnvelope = (id: string, plan: ParsedPlan = PLAN) => ({ schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: `Delivered ${id}`, evidence: [...plan.tasks.find((row) => row.id === id)!.criteria.map((sc) => `CRITERION ${sc} | ${plan.criteria.find((row) => row.id === sc)!.changes[0]} | behavior`), ...(id === 'T1' ? [RED_ROW] : [])] });
const defaultVerify = (purpose: string): Outcome => purpose === 'red' ? { exit: 1, failedTests: ['test:rejects bad input'] } : { exit: 0 };

function answer(state: ImplementState, effect: Effect, sim: Sim): Event | null {
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

function classify(result: Result, sim: Sim, trace: Trace): Result {
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

type Slot = { task: string; action: string; handle: string | null; attempt: number; signature: string; model: string; envelopePath: string; worktree: string };
const slots = (result: Result): Slot[] => result.state.tag === 'tasks' ? (implementData(result.state)['tasks'] as Slot[]) : [];
const record = (result: Result, id: string) => 'c' in result.state && result.state.c ? result.state.c.tasks[id] : undefined;
export const launch = (result: Result, sim: Sim, trace: Trace): Result => host(result, { type: 'WRITE_LAUNCHED', tasks: slots(result).filter((slot) => slot.action === 'launch').map((slot) => ({ task: slot.task, attempt: slot.attempt, signature: slot.signature, handle: `agent-${slot.task}-${slot.attempt}` })) }, sim, trace);
export const submit = (result: Result, id: string, sim: Sim, trace: Trace): Result => {
  const slot = slots(result).find((item) => item.task === id)!;
  return host(result, { type: 'WRITE_ENVELOPE', task: id, attempt: slot.attempt, signature: slot.signature, handle: slot.handle!, envelopePath: slot.envelopePath }, sim, trace);
};
const launchedTasks = (trace: Trace) => trace.effects.flatMap((effect) => effect.kind === 'checkout' && effect.op === 'task' ? [String(effect.input['name'])] : []);

// SECTION: Scheduling

test('prewrite-level: task slots schedule in plan order only after the shared gate', () => {
  const sim: Sim = {};
  let { result, trace } = start(2, sim);
  assert.deepEqual(slots(result).map((slot) => [slot.task, slot.action, slot.model]), [['T1', 'launch', 'writer-a'], ['T2', 'launch', 'writer-a']]);
  assert.deepEqual(slots(result).map((slot) => slot.worktree), ['run/wt/task-t1', 'run/wt/task-t2']);
  result = launch(result, sim, trace);
  assert.deepEqual(slots(result).map((slot) => slot.action), ['running', 'running']);

  result = submit(result, 'T2', sim, trace);
  assert.equal(record(result, 'T2')?.status, 'accepted');
  assert.deepEqual(slots(result).map((slot) => slot.task), ['T1']);

  result = submit(result, 'T1', sim, trace);
  assert.equal(record(result, 'T1')?.integrated, 'i-T1');
  const t3 = trace.effects.findLast((effect) => effect.kind === 'checkout' && effect.op === 'task');
  assert.equal(t3?.kind === 'checkout' && t3.input['revision'], 'i-T1');
  assert.deepEqual(slots(result).map((slot) => [slot.task, slot.action]), [['T3', 'launch']]);

  result = launch(result, sim, trace);
  result = submit(result, 'T3', sim, trace);
  assert.equal(result.state.tag, 'evidence');
  assert.deepEqual(trace.effects.filter((effect) => effect.kind === 'checkout').map((effect) => effect.kind === 'checkout' && effect.op).slice(-2), ['deliver', 'cleanup']);
});

test('tasks: schedule with cap one runs the same pipeline one task at a time', () => {
  const sim: Sim = {};
  let { result, trace } = start(1, sim);
  for (const id of ['T1', 'T2', 'T3']) {
    assert.deepEqual(slots(result).map((slot) => slot.task), [id]);
    result = launch(result, sim, trace);
    result = submit(result, id, sim, trace);
  }
  assert.equal(result.state.tag, 'evidence');
  assert.deepEqual(launchedTasks(trace), ['task-t1', 'task-t2', 'task-t3']);
});

test('level-journal: task admission supplies its mixed production/test paths to a RED_READY scope request', () => {
  const sim: Sim = {
    envelope: (id) => id === 'T1' ? {
      schemaVersion: 1, status: 'SCOPE_REQUEST', stage: 'RED_READY', summary: 'The regression needs one additional fixture.', evidence: [],
      scopeRequest: { requestId: 'red-ready-extra-fixture', source: 'task', task: 'T1', baseArtifactHash: HASH, writerRationale: 'The required regression test needs a fixture outside this task.', delta: { paths: ['tests/extra.fixture.ts'], criteria: [], obligations: [], commands: [], phaseDuties: [], increments: [] } },
    } : defaultEnvelope(id),
  };
  let { result, trace } = start(1, sim);
  result = submit(launch(result, sim, trace), 'T1', sim, trace);
  assert.equal(result.state.tag, 'scope-adjudication');
  const admission = trace.effects.findLast((effect) => effect.kind === 'check-envelope');
  assert.ok(admission?.kind === 'check-envelope');
  if (admission?.kind === 'check-envelope') assert.deepEqual(admission.permitted, ['src/a.ts', 'tests/sc1.test.ts']);
});

test('level-journal: scope-driven fourth launch stays schedulable while repeated failures hit retry bound', () => {
  let scopeRequests = 0;
  const sim: Sim = {
    plan: { ...PLAN, tasks: [PLAN.tasks[0]!] },
    envelope: (id) => {
      if (id !== 'T1') return defaultEnvelope(id);
      if (scopeRequests < 3) {
        const request = ++scopeRequests;
        return {
          schemaVersion: 1, status: 'SCOPE_REQUEST', stage: 'COMPLETE', summary: `Add required helper ${request}.`, evidence: [],
          scopeRequest: { requestId: `scope-${request}`, source: 'task', task: 'T1', baseArtifactHash: HASH, writerRationale: 'The accepted outcome requires another helper.', delta: { paths: [`src/helper-${request}.ts`], criteria: [], obligations: [`Use helper ${request}`], commands: [], phaseDuties: [], increments: [] } },
        };
      }
      return { schemaVersion: 1, status: 'BLOCKED', stage: 'COMPLETE', summary: 'Writer cannot complete.', evidence: [], blockers: ['upstream API remains unavailable'] };
    },
  };
  let { result, trace } = start(1, sim);
  for (let scope = 1; scope <= 3; scope++) {
    result = submit(launch(result, sim, trace), 'T1', sim, trace);
    assert.equal(result.state.tag, 'scope-adjudication');
    if (result.state.tag !== 'scope-adjudication') return;
    result = host(result, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request: result.state.request, ruling: 'approve', rationale: 'The requested helper supports the approved outcome.' } }, sim, trace);
    assert.equal(result.state.tag, 'tasks');
    const next = slots(result).find((slot) => slot.task === 'T1');
    assert.equal(next?.action, 'launch');
    assert.equal(next?.attempt, scope + 1);
    assert.equal(record(result, 'T1')?.failures, 0);
  }
  assert.equal(slots(result).find((slot) => slot.task === 'T1')?.attempt, 4);

  for (let failures = 1; failures <= 3; failures++) {
    result = submit(launch(result, sim, trace), 'T1', sim, trace);
    assert.equal(result.state.tag, 'failure');
    assert.equal(record(result, 'T1')?.failures, failures);
    if (failures < 3) result = host(result, { type: 'DECISION', kind: 'failure', answer: { action: 'retry', rootCause: 'The upstream API is still unavailable.' } }, sim, trace);
  }
  assert.match(validateImplement(result.state, { type: 'DECISION', kind: 'failure', answer: { action: 'retry', rootCause: 'Try again.' } }) ?? '', /failure limit/);
});

test('tasks: schedule verifies GREEN in the task worktree and integration in the integration worktree', () => {
  const sim: Sim = {};
  let { result, trace } = start(1, sim);
  result = submit(launch(result, sim, trace), 'T1', sim, trace);
  const verifies = trace.effects.filter((effect) => effect.kind === 'verify' && effect.purpose !== 'baseline');
  assert.deepEqual(verifies.map((effect) => effect.kind === 'verify' && [effect.purpose, effect.cwd]), [['red', 'run/wt/red-t1'], ['scoped', 'run/wt/task-t1'], ['scoped', 'run/wt/integration']]);
});

// SECTION: Failure isolation

test('tasks: failure of one task blocks only its descendants and asks once', () => {
  const sim: Sim = { envelope: (id) => id === 'T1' ? { schemaVersion: 1, status: 'BLOCKED', stage: 'COMPLETE', summary: 'cannot proceed', evidence: [], blockers: ['missing API'] } : defaultEnvelope(id) };
  let { result, trace } = start(2, sim);
  result = launch(result, sim, trace);
  result = submit(result, 'T1', sim, trace);
  assert.equal(record(result, 'T1')?.status, 'failed');
  assert.equal(result.state.tag, 'tasks');
  result = submit(result, 'T2', sim, trace);
  assert.equal(result.state.tag, 'failure');
  assert.equal(record(result, 'T2')?.status, 'accepted');
  assert.deepEqual(launchedTasks(trace), ['task-t1', 'task-t2']);
  const items = (implementData(result.state)['items'] as { tasks: { task: string; status: string }[] }[])[0]!.tasks;
  assert.deepEqual(items.map((item) => [item.task, item.status]), [['T1', 'failed'], ['T3', 'blocked']]);
  assert.deepEqual(implementData(result.state)['options'], ['retry', 'revise', 'stop']);
});

test('amendment from a BLOCKED writer reaches the failure decision with unresolved targets flagged', () => {
  const amendment = { finding: 'SC1 Verify cannot select the RED test.', evidence: ['pattern selects 0 tests'], proposal: [
    { kind: 'modify', target: 'SC1', proposed: 'select rejects bad input', rationale: 'Matches the leaf test.' },
    { kind: 'remove', target: 'SC9', rationale: 'Duplicate criterion.' },
    { kind: 'modify', target: 'T3', rationale: 'Task depends on the changed SC1.' },
    { kind: 'remove', target: 'npm run lint', rationale: 'Lint is covered by the final gate.' },
    { kind: 'add', target: 'new edge case', rationale: 'Uncovered input.' },
  ] };
  const sim: Sim = { envelope: (id) => id === 'T1' ? { schemaVersion: 1, status: 'BLOCKED', stage: 'COMPLETE', summary: 'plan conflict', evidence: [], blockers: ['SC1 unverifiable'], amendment } : defaultEnvelope(id) };
  sim.plan = { ...PLAN, verification: { ...PLAN.verification, automated: ['npm run lint'] } };
  let { result, trace } = start(1, sim);
  result = submit(launch(result, sim, trace), 'T1', sim, trace);
  result = submit(launch(result, sim, trace), 'T2', sim, trace);
  assert.equal(result.state.tag, 'failure');
  const items = (implementData(result.state)['items'] as { tasks: { task: string; amendment?: unknown }[] }[])[0]!.tasks;
  assert.deepEqual(items.find((item) => item.task === 'T1')?.amendment, { ...amendment, unresolvedTargets: ['SC9'] });
  assert.equal(items.find((item) => item.task === 'T3')?.amendment, undefined);
  result = host(result, { type: 'DECISION', kind: 'failure', answer: { action: 'retry', rootCause: 'pattern clarified' } }, sim, trace);
  assert.equal(record(result, 'T1')?.amendment, null);
});

test('tasks: failure retry re-pends the failed task with its admission defect and stays bounded', () => {
  const sim: Sim = { envelope: (id) => id === 'T1' ? { schemaVersion: 1, status: 'BLOCKED', stage: 'COMPLETE', summary: 'cannot proceed', evidence: [], blockers: ['missing API'] } : defaultEnvelope(id) };
  let { result, trace } = start(1, sim);
  for (let attempt = 1; attempt <= 3; attempt++) {
    result = submit(launch(result, sim, trace), 'T1', sim, trace);
    if (attempt === 1) result = submit(launch(result, sim, trace), 'T2', sim, trace);
    assert.equal(result.state.tag, 'failure');
    assert.equal(record(result, 'T1')?.attempt, attempt);
    if (attempt === 3) break;
    result = host(result, { type: 'DECISION', kind: 'failure', answer: { action: 'retry', rootCause: 'API stub added' } }, sim, trace);
    const brief = trace.effects.findLast((effect) => effect.kind === 'write-brief');
    assert.deepEqual(brief?.kind === 'write-brief' && brief.input['admissionDefects'], ['Writer returned BLOCKED: cannot proceed']);
  }
  assert.match(validateImplement(result.state, { type: 'DECISION', kind: 'failure', answer: { action: 'retry', rootCause: 'again' } }) ?? '', /failure limit/);
});

test('tasks: failure cascade relaunches the next model in a reset worktree without a new attempt', () => {
  const sim: Sim = {};
  let { result, trace } = start(1, sim);
  result = launch(result, sim, trace);
  const t1 = slots(result).find((slot) => slot.task === 'T1')!;
  const receipt = { task: 'T1', attempt: t1.attempt, signature: t1.signature, handle: t1.handle! };
  assert.match(validateImplement(result.state, { type: 'WRITE_FAILED', ...receipt, model: 'writer-b', kind: 'quota', reason: 'x' }) ?? '', /current model/);
  result = host(result, { type: 'WRITE_FAILED', ...receipt, model: 'writer-a', kind: 'quota', reason: 'no capacity' }, sim, trace);
  const reset = trace.effects.at(-1);
  assert.deepEqual(reset?.kind === 'checkout' && [reset.op, reset.input['name'], reset.input['revision']], ['reset', 'task-t1', 'b0']);
  assert.deepEqual(slots(result).map((slot) => [slot.task, slot.action, slot.model, slot.attempt]), [['T1', 'launch', 'writer-b', 2]]);
  result = launch(result, sim, trace);
  const fallback = slots(result).find((slot) => slot.task === 'T1')!;
  result = host(result, { type: 'WRITE_FAILED', task: 'T1', attempt: fallback.attempt, signature: fallback.signature, handle: fallback.handle!, model: 'writer-b', kind: 'quota', reason: 'no capacity' }, sim, trace);
  assert.equal(record(result, 'T1')?.status, 'failed');
  assert.deepEqual(slots(result).map((slot) => slot.task), ['T2']);
});

// SECTION: Admission

const rejections: [string, Sim, RegExp][] = [
  ['scope violation', { diff: (id) => [...pathsOf(id), 'README.md'] }, /outside the task scope/],
  ['scope request after an out-of-envelope edit', {
    envelope: () => ({ schemaVersion: 1, status: 'SCOPE_REQUEST', stage: 'COMPLETE', summary: 'Need an extra module.', evidence: [], scopeRequest: { requestId: 'scope-1', source: 'task', task: 'T1', baseArtifactHash: HASH, writerRationale: 'The accepted behavior requires this module.', delta: { paths: ['src/new.ts'], criteria: [], obligations: [], commands: [], phaseDuties: [], increments: [] } } }),
    diff: (id) => [...pathsOf(id), 'src/new.ts'],
  }, /Scope request rejected after out-of-envelope edits/],
  ['missing RED matrix', { envelope: (id) => ({ ...defaultEnvelope(id), evidence: ['CRITERION SC1 | src/a.ts | behavior'] }) }, /RED matrix rejected/],
  ['unapproved checkpoint', { redDefects: ['T1'] }, /RED checkpoint rejected/],
  ['setup-only RED', { verify: (purpose) => purpose === 'red' ? { exit: 1, loadError: true } : { exit: 0 } }, /load, syntax, or missing-file/],
  ['fabricated RED', { verify: () => ({ exit: 0 }) }, /expected failures were not observed/],
  ['failing GREEN', { verify: (purpose, _command, _task) => purpose === 'red' ? defaultVerify('red') : purpose === 'scoped' ? { exit: 1, failedTests: ['test:x'] } : { exit: 0 } }, /Task verification failed/],
  ['integration conflict', { conflict: ['T1'] }, /Integration conflict on src\/shared.ts/],
];
for (const [name, sim, reason] of rejections) test(`tasks: admission rejects ${name} and keeps dependents blocked`, () => {
  let { result, trace } = start(1, sim);
  result = submit(launch(result, sim, trace), 'T1', sim, trace);
  assert.equal(record(result, 'T1')?.status, 'failed');
  assert.match(record(result, 'T1')?.reason ?? '', reason);
  assert.equal(record(result, 'T1')?.integrated ?? null, null);
  result = submit(launch(result, sim, trace), 'T2', sim, trace);
  assert.equal(result.state.tag, 'failure');
  assert.equal(launchedTasks(trace).includes('task-t3'), false);
});

test('tasks: admission resets the integration worktree when integration verification fails', () => {
  let scoped = 0;
  const sim: Sim = { verify: (purpose) => purpose === 'red' ? defaultVerify('red') : purpose === 'scoped' && ++scoped === 2 ? { exit: 1, failedTests: ['test:x'] } : { exit: 0 } };
  let { result, trace } = start(1, sim);
  result = launch(result, sim, trace);
  result = submit(result, 'T1', sim, trace);
  const reset = trace.effects.find((effect) => effect.kind === 'checkout' && effect.op === 'reset');
  assert.deepEqual(reset?.kind === 'checkout' && [reset.input['name'], reset.input['revision']], ['integration', 'b0']);
  assert.equal(record(result, 'T1')?.status, 'failed');
  assert.match(record(result, 'T1')?.reason ?? '', /Integration verification failed/);
});

test('tasks: admission records writer concerns per task for a quoted ruling after delivery', () => {
  const sim: Sim = { envelope: (id) => id === 'T2' ? { ...defaultEnvelope(id), status: 'DONE_WITH_CONCERNS', concerns: ['API remains synchronous.'] } : defaultEnvelope(id) };
  let { result, trace } = start(2, sim);
  result = launch(result, sim, trace);
  result = submit(result, 'T2', sim, trace);
  result = submit(result, 'T1', sim, trace);
  result = submit(launch(result, sim, trace), 'T3', sim, trace);
  assert.equal(result.state.tag, 'concerns');
  if (result.state.tag === 'concerns') assert.deepEqual(result.state.items, ['T2: API remains synchronous.']);
});

// SECTION: Replay

test('tasks: replay folds the recorded events to identical frames without relaunch or double integration', () => {
  const sim: Sim = {};
  let { result, trace } = start(2, sim);
  result = launch(result, sim, trace);
  result = submit(result, 'T2', sim, trace);
  const fold = () => {
    let state = initialImplement();
    const effects: Effect[] = [];
    for (const event of [run(2), ...trace.events]) { const next = stepImplement(state, event); state = next.state; effects.push(...next.effects); }
    return { state, effects };
  };
  const first = fold(), second = fold();
  assert.deepEqual(second.state, first.state);
  assert.deepEqual(first.state, result.state);
  assert.deepEqual(slots(first).map((slot) => [slot.task, slot.action]), [['T1', 'running']]);
  assert.equal(first.effects.filter((effect) => effect.kind === 'checkout' && effect.op === 'integrate').length, 1);
  const active = slots(first).find((slot) => slot.task === 'T1')!;
  assert.match(validateImplement(first.state, { type: 'WRITE_LAUNCHED', tasks: [{ task: 'T1', attempt: active.attempt, signature: active.signature, handle: 'again' }] }) ?? '', /launch slot/);
  assert.match(validateImplement(first.state, { type: 'WRITE_ENVELOPE', task: 'T2', attempt: 1, signature: 'stale', handle: 'stale', envelopePath: 'run/T2.outcome.json' }) ?? '', /active task/);
});

test('level-journal: task drain retains handle, worktree and signature through replay', () => {
  const sim: Sim = { envelope: (id) => id === 'T1' ? {
    schemaVersion: 1, status: 'SCOPE_REQUEST', stage: 'COMPLETE', summary: 'Request an extra path before editing it.', evidence: [],
    scopeRequest: { requestId: 'scope-replay', source: 'task', task: 'T1', baseArtifactHash: HASH, writerRationale: 'The required behavior uses a companion module.', delta: { paths: ['src/extra.ts'], criteria: [], obligations: [], commands: [], phaseDuties: [], increments: [] } },
  } : defaultEnvelope(id), verify: defaultVerify };
  let { result, trace } = start(2, sim);
  result = launch(result, sim, trace);
  const original = record(result, 'T2');
  result = submit(result, 'T1', sim, trace);
  assert.equal(result.state.tag, 'scope-adjudication');
  if (result.state.tag !== 'scope-adjudication') return;
  result = host(result, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request: result.state.request, ruling: 'approve', rationale: 'The additional path is required by the accepted outcome.' } }, sim, trace);
  assert.equal(result.state.tag, 'scope-draining');
  if (result.state.tag !== 'scope-draining' || !('c' in result.state) || !result.state.c) throw new Error('scope drain should retain the implementation context');
  const drained = result.state.c.tasks['T2'];
  assert.deepEqual([drained?.handle, drained?.worktree, drained?.signature], [original?.handle, original?.worktree, original?.signature]);
  let replay = initialImplement();
  for (const event of [run(2), ...trace.events]) replay = stepImplement(replay, event).state;
  assert.deepEqual(replay, result.state);
});

test('level-journal: task reconciliation retains the parked draft under its updated signature', () => {
  const { result } = start(1);
  if (result.state.tag !== 'tasks') throw new Error('tasks');
  const adjustment: ScopeAdjustment = {
    proposal: { requestId: 'scope-task-signature', source: 'task', task: 'T1', baseArtifactHash: HASH, writerRationale: 'The required behavior uses a companion module.', delta: { paths: ['src/extra.ts'], criteria: [], obligations: [], commands: [], phaseDuties: [], increments: [] } },
    approvedBy: 'orchestrator', rationale: 'The extra path is required.',
  };
  const plan = effectivePlan({ ...result.state.c, scopeAdjustments: [adjustment] });
  const revisedTask = plan.tasks.find((task) => task.id === 'T1')!;
  const prior = result.state.c.tasks['T1']!;
  const signature = taskSignature(plan, revisedTask);
  assert.notEqual(signature, prior.signature);
  const draft = { ...prior, status: 'pending' as const, signature, attempt: 2, worktree: 'run/wt/task-t1', input: 'integration-head', preserveDraft: true, handle: null, baseline: null };
  const reconciled = reconcileTasks({ ...result.state.c.tasks, T1: draft }, plan)['T1']!;
  assert.deepEqual([reconciled.signature, reconciled.worktree, reconciled.input, reconciled.preserveDraft, reconciled.attempt], [signature, draft.worktree, draft.input, true, 2]);
});

// SECTION: RED evidence

const withRed = (patch: Partial<PlanCriterion>): ParsedPlan => ({ ...PLAN, criteria: PLAN.criteria.map((row) => row.id === 'SC1' ? { ...row, ...patch } : row) });
const redCommand = (trace: Trace) => trace.effects.flatMap((effect) => effect.kind === 'verify' && effect.purpose === 'red' ? effect.commands.map((row) => String(row['command'])) : []);

test('tasks: admission RED matrix requires one asserted failure row per active criterion on a declared test path', () => {
  const criteria = [PLAN.criteria[0]!];
  assert.deepEqual(parseRedMatrix([RED_ROW], criteria).defects, []);
  assert.ok(parseRedMatrix(['RED-MATRIX SC1 | src/a.ts:rejects bad input | exit 1 test:rejects bad input'], criteria).defects.some((defect) => /approved test file/.test(defect)));
  assert.ok(parseRedMatrix([], criteria).defects.some((defect) => /Exactly one/.test(defect)));
  assert.ok(parseRedMatrix([RED_ROW, RED_ROW.replace('rejects bad input', 'other')], criteria).defects.some((defect) => /Exactly one/.test(defect)));
});

test('tasks: admission narrows RED to the matrix test file while keeping runner options', () => {
  const command = 'node --test --test-name-pattern="rejects bad input" --import=./hook.ts tests/all.test.ts';
  const sim: Sim = { plan: withRed({ verify: [{ command, final: false }] }) };
  let { result, trace } = start(1, sim);
  result = submit(launch(result, sim, trace), 'T1', sim, trace);
  const [narrowed] = redCommand(trace);
  assert.match(narrowed ?? '', /--test-name-pattern="rejects bad input" --import=\.\/hook.ts "tests\/sc1.test.ts"$/);
  assert.doesNotMatch(narrowed ?? '', /tests\/all.test.ts/);
});

test('tasks: admission fails a task whose RED command cannot be narrowed', () => {
  const sim: Sim = { plan: withRed({ verify: [{ command: 'npm run check', final: false }] }) };
  let { result, trace } = start(1, sim);
  result = submit(launch(result, sim, trace), 'T1', sim, trace);
  assert.match(record(result, 'T1')?.reason ?? '', /cannot be narrowed safely/);
});

test('tasks: admission collides RED with a baseline failure unless Pre-existing is yes', () => {
  for (const preExisting of [false, true]) {
    const failing = (purpose: string): Outcome => purpose === 'baseline' || purpose === 'red' ? { exit: 1, failedTests: ['test:rejects bad input'] } : { exit: 0 };
    const sim: Sim = { plan: withRed({ preExisting }), verify: failing };
    const trace: Trace = { effects: [], events: [] };
    let result = pump(stepImplement(initialImplement(), run(1)), sim, trace);
    assert.equal(result.state.tag, 'baseline-decision');
    const ids = (implementData(result.state)['items'] as { failureId: string }[]).map((row) => row.failureId);
    result = host(result, { type: 'DECISION', kind: 'baseline', answer: { action: 'accept-known-red', ids } }, sim, trace);
    result = host(result, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } }, sim, trace);
    result = classify(result, sim, trace);
    result = submit(launch(result, sim, trace), 'T1', sim, trace);
    if (preExisting) assert.equal(record(result, 'T1')?.status, 'accepted');
    else assert.match(record(result, 'T1')?.reason ?? '', /collides with a pre-existing baseline failure/);
  }
});

test('tasks: admission skips RED replay after an attributed RED exception ruling', () => {
  const sim: Sim = { plan: withRed({ redException: 'External invariant prevents a failing state.' }), envelope: (id) => ({ ...defaultEnvelope(id), evidence: defaultEnvelope(id).evidence.filter((row) => !row.startsWith('RED-MATRIX')) }) };
  const trace: Trace = { effects: [], events: [] };
  let result = pump(stepImplement(initialImplement(), run(1)), sim, trace);
  result = host(result, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } }, sim, trace);
  assert.equal(result.state.tag, 'needs-user');
  assert.ok(validateImplement(result.state, { type: 'DECISION', kind: 'needs-user', answer: { decision: 'accept', by: 'user' } }));
  result = host(result, { type: 'DECISION', kind: 'needs-user', answer: { decision: 'accept', by: 'user', quote: 'Accept the invariant' } }, sim, trace);
  result = classify(result, sim, trace);
  result = submit(launch(result, sim, trace), 'T1', sim, trace);
  assert.equal(record(result, 'T1')?.status, 'accepted');
  assert.deepEqual(redCommand(trace), []);
});

// SECTION: Revision

test('tasks: revision of an accepted criterion definition rewinds integration and reruns the invalidated tasks', () => {
  const sim: Sim = { envelope: (id) => id === 'T2' ? { schemaVersion: 1, status: 'BLOCKED', stage: 'COMPLETE', summary: 'cannot proceed', evidence: [], blockers: ['missing API'] } : defaultEnvelope(id) };
  let { result, trace } = start(2, sim);
  result = launch(result, sim, trace);
  result = submit(result, 'T1', sim, trace);
  result = submit(launch(result, sim, trace), 'T3', sim, trace);
  result = submit(result, 'T2', sim, trace);
  assert.equal(result.state.tag, 'failure');
  assert.deepEqual(['T1', 'T2', 'T3'].map((id) => record(result, id)?.status), ['accepted', 'failed', 'accepted']);
  const revised: ParsedPlan = { ...PLAN, criteria: PLAN.criteria.map((row) => row.id === 'SC1' ? { ...row, verify: [{ command: 'node --test tests/sc1-strict.test.ts', final: false }] } : row) };
  const r = beginRevision(result.state as Extract<ImplementState, { tag: 'failure' }>, { type: 'REVISE', artifact: 'plan', reason: 'blocked-by-plan', evidence: 'SC1 too weak' }).state.r;
  const c = reboundRevision({ tag: 'resume', r: { ...r, plan: revised, hash: `sha256:${'b'.repeat(64)}`, changed: ['SC1'], removed: [], grew: false } });
  const before = trace.effects.length;
  result = host({ state: { ...result.state, c } as ImplementState, effects: [] }, { type: 'DECISION', kind: 'failure', answer: { action: 'retry', rootCause: 'SC1 revised' } }, { ...sim, plan: revised }, trace);
  const rewind = trace.effects.slice(before).find((effect) => effect.kind === 'checkout' && effect.op === 'reset');
  assert.deepEqual(rewind?.kind === 'checkout' && rewind.input, { name: 'integration', revision: 'b0' });
  assert.deepEqual(['T1', 'T2', 'T3'].map((id) => record(result, id)?.status), ['running', 'running', 'pending']);
});
