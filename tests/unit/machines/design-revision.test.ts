import assert from 'node:assert/strict';
import { test } from 'node:test';
import { designDelta, beginDesignRevision, stepDesignRevision, validateDesignRevision } from '../../../skills/dispatch/scripts/machines/design-revision.ts';
import { stepDesign } from '../../../skills/dispatch/scripts/machines/design.ts';
import { approval, approveDesignScope, design, hash } from './fixtures/design.ts';
import { started } from './fixtures/design-delivery.ts';
import type { DesignState } from '../../../skills/dispatch/scripts/machines/design.ts';

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
test('prewrite-level: design growth before the first child gate remains in the revision approval flow', () => {
  const base = approval('implement').c;
  const authored = beginDesignRevision(base, { type: 'REVISE', artifact: 'design', reason: 'repair', evidence: 'required path' });
  const parsing = stepDesignRevision(authored.state, { type: 'AUTHORED', path: authored.state.workingPath });
  if (parsing.state.tag !== 'parse') throw new Error('parse');
  const changed = {
    ...design,
    increments: design.increments.map((row) => row.id === 'I01' ? { ...row, paths: [...row.paths, 'src/new-path.ts'] } : row),
  };
  const reviewed = stepDesignRevision({ ...parsing.state, afterReview: true }, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: parsing.state.effectId, hash: `sha256:${'b'.repeat(64)}`, parsed: changed, defects: [] });
  assert.equal(reviewed.state.tag, 'resume');
  assert.deepEqual(reviewed.effects, []);
});
test('prewrite-level: design revision exposes acceptance delta for adjudication', () => {
  const base = approval('implement').c;
  const before = { ...design, governedText: '# Delivery\n\n## Goals & Requirements\nKeep the accepted behavior\n\n## Architecture & Boundaries\nPreserve module ownership\n\n## Final Integration\nRun the governed suite' };
  const c = { ...base, design: before, hash, levelGatePassed: true, completed: ['I01'], ownership: { I01: ['src/a.ts'] }, baseline: 'a'.repeat(40), approval: { by: 'user' as const, quote: 'Deliver', hash } };
  const working = beginDesignRevision(c, { type: 'REVISE', artifact: 'design', reason: 'Include final integration obligation', evidence: 'The suite must cover the new contract.' });
  const authored = stepDesignRevision(working.state, { type: 'AUTHORED', path: working.state.workingPath });
  if (authored.state.tag !== 'parse') throw new Error('parse');
  const after = { ...before, governedText: before.governedText.replace('Run the governed suite', 'Run the governed suite and confirm cross-increment compatibility') };
  const proposal = stepDesignRevision({ ...authored.state, afterReview: true }, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: authored.state.effectId, hash: `sha256:${'b'.repeat(64)}`, parsed: after, defects: [] });
  assert.equal(proposal.state.tag, 'scope-adjudication');
  if (proposal.state.tag !== 'scope-adjudication') return;
  assert.equal(proposal.state.request.source, 'design-revision');
  if (proposal.state.request.source !== 'design-revision') return;
  assert.equal(proposal.state.request.baseArtifactHash, hash);
  assert.equal(proposal.state.request.proposedArtifactHash, `sha256:${'b'.repeat(64)}`);
  assert.deepEqual(proposal.state.request.affectedIncrements, ['I01', 'I02']);
  assert.deepEqual(proposal.state.request.delta.criteria, []);
  assert.ok(proposal.state.request.delta.obligations.some((obligation) => obligation.includes('## Final Integration updated') && obligation.includes('cross-increment compatibility')));
  assert.deepEqual(proposal.effects, []);

  const reorderedRequest = Object.fromEntries(Object.entries(proposal.state.request).reverse());
  const decision = { type: 'DECISION' as const, kind: 'scope-deviation' as const, answer: { by: 'orchestrator' as const, request: reorderedRequest as typeof proposal.state.request, ruling: 'approve' as const, rationale: 'This verification is required for the revised shared contract.' } };
  assert.equal(validateDesignRevision(proposal.state, decision), null);
  const resumed = stepDesignRevision(proposal.state, decision);
  assert.equal(resumed.state.tag, 'resume');
  if (resumed.state.tag === 'resume') {
    assert.equal(resumed.state.scopeAdjudicated, true);
    assert.deepEqual(resumed.state.c.scopeNotice, { requestId: proposal.state.request.requestId, approvedBy: 'orchestrator', rationale: 'This verification is required for the revised shared contract.' });
    assert.ok(resumed.state.c.scopeAdjustments[0]?.proposal.delta.obligations.some((obligation) => obligation.includes('cross-increment compatibility')));
  }
});

test('level-journal: design revision rulings bind orchestrator and user decisions to the pending proposal', () => {
  const before = { ...design, governedText: '# Delivery\n\n## Goals & Requirements\nKeep the accepted behavior\n\n## Architecture & Boundaries\nPreserve module ownership' };
  const c = { ...approval('implement').c, design: before, hash, levelGatePassed: true, completed: ['I01'], ownership: { I01: ['src/a.ts'] }, baseline: 'a'.repeat(40), approval: { by: 'user' as const, quote: 'Deliver', hash } };
  const working = beginDesignRevision(c, { type: 'REVISE', artifact: 'design', reason: 'add required module', evidence: 'The accepted behavior needs a companion path.' });
  const authored = stepDesignRevision(working.state, { type: 'AUTHORED', path: working.state.workingPath });
  if (authored.state.tag !== 'parse') throw new Error('parse');
  const after = { ...before, increments: before.increments.map((row) => row.id === 'I01' ? { ...row, paths: [...row.paths, 'src/extra.ts'] } : row) };
  const proposal = stepDesignRevision({ ...authored.state, afterReview: true }, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: authored.state.effectId, hash: `sha256:${'b'.repeat(64)}`, parsed: after, defects: [] });
  if (proposal.state.tag !== 'scope-adjudication') throw new Error('expanded revision should request adjudication');
  const request = proposal.state.request;
  assert.deepEqual(request.delta.criteria, []);
  assert.deepEqual(request.delta.increments.map((increment) => increment.id), ['I01']);
  assert.match(validateDesignRevision(proposal.state, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request: { ...request, baseArtifactHash: `sha256:${'c'.repeat(64)}` }, ruling: 'approve', rationale: 'Approve.' } }) ?? '', /pending design proposal/);
  const disagreement = stepDesignRevision(proposal.state, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request, ruling: 'disagree', rationale: 'The added path needs user review.' } });
  if (disagreement.state.tag !== 'scope-user-decision') throw new Error('disagreement should request the user choice');
  assert.match(validateDesignRevision(disagreement.state, { type: 'DECISION', kind: 'scope-deviation-user', answer: { by: 'user', requestId: 'stale', choice: 'accept', quote: 'Accept.' } }) ?? '', /pending design request/);
  const accepted = stepDesignRevision(disagreement.state, { type: 'DECISION', kind: 'scope-deviation-user', answer: { by: 'user', requestId: request.requestId, choice: 'accept', quote: 'Accept the companion path.' } });
  assert.equal(accepted.state.tag, 'resume');
  if (accepted.state.tag === 'resume') {
    assert.equal(accepted.state.scopeAdjudicated, true);
    assert.deepEqual(accepted.state.c.scopeNotice, { requestId: request.requestId, approvedBy: 'user', rationale: 'The added path needs user review.', quote: 'Accept the companion path.' });
  }
});

test('level-journal: design revision retains accepted scope and adjudicates only additional growth', () => {
  const before = { ...design, governedText: '# Delivery\n\n## Goals & Requirements\nKeep the accepted behavior\n\n## Architecture & Boundaries\nPreserve module ownership' };
  const base = { ...approval('implement').c, design: before, hash, levelGatePassed: true, completed: ['I01'], ownership: { I01: ['src/a.ts'] }, baseline: 'a'.repeat(40), approval: { by: 'user' as const, quote: 'Deliver', hash } };
  const firstDesign = { ...before, increments: before.increments.map((row) => row.id === 'I01' ? { ...row, paths: [...row.paths, 'src/extra.ts'] } : row) };
  const firstHash = `sha256:${'b'.repeat(64)}`;
  const first = beginDesignRevision(base, { type: 'REVISE', artifact: 'design', reason: 'add the required companion', evidence: 'The first expansion is needed.' });
  const firstAuthored = stepDesignRevision(first.state, { type: 'AUTHORED', path: first.state.workingPath });
  if (firstAuthored.state.tag !== 'parse') throw new Error('first parse');
  const firstParse = stepDesignRevision({ ...firstAuthored.state, afterReview: true }, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: firstAuthored.state.effectId, hash: firstHash, parsed: firstDesign, defects: [] });
  if (firstParse.state.tag !== 'scope-adjudication') throw new Error('first expansion should be adjudicated');
  const adoptedFirst = stepDesign({ tag: 'revision', c: base, child: firstParse.state }, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request: firstParse.state.request, ruling: 'approve', rationale: 'The companion path is needed.' } });
  assert.notEqual(adoptedFirst.state.tag, 'approval');
  assert.equal(adoptedFirst.state.c?.scopeNotice?.requestId, firstParse.state.request.requestId);
  assert.equal(adoptedFirst.state.c?.approval?.hash, firstHash);
  const adoptedContext = adoptedFirst.state.c!;

  const secondDesign = { ...firstDesign, increments: firstDesign.increments.map((row) => row.id === 'I01' ? { ...row, paths: [...row.paths, 'src/additional.ts'] } : row) };
  const secondHash = `sha256:${'c'.repeat(64)}`;
  const second = beginDesignRevision(adoptedContext, { type: 'REVISE', artifact: 'design', reason: 'add further required work', evidence: 'A second path is necessary.' });
  const secondAuthored = stepDesignRevision(second.state, { type: 'AUTHORED', path: second.state.workingPath });
  if (secondAuthored.state.tag !== 'parse') throw new Error('second parse');
  const secondProposal = stepDesignRevision({ ...secondAuthored.state, afterReview: true }, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: secondAuthored.state.effectId, hash: secondHash, parsed: secondDesign, defects: [] });
  if (secondProposal.state.tag !== 'scope-adjudication') throw new Error('additional expansion should be adjudicated');
  assert.deepEqual(secondProposal.state.request.delta.paths, ['src/additional.ts']);
  if (secondProposal.state.request.source !== 'design-revision') throw new Error('design revision proposal');
  assert.deepEqual(secondProposal.state.request.affectedIncrements, ['I01', 'I02']);
  const acceptedSecond: DesignState = { tag: 'revision', c: adoptedContext, child: secondProposal.state };
  const adoptedSecond = stepDesign(acceptedSecond, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request: secondProposal.state.request, ruling: 'approve', rationale: 'The additional path is required.' } });
  assert.notEqual(adoptedSecond.state.tag, 'approval');
  assert.equal(adoptedSecond.state.c?.scopeNotice?.requestId, secondProposal.state.request.requestId);
  assert.equal(adoptedSecond.state.c?.approval?.hash, secondHash);
  assert.equal(adoptedSecond.state.c?.scopeAdjustments.length, 2);
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
  const rebound = approveDesignScope(stepDesign(parent, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: reviewed.effects[0]!.id, hash: revisedHash, parsed: revised, defects: [] }));
  assert.equal(rebound.state.tag, 'increment');
  if (rebound.state.tag !== 'increment') throw new Error('increment');
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
  const resumed = approveDesignScope(stepDesign({ tag: 'revision', c, child: reviewed.state }, { ...event, effectId: reviewed.effects[0]!.id }));
  assert.equal(resumed.state.tag, 'increment');
  if (resumed.state.tag !== 'increment') throw new Error('increment');
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
    const resumed = approveDesignScope(stepDesign({ tag: 'revision', c, child: reviewed.state }, { ...event, effectId: reviewed.effects[0]!.id }));
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
  const resumed = approveDesignScope(stepDesign(reviewed.state, { ...event, effectId: reviewed.effects[0]!.id }));
  assert.equal(resumed.state.tag, 'increment');
  if (resumed.state.tag !== 'increment' || !('c' in resumed.state.child) || !resumed.state.child.c) throw new Error('resumed child');
  assert.equal(resumed.state.child.tag, 'evidence');
  assert.equal(resumed.state.child.c.evidence, evidence);
  assert.equal(resumed.state.child.c.planPath, initial.child.c.planPath);
  assert.equal(resumed.state.child.c.designBinding?.revision, event.hash);
  assert.equal(resumed.state.child.c.designBinding?.approval.by, 'revision');
  assert.deepEqual(resumed.effects, []);
});
