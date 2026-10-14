import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effect, Event } from '../../../skills/dispatch/scripts/core/types.ts';
import type { ParsedPlan } from '../../../skills/dispatch/scripts/domain/types.ts';
import { generatedCommands, commandMappings } from '../../../skills/dispatch/scripts/machines/implement-types.ts';
import { initialImplement, stepImplement, validateImplement } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { approvalState, host } from './fixtures/implement-recovery.ts';
import { launch, pump, start, submit } from './fixtures/implement-tasks.ts';

test('ordinary evidence completes only when every required criterion passes', () => {
  for (const outcome of ['pass', 'fail', 'blocked', 'unknown', ''] as const) {
    const c = approvalState().c;
    const state = { tag: 'evidence' as const, c, purpose: 'final' as const, ids: ['SC1'], verify: [] };
    const result = host(state, { type: 'EVIDENCE', criteria: { SC1: { outcome, evidence: 'observed behavior' } } });
    assert.equal(result.state.tag, outcome === 'pass' ? 'complete' : 'evidence', outcome || 'empty');
  }
});

test('user-waived evidence completes and reports the waiver as a limitation', () => {
  const c = approvalState().c;
  const state = { tag: 'evidence' as const, c, purpose: 'final' as const, ids: ['SC1'], verify: [] };
  const waived = { type: 'EVIDENCE', criteria: { SC1: { outcome: 'waived', evidence: 'deferred to post-delivery smoke run' } } } as const;
  assert.equal(host(state, waived).state.tag, 'evidence');
  const result = host(state, { ...waived, waiver: { by: 'user', quote: 'waive SC1' } });
  assert.equal(result.state.tag, 'complete');
  assert.deepEqual(result.state.tag === 'complete' && result.state.c.evidence['SC1']?.['waiver'], { by: 'user', quote: 'waive SC1' });
});

type Fingerprint ={ head: string; index: string; worktree: string };
type Point = { state: ReturnType<typeof initialImplement>; effect: Effect; fingerprint: Fingerprint };
type ReviewPoint = Point & { effects: readonly Effect[] };
const FP: Fingerprint = { head: 'head', index: 'index', worktree: 'tree' };
const PLAN: ParsedPlan = {
  title: 'Generated feature', box: { 'TL;DR': 'Deliver feature' }, keyDecisions: [],
  criteria: [
    { id: 'SC1', title: 'Source behavior works', line: 1, changes: ['src/a.ts'], verify: [{ command: 'node --test tests/a.test.ts', final: false }], evidence: 'verify', preExisting: false, redException: null, testRationale: null, review: null, enforcementInfeasibility: null, retain: 'durable', coveredBy: null },
    { id: 'SC2', title: 'Generated output works', line: 2, changes: ['src/b.ts', 'src/generated.ts'], verify: [{ command: 'node --test tests/b.test.ts', final: true }], evidence: 'verify', preExisting: false, redException: null, testRationale: null, review: null, enforcementInfeasibility: null, retain: 'durable', coveredBy: null },
  ],
  changes: [
    { action: 'MODIFY', path: 'src/a.ts', note: 'Source change', command: null, line: 1 },
    { action: 'MODIFY', path: 'src/b.ts', note: 'Final-only source', command: null, line: 2 },
    { action: 'GENERATED', path: 'src/generated.ts', note: 'Generated output', command: 'node scripts/gen.mjs', line: 3 },
  ],
  verification: { automated: ['node --test tests/a.test.ts', 'node --test tests/b.test.ts'], none: null, manual: [] },
  tasks: [{ id: 'T1', title: 'Feature', summary: 'Deliver feature', line: 1, prerequisites: [], criteria: ['SC1', 'SC2'], paths: ['src/a.ts', 'src/b.ts'], generated: [], overlaps: [] }], seams: [], warnings: [], finalCommands: ['node --test tests/b.test.ts'], traceability: null, governedText: '# Generated feature', planIds: ['SC1', 'SC2'], sharedContext: '# Generated feature',
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
  // A fixed durable file is observed at the review boundary before generation.
  if (result.state.tag === 'task-checkout') {
    const observe = getEffect(result.effects, 'checkout');
    const files = observe.kind === 'checkout' ? (observe.input as Record<string, unknown>)['observe'] as string[] : [];
    result = step(result.state, { type: 'CHECKOUT_DONE', effectId: observe.id, op: 'trim', result: { observed: Object.fromEntries(files.map((file) => [file, `blob-${file}`])) } });
  }
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

// SECTION: SC11 — transient evidence and trim

type CriterionSpec = { id: string; changes: string[]; verify: { command: string; final: boolean }[]; retain?: 'durable' | 'transient' };
/** One task owning every path; SC1 is transient by default and covered by durable SC2. */
function transientPlan(specs: CriterionSpec[], finalCommands: string[] = []): ParsedPlan {
  const paths = [...new Set(specs.flatMap((row) => row.changes))].sort();
  return {
    title: 'Transient feature', box: { 'TL;DR': 'Deliver feature' }, keyDecisions: [], seams: [], warnings: [], traceability: null, governedText: '# Transient feature', sharedContext: '# Transient feature', planIds: specs.map((row) => row.id).sort(),
    criteria: specs.map((row, index) => ({ id: row.id, title: row.id, line: index + 1, changes: row.changes, verify: row.verify, evidence: 'verify', preExisting: false, redException: null, testRationale: null, review: null, enforcementInfeasibility: null, retain: row.retain ?? 'durable', coveredBy: row.retain === 'transient' ? 'SC2' : null })),
    changes: paths.map((path, index) => ({ action: 'MODIFY', path, note: path, command: null, line: index + 1 })),
    verification: { automated: [], none: 'criterion commands', manual: [] }, finalCommands,
    tasks: [{ id: 'T1', title: 'Feature', summary: 'Deliver feature', line: 1, prerequisites: [], criteria: specs.map((row) => row.id), paths, generated: [], overlaps: [] }],
  };
}
const SC1 = (verify = [{ command: 'node --test tests/a.test.ts', final: false }]): CriterionSpec => ({ id: 'SC1', changes: ['src/t.ts', 'tests/a.test.ts'], verify, retain: 'transient' });
const SC2 = (command = 'node --test tests/b.test.ts'): CriterionSpec => ({ id: 'SC2', changes: ['src/a.ts', 'tests/b.test.ts'], verify: [{ command, final: false }] });
const BASIC = transientPlan([SC1(), SC2()]);

/** Delivers T1 with review skipped and pumps through trim and final verification. */
function delivered(plan: ParsedPlan, reviewRounds = 0) {
  const sim = { plan, reviewRounds };
  const { result, trace } = start(1, sim);
  return { result: submit(launch(result, sim, trace), 'T1', sim, trace), trace };
}
const trims = (trace: { effects: Effect[] }) => trace.effects.flatMap((effect) => effect.kind === 'checkout' && effect.op === 'trim' ? [effect.input as Record<string, unknown>] : []);
const finalCommands = (trace: { effects: Effect[] }) => trace.effects.flatMap((effect) => effect.kind === 'verify' && effect.purpose === 'final' ? [effect.commands.map((row) => String(row['command']))] : []).at(-1);

test('transient evidence survives later mutation', () => {
  const { result } = delivered(BASIC);
  assert.equal(result.state.tag, 'evidence');
  if (result.state.tag !== 'evidence') return;
  const sc1 = result.state.c.evidence['SC1'];
  assert.equal(sc1?.['evidence'], 'verified at i-T1');
  assert.ok((result.state.c.criterionMutation['SC1'] ?? 0) > (sc1?.mutationEpoch ?? 0), 'delivery mutated SC1 paths after its evidence');
  assert.deepEqual(result.state.ids, ['SC2']);
});

test('trim excludes transient commands from final verify', () => {
  const { trace } = delivered(BASIC);
  assert.deepEqual(trims(trace).map((input) => input['allowed']), [['tests/a.test.ts']]);
  assert.deepEqual(finalCommands(trace), ['node --test tests/b.test.ts']);
});

test('rejects fix deleting durable test', () => {
  const { result } = delivered(BASIC, 1);
  assert.equal(result.state.tag, 'code-review');
  const fix = (file: string) => ({ type: 'FIXES_APPLIED', clusters: [{ affectedPaths: [file], deletedPaths: [file] }] }) as never;
  assert.match(validateImplement(result.state, fix('tests/b.test.ts')) ?? '', /may not delete files of durable criteria: tests\/b\.test\.ts/);
  assert.doesNotMatch(validateImplement(result.state, fix('tests/a.test.ts')) ?? '', /durable/);
});

test('trim keeps production path of transient criterion', () => {
  const { trace } = delivered(BASIC);
  const [input] = trims(trace);
  assert.ok(!(input?.['allowed'] as string[]).includes('src/t.ts'));
  assert.deepEqual((input?.['files'] as { path: string }[]).map((row) => row.path), ['tests/a.test.ts']);
});

test('shared transient durable command is kept', () => {
  const shared = 'npm run test:unit';
  const { trace } = delivered(transientPlan([SC1([{ command: shared, final: false }]), SC2(shared)]));
  assert.deepEqual(trims(trace).map((input) => input['allowed']), [['tests/a.test.ts']]);
  assert.deepEqual(finalCommands(trace), [shared]);
});

test('shared transient final command is kept', () => {
  const { trace } = delivered(transientPlan([SC1([{ command: 'node --test tests/a.test.ts', final: false }, { command: 'npm test', final: true }]), SC2()], ['npm test']));
  assert.deepEqual(trims(trace).map((input) => input['allowed']), [['tests/a.test.ts']]);
  assert.deepEqual(finalCommands(trace), ['node --test tests/b.test.ts', 'npm test']);
});

test('trim rejected when retained command names trimmed file', () => {
  const { result, trace } = delivered(transientPlan([SC1(), SC2('node --test tests/a.test.ts tests/b.test.ts')]));
  assert.equal(result.state.tag, 'failure');
  if (result.state.tag !== 'failure') return;
  assert.match(result.state.reason, /retained commands name trimmed files tests\/a\.test\.ts/);
  assert.deepEqual(trims(trace), []);
});

/** Applies one review fix, settles review, and answers the post-review snapshot with `changed`. */
function afterReviewFix(plan: ParsedPlan, fixed: string, changed: string[]) {
  const { result, trace } = delivered(plan, 1);
  assert.equal(result.state.tag, 'code-review');
  const prepare = getEffect(result.effects, 'prepare-review');
  let state = step(result.state, { type: 'FIXES_APPLIED', clusters: [{ clusterId: 'C-1', status: 'applied', affectedPaths: [fixed] }] } as never).state;
  let next = step(state, { type: 'REVIEW_PREPARED', effectId: prepare.id, scope: { empty: true }, promptPaths: {} });
  assert.equal(next.state.tag, 'post-review-snapshot');
  next = step(next.state, { type: 'SNAPSHOT', effectId: getEffect(next.effects, 'snapshot').id, fingerprint: { head: 'h', index: 'i', worktree: 'fixed' }, diff: { paths: changed } });
  assert.equal(next.state.tag, 'task-checkout');
  const observe = getEffect(next.effects, 'checkout');
  return { next, observe: observe as Extract<Effect, { kind: 'checkout' }>, trace };
}

test('fix deleting durable test fails at observed boundary', () => {
  const { next, observe } = afterReviewFix(BASIC, 'tests/b.test.ts', ['tests/b.test.ts']);
  assert.deepEqual((observe.input as Record<string, unknown>)['observe'], ['tests/b.test.ts']);
  const result = step(next.state, { type: 'CHECKOUT_DONE', effectId: observe.id, op: 'trim', result: { observed: { 'tests/b.test.ts': null } } });
  assert.equal(result.state.tag, 'failure-snapshot');
  if (result.state.tag === 'failure-snapshot') assert.match(result.state.reason, /deleted files of durable criteria: tests\/b\.test\.ts/);
});

test('trim binds review-fixed transient test', () => {
  const { next, observe, trace } = afterReviewFix(BASIC, 'tests/a.test.ts', ['tests/a.test.ts']);
  assert.deepEqual((observe.input as Record<string, unknown>)['observe'], ['tests/a.test.ts']);
  const result = pump(step(next.state, { type: 'CHECKOUT_DONE', effectId: observe.id, op: 'trim', result: { observed: { 'tests/a.test.ts': 'blob-fixed' } } }), { plan: BASIC, reviewRounds: 1 }, trace);
  assert.equal(result.state.tag, 'evidence');
  assert.deepEqual(trims(trace).filter((input) => input['files']).map((input) => input['files']), [[{ path: 'tests/a.test.ts', hash: 'blob-fixed' }]]);
});

// SECTION: Orchestrator evidence authority

const OBSERVATION = { id: 'obs-1', afterHash: 'after-1', beforeHash: 'before-1', phase: 'approval', pendingId: 'DECISION', rawDeltaRef: { version: 1 as const, sha256: 'c'.repeat(64), bytes: 20, path: 'recovery-deltas/c.json' }, paths: ['README.md'], pathCount: 1, suggestedRelevance: 'unknown' as const, reason: 'Dependency coverage is incomplete.', suggestedEvidence: ['SC1'] };
const passed = (c: ReturnType<typeof approvalState>['c']) => ({ id: 'SC1', outcome: 'pass' as const, evidence: 'checked earlier', planHash: c.planHash!, mutationEpoch: 0, source: 'verify', redProvenance: 'not-required' as const });
function accepted() {
  const c0 = approvalState().c;
  const T1 = { ...c0.tasks['T1'] ?? { id: 'T1', signature: '', input: null, worktree: null, handle: null, baseline: null, preserveDraft: false, modelIndex: 0, brief: null, redRows: [], reason: null, failures: 0 }, status: 'accepted' as const, attempt: 2, candidate: 'candidate-1', integrated: 'integrated-1' };
  return { ...c0, phase: 'tasks' as const, tasks: { T1 } as typeof c0.tasks, integration: { path: 'integration', base: 'base', head: 'integrated-1', links: [], ignored: [] }, evidence: { SC1: passed(c0) },
    records: { check: { command: 'check', exit: 0, logPath: 'check.log', failureId: null, failedTests: [], diagnostic: '', loadError: false, inputFingerprint: 'input', mutationEpoch: 0, status: 'pass' as const } }, observations: [OBSERVATION] };
}
const bind = { observationId: 'obs-1', afterHash: 'after-1', rationale: 'README edits cannot affect the SC1 check.' };

test('authority-evidence: reasoned reuse retains evidence despite incomplete dependencies', () => {
  const c = accepted();
  const state = { tag: 'evidence' as const, c: { ...c, phase: 'delivered' as const }, purpose: 'final' as const, ids: [] as string[], verify: [] };
  const result = host(state, { type: 'EVIDENCE', criteria: {}, changeDispositions: [{ ...bind, retain: ['SC1'] }] });
  assert.ok('c' in result.state && result.state.c);
  if (!('c' in result.state) || !result.state.c) return;
  assert.deepEqual(result.state.c.evidence['SC1'], c.evidence.SC1);
  assert.equal(result.state.c.observations?.[0]?.disposition?.rationale, bind.rationale);
  assert.deepEqual(result.state.c.tasks, c.tasks);
});

test('authority-evidence: refresh preserves the accepted candidate', () => {
  const c = accepted();
  const state = { tag: 'evidence' as const, c: { ...c, phase: 'delivered' as const }, purpose: 'final' as const, ids: ['SC1'], verify: [] };
  const result = host(state, { type: 'EVIDENCE', criteria: { SC1: { outcome: 'pass', evidence: 'reused' } }, changeDispositions: [{ ...bind, refresh: ['SC1'] }] });
  assert.equal(result.state.tag, 'final-verify');
  if (result.state.tag !== 'final-verify') return;
  const effect = result.effects[0];
  assert.equal(effect?.kind, 'verify');
  assert.deepEqual(result.state.c.tasks, c.tasks);
  assert.deepEqual(result.state.c.integration, c.integration);
  assert.equal(result.state.c.evidence['SC1'], undefined);
  assert.deepEqual(result.state.c.evidenceHistory, [c.evidence.SC1]);
  assert.deepEqual(result.state.c.obligations?.['SC1']?.tasks, ['T1']);
  assert.equal(result.state.c.records['check'], undefined);
});

test('authority-evidence: a pending obligation clears only with fresh evidence', () => {
  const c = accepted();
  const state = { tag: 'evidence' as const, c: { ...c, phase: 'delivered' as const, evidence: {}, obligations: { SC1: { id: 'SC1', observationId: 'obs-1', rationale: 'recheck', tasks: ['T1'], mutationEpoch: 1 } } }, purpose: 'final' as const, ids: ['SC1'], verify: [] };
  const result = host(state, { type: 'EVIDENCE', criteria: { SC1: { outcome: 'pass', evidence: 'fresh run' } } });
  assert.equal(result.state.tag, 'complete');
  if (result.state.tag === 'complete') assert.deepEqual(result.state.c.obligations, {});
});

test('authority-evidence: reuse cannot pass a failed required gate', () => {
  const base = approvalState().c;
  const failing = { ...base.records, check: { command: 'check', exit: 1, logPath: 'check.log', failureId: 'f', failedTests: ['test:a'], diagnostic: 'failed', loadError: false, inputFingerprint: 'input', mutationEpoch: 0, status: 'regression' as const } };
  const state = { tag: 'failure' as const, c: { ...base, phase: 'delivered' as const, records: failing, evidence: { SC1: passed(base) }, observations: [OBSERVATION] }, reason: 'Final verification failed: check', changedPaths: [] };
  const event = { type: 'DECISION' as const, kind: 'failure' as const, answer: { by: 'orchestrator', action: 'retry', rationale: 'retry' }, changeDispositions: [{ ...bind, retain: ['SC1'] }] };
  assert.match(validateImplement(state, event) ?? '', /failed required checks/);
  assert.deepEqual(stepImplement(state, event).state, state);
});
