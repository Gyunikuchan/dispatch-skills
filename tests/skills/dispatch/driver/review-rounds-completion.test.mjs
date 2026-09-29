// @ts-check
import assert from 'node:assert/strict';
import { after, afterEach, describe, it } from 'node:test';

import { MUST_A, SHOULD_C, runRounds } from '../../../helpers/review-rounds-fixture.mjs';
import { cleanupScriptedRepos, disposeScriptedFixtures } from '../../../helpers/scripted-review-fixture.mjs';

afterEach(cleanupScriptedRepos);
after(disposeScriptedFixtures);

describe('completion output', () => {
  it('reports round count, cap, and no unreviewed fixes after a clean re-review', () => {
    const { run } = runRounds({ rounds: [[MUST_A]], cap: 2 });
    assert.deepEqual(run.done.reviewRounds, { count: 2, cap: 2, capReached: true, fixedUnreviewed: [], rejected: [] });
  });

  it('lists a post-cap SHOULD fix as fixedUnreviewed', () => {
    const { run } = runRounds({ rounds: [[SHOULD_C]], cap: 1 });
    const rounds = run.done.reviewRounds;
    assert.equal(rounds.count, 1);
    assert.equal(rounds.capReached, true);
    assert.equal(rounds.fixedUnreviewed.length, 1);
    assert.equal(rounds.fixedUnreviewed[0].round, 1);
  });

  it('lists rejections with reason and closer', () => {
    const { run } = runRounds({ rounds: [[SHOULD_C]], cap: 1, reject: [SHOULD_C.defect] });
    const [rejected] = run.done.reviewRounds.rejected;
    assert.equal(rejected.closer, 'orchestrator');
    assert.match(rejected.reason, /Declined/);
  });
});
