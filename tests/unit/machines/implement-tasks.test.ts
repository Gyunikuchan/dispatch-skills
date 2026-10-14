import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effect, Event, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import type { ParsedPlan, PlanCriterion, PlanTask } from '../../../skills/dispatch/scripts/domain/types.ts';
import { parseRedMatrix } from '../../../skills/dispatch/scripts/machines/implement-types.ts';
import { implementData, initialImplement, stepImplement, validateImplement, type ImplementState } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { reconcileTasks, taskSignature } from '../../../skills/dispatch/scripts/machines/implement-tasks.ts';
import { HASH, FP, criterion, task, PLAN, run, RED_ROW, taskOf, pathsOf, defaultEnvelope, defaultVerify, answer, pump, host, classify, start, slots, record, launch, submit, launchedTasks, type Outcome, type Sim, type Result, type Trace, type Slot } from './fixtures/implement-tasks.ts';

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

test('level-journal: task admission supplies its mixed production/test paths to the envelope check', () => {
  const sim: Sim = {};
  let { result, trace } = start(1, sim);
  result = submit(launch(result, sim, trace), 'T1', sim, trace);
  const admission = trace.effects.findLast((effect) => effect.kind === 'check-envelope');
  assert.ok(admission?.kind === 'check-envelope');
  if (admission?.kind === 'check-envelope') assert.deepEqual(admission.permitted, ['src/a.ts', 'tests/sc1.test.ts']);
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

test('tasks: failure retry re-pends the failed task with its admission defect and stays bounded', () => {
  const sim: Sim = { envelope: (id) => id === 'T1' ? { schemaVersion: 1, status: 'BLOCKED', stage: 'COMPLETE', summary: 'cannot proceed', evidence: [], blockers: ['missing API'] } : defaultEnvelope(id) };
  let { result, trace } = start(1, sim);
  for (let attempt = 1; attempt <= 3; attempt++) {
    result = submit(launch(result, sim, trace), 'T1', sim, trace);
    if (attempt === 1) result = submit(launch(result, sim, trace), 'T2', sim, trace);
    assert.equal(result.state.tag, 'failure');
    assert.equal(record(result, 'T1')?.attempt, attempt);
    if (attempt === 3) break;
    result = host(result, { type: 'DECISION', kind: 'failure', answer: { by: 'orchestrator', action: 'retry', rationale: 'API stub added' } }, sim, trace);
    const brief = trace.effects.findLast((effect) => effect.kind === 'write-brief');
    assert.deepEqual(brief?.kind === 'write-brief' && brief.input['admissionDefects'], ['Writer returned BLOCKED: cannot proceed']);
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
  ['setup-only RED', { verify: (purpose) => purpose === 'red' ? { exit: 1, loadError: true } : { exit: 0 } }, /load, syntax, or missing-file/],
  ['fabricated RED', { verify: () => ({ exit: 0 }) }, /expected failures were not observed/],
  ['failing GREEN', { verify: (purpose, _command, _task) => purpose === 'red' ? defaultVerify('red') : purpose === 'scoped' ? { exit: 1, failedTests: ['test:x'] } : { exit: 0 } }, /Task verification failed/],
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

test('tasks: RED matrix names control-character corruption from JSON-escaped backslashes', () => {
  const criteria = [PLAN.criteria[0]!];
  assert.ok(parseRedMatrix([RED_ROW.replace('tests/sc1', 'tests\tsc1')], criteria).defects.some((defect) => /control character/.test(defect)));
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

test('tasks: admission refuses to narrow RED to a test path that could break its quoting', () => {
  for (const unsafe of ['tests/sc1.test.ts\\', 'tests/"sc1".test.ts']) {
    const swap = (path: string) => path === 'tests/sc1.test.ts' ? unsafe : path;
    const base = withRed({ verify: [{ command: 'node --test tests/all.test.ts', final: false }] });
    const plan: ParsedPlan = {
      ...base,
      criteria: base.criteria.map((row) => ({ ...row, changes: row.changes.map(swap) })),
      changes: base.changes.map((row) => ({ ...row, path: swap(row.path) })),
      tasks: base.tasks.map((row) => ({ ...row, paths: row.paths.map(swap) })),
    };
    const envelope = (id: string) => ({ ...defaultEnvelope(id, plan), evidence: defaultEnvelope(id, plan).evidence.map((row) => row.replace('tests/sc1.test.ts', unsafe)) });
    const sim: Sim = { plan, envelope };
    let { result, trace } = start(1, sim);
    result = submit(launch(result, sim, trace), 'T1', sim, trace);
    assert.deepEqual(redCommand(trace), [], unsafe);
    assert.match(record(result, 'T1')?.reason ?? '', /cannot be narrowed safely/, unsafe);
  }
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
