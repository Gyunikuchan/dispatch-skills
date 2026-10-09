import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { dispatchMachine, send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { readJournal } from '../../../skills/dispatch/scripts/core/journal.ts';
import type { Frame, Handlers, Machine, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { createHandoff } from '../../../skills/dispatch/scripts/effects/handoff.ts';
import { fakePorts, tempDir, type FakePorts } from '../../helpers/fake-ports.ts';
import { awaitingMachine, fakeHandlers, RUN_STARTED } from './fixtures/machines.ts';

const INSTRUCTION = 'Reply RETRO with at most 3 observations about dispatch-owned components; [] is valid.';
const BUILD = { version: '0.7.1', build: 'abcdef012345', os: 'linux' };
const OBSERVATION = { id: 'slow-author', component: 'references/templates/plan.md', category: 'speed', evidence: 'The author turn re-read the template twice.', impact: 'One extra host turn per plan.', proposedFix: 'Put the template checklist in the author frame.' };

/** An empty-scope review: prepare-review finds nothing, so the run goes straight to handoff (and retro when enabled). */
function reviewRun(toggle: { on: boolean }, session = tempDir(), id = '001-review', ports: FakePorts = fakePorts()) {
  const runDir = path.join(session, '.state/runs', id);
  const handlers: Handlers = {
    'prepare-review': async (effect) => [{ type: 'REVIEW_PREPARED', effectId: effect.id, scope: { paths: [], empty: true }, promptPaths: {} }],
    handoff: createHandoff({ tempRoot: session, workspaceRoot: path.dirname(session) }),
  };
  const base = { ports, runDir, machine: dispatchMachine, handlers, diagnosticToggle: () => toggle.on, diagnosticRetroInstruction: () => INSTRUCTION, diagnosticBuild: () => BUILD };
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

type HostState = { tag: 'booting' | 'author' | 'native' | 'write' | 'done' };
/** author → native → write → done; every host await kind the hint rules distinguish, without a full workflow. */
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
async function hostFrames(on: boolean): Promise<Frame[]> {
  const ports = fakePorts(), runDir = path.join(tempDir(), '.state/runs/001-host');
  const base = { ports, runDir, machine: hostMachine, handlers: {}, diagnosticToggle: () => on, diagnosticRetroInstruction: () => INSTRUCTION };
  const frames = [(await start({ ...base, runStarted: RUN_STARTED })).frame];
  frames.push((await send({ ...base, rawEvent: { type: 'AUTHORED', path: 'plan.md' } })).frame);
  frames.push((await send({ ...base, dryRun: true })).frame);
  frames.push((await send({ ...base, rawEvent: { type: 'NATIVE_RESULTS', slots: [{ slot: 'claude[0]', tokens: 10 }] } })).frame);
  frames.push((await send({ ...base, rawEvent: { type: 'WRITE_ENVELOPE', envelopePath: 'e.json', tokens: 5, durationMs: 9 } })).frame);
  return frames.map((frame) => frame ?? assert.fail('missing frame'));
}
const stateFiles = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, withFileTypes: false }).map((file) => String(file).replaceAll('\\', '/'));

// SECTION: SC5 — enabled frames and the retro await

test('SC5 enters retro after handoff when enabled', async () => {
  const run = reviewRun({ on: true });
  const frame = (await run.begin()).frame;
  assert.equal(frame?.await, 'retro');
  assert.equal(frame?.at, 'review › retro');
  const handoff = [...readJournal(run.ports, run.runDir).records].find((line) => line.type === 'HANDOFF_DONE');
  assert.equal(handoff?.data['diagnostics'], true);
  assert.match(frame?.reply ?? '', /events\/\d+-retro\.json$/);
});

test('SC5 retro frame carries instruction only', async () => {
  const frame = (await reviewRun({ on: true }).begin()).frame;
  assert.deepEqual(frame?.data, { kind: 'retro', diagnostics: { instruction: INSTRUCTION } });
  assert.deepEqual(frame?.events, [{ type: 'RETRO', observations: [] }]);
});

test('SC5 native and write frames carry attest hint', async () => {
  const frames = await hostFrames(true);
  const native = frames.find((frame) => frame.await === 'native'), write = frames.find((frame) => frame.await === 'write');
  assert.deepEqual(native?.data['diagnostics'], { attest: ['tokens', 'durationMs'] });
  assert.deepEqual(write?.data['diagnostics'], { attest: ['tokens', 'durationMs'] });
  assert.deepEqual(frames[2]?.data['diagnostics'], { attest: ['tokens', 'durationMs'] }, 'a status read of a native frame carries the same hint');
});

test('SC5 empty RETRO completes run', async () => {
  const run = reviewRun({ on: true });
  await run.begin();
  const done = await run.reply({ type: 'RETRO', observations: [] });
  assert.equal(done.frame?.await, 'done');
  assert.equal(done.frame?.data['outcome'], 'no-reviewable-changes');
  assert.equal(done.frame?.data['diagnostics'], undefined);
  assert.match(fs.readFileSync(path.join(run.session, 'diagnostics.md'), 'utf8'), /- Host retro: 0 accepted · 0 rejected/);
});

test('SC5 invalid retro items are counted', async () => {
  const run = reviewRun({ on: true });
  await run.begin();
  const done = await run.reply({ type: 'RETRO', observations: [OBSERVATION, { id: 'repo', component: 'src/app.ts', category: 'speed', evidence: 'e', impact: 'i', proposedFix: 'f' }, 'free text'] });
  assert.equal(done.frame?.await, 'done');
  const report = fs.readFileSync(path.join(run.session, 'diagnostics.md'), 'utf8');
  assert.match(report, /- Host retro: 1 accepted · 2 rejected/);
  assert.match(report, /host retro `slow-author`/);
  assert.doesNotMatch(report, /src\/app\.ts|free text/);
});

test('SC5 other frames carry no diagnostics', async () => {
  const frames = await hostFrames(true);
  for (const frame of frames.filter((item) => item.await !== 'native' && item.await !== 'write')) assert.equal(frame.data['diagnostics'], undefined, frame.await);
  const ports = fakePorts(), runDir = path.join(tempDir(), 'run');
  const base = { ports, runDir, machine: awaitingMachine, handlers: fakeHandlers, diagnosticToggle: () => true };
  const author = await start({ ...base, runStarted: RUN_STARTED });
  const rejected = await send({ ...base, rawEvent: { type: 'AUTHORED', path: '../x.md' } });
  assert.deepEqual([author.frame?.data['diagnostics'], rejected.frame?.data['diagnostics']], [undefined, undefined]);
});

// SECTION: SC6 — disabled means off

test('SC6 disabled frames carry no diagnostics', async () => {
  for (const frame of await hostFrames(false)) assert.equal(frame.data['diagnostics'], undefined, frame.await);
  const done = await reviewRun({ on: false }).begin();
  assert.equal(done.frame?.data['diagnostics'], undefined);
});

test('SC6 disabled run skips retro', async () => {
  const run = reviewRun({ on: false });
  const done = await run.begin();
  assert.equal(done.frame?.await, 'done');
  const lines = [...readJournal(run.ports, run.runDir).records];
  assert.equal(lines.find((line) => line.type === 'HANDOFF_DONE')?.data['diagnostics'], false);
  assert.equal(lines.some((line) => line.type === 'RETRO'), false);
});

test('SC6 disabled run writes no report or state files', async () => {
  const run = reviewRun({ on: false });
  await run.begin();
  await run.status();
  await run.reply({ type: 'RETRO', observations: [] });
  assert.equal(fs.existsSync(path.join(run.session, 'diagnostics.md')), false);
  assert.deepEqual(stateFiles(path.join(run.session, '.state')).filter((file) => /diagnostics/.test(file)), []);
});

// SECTION: SC7 — the session report

test('SC7 writes session report at done', async () => {
  const run = reviewRun({ on: true });
  const write = run.ports.fs.writeAtomic;
  let lockedAtWrite: boolean | undefined;
  run.ports.fs.writeAtomic = (file, text) => {
    if (path.basename(file) === 'diagnostics.md') lockedAtWrite = fs.existsSync(path.join(run.runDir, 'lock'));
    write(file, text);
  };
  await run.begin();
  assert.equal(fs.existsSync(path.join(run.session, 'diagnostics.md')), false, 'the retro await precedes the report');
  await run.reply({ type: 'RETRO', observations: [] });
  assert.equal(lockedAtWrite, true, 'the report is written under the run lock');
  const report = fs.readFileSync(path.join(run.session, 'diagnostics.md'), 'utf8');
  for (const heading of ['# Dispatch diagnostics', '## Summary', '## Overview', '## Findings', '## Appendix']) assert.ok(report.includes(heading), heading);
  assert.match(report, /dispatch 0\.7\.1 · build abcdef012345/);
  assert.match(report, /\| 1 · review · low \| code review \| no-reviewable-changes \|/);
});

test('SC7 writes report at fault', async () => {
  const ports = fakePorts(), session = tempDir(), runDir = path.join(session, '.state/runs/001-ask');
  const handlers: Handlers = { snapshot: async () => { throw new Error('disk detail /secret/path'); } };
  const result = await start({ ports, runDir, machine: awaitingMachine, handlers, runStarted: RUN_STARTED, diagnosticToggle: () => true, diagnosticBuild: () => BUILD });
  assert.equal(result.exitCode, 2);
  assert.equal(result.frame?.data['outcome'], 'fault');
  const report = fs.readFileSync(path.join(session, 'diagnostics.md'), 'utf8');
  assert.match(report, /fault: `error` in `fixture\.snapshot\.1`/);
  assert.doesNotMatch(report, /secret|disk detail/);
  assert.equal(fs.existsSync(path.join(runDir, 'lock')), false);
});

test('SC7 leaves no capture or lock files', async () => {
  const run = reviewRun({ on: true });
  await run.begin();
  await run.status();
  await run.reply({ type: 'RETRO', observations: [OBSERVATION] });
  const files = stateFiles(path.join(run.session, '.state'));
  assert.deepEqual(files.filter((file) => /diagnostics|capture|pending-|render\.lock|(^|\/)lock$/.test(file)), []);
  assert.deepEqual(fs.readdirSync(run.session).sort(), ['.state', 'diagnostics.md']);
});

test('SC7 done mentions report only with findings', async () => {
  const clean = reviewRun({ on: true });
  await clean.begin();
  assert.equal((await clean.reply({ type: 'RETRO', observations: [] })).frame?.data['diagnostics'], undefined);
  const flagged = reviewRun({ on: true });
  await flagged.begin();
  const done = await flagged.reply({ type: 'RETRO', observations: [OBSERVATION] });
  assert.deepEqual(done.frame?.data['diagnostics'], { path: path.join(flagged.session, 'diagnostics.md').replaceAll('\\', '/'), findings: 1 });
});
