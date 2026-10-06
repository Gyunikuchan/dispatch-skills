import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import type { Effect, Handler, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { createGit } from '../../../skills/dispatch/scripts/effects/git.ts';
import { createHandlers } from '../../../skills/dispatch/scripts/effects/index.ts';
import { rootMachine } from '../../../skills/dispatch/scripts/machines/root.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../skills/dispatch');

test('ask end to end: start reaches done with claims; the journal replays to the same frame', async () => {
  const wave: Handler<Extract<Effect, { kind: 'wave' }>> = async (effect) => [{
    type: 'WAVE_DONE', effectId: effect.id, round: effect.round, findings: [],
    slots: effect.roster.map((slot) => ({ slot: slot['slot'], state: 'success', claim: `claim from ${String(slot['slot'])} via ${path.basename(String(slot['promptPath']))}` })),
  }];
  const tmp = tempDir();
  const handlers = createHandlers({ skillRoot: SKILL_ROOT, cwd: tmp, os: 'linux', git: createGit({ run: async () => '' }), tempRoot: path.join(tmp, 'tmp'), workspaceRoot: tmp, orchestratorPlatform: 'claude', wave });
  const runDir = path.join(tmp, 'run');
  const ports = fakePorts();
  const runStarted: RunStartedEvent = {
    type: 'RUN_STARTED', verb: 'ask', argument: 'Where is the lock released?', level: 'low', levelSource: 'explicit', pins: null, fix: false,
    orchestrator: 'claude', orchestratorModel: null, overrides: {}, repo: {}, config: { 'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } } },
  };
  const result = await start({ runDir, machine: rootMachine, handlers, ports, runStarted, runRel: 'run' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.frame?.at, 'ask › done');
  assert.equal(result.frame?.await, 'done');
  assert.deepEqual(result.frame?.data['claims'], [{ text: 'claim from codex[0] via codex-0.prompt.md', source: 'codex[0]' }]);
  assert.equal(result.frame?.data['handoff'], runDir);
  const replay = await send({ runDir, machine: rootMachine, handlers, ports, dryRun: true, runRel: 'run' });
  assert.deepEqual(replay.frame, result.frame);
});
