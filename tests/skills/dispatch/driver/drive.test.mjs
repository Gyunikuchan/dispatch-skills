import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { allProviders, implementationOutcome, parseAction, report, runDispatch } from '../../../helpers/driver-harness.mjs';
import { ordinaryDriverPolicy, cleanupOrdinaryDriverFixtures, createOrdinaryDriverFixture } from '../../../helpers/ordinary-driver-fixture.mjs';
import { loadSchema, validateAgainstSchema } from '../../../../skills/dispatch/scripts/driver/actions.mjs';
import { readLedger } from '../../../../skills/dispatch/scripts/ledger/ledger.mjs';

afterEach(cleanupOrdinaryDriverFixtures);

const RED_TEST = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { value } from '../src/app.js';\ntest('sample', () => { assert.equal(value, 2); });\n";

function step(fx, args) {
  const res = runDispatch(fx.fixture, args, { cwd: fx.repo.dir, results: allProviders(report()) });
  assert.equal(res.status, 0, res.stderr);
  return { action: parseAction(res.stdout), stderr: res.stderr };
}

/** Writes the fixture's RED test or production change and returns the envelope a writer would. */
function write(fx, action) {
  const testsOnly = action.fields.stage === 'tests-only';
  if (testsOnly) fs.writeFileSync(path.join(fx.repo.dir, 'tests/sample.test.mjs'), RED_TEST);
  else fs.writeFileSync(path.join(fx.repo.dir, 'src/app.js'), 'export const value = 2;\n');
  return implementationOutcome({ stage: testsOnly ? 'RED_READY' : 'COMPLETE', evidence: testsOnly ? ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] : ['CRITERION SC1 | src/app.js | delivered value=2'] });
}

/** Drives a run with --drive only, answering each stop; returns every stopping action and the banners. */
function driveToDone(fx, first, answer) {
  const stops = [];
  let banners = '';
  let action = first;
  for (let turn = 0; turn < 20 && action.action !== 'done'; turn++) {
    const input = answer(action);
    const next = step(fx, ['--drive', '--state', action.stateFile, ...(input === undefined ? [] : ['--input', JSON.stringify(input)])]);
    banners += next.stderr;
    action = next.action;
    stops.push(action);
  }
  return { stops, banners };
}

describe('--drive', () => {
  it('runs launch and verify argv itself and stops only where the host decides', () => {
    const fx = createOrdinaryDriverFixture();
    const base = ordinaryDriverPolicy(fx.repo);
    const { action: first } = step(fx, ['--run', 'implement', '--orchestrator', 'claude', '--', fx.plan]);
    assert.equal(first.action, 'launch');
    const { stops, banners } = driveToDone(fx, first, (action) => {
      if (action.action === 'ask-user') return base.askUser(action);
      if (action.action === 'delegate-write') return { envelope: write(fx, action) };
      assert.equal(action.action, 'launch', 'only the first pending launch is handed to --drive unanswered');
      return undefined;
    });
    assert.deepEqual(stops.map(action => action.action === 'delegate-write' ? `write:${action.fields.stage}` : action.question ?? action.action),
      ['approval', 'write:tests-only', 'write:production', 'done']);
    assert.equal(stops.at(-1).outcome, 'complete', JSON.stringify(stops.at(-1)));
    assert.match(banners, /\[dispatch drive\] launch review R1: exit 0/);
    assert.deepEqual([...banners.matchAll(/\[dispatch drive\] verify (\w+)/g)].map(match => match[1]), ['baseline', 'red', 'scoped']);
  });

  it('runs a completion gate once, stops with its summary, and reruns it only after the tree changes', () => {
    const fx = createOrdinaryDriverFixture();
    fs.writeFileSync(fx.plan, fs.readFileSync(fx.plan, 'utf8').replace('Evidence: red', 'Evidence: verify'));
    const base = ordinaryDriverPolicy(fx.repo);
    const { action: first } = step(fx, ['--run', 'implement', '--orchestrator', 'claude', '--', fx.plan]);
    let gate = null;
    const { stops, banners } = driveToDone(fx, first, (action) => {
      // Without red criteria no tests-only paths are classified.
      if (action.question === 'approval') return { answer: { ...base.askUser(action).answer, testPaths: [] } };
      if (action.action === 'ask-user') return base.askUser(action);
      if (action.action === 'delegate-write') {
        fs.writeFileSync(path.join(fx.repo.dir, 'tests/sample.test.mjs'), RED_TEST);
        return { envelope: write(fx, action) };
      }
      if (action.action === 'verify') {
        gate = action;
        assert.equal(action.purpose, 'scoped');
        assert.match(action.guidance[0], /already ran argv; do not rerun it/);
        assert.deepEqual(validateAgainstSchema(loadSchema('verify'), action), []);
        // A reply without evidence re-emits the same gate; the runner then reuses its results.
        const rejected = step(fx, ['--drive', '--state', action.stateFile]);
        assert.equal(rejected.action.action, 'verify');
        assert.equal(rejected.action.summary.reused, true);
        assert.match(rejected.stderr, /verify scoped: 1 command\(s\), 0 nonzero, reused unchanged-tree results/);
        // An approved-path edit after the run invalidates those results, so the same gate runs again.
        fs.writeFileSync(path.join(fx.repo.dir, 'src/app.js'), 'export const value = 2; // edited\n');
        const rerun = step(fx, ['--drive', '--state', action.stateFile]);
        assert.equal(rerun.action.summary.reused, undefined);
        assert.doesNotMatch(rerun.stderr, /reused/);
        assert.notEqual(rerun.action.summary.results[0].scopeHash, action.summary.results[0].scopeHash);
        const result = rerun.action.summary.results[0];
        return { criterionEvidence: [{ criterionId: 'SC1', evidenceClass: 'verify', reviewer: 'host', scenario: 'Ran the sample test.', inspectedRevision: result.scopeHash, observableResult: 'value is 2', limitations: 'none', mutationEpoch: result.mutationEpoch }] };
      }
      return undefined;
    });
    assert.ok(gate, `drive stopped at the completion gate: ${JSON.stringify(stops.map(stop => [stop.action, stop.question, stop.outcome, stop.summary, stop.error]))}`);
    assert.equal(stops.at(-1).outcome, 'complete', JSON.stringify(stops.at(-1)));
    assert.equal([...banners.matchAll(/verify scoped/g)].length, 1, 'the evidence reply advanced without rerunning the gate');
  });

  it('auto-approves an explicit low run with a clean baseline and no red criteria, recording the driver as actor', () => {
    const fx = createOrdinaryDriverFixture();
    fs.writeFileSync(fx.plan, fs.readFileSync(fx.plan, 'utf8').replace('Evidence: red', 'Evidence: verify'));
    const { action: first } = step(fx, ['--run', 'implement', '--level', 'low', '--orchestrator', 'claude', '--', fx.plan]);
    const { stops } = driveToDone(fx, first, (action) => {
      assert.notEqual(action.question, 'approval', 'explicit low with nothing to rule on skips the approval ask');
      if (action.action === 'delegate-write') {
        fs.writeFileSync(path.join(fx.repo.dir, 'tests/sample.test.mjs'), RED_TEST);
        return { envelope: write(fx, action) };
      }
      if (action.action === 'verify') {
        const result = action.summary.results[0];
        return { criterionEvidence: [{ criterionId: 'SC1', evidenceClass: 'verify', reviewer: 'host', scenario: 'Ran the sample test.', inspectedRevision: result.scopeHash, observableResult: 'value is 2', limitations: 'none', mutationEpoch: result.mutationEpoch }] };
      }
      return undefined;
    });
    const done = stops.at(-1);
    assert.equal(done.outcome, 'complete', JSON.stringify(done));
    const approval = readLedger(done.ledgerPath).events.find(event => event.type === 'approval');
    assert.equal(approval.data.actor, 'driver');
  });

  it('still asks for approval at explicit low when a criterion needs red evidence', () => {
    const fx = createOrdinaryDriverFixture();
    const { action: first } = step(fx, ['--run', 'implement', '--level', 'low', '--orchestrator', 'claude', '--', fx.plan]);
    let action = first;
    for (let turn = 0; turn < 10 && action.action === 'launch'; turn++) action = step(fx, ['--drive', '--state', action.stateFile]).action;
    assert.equal(action.question, 'approval', JSON.stringify(action));
  });

  it('rejects --drive without a state file or combined with --run', () => {
    const fx = createOrdinaryDriverFixture();
    const missing = runDispatch(fx.fixture, ['--drive'], { cwd: fx.repo.dir });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /--drive requires --state/);
    const combined = runDispatch(fx.fixture, ['--drive', '--run', 'implement', '--orchestrator', 'claude', '--', fx.plan], { cwd: fx.repo.dir });
    assert.equal(combined.status, 2);
  });
});

describe('writer envelope self-check', () => {
  function pendingWrite(fx) {
    const base = ordinaryDriverPolicy(fx.repo);
    const { action: first } = step(fx, ['--run', 'implement', '--orchestrator', 'claude', '--', fx.plan]);
    let action = first;
    while (action.action !== 'delegate-write') {
      action = step(fx, ['--drive', '--state', action.stateFile, ...(action.action === 'ask-user' ? ['--input', JSON.stringify(base.askUser(action))] : [])]).action;
    }
    return action;
  }
  function check(fx, action, envelope) {
    const file = path.join(fx.repo.dir, '..', `${path.basename(fx.repo.dir)}-envelope.json`);
    fs.writeFileSync(file, typeof envelope === 'string' ? envelope : JSON.stringify(envelope));
    try {
      const res = runDispatch(fx.fixture, ['--check-envelope', file, '--state', action.stateFile], { cwd: fx.repo.dir });
      return { status: res.status, result: JSON.parse(res.stdout) };
    } finally { fs.rmSync(file, { force: true }); }
  }

  it('names the check command in both briefs and reports each defect the driver would reject', () => {
    const fx = createOrdinaryDriverFixture();
    const action = pendingWrite(fx);
    const brief = JSON.parse(fs.readFileSync(action.fields.promptPath, 'utf8'));
    assert.match(brief.selfCheck.command, /--check-envelope ENVELOPE_FILE --state /);
    assert.match(brief.verification.join(' '), /never run an aggregate suite/);

    const stringEvidence = check(fx, action, { ...implementationOutcome({ stage: 'RED_READY' }), evidence: 'RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample' });
    assert.equal(stringEvidence.status, 1);
    assert.match(stringEvidence.result.errors.join(' '), /evidence must be an array/);
    const extraField = check(fx, action, { ...implementationOutcome({ stage: 'RED_READY', evidence: ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] }), notes: 'x' });
    assert.match(extraField.result.errors.join(' '), /unknown field "notes"/);
    const noRow = check(fx, action, implementationOutcome({ stage: 'RED_READY' }));
    assert.match(noRow.result.errors.join(' '), /Exactly one primary RED-MATRIX row required for SC1/);
    assert.deepEqual(check(fx, action, implementationOutcome({ stage: 'RED_READY', evidence: ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] })), { status: 0, result: { ok: true } });

    const production = step(fx, ['--drive', '--state', action.stateFile, '--input', JSON.stringify({ envelope: write(fx, action) })]).action;
    assert.equal(production.fields.stage, 'production');
    const productionBrief = JSON.parse(fs.readFileSync(production.fields.promptPath, 'utf8'));
    assert.equal(productionBrief.envelope.stage, 'COMPLETE');
    assert.ok(productionBrief.selfCheck.command.includes(production.stateFile));
    const untraced = check(fx, production, implementationOutcome());
    assert.match(untraced.result.errors.join(' '), /CRITERION SC1 \| <one of: src\/app\.js, tests\/sample\.test\.mjs>/);
    assert.equal(check(fx, production, implementationOutcome({ evidence: ['CRITERION SC1 | src/app.js | value=2'] })).status, 0);
  });
});

describe('settled plan at implement start', () => {
  it('skips a new plan-review round when the settled checkpoint matches the plan', () => {
    const fx = createOrdinaryDriverFixture();
    let action = step(fx, ['--run', 'plan', '--orchestrator', 'claude', '--', fx.plan]).action;
    while (action.action !== 'done') action = step(fx, ['--drive', '--state', action.stateFile]).action;
    assert.equal(action.outcome, 'complete', JSON.stringify(action));
    const implement = step(fx, ['--run', 'implement', '--orchestrator', 'claude', '--', fx.plan]).action;
    assert.equal(implement.action, 'verify');
    assert.equal(implement.purpose, 'baseline');
    fs.writeFileSync(fx.plan, fs.readFileSync(fx.plan, 'utf8').replace('- First.', '- First, edited.'));
    const edited = step(fx, ['--run', 'implement', '--orchestrator', 'claude', '--', fx.plan]).action;
    assert.equal(edited.action, 'launch', 'changed content is reviewed again');
  });
});
