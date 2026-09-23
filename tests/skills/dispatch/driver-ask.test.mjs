// SC4 (v0.5.0 native-fallback model cascade): `ask` routes through the driver's own verb —
// `--run ask` emits `launch`, a wave failure hops to native-fallback, and completion emits `done`
// carrying the collected claims. The direct runner path is retired from the SKILL.md contract.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { buildStubDispatchFixture } from './stub-dispatch-fixture.mjs';
import { allProviders, drive, makeGitRepo } from './driver-harness.mjs';

const CONFIG = {
  'read-delegates': { agy: { model: 'gemini-3.7-flash', effort: 'medium' } },
};

const cleanup = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

function setup() {
  const fixture = buildStubDispatchFixture(CONFIG);
  const repo = makeGitRepo();
  cleanup.push(fixture.cleanup, repo.cleanup);
  return { fixture, repo };
}

describe('`--run ask` (SC4)', () => {
  it('emits launch, hops to native-fallback on a wave failure, then done with the collected claims', () => {
    const { fixture, repo } = setup();
    const seenActions = [];
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['ask', '--orchestrator', 'agy', '--', 'What does the dispatch config schema require?'],
      policy: {
        waveResults: () => allProviders('', { exit: 1, failureKind: 'quota' }),
        nativeFallback(action) {
          seenActions.push(action.action);
          return { slot: action.slot, captured: true, actual: {
            agentType: action.descriptor.agentType, model: action.descriptor.model, reasoningEffort: action.descriptor.reasoningEffort,
          } };
        },
      },
      onAction(action) { seenActions.push(action.action); },
    });
    assert.ok(seenActions.includes('launch'), `expected a launch action, saw: ${seenActions.join(', ')}`);
    assert.ok(seenActions.includes('native-fallback'), `expected a native-fallback hop after the wave failure, saw: ${seenActions.join(', ')}`);
    assert.equal(run.done.action, 'done');
    assert.ok(Array.isArray(run.done.claims) && run.done.claims.length > 0, 'done carries the collected claims');
  });
  it('never requests a native fallback for a failed target on another platform', () => {
    const { fixture, repo } = setup();
    const seenActions = [];
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['ask', '--orchestrator', 'claude', '--', 'What does the dispatch config schema require?'],
      policy: { waveResults: () => allProviders('', { exit: 1, failureKind: 'quota' }) },
      onAction(action) { seenActions.push(action.action); },
    });
    assert.ok(!seenActions.includes('native-fallback'), `cross-platform failure must not hop natively, saw: ${seenActions.join(', ')}`);
    assert.equal(run.done.outcome, 'failed');
    assert.equal(run.done.failed.length, 1);
  });
});
