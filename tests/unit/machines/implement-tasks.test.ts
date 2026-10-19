import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import type { Effect, Event, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import type { ParsedPlan, PlanCriterion, PlanTask } from '../../../skills/dispatch/scripts/domain/types.ts';
import { parseRedMatrix } from '../../../skills/dispatch/scripts/machines/implement-types.ts';
import { implementData, initialImplement, stepImplement, validateImplement, type ImplementState } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { reconcileTasks, taskScope, taskSignature } from '../../../skills/dispatch/scripts/machines/implement-tasks.ts';
import * as implement from '../../../skills/dispatch/scripts/machines/implement.ts';
import { rootMachine, type RootState } from '../../../skills/dispatch/scripts/machines/root.ts';
import { runOwnedPaths } from '../../../skills/dispatch/scripts/effects/snapshot.ts';
import { HASH, FP, criterion, task, PLAN, run, RED_ROW, taskOf, pathsOf, defaultEnvelope, defaultVerify, answer, pump, host, classify, start, slots, frameRows, record, launch, submit, launchedTasks, type Outcome, type Sim, type Result, type Trace, type Slot } from './fixtures/implement-tasks.ts';
import { AMEND_PLAN } from './fixtures/implement-amend.ts';
import { started } from './fixtures/design-delivery.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { memoryRunFs } from '../../helpers/memory-run-fs.ts';
import { launchOf, type Launch } from '../../helpers/launch.ts';
import { FP as RECOVERY_FP, failure, host as recoveryHost } from './fixtures/implement-recovery.ts';

test('governing spec reaches standalone task briefs through scheduling', () => {
  const sim: Sim = {};
  let { result, trace } = start(2, sim);
  const governingSpec = { path: 'intent.spec.md', hash: HASH };
  assert.ok('c' in result.state && result.state.c);
  if (!('c' in result.state) || !result.state.c) return;
  result = { ...result, state: { ...result.state, c: { ...result.state.c, governingSpec } } as ImplementState };
  assert.deepEqual(slots(result).map((slot) => [slot.task, slot.action, slot.model]), [['T1', 'launch', 'writer-a'], ['T2', 'launch', 'writer-a']]);
  assert.deepEqual(slots(result).map((slot) => slot.worktree), ['run/wt/task-t1', 'run/wt/task-t2']);
  result = launch(result, sim, trace);
  assert.deepEqual(slots(result).map((slot) => slot.action), ['running', 'running']);

  result = submit(result, 'T2', sim, trace);
  assert.equal(record(result, 'T2')?.status, 'accepted');
  assert.deepEqual(slots(result).map((slot) => slot.task), ['T1']);

  result = submit(result, 'T1', sim, trace);
  const briefs = trace.effects.filter((effect) => effect.kind === 'write-brief' && effect.input['governingSpec']);
  assert.ok(briefs.length > 0);
  for (const brief of briefs) if (brief.kind === 'write-brief') assert.deepEqual(brief.input['governingSpec'], governingSpec);
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

test('level-journal: task admission supplies its mixed production/test paths to the envelope check', () => {
  const sim: Sim = {};
  let { result, trace } = start(1, sim);
  result = submit(launch(result, sim, trace), 'T1', sim, trace);
  const admission = trace.effects.findLast((effect) => effect.kind === 'check-envelope');
  assert.ok(admission?.kind === 'check-envelope');
  if (admission?.kind === 'check-envelope') assert.deepEqual(admission.permitted, ['src/a.ts', 'tests/validation.test.ts']);
});

test('level-journal: repeated failures hit retry bound', () => {
  const sim: Sim = {
    plan: { ...PLAN, tasks: [PLAN.tasks[0]!] },
    envelope: (id) => id !== 'T1' ? defaultEnvelope(id) : { schemaVersion: 1, status: 'BLOCKED', stage: 'COMPLETE', summary: 'Writer cannot complete.', evidence: [], blockers: ['upstream API remains unavailable'] },
  };
  let { result, trace } = start(1, sim);
  for (let failures = 1; failures <= 3; failures++) {
    result = submit(launch(result, sim, trace), 'T1', sim, trace);
    assert.equal(result.state.tag, 'failure');
    assert.equal(record(result, 'T1')?.failures, failures);
    if (failures < 3) result = host(result, { type: 'DECISION', kind: 'failure', answer: { by: 'orchestrator', action: 'retry', rationale: 'The upstream API is still unavailable.' } }, sim, trace);
  }
  assert.match(validateImplement(result.state, { type: 'DECISION', kind: 'failure', answer: { by: 'orchestrator', action: 'retry', rationale: 'Try again.' } }) ?? '', /failure limit/);
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
  assert.deepEqual(implementData(result.state)['options'], ['retry', 'stop']);
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
  result = host(result, { type: 'DECISION', kind: 'failure', answer: { by: 'orchestrator', action: 'retry', rationale: 'pattern clarified' } }, sim, trace);
  assert.equal(record(result, 'T1')?.amendment, null);
});

test('governing spec remains bound when failure retry regenerates a task brief', () => {
  const sim: Sim = { envelope: (id) => id === 'T1' ? { schemaVersion: 1, status: 'BLOCKED', stage: 'COMPLETE', summary: 'cannot proceed', evidence: [], blockers: ['missing API'] } : defaultEnvelope(id) };
  let { result, trace } = start(1, sim);
  const governingSpec = { path: 'intent.spec.md', hash: HASH };
  assert.ok('c' in result.state && result.state.c);
  if (!('c' in result.state) || !result.state.c) return;
  result = { ...result, state: { ...result.state, c: { ...result.state.c, governingSpec } } as ImplementState };
  for (let attempt = 1; attempt <= 3; attempt++) {
    result = submit(launch(result, sim, trace), 'T1', sim, trace);
    if (attempt === 1) result = submit(launch(result, sim, trace), 'T2', sim, trace);
    assert.equal(result.state.tag, 'failure');
    assert.equal(record(result, 'T1')?.attempt, attempt);
    if (attempt === 3) break;
    result = host(result, { type: 'DECISION', kind: 'failure', answer: { by: 'orchestrator', action: 'retry', rationale: 'API stub added' } }, sim, trace);
    const brief = trace.effects.findLast((effect) => effect.kind === 'write-brief');
    assert.deepEqual(brief?.kind === 'write-brief' && brief.input['admissionDefects'], ['Writer returned BLOCKED: cannot proceed']);
    assert.deepEqual(brief?.kind === 'write-brief' && brief.input['governingSpec'], governingSpec);
  }
  assert.match(validateImplement(result.state, { type: 'DECISION', kind: 'failure', answer: { by: 'orchestrator', action: 'retry', rationale: 'again' } }) ?? '', /failure limit/);
});

test('tasks: failure retry keeps the prior draft and rewinds a rejected candidate without discarding files', () => {
  const sim: Sim = { envelope: (id) => id === 'T1' ? { schemaVersion: 1, status: 'BLOCKED', stage: 'COMPLETE', summary: 'cannot proceed', evidence: [], blockers: ['missing API'] } : defaultEnvelope(id) };
  let { result, trace } = start(1, sim);
  result = submit(launch(result, sim, trace), 'T1', sim, trace);
  result = submit(launch(result, sim, trace), 'T2', sim, trace);
  assert.equal(result.state.tag, 'failure');
  const failed = record(result, 'T1')!;
  const c = (result.state as Extract<ImplementState, { tag: 'failure' }>).c;
  const withCandidate = { ...c, integration: { ...c.integration!, head: failed.input! }, tasks: { ...c.tasks, T1: { ...failed, candidate: 'rejected-candidate' } } };
  const before = trace.effects.length;
  result = host({ state: { ...result.state, c: withCandidate } as ImplementState, effects: [] }, { type: 'DECISION', kind: 'failure', answer: { by: 'orchestrator', action: 'retry', rationale: 'RED row fixed' } }, sim, trace);
  const checkouts = trace.effects.slice(before).filter((effect) => effect.kind === 'checkout' && effect.op === 'task');
  assert.deepEqual(checkouts.map((effect) => { const input = effect.kind === 'checkout' ? effect.input as Readonly<Record<string, unknown>> : {}; return [input['revision'], input['keep'], input['reset']]; }), [[failed.input, true, undefined]]);
});

test('tasks: writer failure resets the worktree and advances the model and attempt', () => {
  const sim: Sim = {};
  let { result, trace } = start(1, sim);
  result = launch(result, sim, trace);
  const t1 = slots(result).find((slot) => slot.task === 'T1')!;
  const receipt = { task: 'T1', attempt: t1.attempt, signature: t1.signature, handle: t1.handle! };
  assert.match(validateImplement(result.state, { type: 'WRITE_RECEIPT', status: 'failed', ...receipt, model: 'writer-b', detail: 'quota: x' }) ?? '', /active writer model/);
  result = host(result, { type: 'WRITE_RECEIPT', status: 'failed', ...receipt, model: 'writer-a', detail: 'quota: no capacity' }, sim, trace);
  const reset = trace.effects.at(-1);
  assert.deepEqual(reset?.kind === 'checkout' && [reset.op, reset.input['name'], reset.input['revision']], ['reset', 'task-t1', 'b0']);
  assert.deepEqual(slots(result).map((slot) => [slot.task, slot.action, slot.model, slot.attempt]), [['T1', 'launch', 'writer-b', 2]]);
  result = launch(result, sim, trace);
  const fallback = slots(result).find((slot) => slot.task === 'T1')!;
  result = host(result, { type: 'WRITE_RECEIPT', status: 'failed', task: 'T1', attempt: fallback.attempt, signature: fallback.signature, handle: fallback.handle!, model: 'writer-b', detail: 'quota: no capacity' }, sim, trace);
  assert.equal(record(result, 'T1')?.status, 'failed');
  assert.deepEqual(slots(result).map((slot) => slot.task), ['T2']);
});

// SECTION: Admission

const rejections: [string, Sim, RegExp][] = [
  ['missing RED matrix', { envelope: (id) => ({ ...defaultEnvelope(id), evidence: ['CRITERION SC1 | src/a.ts | behavior'] }) }, /RED matrix rejected/],
  ['unapproved checkpoint', { redDefects: ['T1'] }, /RED checkpoint rejected/],
  ['RED without the expected names', { verify: (purpose) => purpose === 'red' ? { exit: 1 } : { exit: 0 } }, /expected failures were not observed/],
  ['fabricated RED', { verify: () => ({ exit: 0 }) }, /expected failures were not observed/],
  ['failing GREEN', { verify: (purpose, _command, _task) => purpose === 'red' ? defaultVerify('red') : purpose === 'scoped' ? { exit: 1, failedTests: ['test:x'] } : { exit: 0 } }, /Task verification failed/],
];
test('tasks: admission rejects defective candidate submissions and keeps dependents blocked', () => {
  for (const [name, sim, reason] of rejections) {
    let { result, trace } = start(1, sim);
    result = submit(launch(result, sim, trace), 'T1', sim, trace);
    assert.equal(record(result, 'T1')?.status, 'failed', name);
    assert.match(record(result, 'T1')?.reason ?? '', reason, name);
    assert.equal(record(result, 'T1')?.integrated ?? null, null, name);
    result = submit(launch(result, sim, trace), 'T2', sim, trace);
    assert.equal(result.state.tag, 'failure', name);
    assert.equal(launchedTasks(trace).includes('task-t3'), false, name);
  }
});

// SECTION: Orchestrator scope admission

const extraPaths: Sim = { diff: (id) => id === 'T1' ? [...pathsOf(id), 'README.md'] : [...pathsOf(id)], commitPaths: (id) => id === 'T1' ? [...pathsOf(id), 'README.md'] : [...pathsOf(id)] };
const scopeAnswer = (action: string) => ({ type: 'DECISION', kind: 'request', answer: { by: 'orchestrator', action, rationale: 'Generated doc output.' } }) as never;

test('tasks: writer paths outside the task scope request an orchestrator decision', () => {
  let { result, trace } = start(1, extraPaths);
  result = submit(launch(result, extraPaths, trace), 'T1', extraPaths, trace);
  assert.equal(result.state.tag, 'request-decision');
  const request = result.state.tag === 'request-decision' ? result.state.request : null;
  assert.deepEqual([request?.source, request?.paths, request?.task], ['scope', ['README.md'], 'T1']);
  assert.match(request?.need ?? '', /README\.md/);
  assert.equal(record(result, 'T1')?.status, 'submitted');
});

test('tasks: a scope request frame directs approval without AMEND', () => {
  let { result, trace } = start(1, extraPaths);
  result = submit(launch(result, extraPaths, trace), 'T1', extraPaths, trace);
  const instruction = JSON.stringify(implementData(result.state));
  assert.match(instruction, /README\.md/);
  assert.match(instruction, /no AMEND/);
  assert.doesNotMatch(instruction, /send AMEND to widen it/);
});

test('tasks: orchestrator approval admits outside paths through commit and candidate admission', () => {
  let { result, trace } = start(1, extraPaths);
  result = submit(launch(result, extraPaths, trace), 'T1', extraPaths, trace);
  assert.equal(validateImplement(result.state, scopeAnswer('approve')), null);
  result = host(result, scopeAnswer('approve'), extraPaths, trace);
  assert.deepEqual(record(result, 'T1')?.admittedPaths, ['README.md']);
  const recheck = trace.effects.findLast((effect) => effect.kind === 'check-envelope');
  assert.ok(recheck?.kind === 'check-envelope' && recheck.permitted.includes('README.md'));
  assert.ok(trace.effects.some((effect) => effect.kind === 'checkout' && effect.op === 'commit'));
  assert.equal(record(result, 'T1')?.status, 'accepted');
});

test('tasks: orchestrator decline fails the task naming the outside paths', () => {
  let { result, trace } = start(1, extraPaths);
  result = submit(launch(result, extraPaths, trace), 'T1', extraPaths, trace);
  result = host(result, scopeAnswer('decline'), extraPaths, trace);
  assert.equal(record(result, 'T1')?.status, 'failed');
  assert.match(record(result, 'T1')?.reason ?? '', /declined: README\.md/);
});

test('tasks: user acceptance after escalation admits outside paths', () => {
  let { result, trace } = start(1, extraPaths);
  result = submit(launch(result, extraPaths, trace), 'T1', extraPaths, trace);
  result = host(result, scopeAnswer('escalate'), extraPaths, trace);
  const requestId = result.state.tag === 'request-decision' ? result.state.request.requestId : '';
  const accept = { type: 'DECISION', kind: 'request-user', answer: { by: 'user', requestId, choice: 'accept', quote: 'Keep the README change.' } } as never;
  assert.equal(validateImplement(result.state, accept), null);
  result = host(result, accept, extraPaths, trace);
  assert.deepEqual(record(result, 'T1')?.admittedPaths, ['README.md']);
  assert.equal(record(result, 'T1')?.status, 'accepted');
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
  assert.match(validateImplement(first.state, { type: 'WRITE_RECEIPT', status: 'launched', task: 'T1', attempt: active.attempt, signature: active.signature, handle: 'again', model: active.model }) ?? '', /already launched/);
  assert.match(validateImplement(first.state, { type: 'WRITE_RECEIPT', status: 'submitted', task: 'T2', attempt: 1, signature: 'stale', handle: 'stale', envelopePath: 'run/T2.outcome.json', briefHash: 'stale', model: 'writer-a' }) ?? '', /running task/);
});

test('level-journal: task reconciliation retains the parked draft under its updated signature', () => {
  const { result } = start(1);
  if (result.state.tag !== 'tasks') throw new Error('tasks');
  const current = result.state.c.plan!;
  const plan = { ...current, tasks: current.tasks.map((task) => task.id === 'T1' ? { ...task, paths: [...task.paths, 'src/extra.ts'] } : task) };
  const revisedTask = plan.tasks.find((task) => task.id === 'T1')!;
  const prior = result.state.c.tasks['T1']!;
  const signature = taskSignature(plan, revisedTask);
  assert.notEqual(signature, prior.signature);
  const draft = { ...prior, status: 'pending' as const, signature, attempt: 2, worktree: 'run/wt/task-t1', input: 'integration-head', preserveDraft: true, handle: null, baseline: null };
  const reconciled = reconcileTasks({ ...result.state.c.tasks, T1: draft }, plan)['T1']!;
  assert.deepEqual([reconciled.signature, reconciled.worktree, reconciled.input, reconciled.preserveDraft, reconciled.attempt], [signature, draft.worktree, draft.input, true, 2]);
});

test('task-signature: constraints default empty and a constraint-only change reopens the task', () => {
  const current = PLAN.tasks[0]!;
  const { constraints: _constraints, ...withoutConstraints } = current;
  const emptyConstraints = { ...current, constraints: [] };
  assert.equal(taskSignature(PLAN, withoutConstraints), taskSignature(PLAN, emptyConstraints));

  const revisedTask = { ...current, constraints: ['Preserve the public API.'] };
  assert.notEqual(taskSignature(PLAN, current), taskSignature(PLAN, revisedTask));
  assert.equal(taskScope(PLAN, current), taskScope(PLAN, revisedTask), 'constraints do not alter the writer scope');

  const { result } = start(1);
  if (result.state.tag !== 'tasks') throw new Error('tasks');
  const accepted = { ...result.state.c.tasks[current.id]!, status: 'accepted' as const };
  const revisedPlan = { ...PLAN, tasks: PLAN.tasks.map((task) => task.id === current.id ? revisedTask : task) };
  const reconciled = reconcileTasks({ ...result.state.c.tasks, [current.id]: accepted }, revisedPlan)[current.id]!;
  assert.equal(reconciled.status, 'pending');
  assert.equal(reconciled.signature, taskSignature(revisedPlan, revisedTask));
});

// SECTION: RED evidence

const withRed = (patch: Partial<PlanCriterion>): ParsedPlan => ({ ...PLAN, criteria: PLAN.criteria.map((row) => row.id === 'SC1' ? { ...row, ...patch } : row) });
const redCommand = (trace: Trace) => trace.effects.flatMap((effect) => effect.kind === 'verify' && effect.purpose === 'red' ? effect.commands.map((row) => String(row['command'])) : []);

test('tasks: admission RED matrix requires one asserted failure row per active criterion on a declared test path', () => {
  const criteria = [PLAN.criteria[0]!];
  assert.deepEqual(parseRedMatrix([RED_ROW], criteria, PLAN.planIds).defects, []);
  assert.ok(parseRedMatrix(['RED-MATRIX SC1 | src/a.ts:rejects bad input | exit 1 test:rejects bad input'], criteria, PLAN.planIds).defects.some((defect) => /declared Tests paths/.test(defect)));
  assert.ok(parseRedMatrix([RED_ROW.replace('test:rejects bad input', 'error:ENOENT')], criteria, PLAN.planIds).defects.some((defect) => /error: entries cannot be observed/.test(defect)));
  assert.ok(parseRedMatrix([], criteria, PLAN.planIds).defects.some((defect) => /Exactly one/.test(defect)));
  assert.ok(parseRedMatrix([RED_ROW, RED_ROW.replace('rejects bad input', 'other')], criteria, PLAN.planIds).defects.some((defect) => /Exactly one/.test(defect)));
});

test('tasks: RED matrix names control-character corruption from JSON-escaped backslashes', () => {
  const criteria = [PLAN.criteria[0]!];
  assert.ok(parseRedMatrix([RED_ROW.replace('tests/validation', 'tests\tvalidation')], criteria, PLAN.planIds).defects.some((defect) => /control character/.test(defect)));
});

const planIdDefects = (row: string, planIds: readonly string[] = PLAN.planIds) => parseRedMatrix([row], [PLAN.criteria[0]!], planIds).defects.filter((defect) => /names plan ID/.test(defect));

test('RED-MATRIX names stay plan-free: rejects plan and finding IDs while exempting leading column and undefined look-alikes', () => {
  assert.deepEqual(planIdDefects(RED_ROW.replace(':rejects bad input', ':sc1 rejects bad input')), ['RED-MATRIX SC1 test name sc1 rejects bad input names plan ID SC1; name the behavior instead.']);
  assert.equal(planIdDefects(RED_ROW.replace('test:rejects bad input', 'test:rejects bad input; test:SC3 guards input')).length, 1, 'another task criterion ID');
  assert.deepEqual(planIdDefects(RED_ROW), []);
  const ids = [...PLAN.planIds, 'R1-F001'];
  assert.equal(planIdDefects(RED_ROW.replace('test:rejects bad input', 'test:R1-F001 rejects bad input'), ids).length, 1);
  assert.deepEqual(planIdDefects(RED_ROW.replace('test:rejects bad input', 'test:SC10 and ESC1 reject bad input'), ids), []);
});

const redEffects = (trace: Trace) => trace.effects.flatMap((effect) => effect.kind === 'verify' && effect.purpose === 'red' ? effect.commands : []);

test('tasks: declared RED command expands {files} for a non-node runner and passes on expected names in the log', () => {
  const sim: Sim = { plan: withRed({ red: 'npx jest --ci {files}' }) };
  let { result, trace } = start(1, sim);
  result = submit(launch(result, sim, trace), 'T1', sim, trace);
  assert.deepEqual(redCommand(trace), ['npx jest --ci "tests/validation.test.ts"']);
  assert.deepEqual(redEffects(trace).map((row) => [row.expectedTests, row.scanLogs]), [[['rejects bad input'], []]]);
  assert.equal(record(result, 'T1')?.status, 'accepted');
});

test('tasks: declared RED command without {files} runs unchanged', () => {
  const sim: Sim = { plan: withRed({ red: 'npx nx test web --testFile=validation' }) };
  let { result, trace } = start(1, sim);
  result = submit(launch(result, sim, trace), 'T1', sim, trace);
  assert.deepEqual(redCommand(trace), ['npx nx test web --testFile=validation']);
  assert.equal(record(result, 'T1')?.status, 'accepted');
});

test('tasks: declared RED command rejects runs without expected failures or that exit 0', () => {
  for (const [verify, pattern] of [
    [(purpose: string) => purpose === 'red' ? { exit: 1 } : { exit: 0 }, /expected failures were not observed: test:rejects bad input/],
    [(purpose: string) => purpose === 'red' ? { exit: 0, failedTests: ['test:rejects bad input'] } : { exit: 0 }, /RED command exited 0/],
  ] as const) {
    const sim: Sim = { plan: withRed({ red: 'npx jest --ci {files}' }), verify };
    let { result, trace } = start(1, sim);
    result = submit(launch(result, sim, trace), 'T1', sim, trace);
    assert.match(record(result, 'T1')?.reason ?? '', pattern);
  }
});

test('tasks: declared RED command refuses a test path that could break its quoting', () => {
  for (const unsafe of ['tests/validation.test.ts\\', 'tests/"validation".test.ts']) {
    const swap = (path: string) => path === 'tests/validation.test.ts' ? unsafe : path;
    const plan: ParsedPlan = {
      ...PLAN,
      criteria: PLAN.criteria.map((row) => ({ ...row, changes: row.changes.map(swap), tests: row.tests.map(swap) })),
      changes: PLAN.changes.map((row) => ({ ...row, path: swap(row.path) })),
      tasks: PLAN.tasks.map((row) => ({ ...row, paths: row.paths.map(swap) })),
    };
    const envelope = (id: string) => ({ ...defaultEnvelope(id, plan), evidence: defaultEnvelope(id, plan).evidence.map((row) => row.replace('tests/validation.test.ts', unsafe)) });
    const sim: Sim = { plan, envelope };
    let { result, trace } = start(1, sim);
    result = submit(launch(result, sim, trace), 'T1', sim, trace);
    assert.deepEqual(redCommand(trace), [], unsafe);
    assert.match(record(result, 'T1')?.reason ?? '', /unsafe test path/, unsafe);
  }
});

test('tasks: declared RED command without {files} runs unchanged beside a test path {files} could not quote', () => {
  const unsafe = 'tests/"validation".test.ts';
  const swap = (path: string) => path === 'tests/validation.test.ts' ? unsafe : path;
  const base = withRed({ red: 'npx nx test web --testFile=validation' });
  const plan: ParsedPlan = {
    ...base,
    criteria: base.criteria.map((row) => ({ ...row, changes: row.changes.map(swap), tests: row.tests.map(swap) })),
    changes: base.changes.map((row) => ({ ...row, path: swap(row.path) })),
    tasks: base.tasks.map((row) => ({ ...row, paths: row.paths.map(swap) })),
  };
  const envelope = (id: string) => ({ ...defaultEnvelope(id, plan), evidence: defaultEnvelope(id, plan).evidence.map((row) => row.replace('tests/validation.test.ts', unsafe)) });
  const sim: Sim = { plan, envelope };
  let { result, trace } = start(1, sim);
  result = submit(launch(result, sim, trace), 'T1', sim, trace);
  assert.deepEqual(redCommand(trace), ['npx nx test web --testFile=validation']);
  assert.equal(record(result, 'T1')?.status, 'accepted');
});

const isRecordLike = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

test('tasks: RED envelope tests and the RED checkpoint carry a fixture only when Tests declares it', () => {
  const fixture = 'tests/fixtures/input.json';
  for (const declared of [true, false]) {
    const plan: ParsedPlan = {
      ...PLAN,
      criteria: PLAN.criteria.map((row) => row.id === 'SC1' ? { ...row, changes: [...row.changes, fixture], tests: declared ? [...row.tests, fixture] : row.tests } : row),
      changes: [...PLAN.changes, { action: 'NEW', path: fixture, note: 'fixture', command: null, line: 5 }],
      tasks: PLAN.tasks.map((row) => row.id === 'T1' ? { ...row, paths: [...row.paths, fixture] } : row),
    };
    const sim: Sim = { plan };
    let { result, trace } = start(1, sim);
    result = submit(launch(result, sim, trace), 'T1', sim, trace);
    const expected = declared ? [fixture, 'tests/validation.test.ts'] : ['tests/validation.test.ts'];
    const envelope = trace.effects.findLast((effect) => effect.kind === 'check-envelope');
    assert.deepEqual(envelope?.kind === 'check-envelope' && envelope.tests, expected);
    const brief = trace.effects.find((effect) => effect.kind === 'write-brief' && isRecordLike(effect.input['task']) && effect.input['task']['id'] === 'T1');
    const checkpoint = brief?.kind === 'write-brief' && isRecordLike(brief.input['task']) ? brief.input['task']['checkpoint'] : null;
    assert.deepEqual(isRecordLike(checkpoint) && checkpoint['paths'], expected);
    const red = trace.effects.find((effect) => effect.kind === 'checkout' && effect.op === 'red');
    assert.deepEqual(red?.kind === 'checkout' && red.input['permitted'], expected);
  }
});

test('tasks: RED checkpoint carries a support file declared under a sibling verify criterion', () => {
  const helper = 'tests/helpers/setup.ts';
  const plan: ParsedPlan = {
    ...PLAN,
    criteria: [...PLAN.criteria, { ...criterion('SC4', helper, 'verify'), tests: [helper] }],
    changes: [...PLAN.changes, { action: 'NEW', path: helper, note: 'helper', command: null, line: 5 }],
    tasks: PLAN.tasks.map((row) => row.id === 'T1' ? { ...row, paths: [...row.paths, helper], criteria: [...row.criteria, 'SC4'] } : row),
  };
  const sim: Sim = { plan };
  let { result, trace } = start(1, sim);
  result = submit(launch(result, sim, trace), 'T1', sim, trace);
  const expected = [helper, 'tests/validation.test.ts'];
  const envelope = trace.effects.findLast((effect) => effect.kind === 'check-envelope');
  assert.deepEqual(envelope?.kind === 'check-envelope' && envelope.tests, expected);
  const brief = trace.effects.find((effect) => effect.kind === 'write-brief' && isRecordLike(effect.input['task']) && effect.input['task']['id'] === 'T1');
  const checkpoint = brief?.kind === 'write-brief' && isRecordLike(brief.input['task']) ? brief.input['task']['checkpoint'] : null;
  assert.deepEqual(isRecordLike(checkpoint) && checkpoint['paths'], expected);
  const red = trace.effects.find((effect) => effect.kind === 'checkout' && effect.op === 'red');
  assert.deepEqual(red?.kind === 'checkout' && red.input['permitted'], expected);
});

/** Runs a baseline where SC1's Verify command fails, accepts it as known red, and submits T1. */
function afterFailingBaseline(sim: Sim): { result: Result; trace: Trace } {
  const trace: Trace = { effects: [], events: [] };
  let result = pump(stepImplement(initialImplement(), run(1)), sim, trace);
  assert.equal(result.state.tag, 'baseline-decision');
  const ids = (implementData(result.state)['items'] as { failureId: string }[]).map((row) => row.failureId);
  result = host(result, { type: 'DECISION', kind: 'baseline', answer: { action: 'accept-known-red', ids } }, sim, trace);
  result = host(result, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } }, sim, trace);
  result = classify(result, sim, trace);
  return { result: submit(launch(result, sim, trace), 'T1', sim, trace), trace };
}
const baselineLog = (trace: Trace) => trace.effects.flatMap((effect) => effect.kind === 'verify' && effect.purpose === 'baseline' ? [`${effect.id}.log`] : []);

test('tasks: a RED baseline collision is a recorded concern unless Pre-existing is yes, never a task defect', () => {
  for (const preExisting of [false, true]) {
    const failing = (purpose: string): Outcome => purpose === 'baseline' ? { exit: 1, failedTests: [] } : purpose === 'red' ? { exit: 1, failedTests: ['test:rejects bad input'], baselineHits: ['test:rejects bad input'] } : { exit: 0 };
    const sim: Sim = { plan: withRed({ preExisting }), verify: failing };
    const { result, trace } = afterFailingBaseline(sim);
    assert.deepEqual(redEffects(trace).map((row) => row.scanLogs), [baselineLog(trace)]);
    assert.equal(record(result, 'T1')?.status, 'accepted');
    const concerns = 'c' in result.state ? result.state.c?.concerns ?? [] : [];
    assert.equal(concerns.some((item) => /SC1 expected test names also appear in a failing baseline log \(test:rejects bad input\)/.test(item)), !preExisting, JSON.stringify(concerns));
  }
});

test('tasks: declared RED command fails the task when a failing baseline log is unreadable', () => {
  const sim: Sim = { verify: (purpose) => purpose === 'baseline' ? { exit: 1 } : purpose === 'red' ? { exit: 1, failedTests: ['test:rejects bad input'], scanUnreadable: ['gone.log'] } : { exit: 0 } };
  const { result } = afterFailingBaseline(sim);
  assert.match(record(result, 'T1')?.reason ?? '', /baseline log unreadable: gone\.log/);
});

test('tasks: downgraded RED evidence skips RED replay, verifies GREEN, names the criterion in concerns, and settles evidence', () => {
  const sim: Sim = { plan: withRed({ red: null }), envelope: (id) => ({ ...defaultEnvelope(id), evidence: defaultEnvelope(id).evidence.filter((row) => !row.startsWith('RED-MATRIX')) }) };
  let { result, trace } = start(1, sim);
  result = submit(launch(result, sim, trace), 'T1', sim, trace);
  assert.equal(record(result, 'T1')?.status, 'accepted');
  assert.deepEqual(redCommand(trace), []);
  assert.ok(trace.effects.some((effect) => effect.kind === 'verify' && effect.purpose === 'scoped' && effect.cwd === 'run/wt/task-t1'));
  result = submit(launch(result, sim, trace), 'T2', sim, trace);
  result = submit(launch(result, sim, trace), 'T3', sim, trace);
  assert.equal(result.state.tag, 'concerns');
  if (result.state.tag === 'concerns') assert.deepEqual(result.state.items, ['SC1 RED evidence downgraded to verify: no RED command declared']);
  result = host(result, { type: 'DECISION', kind: 'concerns', answer: { decision: 'accept', by: 'user', quote: 'Accept the downgrade' } }, sim, trace);
  assert.equal(result.state.tag, 'evidence');
  result = host(result, { type: 'EVIDENCE', criteria: Object.fromEntries(PLAN.criteria.map((row) => [row.id, { outcome: 'pass', evidence: 'verify passed' }])) }, sim, trace);
  assert.equal(result.state.tag, 'complete');
  if (result.state.tag === 'complete') assert.deepEqual([result.state.c.evidence['SC1']?.['source'], result.state.c.evidence['SC1']?.['redProvenance']], ['verify', 'not-required']);
});

test('tasks: a red criterion with RED but no Tests downgrades to verify, skips RED replay, and names the reason in concerns', () => {
  const sim: Sim = { plan: withRed({ tests: [] }), envelope: (id) => ({ ...defaultEnvelope(id), evidence: defaultEnvelope(id).evidence.filter((row) => !row.startsWith('RED-MATRIX')) }) };
  let { result, trace } = start(1, sim);
  result = submit(launch(result, sim, trace), 'T1', sim, trace);
  assert.equal(record(result, 'T1')?.status, 'accepted');
  assert.deepEqual(redCommand(trace), []);
  result = submit(launch(result, sim, trace), 'T2', sim, trace);
  result = submit(launch(result, sim, trace), 'T3', sim, trace);
  assert.equal(result.state.tag, 'concerns');
  if (result.state.tag === 'concerns') assert.deepEqual(result.state.items, ['SC1 RED evidence downgraded to verify: no Tests declared']);
});

test('tasks: admission ignores a RED-MATRIX row for a downgraded sibling criterion and accepts the task', () => {
  const plan: ParsedPlan = {
    ...PLAN,
    criteria: [...PLAN.criteria, criterion('SC4', 'src/d.ts', 'red')],
    changes: [...PLAN.changes, { action: 'MODIFY', path: 'src/d.ts', note: 'd', command: null, line: 5 }],
    planIds: [...PLAN.planIds, 'SC4'],
    tasks: PLAN.tasks.map((row) => row.id === 'T1' ? { ...row, paths: [...row.paths, 'src/d.ts'], criteria: [...row.criteria, 'SC4'] } : row),
  };
  const downgradedRow = 'RED-MATRIX SC4 | tests/validation.test.ts:handles d | exit 1 test:handles d';
  const sim: Sim = { plan, envelope: (id) => { const base = defaultEnvelope(id, plan); return id === 'T1' ? { ...base, evidence: [...base.evidence, downgradedRow] } : base; } };
  let { result, trace } = start(1, sim);
  result = submit(launch(result, sim, trace), 'T1', sim, trace);
  assert.equal(record(result, 'T1')?.status, 'accepted', record(result, 'T1')?.reason ?? '');
  assert.ok(parseRedMatrix([RED_ROW, downgradedRow.replace('SC4', 'SC9')], [PLAN.criteria[0]!], [...PLAN.planIds, 'SC9'], ['SC4']).defects.some((defect) => /unknown criterion SC9/.test(defect)));
});

test('hotfix production paths exclude declared tests, not test-like paths', () => {
  const f = failure();
  const plan = f.c.plan!;
  const changes = ['src/a.ts', 'checks/a.ts', 'tests/helper.test.ts'];
  const state = { ...f, c: { ...f.c, plan: {
    ...plan,
    criteria: plan.criteria.map((row) => ({ ...row, changes, tests: ['checks/a.ts'] })),
    changes: changes.map((path, index) => ({ action: 'MODIFY' as const, path, note: path, command: null, line: index + 1 })),
  } } };
  const after = { ...RECOVERY_FP, worktree: 'edited' };
  let r = recoveryHost(state, { type: 'DECISION', kind: 'failure', answer: { by: 'orchestrator', action: 'hotfix', mode: 'inline', rationale: 'bad branch' } }, after, ['src/a.ts']);
  assert.equal(r.state.tag, 'hotfix-snapshot');
  r = stepImplement(r.state, { type: 'SNAPSHOT', effectId: r.effects[0]!.id, fingerprint: after, diff: { paths: ['src/a.ts'] } });
  const assess = r.effects.find((effect) => effect.kind === 'assess-recovery');
  assert.deepEqual(assess?.kind === 'assess-recovery' && assess.input['productionPaths'], ['src/a.ts', 'tests/helper.test.ts']);
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

test('tasks: launch receipts must echo the configured writer model or disclose a substitution', () => {
  const sim: Sim = {};
  let { result, trace } = start(1, sim);
  const slot = slots(result).find((item) => item.action === 'launch')!;
  const launched = { task: slot.task, attempt: slot.attempt, signature: slot.signature, handle: 'agent-1' };
  assert.match(validateImplement(result.state, { type: 'WRITE_RECEIPT', status: 'launched', ...launched, model: 'host-default' }) ?? '', /launched model host-default \(configured writer-a\)/);
  assert.equal(validateImplement(result.state, { type: 'WRITE_RECEIPT', status: 'launched', ...launched, model: slot.model }), null);
  result = host(result, { type: 'WRITE_RECEIPT', status: 'launched', ...launched, model: 'host-default', substitution: 'Task tool exposes no model parameter' }, sim, trace);
  assert.ok(result.state.tag === 'tasks' && result.state.c.concerns.some((item) => item === 'T1: writer substitution, launched model host-default (configured writer-a); Task tool exposes no model parameter'));
  assert.equal(slots(result).find((item) => item.task === slot.task)?.model, 'host-default');
  const failure = { type: 'WRITE_RECEIPT' as const, status: 'failed' as const, ...launched, detail: 'timeout: stalled' };
  assert.equal(validateImplement(result.state, { ...failure, model: 'host-default' }), null);
  assert.match(validateImplement(result.state, { ...failure, model: 'writer-a' }) ?? '', /active writer model/);
});

// SECTION: Launch records and compact frames

const RUN_DIR = path.join('session', '.state', 'runs', '001-implement');
const launchesOf = (result: Result) => implement.implementLaunches(result.state, RUN_DIR) as unknown as { path: string; record: Launch }[];
const valid = (result: Result, receipts: readonly Record<string, unknown>[]) => receipts.map((receipt) => validateImplement(result.state, receipt as never));
const LAUNCH_FIELDS = ['task', 'attempt', 'signature', 'action', 'handle', 'model', 'briefPath', 'briefHash', 'envelopePath', 'checkpointPath', 'worktree', 'paths', 'receipts'];
const amendRunning = (): { result: Result; sim: Sim; trace: Trace } => {
  const sim: Sim = { plan: AMEND_PLAN };
  const { result, trace } = start(3, sim);
  return { result: launch(result, sim, trace), sim, trace };
};
const amendEvent = (delta: readonly object[], notify: { task: string; notice: string }[] = [], extra: Record<string, unknown> = {}): Event =>
  ({ type: 'AMEND', delta, notify, rationale: 'Plan changed mid-run.', ...extra }) as unknown as Event;
const SC1_FAST = { kind: 'modify', target: 'SC1', current: '[SC1] Part 1 works', proposed: '[SC1] Part 1 works fast' };
const DROP_T2 = [
  { kind: 'remove', target: 'T2', current: '| T2 | Part two | Deliver part two. | none | SC2 |' },
  { kind: 'remove', target: 'SC2', current: '- [SC2] Part 2 works\n  - Satisfies: REQ-1\n  - Changes: src/b.ts\n  - Verify: `node --test tests/part-2.test.ts`\n  - Evidence: verify\n  - Test rationale: pins part 2.\n' },
  { kind: 'remove', target: 'T2', current: '### T2 — Part two\n#### [MODIFY] src/b.ts\n- Changes: part two.\n\n' },
];

test('launch record gives a launching writer every launch field and a valid launched receipt while frame rows stay compact', () => {
  const { result } = start(2, {});
  const t1 = record(result, 'T1')!;
  const [first] = launchesOf(result);
  assert.equal(first!.path, path.join(RUN_DIR, 'implement.launch.t1', 'launch.json'));
  assert.equal(implement.launchRel('T1'), 'implement.launch.t1/launch.json');
  for (const field of LAUNCH_FIELDS) assert.ok(field in first!.record, field);
  assert.deepEqual(
    [first!.record.task, first!.record.attempt, first!.record.signature, first!.record.action, first!.record.handle, first!.record.model, first!.record.briefPath, first!.record.briefHash, first!.record.envelopePath, first!.record.checkpointPath, first!.record.worktree, first!.record.paths],
    ['T1', 1, t1.signature, 'launch', null, 'writer-a', t1.brief!.path, t1.brief!.sha256, t1.brief!.envelopePath, t1.brief!.checkpointPath, 'run/wt/task-t1', pathsOf('T1')],
  );
  assert.deepEqual(first!.record.receipts.map((receipt) => [receipt['status'], receipt['handle']]), [['launched', '<host-assigned handle>']]);
  assert.deepEqual(valid(result, first!.record.receipts), [null]);
  assert.deepEqual(frameRows(result), [
    { task: 'T1', action: 'launch', attempt: 1, handle: null, launchPath: 'implement.launch.t1/launch.json' },
    { task: 'T2', action: 'launch', attempt: 1, handle: null, launchPath: 'implement.launch.t2/launch.json' },
  ]);
});

test('launch record: a running writer offers submitted and failed receipts that pass validation and complete the task', () => {
  const sim: Sim = {};
  let { result, trace } = start(2, sim);
  result = launch(result, sim, trace);
  const t2 = launchOf(result.state, 'T2');
  assert.deepEqual(t2.receipts.map((receipt) => [receipt['status'], receipt['handle']]), [['submitted', 'agent-T2-1'], ['failed', 'agent-T2-1']]);
  assert.deepEqual(valid(result, t2.receipts), [null, null]);
  assert.equal(t2.receipts[0]!['briefHash'], t2.briefHash);
  result = host(result, t2.receipts[0] as unknown as Event, sim, trace);
  assert.equal(record(result, 'T2')?.status, 'accepted');
});

test('launch record: concurrent tasks whose briefs share one directory get distinct paths inside the run dir', () => {
  const { result } = start(2, {});
  const launches = launchesOf(result);
  assert.equal(path.dirname(launches[0]!.record.briefPath), path.dirname(launches[1]!.record.briefPath));
  assert.equal(new Set(launches.map((entry) => entry.path)).size, 2);
  for (const entry of launches) assert.ok(!path.relative(RUN_DIR, entry.path).startsWith('..'), entry.path);
});

test('launch record: every record path is run-owned, so snapshots ignore it', () => {
  const { result } = start(2, {});
  const ports = fakePorts(), root = tempDir(), runDir = path.join(root, '.state', 'runs', '001-implement');
  memoryRunFs(ports, root);
  const launches = implement.implementLaunches(result.state, runDir) as unknown as { path: string; record: Launch }[];
  assert.equal(launches.length, 2);
  for (const entry of launches) ports.fs.writeAtomic(entry.path, JSON.stringify(entry.record));
  const owned = runOwnedPaths(ports, root, runDir);
  for (const entry of launches) assert.ok(owned.includes(path.relative(root, entry.path).replaceAll('\\', '/')), entry.path);
});

test('launch record: a pending amendment carries the notice and the regenerated brief, and its submitted receipt passes', () => {
  let { result, sim, trace } = amendRunning();
  const before = launchOf(result.state, 'T1');
  result = host(result, amendEvent([SC1_FAST], [{ task: 'T1', notice: 'SC1 now requires speed.' }]), sim, trace);
  const after = launchOf(result.state, 'T1'), latest = record(result, 'T1')!.briefs!.at(-1)!;
  assert.equal(after.notice, 'SC1 now requires speed.');
  assert.deepEqual([after.briefPath, after.briefHash, after.envelopePath, after.checkpointPath], [latest.path, latest.sha256, latest.envelopePath, latest.checkpointPath]);
  assert.notEqual(after.briefHash, before.briefHash);
  assert.equal(launchOf(result.state, 'T2').notice, undefined);
  assert.deepEqual(implementData(result.state)['amended'], [{ task: 'T1', launchPath: 'implement.launch.t1/launch.json' }]);
  const submitted = after.receipts.find((receipt) => receipt['status'] === 'submitted')!;
  assert.deepEqual([submitted['envelopePath'], submitted['briefHash']], [latest.envelopePath, latest.delta?.sha256]);
  assert.deepEqual(valid(result, after.receipts), [null, null]);
});

test('launch record: a writer that finished under the pre-amendment brief echoes its own hash, and validation names it stale', () => {
  let { result, sim, trace } = amendRunning();
  const before = launchOf(result.state, 'T1');
  result = host(result, amendEvent([SC1_FAST], [{ task: 'T1', notice: 'SC1 now requires speed.' }]), sim, trace);
  const submitted = launchOf(result.state, 'T1').receipts.find((receipt) => receipt['status'] === 'submitted')!;
  const stale = { ...submitted, envelopePath: before.envelopePath, briefHash: before.briefHash };
  assert.match(valid(result, [stale])[0] ?? '', /stale brief; an amendment changed the paths or criteria of T1/);
});

test('launch record: a cascade relaunch keeps the retained brief with the new attempt and model', () => {
  const sim: Sim = {};
  let { result, trace } = start(1, sim);
  result = launch(result, sim, trace);
  const first = launchOf(result.state, 'T1');
  result = host(result, first.receipts.find((receipt) => receipt['status'] === 'failed') as unknown as Event, sim, trace);
  const relaunch = launchOf(result.state, 'T1');
  assert.deepEqual([relaunch.action, relaunch.attempt, relaunch.model, relaunch.handle], ['launch', 2, 'writer-b', null]);
  assert.deepEqual([relaunch.briefPath, relaunch.briefHash, relaunch.envelopePath, relaunch.checkpointPath], [first.briefPath, first.briefHash, first.envelopePath, first.checkpointPath]);
  assert.deepEqual(valid(result, relaunch.receipts), [null]);
  result = host(result, { ...relaunch.receipts[0], handle: 'agent-T1-2' } as unknown as Event, sim, trace);
  const running = launchOf(result.state, 'T1');
  assert.deepEqual(valid(result, running.receipts), [null, null]);
  result = host(result, running.receipts[0] as unknown as Event, sim, trace);
  assert.equal(record(result, 'T1')?.status, 'accepted');
});

test('launch record: a writer retired with stop is cancelled through a valid receipt', () => {
  let { result, sim, trace } = amendRunning();
  result = host(result, amendEvent(DROP_T2, [], { by: { by: 'user', quote: 'Drop part two.' }, retire: [{ task: 'T2', disposition: 'stop' }] }), sim, trace);
  const t2 = launchOf(result.state, 'T2');
  assert.deepEqual([t2.action, t2.retirement, t2.receipts.map((receipt) => receipt['status'])], ['cancel', 'stop', ['cancelled']]);
  assert.deepEqual(valid(result, t2.receipts), [null]);
  result = host(result, t2.receipts[0] as unknown as Event, sim, trace);
  assert.equal(record(result, 'T2'), undefined);
});

test('launch record: a writer retired with retain keeps its disposition and may still finish or stop', () => {
  let { result, sim, trace } = amendRunning();
  result = host(result, amendEvent(DROP_T2, [], { retire: [{ task: 'T2', disposition: 'retain' }] }), sim, trace);
  const retained = launchOf(result.state, 'T2');
  assert.deepEqual([retained.action, retained.retirement, retained.retainedSubmission, retained.receipts.map((receipt) => receipt['status'])], ['running', 'retain', undefined, ['submitted', 'failed', 'cancelled']]);
  assert.deepEqual(valid(result, retained.receipts), [null, null, null]);
  const stopped = host(result, retained.receipts[2] as unknown as Event, sim, trace);
  assert.equal(record(stopped, 'T2'), undefined);
  result = host(result, retained.receipts[0] as unknown as Event, sim, trace);
  assert.equal(record(result, 'T2'), undefined);
});

test('launch record: root writes each design increment launch record under the run dir', () => {
  const { result } = start(2, {});
  const ports = fakePorts(), session = tempDir(), runDir = path.join(session, '.state', 'runs', '001-implement');
  memoryRunFs(ports, session);
  const active = started();
  assert.equal(active.tag, 'increment');
  const state = { tag: 'design', run: { verb: 'implement', argument: 'x.design.md', slug: 'feature' }, child: { ...active, child: result.state } } as unknown as RootState;
  rootMachine.render!(state, ports, runDir);
  for (const task of ['T1', 'T2']) {
    const written = JSON.parse(ports.fs.readText(path.join(runDir, implement.launchRel(task)))) as Launch;
    assert.deepEqual(written, launchOf(state, task));
  }
});

test('launch record: a state without context yields none, and launchOf needs an active implementation', () => {
  assert.deepEqual(implement.implementLaunches(initialImplement(), RUN_DIR), []);
  const { result } = start(2, {});
  const run = { verb: 'implement', argument: 'x.plan.md', slug: 'feature' };
  assert.throws(() => launchOf({ tag: 'review', c: { histories: {} }, review: {} }, 'T1'), /no active implementation/);
  assert.throws(() => launchOf({ tag: 'done', run, last: { verb: 'implement', state: result.state }, counters: {}, done: {}, handoff: null, warning: null }, 'T1'), /no active implementation/);
  assert.equal(launchOf({ tag: 'implement', run, child: result.state }, 'T1').task, 'T1');
});

/** Six independent writers; `scale` multiplies each task's paths and criteria. */
function sixWriterPlan(scale: number): ParsedPlan {
  const ids = [1, 2, 3, 4, 5, 6];
  const files = (n: number) => Array.from({ length: scale }, (_, j) => `src/part-${n}/file-${j}.ts`);
  const owned = (n: number) => Array.from({ length: scale }, (_, k) => `SC${n * 100 + k}`);
  const criteria = ids.flatMap((n) => owned(n).map((id, k) => criterion(id, files(n)[k]!, 'verify')));
  return {
    ...PLAN, criteria, planIds: criteria.map((row) => row.id),
    changes: ids.flatMap(files).map((file, line) => ({ action: 'MODIFY' as const, path: file, note: 'part', command: null, line })),
    tasks: ids.map((n) => task(`T${n}`, files(n), owned(n))),
  };
}
const frameBytes = (state: ImplementState) => Buffer.byteLength(JSON.stringify(implementData(state)));
function sixWriters(scale: number, notice: string): { tasks: number; amended: number } {
  const sim: Sim = { plan: sixWriterPlan(scale) };
  let { result, trace } = start(6, sim);
  result = launch(result, sim, trace);
  assert.deepEqual(frameRows(result).map((row) => row.action), Array(6).fill('running'));
  if (result.state.tag !== 'tasks') throw new Error('tasks frame');
  const c = result.state.c;
  const amended = Object.values(c.tasks).map((row) => ({ task: row.id, briefPath: row.brief!.path, briefHash: row.brief!.sha256, notice }));
  return { tasks: frameBytes(result.state), amended: frameBytes({ ...result.state, c: { ...c, amended } }) };
}

test('frame size independent of task content keeps six writers within fixed tasks and amendment caps', () => {
  const notice = 'Criterion wording changed; keep the public API stable.';
  const base = sixWriters(1, notice), grown = sixWriters(10, notice.repeat(10));
  assert.ok(base.tasks <= 2048, `tasks frame ${base.tasks} bytes`);
  assert.ok(base.amended <= 3072, `amendment frame ${base.amended} bytes`);
  assert.deepEqual(grown, base);
});

// SECTION: Amendment deltas — a live writer reads a delta bound to the full brief it was launched with.

type DeltaLaunch = Launch & { deltaPath?: string; deltaHash?: string };
const deltaLaunch = (result: Result, id: string) => launchOf(result.state, id) as DeltaLaunch;
const submittedOf = (launched: Launch) => launched.receipts.find((receipt) => receipt['status'] === 'submitted')!;
const deltaBases = (trace: Trace) => trace.effects.flatMap((effect) => effect.kind === 'write-brief' ? [effect.input['deltaBase']] : []);
const notifyT1 = (notice: string) => [{ task: 'T1', notice }];
const SC1_FASTER = { kind: 'modify', target: 'SC1', current: '[SC1] Part 1 works fast', proposed: '[SC1] Part 1 works faster' };
const CONSTRAINT_LOG = { kind: 'modify', target: 'T1', current: '- Constraints: Preserve the stable API.', proposed: '- Constraints: Preserve the stable API and log calls.' };
const CONSTRAINT_TRACE = { kind: 'modify', target: 'T1', current: '- Constraints: Preserve the stable API and log calls.', proposed: '- Constraints: Preserve the stable API and trace calls.' };
const T1_AFTER_T2 = { kind: 'modify', target: 'T1', current: '| T1 | Part one | Deliver part one. | none | SC1 |', proposed: '| T1 | Part one | Deliver part one. | T2 | SC1 |' };
/** Folds the recorded events from the run start, as journal replay does. */
const replayed = (trace: Trace): Result => {
  let state = initialImplement();
  for (const event of [run(3), ...trace.events]) state = stepImplement(state, event).state;
  return { state, effects: [] };
};

test('amendment delta binds the launch record and submitted receipt to the delta or the latest full brief', () => {
  let { result, sim, trace } = amendRunning();
  const base = deltaLaunch(result, 'T1');
  assert.equal('deltaPath' in base, false);
  result = host(result, amendEvent([SC1_FAST], notifyT1('SC1 now requires speed.')), sim, trace);
  assert.deepEqual(deltaBases(trace).at(-1), { path: base.briefPath, sha256: base.briefHash, seq: 1 });
  const after = deltaLaunch(result, 'T1'), latest = record(result, 'T1')!.briefs!.at(-1)!;
  assert.ok(latest.delta, 'latest brief records its delta');
  assert.deepEqual([after.deltaPath, after.deltaHash, after.briefPath, after.briefHash, after.envelopePath], [latest.delta!.path, latest.delta!.sha256, latest.path, latest.sha256, latest.envelopePath]);
  const submitted = submittedOf(after);
  assert.deepEqual([submitted['envelopePath'], submitted['briefHash']], [latest.envelopePath, latest.delta!.sha256]);
  assert.deepEqual(valid(result, [submitted, { ...submitted, briefHash: latest.sha256 }]), [null, null]);
  assert.match(valid(result, [{ ...submitted, briefHash: `sha256:${'f'.repeat(64)}` }])[0] ?? '', /echo the hash of the brief the writer worked from/);
  assert.match(valid(result, [{ ...submitted, envelopePath: base.envelopePath, briefHash: base.briefHash }])[0] ?? '', /stale brief/);
  assert.equal('deltaPath' in deltaLaunch(result, 'T2'), false);
  result = host(result, submitted as unknown as Event, sim, trace);
  assert.equal(record(result, 'T1')?.status, 'accepted');
});

test('amendment delta relaunch and fresh launch carry only the full brief', () => {
  const fresh = start(1, {});
  assert.equal('deltaPath' in deltaLaunch(fresh.result, 'T1'), false);
  assert.deepEqual(deltaBases(fresh.trace), [undefined]);

  let { result, sim, trace } = amendRunning();
  result = host(result, amendEvent([SC1_FAST], notifyT1('SC1 now requires speed.')), sim, trace);
  const latest = record(result, 'T1')!.briefs!.at(-1)!;
  assert.equal(deltaLaunch(result, 'T1').deltaHash, latest.delta?.sha256 ?? 'live writer offered a delta');
  result = host(result, deltaLaunch(result, 'T1').receipts.find((receipt) => receipt['status'] === 'failed') as unknown as Event, sim, trace);
  const relaunch = deltaLaunch(result, 'T1');
  assert.deepEqual([relaunch.action, relaunch.attempt, 'deltaPath' in relaunch, 'deltaHash' in relaunch, relaunch.briefPath, relaunch.briefHash], ['launch', 2, false, false, latest.path, latest.sha256]);
  result = host(result, { ...relaunch.receipts[0], handle: 'agent-T1-2' } as unknown as Event, sim, trace);
  const running = deltaLaunch(result, 'T1');
  assert.deepEqual(['deltaPath' in running, submittedOf(running)['briefHash'], submittedOf(running)['envelopePath']], [false, latest.sha256, latest.envelopePath]);
  assert.deepEqual(valid(result, running.receipts), [null, null]);

  const hotfix = recoveryHost(failure(), { type: 'DECISION', kind: 'failure', answer: { by: 'orchestrator', action: 'hotfix', mode: 'writer', rationale: 'bad branch' } });
  const brief = hotfix.effects.find((effect) => effect.kind === 'write-brief');
  assert.ok(brief?.kind === 'write-brief' && brief.stage === 'hotfix');
  assert.equal('deltaBase' in brief.input, false);
});

test('amendment delta repeated in one scope binds the launch brief and rejects only the superseded delta', () => {
  let { result, sim, trace } = amendRunning();
  const base = deltaLaunch(result, 'T1');
  result = host(result, amendEvent([CONSTRAINT_LOG], notifyT1('Log calls.')), sim, trace);
  result = host(result, amendEvent([CONSTRAINT_TRACE], notifyT1('Trace calls.')), sim, trace);
  assert.deepEqual(deltaBases(trace).slice(-2), [1, 2].map((seq) => ({ path: base.briefPath, sha256: base.briefHash, seq })));
  const [, first, second] = record(result, 'T1')!.briefs!;
  const submitted = submittedOf(deltaLaunch(result, 'T1'));
  assert.equal(submitted['briefHash'], second!.delta!.sha256);
  const at = (entry: { envelopePath: string }, briefHash: string) => ({ ...submitted, envelopePath: entry.envelopePath, briefHash });
  assert.deepEqual(valid(result, [at(second!, second!.delta!.sha256), at(second!, second!.sha256), at(base, base.briefHash), at(first!, first!.sha256)]), [null, null, null, null]);
  const superseded = valid(result, [at(first!, first!.delta!.sha256)])[0] ?? '';
  assert.match(superseded, /superseded delta/);
  assert.ok(superseded.includes(second!.delta!.sha256), superseded);
  const replay = replayed(trace);
  assert.deepEqual(launchesOf(replay), launchesOf(result));
  assert.equal(valid(replay, [at(first!, first!.delta!.sha256)])[0], superseded);
});

test('amendment delta repeated scope changes reject the launch brief and first full brief as stale', () => {
  let { result, sim, trace } = amendRunning();
  const base = deltaLaunch(result, 'T1');
  result = host(result, amendEvent([SC1_FAST], notifyT1('SC1 now requires speed.')), sim, trace);
  result = host(result, amendEvent([SC1_FASTER], notifyT1('SC1 now requires more speed.')), sim, trace);
  assert.deepEqual(deltaBases(trace).slice(-2), [1, 2].map((seq) => ({ path: base.briefPath, sha256: base.briefHash, seq })));
  const [, first, second] = record(result, 'T1')!.briefs!;
  const submitted = submittedOf(deltaLaunch(result, 'T1'));
  const at = (entry: { envelopePath: string }, briefHash: string) => ({ ...submitted, envelopePath: entry.envelopePath, briefHash });
  assert.deepEqual(valid(result, [at(second!, second!.delta!.sha256), at(second!, second!.sha256)]), [null, null]);
  const rejected = valid(result, [at(base, base.briefHash), at(first!, first!.sha256), at(first!, first!.delta!.sha256)]);
  assert.match(rejected[0] ?? '', /stale brief/);
  assert.match(rejected[1] ?? '', /stale brief/);
  assert.match(rejected[2] ?? '', /superseded delta/);
  const replay = replayed(trace);
  assert.deepEqual(launchesOf(replay), launchesOf(result));
  assert.deepEqual(valid(replay, [at(base, base.briefHash), at(first!, first!.delta!.sha256)]), [rejected[0], rejected[2]]);
});

test('amendment delta context-only amendments carry the new constraint or prerequisite', () => {
  const lastBrief = (trace: Trace) => trace.effects.findLast((effect) => effect.kind === 'write-brief')!;
  let { result, sim, trace } = amendRunning();
  const scope = record(result, 'T1')!.briefs!.at(-1)!.scope;
  result = host(result, amendEvent([CONSTRAINT_LOG], notifyT1('Log calls.')), sim, trace);
  let effect = lastBrief(trace);
  assert.ok(effect.kind === 'write-brief' && effect.input['deltaBase']);
  assert.deepEqual((effect.input['task'] as { constraints: string[] }).constraints, ['Preserve the stable API and log calls.']);
  assert.equal(record(result, 'T1')!.briefs!.at(-1)!.scope, scope);

  ({ result, sim, trace } = amendRunning());
  result = host(result, amendEvent([T1_AFTER_T2], notifyT1('T1 now follows T2.')), sim, trace);
  effect = lastBrief(trace);
  assert.ok(effect.kind === 'write-brief' && effect.input['deltaBase']);
  assert.deepEqual((effect.input['task'] as { prerequisites: unknown[] }).prerequisites, [{ id: 'T2', integrated: null }]);
  assert.equal(record(result, 'T1')!.briefs!.at(-1)!.scope, scope);
});
