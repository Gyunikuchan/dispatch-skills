// @ts-check
import assert from 'node:assert/strict';
import { after, afterEach, describe, it } from 'node:test';

import { validateConfig } from '../../../../skills/dispatch/scripts/lib/config.mjs';
import { allProviders, drive, planFinding, rebuttal, report, writePlan } from '../../../helpers/driver-harness.mjs';
import { cleanupScriptedRepos, config, disposeScriptedFixtures, launches, phase, setup } from '../../../helpers/scripted-review-fixture.mjs';

afterEach(cleanupScriptedRepos);
after(disposeScriptedFixtures);

describe('no consensus', () => {
  it('rejects consensus as an unknown phase key', () => {
    const cfg = config();
    cfg.phases['code-review'] = { ...phase(), consensus: { low: true } };
    assert.match(validateConfig(cfg).join('\n'), /unrecognized key "consensus"/);
  });

  it('runs a rebuttal wave when a configured plan review rejects a SHOULD', () => {
    const { fixture, repo } = setup(config({ rounds: 1 }));
    const plan = writePlan(repo.dir);
    const run = drive(fixture, {
      cwd: repo.dir, runArgs: ['review', '--orchestrator', 'claude', '--', plan],
      policy: {
        rule: () => ({ status: 'rejected' }),
        waveResults: (action) => allProviders(action.wave.type === 'rebuttal'
          ? rebuttal(action.keys.map((key) => [key, 'CONFIRM']))
          : report(action.wave.type === 'review' ? [planFinding({ severity: 'SHOULD' })] : [])),
      },
    });
    assert.equal(launches(run.trace, 'rebuttal').length, 1);
    assert.equal(run.done.outcome, 'complete');
  });
});
