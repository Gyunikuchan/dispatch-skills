import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Event } from '../../../skills/dispatch/scripts/core/types.ts';
import { projectFrame } from '../../../skills/dispatch/scripts/core/frame.ts';
import { MAX_WRITE_ATTEMPTS, implementMachine, stepImplement, validateImplement, type ImplementState } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { HASH, failure, taskFailure } from './fixtures/implement-recovery.ts';

const AMEND = { type: 'AMEND', delta: [{ kind: 'modify', target: 'SC1', current: '[SC1] works', proposed: '[SC1] works fast' }], notify: [], rationale: 'Change the criterion after delivery.' } as unknown as Event;
const REPLACE = { type: 'REPLACE_PLAN', path: 'session/x.r2.plan.md', expectedHash: HASH, notify: [], rationale: 'Replace the plan after delivery.', reconciliation: { retained: [], changed: [], added: [], retired: [] } } as unknown as Event;

// Answers come from the projected frame, which keeps only examples the machine would accept.
const offeredAnswers = (state: ImplementState) => {
  const frame = projectFrame(implementMachine, state, 'runs/002');
  const answers = (frame.events ?? []).flatMap((event) => event.type === 'DECISION' && event.kind === 'failure' && typeof event.answer === 'object' && event.answer ? [String((event.answer as Record<string, unknown>)['action'])] : []);
  return { data: frame.data, answers };
};

describe('amend outside the task phase', () => {
  test('a plan revision at a final-verification failure is rejected and names the failure and baseline answers', () => {
    const state = failure();
    for (const event of [AMEND, REPLACE]) {
      const error = validateImplement(state, event as never) ?? '';
      assert.match(error, /only during the task phase/);
      assert.match(error, /DECISION failure \(hotfix, retry, manual-complete, stop\)/);
      assert.match(error, /DECISION baseline \(accept-known-red, inline-hotfix, stop\)/);
      assert.equal(stepImplement(state, event).state, state);
    }
  });

  test('an exhausted task-phase failure frame offers stop without retry and keeps the amend hint', () => {
    const { data, answers } = offeredAnswers(taskFailure(MAX_WRITE_ATTEMPTS));
    assert.deepEqual(data['options'], ['stop']);
    assert.ok(!answers.includes('retry'));
    assert.match(String(data['amend']), /AMEND/);
  });

  test('a task-phase failure frame with attempts left still offers retry', () => {
    const { data, answers } = offeredAnswers(taskFailure(1));
    assert.deepEqual(data['options'], ['retry', 'stop']);
    assert.ok(answers.includes('retry'));
    assert.match(String(data['amend']), /AMEND/);
  });
});
