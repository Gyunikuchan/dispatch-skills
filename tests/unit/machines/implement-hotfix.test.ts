import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stepImplement } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { HASH, failure, host } from './fixtures/implement-recovery.ts';

test('writer hotfix envelope with paths outside the approved scope returns to its origin', () => {
  let r = host(failure(), { type: 'DECISION', kind: 'failure', answer: { by: 'orchestrator', action: 'hotfix', mode: 'writer', rationale: 'bad branch' } });
  r = stepImplement(r.state, { type: 'BRIEF_READY', effectId: r.effects[0]!.id, stage: 'hotfix', path: 'hotfix.brief', sha256: HASH, envelopePath: 'hotfix.outcome' });
  r = host(r.state, { type: 'WRITE_RECEIPT', status: 'submitted', model: 'writer-a', briefHash: HASH, envelopePath: 'hotfix.outcome' });
  assert.equal(r.state.tag, 'hotfix-envelope');
  const check = r.effects.find((effect) => effect.kind === 'check-envelope')!;
  const envelope = { schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: 'fixed', evidence: [] };
  r = stepImplement(r.state, { type: 'ENVELOPE_CHECKED', effectId: check.id, envelope, defects: [], diff: { paths: ['README.md', 'src/a.ts'], outside: ['README.md'] } } as never);
  assert.equal(r.state.tag, 'failure');
});
