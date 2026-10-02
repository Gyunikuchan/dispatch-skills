import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { publishBoundary, publishReport } from '../../../skills/dispatch/scripts/core/diagnostics.ts';
import { extractTransport, observations } from '../../../skills/dispatch/scripts/domain/diagnostics.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { awaitingMachine, fakeHandlers, RUN_STARTED } from './fixtures/machines.ts';
test('SC2: malformed optional sidecar preserves accepted semantic reply', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), '.state/runs/001-plan');
  await start({ runDir, ports, machine: awaitingMachine, handlers: fakeHandlers, runStarted: RUN_STARTED });
  const result = await send({ runDir, ports, machine: awaitingMachine, handlers: fakeHandlers, rawEvent: { v: 1, event: { type: 'AUTHORED', path: 'plan.md' }, diagnostics: 'invalid' } });
  assert.equal(result.frame?.await, 'done');
  assert.doesNotMatch(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8'), /diagnostics|observations/);
});
test('SC2: bare events remain compatible and unknown transports fail', () => {
  const event = { type: 'AUTHORED', path: 'plan.md' };
  assert.deepEqual(extractTransport(event), { event });
  assert.ok(extractTransport({ v: 2, event }).error);
});
test('SC2: host repository critique is rejected and empty observations are explicit', () => {
  assert.equal(observations({ observations: [{ v: 1, id: 'one', component: 'src/app.ts' }] }).rejected, 1);
  assert.deepEqual(observations({ observations: [] }).values, []);
  assert.equal(observations(undefined).values, undefined);
});


import { phaseFixture } from './fixtures/diagnostics.ts';
test('SC2: automatic skipped and empty reviews retain distinct terminal outcomes', async () => {
  for (const [rounds, empty, expected] of [[0, false, 'skipped'], [1, true, 'no-reviewable-changes']] as const) {
    const f = phaseFixture('review', rounds, empty);
    const result = await start({ ...f.options, runStarted: f.runStarted });
    assert.equal(result.frame?.await, 'done', JSON.stringify(result.frame));
    assert.equal(f.capture().phases.find((p) => p.name === 'code review')?.outcome, expected);
  }
});

test('SC2: failed phase exit preserves its first terminal timestamp in the report', () => {
  const ports = fakePorts(), session = tempDir(), runDir = path.join(session, '.state/runs/001-plan');
  ports.fs.mkdir(runDir, { recursive: true });
  publishBoundary(ports, runDir, true, [], [
    { seq: 1, at: 10, awaiting: null, phases: [{ key: 'plan', name: 'plan' }] },
    { seq: 2, at: 20, awaiting: null, phases: [{ key: 'plan', name: 'plan', outcome: 'failed' }] },
    { seq: 3, at: 40, awaiting: null, phases: [], outcome: 'failed' },
  ], [], [], () => assert.fail('unexpected diagnostic warning'));
  publishReport(ports, runDir, true, () => assert.fail('unexpected diagnostic warning'));
  assert.match(fs.readFileSync(path.join(session, 'diagnostics.md'), 'utf8'), /\| plan \| failed \| 10 \|/);
});
