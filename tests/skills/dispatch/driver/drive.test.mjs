import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { allProviders, implementationOutcome, makeGitRepo, parseAction, report, runDispatch, writeOutcomeReply, writePlan } from '../../../helpers/driver-harness.mjs';
import { createStubDispatchFixture } from '../../../helpers/stub-dispatch-fixture.mjs';
import { ordinaryDriverPolicy, cleanupOrdinaryDriverFixtures, createOrdinaryDriverFixture, driveOrdinaryImplementation } from '../../../helpers/ordinary-driver-fixture.mjs';
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
  return writeOutcomeReply(action, implementationOutcome({ stage: testsOnly ? 'RED_READY' : 'COMPLETE', evidence: testsOnly ? ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] : ['CRITERION SC1 | src/app.js | delivered value=2'] }));
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
      if (action.action === 'delegate-write') return write(fx, action);
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
        return write(fx, action);
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
        assert.equal('diagnostic' in action.summary.results[0], false, 'a passing result omits its output tail');
        // A failing rerun carries its output tail so the host need not read the log.
        fs.writeFileSync(path.join(fx.repo.dir, 'src/app.js'), 'export const value = 3;\n');
        const failing = step(fx, ['--drive', '--state', action.stateFile]).action.summary.results[0];
        assert.notEqual(failing.exit, 0);
        assert.match(failing.diagnostic, /sample/);
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
        return write(fx, action);
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
    const file = action.fields.expectedEnvelopePath;
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
    assert.ok(brief.selfCheck.command.includes(action.fields.expectedEnvelopePath));
    assert.ok(brief.brief.includes(action.fields.expectedEnvelopePath));
    assert.ok(brief.brief.includes(brief.selfCheck.command));
    assert.doesNotMatch(brief.brief, /ENVELOPE_FILE/);
    assert.match(brief.brief, /mapped `commands` only/);
    assert.match(brief.brief, /Name each test so its criterion's mapped command selects it/);
    assert.doesNotMatch(brief.brief, /node --test <changed test file>/);
    assert.deepEqual(brief.manifest[0].commands, action.fields.criteria[0].commands);
    assert.equal(action.fields.promptHash, `sha256:${crypto.createHash('sha256').update(fs.readFileSync(action.fields.promptPath)).digest('hex')}`);

    const stringEvidence = check(fx, action, { ...implementationOutcome({ stage: 'RED_READY' }), evidence: 'RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample' });
    assert.equal(stringEvidence.status, 1);
    assert.match(stringEvidence.result.errors.join(' '), /evidence must be an array/);
    const extraField = check(fx, action, { ...implementationOutcome({ stage: 'RED_READY', evidence: ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] }), notes: 'x' });
    assert.match(extraField.result.errors.join(' '), /unknown field "notes"/);
    const noRow = check(fx, action, implementationOutcome({ stage: 'RED_READY' }));
    assert.match(noRow.result.errors.join(' '), /Exactly one primary RED-MATRIX row required for SC1/);
    assert.deepEqual(check(fx, action, implementationOutcome({ stage: 'RED_READY', evidence: ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] })), { status: 0, result: { ok: true } });

    const production = step(fx, ['--drive', '--state', action.stateFile, '--input', JSON.stringify(write(fx, action))]).action;
    assert.equal(production.fields.stage, 'production');
    const productionBrief = JSON.parse(fs.readFileSync(production.fields.promptPath, 'utf8'));
    assert.equal(productionBrief.envelope.stage, 'COMPLETE');
    assert.ok(productionBrief.selfCheck.command.includes(production.stateFile));
    assert.ok(productionBrief.selfCheck.command.includes(production.fields.expectedEnvelopePath));
    assert.ok(productionBrief.brief.includes(production.fields.expectedEnvelopePath));
    assert.ok(productionBrief.brief.includes(productionBrief.selfCheck.command));
    assert.match(productionBrief.brief, /Tests are evidence, not specification/);
    assert.match(productionBrief.packet.instruction, /brief/);
    assert.deepEqual(productionBrief.packet.criteria[0].commands, production.fields.criteria[0].commands);
    assert.match(productionBrief.brief, /mapped `commands` only/);
    assert.doesNotMatch(productionBrief.brief, /Name each test/);
    assert.equal(production.fields.promptHash, `sha256:${crypto.createHash('sha256').update(fs.readFileSync(production.fields.promptPath)).digest('hex')}`);
    const untraced = check(fx, production, implementationOutcome());
    assert.match(untraced.result.errors.join(' '), /CRITERION SC1 \| <one of: src\/app\.js, tests\/sample\.test\.mjs>/);
    assert.equal(check(fx, production, implementationOutcome({ evidence: ['CRITERION SC1 | src/app.js | value=2'] })).status, 0);
  });
});

describe('settled plan at implement start', () => {
  it('enters implementation from a tableless plan and carries its detailed criteria and command', () => {
    const fx = createOrdinaryDriverFixture();
    const plan = fs.readFileSync(fx.plan, 'utf8');
    assert.doesNotMatch(plan, /^\| SC \| Outcome \|/m);
    let production;
    const result = driveOrdinaryImplementation(fx, { onAction(action) {
      if (action.action === 'delegate-write' && action.fields.stage === 'production') production = action;
    } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.deepEqual(production.fields.criteria.map(item => item.id), ['SC1']);
    assert.deepEqual(production.fields.criteria[0].commands, ['node --test tests/sample.test.mjs']);
  });

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

describe('--drive with early fallbacks', () => {
  it('runs the wave, hands only the failed early-fallback slots to the host, and waits for the wave on the reply', () => {
    const fixture = createStubDispatchFixture({
      'read-delegates': {
        claude: { targets: [{ low: { model: 'claude-opus-5', effort: 'medium' } }] },
        copilot: { targets: [{ low: { model: 'copilot-a', effort: 'low' } }] },
      },
      phases: { 'plan-review': { rounds: { medium: 1 }, targets: { medium: 2 }, consensus: { medium: false } } },
    });
    const repo = makeGitRepo();
    try {
      const plan = writePlan(repo.dir);
      // The same-platform slot fails at once while the other keeps the wave running.
      const results = { ...allProviders(report()), claude: { exit: 1, failureKind: 'quota', stdout: '' }, copilot: { stdout: report(), delayMs: 4000 } };
      const first = runDispatch(fixture, ['--run', 'review', '--kind', 'plan', '--orchestrator', 'claude', '--', plan], { cwd: repo.dir, results });
      assert.equal(first.status, 0, first.stderr);
      const launch = parseAction(first.stdout);
      assert.equal(launch.earlyFallbacks.length, 1);

      const started = runDispatch(fixture, ['--drive', '--state', launch.stateFile], { cwd: repo.dir, results });
      assert.equal(started.status, 0, started.stderr);
      const host = parseAction(started.stdout);
      assert.equal(host.action, 'launch');
      assert.equal(host.argv, undefined, 'the host never sees argv to rebuild');
      assert.deepEqual(host.earlyFallbacks.map(item => item.slot), [launch.earlyFallbacks[0].slot]);
      assert.match(started.stderr, /launch review R1: still running after .*1 early-fallback slot\(s\) failed/);
      assert.match(host.guidance[0], /never run argv/);
      assert.match(host.guidance.join(' '), /run --drive once/);
      // Re-driving the pending launch adopts the running wave instead of spawning another.
      const redriven = runDispatch(fixture, ['--drive', '--state', launch.stateFile], { cwd: repo.dir, results });
      assert.equal(redriven.status, 0, redriven.stderr);
      assert.deepEqual(parseAction(redriven.stdout).earlyFallbacks.map(item => item.slot), [launch.earlyFallbacks[0].slot]);
      const logOf = text => text.match(/; log (.+)$/m)?.[1];
      assert.equal(logOf(redriven.stderr), logOf(started.stderr));
      const [fallback] = host.earlyFallbacks;
      fs.writeFileSync(fallback.outputPath, report());
      const reply = { earlyFallbacks: [{ slot: fallback.slot, outputPath: fallback.outputPath, captured: true, actual: {
        agentType: fallback.descriptor.agentType, model: fallback.descriptor.model, reasoningEffort: fallback.descriptor.reasoningEffort,
      } }] };
      const next = runDispatch(fixture, ['--drive', '--state', launch.stateFile, '--input', JSON.stringify(reply)], { cwd: repo.dir, results });
      assert.equal(next.status, 0, next.stderr);
      const after = parseAction(next.stdout);
      assert.notEqual(after.action, 'launch', `the reply waited for the wave envelope: ${JSON.stringify(after.error ?? after.guidance)}`);
    } finally {
      repo.cleanup();
      fixture.cleanup();
    }
  });
  it('reaps a tracked wave whose envelope is written instead of rerunning it', () => {
    const fixture = createStubDispatchFixture({
      'read-delegates': {
        claude: { targets: [{ low: { model: 'claude-opus-5', effort: 'medium' } }] },
        copilot: { targets: [{ low: { model: 'copilot-a', effort: 'low' } }] },
      },
      phases: { 'plan-review': { rounds: { medium: 1 }, targets: { medium: 2 }, consensus: { medium: false } } },
    });
    const repo = makeGitRepo();
    try {
      const plan = writePlan(repo.dir);
      // The same-platform slot fails at once while the other keeps the wave running.
      const results = { ...allProviders(report()), claude: { exit: 1, failureKind: 'quota', stdout: '' }, copilot: { stdout: report(), delayMs: 4000 } };
      const first = runDispatch(fixture, ['--run', 'review', '--kind', 'plan', '--orchestrator', 'claude', '--', plan], { cwd: repo.dir, results });
      assert.equal(first.status, 0, first.stderr);
      const launch = parseAction(first.stdout);
      assert.equal(launch.earlyFallbacks.length, 1);

      const started = runDispatch(fixture, ['--drive', '--state', launch.stateFile], { cwd: repo.dir, results });
      assert.equal(started.status, 0, started.stderr);
      const host = parseAction(started.stdout);
      assert.equal(host.action, 'launch');
      assert.equal(host.argv, undefined, 'the host never sees argv to rebuild');
      assert.deepEqual(host.earlyFallbacks.map(item => item.slot), [launch.earlyFallbacks[0].slot]);
      const logOf = text => text.match(/; log (.+)$/m)?.[1];
      // Once the wave writes its envelope, a re-drive reaps it rather than rerunning the wave.
      const envelope = launch.argv[launch.argv.indexOf('--output-file') + 1];
      const deadline = Date.now() + 30000;
      const written = () => { try { return Array.isArray(JSON.parse(fs.readFileSync(envelope, 'utf8')).targets); } catch { return false; } };
      while (!written() && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      const reaped = runDispatch(fixture, ['--drive', '--state', launch.stateFile], { cwd: repo.dir, results });
      assert.equal(reaped.status, 0, reaped.stderr);
      assert.match(reaped.stderr, /launch review R1: exit none/);
      assert.equal(logOf(reaped.stderr.split('\n')[0]), logOf(started.stderr));
    } finally {
      repo.cleanup();
      fixture.cleanup();
    }
  });
});

describe('--drive with native-subagents-only launches', () => {
  it('nativeSubagentsOnly all-native launch is handed to the host instead of run', () => {
    const fixture = createStubDispatchFixture({
      'read-delegates': { agy: { nativeSubagentsOnly: true, targets: [{ low: { model: 'native-only-a', effort: 'low' } }] } },
      phases: { 'plan-review': { rounds: { medium: 1 }, targets: { medium: 1 }, consensus: { medium: false } } },
    });
    const repo = makeGitRepo();
    try {
      const plan = writePlan(repo.dir);
      const first = runDispatch(fixture, ['--run', 'review', '--kind', 'plan', '--orchestrator', 'agy', '--', plan], { cwd: repo.dir });
      assert.equal(first.status, 0, first.stderr);
      const launch = parseAction(first.stdout);
      const res = runDispatch(fixture, ['--drive', '--state', launch.stateFile], { cwd: repo.dir });
      assert.equal(res.status, 0, res.stderr);
      const stop = parseAction(res.stdout);
      assert.equal(stop.action, 'launch');
      assert.equal(stop.argv, undefined);
      assert.equal(stop.nativeLaunches.length, 1);
      assert.doesNotMatch(res.stderr, /[dispatch drive] launch/);
    } finally {
      repo.cleanup();
      fixture.cleanup();
    }
  });
});
