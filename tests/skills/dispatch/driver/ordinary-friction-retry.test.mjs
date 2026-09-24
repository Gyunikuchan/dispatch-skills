import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { readLedger } from '../../../../skills/dispatch/scripts/ledger/ledger.mjs';

import { allProviders, implementationOutcome, report } from '../../../helpers/driver-harness.mjs';
import { cleanupOrdinaryDriverFixtures, createOrdinaryDriverFixture, driveOrdinaryImplementation, ordinaryDriverPolicy } from '../../../helpers/ordinary-driver-fixture.mjs';

afterEach(cleanupOrdinaryDriverFixtures);

describe('ordinary driver friction relief: retries', () => {
  const rulings = ledger => ledger.events.filter(event => event.type === 'ruling').map(event => [event.data.key, event.data.decision]);
  const stray = (fixture, file) => action => {
    if (action.fields.stage === 'production') fs.writeFileSync(path.join(fixture.repo.dir, file), 'stray\n');
    return ordinaryDriverPolicy(fixture.repo).delegateWrite(action);
  };
  it('retries in-segment after a failure, carrying the ruling to the next writer', () => {
    const fixture = createOrdinaryDriverFixture(); let testsOnlyWrites = 0;
    const base = ordinaryDriverPolicy(fixture.repo);
    const result = driveOrdinaryImplementation(fixture, { policy: {
      // The first tests-only write claims RED without changing the test, so the host observes GREEN.
      delegateWrite(action) {
        if (action.fields.stage === 'tests-only' && ++testsOnlyWrites === 1) return { raw: JSON.stringify(implementationOutcome({ stage: 'RED_READY', evidence: ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] })) };
        return base.delegateWrite(action);
      },
      askUser(action) {
        if (action.question === 'failure-disposition') {
          assert.match(action.text, /"retry"/);
          return { answer: { decision: 'retry', reason: 'The test was never changed.', context: 'Write the failing value=2 assertion.' } };
        }
        return base.askUser(action);
      },
    } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    const writes = result.trace.filter(action => action.action === 'delegate-write');
    assert.deepEqual(writes.map(action => action.fields.stage), ['tests-only', 'tests-only', 'production']);
    assert.match(writes[1].fields.continuation.defects[0], /Retry after failure: .*Ruling: Write the failing value=2 assertion\./);
    const ledger = readLedger(result.done.ledgerPath);
    assert.equal(ledger.events.filter(event => event.type === 'run-start').length, 1, 'retry continues the same segment');
    assert.deepEqual(ledger.events.filter(event => event.type === 'ruling').map(event => [event.data.key, event.data.decision]).at(-1), ['failure-disposition', 'retry']);
  });
  it('refuses re-verify for a failure that host evidence did not raise', () => {
    const fixture = createOrdinaryDriverFixture(); let error = null, offered = null;
    const base = ordinaryDriverPolicy(fixture.repo);
    driveOrdinaryImplementation(fixture, { allowErrors: true, policy: {
      askUser(action) {
        if (action.question === 'write-scope') return { answer: { decision: 'stop', reason: 'Unexpected edit.' } };
        if (action.question !== 'failure-disposition') return base.askUser(action);
        offered ??= action.text;
        if (action.error) { error = action.error; return base.askUser(action); }
        return { answer: { decision: 're-verify', reason: 'Try again.' } };
      },
      delegateWrite: stray(fixture, 'stray.md'),
    } });
    assert.doesNotMatch(offered, /"re-verify"/);
    assert.match(error, /re-verify applies only/);
  });
  it('goes from validated RED straight to the production write at high, with no test-review wave', () => {
    const fixture = createOrdinaryDriverFixture(); let waves = 0, testsWritten = false, productionWritten = false;
    const base = ordinaryDriverPolicy(fixture.repo);
    const result = driveOrdinaryImplementation(fixture, { runArgs: ['implement', '--level', 'high', '--orchestrator', 'claude', '--', fixture.plan], policy: {
      delegateWrite(action) {
        testsWritten ||= action.fields.stage === 'tests-only';
        productionWritten ||= action.fields.stage === 'production';
        return base.delegateWrite(action);
      },
      waveResults: () => { if (testsWritten && !productionWritten) waves++; return allProviders(report()); },
    } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.equal(waves, 0);
    assert.deepEqual(result.trace.filter(action => action.action === 'delegate-write').map(action => action.fields.stage), ['tests-only', 'production']);
  });
});

describe('driver-run verification', () => {
  it('runs every gate and plan generator on the driver, logs to the session, and extracts real failure identities', () => {
    const fixture = createOrdinaryDriverFixture();
    fs.writeFileSync(path.join(fixture.repo.dir, 'gen.mjs'), "import fs from 'node:fs';\nfs.writeFileSync('gen.txt', 'generated');\n");
    fixture.repo.git('add', 'gen.mjs'); fixture.repo.git('commit', '--no-gpg-sign', '-qm', 'generator');
    fs.writeFileSync(fixture.plan, fs.readFileSync(fixture.plan, 'utf8').replace('## Verification Plan', '#### [GENERATED] gen.txt\n\n- Command: `node gen.mjs`\n\n## Verification Plan'));
    const base = ordinaryDriverPolicy(fixture.repo);
    const verifies = [];
    const result = driveOrdinaryImplementation(fixture, { onAction(action) { if (action.action === 'verify') verifies.push(action); }, policy: {
      realVerify: true,
      delegateWrite(action) {
        const testsOnly = action.fields.stage === 'tests-only';
        if (testsOnly) fs.writeFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { value } from '../src/app.js';\ntest('sample', () => { assert.equal(value, 2); });\n");
        else fs.writeFileSync(path.join(fixture.repo.dir, 'src/app.js'), 'export const value = 2;\n');
        return { raw: JSON.stringify(implementationOutcome({ stage: testsOnly ? 'RED_READY' : 'COMPLETE', evidence: testsOnly ? ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] : ['CRITERION SC1 | delivered value=2 | src/app.js'] })) };
      },
      verify: () => undefined,
      askUser: base.askUser,
    } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.deepEqual(verifies.map(action => action.purpose), ['baseline', 'red', 'completion']);
    for (const action of verifies) {
      assert.deepEqual(action.argv.slice(-3, -1), ['--verify', '--state']);
      const record = JSON.parse(fs.readFileSync(action.resultsPath, 'utf8'));
      assert.equal(record.purpose, action.purpose);
      for (const item of record.results) assert.ok(fs.existsSync(item.logPath) && /[\\/]sessions[\\/]/.test(item.logPath), item.logPath);
    }
    const completion = JSON.parse(fs.readFileSync(verifies[2].resultsPath, 'utf8'));
    assert.deepEqual(completion.generated.map(item => [item.exit, item.changed, item.outside]), [[0, ['gen.txt'], []]]);
    assert.equal(fs.readFileSync(path.join(fixture.repo.dir, 'gen.txt'), 'utf8'), 'generated');
    const red = JSON.parse(fs.readFileSync(verifies[1].resultsPath, 'utf8')).results[0];
    assert.equal(red.exit, 1);
    assert.deepEqual(red.identifiers, ['test:sample']);
    const ledger = readLedger(result.done.ledgerPath);
    assert.deepEqual(ledger.events.find(event => event.type === 'verification' && event.data.result === 'red').data.failureIdentity.identifiers, ['test:sample']);
  });
});
