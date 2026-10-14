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
  const plan = { title: 'First', box: { 'TL;DR': 'First behavior' }, keyDecisions: [], criteria: [], changes: [], verification: { automated: [], none: null, manual: [] }, tasks: [], finalCommands: [], traceability: { Design: 'x.design.md', Revision: hash, Increment: 'I01', Outcome: 'First behavior' }, governedText: '# First', sharedContext: '# First', seams: [], warnings: [] };
  state = { ...state, child: { tag: 'baseline-snapshot', c: { ...c, plan, planHash: hash, startFingerprint: { head: 'h', index: 'i', worktree: 'w' } }, effectId: 'baseline', results: [] } };
  const result = stepDesign(state, { type: 'SNAPSHOT', effectId: 'baseline', fingerprint: { head: 'h', index: 'i', worktree: 'w' }, diff: { paths: [] } });
  assert.equal(result.state.tag, 'increment');
  if (result.state.tag !== 'increment' || !('c' in result.state.child) || !result.state.child.c) throw new Error('child');
  assert.equal(result.state.child.tag, 'task-checkout');
  assert.equal(result.state.child.c.approval?.by, 'design');
  assert.ok(result.state.child.c.designBinding && result.effects.some((effect) => effect.kind === 'checkout' && effect.op === 'init'));
});
