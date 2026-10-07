import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginRevision, stepRevision, revisionDelta, reboundRevision, validateRevision, type RevisionState } from '../../../skills/dispatch/scripts/machines/revision.ts';
import { effectivePlan, validateImplement, type ImplementState } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { asParsedPlan } from '../../../skills/dispatch/scripts/machines/implement-types.ts';
import { rootMachine, stepRoot, type RootState } from '../../../skills/dispatch/scripts/machines/root.ts';
import type { ScopeAdjustment, ScopeProposal } from '../../../skills/dispatch/scripts/core/types.ts';
import { initialTasks, taskSignature } from '../../../skills/dispatch/scripts/machines/implement-tasks.ts';
import type { ParsedPlan } from '../../../skills/dispatch/scripts/domain/types.ts';
import { approvalState, PLAN, HASH, FP, host } from './fixtures/implement-recovery.ts';

const revision = { type: 'REVISE' as const, artifact: 'plan' as const, reason: 'blocked-by-plan', evidence: 'stalled check report' };
function parsed(plan: Record<string, unknown> = PLAN, hash = `sha256:${'b'.repeat(64)}`) {
  let r = beginRevision(approvalState(), revision);
  const path = r.state.r.workingPath;
  r = stepRevision(r.state, { type: 'AUTHORED', path }); assert.equal(r.state.tag, 'checking-host-event');
  r = stepRevision(r.state, { type: 'SNAPSHOT', effectId: r.effects[0]!.id, fingerprint: FP, diff: { paths: [] } });
  r = stepRevision(r.state, { type: 'ARTIFACT_PARSED', effectId: r.effects[0]!.id, kind: 'plan', hash, parsed: plan, defects: [] });
  return r;
}
test('REVISE allowed at governed approval/evidence/failure/review awaits; outstanding write refused', () => {
  const c = approvalState().c;
  for (const parent of [{ tag: 'approval', c }, { tag: 'evidence', c, purpose: 'final', ids: ['SC1'], verify: [] }, { tag: 'failure', c, reason: 'blocked-by-plan', changedPaths: [] }] as ImplementState[]) {
    assert.equal(validateImplement(parent, revision), null);
    assert.equal(host(parent, revision).state.tag, 'revision-request');
  }
  const pending: ImplementState = { tag: 'tasks', c: { ...c, phase: 'tasks' } };
  assert.match(validateImplement(pending, revision) ?? '', /outstanding write/);
});

test('REVISE waits for original writers during scope adjudication', () => {
  const request: ScopeProposal = {
    requestId: 'revision-drain', source: 'task', task: 'T1', baseArtifactHash: HASH,
    writerRationale: 'The required work needs a companion module.',
    delta: { paths: ['src/extra.ts'], criteria: [], obligations: [], commands: [], phaseDuties: [], increments: [] },
  };
  const base = approvalState().c;
  const run = { verb: 'implement' as const, argument: 'x.plan.md', slug: 'x' };
  const root = (child: ImplementState): RootState => ({ tag: 'implement', run, child });
  const adjudication: ImplementState = { tag: 'scope-adjudication', c: base, request, task: 'T1', active: ['T2'], hotfixResume: null };
  const userDecision: ImplementState = { tag: 'scope-user-decision', c: base, request, task: 'T1', active: ['T2'], orchestratorRationale: 'I disagree with the requested expansion.', hotfixResume: null };
  for (const child of [adjudication, userDecision]) {
    assert.match(rootMachine.validate!(root(child), revision) ?? '', /drain every active writer/);
  }
  assert.equal(rootMachine.validate!(root({ ...adjudication, active: [] }), revision), null);
});

test('REVISE cannot reuse a pending level classification or recommendation', () => {
  const run = { verb: 'implement' as const, argument: 'x.plan.md', slug: 'x' };
  const root = (child: ImplementState): RootState => ({ tag: 'implement', run, child });
  const classification = host(approvalState(), { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } }).state;
  assert.equal(classification.tag, 'level-classification');
  assert.match(rootMachine.validate!(root(classification), revision) ?? '', /pending level gate/);
  if (classification.tag !== 'level-classification') return;
  const recommendation = host(classification, { type: 'DECISION', kind: 'level-classification', answer: {
    evaluatedLevel: 'high', rationale: 'The implementation scope has significant cross-cutting risk.', gateScope: classification.gateScope,
  } }).state;
  assert.equal(recommendation.tag, 'level-recommendation');
  assert.match(rootMachine.validate!(root(recommendation), revision) ?? '', /pending level gate/);
});

test('delta review includes governed changes even when criterion IDs and mappings are unchanged', () => {
  const result = parsed({ ...PLAN, keyDecisions: ['new constraint'], governedText: 'new governed context' });
  assert.equal(result.state.tag, 'review');
  const effect = result.effects[0]; assert.equal(effect?.kind, 'prepare-review');
  if (effect?.kind === 'prepare-review') { assert.equal(effect.scope['scope'], 'delta'); assert.equal(effect.scope['sinceHash'], HASH); assert.equal(effect.scope['beforeText'], PLAN.governedText); assert.ok(String(effect.review['context']).includes('new governed context')); }
});
test('unchanged mapped evidence retained; changed/new pending; removed deviations and full revision log', () => {
  const original = asParsedPlan(PLAN)!;
  const revised = asParsedPlan({ ...PLAN, criteria: [PLAN.criteria[0], { ...PLAN.criteria[0], id: 'SC2', title: 'new' }], governedText: 'revised' })!;
  assert.deepEqual(revisionDelta(original, revised).changed, ['SC2']);
  const parent = approvalState();
  const r = beginRevision({ ...parent, c: { ...parent.c, evidence: { SC1: { id: 'SC1', planHash: HASH, mutationEpoch: 0, source: 'verify', outcome: 'pass', evidence: 'passed' } } } }, revision).state.r;
  const resumed: Extract<RevisionState, { tag: 'resume' }> = { tag: 'resume', r: { ...r, plan: revised, hash: `sha256:${'b'.repeat(64)}`, changed: ['SC2'], removed: [], grew: false } };
  const c = reboundRevision(resumed); assert.ok(c.evidence['SC1']); assert.equal(c.evidence['SC2'], undefined); assert.equal(c.evidence['SC1']?.planHash, resumed.r.hash);
  assert.deepEqual(reboundRevision(resumed), c);
  assert.equal(c.revisions[0]?.beforeHash, HASH); assert.equal(c.revisions[0]?.afterHash, resumed.r.hash); assert.deepEqual(c.revisions[0]?.rebind.pending, ['SC2']);
  const removed = reboundRevision({ ...resumed, r: { ...resumed.r, plan: { ...revised, criteria: [] }, changed: [], removed: ['SC1'] } });
  assert.equal(Object.keys(removed.evidence).length, 0); assert.ok(removed.concerns.some((row) => row.includes('removed criterion SC1')));
});
test('objective refusal names TL;DR; approval only for expanded paths or commands', () => {
  const refused = parsed({ ...PLAN, box: { 'TL;DR': 'different objective' } });
  assert.equal(refused.state.tag, 'refused'); if (refused.state.tag === 'refused') assert.match(refused.state.error, /TL;DR/);
  const plan = asParsedPlan(PLAN)!;
  assert.equal(revisionDelta(plan, { ...plan, criteria: [{ ...plan.criteria[0]!, title: 'renamed' }] }).grew, false);
  assert.equal(revisionDelta(plan, { ...plan, changes: [...plan.changes, { ...plan.changes[0]!, path: 'new.ts' }] }).grew, true);
  assert.equal(revisionDelta(plan, { ...plan, criteria: [{ ...plan.criteria[0]!, verify: [{ command: 'new command', final: false }] }] }).grew, true);
});
test('prewrite-level: plan growth before the initial gate preserves the revision and approval path', () => {
  const base = beginRevision(approvalState(), revision).state.r;
  const expanded = { ...PLAN, changes: [...PLAN.changes, { action: 'MODIFY' as const, path: 'src/extra.ts', note: 'required companion', command: null, line: 2 }] };
  const state: RevisionState = { tag: 'parse', r: { ...base, c: { ...base.c, levelGatePassed: false } }, effectId: 'pre-gate-plan', afterReview: true };
  const result = stepRevision(state, { type: 'ARTIFACT_PARSED', effectId: state.effectId, kind: 'plan', hash: `sha256:${'b'.repeat(64)}`, parsed: expanded, defects: [] });
  assert.equal(result.state.tag, 'resume');
  assert.deepEqual(result.effects, []);
});

test('prewrite-level: expanded criteria are proposed to the orchestrator before adoption', () => {
  const initial = beginRevision(approvalState(), revision).state.r;
  const base = { ...initial, c: { ...initial.c, levelGatePassed: true } };
  const expanded = {
    ...PLAN,
    criteria: [...PLAN.criteria, { ...PLAN.criteria[0]!, id: 'SC4', title: 'Additional criterion on an approved path', changes: ['src/a.ts'], verify: [], evidence: 'verify', testRationale: 'Checks the additional accepted criterion.', line: 20 }],
    tasks: PLAN.tasks.map((task) => task.id === 'T1' ? { ...task, criteria: [...task.criteria, 'SC4'] } : task),
  };
  const result = stepRevision({ tag: 'parse', r: base, effectId: 'criteria-only', afterReview: true }, {
    type: 'ARTIFACT_PARSED', effectId: 'criteria-only', kind: 'plan', hash: `sha256:${'d'.repeat(64)}`, parsed: expanded, defects: [],
  });
  assert.equal(result.state.tag, 'scope-adjudication');
  if (result.state.tag !== 'scope-adjudication') return;
  assert.deepEqual(result.state.request.delta.paths, []);
  assert.deepEqual(result.state.request.delta.commands, []);
  assert.deepEqual(result.state.request.delta.criteria, ['SC4']);
  if (result.state.request.source !== 'plan-revision') throw new Error('plan revision proposal');
  assert.deepEqual(result.state.request.affectedTasks, ['T1']);
});

test('revision author await snapshots drift and refuses incomplete per-path settlement', () => {
  let r = beginRevision(approvalState(), revision);
  r = stepRevision(r.state, { type: 'AUTHORED', path: r.state.r.workingPath });
  r = stepRevision(r.state, { type: 'SNAPSHOT', effectId: r.effects[0]!.id, fingerprint: FP, diff: { paths: ['unexpected'] } });
  assert.equal(r.state.tag, 'drift');
  r = stepRevision(r.state, { type: 'DECISION', kind: 'drift', answer: { unexpected: 'adopt' } });
  assert.equal(r.state.tag, 'parse'); assert.ok(r.state.r.c.finalFocus.includes('unexpected'));
});

test('level-journal: revision scope adjudication journals and settles run-stop after its host snapshot', () => {
  const base = beginRevision(approvalState(), revision).state.r;
  const request = {
    requestId: 'revision-scope-stop', source: 'plan-revision' as const,
    baseArtifactHash: HASH, proposedArtifactHash: `sha256:${'b'.repeat(64)}`,
    affectedTasks: ['SC1'], rationale: 'Revision changes approved work.',
    delta: { paths: ['src/other.ts'], criteria: ['SC2'], commands: [], obligations: [], phaseDuties: [], increments: [] },
  };
  const adjudication: RevisionState = { tag: 'scope-adjudication', r: base, request };
  const userChoice: RevisionState = { tag: 'scope-user-decision', r: base, request, orchestratorRationale: 'I disagree with the proposed expansion.' };
  for (const state of [adjudication, userChoice]) {
    let result = stepRevision(state, { type: 'DECISION', kind: 'run-stop', answer: { by: 'user', quote: 'Stop this run.' } });
    assert.equal(result.state.tag, 'checking-host-event');
    const snapshot = result.effects[0]; assert.equal(snapshot?.kind, 'snapshot');
    if (result.state.tag !== 'checking-host-event' || snapshot?.kind !== 'snapshot') throw new Error('expected journaled stop');
    result = stepRevision(result.state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: FP, diff: { paths: [] } });
    assert.equal(result.state.tag, 'stopped');
    if (result.state.tag === 'stopped') assert.match(result.state.summary, /User stopped during plan-revision scope adjudication/);
  }
});

test('level-journal: plan-revision proposal binds artifact hashes and affected tasks', () => {
  const initial = beginRevision(approvalState(), revision).state.r;
  const base = { ...initial, c: { ...initial.c, levelGatePassed: true } };
  const expanded = {
    ...PLAN,
    changes: [...PLAN.changes, { action: 'MODIFY' as const, path: 'src/extra.ts', note: 'required companion', command: null, line: 9 }],
    criteria: PLAN.criteria.map((row) => row.id === 'SC1' ? { ...row, changes: [...row.changes, 'src/extra.ts'] } : row),
    tasks: PLAN.tasks.map((task) => task.id === 'T1' ? { ...task, paths: [...task.paths, 'src/extra.ts'] } : task),
  } as ParsedPlan;
  const hash = `sha256:${'b'.repeat(64)}`;
  const proposed = stepRevision({ tag: 'parse', r: base, effectId: 'proposal.parse', afterReview: true }, { type: 'ARTIFACT_PARSED', effectId: 'proposal.parse', kind: 'plan', hash, parsed: expanded, defects: [] });
  if (proposed.state.tag !== 'scope-adjudication') throw new Error('expanded revision should request scope adjudication');
  const request = proposed.state.request;
  if (request.source !== 'plan-revision') throw new Error('plan revision proposal should bind a plan artifact');
  assert.equal(request.baseArtifactHash, HASH);
  assert.equal(request.proposedArtifactHash, hash);
  assert.deepEqual(request.affectedTasks, ['T1']);

  const mismatchedRequest = { ...request, affectedTasks: ['T2'] };
  assert.match(validateRevision(proposed.state, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request: mismatchedRequest, ruling: 'approve', rationale: 'Approve the stated work.' } }) ?? '', /bind the pending revision proposal/);
  const reorderedRequest = Object.fromEntries(Object.entries(request).reverse()) as typeof request;
  const approvalEvent = { type: 'DECISION' as const, kind: 'scope-deviation' as const, answer: { by: 'orchestrator' as const, request: reorderedRequest, ruling: 'approve' as const, rationale: 'Approve the stated work.' } };
  assert.equal(validateRevision(proposed.state, approvalEvent), null);
  const orchestratorApproval = stepRevision(proposed.state, approvalEvent);
  assert.equal(orchestratorApproval.state.tag, 'checking-host-event');
  if (orchestratorApproval.state.tag !== 'checking-host-event') throw new Error('approval should be snapshotted');
  const approvalSnapshot = orchestratorApproval.effects[0]!;
  const approved = stepRevision(orchestratorApproval.state, { type: 'SNAPSHOT', effectId: approvalSnapshot.id, fingerprint: FP, diff: { paths: [] } });
  assert.equal(approved.state.tag, 'resume');
  if (approved.state.tag !== 'resume') throw new Error('approval should resume');
  const orchestratorPlan = effectivePlan(approved.state.r.c);
  assert.ok(orchestratorPlan.tasks.find((task) => task.id === 'T1')?.paths.includes('src/extra.ts'));
  assert.deepEqual(orchestratorPlan.tasks.filter((task) => task.paths.includes('src/extra.ts')).map((task) => task.id), request.affectedTasks);

  const disagreement = stepRevision(proposed.state, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request, ruling: 'disagree', rationale: 'The proposed scope is too broad.' } });
  if (disagreement.state.tag !== 'checking-host-event') throw new Error('disagreement should be snapshotted');
  const disagreementSnapshot = disagreement.effects[0]!;
  const userDecision = stepRevision(disagreement.state, { type: 'SNAPSHOT', effectId: disagreementSnapshot.id, fingerprint: FP, diff: { paths: [] } });
  if (userDecision.state.tag !== 'scope-user-decision') throw new Error('user decision should follow disagreement');
  const wrongUserChoice = { type: 'DECISION', kind: 'scope-deviation-user', answer: { by: 'user', requestId: 'different-request', choice: 'accept', quote: 'Accept this scope.' } } as const;
  assert.match(validateRevision(userDecision.state, wrongUserChoice) ?? '', /bind the pending revision request/);
  const accepted = stepRevision(userDecision.state, { type: 'DECISION', kind: 'scope-deviation-user', answer: { by: 'user', requestId: request.requestId, choice: 'accept', quote: 'Accept this scope.' } });
  if (accepted.state.tag !== 'checking-host-event') throw new Error('user acceptance should be snapshotted');
  const userSnapshot = accepted.effects[0]!;
  const userApproved = stepRevision(accepted.state, { type: 'SNAPSHOT', effectId: userSnapshot.id, fingerprint: FP, diff: { paths: [] } });
  assert.equal(userApproved.state.tag, 'resume');
  if (userApproved.state.tag !== 'resume') throw new Error('user acceptance should resume');
  const userPlan = effectivePlan(userApproved.state.r.c);
  assert.ok(userPlan.tasks.find((task) => task.id === 'T1')?.paths.includes('src/extra.ts'));
  assert.deepEqual(userPlan.tasks.filter((task) => task.paths.includes('src/extra.ts')).map((task) => task.id), request.affectedTasks);
});

test('level-journal: plan revision rulings bind orchestrator and user decisions to the pending proposal', () => {
  const initial = beginRevision(approvalState(), revision).state.r;
  const base = { ...initial, c: { ...initial.c, levelGatePassed: true } };
  const expanded = {
    ...PLAN,
    changes: [...PLAN.changes, { action: 'MODIFY' as const, path: 'src/extra.ts', note: 'required companion', command: null, line: 9 }],
    criteria: PLAN.criteria.map((row) => row.id === 'SC1' ? { ...row, changes: [...row.changes, 'src/extra.ts'] } : row),
    tasks: PLAN.tasks.map((task) => task.id === 'T1' ? { ...task, paths: [...task.paths, 'src/extra.ts'] } : task),
  };
  const proposed = stepRevision({ tag: 'parse', r: base, effectId: 'proposal.parse', afterReview: true }, { type: 'ARTIFACT_PARSED', effectId: 'proposal.parse', kind: 'plan', hash: `sha256:${'b'.repeat(64)}`, parsed: expanded, defects: [] });
  if (proposed.state.tag !== 'scope-adjudication') throw new Error('expanded revision should request adjudication');
  const request = proposed.state.request;
  assert.match(validateRevision(proposed.state, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request: { ...request, proposedArtifactHash: HASH }, ruling: 'approve', rationale: 'Approve this scope.' } }) ?? '', /bind the pending revision proposal/);
  const disagreement = stepRevision(proposed.state, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request, ruling: 'disagree', rationale: 'The writer should narrow this change.' } });
  if (disagreement.state.tag !== 'checking-host-event') throw new Error('disagreement should be journaled');
  const userAwait = stepRevision(disagreement.state, { type: 'SNAPSHOT', effectId: disagreement.effects[0]!.id, fingerprint: FP, diff: { paths: [] } });
  if (userAwait.state.tag !== 'scope-user-decision') throw new Error('disagreement should request the user choice');
  assert.match(validateRevision(userAwait.state, { type: 'DECISION', kind: 'scope-deviation-user', answer: { by: 'user', requestId: 'stale', choice: 'accept', quote: 'Accept.' } }) ?? '', /bind the pending revision request/);
  const accepted = stepRevision(userAwait.state, { type: 'DECISION', kind: 'scope-deviation-user', answer: { by: 'user', requestId: request.requestId, choice: 'accept', quote: 'Accept the expanded plan.' } });
  if (accepted.state.tag !== 'checking-host-event') throw new Error('user acceptance should be journaled');
  const resumed = stepRevision(accepted.state, { type: 'SNAPSHOT', effectId: accepted.effects[0]!.id, fingerprint: FP, diff: { paths: [] } });
  assert.equal(resumed.state.tag, 'resume');
  if (resumed.state.tag === 'resume') {
    assert.equal(resumed.state.r.scopeAdjudicated, true);
    assert.deepEqual(resumed.state.r.c.scopeNotice, { requestId: request.requestId, approvedBy: 'user', rationale: 'The writer should narrow this change.', quote: 'Accept the expanded plan.' });
  }
});

test('level-journal: plan revision retains accepted scope and adjudicates only additional growth', () => {
  const started = approvalState();
  const adjustment: ScopeAdjustment = {
    proposal: { requestId: 'earlier-task-scope', source: 'task', task: 'T1', baseArtifactHash: HASH, writerRationale: 'SC1 requires its companion path.', delta: { paths: ['src/extra.ts'], criteria: [], obligations: [], commands: [], phaseDuties: [], increments: [] } },
    approvedBy: 'orchestrator', rationale: 'The companion path is required.',
  };
  const seededContext = { ...started.c, levelGatePassed: true, scopeAdjustments: [adjustment] };
  const context = { ...seededContext, tasks: initialTasks(effectivePlan(seededContext)) };
  const parent: ImplementState = { tag: 'evidence', c: context, purpose: 'final', ids: ['SC1'], verify: [] };
  const begun = beginRevision(parent, revision).state.r;
  assert.ok(begun.original.tasks.find((task) => task.id === 'T1')?.paths.includes('src/extra.ts'));
  const expanded = {
    ...PLAN,
    changes: [...PLAN.changes, { action: 'MODIFY' as const, path: 'src/extra.ts', note: 'previously approved companion', command: null, line: 9 }, { action: 'NEW' as const, path: 'src/additional.ts', note: 'new companion', command: null, line: 10 }],
    criteria: PLAN.criteria.map((row) => row.id === 'SC1' ? { ...row, changes: [...row.changes, 'src/extra.ts', 'src/additional.ts'] } : row),
    tasks: PLAN.tasks.map((task) => task.id === 'T1' ? { ...task, paths: [...task.paths, 'src/extra.ts', 'src/additional.ts'] } : task),
  } as ParsedPlan;
  const parsedRevision = stepRevision({ tag: 'parse', r: begun, effectId: 'scope.parse', afterReview: true }, { type: 'ARTIFACT_PARSED', effectId: 'scope.parse', kind: 'plan', hash: `sha256:${'c'.repeat(64)}`, parsed: expanded, defects: [] });
  if (parsedRevision.state.tag !== 'scope-adjudication') throw new Error('additional growth should require adjudication');
  assert.deepEqual(parsedRevision.state.request.delta.paths, ['src/additional.ts']);
  if (parsedRevision.state.request.source !== 'plan-revision') throw new Error('plan revision proposal');
  assert.deepEqual(parsedRevision.state.request.affectedTasks, ['T1']);
  const decision = stepRevision(parsedRevision.state, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request: parsedRevision.state.request, ruling: 'approve', rationale: 'Only the additional companion path needs approval.' } });
  if (decision.state.tag !== 'checking-host-event') throw new Error('additional growth approval should be journaled');
  const resumed = stepRevision(decision.state, { type: 'SNAPSHOT', effectId: decision.effects[0]!.id, fingerprint: FP, diff: { paths: [] } });
  if (resumed.state.tag !== 'resume') throw new Error('revision should resume after approval');
  assert.equal(resumed.state.r.scopeAdjudicated, true);
  assert.equal(resumed.state.r.c.scopeAdjustments.length, 2);
  assert.equal(resumed.state.r.c.scopeNotice?.requestId, parsedRevision.state.request.requestId);
  const rebound = reboundRevision(resumed.state);
  assert.deepEqual([...(rebound.plan?.tasks.find((task) => task.id === 'T1')?.paths ?? [])].sort(), [...PLAN.tasks.find((task) => task.id === 'T1')!.paths, 'src/extra.ts', 'src/additional.ts'].sort());
  assert.equal(rebound.tasks['T1']?.signature, taskSignature(expanded, expanded.tasks.find((task) => task.id === 'T1')!));
});

test('level-journal: orchestrator-approved plan growth resumes at the settled level without another approval', () => {
  const original = approvalState();
  const parent: ImplementState = { tag: 'evidence', c: { ...original.c, levelGatePassed: true }, purpose: 'final', ids: ['SC1'], verify: [] };
  const begun = beginRevision(parent, revision).state.r;
  const expanded = {
    ...PLAN,
    changes: [...PLAN.changes, { action: 'MODIFY' as const, path: 'src/extra.ts', note: 'companion', command: null, line: 9 }],
    criteria: PLAN.criteria.map((row) => row.id === 'SC1' ? { ...row, changes: [...row.changes, 'src/extra.ts'] } : row),
    tasks: PLAN.tasks.map((task) => task.id === 'T1' ? { ...task, paths: [...task.paths, 'src/extra.ts'] } : task),
  };
  const proposed = stepRevision({ tag: 'parse', r: begun, effectId: 'root.parse', afterReview: true }, { type: 'ARTIFACT_PARSED', effectId: 'root.parse', kind: 'plan', hash: `sha256:${'b'.repeat(64)}`, parsed: expanded, defects: [] });
  if (proposed.state.tag !== 'scope-adjudication') throw new Error('expanded revision should request adjudication');
  const runInfo = { verb: 'implement' as const, argument: 'x.plan.md', slug: 'x' };
  let root: RootState = { tag: 'revision', run: runInfo, child: proposed.state };
  const accepted = stepRoot(root, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request: proposed.state.request, ruling: 'approve', rationale: 'The companion path completes the accepted criterion.' } });
  if (accepted.state.tag !== 'revision') throw new Error('revision should snapshot the approval before resume');
  root = accepted.state;
  const snapshot = accepted.effects.find((effect) => effect.kind === 'snapshot');
  if (!snapshot || snapshot.kind !== 'snapshot') throw new Error('approval should request a host snapshot');
  const resumed = stepRoot(root, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: FP, diff: { paths: [] } });
  assert.equal(resumed.state.tag, 'implement');
  if (resumed.state.tag === 'implement') {
    assert.notEqual(resumed.state.child.tag, 'approval');
    assert.equal('c' in resumed.state.child && resumed.state.child.c?.run.level, 'low');
    assert.equal('c' in resumed.state.child && resumed.state.child.c?.scopeNotice?.requestId, proposed.state.request.requestId);
  }
});

test('root handles terminal plan revisions and declares their transitions', () => {
  const runInfo = { verb: 'implement' as const, argument: 'x.plan.md', slug: 'x' };
  const r = beginRevision(approvalState(), revision).state.r;
  const refused: RootState = { tag: 'revision', run: runInfo, child: { tag: 'refused', r, error: 'Rejected revision.' } };
  const resumed = stepRoot(refused, { type: 'DECISION', kind: 'scope-deviation', answer: {} });
  assert.equal(resumed.state.tag, 'implement');

  const stopped: RootState = { tag: 'revision', run: runInfo, child: { tag: 'stopped', r, summary: 'Stopped by the user.' } };
  const handedOff = stepRoot(stopped, { type: 'SNAPSHOT', effectId: 'terminal.snapshot', fingerprint: FP, diff: { paths: [] } });
  assert.equal(handedOff.state.tag, 'handoff');

  const declared = new Set(rootMachine.transitions.map((row) => `${row.from} --${row.on}--> ${row.to}`));
  assert.ok(declared.has('revision --SNAPSHOT--> implement'));
  assert.ok(declared.has('revision --SNAPSHOT--> handoff'));
  assert.ok(declared.has('revision --DECISION--> implement'));
});
