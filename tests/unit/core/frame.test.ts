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
import { implementMachine, validateImplement, type ImplementState } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { launch, start as startTasks, submit, type Sim } from '../machines/fixtures/implement-tasks.ts';

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

test('every live await emits parser-compatible envelopes with scoped ruling and mapping metadata', () => {
  const data = { path: 'plan.md', slots: [{ sourceKey: 'native[0]', outputPath: 'raw.md', model: 'configured' }], findings: [{ id: 'F1', locus: 'src/a.ts:L1' }], clusters: [{ clusterId: 'C1', affectedPaths: ['src/a.ts'] }], envelopePath: 'receipt.json', model: 'writer', criteria: [{ id: 'SC1' }], kind: 'approval', items: [] };
  for (const current of ['author', 'native', 'rule', 'fix', 'write', 'decide'] as const) {
    const events = awaitEnvelopes(current, data); assert.ok(events.length);
    for (const event of events) assert.equal(validateHostEvent(current, event).ok, true, JSON.stringify(event));
  }
  const approval = awaitEnvelopes('decide', { ...data, hash: 'sha256:revision' })[0];
  assert.deepEqual(approval?.type === 'DECISION' && approval.answer, { by: 'user', quote: '<actual user quote>', hash: 'sha256:revision' });
  const ruling = awaitEnvelopes('rule', data)[0]; assert.equal(ruling?.type === 'RULINGS' && typeof ruling.rulings['F1'], 'object');
});
test('terminal summary stays within 4 KiB while raw paths remain accessible', () => {
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

const row = (task: string, action: string, handle: string | null) => ({ task, action, attempt: 1, handle, launchPath: `implement.launch.${task.toLowerCase()}/launch.json` });
const WRITING = { tasks: [row('T1', 'running', 'writer-T1'), row('T2', 'launch', null), row('T3', 'running', 'writer-T3')], effort: 'high' };

test('compact tasks frame reply templates: one REQUEST per running writer with a handle and no task receipts', () => {
  const events = awaitEnvelopes('write', WRITING);
  assert.equal(events.some((event) => event.type === 'WRITE_RECEIPT'), false, 'hosts copy receipts from launch records');
  const requests = events.filter((event) => event.type === 'REQUEST');
  assert.deepEqual(requests, ['T1', 'T3'].map((task) => ({ type: 'REQUEST', task, attempt: 1, need: '<what the writer needs>', paths: ['<requested path>'], rationale: '<writer rationale>' })));
  for (const event of events) assert.equal(validateHostEvent('write', event).ok, true, JSON.stringify(event));
});

test('compact tasks frame reply templates: AMEND and REPLACE_PLAN notify a live writer, never a launch-only frame', () => {
  const events = awaitEnvelopes('write', WRITING);
  const orchestrator = events.filter((event) => event.type === 'AMEND' || event.type === 'REPLACE_PLAN');
  assert.deepEqual(orchestrator.map((event) => [event.type, 'notify' in event ? event.notify.map((item) => item.task) : []]), [['AMEND', ['T1']], ['REPLACE_PLAN', ['T1']]]);
  for (const tasks of [[row('T2', 'launch', null)], [row('T1', 'running', '')], []]) assert.deepEqual(awaitEnvelopes('write', { tasks }), [], JSON.stringify(tasks));
  const [fromRequest] = awaitEnvelopes('decide', { kind: 'request', request: { task: 'T1' } }).filter((event) => event.type === 'AMEND');
  assert.ok(fromRequest?.type === 'AMEND');
  assert.deepEqual(fromRequest.notify.map((item) => item.task), ['T1']);
  assert.equal(validateHostEvent('decide', fromRequest).ok, true);
});

test('compact tasks frame reply templates: the projected frame keeps validated live-writer replies only', () => {
  const machine = {
    ...awaitingMachine,
    awaitOf: () => 'write' as const,
    project: () => ({ at: 'implement › tasks', data: WRITING }),
    validate: (_state: unknown, event: import('../../../skills/dispatch/scripts/core/types.ts').HostEvent) => event.type === 'REQUEST' && event.task === 'T3' ? 'T3 is retiring' : null,
  };
  const frame = projectFrame(machine, awaitingMachine.initial(), 'run');
  assert.deepEqual(frame.events?.map((event) => [event.type, 'task' in event ? event.task : null]), [['REQUEST', 'T1'], ['AMEND', null], ['REPLACE_PLAN', null]]);
});

test('compact tasks frame reply templates: hotfix-shaped data keeps its two taskless receipts', () => {
  assert.deepEqual(awaitEnvelopes('write', { envelopePath: 'hotfix.json', model: 'm' }), [
    { type: 'WRITE_RECEIPT', status: 'submitted', envelopePath: 'hotfix.json' },
    { type: 'WRITE_RECEIPT', status: 'failed', detail: '<observed failure>', model: 'm' },
  ]);
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

test('diagnostics amendment rule scope guidance preserves examples for code and artifact targets', () => {
  for (const fixTarget of [undefined, 'docs/x.plan.md']) {
    const machine = { ...awaitingMachine, awaitOf: () => 'rule' as const, project: () => ({ at: 'review', data: { fixTarget, findings: [{ id: 'F1', locus: 'src/a.ts:L1', category: 'correctness' }] } }) };
    const frame = projectFrame(machine, awaitingMachine.initial(), 'run', undefined, 4);
    assert.match(String(frame.data['fixScope']), /suggestions/);
    assert.match(String(frame.data['fixScope']), /production.*test.*fixture.*helper.*verification-generated.*before.*RULINGS/);
    const example = frame.events?.[0];
    assert.equal(validateHostEvent('rule', example).ok, true);
    assert.deepEqual(example?.type === 'RULINGS' && (example.rulings['F1'] as { fix: { affectedPaths: string[] } }).fix.affectedPaths, [fixTarget ?? 'src/a.ts']);
    assert.equal(frame.await, 'rule');
    assert.match(frame.reply, /events\/4-rule.json$/);
  }
});

// SECTION: Decide, rule and write templates

const decideMachine = (data: Record<string, unknown>, validate?: (event: import('../../../skills/dispatch/scripts/core/types.ts').HostEvent) => string | null) => ({
  ...awaitingMachine, awaitOf: () => 'decide' as const, project: () => ({ at: 'implement › decide', data }), ...(validate ? { validate: (_state: unknown, event: import('../../../skills/dispatch/scripts/core/types.ts').HostEvent) => validate(event) } : {}),
});
const answers = (events: readonly import('../../../skills/dispatch/scripts/core/types.ts').HostEvent[] | undefined) => (events ?? []).map((event) => event.type === 'DECISION' ? event.answer : null);

test('decide templates offer progress first for writer concerns', () => {
  const items = ['The fixture covers only one platform.', 'A helper stays duplicated.'];
  const state = { tag: 'concerns', c: {}, items } as unknown as ImplementState;
  const frame = projectFrame(decideMachine({ kind: 'concerns', question: 'Resolve the writer concerns before code review.', options: ['accept', 'stop'], items }, (event) => validateImplement(state, event)), awaitingMachine.initial(), 'run');
  const offered = answers(frame.events) as Record<string, unknown>[];
  assert.deepEqual(offered.map((answer) => [answer['decision'], answer['by']]), [['accept', 'orchestrator'], ['stop', 'user']]);
});

test('decide templates offer progress first for baseline failures with every failure id', () => {
  const failing = (failureId: string | null) => ({ command: 'npm test', exit: 1, failureId, diagnostic: 'failed', logPath: 'baseline.log' });
  const rows = [failing('f-b'), failing('f-a'), failing('f-a'), failing(null)];
  const state = { tag: 'baseline-decision', c: {}, items: rows } as unknown as ImplementState;
  const data = { kind: 'baseline', question: 'Accept, hotfix, or stop.', options: ['accept-known-red', 'inline-hotfix', 'stop'], items: rows.map(({ exit: _exit, ...row }) => row) };
  const frame = projectFrame(decideMachine(data, (event) => validateImplement(state, event)), awaitingMachine.initial(), 'run');
  assert.deepEqual(answers(frame.events), [{ action: 'accept-known-red', ids: ['f-a', 'f-b'] }, 'stop']);
  assert.deepEqual(replyEvent(frame.events), undefined, 'the host still chooses between accepting and stopping');
});

test('decide templates offer progress first for spec approval with the revision hash', () => {
  const hash = `sha256:${'b'.repeat(64)}`;
  const data = { kind: 'spec-approval', path: 'x.spec.md', hash, question: 'Approve this governing spec revision.', options: ['approve', 'stop'], required: { by: 'user', quote: 'non-empty', hash } };
  const frame = projectFrame(decideMachine(data), awaitingMachine.initial(), 'run');
  assert.deepEqual(answers(frame.events), [{ by: 'user', quote: '<actual user quote>', hash }, 'stop']);
});

test('rule and write templates name constraints for intent findings with needs-user first', () => {
  const config = { 'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } }, phases: { 'code-review': { rounds: { low: 2 }, targets: { low: 1 } } } };
  const finding = (id: string, category: string) => ({ id, severity: 'MUST', category, locus: 'src/a.ts:L4', defect: 'gap', requiredChange: 'fill', sources: ['codex[0]'], scope: 'in' });
  const events: Event[] = [
    { type: 'RUN_STARTED', verb: 'review', argument: 'src/a.ts', level: 'low', levelSource: 'explicit', pins: null, orchestrator: 'claude', orchestratorModel: null, overrides: { kind: 'code' }, config, repo: {} },
    { type: 'REVIEW_PREPARED', effectId: 'review.prepare-review.1', scope: {}, promptPaths: { 'codex[0]': 'p0' } },
    { type: 'WAVE_DONE', effectId: 'review.wave.1', round: 1, slots: [{ slot: 'codex[0]', state: 'success' }], findings: [finding('R1-F001', 'intent'), finding('R1-F002', 'correctness')] as never },
  ];
  const state = events.reduce((current, event) => reviewMachine.step(current, event).state, reviewMachine.initial());
  const frame = projectFrame(reviewMachine, state, 'run');
  assert.equal(frame.await, 'rule');
  const rulings = (frame.events ?? []).flatMap((event) => event.type === 'RULINGS' ? [event.rulings as Record<string, { ruling: string; by?: string; reason?: string }>] : []);
  assert.deepEqual(rulings.map((row) => [row['R1-F001']?.ruling, row['R1-F001']?.by, row['R1-F002']?.ruling]), [['needs-user', undefined, 'accept'], ['accept', 'orchestrator', 'accept']]);
  assert.ok(rulings[1]?.['R1-F001']?.reason?.trim(), 'the orchestrator ruling carries a reason');
});

test('rule and write templates name constraints for launched receipts and plan replacement', () => {
  const frame = projectFrame({ ...awaitingMachine, awaitOf: () => 'write' as const, project: () => ({ at: 'implement › tasks', data: WRITING }) }, awaitingMachine.initial(), 'run');
  assert.match(String(frame.data['launchedReceipt']), /substitution/);
  const launched = { type: 'WRITE_RECEIPT', status: 'launched', task: 'T1', attempt: 1, signature: 's', handle: 'h', model: 'm', substitution: 'configured model unavailable' };
  assert.equal(validateHostEvent('write', launched).ok, true);
  const replace = frame.events?.find((event) => event.type === 'REPLACE_PLAN');
  assert.match(replace?.type === 'REPLACE_PLAN' ? replace.path : '', /new plan file path.*immutable/);
});

// SECTION: Evidence reply template

const evidenceFrame = (criteria: readonly Record<string, unknown>[]) => projectFrame({ ...awaitingMachine, awaitOf: () => 'evidence' as const, project: () => ({ at: 'implement › evidence', data: { criteria } }) }, awaitingMachine.initial(), 'run');

test('evidence template shows verify logs and leaves every judgment to the host', () => {
  const frame = evidenceFrame([{ id: 'SC1', logPath: 'run/implement.verify.4/1.log', exit: 0 }, { id: 'SC2', logPath: 'run/implement.verify.4/2.log', exit: 1 }, { id: 'SC3' }]);
  assert.equal(frame.events, undefined, 'no event template preselects an outcome');
  assert.equal(replyEvent(frame.events), undefined, 'nothing is pre-written as the reply');
  assert.deepEqual(frame.data['evidenceTemplate'], {
    type: 'EVIDENCE',
    criteria: {
      SC1: { outcome: '<pass|waived after inspecting the log>', evidence: '<log run/implement.verify.4/1.log, exit 0: observed result>' },
      SC2: { outcome: '<pass|waived after inspecting the log>', evidence: '<log run/implement.verify.4/2.log, exit 1: observed result>' },
      SC3: { evidence: '<observed criterion evidence>' },
    },
  });
  const template = frame.data['evidenceTemplate'] as { criteria: Record<string, Record<string, unknown>> };
  const reply = { type: 'EVIDENCE', criteria: Object.fromEntries(Object.keys(template.criteria).map((id) => [id, { outcome: 'pass', evidence: `Read the ${id} log; every assertion passed.` }])) };
  assert.equal(validateHostEvent('evidence', reply).ok, true);
});

test('evidence template shows verify logs journaled by the implementation run', () => {
  const sim: Sim = {};
  let { result, trace } = startTasks(1, sim);
  for (const id of ['T1', 'T2', 'T3']) result = submit(launch(result, sim, trace), id, sim, trace);
  assert.equal(result.state.tag, 'evidence');
  const frame = projectFrame(implementMachine, result.state, 'run');
  assert.equal(frame.events, undefined);
  const lastLog = (command: string) => trace.events.flatMap((event) => event.type === 'VERIFY_DONE' ? event.results.filter((row) => row['command'] === command) : []).at(-1);
  const plan = result.state.tag === 'evidence' ? result.state.c.plan! : null;
  const ids = (frame.data['criteria'] as { id: string }[]).map((row) => row.id);
  assert.ok(ids.length > 0);
  const expected = Object.fromEntries(ids.map((id) => {
    const log = lastLog(plan!.criteria.find((row) => row.id === id)!.verify.at(-1)!.command)!;
    return [id, { outcome: '<pass|waived after inspecting the log>', evidence: `<log ${log['logPath']}, exit ${log['exit']}: observed result>` }];
  }));
  assert.deepEqual(frame.data['evidenceTemplate'], { type: 'EVIDENCE', criteria: expected });
  assert.notEqual(validateImplement(result.state, frame.data['evidenceTemplate'] as never), null, 'the unedited template is not a sendable reply');
  const reply = { type: 'EVIDENCE', criteria: Object.fromEntries(ids.map((id) => [id, { outcome: 'pass', evidence: `Read the ${id} log; every assertion passed.` }])) };
  assert.equal(validateImplement(result.state, reply as never), null);
});
