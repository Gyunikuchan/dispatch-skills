import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canonicalJson,
  foldEvents,
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
    assert.throws(() => serializeEvent({ ...start(), v: 2 }), /Unknown ledger version/);
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
