import assert from 'node:assert/strict';
import type { Event, RecoverySnapshot, RunStartedEvent, TreeFingerprint } from '../../../../skills/dispatch/scripts/core/types.ts';
import { JOURNAL_PROTOCOL_REVISION } from '../../../../skills/dispatch/scripts/core/types.ts';
import { implementData, initialImplement, stepImplement, validateImplement, type ImplementState } from '../../../../skills/dispatch/scripts/machines/implement.ts';
import { artifactRelative, type VerifyRecord } from '../../../../skills/dispatch/scripts/machines/implement-types.ts';

export const HASH = `sha256:${'a'.repeat(64)}`;
export const metadata: RecoverySnapshot = { repoRoot: '', contents: { 'src/a.ts': Buffer.from('before').toString('base64') }, entries: { 'src/a.ts': { kind: 'file', mode: 0o644, linkTarget: null } }, taskStartFiles: ['src/a.ts'], callerDirty: [], ignored: [], git: { head: 'h', index: 'i', stash: '', gitDir: 'g' }, changed: [], verifiedManifestDirs: [], hashManifestDirs: [] };
export const FP: TreeFingerprint = { head: 'h', index: 'i', worktree: 'w', recovery: metadata };
export const PLAN = { title: 'Feature', box: { 'TL;DR': 'Deliver feature' }, keyDecisions: [], criteria: [{ id: 'SC1', title: 'works', line: 1, changes: ['src/a.ts'], verify: [{ command: 'check', final: false }], evidence: 'verify', preExisting: false, redException: null, testRationale: null, review: null, enforcementInfeasibility: null }], changes: [{ action: 'MODIFY', path: 'src/a.ts', note: 'feature', command: null, line: 1 }], verification: { automated: ['check'], none: null, manual: [] }, tasks: [{ id: 'T1', title: 'Feature', summary: 'Deliver feature', line: 1, prerequisites: [], criteria: ['SC1'], paths: ['src/a.ts'], generated: [] }], finalCommands: [], traceability: null, governedText: 'original governed text' };
export const RUN: RunStartedEvent = { type: 'RUN_STARTED', protocolRevision: JOURNAL_PROTOCOL_REVISION, verb: 'implement', argument: 'x.plan.md', level: 'low', levelSource: 'explicit', pins: null, fix: false, orchestrator: 'claude', orchestratorModel: null, repo: {}, overrides: { sessionDir: 'session', settledPlan: { path: 'x.plan.md', hash: HASH, outcome: 'settled' } }, config: { 'write-subagents': { claude: { low: { model: ['writer-a', 'writer-b'] } } }, 'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } }, phases: { 'plan-review': { rounds: { low: 1 }, targets: { low: 1 } }, 'code-review': { rounds: { low: 0 }, targets: { low: 1 } } } } };
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
export function classify(result: ReturnType<typeof stepImplement>) {
  if (result.state.tag !== 'level-classification') return result;
  return host(result.state, { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'low', rationale: 'Bounded local recovery.', gateScope: implementData(result.state)['gateScope'] } });
}
export function failure(): Extract<ImplementState, { tag: 'failure' }> { const c = approvalState().c; return { tag: 'failure', c: { ...c, phase: 'delivered', approval: { by: 'user', quote: 'Proceed' }, stalled: { purpose: 'final', rows: [failedRow] } }, reason: 'blocked-by-plan: check failed', changedPaths: [] }; }
export function taskFailure(attempt: number, failures = attempt): Extract<ImplementState, { tag: 'failure' }> {
  const f = failure();
  return { ...f, c: { ...f.c, phase: 'tasks', stalled: null, tasks: { T1: { id: 'T1', status: 'failed', attempt, failures, signature: '', input: null, worktree: null, handle: null, baseline: null, preserveDraft: false, modelIndex: 0, brief: null, candidate: null, integrated: null, redRows: [], reason: 'check failed' } } } };
}
