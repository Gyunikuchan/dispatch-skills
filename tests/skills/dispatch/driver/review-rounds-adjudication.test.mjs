// @ts-check
import assert from 'node:assert/strict';
import { after, afterEach, describe, it } from 'node:test';

import { MUST_A, MUST_A_REWORDED, SHOULD_C, runRounds, stopOnEscalation } from '../../../helpers/review-rounds-fixture.mjs';
import { cleanupScriptedRepos, disposeScriptedFixtures } from '../../../helpers/scripted-review-fixture.mjs';

afterEach(cleanupScriptedRepos);
after(disposeScriptedFixtures);

const escalations = (trace) => trace.filter((a) => a.action === 'ask-user' && a.question === 'escalation');

describe('adjudication', () => {
  it('closes a rejection by reviewer omission and passes it as a dispute', () => {
    const { run, prompts } = runRounds({ rounds: [[MUST_A]], cap: 3, reject: [MUST_A.defect], capturePrompts: true });
    assert.equal(run.done.outcome, 'complete', JSON.stringify(run.done).slice(0, 800));
    assert.match(prompts[2], /Open pending rejections/);
    assert.deepEqual(run.done.reviewRounds.rejected.map((r) => r.closer), ['reviewer']);
  });

  it('closes a below-threshold rejection on the orchestrator after the cap', () => {
    const { run, reviews } = runRounds({ rounds: [[SHOULD_C]], cap: 1, reject: [SHOULD_C.defect] });
    assert.equal(run.done.outcome, 'complete');
    assert.equal(reviews.length, 1);
    assert.deepEqual(run.done.reviewRounds.rejected.map((r) => r.closer), ['orchestrator']);
  });

  it('escalates a deadlock on the second re-raise and stops with the finding open', () => {
    const { run } = runRounds({ rounds: [[MUST_A], [MUST_A_REWORDED], [MUST_A]], cap: 3, reject: [MUST_A.defect, MUST_A_REWORDED.defect], askUser: stopOnEscalation });
    const [question] = escalations(run.trace);
    assert.equal(question?.kind, 'deadlock', JSON.stringify(run.trace.map((a) => a.action)));
    assert.equal(run.done.outcome, 'failed');
    assert.equal(run.done.reviewRounds.escalation.kind, 'deadlock');
  });

  it('escalates a regression when an applied fix is re-raised', () => {
    const { run } = runRounds({ rounds: [[MUST_A], [MUST_A_REWORDED]], cap: 3, askUser: stopOnEscalation });
    const [question] = escalations(run.trace);
    assert.equal(question?.kind, 'regression');
    assert.deepEqual(question.options, ['stop']);
    assert.equal(run.done.outcome, 'failed');
    assert.equal(run.done.reviewRounds.escalation.kind, 'regression');
  });
});
