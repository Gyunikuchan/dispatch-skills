import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectFrame } from '../../../skills/dispatch/scripts/core/frame.ts';
import { validateHostEvent } from '../../../skills/dispatch/scripts/core/validate.ts';
import type { ChangeNotice, HostEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { renderResolutionSection } from '../../../skills/dispatch/scripts/domain/render.ts';
import { beginDesignRevision } from '../../../skills/dispatch/scripts/machines/design-revision.ts';
import { beginPlan } from '../../../skills/dispatch/scripts/machines/plan.ts';
import { beginReview, resolutionRounds, type ReviewState } from '../../../skills/dispatch/scripts/machines/review.ts';
import { rootMachine, stepRoot, type RootState } from '../../../skills/dispatch/scripts/machines/root.ts';
import { approval as designApproval } from '../machines/fixtures/design.ts';
import { integration } from '../machines/fixtures/design-integration.ts';
import { approvalState } from '../machines/fixtures/implement-recovery.ts';

// SECTION: Harness — each review family parked on an in-flight wave result whose target changes before receipt.

type Kind = 'plan' | 'design' | 'code';
const notice: ChangeNotice = { id: 'change-1', phase: 'review', pendingId: 'check', beforeHash: 'launch-rev', afterHash: 'live-rev', rawDeltaRef: { version: 1, sha256: 'a'.repeat(64), bytes: 10, path: 'recovery-deltas/a.json' }, paths: ['target'], pathCount: 1, relevance: 'relevant', reason: 'Reviewed content changed.', affectedEvidence: [] };
const finding = { id: 'R1-F001', severity: 'MUST' as const, category: 'correctness', locus: 'src/a.ts:L1', defect: 'Missing guard', requiredChange: 'Add guard', sources: ['codex[0]'], scope: 'in' as const };

/** A review parked on its round-1 wave result; the wave launched against `launch-rev`. */
function inFlight(kind: Kind): ReviewState {
  const begun = beginReview({ kind, target: kind === 'code' ? '' : `target.${kind}.md`, cap: 3, breadth: 1, context: 'Scoped change', roster: [], timeoutMs: 1000 }, 'review', {});
  if (!('c' in begun.state)) throw new Error('context');
  const c = { ...begun.state.c, round: 1, targetManifest: 'launch.json', reviewedRevision: 'launch-rev', waveRevision: 'launch-rev', effectId: 'wave' };
  return { tag: 'target-check', c, before: { tag: 'wave', c, phase: 'cli' }, pending: { type: 'WAVE_DONE', effectId: 'wave', round: 1, slots: [{ slot: 'codex[0]', state: 'success' }], findings: [finding] }, effectId: 'check' };
}

const FAMILIES = ['standalone', 'plan', 'implementation-plan', 'implementation-code', 'design', 'design-revision', 'design-integration'] as const;
type Family = typeof FAMILIES[number];
const kindOf = (family: Family, standalone: Kind): Kind => family === 'standalone' ? standalone : family.includes('code') || family.includes('integration') ? 'code' : family.includes('design') ? 'design' : 'plan';

function seed(family: Family, check: ReviewState): RootState {
  const run = { verb: 'implement' as const, argument: 'feature', slug: 'feature' };
  if (family === 'standalone') return { tag: 'review', run: { ...run, verb: 'review' }, child: check };
  if (family === 'plan') {
    const plan = beginPlan({ path: 'feature.plan.md', spec: (check as Extract<ReviewState, { tag: 'target-check' }>).c.spec }, 'plan', {}).state;
    if (!('c' in plan) || !plan.c) throw new Error('plan context');
    return { tag: 'plan', run: { ...run, verb: 'plan' }, child: { tag: 'review', c: plan.c, review: check } };
  }
  if (family === 'implementation-plan' || family === 'implementation-code') return { tag: 'implement', run, child: { tag: family === 'implementation-plan' ? 'plan-review' : 'code-review', c: approvalState().c, review: check } };
  const design = designApproval('implement');
  if (family === 'design-revision') {
    const revision = beginDesignRevision(design.c, { type: 'REVISE', artifact: 'design', reason: 'repair', evidence: 'finding' }).state;
    return { tag: 'design', run, child: { tag: 'revision', c: design.c, child: { ...revision, tag: 'review', review: check } } };
  }
  if (family === 'design-integration') {
    const parent = integration(); if (parent.tag !== 'integration') throw new Error('integration');
    return { tag: 'design', run, child: { ...parent, review: check } };
  }
  return { tag: 'design', run, child: { tag: 'review', c: design.c, review: check } };
}

type Row = Record<string, unknown>;
const findingsOf = (state: RootState): Row[] => (rootMachine.project(state).data['findings'] as Row[] | undefined) ?? [];

// SECTION: Matrix

for (const family of FAMILIES) for (const standalone of family === 'standalone' ? ['plan', 'design', 'code'] as const : ['plan'] as const) {
  const label = family === 'standalone' ? `standalone ${standalone}` : family;
  test(`review-reuse: target change retains in-flight revision-bound findings (${label})`, () => {
    const next = stepRoot(seed(family, inFlight(kindOf(family, standalone))), { type: 'REVIEW_TARGET_CHECKED', effectId: 'check', manifestPath: 'live.json', result: 'changed', notice });
    const frame = projectFrame(rootMachine, next.state, 'runs/001');
    assert.equal(frame.await, 'rule', 'a change observation adds no await');
    assert.deepEqual(findingsOf(next.state).map((row) => [row['id'], row['revision']]), [['R1-F001', 'launch-rev']]);
    const observations = frame.data['reviewObservations'] as Row[];
    assert.deepEqual(observations.map((row) => [row['id'], row['afterHash']]), [['change-1', 'live-rev']]);
    const examples = (frame.events ?? []).filter((event) => event.type === 'REVIEW_USE');
    assert.ok(examples.length > 0, 'the frame shows an optional applicability selection');
    const reuse = { type: 'REVIEW_USE', observationId: 'change-1', afterHash: 'live-rev', action: 'reuse', rationale: 'The edit only renamed a local variable.' };
    const check = (event: HostEvent) => rootMachine.validate!(next.state, event);
    assert.equal(validateHostEvent('rule', reuse, check).ok, true);
    assert.equal(validateHostEvent('rule', { ...reuse, afterHash: 'stale' }, check).ok, false);
    const rulings = { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept', fix: { affectedPaths: ['src/a.ts'], dependsOn: [], verification: [] } } } };
    assert.equal(validateHostEvent('rule', rulings, check).ok, true, 'rulings proceed without an acknowledgement');
  });
}

test('review-reuse: non-review frames reject an applicability selection', () => {
  const state: RootState = { tag: 'implement', run: { verb: 'implement', argument: 'feature', slug: 'feature' }, child: approvalState() };
  const event = { type: 'REVIEW_USE', observationId: 'change-1', afterHash: 'live-rev', action: 'reuse', rationale: 'Unchanged behavior.' };
  assert.equal(validateHostEvent('decide', event, (item) => rootMachine.validate!(state, item)).ok, false);
});

test('review-reuse: rendered history keeps actual coverage apart from host reuse rationale', () => {
  const next = stepRoot(seed('standalone', inFlight('code')), { type: 'REVIEW_TARGET_CHECKED', effectId: 'check', manifestPath: 'live.json', result: 'changed', notice });
  const used = stepRoot(next.state, { type: 'REVIEW_USE', observationId: 'change-1', afterHash: 'live-rev', action: 'reuse', rationale: 'Only comments changed.' });
  if (used.state.tag !== 'review' || !('c' in used.state.child)) throw new Error('review');
  const text = renderResolutionSection(resolutionRounds(used.state.child.c));
  assert.match(text, /Reviewed target: launch-rev/);
  assert.match(text, /Target changed after review: live-rev/);
  assert.match(text, /Host applicability: reuse — Only comments changed\./);
});

test('review-reuse: host-selected full review keeps prior rulings and launches one round', () => {
  const next = stepRoot(seed('standalone', inFlight('code')), { type: 'REVIEW_TARGET_CHECKED', effectId: 'check', manifestPath: 'live.json', result: 'changed', notice });
  const used = stepRoot(next.state, { type: 'REVIEW_USE', observationId: 'change-1', afterHash: 'live-rev', action: 'full', rationale: 'Control flow changed.' });
  const answerTarget = (from: RootState, event: Parameters<typeof stepRoot>[1]) => {
    const result = stepRoot(from, event), check = result.effects.find((effect) => effect.kind === 'check-review-target');
    return check?.kind === 'check-review-target' ? stepRoot(result.state, { type: 'REVIEW_TARGET_CHECKED', effectId: check.id, manifestPath: 'live.json', result: 'unchanged' }) : result;
  };
  const fixing = answerTarget(used.state, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' } } });
  if (fixing.state.tag !== 'review' || fixing.state.child.tag !== 'fix') throw new Error(`expected fix, got ${fixing.state.tag}`);
  const applied = answerTarget(fixing.state, { type: 'FIXES_APPLIED', clusters: fixing.state.child.clusters.map((row) => ({ clusterId: row.clusterId, status: 'applied' })) });
  if (applied.state.tag !== 'review' || applied.state.child.tag !== 'fix-verify') throw new Error(`expected fix verification, got ${applied.state.tag}`);
  const verify = applied.effects.find((effect) => effect.kind === 'verify');
  if (verify?.kind !== 'verify') throw new Error('verify effect');
  const launched = answerTarget(applied.state, { type: 'VERIFY_DONE', effectId: verify.id, purpose: 'fix-verify', results: [], fingerprint: {} });
  if (launched.state.tag !== 'review' || launched.state.child.tag !== 'prepare') throw new Error(`expected prepare, got ${launched.state.tag}`);
  assert.equal(launched.state.child.c.round, 1);
  assert.equal(launched.state.child.c.requested, 'change-1');
  assert.equal(launched.state.child.c.observations![0]!.use?.launchedRound, undefined);
  const prepare = launched.effects.find((effect) => effect.kind === 'prepare-review');
  assert.equal(prepare?.kind === 'prepare-review' && prepare.scope['scope'], 'full');
  assert.deepEqual(launched.state.child.c.findings.map((row) => [row.id, row.status, row.revision]), [['R1-F001', 'fixed', 'launch-rev']]);
  assert.ok(prepare?.kind === 'prepare-review');
  const prepared = stepRoot(launched.state, { type: 'REVIEW_PREPARED', effectId: prepare.id, scope: { empty: false, manifestPath: 'selected.json' }, promptPaths: {} });
  const binding = prepared.effects.find((effect) => effect.kind === 'check-review-target');
  assert.ok(binding?.kind === 'check-review-target');
  const wave = stepRoot(prepared.state, { type: 'REVIEW_TARGET_CHECKED', effectId: binding.id, manifestPath: 'selected.json', result: 'unchanged' });
  if (wave.state.tag !== 'review' || wave.state.child.tag !== 'wave') throw new Error(`expected wave, got ${wave.state.tag}`);
  assert.equal(wave.state.child.c.round, 2);
  assert.equal(wave.state.child.c.requested, undefined);
  assert.equal(wave.state.child.c.observations![0]!.use?.launchedRound, 2);
  assert.deepEqual(wave.state.child.c.findings.map((row) => [row.id, row.status, row.revision]), [['R1-F001', 'fixed', 'launch-rev']]);
  assert.equal(wave.effects[0]?.kind, 'wave-start');
  assert.equal(wave.effects[0]?.kind === 'wave-start' && wave.effects[0].round, 2);
});
