import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Event } from '../../../skills/dispatch/scripts/core/types.ts';
import { implementData, stepImplement, validateImplement } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { AMEND_PLAN } from './fixtures/implement-amend.ts';
import { failure, host as recoveryHost } from './fixtures/implement-recovery.ts';
import { host, launch, record, slots, start, submit, type Result, type Sim, type Slot, type Trace } from './fixtures/implement-tasks.ts';

// SECTION: Helpers — three independent writers on a parseable plan so AMEND can edit its governed text.

const SC1_TITLE = { kind: 'modify', target: 'SC1', current: '[SC1] Part 1 works', proposed: '[SC1] Part 1 works fast' } as const;
const T1_NOTE = { kind: 'modify', target: 'src/a.ts', current: '- Changes: part one.', proposed: '- Changes: part one, tidied.' } as const;
const T3_REQUIRES_T1 = { kind: 'modify', target: 'T3', current: '- Prerequisites: none\n- Criteria: SC3', proposed: '- Prerequisites: T1\n- Criteria: SC3' } as const;
const amend = (delta: readonly Record<string, string>[], notify: { task: string; notice: string }[] = [], by?: { by: 'user'; quote: string }): Event =>
  ({ type: 'AMEND', delta, notify, rationale: 'Plan changed mid-run.', ...(by ? { by } : {}) }) as unknown as Event;
const request = (slot: Slot): Event => ({ type: 'REQUEST', task: slot.task, attempt: slot.attempt, need: 'Read src/shared.ts', paths: ['src/shared.ts'], rationale: 'The helper lives there.' });
const writeEffects = (trace: Trace) => trace.effects.filter((effect) => effect.kind === 'write-brief');

function running(concurrency = 3): { result: Result; sim: Sim; trace: Trace } {
  const sim: Sim = { plan: AMEND_PLAN };
  const { result, trace } = start(concurrency, sim);
  return { result: launch(result, sim, trace), sim, trace };
}
const slot = (result: Result, id: string) => slots(result).find((item) => item.task === id)!;
const submitWith = (result: Result, old: Slot): Event => ({ type: 'WRITE_RECEIPT', status: 'submitted', task: old.task, attempt: old.attempt, signature: slot(result, old.task).signature, handle: old.handle!, model: old.model, envelopePath: old.envelopePath, briefHash: old.briefHash });

// SECTION: SC9 — requests and live amendments

test('request keeps writer active', () => {
  let { result, sim, trace } = running();
  const before = slot(result, 'T1');
  result = host(result, request(before), sim, trace);
  assert.equal(result.state.tag, 'request-decision');
  assert.equal(implementData(result.state)['kind'], 'request');
  assert.equal(record(result, 'T1')?.status, 'running');
  result = host(result, { type: 'DECISION', kind: 'request', answer: { by: 'orchestrator', action: 'decline', rationale: 'Use the existing helper.' } }, sim, trace);
  assert.equal(result.state.tag, 'tasks');
  assert.deepEqual(slot(result, 'T1'), before);
});

test('amend notifies only named writers', () => {
  let { result, sim, trace } = running();
  const [t2, t3] = [slot(result, 'T2'), slot(result, 'T3')];
  const briefs = writeEffects(trace).length;
  result = host(result, amend([SC1_TITLE], [{ task: 'T1', notice: 'SC1 now requires speed.' }]), sim, trace);
  assert.equal(result.state.tag, 'tasks');
  assert.equal(writeEffects(trace).length, briefs + 1);
  assert.deepEqual((implementData(result.state)['amended'] as { task: string }[]).map((row) => row.task), ['T1']);
  assert.deepEqual([slot(result, 'T2'), slot(result, 'T3')], [t2, t3]);
  assert.equal(slot(result, 'T1').handle, 'agent-T1-1');
});

test('amend rejects intent change without user quote', () => {
  const { result } = running();
  const intent = { kind: 'modify', target: 'T1', current: 'deliver three parts.', proposed: 'deliver four parts.' };
  assert.match(validateImplement(result.state, amend([intent]) as never) ?? '', /user's quote: intent change/);
  assert.equal(validateImplement(result.state, amend([intent], [], { by: 'user', quote: 'Make it four.' }) as never), null);
});

test('amend rejects changed running task without notice', () => {
  const { result } = running();
  assert.match(validateImplement(result.state, amend([SC1_TITLE]) as never) ?? '', /changes running task T1; name it in notify/);
});

test('amend keeps submitted candidate pending admission', () => {
  let { result, sim, trace } = running();
  result = host(result, amend([T3_REQUIRES_T1]), sim, trace);
  result = submit(result, 'T3', sim, trace);
  const parked = record(result, 'T3')!;
  assert.equal(parked.status, 'submitted');
  const sc3 = { kind: 'modify', target: 'SC3', current: '[SC3] Part 3 works', proposed: '[SC3] Part 3 works fast' };
  result = host(result, amend([sc3]), sim, trace);
  assert.deepEqual(record(result, 'T3'), { ...parked });
  assert.ok(!trace.effects.some((effect) => effect.kind === 'check-envelope' && effect.cwd === parked.worktree));
  result = submit(result, 'T1', sim, trace);
  assert.equal(record(result, 'T3')?.status, 'accepted');
  assert.ok(trace.effects.some((effect) => effect.kind === 'check-envelope' && effect.cwd === parked.worktree));
});

test('amend reverifies changed accepted task', () => {
  let { result, sim, trace } = running();
  result = submit(result, 'T2', sim, trace);
  assert.equal(record(result, 'T2')?.status, 'accepted');
  const accepted = record(result, 'T2')!;
  const effects = trace.effects.length;
  const sc2 = { kind: 'modify', target: 'SC2', current: '[SC2] Part 2 works', proposed: '[SC2] Part 2 works fast' };
  result = host(result, amend([sc2]), sim, trace);
  const verify = trace.effects.slice(effects).filter((effect) => effect.kind === 'verify');
  assert.deepEqual(verify.map((effect) => effect.kind === 'verify' && [effect.cwd, effect.commands.map((row) => row['command'])]), [['run/wt/integration', ['node --test tests/sc2.test.ts']]]);
  assert.ok(!trace.effects.slice(effects).some((effect) => effect.kind === 'checkout' && effect.op === 'task'), 'no rebuild');
  assert.equal(record(result, 'T2')?.status, 'accepted');
  assert.equal(record(result, 'T2')?.integrated, accepted.integrated);
});

// SECTION: SC10 — stale brief hashes

test('stale brief hash accepted when scope unchanged', () => {
  let { result, sim, trace } = running();
  const old = slot(result, 'T1');
  result = host(result, amend([T1_NOTE], [{ task: 'T1', notice: 'Note reworded.' }]), sim, trace);
  assert.notEqual(slot(result, 'T1').briefHash, old.briefHash);
  assert.equal(validateImplement(result.state, submitWith(result, old) as never), null);
});

test('stale brief hash rejected when scope changed', () => {
  let { result, sim, trace } = running();
  const old = slot(result, 'T1');
  result = host(result, amend([SC1_TITLE], [{ task: 'T1', notice: 'SC1 now requires speed.' }]), sim, trace);
  assert.match(validateImplement(result.state, submitWith(result, old) as never) ?? '', /stale brief/);
});

// SECTION: SC17 — amendment-added prerequisites

test('added prerequisite parks running submission', () => {
  let { result, sim, trace } = running();
  result = host(result, amend([T3_REQUIRES_T1]), sim, trace);
  const envelopes = () => trace.effects.filter((effect) => effect.kind === 'check-envelope').length;
  result = submit(result, 'T3', sim, trace);
  assert.equal(envelopes(), 0);
  assert.ok(record(result, 'T3')?.parked);
  result = submit(result, 'T1', sim, trace);
  const integrated = trace.effects.flatMap((effect) => effect.kind === 'checkout' && effect.op === 'integrate' ? [String(effect.input['task'])] : []);
  assert.deepEqual(integrated, ['T1', 'T3']);
  assert.equal(record(result, 'T3')?.status, 'accepted');
});

test('amend rejects unaccepted prerequisite on accepted task', () => {
  let { result, sim, trace } = running();
  result = submit(result, 'T3', sim, trace);
  assert.equal(record(result, 'T3')?.status, 'accepted');
  assert.match(validateImplement(result.state, amend([T3_REQUIRES_T1]) as never) ?? '', /unaccepted prerequisite T1 to accepted task T3/);
});

// SECTION: SC18 — request escalation and failure decisions

test('request escalation requires user quote', () => {
  let { result, sim, trace } = running();
  result = host(result, request(slot(result, 'T1')), sim, trace);
  result = host(result, { type: 'DECISION', kind: 'request', answer: { by: 'orchestrator', action: 'escalate', rationale: 'Needs a scope call.' } }, sim, trace);
  assert.equal(implementData(result.state)['kind'], 'request-user');
  const requestId = implementData(result.state)['requestId'];
  assert.match(validateImplement(result.state, { type: 'DECISION', kind: 'request-user', answer: { by: 'user', requestId, choice: 'decline' } } as never) ?? '', /quote/);
  result = host(result, { type: 'DECISION', kind: 'request-user', answer: { by: 'user', requestId, choice: 'decline', quote: 'No.' } } as Event, sim, trace);
  assert.equal(result.state.tag, 'tasks');
  assert.equal(record(result, 'T1')?.status, 'running');
});

const failureDecision = (answer: Record<string, unknown>): Event => ({ type: 'DECISION', kind: 'failure', answer } as Event);

test('failure retry uses rationale', () => {
  const state = failure();
  assert.match(validateImplement(state, failureDecision({ by: 'orchestrator', action: 'retry' }) as never) ?? '', /rationale/);
  const result = recoveryHost(state, failureDecision({ by: 'orchestrator', action: 'retry', rationale: 'Flaky network; rerun.' }));
  assert.ok('c' in result.state && result.state.c);
  assert.deepEqual(result.state.c.retryContext, { rationale: 'Flaky network; rerun.', failure: state.reason });
});

test('failure hotfix requires mode', () => {
  const state = failure();
  assert.notEqual(validateImplement(state, failureDecision({ by: 'orchestrator', action: 'hotfix', rationale: 'Small fix.' }) as never), null);
  assert.equal(validateImplement(state, failureDecision({ by: 'orchestrator', action: 'hotfix', mode: 'inline', rationale: 'Small fix.' }) as never), null);
});

test('failure rejects root cause field', () => {
  const state = failure();
  assert.match(validateImplement(state, failureDecision({ by: 'orchestrator', action: 'retry', rationale: 'Rerun.', rootCause: 'flaky' }) as never) ?? '', /rootCause/);
  assert.equal(stepImplement(state, failureDecision({ by: 'orchestrator', action: 'retry', rationale: 'Rerun.', rootCause: 'flaky' })).state, state);
});


// SECTION: Review fixes — parked capacity, removed writers, amendment paths

const REMOVE_T2 = [
  { kind: 'remove', target: 'SC2', current: '- [SC2] Part 2 works\n  - Changes: src/b.ts\n  - Verify: `node --test tests/sc2.test.ts`\n  - Evidence: verify\n  - Test rationale: pins part 2.\n' },
  { kind: 'remove', target: 'T2', current: '### T2 — Part two\nDeliver part two.\n- Prerequisites: none\n- Criteria: SC2\n\n#### [MODIFY] src/b.ts\n- Changes: part two.\n\n' },
] as const;

test('parked submission frees writer slot', () => {
  let { result, sim, trace } = running(1);
  assert.deepEqual(slots(result).map((item) => item.task), ['T1']);
  const t1RequiresT2 = { kind: 'modify', target: 'T1', current: '- Prerequisites: none\n- Criteria: SC1', proposed: '- Prerequisites: T2\n- Criteria: SC1' };
  result = host(result, amend([t1RequiresT2]), sim, trace);
  result = submit(result, 'T1', sim, trace);
  assert.ok(record(result, 'T1')?.parked);
  assert.deepEqual(slots(result).map((item) => [item.task, item.action]), [['T2', 'launch']]);
  result = submit(launch(result, sim, trace), 'T2', sim, trace);
  assert.equal(record(result, 'T1')?.status, 'accepted');
});

test('removing launched writer requires user quote', () => {
  const { result } = running();
  assert.match(validateImplement(result.state, amend([...REMOVE_T2]) as never) ?? '', /user's quote: discards work of T2/);
  assert.equal(validateImplement(result.state, amend([...REMOVE_T2], [], { by: 'user', quote: 'Drop part two.' }) as never), null);
});

test('submission racing cancellation waits for cancelled receipt', () => {
  let { result, sim, trace } = running();
  const t2 = slot(result, 'T2');
  result = host(result, amend([...REMOVE_T2], [], { by: 'user', quote: 'Drop part two.' }), sim, trace);
  assert.equal(slot(result, 'T2').action, 'cancel');
  result = host(result, submitWith(result, t2), sim, trace);
  assert.ok(!trace.effects.some((effect) => effect.kind === 'check-envelope'));
  assert.equal(record(result, 'T2')?.discardedSubmission, t2.envelopePath);
  assert.equal(slot(result, 'T2').action, 'cancel');
  assert.match('c' in result.state && result.state.c ? result.state.c.concerns.join(' ') : '', /T2: removed writer submitted/);
  result = host(result, { type: 'WRITE_RECEIPT', status: 'cancelled', task: 'T2', attempt: t2.attempt, signature: t2.signature, handle: t2.handle!, model: t2.model } as Event, sim, trace);
  assert.equal(record(result, 'T2'), undefined);
});

test('amendment paths are namespaced per plan', () => {
  const paths = ['session/d-i1.plan.md', 'session/d-i2.plan.md'].map((planPath) => {
    let { result, sim, trace } = running();
    assert.ok(result.state.tag === 'tasks');
    result = { ...result, state: { ...result.state, c: { ...result.state.c, planPath } } };
    result = host(result, amend([T1_NOTE], [{ task: 'T1', notice: 'Note reworded.' }]), sim, trace);
    const c = 'c' in result.state && result.state.c ? result.state.c : null;
    return [c?.planPath, c?.amendments[0]?.path, c?.amendments[0]?.afterHash];
  });
  assert.deepEqual(paths.map((row) => row[0]), ['session/d-i1.amend-1.plan.md', 'session/d-i2.amend-1.plan.md']);
  assert.deepEqual(paths.map((row) => row[1]), paths.map((row) => row[0]));
});

// SECTION: Round-2 fixes — admission continuations re-check the amended plan

/** Puts `id` at an admission request as if an amendment narrowed its scope after its brief. */
function atAdmission(id: string): { result: Result; sim: Sim; trace: Trace } {
  const { result, sim, trace } = running();
  assert.ok(result.state.tag === 'tasks');
  const c = result.state.c, task = c.tasks[id]!;
  const tasks = { ...c.tasks, [id]: { ...task, status: 'submitted' as const, candidate: `c-${id}`, candidatePaths: ['src/c.ts'] } };
  const request = { requestId: 'request-1', task: id, attempt: task.attempt, need: 'Admit candidate paths outside the amended scope: src/c.ts.', paths: ['src/c.ts'], rationale: 'An amendment narrowed this task after its brief was issued.', source: 'admission' as const };
  return { result: { state: { tag: 'request-decision', c: { ...c, tasks, requestCount: 1 }, request, stage: 'orchestrator', orchestratorRationale: null }, effects: [] }, sim, trace };
}
const REMOVE_T3 = [
  { kind: 'remove', target: 'SC3', current: '- [SC3] Part 3 works\n  - Changes: src/c.ts\n  - Verify: `node --test tests/sc3.test.ts`\n  - Evidence: verify\n  - Test rationale: pins part 3.\n' },
  { kind: 'remove', target: 'T3', current: '### T3 — Part three\nDeliver part three.\n- Prerequisites: none\n- Criteria: SC3\n\n#### [MODIFY] src/c.ts\n- Changes: part three.\n\n' },
];

test('amend removing task at its admission resumes scheduling', () => {
  let { result, sim, trace } = atAdmission('T3');
  result = host(result, amend(REMOVE_T3, [], { by: 'user', quote: 'Drop part three.' }), sim, trace);
  assert.equal(result.state.tag, 'tasks');
  assert.equal(record(result, 'T3'), undefined);
});

test('amend adding prerequisite at admission parks until accepted', () => {
  let { result, sim, trace } = atAdmission('T3');
  const envelopes = () => trace.effects.filter((effect) => effect.kind === 'check-envelope' || (effect.kind === 'checkout' && effect.op === 'red' && String(effect.input['name']).includes('t3'))).length;
  result = host(result, amend([T3_REQUIRES_T1]), sim, trace);
  assert.equal(result.state.tag, 'tasks');
  assert.ok(record(result, 'T3')?.parked);
  assert.equal(envelopes(), 0);
  result = submit(result, 'T1', sim, trace);
  const integrated = trace.effects.flatMap((effect) => effect.kind === 'checkout' && effect.op === 'integrate' ? [String(effect.input['task'])] : []);
  assert.deepEqual(integrated, ['T1', 'T3']);
  assert.equal(record(result, 'T3')?.status, 'accepted');
});
