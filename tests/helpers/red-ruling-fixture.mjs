// @ts-check
// Shared fixtures for red-ruling*.test.mjs: an interrupted segment with host-observed RED, then a resumed one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readLedger } from '../../skills/dispatch/scripts/ledger/ledger.mjs';

import { implementationOutcome } from './driver-harness.mjs';
import { createOrdinaryDriverFixture, driveOrdinaryImplementation, ordinaryDriverPolicy } from './ordinary-driver-fixture.mjs';

// SECTION: Fixture segments

export const RED_ROW = 'RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample';
const PASSING_TEST = "import assert from 'node:assert/strict';\nimport { value } from '../src/app.js';\nassert.equal(value, 2);\n";

/**
 * Segment 1 records a host-observed RED and then terminates when every production writer rejects.
 * The host then lands the production change, so a resumed segment's RED tests already pass.
 * @returns {{ fixture: any, priorRunId: string }}
 */
export function interruptedRun({ redException = null, multiCommand = false } = {}) {
  const fixture = createOrdinaryDriverFixture();
  if (multiCommand) {
    // SC1 maps two commands; the fixture verify policy runs the sample test for each.
    const text = fs.readFileSync(fixture.plan, 'utf8');
    fs.writeFileSync(fixture.plan, text.replace('  - Verify: `node --test tests/sample.test.mjs`', '  - Verify: `node --test tests/sample.test.mjs`\n  - Verify: `node --test --test-reporter=spec tests/sample.test.mjs`'));
  }
  const base = ordinaryDriverPolicy(fixture.repo);
  const first = driveOrdinaryImplementation(fixture, { allowErrors: true, policy: {
    delegateWrite: action => (action.fields.stage === 'tests-only' ? base.delegateWrite(action) : { rejected: true, reason: 'Model permanently unavailable.' }),
  } });
  assert.equal(first.done.outcome, 'failed', JSON.stringify(first.done));
  const events = readLedger(first.done.ledgerPath).events;
  assert.ok(events.some(event => event.type === 'verification' && event.data.result === 'red'), 'segment 1 recorded a red verification');
  const priorRunId = events[0].runId;
  // The host lands production between segments; the plan gains a revision so a new segment starts.
  fs.writeFileSync(path.join(fixture.repo.dir, 'src/app.js'), 'export const value = 2;\n');
  fs.writeFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), PASSING_TEST);
  fixture.repo.git('add', 'src', 'tests'); fixture.repo.git('commit', '--no-gpg-sign', '-qm', 'land production');
  let plan = fs.readFileSync(fixture.plan, 'utf8').replace('- Add regression.', '- Add regression; resumed after production landed.');
  if (redException) plan = plan.replace('  - Test rationale: Behavioral failure isolates the sample outcome and protects its regression.',
    `  - Test rationale: Behavioral failure isolates the sample outcome and protects its regression.\n  - RED exception: ${redException}`);
  fs.writeFileSync(fixture.plan, plan);
  return { fixture, priorRunId };
}

/**
 * Drives the resumed segment. `rulings` answers each failure-disposition in order; a string entry is
 * a plain decision. Returns the result plus every failure-disposition action seen.
 */
export function resumedRun(fixture, rulings, { testsOnly, restartWhen, beforeRuling, untouched = false } = {}) {
  const base = ordinaryDriverPolicy(fixture.repo);
  const questions = [];
  let index = 0;
  const result = driveOrdinaryImplementation(fixture, { allowErrors: true, maxSteps: 60, restartWhen, policy: {
    delegateWrite(action) {
      if (action.fields.stage === 'tests-only') {
        // The retained test already asserts landed behavior; the writer only touches its classified test path.
        if (!untouched) fs.appendFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), '// resumed segment\n');
        testsOnly?.(fixture);
        return { raw: JSON.stringify(implementationOutcome({ stage: 'RED_READY', evidence: [RED_ROW] })) };
      }
      // Code review needs a reviewable change when tests-only touched nothing.
      if (untouched) fs.appendFileSync(path.join(fixture.repo.dir, 'src/app.js'), '// resumed segment\n');
      return { raw: JSON.stringify(implementationOutcome({ evidence: ['CRITERION SC1 | delivered value=2 | src/app.js'] })) };
    },
    askUser(action) {
      // The driver never re-emits a pending write after a restart; the host relays the completed write's envelope.
      if (action.question === 'implementation-recovery') return { answer: { raw: JSON.stringify(implementationOutcome({ evidence: ['CRITERION SC1 | delivered value=2 | src/app.js'] })) } };
      if (action.question !== 'failure-disposition') return base.askUser(action);
      if (!questions.length) beforeRuling?.(fixture);
      questions.push(action);
      assert.match(action.text, /red-ruling/, 'the RED-gate failure disposition offers red-ruling');
      const answer = rulings[Math.min(index++, rulings.length - 1)];
      return { answer: typeof answer === 'string' ? { decision: answer, reason: 'Close the fixture run.' } : answer };
    },
  } });
  return { ...result, questions };
}

export const carryOver = (runId, extra = []) => ({ decision: 'red-ruling', reason: 'RED observed in the interrupted segment.', rulings: [{ criterionId: 'SC1', kind: 'carry-over', runId }, ...extra] });
export const noFailingState = (locus = 'src/app.js:1') => ({ decision: 'red-ruling', reason: 'Behavior already satisfied by landed production.', rulings: [{ criterionId: 'SC1', kind: 'no-failing-state', locus, reason: 'src/app.js already exports value=2.' }] });

export function walkthroughText(result) {
  return fs.readFileSync(result.done.handoff.destinations.find(file => file.endsWith('-walkthrough.md')), 'utf8');
}

export function assertAccepted(result) {
  assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
  const events = readLedger(result.done.ledgerPath).events;
  const segmentId = events.at(-1).runId;
  const rulings = events.filter(event => event.runId === segmentId && event.type === 'ruling');
  assert.ok(rulings.some(event => event.data.key === 'red-exception' && event.data.state === 'resolved'), 'red-exception ruling recorded resolved');
  assert.ok(rulings.some(event => event.data.key === 'failure-disposition' && event.data.decision === 'red-ruling' && event.data.state === 'resolved'));
  assert.ok(events.some(event => event.runId === segmentId && event.type === 'verification' && event.data.result === 'red' && event.data.transition === 'run-red'));
  assert.ok(result.trace.some(action => action.action === 'delegate-write' && action.fields.stage === 'production'), 'continues to the production write');
  return segmentId;
}

/** A rejected ruling re-asks the same failure-disposition with an error naming the defect. */
export function assertRejected(result, pattern) {
  assert.ok(result.questions.length >= 2, `failure-disposition re-asked after rejection (${result.questions.length})`);
  const retry = result.questions[1];
  assert.match(retry.error ?? '', pattern);
  assert.equal(result.trace.some(action => action.action === 'delegate-write' && action.fields.stage === 'production'), false);
}
