import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effect, Event } from '../../../skills/dispatch/scripts/core/types.ts';
import type { ParsedPlan } from '../../../skills/dispatch/scripts/domain/types.ts';
import { generatedCommands, commandMappings } from '../../../skills/dispatch/scripts/machines/implement-types.ts';
import { initialImplement, stepImplement } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { approvalState, host } from './implement-recovery.test.ts';
import { launch, start, submit } from './implement-tasks.test.ts';

for (const outcome of ['pass', 'fail', 'blocked', 'unknown', ''] as const) test(`rewrite SC1 ordinary evidence ${outcome || 'empty'} cannot falsely complete`, () => {
  const c = approvalState().c;
  const state = { tag: 'evidence' as const, c, purpose: 'final' as const, ids: ['SC1'], verify: [] };
  const result = host(state, { type: 'EVIDENCE', criteria: { SC1: { outcome, evidence: 'observed behavior' } } });
  assert.equal(result.state.tag, outcome === 'pass' ? 'complete' : 'evidence');
});

type Fingerprint = { head: string; index: string; worktree: string };
type Point = { state: ReturnType<typeof initialImplement>; effect: Effect; fingerprint: Fingerprint };
type ReviewPoint = Point & { effects: readonly Effect[] };
const FP: Fingerprint = { head: 'head', index: 'index', worktree: 'tree' };
const PLAN: ParsedPlan = {
  title: 'Generated feature', box: { 'TL;DR': 'Deliver feature' }, keyDecisions: [],
  criteria: [
    { id: 'SC1', title: 'Source behavior works', line: 1, changes: ['src/a.ts'], verify: [{ command: 'node --test tests/a.test.ts', final: false }], evidence: 'verify', preExisting: false, redException: null, testRationale: null, review: null, enforcementInfeasibility: null },
    { id: 'SC2', title: 'Generated output works', line: 2, changes: ['src/b.ts', 'src/generated.ts'], verify: [{ command: 'node --test tests/b.test.ts', final: true }], evidence: 'verify', preExisting: false, redException: null, testRationale: null, review: null, enforcementInfeasibility: null },
  ],
  changes: [
    { action: 'MODIFY', path: 'src/a.ts', note: 'Source change', command: null, line: 1 },
    { action: 'MODIFY', path: 'src/b.ts', note: 'Final-only source', command: null, line: 2 },
    { action: 'GENERATED', path: 'src/generated.ts', note: 'Generated output', command: 'node scripts/gen.mjs', line: 3 },
  ],
  verification: { automated: ['node --test tests/a.test.ts', 'node --test tests/b.test.ts'], none: null, manual: [] },
  tasks: [{ id: 'T1', title: 'Feature', summary: 'Deliver feature', line: 1, prerequisites: [], criteria: ['SC1', 'SC2'], paths: ['src/a.ts', 'src/b.ts'], generated: [] }], finalCommands: ['node --test tests/b.test.ts'], traceability: null, governedText: '# Generated feature',
};
/** Delivers the single task and stops at the code-review prepare effect. */
function afterDelivery(): Point {
  const sim = { plan: PLAN, reviewRounds: 1 };
  let { result, trace } = start(1, sim);
  result = submit(launch(result, sim, trace), 'T1', sim, trace);
  assert.equal(result.state.tag, 'code-review');
  return { state: result.state, effect: getEffect(result.effects, 'prepare-review'), fingerprint: { head: 'h', index: 'i', worktree: 'w' } };
}
function getEffect(effects: readonly Effect[], kind: Effect['kind']): Effect {
  const found = effects.find((item) => item.kind === kind);
  assert.ok(found, `expected ${kind}`);
  return found;
}
const step = (state: ReturnType<typeof initialImplement>, event: Event) => {
  const result = stepImplement(state, event);
  if (result.state.tag !== 'checking-host-event') return result;
  return stepImplement(result.state, { type: 'SNAPSHOT', effectId: result.state.effectId, fingerprint: result.state.c.lastFingerprint ?? FP, diff: { paths: [] } });
};

function throughReview(input: Point, mutate = false): ReviewPoint {
  let state = input.state;
  if (state.tag !== 'code-review') throw new Error('expected code review state');
  if (mutate) state = step(state, { type: 'FIXES_APPLIED', clusters: [{ affectedPaths: ['src/a.ts'] }] }).state;
  let result = step(state, { type: 'REVIEW_PREPARED', effectId: input.effect.id, scope: { empty: true }, promptPaths: {} });
  assert.equal(result.state.tag, 'post-review-snapshot');
  if (result.state.tag !== 'post-review-snapshot') throw new Error('expected post-review snapshot state');
  const snapshot = getEffect(result.effects, 'snapshot');
  const postReviewFp = mutate ? { ...input.fingerprint, worktree: 'post-review' } : input.fingerprint;
  result = step(result.state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: postReviewFp, diff: { paths: mutate ? ['src/a.ts'] : [] } });
  return { state: result.state, effect: result.effects[0] as Effect, effects: result.effects, fingerprint: postReviewFp };
}

test('implement-final-deferral, implement-final-gate-coverage, implement-completion-rules and caller-checkout reruns after delivery', () => {
  assert.deepEqual(commandMappings(PLAN).map((row) => [row.command, row.final]), [['node --test tests/a.test.ts', false], ['node --test tests/b.test.ts', true]]);
  assert.deepEqual(generatedCommands(PLAN), [{ command: 'node scripts/gen.mjs', path: 'src/generated.ts' }]);
  const scoped = afterDelivery();
  let postReview = throughReview(scoped);
  assert.equal(postReview.state.tag, 'generated-verify');
  if (postReview.state.tag !== 'generated-verify') return;
  assert.equal(postReview.effect.kind, 'verify');
  if (postReview.effect.kind !== 'verify') return;
  assert.deepEqual(postReview.effect.commands.map((item) => item['command']), ['node scripts/gen.mjs']);
  let result = step(postReview.state, { type: 'VERIFY_DONE', effectId: postReview.effect.id, purpose: 'generated', results: [{ command: 'node scripts/gen.mjs', exit: 0, logPath: 'generate.log', failedTests: [], failureId: null, diagnostic: '', loadError: false, inputFingerprint: 'generated-input' }], fingerprint: postReview.fingerprint });
  assert.equal(result.state.tag, 'generated-snapshot');
  if (result.state.tag !== 'generated-snapshot') return;
  const snapshot = getEffect(result.effects, 'snapshot');
  result = step(result.state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: postReview.fingerprint, diff: { paths: [] } });
  assert.equal(result.state.tag, 'final-verify');
  if (result.state.tag !== 'final-verify') return;
  const final = getEffect(result.effects, 'verify');
  assert.equal(final.kind, 'verify');
  if (final.kind !== 'verify') return;
  assert.deepEqual(final.commands.map((item) => [item['command'], item['reuse'] !== undefined]), [
    ['node --test tests/a.test.ts', false], ['node --test tests/b.test.ts', false],
  ]);
  result = step(result.state, { type: 'VERIFY_DONE', effectId: final.id, purpose: 'final', results: [
    { command: 'node --test tests/a.test.ts', exit: 0, logPath: 'scope-a.log', failedTests: [], failureId: null, diagnostic: '', loadError: false, inputFingerprint: 'input-a' },
    { command: 'node --test tests/b.test.ts', exit: 0, logPath: 'final-b.log', failedTests: [], failureId: null, diagnostic: '', loadError: false, inputFingerprint: 'input-b' },
  ], fingerprint: postReview.fingerprint });
  assert.equal(result.state.tag, 'evidence');
  if (result.state.tag !== 'evidence') return;
  assert.deepEqual(result.state.ids, ['SC1', 'SC2']);
  result = step(result.state, { type: 'EVIDENCE', criteria: { SC1: { outcome: 'pass', evidence: 'final command passed' }, SC2: { outcome: 'pass', evidence: 'final command passed' } } });
  assert.equal(result.state.tag, 'complete');
});

test('implement-evidence-postdates and implement-generated-rerun: mutations stale evidence and generation runs first', () => {
  const scoped = afterDelivery();
  let postReview = throughReview(scoped, true);
  if (postReview.state.tag !== 'generated-verify') return assert.fail('generated verify should follow review snapshot');
  const generated = getEffect(postReview.effects, 'verify');
  let result = step(postReview.state, { type: 'VERIFY_DONE', effectId: generated.id, purpose: 'generated', results: [{ command: 'node scripts/gen.mjs', exit: 0, logPath: 'generate.log', failedTests: [], failureId: null, diagnostic: '', loadError: false, inputFingerprint: 'generated' }], fingerprint: postReview.fingerprint });
  if (result.state.tag !== 'generated-snapshot') return assert.fail('generated snapshot expected');
  const snapshot = getEffect(result.effects, 'snapshot');
  const afterGenerate = { ...postReview.fingerprint, worktree: 'generated' };
  result = step(result.state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: afterGenerate, diff: { paths: ['src/generated.ts'] } });
  if (result.state.tag !== 'final-verify') return assert.fail('final verification expected');
  const final = getEffect(result.effects, 'verify');
  assert.equal(final.kind, 'verify');
  if (final.kind !== 'verify') return;
  assert.ok(final.commands.every((item) => item['reuse'] === undefined));
  result = step(result.state, { type: 'VERIFY_DONE', effectId: final.id, purpose: 'final', results: [
    { command: 'node --test tests/a.test.ts', exit: 0, logPath: 'final-a.log', failedTests: [], failureId: null, diagnostic: '', loadError: false, inputFingerprint: 'final-a' },
    { command: 'node --test tests/b.test.ts', exit: 0, logPath: 'final-b.log', failedTests: [], failureId: null, diagnostic: '', loadError: false, inputFingerprint: 'final-b' },
  ], fingerprint: afterGenerate });
  assert.equal(result.state.tag, 'evidence');
  if (result.state.tag === 'evidence') assert.deepEqual(result.state.ids, ['SC1', 'SC2']);
});
