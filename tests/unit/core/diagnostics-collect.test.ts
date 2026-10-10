import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { collectRunFacts, renderSessionDiagnostics, type FoldRun, type TimelineStep } from '../../../skills/dispatch/scripts/core/diagnostics.ts';
import { dispatchMachine, fold, send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { appendEvent, readJournal } from '../../../skills/dispatch/scripts/core/journal.ts';
import type { Await, Effect, Event, Handlers, Machine, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { heuristics, renderDiagnostics, type Phase } from '../../../skills/dispatch/scripts/domain/diagnostics.ts';
import { createHandoff } from '../../../skills/dispatch/scripts/effects/handoff.ts';
import { diagnosticPhases } from '../../../skills/dispatch/scripts/machines/diagnostics.ts';
import type { RootState } from '../../../skills/dispatch/scripts/machines/root.ts';
import { validateNativeResults } from '../../../skills/dispatch/scripts/machines/review.ts';
import { FIXED_NOW, fakePorts, tempDir, type FakePorts } from '../../helpers/fake-ports.ts';
import { RUN_STARTED, snapshotResult } from './fixtures/machines.ts';

const INSTRUCTION = 'Reply RETRO with at most 3 observations about dispatch-owned components; [] is valid.';
const OBSERVATION = { id: 'slow-author', component: 'references/templates/plan.md', category: 'speed', evidence: 'The author turn re-read the template twice.', impact: 'One extra host turn per plan.', proposedFix: 'Put the template checklist in the author frame.' };
const PLAN: Phase = { key: 'plan', name: 'plan' };
const REVIEW: Phase = { key: 'plan-review', name: 'plan review' };
const IMPL: Phase = { key: 'impl', name: 'implementation' };
const closed = (phase: Phase): Phase => ({ ...phase, outcome: 'complete' });
const read = (file: string): string => fs.readFileSync(file, 'utf8');

/** A collector fold over any fixture machine: the real `fold`, with test-owned phases standing in for the root machine's. */
function testFold<S>(machine: Machine<S>, phasesOf: (state: S) => Phase[], userOf: (state: S) => boolean = () => false): FoldRun {
  return (lines) => {
    const steps: TimelineStep[] = [];
    let signature = '';
    fold(machine, lines, undefined, (state, line) => {
      const awaiting = machine.awaitOf(state);
      const step: TimelineStep = { seq: line.seq, phases: phasesOf(state), awaiting, user: userOf(state), ...(awaiting === 'done' ? { outcome: String(machine.project(state).data['outcome']) } : {}) };
      const next = JSON.stringify([step.phases, step.awaiting, step.user, step.outcome]);
      if (next !== signature) { steps.push(step); signature = next; }
    });
    return { steps, orchestratorBytes: 0 };
  };
}

/** A clock the test advances; journal `at` stamps and fault-note times all read it. */
function steppedPorts(): { ports: FakePorts; advance: (ms: number) => void; now: () => number } {
  const ports = fakePorts();
  let now = FIXED_NOW;
  ports.clock.now = () => now;
  return { ports, advance: (ms) => { now += ms; }, now: () => now };
}

// SECTION: Flow machine — plan (author), plan review (wave, rule), implementation (native, approval, write).

type FlowTag = 'new' | 'snapshotting' | 'author' | 'waving' | 'rule' | 'native' | 'approve' | 'write' | 'done';
type FlowState = { tag: FlowTag; pending: number };
const FLOW_AWAIT: Partial<Record<FlowTag, Await>> = { author: 'author', rule: 'rule', native: 'native', approve: 'decide', write: 'write', done: 'done' };
const flowMachine: Machine<FlowState> = {
  initial: () => ({ tag: 'new', pending: 0 }),
  step(state, event: Event) {
    const to = (tag: FlowTag, effects: Effect[] = [], pending = state.pending) => ({ state: { tag, pending }, effects });
    switch (`${state.tag}:${event.type}`) {
      case 'new:RUN_STARTED': return to('snapshotting', [{ kind: 'snapshot', id: 'flow.snapshot.1', since: null }]);
      case 'snapshotting:SNAPSHOT': return to('author');
      case 'author:AUTHORED': return to('waving', [{ kind: 'wave', id: 'flow.wave.1', round: 1, roster: [], timeoutMs: 60_000 }]);
      case 'waving:WAVE_DONE': return to('rule');
      case 'rule:RULINGS': return to('native');
      case 'native:NATIVE_RESULTS': return to('approve');
      case 'approve:DECISION': return to('write');
      case 'write:WRITE_LAUNCHED': return to('write', [], (event as { tasks: unknown[] }).tasks.length);
      case 'write:WRITE_ENVELOPE': case 'write:WRITE_FAILED': return to(state.pending > 1 ? 'write' : 'done', [], state.pending - 1);
      default: return { state, effects: [] };
    }
  },
  awaitOf: (state) => FLOW_AWAIT[state.tag] ?? null,
  project: (state) => ({ at: `flow › ${state.tag}`, data: state.tag === 'done' ? { outcome: 'complete' } : { kind: state.tag === 'approve' ? 'approval' : state.tag } }),
  transitions: [
    { from: 'new', on: 'RUN_STARTED', to: 'snapshotting' }, { from: 'snapshotting', on: 'SNAPSHOT', to: 'author' }, { from: 'author', on: 'AUTHORED', to: 'waving' },
    { from: 'waving', on: 'WAVE_DONE', to: 'rule' }, { from: 'rule', on: 'RULINGS', to: 'native' }, { from: 'native', on: 'NATIVE_RESULTS', to: 'approve' },
    { from: 'approve', on: 'DECISION', to: 'write' }, { from: 'write', on: 'WRITE_ENVELOPE', to: 'done' },
  ],
};
const flowPhases = (state: FlowState): Phase[] => {
  if (['new', 'snapshotting', 'author'].includes(state.tag)) return [PLAN];
  if (state.tag === 'waving' || state.tag === 'rule') return [closed(PLAN), REVIEW];
  return state.tag === 'done' ? [closed(PLAN), closed(REVIEW), closed(IMPL)] : [closed(PLAN), closed(REVIEW), IMPL];
};
const flowFold = testFold(flowMachine, flowPhases, (state) => state.tag === 'approve');

const WAVE_SLOTS = [
  { slot: 'codex[0]', provider: 'codex', invocations: [
    { provider: 'codex', model: 'gpt-x', mode: 'cli', effort: 'high', launched: true, durationMs: 4_000, outcome: 'effort-unsupported' },
    { provider: 'codex', model: 'gpt-x', mode: 'cli', effort: null, launched: true, durationMs: 16_000, outcome: 'ok', usage: { input: 1_000, output: 200, cacheRead: 400, scope: 'invocation', provenance: 'codex.turn.completed', inputSemantics: 'includes-cache' } },
  ] },
  { slot: 'claude[0]', provider: 'claude', invocations: [
    { provider: 'claude', model: 'opus', mode: 'cli', effort: null, launched: true, durationMs: 12_000, outcome: 'ok', usage: { input: 50, output: 300, cacheRead: 2_000, cacheWrite: 100, scope: 'invocation', provenance: 'claude.result.modelUsage', inputSemantics: 'uncached', actualModels: ['opus', 'haiku'], models: { opus: { input: 40, output: 250, cacheRead: 2_000, cacheWrite: 100 }, haiku: { input: 10, output: 50 } } } },
  ] },
  { slot: 'gemini[0]', provider: 'gemini', invocations: [{ provider: 'gemini', model: null, mode: 'cli', effort: null, launched: false, outcome: 'not-found' }] },
];

/** One full flow run with known waits: 1s snapshot, 300s author wait (a rejected reply inside it), 20s wave, then host and user waits. */
async function flowRun() {
  const { ports, advance } = steppedPorts();
  const runDir = path.join(tempDir(), '.state/runs/001-plan');
  const handlers: Handlers = {
    snapshot: async (effect) => { advance(1_000); return [snapshotResult(effect.id)]; },
    wave: async (effect) => { advance(20_000); return [{ type: 'WAVE_DONE', effectId: effect.id, round: effect.round, slots: WAVE_SLOTS, findings: [{ id: 'F1' }, { id: 'F2' }] }]; },
  };
  const base = { ports, runDir, machine: flowMachine, handlers };
  const awaits: (string | undefined)[] = [];
  const runStarted: RunStartedEvent = { ...RUN_STARTED, verb: 'plan', level: 'medium', pins: { kind: 'count', count: 2 } };
  awaits.push((await start({ ...base, runStarted })).frame?.await);
  const reply = async (wait: number, rawEvent: unknown) => { advance(wait); awaits.push((await send({ ...base, rawEvent })).frame?.await); };
  const write = { signature: 's', handle: 'h' };
  await reply(100_000, { type: 'RULINGS', rulings: {} });
  await reply(200_000, { type: 'AUTHORED', path: 'plan.md' });
  await reply(60_000, { type: 'RULINGS', rulings: { F1: { ruling: 'accept' }, F2: { ruling: 'reject' } } });
  await reply(30_000, { type: 'NATIVE_RESULTS', slots: [{ slot: 'claude[0]', model: 'sonnet', tokens: 5_000, durationMs: 60_000 }, { slot: 'claude[1]' }] });
  await reply(900_000, { type: 'DECISION', kind: 'approval', answer: { approved: true } });
  await reply(10_000, { type: 'WRITE_LAUNCHED', tasks: [{ task: 'T1', attempt: 1, ...write, model: 'opus', effort: 'high' }, { task: 'T2', attempt: 2, ...write, model: 'sonnet' }] });
  await reply(40_000, { type: 'WRITE_ENVELOPE', envelopePath: 't1.json', task: 'T1', attempt: 1, ...write, tokens: 1_200, durationMs: 30_000 });
  await reply(5_000, { type: 'WRITE_FAILED', model: 'sonnet', kind: 'crash', reason: 'exit 1', task: 'T2', attempt: 2, ...write });
  assert.deepEqual(awaits, ['author', 'author', 'rule', 'native', 'decide', 'write', 'write', 'write', 'done']);
  return { ports, runDir, facts: collectRunFacts(ports, runDir, {}, flowFold) };
}

// SECTION: Review flow and host machine — the interpreter's toggle and retro wiring.

function reviewRun(toggle: { on: boolean }, session = tempDir(), id = '001-review') {
  const ports = fakePorts(), runDir = path.join(session, '.state/runs', id);
  const handlers: Handlers = {
    'prepare-review': async (effect) => [{ type: 'REVIEW_PREPARED', effectId: effect.id, scope: { paths: [], empty: true }, promptPaths: {} }],
    handoff: createHandoff({ tempRoot: session, workspaceRoot: path.dirname(session) }),
  };
  const base = { ports, runDir, machine: dispatchMachine, handlers, diagnosticToggle: () => toggle.on, diagnosticRetroInstruction: () => INSTRUCTION };
  const runStarted: RunStartedEvent = {
    ...RUN_STARTED, verb: 'review', argument: 'src', overrides: { sessionDir: session },
    config: { 'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } }, phases: { 'code-review': { rounds: { low: 1 }, targets: { low: 1 } } } },
  };
  return {
    ports, session, runDir,
    begin: () => start({ ...base, runStarted }),
    reply: (rawEvent: unknown) => send({ ...base, rawEvent }),
    status: () => send({ ...base, dryRun: true }),
  };
}

type HandoffHandler = NonNullable<Handlers['handoff']>;
/** A real code review through dispatchMachine with one codex finding per round; diagnostics on, so it ends at retro. */
function codeReview(finding: (round: number) => Record<string, unknown>, rounds: number, ports: FakePorts = fakePorts(), wrapHandoff = (handoff: HandoffHandler): HandoffHandler => handoff) {
  const session = tempDir(), runDir = path.join(session, '.state/runs/001-review');
  const handlers: Handlers = {
    'prepare-review': async (effect) => [{ type: 'REVIEW_PREPARED', effectId: effect.id, scope: { paths: ['src/a.ts'] }, promptPaths: { 'codex[0]': 'p0.md' } }],
    'wave-start': async (effect) => [{ type: 'WAVE_STARTED', effectId: effect.id, waveKey: effect.id, attempt: 1, roster: effect.roster, native: [], early: [], claimPath: null, inputPath: 'input.json' }],
    'wave-finish': async (effect) => [{ type: 'WAVE_DONE', effectId: effect.id, round: effect.round, slots: [{ slot: 'codex[0]', state: 'success' }], findings: [finding(effect.round)] as never }],
    handoff: wrapHandoff(createHandoff({ tempRoot: session, workspaceRoot: path.dirname(session) })),
  };
  const base = { ports, runDir, machine: dispatchMachine, handlers, diagnosticToggle: () => true, diagnosticRetroInstruction: () => INSTRUCTION };
  const runStarted: RunStartedEvent = {
    ...RUN_STARTED, verb: 'review', argument: 'src', overrides: { sessionDir: session },
    config: { 'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } }, phases: { 'code-review': { rounds: { low: rounds }, targets: { low: 1 } } } },
  };
  return {
    ports, runDir,
    report: () => read(path.join(session, 'diagnostics.md')),
    begin: async () => (await start({ ...base, runStarted })).frame?.await,
    /** The next await, or the frame error for a rejected event or a fault. */
    reply: async (rawEvent: unknown) => { const result = await send({ ...base, rawEvent }); return result.frame?.error ?? result.frame?.await; },
  };
}
const reviewFinding = (round: number, category = 'correctness') => ({ id: `R${round}-F001`, severity: 'MUST', category, locus: 'src/a.ts:L3', defect: 'null deref', requiredChange: 'guard it', sources: ['codex[0]'], scope: 'in' });

type HostState = { tag: 'booting' | 'author' | 'native' | 'write' | 'done' };
const hostMachine: Machine<HostState> = {
  initial: () => ({ tag: 'booting' }),
  step(state, event) {
    if (event.type === 'RUN_STARTED') return { state: { tag: 'author' }, effects: [] };
    if (event.type === 'AUTHORED' && state.tag === 'author') return { state: { tag: 'native' }, effects: [] };
    if (event.type === 'NATIVE_RESULTS' && state.tag === 'native') return { state: { tag: 'write' }, effects: [] };
    if (event.type === 'WRITE_ENVELOPE' && state.tag === 'write') return { state: { tag: 'done' }, effects: [] };
    return { state, effects: [] };
  },
  awaitOf: (state) => state.tag === 'booting' ? null : state.tag,
  project: (state) => ({ at: `host › ${state.tag}`, data: state.tag === 'done' ? { outcome: 'complete' } : { kind: state.tag, path: 'plan.md' } }),
  transitions: [{ from: 'author', on: 'AUTHORED', to: 'native' }, { from: 'native', on: 'NATIVE_RESULTS', to: 'write' }, { from: 'write', on: 'WRITE_ENVELOPE', to: 'done' }],
};

// SECTION: SC10

test('SC10 derives phases gaps and user waits from journal', async () => {
  const { facts } = await flowRun();
  assert.deepEqual(facts.phases, [
    { key: 'plan', name: 'plan', outcome: 'complete', wallMs: 301_000, driverMs: 1_000, hostMs: 300_000, userMs: 0 },
    { key: 'plan-review', name: 'plan review', outcome: 'complete', wallMs: 80_000, driverMs: 20_000, hostMs: 60_000, userMs: 0 },
    { key: 'impl', name: 'implementation', outcome: 'complete', wallMs: 985_000, driverMs: 0, hostMs: 85_000, userMs: 900_000 },
  ]);
  assert.equal(facts.phases.reduce((total, phase) => total + (phase.wallMs ?? 0), 0), 1_366_000, 'phase walls sum to the run wall');
  assert.deepEqual(facts.hostGaps, [
    { await: 'author', ms: 300_000 }, { await: 'rule', ms: 60_000 }, { await: 'native', ms: 30_000 },
    { await: 'write', ms: 10_000 }, { await: 'write', ms: 40_000 }, { await: 'write', ms: 5_000 },
  ], 'the rejected reply is a note and never splits the author wait; the approval wait is user time');
  assert.equal(facts.rejectedEvents.length, 1);
  assert.equal(facts.rejectedEvents[0]?.eventType, 'RULINGS');
  assert.equal(facts.rejectedEvents[0]?.reason, 'wrong-await at event.type');
  assert.deepEqual([facts.verb, facts.level, facts.pins, facts.host, facts.outcome], ['plan', 'medium', '2', 'claude', 'complete']);
  assert.deepEqual(facts.reviews, [{ phase: 'plan-review', round: 1, accepted: 1, rejected: 1 }]);
});

test('SC10 derives invocation totals and attestations', async () => {
  const { facts } = await flowRun();
  const cli = { phase: 'plan-review', surface: 'cli', mode: 'cli' } as const;
  assert.deepEqual(facts.invocations, [
    { ...cli, provider: 'codex', model: 'gpt-x', effort: 'high', launched: true, durationMs: 4_000, outcome: 'effort-unsupported' },
    { ...cli, provider: 'codex', model: 'gpt-x', launched: true, durationMs: 16_000, outcome: 'ok', usage: { input: 600, output: 200, cacheRead: 400 } },
    { ...cli, provider: 'claude', model: 'opus', launched: true, durationMs: 12_000, outcome: 'ok', usage: { input: 50, output: 300, cacheRead: 2_000, cacheWrite: 100, models: { opus: { input: 40, output: 250, cacheRead: 2_000, cacheWrite: 100 }, haiku: { input: 10, output: 50 } } }, reportedModels: ['opus', 'haiku'] },
    { ...cli, provider: 'gemini', model: 'default', launched: false, outcome: 'not-found' },
    { phase: 'impl', provider: 'claude', model: 'sonnet', surface: 'native', launched: true, outcome: 'ok', estimated: true, tokens: 5_000, durationMs: 60_000 },
    { phase: 'impl', provider: 'claude', model: '—', surface: 'native', launched: true, outcome: 'ok', estimated: true },
    { phase: 'impl', provider: 'claude', model: 'opus', effort: 'high', mode: 'write', surface: 'native', launched: true, outcome: 'ok', estimated: true, tokens: 1_200, durationMs: 30_000 },
    { phase: 'impl', provider: 'claude', model: 'sonnet', mode: 'write', surface: 'native', launched: true, outcome: 'failed', estimated: true },
  ]);
  assert.equal(facts.repairs, 1, 'a second write attempt is a repair');
  const report = renderDiagnostics([facts]).text;
  assert.ok(report.includes('- Measured tokens: 3,650 (input 650 · cache read 2,400 · cache write 100 · output 500) · coverage 2/3'), 'measured totals exclude estimates; unlaunched attempts never count against coverage');
  assert.ok(report.includes('native and write ~6,200'), 'attested native and write tokens stay a separate estimate');
  assert.ok(report.includes('| codex | all models | 600 | 400 | — | 200 | 1/2 |'));
  assert.ok(report.includes('| claude | haiku | 10 | — | — | 50 | — |'), 'per-model counters split the cascade');
});

test('SC10 native receipt records launched model and effort', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), '.state/runs/001-host');
  const descriptor = { sourceKey: 'claude[0]', substitutesFor: null, outputPath: 'native/claude-0.md', model: 'claude-opus-5-5', reasoningEffort: 'high' };
  const mapping = { configuredModel: 'claude-opus-5-5', launcherModel: 'claude-sonnet-5', launcherEffort: 'medium', substitution: 'opus quota exhausted; launched sonnet at medium', provider: 'anthropic' };
  const receipt = { slot: 'claude[0]', sourceKey: 'claude[0]', outputPath: 'native/claude-0.md', mapping, tokens: 4_200, durationMs: 90_000 };
  assert.equal(validateNativeResults([receipt], [descriptor]), null, 'the disclosed substitution makes the differing launch protocol-valid');
  const { substitution: _substitution, ...undisclosed } = mapping;
  assert.match(validateNativeResults([{ ...receipt, mapping: undisclosed }], [descriptor]) ?? '', /substitution reason/);
  const base = { ports, runDir, machine: hostMachine, handlers: {} };
  await start({ ...base, runStarted: RUN_STARTED });
  await send({ ...base, rawEvent: { type: 'AUTHORED', path: 'plan.md' } });
  const native = await send({ ...base, rawEvent: { type: 'NATIVE_RESULTS', slots: [receipt] } });
  assert.equal(native.frame?.await, 'write', native.frame?.error);
  const facts = collectRunFacts(ports, runDir, {}, testFold(hostMachine, () => [IMPL]));
  assert.deepEqual(facts.invocations, [{ phase: 'impl', provider: 'claude', model: 'claude-sonnet-5', effort: 'medium', surface: 'native', launched: true, outcome: 'ok', estimated: true, tokens: 4_200, durationMs: 90_000 }]);
  assert.ok(renderDiagnostics([facts]).text.includes('| 1 | implementation | claude (native) | claude-sonnet-5 | medium | 1m 30s | — | — | — | — | ~4,200 | ok |'));
});

test('SC10 H2 fires when round 2 re-raises a carried rejection', async () => {
  const review = codeReview((round) => reviewFinding(round), 2);
  assert.equal(await review.begin(), 'rule');
  assert.equal(await review.reply({ type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'reject', reason: 'intended behavior' } } }), 'rule', 'the rejection is carried and re-raised in round 2');
  assert.equal(await review.reply({ type: 'RULINGS', rulings: { 'R2-F001': { ruling: 'accept' } } }), 'retro');
  assert.equal(await review.reply({ type: 'RETRO', observations: [] }), 'done');
  assert.match(review.report(), /code review: 2 rounds; 1 finding re-raised across rounds \(R1-F001\)\./);
});

test('SC10 later run-end render replaces older snapshot', async () => {
  const toggle = { on: true }, session = tempDir(), report = path.join(session, 'diagnostics.md');
  const first = reviewRun(toggle, session, '001-review');
  await first.begin();
  await first.reply({ type: 'RETRO', observations: [OBSERVATION] });
  assert.match(read(report), /- Runs: 1 · /);
  const second = reviewRun(toggle, session, '002-review');
  await second.begin();
  assert.match(read(report), /- Runs: 1 · /, 'a run paused at retro does not render');
  const third = reviewRun(toggle, session, '003-review');
  await third.begin();
  await third.reply({ type: 'RETRO', observations: [] });
  let text = read(report);
  assert.match(text, /- Runs: 3 · /);
  assert.match(text, /- Host retro: 1 accepted · 0 rejected/);
  assert.ok(text.includes('Run 2: verb review, level low, pins —, outcome in-progress.'));
  await second.reply({ type: 'RETRO', observations: [] });
  text = read(report);
  assert.ok(text.includes('Run 2: verb review, level low, pins —, outcome no-reviewable-changes.'), 'the latest run-end render replaces the stale snapshot');
  assert.match(text, /- Runs: 3 · /);
});

test('SC10 collector imports no machines', () => {
  const source = read(path.join(import.meta.dirname, '../../../skills/dispatch/scripts/core/diagnostics.ts'));
  const imports = [...source.matchAll(/^import [^;]* from '([^']+)';$/gm)].map((match) => match[1] ?? '');
  assert.ok(imports.length > 0);
  assert.deepEqual(imports.filter((specifier) => /machines\/|interpreter/.test(specifier)), []);
});

// SECTION: Heuristic precision

type RoundsState = { tag: 'new' | 'waving' | 'rule' | 'done'; round: number };
const waveRound = (round: number) => ({ state: { tag: 'waving' as const, round }, effects: [{ kind: 'wave' as const, id: `rounds.wave.${round}`, round, roster: [], timeoutMs: 60_000 }] });
/** A review that runs three wave rounds, each followed by a rule await. */
const roundsMachine: Machine<RoundsState> = {
  initial: () => ({ tag: 'new', round: 0 }),
  step(state, event) {
    if (event.type === 'RUN_STARTED' && state.tag === 'new') return waveRound(1);
    if (event.type === 'WAVE_DONE' && state.tag === 'waving') return { state: { tag: 'rule', round: state.round }, effects: [] };
    if (event.type === 'RULINGS' && state.tag === 'rule') return state.round < 3 ? waveRound(state.round + 1) : { state: { tag: 'done', round: state.round }, effects: [] };
    return { state, effects: [] };
  },
  awaitOf: (state) => state.tag === 'rule' ? 'rule' : state.tag === 'done' ? 'done' : null,
  project: (state) => ({ at: `rounds › ${state.tag}`, data: state.tag === 'done' ? { outcome: 'complete' } : { round: state.round } }),
  transitions: [{ from: 'new', on: 'RUN_STARTED', to: 'waving' }, { from: 'waving', on: 'WAVE_DONE', to: 'rule' }, { from: 'rule', on: 'RULINGS', to: 'waving' }, { from: 'rule', on: 'RULINGS', to: 'done' }],
};

test('heuristic precision collector carries review cap', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), '.state/runs/001-review');
  const handlers: Handlers = { wave: async (effect) => [{ type: 'WAVE_DONE', effectId: effect.id, round: effect.round, slots: [], findings: [] }] };
  const base = { ports, runDir, machine: roundsMachine, handlers };
  await start({ ...base, runStarted: RUN_STARTED });
  for (let round = 1; round <= 3; round++) await send({ ...base, rawEvent: { type: 'RULINGS', rulings: {} } });
  const review: Phase = { key: 'review', name: 'code review' };
  const phases = (cap?: number) => (state: RoundsState): Phase[] => [{ ...review, ...(cap === undefined ? {} : { cap }), ...(state.tag === 'done' ? { outcome: 'complete' } : {}) }];
  const capped = collectRunFacts(ports, runDir, {}, testFold(roundsMachine, phases(3)));
  assert.deepEqual(capped.reviews, [1, 2, 3].map((round) => ({ phase: 'review', round, accepted: 0, rejected: 0, cap: 3 })));
  assert.deepEqual(heuristics(capped).filter((finding) => finding.source === 'H2'), [], 'three rounds within cap 3 is normal convergence');
  const uncapped = collectRunFacts(ports, runDir, {}, testFold(roundsMachine, phases()));
  assert.equal(heuristics(uncapped).filter((finding) => finding.source === 'H2').length, 1, 'without a cap the fallback threshold still fires');
});

test('heuristic precision production phases carry review cap', async () => {
  // Distinct findings per round, so no round re-raises a carried rejection and only the round count can trip H2.
  const finding = (round: number) => ({ ...reviewFinding(round), locus: `src/file-${round}.ts:L3` });
  const review = codeReview(finding, 3);
  assert.equal(await review.begin(), 'rule');
  assert.equal(await review.reply({ type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'reject', reason: 'intended behavior' } } }), 'rule');
  assert.equal(await review.reply({ type: 'RULINGS', rulings: { 'R2-F001': { ruling: 'reject', reason: 'intended behavior' } } }), 'rule');
  assert.equal(await review.reply({ type: 'RULINGS', rulings: { 'R3-F001': { ruling: 'accept' } } }), 'retro');
  assert.equal(await review.reply({ type: 'RETRO', observations: [] }), 'done');
  const facts = collectRunFacts(review.ports, review.runDir, {}, testFold(dispatchMachine, (state) => diagnosticPhases(state as RootState)));
  assert.deepEqual(facts.reviews.map((row) => [row.round, row.cap]), [[1, 3], [2, 3], [3, 3]], 'the root machine phases carry the resolved cap on every round');
  const report = review.report();
  assert.doesNotMatch(report, /\bH2\b|code review: 3 rounds/, 'three rounds within cap 3 is normal convergence');
});

test('heuristic precision omits a run whose journal fails to fold', async () => {
  const session = tempDir(), ports = fakePorts();
  const runDir = (id: string) => path.join(session, '.state/runs', id);
  const base = (id: string) => ({ ports, runDir: runDir(id), machine: hostMachine, handlers: {} });
  await start({ ...base('001-host'), runStarted: RUN_STARTED });
  await send({ ...base('001-host'), rawEvent: { type: 'AUTHORED', path: 'plan.md' } });
  await start({ ...base('002-host'), runStarted: RUN_STARTED });
  // An effect start the machine never queued faults the fold, as a journal from an older driver can.
  appendEvent(ports, runDir('002-host'), 'EFFECT_STARTED', { effectId: 'ghost.verify.1', kind: 'verify', attempt: 1 });
  let warnings = 0;
  const result = renderSessionDiagnostics(ports, runDir('001-host'), {}, testFold(hostMachine, () => [IMPL]), () => { warnings++; });
  assert.ok(result, 'the report still renders');
  assert.equal(warnings, 1, 'the unfoldable run warns once');
  assert.match(read(path.join(session, 'diagnostics.md')), /^- Runs: 1 · /m, 'only the foldable run is counted');
});

// SECTION: SC3 — rejection redaction

test('SC3 rejected event canaries never reach the report', async () => {
  const session = tempDir(), ports = fakePorts(), runDir = path.join(session, '.state/runs/001-host');
  const base = { ports, runDir, machine: hostMachine, handlers: {}, diagnosticToggle: () => true };
  await start({ ...base, runStarted: RUN_STARTED });
  await send({ ...base, rawEvent: { type: 'AUTHORED', path: 'plan.md' } });
  const value = await send({ ...base, rawEvent: { type: 'NATIVE_RESULTS', slots: [{ slot: 'claude[0]', tokens: 'CANARY_VALUE_123' }] } });
  assert.match(value.frame?.error ?? '', /CANARY_VALUE_123/, 'the host still sees the validator detail');
  const key = await send({ ...base, rawEvent: { type: 'NATIVE_RESULTS', slots: [], CANARY_KEY_456: 'CANARY_VALUE_789' } });
  assert.match(key.frame?.error ?? '', /CANARY_KEY_456/);
  const type = await send({ ...base, rawEvent: { type: 'CANARY type 000', slots: [] } });
  assert.match(type.frame?.error ?? '', /CANARY type 000/);
  const notes = [...readJournal(ports, runDir).records].filter((line) => line.type === 'DIAGNOSTIC_NOTE');
  assert.deepEqual(notes.map((line) => line.data), [
    { kind: 'event-rejected', eventType: 'NATIVE_RESULTS', reason: 'invalid-value at event.slots[0].tokens' },
    { kind: 'event-rejected', eventType: 'NATIVE_RESULTS', reason: 'unexpected-field at event.*' },
    { kind: 'event-rejected', eventType: 'UNKNOWN', reason: 'unknown-type at event.type' },
  ], 'the note journals only a known event type, the class, and an allowlisted path');
  await send({ ...base, rawEvent: { type: 'NATIVE_RESULTS', slots: [] } });
  assert.equal((await send({ ...base, rawEvent: { type: 'WRITE_ENVELOPE', envelopePath: 'e.json' } })).frame?.await, 'done');
  assert.doesNotMatch(JSON.stringify([...readJournal(ports, runDir).records]), /CANARY/, 'no journal line holds a submitted value, key, or type');
  const report = read(path.join(session, 'diagnostics.md'));
  assert.doesNotMatch(report, /CANARY/, 'neither the submitted value nor the arbitrary key renders');
  assert.ok(report.includes('3 host events rejected (NATIVE_RESULTS ×2, UNKNOWN ×1): "invalid-value at event.slots[0].tokens"; "unexpected-field at event.*"; "unknown-type at event.type".'), report);
});
