// Speed cuts (SC7): fewer review waves and verification gates without weakening the final gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { allProviders, codeFinding, implementationOutcome, readFixtureState, report, writeOutcomeReply } from '../../../helpers/driver-harness.mjs';
import { cleanupOrdinaryDriverFixtures, createOrdinaryDriverFixture, driveOrdinaryImplementation, ordinaryDriverPolicy, tierFixture, tierPolicy } from '../../../helpers/ordinary-driver-fixture.mjs';

afterEach(cleanupOrdinaryDriverFixtures);

const LINT = 'node scripts/lint.mjs';

/** Runs with one code-review finding of `severity`, applied by appending a comment; the fix names no check, so its scoped command goes stale. */
function reviewRun(severity) {
  const fixture = createOrdinaryDriverFixture();
  let production = false, codeWaves = 0;
  const reviews = new Set();
  const base = ordinaryDriverPolicy(fixture.repo);
  const result = driveOrdinaryImplementation(fixture, { onAction(action) {
    // Each implementation code review has its own run; a re-review after a fix starts a new one.
    const review = production && readFixtureState(action.stateFile).reviewState;
    if (review?.invocation?.implementation) reviews.add(review.runId);
  }, policy: {
    delegateWrite(action) { production ||= action.fields.stage === 'production'; return base.delegateWrite(action); },
    waveResults: () => allProviders(report(production && ++codeWaves === 1 ? [codeFinding({ severity, defect: 'Missing trailing comment.' })] : [])),
    // The fix names no check, so its scoped command goes stale for the driver to judge.
    fix: () => ({ affectedPaths: ['src/app.js'], dependsOn: [], verification: [] }),
    applyFixes(action) {
      fs.appendFileSync(path.join(fixture.repo.dir, 'src/app.js'), '// fixed\n');
      return { clusters: action.clusters.map(cluster => ({ clusterId: cluster.clusterId, status: 'applied' })) };
    },
  } });
  return { result, codeWaves: () => codeWaves, reviews: () => reviews.size };
}
const scopedAfterFix = trace => {
  const fixAt = trace.findIndex(action => action.action === 'apply-fixes');
  return trace.slice(fixAt + 1).filter(action => action.action === 'verify' && action.purpose === 'scoped');
};

describe('speed cuts', () => {
  it('speed cut: an applied non-MUST fix goes to the final gate without another review wave', () => {
    const { result, codeWaves, reviews } = reviewRun('SHOULD');
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.equal(codeWaves(), 1);
    assert.equal(reviews(), 1);
    assert.deepEqual(scopedAfterFix(result.trace), [], 'the final gate covers the stale scoped command');
  });

  it('speed cut: an applied MUST fix re-enters code review', () => {
    const { result, reviews } = reviewRun('MUST');
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.equal(reviews(), 2);
  });

  it('speed cut: a scoped command with an unchanged fingerprint is not re-run', () => {
    const fixture = tierFixture({ lint: true });
    const policy = tierPolicy(fixture);
    let productionWrites = 0;
    const result = driveOrdinaryImplementation(fixture, { policy: {
      ...policy,
      // The fixture runs the sample test for every command; lint itself passes regardless of the app value.
      verify(action, ctx) {
        const reply = policy.verify(action, ctx);
        return { ...reply, results: reply.results.map(item => (item.command === LINT ? { ...item, exit: 0, identifiers: [] } : item)) };
      },
      delegateWrite(action) {
        if (action.fields.stage !== 'production' || ++productionWrites > 1) return policy.delegateWrite(action);
        fs.writeFileSync(path.join(fixture.repo.dir, 'src/app.js'), 'export const value = 3;\n');
        return writeOutcomeReply(action, implementationOutcome({ evidence: ['SC1', 'SC2', 'SC3'].map(id => `CRITERION ${id} | ${id === 'SC3' ? 'tests/sample.test.mjs' : 'src/app.js'} | delivered value`) }));
      },
    } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    const scoped = result.trace.filter(action => action.action === 'verify' && action.purpose === 'scoped');
    assert.ok(scoped.length >= 2, JSON.stringify(scoped.map(action => action.commands)));
    assert.ok(scoped[0].commands.includes(LINT));
    assert.equal(scoped[1].commands.includes(LINT), false, 'the lint command scoped to the unchanged test file stays fresh');
  });

  it('speed cut: hot-fixed paths reach the code-review focus', () => {
    const fixture = createOrdinaryDriverFixture();
    const base = ordinaryDriverPolicy(fixture.repo);
    let focus = null;
    const result = driveOrdinaryImplementation(fixture, {
      onAction(action) {
        if (action.action === 'launch' && focus === null) {
          const state = readFixtureState(action.stateFile);
          if (state.reviewState?.invocation?.implementation) focus = state.reviewState.invocation.focus ?? '';
        }
      },
      policy: {
        delegateWrite(action) {
          if (action.fields.stage === 'tests-only') return base.delegateWrite(action);
          fs.writeFileSync(path.join(fixture.repo.dir, 'src/app.js'), 'export const value = 3;\n');
          return writeOutcomeReply(action, implementationOutcome({ evidence: ['CRITERION SC1 | src/app.js | delivered value'] }));
        },
        askUser(action) {
          if (action.question === 'failure-disposition') return { answer: { decision: 'hotfix', mode: 'host', rootCause: 'off-by-one value', reason: 'Known locus.' } };
          if (action.question === 'hotfix-edit') { fs.writeFileSync(path.join(fixture.repo.dir, 'src/app.js'), 'export const value = 2;\n'); return { answer: { done: true } }; }
          return base.askUser(action);
        },
      },
    });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.equal(focus, '- src/app.js — hot fix: off-by-one value');
  });
});
