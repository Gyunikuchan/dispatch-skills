import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { readLedger } from '../../../../skills/dispatch/scripts/ledger/ledger.mjs';

import { drive, runDispatch, readFixtureState } from '../../../helpers/driver-harness.mjs';
import { cleanupOrdinaryDriverFixtures, createOrdinaryDriverFixture, driveOrdinaryImplementation, ordinaryDriverPolicy } from '../../../helpers/ordinary-driver-fixture.mjs';

afterEach(cleanupOrdinaryDriverFixtures);

// SECTION: Resume by bound plan path (SC1, SC2)

const ASK = 'add a sample behavior';

/** Splits a resume command into argv after `node <script>`, decoding JSON-quoted tokens. */
function resumeArgs(command) {
  const tokens = command.match(/"(?:[^"\\]|\\.)*"|\S+/g).map(token => (token.startsWith('"') ? JSON.parse(token) : token));
  return tokens.slice(2);
}

/** Author policy: writes the fixture plan body once; later replies name the existing plan unchanged. */
function authorFrom(fixture) {
  const body = fs.readFileSync(fixture.plan, 'utf8');
  return (action) => { if (!fs.existsSync(action.path)) fs.writeFileSync(action.path, body); return { path: action.path }; };
}

/**
 * Answers the restored write-pending recovery question: the interrupted write completes on the host and
 * its captured envelope is relayed, because the driver never re-emits a pending write.
 */
function recoverWrite(fixture) {
  const base = ordinaryDriverPolicy(fixture.repo);
  return (action) => {
    if (action.question !== 'implementation-recovery') return base.askUser(action);
    const stage = action.items[0].paths.includes('src/app.js') ? 'production' : 'tests-only';
    return { answer: base.delegateWrite({ fields: { stage, expectedEnvelopePath: action.items[0].expectedEnvelopePath } }) };
  };
}

const relativePlan = (repoDir, action) => path.relative(repoDir, action.path).split(path.sep).join('/');
const planReviewLaunches = trace => trace.filter(action => action.action === 'launch');

describe('ordinary driver: resume by bound plan path', () => {
  it('SC1: the resume command names the bound plan path and resumes without plan review', () => {
    const fixture = createOrdinaryDriverFixture(); let planRel = null, resumedFirst = null;
    const result = driveOrdinaryImplementation({ ...fixture, plan: ASK }, {
      policy: { author: action => { planRel = relativePlan(fixture.repo.dir, action); return authorFrom(fixture)(action); }, askUser: recoverWrite(fixture) },
      onAction(action) {
        if (resumedFirst || action.action !== 'delegate-write' || action.fields.stage !== 'tests-only') return;
        const cached = readFixtureState(action.stateFile);
        const args = resumeArgs(cached.resumeCommand);
        assert.equal(args.at(-1), planRel, cached.resumeCommand);
        fs.rmSync(action.stateFile);
        const reply = runDispatch(fixture.fixture, args, { cwd: fixture.repo.dir });
        assert.equal(reply.status, 0, reply.stderr);
        resumedFirst = JSON.parse(reply.stdout);
        assert.notEqual(resumedFirst.action, 'launch', JSON.stringify(resumedFirst));
        assert.notEqual(resumedFirst.action, 'author', JSON.stringify(resumedFirst));
        assert.equal(path.dirname(resumedFirst.items[0].expectedEnvelopePath), path.dirname(resumedFirst.stateFile));
        Object.assign(action, resumedFirst);
      },
    });
    assert.ok(resumedFirst, 'run reached the tests-only write');
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.equal(resumeArgs(result.done.command).at(-1), planRel, result.done.command);
    assert.equal(readLedger(result.done.ledgerPath).events.filter(event => event.type === 'approval').length, 1);
  });

  it('SC1: the emitted resume command binds the plan when run from a repository subdirectory', () => {
    const fixture = createOrdinaryDriverFixture(); let planRel = null, resumed = null;
    driveOrdinaryImplementation({ ...fixture, plan: ASK }, {
      policy: { author: action => { planRel = relativePlan(fixture.repo.dir, action); return authorFrom(fixture)(action); }, askUser: recoverWrite(fixture) },
      maxSteps: 40,
      onAction(action) {
        if (resumed || action.action !== 'delegate-write' || action.fields.stage !== 'tests-only') return;
        const cached = readFixtureState(action.stateFile);
        const args = resumeArgs(cached.resumeCommand);
        assert.equal(args.at(-1), planRel, cached.resumeCommand);
        fs.rmSync(action.stateFile);
        const reply = runDispatch(fixture.fixture, args, { cwd: path.join(fixture.repo.dir, 'src') });
        assert.equal(reply.status, 0, reply.stderr);
        resumed = JSON.parse(reply.stdout);
        assert.notEqual(resumed.outcome, 'refused', JSON.stringify(resumed));
        assert.ok(!['launch', 'author'].includes(resumed.action), JSON.stringify(resumed));
        Object.assign(action, resumed);
      },
    });
    assert.ok(resumed, 'run reached the tests-only write');
  });

  it('SC1: a run started with --phases from:plan resumes after approval without --phases or plan review', () => {
    const fixture = createOrdinaryDriverFixture(); let planRel = null, resumed = null;
    driveOrdinaryImplementation({ ...fixture, plan: ASK }, {
      runArgs: ['implement', '--phases', 'from:plan', '--orchestrator', 'claude', '--', ASK],
      policy: { author: action => { planRel = relativePlan(fixture.repo.dir, action); return authorFrom(fixture)(action); }, askUser: recoverWrite(fixture) },
      maxSteps: 40,
      onAction(action) {
        if (resumed || action.action !== 'delegate-write' || action.fields.stage !== 'tests-only') return;
        const cached = readFixtureState(action.stateFile);
        const args = resumeArgs(cached.resumeCommand);
        assert.equal(args.at(-1), planRel, cached.resumeCommand);
        assert.equal(args.includes('--phases'), false, cached.resumeCommand);
        fs.rmSync(action.stateFile);
        const reply = runDispatch(fixture.fixture, args, { cwd: fixture.repo.dir });
        assert.equal(reply.status, 0, reply.stderr);
        resumed = JSON.parse(reply.stdout);
        assert.ok(!['launch', 'author'].includes(resumed.action), JSON.stringify(resumed));
        Object.assign(action, resumed);
      },
    });
    assert.ok(resumed, 'run reached the tests-only write');
  });

  it('SC2: an author reply naming a settled plan continues to baseline without plan review', () => {
    const fixture = createOrdinaryDriverFixture();
    const author = authorFrom(fixture);
    const planned = drive(fixture.fixture, { cwd: fixture.repo.dir, runArgs: ['plan', '--orchestrator', 'claude', '--', ASK], policy: { author } });
    assert.equal(planned.done.outcome, 'complete', JSON.stringify(planned.done));
    const result = driveOrdinaryImplementation({ ...fixture, plan: ASK }, { policy: { author } });
    assert.equal(result.trace[0].action, 'author');
    assert.deepEqual(planReviewLaunches(result.trace.slice(0, result.trace.findIndex(action => action.action === 'verify'))), []);
    assert.equal(result.trace[1].action === 'verify' ? result.trace[1].purpose : result.trace[1].question, result.trace[1].action === 'verify' ? 'baseline' : 'approval', JSON.stringify(result.trace[1]));
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
  });

  it('binds the canonical plan when the author reply spells it repository-relative with backslashes', () => {
    const fixture = createOrdinaryDriverFixture();
    const author = authorFrom(fixture);
    const backslashed = action => { author(action); return { path: path.relative(fixture.repo.dir, action.path).split(path.sep).join('\\') }; };
    const result = driveOrdinaryImplementation({ ...fixture, plan: ASK }, { policy: { author: backslashed } });
    assert.equal(result.trace[0].action, 'author');
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
  });

  it('SC2: an author reply naming a plan with restorable walkthrough evidence resumes the restored phase', () => {
    const fixture = createOrdinaryDriverFixture(); let restarted = false, replied = false;
    const result = driveOrdinaryImplementation({ ...fixture, plan: ASK }, {
      policy: { author: authorFrom(fixture), askUser: recoverWrite(fixture) },
      onAction(action) {
        // The first action after the post-restart author reply must be the restored write, not plan review.
        if (replied) { replied = false; assert.equal(action.question, 'implementation-recovery', `restored write-pending phase expected, got ${action.action}`); }
        if (restarted && action.action === 'author') replied = true;
      },
      restartWhen: action => !restarted && action.action === 'delegate-write' && action.fields.stage === 'tests-only' && (restarted = true),
    });
    assert.equal(result.restarts, 1);
    const afterRestart = result.trace.slice(result.trace.findIndex(action => action.action === 'delegate-write') + 1);
    assert.equal(afterRestart[0].action, 'author');
    assert.equal(afterRestart[1].question, 'implementation-recovery', JSON.stringify(afterRestart[1]));
    // Launches before production are plan review; the later code-review launch is expected.
    assert.deepEqual(planReviewLaunches(afterRestart.slice(0, afterRestart.findIndex(action => action.action === 'delegate-write' && action.fields.stage === 'production'))), []);
    assert.ok(afterRestart.some(action => action.action === 'delegate-write' && action.fields.stage === 'production'), 'continues to production');
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.equal(readLedger(result.done.ledgerPath).events.filter(event => event.type === 'approval').length, 1);
  });

  it('SC2: the plan verb still enters plan review for an author reply naming a settled plan', () => {
    const fixture = createOrdinaryDriverFixture();
    const author = authorFrom(fixture);
    drive(fixture.fixture, { cwd: fixture.repo.dir, runArgs: ['plan', '--orchestrator', 'claude', '--', ASK], policy: { author } });
    const again = drive(fixture.fixture, { cwd: fixture.repo.dir, runArgs: ['plan', '--orchestrator', 'claude', '--', ASK], policy: { author } });
    assert.equal(again.trace[0].action, 'author');
    assert.equal(again.trace[1].action, 'launch');
  });

  it('the plan verb authors from a non-canonical design spec instead of binding it', () => {
    const fixture = createOrdinaryDriverFixture();
    const spec = 'specs/2026-09-28-sample-behavior.design.md';
    fs.mkdirSync(path.join(fixture.repo.dir, 'specs'), { recursive: true });
    fs.writeFileSync(path.join(fixture.repo.dir, spec), '# Sample behavior\n');
    const reply = runDispatch(fixture.fixture, ['--run', 'plan', '--orchestrator', 'claude', '--', spec], { cwd: fixture.repo.dir });
    assert.equal(reply.status, 0, reply.stderr);
    const action = JSON.parse(reply.stdout);
    assert.equal(action.action, 'author', reply.stdout);
    assert.match(action.path.split(path.sep).join('/'), /\/sample-behavior\.plan\.md$/);
    assert.ok(reply.stdout.includes(spec), reply.stdout);
  });
});
