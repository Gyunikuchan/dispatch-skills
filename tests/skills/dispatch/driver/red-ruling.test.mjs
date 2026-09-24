// SC6: driver-verified RED rulings at the RED-gate failure disposition.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { readLedger } from '../../../../skills/dispatch/scripts/ledger/ledger.mjs';
import { persistEvidence } from '../../../../skills/dispatch/scripts/driver/implement-state.mjs';

import { implementationOutcome } from '../../../helpers/driver-harness.mjs';
import { cleanupOrdinaryDriverFixtures, createOrdinaryDriverFixture, driveOrdinaryImplementation, ordinaryDriverPolicy } from '../../../helpers/ordinary-driver-fixture.mjs';

afterEach(cleanupOrdinaryDriverFixtures);

// SECTION: Fixture segments

const RED_ROW = 'RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample';
const PASSING_TEST = "import assert from 'node:assert/strict';\nimport { value } from '../src/app.js';\nassert.equal(value, 2);\n";

/**
 * Segment 1 records a host-observed RED and then terminates when every production writer rejects.
 * The host then lands the production change, so a resumed segment's RED tests already pass.
 * @returns {{ fixture: any, priorRunId: string }}
 */
function interruptedRun({ redException = null, multiCommand = false } = {}) {
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
function resumedRun(fixture, rulings, { testsOnly, restartWhen, beforeRuling } = {}) {
  const base = ordinaryDriverPolicy(fixture.repo);
  const questions = [];
  let index = 0;
  const result = driveOrdinaryImplementation(fixture, { allowErrors: true, maxSteps: 60, restartWhen, policy: {
    delegateWrite(action) {
      if (action.fields.stage === 'tests-only') {
        // The retained test already asserts landed behavior; the writer only touches its classified test path.
        fs.appendFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), '// resumed segment\n');
        testsOnly?.(fixture);
        return { raw: JSON.stringify(implementationOutcome({ stage: 'RED_READY', evidence: [RED_ROW] })) };
      }
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

const carryOver = (runId, extra = []) => ({ decision: 'red-ruling', reason: 'RED observed in the interrupted segment.', rulings: [{ criterionId: 'SC1', kind: 'carry-over', runId }, ...extra] });
const noFailingState = (locus = 'src/app.js:1') => ({ decision: 'red-ruling', reason: 'Behavior already satisfied by landed production.', rulings: [{ criterionId: 'SC1', kind: 'no-failing-state', locus, reason: 'src/app.js already exports value=2.' }] });

function walkthroughText(result) {
  return fs.readFileSync(result.done.handoff.destinations.find(file => file.endsWith('-walkthrough.md')), 'utf8');
}

function assertAccepted(result) {
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
function assertRejected(result, pattern) {
  assert.ok(result.questions.length >= 2, `failure-disposition re-asked after rejection (${result.questions.length})`);
  const retry = result.questions[1];
  assert.match(retry.error ?? '', pattern);
  assert.equal(result.trace.some(action => action.action === 'delegate-write' && action.fields.stage === 'production'), false);
}

// SECTION: Cases

describe('ordinary driver: RED rulings (SC6)', () => {
  it('accepts a carry-over ruling citing the interrupted segment and renders it in the RED matrix', () => {
    const { fixture, priorRunId } = interruptedRun();
    const result = resumedRun(fixture, [carryOver(priorRunId)]);
    assertAccepted(result);
    const walkthrough = walkthroughText(result);
    assert.match(walkthrough, /### RED matrix/);
    assert.match(walkthrough, new RegExp(`SC1 \\| carried over from ${priorRunId}: tests/sample\\.test\\.mjs`));
  });

  it('accepts a carry-over ruling for a criterion mapped to two commands', () => {
    const { fixture, priorRunId } = interruptedRun({ multiCommand: true });
    assert.match(fs.readFileSync(fixture.plan, 'utf8'), /--test-reporter=spec/);
    const result = resumedRun(fixture, [carryOver(priorRunId)]);
    assertAccepted(result);
    assert.match(walkthroughText(result), new RegExp(`SC1 \\| carried over from ${priorRunId}: tests/sample\\.test\\.mjs`));
  });

  it('renders a missed exception join as an evidence-missing row instead of throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-red-join-'));
    try {
      const walkthroughPath = path.join(dir, 'walkthrough.md');
      fs.writeFileSync(walkthroughPath, '# Walkthrough\n\n## Verification & Validation\n- pending\n\n## Outcome Traceability\n- pending\n\n## Key Deviations\n- none\n');
      const state = { repoRoot: dir, planPath: path.join(dir, 'plan.md'), walkthroughPath, governingHash: 'sha256:x', ordinary: {
        criteria: [], redValidated: { scopeHash: 'x', evidence: [], exceptions: [{ criterionId: 'SC1', kind: 'carry-over', runId: 'gone' }] } } };
      assert.doesNotThrow(() => persistEvidence(state));
      assert.match(fs.readFileSync(walkthroughPath, 'utf8'), /SC1 \| exception evidence missing \| —/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a carry-over ruling naming a wrong runId and keeps the question open', () => {
    const { fixture } = interruptedRun();
    const wrong = '00000000-0000-4000-8000-000000000000';
    const result = resumedRun(fixture, [carryOver(wrong), 'keep-for-repair']);
    assertRejected(result, new RegExp(wrong));
  });

  it('rejects a no-failing-state ruling when the plan declares no RED exception class', () => {
    const { fixture } = interruptedRun();
    const result = resumedRun(fixture, [noFailingState(), 'keep-for-repair']);
    assertRejected(result, /RED exception/i);
  });

  it('accepts a no-failing-state ruling against a declared class and an existing locus', () => {
    const { fixture } = interruptedRun({ redException: 'already-satisfied' });
    const result = resumedRun(fixture, [noFailingState()]);
    assertAccepted(result);
    assert.match(walkthroughText(result), /SC1 \| N\/A — src\/app\.js:1 \| exception \(already-satisfied\): src\/app\.js already exports value=2\./);
  });

  it('rejects carry-over entries citing two different runIds', () => {
    const { fixture, priorRunId } = interruptedRun();
    const other = '11111111-1111-4111-8111-111111111111';
    const result = resumedRun(fixture, [carryOver(priorRunId, [{ criterionId: 'SC1', kind: 'carry-over', runId: other }]), 'keep-for-repair']);
    assertRejected(result, /runId/);
  });

  it('does not offer red-ruling at a tests-only admission failure after a load-failure retry', () => {
    const fixture = createOrdinaryDriverFixture(); let calls = 0; const offered = [];
    const base = ordinaryDriverPolicy(fixture.repo);
    driveOrdinaryImplementation(fixture, { allowErrors: true, policy: {
      delegateWrite(action) {
        if (action.fields.stage === 'production') return base.delegateWrite(action);
        if (++calls > 1) return { raw: '{"status":"DONE"}' };
        fs.writeFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), "import assert from 'node:assert/strict';\nimport { missing } from '../src/app.js';\nassert.equal(missing, 2);\n");
        return { raw: JSON.stringify(implementationOutcome({ stage: 'RED_READY', evidence: [RED_ROW] })) };
      },
      verify(action) {
        const reply = base.verify(action);
        if (fs.readFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), 'utf8').includes('missing')) for (const item of reply.results) item.identifiers = ['error:load tests/sample.test.mjs'];
        return reply;
      },
      askUser(action) {
        if (action.question === 'implementation-recovery') return { answer: { raw: '{"status":"DONE"}' } };
        if (action.question === 'failure-disposition') { offered.push(/red-ruling/.test(action.text)); return { answer: { decision: 'inspect-first', reason: 'Inspect admission failure.' } }; }
        return base.askUser(action);
      },
    } });
    assert.ok(calls >= 2, 'the load failure relaunched tests-only');
    assert.deepEqual(offered, [false]);
  });

  it('resumes into production after an interruption that follows an accepted ruling', () => {
    const { fixture, priorRunId } = interruptedRun();
    let restarted = false;
    const result = resumedRun(fixture, [carryOver(priorRunId)], {
      restartWhen: action => !restarted && action.action === 'delegate-write' && action.fields.stage === 'production' && (restarted = true),
    });
    assert.equal(result.restarts, 1);
    assert.equal(result.questions.length, 1, 'the resolved failure is not reopened on resume');
    const afterRestart = result.trace.slice(result.trace.findIndex(action => action.action === 'delegate-write' && action.fields.stage === 'production') + 1);
    assert.equal(afterRestart[0].action, 'ask-user', JSON.stringify(afterRestart[0]));
    assert.equal(afterRestart[0].question, 'implementation-recovery', 'the restored production write is recovered, not relaunched');
    assert.equal(afterRestart.some(action => action.action === 'delegate-write'), false);
    assertAccepted(result);
  });

  // NOTE: the unrelated RED-gate defect is stale RED evidence: the test file changes after the RED run.
  it('rejects a valid ruling when another RED-gate defect remains, naming it and keeping the question open', () => {
    const { fixture, priorRunId } = interruptedRun();
    const result = resumedRun(fixture, [carryOver(priorRunId), 'keep-for-repair'], {
      beforeRuling: f => fs.appendFileSync(path.join(f.repo.dir, 'tests/sample.test.mjs'), '// mutated after the RED run\n'),
    });
    assertRejected(result, /RED host evidence is stale or changed the repository/);
    const events = readLedger(result.done.ledgerPath).events;
    assert.equal(events.some(event => event.type === 'ruling' && event.data.key === 'red-exception'), false, 'red-ruling did not validate');
  });
});
