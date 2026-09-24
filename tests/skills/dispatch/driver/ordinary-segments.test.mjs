import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { readLedger } from '../../../../skills/dispatch/scripts/ledger/ledger.mjs';
import { validateRedAdmission } from '../../../../skills/dispatch/scripts/driver/verification.mjs';

import { allProviders, codeFinding, implementationOutcome, report, runDispatch } from '../../../helpers/driver-harness.mjs';
import { policies, run, runCleanup, setup } from '../../../helpers/ordinary-driver.mjs';

afterEach(runCleanup);

describe('ordinary driver canonical contracts: segment relaunch and termination', () => {
  it('rolls back the plan round and walkthrough stub when a reply throws after adjudication', () => {
    const fixture = setup(); let planWaves = 0, errored = null;
    // An approved path that is a directory makes baseline fingerprinting throw after the round is written.
    fs.rmSync(path.join(fixture.repo.dir, 'src/app.js'));
    fs.mkdirSync(path.join(fixture.repo.dir, 'src/app.js'));
    const finding = codeFinding({ locus: '§ Verification Plan', defect: 'Plan omits a negative case.' });
    const before = fs.readFileSync(fixture.plan, 'utf8');
    const walkthrough = fixture.plan.replace(/.md$/, '-walkthrough.md');
    try {
      run(fixture, { allowErrors: true, maxSteps: 40,
      onAction(action) { if (action.error && !errored) { errored = action; throw new Error('stop'); } },
      policy: {
        waveResults: () => allProviders(report(++planWaves === 1 ? [finding] : [])),
        // A rejected ruling still writes the round without needing fix paths.
        rule: () => ({ status: 'rejected', resolution: 'Plan already names the negative case.' }),
      } });
    } catch (error) { if (error.message !== 'stop') throw error; }
    assert.ok(errored, 'the adjudicate reply must fail');
    assert.equal(fs.readFileSync(fixture.plan, 'utf8'), before);
    assert.equal(fs.existsSync(walkthrough), false);
  });
  it('asks once for a verbatim envelope when the relay fails its schema, without spending a launch', () => {
    const fixture = setup(); let relays = 0;
    const base = policies(fixture.repo);
    const valid = JSON.stringify(implementationOutcome({ stage: 'RED_READY', evidence: ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] }));
    const result = run(fixture, { policy: {
      askUser(action) {
        if (action.question === 'implementation-recovery') { relays++; return { answer: { raw: valid } }; }
        return base.askUser(action);
      },
      delegateWrite(action) {
        const reply = base.delegateWrite(action);
        if (action.fields.stage !== 'tests-only') return reply;
        const envelope = JSON.parse(reply.raw);
        return { raw: JSON.stringify({ ...envelope, evidence: envelope.evidence[0] }) };
      },
    } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.equal(relays, 1);
    assert.deepEqual(result.trace.filter(action => action.action === 'delegate-write').map(action => action.fields.stage), ['tests-only', 'production']);
  });
  it('relaunches tests-only once when a RED test file fails to load, then continues production from attempt 2', () => {
    const fixture = setup(); let calls = 0;
    const base = policies(fixture.repo);
    const result = run(fixture, { policy: {
      delegateWrite(action) {
        if (action.fields.stage === 'production') return base.delegateWrite(action);
        calls++;
        // First launch imports a not-yet-existing export, so the file crashes before any leaf test runs.
        fs.writeFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), calls === 1
          ? "import assert from 'node:assert/strict';\nimport { missing } from '../src/app.js';\nassert.equal(missing, 2);\n"
          : "import assert from 'node:assert/strict';\nimport { value } from '../src/app.js';\nassert.equal(value, 2);\n");
        return { raw: JSON.stringify(implementationOutcome({ stage: 'RED_READY', evidence: ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] })) };
      },
      verify(action) {
        const reply = base.verify(action);
        if (fs.readFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), 'utf8').includes('missing')) for (const item of reply.results) item.identifiers = ['error:load tests/sample.test.mjs'];
        return reply;
      },
    } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    const writes = result.trace.filter(action => action.action === 'delegate-write');
    assert.equal(writes[1].fields.continuation.kind, 'admission-repair');
    assert.match(writes[1].fields.continuation.defects[0], /failed to load/);
    const attempts = readLedger(result.done.ledgerPath).events.filter(event => event.type === 'implementation-attempt');
    assert.deepEqual(attempts.map(event => [event.data.launch, event.data.attempt]), [['tests-only', 1], ['tests-only', 2], ['continuation', 2]]);
  });
  it('admits a declared pre-existing RED test whose identity matches baseline instead of a collision defect (SC4)', () => {
    const fixture = setup();
    // The baseline sample test already fails (asserts value=2 against src value=1); SC1 declares
    // this pre-existing so the matching tests-only RED is admitted instead of raising a collision.
    fs.writeFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), "import assert from 'node:assert/strict';\nimport { value } from '../src/app.js';\nassert.equal(value, 2);\n");
    fixture.repo.git('add', 'tests'); fixture.repo.git('commit', '--no-gpg-sign', '-qm', 'pre-existing red baseline');
    fs.writeFileSync(fixture.plan, fs.readFileSync(fixture.plan, 'utf8')
      .replace('  - Test rationale: Behavioral failure isolates the sample outcome and protects its regression.',
        '  - Test rationale: Behavioral failure isolates the sample outcome and protects its regression.\n  - Pre-existing: yes'));
    const base = policies(fixture.repo);
    const result = run(fixture, { allowErrors: true, policy: {
      askUser(action) {
        if (action.question === 'baseline-red') return { answer: { decision: 'accept', reason: 'Pre-existing failure declared in the plan.' } };
        return base.askUser(action);
      },
      delegateWrite(action) {
        const testsOnly = action.fields.stage === 'tests-only';
        if (!testsOnly) return base.delegateWrite(action);
        // The tests-only mutation leaves the same failing assertion in place: same command, same
        // host-observed identity as the pre-existing baseline failure.
        return { raw: JSON.stringify(implementationOutcome({ stage: 'RED_READY', evidence: ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] })) };
      },
    } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    const ledger = readLedger(result.done.ledgerPath);
    assert.equal(ledger.status, 'ok', ledger.diagnostic);
    assert.equal(ledger.events.some(event => event.type === 'verification' && /collision/i.test(JSON.stringify(event.data))), false,
      'a declared pre-existing RED matching baseline must not raise a Known-red baseline collision');
  });

  it('resumes an inspect-first segment on a fresh --run instead of throwing Task already dispatched (SC4)', () => {
    const fixture = setup();
    const base = policies(fixture.repo);
    const result = run(fixture, { policy: {
      delegateWrite: () => ({ raw: '{"status":"DONE"}' }),
      askUser: action => action.question === 'implementation-recovery' ? { answer: { raw: '{"status":"DONE"}' } } : action.question === 'failure-disposition'
        ? { answer: { decision: 'inspect-first', reason: 'Inspect incomplete outcome.' } }
        : base.askUser(action),
    } });
    const ledger = readLedger(result.done.ledgerPath);
    assert.equal(ledger.events.some(event => event.type === 'run-complete'), false, 'inspect-first must leave the segment open, not terminal');
    // A brand-new `--run` on the same governing plan must resume the open inspect-first segment
    // instead of throwing "Task already dispatched; reconstruct its canonical outcome instead of relaunching."
    const resumed = runDispatch(fixture.fixture, ['--run', 'implement', '--orchestrator', 'claude', '--', fixture.plan], { cwd: fixture.repo.dir });
    assert.equal(resumed.status, 0, resumed.stderr);
    const parsed = JSON.parse(resumed.stdout);
    assert.notEqual(parsed.outcome, 'refused', JSON.stringify(parsed));
    assert.doesNotMatch(resumed.stderr + JSON.stringify(parsed), /Task already dispatched/);
  });

  it('production guidance names CRITERION rows; judged verify guidance names the inspectedRevision rule (SC4)', () => {
    const fixture = setup();
    fs.writeFileSync(fixture.plan, fs.readFileSync(fixture.plan, 'utf8').replace('Evidence: red', 'Evidence: verify')
      .replace('Behavioral failure isolates the sample outcome and protects its regression.', 'A retained pre-change test would add no signal beyond the mapped deterministic check.'));
    let production, completion;
    const base = policies(fixture.repo);
    const result = run(fixture, {
      onAction(action) { if (action.action === 'delegate-write' && action.fields.stage === 'production') production = action; if (action.action === 'verify' && action.purpose === 'completion') completion ??= action; },
      policy: {
        delegateWrite(action) {
          fs.writeFileSync(path.join(fixture.repo.dir, 'src/app.js'), 'export const value = 2;\n');
          fs.writeFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), "import assert from 'node:assert/strict';\nimport { value } from '../src/app.js';\nassert.equal(value, 2);\n");
          return { raw: JSON.stringify(implementationOutcome({ evidence: ['CRITERION SC1 | delivered value=2 | src/app.js'] })) };
        },
        askUser(action) { return action.question === 'approval' ? { answer: { decision: 'approved', governingHash: action.items[0].governingHash, testPaths: [], reason: 'Approve verify-only fixture.' } } : base.askUser(action); },
        verify(action) {
          const reply = base.verify(action);
          if (action.purpose === 'completion') reply.results[0].criterionEvidence = [{ criterionId: 'SC1', evidenceClass: 'verify', reviewer: 'host', scenario: 'execute mapped sample check', inspectedRevision: action.scopeHash, observableResult: 'value=2 observed', limitations: 'covers mapped sample only', mutationEpoch: action.mutationEpoch }];
          return reply;
        },
      },
    });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.match(production.guidance.join(' '), /CRITERION\s+SC#\s*\|/, 'guidance must name the CRITERION SC# | <paths> | <behavior> envelope row format');
    const guidance = completion.guidance.join(' ');
    assert.match(guidance, /inspectedRevision/, 'guidance must name the inspectedRevision field');
    assert.match(guidance, /scopeHash/, 'guidance must state that inspectedRevision equals the summary scopeHash');
  });

  it('rejects a RED-MATRIX row whose test identifier contains a semicolon at admission (SC4)', () => {
    const state = { ordinary: { redCriteria: [{ id: 'SC1' }], testsOnlyPaths: ['tests/sample.test.mjs'] } };
    const defects = validateRedAdmission(state, implementationOutcome({
      stage: 'RED_READY',
      evidence: ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:hops A; then B'],
    }));
    assert.ok(defects.some(defect => /;/.test(defect) || /naming|semicolon/i.test(defect)),
      `expected a naming diagnostic for a \`;\`-bearing test name; got ${JSON.stringify(defects)}`);
  });

  it('blockedWrite appends a terminal run-complete ledger event before done (SC4)', () => {
    const fixture = setup();
    const result = run(fixture, { allowErrors: true, policy: {
      delegateWrite: () => ({ rejected: true, reason: 'Model permanently unavailable.' }),
    } });
    assert.equal(result.done.outcome, 'failed', JSON.stringify(result.done));
    const ledger = readLedger(result.done.ledgerPath);
    assert.equal(ledger.status, 'ok', ledger.diagnostic);
    const complete = ledger.events.find(event => event.type === 'run-complete');
    assert.ok(complete, `expected a terminal run-complete ledger event; got types ${JSON.stringify(ledger.events.map(e => e.type))}`);
    assert.equal(complete.data.result, 'stable-failure');
    assert.ok(Array.isArray(complete.data.evidenceRefs) && complete.data.evidenceRefs.length > 0,
      'run-complete must carry an evidenceRefs array naming the walkthrough');
  });

  it('fails closed for green tests-only verification and resolves failure before stable-failure', () => {
    const fixture = setup();
    const result = run(fixture, { policy: { delegateWrite: () => ({ envelope: implementationOutcome({ stage: 'RED_READY', evidence: ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] }) }) } });
    assert.equal(result.done.outcome, 'stable-failure');
    const ledger = readLedger(result.done.ledgerPath);
    assert.equal(ledger.status, 'ok', ledger.diagnostic);
    assert.equal(ledger.events.at(-2).data.key, 'failure-disposition');
    assert.equal(ledger.events.at(-2).data.state, 'resolved');
    assert.equal(result.trace.filter(action => action.action === 'delegate-write').length, 1);
  });
});
