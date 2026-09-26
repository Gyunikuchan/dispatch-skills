import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { readLedger } from '../../../../skills/dispatch/scripts/ledger/ledger.mjs';
import { ledgerNamespacePath, repositoryRootHash } from '../../../../skills/dispatch/scripts/artifacts/resolve-paths.mjs';

import { implementationOutcome, writeOutcomeReply } from '../../../helpers/driver-harness.mjs';
import { cleanupOrdinaryDriverFixtures, createOrdinaryDriverFixture, driveOrdinaryImplementation, ordinaryDriverPolicy } from '../../../helpers/ordinary-driver-fixture.mjs';

afterEach(cleanupOrdinaryDriverFixtures);

describe('ordinary driver canonical contracts: baseline and RED', () => {
  it('executes mapped host baseline, typed approval, real RED and checkpoint relocation', () => {
    const fixture = createOrdinaryDriverFixture();
    const result = driveOrdinaryImplementation(fixture);
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.ok(result.done.handoff.checkpoint.invocationId);
    assert.equal(result.done.handoff.destinations.length, 2);
    assert.ok(result.done.handoff.destinations.every(file => fs.existsSync(file)));
    const ledger = readLedger(result.done.ledgerPath);
    assert.equal(ledger.status, 'ok', ledger.diagnostic);
    // Pins where the rejected-approval case looks for a ledger.
    assert.equal(path.dirname(result.done.ledgerPath), ledgerNamespacePath({ repoHash: repositoryRootHash(fixture.repo.dir) }));
    assert.match(path.basename(result.done.ledgerPath), /-ledger\.md$/);
    assert.deepEqual(ledger.events.slice(0, 2).map(event => event.type), ['run-start', 'approval']);
    assert.equal(ledger.events[0].data.baseline.commit, fixture.repo.git('rev-parse', 'HEAD').toString().trim());
    assert.equal(ledger.events.filter(event => event.type === 'approval').length, 1);
    assert.deepEqual(result.trace.filter(action => action.action === 'delegate-write').map(action => action.fields.stage), ['tests-only', 'production']);
    const testsOnly = result.trace.find(action => action.action === 'delegate-write');
    assert.match(testsOnly.fields.promptPath, /[\\/]sessions[\\/]/);
    const prompt = fs.readFileSync(testsOnly.fields.promptPath, 'utf8');
    assert.equal(testsOnly.fields.promptHash, `sha256:${crypto.createHash('sha256').update(prompt).digest('hex')}`);
    assert.match(testsOnly.guidance.join(' '), /Read .* fully/);
    assert.equal(result.trace.some(action => action.action === 'native-fallback'), false);
    assert.equal(ledger.events.at(-1).data.result, 'complete');
  });
  it('stops on a rejected approval without writing a ledger segment', () => {
    const fixture = createOrdinaryDriverFixture();
    const result = driveOrdinaryImplementation(fixture, { policy: {
      ...ordinaryDriverPolicy(fixture.repo),
      askUser(action) {
        if (action.question === 'approval') return { answer: { decision: 'rejected', reason: 'Scope is wrong.' } };
        return ordinaryDriverPolicy(fixture.repo).askUser(action);
      },
    } });
    assert.equal(result.done.outcome, 'refused', JSON.stringify(result.done));
    assert.match(result.done.reason, /Plan approval rejected: Scope is wrong\..*--phases from:plan/);
    assert.equal(result.trace.some(action => action.action === 'delegate-write'), false);
    const namespace = ledgerNamespacePath({ repoHash: repositoryRootHash(fixture.repo.dir) });
    const ledgers = fs.existsSync(namespace) ? fs.readdirSync(namespace).filter(name => name.endsWith('-ledger.md')) : [];
    assert.deepEqual(ledgers, [], 'rejection writes no ledger');
  });
  it('relays the red-criterion test-path lint warning in the approval items', () => {
    const fixture = createOrdinaryDriverFixture();
    fs.writeFileSync(fixture.plan, fs.readFileSync(fixture.plan, 'utf8').replace(/(  - Changes: [^\n]*?),\s*`?tests\/sample\.test\.mjs`?/, '$1'));
    let approval;
    driveOrdinaryImplementation(fixture, { allowErrors: true, policy: {
      askUser(action) {
        if (action.question === 'approval') { approval = action; return { answer: { decision: 'rejected', reason: 'Inspect warning only.' } }; }
        return ordinaryDriverPolicy(fixture.repo).askUser(action);
      },
    } });
    assert.ok(approval, 'reached approval');
    assert.match(JSON.stringify(approval.items[0].warnings ?? []), /SC1 uses red evidence but its Changes line names no conventional test path/);
  });
  it('resumes an interrupted host RED verification without repeating approval or delegation', () => {
    const fixture = createOrdinaryDriverFixture(); let restarted = false;
    const result = driveOrdinaryImplementation(fixture, { restartWhen: action => !restarted && action.action === 'verify' && action.purpose === 'red' && (restarted = true) });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.equal(result.restarts, 1);
    const ledger = readLedger(result.done.ledgerPath);
    assert.equal(ledger.status, 'ok', ledger.diagnostic);
    assert.equal(ledger.events.filter(event => event.type === 'run-start').length, 1);
    assert.equal(ledger.events.filter(event => event.type === 'approval').length, 1);
    assert.deepEqual(result.trace.filter(action => action.action === 'delegate-write').map(action => action.fields.stage), ['tests-only', 'production']);
  });
  it('skips RED for verify-only criteria, emits the bounded packet, and renders fresh traceability', () => {
    const fixture = createOrdinaryDriverFixture();
    fs.writeFileSync(fixture.plan, fs.readFileSync(fixture.plan, 'utf8')
      .replace('Evidence: red', 'Evidence: verify')
      .replace('Behavioral failure isolates the sample outcome and protects its regression.', 'A retained pre-change test would add no signal beyond the mapped deterministic check.'));
    let packet;
    const result = driveOrdinaryImplementation(fixture, { policy: {
      askUser(action) {
        if (action.question === 'approval') return { answer: { decision: 'approved', governingHash: action.items[0].governingHash, testPaths: [], reason: 'Approve verify-only fixture.' } };
        return ordinaryDriverPolicy(fixture.repo).askUser(action);
      },
      delegateWrite(action) {
        assert.equal(action.fields.stage, 'production');
        packet = JSON.parse(fs.readFileSync(action.fields.promptPath, 'utf8')).packet;
        fs.writeFileSync(path.join(fixture.repo.dir, 'src/app.js'), 'export const value = 2;\n');
        fs.writeFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), "import assert from 'node:assert/strict';\nimport { value } from '../src/app.js';\nassert.equal(value, 2);\n");
        return writeOutcomeReply(action, implementationOutcome({ evidence: ['CRITERION SC1 | src/app.js | delivered value=2'] }));
      },
      verify(action) {
        const base = ordinaryDriverPolicy(fixture.repo).verify(action);
        if (action.purpose === 'scoped') base.results[0].criterionEvidence = [{ criterionId: 'SC1', evidenceClass: 'verify', reviewer: 'host', scenario: 'execute mapped sample check', inspectedRevision: action.scopeHash, observableResult: 'value=2 observed', limitations: 'covers mapped sample only', mutationEpoch: action.mutationEpoch }];
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
    assert.match(walkthrough, /^\| SC1 \| delivered value=2 \|/m);
    assert.match(walkthrough, /reviewer: host/);
    assert.doesNotMatch(walkthrough, /^\| SC1 \|[^\n]*\| Pending/m);
  });
});
