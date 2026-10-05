import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScopeAdjustment } from '../../../skills/dispatch/scripts/core/types.ts';
import { planReviewContext, implementData, stepImplement, type ImplementState } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { executionDelta } from '../../../skills/dispatch/scripts/domain/execution-config.ts';
import { initialTasks } from '../../../skills/dispatch/scripts/machines/implement-tasks.ts';
import { approvalState, host, RUN } from './implement-recovery.test.ts';
import { rootMachine, type RootState } from '../../../skills/dispatch/scripts/machines/root.ts';

const HASH = `sha256:${'a'.repeat(64)}`;
const FP = { head: 'h', index: 'i', worktree: 'w' };

function withWriters(low: string, medium: string, high: string) {
  return {
    ...RUN,
    config: {
      ...RUN.config,
      'write-subagents': { claude: { low: { model: [low] }, medium: { model: [medium] }, high: { model: [high] } } },
    },
  };
}

test('level-journal: a writer refresh during the gate cannot override the settled level after replay', () => {
  const before = withWriters('writer-low', 'writer-medium', 'writer-high');
  const after = withWriters('writer-low-refreshed', 'writer-medium-refreshed', 'writer-high-refreshed');
  let gate = host(approvalState(), { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } }).state;
  assert.equal(gate.tag, 'level-classification');
  if (gate.tag !== 'level-classification') return;
  gate = { ...gate, c: { ...gate.c, run: before } };
  const root: RootState = { tag: 'implement', run: { verb: 'implement', argument: before.argument, slug: 'x', defaults: before }, child: gate };
  const event = { type: 'EXECUTION_CONFIG_UPDATED' as const, revision: 1, boundarySeq: 1, delta: executionDelta(before.config, after.config) };
  const refreshed = rootMachine.reconfigure?.(root, event);
  assert.ok(refreshed && refreshed.tag === 'implement' && refreshed.child.tag === 'level-classification');
  if (!refreshed || refreshed.tag !== 'implement' || refreshed.child.tag !== 'level-classification') return;
  assert.deepEqual(refreshed.child.c.pendingWriter?.models, ['writer-low-refreshed']);
  const gateScope = implementData(refreshed.child)['gateScope'];
  let choice = host(refreshed.child, { type: 'DECISION', kind: 'level-classification', answer: {
    evaluatedLevel: 'high', rationale: 'The governed workflow has a meaningful recovery boundary.', gateScope,
  } });
  assert.equal(choice.state.tag, 'level-recommendation');
  if (choice.state.tag !== 'level-recommendation') return;
  choice = host(choice.state, { type: 'DECISION', kind: 'level-recommendation', answer: { choice: 'adopt', quote: 'Adopt high for this run.' } });
  assert.equal(choice.state.tag, 'task-checkout');
  if (choice.state.tag !== 'task-checkout') return;
  assert.equal(choice.state.c.run.level, 'high');
  assert.equal(choice.state.c.run.levelSource, 'explicit');
  assert.deepEqual(choice.state.c.writer?.models, ['writer-high-refreshed']);
  assert.equal(choice.state.c.pendingWriter, undefined);
  assert.deepEqual(choice.state.c.gateScope, gateScope);
  assert.equal(choice.state.c.levelChoice?.quote, 'Adopt high for this run.');
});

test('level-journal: inherited gate data stays out of later plan review and brief projection is bounded', () => {
  let result = host(approvalState(), { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } });
  if (result.state.tag !== 'level-classification') throw new Error('classification gate');
  const rawScope = implementData(result.state)['gateScope'] as Record<string, unknown>;
  const delta = { paths: ['src/extra.ts'], criteria: [], obligations: ['private obligation'], commands: [], phaseDuties: [], increments: [] };
  const adjustment: ScopeAdjustment = {
    proposal: { requestId: 'private-scope-request', source: 'task', task: 'T1', baseArtifactHash: HASH, writerRationale: 'private writer rationale', delta },
    approvedBy: 'user', rationale: 'private orchestrator rationale', quote: 'private scope quote', ownerIncrement: 'I01',
  };
  const binding = {
    path: 'design/example.design.md', revision: HASH, increment: 'I01', contract: { Outcome: 'Deliver the example' }, paths: ['src/a.ts'],
    approval: { by: 'user' as const, quote: 'private approval quote', hash: HASH }, repair: [],
    governingDesign: { path: 'design/example.design.md', hash: HASH, title: 'Example design', objective: 'Deliver the example', invariants: ['Preserve stored values'], fields: { 'TL;DR': 'Deliver the example' }, remainingIncrements: [] },
    levelGatePassed: true, gateScope: rawScope as never,
    levelAssessment: { evaluatedLevel: 'low' as const, rationale: 'private assessment rationale', gateScope: rawScope as never },
    levelChoice: { choice: 'retain' as const, quote: 'private level quote' }, scopeAdjustments: [adjustment],
    scopeNotice: { requestId: adjustment.proposal.requestId, approvedBy: 'user' as const, rationale: 'private notice rationale', quote: 'private notice quote' },
  };
  const context = { ...result.state.c, tasks: initialTasks(result.state.c.plan!), designBinding: binding, scopeAdjustments: [adjustment] };
  const briefState: ImplementState = { tag: 'task-prewrite-snapshot', c: context, effectId: 'brief-snapshot', task: 'T1' };
  const briefResult = stepImplement(briefState, { type: 'SNAPSHOT', effectId: 'brief-snapshot', fingerprint: FP, diff: { paths: [] } });
  const briefEffect = briefResult.effects.find((effect) => effect.kind === 'write-brief');
  assert.ok(briefEffect?.kind === 'write-brief');
  if (briefEffect?.kind !== 'write-brief') return;
  const renderedInput = JSON.stringify(briefEffect.input);
  for (const privateText of ['private assessment rationale', 'private level quote', 'private scope quote', 'private notice quote', 'private writer rationale', 'private orchestrator rationale']) assert.equal(renderedInput.includes(privateText), false, privateText);
  assert.match(renderedInput, /Preserve stored values/);
  assert.match(renderedInput, /"settledLevel":"low"/);
  assert.match(renderedInput, /"delta":\{"paths":\["src\/extra\.ts"\]/);
  const reviewContext = JSON.parse(planReviewContext(context, 'the original invocation context') as string) as Record<string, unknown>;
  assert.deepEqual(reviewContext, { invocationContext: 'the original invocation context', invocationLevel: 'low', invocationLevelSource: 'explicit' });
});
