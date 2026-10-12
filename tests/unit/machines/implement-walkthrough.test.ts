import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stepImplement } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { approvalState, FP, HASH } from './fixtures/implement-recovery.ts';


test('review fix design walkthrough uses the originating slug once for each increment', () => {
  const state = approvalState();
  const run = { ...state.c.run, argument: 'chat/renamed-i01.plan.md', overrides: { ...state.c.run.overrides, sessionDir: 'chat', artifactSlug: 'original-objective' }, config: { ...state.c.run.config, phases: { 'code-review': { rounds: { low: 1 }, targets: { low: 1 } } } } };
  const c = { ...state.c, run, designBinding: { path: 'renamed.design.md', revision: HASH, increment: 'I01', contract: {}, paths: ['src/a.ts'], approval: { by: 'user' as const, quote: 'Approved', hash: HASH }, repair: [] } };
  let result = stepImplement({ tag: 'delivered-snapshot', c: { ...c, phase: 'delivered' }, effectId: 'delivered' }, { type: 'SNAPSHOT', effectId: 'delivered', fingerprint: FP, diff: { paths: [] } });
  if (result.state.tag === 'checking-host-event') result = stepImplement(result.state, { type: 'SNAPSHOT', effectId: result.state.effectId, fingerprint: FP, diff: { paths: [] } });
  const effect = result.effects.find((row) => row.kind === 'prepare-review'); assert.equal(effect?.kind, 'prepare-review');
  if (effect?.kind === 'prepare-review') assert.equal((effect.review['governing'] as Record<string,unknown>)['walkthroughPath'], 'chat/original-objective-i01.walkthrough.md');
});
