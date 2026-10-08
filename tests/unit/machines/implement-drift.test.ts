import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stepImplement, validateImplement } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { approvalState, FP, assessed } from './fixtures/implement-recovery.ts';
function drift() {
 const r = stepImplement(approvalState(), { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } });
 return assessed(stepImplement(r.state, { type: 'SNAPSHOT', effectId: r.effects[0]!.id, fingerprint: { ...FP, worktree: 'changed' }, diff: { paths: ['external.ts'] } }), ['external.ts']);
}
test('change receipt: structured resolution rechecks live state and preserves write scope', () => {
 const r = drift(); assert.equal(r.state.tag, 'drift'); if (r.state.tag !== 'drift') return;
 const answer = { by: 'orchestrator', noticeId: r.state.notice.id, afterHash: r.state.notice.afterHash, action: 'refresh', rationale: 'Accept the in-intent input and invalidate affected evidence.', evidenceIds: [] };
 const check = stepImplement(r.state, { type: 'DECISION', kind: 'drift', answer }); assert.equal(check.effects[0]?.kind, 'snapshot');
 const next = assessed(stepImplement(check.state, { type: 'SNAPSHOT', effectId: check.effects[0]!.id, fingerprint: r.state.fingerprint, diff: { paths: ['external.ts'] } }), ['external.ts']);
 assert.ok('c' in next.state && next.state.c); if ('c' in next.state && next.state.c) { assert.equal('adoptedPaths' in next.state.c, false); assert.equal(next.state.c.evidence['SC1'], undefined); }
});
test('phase adapter: stale and incomplete resolutions cannot resume a parked receipt', () => {
 const r = drift(); assert.equal(r.state.tag, 'drift'); if (r.state.tag !== 'drift') return;
 const answer = { by: 'orchestrator', noticeId: r.state.notice.id, afterHash: 'old', action: 'refresh', rationale: 'accept', evidenceIds: [] };
 assert.ok(validateImplement(r.state, { type: 'DECISION', kind: 'drift', answer })); assert.deepEqual(stepImplement(r.state, { type: 'DECISION', kind: 'drift', answer }).state, r.state);
});
