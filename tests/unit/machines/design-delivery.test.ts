import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Event } from '../../../skills/dispatch/scripts/core/types.ts';
import { stepDesign, selectReady, type DesignState } from '../../../skills/dispatch/scripts/machines/design.ts';
import { validateDesignTraceability } from '../../../skills/dispatch/scripts/domain/plan.ts';
import { approval, hash, design } from './design.test.ts';
import { beginRevision } from '../../../skills/dispatch/scripts/machines/revision.ts';
import { PLAN, FP } from './implement-recovery.test.ts';
import type { ParsedPlan } from '../../../skills/dispatch/scripts/domain/types.ts';

export function started(): DesignState {
  const approved = stepDesign(approval('implement'), { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Deliver', hash } });
  return stepDesign(approved.state, { type: 'SNAPSHOT', effectId: approved.effects[0]!.id, fingerprint: { head: 'a'.repeat(40), index: 'i', worktree: 'w' }, diff: { paths: [] } }).state;
}

test('expanded bound plan revision derives approval and retains write effects within design scope', () => {
  const state = started();
  if (state.tag !== 'increment' || !('c' in state.child) || !state.child.c) throw new Error('child');
  const binding = state.child.c.designBinding!;
  const original: ParsedPlan = { ...PLAN, changes: PLAN.changes.map((row) => ({ ...row, action: 'MODIFY' })), criteria: PLAN.criteria.map((row) => ({ ...row, evidence: 'verify' })), box: { 'TL;DR': 'First behavior' }, traceability: { Design: binding.path, Revision: hash, Increment: 'I01', ...binding.contract } };
  const c = { ...state.child.c, plan: original, planHash: hash, startFingerprint: FP, lastFingerprint: FP };
  const parent = { tag: 'evidence' as const, c, purpose: 'final' as const, ids: ['SC1'], verify: [] };
  const revision = beginRevision(parent, { type: 'REVISE', artifact: 'plan', reason: 'Add verification', evidence: 'Missing check' }).state;
  const event = { type: 'ARTIFACT_PARSED' as const, kind: 'plan' as const, effectId: 'reparse', hash: `sha256:${'b'.repeat(64)}`, defects: [], parsed: { ...original, criteria: original.criteria.map((row) => ({ ...row, verify: [...row.verify, { command: 'extra-check', final: false }] })) } };
  const result = stepDesign({ tag: 'plan-revision', c: state.c, increment: 'I01', child: { tag: 'parse', r: revision.r, effectId: 'reparse', afterReview: true } }, event);
  assert.equal(result.state.tag, 'increment');
  if (result.state.tag !== 'increment' || !('c' in result.state.child)) throw new Error('child');
  assert.equal(result.state.child.tag, 'task-checkout');
  assert.equal(result.state.child.c?.approval?.by, 'design');
  assert.ok(result.effects.some((effect) => effect.kind === 'checkout' && effect.op === 'init'));
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
  const c = state.child.c;
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
