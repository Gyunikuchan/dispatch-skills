import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Event } from '../../../skills/dispatch/scripts/core/types.ts';
import { beginSpec, beginSpecApproval, specApprovalRequired, specMachine, type SpecState } from '../../../skills/dispatch/scripts/machines/spec.ts';

const HASH = `sha256:${'a'.repeat(64)}`;
const OTHER = `sha256:${'b'.repeat(64)}`;
const read = (candidate: string | null, level: 'low' | 'medium' = 'low') =>
  beginSpec({ candidate, defaultPath: '/session/x.spec.md', level, approvals: [] }, {});
const parsed = (effectId: string, over: Partial<Extract<Event, { type: 'ARTIFACT_PARSED' }>> = {}): Event =>
  ({ type: 'ARTIFACT_PARSED', effectId, kind: 'spec', hash: HASH, parsed: { reqIds: ['REQ-1'] }, defects: [], ...over });
const settledFrom = (state: SpecState): SpecState => {
  if (state.tag !== 'settled') throw new Error(`expected settled, got ${state.tag}`);
  return state;
};

// SECTION: Reading and authoring

test('spec stage: a candidate is read and settles its path and hash on a clean parse', () => {
  const start = read('/repo/a.spec.md');
  assert.deepEqual(start.effects, [{ kind: 'parse-artifact', id: 'spec.parse-artifact.1', path: '/repo/a.spec.md', artifact: 'spec', level: 'low' }]);
  assert.equal(specMachine.awaitOf(start.state), null);
  const settled = settledFrom(specMachine.step(start.state, parsed('spec.parse-artifact.1')).state);
  assert.deepEqual(settled.tag === 'settled' && settled.identity, { path: '/repo/a.spec.md', hash: HASH });
});

test('spec stage: lint defects return to author with the defects', () => {
  const start = read('/repo/a.spec.md');
  const next = specMachine.step(start.state, parsed('spec.parse-artifact.1', { parsed: {}, defects: [{ code: 'missing-section', message: 'm' }] })).state;
  assert.equal(specMachine.awaitOf(next), 'author');
  assert.deepEqual(specMachine.project(next).data, { artifact: 'spec', path: '/repo/a.spec.md', template: 'references/templates/spec.md', level: 'low', defects: [{ code: 'missing-section', message: 'm' }] });
});

test('spec stage: a missing candidate is authored at the same path', () => {
  const start = read('/repo/a.spec.md');
  const next = specMachine.step(start.state, { type: 'EFFECT_FAILED', effectId: 'spec.parse-artifact.1', cls: 'io', detail: 'spec not found: /repo/a.spec.md' }).state;
  assert.equal(next.tag, 'author');
  assert.equal(specMachine.project(next).data['path'], '/repo/a.spec.md');
  const failed = specMachine.step(start.state, { type: 'EFFECT_FAILED', effectId: 'spec.parse-artifact.1', cls: 'io', detail: 'EACCES' }).state;
  assert.equal(failed.tag, 'failed');
});

test('spec stage: no candidate authors at the default path and reads the authored file', () => {
  const start = read(null);
  assert.deepEqual(start.effects, []);
  assert.equal(specMachine.awaitOf(start.state), 'author');
  assert.equal(specMachine.project(start.state).data['path'], '/session/x.spec.md');
  assert.match(String(specMachine.validate!(start.state, { type: 'AUTHORED', path: '/elsewhere.spec.md' })), /author the spec at \/session\/x\.spec\.md/);
  const reading = specMachine.step(start.state, { type: 'AUTHORED', path: '/session/x.spec.md' });
  assert.equal(reading.state.tag, 'reading');
  assert.equal(reading.effects[0]?.kind === 'parse-artifact' && reading.effects[0].path, '/session/x.spec.md');
});

// SECTION: Approval and revision

test('spec stage: approval settles on the current hash, rejects another hash, and stops on stop', () => {
  const settled = settledFrom(specMachine.step(read('/repo/a.spec.md', 'medium').state, parsed('spec.parse-artifact.1')).state);
  if (settled.tag !== 'settled') return;
  const approval = beginSpecApproval(settled.c, settled.identity).state;
  assert.equal(specMachine.awaitOf(approval), 'decide');
  assert.deepEqual(specMachine.project(approval).data, { kind: 'spec-approval', path: '/repo/a.spec.md', hash: HASH, question: 'Approve this governing spec revision.', options: ['approve', 'stop'], required: { by: 'user', quote: 'non-empty', hash: HASH } });
  const wrong = { type: 'DECISION', kind: 'spec-approval', answer: { by: 'user', quote: 'yes', hash: OTHER } } as const;
  assert.match(String(specMachine.validate!(approval, wrong)), /expected sha256:a+/);
  const ok = { type: 'DECISION', kind: 'spec-approval', answer: { by: 'user', quote: 'yes', hash: HASH } } as const;
  assert.equal(specMachine.validate!(approval, ok), null);
  const approved = specMachine.step(approval, ok).state;
  assert.equal(approved.tag, 'settled');
  assert.deepEqual(approved.c.approvals, [{ by: 'user', quote: 'yes', hash: HASH }]);
  const stopped = specMachine.step(approval, { type: 'DECISION', kind: 'spec-approval', answer: 'stop' }).state;
  assert.deepEqual([stopped.tag, specMachine.project(stopped).data], ['stopped', { outcome: 'failed', summary: 'User declined spec approval.' }]);
});

test('spec stage: approval is required only above low for an unapproved hash', () => {
  const approvals = [{ by: 'user' as const, quote: 'yes', hash: HASH }];
  assert.equal(specApprovalRequired('low', HASH, []), false);
  assert.equal(specApprovalRequired('medium', HASH, approvals), false);
  assert.equal(specApprovalRequired('medium', OTHER, approvals), true);
  assert.equal(specApprovalRequired('high', HASH, []), true);
});

test('spec stage: a malformed parse hash returns to author with an invalid-hash defect', () => {
  const start = read('/repo/a.spec.md');
  const next = specMachine.step(start.state, parsed('spec.parse-artifact.1', { hash: 'md5:abc' })).state;
  assert.equal(next.tag, 'author');
  assert.equal(specMachine.awaitOf(next), 'author');
  const defects = specMachine.project(next).data['defects'] as readonly Record<string, unknown>[];
  assert.deepEqual(defects.map((defect) => defect['code']), ['invalid-hash']);
});

test('spec stage: a revision at approval rereads the spec with a parse-artifact effect', () => {
  const settled = settledFrom(specMachine.step(read('/repo/a.spec.md', 'medium').state, parsed('spec.parse-artifact.1')).state);
  if (settled.tag !== 'settled') return;
  const approval = beginSpecApproval(settled.c, settled.identity).state;
  const revised = specMachine.step(approval, { type: 'SPEC_REVISED', path: '/repo/a.spec.md' });
  assert.equal(revised.state.tag, 'reading');
  assert.deepEqual(revised.effects, [{ kind: 'parse-artifact', id: 'spec.parse-artifact.2', path: '/repo/a.spec.md', artifact: 'spec', level: 'medium' }]);
});

test('spec stage: a case-variant revision path at approval rereads the governing spec on Windows', { skip: process.platform !== 'win32' && 'case-insensitive paths are Windows-only' }, () => {
  const settled = settledFrom(specMachine.step(read('C:/Repo/a.spec.md', 'medium').state, parsed('spec.parse-artifact.1')).state);
  if (settled.tag !== 'settled') return;
  const approval = beginSpecApproval(settled.c, settled.identity).state;
  const revised = specMachine.step(approval, { type: 'SPEC_REVISED', path: 'c:\\repo\\A.spec.md' });
  assert.equal(revised.state.tag, 'reading');
  assert.equal(revised.effects[0]?.kind === 'parse-artifact' && revised.effects[0].path, 'C:/Repo/a.spec.md');
});
