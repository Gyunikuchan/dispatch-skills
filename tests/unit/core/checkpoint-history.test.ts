import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { send, findDesignDelivery, loadExecution, timelineFold, findSettledPlan } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { start } from '../../helpers/governed-start.ts';
import { collectRunFacts } from '../../../skills/dispatch/scripts/core/diagnostics.ts';
import { renderReport } from '../../../skills/dispatch/scripts/domain/render.ts';
import { resolutionRounds } from '../../../skills/dispatch/scripts/machines/review.ts';
import fs from 'node:fs';
import { FIXED_NOW } from '../../helpers/fake-ports.ts';
import { PLAN, HASH } from '../machines/fixtures/implement-recovery.ts';
import type { Handlers } from '../../../skills/dispatch/scripts/core/types.ts';
import { rootMachine } from '../../../skills/dispatch/scripts/machines/root.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { run, hash, design } from '../machines/fixtures/design.ts';

test('checkpoint-history: nested design discovery and dry-run bypass accepted reducers', async () => {
  const ports = fakePorts(), session = tempDir(), runDir = path.join(session, '.state', 'runs', '001-implement');
  const handlers = { 'parse-artifact': async (effect: { id: string }) => [{ type: 'ARTIFACT_PARSED' as const, effectId: effect.id, kind: 'design' as const, hash, parsed: design, defects: [] }] };
  assert.equal((await start({ ports, machine: rootMachine, handlers, runDir, runStarted: run('implement') })).exitCode, 0);
  const changed = { ...rootMachine, step: () => { throw new Error('historical reducer called'); } };
  const found = findDesignDelivery(ports, path.dirname(runDir), changed, { path: 'x.design.md', revision: hash });
  assert.equal(found?.finished, false);
  assert.equal(found?.state.tag, 'design');
  assert.equal((await send({ ports, machine: changed, handlers, runDir, dryRun: true })).frame?.await, 'decide');
});

test('checkpoint-history: reloaded history preserves prior phase durations without prefix replay', async () => {
  const ports = fakePorts(), session = tempDir(), runDir = path.join(session, '.state', 'runs', '001-design');
  let now = FIXED_NOW;
  ports.clock.now = () => now;
  const handlers: Handlers = { 'parse-artifact': async (effect) => { now += 50; return [{ type: 'ARTIFACT_PARSED', effectId: effect.id, kind: 'design', hash, parsed: design, defects: [] }]; } };
  await start({ ports, machine: rootMachine, handlers, runDir, runStarted: { ...run(), argument: 'Create a design', overrides: { path: path.join(session, 'x.design.md') } } });
  now += 1000;
  assert.equal((await send({ ports, machine: rootMachine, handlers, runDir, rawEvent: { type: 'AUTHORED', path: path.join(session, 'x.design.md') } })).frame?.await, 'decide');
  const expected = collectRunFacts(ports, runDir, {}, timelineFold(rootMachine, session));
  const changed = { ...rootMachine, step: () => { throw new Error('historical phase reducer was replayed'); } };
  const restored = collectRunFacts(ports, runDir, {}, timelineFold(changed, session, ports, runDir));
  assert.deepEqual(restored.phases, expected.phases);
  assert.deepEqual(restored.hostGaps, expected.hostGaps);
  assert.equal(restored.orchestratorBytes, expected.orchestratorBytes);
  assert.equal(restored.phases.find((phase) => phase.key === 'design')?.hostMs, 1000);
  assert.equal(restored.phases.find((phase) => phase.key === 'design')?.driverMs, 100);
});

test('checkpoint-history: relocated session restores nested private paths and portable references', async () => {
  const ports = fakePorts(), base = tempDir(), session = path.join(base, 'old'), runDir = path.join(session, '.state', 'runs', '001-implement');
  const handlers: Handlers = { 'parse-artifact': async (effect) => [{ type: 'ARTIFACT_PARSED', effectId: effect.id, kind: 'design', hash, parsed: design, defects: [] }] };
  await start({ ports, machine: rootMachine, handlers, runDir, runStarted: { ...run('implement'), argument: path.join(session, 'x.design.md') } });
  const destination = path.join(base, 'new');
  fs.renameSync(session, destination);
  const movedRun = path.join(destination, '.state', 'runs', '001-implement');
  const changed = { ...rootMachine, step: () => { throw new Error('relocation replayed old reducer'); } };
  const restored = loadExecution(changed, ports, movedRun).folder.state;
  assert.equal(restored.tag, 'design');
  if (restored.tag !== 'design') assert.fail('nested design missing');
  assert.equal(restored.child.c.path, path.join(destination, 'x.design.md').replaceAll('\\', '/'));
  assert.equal(findDesignDelivery(ports, path.dirname(movedRun), changed, { path: path.join(destination, 'x.design.md'), revision: hash })?.runDir, movedRun);
  assert.equal((await send({ ports, machine: changed, handlers, runDir: movedRun, dryRun: true })).exitCode, 0);
});

test('checkpoint-history: settled-plan discovery and report rendering use retained private review history', async () => {
  const ports = fakePorts(), session = tempDir(), runDir = path.join(session, '.state', 'runs', '001-plan'), planPath = path.join(session, 'x.plan.md');
  const handlers: Handlers = {
    'parse-artifact': async (effect) => [{ type: 'ARTIFACT_PARSED', effectId: effect.id, kind: 'plan', hash: HASH, parsed: PLAN, defects: [] }],
    handoff: async (effect) => [{ type: 'HANDOFF_DONE', effectId: effect.id, destination: '/handoff', warning: null }],
  };
  await start({ ports, machine: rootMachine, handlers, runDir, runStarted: { ...run(), verb: 'plan', argument: 'Create the plan', overrides: { path: planPath } } });
  assert.equal((await send({ ports, machine: rootMachine, handlers, runDir, rawEvent: { type: 'AUTHORED', path: planPath } })).frame?.await, 'done');
  const changed = { ...rootMachine, step: () => { throw new Error('settled plan replayed'); } };
  assert.deepEqual(findSettledPlan(ports, path.dirname(runDir), changed, session, { path: planPath, currentHash: HASH }), { path: planPath, hash: HASH, outcome: 'skipped' });
  const state = loadExecution(changed, ports, runDir).folder.state;
  if (state.tag !== 'done' || state.last?.verb !== 'plan' || !('review' in state.last.state) || !state.last.state.review || !('c' in state.last.state.review)) assert.fail('retained plan review missing');
  const review = state.last.state.review;
  assert.match(renderReport({ title: 'Retained review', kind: 'plan', target: 'x.plan.md', summary: 'Skipped under configured policy', rounds: resolutionRounds(review.c) }), /Skipped under configured policy/);
});
