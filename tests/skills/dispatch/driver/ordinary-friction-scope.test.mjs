import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { readLedger } from '../../../../skills/dispatch/scripts/ledger/ledger.mjs';

import { hashFile } from '../../../../skills/dispatch/scripts/lib/integrity.mjs';
import { allProviders, codeFinding, report } from '../../../helpers/driver-harness.mjs';
import { cleanupOrdinaryDriverFixtures, createOrdinaryDriverFixture, driveOrdinaryImplementation, ordinaryDriverPolicy } from '../../../helpers/ordinary-driver-fixture.mjs';

afterEach(cleanupOrdinaryDriverFixtures);

describe('ordinary driver friction relief: write scope and re-verify', () => {
  const rulings = ledger => ledger.events.filter(event => event.type === 'ruling').map(event => [event.data.key, event.data.decision]);
  const stray = (fixture, file) => action => {
    if (action.fields.stage === 'production') fs.writeFileSync(path.join(fixture.repo.dir, file), 'stray\n');
    return ordinaryDriverPolicy(fixture.repo).delegateWrite(action);
  };
  it('auto-approves a sibling integrity manifest and asks a ruling for other out-of-scope paths', () => {
    const fixture = createOrdinaryDriverFixture(); const asked = [];
    const base = ordinaryDriverPolicy(fixture.repo);
    const result = driveOrdinaryImplementation(fixture, { policy: {
      askUser(action) {
        if (action.question !== 'write-scope') return base.askUser(action);
        asked.push(action.items);
        return { answer: { approve: ['docs/notes.md'], reason: 'Notes document the change.' } };
      },
      delegateWrite(action) {
        const reply = base.delegateWrite(action);
        if (action.fields.stage === 'production') {
          fs.writeFileSync(path.join(fixture.repo.dir, 'src/skill-hashes.json'), JSON.stringify({ 'app.js': hashFile(path.join(fixture.repo.dir, 'src/app.js')) }));
          fs.mkdirSync(path.join(fixture.repo.dir, 'docs'), { recursive: true });
          fs.writeFileSync(path.join(fixture.repo.dir, 'docs/notes.md'), 'notes\n');
        }
        return reply;
      },
    } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.deepEqual(asked, [[{ path: 'docs/notes.md', revertable: true }]]);
    const ledger = readLedger(result.done.ledgerPath);
    assert.deepEqual(rulings(ledger).filter(([key]) => key === 'write-scope'), [['write-scope', 'auto-approve'], ['write-scope', 'approve']]);
    assert.deepEqual(ledger.events.find(event => event.type === 'task-complete').data.paths, ['docs/notes.md', 'src/app.js', 'src/skill-hashes.json', 'tests/sample.test.mjs']);
  });
  it('reverts ruled-out paths to their task-start state and continues', () => {
    const fixture = createOrdinaryDriverFixture();
    fs.mkdirSync(path.join(fixture.repo.dir, 'docs'));
    fs.writeFileSync(path.join(fixture.repo.dir, 'docs/keep.md'), 'original\n');
    fixture.repo.git('add', 'docs'); fixture.repo.git('commit', '--no-gpg-sign', '-qm', 'docs');
    const base = ordinaryDriverPolicy(fixture.repo);
    const result = driveOrdinaryImplementation(fixture, { policy: {
      askUser: action => action.question === 'write-scope' ? { answer: { revert: ['docs/keep.md', 'docs/stray.md'], reason: 'Out of plan scope.' } } : base.askUser(action),
      delegateWrite(action) {
        if (action.fields.stage === 'production') {
          fs.writeFileSync(path.join(fixture.repo.dir, 'docs/keep.md'), 'edited\n');
          fs.writeFileSync(path.join(fixture.repo.dir, 'docs/stray.md'), 'stray\n');
        }
        return base.delegateWrite(action);
      },
    } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.equal(fs.readFileSync(path.join(fixture.repo.dir, 'docs/keep.md'), 'utf8'), 'original\n');
    assert.equal(fs.existsSync(path.join(fixture.repo.dir, 'docs/stray.md')), false);
  });
  it('routes a stale integrity manifest to the ruling and stops on a stop ruling', () => {
    const fixture = createOrdinaryDriverFixture(); let items;
    const base = ordinaryDriverPolicy(fixture.repo);
    const result = driveOrdinaryImplementation(fixture, { policy: {
      askUser(action) {
        if (action.question !== 'write-scope') return base.askUser(action);
        items = action.items;
        return { answer: { decision: 'stop', reason: 'Unexpected edit.' } };
      },
      delegateWrite(action) {
        if (action.fields.stage === 'production') fs.writeFileSync(path.join(fixture.repo.dir, 'src/skill-hashes.json'), JSON.stringify({ 'app.js': 'sha256:stale' }));
        return base.delegateWrite(action);
      },
    } });
    assert.equal(result.done.outcome, 'stable-failure');
    assert.deepEqual(items.map(item => item.path), ['src/skill-hashes.json']);
    assert.match(result.done.summary, /outside its approved write scope: src\/skill-hashes\.json/);
  });
  it('refuses to revert a path the delegate staged', () => {
    const fixture = createOrdinaryDriverFixture(); const asked = []; let error = null;
    const base = ordinaryDriverPolicy(fixture.repo);
    const result = driveOrdinaryImplementation(fixture, { allowErrors: true, policy: {
      askUser(action) {
        if (action.question !== 'write-scope') return base.askUser(action);
        asked.push(action.items);
        if (action.error) { error = action.error; return { answer: { approve: ['stray.md'], reason: 'Keep it after all.' } }; }
        return { answer: { revert: ['stray.md'], reason: 'Out of scope.' } };
      },
      delegateWrite(action) {
        const reply = stray(fixture, 'stray.md')(action);
        if (action.fields.stage === 'production') fixture.repo.git('add', 'stray.md');
        return reply;
      },
    } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.deepEqual(asked[0], [{ path: 'stray.md', revertable: false }]);
    assert.match(error, /cannot be reverted: stray\.md/);
  });
  it('re-verifies RED when the user rules the host evidence wrong', () => {
    const fixture = createOrdinaryDriverFixture(); let redCalls = 0, offered = null;
    const base = ordinaryDriverPolicy(fixture.repo);
    const result = driveOrdinaryImplementation(fixture, { policy: {
      askUser(action) {
        if (action.question !== 'failure-disposition') return base.askUser(action);
        offered = action.text;
        return { answer: { decision: 're-verify', reason: 'The host ran the command before the tests were written.' } };
      },
      verify(action) {
        if (action.purpose === 'red' && ++redCalls === 1) return { results: action.commands.map(command => ({ command, exit: 0, evidence: 'pass 1 fail 0', identifiers: [], scopeHash: action.scopeHash, mutationEpoch: action.mutationEpoch })) };
        return base.verify(action);
      },
    } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.match(offered, /"re-verify"/);
    assert.equal(redCalls, 2);
    assert.deepEqual(rulings(readLedger(result.done.ledgerPath)).filter(([key]) => key === 'failure-disposition'), [['failure-disposition', 'inspect-first'], ['failure-disposition', 're-verify']]);
  });
  it('re-verifies a failed post-review completion and returns to code review', () => {
    const fixture = createOrdinaryDriverFixture(); let fixed = false, postReviewCalls = 0, disposition = null, codeWaves = 0, production = false;
    const base = ordinaryDriverPolicy(fixture.repo);
    const result = driveOrdinaryImplementation(fixture, { policy: {
      delegateWrite(action) { production ||= action.fields.stage === 'production'; return base.delegateWrite(action); },
      waveResults: () => allProviders(report(production && ++codeWaves === 1 ? [codeFinding({ defect: 'Missing trailing comment.' })] : [])),
      fix: () => ({ affectedPaths: ['src/app.js'], dependsOn: [], verification: ['node --test tests/sample.test.mjs'] }),
      applyFixes(action) {
        fs.appendFileSync(path.join(fixture.repo.dir, 'src/app.js'), '// fixed\n');
        fixed = true;
        return { clusters: action.clusters.map(cluster => ({ clusterId: cluster.clusterId, status: 'applied', paths: cluster.affectedPaths, note: 'edited' })) };
      },
      askUser(action) {
        if (action.question !== 'failure-disposition') return base.askUser(action);
        disposition = action.text;
        return { answer: { decision: 're-verify', reason: 'The host ran the command against a stale checkout.' } };
      },
      verify(action) {
        if (fixed && action.purpose === 'completion' && ++postReviewCalls === 1) return { results: action.commands.map(command => ({ command, exit: 1, evidence: 'pass 0 fail 1', identifiers: ['test:sample'], diagnostic: 'stale checkout', scopeHash: action.scopeHash, mutationEpoch: action.mutationEpoch })) };
        return base.verify(action);
      },
    } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.match(disposition, /rerun the completion verification|reruns the completion verification/);
    assert.equal(postReviewCalls, 2);
    assert.deepEqual(rulings(readLedger(result.done.ledgerPath)).filter(([key]) => key === 'failure-disposition').map(([, decision]) => decision), ['inspect-first', 're-verify']);
  });
});
