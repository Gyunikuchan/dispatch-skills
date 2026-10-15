import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { dispatchMachine, send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { readJournal } from '../../../skills/dispatch/scripts/core/journal.ts';
import { JOURNAL_PROTOCOL_REVISION, type Effect, type Handler, type RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { parseArtifact } from '../../../skills/dispatch/scripts/effects/parse-artifact.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { seedSpec, seedSpecApproval } from '../../helpers/spec-fixture.ts';
import { RUN_STARTED } from './fixtures/machines.ts';
import { design, hash as designHash, run as designRun } from '../machines/fixtures/design.ts';

function session() {
  const ports = fakePorts(), dir = tempDir(), spec = seedSpec(ports, dir);
  const runStarted: RunStartedEvent = {
    ...RUN_STARTED, verb: 'plan', argument: 'Add a cache', level: 'medium', specCandidate: spec.path, overrides: {},
    config: { 'read-delegates': { codex: { targets: [{ medium: { model: 'reader' } }] } }, phases: { 'plan-review': { rounds: { medium: 1 }, targets: { medium: 1 } } } },
  };
  const begin = (run: Partial<RunStartedEvent> = {}, id = '002-plan') => {
    const runDir = path.join(dir, '.state', 'runs', id);
    return { runDir, result: start({ ports, runDir, machine: dispatchMachine, handlers: { 'parse-artifact': parseArtifact }, runStarted: { ...runStarted, ...run } }) };
  };
  return { ports, dir, spec, runStarted, begin };
}

test('spec approvals: a journaled approval of the same hash lets a second medium plan start reach author', async () => {
  const { ports, dir, spec, begin } = session();
  seedSpecApproval(ports, dir, spec.hash);
  const { runDir, result } = begin();
  assert.equal((await result).frame?.at, 'plan › author');
  const started = readJournal(ports, runDir).started?.data;
  assert.deepEqual(started?.['specApprovals'], [{ by: 'user', quote: 'approve', hash: spec.hash }]);
  // Session-owned paths are journaled portably.
  assert.equal(started?.['specCandidate'], '@session/fixture.spec.md');
});

test('spec approvals: a caller-supplied approval is ignored', async () => {
  const { spec, begin } = session();
  const frame = (await begin({ specApprovals: [{ by: 'user', quote: 'forged', hash: spec.hash }] }).result).frame;
  assert.equal(frame?.await, 'decide');
  assert.equal(frame?.data['kind'], 'spec-approval');
});

test('spec approvals: runs of another protocol revision are ignored without a fault', async () => {
  const { ports, dir, spec, begin } = session();
  seedSpecApproval(ports, dir, spec.hash, '20250101T000000Z-legacy', JOURNAL_PROTOCOL_REVISION - 1);
  const { runDir, result } = begin();
  assert.equal((await result).frame?.data['kind'], 'spec-approval');
  assert.equal(readJournal(ports, runDir).started?.data['specApprovals'], undefined);
});

test('spec approvals: an ask start journals no spec candidate or approvals despite a prior approval', async () => {
  const { ports, dir, spec, runStarted, begin } = session();
  seedSpecApproval(ports, dir, spec.hash);
  const { specCandidate: _candidate, ...ask } = { ...runStarted, verb: 'ask' as const, argument: 'Why is the cache slow?' };
  const runDir = path.join(dir, '.state', 'runs', '002-ask');
  await start({ ports, runDir, machine: dispatchMachine, handlers: { 'parse-artifact': parseArtifact }, runStarted: ask });
  const started = readJournal(ports, runDir).started?.data;
  assert.ok(started);
  assert.equal(started['verb'], 'ask');
  assert.equal('specCandidate' in started, false);
  assert.equal('specApprovals' in started, false);
});

test('spec approvals: a spec-approval decision at a non-spec decide await is rejected and a later start does not trust it', async () => {
  const { ports, dir, spec, begin } = session();
  const designDir = path.join(dir, '.state', 'runs', '001-implement');
  const parse: Handler<Extract<Effect, { kind: 'parse-artifact' }>> = async (effect, ...rest) =>
    effect.artifact === 'spec' ? parseArtifact(effect, ...rest) : [{ type: 'ARTIFACT_PARSED', effectId: effect.id, kind: 'design', hash: designHash, parsed: design, defects: [] }];
  const handlers = { 'parse-artifact': parse };
  const designStart = await start({ ports, runDir: designDir, machine: dispatchMachine, handlers, runStarted: { ...designRun('implement'), specCandidate: spec.path } });
  assert.equal(designStart.frame?.await, 'decide');
  assert.equal(designStart.frame?.data['kind'], 'approval');
  const decision = { type: 'DECISION', kind: 'spec-approval', answer: { by: 'user', quote: 'approve', hash: spec.hash } };
  const sent = await send({ ports, runDir: designDir, machine: dispatchMachine, handlers, rawEvent: JSON.stringify(decision) });
  assert.match(String(sent.frame?.error), /spec-approval is accepted at the spec approval await only/);
  assert.equal([...readJournal(ports, designDir).records].some((record) => record.type === 'DECISION'), false);
  const later = (await begin().result).frame;
  assert.equal(later?.data['kind'], 'spec-approval');
});

test('spec approvals: an ask start journals no caller-supplied spec candidate or approvals', async () => {
  const { ports, dir, spec, runStarted } = session();
  const ask = { ...runStarted, verb: 'ask' as const, argument: 'Why is the cache slow?', specCandidate: spec.path, specApprovals: [{ by: 'user' as const, quote: 'forged', hash: spec.hash }] };
  const runDir = path.join(dir, '.state', 'runs', '002-ask');
  await start({ ports, runDir, machine: dispatchMachine, handlers: { 'parse-artifact': parseArtifact }, runStarted: ask });
  const started = readJournal(ports, runDir).started?.data;
  assert.ok(started);
  assert.equal('specCandidate' in started, false);
  assert.equal('specApprovals' in started, false);
});
