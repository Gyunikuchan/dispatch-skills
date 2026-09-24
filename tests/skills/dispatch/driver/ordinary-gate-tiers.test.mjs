import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { allProviders, codeFinding, implementationOutcome, report } from '../../../helpers/driver-harness.mjs';
import { cleanupOrdinaryDriverFixtures, driveOrdinaryImplementation, FINAL_COMMAND, tierFixture, tierPolicy } from '../../../helpers/ordinary-driver-fixture.mjs';

afterEach(cleanupOrdinaryDriverFixtures);

const verifies = trace => trace.filter(action => action.action === 'verify');
const SAMPLE = 'node --test tests/sample.test.mjs', LINT = 'node scripts/lint.mjs';
const handoffWalkthrough = done => fs.readFileSync(done.handoff.destinations.find(file => file.endsWith('-walkthrough.md')), 'utf8');

describe('ordinary driver verification gate tiers', () => {
  it('runs a [FINAL] command only at baseline and one final gate across a retry and an accepted fix round', () => {
    const fixture = tierFixture({ lint: true });
    let testsOnlyWrites = 0, production = false, codeWaves = 0, fixed = false;
    const policy = tierPolicy(fixture);
    const result = driveOrdinaryImplementation(fixture, { policy: {
      ...policy,
      delegateWrite(action) {
        production ||= action.fields.stage === 'production';
        // The first tests-only write claims RED without changing the test, forcing a retry.
        if (action.fields.stage === 'tests-only' && ++testsOnlyWrites === 1) return { raw: JSON.stringify(implementationOutcome({ stage: 'RED_READY', evidence: ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] })) };
        return policy.delegateWrite(action);
      },
      askUser(action) {
        if (action.question === 'failure-disposition') return { answer: { decision: 'retry', reason: 'The test was never changed.', context: 'Write the failing value=2 assertion.' } };
        return policy.askUser(action);
      },
      waveResults: () => allProviders(report(production && ++codeWaves === 1 ? [codeFinding({ defect: 'Missing trailing comment.' })] : [])),
      fix: () => ({ affectedPaths: ['src/app.js'], dependsOn: [], verification: [SAMPLE] }),
      applyFixes(action) {
        fs.appendFileSync(path.join(fixture.repo.dir, 'src/app.js'), '// fixed\n');
        fixed = true;
        return { clusters: action.clusters.map(cluster => ({ clusterId: cluster.clusterId, status: 'applied', paths: cluster.affectedPaths, note: 'edited' })) };
      },
    } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.ok(fixed, 'a code-review fix round was applied');
    const gates = verifies(result.trace), purposes = gates.map(action => action.purpose);
    assert.equal(purposes.includes('completion'), false, purposes.join(' → '));
    assert.equal(purposes.filter(purpose => purpose === 'final').length, 1, purposes.join(' → '));
    assert.equal(purposes.at(-1), 'final', 'the final gate is the last gate before handoff');
    assert.ok(purposes.filter(purpose => purpose === 'scoped').length >= 2, 'attempt and post-review gates are scoped');
    assert.deepEqual(gates.filter(action => action.commands.includes(FINAL_COMMAND)).map(action => action.purpose), ['baseline', 'final']);
    // The fix touched only src/app.js: the lint command, scoped to the test file, is skipped at the post-review gate.
    const postReview = gates.filter(action => action.purpose === 'scoped').at(-1);
    assert.ok(postReview.commands.includes(SAMPLE), JSON.stringify(postReview.commands));
    assert.equal(postReview.commands.includes(LINT), false, JSON.stringify(postReview.commands));
    // Folded from the retired end-to-end defer case: the final gate defers nothing and the deferred SC2 renders final evidence.
    assert.equal(gates.find(action => action.purpose === 'final')?.deferred, undefined, 'the final gate defers nothing');
    const walkthrough = handoffWalkthrough(result.done);
    assert.match(walkthrough, /- \[SC2\] delivered value=2 — production path: `src\/app\.js`; evidence: verify;/);
    assert.doesNotMatch(walkthrough, /Pending — missing validated/);
  });

  it('reaches the final gate and done with code review disabled', () => {
    const fixture = tierFixture({ codeReview: false });
    const result = driveOrdinaryImplementation(fixture, { policy: tierPolicy(fixture) });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    const purposes = verifies(result.trace).map(action => action.purpose);
    assert.equal(purposes.filter(purpose => purpose === 'final').length, 1, purposes.join(' → '));
    assert.equal(purposes.at(-1), 'final');
  });

  it('re-verify after a failed final gate reruns its commands', () => {
    const fixture = tierFixture();
    let finals = 0, disposition = null;
    const policy = tierPolicy(fixture);
    const result = driveOrdinaryImplementation(fixture, { policy: {
      ...policy,
      verify(action, ctx) {
        if (action.purpose === 'final' && ++finals === 1) return { results: action.commands.map(command => ({ command, exit: 1, evidence: 'pass 0 fail 1', identifiers: ['test:sample'], diagnostic: 'stale checkout' })) };
        return policy.verify(action, ctx);
      },
      askUser(action) {
        if (action.question !== 'failure-disposition') return policy.askUser(action);
        disposition = action.text;
        return { answer: { decision: 're-verify', reason: 'The host ran the command against a stale checkout.' } };
      },
    } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.match(disposition ?? '', /"re-verify"/);
    const finalGates = verifies(result.trace).filter(action => action.purpose === 'final');
    assert.equal(finalGates.length, 2);
    assert.deepEqual(finalGates[1].commands, finalGates[0].commands);
  });

});
