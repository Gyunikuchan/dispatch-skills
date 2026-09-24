import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { readLedger } from '../../../../skills/dispatch/scripts/ledger/ledger.mjs';
import { validateRedAdmission } from '../../../../skills/dispatch/scripts/driver/verification.mjs';

import { implementationOutcome, runDispatch } from '../../../helpers/driver-harness.mjs';
import { cleanupOrdinaryDriverFixtures, createOrdinaryDriverFixture, driveOrdinaryImplementation, ordinaryDriverPolicy } from '../../../helpers/ordinary-driver-fixture.mjs';

afterEach(cleanupOrdinaryDriverFixtures);

describe('ordinary driver canonical contracts: resume and repair', () => {
  it('reconstructs review, baseline, and implementation phases from canonical artifacts after cache loss', () => {
    for (const phase of ['plan-review', 'baseline', 'implementation', 'code-review']) {
      const fixture = createOrdinaryDriverFixture(); let restarted = false;
      const result = driveOrdinaryImplementation(fixture, {
        onAction(action) {
          if (restarted) return;
          const cached = JSON.parse(fs.readFileSync(action.stateFile, 'utf8'));
          const boundary = phase === 'plan-review' ? cached.ordinary.phase === 'plan-review'
            : phase === 'baseline' ? action.action === 'verify' && action.purpose === 'baseline'
            : phase === 'implementation' ? action.action === 'verify' && action.purpose === 'red'
            : cached.ordinary.phase === 'code-review';
          if (!boundary) return;
          restarted = true;
          fs.rmSync(action.stateFile);
          const reply = runDispatch(fixture.fixture, ['--run', 'implement', '--phases', `from:${phase}`, '--orchestrator', 'claude', '--', fixture.plan], { cwd: fixture.repo.dir });
          assert.equal(reply.status, 0, reply.stderr);
          const resumed = JSON.parse(reply.stdout);
          assert.notEqual(resumed.outcome, 'refused', JSON.stringify(resumed));
          // Continue on the newly reconstructed cache through the same scripted host.
          Object.assign(action, resumed);
        },
      });
      assert.equal(result.done.outcome, 'complete', `${phase}: ${JSON.stringify(result.done)}`);
      const events = readLedger(result.done.ledgerPath).events;
      assert.equal(events.filter(event => event.type === 'approval').length, 1, phase);
      assert.equal(events.filter(event => event.type === 'task-start').length, 1, phase);
    }
  });
  it('keeps inspect-first unterminated after malformed tests-only outcome', () => {
    const fixture = createOrdinaryDriverFixture();
    const result = driveOrdinaryImplementation(fixture, { policy: {
      delegateWrite: () => ({ raw: '{"status":"DONE"}' }),
      askUser: action => action.question === 'implementation-recovery' ? { answer: { raw: '{"status":"DONE"}' } } : action.question === 'failure-disposition'
        ? { answer: { decision: 'inspect-first', reason: 'Inspect incomplete outcome.' } }
        : ordinaryDriverPolicy(fixture.repo).askUser(action),
    } });
    const ledger = readLedger(result.done.ledgerPath);
    assert.equal(ledger.status, 'ok', ledger.diagnostic);
    assert.equal(ledger.events.some(event => event.type === 'run-complete'), false);
    assert.equal(ledger.events.at(-1).data.state, 'open');
    const writes = result.trace.filter(action => action.action === 'delegate-write');
    assert.equal(writes.length, 2);
    assert.equal(writes[1].fields.continuation.kind, 'admission-repair');
    assert.match(writes[1].fields.continuation.defects.join(' '), /schemaVersion|valid tests-only/i);
    assert.equal(writes[1].fields.model, writes[0].fields.model);
    assert.equal(writes[1].fields.effort, writes[0].fields.effort);
    const repairPrompt = JSON.parse(fs.readFileSync(writes[1].fields.promptPath, 'utf8'));
    assert.deepEqual(repairPrompt.manifest.map(item => item.id), ['SC1']);
    assert.deepEqual(repairPrompt.admissionDefects, writes[1].fields.continuation.defects);
    assert.equal(repairPrompt.boundaries.retainExistingTestChanges, true);
    assert.equal(ledger.events.some(event => event.type === 'implementation-attempt'), false);
  });
  it('uses one RED-MATRIX grammar for parsing and criterion counting', () => {
    const state = { ordinary: { redCriteria: [{ id: 'SC1' }], testsOnlyPaths: ['tests/sample.test.mjs'] } };
    assert.deepEqual(validateRedAdmission(state, implementationOutcome({ stage: 'RED_READY', evidence: ['RED-MATRIX SC1| tests/sample.test.mjs | exit 1 test:sample'] })), []);
    assert.deepEqual(validateRedAdmission(state, implementationOutcome({ stage: 'RED_READY', evidence: ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 assertion failed'] })), ['SC1 expected failure lacks stable exit and identifier shape.']);
    assert.deepEqual(validateRedAdmission(state, implementationOutcome({ stage: 'RED_READY', evidence: ['RED-MATRIX SC1 | malformed'] })), ['Malformed RED-MATRIX row: RED-MATRIX SC1 | malformed', 'Exactly one primary RED-MATRIX row required for SC1.']);
    assert.deepEqual(validateRedAdmission(state, implementationOutcome({ stage: 'RED_READY', evidence: ['RED-MATRIX SC1 | N/A | recovery is not applicable to this criterion class'] })), []);
    // A full test name containing spaces is one identifier, not truncated at the first space.
    assert.deepEqual(validateRedAdmission(state, implementationOutcome({ stage: 'RED_READY', evidence: ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:hops A then B'] })), []);
  });
  it('restores a dispatched admission repair from walkthrough evidence without relaunching it', () => {
    const fixture = createOrdinaryDriverFixture(); let writes = 0, restarted = false, recoveries = 0;
    const base = ordinaryDriverPolicy(fixture.repo);
    const result = driveOrdinaryImplementation(fixture, {
      restartWhen: action => action.action === 'delegate-write' && action.fields.continuation?.kind === 'admission-repair' && !restarted && (restarted = true),
      policy: {
        delegateWrite(action) {
          if (action.fields.stage === 'production') return base.delegateWrite(action);
          writes++;
          fs.writeFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), "import assert from 'node:assert/strict';\nassert.equal(1, 2);\n");
          return { raw: '{"status":"DONE"}' };
        },
        askUser(action) {
          // The first recovery is the schema re-relay of genuine writer junk; the post-restart one restores the repair.
          if (action.question === 'implementation-recovery') return { answer: { raw: ++recoveries === 1 ? '{"status":"DONE"}' : JSON.stringify(implementationOutcome({ stage: 'RED_READY', evidence: ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] })) } };
          return base.askUser(action);
        },
      },
    });
    assert.equal(result.trace.some(action => action.action === 'ask-user' && action.question === 'implementation-recovery'), true);
    assert.equal(writes, 1);
    assert.equal(result.restarts, 1);
  });
  it('repairs a missing RED criterion without charging another attempt', () => {
    const fixture = createOrdinaryDriverFixture(); let calls = 0;
    const source = fs.readFileSync(fixture.plan, 'utf8').replace('## Proposed Changes', '- [SC2] Preserve the same RED observable.\n  - Changes: `src/app.js`, `tests/sample.test.mjs`\n  - Verify: `node --test tests/sample.test.mjs`\n  - Evidence: red\n  - Test rationale: A second mapped acceptance condition requires explicit matrix coverage.\n\n## Proposed Changes');
    fs.writeFileSync(fixture.plan, source);
    const base = ordinaryDriverPolicy(fixture.repo);
    const result = driveOrdinaryImplementation(fixture, { policy: { delegateWrite(action) {
      if (action.fields.stage === 'production') {
        fs.writeFileSync(path.join(fixture.repo.dir, 'src/app.js'), 'export const value = 2;\n');
        fs.writeFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), "import assert from 'node:assert/strict';\nimport { value } from '../src/app.js';\nassert.equal(value, 2);\n");
        return { raw: JSON.stringify(implementationOutcome({ evidence: ['CRITERION SC1 | delivered value=2 | src/app.js', 'CRITERION SC2 | delivered value=2 | src/app.js'] })) };
      }
      calls++; fs.writeFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), "import assert from 'node:assert/strict';\nassert.equal(1, 2);\n");
      return { raw: JSON.stringify(implementationOutcome({ stage: 'RED_READY', evidence: calls === 1 ? ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] : ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample', 'RED-MATRIX SC2 | tests/sample.test.mjs | exit 1 test:sample'] })) };
    } } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    const writes = result.trace.filter(action => action.action === 'delegate-write');
    assert.equal(writes[1].fields.continuation.kind, 'admission-repair');
    assert.deepEqual(writes[1].fields.continuation.defects, ['Exactly one primary RED-MATRIX row required for SC2.']);
    const ledger = readLedger(result.done.ledgerPath);
    assert.equal(ledger.events.filter(event => event.type === 'implementation-attempt' && event.data.launch === 'tests-only').length, 1);
    const evidence = JSON.parse(fs.readFileSync(result.done.handoff.destinations.find(file => file.endsWith('-walkthrough.md')), 'utf8').match(/## Ordinary execution evidence\n```json\n(.+)\n```/s)[1]);
    assert.equal(evidence.ordinary.testsOnlyAttempts, 2);
    assert.equal(evidence.ordinary.testsOnlyAdmitted, true);
  });
});
