// An unparseable rebuttal report from a non-orchestrator delegate is retried once with the parse error.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, afterEach, describe, it } from 'node:test';

import { allProviders, drive, logEntries, planFinding, readLog, rebuttal, report, writePlan } from '../../../helpers/driver-harness.mjs';
import { cleanupScriptedRepos, config, disposeScriptedFixtures, launches, setup } from '../../../helpers/scripted-review-fixture.mjs';

afterEach(cleanupScriptedRepos);
after(disposeScriptedFixtures);

const GARBAGE = 'I think these findings are fine overall.';

/** Runs a consensus plan review (orchestrator claude, delegate agy) whose rebuttal replies come from `rebuttals`. */
function rebuttalRun(rebuttals) {
  const { fixture, repo } = setup(config({ consensus: true, rounds: 1 }));
  const plan = writePlan(repo.dir);
  const prompts = [];
  let rebuttalCount = 0;
  const run = drive(fixture, {
    cwd: repo.dir, runArgs: ['review', '--orchestrator', 'claude', '--', plan],
    policy: {
      rule: () => ({ status: 'rejected' }),
      waveResults: (action) => action.wave.type === 'rebuttal'
        ? allProviders(rebuttals(rebuttalCount++, action.keys))
        : allProviders(report(action.wave.type === 'review' ? [planFinding()] : [])),
      askUser: (action) => action.options?.includes('stop')
        ? { stop: true }
        : { answer: Object.fromEntries(action.items.map((item) => [item.key, 'rejected'])) },
    },
    onAction: (action) => {
      if (action.action !== 'launch' || action.wave.type !== 'rebuttal') return;
      const state = JSON.parse(fs.readFileSync(action.stateFile, 'utf8'));
      prompts.push(fs.readFileSync(state.wave.promptPath, 'utf8'));
    },
  });
  return { plan, run, prompts, rebuttalWaves: launches(run.trace, 'rebuttal') };
}

describe('rebuttal retry', () => {
  it('rebuttal retry relaunches the failed delegate once with the parse error and settles on CONFIRM', () => {
    const { plan, run, prompts, rebuttalWaves } = rebuttalRun((index, keys) => (index === 0 ? GARBAGE : rebuttal(keys.map((key) => [key, 'CONFIRM']))));
    assert.equal(rebuttalWaves.length, 2, 'one retry rebuttal wave follows the invalid report');
    const retry = rebuttalWaves[1];
    assert.deepEqual(retry.selectedTargets.map((target) => target.platform), ['agy'], 'retry targets only the failed delegate');
    assert.deepEqual(retry.keys, rebuttalWaves[0].keys, 'retry reuses the same keys');
    assert.match(prompts[1], /didn't parse because \S/, 'retry prompt carries the parse error');
    assert.match(prompts[1], /CONFIRM\/REBUT\/INTENT-DISPUTE/);
    assert.doesNotMatch(prompts[0], /didn't parse because/, 'the first rebuttal prompt has no retry note');
    assert.equal(logEntries(plan)[0].status, 'rejected', 'unanimous CONFIRM on retry settles the rejection');
    assert.ok(!run.done.failed?.some((item) => item.wave === 'rebuttal'), JSON.stringify(run.done.failed));
    assert.equal(readLog(plan).rebuttalFailures.length, 0);
  });

  it('rebuttal retry that fails again records invalid-report with the affected finding keys', () => {
    const { plan, run, rebuttalWaves } = rebuttalRun(() => GARBAGE);
    assert.equal(rebuttalWaves.length, 2, 'exactly one retry, never more');
    const key = rebuttalWaves[0].keys[0];
    const failed = (run.done.failed ?? []).filter((item) => item.wave === 'rebuttal');
    assert.equal(failed.length, 1, JSON.stringify(run.done.failed));
    assert.equal(failed[0].kind, 'invalid-report');
    assert.match(failed[0].sourceKey, /:agy:0$/);
    assert.deepEqual(failed[0].findingKeys, [key], 'notice lists the keys the delegate cites');
    const noticed = run.trace.filter((action) => action.unfulfilledTargets?.wave === 'rebuttal')
      .flatMap((action) => action.unfulfilledTargets.targets);
    assert.ok(noticed.length > 0, 'a rebuttal failure notice was emitted');
    assert.ok(noticed.every((target) => Array.isArray(target.findingKeys) && target.findingKeys.includes(key)), JSON.stringify(noticed));
    assert.equal(logEntries(plan)[0].status, 'rejected', 'the gate still rules the live key');
  });
});
