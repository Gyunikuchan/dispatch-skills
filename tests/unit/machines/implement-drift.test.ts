import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stepImplement, validateImplement, type ImplementState } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { classifyDrift, permittedPaths } from '../../../skills/dispatch/scripts/policy/drift.ts';
import { validateHostEvent } from '../../../skills/dispatch/scripts/core/validate.ts';
import { approvalState, FP, metadata, host } from './implement-recovery.test.ts';

test('implement-out-of-scope: park snapshot settle apply exactly once', () => {
  const initial = approvalState();
  const parked = stepImplement(initial, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } });
  assert.equal(parked.state.tag, 'checking-host-event');
  assert.equal('c' in parked.state && parked.state.c?.attempts.production, 0);
  const event = { type: 'SNAPSHOT' as const, effectId: parked.effects[0]!.id, fingerprint: FP, diff: { paths: ['external.ts'] } };
  const drift = stepImplement(parked.state, event); assert.equal(drift.state.tag, 'drift');
  assert.equal('c' in drift.state && drift.state.c?.attempts.production, 0);
  const adopted = stepImplement(drift.state, { type: 'DECISION', kind: 'drift', answer: { 'external.ts': 'adopt' } });
  assert.equal(adopted.state.tag, 'writing-brief');
  assert.ok('c' in adopted.state && adopted.state.c?.finalFocus.includes('external.ts'));
  assert.equal('c' in adopted.state && adopted.state.c?.attempts.production, 1);
  assert.deepEqual(stepImplement(adopted.state, event).state, adopted.state);
  if (adopted.effects[0]?.kind === 'write-brief') assert.ok(JSON.stringify(adopted.effects[0].input['settledScope']).includes('external.ts'));
});
test('permitted author/write/fix paths and caller-dirty exemption', () => {
  const ctx = { stagePaths: ['src/a.ts'], testPaths: ['tests/a.test.ts'], testsOnly: false, artifactPath: 'x.plan.md' };
  assert.deepEqual(permittedPaths('author', ctx), ['x.plan.md']);
  assert.deepEqual(permittedPaths('write', ctx), ['src/a.ts']);
  assert.deepEqual(permittedPaths('fix', ctx), ['src/a.ts']);
  const initial = approvalState();
  const c = { ...initial.c, startFingerprint: { ...FP, recovery: { ...metadata, callerDirty: ['caller.txt'] } } };
  const result = host({ ...initial, c }, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } }, FP, ['caller.txt']);
  assert.equal(result.state.tag, 'writing-brief');
});
test('per-path adopt and stop require exhaustive ruling and stop preserves context', () => {
  const parked = stepImplement(approvalState(), { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } });
  const drift = stepImplement(parked.state, { type: 'SNAPSHOT', effectId: parked.effects[0]!.id, fingerprint: FP, diff: { paths: ['a', 'b'] } });
  assert.ok(validateImplement(drift.state, { type: 'DECISION', kind: 'drift', answer: { a: 'adopt' } }));
  assert.equal(stepImplement(drift.state, { type: 'DECISION', kind: 'drift', answer: { a: 'adopt', b: 'stop' } }).state.tag, 'stopped');
});
test('nearest verified hashes auto-adopt; unverified and mismatched hashes require drift ruling', () => {
  const input = { awaiting: 'write' as const, ctx: { stagePaths: ['skill/nested/src/a.ts'], testPaths: [], testsOnly: false, artifactPath: null }, changed: ['skill/skill-hashes.json', 'skill/nested/skill-hashes.json'], callerDirty: [] };
  const verified = classifyDrift({ ...input, hashManifestDirs: ['skill', 'skill/nested'] });
  assert.deepEqual(verified.autoAdopt, ['skill/nested/skill-hashes.json']); assert.deepEqual(verified.drift, ['skill/skill-hashes.json']);
  assert.deepEqual(classifyDrift({ ...input, hashManifestDirs: [] }).drift, input.changed);
});
test('malformed parked-event payload refused before snapshot admission', () => {
  const state: ImplementState = approvalState();
  const result = validateHostEvent('decide', { type: 'DECISION', kind: 'approval', answer: { by: 'user' } }, (event) => validateImplement(state, event));
  assert.equal(result.ok, false);
  assert.equal(validateHostEvent('evidence', { type: 'EVIDENCE', criteria: null }).ok, false);
});
