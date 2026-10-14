import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { appendEvent, journalPath, readJournal } from '../../../skills/dispatch/scripts/core/journal.ts';
import { LOCK_FILE } from '../../../skills/dispatch/scripts/core/lock.ts';
import { validateHostEvent } from '../../../skills/dispatch/scripts/core/validate.ts';
import { rejectionReason } from '../../../skills/dispatch/scripts/domain/diagnostics.ts';
import { fakePorts, tempDir, type FakePorts } from '../../helpers/fake-ports.ts';
import { awaitingMachine, fakeHandlers, RUN_STARTED } from './fixtures/machines.ts';

async function startAwaiting(ports: FakePorts) {
  const runDir = path.join(tempDir(), 'runs', '001-ask');
  const result = await start({ runDir, runRel: 'runs/001-ask', machine: awaitingMachine, handlers: fakeHandlers, ports, runStarted: RUN_STARTED });
  return { runDir, result };
}

const bytes = (runDir: string) => fs.readFileSync(journalPath(runDir));
const types = (ports: FakePorts, runDir: string) => Array.from(readJournal(ports, runDir).records).map((line) => line.type);

test('dry-run-guidance: invalid rulings returns validated examples without mutation', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'runs', '001-review');
  const options = { ports, runDir, runRel: 'runs/001-review', machine: transportMachine, handlers: fakeHandlers };
  await start({ ...options, runStarted: RUN_STARTED });
  const snapshot = () => fs.readdirSync(runDir, { recursive: true, withFileTypes: true }).map((entry) => {
    const file = path.join(entry.parentPath, entry.name);
    return [path.relative(runDir, file), entry.isDirectory() ? 'directory' : fs.readFileSync(file, 'utf8')];
  }).sort(([left], [right]) => left!.localeCompare(right!));
  const before = snapshot();
  const result = await send({ ...options, dryRun: true, rawEvent: { type: 'RULINGS', rulings: { F1: 1 } } });
  assert.equal(result.exitCode, 1);
  assert.match(result.verdict?.error ?? '', /event.rulings.F1/);
  const guidance = result.verdict as { valid: boolean; events?: unknown[]; reply?: string };
  assert.ok(guidance.events?.length);
  for (const event of guidance.events) assert.equal(validateHostEvent('rule', event).ok, true);
  assert.match(guidance.reply ?? '', /send --run runs\/001-review --event @runs\/001-review\/events\/1-rule.json/);
  assert.deepEqual(snapshot(), before);
  const rejected = await send({ ...options, rawEvent: { type: 'RULINGS', rulings: { F1: 1 } } });
  assert.deepEqual(rejected.frame?.events, guidance.events);
  assert.equal(rejected.frame?.reply, guidance.reply);
});

test('dry-run-guidance: new authority and recovery fields retain privacy-safe diagnostic paths', () => {
  for (const field of ['changeDispositions[0].rationale', 'reconciliation.compensating[0]', 'retire[0].disposition', 'observationId', 'afterHash', 'paths[0]', 'boundarySeq', 'effectId', 'attempt', 'descriptorHash', 'oldRuntime', 'newRuntime', 'source.sha256', 'epoch']) {
    const reason = rejectionReason(`event.${field}: expected valid input, got "private rationale C:/Users/private"`);
    assert.equal(reason, `invalid-value at event.${field}`);
    assert.equal(reason.includes('private'), false);
  }
  assert.equal(rejectionReason('event.privateRationale: expected string, got "secret"'), 'invalid-value at event.*');
  assert.equal(rejectionReason('event.criterionDefinitions[0].id: expected string, got "secret"'), 'invalid-value at event.*');
});

test('start drives the machine to its await and returns one frame', async () => {
  const ports = fakePorts();
  const { runDir, result } = await startAwaiting(ports);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(Object.keys(result.frame ?? {}), ['v', 'run', 'at', 'await', 'data', 'reply', 'events']);
  assert.equal(result.frame?.await, 'author');
  assert.match(result.frame?.reply ?? '', /send --run runs\/001-ask --event @/);
  assert.deepEqual(types(ports, runDir), ['RUN_STARTED', 'EFFECT_STARTED', 'SNAPSHOT']);
  assert.equal(fs.existsSync(path.join(runDir, LOCK_FILE)), false);
});

test('start refuses an existing run folder', async () => {
  const ports = fakePorts();
  const { runDir } = await startAwaiting(ports);
  await assert.rejects(start({ runDir, machine: awaitingMachine, handlers: fakeHandlers, ports, runStarted: RUN_STARTED }), /EEXIST/);
});

test('a valid host event is appended and the loop runs to the next await', async () => {
  const ports = fakePorts();
  const { runDir } = await startAwaiting(ports);
  const result = await send({ runDir, machine: awaitingMachine, handlers: fakeHandlers, ports, rawEvent: '{"type":"AUTHORED","path":"plan.md"}' });
  assert.equal(result.frame?.await, 'done');
  assert.deepEqual(result.frame?.data, { outcome: 'complete', path: 'plan.md' });
  assert.deepEqual(types(ports, runDir).slice(3), ['AUTHORED', 'EFFECT_STARTED', 'VERIFY_DONE']);
});

test('a bad event re-emits the same frame with a one-line error and appends only an event-rejected note', async () => {
  const ports = fakePorts();
  const { runDir, result: before } = await startAwaiting(ports);
  const journal = bytes(runDir);
  for (const raw of [{ type: 'RULINGS', rulings: {} }, { type: 'AUTHORED' }, { type: 'AUTHORED', path: '../x' }, '{nope']) {
    const result = await send({ runDir, machine: awaitingMachine, handlers: fakeHandlers, ports, rawEvent: raw, runRel: 'runs/001-ask' });
    assert.equal(result.exitCode, 0);
    const { error, ...frame } = result.frame ?? { error: undefined };
    assert.deepEqual(frame, before.frame);
    assert.match(error ?? '', /^event[.:]/);
    assert.doesNotMatch(error ?? '', /\n/);
  }
  // Notes keep the operational prefix and never move the reply boundary, so every frame above matched the first.
  const after = bytes(runDir);
  assert.deepEqual(after.subarray(0, journal.length), journal);
  const notes = after.subarray(journal.length).toString('utf8').trim().split('\n').map((line) => JSON.parse(line) as { seq: number; type: string; data: Record<string, unknown> });
  assert.deepEqual(notes.map((note) => [note.seq, note.type, note.data['kind'], note.data['eventType']]), [
    [4, 'DIAGNOSTIC_NOTE', 'event-rejected', 'RULINGS'], [5, 'DIAGNOSTIC_NOTE', 'event-rejected', 'AUTHORED'],
    [6, 'DIAGNOSTIC_NOTE', 'event-rejected', 'AUTHORED'], [7, 'DIAGNOSTIC_NOTE', 'event-rejected', 'UNKNOWN'],
  ]);
});

test('dry-run verdict reports validity with exit 0 for a valid event and 1 for an invalid one', async () => {
  const ports = fakePorts();
  const { runDir } = await startAwaiting(ports);
  const journal = bytes(runDir);
  const options = { runDir, machine: awaitingMachine, handlers: fakeHandlers, ports, dryRun: true };
  assert.deepEqual(await send({ ...options, rawEvent: { type: 'AUTHORED', path: 'p.md' } }), { frame: null, verdict: { valid: true }, exitCode: 0 });
  const malformed = await send({ ...options, rawEvent: '{nope' });
  assert.deepEqual([malformed.frame, malformed.verdict?.valid, malformed.exitCode], [null, false, 1]);
  assert.match(malformed.verdict?.error ?? '', /^event[.:]/);
  const bad = await send({ ...options, rawEvent: { type: 'AUTHORED', path: 1 } });
  assert.deepEqual([bad.frame, bad.verdict?.valid, bad.verdict?.error, bad.exitCode], [null, false, 'event.path: expected non-empty string, got number', 1]);
  assert.deepEqual(bad.verdict?.events, [{ type: 'AUTHORED', path: 'plan.md' }]);
  assert.match(bad.verdict?.reply ?? '', /--event @.*3-author.json$/);
  const replay = await send(options);
  assert.equal(replay.frame?.await, 'author');
  assert.equal(replay.verdict, undefined);
  assert.deepEqual(bytes(runDir), journal);
});

test('rejects journal from prior protocol revision', async () => {
  const ports = fakePorts();
  const runDir = path.join(tempDir(), 'runs', '001-ask');
  // Revision 7 carried the four write event types and kind-specific scope decisions.
  appendEvent(ports, runDir, 'RUN_STARTED', { ...RUN_STARTED, type: undefined, protocolRevision: 7 });
  const before = bytes(runDir);
  for (const dryRun of [false, true]) {
    const result = await send({ runDir, runRel: 'runs/001-ask', machine: awaitingMachine, handlers: fakeHandlers, ports, dryRun });
    assert.deepEqual([result.frame, result.exitCode, result.message], [null, 1, 'layout-unsupported: runs/001-ask']);
  }
  assert.deepEqual(bytes(runDir), before);
});

const transportFindings = (round: number) => [{ id: `F${round}`, severity: 'MUST', category: 'intent', locus: 'src/a.ts:L1', defect: `full body ${round}`, requiredChange: 'fix', sources: ['native[0]'], scope: 'in' }];
const transportMachine: import('../../../skills/dispatch/scripts/core/types.ts').Machine<number> = {
  transitions: [],
  initial: () => 0,
  step: (state, event) => ({ state: event.type === 'RUN_STARTED' || event.type === 'RULINGS' ? state + 1 : state, effects: [] }),
  awaitOf: () => 'rule',
  project: (state) => ({ at: 'review', data: { findings: transportFindings(state) } }),
};
const summaries = (round: number) => transportFindings(round).map(({ id, severity, category, locus }) => ({ id, severity, category, locus }));

test('diagnostics amendment findings transport writes current full findings, overwrites and repairs on replay', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'runs', '001-review');
  const options = { ports, runDir, runRel: 'runs/001-review', machine: transportMachine, handlers: fakeHandlers };
  const result = await start({ ...options, runStarted: RUN_STARTED });
  const file = path.join(runDir, 'rule.findings.json');
  assert.equal(result.frame?.data['findingsPath'], 'runs/001-review/rule.findings.json');
  assert.deepEqual(result.frame?.data['findings'], summaries(1));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), transportFindings(1));
  assert.deepEqual(transportMachine.project(1).data['findings'], transportFindings(1));
  const next = await send({ ...options, rawEvent: { type: 'RULINGS', rulings: {} } });
  assert.deepEqual(next.frame?.data['findings'], summaries(2));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), transportFindings(2));
  fs.writeFileSync(file, '[]');
  assert.deepEqual((await send(options)).frame?.data['findings'], summaries(2));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), transportFindings(2));
  const rejected = await send({ ...options, rawEvent: { type: 'AUTHORED', path: 'p.md' } });
  assert.ok(rejected.frame?.error);
  assert.deepEqual(rejected.frame?.data['findings'], summaries(2));
  const refresh = await send({ ...options, refreshConfig: true });
  assert.ok(refresh.frame?.error);
  assert.deepEqual(refresh.frame?.data['findings'], summaries(2));
});

for (const freshness of ['current', 'missing', 'stale', 'invalid']) test(`diagnostics amendment findings transport dry-run ${freshness} writes nothing`, async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), 'runs', '001-review');
  const options = { ports, runDir, runRel: 'runs/001-review', machine: transportMachine, handlers: fakeHandlers };
  await start({ ...options, runStarted: RUN_STARTED });
  const file = path.join(runDir, 'rule.findings.json');
  if (freshness === 'missing') fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, freshness === 'invalid' ? '{bad' : JSON.stringify(transportFindings(freshness === 'stale' ? 0 : 1)));
  const before = ports.fs.listFiles(runDir).map((name) => [name, fs.readFileSync(path.join(runDir, name), 'utf8')]);
  for (const refreshConfig of [false, true]) {
    const result = await send({ ...options, dryRun: true, refreshConfig });
    assert.deepEqual(result.frame?.data['findings'], freshness === 'current' ? summaries(1) : transportFindings(1));
    assert.equal(result.frame?.data['findingsPath'], freshness === 'current' ? 'runs/001-review/rule.findings.json' : undefined);
  }
  assert.deepEqual(ports.fs.listFiles(runDir).map((name) => [name, fs.readFileSync(path.join(runDir, name), 'utf8')]), before);
});

test('diagnostics amendment findings transport leaves non-rule frames unchanged', async () => {
  const ports = fakePorts();
  const { runDir, result } = await startAwaiting(ports);
  assert.equal(result.frame?.data['findingsPath'], undefined);
  assert.equal(fs.existsSync(path.join(runDir, 'rule.findings.json')), false);
  assert.deepEqual(result.frame?.data, { artifact: 'plan', path: 'plan.md' });
});

test('diagnostics amendment findings transport adapts queued recovery and terminal effect results under the lock', async () => {
  type State = { findings: ReturnType<typeof transportFindings>; waiting: boolean; round: number };
  const machine: import('../../../skills/dispatch/scripts/core/types.ts').Machine<State> = {
    transitions: [],
    initial: () => ({ findings: [], waiting: false, round: 0 }),
    step(state, event) {
      if (event.type === 'RUN_STARTED' || event.type === 'RULINGS') {
        const round = state.round + 1;
        return { state: { ...state, waiting: true, round }, effects: [{ kind: 'wave', id: `fixture.wave.${round}`, round, roster: [], timeoutMs: 1000 }] };
      }
      if (event.type === 'WAVE_DONE') return { state: { ...state, waiting: false, findings: event.findings as State['findings'] }, effects: [] };
      return { state, effects: [] };
    },
    awaitOf: () => 'rule',
    project: (state) => ({ at: 'review', data: { findings: state.findings } }),
  };
  const ports = fakePorts(), runDir = path.join(tempDir(), 'runs', '001-review');
  const options = { ports, runDir, runRel: 'runs/001-review', machine, handlers: { wave: async (effect: import('../../../skills/dispatch/scripts/core/types.ts').Effect) => [{ type: 'WAVE_DONE' as const, effectId: effect.id, round: 1, slots: [], findings: transportFindings(effect.kind === 'wave' ? effect.round : 1) as never }] } };
  const atomic = ports.fs.writeAtomic;
  let writes = 0;
  ports.fs.writeAtomic = (file, text) => {
    if (file.endsWith('rule.findings.json')) { assert.equal(fs.existsSync(path.join(runDir, LOCK_FILE)), true); writes++; }
    atomic(file, text);
  };
  const started = await start({ ...options, runStarted: RUN_STARTED });
  assert.deepEqual(started.frame?.data['findings'], summaries(1));
  const current = await send({ ...options, rawEvent: { type: 'RULINGS', rulings: {} } });
  assert.deepEqual(current.frame?.data['findings'], summaries(2));
  const wave = Array.from(readJournal(ports, runDir).records).filter((line) => line.type === 'WAVE_DONE').at(-1)!;
  assert.deepEqual(wave.data['findings'], transportFindings(2), 'journal retains bodies');
  appendEvent(ports, runDir, 'RULINGS', { rulings: {} });
  const queued = await send({ ...options, rawEvent: { type: 'RULINGS', rulings: {} } });
  assert.ok(queued.frame?.error);
  assert.deepEqual(queued.frame?.data['findings'], summaries(2));
  const recovered = await send(options);
  assert.deepEqual(recovered.frame?.data['findings'], summaries(3));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'rule.findings.json'), 'utf8')), transportFindings(3));
  assert.equal(writes, 4);
});

test('diagnostics amendment findings transport publish failure preserves completed effects and inline findings', async () => {
  const ports = fakePorts();
  const runDir = path.join(tempDir(), 'runs', '001-review');
  const machine = {
    ...awaitingMachine,
    awaitOf: (state: ReturnType<typeof awaitingMachine.initial>) => state.tag === 'done' ? 'rule' as const : awaitingMachine.awaitOf(state),
    project: (state: ReturnType<typeof awaitingMachine.initial>) => state.tag === 'done' ? { at: 'review', data: { findings: transportFindings(1) } } : awaitingMachine.project(state),
  };
  let effects = 0;
  const handlers = { ...fakeHandlers, verify: async (...args: Parameters<NonNullable<typeof fakeHandlers.verify>>) => { effects++; return fakeHandlers.verify!(...args); } };
  const options = { ports, runDir, machine, handlers };
  await start({ ...options, runStarted: RUN_STARTED });
  const atomic = ports.fs.writeAtomic;
  ports.fs.writeAtomic = (file, text) => { if (file.endsWith('rule.findings.json')) throw new Error('injected publish failure'); atomic(file, text); };
  const result = await send({ ...options, rawEvent: { type: 'AUTHORED', path: 'plan.md' } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.frame?.await, 'rule');
  assert.deepEqual(result.frame?.data['findings'], transportFindings(1));
  assert.equal(result.frame?.data['findingsPath'], undefined);
  assert.deepEqual(types(ports, runDir), ['RUN_STARTED', 'EFFECT_STARTED', 'SNAPSHOT', 'AUTHORED', 'EFFECT_STARTED', 'VERIFY_DONE']);
  const journal = bytes(runDir);
  const replay = await send(options);
  assert.equal(replay.exitCode, 0);
  assert.deepEqual(replay.frame?.data['findings'], transportFindings(1));
  assert.equal(replay.frame?.data['findingsPath'], undefined);
  assert.deepEqual(bytes(runDir), journal);
  assert.equal(effects, 1);
});
