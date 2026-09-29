// @ts-check
import assert from 'node:assert/strict';
import { after, afterEach, describe, it } from 'node:test';

import { CONSIDER_D, MUST_A, MUST_B, SHOULD_C, runRounds } from '../../../helpers/review-rounds-fixture.mjs';
import { cleanupScriptedRepos, disposeScriptedFixtures } from '../../../helpers/scripted-review-fixture.mjs';

afterEach(cleanupScriptedRepos);
after(disposeScriptedFixtures);

describe('review rounds', () => {
  it('re-reviews a fixed SHOULD before the cap and stops on a clean round', () => {
    const { run, reviews } = runRounds({ rounds: [[SHOULD_C]], cap: 3 });
    assert.equal(run.done.outcome, 'complete', JSON.stringify(run.done).slice(0, 800));
    assert.equal(reviews.length, 2);
  });

  it('does not re-review a fixed CONSIDER', () => {
    const { run, reviews } = runRounds({ rounds: [[CONSIDER_D]], cap: 3 });
    assert.equal(run.done.outcome, 'complete');
    assert.equal(reviews.length, 1);
  });

  it('runs delta MUST rounds beyond the cap without an extend question', () => {
    const { run, reviews, prompts } = runRounds({ rounds: [[MUST_A], [MUST_B]], cap: 1, capturePrompts: true });
    assert.equal(run.done.outcome, 'complete', JSON.stringify(run.done).slice(0, 800));
    assert.equal(reviews.length, 3, 'MUST fixes past the cap keep the loop going');
    assert.ok(!run.trace.some((a) => a.action === 'ask-user' && a.question === 'extend'));
    assert.match(prompts[2], /Delta round 2/);
    assert.match(prompts[3], /Delta round 3/);
  });

  it('stops after the cap when only a SHOULD was fixed', () => {
    const { run, reviews } = runRounds({ rounds: [[SHOULD_C]], cap: 1 });
    assert.equal(run.done.outcome, 'complete');
    assert.equal(reviews.length, 1);
  });
});
