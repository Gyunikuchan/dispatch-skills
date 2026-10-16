import { qualitySections } from '../../../skills/dispatch/scripts/domain/prompt.ts';
import { rebindReviewSpec, stepReview } from '../../../skills/dispatch/scripts/machines/review.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { designDelta, beginDesignRevision, stepDesignRevision, validateDesignRevision, designRevisionData } from '../../../skills/dispatch/scripts/machines/design-revision.ts';
import { integration } from './fixtures/design-integration.ts';
import { designData, stepDesign } from '../../../skills/dispatch/scripts/machines/design.ts';
import { approval, approveDesignScope, design, hash } from './fixtures/design.ts';
import { started } from './fixtures/design-delivery.ts';
import type { DesignState } from '../../../skills/dispatch/scripts/machines/design.ts';
import { createFolder, fold } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { rootMachine, type RootState } from '../../../skills/dispatch/scripts/machines/root.ts';
import type { Event, JournalLine, Ports } from '../../../skills/dispatch/scripts/core/types.ts';
import { threshold } from '../../../skills/dispatch/scripts/policy/rounds.ts';

function revisionParsing() {
  const author = beginDesignRevision(approval('implement').c, { type: 'REVISE', artifact: 'design', reason: 'repair', evidence: 'User constraint: keep the existing public API.' }).state;
  const parse = stepDesignRevision(author, { type: 'AUTHORED', path: author.workingPath });
  return { author, parse, event: { type: 'ARTIFACT_PARSED' as const, kind: 'design' as const, effectId: parse.effects[0]!.id, hash, parsed: design, defects: [] as Record<string, unknown>[] } };
}

test('review-cap: successive design revisions launch cumulative rounds and finding IDs', () => {
  let c = approval('implement').c;
  c = { ...c, run: { ...c.run, config: { ...c.run.config, phases: { ...(c.run.config['phases'] as Record<string, unknown>), 'plan-review': { rounds: { low: 2 }, targets: { low: 1 } } } } } };
  for (const round of [1, 2]) {
    const revisionHash = `sha256:${String(round).repeat(64)}`;
    const author = beginDesignRevision(c, { type: 'REVISE', artifact: 'design', reason: 'repair', evidence: 'Preserve the objective.' }).state;
    const parsed = stepDesignRevision(author, { type: 'AUTHORED', path: author.workingPath });
    const prepared = stepDesignRevision(parsed.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: parsed.effects[0]!.id, hash: revisionHash, parsed: design, defects: [] });
    assert.equal(prepared.state.tag, 'review');
    if (prepared.state.tag !== 'review') throw new Error('Expected revision review.');
    assert.ok('c' in prepared.state.review);
    assert.equal(prepared.state.review.c.round, round - 1);
    assert.equal(prepared.effects[0]!.kind, 'prepare-review');
    const launched = stepDesignRevision(prepared.state, { type: 'REVIEW_PREPARED', effectId: prepared.effects[0]!.id, scope: { empty: false }, promptPaths: {} });
    assert.equal(launched.state.tag, 'review');
    if (launched.state.tag !== 'review') throw new Error('Expected launched review.');
    assert.ok('c' in launched.state.review);
    assert.equal(launched.state.review.c.round, round);
    const wave = launched.effects[0]!;
    assert.equal(wave.kind, 'wave-start');
    if (wave.kind !== 'wave-start') throw new Error('Expected review wave.');
    assert.equal(wave.round, round);
    const id = `R${wave.round}-F001`;
    const ruled = stepDesignRevision(launched.state, { type: 'WAVE_DONE', effectId: wave.id, round, slots: [{ slot: 'codex', state: 'success' }], findings: [{ id, severity: 'CONSIDER', category: 'correctness', defect: 'Check compatibility', requiredChange: 'Preserve compatibility.', locus: 'src/a.ts', sources: ['codex'] }] });
    assert.equal(ruled.state.tag, 'review');
    if (ruled.state.tag !== 'review') throw new Error('Expected rulings.');
    assert.ok('c' in ruled.state.review);
    assert.equal(ruled.state.review.c.findings[0]!.id, id);
    assert.equal(ruled.state.review.c.spec.cap, 2);
    assert.equal(ruled.state.review.c.round, round);
    assert.equal(threshold(round, ruled.state.review.c.spec.cap), round === 1 ? 'SHOULD' : 'MUST');
    const settled = stepDesignRevision(ruled.state, { type: 'RULINGS', rulings: { [id]: { ruling: 'reject', reason: 'No defect.' } } });
    assert.equal(settled.state.tag, 'parse');
    const resumed = stepDesignRevision(settled.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: settled.effects[0]!.id, hash: revisionHash, parsed: design, defects: [] });
    assert.equal(resumed.state.tag, 'resume');
    if (resumed.state.tag !== 'resume') throw new Error('Expected resumed revision.');
    assert.equal(resumed.state.c.revisionReviewRound, round);
    c = { ...resumed.state.c, hash: resumed.state.hash, design: resumed.state.design };
  }
});

// SECTION: Revision author handoff

test('author quality reads: revision author exposes the canonical design template', () => {
  const { author } = revisionParsing();
  const data = designRevisionData(author);
  assert.equal(data['template'], 'references/templates/design.md');
  assert.deepEqual(Object.keys(data).sort(), ['artifact', 'defects', 'evidence', 'path', 'read', 'reason', 'template']);
  assert.deepEqual(data['read'], [{ path: 'references/templates/quality-bar.md', sections: qualitySections.design }]);
  assert.equal(data['evidence'], 'User constraint: keep the existing public API.');
  assert.deepEqual(data['defects'], []);
});

test('revision-handoff: retry keeps parser code line and message', () => {
  const { parse, event } = revisionParsing();
  const defects = [{ code: 'missing-field', line: 12, message: 'Add rollback boundary.', severity: 'defect' }];
  const retry = stepDesignRevision(parse.state, { ...event, defects }).state;
  assert.equal(retry.tag, 'author');
  assert.deepEqual(designRevisionData(retry)['defects'], defects);
  assert.equal(designRevisionData(retry)['error'], undefined);
});

test('revision-handoff: absent diagnostics use the parent design fallback record', () => {
  const { parse, event } = revisionParsing();
  for (const invalid of [{ ...event, hash: 'bad' }, { ...event, parsed: {} }]) {
    const retry = stepDesignRevision(parse.state, invalid).state;
    assert.deepEqual(designRevisionData(retry)['defects'], [{ message: 'Invalid design payload or governed hash.' }]);
  }
});

test('revision-handoff: replay reproduces the diagnostic author frame', () => {
  const base = approval('implement');
  const seed: RootState = { tag: 'design', run: { verb: 'implement', argument: base.c.path, slug: 'fixture' }, child: base };
  const machine = { ...rootMachine, initial: () => seed };
  const folder = createFolder(machine);
  const events: Event[] = [];
  const apply = (event: Event) => { events.push(event); folder.apply(event); };
  apply({ type: 'REVISE', artifact: 'design', reason: 'repair', evidence: 'User constraint: keep the existing public API.' });
  assert.equal(machine.project(folder.state).data['evidence'], 'User constraint: keep the existing public API.');
  const path = machine.project(folder.state).data['path'];
  assert.equal(typeof path, 'string');
  apply({ type: 'AUTHORED', path: String(path) });
  const effect = folder.queue[0]!;
  apply({ type: 'EFFECT_STARTED', effectId: effect.id, kind: effect.kind, attempt: 1 });
  const defects = [{ code: 'missing', line: 5, message: 'Repair field.' }];
  apply({ type: 'ARTIFACT_PARSED', effectId: effect.id, kind: 'design', hash, parsed: design, defects });
  const lines: JournalLine[] = [{ seq: 1, v: 1, at: 'now', type: 'RUN_STARTED', data: { ...base.c.run } }, ...events.map(({ type, ...data }, i): JournalLine => ({ seq: i + 2, v: 1, at: 'now', type, data }))];
  const replay = fold(machine, lines);
  assert.deepEqual(replay.state, folder.state);
  const data = machine.project(replay.state).data;
  assert.equal(data['evidence'], 'User constraint: keep the existing public API.');
  assert.equal(data['template'], 'references/templates/design.md');
  assert.deepEqual(data['defects'], defects);
});

test('revision-handoff: successful repair clears prior author diagnostics', () => {
  const { parse, event } = revisionParsing();
  const retry = stepDesignRevision(parse.state, { ...event, defects: [{ message: 'Repair field.' }] }).state;
  const next = stepDesignRevision(retry, { type: 'AUTHORED', path: retry.workingPath });
  const resumed = stepDesignRevision(next.state, { ...event, effectId: next.effects[0]!.id }).state;
  assert.equal(resumed.tag, 'resume');
  assert.equal(designRevisionData(resumed)['defects'], undefined);
});

test('revision-handoff: non-author projections omit the author template', () => {
  const { parse, event } = revisionParsing();
  const resumed = stepDesignRevision(parse.state, event).state;
  const refused = stepDesignRevision(parse.state, { ...event, parsed: { ...design, box: { 'TL;DR': 'Different goal' } } }).state;
  for (const state of [parse.state, resumed, refused]) assert.equal(designRevisionData(state)['template'], undefined);
});

// SECTION: Revision settlement and scope adjudication

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
test('design revision request approved by orchestrator', () => {
  const base = approval('implement').c;
  const before = { ...design, governedText: '# Delivery\n\n## Approach\nREQ-1 strategy\nKeep the accepted behavior\n\n## Architecture & Boundaries\nPreserve module ownership\n\n## Final Integration\nRun the governed suite' };
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

  assert.equal(designRevisionData(proposal.state)['kind'], 'request');
  const decision = { type: 'DECISION' as const, kind: 'request' as const, answer: { by: 'orchestrator' as const, action: 'approve', rationale: 'This verification is required for the revised shared contract.' } };
  assert.equal(validateDesignRevision(proposal.state, decision), null);
  const resumed = stepDesignRevision(proposal.state, decision);
  assert.equal(resumed.state.tag, 'resume');
  if (resumed.state.tag === 'resume') {
    assert.equal(resumed.state.scopeAdjudicated, true);
    assert.deepEqual(resumed.state.c.scopeNotice, { requestId: proposal.state.request.requestId, approvedBy: 'orchestrator', rationale: 'This verification is required for the revised shared contract.' });
    assert.ok(resumed.state.c.scopeAdjustments[0]?.proposal.delta.obligations.some((obligation) => obligation.includes('cross-increment compatibility')));
  }
});

test('design revision request escalates to user', () => {
  const before = { ...design, governedText: '# Delivery\n\n## Approach\nREQ-1 strategy\nKeep the accepted behavior\n\n## Architecture & Boundaries\nPreserve module ownership' };
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
  assert.match(validateDesignRevision(proposal.state, { type: 'DECISION', kind: 'request', answer: { by: 'orchestrator', action: 'approve', rationale: ' ' } }) ?? '', /approve, decline, or escalate/);
  const disagreement = stepDesignRevision(proposal.state, { type: 'DECISION', kind: 'request', answer: { by: 'orchestrator', action: 'escalate', rationale: 'The added path needs user review.' } });
  if (disagreement.state.tag !== 'scope-user-decision') throw new Error('escalation should request the user choice');
  assert.equal(designRevisionData(disagreement.state)['kind'], 'request-user');
  assert.match(validateDesignRevision(disagreement.state, { type: 'DECISION', kind: 'request-user', answer: { by: 'user', requestId: 'stale', choice: 'accept', quote: 'Accept.' } }) ?? '', /pending design request/);
  assert.match(validateDesignRevision(disagreement.state, { type: 'DECISION', kind: 'request-user', answer: { by: 'user', requestId: request.requestId, choice: 'accept', quote: '' } }) ?? '', /quote/);
  const accepted = stepDesignRevision(disagreement.state, { type: 'DECISION', kind: 'request-user', answer: { by: 'user', requestId: request.requestId, choice: 'accept', quote: 'Accept the companion path.' } });
  assert.equal(accepted.state.tag, 'resume');
  if (accepted.state.tag === 'resume') {
    assert.equal(accepted.state.scopeAdjudicated, true);
    assert.deepEqual(accepted.state.c.scopeNotice, { requestId: request.requestId, approvedBy: 'user', rationale: 'The added path needs user review.', quote: 'Accept the companion path.' });
  }
});

test('level-journal: design revision retains accepted scope and adjudicates only additional growth', () => {
  const before = { ...design, governedText: '# Delivery\n\n## Approach\nREQ-1 strategy\nKeep the accepted behavior\n\n## Architecture & Boundaries\nPreserve module ownership' };
  const base = { ...approval('implement').c, design: before, hash, levelGatePassed: true, completed: ['I01'], ownership: { I01: ['src/a.ts'] }, baseline: 'a'.repeat(40), approval: { by: 'user' as const, quote: 'Deliver', hash } };
  const firstDesign = { ...before, increments: before.increments.map((row) => row.id === 'I01' ? { ...row, paths: [...row.paths, 'src/extra.ts'] } : row) };
  const firstHash = `sha256:${'b'.repeat(64)}`;
  const first = beginDesignRevision(base, { type: 'REVISE', artifact: 'design', reason: 'add the required companion', evidence: 'The first expansion is needed.' });
  const firstAuthored = stepDesignRevision(first.state, { type: 'AUTHORED', path: first.state.workingPath });
  if (firstAuthored.state.tag !== 'parse') throw new Error('first parse');
  const firstParse = stepDesignRevision({ ...firstAuthored.state, afterReview: true }, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: firstAuthored.state.effectId, hash: firstHash, parsed: firstDesign, defects: [] });
  if (firstParse.state.tag !== 'scope-adjudication') throw new Error('first expansion should be adjudicated');
  const adoptedFirst = stepDesign({ tag: 'revision', c: base, child: firstParse.state }, { type: 'DECISION', kind: 'request', answer: { by: 'orchestrator', action: 'approve', rationale: 'The companion path is needed.' } });
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
  const adoptedSecond = stepDesign(acceptedSecond, { type: 'DECISION', kind: 'request', answer: { by: 'orchestrator', action: 'approve', rationale: 'The additional path is required.' } });
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

test('approach change is a scope obligation', () => {
 const { parse, event } = revisionParsing();
 const revised = { ...design, governedText: design.governedText + '\n## Approach\nREQ-1 strategy\nREQ-1 new strategy\n' };
 if (parse.state.tag !== 'parse') throw new Error('Expected parse');
 const proposal = stepDesignRevision({ ...parse.state, c: { ...parse.state.c, levelGatePassed: true }, afterReview: true }, { ...event, parsed: revised, hash: 'sha256:' + 'b'.repeat(64) });
 assert.equal(proposal.state.tag, 'scope-adjudication');
 if (proposal.state.tag !== 'scope-adjudication') throw new Error('Expected scope adjudication');
 assert.ok(proposal.state.request.delta.obligations.some(value => value.includes('## Approach updated')));
});

const governingSpec = { path: 'x.spec.md', hash: 'sha256:' + 'a'.repeat(64) };
const specUpdate = { type: 'SPEC_SETTLED' as const, path: governingSpec.path, hash: 'sha256:' + 'b'.repeat(64) };
function governedRevision() {
 const base = approval('implement').c;
 const c = { ...base, governingSpec, revisionReviewRound: 2, run: { ...base.run, config: { ...base.run.config, phases: { 'plan-review': { rounds: { low: 3 }, targets: { low: 1 } } } } } };
 const author = beginDesignRevision(c, { type: 'REVISE', artifact: 'design', reason: 'repair', evidence: 'Keep intent' }).state;
 const parse = stepDesignRevision(author, { type: 'AUTHORED', path: author.workingPath });
 const event = { type: 'ARTIFACT_PARSED' as const, kind: 'design' as const, effectId: parse.effects[0]!.id, hash: 'sha256:' + 'c'.repeat(64), parsed: design, defects: [] };
 return { c, parse, event, review: stepDesignRevision(parse.state, event) };
}
test('author quality reads: stale design spec pin returns revision to author', () => {
 const { c, parse, event, review } = governedRevision();
 const stale = stepDesignRevision(parse.state, { ...event, governing: { pinned: governingSpec.hash, current: specUpdate.hash, design: null, reqIds: [] } });
 assert.equal(stale.state.tag, 'parse'); assert.deepEqual(stale.effects, []);
 for (const child of [stale.state, review.state]) {
 const parent: DesignState = { tag: 'revision', c, child };
 const rebound = stepDesign(parent, specUpdate);
 assert.ok(rebound.state.tag === 'revision' && rebound.state.child.tag === 'author');
 assert.deepEqual(designData(rebound.state)['read'], [{ path: 'references/templates/quality-bar.md', sections: qualitySections.design }]);
 assert.equal(rebound.state.child.defects[0]?.['code'], 'stale-spec'); assert.equal(rebound.state.c.revisionReviewEpoch, 1);
 assert.equal(rebound.state.c.revisionReviewRound, 2); assert.deepEqual(rebound.effects, []);
 }
});
test('successive revision keeps delta scope through pin check', () => {
 const { review } = governedRevision(); assert.ok(review.state.tag === 'review' && review.state.review.tag === 'pin-check');
 assert.equal(review.state.review.c.scope, 'delta');
 const prepared = stepDesignRevision(review.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: review.effects[0]!.id, hash, parsed: design, defects: [], governing: { pinned: governingSpec.hash, current: governingSpec.hash, design: null, reqIds: [] } });
 const effect = prepared.effects[0]; assert.ok(effect?.kind === 'prepare-review');
 assert.equal(effect.round, 3); assert.equal(effect.scope['scope'], 'delta'); assert.equal(effect.scope['sinceHash'], hash); assert.equal(effect.scope['priorTarget'], 'x.design.md');
});
test('revision review later round takes policy scope', () => {
 const { review } = governedRevision(); assert.ok(review.state.tag === 'review');
 const result = rebindReviewSpec(review.state.review, { path: governingSpec.path, hash: specUpdate.hash });
 assert.ok(result.state.tag === 'pin-check');
 const prepared = stepReview(result.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: result.effects[0]!.id, hash, parsed: design, defects: [], governing: { pinned: specUpdate.hash, current: specUpdate.hash, design: null, reqIds: [] } });
 assert.ok(prepared.effects[0]?.kind === 'prepare-review'); assert.equal(prepared.effects[0].scope['scope'], 'full');
 assert.equal(prepared.effects[0].scope['priorTarget'], undefined);
});
test('revision review stale after findings keeps history', () => {
 const initial = governedRevision(); let result = initial.review; assert.ok(result.state.tag === 'review');
 result = stepDesignRevision(result.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: result.effects[0]!.id, hash, parsed: design, defects: [], governing: { pinned: governingSpec.hash, current: governingSpec.hash, design: null, reqIds: [] } });
 result = stepDesignRevision(result.state, { type: 'REVIEW_PREPARED', effectId: result.effects[0]!.id, scope: {}, promptPaths: {} });
 result = stepDesignRevision(result.state, { type: 'WAVE_DONE', effectId: result.effects[0]!.id, round: 3, slots: [{ slot: 'codex[0]', state: 'success' }], findings: [{ id: 'R3-F001', severity: 'MUST', category: 'correctness', locus: 'x.design.md:L1', defect: 'Earlier revision finding', requiredChange: 'Keep invariant', sources: ['codex[0]'], scope: 'in' }] });
 result = stepDesignRevision(result.state, { type: 'RULINGS', rulings: { 'R3-F001': { ruling: 'reject', reason: 'Earlier revision ruling' } } });
 assert.ok(result.state.tag === 'review' && result.state.review.tag === 'pin-check');
 const files = new Map<string, string>([['x.design.md', '# Design\n']]);
 const ports = { fs: { exists: (file: string) => files.has(file), readText: (file: string) => files.get(file)!, writeAtomic: (file: string, text: string) => files.set(file, text) } } as unknown as Ports;
 const run = { verb: 'implement' as const, argument: 'x.design.md', slug: 'x' };
 const parent: DesignState = { tag: 'revision', c: result.state.c, child: result.state };
 rootMachine.render!({ tag: 'design', run, child: parent }, ports, '/session/.state/runs/run');
 const next = stepDesign(parent, specUpdate); assert.ok(next.state.tag === 'revision' && next.state.child.tag === 'author');
 const parsed = stepDesign(next.state, { type: 'AUTHORED', path: next.state.child.workingPath });
 let accepted = stepDesign(parsed.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: parsed.effects[0]!.id, hash: 'sha256:' + 'd'.repeat(64), parsed: design, defects: [] });
 assert.equal(accepted.effects[0]?.id, 'design.revision.review.s1.parse-artifact.1');
 assert.equal(accepted.state.c.revisionReviewRound, 3);
 accepted = stepDesign(accepted.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: accepted.effects[0]!.id, hash, parsed: design, defects: [], governing: { pinned: specUpdate.hash, current: specUpdate.hash, design: null, reqIds: [] } });
 accepted = stepDesign(accepted.state, { type: 'REVIEW_PREPARED', effectId: accepted.effects[0]!.id, scope: {}, promptPaths: {} });
 accepted = stepDesign(accepted.state, { type: 'WAVE_DONE', effectId: accepted.effects[0]!.id, round: 4, slots: [{ slot: 'codex[0]', state: 'success' }], findings: [{ id: 'R4-F001', severity: 'MUST', category: 'correctness', locus: 'x.design.md:L2', defect: 'Later revision finding', requiredChange: 'Keep invariant', sources: ['codex[0]'], scope: 'in' }] });
 rootMachine.render!({ tag: 'design', run, child: accepted.state }, ports, '/session/.state/runs/run');
 const log = [...files.entries()].find(([file]) => file.endsWith('.review-log.md'))?.[1] ?? '';
 for (const marker of ['Earlier revision finding', 'Earlier revision ruling', 'Later revision finding', 'design.revision.review.s1']) assert.ok(log.includes(marker), marker);
});

test('author quality reads match the shared consumer map after an integration contract conflict', () => {
  const state = integration();
  if (state.tag !== 'integration' || !('c' in state.review)) throw new Error('Expected integration review');
  state.review = { ...state.review, c: { ...state.review.c, findings: state.review.c.findings.map((row) => ({ ...row, severity: 'CONSIDER' })) } };
  const offered = stepDesign(state, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept', reason: '[shared-contract]' } } });
  const revision = stepDesign(offered.state, { type: 'DECISION', kind: 'opt-in', answer: [] }).state;
  assert.ok(revision.tag === 'revision' && revision.child.tag === 'author');
  assert.deepEqual(designData(revision)['read'], [{ path: 'references/templates/quality-bar.md', sections: qualitySections.design }]);
});
