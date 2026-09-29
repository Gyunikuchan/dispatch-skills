import assert from 'node:assert/strict';
import { test } from 'node:test';
import { faultFrame, projectFrame, replyTemplate } from '../../../skills/dispatch/scripts/core/frame.ts';
import { awaitingMachine } from './fixtures/machines.ts';

test('a projected frame carries the envelope fields in order', () => {
  const frame = projectFrame(awaitingMachine, { tag: 'authoring', counters: {} }, 'runs/001');
  assert.deepEqual(frame, {
    v: 1, run: 'runs/001', at: 'fixture › authoring', await: 'author',
    data: { artifact: 'plan', path: 'plan.md' }, reply: replyTemplate('runs/001'),
  });
  assert.equal(projectFrame(awaitingMachine, { tag: 'authoring', counters: {} }, 'r', 'event.path: bad').error, 'event.path: bad');
});

test('a fault frame is a done frame with outcome fault and a one-line error', () => {
  assert.deepEqual(faultFrame('runs/001', 'EngineFault: broke\n  at x'), {
    v: 1, run: 'runs/001', at: 'fault', await: 'done', data: { outcome: 'fault' }, reply: replyTemplate('runs/001'), error: 'EngineFault: broke at x',
  });
});

test('the reply template sends the event from a file', () => {
  assert.match(replyTemplate('runs/001'), /send --run runs\/001 --event @<event-file>$/);
});
