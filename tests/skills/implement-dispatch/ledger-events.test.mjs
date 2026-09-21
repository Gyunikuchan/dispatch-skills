import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canonicalJson,
  foldEvents,
  foldDesignRun,
  nextDesignAction,
  parseEventLine,
  selectOrdinarySegment,
  selectDesignSegment,
  serializeEvent,
} from '../../../skills/implement-dispatch/scripts/ledger-events.mjs';

const runId = '11111111-1111-4111-8111-111111111111';
const hash = `sha256:${'a'.repeat(64)}`;
const state = `sha256:${'b'.repeat(64)}`;
const oid = 'c'.repeat(40);
const at = '2026-09-20T00:00:00.000Z';
const event = (seq, type, data) => ({ v: 1, seq, type, runId, at, data });
const start = (seq = 1, governingHash = hash) => event(seq, 'run-start', {
  governingPath: '.scratch/plan/2026-09-20-example.md',
  governingHash,
  rootSlug: 'example',
  action: 'ordinary',
  baseline: { commit: oid, repositoryState: state, dirtyPaths: [] },
});
const approval = (seq, governingHash = hash) => event(seq, 'approval', {
  governingHash, decision: 'approved', actor: 'user',
});

describe('canonical ledger events', () => {
  it('sorts keys, NFC-normalizes non-path strings, and preserves path strings', () => {
    assert.equal(
      canonicalJson({ z: 'e\u0301', paths: ['e\u0301.txt'], a: 1 }),
      '{"a":1,"paths":["é.txt"],"z":"é"}',
    );
  });

  it('serializes and parses one newline-terminated markdown row', () => {
    const line = serializeEvent(start());
    assert.match(line, /^- event: \{"at":/);
    assert.ok(line.endsWith('\n'));
    assert.deepEqual(parseEventLine(line.trimEnd()), start());
  });

  it('round-trips v2 design repair markers and rejects invalid second events', () => {
    const designStart = { ...start(), v: 2, data: { ...start().data, action: 'design', governingPath: '.scratch/plan/2026-09-20-example-design.md', repair: true } };
    assert.deepEqual(parseEventLine(serializeEvent(designStart).trimEnd()), designStart);
    assert.throws(() => foldEvents([designStart, { ...approval(2), v: 2, data: { ...approval(2).data, decision: 'approved' } }]), /reconciliation/);
    const ruling = event(2, 'ruling', { key: 'reconciliation', decision: 'accept-repair', reason: 'reviewed', costIfWrong: 'n/a', state: 'resolved' });
    assert.equal(foldEvents([designStart, { ...ruling, v: 2 }]).version, 2);
  });

  it('rejects unknown properties, versions, types, and non-integer numbers', () => {
    assert.throws(() => serializeEvent({ ...start(), extra: true }), /unknown/);
    assert.throws(() => serializeEvent({ ...start(), v: 2 }), /version/);
    assert.throws(() => serializeEvent({ ...start(), type: 'increment-state' }), /Unknown event type/);
    assert.throws(() => canonicalJson({ value: 1.5 }), /integers only/);
  });
});

describe('v1 fold', () => {
  it('reconstructs a completed task and keyed rulings', () => {
    const events = [
      start(),
      approval(2),
      event(3, 'ruling', { key: 'baseline-red', decision: 'proceed', reason: 'known red', costIfWrong: 'n/a', state: 'resolved' }),
      event(4, 'task-start', { taskId: 't1', attemptBudget: 2, paths: ['a.txt'], preState: state }),
      event(5, 'implementation-attempt', {
        taskId: 't1', attempt: 1, launch: 'full', target: { platform: 'copilot' },
        terminalEnvelope: {}, evidence: ['done'], transition: 'verify',
      }),
      event(6, 'verification', {
        taskId: 't1', attempt: 1, result: 'pass', commandRefs: ['test'], transition: 'complete',
      }),
      event(7, 'task-complete', {
        taskId: 't1', paths: ['a.txt'], head: oid, preState: state, resultState: state, diffHash: hash,
      }),
    ];
    const folded = foldEvents(events);
    assert.deepEqual([...folded.completedTasks.keys()], ['t1']);
    assert.equal(folded.rulings.get('baseline-red').decision, 'proceed');
  });

  it('preserves a red verification for same-attempt continuation', () => {
    const events = [
      start(),
      approval(2),
      event(3, 'task-start', { taskId: 't1', attemptBudget: 2, paths: ['a.txt'], preState: state }),
      event(4, 'implementation-attempt', {
        taskId: 't1', attempt: 1, launch: 'tests-only', target: { platform: 'copilot' },
        terminalEnvelope: {}, evidence: ['test'], transition: 'run-red',
      }),
      event(5, 'verification', {
        taskId: 't1', attempt: 1, result: 'red', failureIdentity: { id: 'expected' },
        commandRefs: ['test'], transition: 'continue',
      }),
      event(6, 'implementation-attempt', {
        taskId: 't1', attempt: 1, launch: 'continuation', target: { platform: 'copilot' },
        terminalEnvelope: {}, evidence: ['implementation'], transition: 'verify',
      }),
      event(7, 'verification', {
        taskId: 't1', attempt: 1, result: 'pass', commandRefs: ['test'], transition: 'complete',
      }),
      event(8, 'task-complete', {
        taskId: 't1', paths: ['a.txt'], head: oid, preState: state, resultState: state, diffHash: hash,
      }),
    ];
    const folded = foldEvents(events);
    assert.equal(folded.tasks.get('t1').latestAttempt, 1);
    assert.equal(folded.tasks.get('t1').complete, true);
  });

  it('rejects illegal ordering and sequence duplication', () => {
    assert.throws(() => foldEvents([event(1, 'approval', { governingHash: hash, decision: 'approved', actor: 'user' })]), /run-start/);
    assert.throws(() => foldEvents([start(), { ...start(), seq: 1 }]), /strictly increase/);
    assert.throws(() => foldEvents([
      start(),
      approval(2),
      event(3, 'task-start', { taskId: 't1', attemptBudget: 1, paths: ['a'], preState: state }),
      event(4, 'task-complete', { taskId: 't1', paths: ['a'], head: oid, preState: state, resultState: state, diffHash: hash }),
    ]), /complete verification/);
  });

  it('selects newest matching design segment and skips only resolved repair', () => {
    const design = { ...start(), v: 2, data: { ...start().data, action: 'design', governingPath: '.scratch/plan/2026-09-20-example-design.md' } };
    const approval2 = { ...approval(2), v: 2 };
    const newerId = '22222222-2222-4222-8222-222222222222';
    const newer = [{ ...design, seq: 3, runId: newerId }, { ...approval2, seq: 4, runId: newerId }];
    assert.equal(selectDesignSegment([design, approval2, ...newer], hash).runId, newerId);

    const repairId = '33333333-3333-4333-8333-333333333333';
    const repair = state => [
      { ...design, seq: 5, runId: repairId, data: { ...design.data, repair: true } },
      { v: 2, seq: 6, type: 'ruling', runId: repairId, at, data: { key: 'reconciliation', decision: 'repair', reason: 'tail', costIfWrong: 'drift', state } },
    ];
    assert.equal(selectDesignSegment([design, approval2, ...newer, ...repair('resolved')], hash).runId, newerId);
    for (const stateName of ['open', 'superseded']) {
      const selected = selectDesignSegment([design, approval2, ...newer, ...repair(stateName)], hash);
      assert.equal(selected.runId, repairId);
      assert.equal(selected.needsReconciliation, true);
    }
  });

  it('selects only the latest matching unterminated segment', () => {
    const other = `sha256:${'d'.repeat(64)}`;
    const first = [start(1), approval(2), event(3, 'run-complete', { result: 'complete', evidenceRefs: [] })];
    const secondId = '22222222-2222-4222-8222-222222222222';
    const thirdId = '33333333-3333-4333-8333-333333333333';
    const second = [{ ...start(4, other), runId: secondId }, { ...approval(5, other), runId: secondId }];
    const third = [{ ...start(6), runId: thirdId }, { ...approval(7), runId: thirdId }];
    assert.equal(selectOrdinarySegment([...first, ...second, ...third], hash).runId, third[0].runId);
    assert.equal(selectOrdinarySegment([...first, ...second], hash), null);
  });
});

describe('v2 phased ledger events', () => {
  const designPath = '.scratch/plan/2026-09-20-demo-design.md';
  const revision = hash;
  const laterRevision = `sha256:${'e'.repeat(64)}`;
  const designStart = (seq = 1, governingHash = hash, overrides = {}) => ({
    ...event(seq, 'run-start', {
      governingPath: designPath,
      governingHash,
      rootSlug: 'demo',
      action: 'design',
      baseline: { commit: oid, repositoryState: state, dirtyPaths: [] },
      ...overrides,
    }),
    v: 2,
  });
  const designApproval = (seq, governingHash = hash) => ({ ...event(seq, 'approval', { governingHash, decision: 'approved', actor: 'user' }), v: 2 });
  const incrementStart = (seq, overrides = {}) => ({
    ...event(seq, 'run-start', {
      governingPath: designPath,
      governingHash: revision,
      rootSlug: 'demo',
      action: 'increment',
      baseline: { commit: oid, repositoryState: state, dirtyPaths: [] },
      design: { path: designPath, revision },
      increment: {
        id: 'I01',
        planPath: '.scratch/plan/2026-09-20-demo-i01-one-plan.md',
        walkthroughPath: '.scratch/plan/2026-09-20-demo-i01-one-walkthrough.md',
        planHash: hash,
      },
      ...overrides,
    }),
    v: 2,
  });
  const v2 = ev => ({ ...ev, v: 2 });
  const taskStart = (seq, increment = false) => v2(event(seq, 'task-start', {
    taskId: increment ? 'I01-task' : 't1', attemptBudget: 2, paths: ['a.txt'], preState: state,
  }));
  const attempt = (seq, launch = 'full', transition = 'verify') => v2(event(seq, 'implementation-attempt', {
    taskId: 't1', attempt: 1, launch, target: { platform: 'opencode' },
    terminalEnvelope: {}, evidence: ['work'], transition,
  }));
  const verification = (seq, result = 'pass', transition = 'complete') => v2(event(seq, 'verification', {
    taskId: 't1', attempt: 1, result, commandRefs: ['test'], transition,
    ...(result === 'red' ? { failureIdentity: { id: 'expected' } } : {}),
  }));
  const taskComplete = seq => v2(event(seq, 'task-complete', {
    taskId: 't1', paths: ['a.txt'], head: oid, preState: state, resultState: state, diffHash: hash,
  }));
  const incrementState = (seq, prior, next, overrides = {}) => v2(event(seq, 'increment-state', {
    incrementId: 'I01', prior, next, cause: 'amendment:A01', affectedDependents: [], ...overrides,
  }));
  const amendment = (seq, stateName, overrides = {}) => {
    const data = { amendmentId: 'A01', state: stateName, affectedIncrements: [], ...overrides };
    if (stateName === 'prepared') {
      data.baseRevision = revision;
      data.candidateHash = laterRevision;
      data.targetPath = designPath;
      data.replacementPath = `${designPath}.tmp`;
    }
    if (stateName === 'activated') {
      data.baseRevision = revision;
      data.candidateHash = laterRevision;
    }
    return v2(event(seq, 'amendment', data));
  };

  it('accepts v2 run-start for design, increment, and integration actions and validates bindings', () => {
    assert.equal(foldEvents([designStart()]).version, 2);
    const incrementSegment = [incrementStart(2), { ...designApproval(3, revision), v: 2 }, taskStart(4)];
    assert.doesNotThrow(() => foldEvents(incrementSegment));
    assert.throws(() => foldEvents([incrementStart(2, {
      design: { path: '.scratch/plan/other-design.md', revision },
    })]), /design\.path/);
    assert.throws(() => foldEvents([incrementStart(2, {
      increment: { id: 'I01', planPath: '.scratch/plan/2026-09-20-demo-i01-one-plan.md', walkthroughPath: '.scratch/plan/2026-09-20-demo-i01-one-walkthrough.md' },
    })]), /planHash/);
    assert.throws(() => foldEvents([incrementStart(2, {
      design: { path: designPath, revision },
      increment: {
        id: 'X1', planPath: '.scratch/plan/2026-09-20-demo-i01-one-plan.md',
        walkthroughPath: '.scratch/plan/2026-09-20-demo-i01-one-walkthrough.md', planHash: hash,
      },
    })]), /increment\.id/);
    assert.throws(() => foldEvents([{ ...start(1), v: 2 }]), /version/);
    assert.throws(() => foldEvents([{ ...designStart(), v: 1 }]), /Phased segments require ledger version 2/);
  });

  it('allows task events in v2 increment segments and rejects them in design and integration segments', () => {
    const integrationStart = { ...incrementStart(1), data: {
      ...incrementStart().data, action: 'integration', increment: undefined,
      design: { path: designPath, revision },
    } };
    delete integrationStart.data.increment;
    assert.throws(() => foldEvents([designStart(), { ...approval(2), v: 2 }, taskStart(3)]), /design segments|Task cannot start/);
    assert.throws(() => foldEvents([{ ...integrationStart, seq: 1 }, taskStart(2)]), /cannot contain implementation tasks/);
    assert.doesNotThrow(() => foldEvents([incrementStart(1), taskStart(2), attempt(3), verification(4), taskComplete(5)]));
  });

  it('derives approval from the design binding in increment segments without an approval event', () => {
    const folded = foldEvents([incrementStart(1), taskStart(2)]);
    assert.equal(folded.approved, true);
  });

  it('validates increment-state transitions and the activated-amendment guard', () => {
    assert.throws(() => foldEvents([incrementStart(1), incrementState(2, 'pending', 'complete')]), /Illegal increment-state transition/);
    assert.doesNotThrow(() => foldEvents([incrementStart(1), incrementState(2, 'pending', 'ready')]));
    assert.throws(() => foldEvents([incrementStart(1), incrementState(2, 'active', 'pending')]), /does not match folded state|Illegal/);
    assert.throws(() => foldEvents([
      incrementStart(1),
      incrementState(2, 'pending', 'ready'),
      incrementState(3, 'ready', 'active'),
      incrementState(4, 'active', 'invalidated'),
      incrementState(5, 'invalidated', 'pending'),
    ]), /activated amendment/);
    assert.doesNotThrow(() => foldEvents([
      incrementStart(1),
      amendment(2, 'proposed', { amendmentId: 'A01' }),
      amendment(3, 'reviewed', { amendmentId: 'A01' }),
      amendment(4, 'prepared', { amendmentId: 'A01' }),
      amendment(5, 'activated', { amendmentId: 'A01', affectedIncrements: ['I01'] }),
      incrementState(6, 'pending', 'ready'),
      incrementState(7, 'ready', 'active'),
      incrementState(8, 'active', 'invalidated'),
      incrementState(9, 'invalidated', 'pending'),
    ]));
  });

  it('enforces the amendment state machine and per-state key sets', () => {
    assert.doesNotThrow(() => foldEvents([incrementStart(1), amendment(2, 'proposed', { amendmentId: 'A01' })]));
    assert.throws(() => foldEvents([incrementStart(1), amendment(2, 'prepared', { amendmentId: 'A01' })]), /Illegal amendment state transition/);
    assert.throws(() => foldEvents([
      incrementStart(1),
      amendment(2, 'proposed', { amendmentId: 'A01' }),
      amendment(3, 'rejected', { amendmentId: 'A01' }),
      amendment(4, 'activated', { amendmentId: 'A01', baseRevision: revision, candidateHash: laterRevision }),
    ]), /terminal/);
    assert.throws(() => foldEvents([incrementStart(1), amendment(2, 'proposed', { amendmentId: 'A01', baseRevision: revision })]), /rejected on/);
    assert.throws(() => foldEvents([incrementStart(1), amendment(2, 'proposed', { amendmentId: 'A01' }), amendment(3, 'activated', { amendmentId: 'A01', baseRevision: revision, candidateHash: laterRevision })]), /Illegal amendment state transition/);
  });

  it('permits an amendment before any task event and inside integration segments', () => {
    assert.doesNotThrow(() => foldEvents([incrementStart(1), amendment(2, 'proposed', { amendmentId: 'A01' })]));
    const integrationStart = { ...incrementStart(1), data: {
      ...incrementStart().data, action: 'integration', design: { path: designPath, revision },
    } };
    delete integrationStart.data.increment;
    assert.doesNotThrow(() => foldEvents([{ ...integrationStart, v: 2 }, { ...amendment(2, 'proposed', { amendmentId: 'A01' }), v: 2 }]));
  });

  it('gates adjacent-fix and integration events on ordering and segment action', () => {
    assert.throws(() => foldEvents([incrementStart(1), v2(event(2, 'adjacent-fix', {
      findingIds: ['F1'], clusterId: 'C-aaaaaaaaaaaa', attempts: [1], result: 'complete',
    }))]), /adjacent-fix|cluster/);
    assert.doesNotThrow(() => foldEvents([
      incrementStart(1),
      v2(event(2, 'task-start', { taskId: 'C-aaaaaaaaaaaa', attemptBudget: 1, paths: ['b.txt'], preState: state })),
      v2(event(3, 'implementation-attempt', { taskId: 'C-aaaaaaaaaaaa', attempt: 1, launch: 'full', target: { platform: 'opencode' }, terminalEnvelope: {}, evidence: ['work'], transition: 'verify' })),
      v2(event(4, 'verification', { taskId: 'C-aaaaaaaaaaaa', attempt: 1, result: 'pass', commandRefs: ['test'], transition: 'complete' })),
      v2(event(5, 'task-complete', { taskId: 'C-aaaaaaaaaaaa', paths: ['b.txt'], head: oid, preState: state, resultState: state, diffHash: hash })),
      v2(event(6, 'adjacent-fix', { findingIds: ['F1'], clusterId: 'C-aaaaaaaaaaaa', attempts: [1], result: 'complete' })),
    ]));
    const integrationStart = { ...incrementStart(1), data: {
      ...incrementStart().data, action: 'integration', design: { path: designPath, revision },
    } };
    delete integrationStart.data.increment;
    assert.throws(() => foldEvents([v2({ ...integrationStart, seq: 1 }), v2(event(2, 'integration', {
      scopeId: 'final', verificationRefs: ['v1'], reviewRefs: [], result: 'pass',
    }))]), /integration events are only legal|verification\/review evidence/);
    assert.doesNotThrow(() => foldEvents([
      v2({ ...integrationStart, seq: 1 }),
      v2(event(2, 'review', { kind: 'integration', round: 1, counts: { accepted: 0, rejected: 0, resolvedDispute: 0, disputed: 0, pendingConfirmation: 0, unknown: 0 }, checkpointRef: 'cp1' })),
      v2(event(3, 'integration', { scopeId: 'final', verificationRefs: ['v1'], reviewRefs: ['r1'], result: 'pass' })),
      v2(event(4, 'run-complete', { result: 'complete', evidenceRefs: [] })),
    ]));
  });

  it('gates completed-task restart on reopening the owning increment', () => {
    const base = [
      incrementStart(1),
      taskStart(2),
      attempt(3),
      verification(4),
      taskComplete(5),
    ];
    assert.throws(() => foldEvents([...base, taskStart(6)]), /already started/);
    assert.doesNotThrow(() => foldEvents([
      ...base,
      incrementState(6, 'active', 'complete'),
      incrementState(7, 'complete', 'reopened', { cause: 'integration' }),
      taskStart(8),
    ]));
  });

  it('rejects events after a terminal event without an intervening run-start', () => {
    assert.throws(() => foldEvents([
      incrementStart(1),
      v2(event(2, 'run-complete', { result: 'complete', evidenceRefs: [] })),
      v2(event(3, 'ruling', { key: 'x', decision: 'd', reason: 'r', costIfWrong: 'n/a', state: 'open' })),
    ]), /run-complete must be the final event/);
  });

  it('folds a design run across segments and revisions', () => {
    const completed = [
      { ...incrementStart(1), seq: 1 },
      { ...taskStart(2), v: 2, seq: 2, data: { ...taskStart().data, taskId: 'I01-task' } },
      { ...attempt(3), v: 2, seq: 3, data: { ...attempt().data, taskId: 'I01-task' } },
      { ...verification(4), v: 2, seq: 4, data: { ...verification().data, taskId: 'I01-task' } },
      { ...event(5, 'task-complete', { taskId: 'I01-task', paths: ['a.txt'], head: oid, preState: state, resultState: state, diffHash: hash }), v: 2 },
      { ...event(6, 'run-complete', { result: 'complete', evidenceRefs: [] }), v: 2 },
    ];
    const secondId = '22222222-2222-4222-8222-222222222222';
    const reopened = [
      { ...incrementStart(7, { increment: { id: 'I02', planPath: '.scratch/plan/2026-09-20-demo-i02-two-plan.md', walkthroughPath: '.scratch/plan/2026-09-20-demo-i02-two-walkthrough.md', planHash: hash } }), runId: secondId, v: 2 },
      { ...event(8, 'run-complete', { result: 'complete', evidenceRefs: [] }), runId: secondId, v: 2 },
    ];
    const folded = foldDesignRun([designStart(), designApproval(2), ...completed, ...reopened]);
    assert.equal(folded.status, 'ok');
    assert.equal(folded.completedTasks.has('I01-task'), true);
    assert.ok(folded.incrementStates.get('I01'));
    assert.equal(nextDesignAction(folded).action, 'implement');
    assert.equal(nextDesignAction(folded).incrementId, 'I02');
  });

  it('derives nextDesignAction with total precedence', () => {
    const incrementStates = new Map([['I01', 'ready']]);
    const incomplete = { incrementStates, needsReconciliation: true };
    assert.equal(nextDesignAction(incomplete).action, 'resolve-reconciliation');
    const withPreparedAmendment = { incrementStates, amendments: new Map([['A01', { state: 'prepared' }]]) };
    assert.equal(nextDesignAction(withPreparedAmendment).action, 'resolve-amendment');
    const unterminatedIncrement = { incrementStates, activeIncrementId: 'I01', needsReconciliation: false, amendments: new Map() };
    assert.equal(nextDesignAction(unterminatedIncrement).action, 'resume-increment');
    const allComplete = { incrementStates: new Map([['I01', 'complete']]), needsReconciliation: false, amendments: new Map(), activeIncrementId: null, integrationPassed: false };
    assert.equal(nextDesignAction(allComplete).action, 'final-integration');
    assert.equal(nextDesignAction({ ...allComplete, integrationPassed: true }).action, 'complete');
    const reopenedAfterIntegration = {
      incrementStates: new Map([['I01', 'complete'], ['I02', 'reopened']]),
      needsReconciliation: false, amendments: new Map(), activeIncrementId: null, integrationPassed: true,
    };
    assert.equal(nextDesignAction(reopenedAfterIntegration).action, 'implement');
    assert.equal(nextDesignAction(reopenedAfterIntegration).incrementId, 'I02');
    const blockedWithNothingReady = {
      incrementStates: new Map([['I01', 'blocked']]),
      needsReconciliation: false, amendments: new Map(), activeIncrementId: null, integrationPassed: false,
    };
    assert.equal(nextDesignAction(blockedWithNothingReady).action, 'resolve-reconciliation');
    const priorityOverridesId = {
      incrementStates: new Map([['I01', 'ready'], ['I02', 'ready']]),
      incrementPriorities: new Map([['I01', 2], ['I02', 1]]),
      needsReconciliation: false, amendments: new Map(), activeIncrementId: null,
    };
    assert.equal(nextDesignAction(priorityOverridesId).incrementId, 'I02');
  });
});

describe('nextDesignAction empty graph', () => {
  it('never treats an empty increment map as all-complete', () => {
    const fold = { incrementStates: new Map(), needsReconciliation: false, amendments: new Map(), activeIncrementId: null };
    assert.equal(nextDesignAction(fold).action, 'resolve-reconciliation');
  });
});
