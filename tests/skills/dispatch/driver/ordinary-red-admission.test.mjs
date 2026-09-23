import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { readLedger } from '../../../../skills/dispatch/scripts/ledger.mjs';
import { loadSchema, validateAgainstSchema } from '../../../../skills/dispatch/scripts/driver/actions.mjs';

import { drive, implementationOutcome, PLAN_BODY, runDispatch } from '../../../helpers/driver-harness.mjs';
import { policies, run, runCleanup, setup } from '../../../helpers/ordinary-driver.mjs';

afterEach(runCleanup);

describe('ordinary driver canonical contracts: RED admission and cascade', () => {
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
        assert.ok(action.purpose !== 'red' || !action.commands.includes('npm test'), 'RED runs only red-mapped commands');
        const base = policies(fixture.repo).verify(action);
        if (!action.commands.includes('npm test')) return base;
        const scopeHash = action.scopeHashes['npm test'];
        base.results = base.results.map(item => item.command !== 'npm test' ? item : { command: 'npm test', exit: 0, evidence: 'ok', identifiers: [], diagnostic: '', scopeHash, mutationEpoch: action.mutationEpoch,
          ...(action.purpose === 'completion' ? { criterionEvidence: [{ criterionId: 'SC2', evidenceClass: 'verify', reviewer: 'host', scenario: 'run the aggregate suite', inspectedRevision: scopeHash, observableResult: 'suite green', limitations: 'covers mapped aggregate only', mutationEpoch: action.mutationEpoch }] } : {}) });
        return base;
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
    const inlinePacket = structuredClone(production); inlinePacket.fields.packet = JSON.parse(fs.readFileSync(production.fields.promptPath, 'utf8')).packet;
    assert.ok(validateAgainstSchema(loadSchema('delegate-write'), inlinePacket).length, 'production relays the brief by path, never inline');
    const noPrompt = structuredClone(production); delete noPrompt.fields.promptPath;
    assert.ok(validateAgainstSchema(loadSchema('delegate-write'), noPrompt).length);
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
});
