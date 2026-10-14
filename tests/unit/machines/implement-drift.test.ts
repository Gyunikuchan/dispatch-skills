import assert from 'node:assert/strict';
import { test } from 'node:test';
import { implementData, stepImplement, validateImplement } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { approvalState, FP, assessed } from './fixtures/implement-recovery.ts';
function observed() {
 const r = stepImplement(approvalState(), { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } });
 return assessed(stepImplement(r.state, { type: 'SNAPSHOT', effectId: r.effects[0]!.id, fingerprint: { ...FP, worktree: 'changed' }, diff: { paths: ['external.ts'] } }), ['external.ts']);
}
test('change receipt: an ordinary change advances without a drift await and preserves write scope', () => {
 const r = observed(); assert.equal(r.state.tag, 'level-classification');
 assert.ok('c' in r.state && r.state.c); if (!('c' in r.state) || !r.state.c) return;
 assert.equal('adoptedPaths' in r.state.c, false); assert.deepEqual(r.state.c.lastFingerprint, { ...FP, worktree: 'changed' });
 const [row] = implementData(r.state)['observations'] as { paths: string[] }[];
 assert.deepEqual(row?.paths, ['external.ts']);
});
test('phase adapter: a stale disposition is rejected and leaves the state unchanged', () => {
 const r = observed(); if (!('c' in r.state) || !r.state.c) return assert.fail('expected context');
 const row = r.state.c.observations![0]!;
 const event = { type: 'DECISION' as const, kind: 'run-stop' as const, answer: { by: 'user', quote: 'stop' }, changeDispositions: [{ observationId: row.id, afterHash: 'old', rationale: 'accept' }] };
 assert.ok(validateImplement(r.state, event)); assert.deepEqual(stepImplement(r.state, event).state, r.state);
});
