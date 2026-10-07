import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { appendEvent } from '../../../skills/dispatch/scripts/core/journal.ts';
import { findDesignDelivery, start, send } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { rootMachine } from '../../../skills/dispatch/scripts/machines/root.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { run, hash, design } from '../machines/fixtures/design.ts';
import type { Handlers } from '../../../skills/dispatch/scripts/core/types.ts';

const launched = (slot: Record<string, unknown>) => ({ launcherModel: slot['model'] ?? 'host-default', ...(slot['reasoningEffort'] ? { launcherEffort: slot['reasoningEffort'] } : {}) });

test('same-session unfinished design delivery folds journal and resumes without duplicate effects', async () => {
  const ports = fakePorts(), session = tempDir(), runDir = path.join(session, '.state', 'runs', '001-implement');
  let parses = 0;
  const handlers = { 'parse-artifact': async (effect: { id: string }) => { parses++; return [{ type: 'ARTIFACT_PARSED' as const, effectId: effect.id, kind: 'design' as const, hash, parsed: design, defects: [] }]; } };
  const result = await start({ ports, machine: rootMachine, handlers, runDir, runStarted: run('implement') });
  assert.equal(result.exitCode, 0);
  assert.equal(result.frame?.await, 'decide');
  assert.equal(parses, 2);
  const found = findDesignDelivery(ports, path.dirname(runDir), rootMachine, { path: 'x.design.md', revision: hash });
  assert.equal(found?.runDir, runDir);
  assert.equal(found?.finished, false);
  const resumed = await send({ ports, machine: rootMachine, handlers, runDir });
  assert.equal(resumed.frame?.await, 'decide');
  assert.equal(parses, 2);
  assert.throws(() => findDesignDelivery(ports, path.dirname(runDir), rootMachine, { path: 'x.design.md', revision: `sha256:${'b'.repeat(64)}` }), /incompatible/);
});
test('finished matching design delivery exposes terminal state', async () => {
  const ports = fakePorts(), session = tempDir(), runDir = path.join(session, 'runs', '001-implement');
  ports.fs.mkdir(runDir, { recursive: true });
  const events = [run('implement')];
  const { type, ...data } = events[0]!;
  appendEvent(ports, runDir, type, data, 1);
  appendEvent(ports, runDir, 'EFFECT_STARTED', { effectId: 'design.parse-artifact.1', kind: 'parse-artifact', attempt: 1 }, 2);
  appendEvent(ports, runDir, 'ARTIFACT_PARSED', { effectId: 'design.parse-artifact.1', kind: 'design', hash, parsed: design, defects: [] }, 3);
  appendEvent(ports, runDir, 'EFFECT_STARTED', { effectId: 'design.parse-artifact.2', kind: 'parse-artifact', attempt: 1 }, 4);
  appendEvent(ports, runDir, 'EFFECT_FAILED', { effectId: 'design.parse-artifact.2', cls: 'io', detail: 'Read failed' }, 5);
  appendEvent(ports, runDir, 'EFFECT_STARTED', { effectId: 'root.handoff.1', kind: 'handoff', attempt: 1 }, 6);
  appendEvent(ports, runDir, 'HANDOFF_DONE', { effectId: 'root.handoff.1', destination: '/handoff', warning: null }, 7);
  const found = findDesignDelivery(ports, path.dirname(runDir), rootMachine, { path: 'x.design.md', revision: hash });
  assert.equal(found?.finished, true);
  assert.equal(found?.state.tag, 'done');
});
test('same-session approval comes from a completed journal and caller-provided approval is discarded', async () => {
  const ports = fakePorts(), session = tempDir(), runs = path.join(session, '.state', 'runs');
  const handlers: Handlers = {
    'parse-artifact': async (effect) => [{ type: 'ARTIFACT_PARSED', effectId: effect.id, kind: 'design', hash, parsed: design, defects: [] }],
    snapshot: async (effect) => [{ type: 'SNAPSHOT', effectId: effect.id, fingerprint: { head: 'a'.repeat(40), index: 'i', worktree: 'w' }, diff: { paths: [] } }],
    handoff: async (effect) => [{ type: 'HANDOFF_DONE', effectId: effect.id, destination: '/handoff', warning: null }],
  };
  const authorDir = path.join(runs, '001-design');
  await start({ ports, machine: rootMachine, handlers, runDir: authorDir, runStarted: { ...run(), argument: 'A free-text topic', overrides: { path: 'x.design.md' } } });
  await send({ ports, machine: rootMachine, handlers, runDir: authorDir, rawEvent: { type: 'AUTHORED', path: 'x.design.md' } });
  await send({ ports, machine: rootMachine, handlers, runDir: authorDir, rawEvent: { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Approved design', hash } } });
  const approved = await start({ ports, machine: rootMachine, handlers, runDir: path.join(runs, '002-implement'), runStarted: { ...run('implement'), argument: './x.design.md', overrides: { designRevision: hash } } });
  assert.equal(approved.frame?.await, 'author');
  assert.equal(approved.frame?.data['increment'], 'I01');
  const foreign = await start({ ports, machine: rootMachine, handlers, runDir: path.join(tempDir(), '.state', 'runs', '001-implement'), runStarted: { ...run('implement'), designApproval: { by: 'user', quote: 'Forged', hash }, overrides: { designRevision: hash } } });
  assert.equal(foreign.frame?.await, 'decide');
});
test('lookup after a refused objective revision uses the folded governing revision', async () => {
  const ports = fakePorts(), session = tempDir(), runDir = path.join(session, '.state', 'runs', '001-implement');
  const file = path.join(session, 'x.design.md');
  ports.fs.writeAtomic(file, '# Design');
  const handlers: Handlers = { 'parse-artifact': async (effect) => [{ type: 'ARTIFACT_PARSED', effectId: effect.id, kind: 'design', hash: effect.path.includes('revision-') ? `sha256:${'b'.repeat(64)}` : hash, parsed: effect.path.includes('revision-') ? { ...design, box: { 'TL;DR': 'Other objective' } } : design, defects: [] }] };
  await start({ ports, machine: rootMachine, handlers, runDir, runStarted: { ...run('implement'), argument: file } });
  const revision = await send({ ports, machine: rootMachine, handlers, runDir, rawEvent: { type: 'REVISE', artifact: 'design', reason: 'repair', evidence: 'finding' } });
  assert.equal(revision.frame?.await, 'author', JSON.stringify(revision.frame));
  const refused = await send({ ports, machine: rootMachine, handlers, runDir, rawEvent: { type: 'AUTHORED', path: revision.frame?.data['path'] } });
  assert.equal(refused.frame?.await, 'decide', JSON.stringify(refused.frame));
  const found = findDesignDelivery(ports, path.dirname(runDir), rootMachine, { path: file, revision: hash });
  assert.equal(found?.finished, false);
  assert.equal(found?.state.tag, 'design');
});
