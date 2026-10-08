import assert from 'node:assert/strict';
import { test } from 'node:test';
import { faultFrame, projectFrame, replyTemplate, awaitEnvelopes } from '../../../skills/dispatch/scripts/core/frame.ts';
import { validateHostEvent } from '../../../skills/dispatch/scripts/core/validate.ts';
import fs from 'node:fs';
import path from 'node:path';
import { send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { awaitingMachine, fakeHandlers, RUN_STARTED } from './fixtures/machines.ts';

test('change receipt: drift envelope preserves actor notice hash and evidence bindings through transport', () => {
  const [event] = awaitEnvelopes('decide', { kind: 'drift', notice: { id: 'n', afterHash: 'after', affectedEvidence: ['SC1'] } });
  assert.equal(event?.type, 'DECISION');
  if (event?.type !== 'DECISION') return;
  assert.deepEqual(event.answer, { by: 'orchestrator', noticeId: 'n', afterHash: 'after', action: '<preserve|refresh|reconcile|escalate>', rationale: '<observed intent and dependency evidence>', evidenceIds: ['SC1'] });
  assert.equal(validateHostEvent('decide', JSON.parse(JSON.stringify(event))).ok, false);
  assert.equal(validateHostEvent('decide', { ...event, answer: { ...(event.answer as object), action: 'refresh' } }).ok, true);
});

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


test('event path: a boundary frame names events/<seq>-<await>.json and a done frame keeps the placeholder', () => {
  assert.match(projectFrame(awaitingMachine, { tag: 'authoring', counters: {} }, 'runs/001', undefined, 3).reply, /--event @runs\/001\/events\/3-author\.json$/);
  assert.match(faultFrame('runs/001', 'x').reply, /@<event-file>$/);
});

test('event path: a rejected event keeps its path, and the rewritten file is accepted', async () => {
  const ports = fakePorts();
  const root = tempDir(), runDir = path.join(root, 'runs', '001-ask');
  const started = await start({ runDir, runRel: 'runs/001-ask', machine: awaitingMachine, handlers: fakeHandlers, ports, runStarted: RUN_STARTED });
  const file = path.join(root, /@(\S+)$/.exec(started.frame!.reply)![1]!);
  assert.equal(fs.existsSync(path.dirname(file)), true, 'events/ exists before the host writes');
  const rejected = await send({ runDir, runRel: 'runs/001-ask', machine: awaitingMachine, handlers: fakeHandlers, ports, rawEvent: { type: 'AUTHORED' } });
  assert.ok(rejected.frame?.error);
  assert.equal(rejected.frame.reply, started.frame!.reply);
  fs.writeFileSync(file, JSON.stringify({ type: 'AUTHORED', path: 'plan.md' }));
  const accepted = await send({ runDir, runRel: 'runs/001-ask', machine: awaitingMachine, handlers: fakeHandlers, ports, rawEvent: JSON.parse(fs.readFileSync(file, 'utf8')) });
  assert.equal(accepted.frame?.error, undefined);
  assert.notEqual(accepted.frame?.reply, started.frame!.reply);
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

test('level-journal: write frames bind failure models and suppress launches while draining', () => {
  const task = { task: 'T1', attempt: 2, signature: 'sig', handle: 'writer', model: 'model-task', envelopePath: 't1.json' };
  const ordinary = awaitEnvelopes('write', { tasks: [task], model: 'model-run' });
  assert.ok(ordinary.some((event) => event.type === 'WRITE_FAILED' && event.model === 'model-task'));
  const draining = awaitEnvelopes('write', { stage: 'scope-draining', tasks: [task], model: 'model-run' });
  assert.ok(!draining.some((event) => event.type === 'WRITE_LAUNCHED'));
  assert.ok(draining.some((event) => event.type === 'WRITE_FAILED' && event.model === 'model-task'));
});

test('level-journal: projectFrame launches only unlaunched task slots when writers overlap', () => {
  const tasks = [
    { task: 'T1', action: 'running', attempt: 1, signature: 'sig-running', handle: 'writer-T1', model: 'model', envelopePath: 't1.json' },
    { task: 'T2', action: 'launch', attempt: 2, signature: 'sig-launch', handle: '', model: 'model', envelopePath: 't2.json' },
  ];
  const machine = {
    ...awaitingMachine,
    awaitOf: () => 'write' as const,
    project: () => ({ at: 'implement › tasks', data: { tasks } }),
    validate: (_state: unknown, event: import('../../../skills/dispatch/scripts/core/types.ts').HostEvent) =>
      event.type === 'WRITE_LAUNCHED' && event.tasks.some((task) => task.task === 'T1') ? 'T1 already has a writer handle' : null,
  };
  const frame = projectFrame(machine, awaitingMachine.initial(), 'run');
  const launches = frame.events?.find((event) => event.type === 'WRITE_LAUNCHED');
  assert.ok(launches?.type === 'WRITE_LAUNCHED');
  assert.deepEqual(launches.tasks.map((task) => task.task), ['T2']);
});
