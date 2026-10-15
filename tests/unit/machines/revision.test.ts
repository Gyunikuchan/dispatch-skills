import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Event, PlanEdit } from '../../../skills/dispatch/scripts/core/types.ts';
import { amendPlan, replacementPlan } from '../../../skills/dispatch/scripts/machines/revision.ts';
import { implementData, validateImplement } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { rootMachine, type RootState } from '../../../skills/dispatch/scripts/machines/root.ts';
import { AMEND_PLAN } from './fixtures/implement-amend.ts';
import { approvalState } from './fixtures/implement-recovery.ts';
import { host, launch, record, slots, start, type Result, type Sim, type Trace } from './fixtures/implement-tasks.ts';

// SECTION: Helpers — live plan revision is an AMEND delta on the governed text of a parseable plan.

/** Adds src/shared.ts to T1 and to SC1's Changes so the amended plan still lints. */
const WIDEN_T1: PlanEdit[] = [
  { kind: 'modify', target: 'SC1', current: '  - Changes: src/a.ts, tests/part-1.test.ts', proposed: '  - Changes: src/a.ts, tests/part-1.test.ts, src/shared.ts' },
  { kind: 'add', target: 'src/shared.ts', current: '- Purpose: pins part one.\n', proposed: '#### [MODIFY] src/shared.ts\n- Changes: shared helper.\n' },
];
const amend = (delta: readonly PlanEdit[], by?: { by: 'user'; quote: string }): Event =>
  ({ type: 'AMEND', delta, notify: [{ task: 'T1', notice: 'src/shared.ts is now in scope.' }], rationale: 'The writer needs the shared helper.', ...(by ? { by } : {}) }) as unknown as Event;
const request: Event = { type: 'REQUEST', task: 'T1', attempt: 1, need: 'Edit src/shared.ts', paths: ['src/shared.ts'], rationale: 'The helper lives there.' };

function running(): { result: Result; sim: Sim; trace: Trace } {
  const sim: Sim = { plan: AMEND_PLAN };
  const { result, trace } = start(3, sim);
  return { result: launch(result, sim, trace), sim, trace };
}
const t1 = (result: Result) => slots(result).find((slot) => slot.task === 'T1')!;
const t1Paths = (result: Result) => 'c' in result.state && result.state.c?.plan ? result.state.c.plan.tasks.find((task) => task.id === 'T1')!.paths : [];

// SECTION: amendPlan

test('amend plan applies exact text edits and relints', () => {
  const amended = amendPlan(AMEND_PLAN, WIDEN_T1);
  assert.ok(amended.ok, amended.ok ? '' : amended.error);
  if (!amended.ok) return;
  assert.ok(amended.plan.tasks.find((task) => task.id === 'T1')!.paths.includes('src/shared.ts'));
  assert.match(amended.hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(amended.text, amended.plan.governedText);
});

test('amend plan rejects ambiguous or missing current text', () => {
  const missing = amendPlan(AMEND_PLAN, [{ kind: 'modify', target: 'SC1', current: 'no such text', proposed: 'x' }]);
  assert.ok(!missing.ok && /exactly once in the plan; found 0/.test(missing.error), JSON.stringify(missing));
  const ambiguous = amendPlan(AMEND_PLAN, [{ kind: 'modify', target: 'SC1', current: '| none |', proposed: '| T2 |' }]);
  assert.ok(!ambiguous.ok && /exactly once in the plan; found 3/.test(ambiguous.error));
});

test('amend plan rejects unknown targets', () => {
  const result = amendPlan(AMEND_PLAN, [{ kind: 'modify', target: 'T9', current: '[SC1] Part 1 works', proposed: '[SC1] Part 1 works fast' }]);
  assert.ok(!result.ok && /T9/.test(result.error));
});

test('amend plan infers no gate from objective or manifest text', () => {
  const intent = amendPlan(AMEND_PLAN, [{ kind: 'modify', target: 'T1', current: 'deliver three parts.', proposed: 'deliver four parts.' }]);
  assert.ok(intent.ok && !('gates' in intent), 'semantic approval comes from the reconciliation attestation');
});

// SECTION: replacementPlan

test('replacement plan accepts a parsed plan with its governed hash', () => {
  const hash = `sha256:${'a'.repeat(64)}`;
  const revised = replacementPlan({ hash, plan: AMEND_PLAN, defects: [] });
  assert.ok(revised.ok && revised.hash === hash && revised.text === AMEND_PLAN.governedText);
});

test('replacement plan rejects lint defects and invalid hashes', () => {
  const defective = replacementPlan({ hash: `sha256:${'a'.repeat(64)}`, plan: AMEND_PLAN, defects: [{ code: 'cycle', message: 'T1 -> T2 -> T1' }] });
  assert.ok(!defective.ok && /cycle/.test(defective.error));
  const hashless = replacementPlan({ hash: 'nope', plan: AMEND_PLAN, defects: [] });
  assert.ok(!hashless.ok && /hash/.test(hashless.error));
});

// SECTION: In-run revision arrives as AMEND

test('in-run plan REVISE is rejected with a pointer to AMEND', () => {
  const { result } = running();
  assert.match(validateImplement(result.state, { type: 'REVISE', artifact: 'plan', reason: 'blocked-by-plan', evidence: 'stalled check' }) ?? '', /AMEND/);
  const root: RootState = { tag: 'implement', run: { verb: 'implement', argument: 'x.plan.md', slug: 'feature' }, child: approvalState() };
  assert.match(rootMachine.validate!(root, { type: 'REVISE', artifact: 'plan', reason: 'blocked-by-plan', evidence: 'stalled check' }) ?? '', /AMEND/);
});

// SECTION: SC20 — plan revision scope requests use request and request-user

test('plan revision request approved by orchestrator', () => {
  let { result, sim, trace } = running();
  const handle = t1(result).handle;
  result = host(result, request, sim, trace);
  assert.equal(result.state.tag, 'request-decision');
  assert.equal(implementData(result.state)['kind'], 'request');
  const approve = { type: 'DECISION', kind: 'request', answer: { by: 'orchestrator', action: 'approve', rationale: 'The helper belongs to T1.' } } as Event;
  assert.match(validateImplement(result.state, approve as never) ?? '', /AMEND/, 'approving out-of-scope paths needs AMEND');
  result = host(result, amend(WIDEN_T1), sim, trace);
  assert.equal(result.state.tag, 'tasks', 'the AMEND answers the request');
  assert.ok(t1Paths(result).includes('src/shared.ts'));
  result = host(result, { ...request, attempt: t1(result).attempt } as Event, sim, trace);
  assert.equal(result.state.tag, 'request-decision');
  assert.equal(validateImplement(result.state, approve as never), null);
  result = host(result, approve, sim, trace);
  assert.equal(result.state.tag, 'tasks');
  assert.equal(record(result, 'T1')?.status, 'running');
  assert.equal(t1(result).handle, handle, 'the writer stays live across the ruling');
});

test('plan revision request escalates to user', () => {
  let { result, sim, trace } = running();
  const handle = t1(result).handle;
  result = host(result, { ...request, paths: ['src/a.ts'] } as Event, sim, trace);
  result = host(result, { type: 'DECISION', kind: 'request', answer: { by: 'orchestrator', action: 'escalate', rationale: 'The approach change needs the user.' } } as Event, sim, trace);
  assert.equal(result.state.tag, 'request-decision');
  assert.equal(implementData(result.state)['kind'], 'request-user');
  const requestId = implementData(result.state)['requestId'];
  assert.ok(validateImplement(result.state, { type: 'DECISION', kind: 'request', answer: { by: 'orchestrator', action: 'approve', rationale: 'x' } } as never), 'the orchestrator cannot rule an escalated request');
  assert.match(validateImplement(result.state, { type: 'DECISION', kind: 'request-user', answer: { by: 'user', requestId, choice: 'accept', quote: '' } } as never) ?? '', /quote/);
  result = host(result, { type: 'DECISION', kind: 'request-user', answer: { by: 'user', requestId, choice: 'accept', quote: 'Yes, go ahead.' } } as Event, sim, trace);
  assert.equal(result.state.tag, 'tasks');
  assert.equal(record(result, 'T1')?.status, 'running');
  assert.equal(t1(result).handle, handle);
});
