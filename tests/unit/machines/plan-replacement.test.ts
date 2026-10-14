import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Event, PlanReconciliation } from '../../../skills/dispatch/scripts/core/types.ts';
import { implementData, stepImplement, validateImplement, type Context } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { AMEND_PLAN, replacementText } from './fixtures/implement-amend.ts';
import { HASH, answer, host, launch, record, slots, start, submit, type Result, type Sim, type Trace } from './fixtures/implement-tasks.ts';

// SECTION: Helpers — REPLACE_PLAN binds a whole revised plan file through the same reconcile operation as AMEND.

const PATH = 'session/x.replace-1.plan.md';
const T1_NOTE = ['- Changes: part one.', '- Changes: part one, tidied.'] as const;
const T3_REQUIRES_T1 = ['- Prerequisites: none\n- Criteria: SC3', '- Prerequisites: T1\n- Criteria: SC3'] as const;
const summary = (over: Partial<PlanReconciliation> = {}): PlanReconciliation => ({ retained: ['T1', 'T2', 'T3'], changed: [], added: [], retired: [], intentChanged: false, dependencyChanged: false, ...over });
const replace = (expectedHash: string, reconciliation: PlanReconciliation, extra: Record<string, unknown> = {}): Event =>
  ({ type: 'REPLACE_PLAN', path: PATH, expectedHash, rationale: 'The plan changed mid-run.', notify: [], reconciliation, ...extra }) as unknown as Event;

function running(replacement?: ReturnType<typeof replacementText>): { result: Result; sim: Sim; trace: Trace } {
  const sim: Sim = { plan: AMEND_PLAN, ...(replacement ? { replacements: { [PATH]: replacement } } : {}) };
  const { result, trace } = start(3, sim);
  return { result: launch(result, sim, trace), sim, trace };
}
const ctx = (result: Result): Context => { assert.ok('c' in result.state && result.state.c); return result.state.c as Context; };
/** Steps without the fixture's validation so a rejected parse result returns to the write frame. */
function step(result: Result, event: Event, sim: Sim, trace: Trace): Result {
  trace.events.push(event);
  let next = stepImplement(result.state, event);
  const effect = next.effects[0];
  if (effect?.kind === 'parse-artifact') {
    const replacement = sim.replacements?.[effect.path];
    next = stepImplement(next.state, { type: 'ARTIFACT_PARSED', effectId: effect.id, kind: 'plan', hash: replacement?.hash ?? HASH, parsed: replacement?.plan ?? AMEND_PLAN, defects: (replacement?.defects ?? []) as never });
  }
  return next;
}

// SECTION: Stale and malformed revisions

test('replacement-contract: stale revision leaves work and plan unchanged', () => {
  const revised = replacementText(T1_NOTE);
  const { result } = running(revised);
  const before = ctx(result);
  const error = validateImplement(result.state, replace(`sha256:${'b'.repeat(64)}`, summary(), { notify: [{ task: 'T1', notice: 'Note reworded.' }] }) as never);
  assert.match(error ?? '', /expectedHash: the run is bound to/);
  assert.equal(ctx(result).planHash, before.planHash);
  assert.deepEqual(ctx(result).tasks, before.tasks);
});

test('replacement-contract: cyclic or malformed graph is rejected without mutation', () => {
  const revised = { ...replacementText(T1_NOTE), defects: [{ code: 'cycle', message: 'T1 -> T3 -> T1' }] };
  let { result, sim, trace } = running(revised);
  const before = ctx(result);
  result = step(result, replace(HASH, summary()), sim, trace);
  assert.equal(result.state.tag, 'tasks');
  assert.match(String((implementData(result.state)['planRejection'] as { error: string }).error), /cycle/);
  assert.deepEqual([ctx(result).planHash, ctx(result).tasks, ctx(result).amendments], [before.planHash, before.tasks, before.amendments]);
});

// SECTION: Reconciliation summary

test('replacement-contract: incomplete reconciliation is rejected', () => {
  const revised = replacementText(T1_NOTE);
  let { result, sim, trace } = running(revised);
  result = step(result, replace(HASH, summary({ retained: ['T2', 'T3'] }), { notify: [{ task: 'T1', notice: 'Note reworded.' }] }), sim, trace);
  assert.match(String((implementData(result.state)['planRejection'] as { error: string }).error), /reconciliation\.retained: expected \[T1, T2, T3\] for the current task records; got \[T2, T3\]/);
  assert.equal(ctx(result).planHash, HASH);
});

test('replacement-contract: unauthorized running scope change is rejected', () => {
  const revised = replacementText(['  - Changes: src/b.ts\n', '  - Changes: src/b.ts, src/shared.ts\n'], ['- Changes: part two.\n', '- Changes: part two.\n#### [MODIFY] src/shared.ts\n- Changes: shared.\n']);
  let { result, sim, trace } = running(revised);
  result = step(result, replace(HASH, summary({ retained: ['T1', 'T3'], changed: ['T2'] })), sim, trace);
  assert.match(String((implementData(result.state)['planRejection'] as { error: string }).error), /changes running task T2; name it in notify/);
  assert.equal(record(result, 'T2')?.handle, 'agent-T2-1');
});

test('replacement-contract: attestation, not plan text, gates an intent change', () => {
  const revised = replacementText(['deliver three parts.', 'deliver four parts.']);
  const { result } = running(revised);
  assert.equal(validateImplement(result.state, replace(HASH, summary()) as never), null, 'objective text alone infers no gate');
  let { result: gated, sim, trace } = running(revised);
  gated = step(gated, replace(HASH, summary({ intentChanged: true })), sim, trace);
  assert.match(String((implementData(gated.state)['planRejection'] as { error: string }).error), /user's quote: attested intent change/);
  gated = host(gated, replace(HASH, summary({ intentChanged: true }), { by: { by: 'user', quote: 'Make it four.' } }), sim, trace);
  assert.equal(ctx(gated).planHash, revised.hash);
  assert.equal(ctx(gated).amendments.at(-1)?.reconciliation?.intentChanged, true);
});

// SECTION: Agreement with AMEND and immutable revisions

test('replacement-contract: replacement and AMEND reconcile to the same records', () => {
  const revised = replacementText(T1_NOTE, T3_REQUIRES_T1);
  const notify = [{ task: 'T1', notice: 'Note reworded.' }, { task: 'T3', notice: 'T3 now waits for T1.' }];
  const viaReplace = running(revised);
  const replaced = host(viaReplace.result, replace(HASH, summary({ retained: ['T1', 'T2'], changed: ['T3'] }), { notify }), viaReplace.sim, viaReplace.trace);
  const viaAmend = running();
  const delta = [
    { kind: 'modify', target: 'src/a.ts', current: T1_NOTE[0], proposed: T1_NOTE[1] },
    { kind: 'modify', target: 'T3', current: T3_REQUIRES_T1[0], proposed: T3_REQUIRES_T1[1] },
  ];
  const amended = host(viaAmend.result, { type: 'AMEND', delta, notify, rationale: 'The plan changed mid-run.' } as unknown as Event, viaAmend.sim, viaAmend.trace);
  assert.equal(ctx(replaced).planHash, ctx(amended).planHash);
  const shape = (c: Context) => Object.fromEntries(Object.entries(c.tasks).map(([id, row]) => [id, { status: row.status, signature: row.signature, handle: row.handle }]));
  assert.deepEqual(shape(ctx(replaced)), shape(ctx(amended)));
  assert.deepEqual(ctx(replaced).amendments.at(-1)?.reconciliation, ctx(amended).amendments.at(-1)?.reconciliation);
});

test('replacement-contract: prior plan revision stays immutable', () => {
  const revised = replacementText(T1_NOTE);
  let { result, sim, trace } = running(revised);
  const priorPath = ctx(result).planPath;
  result = host(result, replace(HASH, summary(), { notify: [{ task: 'T1', notice: 'Note reworded.' }] }), sim, trace);
  const revision = ctx(result).amendments.at(-1)!;
  assert.deepEqual([revision.id, revision.kind, revision.path, revision.beforeHash, revision.afterHash], ['replace-1', 'replace', PATH, HASH, revised.hash]);
  assert.equal(ctx(result).planPath, PATH);
  assert.notEqual(priorPath, PATH);
  assert.match(validateImplement(result.state, replace(revised.hash, summary(), { path: priorPath }) as never) ?? '', /earlier plan revisions stay immutable/);
  assert.match(validateImplement(result.state, replace(revised.hash, summary()) as never) ?? '', /earlier plan revisions stay immutable/);
});

test('replacement-contract: new prerequisite of accepted work creates validation obligations', () => {
  const revised = replacementText(T3_REQUIRES_T1);
  let { result, sim, trace } = running(revised);
  result = submit(result, 'T3', sim, trace);
  assert.equal(record(result, 'T3')?.status, 'accepted');
  result = host(result, replace(HASH, summary({ retained: ['T1', 'T2'], changed: ['T3'] })), sim, trace);
  assert.equal(record(result, 'T3')?.status, 'accepted', 'accepted work stays accepted');
  assert.equal(record(result, 'T3')?.integrated, 'i-T3');
  assert.deepEqual(Object.keys(ctx(result).obligations ?? {}), ['SC3']);
  assert.equal(ctx(result).obligations?.['SC3']?.observationId, 'replace-1');
});

test('replacement-contract: accepted consumer checks wait for its new producer and retain failed work', () => {
  const revised = replacementText(T3_REQUIRES_T1, ['node --test tests/part-3.test.ts', 'node --test tests/part-3-revised.test.ts']);
  let { result, sim, trace } = running(revised);
  result = submit(result, 'T3', sim, trace);
  const accepted = record(result, 'T3')!;
  const checks = trace.effects.length;
  result = host(result, replace(HASH, summary({ retained: ['T1', 'T2'], changed: ['T3'] })), sim, trace);
  assert.equal(result.state.tag, 'tasks');
  assert.deepEqual(ctx(result).reverifyQueue, ['T3']);
  assert.equal(trace.effects.slice(checks).some((effect) => effect.kind === 'verify'), false, 'unfinished producer blocks retained checks');
  sim.verify = (_purpose, command) => ({ exit: command.includes('part-3-revised') ? 1 : 0 });
  result = submit(result, 'T1', sim, trace);
  assert.equal(result.state.tag, 'failure', 'failed retained checks need an explicit ruling');
  for (const key of ['status', 'attempt', 'failures', 'worktree', 'integrated', 'candidate'] as const) assert.equal(record(result, 'T3')![key], accepted[key], key);
  assert.deepEqual(ctx(result).reverifyQueue, ['T3']);
  const retryStart = trace.effects.length;
  sim.verify = () => ({ exit: 0 });
  result = host(result, { type: 'DECISION', kind: 'failure', answer: { by: 'orchestrator', action: 'retry', rationale: 'Repair verified on retained integration.' } }, sim, trace);
  assert.equal(result.state.tag, 'tasks');
  assert.deepEqual(ctx(result).reverifyQueue, []);
  assert.equal(trace.effects.slice(retryStart).some((effect) => effect.kind === 'checkout' && effect.op === 'task'), false, 'retry rechecks without a replacement writer');
  assert.equal(record(result, 'T3')?.attempt, accepted.attempt);
});

test('replacement-contract: accepted producer checks precede retained consumer checks', () => {
  const revised = replacementText(T3_REQUIRES_T1, ['node --test tests/part-3.test.ts', 'node --test tests/part-3-revised.test.ts'], ['node --test tests/part-1.test.ts', 'node --test tests/part-1-revised.test.ts']);
  let { result, sim, trace } = running(revised);
  result = submit(result, 'T3', sim, trace);
  result = submit(result, 'T1', sim, trace);
  const checks = trace.effects.length;
  result = host(result, replace(HASH, summary({ retained: ['T2'], changed: ['T1', 'T3'] })), sim, trace);
  assert.equal(result.state.tag, 'tasks');
  assert.deepEqual(trace.effects.slice(checks).flatMap((effect) => effect.kind === 'verify' ? effect.commands.map((row) => row['command']) : []), ['node --test tests/part-1-revised.test.ts', 'node --test tests/part-3-revised.test.ts']);
});

test('replacement-work: replay conflict binds active HEAD and resumes without ordinary task acceptance', () => {
  let { result, sim, trace } = running();
  result = submit(result, 'T3', sim, trace);
  const accepted = record(result, 'T3')!;
  const c = ctx(result);
  result = stepImplement({ tag: 'task-checkout', c, effectId: 'replay.1', step: 'rebase', task: null, reason: 'integration-archive' }, { type: 'CHECKOUT_DONE', effectId: 'replay.1', op: 'init', result: { path: 'run/wt/integration', base: 'new-baseline', head: 'completed-first-pick', candidate: accepted.integrated, conflict: true, paths: ['src/c.ts'], manifest: {}, replayed: [] } });
  assert.equal(result.state.tag, 'integration-conflict');
  assert.deepEqual(ctx(result).integration, { path: 'run/wt/integration', base: 'new-baseline', head: 'completed-first-pick', links: [], ignored: [] });
  assert.deepEqual(ctx(result).archivedIntegrations, [{ archivedName: 'integration-archive', base: c.integration!.base, head: c.integration!.head }]);
  assert.match(validateImplement(result.state, { type: 'DECISION', kind: 'integration-conflict', answer: { by: 'orchestrator', action: 'discard', rationale: 'drop' } } as never) ?? '', /resolve is the only/);
  result = stepImplement(result.state, { type: 'DECISION', kind: 'integration-conflict', answer: { by: 'orchestrator', action: 'resolve', rationale: 'Preserve accepted behavior and new caller content.' } });
  assert.equal(result.effects[0]?.kind, 'checkout');
  const effect = result.effects[0]!;
  result = stepImplement(result.state, { type: 'CHECKOUT_DONE', effectId: effect.id, op: 'resolve', result: { revision: 'resolved-pick', paths: ['src/c.ts'], retained: ['src/c.ts'] } });
  const verified = answer(result.state, result.effects[0]!, sim)!;
  result = stepImplement(result.state, verified);
  assert.equal(result.state.tag, 'task-checkout');
  assert.equal(result.effects[0]?.kind === 'checkout' && result.effects[0].op, 'init');
  assert.deepEqual(record(result, 'T3'), accepted, 'resolution does not consume a new acceptance or writer attempt');
  assert.equal(ctx(result).integration?.head, 'resolved-pick');
});

test('replacement-work: retired accepted owner resolves replay with retained scope and remapped history', () => {
  const sc3 = '- [SC3] Part 3 works\n  - Changes: src/c.ts\n  - Verify: `node --test tests/part-3.test.ts`\n  - Evidence: verify\n  - Test rationale: pins part 3.\n';
  const task3 = '### T3 — Part three\nDeliver part three.\n- Prerequisites: none\n- Criteria: SC3\n\n#### [MODIFY] src/c.ts\n- Changes: part three.\n\n';
  const revised = replacementText([sc3, ''], [task3, '']);
  let { result, sim, trace } = running(revised);
  result = submit(result, 'T3', sim, trace);
  const accepted = record(result, 'T3')!;
  result = host(result, replace(HASH, summary({ retained: ['T1', 'T2'], retired: ['T3'] })), sim, trace);
  const c = ctx(result);
  const replayState = { tag: 'task-checkout' as const, c, effectId: 'retired.replay', step: 'rebase' as const, task: null, reason: 'integration-archive' };
  result = stepImplement(replayState, { type: 'CHECKOUT_DONE', effectId: 'retired.replay', op: 'init', result: { path: 'run/wt/integration', base: 'newbase', head: 'newhead', candidate: accepted.integrated, conflict: true, paths: ['src/c.ts'], manifest: {} } });
  assert.equal(result.state.tag, 'integration-conflict');
  if (result.state.tag !== 'integration-conflict') throw new Error('conflict required');
  assert.equal(result.state.conflict.task, 'T3');
  const decision: Event = { type: 'DECISION', kind: 'integration-conflict', answer: { by: 'orchestrator', action: 'resolve', rationale: 'Preserve retired accepted work.' } };
  assert.equal(validateImplement(result.state, decision as never), null);
  const conflictState = result.state;
  result = stepImplement(result.state, decision);
  assert.deepEqual(result.effects[0]?.kind === 'checkout' && result.effects[0].input['permitted'], ['src/c.ts']);
  const resolveEffect = result.effects[0]!;
  const refused = stepImplement(result.state, { type: 'CHECKOUT_DONE', effectId: resolveEffect.id, op: 'resolve', result: { refused: 'out-of-scope', paths: ['src/a.ts'], detail: 'outside retained owner' } });
  assert.equal(refused.state.tag, 'integration-conflict');
  assert.deepEqual(ctx(refused).retiredTasks, c.retiredTasks);
  result = stepImplement(result.state, { type: 'CHECKOUT_DONE', effectId: resolveEffect.id, op: 'resolve', result: { revision: 'resolved', paths: ['src/c.ts'], retained: ['src/c.ts'] } });
  assert.deepEqual(result.effects[0]?.kind === 'verify' && result.effects[0].commands.map((row) => row['command']), ['node --test tests/part-3.test.ts'], 'historical check tests retained work without restoring SC3');
  const verifyEffect = result.effects[0]!;
  const failedEvent = answer(result.state, verifyEffect, { ...sim, verify: () => ({ exit: 1 }) })!;
  const failed = stepImplement(result.state, failedEvent);
  assert.equal(failed.state.tag, 'integration-conflict');
  assert.deepEqual(ctx(failed).retiredTasks, c.retiredTasks);
  result = stepImplement(result.state, answer(result.state, verifyEffect, sim)!);
  assert.equal(result.state.tag, 'task-checkout');
  const replayEffect = result.effects[0]!;
  result = stepImplement(result.state, { type: 'CHECKOUT_DONE', effectId: replayEffect.id, op: 'init', result: { path: 'run/wt/integration', base: 'newbase', head: 'resolved', conflict: false, manifest: {}, replayed: [{ from: accepted.integrated, to: 'resolved' }] } });
  const retired = ctx(result).retiredTasks![0]!;
  assert.equal(retired.integrated, 'resolved');
  assert.deepEqual(retired.integratedHistory, [accepted.integrated]);
  for (const key of ['status', 'attempt', 'failures', 'worktree', 'candidate'] as const) assert.equal(retired[key], accepted[key], key);
  assert.equal(ctx(result).plan?.criteria.some((row) => row.id === 'SC3'), false);
  assert.match(validateImplement(conflictState, { ...decision, answer: { by: 'orchestrator', action: 'discard', rationale: 'drop' } } as never) ?? '', /resolve is the only/);
  const unknown = stepImplement(replayState, { type: 'CHECKOUT_DONE', effectId: 'retired.replay', op: 'init', result: { path: 'run/wt/integration', base: 'newbase', head: 'newhead', candidate: 'unbound', candidatePaths: ['src/unowned.ts'], conflict: true, paths: ['src/unowned.ts'], manifest: {} } });
  assert.equal(unknown.state.tag, 'failed', 'unbound replay cannot enter a retry path that delivers a partial candidate');
  assert.equal(ctx(unknown).integration?.head, 'newhead');
  assert.deepEqual(unknown.effects, []);
});

test('replacement-work: failed resolved retired replay resumes before delivery and preserves accepted records', () => {
  const sc3 = '- [SC3] Part 3 works\n  - Changes: src/c.ts\n  - Verify: `node --test tests/part-3.test.ts`\n  - Evidence: verify\n  - Test rationale: pins part 3.\n';
  const task3 = '### T3 — Part three\nDeliver part three.\n- Prerequisites: none\n- Criteria: SC3\n\n#### [MODIFY] src/c.ts\n- Changes: part three.\n\n';
  let { result, sim, trace } = running(replacementText([sc3, ''], [task3, '']));
  result = submit(result, 'T3', sim, trace);
  result = host(result, replace(HASH, summary({ retained: ['T1', 'T2'], retired: ['T3'] })), sim, trace);
  result = submit(result, 'T1', sim, trace);
  const slot = slots(result).find((row) => row.task === 'T2')!;
  const receipt: Event = { type: 'WRITE_RECEIPT', status: 'submitted', task: 'T2', attempt: slot.attempt, signature: slot.signature, handle: slot.handle!, model: slot.model, envelopePath: slot.envelopePath, briefHash: slot.briefHash };
  assert.equal(validateImplement(result.state, receipt as never), null);
  result = stepImplement(result.state, receipt);
  for (let count = 0; result.effects[0]?.kind !== 'checkout' || result.effects[0].op !== 'deliver'; count++) {
    assert.ok(count < 100);
    result = stepImplement(result.state, answer(result.state, result.effects[0]!, sim)!);
  }
  const original = ctx(result), retired = original.retiredTasks![0]!;
  const initialFailure = stepImplement({ tag: 'task-checkout', c: original, effectId: 'probe.initial', step: 'rebase', task: null, reason: 'integration-archive' }, { type: 'EFFECT_FAILED', effectId: 'probe.initial', cls: 'io', detail: 'Baseline archive moved before replay failed.' });
  const initialBoundary = stepImplement(initialFailure.state, answer(initialFailure.state, initialFailure.effects[0]!, sim)!);
  const initialRetry = stepImplement(initialBoundary.state, { type: 'DECISION', kind: 'failure', answer: { by: 'orchestrator', action: 'retry', rationale: 'Resume initial archive.' } });
  assert.equal(initialRetry.effects[0]?.kind === 'checkout' && initialRetry.effects[0].op, 'init');
  const initialEffect = initialRetry.effects[0]!;
  if (initialEffect.kind !== 'checkout' || initialEffect.op !== 'init') throw new Error('replay init required');
  assert.deepEqual(initialEffect.input['replay'], { base: original.integration!.base, head: original.integration!.head });
  result = stepImplement({ tag: 'task-checkout', c: original, effectId: 'probe.replay', step: 'rebase', task: null, reason: 'integration-archive' }, { type: 'CHECKOUT_DONE', effectId: 'probe.replay', op: 'init', result: { path: 'run/wt/integration', base: 'newbase', head: 'partial', candidate: retired.integrated, candidatePaths: ['src/c.ts'], conflict: true, paths: ['src/c.ts'], manifest: {} } });
  const resolve: Event = { type: 'DECISION', kind: 'integration-conflict', answer: { by: 'orchestrator', action: 'resolve', rationale: 'Preserve retired accepted bytes.' } };
  assert.equal(validateImplement(result.state, resolve as never), null);
  result = stepImplement(result.state, resolve);
  result = stepImplement(result.state, { type: 'CHECKOUT_DONE', effectId: result.effects[0]!.id, op: 'resolve', result: { revision: 'resolved-retired', paths: ['src/c.ts'], retained: ['src/c.ts'] } });
  result = stepImplement(result.state, answer(result.state, result.effects[0]!, sim)!);
  const continuation = result.effects[0]!;
  for (let attempt = 0; attempt < 2; attempt++) {
    result = stepImplement(result.state, { type: 'EFFECT_FAILED', effectId: result.effects[0]!.id, cls: 'io', detail: 'rev-list failed before remaining picks' });
    result = stepImplement(result.state, answer(result.state, result.effects[0]!, sim)!);
    assert.equal(result.state.tag, 'failure');
    assert.deepEqual(ctx(result).tasks, original.tasks);
    assert.deepEqual(ctx(result).retiredTasks, original.retiredTasks);
    const retry: Event = { type: 'DECISION', kind: 'failure', answer: { by: 'orchestrator', action: 'retry', rationale: 'Retry original replay.' } };
    assert.equal(validateImplement(result.state, retry as never), null);
    result = stepImplement(result.state, retry);
    assert.equal(result.effects[0]?.kind === 'checkout' && result.effects[0].op, 'init');
    assert.deepEqual(result.effects[0]?.kind === 'checkout' && result.effects[0].input, continuation.kind === 'checkout' && continuation.input);
  }
  const effect = result.effects[0]!;
  const partial = stepImplement(result.state, { type: 'CHECKOUT_DONE', effectId: effect.id, op: 'init', result: { path: 'run/wt/integration', base: 'newbase', head: 'resolved-retired', conflict: false, manifest: {}, replayed: [{ from: retired.integrated, to: 'resolved-retired' }] } });
  assert.equal(partial.state.tag, 'failure-snapshot', 'incomplete mapping must retain the replay');
  result = stepImplement(result.state, { type: 'CHECKOUT_DONE', effectId: effect.id, op: 'init', result: { path: 'run/wt/integration', base: 'newbase', head: 'replayed-T2', conflict: false, manifest: {}, replayed: [{ from: retired.integrated, to: 'resolved-retired' }, { from: original.tasks['T1']!.integrated, to: 'replayed-T1' }, { from: original.tasks['T2']!.integrated, to: 'replayed-T2' }] } });
  assert.equal(ctx(result).pendingReplay, undefined);
  assert.equal(ctx(result).retiredTasks![0]!.integrated, 'resolved-retired');
  assert.equal(ctx(result).retiredTasks![0]!.attempt, retired.attempt);
  assert.equal(ctx(result).plan!.criteria.some((row) => row.id === 'SC3'), false);
  for (let count = 0; result.effects[0]?.kind !== 'checkout' || result.effects[0].op !== 'deliver'; count++) {
    assert.ok(count < 100);
    assert.equal(result.effects[0]?.kind === 'checkout' && result.effects[0].op, false, 'no writer restart');
    result = stepImplement(result.state, answer(result.state, result.effects[0]!, sim)!);
  }
  assert.equal(result.effects[0]?.kind === 'checkout' && result.effects[0].input['revision'], 'replayed-T2');
});
