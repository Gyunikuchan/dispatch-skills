import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { buildStubDispatchFixture } from './stub-dispatch-fixture.mjs';
import { drive, implementationOutcome, makeGitRepo, PLAN_BODY, runDispatch, writePlan } from './driver-harness.mjs';
import { readLedger } from '../../../skills/dispatch/scripts/ledger.mjs';
import { loadSchema, validateAgainstSchema } from '../../../skills/dispatch/scripts/driver/actions.mjs';

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
function policies(repo, overrides = {}) {
  return {
    askUser(action) {
      if (action.question === 'approval') return { answer: { decision: 'approved', governingHash: action.items[0].governingHash, testPaths: ['tests/sample.test.mjs'], reason: 'Approved fixture plan.' } };
      if (action.question === 'failure-disposition') return { answer: { decision: 'keep-for-repair', reason: 'Preserve fixture evidence.' } };
      if (action.question === 'opt-in') return { answer: 'none' };
      throw new Error(`Unexpected question ${action.question}`);
    },
    delegateWrite(action) {
      const testsOnly = action.fields.stage === 'tests-only';
      fs.writeFileSync(path.join(repo.dir, testsOnly ? 'tests/sample.test.mjs' : 'src/app.js'), testsOnly
        ? "import assert from 'node:assert/strict';\nimport { value } from '../src/app.js';\nassert.equal(value, 2);\n" : 'export const value = 2;\n');
      return { raw: JSON.stringify(implementationOutcome({ stage: testsOnly ? 'RED_READY' : 'COMPLETE', evidence: testsOnly ? ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] : ['CRITERION SC1 | delivered value=2 | src/app.js'] })) };
    },
    verify(action) {
      return { results: action.commands.map(command => {
        const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, ['--test', 'tests/sample.test.mjs'], { cwd: repo.dir, encoding: 'utf8', env });
        return { command, exit: result.status, evidence: result.stdout, identifiers: result.status ? ['test:sample'] : [], diagnostic: result.stderr, scopeHash: action.scopeHash, mutationEpoch: action.mutationEpoch };
      }) };
    }, ...overrides,
  };
}
function run({ fixture, repo, plan }, options = {}) {
  return drive(fixture, { cwd: repo.dir, runArgs: ['implement', '--orchestrator', 'claude', '--', plan], policy: policies(repo, options.policy),
    onAction(action) { assert.deepEqual(validateAgainstSchema(loadSchema(action.action), action), [], JSON.stringify(action)); if (!options.allowErrors) assert.equal(action.error, undefined, JSON.stringify(action)); options.onAction?.(action); }, ...Object.fromEntries(Object.entries(options).filter(([key]) => !['policy', 'onAction', 'allowErrors'].includes(key))) });
}
describe('ordinary driver canonical contracts', () => {
  it('executes mapped host baseline, typed approval, real RED, configured risk review and checkpoint relocation', () => {
    const fixture = setup();
    const result = run(fixture);
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.ok(result.done.handoff.checkpoint.invocationId);
    assert.equal(result.done.handoff.destinations.length, 2);
    assert.ok(result.done.handoff.destinations.every(file => fs.existsSync(file)));
    const ledger = readLedger(result.done.ledgerPath);
    assert.equal(ledger.status, 'ok', ledger.diagnostic);
    assert.deepEqual(ledger.events.slice(0, 2).map(event => event.type), ['run-start', 'approval']);
    assert.equal(ledger.events[0].data.baseline.commit, fixture.repo.git('rev-parse', 'HEAD').toString().trim());
    assert.equal(ledger.events.filter(event => event.type === 'approval').length, 1);
    assert.deepEqual(result.trace.filter(action => action.action === 'delegate-write').map(action => action.fields.stage), ['tests-only', 'production']);
    assert.equal(result.trace.some(action => action.action === 'native-fallback'), false);
    assert.equal(ledger.events.at(-1).data.result, 'complete');
  });
  it('resumes an interrupted host RED verification without repeating approval or delegation', () => {
    const fixture = setup(); let restarted = false;
    const result = run(fixture, { restartWhen: action => !restarted && action.action === 'verify' && action.purpose === 'red' && (restarted = true) });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.equal(result.restarts, 1);
    const ledger = readLedger(result.done.ledgerPath);
    assert.equal(ledger.status, 'ok', ledger.diagnostic);
    assert.equal(ledger.events.filter(event => event.type === 'run-start').length, 1);
    assert.equal(ledger.events.filter(event => event.type === 'approval').length, 1);
    assert.deepEqual(result.trace.filter(action => action.action === 'delegate-write').map(action => action.fields.stage), ['tests-only', 'production']);
  });
  it('skips RED for verify-only criteria, emits the bounded packet, and renders fresh traceability', () => {
    const fixture = setup();
    fs.writeFileSync(fixture.plan, fs.readFileSync(fixture.plan, 'utf8')
      .replace('Evidence: red', 'Evidence: verify')
      .replace('Behavioral failure isolates the sample outcome and protects its regression.', 'A retained pre-change test would add no signal beyond the mapped deterministic check.'));
    let packet;
    const result = run(fixture, { policy: {
      askUser(action) {
        if (action.question === 'approval') return { answer: { decision: 'approved', governingHash: action.items[0].governingHash, testPaths: [], reason: 'Approve verify-only fixture.' } };
        return policies(fixture.repo).askUser(action);
      },
      delegateWrite(action) {
        assert.equal(action.fields.stage, 'production');
        packet = action.fields.packet;
        fs.writeFileSync(path.join(fixture.repo.dir, 'src/app.js'), 'export const value = 2;\n');
        fs.writeFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), "import assert from 'node:assert/strict';\nimport { value } from '../src/app.js';\nassert.equal(value, 2);\n");
        return { raw: JSON.stringify(implementationOutcome({ evidence: ['CRITERION SC1 | delivered value=2 | src/app.js'] })) };
      },
      verify(action) {
        const base = policies(fixture.repo).verify(action);
        if (action.purpose === 'completion') base.results[0].criterionEvidence = [{ criterionId: 'SC1', evidenceClass: 'verify', reviewer: 'host', scenario: 'execute mapped sample check', inspectedRevision: action.scopeHash, observableResult: 'value=2 observed', limitations: 'covers mapped sample only', mutationEpoch: action.mutationEpoch }];
        return base;
      },
    } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.deepEqual(result.trace.filter(action => action.action === 'delegate-write').map(action => action.fields.stage), ['production']);
    assert.deepEqual(Object.keys(packet).slice(0, 5), ['governingOutcome', 'settledBoundary', 'criteria', 'repositoryContext', 'testsAsEvidence']);
    assert.equal(packet.testsAsEvidence.label, 'evidence, not specification');
    assert.match(packet.governingOutcome.title, /Plan/);
    assert.equal(packet.criteria[0].evidenceClass, 'verify');
    const walkthrough = fs.readFileSync(result.done.handoff.destinations.find(file => file.endsWith('-walkthrough.md')), 'utf8');
    assert.match(walkthrough, /\[SC1\] delivered value=2/);
    assert.match(walkthrough, /reviewer: host/);
    assert.doesNotMatch(walkthrough, /\[SC1\] Pending/);
  });
  it('rejects missing and stale per-criterion evidence before accepting a fresh record', () => {
    const fixture = setup();
    fs.writeFileSync(fixture.plan, fs.readFileSync(fixture.plan, 'utf8').replace('Evidence: red', 'Evidence: verify'));
    let completionReplies = 0;
    const result = run(fixture, { allowErrors: true, policy: {
      askUser(action) {
        if (action.question === 'approval') return { answer: { decision: 'approved', governingHash: action.items[0].governingHash, testPaths: [], reason: 'Approve verify fixture.' } };
        return policies(fixture.repo).askUser(action);
      },
      delegateWrite(action) {
        fs.writeFileSync(path.join(fixture.repo.dir, 'src/app.js'), 'export const value = 2;\n');
        fs.writeFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), "import assert from 'node:assert/strict';\nimport { value } from '../src/app.js';\nassert.equal(value, 2);\n");
        return { raw: JSON.stringify(implementationOutcome({ evidence: ['CRITERION SC1 | delivered value=2 | src/app.js'] })) };
      },
      verify(action) {
        const reply = policies(fixture.repo).verify(action);
        if (action.purpose !== 'completion') return reply;
        completionReplies++;
        if (completionReplies === 1) return reply;
        reply.results[0].criterionEvidence = [{ criterionId: 'SC1', evidenceClass: 'verify', reviewer: 'host', scenario: 'mapped check', inspectedRevision: completionReplies === 2 ? 'sha256:stale' : action.scopeHash, observableResult: 'value=2', limitations: 'mapped scope only', mutationEpoch: action.mutationEpoch }];
        return reply;
      },
    } });
    assert.equal(result.done.outcome, 'complete');
    assert.equal(completionReplies, 3);
    const rejected = result.trace.filter(action => action.action === 'verify' && action.purpose === 'completion' && action.error);
    assert.equal(rejected.length, 2);
    assert.match(rejected[0].error, /fresh structured verify evidence/);
    assert.match(rejected[1].error, /fresh structured verify evidence/);
  });
  it('rejects mixed-plan non-red path leakage from the canonical tests-only scope', () => {
    const fixture = setup();
    const source = fs.readFileSync(fixture.plan, 'utf8')
      .replace('Changes: `src/app.js`, `tests/sample.test.mjs`', 'Changes: `tests/sample.test.mjs`')
      .replace('## Proposed Changes', '- [SC2] Deliver production behavior.\n  - Changes: `src/app.js`\n  - Verify: `node --test tests/sample.test.mjs`\n  - Evidence: verify\n  - Test rationale: Existing mapped verification is sufficient and a second retained test would be redundant.\n\n## Proposed Changes');
    fs.writeFileSync(fixture.plan, source);
    let scope;
    const result = run(fixture, { policy: { delegateWrite(action) {
      if (action.fields.stage === 'tests-only') {
        scope = action.fields.paths;
        fs.writeFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), "import assert from 'node:assert/strict';\nassert.equal(1, 2);\n");
        fs.writeFileSync(path.join(fixture.repo.dir, 'src/app.js'), 'export const value = 99;\n');
        return { raw: JSON.stringify(implementationOutcome({ stage: 'RED_READY', evidence: ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] })) };
      }
      throw new Error('production must not launch after leakage');
    } } });
    assert.deepEqual(scope, ['tests/sample.test.mjs']);
    assert.equal(result.done.outcome, 'stable-failure');
    assert.match(result.done.summary, /outside its approved write scope/);
  });
  it('strictly validates criteria and stage-conditional packets', () => {
    const fixture = setup(); let production;
    const result = run(fixture, { onAction(action) { if (action.action === 'delegate-write' && action.fields.stage === 'production') production = structuredClone(action); } });
    assert.equal(result.done.outcome, 'complete');
    assert.deepEqual(validateAgainstSchema(loadSchema('delegate-write'), production), []);
    const missingCriteria = structuredClone(production); delete missingCriteria.fields.criteria;
    assert.ok(validateAgainstSchema(loadSchema('delegate-write'), missingCriteria).length);
    const nullPacket = structuredClone(production); nullPacket.fields.packet = null;
    assert.ok(validateAgainstSchema(loadSchema('delegate-write'), nullPacket).length);
    const testsOnly = structuredClone(production); testsOnly.fields.stage = 'tests-only'; testsOnly.fields.launch = 'tests-only'; testsOnly.fields.packet = null;
    testsOnly.fields.criteria[0].evidence = 'verify';
    assert.ok(validateAgainstSchema(loadSchema('delegate-write'), testsOnly).length);
  });
  it('authors an ask into a canonical plan and stops before baseline or ledger', () => {
    const fixture = setup();
    const result = drive(fixture.fixture, { cwd: fixture.repo.dir, runArgs: ['plan', '--orchestrator', 'claude', '--', 'add a sample behavior'], policy: {
      author(action) { fs.writeFileSync(action.path, PLAN_BODY); return { path: action.path }; },
    } });
    assert.equal(result.done.outcome, 'complete');
    assert.equal(result.trace[0].action, 'author');
    assert.equal(result.trace.some(action => ['verify', 'delegate-write'].includes(action.action)), false);
    assert.equal(result.done.ledgerPath, undefined);
  });
  it('uses only configured cascade candidates after actual launch rejection', () => {
    const fixture = setup(); let rejected = false;
    const result = run(fixture, { policy: { delegateWrite(action) {
      if (!rejected) { rejected = true; return { rejected: true, reason: 'Model unavailable.' }; }
      return policies(fixture.repo).delegateWrite(action);
    } } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.deepEqual(result.trace.filter(action => action.action === 'delegate-write').slice(0, 2).map(action => action.fields.model), ['first-model', 'second-model']);
    assert.equal(readLedger(result.done.ledgerPath).events.filter(event => event.type === 'implementation-attempt' && event.data.launch === 'tests-only').length, 1);
  });
  it('rejects missing prerequisites without creating a ledger or writing production', () => {
    const { fixture, repo, plan } = setup();
    for (const phase of ['baseline', 'implementation', 'code-review', 'handoff']) {
      const result = runDispatch(fixture, ['--run', 'implement', '--phases', `from:${phase}`, '--orchestrator', 'claude', '--', plan], { cwd: repo.dir });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).outcome, 'refused');
    }
  });
  it('reconstructs review, baseline, and implementation phases from canonical artifacts after cache loss', () => {
    for (const phase of ['plan-review', 'baseline', 'implementation', 'code-review']) {
      const fixture = setup(); let restarted = false;
      const result = run(fixture, {
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
    const fixture = setup();
    const result = run(fixture, { policy: {
      delegateWrite: () => ({ raw: '{"status":"DONE"}' }),
      askUser: action => action.question === 'failure-disposition'
        ? { answer: { decision: 'inspect-first', reason: 'Inspect incomplete outcome.' } }
        : policies(fixture.repo).askUser(action),
    } });
    const ledger = readLedger(result.done.ledgerPath);
    assert.equal(ledger.status, 'ok', ledger.diagnostic);
    assert.equal(ledger.events.some(event => event.type === 'run-complete'), false);
    assert.equal(ledger.events.at(-1).data.state, 'open');
    assert.equal(result.trace.filter(action => action.action === 'delegate-write').length, 1);
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
