import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateApproachRequirements } from '../../../skills/dispatch/scripts/domain/design.ts';
import { validateSpecTraceability, validateDesignTraceability } from '../../../skills/dispatch/scripts/domain/plan.ts';
import { hash } from '../machines/fixtures/design.ts';
import { started } from '../machines/fixtures/design-delivery.ts';


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

// SECTION: Spec and approach requirement validation

const requirements = ['REQ-1', 'REQ-2', 'REQ-3'];
const tracedPlan = (ids: string[]) => ({ criteria: [{ id: 'SC1', line: 12, satisfies: ids }] }) as never;

test('spec traceability: validates requirement coverage against spec requirements', () => {
  assert.deepEqual(validateSpecTraceability(tracedPlan(requirements), requirements), []);
  const unknown = validateSpecTraceability(tracedPlan(['REQ-9']), requirements);
  assert.deepEqual(unknown.filter(item => item.code === 'unknown-requirement').map(item => item.severity), ['warning']);
  assert.match(unknown[0]!.message, /REQ-9/);
  const uncited = validateSpecTraceability(tracedPlan(['REQ-1']), requirements);
  assert.deepEqual(uncited.map(item => [item.code, item.severity]), [['unsatisfied-requirement', 'warning'], ['unsatisfied-requirement', 'warning']]);
  assert.match(uncited[0]!.message, /REQ-2/); assert.match(uncited[1]!.message, /REQ-3/);
});

test('approach requirements reject unknown requirement', () => {
  const defects = validateApproachRequirements({ approachRequirements: ['REQ-1', 'REQ-9'] } as never, requirements);
  assert.deepEqual(defects.map(item => [item.code, item.severity]), [['unknown-requirement', 'warning']]);
  assert.match(defects[0]!.message, /REQ-9/);
});
