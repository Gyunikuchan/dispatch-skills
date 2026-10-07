import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Event } from '../../../skills/dispatch/scripts/core/types.ts';
import { effectivePlan, implementData, stepImplement, validateImplement, type Context, type ImplementState } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { launch, host, start, submit, PLAN, type Result, type Sim, type Trace } from './fixtures/implement-tasks.ts';
import type { ScopeAdjustment } from '../../../skills/dispatch/scripts/core/types.ts';
import { reconcileTasks, taskSignature } from '../../../skills/dispatch/scripts/machines/implement-tasks.ts';
import { approvalState, host as recoveryHost, failedRow, FP as recoveryFingerprint } from './fixtures/implement-recovery.ts';
import { previewReceipt } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import type { RootState } from '../../../skills/dispatch/scripts/machines/root.ts';
import type { Ports } from '../../../skills/dispatch/scripts/core/types.ts';

const HASH = `sha256:${'a'.repeat(64)}`;
const delta = { paths: ['src/extra.ts'], criteria: [], obligations: [], commands: [], phaseDuties: [], increments: [] };
const request = (task = 'T1') => ({ requestId: 'scope-expand-1', source: 'task' as const, task, baseArtifactHash: HASH, writerRationale: 'The required behavior needs a companion module.', delta });
const scopeEnvelope = (task = 'T1') => ({ schemaVersion: 1, status: 'SCOPE_REQUEST', stage: 'COMPLETE', summary: 'Request the companion module before editing it.', evidence: [], scopeRequest: request(task) });
const slots = (result: Result) => implementData(result.state)['tasks'] as { task: string; action: string; attempt: number; signature: string; handle: string | null; model: string; envelopePath: string; paths: string[] }[];

function scopedSimulation(): Sim {
  let requests = 0;
  return {
    envelope: (id) => id === 'T1' && requests++ === 0 ? scopeEnvelope() : ({
      schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: 'Delivered',
      evidence: [
        ...PLAN.tasks.find((row) => row.id === id)!.criteria.map((criterionId) => `CRITERION ${criterionId} | ${PLAN.criteria.find((row) => row.id === criterionId)!.changes[0]} | delivered`),
        ...(id === 'T1' ? ['RED-MATRIX SC1 | tests/sc1.test.ts:rejects bad input | exit 1 test:rejects bad input'] : []),
      ],
    }),
    verify: (purpose) => purpose === 'red' ? { exit: 1, failedTests: ['test:rejects bad input'] } : { exit: 0 },
  };
}

function approve(result: Result, sim: Sim, trace: Trace, ruling: 'approve' | 'disagree' = 'approve'): Result {
  if (result.state.tag !== 'scope-adjudication') throw new Error('scope decision is not pending');
  const pending = result.state.request;
  return host(result, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request: pending, ruling, rationale: 'The companion module is required by the accepted outcome.' } }, sim, trace);
}

function taskReceipt(result: Result, task: string) {
  if (result.state.tag !== 'scope-draining') throw new Error('scope drain is not pending');
  const pending = implementData(result.state)['tasks'] as { task: string; attempt: number; signature: string; handle: string; envelopePath: string }[];
  const slot = pending.find((row) => row.task === task);
  if (!slot) throw new Error(`missing original attempt for ${task}`);
  return slot;
}

test('prewrite-level: orchestrator approval journals scope and relaunches under the settled level', () => {
  const sim = scopedSimulation();
  let { result, trace } = start(1, sim);
  result = launch(result, sim, trace);
  const originalWorktree = result.state.tag === 'tasks' ? result.state.c.tasks['T1']?.worktree : null;
  result = submit(result, 'T1', sim, trace);
  assert.equal(result.state.tag, 'scope-adjudication');

  result = approve(result, sim, trace);
  assert.equal(result.state.tag, 'tasks');
  if (result.state.tag !== 'tasks') return;
  const data = implementData(result.state);
  const adjustments = data['scopeAdjustments'] as { proposal: { delta: { paths: string[] } }; approvedBy: string }[];
  assert.equal(adjustments.length, 1);
  assert.equal(adjustments[0]?.approvedBy, 'orchestrator');
  assert.deepEqual(adjustments[0]?.proposal.delta.paths, ['src/extra.ts']);
  assert.equal((data['scopeNotice'] as { requestId: string }).requestId, 'scope-expand-1');
  assert.ok(slots(result).some((slot) => slot.task === 'T1' && slot.paths.includes('src/extra.ts')));
  assert.equal(result.state.c.tasks['T1']?.worktree, originalWorktree);
  assert.equal(result.state.c.tasks['T1']?.attempt, 2);
  assert.equal(result.state.c.run.level, 'low');
});

test('prewrite-level: accepted path expansion widens writer and commit scope while rejecting the pre-adjustment receipt', () => {
  const sim = scopedSimulation();
  let { result, trace } = start(1, sim);
  result = launch(result, sim, trace);
  const original = slots(result).find((slot) => slot.task === 'T1')!;
  const staleReceipt = { type: 'WRITE_ENVELOPE' as const, task: 'T1', attempt: original.attempt, signature: original.signature, handle: original.handle!, envelopePath: original.envelopePath };
  result = submit(result, 'T1', sim, trace);
  result = approve(result, sim, trace);
  assert.equal(result.state.tag, 'tasks');
  if (result.state.tag !== 'tasks') return;
  sim.plan = effectivePlan(result.state.c);
  sim.diff = (id) => [...sim.plan!.tasks.find((task) => task.id === id)!.paths];
  assert.ok(slots(result).some((slot) => slot.task === 'T1' && slot.paths.includes('src/extra.ts')));
  assert.match(validateImplement(result.state, staleReceipt) ?? '', /active task, attempt, signature, handle/);
  result = launch(result, sim, trace);
  result = submit(result, 'T1', sim, trace);
  const commit = trace.events.findLast((event) => event.type === 'CHECKOUT_DONE' && event.op === 'commit');
  assert.ok(commit?.type === 'CHECKOUT_DONE' && (commit.result['paths'] as string[]).includes('src/extra.ts'));
});

test('prewrite-level: orchestrator disagreement sends the proposal to the user and accepted work uses the same settled level', () => {
  const sim = scopedSimulation();
  let { result, trace } = start(1, sim);
  result = launch(result, sim, trace);
  result = submit(result, 'T1', sim, trace);
  result = approve(result, sim, trace, 'disagree');
  assert.equal(result.state.tag, 'scope-user-decision');
  if (result.state.tag !== 'scope-user-decision') return;
  assert.match(result.state.orchestratorRationale, /required/);
  result = host(result, { type: 'DECISION', kind: 'scope-deviation-user', answer: { by: 'user', requestId: result.state.request.requestId, choice: 'accept', quote: 'Accept the companion module.' } }, sim, trace);
  assert.equal(result.state.tag, 'tasks');
  if (result.state.tag !== 'tasks') return;
  const data = implementData(result.state);
  const adjustments = data['scopeAdjustments'] as { approvedBy: string; quote?: string }[];
  assert.equal(adjustments[0]?.approvedBy, 'user');
  assert.equal(adjustments[0]?.quote, 'Accept the companion module.');
  assert.equal(result.state.c.run.level, 'low');
});

test('prewrite-level: accepted deviation drains an invalidated sibling before worktree reuse', () => {
  const sim = scopedSimulation();
  let { result, trace } = start(2, sim);
  result = launch(result, sim, trace);
  const originalWorktrees = result.state.tag === 'tasks' ? Object.fromEntries(Object.entries(result.state.c.tasks).map(([id, task]) => [id, task.worktree])) : {};
  result = submit(result, 'T1', sim, trace);
  assert.equal(result.state.tag, 'scope-adjudication');
  result = approve(result, sim, trace);
  assert.equal(result.state.tag, 'scope-draining');
  if (result.state.tag !== 'scope-draining') throw new Error('scope-draining');
  const sibling = taskReceipt(result, 'T2');
  assert.match(validateImplement(result.state, { type: 'WRITE_LAUNCHED', tasks: [] }) ?? '', /scope draining accepts only terminal receipts/);

  result = host(result, { type: 'WRITE_ENVELOPE', ...sibling }, sim, trace);
  assert.equal(result.state.tag, 'tasks');
  if (result.state.tag !== 'tasks') return;
  assert.equal(result.state.c.tasks['T1']?.status, 'running');
  assert.equal(result.state.c.tasks['T2']?.status, 'running');
  assert.equal(result.state.c.tasks['T1']?.integrated, null);
  assert.equal(result.state.c.tasks['T2']?.integrated, null);
  assert.equal(result.state.c.tasks['T1']?.worktree, originalWorktrees['T1']);
  assert.equal(result.state.c.tasks['T2']?.worktree, originalWorktrees['T2']);
  assert.ok((result.state.c.tasks['T1']?.attempt ?? 0) >= 2);
  assert.ok((result.state.c.tasks['T2']?.attempt ?? 0) >= 2);
  assert.equal(trace.effects.some((effect) => effect.kind === 'checkout' && effect.op === 'integrate'), false);
  assert.ok(slots(result).some((slot) => slot.task === 'T1' && slot.paths.includes('src/extra.ts')));
});

test('prewrite-level: draining multiple siblings preserves unique envelope effect IDs', () => {
  const sim = scopedSimulation();
  sim.plan = { ...PLAN, tasks: PLAN.tasks.map((task) => task.id === 'T3' ? { ...task, prerequisites: [] } : task) };
  let { result, trace } = start(3, sim);
  result = launch(result, sim, trace);
  result = submit(result, 'T1', sim, trace);
  result = approve(result, sim, trace);
  assert.equal(result.state.tag, 'scope-draining');
  if (result.state.tag !== 'scope-draining') return;
  for (const task of ['T2', 'T3']) {
    const receipt = taskReceipt(result, task);
    result = host(result, { type: 'WRITE_ENVELOPE', ...receipt }, sim, trace);
  }
  const ids = trace.effects.filter((effect) => effect.kind === 'check-envelope').map((effect) => effect.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 3);
});

test('level-journal: scope-draining checks an in-flight sibling against its pre-adjustment envelope', async () => {
  const sim = scopedSimulation();
  let { result, trace } = start(2, sim);
  result = launch(result, sim, trace);
  if (result.state.tag !== 'tasks') throw new Error('tasks');
  const proposal = {
    requestId: 'plan-revision-expand-t2', source: 'plan-revision' as const,
    baseArtifactHash: HASH, proposedArtifactHash: `sha256:${'b'.repeat(64)}`, affectedTasks: ['T2'], rationale: 'T2 requires the newly governed companion path.',
    delta: { paths: ['src/extra.ts'], criteria: [], obligations: [], commands: [], phaseDuties: [], increments: [] },
  };
  const adjustment: ScopeAdjustment = { proposal, approvedBy: 'orchestrator', rationale: 'The added path supports T2\'s accepted criterion.' };
  const c = { ...result.state.c, scopeAdjustments: [...result.state.c.scopeAdjustments, adjustment] };
  const draining: ImplementState = { tag: 'scope-draining', c, request: proposal, adjustment, requester: 'T1', active: ['T2'], drained: [], stopAfterDrain: false, hotfixResume: null };
  const slot = (implementData(draining)['tasks'] as { task: string; attempt: number; signature: string; handle: string; envelopePath: string }[]).find((row) => row.task === 'T2')!;
  assert.deepEqual(effectivePlan(c).tasks.find((task) => task.id === 'T2')?.paths, ['src/b.ts', 'src/extra.ts']);
  const checked = stepImplement(draining, { type: 'WRITE_ENVELOPE', ...slot });
  assert.equal(checked.state.tag, 'scope-drain-envelope');
  const envelopeCheck = checked.effects.find((effect) => effect.kind === 'check-envelope');
  assert.ok(envelopeCheck?.kind === 'check-envelope');
  if (envelopeCheck?.kind === 'check-envelope') assert.deepEqual(envelopeCheck.permitted, ['src/b.ts']);

  const checks: { permitted: readonly string[] }[] = [];
  const checker = async (effect: { id: string; permitted: readonly string[] }) => {
    checks.push(effect);
    return [{ type: 'ENVELOPE_CHECKED', effectId: effect.id, envelope: {}, defects: ['outside the original writer envelope'], diff: { paths: ['src/extra.ts'] } }] as never;
  };
  const receipt = { type: 'WRITE_ENVELOPE' as const, task: slot.task, attempt: slot.attempt, signature: slot.signature, handle: slot.handle, envelopePath: slot.envelopePath };
  const preview = await previewReceipt({ tag: 'implement', child: draining } as unknown as RootState, receipt, { 'check-envelope': checker } as never, {} as Ports, 'run');
  assert.equal(preview, 'outside the original writer envelope');
  assert.deepEqual(checks[0]?.permitted, ['src/b.ts']);
});

test('level-journal: SCOPE_REQUEST during scope draining stays nonterminal and preserves the attempt', () => {
  const sim = scopedSimulation();
  let { result, trace } = start(2, sim);
  result = launch(result, sim, trace);
  result = submit(result, 'T1', sim, trace);
  result = approve(result, sim, trace);
  if (result.state.tag !== 'scope-draining') throw new Error('scope drain is not pending');
  const original = result.state.c.tasks['T2'];
  const receipt = taskReceipt(result, 'T2');

  const requested = stepImplement(result.state, { type: 'WRITE_ENVELOPE', ...receipt });
  const requestCheck = requested.effects.find((effect) => effect.kind === 'check-envelope');
  assert.ok(requestCheck?.kind === 'check-envelope');
  if (requestCheck?.kind !== 'check-envelope') return;
  const paused = stepImplement(requested.state, {
    type: 'ENVELOPE_CHECKED', effectId: requestCheck.id, envelope: scopeEnvelope('T2'), defects: [], diff: { paths: [] },
  });
  assert.equal(paused.state.tag, 'scope-draining');
  if (paused.state.tag !== 'scope-draining') return;
  assert.ok(paused.state.active.includes('T2'));
  assert.equal(paused.state.c.tasks['T2']?.handle, original?.handle);
  assert.equal(paused.state.c.tasks['T2']?.failures, original?.failures);
  assert.deepEqual(implementData(paused.state)['rejectedScopeRequests'], [{ task: 'T2', requestId: 'scope-expand-1', summary: 'Request the companion module before editing it.' }]);

  const terminalReceipt = taskReceipt({ ...result, state: paused.state }, 'T2');
  const terminal = stepImplement(paused.state, { type: 'WRITE_ENVELOPE', ...terminalReceipt });
  const terminalCheck = terminal.effects.find((effect) => effect.kind === 'check-envelope');
  assert.ok(terminalCheck?.kind === 'check-envelope');
  if (terminalCheck?.kind !== 'check-envelope') return;
  const drained = stepImplement(terminal.state, {
    type: 'ENVELOPE_CHECKED', effectId: terminalCheck.id,
    envelope: { schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: 'Finished within the current scope.', evidence: [] },
    defects: [], diff: { paths: [] },
  });
  assert.notEqual(drained.state.tag, 'scope-draining');
  if ('c' in drained.state && drained.state.c) assert.equal(drained.state.c.tasks['T2']?.failures, original?.failures);
});

test('prewrite-level: a parked scope-request draft rebases onto the integration head after a sibling is accepted', () => {
  const sim = scopedSimulation();
  let { result, trace } = start(2, sim);
  result = launch(result, sim, trace);
  if (result.state.tag !== 'tasks') throw new Error('tasks');
  const originalWorktree = result.state.c.tasks['T1']?.worktree;
  result = submit(result, 'T2', sim, trace);
  if (result.state.tag !== 'tasks') throw new Error('sibling accepted while T1 remains active');
  assert.equal(result.state.c.tasks['T2']?.status, 'accepted');
  const integrationHead = result.state.c.integration?.head;
  assert.notEqual(result.state.c.tasks['T1']?.input, integrationHead);

  result = submit(result, 'T1', sim, trace);
  assert.equal(result.state.tag, 'scope-adjudication');
  result = approve(result, sim, trace);
  assert.equal(result.state.tag, 'tasks');
  if (result.state.tag !== 'tasks') return;
  const rebase = trace.effects.findLast((effect) => effect.kind === 'checkout' && effect.op === 'scope-rebase');
  assert.equal(rebase?.kind === 'checkout' && rebase.input['originalName'], 'task-t1');
  assert.equal(rebase?.kind === 'checkout' && rebase.input['revision'], integrationHead);
  assert.equal(originalWorktree, 'run/wt/task-t1');
  assert.equal(result.state.c.tasks['T1']?.worktree, rebase?.kind === 'checkout' ? `run/wt/${String(rebase.input['name'])}` : null);
  assert.equal(result.state.c.tasks['T2']?.status, 'accepted');
  assert.ok(slots(result).some((slot) => slot.task === 'T1' && slot.paths.includes('src/extra.ts')));
});

test('level-journal: rebased task drafts commit and clean up the active replacement worktree', () => {
  const sim = scopedSimulation();
  let { result, trace } = start(2, sim);
  result = launch(result, sim, trace);
  result = submit(result, 'T2', sim, trace);
  if (result.state.tag !== 'tasks') throw new Error('sibling acceptance should leave the scope requester pending');
  result = submit(result, 'T1', sim, trace);
  assert.equal(result.state.tag, 'scope-adjudication');
  result = approve(result, sim, trace);
  if (result.state.tag !== 'tasks') throw new Error('scope approval should rebase and schedule the requester');
  const activePath = result.state.c.tasks['T1']?.worktree;
  const activeName = activePath?.split(/[\\/]/).at(-1);
  assert.ok(activeName && activeName !== 'task-t1');
  result = launch(result, sim, trace);
  result = submit(result, 'T1', sim, trace);
  const commit = trace.effects.findLast((effect) => effect.kind === 'checkout' && effect.op === 'commit');
  assert.equal(commit?.kind === 'checkout' && commit.input['name'], activeName);

  if (result.state.tag === 'tasks' && slots(result).some((slot) => slot.action === 'launch')) {
    result = launch(result, sim, trace);
    const next = slots(result).find((slot) => slot.action === 'running');
    if (next) result = submit(result, next.task, sim, trace);
  }
  const cleanup = trace.effects.findLast((effect) => effect.kind === 'checkout' && effect.op === 'cleanup');
  assert.ok(cleanup?.kind === 'checkout');
  if (cleanup?.kind === 'checkout') {
    const names = (cleanup.input as Readonly<Record<string, unknown>>)['names'] as string[];
    assert.ok(names.includes('task-t1'));
    assert.ok(names.includes(activeName!));
  }
});

test('level-journal: accepted delta becomes full plan evidence and stays with its design increment', () => {
  const sim = scopedSimulation();
  const { result } = start(1, sim);
  if (result.state.tag !== 'tasks') throw new Error('tasks');
  const taskContext = result.state.c;
  const definition = {
    id: 'SC4', title: 'Companion module works', changes: ['src/extra.ts'],
    verify: [{ command: 'check-companion', final: false }], evidence: 'verify' as const,
    preExisting: false, redException: null, testRationale: null, review: null, enforcementInfeasibility: null,
  };
  const adjustment: ScopeAdjustment = {
    proposal: { requestId: 'complete-delta', source: 'task', task: 'T1', baseArtifactHash: HASH, writerRationale: 'The companion module is required.', delta: {
      paths: ['src/extra.ts'], criteria: ['SC4'], criterionDefinitions: [definition], obligations: ['Preserve companion behavior'],
      commands: ['check-scope'], finalCommands: ['check-final'], phaseDuties: ['Inspect companion behavior manually'], increments: [],
    } },
    approvedBy: 'orchestrator', rationale: 'The added requirement is part of the accepted outcome.', ownerIncrement: 'I01',
  };
  const context = (increment: string): Context => ({ ...taskContext, designBinding: { increment } as NonNullable<Context['designBinding']>, scopeAdjustments: [adjustment] });
  const first = effectivePlan(context('I01'));
  const task = first.tasks.find((row) => row.id === 'T1')!;
  assert.ok(task.paths.includes('src/extra.ts'));
  assert.ok(task.criteria.includes('SC4'));
  assert.equal(first.criteria.find((row) => row.id === 'SC4')?.title, definition.title);
  assert.ok(first.verification.automated.includes('check-scope'));
  assert.ok(first.verification.automated.includes('check-companion'));
  assert.ok(first.finalCommands.includes('check-final'));
  assert.ok(first.verification.manual.includes('Inspect companion behavior manually'));
  assert.ok(first.keyDecisions.includes('Preserve companion behavior'));
  assert.ok(first.changes.some((row) => row.path === 'src/extra.ts'));

  const later = effectivePlan(context('I02'));
  assert.equal(later.criteria.some((row) => row.id === 'SC4'), false);
  assert.equal(later.tasks.find((row) => row.id === 'T1')?.paths.includes('src/extra.ts'), false);
  assert.equal(later.keyDecisions.includes('Preserve companion behavior'), false);
});

test('level-journal: revised plan supersedes historical criterion definitions and path overlays', () => {
  const { result } = start(1);
  if (result.state.tag !== 'tasks') throw new Error('tasks');
  const sc2 = PLAN.criteria.find((criterion) => criterion.id === 'SC2')!;
  const oldDefinition = { ...sc2, title: 'Old approved criterion wording', changes: ['src/b.ts', 'src/legacy.ts'], verify: [{ command: 'check-old-criterion', final: false }] };
  const historicalCriterion = { ...oldDefinition, id: 'SC4', title: 'Old approved companion criterion' };
  const adjustment: ScopeAdjustment = {
    proposal: { requestId: 'historical-plan-overlay', source: 'task', task: 'T2', baseArtifactHash: HASH, writerRationale: 'An earlier accepted deviation added a companion criterion.', delta: {
      paths: ['src/legacy.ts'], criteria: ['SC4'], criterionDefinitions: [oldDefinition, historicalCriterion], obligations: [], commands: ['check-old-command'], phaseDuties: [], increments: [],
    } },
    approvedBy: 'orchestrator', rationale: 'The historical companion criterion was approved.',
  };
  const earlier = { ...result.state.c, scopeAdjustments: [adjustment] };
  const oldPlan = effectivePlan(earlier);
  assert.equal(oldPlan.criteria.find((criterion) => criterion.id === 'SC2')?.title, oldDefinition.title);
  assert.ok(oldPlan.criteria.some((criterion) => criterion.id === 'SC4'));
  const revised: typeof PLAN = {
    ...PLAN,
    changes: [...PLAN.changes.filter((change) => change.path !== 'src/legacy.ts'), { action: 'MODIFY', path: 'src/current.ts', note: 'Revised criterion path', command: null, line: 9 }],
    criteria: PLAN.criteria.map((criterion) => criterion.id === 'SC2' ? { ...criterion, title: 'Revised criterion wording', changes: ['src/b.ts', 'src/current.ts'], verify: [{ command: 'check-new-criterion', final: false }] } : criterion),
    tasks: PLAN.tasks.map((task) => task.id === 'T2' ? { ...task, paths: ['src/b.ts', 'src/current.ts'] } : task),
    governedText: '# Revised tasks',
  };
  const newPlanHash = `sha256:${'b'.repeat(64)}`;
  const current = { ...earlier, plan: revised, planHash: newPlanHash };
  const plan = effectivePlan(current);
  assert.equal(plan.criteria.some((criterion) => criterion.id === 'SC4'), false);
  assert.equal(plan.criteria.find((criterion) => criterion.id === 'SC2')?.title, 'Revised criterion wording');
  assert.deepEqual(plan.criteria.find((criterion) => criterion.id === 'SC2')?.changes, ['src/b.ts', 'src/current.ts']);
  assert.deepEqual(plan.criteria.find((criterion) => criterion.id === 'SC2')?.verify, [{ command: 'check-new-criterion', final: false }]);
  assert.deepEqual(plan.tasks.find((task) => task.id === 'T2')?.paths, ['src/b.ts', 'src/current.ts']);
  assert.equal(plan.changes.some((change) => change.path === 'src/legacy.ts'), false);
  assert.equal(plan.verification.automated.includes('check-old-command'), false);
  assert.equal(plan.verification.automated.includes('check-old-criterion'), false);
  const signature = taskSignature(plan, plan.tasks.find((task) => task.id === 'T2')!);
  const task = current.tasks['T2']!;
  const reconciled = reconcileTasks({ ...current.tasks, T2: { ...task, status: 'accepted', signature: taskSignature(oldPlan, oldPlan.tasks.find((row) => row.id === 'T2')!), integrated: 'old-integration' } }, plan)['T2']!;
  assert.equal(reconciled.status, 'pending');
  assert.equal(reconciled.integrated, null);
  assert.equal(reconciled.signature, signature);
});

test('level-journal: revised plan drops stale accepted adjustments from task briefs and verification', () => {
  const sim: Sim = {};
  let { result, trace } = start(1, sim);
  if (result.state.tag !== 'tasks') throw new Error('initial task writer');
  const adjustment: ScopeAdjustment = {
    proposal: { requestId: 'stale-task-overlay', source: 'task', task: 'T2', baseArtifactHash: HASH, writerRationale: 'An earlier plan required a companion check.', delta: {
      paths: ['src/legacy.ts'], criteria: [], obligations: [], commands: ['check-old-command'], phaseDuties: [], increments: [],
    } },
    approvedBy: 'orchestrator', rationale: 'The earlier artifact required this check.',
  };
  const revised = { ...PLAN, governedText: '# Revised plan' };
  const revisedHash = 'sha256:' + 'b'.repeat(64);
  result = { ...result, state: { ...result.state, c: { ...result.state.c, plan: revised, planHash: revisedHash, scopeAdjustments: [adjustment] } } };

  result = launch(result, sim, trace);
  result = submit(result, 'T1', sim, trace);
  const brief = trace.effects.findLast((effect) => effect.kind === 'write-brief' && effect.stage === 'task'
    && (effect.input['task'] as { id?: string } | undefined)?.id === 'T2');
  assert.ok(brief?.kind === 'write-brief');
  if (brief?.kind !== 'write-brief') return;
  const settledScope = brief.input['settledScope'] as { acceptedAdjustments: unknown[] };
  assert.deepEqual(settledScope.acceptedAdjustments, []);

  result = launch(result, sim, trace);
  result = submit(result, 'T2', sim, trace);
  const taskVerify = trace.effects.flatMap((effect) => effect.kind === 'verify' && effect.purpose === 'green' ? effect.commands : []);
  assert.ok(taskVerify.every((command) => command['command'] !== 'check-old-command'));
});

test('level-journal: accepted hotfix scope appears in the next hotfix brief', () => {
  let result = recoveryHost(approvalState(), { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } });
  if (result.state.tag !== 'level-classification') throw new Error('level classification');
  result = recoveryHost(result.state, { type: 'DECISION', kind: 'level-classification', answer: {
    evaluatedLevel: 'low', rationale: 'A bounded local repair with a clear check.', gateScope: implementData(result.state)['gateScope'],
  } });
  if (!('c' in result.state) || !result.state.c) throw new Error('settled implementation context');
  const adjustment: ScopeAdjustment = {
    proposal: { requestId: 'hotfix-scope-1', source: 'hotfix', baseArtifactHash: HASH, writerRationale: 'The repair requires the companion path.', delta: {
      paths: ['src/extra.ts'], criteria: [], obligations: ['Preserve companion behavior'], commands: [], phaseDuties: [], increments: [],
    } },
    approvedBy: 'orchestrator', rationale: 'The companion path is necessary to repair the observed failure.',
  };
  const c: Context = {
    ...result.state.c, phase: 'delivered', lastFingerprint: recoveryFingerprint,
    stalled: { purpose: 'final', rows: [failedRow] }, scopeAdjustments: [adjustment],
    scopeNotice: { requestId: 'hotfix-scope-1', approvedBy: 'orchestrator', rationale: 'The companion path is necessary to repair the observed failure.' },
  };
  const failure: ImplementState = { tag: 'failure', c, reason: 'The final check failed.', changedPaths: [] };
  const hotfix = recoveryHost(failure, { type: 'DECISION', kind: 'failure', answer: { action: 'hotfix', rootCause: 'Repair the companion path.' } });
  const effect = hotfix.effects.find((candidate) => candidate.kind === 'write-brief');
  assert.ok(effect?.kind === 'write-brief' && effect.stage === 'hotfix');
  if (effect?.kind !== 'write-brief') return;
  const input = effect.input as Readonly<Record<string, unknown>>;
  const scope = input['settledScope'] as { paths: string[]; approvedPaths: string[] };
  const hotfixScope = input['hotfix'] as { paths: string[] };
  const envelopeSchema = input['envelopeSchema'] as { status: string[] };
  assert.ok(scope.paths.includes('src/extra.ts'));
  assert.ok(scope.approvedPaths.includes('src/extra.ts'));
  assert.ok(hotfixScope.paths.includes('src/extra.ts'));
  assert.ok(envelopeSchema.status.includes('SCOPE_REQUEST'));

  const resumed = stepImplement(hotfix.state, { type: 'BRIEF_READY', effectId: effect.id, stage: 'hotfix', path: 'hotfix.brief', sha256: HASH, envelopePath: 'hotfix.outcome' });
  assert.equal(resumed.state.tag, 'hotfix-write');
  const frame = implementData(resumed.state);
  assert.deepEqual(frame['scopeNotice'], { requestId: 'hotfix-scope-1', approvedBy: 'orchestrator', rationale: 'The companion path is necessary to repair the observed failure.' });
  const accepted = frame['acceptedAdjustments'] as { requestId: string; rationale: string; delta: { paths: string[] } }[];
  assert.deepEqual(accepted.map(({ requestId, rationale, delta }) => [requestId, rationale, delta.paths]), [
    ['hotfix-scope-1', 'The companion path is necessary to repair the observed failure.', ['src/extra.ts']],
  ]);
});

test('level-journal: run-stop waits for every original writer attempt and launches no replacement', () => {
  const sim = scopedSimulation();
  let { result, trace } = start(2, sim);
  result = launch(result, sim, trace);
  result = submit(result, 'T1', sim, trace);
  result = host(result, { type: 'DECISION', kind: 'run-stop', answer: { by: 'user', quote: 'Stop this run.' } }, sim, trace);
  assert.equal(result.state.tag, 'scope-draining');
  const sibling = taskReceipt(result, 'T2');
  const before = trace.effects.filter((effect) => effect.kind === 'checkout' && effect.op === 'task').length;
  result = host(result, { type: 'WRITE_CANCELLED', ...sibling, reason: 'Writer confirmed cancellation.' } as Event, sim, trace);
  assert.equal(result.state.tag, 'stopped');
  assert.equal(trace.effects.filter((effect) => effect.kind === 'checkout' && effect.op === 'task').length, before);
  assert.equal(implementData(result.state)['outcome'], 'stopped');
});

test('level-journal: run-stop is rejected at legacy decision gates', () => {
  const state = approvalState();
  assert.equal(state.tag, 'approval');
  assert.match(validateImplement(state, { type: 'DECISION', kind: 'run-stop', answer: { by: 'user', quote: 'Stop this run.' } }) ?? '', /run-stop is valid only/);
});

test('prewrite-level: user-declined deviation keeps the original plan and task identities', () => {
  const sim = scopedSimulation();
  let { result, trace } = start(1, sim);
  result = launch(result, sim, trace);
  const originalHash = result.state.tag === 'tasks' ? result.state.c.planHash : null;
  const originalSignature = result.state.tag === 'tasks' ? result.state.c.tasks['T1']?.signature : null;
  result = submit(result, 'T1', sim, trace);
  result = approve(result, sim, trace, 'disagree');
  if (result.state.tag !== 'scope-user-decision') throw new Error('user decision is not pending');
  result = host(result, { type: 'DECISION', kind: 'scope-deviation-user', answer: { by: 'user', requestId: result.state.request.requestId, choice: 'decline', quote: 'Keep the approved scope.' } }, sim, trace);
  assert.equal(result.state.tag, 'tasks');
  if (result.state.tag !== 'tasks') return;
  assert.equal(result.state.c.planHash, originalHash);
  assert.deepEqual(effectivePlan(result.state.c).changes, result.state.c.plan?.changes);
  assert.deepEqual(Object.keys(result.state.c.tasks), PLAN.tasks.map((task) => task.id));
  assert.equal(result.state.c.tasks['T1']?.signature, originalSignature);
  assert.equal(result.state.c.scopeAdjustments.length, 0);
  assert.equal(result.state.c.scopeNotice, null);
});

test('level-journal: stale launch, envelope, and failure receipts cannot bind a replacement task attempt', () => {
  const sim = scopedSimulation();
  let { result, trace } = start(1, sim);
  result = launch(result, sim, trace);
  if (result.state.tag !== 'tasks') throw new Error('tasks');
  const prior = result.state.c.tasks['T1']!;
  const replacement: ImplementState = {
    ...result.state,
    c: { ...result.state.c, tasks: { ...result.state.c.tasks, T1: { ...prior, attempt: prior.attempt + 1, signature: 'replacement-signature', handle: null } } },
  };
  const stale = { task: 'T1', attempt: prior.attempt, signature: prior.signature, handle: prior.handle! };
  assert.match(validateImplement(replacement, { type: 'WRITE_LAUNCHED', tasks: [{ ...stale, handle: 'late-launch', model: result.state.c.writer!.models[prior.modelIndex]! }] }) ?? '', /echo its projected attempt and signature/);
  assert.match(validateImplement(replacement, { type: 'WRITE_ENVELOPE', ...stale, envelopePath: prior.brief!.envelopePath }) ?? '', /active task, attempt, signature, handle/);
  assert.match(validateImplement(replacement, { type: 'WRITE_FAILED', ...stale, model: result.state.c.writer!.models[prior.modelIndex]!, kind: 'integrity', reason: 'stale failure' }) ?? '', /active task, attempt, signature and handle/);
  assert.equal(replacement.c.tasks['T1']?.attempt, prior.attempt + 1);
});

test('level-journal: cancellation receipts are rejected outside scope draining', () => {
  const sim = scopedSimulation();
  const { result } = start(1, sim);
  assert.equal(result.state.tag, 'tasks');
  if (result.state.tag !== 'tasks') return;
  const record = result.state.c.tasks['T1']!;
  assert.match(validateImplement(result.state, { type: 'WRITE_CANCELLED', task: 'T1', attempt: record.attempt, signature: record.signature, handle: 'writer', reason: 'cancelled' }) ?? '', /only while draining scope changes/);
});

test('level-journal: partial launch scope approval requeues unlaunched slots and run stop settles', () => {
  const sim = scopedSimulation();
  let { result, trace } = start(2, sim);
  const first = slots(result).find((slot) => slot.task === 'T1')!;
  result = host(result, { type: 'WRITE_LAUNCHED', tasks: [{ task: first.task, attempt: first.attempt, signature: first.signature, handle: 'agent-T1', model: first.model }] }, sim, trace);
  result = submit(result, 'T1', sim, trace);
  assert.equal(result.state.tag, 'scope-adjudication');
  if (result.state.tag !== 'scope-adjudication') throw new Error('scope adjudication');
  assert.equal(result.state.c.tasks['T2']?.status, 'pending');
  result = approve(result, sim, trace);
  assert.equal(result.state.tag, 'tasks');
  if (result.state.tag === 'tasks') assert.notEqual(result.state.c.tasks['T2']?.status, 'submitted');

  const stopSim = scopedSimulation();
  let stopped = start(2, stopSim);
  const stopSlot = slots(stopped.result).find((slot) => slot.task === 'T1')!;
  stopped.result = host(stopped.result, { type: 'WRITE_LAUNCHED', tasks: [{ task: stopSlot.task, attempt: stopSlot.attempt, signature: stopSlot.signature, handle: 'agent-T1', model: stopSlot.model }] }, stopSim, stopped.trace);
  stopped.result = submit(stopped.result, 'T1', stopSim, stopped.trace);
  stopped.result = host(stopped.result, { type: 'DECISION', kind: 'run-stop', answer: { by: 'user', quote: 'Stop this run.' } }, stopSim, stopped.trace);
  assert.equal(stopped.result.state.tag, 'stopped');
});

test('level-journal: accepted sibling invalidated by a criterion replacement rewinds integration', () => {
  const definition = {
    id: 'SC2', title: 'Updated second criterion', changes: ['src/b.ts'], verify: [{ command: 'verify-updated-second', final: false }],
    evidence: 'verify' as const, preExisting: false, redException: null, testRationale: null, review: null, enforcementInfeasibility: null,
  };
  const expandedRequest = { ...request(), delta: { ...delta, paths: ['src/b.ts', 'src/extra.ts'], criteria: ['SC2'], criterionDefinitions: [definition] } };
  const base = scopedSimulation();
  const sim: Sim = { ...base, envelope: (id) => id === 'T1' ? { ...scopeEnvelope(), scopeRequest: expandedRequest } : base.envelope!(id) };
  let { result, trace } = start(2, sim);
  result = launch(result, sim, trace);
  result = submit(result, 'T2', sim, trace);
  if (result.state.tag !== 'tasks') throw new Error('T2 should be accepted while T1 remains active');
  const acceptedHead = result.state.c.integration?.head;
  assert.equal(result.state.c.tasks['T2']?.status, 'accepted');
  result = submit(result, 'T1', sim, trace);
  assert.equal(result.state.tag, 'scope-adjudication');
  result = approve(result, sim, trace);
  assert.equal(result.state.tag, 'tasks');
  if (result.state.tag !== 'tasks') return;
  assert.ok(trace.effects.some((effect) => effect.kind === 'checkout' && effect.op === 'reset' && effect.input['name'] === 'integration'));
  assert.notEqual(result.state.c.integration?.head, acceptedHead);
  assert.notEqual(result.state.c.tasks['T2']?.status, 'accepted');
  const effective = effectivePlan(result.state.c);
  for (const task of effective.tasks) assert.equal(result.state.c.tasks[task.id]?.signature, taskSignature(effective, task));
  const withUnchangedAccepted = { ...result.state.c.tasks, T3: { ...result.state.c.tasks['T3']!, status: 'accepted' as const } };
  assert.equal(reconcileTasks(withUnchangedAccepted, effective)['T3']?.status, 'accepted');
});
