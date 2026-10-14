import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginReview, reviewMachine, stepReview, validateReview, type ReviewState } from '../../../skills/dispatch/scripts/machines/review.ts';
import type { ChangeNotice, Effect, Event } from '../../../skills/dispatch/scripts/core/types.ts';
import { stepRoot, rootMachine, type RootState } from '../../../skills/dispatch/scripts/machines/root.ts';
import { beginPlan } from '../../../skills/dispatch/scripts/machines/plan.ts';
import { beginDesignRevision } from '../../../skills/dispatch/scripts/machines/design-revision.ts';
import type { ReviewFinding } from '../../../skills/dispatch/scripts/machines/types.ts';
import { approvalState, RUN } from './fixtures/implement-recovery.ts';
import { approval as designApproval } from './fixtures/design.ts';
import { integration } from './fixtures/design-integration.ts';

function context(kind: 'plan' | 'design' | 'code' = 'plan', mode: 'report' | 'fix' = 'fix', cap = 3) {
  const begun = beginReview({ kind, mode, target: kind === 'code' ? '' : `target.${kind}.md`, cap, breadth: 1, context: 'Scoped change', roster: [], timeoutMs: 1000 }, 'review', {});
  if (!('c' in begun.state)) throw new Error('context');
  return { ...begun.state.c, round: 1, targetManifest: 'baseline.json' };
}
const cluster = (id: string) => ({ clusterId: id, findingIds: [id], paths: ['§ Proposed Changes'], verification: [], attemptBudget: 3, parentId: null, dependsOnClusters: [], members: [{ id, paths: ['§ Proposed Changes'], dependencies: [], verification: [] }] });
test('review change: authorized plan fix admits the artifact target rather than its heading', () => {
  const state: ReviewState = { tag: 'fix', c: context(), clusters: [cluster('C1')], pass: 'main', defects: [] };
  const result = stepReview(state, { type: 'FIXES_APPLIED', clusters: [{ clusterId: 'C1', status: 'applied' }] });
  assert.equal(result.state.tag, 'target-check');
  assert.deepEqual(result.effects[0]?.kind === 'check-review-target' && result.effects[0].allowedPaths, ['target.plan.md']);
});
for (const kind of ['plan', 'design', 'code'] as const) test(`review branch: ${kind} mixed and all-failed fix receipts retain scoped admission`, () => {
  const c = context(kind);
  const clusters = [cluster('C1'), cluster('C2')];
  const state: ReviewState = { tag: 'fix', c, clusters, pass: 'main', defects: [] };
  const mixed = stepReview(state, { type: 'FIXES_APPLIED', clusters: [{ clusterId: 'C1', status: 'applied' }, { clusterId: 'C2', status: 'failed' }] });
  assert.deepEqual(mixed.effects[0]?.kind === 'check-review-target' && mixed.effects[0].allowedPaths, kind === 'code' ? ['§ Proposed Changes'] : [`target.${kind}.md`]);
  const failed = stepReview(state, { type: 'FIXES_APPLIED', clusters: clusters.map((row) => ({ clusterId: row.clusterId, status: 'failed' })) });
  assert.deepEqual(failed.effects[0]?.kind === 'check-review-target' && failed.effects[0].allowedPaths, []);
  assert.deepEqual(stepReview(state, { type: 'FIXES_APPLIED', clusters: [{ clusterId: 'unknown' }] }).state, state);
});
const reviewFinding = (id: string, status: ReviewFinding['status'], extra: Partial<ReviewFinding> = {}): ReviewFinding => ({ id, severity: 'MUST', category: 'correctness', locus: 'src/a.ts:L1', defect: 'defect', requiredChange: 'fix', sources: ['codex[0]'], scope: 'in', round: 1, status, ...extra });
export const notice: ChangeNotice = { id: 'change', phase: 'review', pendingId: 'check', beforeHash: 'before', afterHash: 'after', rawDeltaRef: { version: 1, sha256: 'a'.repeat(64), bytes: 10, path: 'recovery-deltas/a.json' }, paths: ['target.plan.md'], pathCount: 1, relevance: 'relevant', reason: 'Reviewed input changed', affectedEvidence: [] };
for (const mode of ['report', 'fix'] as const) test(`review branch: ${mode} target changes record observations and apply the parked receipt`, () => {
  const c = { ...context('plan', mode), findings: [reviewFinding('R1-F001', 'open', { locus: '§ Scope' })] };
  const check: ReviewState = { tag: 'target-check', c, before: { tag: 'rule', c }, pending: { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'reject', reason: 'Not a defect' } } }, effectId: 'check' };
  const changed = stepReview(check, { type: 'REVIEW_TARGET_CHECKED', effectId: 'check', manifestPath: 'current.json', result: 'changed', notice });
  assert.notEqual(reviewMachine.awaitOf(changed.state), 'decide');
  assert.ok('c' in changed.state);
  if (!('c' in changed.state)) return;
  assert.deepEqual(changed.state.c.observations?.map((row) => row.id), [notice.id]);
  assert.equal(changed.state.c.findings[0]?.status, 'pending-rejection');
  const second = { ...notice, id: 'second', afterHash: 'second' };
  const again = stepReview({ tag: 'target-check', c: changed.state.c, before: { tag: 'rule', c: changed.state.c }, pending: { type: 'RULINGS', rulings: {} }, effectId: 'check' }, { type: 'REVIEW_TARGET_CHECKED', effectId: 'check', manifestPath: 'second.json', result: 'changed', notice: second });
  assert.ok('c' in again.state && again.state.c.observations?.length === 2);
});
test('review branch: bound empty preparation checks identity before terminal routing', () => {
  const c = context(), state: ReviewState = { tag: 'prepare', c: { ...c, effectId: 'prepare' } };
  const next = stepReview(state, { type: 'REVIEW_PREPARED', effectId: 'prepare', scope: { empty: true }, promptPaths: {} });
  assert.equal(next.state.tag, 'target-check');
  assert.equal(stepReview(next.state, { type: 'REVIEW_TARGET_CHECKED', effectId: next.effects[0]!.id, manifestPath: 'empty.json', result: 'unchanged' }).state.tag, 'empty');
});
test('review branch: changed bound preparation launches its unissued round without a decision', () => {
  const c = { ...context('code', 'report', 3), round: 2, preparedRound: 3 };
  const before: ReviewState = { tag: 'prepare', c: { ...c, effectId: 'prepare' } };
  const state: ReviewState = { tag: 'target-check', c, before, pending: { type: 'REVIEW_PREPARED', effectId: 'prepare', scope: { empty: false }, promptPaths: {} }, effectId: 'check' };
  const launched = stepReview(state, { type: 'REVIEW_TARGET_CHECKED', effectId: 'check', manifestPath: 'fresh.json', result: 'changed', notice });
  assert.equal(launched.state.tag, 'wave'); if (launched.state.tag !== 'wave') return;
  assert.equal(launched.state.c.round, 3);
  assert.equal(launched.state.c.waveRevision, notice.afterHash);
});
for (const family of ['plan', 'implementation-plan', 'implementation-code', 'design', 'design-revision', 'design-integration'] as const) test(`review branch: ${family} parent applies the parked receipt without a change decision`, () => {
  const c = context(family.includes('code') || family.includes('integration') ? 'code' : family.includes('design') ? 'design' : 'plan');
  const check: ReviewState = { tag: 'target-check', c, before: { tag: 'rule', c }, pending: { type: 'RULINGS', rulings: {} }, effectId: 'check' };
  const run = { verb: 'implement' as const, argument: 'feature', slug: 'feature' }, implemented = approvalState(), design = designApproval('implement');
  let seed: RootState;
  if (family === 'plan') {
    const plan = beginPlan({ path: 'feature.plan.md', spec: c.spec }, 'plan', {}).state;
    if (!('c' in plan) || !plan.c) throw new Error('plan context');
    seed = { tag: 'plan', run: { ...run, verb: 'plan' }, child: { tag: 'review', c: plan.c, review: check } };
  } else if (family === 'implementation-plan' || family === 'implementation-code') seed = { tag: 'implement', run, child: { tag: family === 'implementation-plan' ? 'plan-review' : 'code-review', c: implemented.c, review: check } };
  else if (family === 'design-revision') {
    const revision = beginDesignRevision(design.c, { type: 'REVISE', artifact: 'design', reason: 'repair', evidence: 'finding' }).state;
    seed = { tag: 'design', run, child: { tag: 'revision', c: design.c, child: { ...revision, tag: 'review', review: check } } };
  } else if (family === 'design-integration') {
    const parent = integration(); if (parent.tag !== 'integration') throw new Error('integration');
    seed = { tag: 'design', run, child: { ...parent, review: check } };
  } else seed = { tag: 'design', run, child: { tag: 'review', c: design.c, review: check } };
  const next = stepRoot(seed, { type: 'REVIEW_TARGET_CHECKED', effectId: 'check', manifestPath: 'changed.json', result: 'changed', notice });
  assert.notEqual(rootMachine.awaitOf(next.state), 'decide', 'the parked receipt applies without a change decision');
  assert.notEqual(rootMachine.project(next.state).data['kind'], 'drift');
});

// SECTION: Target changes around a fix

const FIX_CONFIG = {
  'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } },
  phases: { 'code-review': { rounds: { low: 2 }, targets: { low: 1 } }, 'plan-review': { rounds: { low: 2 }, targets: { low: 1 } } },
};
const fixRun = (kind: 'code' | 'plan'): Event => ({
  type: 'RUN_STARTED', verb: 'review', argument: kind === 'plan' ? 'x.plan.md' : '', level: 'low', levelSource: 'explicit', pins: null, fix: true,
  orchestrator: 'claude', orchestratorModel: null, overrides: { kind }, config: FIX_CONFIG, repo: {},
});
type Driven = { state: ReviewState; effects: readonly Effect[] };
/** Steps one event and answers each issued target check unchanged unless `changed` is set. */
function stepChecked(from: Driven, event: Event, changed = false): Driven {
  const next = reviewMachine.step(from.state, event);
  const check = next.effects.find((effect) => effect.kind === 'check-review-target');
  if (!check || changed) return next;
  return reviewMachine.step(next.state, { type: 'REVIEW_TARGET_CHECKED', effectId: check.id, manifestPath: 'check.json', result: 'unchanged' });
}
const fixPath = (kind: 'code' | 'plan') => (kind === 'code' ? 'src/a.ts' : 'x.plan.md');
const acceptFix = (path: string) => ({ ruling: 'accept', fix: { affectedPaths: [path], dependsOn: [], verification: ['npm test'] } });
/** Drives a fix review to `rule` with one open MUST finding per id. */
function toRule(kind: 'code' | 'plan', ids: readonly string[] = ['R1-F001']): Driven {
  let driven: Driven = { state: reviewMachine.initial(), effects: [] };
  driven = stepChecked(driven, fixRun(kind));
  driven = stepChecked(driven, { type: 'REVIEW_PREPARED', effectId: 'review.prepare-review.1', scope: { manifestPath: 'm1.json' }, promptPaths: { 'codex[0]': 'p0' } });
  const locus = kind === 'code' ? 'src/a.ts:L3' : '§ Scope';
  const findings = ids.map((id) => ({ id, severity: 'MUST', category: 'correctness', locus, defect: `defect ${id}`, requiredChange: 'fix', sources: ['codex[0]'], scope: 'in' }));
  driven = stepChecked(driven, { type: 'WAVE_DONE', effectId: 'review.wave.1', round: 1, slots: [{ slot: 'codex[0]', state: 'success' }], findings: findings as never });
  assert.equal(driven.state.tag, 'rule');
  return driven;
}
function toFix(kind: 'code' | 'plan'): Driven {
  const driven = stepChecked(toRule(kind), { type: 'RULINGS', rulings: { 'R1-F001': acceptFix(fixPath(kind)) } });
  assert.equal(driven.state.tag, 'fix');
  return driven;
}
/** Answers the pending target check `changed`; the change is recorded as an observation and the parked receipt applies. */
function observeChange(from: Driven): Driven {
  const check = from.effects.find((effect) => effect.kind === 'check-review-target')!;
  return reviewMachine.step(from.state, { type: 'REVIEW_TARGET_CHECKED', effectId: check.id, manifestPath: 'changed.json', result: 'changed', notice });
}
const observed = (state: ReviewState) => ('c' in state ? state.c.observations?.map((row) => row.id) : undefined);
const statusOfFinding = (state: ReviewState) => ('c' in state ? state.c.findings.find((row) => row.id === 'R1-F001')?.status : undefined);
const verifyResult = (kind: 'code' | 'plan', effectId: string): Event => kind === 'code'
  ? { type: 'VERIFY_DONE', effectId, purpose: 'fix-verify', results: [{ command: 'npm test', exit: 0, logPath: 'l.log' }], fingerprint: {} }
  : { type: 'ARTIFACT_PARSED', effectId, kind: 'plan', hash: 'h', parsed: {}, defects: [] };

for (const kind of ['code', 'plan'] as const) test(`changed target after applied fixes retains accepted findings and fails admission (${kind})`, () => {
  const fix = toFix(kind);
  const parked = stepChecked(fix, { type: 'FIXES_APPLIED', clusters: fix.state.tag === 'fix' ? fix.state.clusters.map((cluster) => ({ clusterId: cluster.clusterId, status: 'applied' })) : [] }, true);
  const changed = observeChange(parked);
  assert.equal(changed.state.tag, 'failed');
  assert.equal(statusOfFinding(changed.state), 'accepted');
  assert.deepEqual(observed(changed.state), [notice.id]);
  assert.equal(changed.effects.length, 0);
  assert.ok('c' in changed.state && 'c' in fix.state && changed.state.c.targetManifest === fix.state.c.targetManifest);
});

for (const kind of ['code', 'plan'] as const) test(`changed target during verification cannot complete the fix (${kind})`, () => {
  const fix = toFix(kind);
  const verifying = stepChecked(fix, { type: 'FIXES_APPLIED', clusters: fix.state.tag === 'fix' ? fix.state.clusters.map((cluster) => ({ clusterId: cluster.clusterId, status: 'applied' })) : [] });
  assert.equal(verifying.state.tag, 'fix-verify');
  const first = verifying.effects.find((effect) => effect.kind === 'verify' || effect.kind === 'parse-artifact')!;
  const parked = stepChecked(verifying, verifyResult(kind, first.id), true);
  assert.equal(parked.state.tag, 'target-check');
  const changed = observeChange(parked);
  assert.equal(changed.state.tag, 'failed');
  assert.equal(statusOfFinding(changed.state), 'accepted');
  assert.deepEqual(observed(changed.state), [notice.id]);
});

// SECTION: Edits before RULINGS

/** Sends `RULINGS` and answers its target check `changed` on `paths`. */
function preRuling(kind: 'code' | 'plan', rulings: Readonly<Record<string, Readonly<Record<string, unknown>>>>, paths: readonly string[], reason = notice.reason, result: 'expected' | 'changed' = 'changed'): Driven {
  const parked = stepChecked(toRule(kind, Object.keys(rulings)), { type: 'RULINGS', rulings }, true);
  const check = parked.effects.find((effect) => effect.kind === 'check-review-target')!;
  return reviewMachine.step(parked.state, { type: 'REVIEW_TARGET_CHECKED', effectId: check.id, manifestPath: 'edited.json', result, notice: { ...notice, reason, paths: [...paths], pathCount: paths.length } });
}

for (const kind of ['code', 'plan'] as const) test(`pre-ruling edit inside accepted paths enters fix (${kind})`, () => {
  const target = fixPath(kind);
  const fix = preRuling(kind, { 'R1-F001': acceptFix(target) }, [target], notice.reason, 'expected');
  assert.equal(fix.state.tag, 'fix');
  assert.equal(reviewMachine.awaitOf(fix.state), 'fix');
  assert.equal(statusOfFinding(fix.state), 'accepted');
  const applied = reviewMachine.step(fix.state, { type: 'FIXES_APPLIED', clusters: fix.state.tag === 'fix' ? fix.state.clusters.map((cluster) => ({ clusterId: cluster.clusterId, status: 'applied' })) : [] });
  const check = applied.effects.find((effect) => effect.kind === 'check-review-target');
  assert.ok(check?.kind === 'check-review-target');
  const verifying = reviewMachine.step(applied.state, { type: 'REVIEW_TARGET_CHECKED', effectId: check.id, manifestPath: 'fixed.json', result: 'expected', notice: { ...notice, paths: [target], pathCount: 1, relevance: 'expected' } });
  assert.equal(verifying.state.tag, 'fix-verify');
});

test('pre-ruling unadmitted edits retain observations and stop before fixing', () => {
  const accepted = { 'R1-F001': acceptFix('src/a.ts') };
  for (const [label, rulings, paths, reason] of [
    ['outside accepted paths', accepted, ['src/a.ts', 'src/b.ts'], notice.reason],
    ['comparison identity changed', accepted, ['src/a.ts'], 'Comparison identity changed.'],
    ['rejected ruling', { ...accepted, 'R1-F002': { ruling: 'reject', reason: 'Not a defect' } }, ['src/a.ts'], notice.reason],
  ] as const) {
    const next = preRuling('code', rulings, paths, reason);
    assert.equal(next.state.tag, 'failed', label);
    assert.deepEqual(observed(next.state), [notice.id], label);
  }
});
