import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { validateConfig } from '../../../skills/dispatch/scripts/lib/config.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { awaitingMachine, fakeHandlers, RUN_STARTED } from './fixtures/machines.ts';
test('SC1: omitted and false diagnostics preserve frames and artifacts', async () => {
  const frames = [];
  for (const config of [{}, { diagnostics: false }]) {
    const ports = fakePorts(), runDir = path.join(tempDir(), '.state/runs/001-plan');
    const result = await start({ runDir, runRel: 'run', ports, machine: awaitingMachine, handlers: fakeHandlers, runStarted: { ...RUN_STARTED, config } });
    frames.push(result.frame);
    assert.equal(fs.existsSync(path.join(runDir, 'diagnostics')), false);
    assert.equal(fs.existsSync(path.join(runDir, '../../../diagnostics.md')), false);
    assert.doesNotMatch(JSON.stringify(result.frame), /diagnostic/i);
  }
  assert.deepEqual(frames[0], frames[1]);
});
test('SC1: diagnostics accepts booleans and rejects other types', () => {
  const base = { 'read-delegates': { codex: { targets: [{ low: { model: 'fixture' } }] } } };
  for (const diagnostics of [true, false]) assert.deepEqual(validateConfig({ ...base, diagnostics }), []);
  for (const diagnostics of [null, 1, 'true', {}]) assert.ok(validateConfig({ ...base, diagnostics }).some((v) => /diagnostics must be a boolean/.test(v)));
});
