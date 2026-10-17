import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FailureClass } from '../../../skills/dispatch/scripts/core/types.ts';
import { failureDisposition, hasReserve, next, reservePool, takeReserve, type Voice } from '../../../skills/dispatch/scripts/policy/cascade.ts';

const agy: Voice = {
  slot: 'agy[0]', platform: 'agy', models: ['gemini-pro', 'gemini-flash'], modes: ['direct', 'sandboxed'], modeCascadeOn: ['quota', 'context-overflow'],
};
const lastModel = { model: 1, mode: 0 };

// SECTION: Failure dispositions

test('delegates-failure-classes: every class has a disposition; integrity and config end the run', () => {
  const classes: FailureClass[] = [
    'quota', 'context-overflow', 'auth', 'model-not-found', 'cli-outdated', 'model-not-loaded', 'sandbox-unsupported', 'not-found',
    'timeout', 'buffer', 'empty-output', 'refusal', 'truncated', 'integrity', 'config',
  ];
  const dispositions = Object.fromEntries(classes.map((cls) => [cls, failureDisposition(cls)]));
  assert.equal(dispositions['sandbox-unsupported'], 'skip-voice');
  assert.equal(dispositions['integrity'], 'terminal-run');
  assert.equal(dispositions['config'], 'terminal-run');
  assert.equal(classes.filter((cls) => dispositions[cls] === 'cascade').length, 12);
  assert.deepEqual(next('config', { model: 0, mode: 0 }, agy), { kind: 'terminal', scope: 'run', reason: 'config is terminal for the run' });
});

// SECTION: Model and mode cascade

test('delegates-model-array-cascade: every cascade class, auth included, tries the next model first', () => {
  for (const cls of ['auth', 'timeout', 'quota'] as const) {
    assert.deepEqual(next(cls, { model: 0, mode: 0 }, agy), { kind: 'next-model', position: { model: 1, mode: 0 } }, cls);
  }
  assert.deepEqual(next('sandbox-unsupported', { model: 0, mode: 0 }, agy), { kind: 'terminal', scope: 'slot', reason: 'agy[0] failed: sandbox-unsupported' });
});

test('delegates-mode-cascade: only provider-declared classes advance the mode, resetting the model', () => {
  assert.deepEqual(next('quota', lastModel, agy), { kind: 'next-mode', position: { model: 0, mode: 1 } });
  assert.deepEqual(next('timeout', lastModel, agy), { kind: 'terminal', scope: 'slot', reason: 'agy[0] failed: timeout' });
  assert.equal(next('quota', { model: 1, mode: 1 }, agy).kind, 'terminal');
});

// SECTION: Reserves and substitution pool

test('delegates-reserves: exhausted voices prefer reserves and use native fallback only on the orchestrator platform', () => {
  assert.deepEqual(next('timeout', lastModel, agy, { orchestratorPlatform: 'claude', reserveAvailable: true }), { kind: 'reserve' });
  assert.deepEqual(next('timeout', lastModel, agy, { orchestratorPlatform: 'agy', reserveAvailable: false }), { kind: 'native-fallback' });
  assert.equal(next('timeout', lastModel, agy, { orchestratorPlatform: 'claude', reserveAvailable: false }).kind, 'terminal');
});

test('delegates-reserves-once: each reserve is consumed once per wave with recorded substitutions', () => {
  let pool = reservePool(['copilot[0]', 'opencode[0]']);
  const first = takeReserve(pool, 'agy[0]', 'timeout');
  pool = first.pool;
  const second = takeReserve(pool, 'codex[0]', 'quota');
  pool = second.pool;
  const third = takeReserve(pool, 'claude[0]', 'auth');
  assert.deepEqual([first.reserve, second.reserve, third.reserve], ['copilot[0]', 'opencode[0]', null]);
  assert.equal(hasReserve(third.pool), false);
  assert.deepEqual(third.pool.records, ['agy[0] → copilot[0]: timeout', 'codex[0] → opencode[0]: quota']);
});
