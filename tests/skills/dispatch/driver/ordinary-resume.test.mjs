import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readLedger } from '../../../../skills/dispatch/scripts/ledger/ledger.mjs';
import { validateRedAdmission } from '../../../../skills/dispatch/scripts/driver/verification.mjs';
import { bindSession, bindWorkflowSession, SESSION_ENV, RUN_ENV } from '../../../../skills/dispatch/scripts/lib/session-temp.mjs';

import { implementationOutcome, runDispatch, writeEnvelopeFile, writeOutcomeReply, readFixtureState } from '../../../helpers/driver-harness.mjs';
import { cleanupOrdinaryDriverFixtures, createOrdinaryDriverFixture, driveOrdinaryImplementation, ordinaryDriverPolicy, withCriterionEvidence } from '../../../helpers/ordinary-driver-fixture.mjs';

let savedSessionEnv;
let savedTempEnv;
let shortTempRoot;
beforeEach(() => {
  const keys = ['DISPATCH_SESSION_DIR', 'DISPATCH_RUN_ID', 'DISPATCH_CHAT_ID'];
  savedSessionEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  const tempKeys = ['TMPDIR', 'TEMP', 'TMP'];
  savedTempEnv = Object.fromEntries(tempKeys.map(key => [key, process.env[key]]));
  shortTempRoot = fs.mkdtempSync(path.join(os.homedir(), '.d-'));
  for (const key of tempKeys) process.env[key] = shortTempRoot;
});
afterEach(() => {
  cleanupOrdinaryDriverFixtures();
  if (shortTempRoot) fs.rmSync(shortTempRoot, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedSessionEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const [key, value] of Object.entries(savedTempEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function createFixture(options) {
  const fixture = createOrdinaryDriverFixture(options);
  process.env[SESSION_ENV] = fixture.repo.sessionDir;
  delete process.env[RUN_ENV];
  process.env.DISPATCH_CHAT_ID = fixture.repo.sessionId;
  bindWorkflowSession({ repositoryRoot: fixture.repo.dir, artifactKind: 'plan', slug: 'sample', objective: 'Ordinary resume fixture' });
  return fixture;
}

function reactivateDone(done) {
  const published = done.handoff.destinations[0];
  delete process.env[SESSION_ENV];
  delete process.env[RUN_ENV];
  const active = bindSession(published);
  const ledgerRelative = path.relative(published, done.ledgerPath);
  return { active, ledgerPath: path.join(active, ledgerRelative) };
}

describe('ordinary driver canonical contracts: resume and repair', () => {
  it('reconstructs review, baseline, and implementation phases from canonical artifacts after cache loss', () => {
    for (const phase of ['plan-review', 'baseline', 'implementation', 'code-review']) {
      const fixture = createFixture(); let restarted = false;
      let codeBudgetAtRestart = null;
      const result = driveOrdinaryImplementation(fixture, {
        onAction(action) {
          if (restarted) return;
          const cached = readFixtureState(action.stateFile);
          const boundary = phase === 'plan-review' ? cached.ordinary.phase === 'plan-review'
            : phase === 'baseline' ? action.action === 'verify' && action.purpose === 'baseline'
            : phase === 'implementation' ? action.action === 'verify' && action.purpose === 'red'
            : cached.ordinary.phase === 'code-review';
          if (!boundary) return;
          if (phase === 'code-review') {
            codeBudgetAtRestart = cached.reviewBudgets?.['code-review'];
            assert.ok(codeBudgetAtRestart?.budgetId, 'code-review has a parent-owned phase identity');
            assert.ok(codeBudgetAtRestart.reviewWaves >= 1, 'the first launched wave is carried to the parent');
          }
          restarted = true;
          fs.rmSync(action.stateFile);
          const reply = runDispatch(fixture.fixture, ['--run', 'implement', '--phases', `from:${phase}`, '--orchestrator', 'claude', '--', fixture.plan], { cwd: fixture.repo.dir });
          assert.equal(reply.status, 0, reply.stderr);
          const resumed = JSON.parse(reply.stdout);
          assert.notEqual(resumed.outcome, 'refused', JSON.stringify(resumed));
          if (phase === 'code-review') {
            const recovered = readFixtureState(resumed.stateFile).reviewBudgets?.['code-review'];
            assert.equal(recovered?.budgetId, codeBudgetAtRestart.budgetId, 'recovery uses the same code-review identity');
            assert.ok(recovered.reviewWaves >= codeBudgetAtRestart.reviewWaves, 'recovery never lowers consumed waves');
            assert.ok(recovered.roundLimit >= codeBudgetAtRestart.roundLimit, 'recovery never lowers the approved cap');
          }
          // Continue on the newly reconstructed cache through the same scripted host.
          Object.assign(action, resumed);
        },
      });
      assert.equal(result.done.outcome, 'complete', `${phase}: ${JSON.stringify(result.done)}`);
      const active = reactivateDone(result.done);
      const events = readLedger(active.ledgerPath).events;
      assert.equal(events.filter(event => event.type === 'approval').length, 1, phase);
      assert.equal(events.filter(event => event.type === 'task-start').length, 1, phase);
    }
  });
  it('resumes at code review after only scoped gates, deferring [FINAL] evidence to the final gate', () => {
    const fixture = createFixture({ finalCommand: true }); let restarted = false;
    const base = ordinaryDriverPolicy(fixture.repo);
    const result = driveOrdinaryImplementation(fixture, {
      policy: {
        delegateWrite(action) {
          if (action.fields.stage === 'tests-only') return base.delegateWrite(action);
          fs.writeFileSync(path.join(fixture.repo.dir, 'src/app.js'), 'export const value = 2;\n');
          return writeOutcomeReply(action, implementationOutcome({ evidence: ['CRITERION SC1 | src/app.js | delivered value=2', 'CRITERION SC2 | src/app.js | delivered value=2'] }));
        },
        verify: withCriterionEvidence(action => ({ results: base.verify(action).results.map(({ scopeHash, ...item }) => item) })),
      },
      onAction(action) {
        if (restarted || readFixtureState(action.stateFile).ordinary?.phase !== 'code-review') return;
        restarted = true;
        fs.rmSync(action.stateFile);
        const reply = runDispatch(fixture.fixture, ['--run', 'implement', '--phases', 'from:code-review', '--orchestrator', 'claude', '--', fixture.plan], { cwd: fixture.repo.dir });
        assert.equal(reply.status, 0, reply.stderr);
        const resumed = JSON.parse(reply.stdout);
        assert.notEqual(resumed.outcome, 'refused', JSON.stringify(resumed));
        Object.assign(action, resumed);
      },
    });
    assert.ok(restarted);
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.equal(result.trace.filter(action => action.action === 'verify').at(-1).purpose, 'final');
  });
  it('keeps inspect-first unterminated after malformed tests-only RED evidence', () => {
    const fixture = createFixture();
    const result = driveOrdinaryImplementation(fixture, { policy: {
      delegateWrite: action => writeOutcomeReply(action, implementationOutcome({ stage: 'RED_READY', evidence: ['malformed RED evidence'] })),
      askUser: action => action.question === 'failure-disposition'
        ? { answer: { decision: 'inspect-first', reason: 'Inspect incomplete outcome.' } }
        : ordinaryDriverPolicy(fixture.repo).askUser(action),
    } });
    const active = reactivateDone(result.done);
    const ledger = readLedger(active.ledgerPath);
    assert.equal(ledger.status, 'ok', ledger.diagnostic);
    assert.equal(ledger.events.some(event => event.type === 'run-complete'), false);
    assert.equal(ledger.events.at(-1).data.state, 'open');
    const writes = result.trace.filter(action => action.action === 'delegate-write');
    assert.equal(writes.length, 2);
    assert.equal(writes[1].fields.continuation.kind, 'admission-repair');
    assert.match(writes[1].fields.continuation.defects.join(' '), /RED-MATRIX/i);
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
    const fixture = createFixture(); let writes = 0, restarted = false, recoveries = 0;
    const base = ordinaryDriverPolicy(fixture.repo);
    const result = driveOrdinaryImplementation(fixture, {
      restartWhen: action => action.action === 'delegate-write' && action.fields.continuation?.kind === 'admission-repair' && !restarted && (restarted = true),
      policy: {
        delegateWrite(action) {
          if (action.fields.stage === 'production') return base.delegateWrite(action);
          writes++;
          fs.writeFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), "import assert from 'node:assert/strict';\nassert.equal(1, 2);\n");
          return writeOutcomeReply(action, implementationOutcome({ stage: 'RED_READY', evidence: ['invalid RED row'] }));
        },
        askUser(action) {
          // The resumed host writes the repair envelope at the pending action's exact path.
          if (action.question === 'implementation-recovery') {
            recoveries++;
            return { answer: writeEnvelopeFile(action.items[0].expectedEnvelopePath, implementationOutcome({ stage: 'RED_READY', evidence: ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] })) };
          }
          return base.askUser(action);
        },
      },
    });
    assert.equal(result.trace.some(action => action.action === 'ask-user' && action.question === 'implementation-recovery'), true);
    assert.equal(writes, 1);
    assert.equal(result.restarts, 1);
  });
  it('repairs a missing RED criterion without charging another attempt', () => {
    const fixture = createFixture(); let calls = 0;
    const source = fs.readFileSync(fixture.plan, 'utf8').replace('## Proposed Changes', '- [SC2] Preserve the same RED observable.\n  - Changes: `src/app.js`, `tests/sample.test.mjs`\n  - Verify: `node --test tests/sample.test.mjs`\n  - Evidence: red\n  - Test rationale: A second mapped acceptance condition requires explicit matrix coverage.\n\n## Proposed Changes');
    fs.writeFileSync(fixture.plan, source);
    const base = ordinaryDriverPolicy(fixture.repo);
    const result = driveOrdinaryImplementation(fixture, { policy: { delegateWrite(action) {
      if (action.fields.stage === 'production') {
        fs.writeFileSync(path.join(fixture.repo.dir, 'src/app.js'), 'export const value = 2;\n');
        fs.writeFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), "import assert from 'node:assert/strict';\nimport { value } from '../src/app.js';\nassert.equal(value, 2);\n");
        return writeOutcomeReply(action, implementationOutcome({ evidence: ['CRITERION SC1 | src/app.js | delivered value=2', 'CRITERION SC2 | src/app.js | delivered value=2'] }));
      }
      calls++; fs.writeFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), "import assert from 'node:assert/strict';\nassert.equal(1, 2);\n");
      return writeOutcomeReply(action, implementationOutcome({ stage: 'RED_READY', evidence: calls === 1 ? ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] : ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample', 'RED-MATRIX SC2 | tests/sample.test.mjs | exit 1 test:sample'] }));
    } } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    const writes = result.trace.filter(action => action.action === 'delegate-write');
    assert.equal(writes[1].fields.continuation.kind, 'admission-repair');
    assert.deepEqual(writes[1].fields.continuation.defects, ['Exactly one primary RED-MATRIX row required for SC2.']);
    const active = reactivateDone(result.done);
    const ledger = readLedger(active.ledgerPath);
    assert.equal(ledger.events.filter(event => event.type === 'implementation-attempt' && event.data.launch === 'tests-only').length, 1);
    const walkthroughPath = path.join(active.active, 'artifacts', `${path.basename(fixture.plan, '.md')}-walkthrough.md`);
    const evidence = JSON.parse(fs.readFileSync(walkthroughPath, 'utf8').match(/## Ordinary execution evidence\n```json\n(.+)\n```/s)[1]);
    assert.equal(evidence.ordinary.testsOnlyAttempts, 2);
    assert.equal(evidence.ordinary.testsOnlyAdmitted, true);
  });
});
