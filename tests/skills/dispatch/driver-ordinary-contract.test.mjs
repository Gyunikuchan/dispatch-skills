import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { buildStubDispatchFixture } from './stub-dispatch-fixture.mjs';
import { allProviders, codeFinding, drive, implementationOutcome, makeGitRepo, PLAN_BODY, report, runDispatch, writePlan } from './driver-harness.mjs';
import { readLedger } from '../../../skills/dispatch/scripts/ledger.mjs';
import { loadSchema, validateAgainstSchema } from '../../../skills/dispatch/scripts/driver/actions.mjs';
import { validateRedAdmission } from '../../../skills/dispatch/scripts/driver/verification.mjs';

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
    const testsOnly = result.trace.find(action => action.action === 'delegate-write');
    assert.match(testsOnly.fields.promptPath, /dispatch-driver/);
    const prompt = fs.readFileSync(testsOnly.fields.promptPath, 'utf8');
    assert.equal(testsOnly.fields.promptHash, `sha256:${crypto.createHash('sha256').update(prompt).digest('hex')}`);
    assert.match(testsOnly.guidance.join(' '), /Read .* fully/);
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
  it('excludes an aggregate command mapped to no red criterion from RED admission', () => {
    const fixture = setup();
    const source = fs.readFileSync(fixture.plan, 'utf8')
      .replace('## Proposed Changes', '- [SC2] Aggregate regression coverage.\n  - Changes: `src/app.js`\n  - Verify: `npm test`\n  - Evidence: verify\n  - Test rationale: The full suite is deterministic and needs no dedicated pre-change failure.\n\n## Proposed Changes')
      .replace('- `node --test tests/sample.test.mjs`', '- `node --test tests/sample.test.mjs`\n- `npm test`');
    fs.writeFileSync(fixture.plan, source);
    const result = run(fixture, { policy: {
      delegateWrite(action) {
        const testsOnly = action.fields.stage === 'tests-only';
        fs.writeFileSync(path.join(fixture.repo.dir, testsOnly ? 'tests/sample.test.mjs' : 'src/app.js'), testsOnly
          ? "import assert from 'node:assert/strict';\nimport { value } from '../src/app.js';\nassert.equal(value, 2);\n" : 'export const value = 2;\n');
        return { raw: JSON.stringify(implementationOutcome({ stage: testsOnly ? 'RED_READY' : 'COMPLETE', evidence: testsOnly
          ? ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample']
          : ['CRITERION SC1 | delivered value=2 | src/app.js', 'CRITERION SC2 | delivered value=2 | src/app.js'] })) };
      },
      verify(action) {
        // The aggregate command belongs to a verify-class criterion, not a red one; it also goes RED
        // during the tests-only mutation, and must not be checked for RED identity or admitted defects.
        if (action.commands[0] === 'npm test') {
          const failing = action.purpose === 'red';
          return { results: [{ command: 'npm test', exit: failing ? 1 : 0, evidence: failing ? 'unrelated aggregate failure' : 'ok',
            identifiers: failing ? ['error:aggregate-unrelated'] : [], diagnostic: failing ? 'unrelated aggregate diagnostic' : '',
            scopeHash: action.scopeHash, mutationEpoch: action.mutationEpoch,
            ...(action.purpose === 'completion' ? { criterionEvidence: [{ criterionId: 'SC2', evidenceClass: 'verify', reviewer: 'host', scenario: 'run the aggregate suite', inspectedRevision: action.scopeHash, observableResult: 'suite green', limitations: 'covers mapped aggregate only', mutationEpoch: action.mutationEpoch }] } : {}) }] };
        }
        return policies(fixture.repo).verify(action);
      },
    } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    const ledger = readLedger(result.done.ledgerPath);
    const redEvent = ledger.events.find(event => event.type === 'verification' && event.data.result === 'red');
    assert.deepEqual(redEvent.data.failureIdentity.identifiers, ['test:sample']);
  });
  it('matches a command shared by two red criteria against the union of their identifiers', () => {
    const attempt = (hostIdentifiers) => {
      const fixture = setup();
      const source = fs.readFileSync(fixture.plan, 'utf8')
        .replace('## Proposed Changes', '- [SC2] Second observable on the shared command.\n  - Changes: `src/app.js`, `tests/sample.test.mjs`\n  - Verify: `node --test tests/sample.test.mjs`\n  - Evidence: red\n  - Test rationale: Shares the first criterion\'s command, so its RED must match the union.\n\n## Proposed Changes');
      fs.writeFileSync(fixture.plan, source);
      return run(fixture, { policy: {
        delegateWrite(action) {
          const testsOnly = action.fields.stage === 'tests-only';
          fs.writeFileSync(path.join(fixture.repo.dir, testsOnly ? 'tests/sample.test.mjs' : 'src/app.js'), testsOnly
            ? "import assert from 'node:assert/strict';\nimport { value } from '../src/app.js';\nassert.equal(value, 2);\n" : 'export const value = 2;\n');
          return { raw: JSON.stringify(implementationOutcome({ stage: testsOnly ? 'RED_READY' : 'COMPLETE', evidence: testsOnly
            ? ['RED-MATRIX SC1 | tests/sample.test.mjs:alpha one | exit 1 test:alpha one', 'RED-MATRIX SC2 | tests/sample.test.mjs:beta two | exit 1 test:beta two']
            : ['CRITERION SC1 | delivered value=2 | src/app.js', 'CRITERION SC2 | delivered value=2 | src/app.js'] })) };
        },
        verify(action) {
          if (action.purpose !== 'red') return policies(fixture.repo).verify(action);
          return { results: [{ command: action.commands[0], exit: 1, evidence: 'failing', identifiers: hostIdentifiers, diagnostic: '',
            scopeHash: action.scopeHash, mutationEpoch: action.mutationEpoch }] };
        },
      } });
    };
    const matched = attempt(['test:alpha one', 'test:beta two']);
    assert.equal(matched.done.outcome, 'complete', JSON.stringify(matched.done));
    const partial = attempt(['test:alpha one']);
    assert.notEqual(partial.done?.outcome, 'complete');
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
      askUser: action => action.question === 'implementation-recovery' ? { answer: { raw: '{"status":"DONE"}' } } : action.question === 'failure-disposition'
        ? { answer: { decision: 'inspect-first', reason: 'Inspect incomplete outcome.' } }
        : policies(fixture.repo).askUser(action),
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
    const fixture = setup(); let writes = 0, restarted = false, recoveries = 0;
    const base = policies(fixture.repo);
    const result = run(fixture, {
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
    const fixture = setup(); let calls = 0;
    const source = fs.readFileSync(fixture.plan, 'utf8').replace('## Proposed Changes', '- [SC2] Preserve the same RED observable.\n  - Changes: `src/app.js`, `tests/sample.test.mjs`\n  - Verify: `node --test tests/sample.test.mjs`\n  - Evidence: red\n  - Test rationale: A second mapped acceptance condition requires explicit matrix coverage.\n\n## Proposed Changes');
    fs.writeFileSync(fixture.plan, source);
    const base = policies(fixture.repo);
    const result = run(fixture, { policy: { delegateWrite(action) {
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
  it('relaunches tests-only once after an accepted test-review finding, then completes', () => {
    const fixture = setup(); let testWaves = 0, testsWritten = false;
    const base = policies(fixture.repo);
    const finding = codeFinding({ locus: 'tests/sample.test.mjs:L3', defect: 'RED lacks a negative assertion.' });
    const result = run(fixture, { policy: {
      delegateWrite(action) { testsWritten ||= action.fields.stage === 'tests-only'; return base.delegateWrite(action); },
      // Only the first wave after the tests-only write is the RED test review.
      waveResults: () => allProviders(report(testsWritten && ++testWaves === 1 ? [finding] : [])),
      restate: () => ({ status: 'accepted', severity: 'MUST_FIX', scope: 'in-scope', locus: finding.locus, tag: 'testability', defect: finding.defect, resolution: 'Verified against the test.' }),
    } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    const writes = result.trace.filter(action => action.action === 'delegate-write');
    assert.deepEqual(writes.map(action => action.fields.stage), ['tests-only', 'tests-only', 'production']);
    assert.match(writes[1].fields.continuation.defects[0], /Accepted test-review finding .*negative assertion/);
    const attempts = readLedger(result.done.ledgerPath).events.filter(event => event.type === 'implementation-attempt');
    assert.deepEqual(attempts.map(event => [event.data.launch, event.data.attempt]), [['tests-only', 1], ['tests-only', 2], ['continuation', 2]]);
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
        // No test file changed, so the independent RED review has nothing to inspect.
        if (action.question === 'risk-review-degradation') return { answer: { decision: 'accept', reason: 'Pre-existing RED; no changed tests to review.' } };
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

  it('production delegate-write guidance names CRITERION rows and the inspectedRevision rule (SC4)', () => {
    const fixture = setup();
    let production;
    const result = run(fixture, { onAction(action) { if (action.action === 'delegate-write' && action.fields.stage === 'production') production = action; } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    const guidance = production.guidance.join(' ');
    assert.match(guidance, /CRITERION\s+SC#\s*\|/, 'guidance must name the CRITERION SC# | <paths> | <behavior> envelope row format');
    assert.match(guidance, /inspectedRevision/, 'guidance must name the inspectedRevision field');
    assert.match(guidance, /scopeHash/, 'guidance must state that inspectedRevision equals the emitted scopeHash');
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
