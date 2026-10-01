import assert from 'node:assert/strict';
import { test } from 'node:test';
import { faultFrame, projectFrame, replyTemplate, awaitEnvelopes } from '../../../skills/dispatch/scripts/core/frame.ts';
import { validateHostEvent } from '../../../skills/dispatch/scripts/core/validate.ts';
import { awaitingMachine } from './fixtures/machines.ts';

test('a projected frame carries the envelope fields in order', () => {
  const frame = projectFrame(awaitingMachine, { tag: 'authoring', counters: {} }, 'runs/001');
  assert.deepEqual(frame, {
    v: 1, run: 'runs/001', at: 'fixture › authoring', await: 'author',
    data: { artifact: 'plan', path: 'plan.md' }, events: [{ type: 'AUTHORED', path: 'plan.md' }], reply: replyTemplate('runs/001'),
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


test('rewrite SC5 every live await emits parser-compatible envelopes with scoped ruling and mapping metadata', () => {
  const data = { path: 'plan.md', slots: [{ sourceKey: 'native[0]', outputPath: 'raw.md', model: 'configured' }], findings: [{ id: 'F1', locus: 'src/a.ts:L1' }], clusters: [{ clusterId: 'C1', affectedPaths: ['src/a.ts'] }], envelopePath: 'receipt.json', model: 'writer', criteria: [{ id: 'SC1' }], kind: 'approval', items: [] };
  for (const current of ['author', 'native', 'rule', 'fix', 'write', 'evidence', 'decide'] as const) {
    const events = awaitEnvelopes(current, data); assert.ok(events.length);
    for (const event of events) assert.equal(validateHostEvent(current, event).ok, true, JSON.stringify(event));
  }
  const approval = awaitEnvelopes('decide', { ...data, hash: 'sha256:revision' })[0];
  assert.deepEqual(approval?.type === 'DECISION' && approval.answer, { by: 'user', quote: '<actual user quote>', hash: 'sha256:revision' });
  const ruling = awaitEnvelopes('rule', data)[0]; assert.equal(ruling?.type === 'RULINGS' && typeof ruling.rulings['F1'], 'object');
});
test('rewrite SC5 terminal summary stays within 4 KiB while raw paths remain accessible', () => {
  const machine = { ...awaitingMachine, awaitOf: () => 'done' as const, project: () => ({ at: 'done', data: { outcome: 'complete', summary: 'x'.repeat(10000), captures: ['raw.log'] } }) };
  const frame = projectFrame(machine, awaitingMachine.initial(), 'run'); assert.ok(Buffer.byteLength(String(frame.data['summary'])) <= 4096); assert.deepEqual(frame.data['captures'], ['raw.log']);
});

test('review fix author envelope requires a real nonempty path', () => {
  for (const path of [undefined, null, '', '  ', 123]) assert.deepEqual(awaitEnvelopes('author', { path }), []);
  assert.deepEqual(awaitEnvelopes('author', { path: 'actual.plan.md' }), [{ type: 'AUTHORED', path: 'actual.plan.md' }]);
});


test('review fix terminal summary truncation preserves complete UTF-8 characters', () => {
  for (const character of ['😀', '€']) {
    const summary = '\uFEFF' + 'a'.repeat(3996) + character + 'b'.repeat(500);
    const machine = { ...awaitingMachine, awaitOf: () => 'done' as const, project: () => ({ at: 'done', data: { summary, captures: ['raw.log'] } }) };
    const frame = projectFrame(machine, awaitingMachine.initial(), 'run');
    assert.equal(frame.data['summary'], '\uFEFF' + 'a'.repeat(3996) + ' [full captures referenced separately]');
    assert.ok(Buffer.byteLength(String(frame.data['summary'])) <= 4096);
    assert.deepEqual(frame.data['captures'], ['raw.log']);
  }
});
