import type { Ports } from '../../../skills/dispatch/scripts/core/types.ts';
import { rootMachine } from '../../../skills/dispatch/scripts/machines/root.ts';
import { beginReview, stepReview } from '../../../skills/dispatch/scripts/machines/review.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stepDesign, selectReady, type DesignState } from '../../../skills/dispatch/scripts/machines/design.ts';
import { approval, approveDesignScope, hash, design } from './fixtures/design.ts';
import { beginDesignRevision, stepDesignRevision } from '../../../skills/dispatch/scripts/machines/design-revision.ts';
import { PLAN, FP } from './fixtures/implement-recovery.ts';
import type { ParsedPlan } from '../../../skills/dispatch/scripts/domain/types.ts';
import { started } from './fixtures/design-delivery.ts';

test('prewrite-level: gate sees all increments before checkout', () => {
  const state = started();
  assert.equal(state.tag, 'increment');
  if (state.tag !== 'increment' || !('c' in state.child) || !state.child.c) throw new Error('child');
  assert.deepEqual(state.child.c.designBinding?.governingDesign?.remainingIncrements.map((row) => row.id), ['I01', 'I02']);
  assert.notEqual(state.child.tag, 'task-checkout');
});

test('prewrite-level: approved later-increment expansion is adjudicated before delivery checkout', () => {
  const base = approval('implement').c;
  const c = {
    ...base, design, hash, levelGatePassed: true, completed: ['I01'], ownership: { I01: ['src/a.ts'] },
    approval: { by: 'user' as const, quote: 'Deliver', hash }, baseline: 'a'.repeat(40),
  };
  const working = beginDesignRevision(c, { type: 'REVISE', artifact: 'design', reason: 'Expand the later increment', evidence: 'Its acceptance contract requires the helper.' });
  const authored = stepDesignRevision(working.state, { type: 'AUTHORED', path: working.state.workingPath });
  if (authored.state.tag !== 'parse') throw new Error('parse');
  const revised = { ...design, increments: design.increments.map((row) => row.id === 'I02' ? { ...row, paths: [...row.paths, 'src/extra.ts'] } : row) };
  const proposal = stepDesignRevision({ ...authored.state, afterReview: true }, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: authored.state.effectId, hash: `sha256:${'b'.repeat(64)}`, parsed: revised, defects: [] });
  assert.equal(proposal.state.tag, 'scope-adjudication');
  if (proposal.state.tag !== 'scope-adjudication') return;
  assert.equal(proposal.state.request.source, 'design-revision');
  if (proposal.state.request.source !== 'design-revision') return;
  const requestId = proposal.state.request.requestId;
  assert.deepEqual(proposal.state.request.affectedIncrements, ['I02']);
  assert.ok(proposal.state.request.delta.paths.includes('src/extra.ts'));
  assert.deepEqual(proposal.effects, []);

  const pending = { state: { tag: 'revision' as const, c, child: proposal.state }, effects: [] };
  const resumed = approveDesignScope(pending);
  assert.ok(resumed.state.tag === 'approval' || resumed.state.tag === 'increment');
  assert.ok('c' in resumed.state && resumed.state.c?.scopeAdjustments.some((item) => item.proposal.requestId === requestId));
  assert.equal(resumed.effects.some((effect) => effect.kind === 'checkout' && effect.op === 'task'), false);
});

test('design-increment-selection: priority and prerequisite completion select ready children', () => {
  assert.equal(selectReady({ ...design, increments: [...design.increments].reverse() }, []), 'I01');
  assert.equal(selectReady(design, ['I01']), 'I02');
  assert.equal(selectReady(design, ['I01', 'I02']), null);
});

test('design-implement-delivers-all: two child outcomes retain ownership and use distinct effect paths', () => {
  let state = started();
  const ids: string[] = [];
  for (const increment of ['I01', 'I02']) {
    assert.equal(state.tag, 'increment');
    if (state.tag !== 'increment' || !('c' in state.child) || !state.child.c) throw new Error('child');
    assert.equal(state.increment, increment);
    ids.push(...Object.keys(state.child.c.counters));
    const completed = { ...state, child: { tag: 'complete' as const, c: { ...state.child.c, changedPaths: [`src/${increment === 'I01' ? 'a' : 'b'}.ts`] }, summary: 'Done' } };
    state = stepDesign(completed, { type: 'LOCK_BROKEN', stalePid: 1 }).state;
  }
  assert.equal(state.tag, 'integration');
  assert.deepEqual(state.c.completed, ['I01', 'I02']);
  assert.deepEqual(state.c.ownership, { I01: ['src/a.ts'], I02: ['src/b.ts'] });
  assert.ok(ids.includes('design.i01.implement.snapshot'));
  assert.ok(ids.includes('design.i02.implement.snapshot'));
});
test('bound child baseline derives approval without an approval await', () => {
  let state = started();
  if (state.tag !== 'increment' || !('c' in state.child) || !state.child.c) throw new Error('child');
  const c = { ...state.child.c, levelGatePassed: true };
  const plan = { title: 'First', box: { 'TL;DR': 'First behavior' }, keyDecisions: [], criteria: [], changes: [], verification: { automated: [], none: null, manual: [] }, tasks: [], finalCommands: [], traceability: { Design: 'x.design.md', Revision: hash, Increment: 'I01', Outcome: 'First behavior' }, governedText: '# First', planIds: [], sharedContext: '# First', seams: [], warnings: [] };
  state = { ...state, child: { tag: 'baseline-snapshot', c: { ...c, plan, planHash: hash, startFingerprint: { head: 'h', index: 'i', worktree: 'w' } }, effectId: 'baseline', results: [] } };
  const result = stepDesign(state, { type: 'SNAPSHOT', effectId: 'baseline', fingerprint: { head: 'h', index: 'i', worktree: 'w' }, diff: { paths: [] } });
  assert.equal(result.state.tag, 'increment');
  if (result.state.tag !== 'increment' || !('c' in result.state.child) || !result.state.child.c) throw new Error('child');
  assert.equal(result.state.child.tag, 'task-checkout');
  assert.equal(result.state.child.c.approval?.by, 'design');
  assert.ok(result.state.child.c.designBinding && result.effects.some((effect) => effect.kind === 'checkout' && effect.op === 'init'));
});

const revisedSpec = { path: 'x.spec.md', hash: 'sha256:' + 'b'.repeat(64) };
test('stale design spec pin returns design to author', () => {
 const base = approval();
 const parsed = { tag: 'parse' as const, c: { ...base.c, approval: null }, effectId: 'design.parse-artifact.1', afterReview: false };
 const stale = stepDesign(parsed, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: parsed.effectId, hash, parsed: design, defects: [], governing: { pinned: hash, current: revisedSpec.hash, design: null, reqIds: [] } });
 assert.equal(stale.state.tag, 'parse'); assert.deepEqual(stale.effects, []);
 const result = stepDesign(stale.state, { type: 'SPEC_SETTLED', ...revisedSpec });
 assert.ok(result.state.tag === 'author'); assert.equal(result.state.defects[0]?.['code'], 'stale-spec');
});
function restartedIncrement() {
 const delivery = started(); assert.ok(delivery.tag === 'increment');
 const revision = stepDesign(delivery, { type: 'SPEC_SETTLED', ...revisedSpec });
 assert.ok(revision.state.tag === 'revision' && revision.state.child.tag === 'author');
 assert.deepEqual(revision.state.c.restartIncrements, ['I01']);
 const parse = stepDesign(revision.state, { type: 'AUTHORED', path: revision.state.child.workingPath });
 const nextHash = 'sha256:' + 'c'.repeat(64);
 const reviewed = stepDesign(parse.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: parse.effects[0]!.id, hash: nextHash, parsed: design, defects: [] });
 const accepted = approveDesignScope(stepDesign(reviewed.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: reviewed.effects[0]!.id, hash: nextHash, parsed: design, defects: [] }));
 assert.ok(accepted.state.tag === 'increment' && accepted.state.child.tag === 'starting');
 return accepted;
}
test('stale design spec revision approval restarts increment', () => {
 const restarted = restartedIncrement(); assert.ok(restarted.state.tag === 'increment' && restarted.state.child.tag === 'starting');
 assert.equal(restarted.state.child.c.specEpoch, 1); assert.deepEqual(restarted.state.c.restartIncrements, []);
 assert.deepEqual(restarted.state.child.c.governingSpec, revisedSpec);
 assert.equal(restarted.effects.at(-1)?.kind, 'snapshot');
 const complete = { ...restarted.state, child: { tag: 'complete' as const, c: { ...restarted.state.child.c, changedPaths: ['src/a.ts'] }, summary: 'Complete' } };
 const next = stepDesign(complete, { type: 'LOCK_BROKEN', stalePid: 1 });
 assert.ok(next.state.tag === 'increment' && next.state.increment === 'I02'); assert.deepEqual(next.state.c.completed, ['I01']);
});
test('restarted increment keeps earlier plan review history', () => {
 const restarted = restartedIncrement(); assert.ok(restarted.state.tag === 'increment');
 assert.equal(restarted.state.c.histories['I01']?.length, 1);
 assert.equal(restarted.state.c.histories['I01']?.[0]?.tag, 'starting');
 assert.equal('c' in restarted.state.child && restarted.state.child.c?.specEpoch, 1);
});

function historyReview(machinePath: string, target: string, marker: string) {
 const begun = beginReview({ kind: 'plan', target, cap: 1, breadth: 1, context: '', roster: [], timeoutMs: 1000 }, machinePath, {});
 assert.ok('c' in begun.state);
 return stepReview({ tag: 'rule', c: { ...begun.state.c, round: 1, rounds: [{ round: 1, scope: 'full', reviewers: ['reader'], failed: [] }], findings: [{ id: 'R1-F001', round: 1, status: 'open', severity: 'SHOULD', category: 'correctness', locus: 'x.plan.md:L1', defect: marker, requiredChange: 'Keep the invariant.', sources: ['reader'], scope: 'in' }] } }, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'reject', reason: marker + ' ruling' } } }).state;
}
test('restarted increment keeps earlier plan review history in rendered log blocks', () => {
 const restarted = restartedIncrement(); assert.ok(restarted.state.tag === 'increment' && 'c' in restarted.state.child && restarted.state.child.c);
 const context = restarted.state.child.c, target = context.planPath;
 const files = new Map<string, string>([[target, '# Plan\n']]);
 const ports = { fs: { exists: (file: string) => files.has(file), readText: (file: string) => files.get(file)!, writeAtomic: (file: string, text: string) => files.set(file, text) } } as unknown as Ports;
 const old = restarted.state.c.histories['I01']![0]!; assert.ok('c' in old && old.c);
 const prior = { ...old, c: { ...old.c, planPath: target, planReview: historyReview('design.i01.implement.plan-review', target, 'Earlier finding') } };
 const current = { ...restarted.state.child, c: { ...context, planReview: historyReview('design.i01.implement.plan-review.s1', target, 'Later finding') } };
 const state: DesignState = { ...restarted.state, c: { ...restarted.state.c, histories: { I01: [prior] } }, child: current };
 rootMachine.render!({ tag: 'design', run: { verb: 'implement', argument: 'x.design.md', slug: 'x' }, child: state }, ports, '/session/.state/runs/run');
 const log = [...files.entries()].find(([file]) => file.endsWith('.review-log.md'))?.[1] ?? '';
 assert.match(log, /Earlier finding/); assert.match(log, /Later finding/);
 assert.match(log, /Earlier finding ruling/); assert.match(log, /Later finding ruling/);
 assert.match(log, /plan-review.s1/);
});
