import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stepImplement } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { HASH, FP, assessed, classificationState, classify, failedRow, failure, host } from './fixtures/implement-recovery.ts';

test('governing spec reaches hotfix writer before out-of-scope envelope returns to origin', () => {
  const state = failure(), governingSpec = { path: 'intent.spec.md', hash: HASH };
  let r = host({ ...state, c: { ...state.c, governingSpec } }, { type: 'DECISION', kind: 'failure', answer: { by: 'orchestrator', action: 'hotfix', mode: 'writer', rationale: 'bad branch' } });
  const brief = r.effects.find((effect) => effect.kind === 'write-brief');
  assert.ok(brief?.kind === 'write-brief');
  assert.deepEqual(brief.input['governingSpec'], governingSpec);
  r = stepImplement(r.state, { type: 'BRIEF_READY', effectId: r.effects[0]!.id, stage: 'hotfix', path: 'hotfix.brief', sha256: HASH, envelopePath: 'hotfix.outcome' });
  r = host(r.state, { type: 'WRITE_RECEIPT', status: 'submitted', model: 'writer-a', briefHash: HASH, envelopePath: 'hotfix.outcome' });
  assert.equal(r.state.tag, 'hotfix-envelope');
  const check = r.effects.find((effect) => effect.kind === 'check-envelope')!;
  const envelope = { schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: 'fixed', evidence: [] };
  r = stepImplement(r.state, { type: 'ENVELOPE_CHECKED', effectId: check.id, envelope, defects: [], diff: { paths: ['README.md', 'src/a.ts'], outside: ['README.md'] } } as never);
  assert.equal(r.state.tag, 'failure');
});

test('hotfix verification reuses only matching final inputs across the final gate', () => {
  const failed = failure();
  const stale = {
    ...failedRow, command: 'baseline-only', exit: 0, logPath: 'baseline-only.log', failureId: null,
    failedTests: [], diagnostic: '', baselineHits: [], scanUnreadable: [], inputFingerprint: 'old-input',
    mutationEpoch: failed.c.mutationEpoch, status: 'pass' as const,
  };
  const state = {
    ...failed,
    c: {
      ...failed.c,
      plan: { ...failed.c.plan!, finalCommands: ['check', 'baseline-only'] },
      records: { ...failed.c.records, 'baseline-only': stale },
    },
  };
  let r = classify(host(state, { type: 'DECISION', kind: 'failure', answer: { by: 'orchestrator', action: 'hotfix', mode: 'writer', rationale: 'repair check' } }));
  const brief = r.effects.find((effect) => effect.kind === 'write-brief');
  assert.ok(brief?.kind === 'write-brief');
  r = stepImplement(r.state, { type: 'BRIEF_READY', effectId: brief.id, stage: 'hotfix', path: 'hotfix.brief', sha256: HASH, envelopePath: 'hotfix.outcome' });
  r = host(r.state, { type: 'WRITE_RECEIPT', status: 'submitted', model: 'writer-a', briefHash: HASH, envelopePath: 'hotfix.outcome' });
  const envelopeCheck = r.effects.find((effect) => effect.kind === 'check-envelope');
  assert.ok(envelopeCheck?.kind === 'check-envelope');
  r = stepImplement(r.state, { type: 'ENVELOPE_CHECKED', effectId: envelopeCheck.id, envelope: { schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: 'fixed', evidence: [] }, defects: [], diff: { paths: ['src/a.ts'], outside: [] } } as never);
  const snapshot = r.effects.find((effect) => effect.kind === 'snapshot');
  assert.ok(snapshot?.kind === 'snapshot');
  const hotfixed = { ...FP, worktree: 'hotfixed' };
  r = stepImplement(r.state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: hotfixed, diff: { paths: ['src/a.ts'] } });
  r = assessed(r, ['src/a.ts']);
  const hotfixVerify = r.effects.find((effect) => effect.kind === 'verify' && effect.purpose === 'hotfix');
  assert.ok(hotfixVerify?.kind === 'verify');
  assert.equal(r.state.tag, 'hotfix-verify');
  if (r.state.tag !== 'hotfix-verify') throw new Error('expected hotfix verification state');
  const verification = r.state;
  const hotfixCommand = hotfixVerify.commands.find((command) => command['command'] === 'check');
  assert.ok(hotfixCommand);
  assert.equal(hotfixCommand['planHash'], state.c.planHash);

  r = stepImplement(verification, { type: 'VERIFY_DONE', effectId: verification.effectId, purpose: 'hotfix', results: [{ command: 'check', exit: 0, logPath: 'hotfix.log', inputFingerprint: 'same-input' }], fingerprint: hotfixed });
  assert.equal(r.state.tag, 'final-verify');
  const finalVerify = r.effects.find((effect) => effect.kind === 'verify' && effect.purpose === 'final');
  assert.ok(finalVerify?.kind === 'verify');
  const finalCheck = finalVerify.commands.find((command) => command['command'] === 'check');
  assert.ok(finalCheck);
  assert.deepEqual(
    [finalCheck['command'], finalCheck['planHash'], finalCheck['environment'], finalCheck['inputPaths']],
    [hotfixCommand['command'], hotfixCommand['planHash'], hotfixCommand['environment'], hotfixCommand['inputPaths']],
  );
  assert.deepEqual(finalCheck['reuse'], { inputFingerprint: 'same-input', exit: 0, logPath: 'hotfix.log' });
  assert.equal(finalVerify.commands.find((command) => command['command'] === 'baseline-only')?.['reuse'], undefined);
});

test('hotfix verification reuses only matching final inputs during baseline recovery', () => {
  const c = { ...classificationState().c, approval: null, baseline: [failedRow], records: {} };
  const origin = { tag: 'baseline-decision' as const, c, items: [failedRow] };
  let r = classify(host(origin, { type: 'DECISION', kind: 'baseline', answer: { by: 'orchestrator', action: 'hotfix', mode: 'inline', rationale: 'repair baseline' } }));
  assert.equal(r.state.tag, 'hotfix-snapshot');
  const snapshot = r.effects.find((effect) => effect.kind === 'snapshot');
  assert.ok(snapshot?.kind === 'snapshot');
  const hotfixed = { ...FP, worktree: 'hotfixed' };
  r = stepImplement(r.state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: hotfixed, diff: { paths: ['src/a.ts'] } });
  r = assessed(r, ['src/a.ts']);
  const hotfixVerify = r.effects.find((effect) => effect.kind === 'verify' && effect.purpose === 'hotfix');
  assert.ok(hotfixVerify?.kind === 'verify');
  assert.equal(hotfixVerify.commands[0]?.['planHash'], c.planHash);
  assert.equal(r.state.tag, 'hotfix-verify');
  if (r.state.tag !== 'hotfix-verify') throw new Error('expected hotfix verification state');
  const verification = r.state;
  r = stepImplement(verification, { type: 'VERIFY_DONE', effectId: verification.effectId, purpose: 'hotfix', results: [{ command: 'check', exit: 0, logPath: 'baseline-hotfix.log', inputFingerprint: 'same-input' }], fingerprint: hotfixed });
  assert.equal(r.state.tag, 'task-checkout');
  assert.equal(r.state.tag === 'task-checkout' && r.state.c.baseline.find((row) => row.command === 'check')?.exit, 0);
});
