import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dryRunGuidance, faultFrame, projectFrame, replyTemplate, replyEvent, awaitEnvelopes } from '../../../skills/dispatch/scripts/core/frame.ts';
import { validateHostEvent } from '../../../skills/dispatch/scripts/core/validate.ts';
import fs from 'node:fs';
import path from 'node:path';
import { send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { awaitingMachine, fakeHandlers, RUN_STARTED } from './fixtures/machines.ts';
import { reviewMachine } from '../../../skills/dispatch/scripts/machines/review.ts';
import type { Event } from '../../../skills/dispatch/scripts/core/types.ts';

test('change receipt: drift envelope preserves actor notice hash and evidence bindings through transport', () => {
  const [event] = awaitEnvelopes('decide', { kind: 'drift', notice: { id: 'n', afterHash: 'after', affectedEvidence: ['SC1'] } });
  assert.equal(event?.type, 'DECISION');
  if (event?.type !== 'DECISION') return;
  assert.deepEqual(event.answer, { by: 'orchestrator', noticeId: 'n', afterHash: 'after', action: '<preserve|refresh|reconcile|escalate>', rationale: '<observed intent and dependency evidence>', evidenceIds: ['SC1'] });
  assert.equal(validateHostEvent('decide', JSON.parse(JSON.stringify(event))).ok, false);
  assert.equal(validateHostEvent('decide', { ...event, answer: { ...(event.answer as object), action: 'refresh' } }).ok, true);
});

test('a projected frame carries the host envelope and optional error', () => {
  const frame = projectFrame(awaitingMachine, { tag: 'authoring', counters: {} }, 'runs/001');
  assert.deepEqual(frame, {
    v: 1, run: 'runs/001', at: 'fixture › authoring', await: 'author',
    data: { artifact: 'plan', path: 'plan.md' }, events: [{ type: 'AUTHORED', path: 'plan.md' }], reply: replyTemplate('runs/001'),
  });
  assert.equal(projectFrame(awaitingMachine, { tag: 'authoring', counters: {} }, 'r', 'event.path: bad').error, 'event.path: bad');
});

test('read-only rejection guidance uses projected validated examples and the same reply boundary', () => {
  const state = { tag: 'authoring' as const, counters: {} };
  const frame = projectFrame(awaitingMachine, state, 'runs/001', undefined, 3);
  assert.deepEqual(dryRunGuidance(awaitingMachine, state, 'runs/001', 3), { events: frame.events, reply: frame.reply });
  for (const event of frame.events ?? []) assert.equal(validateHostEvent(frame.await, event, (item) => awaitingMachine.validate!(state, item)).ok, true);
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

test('level-journal: write frames bind failure receipts to the task model', () => {
  const task = { task: 'T1', attempt: 2, signature: 'sig', handle: 'writer', model: 'model-task', envelopePath: 't1.json' };
  const events = awaitEnvelopes('write', { tasks: [task], model: 'model-run' });
  assert.ok(events.some((event) => event.type === 'WRITE_RECEIPT' && event.status === 'failed' && event.task === 'T1' && event.model === 'model-task'));
  assert.ok(events.some((event) => event.type === 'WRITE_RECEIPT' && event.status === 'failed' && event.task === undefined && event.model === 'model-run'));
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
      event.type === 'WRITE_RECEIPT' && event.status === 'launched' && event.task === 'T1' ? 'T1 already has a writer handle' : null,
  };
  const frame = projectFrame(machine, awaitingMachine.initial(), 'run');
  const launches = frame.events?.filter((event) => event.type === 'WRITE_RECEIPT' && event.status === 'launched') ?? [];
  assert.deepEqual(launches.map((event) => event.type === 'WRITE_RECEIPT' && event.task), ['T2']);
});

test('plan review rule example uses the plan path', () => {
  const config = { 'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } }, phases: { 'plan-review': { rounds: { low: 2 }, targets: { low: 1 } } } };
  const events: Event[] = [
    { type: 'RUN_STARTED', verb: 'review', argument: 'docs/x.plan.md', level: 'low', levelSource: 'explicit', pins: null, orchestrator: 'claude', orchestratorModel: null, overrides: { kind: 'plan' }, config, repo: {} },
    { type: 'REVIEW_PREPARED', effectId: 'review.prepare-review.1', scope: {}, promptPaths: { 'codex[0]': 'p0' } },
    { type: 'WAVE_DONE', effectId: 'review.wave.1', round: 1, slots: [{ slot: 'codex[0]', state: 'success' }], findings: [{ id: 'R1-F001', severity: 'MUST', category: 'correctness', locus: '§ Proposed Changes', defect: 'gap', requiredChange: 'fill', sources: ['codex[0]'], scope: 'in' }] as never },
  ];
  const state = events.reduce((current, event) => reviewMachine.step(current, event).state, reviewMachine.initial());
  const frame = projectFrame(reviewMachine, state, 'run');
  assert.equal(frame.await, 'rule');
  const example = frame.events?.find((event) => event.type === 'RULINGS');
  assert.deepEqual(example?.type === 'RULINGS' && (example.rulings['R1-F001'] as { fix: { affectedPaths: string[] } }).fix.affectedPaths, ['docs/x.plan.md']);
});

test('diagnostics amendment dual intent hint names both accept/reject routes', () => {
  const machine = (category: string) => ({ ...awaitingMachine, awaitOf: () => 'rule' as const, project: () => ({ at: 'review › rule', data: { findings: [{ id: 'R1-F001', category, locus: 'src/a.ts:L1' }] } }) });
  const intent = projectFrame(machine('intent'), awaitingMachine.initial(), 'run');
  assert.equal(intent.data['intentRuling'], 'needs-user; { ruling: accept|reject, quote: <user words> }; { ruling: accept|reject, by: orchestrator, reason: <settled decision> }');
  const example = intent.events?.find((event) => event.type === 'RULINGS');
  assert.equal(example?.type === 'RULINGS' && (example.rulings['R1-F001'] as { ruling: string }).ruling, 'needs-user');
  assert.equal(projectFrame(machine('correctness'), awaitingMachine.initial(), 'run').data['intentRuling'], undefined);
});

test('replyEvent selects only a placeholder-free single event', () => {
  const authored = { type: 'AUTHORED', path: 'plan.md' } as const;
  assert.deepEqual(replyEvent([authored]), authored);
  assert.equal(replyEvent(undefined), undefined);
  assert.equal(replyEvent([]), undefined);
  assert.equal(replyEvent([authored, authored]), undefined);
  assert.equal(replyEvent(awaitEnvelopes('evidence', { criteria: [{ id: 'SC1' }] })), undefined, 'a nested placeholder needs host evidence');
  assert.equal(replyEvent([{ type: 'AUTHORED', path: '<path>' }]), undefined);
});

const WRITING = { tasks: [{ task: 'T1', action: 'running', attempt: 1, signature: 'sig', handle: 'writer-T1', model: 'm', envelopePath: 't1.json', briefHash: 'sha256:brief' }, { task: 'T2', action: 'launch', attempt: 1, signature: 'sig2', handle: '', model: 'm' }], effort: 'high' };

test('renders write receipt reply template', () => {
  const events = awaitEnvelopes('write', WRITING);
  const receipts = events.filter((event) => event.type === 'WRITE_RECEIPT');
  const identity = { task: 'T1', attempt: 1, signature: 'sig', handle: 'writer-T1' };
  assert.deepEqual(receipts, [
    { type: 'WRITE_RECEIPT', status: 'submitted', ...identity, envelopePath: 't1.json', briefHash: 'sha256:brief', model: 'm', effort: 'high' },
    { type: 'WRITE_RECEIPT', status: 'failed', ...identity, detail: '<observed failure>', model: 'm', effort: 'high' },
    { type: 'WRITE_RECEIPT', status: 'cancelled', ...identity },
    { type: 'WRITE_RECEIPT', status: 'launched', task: 'T2', attempt: 1, signature: 'sig2', handle: '<host-assigned handle>', model: 'm', effort: 'high' },
  ]);
  for (const event of receipts) assert.equal(validateHostEvent('write', event).ok, true, JSON.stringify(event));
  assert.deepEqual(awaitEnvelopes('write', { envelopePath: 'hotfix.json', model: 'm' }), [
    { type: 'WRITE_RECEIPT', status: 'submitted', envelopePath: 'hotfix.json' },
    { type: 'WRITE_RECEIPT', status: 'failed', detail: '<observed failure>', model: 'm' },
  ]);
});

test('renders request reply template', () => {
  const requests = awaitEnvelopes('write', WRITING).filter((event) => event.type === 'REQUEST');
  assert.deepEqual(requests, [{ type: 'REQUEST', task: 'T1', attempt: 1, need: '<what the writer needs>', paths: ['<requested path>'], rationale: '<writer rationale>' }]);
  assert.equal(validateHostEvent('write', requests[0]).ok, true);
});

test('renders amend reply template', () => {
  const [amend] = awaitEnvelopes('write', WRITING).filter((event) => event.type === 'AMEND');
  assert.ok(amend?.type === 'AMEND');
  assert.deepEqual(amend.notify.map((row) => row.task), ['T1']);
  assert.equal(validateHostEvent('write', amend).ok, true);
  const [fromRequest] = awaitEnvelopes('decide', { kind: 'request', request: { task: 'T1' } }).filter((event) => event.type === 'AMEND');
  assert.ok(fromRequest?.type === 'AMEND');
  assert.deepEqual(fromRequest.notify.map((row) => row.task), ['T1']);
  assert.equal(validateHostEvent('decide', fromRequest).ok, true);
  assert.equal(awaitEnvelopes('write', { tasks: [] }).some((event) => event.type === 'AMEND'), false, 'no live writer to notify');
});

test('renders generic decision reply template', () => {
  for (const [kind, data, answer] of [
    ['integration-conflict', {}, { by: 'orchestrator', action: 'resolve', rationale: '<resolution against the intent and criteria of both tasks>' }],
    ['request', {}, { by: 'orchestrator', action: 'approve', rationale: '<ruling against task intent and invariants>' }],
    ['failure', {}, { by: 'orchestrator', action: 'retry', rationale: '<observed root cause and the change that addresses it>' }],
    ['request-user', { request: { requestId: 'req-1' } }, { by: 'user', requestId: 'req-1', choice: 'accept', quote: '<actual user quote>' }],
  ] as const) {
    const [event] = awaitEnvelopes('decide', { kind, ...data });
    assert.deepEqual(event, { type: 'DECISION', kind, answer }, kind);
    assert.equal(validateHostEvent('decide', event).ok, true, kind);
  }
});

for (const fixTarget of [undefined, 'docs/x.plan.md']) test(`diagnostics amendment rule scope ${fixTarget ? 'artifact' : 'code'} guidance preserves examples`, () => {
  const machine = { ...awaitingMachine, awaitOf: () => 'rule' as const, project: () => ({ at: 'review', data: { fixTarget, findings: [{ id: 'F1', locus: 'src/a.ts:L1', category: 'correctness' }] } }) };
  const frame = projectFrame(machine, awaitingMachine.initial(), 'run', undefined, 4);
  assert.match(String(frame.data['fixScope']), /suggestions/);
  assert.match(String(frame.data['fixScope']), /production.*test.*fixture.*helper.*verification-generated.*before.*RULINGS/);
  const example = frame.events?.[0];
  assert.equal(validateHostEvent('rule', example).ok, true);
  assert.deepEqual(example?.type === 'RULINGS' && (example.rulings['F1'] as { fix: { affectedPaths: string[] } }).fix.affectedPaths, [fixTarget ?? 'src/a.ts']);
  assert.equal(frame.await, 'rule');
  assert.match(frame.reply, /events\/4-rule.json$/);
});
