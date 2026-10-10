import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effect, Event, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { reviewMachine, type ReviewState } from '../../../skills/dispatch/scripts/machines/review.ts';
import { rootMachine, type RootState } from '../../../skills/dispatch/scripts/machines/root.ts';
import { executionDelta } from '../../../skills/dispatch/scripts/domain/execution-config.ts';

const CONFIG = {
  'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } },
  phases: { 'code-review': { rounds: { low: 2 }, targets: { low: 1 } }, 'plan-review': { rounds: { low: 2 }, targets: { low: 1 } } },
};
const started = (over: Partial<RunStartedEvent> = {}): RunStartedEvent => ({
  type: 'RUN_STARTED', verb: 'review', argument: '', level: 'low', levelSource: 'explicit', pins: null, fix: true,
  orchestrator: 'claude', orchestratorModel: null, overrides: {}, config: CONFIG, repo: {}, ...over,
});
const finding = (id: string, over: Record<string, unknown> = {}) => ({
  id, severity: 'MUST', category: 'correctness', locus: `src/${id}.ts:L3`, defect: `defect ${id}`, requiredChange: 'fix', sources: ['codex[0]'], scope: 'in', ...over,
});
const prepared = (n: number): Event => ({ type: 'REVIEW_PREPARED', effectId: `review.prepare-review.${n}`, scope: {}, promptPaths: { 'codex[0]': 'p0' } });
const waveDone = (n: number, findings: unknown[]): Event => ({ type: 'WAVE_DONE', effectId: `review.wave.${n}`, round: n, slots: [{ slot: 'codex[0]', state: 'success' }], findings: findings as never });
const accept = (...ids: string[]): Event => ({ type: 'RULINGS', rulings: Object.fromEntries(ids.map((id) => [id, { ruling: 'accept' }])) });
const verified = (n: number, exit = 0): Event => ({ type: 'VERIFY_DONE', effectId: `review.verify.${n}`, purpose: 'fix-verify', results: exit ? [{ command: 'npm test', exit, logPath: 'l.log' }] : [], fingerprint: {} });

function drive(events: readonly Event[], from: ReviewState = reviewMachine.initial()): { state: ReviewState; effects: Effect[] } {
  let state = from;
  const effects: Effect[] = [];
  for (const event of events) { const result = reviewMachine.step(state, event); state = result.state; effects.push(...result.effects); }
  return { state, effects };
}
const applied = (state: ReviewState): Event => ({ type: 'FIXES_APPLIED', clusters: state.tag === 'fix' ? state.clusters.map((cluster) => ({ clusterId: cluster.clusterId })) : [] });

const freshFix = (kind: 'code' | 'plan' = 'code') => drive([started({ argument: kind === 'plan' ? 'x.plan.md' : '', overrides: { kind } }), prepared(1), waveDone(1, [finding('R1-F001')]), accept('R1-F001')]).state;
const failApply = (state: ReviewState): Event => ({ type: 'FIXES_APPLIED', clusters: state.tag === 'fix' ? state.clusters.map((cluster) => ({ clusterId: cluster.clusterId, status: 'failed' })) : [] });

test('bounded-recovery: failed applies consume all three attempts and retain findings', () => {
  let state = freshFix();
  for (const budget of [3, 2, 1]) {
    assert.equal(state.tag === 'fix' && state.clusters[0]?.attemptBudget, budget);
    state = drive([failApply(state)], state).state;
  }
  assert.equal(state.tag, 'failed');
  assert.match(String(reviewMachine.project(state).data['summary']), /fix-attempts-exhausted.*R1-F001/);
  assert.equal('c' in state && state.c.findings[0]?.status, 'accepted');
});

test('bounded-recovery: code and artifact verification failures exhaust without claiming fixed', () => {
  for (const kind of ['code', 'plan'] as const) {
    let state = freshFix(kind);
    for (let n = 1; n <= 3; n++) {
      state = drive([applied(state)], state).state;
      assert.equal('c' in state && state.c.findings[0]?.status, 'accepted');
      state = drive([kind === 'code' ? verified(n, 1) : { type: 'ARTIFACT_PARSED', effectId: `review.parse-artifact.${n}`, kind: 'plan', hash: 'h', parsed: {}, defects: [{ code: 'x', message: 'bad' }] }], state).state;
    }
    assert.equal(state.tag, 'failed');
    assert.equal('c' in state && state.c.fixes.length, 0);
  }
});

test('bounded-recovery: mixed receipts verify successes once and retry only failed siblings', () => {
  const fix = drive([started(), prepared(1), waveDone(1, [finding('R1-F001'), finding('R1-F002', { locus: 'src/R1-F001.ts:L4' })]), accept('R1-F001', 'R1-F002')]).state;
  assert.equal(fix.tag, 'fix');
  if (fix.tag !== 'fix') return;
  const events: Event[] = [{ type: 'FIXES_APPLIED', clusters: fix.clusters.map((cluster, i) => ({ clusterId: cluster.clusterId, status: i ? 'failed' : 'applied' })) }, verified(1)];
  let state = drive(events, fix).state;
  assert.equal(state.tag, 'fix');
  assert.deepEqual(state.tag === 'fix' && state.clusters.flatMap((c) => c.findingIds), ['R1-F002']);
  assert.equal('c' in state && state.c.findings[0]?.status, 'fixed');
  const history = [...events];
  for (let n = 0; n < 2; n++) { const event = failApply(state); history.push(event); state = drive([event], state).state; }
  assert.equal(state.tag, 'failed');
  assert.equal('c' in state && state.c.findings[0]?.status, 'fixed');
  assert.deepEqual(drive(history, fix).state, state);
});

test('fix receipt: a withdrawn finding is recorded as a user rejection and its cluster sibling as fixed', () => {
  const fix = drive([started(), prepared(1), waveDone(1, [finding('R1-F001'), finding('R1-F002')]), accept('R1-F001', 'R1-F002')]).state;
  assert.equal(fix.tag === 'fix' && fix.clusters.length, 1);
  if (fix.tag !== 'fix') return;
  const clusterId = fix.clusters[0]!.clusterId;
  const bad = drive([{ type: 'FIXES_APPLIED', clusters: [{ clusterId, status: 'failed', withdrawn: [{ findingId: 'R1-F002', quote: 'keep it' }] }] }], fix).state;
  assert.deepEqual(bad, fix, 'withdrawal requires an applied cluster');
  assert.deepEqual(drive([{ type: 'FIXES_APPLIED', clusters: [{ clusterId, withdrawn: [{ findingId: 'R1-F009', quote: 'x' }] }] }], fix).state, fix);
  assert.deepEqual(drive([{ type: 'FIXES_APPLIED', clusters: [{ clusterId, withdrawn: [{ findingId: 'R1-F002', quote: ' ' }] }] }], fix).state, fix);
  const state = drive([{ type: 'FIXES_APPLIED', clusters: [{ clusterId, status: 'applied', withdrawn: [{ findingId: 'R1-F002', quote: 'Go with recommended instead' }] }] }, verified(1)], fix).state;
  const byId = Object.fromEntries('c' in state ? state.c.findings.map((row) => [row.id, row]) : []);
  assert.equal(byId['R1-F001']?.status, 'fixed');
  assert.equal(byId['R1-F002']?.status, 'rejected');
  assert.equal(byId['R1-F002']?.resolution, 'user: Go with recommended instead');
  assert.ok('c' in state && !state.c.fixes.some((row) => row.id === 'R1-F002'));
});

test('fix receipt: a withdrawn finding stays rejected through a failed verification and retry', () => {
  const fix = drive([started(), prepared(1), waveDone(1, [finding('R1-F001'), finding('R1-F002')]), accept('R1-F001', 'R1-F002')]).state;
  if (fix.tag !== 'fix') return assert.fail('fix');
  const clusterId = fix.clusters[0]!.clusterId;
  let state = drive([{ type: 'FIXES_APPLIED', clusters: [{ clusterId, withdrawn: [{ findingId: 'R1-F002', quote: 'Drop it' }] }] }, verified(1, 1)], fix).state;
  assert.deepEqual(state.tag === 'fix' && state.clusters.flatMap((c) => c.members.map((m) => m.id)), ['R1-F001']);
  state = drive([applied(state), verified(2)], state).state;
  const byId = Object.fromEntries('c' in state ? state.c.findings.map((row) => [row.id, row]) : []);
  assert.equal(byId['R1-F001']?.status, 'fixed');
  assert.equal(byId['R1-F002']?.status, 'rejected');
  assert.ok('c' in state && !state.c.fixes.some((row) => row.id === 'R1-F002'));
});

test('bounded-recovery: duplicate and unknown-status receipts are rejected', () => {
  const state = freshFix();
  const receipt = applied(state) as Extract<Event, { type: 'FIXES_APPLIED' }>;
  assert.match(reviewMachine.validate?.(state, { ...receipt, clusters: [...receipt.clusters, ...receipt.clusters] }) ?? '', /duplicate/);
  assert.match(reviewMachine.validate?.(state, { ...receipt, clusters: receipt.clusters.map((c) => ({ ...c as object, status: 'maybe' })) }) ?? '', /status/);
});

test('bounded-recovery: verification charges applied clusters once and pending failures keep their budget', () => {
  const fix = drive([started(), prepared(1), waveDone(1, [finding('R1-F001'), finding('R1-F002', { locus: 'src/R1-F001.ts:L4' })]), accept('R1-F001', 'R1-F002')]).state;
  if (fix.tag !== 'fix') return assert.fail('expected fix');
  const verify = drive([{ type: 'FIXES_APPLIED', clusters: fix.clusters.map((c, i) => ({ clusterId: c.clusterId, status: i ? 'failed' : 'applied' })) }], fix).state;
  const retry = drive([verified(1, 1)], verify).state;
  assert.equal(retry.tag, 'fix');
  assert.deepEqual(retry.tag === 'fix' && retry.clusters.map((c) => c.attemptBudget), [2, 2]);
});

test('bounded-recovery: selected opt-in exhaustion fails and preserves main-pass fixes', () => {
  const main = freshFix();
  const offered = drive([applied(main), verified(1), prepared(2), waveDone(2, [finding('R2-F001', { scope: 'adjacent', severity: 'CONSIDER' })]), accept('R2-F001')], main).state;
  assert.equal(offered.tag, 'decide-opt-in');
  let state = drive([{ type: 'DECISION', kind: 'opt-in', answer: ['R2-F001'] }], offered).state;
  for (let n = 0; n < 3; n++) state = drive([failApply(state)], state).state;
  assert.equal(state.tag, 'failed');
  assert.equal('c' in state && state.c.findings[0]?.status, 'fixed');
});

test('bounded-recovery: failed prerequisite cannot admit an applied dependent receipt', () => {
  const fix = drive([started(), prepared(1), waveDone(1, [finding('R1-F001'), finding('R1-F002', { fix: { paths: ['b'], dependencies: ['R1-F001'], verification: [] } })]), accept('R1-F001', 'R1-F002')]).state;
  if (fix.tag !== 'fix') return assert.fail('expected fix');
  const event: Event = { type: 'FIXES_APPLIED', clusters: fix.clusters.map((c, i) => ({ clusterId: c.clusterId, status: i ? 'applied' : 'failed' })) };
  assert.match(reviewMachine.validate?.(fix, event) ?? '', /prerequisite.*failed/);
  assert.deepEqual(reviewMachine.step(fix, event).state, fix);
});

test('bounded-recovery: exhaustion names pending work as well as exhausted findings', () => {
  const fix = drive([started(), prepared(1), waveDone(1, [finding('R1-F001'), finding('R1-F002', { locus: 'src/R1-F001.ts:L4' })]), accept('R1-F001', 'R1-F002')]).state;
  if (fix.tag !== 'fix') return assert.fail('expected fix');
  const unequal = { ...fix, clusters: fix.clusters.map((c, i) => ({ ...c, attemptBudget: i ? 3 : 1 })) };
  const done = drive([failApply(unequal)], unequal).state;
  assert.equal(done.tag, 'failed');
  assert.match(String(reviewMachine.project(done).data['summary']), /exhausted.*R1-F001.*pending.*R1-F002/);
});

test('review-report-only-default: report mode records acceptance without fix', () => {
  const { state, effects } = drive([started({ fix: false }), prepared(1), waveDone(1, [finding('R1-F001')]), accept('R1-F001')]);
  assert.equal(state.tag, 'settled');
  assert.equal('c' in state && state.c.findings[0]?.status, 'accepted');
  assert.deepEqual(effects.map((effect) => effect.kind), ['prepare-review', 'wave-start']);
});

test('review-adjacent-follow-ups: only accepted adjacent findings become follow-ups', () => {
  const findings = [finding('R1-F001', { scope: 'adjacent' }), finding('R1-F002', { scope: 'adjacent' })];
  let { state } = drive([started({ fix: false }), prepared(1), waveDone(1, findings),
    { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' }, 'R1-F002': { ruling: 'reject', reason: 'by design' } } } as Event]);
  if (state.tag === 'prepare') state = drive([prepared(2), waveDone(2, [])], state).state;
  assert.equal(state.tag, 'settled');
  const data = reviewMachine.project(state).data['completion'] as { followUps: string[] };
  assert.deepEqual(data.followUps, ['R1-F001 src/R1-F001.ts:L3: defect R1-F001']);
});

test('fix → fix-verify: plan lint defects return to fix, a clean parse moves to the next round', () => {
  const run = started({ argument: 'docs/x.plan.md', overrides: { kind: 'plan' } });
  const fix = drive([run, prepared(1), waveDone(1, [finding('R1-F001', { locus: '§ Scope' })]), accept('R1-F001')]).state;
  assert.equal(reviewMachine.project(fix).at, 'review › fix');
  const verify = drive([applied(fix)], fix);
  assert.deepEqual(verify.effects.map((effect) => effect.kind === 'parse-artifact' && [effect.id, effect.path]), [['review.parse-artifact.1', 'docs/x.plan.md']]);
  const back = drive([{ type: 'ARTIFACT_PARSED', effectId: 'review.parse-artifact.1', kind: 'plan', hash: 'h', parsed: {}, defects: [{ code: 'placeholder', message: 'Plan contains a prose placeholder.' }] }], verify.state).state;
  assert.equal(back.tag, 'fix');
  assert.deepEqual(reviewMachine.project(back).data['defects'], ['Plan contains a prose placeholder.']);
  const next = drive([applied(back), { type: 'ARTIFACT_PARSED', effectId: 'review.parse-artifact.2', kind: 'plan', hash: 'h', parsed: {}, defects: [] }], back);
  assert.equal(next.state.tag, 'prepare');
  assert.equal(next.effects.at(-1)?.id, 'review.prepare-review.2');
});

test('code fix-verify runs the finding verification commands; a red command returns to fix', () => {
  const fix = drive([started(), prepared(1), waveDone(1, [finding('R1-F001', { fix: { paths: ['src/a.ts'], dependencies: [], verification: ['npm test'] } })]), accept('R1-F001')]).state;
  const verify = drive([applied(fix)], fix);
  assert.deepEqual(verify.effects.map((effect) => effect.kind === 'verify' && effect.commands), [[{ command: 'npm test' }]]);
  const red = drive([verified(1, 1)], verify.state).state;
  assert.equal(red.tag, 'fix');
  assert.match(String((reviewMachine.project(red).data['defects'] as string[])[0]), /npm test exited 1 \(l\.log\)/);
});

test('grammar-fix-opt-in / review-consider-opt-in / review-adjacent-follow-ups: one opt-in after settle, applied without another wave', () => {
  const findings = [finding('R1-F001'), finding('R1-F002', { severity: 'SHOULD', scope: 'adjacent' }), finding('R1-F003', { severity: 'CONSIDER' })];
  const fix = drive([started(), prepared(1), waveDone(1, findings), accept('R1-F001', 'R1-F002', 'R1-F003')]).state;
  assert.deepEqual(fix.tag === 'fix' && fix.clusters.flatMap((cluster) => cluster.findingIds), ['R1-F001']);
  const offered = drive([applied(fix), verified(1), prepared(2), waveDone(2, [])], fix).state;
  assert.equal(offered.tag, 'decide-opt-in');
  const frame = reviewMachine.project(offered).data;
  assert.equal(frame['kind'], 'opt-in');
  assert.deepEqual((frame['items'] as { id: string }[]).map((item) => item.id), ['R1-F002', 'R1-F003']);
  assert.match(reviewMachine.validate?.(offered, { type: 'DECISION', kind: 'opt-in', answer: ['R1-F001'] }) ?? '', /R1-F001 was not offered/);
  const chosen = drive([{ type: 'DECISION', kind: 'opt-in', answer: ['R1-F003'] }], offered).state;
  assert.equal(chosen.tag, 'fix');
  const end = drive([applied(chosen), verified(2)], chosen);
  assert.equal(end.state.tag, 'settled');
  assert.ok(!end.effects.some((effect) => effect.kind === 'wave' || effect.kind === 'prepare-review'));
  const data = reviewMachine.project(end.state).data['completion'] as { exitSummary: { fixedUnreviewed: unknown }; followUps: string[] };
  assert.deepEqual(data.followUps, ['R1-F002 src/R1-F002.ts:L3: defect R1-F002']);
  assert.deepEqual(data.exitSummary.fixedUnreviewed, [{ id: 'R1-F003', round: 2 }]);
});

test('settled carries fixedUnreviewed for a fix applied in the last round', () => {
  const config = { ...CONFIG, phases: { 'code-review': { rounds: { low: 1 }, targets: { low: 1 } } } };
  const fix = drive([started({ config }), prepared(1), waveDone(1, [finding('R1-F001', { severity: 'SHOULD' })]), accept('R1-F001')]).state;
  const { state } = drive([applied(fix), verified(1)], fix);
  assert.equal(state.tag, 'settled');
  assert.deepEqual(state.tag === 'settled' && state.exit.fixedUnreviewed, [{ id: 'R1-F001', round: 1 }]);
});

test('review-consider-opt-in: an answered needs-user CONSIDER finding is offered in the opt-in', () => {
  const findings = [finding('R1-F001'), finding('R1-F002', { severity: 'CONSIDER', locus: 'src/b.ts:L1' })];
  const fix = drive([started(), prepared(1), waveDone(1, findings),
    { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' }, 'R1-F002': { ruling: 'needs-user' } } } as Event,
    { type: 'DECISION', kind: 'needs-user', answer: { 'R1-F002': { ruling: 'accept', quote: 'maybe later' } } }]).state;
  assert.equal(fix.tag, 'fix');
  const offered = drive([applied(fix), verified(1), prepared(2), waveDone(2, [])], fix).state;
  assert.equal(offered.tag, 'decide-opt-in');
  assert.deepEqual((reviewMachine.project(offered).data['items'] as { id: string }[]).map((item) => item.id), ['R1-F002']);
});

test('code fix-verify runs the verification carried on the host ruling; a failed cluster stays in fix', () => {
  const fix = drive([started(), prepared(1), waveDone(1, [finding('R1-F001')]),
    { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept', fix: { affectedPaths: ['src/a.ts'], dependsOn: [], verification: ['npm run check'] } } } } as Event]).state;
  const failed = drive([{ type: 'FIXES_APPLIED', clusters: fix.tag === 'fix' ? fix.clusters.map((cluster) => ({ clusterId: cluster.clusterId, status: 'failed', note: 'x' })) : [] }], fix);
  assert.equal(failed.state.tag, 'fix');
  assert.deepEqual(failed.effects, []);
  assert.match(String((reviewMachine.project(failed.state).data['defects'] as string[])[0]), /failed to apply/);
  const verify = drive([applied(failed.state)], failed.state);
  assert.deepEqual(verify.effects.map((effect) => effect.kind === 'verify' && effect.commands), [[{ command: 'npm run check' }]]);
});

// SECTION: Writer briefing

const writers = (low: string, effort: string) => ({ ...CONFIG, 'write-subagents': { claude: { low: { model: low, effort }, high: { model: 'writer-high', effort: 'max' } } } });

test('fix frame carries writer effort', () => {
  const fix = drive([started({ config: writers('writer-low', 'medium') }), prepared(1), waveDone(1, [finding('R1-F001')]), accept('R1-F001')]).state;
  assert.equal(fix.tag, 'fix');
  assert.deepEqual(reviewMachine.project(fix).data['writer'], { models: ['writer-low'], effort: 'medium' });
});

test('fix frame writer follows a config refresh', () => {
  const before = started({ config: writers('writer-low', 'medium') });
  const after = started({ config: writers('writer-refreshed', 'high') });
  const fix = drive([before, prepared(1), waveDone(1, [finding('R1-F001')]), accept('R1-F001')]).state;
  const root: RootState = { tag: 'review', run: { verb: 'review', argument: '', slug: 'x', defaults: before }, child: fix };
  const refreshed = rootMachine.reconfigure?.(root, { type: 'EXECUTION_CONFIG_UPDATED', revision: 1, boundarySeq: 1, delta: executionDelta(before.config, after.config) });
  if (!refreshed || refreshed.tag !== 'review') return assert.fail('expected review root');
  assert.deepEqual(reviewMachine.project(refreshed.child).data['writer'], { models: ['writer-low'], effort: 'medium' }, 'bound until the next prepare');
  const next = drive([applied(refreshed.child), verified(1), prepared(2), waveDone(2, [finding('R2-F001', { locus: 'src/other.ts:L1' })]), accept('R2-F001')], refreshed.child).state;
  assert.equal(next.tag, 'fix');
  assert.deepEqual(reviewMachine.project(next).data['writer'], { models: ['writer-refreshed'], effort: 'high' });
});
