import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Event, RecoverySnapshot, RunStartedEvent, TreeFingerprint } from '../../../skills/dispatch/scripts/core/types.ts';
import { initialImplement, stepImplement, validateImplement, type ImplementState } from '../../../skills/dispatch/scripts/machines/implement.ts';
import type { VerifyRecord } from '../../../skills/dispatch/scripts/machines/implement-types.ts';

export const HASH = `sha256:${'a'.repeat(64)}`;
export const metadata: RecoverySnapshot = { repoRoot: '', contents: { 'src/a.ts': Buffer.from('before').toString('base64') }, entries: { 'src/a.ts': { kind: 'file', mode: 0o644, linkTarget: null } }, taskStartFiles: ['src/a.ts'], callerDirty: [], ignored: [], git: { head: 'h', index: 'i', stash: '', gitDir: 'g' }, changed: [], verifiedManifestDirs: [], hashManifestDirs: [] };
export const FP: TreeFingerprint = { head: 'h', index: 'i', worktree: 'w', recovery: metadata };
export const PLAN = { title: 'Feature', box: { 'TL;DR': 'Deliver feature' }, keyDecisions: [], criteria: [{ id: 'SC1', title: 'works', line: 1, changes: ['src/a.ts'], verify: [{ command: 'check', final: false }], evidence: 'verify', preExisting: false, redException: null, testRationale: null, review: null, enforcementInfeasibility: null }], changes: [{ action: 'MODIFY', path: 'src/a.ts', note: 'feature', command: null, line: 1 }], verification: { automated: ['check'], none: null, manual: [] }, finalCommands: [], traceability: null, governedText: 'original governed text' };
export const RUN: RunStartedEvent = { type: 'RUN_STARTED', protocolRevision: 2, verb: 'implement', argument: 'x.plan.md', level: 'low', levelSource: 'explicit', pins: null, fix: false, orchestrator: 'claude', orchestratorModel: null, repo: {}, overrides: { sessionDir: 'session', settledPlan: { path: 'x.plan.md', hash: HASH, outcome: 'settled' } }, config: { 'write-subagents': { claude: { low: { model: ['writer-a', 'writer-b'] } } }, 'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } }, phases: { 'plan-review': { rounds: { low: 1 }, targets: { low: 1 } }, 'code-review': { rounds: { low: 0 }, targets: { low: 1 } } } } };
export const failedRow: VerifyRecord = { command: 'check', exit: 1, logPath: 'failure.log', failureId: 'same-failure', failedTests: ['test:behavior'], diagnostic: 'failed', loadError: false, inputFingerprint: 'input', mutationEpoch: 0, status: 'regression' };
export function approvalState(): Extract<ImplementState, { tag: 'approval' }> {
  let r = stepImplement(initialImplement(), RUN);
  r = stepImplement(r.state, { type: 'SNAPSHOT', effectId: r.effects[0]!.id, fingerprint: FP, diff: { paths: [] } });
  r = stepImplement(r.state, { type: 'ARTIFACT_PARSED', effectId: r.effects[0]!.id, kind: 'plan', hash: HASH, parsed: PLAN, defects: [] });
  r = stepImplement(r.state, { type: 'SNAPSHOT', effectId: r.effects[0]!.id, fingerprint: FP, diff: { paths: [] } });
  r = stepImplement(r.state, { type: 'VERIFY_DONE', effectId: r.effects[0]!.id, purpose: 'baseline', results: [{ command: 'check', exit: 0, logPath: 'baseline.log' }], fingerprint: FP });
  r = stepImplement(r.state, { type: 'SNAPSHOT', effectId: r.effects[0]!.id, fingerprint: FP, diff: { paths: [] } });
  assert.equal(r.state.tag, 'approval'); return r.state as Extract<ImplementState, { tag: 'approval' }>;
}
export function host(state: ImplementState, event: Event, fingerprint = FP, paths: string[] = []) {
  const r = stepImplement(state, event);
  if (r.state.tag !== 'checking-host-event') return r;
  assert.equal(r.effects[0]?.kind, 'snapshot');
  return stepImplement(r.state, { type: 'SNAPSHOT', effectId: r.state.effectId, fingerprint, diff: { paths } });
}
function failure(): Extract<ImplementState, { tag: 'failure' }> { const c = approvalState().c; return { tag: 'failure', c: { ...c, approval: { by: 'user', quote: 'Proceed' }, stalled: { purpose: 'scoped', rows: [failedRow] } }, reason: 'blocked-by-plan: check failed', changedPaths: [] }; }
function writer(): Extract<ImplementState, { tag: 'write' }> {
  let r = host(approvalState(), { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } });
  r = stepImplement(r.state, { type: 'BRIEF_READY', effectId: r.effects[0]!.id, stage: 'production', path: 'brief', sha256: HASH, envelopePath: 'outcome' });
  r = stepImplement(r.state, { type: 'SNAPSHOT', effectId: r.effects[0]!.id, fingerprint: FP, diff: { paths: [] } });
  assert.equal(r.state.tag, 'write'); return r.state as Extract<ImplementState, { tag: 'write' }>;
}
test('implement-failure-disposition: failure retry bound and root-cause brief', () => {
  const f = failure();
  const retry = host(f, { type: 'DECISION', kind: 'failure', answer: { action: 'retry', rootCause: 'wrong mapping' } });
  assert.equal(retry.state.tag, 'writing-brief');
  assert.equal(retry.effects[0]?.kind === 'write-brief' && retry.effects[0].input['retryContext'] !== null, true);
  assert.equal('c' in retry.state && retry.state.c?.attempts.production, 1);
  const cap = host({ ...f, c: { ...f.c, attempts: { ...f.c.attempts, production: 3 } } }, { type: 'DECISION', kind: 'failure', answer: { action: 'retry', rootCause: 'same' } });
  assert.equal(cap.state.tag, 'failure-snapshot');
});
test('user-only manual completion requires explicit quote and per-criterion evidence', () => {
  const f = failure(), criteria = { SC1: { outcome: 'pass', evidence: 'user observed behavior' } };
  assert.ok(validateImplement(f, { type: 'DECISION', kind: 'failure', answer: { action: 'manual-completion', by: 'agent', quote: 'done', criteria } }));
  assert.ok(validateImplement(f, { type: 'DECISION', kind: 'failure', answer: { action: 'manual-completion', by: 'user', quote: 'done', criteria: {} } }));
  const r = host(f, { type: 'DECISION', kind: 'failure', answer: { action: 'manual-completion', by: 'user', quote: 'I verified completion', criteria } });
  assert.equal(r.state.tag, 'complete');
});

test('rewrite SC1 manual waiver retains user attribution and RED provenance', () => {
  const base = failure(); const f = { ...base, c: { ...base.c, plan: { ...base.c.plan!, criteria: base.c.plan!.criteria.map((criterion) => ({ ...criterion, evidence: 'red' as const })) } } };
  const r = host(f, { type: 'DECISION', kind: 'failure', answer: { action: 'manual-complete', by: 'user', quote: 'Waive SC1 and its RED requirement', criteria: { SC1: { outcome: 'waived', evidence: 'Accepted limitation' } } } });
  assert.equal(r.state.tag, 'complete');
  if (r.state.tag !== 'complete') return;
  assert.deepEqual(r.state.c.evidence['SC1']?.['waiver'], { by: 'user', quote: 'Waive SC1 and its RED requirement' });
  assert.equal(r.state.c.evidence['SC1']?.['redProvenance'], 'waived');
  assert.match(r.state.summary, /0 passed; 1 waived/);
});
test('implement-hotfix: inline baseline hotfix immediately reruns stalled check and expands finalFocus', () => {
  const c = approvalState().c;
  const baseline: ImplementState = { tag: 'baseline-decision', c, items: [failedRow] };
  let r = host(baseline, { type: 'DECISION', kind: 'baseline', answer: { action: 'hotfix', rootCause: 'environment' } });
  assert.equal(r.state.tag, 'hotfix-snapshot');
  const changed = { ...FP, worktree: 'fixed', recovery: { ...metadata, changed: [{ path: 'env.txt', added: 1, removed: 0, deleted: false, outsideRepo: false }] } };
  r = stepImplement(r.state, { type: 'SNAPSHOT', effectId: r.effects[0]!.id, fingerprint: changed, diff: { paths: ['env.txt'] } });
  assert.equal(r.state.tag, 'hotfix-verify');
  assert.deepEqual(r.effects[0]?.kind === 'verify' && r.effects[0].commands.map((row) => row['command']), ['check']);
  if ('c' in r.state && r.state.c) assert.ok(r.state.c.finalFocus.includes('env.txt'));
  r = stepImplement(r.state, { type: 'VERIFY_DONE', effectId: r.effects[0]!.id, purpose: 'hotfix', results: [{ command: 'check', exit: 0, logPath: 'pass.log' }], fingerprint: changed });
  assert.equal(r.state.tag, 'approval');
});
test('writer hotfix single-shot uses configured first writer and never cascades', () => {
  let r = host(failure(), { type: 'DECISION', kind: 'failure', answer: { action: 'hotfix', rootCause: 'bad branch' } });
  assert.equal(r.effects[0]?.kind === 'write-brief' && r.effects[0].stage, 'hotfix');
  r = stepImplement(r.state, { type: 'BRIEF_READY', effectId: r.effects[0]!.id, stage: 'hotfix', path: 'hotfix.brief', sha256: HASH, envelopePath: 'hotfix.outcome' });
  assert.equal(r.state.tag, 'hotfix-write');
  r = host(r.state, { type: 'WRITE_FAILED', model: 'writer-a', kind: 'quota', reason: 'failed' });
  assert.equal(r.state.tag, 'failure'); assert.deepEqual(r.effects, []);
});
test('failure inline hotfix nested spec answer preserves pre-await delta and checks its full budget', () => {
  const f = failure();
  const after = { ...FP, worktree: 'edited', recovery: { ...metadata, changed: [{ path: 'src/a.ts', added: 151, removed: 0, deleted: false, outsideRepo: false }] } };
  let r = host(f, { type: 'DECISION', kind: 'failure', answer: { action: 'hotfix', rootCause: 'bad branch', hotfix: { mode: 'inline', external: [] } } }, after, ['src/a.ts']);
  assert.equal(r.state.tag, 'hotfix-snapshot'); if (r.state.tag === 'hotfix-snapshot') assert.deepEqual(r.state.before, FP);
  r = stepImplement(r.state, { type: 'SNAPSHOT', effectId: r.effects[0]!.id, fingerprint: after, diff: { paths: ['src/a.ts'] } });
  assert.equal(r.state.tag, 'failure'); assert.deepEqual(r.effects, []);
  assert.equal(host(f, { type: 'DECISION', kind: 'failure', answer: { action: 'manual-complete', by: 'user', quote: 'I verified', criteria: { SC1: { outcome: 'pass', evidence: 'checked' } } } }).state.tag, 'complete');
});
for (const violation of ['budget', 'hard-limit', 'pre-RED'] as const) test(`hotfix ${violation} violation re-asks without stalled check`, () => {
  const c0 = approvalState().c, c = violation === 'pre-RED' ? { ...c0, currentStage: 'tests-only' as const } : c0;
  let r = host({ tag: 'baseline-decision', c, items: [failedRow] }, { type: 'DECISION', kind: 'baseline', answer: { action: 'hotfix', rootCause: 'fix' } });
  const changed = { ...FP, recovery: { ...metadata, changed: [{ path: 'src/a.ts', added: violation === 'budget' ? 151 : 1, removed: 0, deleted: violation === 'hard-limit', outsideRepo: false }] } };
  r = stepImplement(r.state, { type: 'SNAPSHOT', effectId: r.effects[0]!.id, fingerprint: changed, diff: { paths: ['src/a.ts'] } });
  assert.equal(r.state.tag, 'baseline-decision'); assert.deepEqual(r.effects, []);
});
test('unchanged failure withdraws hotfix for stage', () => {
  let r = host({ tag: 'baseline-decision', c: approvalState().c, items: [failedRow] }, { type: 'DECISION', kind: 'baseline', answer: { action: 'hotfix', rootCause: 'fix' } });
  r = stepImplement(r.state, { type: 'SNAPSHOT', effectId: r.effects[0]!.id, fingerprint: FP, diff: { paths: [] } });
  r = stepImplement(r.state, { type: 'VERIFY_DONE', effectId: r.effects[0]!.id, purpose: 'hotfix', results: [failedRow], fingerprint: FP });
  assert.equal(r.state.tag, 'baseline-decision');
  assert.ok('c' in r.state && r.state.c?.withdrawnHotfix.includes('baseline'));
  assert.equal(host(r.state, { type: 'DECISION', kind: 'baseline', answer: { action: 'hotfix', rootCause: 'again' } }).state.tag, 'baseline-decision');
});
test('failed cascade emits restore and RESTORED launches next model', () => {
  let r = host(writer(), { type: 'WRITE_FAILED', model: 'writer-a', kind: 'quota', reason: 'partial write' });
  r = stepImplement(r.state, { type: 'SNAPSHOT', effectId: r.effects[0]!.id, fingerprint: { ...FP, worktree: 'changed' }, diff: { paths: ['src/a.ts'] } });
  assert.equal(r.state.tag, 'restoring'); assert.equal(r.effects[0]?.kind, 'restore');
  const restoring = r.state;
  r = stepImplement(r.state, { type: 'RESTORED', effectId: r.effects[0]!.id, paths: ['src/a.ts'], patchPath: 'patch' });
  assert.equal(r.state.tag, 'write'); if (r.state.tag === 'write') assert.equal(r.state.info.modelIndex, 1);
  assert.deepEqual(stepImplement(restoring, { type: 'RESTORED', effectId: restoring.tag === 'restoring' ? restoring.effectId : '', paths: ['src/a.ts'], patchPath: 'patch' }).state, r.state);
});
test('failed-writer Git mutation stops before restore and next launch', () => {
  const r = host(writer(), { type: 'WRITE_FAILED', model: 'writer-a', kind: 'quota', reason: 'partial write' });
  for (const key of ['head', 'index', 'stash', 'gitDir'] as const) {
    const changed = { ...FP, ...(key === 'head' || key === 'index' ? { [key]: 'changed' } : {}), recovery: { ...metadata, git: { ...metadata.git, [key]: 'changed' } } };
    const stopped = stepImplement(r.state, { type: 'SNAPSHOT', effectId: r.effects[0]!.id, fingerprint: changed, diff: { paths: ['src/a.ts'] } });
    assert.equal(stopped.state.tag, 'failure-snapshot'); assert.equal(stopped.effects.some((effect) => effect.kind === 'restore'), false);
  }
});

test('rewrite SC1 observed RED stays distinct from a manual waived RED requirement', () => {
  const base = failure(); const plan = { ...base.c.plan!, criteria: base.c.plan!.criteria.map((criterion) => ({ ...criterion, evidence: 'red' as const })) };
  const f = { ...base, c: { ...base.c, plan, redMatrix: [{ id: 'SC1', path: 'tests/a.test.ts', leaf: 'check', exit: 1, tests: ['expected failure'] }] } };
  const result = host(f, { type: 'DECISION', kind: 'failure', answer: { action: 'manual-complete', by: 'user', quote: 'I observed the behavior pass', criteria: { SC1: { outcome: 'pass', evidence: 'Behavior passed' } } } });
  assert.equal(result.state.tag, 'complete'); if (result.state.tag !== 'complete') return;
  assert.equal(result.state.c.evidence['SC1']?.['redProvenance'], 'observed'); assert.equal(result.state.c.evidence['SC1']?.['waiver'], undefined);
});
