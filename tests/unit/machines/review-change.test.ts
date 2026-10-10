import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginReview, reviewMachine, stepReview, validateReview, type ReviewState } from '../../../skills/dispatch/scripts/machines/review.ts';
import type { ChangeNotice, Effect, Event } from '../../../skills/dispatch/scripts/core/types.ts';
import { stepRoot, rootMachine, type RootState } from '../../../skills/dispatch/scripts/machines/root.ts';
import { beginPlan } from '../../../skills/dispatch/scripts/machines/plan.ts';
import { beginRevision } from '../../../skills/dispatch/scripts/machines/revision.ts';
import { beginDesignRevision } from '../../../skills/dispatch/scripts/machines/design-revision.ts';
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
export const notice: ChangeNotice = { id: 'change', phase: 'review', pendingId: 'check', beforeHash: 'before', afterHash: 'after', rawDeltaRef: { version: 1, sha256: 'a'.repeat(64), bytes: 10, path: 'recovery-deltas/a.json' }, paths: ['target.plan.md'], pathCount: 1, relevance: 'relevant', reason: 'Reviewed input changed', affectedEvidence: [] };
for (const mode of ['report', 'fix'] as const) test(`review branch: ${mode} second edits reject obsolete resolution and retain the parked receipt`, () => {
  const c = context('plan', mode);
  const before: ReviewState = { tag: 'rule', c };
  const check: ReviewState = { tag: 'target-check', c, before, pending: { type: 'RULINGS', rulings: {} }, effectId: 'check' };
  const changed = stepReview(check, { type: 'REVIEW_TARGET_CHECKED', effectId: 'check', manifestPath: 'current.json', result: 'changed', notice });
  assert.equal(changed.state.tag, 'change-resolution');
  const answer = { by: 'orchestrator', noticeId: notice.id, afterHash: notice.afterHash, action: 'refresh', rationale: 'Current intent remains unchanged', evidenceIds: [] };
  assert.ok(validateReview(changed.state, { type: 'DECISION', kind: 'drift', answer: { ...answer, afterHash: 'old' } }));
  const recheck = stepReview(changed.state, { type: 'DECISION', kind: 'drift', answer });
  assert.equal(recheck.effects[0]?.kind, 'check-review-target');
  const raced = stepReview(recheck.state, { type: 'REVIEW_TARGET_CHECKED', effectId: recheck.effects[0]!.id, manifestPath: 'second.json', result: 'changed', notice: { ...notice, id: 'second', afterHash: 'second' } });
  assert.equal(raced.state.tag, 'change-resolution');
  assert.deepEqual(stepReview(raced.state, { type: 'DECISION', kind: 'drift', answer }).state, raced.state);
});
for (const cap of [1, 3]) test(`review branch: refresh respects remaining rounds at cap ${cap}`, () => {
  const c = context('plan', 'report', cap), before: ReviewState = { tag: 'rule', c };
  const state: ReviewState = { tag: 'target-check', c, before, pending: { type: 'RULINGS', rulings: {} }, effectId: 'check', resolution: { by: 'orchestrator', noticeId: notice.id, afterHash: notice.afterHash, action: 'refresh', rationale: 'Review changed content', evidenceIds: [] } };
  const next = stepReview(state, { type: 'REVIEW_TARGET_CHECKED', effectId: 'check', manifestPath: 'refreshed.json', result: 'changed', notice });
  assert.equal(next.state.tag, cap === 1 ? 'escalated' : 'prepare');
  if ('c' in next.state) assert.equal(next.state.c.spec.cap, cap);
});
test('review branch: bound empty preparation checks identity before terminal routing', () => {
  const c = context(), state: ReviewState = { tag: 'prepare', c: { ...c, effectId: 'prepare' } };
  const next = stepReview(state, { type: 'REVIEW_PREPARED', effectId: 'prepare', scope: { empty: true }, promptPaths: {} });
  assert.equal(next.state.tag, 'target-check');
  assert.equal(stepReview(next.state, { type: 'REVIEW_TARGET_CHECKED', effectId: next.effects[0]!.id, manifestPath: 'empty.json', result: 'unchanged' }).state.tag, 'empty');
});
test('review branch: changed bound preparation at the cap reuses its unissued round', () => {
  const c = { ...context('code', 'report', 3), round: 3 };
  const before: ReviewState = { tag: 'prepare', c: { ...c, effectId: 'prepare' } };
  const state: ReviewState = { tag: 'target-check', c, before, pending: { type: 'REVIEW_PREPARED', effectId: 'prepare', scope: { empty: false }, promptPaths: {} }, effectId: 'check', resolution: { by: 'orchestrator', noticeId: notice.id, afterHash: notice.afterHash, action: 'refresh', rationale: 'Review current content without spending an unissued wave.', evidenceIds: [] } };
  const refreshed = stepReview(state, { type: 'REVIEW_TARGET_CHECKED', effectId: 'check', manifestPath: 'fresh.json', result: 'changed', notice });
  assert.equal(refreshed.state.tag, 'prepare'); if (refreshed.state.tag !== 'prepare') return;
  assert.equal(refreshed.state.c.round, 3);
  const prepared = stepReview(refreshed.state, { type: 'REVIEW_PREPARED', effectId: refreshed.state.c.effectId!, scope: { empty: false }, promptPaths: {} });
  const checked = stepReview(prepared.state, { type: 'REVIEW_TARGET_CHECKED', effectId: prepared.effects[0]!.id, manifestPath: 'fresh.json', result: 'unchanged' });
  assert.equal(checked.state.tag, 'wave'); if ('c' in checked.state) assert.equal(checked.state.c.round, 3);
});
for (const family of ['plan', 'implementation-plan', 'implementation-code', 'plan-revision', 'design', 'design-revision', 'design-integration'] as const) test(`review branch: ${family} parent forwards a bound change notice`, () => {
  const c = context(family.includes('code') || family.includes('integration') ? 'code' : family.includes('design') ? 'design' : 'plan');
  const check: ReviewState = { tag: 'target-check', c, before: { tag: 'rule', c }, pending: { type: 'RULINGS', rulings: {} }, effectId: 'check' };
  const run = { verb: 'implement' as const, argument: 'feature', slug: 'feature' }, implemented = approvalState(), design = designApproval('implement');
  let seed: RootState;
  if (family === 'plan') {
    const plan = beginPlan({ path: 'feature.plan.md', spec: c.spec }, 'plan', {}).state;
    if (!('c' in plan) || !plan.c) throw new Error('plan context');
    seed = { tag: 'plan', run: { ...run, verb: 'plan' }, child: { tag: 'review', c: plan.c, review: check } };
  } else if (family === 'implementation-plan' || family === 'implementation-code') seed = { tag: 'implement', run, child: { tag: family === 'implementation-plan' ? 'plan-review' : 'code-review', c: implemented.c, review: check } };
  else if (family === 'plan-revision') {
    const r = beginRevision(implemented, { type: 'REVISE', artifact: 'plan', reason: 'repair', evidence: 'finding' }).state.r;
    seed = { tag: 'revision', run, child: { tag: 'review', r, review: check } };
  } else if (family === 'design-revision') {
    const revision = beginDesignRevision(design.c, { type: 'REVISE', artifact: 'design', reason: 'repair', evidence: 'finding' }).state;
    seed = { tag: 'design', run, child: { tag: 'revision', c: design.c, child: { ...revision, tag: 'review', review: check } } };
  } else if (family === 'design-integration') {
    const parent = integration(); if (parent.tag !== 'integration') throw new Error('integration');
    seed = { tag: 'design', run, child: { ...parent, review: check } };
  } else seed = { tag: 'design', run, child: { tag: 'review', c: design.c, review: check } };
  const next = stepRoot(seed, { type: 'REVIEW_TARGET_CHECKED', effectId: 'check', manifestPath: 'changed.json', result: 'changed', notice });
  assert.equal(rootMachine.awaitOf(next.state), 'decide');
  assert.deepEqual(rootMachine.project(next.state).data['notice'], notice);
  assert.equal(rootMachine.project(next.state).data['kind'], 'drift');
});

// SECTION: Refresh after a fix

const FIX_CONFIG = {
  'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } },
  phases: { 'code-review': { rounds: { low: 2 }, targets: { low: 1 } }, 'plan-review': { rounds: { low: 2 }, targets: { low: 1 } } },
};
const fixRun = (kind: 'code' | 'plan'): Event => ({
  type: 'RUN_STARTED', verb: 'review', argument: kind === 'plan' ? 'x.plan.md' : '', level: 'low', levelSource: 'explicit', pins: null, fix: true,
  orchestrator: 'claude', orchestratorModel: null, overrides: { kind }, config: FIX_CONFIG, repo: {},
});
const refreshAnswer = { by: 'orchestrator', noticeId: notice.id, afterHash: notice.afterHash, action: 'refresh', rationale: 'Regenerated output belongs to the fix', evidenceIds: [] };
type Driven = { state: ReviewState; effects: readonly Effect[] };
/** Steps one event and answers each issued target check unchanged unless `changed` is set. */
function stepChecked(from: Driven, event: Event, changed = false): Driven {
  const next = reviewMachine.step(from.state, event);
  const check = next.effects.find((effect) => effect.kind === 'check-review-target');
  if (!check || changed) return next;
  return reviewMachine.step(next.state, { type: 'REVIEW_TARGET_CHECKED', effectId: check.id, manifestPath: 'check.json', result: 'unchanged' });
}
function toFix(kind: 'code' | 'plan'): Driven {
  let driven: Driven = { state: reviewMachine.initial(), effects: [] };
  driven = stepChecked(driven, fixRun(kind));
  driven = stepChecked(driven, { type: 'REVIEW_PREPARED', effectId: 'review.prepare-review.1', scope: { manifestPath: 'm1.json' }, promptPaths: { 'codex[0]': 'p0' } });
  const locus = kind === 'code' ? 'src/a.ts:L3' : '§ Scope';
  const finding = { id: 'R1-F001', severity: 'MUST', category: 'correctness', locus, defect: 'defect', requiredChange: 'fix', sources: ['codex[0]'], scope: 'in' };
  driven = stepChecked(driven, { type: 'WAVE_DONE', effectId: 'review.wave.1', round: 1, slots: [{ slot: 'codex[0]', state: 'success' }], findings: [finding] as never });
  driven = stepChecked(driven, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept', fix: { affectedPaths: [kind === 'code' ? 'src/a.ts' : 'x.plan.md'], dependsOn: [], verification: ['npm test'] } } } });
  assert.equal(driven.state.tag, 'fix');
  return driven;
}
/** Answers the pending target check `changed`, resolves the drift with refresh, and answers the bound recheck `changed` again. */
function refresh(from: Driven): Driven {
  const check = from.effects.find((effect) => effect.kind === 'check-review-target')!;
  const changed = reviewMachine.step(from.state, { type: 'REVIEW_TARGET_CHECKED', effectId: check.id, manifestPath: 'changed.json', result: 'changed', notice });
  assert.equal(changed.state.tag, 'change-resolution');
  const recheck = reviewMachine.step(changed.state, { type: 'DECISION', kind: 'drift', answer: refreshAnswer });
  return reviewMachine.step(recheck.state, { type: 'REVIEW_TARGET_CHECKED', effectId: recheck.effects[0]!.id, manifestPath: 'refreshed.json', result: 'changed', notice });
}
const statusOfFinding = (state: ReviewState) => ('c' in state ? state.c.findings.find((row) => row.id === 'R1-F001')?.status : undefined);
const verifyResult = (kind: 'code' | 'plan', effectId: string): Event => kind === 'code'
  ? { type: 'VERIFY_DONE', effectId, purpose: 'fix-verify', results: [{ command: 'npm test', exit: 0, logPath: 'l.log' }], fingerprint: {} }
  : { type: 'ARTIFACT_PARSED', effectId, kind: 'plan', hash: 'h', parsed: {}, defects: [] };

for (const kind of ['code', 'plan'] as const) test(`refresh after a fix keeps fixed findings (${kind})`, () => {
  const fix = toFix(kind);
  const parked = stepChecked(fix, { type: 'FIXES_APPLIED', clusters: fix.state.tag === 'fix' ? fix.state.clusters.map((cluster) => ({ clusterId: cluster.clusterId, status: 'applied' })) : [] }, true);
  const refreshed = refresh(parked);
  assert.equal(refreshed.state.tag, 'fix-verify');
  assert.equal(statusOfFinding(refreshed.state), 'accepted');
  const verification = refreshed.effects.find((effect) => effect.kind === (kind === 'code' ? 'verify' : 'parse-artifact'));
  assert.ok(verification, 'fix-verify effect issued after the refresh');
  const done = stepChecked(refreshed, verifyResult(kind, verification.id));
  assert.equal(statusOfFinding(done.state), 'fixed');
  assert.ok('c' in done.state && done.state.c.fixes.some((row) => row.id === 'R1-F001'));
});

for (const kind of ['code', 'plan'] as const) test(`refresh after a fix reruns verification (${kind})`, () => {
  const fix = toFix(kind);
  const verifying = stepChecked(fix, { type: 'FIXES_APPLIED', clusters: fix.state.tag === 'fix' ? fix.state.clusters.map((cluster) => ({ clusterId: cluster.clusterId, status: 'applied' })) : [] });
  assert.equal(verifying.state.tag, 'fix-verify');
  const first = verifying.effects.find((effect) => effect.kind === 'verify' || effect.kind === 'parse-artifact')!;
  const parked = stepChecked(verifying, verifyResult(kind, first.id), true);
  assert.equal(parked.state.tag, 'target-check');
  const refreshed = refresh(parked);
  assert.equal(refreshed.state.tag, 'fix-verify');
  assert.equal(statusOfFinding(refreshed.state), 'accepted');
  const rerun = refreshed.effects.find((effect) => effect.kind === first.kind);
  assert.ok(rerun, 'verification reissued');
  assert.notEqual(rerun.id, first.id);
  assert.equal(statusOfFinding(stepChecked(refreshed, verifyResult(kind, first.id)).state), 'accepted', 'stale result ignored');
  assert.equal(statusOfFinding(stepChecked(refreshed, verifyResult(kind, rerun.id)).state), 'fixed');
});
