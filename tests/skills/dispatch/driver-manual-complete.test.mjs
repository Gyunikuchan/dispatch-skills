// SC5: `manual-complete` is a failure-disposition decision that closes a stuck run on the record.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

import { buildStubDispatchFixture } from './stub-dispatch-fixture.mjs';
import { readLedger } from '../../../skills/dispatch/scripts/ledger.mjs';
import { drive, implementationOutcome, makeGitRepo, PLAN_BODY, writePlan } from './driver-harness.mjs';

const levels = { low: 1, medium: 1, high: 1, xhigh: 1, max: 1 };
const config = {
  'read-delegates': { agy: { model: 'gemini-3.7-flash', effort: 'medium' } },
  'write-subagents': { claude: { model: ['first-model', 'second-model'], effort: 'low' } },
  phases: Object.fromEntries(['plan-review', 'code-review'].map(key => [key, { rounds: levels, targets: levels, consensus: Object.fromEntries(Object.keys(levels).map(level => [level, false])) }])),
};
const cleanup = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

function setup() {
  const fixture = buildStubDispatchFixture(config), repo = makeGitRepo();
  cleanup.push(fixture.cleanup, repo.cleanup);
  fs.mkdirSync(path.join(repo.dir, 'tests'));
  fs.writeFileSync(path.join(repo.dir, 'tests/sample.test.mjs'), "import assert from 'node:assert/strict';\nimport { value } from '../src/app.js';\nassert.equal(value, 1);\n");
  repo.git('add', 'tests'); repo.git('commit', '--no-gpg-sign', '-qm', 'baseline tests');
  const plan = writePlan(repo.dir, undefined, PLAN_BODY.replace('Changes: `src/app.js`', 'Changes: `src/app.js`, `tests/sample.test.mjs`').replace('#### [MODIFY] src/app.js', '#### [MODIFY] tests/sample.test.mjs\n\n- Add regression.\n\n#### [MODIFY] src/app.js'));
  return { fixture, repo, plan };
}

function baseAskUser(action) {
  if (action.question === 'approval') return { answer: { decision: 'approved', governingHash: action.items[0].governingHash, testPaths: ['tests/sample.test.mjs'], reason: 'Approved fixture plan.' } };
  if (action.question === 'opt-in') return { answer: 'none' };
  throw new Error(`Unexpected question ${action.question}`);
}

// Runs the real (unmutated) sample test so a claimed tests-only RED is host-observed as GREEN,
// which the driver fails closed on and opens failure disposition for.
function realVerify(repo, action) {
  return { results: action.commands.map(command => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', 'tests/sample.test.mjs'], { cwd: repo.dir, encoding: 'utf8', env });
    return { command, exit: result.status, evidence: result.stdout, identifiers: result.status ? ['test:sample'] : [], diagnostic: result.stderr, scopeHash: action.scopeHash, mutationEpoch: action.mutationEpoch };
  }) };
}

describe('manual-complete recovery decision (SC5)', () => {
  function stuckRun(fixture, answer) {
    return drive(fixture.fixture, { cwd: fixture.repo.dir, runArgs: ['implement', '--orchestrator', 'claude', '--', fixture.plan], maxSteps: 40, policy: {
      // A claimed tests-only RED that the host observes GREEN opens failure disposition.
      delegateWrite: () => ({ envelope: implementationOutcome({ stage: 'RED_READY', evidence: ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] }) }),
      verify: (action) => realVerify(fixture.repo, action),
      askUser: (action) => action.question === 'failure-disposition' ? { answer } : baseAskUser(action),
    } });
  }

  it('closes a stuck run on the record with ledger-recorded evidence, reviewer, and reason', () => {
    const fixture = setup();
    const result = stuckRun(fixture, {
      decision: 'manual-complete',
      reason: 'Driver cannot converge; closing on manual review.',
      reviewer: 'host-orchestrator',
      redEvidence: 'node --test tests/sample.test.mjs failed with test:sample before the fix.',
      criterionEvidence: [{ criterionId: 'SC1', evidence: 'Inspected src/app.js; value matches the governing outcome.' }],
    });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    const ledger = readLedger(result.done.ledgerPath);
    assert.equal(ledger.status, 'ok', ledger.diagnostic);
    const manual = ledger.events.find(event => event.type === 'manual-complete');
    assert.ok(manual, JSON.stringify(ledger.events.map(event => event.type)));
    assert.equal(manual.data.reviewer, 'host-orchestrator');
    assert.equal(manual.data.reason, 'Driver cannot converge; closing on manual review.');
    assert.deepEqual(manual.data.criterionEvidence.map(item => item.criterionId), ['SC1']);
    assert.match(manual.data.redEvidence, /test:sample/);
    assert.equal(manual.data.fingerprint.commit, fixture.repo.git('rev-parse', 'HEAD').toString().trim());
    assert.equal(ledger.events.at(-1).type, 'run-complete');
    assert.equal(ledger.events.at(-1).data.result, 'complete');
  });

  it('rejects manual-complete without evidence for every criterion', () => {
    const fixture = setup();
    const errors = [];
    const result = drive(fixture.fixture, { cwd: fixture.repo.dir, runArgs: ['implement', '--orchestrator', 'claude', '--', fixture.plan], maxSteps: 40, policy: {
      delegateWrite: () => ({ envelope: implementationOutcome({ stage: 'RED_READY', evidence: ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] }) }),
      verify: (action) => realVerify(fixture.repo, action),
      askUser(action) {
        if (action.question !== 'failure-disposition') return baseAskUser(action);
        if (action.error) { errors.push(action.error); return { answer: { decision: 'keep-for-repair', reason: 'Evidence incomplete.' } }; }
        return { answer: { decision: 'manual-complete', reason: 'Close it.', reviewer: 'host-orchestrator', redEvidence: 'observed', criterionEvidence: [] } };
      },
    } });
    assert.match(errors.join(' '), /missing SC1/);
    assert.equal(result.done.outcome, 'stable-failure');
  });
});
