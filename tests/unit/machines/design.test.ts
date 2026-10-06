import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LevelGateScope, RunStartedEvent, ScopeProposal } from '../../../skills/dispatch/scripts/core/types.ts';
import { beginDesign, stepDesign, validateDesign, type DesignState } from '../../../skills/dispatch/scripts/machines/design.ts';
import type { ImplementState } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { stepDesignRevision } from '../../../skills/dispatch/scripts/machines/design-revision.ts';
import { asParsedDesign, designScopeGrew } from '../../../skills/dispatch/scripts/domain/design.ts';
import { rootMachine, stepRoot, type RootState } from '../../../skills/dispatch/scripts/machines/root.ts';
import { approvalState, FP } from './implement-recovery.test.ts';

export const hash = `sha256:${'a'.repeat(64)}`;
export const design = { title: 'Delivery', box: { 'TL;DR': 'Deliver feature' }, governedText: '# Delivery', executionStatus: null, increments: [{ id: 'I01', priority: 1, summary: 'First', prerequisites: [], paths: ['src/a.ts'] }, { id: 'I02', priority: 2, summary: 'Second', prerequisites: ['I01'], paths: ['src/b.ts'] }], details: { I01: { Outcome: 'First behavior' }, I02: { Outcome: 'Second behavior' } } };
export const run = (verb: 'design' | 'implement' = 'design'): RunStartedEvent => ({ type: 'RUN_STARTED', protocolRevision: 4, verb, argument: 'x.design.md', level: 'low', levelSource: 'explicit', pins: null, fix: true, orchestrator: 'claude', orchestratorModel: null, overrides: { sessionDir: '/session' }, repo: {}, config: { 'write-subagents': { claude: { low: { model: 'writer' } } }, 'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } }, phases: { 'design-review': { rounds: { low: 0 }, targets: { low: 1 } }, 'plan-review': { rounds: { low: 0 }, targets: { low: 1 } }, 'code-review': { rounds: { low: 0 }, targets: { low: 1 } } } } });
export function approval(verb: 'design' | 'implement' = 'design'): DesignState {
  let result = beginDesign(run(verb));
  if (result.state.tag === 'author') result = stepDesign(result.state, { type: 'AUTHORED', path: 'x.design.md' });
  result = stepDesign(result.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: result.effects[0]!.id, hash, parsed: design, defects: [] });
  return stepDesign(result.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: result.effects[0]!.id, hash, parsed: design, defects: [] }).state;
}
export function approveDesignScope(result: ReturnType<typeof stepDesign>): ReturnType<typeof stepDesign> {
  const state = result.state;
  if (state.tag !== 'revision') return result;
  let child = state.child;
  if (child.tag === 'scope-adjudication') {
    child = stepDesignRevision(child, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request: child.request, ruling: 'approve', rationale: 'The revised acceptance expands governed work.' } }).state;
  }
  if (child.tag !== 'resume') return result;
  const resumed = stepDesign({ ...state, child }, { type: 'LOCK_BROKEN', stalePid: 1 });
  return { ...result, state: resumed.state, effects: [...result.effects, ...resumed.effects] };
}
test('design-stops-at-approval: hash-bound authoring completes without production effects', () => {
  const state = approval();
  assert.equal(state.tag, 'approval');
  const result = stepDesign(state, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Approved', hash } });
  assert.equal(result.state.tag, 'complete');
  assert.deepEqual(result.effects, []);
});
test('design-governed-hash: stale or unattributed approval and lint failure cannot authorize delivery', () => {
  const state = approval('implement');
  for (const answer of [{ by: 'user', quote: 'yes', hash: `sha256:${'b'.repeat(64)}` }, { by: 'agent', quote: 'yes', hash }]) {
    const event = { type: 'DECISION' as const, kind: 'approval' as const, answer };
    assert.match(validateDesign(state, event)!, /current governed hash/);
    assert.equal(stepDesign(state, event).state, state);
  }
  const parsing = stepDesign(beginDesign(run()).state, { type: 'AUTHORED', path: 'x.design.md' });
  assert.equal(stepDesign(parsing.state, { type: 'ARTIFACT_PARSED', effectId: parsing.effects[0]!.id, kind: 'design', hash, parsed: design, defects: [{ message: 'lint' }] }).state.tag, 'author');
});
test('prewrite-level: author-only runs stop after invocation classification', () => {
  const state = approval('design');
  assert.equal(state.tag, 'approval');
  assert.equal(state.c.levelGatePassed, false);
  assert.equal(state.c.levelAssessment, null);
  assert.equal(state.c.scopeAdjustments.length, 0);
});
test('level-journal: design parent delegates nested implementation event validation', () => {
  const nested = {
    tag: 'tasks',
    c: {
      phase: 'tasks',
      tasks: { T1: { status: 'running', handle: null, attempt: 2, signature: 'current-signature', brief: { envelopePath: 'current.out' } } },
      writer: { models: ['writer'] },
    },
  } as unknown as ImplementState;
  const state: DesignState = { tag: 'increment', c: approval('implement').c, increment: 'I01', child: nested };
  const stale = { type: 'WRITE_LAUNCHED' as const, tasks: [{ task: 'T1', attempt: 1, signature: 'old-signature', handle: 'old-handle', model: 'writer' }] };
  assert.match(validateDesign(state, stale) ?? '', /projected attempt and signature/);
});
test('REVISE design waits for nested gates and drains writers before a stop', () => {
  const parent = approval('implement');
  if (parent.tag !== 'approval') throw new Error('design approval');
  const c = approvalState().c;
  const runInfo = { verb: 'design' as const, argument: 'x.design.md', slug: 'x' };
  const rootFor = (child: ImplementState): RootState => ({
    tag: 'design', run: runInfo, child: { tag: 'increment', c: parent.c, increment: 'I01', child },
  });
  const request: ScopeProposal = {
    requestId: 'design-scope', source: 'task', task: 'T1', baseArtifactHash: hash,
    writerRationale: 'The required behavior needs a companion module.',
    delta: { paths: ['src/extra.ts'], criteria: [], obligations: [], commands: [], phaseDuties: [], increments: [] },
  };
  const adjudication: ImplementState = { tag: 'scope-adjudication', c, request, task: 'T1', active: ['T2'], hotfixResume: null };
  const userDecision: ImplementState = { tag: 'scope-user-decision', c, request, task: 'T1', active: ['T2'], orchestratorRationale: 'I disagree with the expansion.', hotfixResume: null };
  const scopeRevisions = [adjudication, userDecision];
  const designRevision = { type: 'REVISE' as const, artifact: 'design' as const, reason: 'design-invalidates-increment', evidence: 'The accepted design scope must be reconsidered.' };
  for (const child of scopeRevisions) assert.match(rootMachine.validate!(rootFor(child), designRevision) ?? '', /Drain every active writer/);
  assert.equal(rootMachine.validate!(rootFor({ ...adjudication, active: [] }), designRevision), null);

  const gateScope: LevelGateScope = {
    planHash: hash, objective: 'Deliver feature', invariants: [], criteria: [], approvedPaths: [],
    commandMappings: [], baselineEvidence: [], phaseObligations: { writer: [], review: [] }, remainingIncrements: [], design: null,
  };
  const classification: ImplementState = { tag: 'level-classification', c, gateScope, resume: { kind: 'tasks' } };
  const recommendation: ImplementState = {
    tag: 'level-recommendation', c, assessment: { evaluatedLevel: 'high', rationale: 'Cross-cutting scope.', gateScope }, resume: { kind: 'tasks' },
  };
  for (const child of [classification, recommendation]) assert.match(rootMachine.validate!(rootFor(child), designRevision) ?? '', /pending level gate/);

  const runStop = { type: 'DECISION' as const, kind: 'run-stop' as const, answer: { by: 'user' as const, quote: 'Stop this run.' } };
  const scopedRoot = rootFor(adjudication);
  assert.equal(rootMachine.validate!(scopedRoot, runStop), null);
  const parked = stepRoot(scopedRoot, runStop);
  assert.equal(parked.state.tag, 'design');
  if (parked.state.tag !== 'design' || parked.state.child.tag !== 'increment' || parked.state.child.child.tag !== 'checking-host-event') throw new Error('expected the stop to be journaled before draining');
  const snapshot = parked.effects[0];
  assert.ok(snapshot?.kind === 'snapshot');
  if (snapshot?.kind !== 'snapshot') return;
  const drained = stepRoot(parked.state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: FP, diff: { paths: [] } });
  assert.equal(drained.state.tag, 'design');
  if (drained.state.tag !== 'design' || drained.state.child.tag !== 'increment') throw new Error('expected the design increment to remain active while writers drain');
  assert.equal(drained.state.child.child.tag, 'scope-draining');
});
test('post-review hash changes require approval of the reparsed hash', () => {
  const parsing = stepDesign(beginDesign(run()).state, { type: 'AUTHORED', path: 'x.design.md' });
  const reviewed = stepDesign(parsing.state, { type: 'ARTIFACT_PARSED', effectId: parsing.effects[0]!.id, kind: 'design', hash, parsed: design, defects: [] });
  const newer = `sha256:${'b'.repeat(64)}`;
  const state = stepDesign(reviewed.state, { type: 'ARTIFACT_PARSED', effectId: reviewed.effects[0]!.id, kind: 'design', hash: newer, parsed: design, defects: [] }).state;
  assert.equal(state.c.hash, newer);
  assert.ok(validateDesign(state, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'old', hash } }));
});

test('journal design admission rejects malformed objectives and dependency graphs', () => {
  assert.ok(asParsedDesign(design));
  const rows = design.increments;
  const invalid = [
    { ...design, box: {} }, { ...design, box: { 'TL;DR': ' ' } },
    { ...design, increments: [{ ...rows[0]!, paths: [] }, rows[1]!] },
    { ...design, increments: [rows[0]!, { ...rows[1]!, id: 'I01' }] },
    { ...design, increments: [rows[0]!, { ...rows[1]!, priority: 1 }] },
    { ...design, increments: [{ ...rows[0]!, prerequisites: ['I99'] }, rows[1]!] },
    { ...design, increments: [{ ...rows[0]!, prerequisites: ['I02'] }, rows[1]!] },
    { ...design, increments: [rows[1]!] },
  ];
  for (const payload of invalid) assert.equal(asParsedDesign(payload), null);
});

test('re-requests approval when increment scope expands', () => {
  const state = approval('implement');
  const baseline = '1111111111111111111111111111111111111111';
  let s = stepDesign(state, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Approved', hash } });
  assert.equal(s.state.tag, 'baseline');
  s = stepDesign(s.state, { type: 'SNAPSHOT', effectId: s.effects[0]!.id, fingerprint: { head: baseline, index: '0'.repeat(40), worktree: '0'.repeat(40) }, diff: { paths: [] } });
  assert.equal(s.state.tag, 'increment');
  assert.equal(s.state.c.baseline, baseline);
  s = stepDesign(s.state, { type: 'SNAPSHOT', effectId: s.effects[0]!.id, fingerprint: { head: baseline, index: '0'.repeat(40), worktree: '0'.repeat(40) }, diff: { paths: [] } });

  let rev = stepDesign(s.state, { type: 'REVISE', artifact: 'design', reason: 'scope expansion', evidence: 'test' });
  assert.equal(rev.state.tag, 'revision');

  const expandedDesign = {
    ...design,
    increments: [{ ...design.increments[0]!, paths: ['src/a.ts', 'src/expanded.ts'] }, design.increments[1]!],
  };
  const newHash = `sha256:${'c'.repeat(64)}`;
  rev = stepDesign(rev.state, { type: 'AUTHORED', path: '/session/revision-1.design.md' });
  rev = stepDesign(rev.state, {
    type: 'ARTIFACT_PARSED',
    kind: 'design',
    effectId: rev.effects[0]!.id,
    hash: newHash,
    parsed: expandedDesign,
    defects: [],
  });
  const pending = stepDesign(rev.state, {
    type: 'ARTIFACT_PARSED',
    kind: 'design',
    effectId: rev.effects[0]!.id,
    hash: newHash,
    parsed: expandedDesign,
    defects: [],
  });
  const resumed = approveDesignScope(pending);
  assert.equal(resumed.state.tag, 'approval');
  if (resumed.state.tag !== 'approval') throw new Error('approval');
  assert.equal(resumed.state.c.baseline, baseline);
  assert.equal(resumed.state.c.approval, null);

  const approved = stepDesign(resumed.state, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Re-approved', hash: newHash } });
  assert.equal(approved.state.tag, 'increment');
  assert.equal(approved.state.c.baseline, baseline);
});

test('invalidates completed increments when shared architecture changes', () => {
  const state = approval('implement');
  const baseline = '1111111111111111111111111111111111111111';
  let s = stepDesign(state, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Approved', hash } });
  s = stepDesign(s.state, { type: 'SNAPSHOT', effectId: s.effects[0]!.id, fingerprint: { head: baseline, index: '0'.repeat(40), worktree: '0'.repeat(40) }, diff: { paths: [] } });
  assert.equal(s.state.tag, 'increment');
  s = stepDesign(s.state, { type: 'SNAPSHOT', effectId: s.effects[0]!.id, fingerprint: { head: baseline, index: '0'.repeat(40), worktree: '0'.repeat(40) }, diff: { paths: [] } });

  const withCompleted: DesignState = {
    ...s.state,
    c: { ...s.state.c, completed: ['I01'], ownership: { I01: ['src/a.ts'] } },
  };

  let rev = stepDesign(withCompleted, { type: 'REVISE', artifact: 'design', reason: 'architecture update', evidence: 'test' });
  assert.equal(rev.state.tag, 'revision');

  const alteredDesign = {
    ...design,
    governedText: '# Delivery\n\n## Goals & Requirements\nAltered global goals\n\n## Architecture & Boundaries\nAltered boundary\n\n## Increment Dependency Graph\n\n## Increment Details\n',
  };
  const newHash = `sha256:${'d'.repeat(64)}`;
  rev = stepDesign(rev.state, { type: 'AUTHORED', path: '/session/revision-1.design.md' });
  rev = stepDesign(rev.state, {
    type: 'ARTIFACT_PARSED',
    kind: 'design',
    effectId: rev.effects[0]!.id,
    hash: newHash,
    parsed: alteredDesign,
    defects: [],
  });
  const resumed = approveDesignScope(stepDesign(rev.state, {
    type: 'ARTIFACT_PARSED',
    kind: 'design',
    effectId: rev.effects[0]!.id,
    hash: newHash,
    parsed: alteredDesign,
    defects: [],
  }));
  assert.deepEqual(resumed.state.c.completed, []);
});

test('preserves completed increments when only increment details or non-contract prose change', () => {
  const state = approval('implement');
  const baseline = '1111111111111111111111111111111111111111';
  let s = stepDesign(state, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Approved', hash } });
  s = stepDesign(s.state, { type: 'SNAPSHOT', effectId: s.effects[0]!.id, fingerprint: { head: baseline, index: '0'.repeat(40), worktree: '0'.repeat(40) }, diff: { paths: [] } });
  assert.equal(s.state.tag, 'increment');
  s = stepDesign(s.state, { type: 'SNAPSHOT', effectId: s.effects[0]!.id, fingerprint: { head: baseline, index: '0'.repeat(40), worktree: '0'.repeat(40) }, diff: { paths: [] } });

  const baseDesign = {
    ...design,
    governedText: '# Delivery\n\n## Context & Intent\nOriginal background context\n\n## Goals & Requirements\nOriginal goals\n\n## Architecture & Boundaries\nOriginal boundary\n\n## Increment Dependency Graph\n\n## Increment Details\n\n## Final Integration\n',
  };
  const withCompleted: DesignState = {
    ...s.state,
    c: { ...s.state.c, design: baseDesign, completed: ['I01'], ownership: { I01: ['src/a.ts'] } },
  };

  let rev = stepDesign(withCompleted, { type: 'REVISE', artifact: 'design', reason: 'details update', evidence: 'test' });
  assert.equal(rev.state.tag, 'revision');

  const detailsOnlyDesign = {
    ...design,
    details: {
      ...design.details,
      I02: { ...design.details.I02, Scope: 'Modified scope for I02' },
    },
    governedText: '# Delivery\n\n## Context & Intent\nUpdated non-contract background context\n\n## Goals & Requirements\nOriginal goals\n\n## Architecture & Boundaries\nOriginal boundary\n\n## Increment Dependency Graph\n\n## Increment Details\n\n## Final Integration\n',
  };
  const newHash = `sha256:${'e'.repeat(64)}`;
  rev = stepDesign(rev.state, { type: 'AUTHORED', path: '/session/revision-1.design.md' });
  rev = stepDesign(rev.state, {
    type: 'ARTIFACT_PARSED',
    kind: 'design',
    effectId: rev.effects[0]!.id,
    hash: newHash,
    parsed: detailsOnlyDesign,
    defects: [],
  });
  const resumed = approveDesignScope(stepDesign(rev.state, {
    type: 'ARTIFACT_PARSED',
    kind: 'design',
    effectId: rev.effects[0]!.id,
    hash: newHash,
    parsed: detailsOnlyDesign,
    defects: [],
  }));
  assert.deepEqual(resumed.state.c.completed, ['I01']);
  assert.deepEqual(resumed.state.c.ownership, { I01: ['src/a.ts'] });
});

test('designScopeGrew compares validation case-insensitively', () => {
  const before = {
    ...design,
    details: {
      I01: { Outcome: 'First behavior', validation: 'npm test -- a' },
      I02: { Outcome: 'Second behavior' },
    },
  };
  const sameCased = {
    ...design,
    details: {
      I01: { Outcome: 'First behavior', Validation: 'npm test -- a' },
      I02: { Outcome: 'Second behavior' },
    },
  };
  const changedVal = {
    ...design,
    details: {
      I01: { Outcome: 'First behavior', Validation: 'npm test -- a and b' },
      I02: { Outcome: 'Second behavior' },
    },
  };
  assert.equal(designScopeGrew(before, sameCased), false);
  assert.equal(designScopeGrew(before, changedVal), true);
});

test('approval of invalidating expansion restarts delivery rather than resuming obsolete child', () => {
  const state = approval('implement');
  const baseline = '1111111111111111111111111111111111111111';
  let s = stepDesign(state, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Approved', hash } });
  s = stepDesign(s.state, { type: 'SNAPSHOT', effectId: s.effects[0]!.id, fingerprint: { head: baseline, index: '0'.repeat(40), worktree: '0'.repeat(40) }, diff: { paths: [] } });
  assert.equal(s.state.tag, 'increment');
  s = stepDesign(s.state, { type: 'SNAPSHOT', effectId: s.effects[0]!.id, fingerprint: { head: baseline, index: '0'.repeat(40), worktree: '0'.repeat(40) }, diff: { paths: [] } });

  let rev = stepDesign(s.state, { type: 'REVISE', artifact: 'design', reason: 'contract update', evidence: 'test' });
  const updatedDesign = {
    ...design,
    details: {
      I01: { Outcome: 'Updated outcome for I01', 'Affected contracts': 'New contract' },
      I02: { Outcome: 'Second behavior' },
    },
    increments: [{ ...design.increments[0]!, paths: ['src/a.ts', 'src/new-path.ts'] }, design.increments[1]!],
  };
  const newHash = `sha256:${'f'.repeat(64)}`;
  rev = stepDesign(rev.state, { type: 'AUTHORED', path: '/session/revision-1.design.md' });
  rev = stepDesign(rev.state, {
    type: 'ARTIFACT_PARSED',
    kind: 'design',
    effectId: rev.effects[0]!.id,
    hash: newHash,
    parsed: updatedDesign,
    defects: [],
  });
  const resumed = approveDesignScope(stepDesign(rev.state, {
    type: 'ARTIFACT_PARSED',
    kind: 'design',
    effectId: rev.effects[0]!.id,
    hash: newHash,
    parsed: updatedDesign,
    defects: [],
  }));
  assert.equal(resumed.state.tag, 'approval');

  const approved = stepDesign(resumed.state, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Re-approved', hash: newHash } });
  assert.equal(approved.state.tag, 'increment');
  const child = approved.state.child;
  assert.ok('c' in child && child.c?.designBinding);
  assert.deepEqual(child.c.designBinding.paths, ['src/a.ts', 'src/new-path.ts']);
  assert.equal(child.c.designBinding.contract['Outcome'], 'Updated outcome for I01');
  assert.equal(child.c.designBinding.contract['Affected contracts'], 'New contract');
});

test('expansion followed by non-expanding revision before approval preserves suspended increment and awaits consent', () => {
  const state = approval('implement');
  const baseline = '1111111111111111111111111111111111111111';
  let s = stepDesign(state, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Approved', hash } });
  s = stepDesign(s.state, { type: 'SNAPSHOT', effectId: s.effects[0]!.id, fingerprint: { head: baseline, index: '0'.repeat(40), worktree: '0'.repeat(40) }, diff: { paths: [] } });
  assert.equal(s.state.tag, 'increment');
  s = stepDesign(s.state, { type: 'SNAPSHOT', effectId: s.effects[0]!.id, fingerprint: { head: baseline, index: '0'.repeat(40), worktree: '0'.repeat(40) }, diff: { paths: [] } });

  // 1. Revision 1 expands scope (adds path)
  let rev1 = stepDesign(s.state, { type: 'REVISE', artifact: 'design', reason: 'scope expansion', evidence: 'test' });
  const expandedDesign = {
    ...design,
    increments: [{ ...design.increments[0]!, paths: ['src/a.ts', 'src/expanded.ts'] }, design.increments[1]!],
  };
  const hash1 = `sha256:${'1'.repeat(64)}`;
  rev1 = stepDesign(rev1.state, { type: 'AUTHORED', path: '/session/revision-1.design.md' });
  rev1 = stepDesign(rev1.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: rev1.effects[0]!.id, hash: hash1, parsed: expandedDesign, defects: [] });
  const pending1 = approveDesignScope(stepDesign(rev1.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: rev1.effects[0]!.id, hash: hash1, parsed: expandedDesign, defects: [] }));
  assert.equal(pending1.state.tag, 'approval');
  assert.equal(pending1.state.c.approval, null);

  // 2. Revision 2 before user approval: non-expanding edit (e.g. non-contract prose tweak)
  let rev2 = stepDesign(pending1.state, { type: 'REVISE', artifact: 'design', reason: 'prose tweak', evidence: 'test' });
  assert.equal(rev2.state.tag, 'revision');
  const tweakedDesign = {
    ...expandedDesign,
    governedText: '# Delivery\n\n## Context & Intent\nTweaked prose\n\n## Goals & Requirements\nSame\n\n## Architecture & Boundaries\nSame\n\n## Increment Dependency Graph\n\n## Increment Details\n\n## Final Integration\n',
  };
  const hash2 = `sha256:${'2'.repeat(64)}`;
  rev2 = stepDesign(rev2.state, { type: 'AUTHORED', path: '/session/revision-2.design.md' });
  rev2 = stepDesign(rev2.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: rev2.effects[0]!.id, hash: hash2, parsed: tweakedDesign, defects: [] });
  const pending2 = approveDesignScope(stepDesign(rev2.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: rev2.effects[0]!.id, hash: hash2, parsed: tweakedDesign, defects: [] }));

  // Must remain in approval state awaiting consent, not crashing via deliver()
  assert.equal(pending2.state.tag, 'approval');
  assert.equal(pending2.state.c.approval, null);
  assert.equal(pending2.state.c.baseline, baseline);

  // 3. User approves revision 2
  const approved = stepDesign(pending2.state, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Approved both', hash: hash2 } });
  assert.equal(approved.state.tag, 'increment');
  const child = approved.state.child;
  assert.ok('c' in child && child.c?.designBinding);
  assert.deepEqual(child.c.designBinding.paths, ['src/a.ts', 'src/expanded.ts']);
});

test('intervening invalidating expansion followed by non-contract edit restarts delivery upon approval', () => {
  const state = approval('implement');
  const baseline = '1111111111111111111111111111111111111111';
  let s = stepDesign(state, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Approved', hash } });
  s = stepDesign(s.state, { type: 'SNAPSHOT', effectId: s.effects[0]!.id, fingerprint: { head: baseline, index: '0'.repeat(40), worktree: '0'.repeat(40) }, diff: { paths: [] } });
  assert.equal(s.state.tag, 'increment');
  s = stepDesign(s.state, { type: 'SNAPSHOT', effectId: s.effects[0]!.id, fingerprint: { head: baseline, index: '0'.repeat(40), worktree: '0'.repeat(40) }, diff: { paths: [] } });

  // 1. Revision 1: Validation expansion invalidates I01 and requires consent
  let rev1 = stepDesign(s.state, { type: 'REVISE', artifact: 'design', reason: 'validation expansion', evidence: 'test' });
  const expandedDesign = {
    ...design,
    details: {
      I01: { Outcome: 'First behavior', Validation: 'npm test -- a and b' },
      I02: { Outcome: 'Second behavior' },
    },
  };
  const hash1 = `sha256:${'3'.repeat(64)}`;
  rev1 = stepDesign(rev1.state, { type: 'AUTHORED', path: '/session/revision-1.design.md' });
  rev1 = stepDesign(rev1.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: rev1.effects[0]!.id, hash: hash1, parsed: expandedDesign, defects: [] });
  const pending1 = approveDesignScope(stepDesign(rev1.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: rev1.effects[0]!.id, hash: hash1, parsed: expandedDesign, defects: [] }));
  assert.equal(pending1.state.tag, 'approval');

  // 2. Revision 2: non-contract background prose edit before approval (no new invalidations in rev 2)
  let rev2 = stepDesign(pending1.state, { type: 'REVISE', artifact: 'design', reason: 'prose tweak', evidence: 'test' });
  const proseDesign = {
    ...expandedDesign,
    governedText: '# Delivery\n\n## Context & Intent\nNon-contract background prose edit\n\n## Goals & Requirements\nOriginal goals\n\n## Architecture & Boundaries\nOriginal boundary\n\n## Increment Dependency Graph\n\n## Increment Details\n\n## Final Integration\n',
  };
  const hash2 = `sha256:${'4'.repeat(64)}`;
  rev2 = stepDesign(rev2.state, { type: 'AUTHORED', path: '/session/revision-2.design.md' });
  rev2 = stepDesign(rev2.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: rev2.effects[0]!.id, hash: hash2, parsed: proseDesign, defects: [] });
  const pending2 = approveDesignScope(stepDesign(rev2.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: rev2.effects[0]!.id, hash: hash2, parsed: proseDesign, defects: [] }));
  assert.equal(pending2.state.tag, 'approval');

  // 3. User approves revision 2. Delivery must restart with a fresh child bound to hash2, NOT resume obsolete child
  const approved = stepDesign(pending2.state, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Approved both', hash: hash2 } });
  assert.equal(approved.state.tag, 'increment');
  const child = approved.state.child;
  assert.ok('c' in child && child.c?.designBinding);
  assert.equal(child.c.designBinding.revision, hash2);
  // Freshly bound child has clean plan/evidence state
  assert.equal(child.c.plan, null);
});

test('revert after invalidating revision resets binding index so later non-invalidating revision preserves fresh child progress', () => {
  const state = approval('implement');
  const baseline = '1111111111111111111111111111111111111111';
  let s = stepDesign(state, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Approved', hash } });
  s = stepDesign(s.state, { type: 'SNAPSHOT', effectId: s.effects[0]!.id, fingerprint: { head: baseline, index: '0'.repeat(40), worktree: '0'.repeat(40) }, diff: { paths: [] } });
  assert.equal(s.state.tag, 'increment');
  s = stepDesign(s.state, { type: 'SNAPSHOT', effectId: s.effects[0]!.id, fingerprint: { head: baseline, index: '0'.repeat(40), worktree: '0'.repeat(40) }, diff: { paths: [] } });

  const baseDesign = {
    ...design,
    governedText: '# Delivery\n\n## Context & Intent\nOriginal background context\n\n## Goals & Requirements\nOriginal goals\n\n## Architecture & Boundaries\nOriginal boundary\n\n## Increment Dependency Graph\n\n## Increment Details\n\n## Final Integration\n',
  };
  const hashBase = `sha256:${'a'.repeat(64)}`;

  // 1. Revision 1 (hash -> hashB): invalidating revision (Validation expanded)
  let rev1 = stepDesign(s.state, { type: 'REVISE', artifact: 'design', reason: 'validation expansion', evidence: 'test' });
  const designB = {
    ...baseDesign,
    details: {
      I01: { Outcome: 'First behavior', Validation: 'npm test -- expanded' },
      I02: { Outcome: 'Second behavior' },
    },
  };
  const hashB = `sha256:${'b'.repeat(64)}`;
  rev1 = stepDesign(rev1.state, { type: 'AUTHORED', path: '/session/revision-1.design.md' });
  rev1 = stepDesign(rev1.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: rev1.effects[0]!.id, hash: hashB, parsed: designB, defects: [] });
  const pending1 = approveDesignScope(stepDesign(rev1.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: rev1.effects[0]!.id, hash: hashB, parsed: designB, defects: [] }));
  assert.equal(pending1.state.tag, 'approval');

  // 2. Revision 2 (hashB -> hashBase): revert back to original design
  let rev2 = stepDesign(pending1.state, { type: 'REVISE', artifact: 'design', reason: 'revert', evidence: 'test' });
  rev2 = stepDesign(rev2.state, { type: 'AUTHORED', path: '/session/revision-2.design.md' });
  rev2 = stepDesign(rev2.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: rev2.effects[0]!.id, hash: hashBase, parsed: baseDesign, defects: [] });
  const pending2 = approveDesignScope(stepDesign(rev2.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: rev2.effects[0]!.id, hash: hashBase, parsed: baseDesign, defects: [] }));

  // 3. User approves reverted design: fresh child is delivered at revision index 2
  let delivered = stepDesign(pending2.state, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Approved revert', hash: hashBase } });
  assert.equal(delivered.state.tag, 'increment');
  if (delivered.state.tag !== 'increment') throw new Error('expected increment');
  delivered = stepDesign(delivered.state, { type: 'SNAPSHOT', effectId: delivered.effects[0]!.id, fingerprint: { head: baseline, index: '0'.repeat(40), worktree: '0'.repeat(40) }, diff: { paths: [] } });
  if (delivered.state.tag !== 'increment') throw new Error('expected increment');
  let freshChild = delivered.state.child;
  assert.ok('c' in freshChild && freshChild.c?.designBinding);
  assert.equal(freshChild.c.designBinding.revision, hashBase);
  assert.equal(freshChild.c.designBinding.revisionIndex, 2);

  // 4. Fresh child makes progress (e.g. record some evidence or changed state)
  const modifiedChild = {
    ...freshChild,
    c: {
      ...freshChild.c,
      evidence: { C01: { status: 'pass', command: 'npm test', exit: 0 } as any },
    },
  };
  const withProgress: DesignState = {
    ...delivered.state,
    child: modifiedChild as any,
  };

  // 5. Revision 3 (hashBase -> hashC): non-invalidating prose edit
  const designC = {
    ...baseDesign,
    governedText: '# Delivery\n\n## Context & Intent\nMinor background prose update\n\n## Goals & Requirements\nOriginal goals\n\n## Architecture & Boundaries\nOriginal boundary\n\n## Increment Dependency Graph\n\n## Increment Details\n\n## Final Integration\n',
  };
  const hashC = `sha256:${'c'.repeat(64)}`;
  let rev3 = stepDesign(withProgress, { type: 'REVISE', artifact: 'design', reason: 'prose update', evidence: 'test' });
  rev3 = stepDesign(rev3.state, { type: 'AUTHORED', path: '/session/revision-3.design.md' });
  rev3 = stepDesign(rev3.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: rev3.effects[0]!.id, hash: hashC, parsed: designC, defects: [] });
  const resumed3 = stepDesign(rev3.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: rev3.effects[0]!.id, hash: hashC, parsed: designC, defects: [] });

  // 6. Non-invalidating revision preserves the fresh child's progress!
  assert.equal(resumed3.state.tag, 'increment');
  const resumedChild = resumed3.state.child;
  assert.ok('c' in resumedChild && resumedChild.c?.designBinding);
  assert.equal(resumedChild.c.designBinding.revision, hashC);
  assert.ok('C01' in resumedChild.c.evidence);
});

test('design: default design path is scoped to sessionDir', () => {
  const s = beginDesign({
    ...run(),
    argument: 'Deliver feature',
    overrides: { sessionDir: '/workspace/.scratch/dispatch-skills/20261001T0000Z-my-design' },
  });
  assert.equal(s.state.tag, 'author');
  if (s.state.tag === 'author') {
    assert.equal(s.state.c.path, '/workspace/.scratch/dispatch-skills/20261001T0000Z-my-design/deliver-feature.design.md');
  }

  // Explicit argument ending in .design.md is preserved
  const explicit = beginDesign({
    ...run(),
    argument: 'custom/external.design.md',
    overrides: { sessionDir: '/workspace/.scratch/dispatch-skills/20261001T0000Z-my-design' },
  });
  assert.equal(explicit.state.tag, 'author');
  if (explicit.state.tag === 'author') {
    assert.equal(explicit.state.c.path, 'custom/external.design.md');
  }
});





