import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import type { HostEvent, ScopeAdjustment } from '../../../skills/dispatch/scripts/core/types.ts';
import { awaitEnvelopes } from '../../../skills/dispatch/scripts/core/frame.ts';
import { validateHostEvent } from '../../../skills/dispatch/scripts/core/validate.ts';
import { stableValue } from '../../../skills/dispatch/scripts/domain/stable-value.ts';
import { planReviewContext, implementData, stepImplement, validateImplement, type ImplementState } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { designData, validateDesign, type DesignState } from '../../../skills/dispatch/scripts/machines/design.ts';
import { executionDelta } from '../../../skills/dispatch/scripts/domain/execution-config.ts';
import { initialTasks } from '../../../skills/dispatch/scripts/machines/implement-tasks.ts';
import { approvalState, host, RUN } from './fixtures/implement-recovery.ts';
import { approval as designApproval } from './fixtures/design.ts';
import { rootMachine, type RootState } from '../../../skills/dispatch/scripts/machines/root.ts';

const HASH = `sha256:${'a'.repeat(64)}`;
const FP = { head: 'h', index: 'i', worktree: 'w' };
const scopeHash = (scope: unknown): string => `sha256:${crypto.createHash('sha256').update(stableValue(scope)).digest('hex')}`;
const WRONG_HASH = `sha256:${'0'.repeat(64)}`;

function classificationGate(): Extract<ImplementState, { tag: 'level-classification' }> {
  const result = host(approvalState(), { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } });
  if (result.state.tag !== 'level-classification') throw new Error('classification gate');
  return result.state;
}

function classificationTemplate(data: Readonly<Record<string, unknown>>): Extract<HostEvent, { type: 'DECISION' }> {
  const template = awaitEnvelopes('decide', data).find((event) => event.type === 'DECISION' && event.kind === 'level-classification');
  if (template?.type !== 'DECISION') throw new Error('classification template');
  return template;
}

const withHash = (event: Extract<HostEvent, { type: 'DECISION' }>, gateScopeHash: string): HostEvent => ({ ...event, answer: { ...(event.answer as Record<string, unknown>), gateScopeHash } });

test('level classification binds by scope hash in the implement machine', () => {
  const gate = classificationGate();
  const data = implementData(gate);
  assert.equal(data['gateScopeHash'], scopeHash(gate.gateScope));
  const template = classificationTemplate(data);
  assert.deepEqual(Object.keys(template.answer as object).sort(), ['evaluatedLevel', 'gateScopeHash', 'rationale'], 'the template carries the hash, not the scope');
  const check = (event: unknown) => validateHostEvent('decide', event, (item) => validateImplement(gate, item));
  assert.equal(check(template).ok, true);
  assert.equal(check(withHash(template, WRONG_HASH)).ok, false);
  const { gateScopeHash: _hash, ...legacy } = template.answer as Record<string, unknown>;
  assert.equal(check({ ...template, answer: { ...legacy, gateScope: gate.gateScope } }).ok, false, 'a full scope echo is no longer an answer');
  const next = host(gate, template).state;
  assert.equal(next.tag, 'level-recommendation');
  if (next.tag !== 'level-recommendation') return;
  assert.deepEqual(next.c.gateScope, gate.gateScope, 'the stored scope comes from the gate');
  assert.equal(next.assessment.gateScopeHash, scopeHash(gate.gateScope));
});

test('level classification binds by scope hash in the design machine', () => {
  const parent = designApproval('implement');
  const gate = classificationGate();
  const state: DesignState = { tag: 'increment', c: parent.c, increment: 'I01', child: gate };
  const data = designData(state);
  assert.equal(data['gateScopeHash'], scopeHash(gate.gateScope));
  const template = classificationTemplate(data);
  assert.equal(validateDesign(state, template), null);
  assert.match(validateDesign(state, withHash(template, WRONG_HASH)) ?? '', /gateScopeHash/);
});

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
    evaluatedLevel: 'high', rationale: 'The governed workflow has a meaningful recovery boundary.', gateScopeHash: String(implementData(refreshed.child)['gateScopeHash']),
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

test('governing spec keeps inherited gate data structural and brief projection bounded', () => {
  let result = host(approvalState(), { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } });
  if (result.state.tag !== 'level-classification') throw new Error('classification gate');
  const rawScope = implementData(result.state)['gateScope'] as Record<string, unknown>;
  const delta = { paths: ['src/extra.ts'], criteria: [], obligations: ['private obligation'], commands: [], phaseDuties: [], increments: [] };
  const adjustment: ScopeAdjustment = {
    proposal: { requestId: 'private-scope-request', source: 'design-revision', affectedIncrements: ['I01'], baseArtifactHash: HASH, proposedArtifactHash: HASH, rationale: 'private writer rationale', delta },
    approvedBy: 'user', rationale: 'private orchestrator rationale', quote: 'private scope quote', ownerIncrement: 'I01',
  };
  const binding = {
    path: 'design/example.design.md', revision: HASH, increment: 'I01', contract: { Outcome: 'Deliver the example' }, paths: ['src/a.ts'],
    approval: { by: 'user' as const, quote: 'private approval quote', hash: HASH }, repair: [],
    governingDesign: { path: 'design/example.design.md', hash: HASH, title: 'Example design', objective: 'Deliver the example', invariants: ['Preserve stored values'], fields: { 'TL;DR': 'Deliver the example' }, remainingIncrements: [] },
    levelGatePassed: true, gateScope: rawScope as never,
    levelAssessment: { evaluatedLevel: 'low' as const, rationale: 'private assessment rationale', gateScopeHash: scopeHash(rawScope) },
    levelChoice: { choice: 'retain' as const, quote: 'private level quote' }, scopeAdjustments: [adjustment],
    scopeNotice: { requestId: adjustment.proposal.requestId, approvedBy: 'user' as const, rationale: 'private notice rationale', quote: 'private notice quote' },
  };
  const governingSpec = { path: 'intent.spec.md', hash: HASH };
  const context = { ...result.state.c, governingSpec, tasks: initialTasks(result.state.c.plan!), designBinding: binding, scopeAdjustments: [adjustment] };
  const briefState: ImplementState = { tag: 'task-prewrite-snapshot', c: context, effectId: 'brief-snapshot', task: 'T1' };
  const briefResult = stepImplement(briefState, { type: 'SNAPSHOT', effectId: 'brief-snapshot', fingerprint: FP, diff: { paths: [] } });
  const briefEffect = briefResult.effects.find((effect) => effect.kind === 'write-brief');
  assert.ok(briefEffect?.kind === 'write-brief');
  if (briefEffect?.kind !== 'write-brief') return;
  assert.deepEqual(briefEffect.input['governingSpec'], governingSpec);
  const renderedInput = JSON.stringify(briefEffect.input);
  for (const privateText of ['private assessment rationale', 'private level quote', 'private scope quote', 'private notice quote', 'private writer rationale', 'private orchestrator rationale']) assert.equal(renderedInput.includes(privateText), false, privateText);
  assert.match(renderedInput, /Preserve stored values/);
  assert.match(renderedInput, /"settledLevel":"low"/);
  assert.equal(renderedInput.includes('src/extra.ts'), false, 'Design history cannot grant implementation write scope.');
  assert.deepEqual(context.scopeAdjustments, [adjustment], 'Design approval history remains private and intact.');
  assert.deepEqual(briefEffect.input['settledScope'], { paths: context.plan!.tasks[0]!.paths, approvedPaths: context.plan!.tasks[0]!.paths, changes: context.plan!.changes.filter((change) => context.plan!.tasks[0]!.paths.includes(change.path)) });
  const reviewContext = JSON.parse(planReviewContext(context, 'the original invocation context') as string) as Record<string, unknown>;
  assert.deepEqual(reviewContext, { invocationContext: 'the original invocation context', invocationLevel: 'low', invocationLevelSource: 'explicit' });
});
