import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effect, Event, Level, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { reviewMachine, resolutionRounds, type ReviewState } from '../../../skills/dispatch/scripts/machines/review.ts';
import { renderResolutionSection } from '../../../skills/dispatch/scripts/domain/render.ts';
import { play } from '../../helpers/play.ts';

const CONFIG = {
  'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] }, agy: { targets: [{ low: { model: 'gemini' } }] } },
  phases: { 'code-review': { rounds: { low: 2 }, targets: { low: 2 } } },
};
const started = (over: Partial<RunStartedEvent> = {}): RunStartedEvent => ({
  type: 'RUN_STARTED', verb: 'review', argument: 'main..HEAD', level: 'low', levelSource: 'explicit', pins: null,
  orchestrator: 'claude', orchestratorModel: null, overrides: {}, config: CONFIG, repo: {}, ...over,
});
const finding = (id: string, over: Record<string, unknown> = {}) => ({
  id, severity: 'MUST', category: 'correctness', locus: 'src/a.ts:L3', defect: `defect ${id}`, requiredChange: 'fix it', sources: ['agy[0]'], scope: 'in', ...over,
});
const prepared = (n: number): Event => ({ type: 'REVIEW_PREPARED', effectId: `review.prepare-review.${n}`, scope: {}, promptPaths: { 'codex[0]': 'p0', 'agy[0]': 'p1' } });
const rows = [{ slot: 'codex[0]', state: 'success' }, { slot: 'agy[0]', state: 'success' }];
const waveDone = (n: number, findings: unknown[]): Event => ({ type: 'WAVE_DONE', effectId: `review.wave.${n}`, round: n, slots: rows, findings: findings as never });

for (const [level, expected] of Object.entries({ low: 600_000, medium: 600_000, high: 1_200_000, xhigh: 1_800_000, max: 1_800_000 })) {
  test(`diagnostics amendment timeout: ${level} default and positive override`, () => {
    const config = { 'read-delegates': { codex: { targets: [{ [level]: { model: 'gpt-5' } }] } }, phases: { 'code-review': { rounds: { [level]: 2 }, targets: { [level]: 1 } } } };
    for (const timeout of [undefined, 0, -1, 7]) {
      const { state, effects } = drive([started({ level: level as Level, config, overrides: timeout === undefined ? {} : { timeout } }), prepared(1)]);
      assert.equal(state.tag, 'wave');
      assert.equal(effects[0]?.kind === 'wave-start' && effects[0].timeoutMs, timeout === 7 ? 7_000 : expected);
    }
  });
}

test('diagnostics amendment timeout: failed review spec retains fallback', () => {
  const { state } = drive([started({ level: 'max', config: { 'read-delegates': {} } })]);
  assert.equal(state.tag, 'failed');
  assert.equal('c' in state && state.c.spec.timeoutMs, 600_000);
});

test('diagnostics amendment continuation frame: within cap omits reason and exposes full scope', () => {
  const { state } = drive([started(), prepared(1), waveDone(1, [finding('R1-F001')])]);
  const data = reviewMachine.project(state).data;
  assert.equal(data['scope'], 'full');
  assert.ok(!('continuationReason' in data));
});

for (const scope of ['delta', 'disputes-only'] as const) test(`diagnostics amendment continuation frame: ${scope} beyond cap describes MUST continuation`, () => {
  const config = { ...CONFIG, phases: { 'code-review': { rounds: { low: 1 }, targets: { low: 2 } } } };
  const events: Event[] = [started({ config }), prepared(1), waveDone(1, [finding('R1-F001')]),
    { type: 'RULINGS', rulings: { 'R1-F001': scope === 'delta' ? { ruling: 'accept' } : { ruling: 'reject', reason: 'by design' } } }];
  if (scope === 'delta') {
    const { state } = drive(events);
    assert.equal(state.tag, 'fix');
    if (state.tag !== 'fix') throw new Error('fix state missing');
    events.push({ type: 'FIXES_APPLIED', clusters: state.clusters.map((cluster) => ({ clusterId: cluster.clusterId, status: 'applied' })) },
      { type: 'VERIFY_DONE', effectId: 'review.verify.1', purpose: 'fix-verify', results: [], fingerprint: {} });
  }
  events.push(prepared(2), waveDone(2, [finding('R2-F001', { locus: 'src/b.ts:L1', defect: 'new defect' })]));
  const { state } = drive(events);
  assert.equal(state.tag, 'rule');
  const data = reviewMachine.project(state).data;
  assert.equal(data['round'], 2);
  assert.equal(data['cap'], 1);
  assert.equal(data['scope'], scope);
  assert.match(String(data['continuationReason']), /MUST/);
  assert.match(String(data['continuationReason']), scope === 'delta' ? /delta.*fixed|fixed.*delta/ : /disputes-only.*pending.rejection|pending.rejection.*disputes-only/);
});

function drive(events: readonly Event[]): { state: ReviewState; effects: readonly Effect[] } {
  let state = reviewMachine.initial();
  let effects: readonly Effect[] = [];
  for (const event of events) ({ state, effects } = reviewMachine.step(state, event));
  return { state, effects };
}

test('prepare → wave → rule: frames per transition', () => {
  const frames = play(reviewMachine, [started(), prepared(1), waveDone(1, [finding('R1-F001')])]);
  assert.deepEqual(frames.map((frame) => [frame.at, frame.await]), [['review › prepare', 'done'], ['review › wave', 'done'], ['review › rule', 'rule']]);
  assert.deepEqual((frames[2]?.data['findings'] as { id: string }[]).map((entry) => entry.id), ['R1-F001']);
  const { effects } = drive([started(), prepared(1)]);
  const wave = effects[0];
  assert.equal(wave?.kind, 'wave-start');
  assert.deepEqual(wave?.kind === 'wave-start' && wave.roster.map((slot) => [slot['slot'], slot['promptPath'], slot['review']]), [['codex[0]', 'p0', 'code'], ['agy[0]', 'p1', 'code']]);
});

test('disputes-only round when nothing was fixed; affinity carries the rejection to its source slot', () => {
  const events = [started(), prepared(1), waveDone(1, [finding('R1-F001')]), { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'reject', reason: 'by design' } } } as Event];
  const { state, effects } = drive(events);
  assert.equal(state.tag, 'prepare');
  const next = effects[0];
  assert.equal(next?.kind === 'prepare-review' && next.id, 'review.prepare-review.2');
  assert.deepEqual(next?.kind === 'prepare-review' && next.scope, {
    scope: 'disputes-only', affectedPaths: [], carried: [{ id: 'R1-F001', slot: 'agy[0]', locus: 'src/a.ts:L3', defect: 'defect R1-F001', reason: 'by design' }],
  });
});

test('orchestrator closure below threshold at the cap', () => {
  const should = finding('R1-F001', { severity: 'SHOULD' });
  const events = [
    started(), prepared(1), waveDone(1, [should]), { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'reject', reason: 'intentional behavior; retained scenario evidence' } } } as Event,
    prepared(2), waveDone(2, [{ ...should, id: 'R2-F001' }]), { type: 'RULINGS', rulings: { 'R2-F001': { ruling: 'reject', reason: 'intentional behavior; retained scenario evidence' } } } as Event,
  ];
  const { state } = drive(events);
  assert.equal(state.tag, 'settled');
  const statuses = 'c' in state ? state.c.findings.map((entry) => [entry.id, entry.status]) : [];
  assert.deepEqual(statuses, [['R1-F001', 'superseded'], ['R2-F001', 'closed-by-orchestrator']]);
});

test('cap = 0 → skipped with no effect', () => {
  const config = { ...CONFIG, phases: { 'code-review': { rounds: { low: 0 }, targets: { low: 2 } } } };
  const result = reviewMachine.step(reviewMachine.initial(), started({ config }));
  assert.equal(result.state.tag, 'skipped');
  assert.deepEqual(result.effects, []);
  assert.deepEqual(reviewMachine.project(result.state).data, { outcome: 'skipped', summary: 'review skipped (rounds 0)' });
});

test('an active review phase with zero resolved reviewers fails; rounds zero still skips', () => {
  const none = { ...CONFIG, 'read-delegates': {} };
  assert.equal(play(reviewMachine, [started({ config: none })]).at(-1)?.at, 'review › failed');
  const skip = { ...none, phases: { 'code-review': { rounds: { low: 0 }, targets: { low: 1 } } } };
  assert.equal(play(reviewMachine, [started({ config: skip })]).at(-1)?.at, 'review › skipped');
});

for (const coverage of ['failed', 'missing', 'clean'] as const) test(`rewrite SC1 responsible reviewer ${coverage} controls omission`, () => {
  const events = [started(), prepared(1), waveDone(1, [finding('R1-F001')]),
    { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'reject', reason: 'by design' } } } as Event, prepared(2),
    { ...waveDone(2, []), slots: coverage === 'clean' ? rows : [rows[0]!, ...(coverage === 'failed' ? [{ slot: 'agy[0]', state: 'failed', reason: 'timeout' }] : [])] } as Event];
  const { state } = drive(events);
  assert.equal(state.tag, coverage === 'clean' ? 'settled' : 'failed');
  assert.equal('c' in state && state.c.findings[0]?.status, coverage === 'clean' ? 'closed-by-reviewer' : 'pending-rejection');
  if (coverage === 'clean') assert.deepEqual(state.tag === 'settled' && state.exit.rejections, ['R1-F001']);
});

test('rewrite SC1 all-failed review reports coverage failure', () => {
  const { state } = drive([started(), prepared(1), { ...waveDone(1, []), slots: rows.map((row) => ({ ...row, state: 'failed' })) } as Event]);
  assert.equal(state.tag, 'failed');
  assert.match(state.tag === 'failed' ? state.detail : '', /reviewer-coverage/);
});

test('reserve-substitution: reviewers list reflects reserve delegate and failed reflects primary failure', () => {
  const reserveRows = [
    { slot: 'claude[0]', state: 'reserve', by: 'codex[0]', model: 'gpt-5', record: 'claude[0] → codex[0]: api-error: 400', reason: 'api-error: 400' },
  ];
  const { state } = drive([
    started(),
    prepared(1),
    { type: 'WAVE_DONE', effectId: 'review.wave.1', round: 1, slots: reserveRows, findings: [finding('R1-F001', { sources: ['codex[0]'] })] } as Event,
  ]);
  assert.equal(state.tag, 'rule');
  if (!('c' in state)) throw new Error('review context missing');
  const rounds = resolutionRounds(state.c);
  assert.equal(rounds.length, 1);
  assert.deepEqual(rounds[0]?.reviewers, [{ slot: 'codex[0]', model: 'gpt-5' }]);
  assert.deepEqual(rounds[0]?.failed, [{ slot: 'claude[0]', reason: 'api-error: 400' }]);
  const rendered = renderResolutionSection(rounds);
  assert.match(rendered, /- Reviewers: codex\[0\] gpt-5/);
  assert.match(rendered, /- Failed: claude\[0\] \(api-error: 400\)/);
});

test('reviewer-metadata-preservation: model and effort are preserved from wave and roster', () => {
  const metaRows = [
    { slot: 'codex[0]', state: 'success', model: 'gpt-5', effort: 'high' },
  ];
  const { state } = drive([
    started(),
    prepared(1),
    { type: 'WAVE_DONE', effectId: 'review.wave.1', round: 1, slots: metaRows, findings: [] } as Event,
  ]);
  assert.equal(state.tag, 'settled');
  if (!('c' in state)) throw new Error('review context missing');
  const rounds = resolutionRounds(state.c);
  assert.deepEqual(rounds[0]?.reviewers, [{ slot: 'codex[0]', model: 'gpt-5', effort: 'high' }]);
  const rendered = renderResolutionSection(rounds);
  assert.match(rendered, /- Reviewers: codex\[0\] gpt-5 \(high\)/);
});

test('round two scope carries settled rulings', () => {
  const events = [started(), prepared(1), waveDone(1, [
    finding('R1-F001'), finding('R1-F002', { severity: 'CONSIDER', locus: 'src/b.ts:L1' }), finding('R1-F003', { severity: 'CONSIDER', locus: 'src/c.ts:L9' }),
  ]), { type: 'RULINGS', rulings: {
    'R1-F001': { ruling: 'reject', reason: 'by design' },
    'R1-F002': { ruling: 'reject', reason: 'out of scope for this change' },
    'R1-F003': { ruling: 'accept', reason: 'valid gap; report only' },
  } } as Event];
  const { state, effects } = drive(events);
  assert.equal(state.tag, 'prepare');
  const next = effects[0];
  const scope = next?.kind === 'prepare-review' ? next.scope as Record<string, unknown> : {};
  assert.deepEqual((scope['carried'] as { id: string }[]).map((row) => row.id), ['R1-F001']);
  assert.deepEqual(scope['settled'], [
    { id: 'R1-F002', locus: 'src/b.ts:L1', defect: 'defect R1-F002', ruling: 'Rejected', reason: 'out of scope for this change' },
    { id: 'R1-F003', locus: 'src/c.ts:L9', defect: 'defect R1-F003', ruling: 'Accepted', reason: 'valid gap; report only' },
  ]);
});

// SECTION: Change observations and the round cap

const capConfig = (cap: number) => ({ ...CONFIG, phases: { 'code-review': { rounds: { low: cap }, targets: { low: 2 } } } });
const capNotice = (id: string) => ({ id, phase: 'review', pendingId: 'check', beforeHash: 'before', afterHash: `after-${id}`, rawDeltaRef: { version: 1 as const, sha256: 'a'.repeat(64), bytes: 1, path: `recovery-deltas/${id}.json` }, paths: ['src/a.ts'], pathCount: 1, relevance: 'relevant' as const, reason: 'Reviewed content changed.', affectedEvidence: [] });
/** Steps one event; a target check it issues is answered `changed` with `notice` when given, else `unchanged`. */
function stepTarget(from: { state: ReviewState; effects: readonly Effect[] }, event: Event, notice?: ReturnType<typeof capNotice>) {
  const next = reviewMachine.step(from.state, event);
  const check = next.effects.find((effect) => effect.kind === 'check-review-target');
  if (!check) return next;
  return reviewMachine.step(next.state, notice ? { type: 'REVIEW_TARGET_CHECKED', effectId: check.id, manifestPath: `${notice.id}.json`, result: 'changed', notice } : { type: 'REVIEW_TARGET_CHECKED', effectId: check.id, manifestPath: 'same.json', result: 'unchanged' });
}
/** Drives a report review to `rule` while the target changes before the in-flight wave result is consumed. */
function observedRule(cap: number, findings: unknown[] = [finding('R1-F001')]) {
  let driven: { state: ReviewState; effects: readonly Effect[] } = reviewMachine.step(reviewMachine.initial(), started({ config: capConfig(cap) }));
  driven = stepTarget(driven, { type: 'REVIEW_PREPARED', effectId: 'review.prepare-review.1', scope: { manifestPath: 'm1.json' }, promptPaths: { 'codex[0]': 'p0', 'agy[0]': 'p1' } });
  assert.equal(driven.state.tag, 'wave');
  const wave = driven.effects.find((effect) => effect.kind === 'wave-start')!;
  driven = stepTarget(driven, { type: 'WAVE_DONE', effectId: wave.id, round: 1, slots: rows, findings: findings as never }, capNotice('second'));
  return driven;
}

test('review-cap: observations spend no round and cap preserves findings', () => {
  const ruled = observedRule(1, [finding('R1-F001', { severity: 'CONSIDER' })]);
  assert.equal(ruled.state.tag, 'rule'); if (ruled.state.tag !== 'rule') return;
  assert.equal(ruled.state.c.round, 1);
  assert.equal(ruled.state.c.rounds.length, 1);
  assert.deepEqual(ruled.state.c.observations?.map((row) => row.id), ['second']);
  const use = { type: 'REVIEW_USE', observationId: 'second', afterHash: 'after-second', action: 'targeted', rationale: 'Recheck the edited file', paths: ['src/a.ts'] } as const;
  assert.match(reviewMachine.validate!(ruled.state, use) ?? '', /cap/);
  assert.equal(reviewMachine.validate!(ruled.state, { ...use, action: 'reuse' }), null);
  const offered = stepTarget(ruled, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' } } });
  assert.equal(offered.state.tag, 'decide-opt-in'); if (offered.state.tag !== 'decide-opt-in') return;
  const settled = stepTarget(offered, { type: 'DECISION', kind: 'opt-in', answer: [] });
  assert.equal(settled.state.tag, 'settled'); if (settled.state.tag !== 'settled') return;
  assert.equal(settled.state.c.round, 1);
  const kept = settled.state.c.findings.find((row) => row.id === 'R1-F001');
  assert.equal(kept?.status, 'accepted');
  assert.equal(kept?.revision, 'm1.json', 'the finding stays bound to the revision its wave reviewed');
  const coverage = (reviewMachine.project(settled.state).data['completion'] as Record<string, unknown>)['coverage'] as Record<string, unknown>;
  assert.deepEqual((coverage['unassessed'] as { id: string }[]).map((row) => row.id), ['second']);
});

for (const action of ['targeted', 'full'] as const) test(`review-cap: selected ${action} review spends a round only when launched`, () => {
  const ruled = observedRule(3, [finding('R1-F001', { severity: 'CONSIDER' })]);
  if (ruled.state.tag !== 'rule') throw new Error('rule');
  const selected = reviewMachine.step(ruled.state, { type: 'REVIEW_USE', observationId: 'second', afterHash: 'after-second', action, rationale: 'Edited lines need review', paths: ['src/a.ts'] });
  assert.equal(selected.state.tag, 'rule'); assert.deepEqual(selected.effects, []);
  if (selected.state.tag !== 'rule') return;
  assert.equal(selected.state.c.round, 1);
  assert.match(reviewMachine.validate!(selected.state, { type: 'REVIEW_USE', observationId: 'second', afterHash: 'after-second', action: 'full', rationale: 'Again' }) ?? '', /already/);
  const launched = stepTarget(selected, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' } } });
  assert.equal(launched.state.tag, 'prepare'); if (launched.state.tag !== 'prepare') return;
  assert.equal(launched.state.c.round, 1);
  const effect = launched.effects.find((row) => row.kind === 'prepare-review');
  assert.ok(effect?.kind === 'prepare-review');
  assert.equal(effect.scope['scope'], action === 'full' ? 'full' : 'delta');
  assert.ok((effect.scope['affectedPaths'] as string[]).includes('src/a.ts'));
  assert.equal(launched.state.c.findings.find((row) => row.id === 'R1-F001')?.status, 'accepted', 'prior rulings stay');
  assert.equal(launched.state.c.observations?.find((row) => row.id === 'second')?.use?.launchedRound, undefined);
  const wave = stepTarget(launched, { type: 'REVIEW_PREPARED', effectId: effect.id, scope: { empty: false }, promptPaths: { 'codex[0]': 'selected.prompt.md' } });
  assert.equal(wave.state.tag, 'wave'); if (wave.state.tag !== 'wave') return;
  assert.equal(wave.state.c.round, 2);
  assert.equal(wave.state.c.requested, undefined);
  assert.equal(wave.state.c.observations?.find((row) => row.id === 'second')?.use?.launchedRound, 2);
});

for (const action of ['targeted', 'full'] as const) for (const outcome of ['failed', 'empty'] as const) test(`review-cap: ${action} preparation ${outcome} retains an unlaunched selection`, () => {
  const ruled = observedRule(3, [finding('R1-F001', { severity: 'CONSIDER' })]);
  const selected = reviewMachine.step(ruled.state, { type: 'REVIEW_USE', observationId: 'second', afterHash: 'after-second', action, rationale: 'Review selected code', paths: ['src/a.ts'] });
  const preparing = stepTarget(selected, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' } } });
  const effect = preparing.effects.find((item) => item.kind === 'prepare-review')!;
  const result = stepTarget(preparing, outcome === 'failed' ? { type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: 'Preparation failed' } : { type: 'REVIEW_PREPARED', effectId: effect.id, scope: { empty: true }, promptPaths: {} });
  assert.equal(result.state.tag, outcome);
  assert.ok('c' in result.state); if (!('c' in result.state)) return;
  assert.equal(result.state.c.round, 1);
  assert.equal(result.state.c.requested, 'second');
  assert.equal(result.state.c.observations![0]!.use?.launchedRound, undefined);
  assert.equal(result.state.c.rounds.length, 1);
});

for (const outcome of ['failed', 'empty'] as const) test(`review-cap: first preparation ${outcome} spends no round`, () => {
  const preparing = reviewMachine.step(reviewMachine.initial(), started());
  const effect = preparing.effects[0]!;
  const result = reviewMachine.step(preparing.state, outcome === 'failed' ? { type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: 'Preparation failed' } : { type: 'REVIEW_PREPARED', effectId: effect.id, scope: { empty: true }, promptPaths: {} });
  assert.equal(result.state.tag, outcome);
  assert.ok('c' in result.state && result.state.c.round === 0);
});
