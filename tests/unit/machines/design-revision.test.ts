import assert from 'node:assert/strict';
import { test } from 'node:test';
import { designDelta, beginDesignRevision, stepDesignRevision } from '../../../skills/dispatch/scripts/machines/design-revision.ts';
import { stepDesign } from '../../../skills/dispatch/scripts/machines/design.ts';
import { approval, design, hash } from './design.test.ts';
import { started } from './design-delivery.test.ts';

test('design-revision: completed changed acceptance and dependent increments invalidate', () => {
  const changed = { ...design, details: { ...design.details, I01: { Outcome: 'Changed behavior' } } };
  assert.deepEqual(designDelta(design, changed), { changed: ['I01'], invalidated: ['I01', 'I02'], removed: [] });
  assert.deepEqual(designDelta(design, design).invalidated, []);
});
test('design revision refuses a changed objective before review', () => {
  const base = approval('implement');
  const authored = beginDesignRevision(base.c, { type: 'REVISE', artifact: 'design', reason: 'repair', evidence: 'finding' });
  const parsing = stepDesignRevision(authored.state, { type: 'AUTHORED', path: authored.state.workingPath });
  const result = stepDesignRevision(parsing.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: parsing.effects[0]!.id, hash, parsed: { ...design, box: { 'TL;DR': 'Other objective' } }, defects: [] });
  assert.equal(result.state.tag, 'refused');
});
test('delta settlement rebinds revision and keeps unchanged acceptance evidence; changed completion reopens', () => {
  const state = approval('implement');
  const c = { ...state.c, completed: ['I01', 'I02'], approval: { by: 'user' as const, quote: 'Deliver', hash }, baseline: 'a'.repeat(40), ownership: { I01: ['src/a.ts'], I02: ['src/b.ts'] } };
  const revisedHash = `sha256:${'b'.repeat(64)}`;
  const revised = { ...design, details: { ...design.details, I02: { Outcome: 'Updated second' } } };
  const working = beginDesignRevision(c, { type: 'REVISE', artifact: 'design', reason: 'repair', evidence: 'finding' });
  const parsing = stepDesignRevision(working.state, { type: 'AUTHORED', path: working.state.workingPath });
  const reviewed = stepDesignRevision(parsing.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: parsing.effects[0]!.id, hash: revisedHash, parsed: revised, defects: [] });
  assert.equal(reviewed.state.tag, 'parse');
  const parent = { tag: 'revision' as const, c, child: reviewed.state };
  const rebound = stepDesign(parent, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: reviewed.effects[0]!.id, hash: revisedHash, parsed: revised, defects: [] });
  assert.equal(rebound.state.tag, 'increment');
  assert.deepEqual(rebound.state.c.completed, ['I01']);
  assert.equal(rebound.state.c.approval?.hash, revisedHash);
  assert.equal(rebound.state.c.approval?.by, 'revision');
  assert.ok(rebound.state.c.approval?.by === 'revision' && rebound.state.c.approval.basedOn === hash);
  assert.equal(rebound.state.c.hash, revisedHash);
  assert.equal(new Set([...parsing.effects, ...reviewed.effects, ...rebound.effects].map((effect) => effect.id)).size, 3);
});

test('removed increment seeds transitive invalidation without returning removed IDs as ready work', () => {
  const after = { ...design, increments: [design.increments[1]!] };
  assert.deepEqual(designDelta(design, after), { changed: [], removed: ['I01'], invalidated: ['I02'] });
});

test('removed completed increment transfers changed paths to its unique revised owner', () => {
  const base = approval('implement');
  const c = { ...base.c, completed: ['I01', 'I02'], approval: { by: 'user' as const, quote: 'Deliver', hash }, baseline: 'a'.repeat(40), ownership: { I01: ['src/a.ts'], I02: ['src/b.ts'] }, repairs: { I02: ['old repair'] } };
  const revised = { ...design, increments: [{ ...design.increments[0]!, paths: ['src/a.ts', 'src/b.ts'] }], details: { I01: design.details.I01 } };
  const working = beginDesignRevision(c, { type: 'REVISE', artifact: 'design', reason: 'Remove second', evidence: 'not required' });
  const parsing = stepDesignRevision(working.state, { type: 'AUTHORED', path: working.state.workingPath });
  const event = { type: 'ARTIFACT_PARSED' as const, kind: 'design' as const, effectId: parsing.effects[0]!.id, hash: `sha256:${'b'.repeat(64)}`, parsed: revised, defects: [] };
  const reviewed = stepDesignRevision(parsing.state, event);
  const resumed = stepDesign({ tag: 'revision', c, child: reviewed.state }, { ...event, effectId: reviewed.effects[0]!.id });
  assert.equal(resumed.state.tag, 'increment');
  assert.deepEqual(resumed.state.c.completed, []);
  assert.deepEqual(resumed.state.c.ownership, { I01: ['src/a.ts', 'src/b.ts'] });
  assert.deepEqual(resumed.state.c.repairs, {});
});

test('revision refuses dropped and ambiguous previously changed paths; valid paths survive invalidation', () => {
  for (const scope of ['dropped', 'ambiguous', 'valid']) {
    const base = approval('implement');
    const c = { ...base.c, completed: ['I01', 'I02'], approval: { by: 'user' as const, quote: 'Deliver', hash }, baseline: 'a'.repeat(40), ownership: { I01: ['src/a.ts'], I02: ['src/b.ts'] }, repairs: { I01: ['obsolete contract repair'] } };
    const revised = { ...design, increments: design.increments.map((row) => scope === 'dropped' && row.id === 'I01' ? { ...row, paths: ['src/c.ts'] } : scope === 'ambiguous' && row.id === 'I02' ? { ...row, paths: ['src/a.ts', 'src/b.ts'] } : row), details: { ...design.details, I01: { Outcome: 'Updated contract' } } };
    const working = beginDesignRevision(c, { type: 'REVISE', artifact: 'design', reason: 'Revise first', evidence: 'Changed contract' });
    const parsing = stepDesignRevision(working.state, { type: 'AUTHORED', path: working.state.workingPath });
    const event = { type: 'ARTIFACT_PARSED' as const, kind: 'design' as const, effectId: parsing.effects[0]!.id, hash: `sha256:${'b'.repeat(64)}`, parsed: revised, defects: [] };
    const reviewed = stepDesignRevision(parsing.state, event);
    const resumed = stepDesign({ tag: 'revision', c, child: reviewed.state }, { ...event, effectId: reviewed.effects[0]!.id });
    assert.equal(resumed.state.tag, scope === 'valid' ? 'increment' : 'failed');
    if (scope === 'valid') {
      assert.deepEqual(resumed.state.c.ownership, c.ownership);
      assert.deepEqual(resumed.state.c.repairs, {});
      assert.deepEqual(resumed.state.c.completed, []);
    } else {
      assert.ok(resumed.state.tag === 'failed' && /cannot reconcile.*src\/a.ts/.test(resumed.state.summary));
      assert.deepEqual(resumed.effects, []);
    }
  }
});

test('an unaffected active increment retains its evidence await and progress across a design revision', () => {
  const initial = started();
  if (initial.tag !== 'increment' || !('c' in initial.child) || !initial.child.c) throw new Error('child');
  const evidence = { SC1: { result: 'verified before revision' } } as never;
  const parent = { ...initial, child: { tag: 'evidence' as const, c: { ...initial.child.c, evidence }, purpose: 'final' as const, ids: ['SC1'], verify: [] } };
  const authored = stepDesign(parent, { type: 'REVISE', artifact: 'design', reason: 'Change only second increment', evidence: 'Unstarted contract changed' });
  if (authored.state.tag !== 'revision') throw new Error('revision');
  const parsed = stepDesign(authored.state, { type: 'AUTHORED', path: authored.state.child.workingPath });
  const revised = { ...design, details: { ...design.details, I02: { Outcome: 'Updated second' } } };
  const event = { type: 'ARTIFACT_PARSED' as const, kind: 'design' as const, effectId: parsed.effects[0]!.id, hash: `sha256:${'b'.repeat(64)}`, parsed: revised, defects: [] };
  const reviewed = stepDesign(parsed.state, event);
  const resumed = stepDesign(reviewed.state, { ...event, effectId: reviewed.effects[0]!.id });
  assert.equal(resumed.state.tag, 'increment');
  if (resumed.state.tag !== 'increment' || !('c' in resumed.state.child) || !resumed.state.child.c) throw new Error('resumed child');
  assert.equal(resumed.state.child.tag, 'evidence');
  assert.equal(resumed.state.child.c.evidence, evidence);
  assert.equal(resumed.state.child.c.planPath, initial.child.c.planPath);
  assert.equal(resumed.state.child.c.designBinding?.revision, event.hash);
  assert.equal(resumed.state.child.c.designBinding?.approval.by, 'revision');
  assert.deepEqual(resumed.effects, []);
});
