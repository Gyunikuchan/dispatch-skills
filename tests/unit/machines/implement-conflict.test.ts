import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effect, Event } from '../../../skills/dispatch/scripts/core/types.ts';
import { implementData, initialImplement, stepImplement, validateImplement, type ImplementState } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { AMEND_PLAN } from './fixtures/implement-amend.ts';
import { answer, host, launch, record, run, start, submit, type Result, type Sim, type Trace } from './fixtures/implement-tasks.ts';

// SECTION: Helpers — T2 conflicts with accepted T1 on both tasks' files.

const CONFLICT_PATHS = ['src/a.ts', 'src/b.ts'];
type Run = { result: Result; sim: Sim; trace: Trace; failing: Set<string> };

/** Pumps like the shared fixture but reports the conflict on files that both tasks own. */
function pump(result: Result, sim: Sim, trace: Trace): Result {
  for (let guard = 0; result.effects.length; guard++) {
    assert.ok(guard < 200, 'driver loop did not settle');
    const effect = result.effects[0]!;
    const event = conflictAnswer(result.state, effect, sim);
    if (!event) return result;
    trace.effects.push(effect);
    trace.events.push(event);
    result = stepImplement(result.state, event);
  }
  return result;
}
function conflictAnswer(state: ImplementState, effect: Effect, sim: Sim): Event | null {
  const event = answer(state, effect, sim);
  if (effect.kind === 'checkout' && effect.op === 'integrate' && effect.input['task'] === 'T2') return { type: 'CHECKOUT_DONE', effectId: effect.id, op: effect.op, result: { conflict: true, paths: CONFLICT_PATHS, detail: 'both modified' } };
  return event;
}
function send(state: Run, event: Event): Result {
  assert.equal(validateImplement(state.result.state, event as never), null);
  state.trace.events.push(event);
  return state.result = pump(stepImplement(state.result.state, event), state.sim, state.trace);
}

function conflicted(): Run {
  const failing = new Set<string>();
  const sim: Sim = { plan: AMEND_PLAN, resolve: (input) => ({ revision: `r-${String(input['attempt'])}`, paths: CONFLICT_PATHS }), verify: (_purpose, command) => failing.has(command) ? { exit: 1, failedTests: ['test:broken'] } : { exit: 0 } };
  let { result, trace } = start(2, sim);
  result = launch(result, sim, trace);
  result = submit(result, 'T1', sim, trace);
  const state: Run = { result, sim, trace, failing };
  const t2 = (result.state.tag === 'tasks' ? implementData(result.state)['tasks'] as { task: string; attempt: number; signature: string; handle: string; model: string; envelopePath: string; briefHash: string }[] : []).find((slot) => slot.task === 'T2')!;
  send(state, { type: 'WRITE_RECEIPT', status: 'submitted', task: 'T2', attempt: t2.attempt, signature: t2.signature, handle: t2.handle, model: t2.model, envelopePath: t2.envelopePath, briefHash: t2.briefHash });
  return state;
}
const resolveDecision: Event = { type: 'DECISION', kind: 'integration-conflict', answer: { by: 'orchestrator', action: 'resolve', rationale: 'Merge both edits.' } };
const checkouts = (trace: Trace, op: string) => trace.effects.filter((effect): effect is Extract<Effect, { kind: 'checkout' }> => effect.kind === 'checkout' && effect.op === op);
const verifies = (trace: Trace, from: number) => trace.effects.slice(from).filter((effect): effect is Extract<Effect, { kind: 'verify' }> => effect.kind === 'verify');

// SECTION: SC8

test('conflict emits integration-conflict decision', () => {
  const { result } = conflicted();
  assert.equal(result.state.tag, 'integration-conflict');
  const data = implementData(result.state);
  assert.equal(data['kind'], 'integration-conflict');
  assert.deepEqual(data['options'], ['resolve', 'discard']);
  assert.deepEqual([data['task'], data['paths'], data['candidate'], data['head'], data['worktree']], ['T2', CONFLICT_PATHS, 'c-T2', 'i-T1', 'run/wt/integration']);
  const tasks = data['tasks'] as { task: string; briefHash: string | null; criteria: { id: string }[] }[];
  assert.deepEqual(tasks.map((row) => [row.task, row.criteria.map((item) => item.id), !!row.briefHash]), [['T2', ['SC2'], true], ['T1', ['SC1'], true]]);
});

test('resolve reverifies touched tasks', () => {
  const state = conflicted();
  const from = state.trace.effects.length;
  const result = send(state, resolveDecision);
  const [resolve] = checkouts(state.trace, 'resolve');
  assert.deepEqual(resolve?.input['permitted'], ['src/a.ts', 'src/b.ts', 'tests/part-1.test.ts']);
  const [verify] = verifies(state.trace, from);
  assert.deepEqual(verify?.commands.map((row) => row['command']).sort(), ['node --test tests/part-1.test.ts', 'node --test tests/part-2.test.ts']);
  assert.equal(verify?.cwd, 'run/wt/integration');
  assert.equal(record(result, 'T2')?.status, 'accepted');
  assert.equal(record(result, 'T2')?.integrated, 'r-1');
});

test('resolve involves an accepted task that owns the conflict path only through scope admission', () => {
  const state = conflicted();
  const current = state.result.state;
  assert.equal(current.tag, 'integration-conflict');
  if (current.tag !== 'integration-conflict') return;
  const t1 = current.c.tasks['T1']!;
  state.result = { state: { ...current, c: { ...current.c, tasks: { ...current.c.tasks, T1: { ...t1, admittedPaths: ['README.md'] } } }, conflict: { ...current.conflict, paths: ['README.md'] } }, effects: [] };
  state.sim.resolve = (input) => ({ revision: `r-${String(input['attempt'])}`, paths: ['README.md'] });
  const from = state.trace.effects.length;
  send(state, resolveDecision);
  const [resolve] = checkouts(state.trace, 'resolve');
  assert.ok(((resolve?.input as Record<string, unknown> | undefined)?.['tasks'] as string[]).includes('T1'));
  assert.ok((resolve?.input['permitted'] as string[]).includes('src/a.ts'));
  const [verify] = verifies(state.trace, from);
  assert.ok(verify?.commands.some((row) => row['command'] === 'node --test tests/part-1.test.ts'));
});

test('resolve check failure returns decision', () => {
  const state = conflicted();
  state.failing.add('node --test tests/part-1.test.ts');
  const result = send(state, resolveDecision);
  assert.equal(result.state.tag, 'integration-conflict');
  const data = implementData(result.state);
  assert.deepEqual([data['attempt'], data['head']], [1, 'r-1']);
  assert.match((data['evidence'] as string[]).join(' '), /attempt 1 at r-1 failed checks: node --test tests\/part-1\.test\.ts/);
  assert.equal(record(result, 'T2')?.status, 'submitted');
});

test('repair after failed check resolves on replay', () => {
  const state = conflicted();
  state.failing.add('node --test tests/part-1.test.ts');
  send(state, resolveDecision);
  state.failing.clear();
  const result = send(state, resolveDecision);
  const repair = checkouts(state.trace, 'resolve').at(-1) as { input: Record<string, unknown> } | undefined;
  assert.deepEqual([repair?.input['attempt'], repair?.input['expected']], [2, 'r-1']);
  assert.equal(record(result, 'T2')?.integrated, 'r-2');
  let replay = stepImplement(initialImplement(), run(2, 0));
  for (const event of state.trace.events) replay = stepImplement(replay.state, event);
  assert.deepEqual(replay.state, result.state);
});

test('discard requires user-gated amendment', () => {
  const state = conflicted();
  const discard = (amendment?: string): Event => ({ type: 'DECISION', kind: 'integration-conflict', answer: { by: 'orchestrator', action: 'discard', rationale: 'Drop T2.', ...(amendment ? { amendment } : {}) } });
  assert.match(validateImplement(state.result.state, discard() as never) ?? '', /user-gated AMEND/);
  const removeT2 = [
    { kind: 'remove', target: 'T2', current: '| T2 | Part two | Deliver part two. | none | SC2 |' },
    { kind: 'remove', target: 'SC2', current: '- [SC2] Part 2 works\n  - Changes: src/b.ts\n  - Verify: `node --test tests/part-2.test.ts`\n  - Evidence: verify\n  - Test rationale: pins part 2.\n' },
    { kind: 'remove', target: 'T2', current: '### T2 — Part two\n#### [MODIFY] src/b.ts\n- Changes: part two.\n\n' },
  ];
  const amend = (by?: { by: 'user'; quote: string }) => ({ type: 'AMEND', delta: removeT2, notify: [], rationale: 'T2 is no longer wanted.', ...(by ? { by } : {}) }) as unknown as Event;
  assert.match(validateImplement(state.result.state, amend() as never) ?? '', /user's quote: discards conflicted integration of T2/);
  send(state, amend({ by: 'user', quote: 'Drop part two.' }));
  assert.equal(state.result.state.tag, 'integration-conflict');
  const result = send(state, discard('amend-1'));
  assert.deepEqual(checkouts(state.trace, 'reset').at(-1)?.input, { name: 'integration', revision: 'i-T1' });
  assert.equal(record(result, 'T2'), undefined);
  assert.equal(record(result, 'T1')?.status, 'accepted');
});

// SECTION: Resolution delta selects verification

/** T1 and T3 accepted, then T2 conflicts on its own files; the resolution returns `paths`. */
function conflictedAfterT3(paths: string[], plan = AMEND_PLAN): Run {
  const failing = new Set<string>();
  const sim: Sim = { plan, resolve: (input) => ({ revision: `r-${String(input['attempt'])}`, paths }), verify: (_purpose, command) => failing.has(command) ? { exit: 1, failedTests: ['test:broken'] } : { exit: 0 } };
  let { result, trace } = start(3, sim);
  result = launch(result, sim, trace);
  result = submit(result, 'T1', sim, trace);
  result = submit(result, 'T3', sim, trace);
  const state: Run = { result, sim, trace, failing };
  send(state, (() => {
    const t2 = (implementData(state.result.state)['tasks'] as { task: string; attempt: number; signature: string; handle: string; model: string; envelopePath: string; briefHash: string }[]).find((slot) => slot.task === 'T2')!;
    return { type: 'WRITE_RECEIPT', status: 'submitted', task: 'T2', attempt: t2.attempt, signature: t2.signature, handle: t2.handle, model: t2.model, envelopePath: t2.envelopePath, briefHash: t2.briefHash } as Event;
  })());
  assert.equal(state.result.state.tag, 'integration-conflict');
  return state;
}

test('resolve refuses resolution delta outside involved tasks', () => {
  const state = conflictedAfterT3([]);
  // Emulates checkout: a delta outside `permitted` is refused before commit.
  state.sim.resolve = (input) => {
    const outside = ['src/b.ts', 'src/c.ts'].filter((file) => !(input['permitted'] as string[]).includes(file));
    return outside.length ? { revision: String(input['expected']), refused: 'out-of-scope', paths: outside, detail: 'outside' } : { revision: 'r-1', paths: ['src/b.ts', 'src/c.ts'] };
  };
  const from = state.trace.effects.length;
  const result = send(state, resolveDecision);
  assert.ok(!(checkouts(state.trace, 'resolve').at(-1)!.input['permitted'] as string[]).includes('src/c.ts'));
  assert.equal(verifies(state.trace, from).length, 0);
  assert.equal(result.state.tag, 'integration-conflict');
  assert.match((implementData(result.state)['evidence'] as string[]).join(' '), /refused \(out-of-scope\).*src\/c\.ts/);
});

test('resolve runs integration criterion on resolution paths', () => {
  const sc4 = { ...AMEND_PLAN.criteria[0]!, id: 'SC4', title: 'Parts integrate', changes: ['src/b.ts', 'src/c.ts'], verify: [{ command: 'node --test tests/part-4.test.ts', final: false }], evidence: 'verify' as const, testRationale: 'pins integration.' };
  const plan = { ...AMEND_PLAN, criteria: [...AMEND_PLAN.criteria, sc4] };
  const state = conflictedAfterT3(['src/b.ts'], plan);
  state.failing.add('node --test tests/part-4.test.ts');
  const from = state.trace.effects.length;
  const result = send(state, resolveDecision);
  const [verify] = verifies(state.trace, from);
  assert.ok(verify?.commands.some((row) => row['command'] === 'node --test tests/part-4.test.ts'));
  assert.equal(result.state.tag, 'integration-conflict');
});

// SECTION: Round-2 fixes — discard binding and cumulative repair checks

test('discard rejects unrelated user-gated amendment', () => {
  const state = conflicted();
  const cosmetic = { kind: 'modify', target: 'src/b.ts', current: '- Changes: part two.', proposed: '- Changes: part two, reworded.' };
  send(state, { type: 'AMEND', delta: [cosmetic], notify: [], rationale: 'Reword T2.', by: { by: 'user', quote: 'Reword it.' } } as unknown as Event);
  assert.equal(state.result.state.tag, 'integration-conflict');
  const discard = { type: 'DECISION', kind: 'integration-conflict', answer: { by: 'orchestrator', action: 'discard', rationale: 'Drop T2.', amendment: 'amend-1' } } as Event;
  assert.match(validateImplement(state.result.state, discard as never) ?? '', /removed or rescoped the conflicting work/);
});

test('repair reruns unresolved check outside its own delta', () => {
  const sc4 = { ...AMEND_PLAN.criteria[0]!, id: 'SC4', title: 'Parts integrate', changes: ['src/a.ts'], verify: [{ command: 'node --test tests/part-4.test.ts', final: false }], evidence: 'verify' as const, testRationale: 'pins integration.' };
  const state = conflictedAfterT3([], { ...AMEND_PLAN, criteria: [...AMEND_PLAN.criteria, sc4] });
  state.sim.resolve = (input) => ({ revision: `r-${String(input['attempt'])}`, paths: input['attempt'] === 1 ? ['src/a.ts', 'src/b.ts'] : ['src/b.ts'] });
  state.failing.add('node --test tests/part-4.test.ts');
  send(state, resolveDecision);
  assert.equal(state.result.state.tag, 'integration-conflict');
  const from = state.trace.effects.length;
  const result = send(state, resolveDecision);
  const commands = verifies(state.trace, from).flatMap((effect) => effect.commands.map((row) => row['command']));
  assert.ok(commands.includes('node --test tests/part-4.test.ts'), 'SC4 check still failing must rerun');
  assert.equal(result.state.tag, 'integration-conflict');
});

// SECTION: Resolve effect failure keeps the conflict

/** Rules `resolve` and fails its checkout effect without pumping; returns the failed effect. */
function failResolve(state: Run): Extract<Effect, { kind: 'checkout' }> {
  assert.equal(validateImplement(state.result.state, resolveDecision as never), null);
  const ruled = stepImplement(state.result.state, resolveDecision);
  const effect = ruled.effects[0] as Extract<Effect, { kind: 'checkout' }>;
  assert.equal(effect.op, 'resolve');
  state.result = stepImplement(ruled.state, { type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: 'boom' });
  return effect;
}

test('resolve failure before commit returns conflict decision', () => {
  const state = conflicted();
  const failed = failResolve(state);
  assert.equal(state.result.state.tag, 'integration-conflict');
  const data = implementData(state.result.state);
  assert.deepEqual([data['candidate'], data['head'], data['attempt']], ['c-T2', 'i-T1', 0]);
  assert.match((data['evidence'] as string[]).join(' '), /attempt 1 failed: checkout resolve failed: io: boom/);
  assert.equal(record(state.result, 'T2')?.status, 'submitted');
  const result = send(state, resolveDecision);
  const retry = checkouts(state.trace, 'resolve').at(-1)!;
  assert.equal(retry.id, failed.id);
  assert.deepEqual(retry.input, failed.input);
  assert.equal(record(result, 'T2')?.integrated, 'r-1');
});

test('resolve failure after commit recovers the committed resolution', () => {
  const state = conflicted();
  const failed = failResolve(state);
  state.sim.resolve = (input) => ({ revision: `r-${String(input['attempt'])}`, paths: CONFLICT_PATHS, reused: true });
  const result = send(state, resolveDecision);
  assert.equal(checkouts(state.trace, 'resolve').at(-1)?.id, failed.id);
  assert.equal(record(result, 'T2')?.status, 'accepted');
  assert.equal(record(result, 'T2')?.integrated, 'r-1');
  assert.equal(checkouts(state.trace, 'reset').length, 0);
});

test('resolve rejected after amendment removes conflicting task', () => {
  const state = conflicted();
  const removeT2 = [
    { kind: 'remove', target: 'T2', current: '| T2 | Part two | Deliver part two. | none | SC2 |' },
    { kind: 'remove', target: 'SC2', current: '- [SC2] Part 2 works\n  - Changes: src/b.ts\n  - Verify: `node --test tests/part-2.test.ts`\n  - Evidence: verify\n  - Test rationale: pins part 2.\n' },
    { kind: 'remove', target: 'T2', current: '### T2 — Part two\n#### [MODIFY] src/b.ts\n- Changes: part two.\n\n' },
  ];
  send(state, { type: 'AMEND', delta: removeT2, notify: [], rationale: 'T2 is no longer wanted.', by: { by: 'user', quote: 'Drop part two.' } } as unknown as Event);
  assert.equal(state.result.state.tag, 'integration-conflict');
  assert.deepEqual(implementData(state.result.state)['options'], ['discard']);
  assert.match(validateImplement(state.result.state, resolveDecision as never) ?? '', /discard is the only continuation/);
});

// SECTION: Round-4 fixes — scope-bound retries, prerequisite AMENDs, discard failure

const NARROW_T2 = [
  { kind: 'modify', target: 'T2', current: '#### [MODIFY] src/b.ts\n- Changes: part two.', proposed: '#### [NEW] src/d.ts\n- Purpose: part two.' },
  { kind: 'modify', target: 'SC2', current: '  - Changes: src/b.ts', proposed: '  - Changes: src/d.ts' },
];
const REMOVE_T2 = [
  { kind: 'remove', target: 'T2', current: '| T2 | Part two | Deliver part two. | none | SC2 |' },
  { kind: 'remove', target: 'SC2', current: '- [SC2] Part 2 works\n  - Changes: src/b.ts\n  - Verify: `node --test tests/part-2.test.ts`\n  - Evidence: verify\n  - Test rationale: pins part 2.\n' },
  { kind: 'remove', target: 'T2', current: '### T2 — Part two\n#### [MODIFY] src/b.ts\n- Changes: part two.\n\n' },
];
const discardAmend1 = { type: 'DECISION', kind: 'integration-conflict', answer: { by: 'orchestrator', action: 'discard', rationale: 'Drop T2 work.', amendment: 'amend-1' } } as Event;

test('resolve retry after scope-narrowing amendment refuses recovered out-of-scope commit', () => {
  const state = conflicted();
  const failed = failResolve(state);
  send(state, { type: 'AMEND', delta: NARROW_T2, notify: [], rationale: 'Move part two.', by: { by: 'user', quote: 'Move it.' } } as unknown as Event);
  assert.equal(state.result.state.tag, 'integration-conflict');
  state.sim.resolve = (input) => ({ revision: `r-${String(input['attempt'])}`, paths: CONFLICT_PATHS, reused: true });
  const result = send(state, resolveDecision);
  const retry = checkouts(state.trace, 'resolve').at(-1)!;
  assert.deepEqual([retry.id, retry.input], [failed.id, failed.input]);
  assert.equal(result.state.tag, 'integration-conflict');
  assert.notEqual(record(result, 'T2')?.status, 'accepted');
  const data = implementData(result.state);
  assert.deepEqual(data['options'], ['discard']);
  assert.match((data['evidence'] as string[]).join(' '), /outside the current scope: src\/b\.ts/);
  assert.match(validateImplement(result.state, resolveDecision as never) ?? '', /discard is the only continuation/);
  send(state, discardAmend1);
  assert.deepEqual(checkouts(state.trace, 'reset').at(-1)?.input, { name: 'integration', revision: 'i-T1' });
});

test('amendment adding a prerequisite to the conflicting task is rejected', () => {
  const state = conflicted();
  const amend = { type: 'AMEND', delta: [{ kind: 'modify', target: 'T2', current: '| T2 | Part two | Deliver part two. | none | SC2 |', proposed: '| T2 | Part two | Deliver part two. | T3 | SC2 |' }], notify: [], rationale: 'T2 needs T3.', by: { by: 'user', quote: 'Order them.' } } as unknown as Event;
  assert.match(validateImplement(state.result.state, amend as never) ?? '', /before changing T2 prerequisites/);
});

test('discard failure keeps the conflict and retries', () => {
  const state = conflicted();
  send(state, { type: 'AMEND', delta: REMOVE_T2, notify: [], rationale: 'Drop T2.', by: { by: 'user', quote: 'Drop part two.' } } as unknown as Event);
  const ruled = stepImplement(state.result.state, discardAmend1);
  const effect = ruled.effects[0] as Extract<Effect, { kind: 'checkout' }>;
  assert.equal(effect.op, 'reset');
  state.result = stepImplement(ruled.state, { type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: 'locked' });
  assert.equal(state.result.state.tag, 'integration-conflict');
  assert.match((implementData(state.result.state)['evidence'] as string[]).join(' '), /Discard failed: checkout discard failed: io: locked/);
  send(state, discardAmend1);
  assert.deepEqual(checkouts(state.trace, 'reset').at(-1)?.input, { name: 'integration', revision: 'i-T1' });
  assert.notEqual(state.result.state.tag, 'integration-conflict');
});

// SECTION: Round-5 fixes — retained resolution delta

test('repair after scope-narrowing amendment refuses retained out-of-scope path', () => {
  const state = conflicted();
  state.failing.add('node --test tests/part-1.test.ts');
  send(state, resolveDecision);
  assert.equal(state.result.state.tag, 'integration-conflict');
  send(state, { type: 'AMEND', delta: NARROW_T2, notify: [], rationale: 'Move part two.', by: { by: 'user', quote: 'Move it.' } } as unknown as Event);
  state.failing.clear();
  // The repair changes only an allowed T1 file; attempt 1's src/b.ts commit stays in the retained delta.
  // Production checkout refuses before committing when the retained delta leaves the permitted set.
  state.sim.resolve = (input) => ({ refused: 'out-of-scope', detail: 'retained resolution changes paths outside permitted', paths: ['src/b.ts'], retained: ['src/b.ts'] });
  const result = send(state, resolveDecision);
  assert.equal((checkouts(state.trace, 'resolve').at(-1)?.input as Record<string, unknown> | undefined)?.['base'], 'i-T1');
  assert.equal(result.state.tag, 'integration-conflict');
  assert.notEqual(record(result, 'T2')?.status, 'accepted');
  assert.match((implementData(result.state)['evidence'] as string[]).join(' '), /out-of-scope.*src\/b\.ts/);
  assert.match(validateImplement(result.state, resolveDecision as never) ?? '', /discard is the only continuation/);
  // The narrowing amendment dropped src/b.ts, so it authorizes the discard.
  assert.equal(validateImplement(result.state, discardAmend1 as never), null);
});

test('working-tree out-of-scope refusal stays repairable by resolve', () => {
  const state = conflicted();
  // An untracked temporary file in the integration tree: checkout refuses it, but nothing out of scope is committed.
  state.sim.resolve = (input) => ({ revision: String(input['expected']), refused: 'out-of-scope', paths: ['tmp.log'], retained: [], detail: 'outside' });
  let result = send(state, resolveDecision);
  assert.equal(result.state.tag, 'integration-conflict');
  assert.match(validateImplement(result.state, resolveDecision as never) ?? '', /^$/);
  // The orchestrator removes the file; the next resolve commits.
  state.sim.resolve = (input) => ({ revision: `r-${String(input['attempt'])}`, paths: CONFLICT_PATHS });
  result = send(state, resolveDecision);
  assert.notEqual(result.state.tag, 'integration-conflict');
  assert.equal(checkouts(state.trace, 'reset').length, 0);
});
