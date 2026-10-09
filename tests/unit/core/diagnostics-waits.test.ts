import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { collectRunFacts, type FoldRun, type TimelineStep } from '../../../skills/dispatch/scripts/core/diagnostics.ts';
import { dispatchMachine, fold, send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { readJournal } from '../../../skills/dispatch/scripts/core/journal.ts';
import type { Effect, Handlers, Machine, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { heuristics, type Phase } from '../../../skills/dispatch/scripts/domain/diagnostics.ts';
import { createHandoff } from '../../../skills/dispatch/scripts/effects/handoff.ts';
import { FIXED_NOW, fakePorts, tempDir, type FakePorts } from '../../helpers/fake-ports.ts';
import { awaitingMachine, RUN_STARTED, snapshotResult, type AwaitingState } from './fixtures/machines.ts';

const INSTRUCTION = 'Reply RETRO with at most 3 observations about dispatch-owned components; [] is valid.';
const OBSERVATION = { id: 'slow-author', component: 'references/templates/plan.md', category: 'speed', evidence: 'The author turn re-read the template twice.', impact: 'One extra host turn per plan.', proposedFix: 'Put the template checklist in the author frame.' };
const PLAN: Phase = { key: 'plan', name: 'plan' };
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
    report: () => read(path.join(session, 'diagnostics.md')),
    begin: async () => (await start({ ...base, runStarted })).frame?.await,
    /** The next await, or the frame error for a rejected event or a fault. */
    reply: async (rawEvent: unknown) => { const result = await send({ ...base, rawEvent }); return result.frame?.error ?? result.frame?.await; },
  };
}
const reviewFinding = (round: number, category = 'correctness') => ({ id: `R${round}-F001`, severity: 'MUST', category, locus: 'src/a.ts:L3', defect: 'null deref', requiredChange: 'guard it', sources: ['codex[0]'], scope: 'in' });
/** The production needs-user answer: one ruling and the user's words per finding. */
const needsUser = { type: 'DECISION', kind: 'needs-user', answer: { 'R1-F001': { ruling: 'accept', quote: 'Yes, change the API.' } } };

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

const verifyDone = (effect: Extract<Effect, { kind: 'verify' }>) => [{ type: 'VERIFY_DONE' as const, effectId: effect.id, purpose: effect.purpose, results: [], fingerprint: {} }];
const portTimeout = () => Object.assign(new Error('timed out reading /home/alice/secret-notes.txt'), { name: 'PortTimeout' });
const askPhases = (state: AwaitingState): Phase[] => [state.tag === 'done' ? closed(PLAN) : PLAN];

type GateState = { tag: 'new' | 'approve' | 'verifying' | 'done' };
/** Awaits an approval (a user wait), then verifies before completing. */
const gateMachine: Machine<GateState> = {
  initial: () => ({ tag: 'new' }),
  step(state, event) {
    if (event.type === 'RUN_STARTED' && state.tag === 'new') return { state: { tag: 'approve' }, effects: [] };
    if (event.type === 'DECISION' && state.tag === 'approve') return { state: { tag: 'verifying' }, effects: [{ kind: 'verify', id: 'gate.verify.1', purpose: 'final', commands: [] }] };
    if (event.type === 'VERIFY_DONE' && state.tag === 'verifying') return { state: { tag: 'done' }, effects: [] };
    return { state, effects: [] };
  },
  awaitOf: (state) => state.tag === 'approve' ? 'decide' : state.tag === 'done' ? 'done' : null,
  project: (state) => ({ at: `gate › ${state.tag}`, data: state.tag === 'done' ? { outcome: 'complete' } : { kind: 'approval' } }),
  transitions: [{ from: 'new', on: 'RUN_STARTED', to: 'approve' }, { from: 'approve', on: 'DECISION', to: 'verifying' }, { from: 'verifying', on: 'VERIFY_DONE', to: 'done' }],
};

// SECTION: SC10 waits, faults, and toggles

test('SC10 needs-user wait counts as user time', async () => {
  const { ports, advance } = steppedPorts();
  const review = codeReview((round) => reviewFinding(round, 'intent'), 1, ports);
  assert.equal(await review.begin(), 'rule');
  advance(60_000);
  assert.equal(await review.reply({ type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'needs-user' } } }), 'decide');
  advance(7_200_000);
  assert.equal(await review.reply(needsUser), 'retro');
  advance(5_000);
  assert.equal(await review.reply({ type: 'RETRO', observations: [] }), 'done');
  const report = review.report();
  assert.match(report, /\| code review \| [a-z-]+ \| 2h 1m 5s \| <1s \| 1m 5s \| 2h 0m 0s \|/, 'the per-finding user ruling wait is user time, not host time');
  assert.doesNotMatch(report, /H6/, 'a user wait never raises the long host turn finding');
});

test('SC10 needs-user wait then failing send counts the wait as user time', async () => {
  const { ports, advance } = steppedPorts();
  let failing = true;
  const review = codeReview((round) => reviewFinding(round, 'intent'), 1, ports, (handoff) => async (effect, effectPorts, context) => {
    if (!failing) return handoff(effect, effectPorts, context);
    advance(500);
    throw portTimeout();
  });
  assert.equal(await review.begin(), 'rule');
  advance(60_000);
  assert.equal(await review.reply({ type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'needs-user' } } }), 'decide');
  advance(7_200_000);
  assert.match(String(await review.reply(needsUser)), /^PortTimeout/, 'the send faults and rolls back the needs-user reply');
  advance(60_000);
  failing = false;
  assert.equal(await review.reply(needsUser), 'retro');
  advance(5_000);
  assert.equal(await review.reply({ type: 'RETRO', observations: [] }), 'done');
  const report = review.report();
  assert.ok(report.includes('- Run 1 fault: `port-timeout` in `root.handoff.1`; host wait 2h 0m 0s; driver <1s.'), report);
  assert.match(report, /\| code review \| [a-z-]+ \| 2h 2m 5s \| <1s \| 1m 5s \| 2h 1m 0s \|/, 'both the rolled-back wait and the retry wait are user time');
  assert.doesNotMatch(report, /H6/, 'no host gap holds the user wait');
});

test('SC10 fault report names fault class and timing without detail', async () => {
  const { ports, advance } = steppedPorts();
  const session = tempDir(), runDir = path.join(session, '.state/runs/001-ask');
  const handlers: Handlers = {
    snapshot: async (effect) => { advance(1_000); return [snapshotResult(effect.id)]; },
    verify: async () => { advance(3_000); throw portTimeout(); },
  };
  const base = { ports, runDir, machine: awaitingMachine, handlers, diagnosticToggle: () => true };
  await start({ ...base, runStarted: RUN_STARTED });
  advance(120_000);
  const fault = await send({ ...base, rawEvent: { type: 'AUTHORED', path: 'plan.md' } });
  assert.equal(fault.exitCode, 2);
  const lines = [...readJournal(ports, runDir).records];
  assert.deepEqual(lines.map((line) => line.type), ['RUN_STARTED', 'EFFECT_STARTED', 'SNAPSHOT', 'DIAGNOSTIC_NOTE'], 'the failed send rolls back and leaves one note');
  assert.deepEqual(lines[3]?.data, { kind: 'fault', effectId: 'fixture.verify.1', cls: 'port-timeout', sendStartedAt: FIXED_NOW + 121_000, failedAt: FIXED_NOW + 124_000 });
  const report = read(path.join(session, 'diagnostics.md'));
  assert.ok(report.includes('- Run 1 fault: `port-timeout` in `fixture.verify.1`; host wait 2m 0s; driver 3s.'));
  assert.doesNotMatch(report, /alice|secret|timed out/);
});

test('SC10 long host wait then short failing effect splits host and driver time', async () => {
  const { ports, advance } = steppedPorts();
  const runDir = path.join(tempDir(), '.state/runs/001-ask');
  let failing = true;
  const handlers: Handlers = {
    snapshot: async (effect) => { advance(1_000); return [snapshotResult(effect.id)]; },
    verify: async (effect) => { advance(failing ? 500 : 2_000); if (failing) throw portTimeout(); return verifyDone(effect); },
  };
  const base = { ports, runDir, machine: awaitingMachine, handlers };
  await start({ ...base, runStarted: RUN_STARTED });
  advance(7_200_000);
  assert.equal((await send({ ...base, rawEvent: { type: 'AUTHORED', path: 'plan.md' } })).exitCode, 2);
  advance(60_000);
  failing = false;
  assert.equal((await send({ ...base, rawEvent: { type: 'AUTHORED', path: 'plan.md' } })).frame?.await, 'done');
  const facts = collectRunFacts(ports, runDir, {}, testFold(awaitingMachine, askPhases));
  assert.deepEqual(facts.fault, { effectId: 'fixture.verify.1', cls: 'port-timeout', hostWaitMs: 7_200_000, driverMs: 500 });
  assert.deepEqual(facts.hostGaps, [{ await: 'author', ms: 7_200_000 }, { await: 'author', ms: 60_000 }], 'the retry wait starts at the failure, so the long wait counts once');
  assert.deepEqual(facts.phases, [{ key: 'plan', name: 'plan', outcome: 'complete', wallMs: 7_263_500, driverMs: 3_500, hostMs: 7_260_000, userMs: 0 }]);
  assert.equal(facts.outcome, 'complete');
});

test('SC10 long approval wait then failing send counts the wait as user time', async () => {
  const { ports, advance } = steppedPorts();
  const runDir = path.join(tempDir(), '.state/runs/001-gate');
  let failing = true;
  const handlers: Handlers = { verify: async (effect) => { if (failing) { advance(500); throw portTimeout(); } return verifyDone(effect); } };
  const base = { ports, runDir, machine: gateMachine, handlers };
  const approval = { type: 'DECISION', kind: 'approval', answer: { approved: true } };
  await start({ ...base, runStarted: RUN_STARTED });
  advance(7_200_000);
  assert.equal((await send({ ...base, rawEvent: approval })).exitCode, 2);
  advance(60_000);
  failing = false;
  assert.equal((await send({ ...base, rawEvent: approval })).frame?.await, 'done');
  const facts = collectRunFacts(ports, runDir, {}, testFold(gateMachine, (state) => [state.tag === 'done' ? closed(IMPL) : IMPL], (state) => state.tag === 'approve'));
  assert.deepEqual(facts.fault, { effectId: 'gate.verify.1', cls: 'port-timeout', hostWaitMs: 7_200_000, driverMs: 500 });
  assert.deepEqual(facts.phases, [{ key: 'impl', name: 'implementation', outcome: 'complete', wallMs: 7_260_500, driverMs: 500, hostMs: 0, userMs: 7_260_000 }]);
  assert.deepEqual(facts.hostGaps, [], 'a user wait is never a host gap');
  assert.deepEqual(heuristics(facts).filter((finding) => finding.source === 'H6'), []);
});

test('SC10 toggle change applies at next send', async () => {
  const toggle = { on: false };
  const session = tempDir(), ports = fakePorts(), runDir = path.join(session, '.state/runs/001-host');
  const base = { ports, runDir, machine: hostMachine, handlers: {}, diagnosticToggle: () => toggle.on };
  const hint = async (result: Promise<{ frame: { data: Record<string, unknown> } | null }>) => (await result).frame?.data['diagnostics'];
  await start({ ...base, runStarted: { ...RUN_STARTED, config: { diagnostics: true } } });
  toggle.on = true;
  assert.deepEqual(await hint(send({ ...base, rawEvent: { type: 'AUTHORED', path: 'plan.md' } })), { attest: ['tokens', 'durationMs'] }, 'on: the next send hints');
  toggle.on = false;
  assert.equal(await hint(send({ ...base, dryRun: true })), undefined, 'off: a status read drops the hint, whatever the start config');
  toggle.on = true;
  assert.deepEqual(await hint(send({ ...base, dryRun: true })), { attest: ['tokens', 'durationMs'] });
  toggle.on = false;
  assert.equal(await hint(send({ ...base, rawEvent: { type: 'NATIVE_RESULTS', slots: [] } })), undefined);
  await send({ ...base, rawEvent: { type: 'WRITE_ENVELOPE', envelopePath: 'e.json' } });
  assert.equal(fs.existsSync(path.join(session, 'diagnostics.md')), false, 'off at the done send: no report');

  const later = tempDir(), laterDir = path.join(later, '.state/runs/001-host'), laterBase = { ...base, ports: fakePorts(), runDir: laterDir };
  await start({ ...laterBase, runStarted: RUN_STARTED });
  await send({ ...laterBase, rawEvent: { type: 'AUTHORED', path: 'plan.md' } });
  await send({ ...laterBase, rawEvent: { type: 'NATIVE_RESULTS', slots: [] } });
  toggle.on = true;
  await send({ ...laterBase, rawEvent: { type: 'WRITE_ENVELOPE', envelopePath: 'e.json' } });
  assert.match(read(path.join(later, 'diagnostics.md')), /^# Dispatch diagnostics/, 'on at the done send: the report covers the whole journal');
});

test('SC10 disabling during pending retro keeps instruction and completes on RETRO', async () => {
  const toggle = { on: true };
  const run = reviewRun(toggle);
  assert.equal((await run.begin()).frame?.await, 'retro');
  toggle.on = false;
  assert.deepEqual((await run.status()).frame?.data['diagnostics'], { instruction: INSTRUCTION }, 'the journaled retro decision governs, not the live toggle');
  const done = await run.reply({ type: 'RETRO', observations: [OBSERVATION] });
  assert.equal(done.frame?.await, 'done');
  assert.equal(done.frame?.data['diagnostics'], undefined);
  assert.ok([...readJournal(run.ports, run.runDir).records].some((line) => line.type === 'RETRO'));
  assert.equal(fs.existsSync(path.join(run.session, 'diagnostics.md')), false, 'the live toggle at the RETRO send decides the report');
});
