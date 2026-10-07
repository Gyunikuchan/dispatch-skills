import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stepDesign, selectReady, type DesignState } from '../../../skills/dispatch/scripts/machines/design.ts';
import { validateDesignTraceability } from '../../../skills/dispatch/scripts/domain/plan.ts';
import { approval, approveDesignScope, hash, design } from './fixtures/design.ts';
import { beginRevision } from '../../../skills/dispatch/scripts/machines/revision.ts';
import { beginDesignRevision, stepDesignRevision } from '../../../skills/dispatch/scripts/machines/design-revision.ts';
import { PLAN, FP } from './fixtures/implement-recovery.ts';
import type { ParsedPlan } from '../../../skills/dispatch/scripts/domain/types.ts';
import { started } from './fixtures/design-delivery.ts';

test('prewrite-level: gate sees all increments before checkout', () => {
  const state = started();
  assert.equal(state.tag, 'increment');
  if (state.tag !== 'increment' || !('c' in state.child) || !state.child.c) throw new Error('child');
  assert.deepEqual(state.child.c.designBinding?.governingDesign?.remainingIncrements.map((row) => row.id), ['I01', 'I02']);
  assert.notEqual(state.child.tag, 'task-checkout');
});

test('prewrite-level: approved later-increment expansion is adjudicated before delivery checkout', () => {
  const base = approval('implement').c;
  const c = {
    ...base, design, hash, levelGatePassed: true, completed: ['I01'], ownership: { I01: ['src/a.ts'] },
    approval: { by: 'user' as const, quote: 'Deliver', hash }, baseline: 'a'.repeat(40),
  };
  const working = beginDesignRevision(c, { type: 'REVISE', artifact: 'design', reason: 'Expand the later increment', evidence: 'Its acceptance contract requires the helper.' });
  const authored = stepDesignRevision(working.state, { type: 'AUTHORED', path: working.state.workingPath });
  if (authored.state.tag !== 'parse') throw new Error('parse');
  const revised = { ...design, increments: design.increments.map((row) => row.id === 'I02' ? { ...row, paths: [...row.paths, 'src/extra.ts'] } : row) };
  const proposal = stepDesignRevision({ ...authored.state, afterReview: true }, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: authored.state.effectId, hash: `sha256:${'b'.repeat(64)}`, parsed: revised, defects: [] });
  assert.equal(proposal.state.tag, 'scope-adjudication');
  if (proposal.state.tag !== 'scope-adjudication') return;
  assert.equal(proposal.state.request.source, 'design-revision');
  if (proposal.state.request.source !== 'design-revision') return;
  const requestId = proposal.state.request.requestId;
  assert.deepEqual(proposal.state.request.affectedIncrements, ['I02']);
  assert.ok(proposal.state.request.delta.paths.includes('src/extra.ts'));
  assert.deepEqual(proposal.effects, []);

  const pending = { state: { tag: 'revision' as const, c, child: proposal.state }, effects: [] };
  const resumed = approveDesignScope(pending);
  assert.ok(resumed.state.tag === 'approval' || resumed.state.tag === 'increment');
  assert.ok('c' in resumed.state && resumed.state.c?.scopeAdjustments.some((item) => item.proposal.requestId === requestId));
  assert.equal(resumed.effects.some((effect) => effect.kind === 'checkout' && effect.op === 'task'), false);
});

function approveRevisionScope(result: ReturnType<typeof stepDesign>): ReturnType<typeof stepDesign> {
  const state = result.state;
  if (state.tag !== 'plan-revision' || state.child.tag !== 'scope-adjudication') return result;
  let next = stepDesign(state, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request: state.child.request, ruling: 'approve', rationale: 'The added check is required by the accepted criterion.' } });
  if (next.state.tag === 'plan-revision' && next.state.child.tag === 'checking-host-event') next = stepDesign(next.state, { type: 'SNAPSHOT', effectId: next.state.child.effectId, fingerprint: FP, diff: { paths: [] } });
  return { ...next, effects: [...result.effects, ...next.effects] };
}

test('orchestrator-approved bound plan revision resumes without another user approval', () => {
  const state = started();
  if (state.tag !== 'increment' || !('c' in state.child) || !state.child.c) throw new Error('child');
  const binding = state.child.c.designBinding!;
  const original: ParsedPlan = { ...PLAN, changes: PLAN.changes.map((row) => ({ ...row, action: 'MODIFY' })), criteria: PLAN.criteria.map((row) => ({ ...row, evidence: 'verify' })), box: { 'TL;DR': 'First behavior' }, traceability: { Design: binding.path, Revision: hash, Increment: 'I01', ...binding.contract } };
  const c = { ...state.child.c, plan: original, planHash: hash, startFingerprint: FP, lastFingerprint: FP, levelGatePassed: true };
  const parent = { tag: 'evidence' as const, c, purpose: 'final' as const, ids: ['SC1'], verify: [] };
  const revision = beginRevision(parent, { type: 'REVISE', artifact: 'plan', reason: 'Add verification', evidence: 'Missing check' }).state;
  const event = { type: 'ARTIFACT_PARSED' as const, kind: 'plan' as const, effectId: 'reparse', hash: `sha256:${'b'.repeat(64)}`, defects: [], parsed: { ...original, criteria: original.criteria.map((row) => ({ ...row, verify: [...row.verify, { command: 'extra-check', final: false }] })) } };
  const parsed = stepDesign({ tag: 'plan-revision', c: state.c, increment: 'I01', child: { tag: 'parse', r: revision.r, effectId: 'reparse', afterReview: true } }, event);
  assert.equal(parsed.state.tag, 'plan-revision');
  if (parsed.state.tag !== 'plan-revision' || parsed.state.child.tag !== 'scope-adjudication') throw new Error('revision scope proposal');
  assert.equal(parsed.state.child.request.source, 'plan-revision');
  assert.equal(parsed.state.child.request.baseArtifactHash, hash);
  assert.equal(parsed.state.child.request.proposedArtifactHash, event.hash);
  const result = approveRevisionScope(parsed);
  assert.equal(result.state.tag, 'increment');
  if (result.state.tag !== 'increment' || !('c' in result.state.child)) throw new Error('child');
  assert.equal(result.state.child.tag, 'evidence');
  assert.equal(result.state.child.c?.designBinding?.revision, hash);
  assert.equal(result.state.child.c?.scopeNotice?.requestId, parsed.state.tag === 'plan-revision' && parsed.state.child.tag === 'scope-adjudication' ? parsed.state.child.request.requestId : null);
  assert.equal(result.state.child.c?.run.level, c.run.level);
  assert.equal(result.effects.some((effect) => effect.kind === 'checkout' && effect.op === 'init'), false);
  const denied = stepDesign({ tag: 'plan-revision', c: state.c, increment: 'I01', child: { tag: 'parse', r: revision.r, effectId: 'reparse', afterReview: true } }, { ...event, parsed: { ...event.parsed, changes: [{ ...original.changes[0]!, path: 'src/outside.ts' }] } });
  assert.equal(denied.state.tag, 'plan-revision');
  assert.deepEqual(denied.effects, []);
});
test('design-increment-selection: priority and prerequisite completion select ready children', () => {
  assert.equal(selectReady({ ...design, increments: [...design.increments].reverse() }, []), 'I01');
  assert.equal(selectReady(design, ['I01']), 'I02');
  assert.equal(selectReady(design, ['I01', 'I02']), null);
});
test('design-derived-approvals and design-traceability: inherited contract rejects stale revision and wrong increment', () => {
  const state = started();
  assert.equal(state.tag, 'increment');
  if (state.tag !== 'increment' || !('c' in state.child) || !state.child.c) throw new Error('child');
  const binding = state.child.c.designBinding!;
  const plan = { traceability: { Design: binding.path, Revision: hash, Increment: 'I01', Outcome: 'First behavior' } } as never;
  assert.deepEqual(validateDesignTraceability(plan, binding), []);
  assert.ok(validateDesignTraceability(plan, { ...binding, increment: 'I02' }).length);
  assert.ok(validateDesignTraceability(plan, { ...binding, revision: `sha256:${'b'.repeat(64)}` }).length);
});
test('design-implement-delivers-all: two child outcomes retain ownership and use distinct effect paths', () => {
  let state = started();
  const ids: string[] = [];
  for (const increment of ['I01', 'I02']) {
    assert.equal(state.tag, 'increment');
    if (state.tag !== 'increment' || !('c' in state.child) || !state.child.c) throw new Error('child');
    assert.equal(state.increment, increment);
    ids.push(...Object.keys(state.child.c.counters));
    const completed = { ...state, child: { tag: 'complete' as const, c: { ...state.child.c, changedPaths: [`src/${increment === 'I01' ? 'a' : 'b'}.ts`] }, summary: 'Done' } };
    state = stepDesign(completed, { type: 'LOCK_BROKEN', stalePid: 1 }).state;
  }
  assert.equal(state.tag, 'integration');
  assert.deepEqual(state.c.completed, ['I01', 'I02']);
  assert.deepEqual(state.c.ownership, { I01: ['src/a.ts'], I02: ['src/b.ts'] });
  assert.ok(ids.includes('design.i01.implement.snapshot'));
  assert.ok(ids.includes('design.i02.implement.snapshot'));
});
test('bound child baseline derives approval without an approval await', () => {
  let state = started();
  if (state.tag !== 'increment' || !('c' in state.child) || !state.child.c) throw new Error('child');
  const c = { ...state.child.c, levelGatePassed: true };
  const plan = { title: 'First', box: { 'TL;DR': 'First behavior' }, keyDecisions: [], criteria: [], changes: [], verification: { automated: [], none: null, manual: [] }, tasks: [], finalCommands: [], traceability: { Design: 'x.design.md', Revision: hash, Increment: 'I01', Outcome: 'First behavior' }, governedText: '# First' };
  state = { ...state, child: { tag: 'baseline-snapshot', c: { ...c, plan, planHash: hash, startFingerprint: { head: 'h', index: 'i', worktree: 'w' } }, effectId: 'baseline', results: [] } };
  const result = stepDesign(state, { type: 'SNAPSHOT', effectId: 'baseline', fingerprint: { head: 'h', index: 'i', worktree: 'w' }, diff: { paths: [] } });
  assert.equal(result.state.tag, 'increment');
  if (result.state.tag !== 'increment' || !('c' in result.state.child) || !result.state.child.c) throw new Error('child');
  assert.equal(result.state.child.tag, 'task-checkout');
  assert.equal(result.state.child.c.approval?.by, 'design');
  assert.ok(result.state.child.c.designBinding && result.effects.some((effect) => effect.kind === 'checkout' && effect.op === 'init'));
});

test('traceability scope admits directory and glob forms while rejecting escapes and sibling prefixes', () => {
  const state = started();
  if (state.tag !== 'increment' || !('c' in state.child) || !state.child.c?.designBinding) throw new Error('binding');
  const binding = state.child.c.designBinding;
  const plan = (file: string) => ({ traceability: { Design: binding.path, Revision: hash, Increment: 'I01', Outcome: 'First behavior' }, changes: [{ path: file }] }) as never;
  for (const [scope, allowed, denied] of [
    ['src/a.ts', 'src/a.ts', 'src/b.ts'],
    ['src/', 'src/deep/a.ts', 'src-other/a.ts'],
    ['src/**', 'src/deep/a.ts', 'src-other/a.ts'],
    ['src/*.ts', 'src/a.ts', 'src/deep/a.ts'],
    ['src/**/*.ts', 'src/a.ts', 'src/deep/a.js'],
    ['src/{a,b}.ts', 'src/b.ts', 'src/c.ts'],
  ]) {
    const scoped = { ...binding, paths: [scope!] };
    assert.deepEqual(validateDesignTraceability(plan(allowed!), scoped), []);
    assert.match(validateDesignTraceability(plan(denied!), scoped).join(';'), /outside increment/);
    assert.match(validateDesignTraceability(plan('src/../caller.ts'), scoped).join(';'), /outside increment/);
  }
});

test('template traceability binds Parent path, revision, increment, contract and owned changes', () => {
  const state = started();
  if (state.tag !== 'increment' || !('c' in state.child) || !state.child.c?.designBinding) throw new Error('binding');
  const binding = state.child.c.designBinding;
  const plan = { box: { Parent: `\`${binding.path}\` · I01` }, traceability: { 'Approved revision': hash, 'Increment ID and inherited contract': 'I01 — First behavior', 'Prerequisite evidence': 'None', 'Acceptance mapping': 'src/a.ts → SC1' }, changes: [{ path: 'src/a.ts' }] } as never;
  assert.deepEqual(validateDesignTraceability(plan, binding), []);
  for (const other of [{ ...binding, path: 'other.design.md' }, { ...binding, revision: `sha256:${'b'.repeat(64)}` }, { ...binding, increment: 'I02' }, { ...binding, contract: { Outcome: 'Other behavior' } }, { ...binding, paths: ['src/b.ts'] }]) assert.ok(validateDesignTraceability(plan, other).length);
});
