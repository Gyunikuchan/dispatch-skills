import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { allProviders, codeFinding, implementationOutcome, report, runDispatch } from '../../../helpers/driver-harness.mjs';
import { cleanupOrdinaryDriverFixtures, createOrdinaryDriverFixture, driveOrdinaryImplementation, FINAL_COMMAND, ordinaryDriverPolicy, withCriterionEvidence } from '../../../helpers/ordinary-driver-fixture.mjs';

afterEach(cleanupOrdinaryDriverFixtures);

const SAMPLE = 'node --test tests/sample.test.mjs', LINT = 'node scripts/lint.mjs';
const LINT_CRITERION = '- [SC3] Test file stays lint-clean.\n  - Changes: `tests/sample.test.mjs`\n  - Verify: `node scripts/lint.mjs`\n  - Evidence: verify\n  - Test rationale: A deterministic lint check needs no dedicated pre-change failure.\n\n';

/** Tier fixture: SC1 red (sample), SC2 all-[FINAL] verify, optionally SC3 verify (lint) scoped to the test file only. */
function tierFixture({ lint = false, ...options } = {}) {
  const fixture = createOrdinaryDriverFixture({ finalCommand: true, ...options });
  if (lint) fs.writeFileSync(fixture.plan, fs.readFileSync(fixture.plan, 'utf8').replace('## Proposed Changes', `${LINT_CRITERION}## Proposed Changes`));
  return fixture;
}
/** Base policy whose production outcome cites every plan criterion and whose verify replies carry judged evidence. */
function tierPolicy(fixture, overrides = {}) {
  const base = ordinaryDriverPolicy(fixture.repo);
  const ids = [...fs.readFileSync(fixture.plan, 'utf8').matchAll(/^- \[(SC\d+)\]/gm)].map(match => match[1]);
  return {
    ...base,
    delegateWrite(action) {
      if (action.fields.stage === 'tests-only') return base.delegateWrite(action);
      fs.writeFileSync(path.join(fixture.repo.dir, 'src/app.js'), 'export const value = 2;\n');
      return { raw: JSON.stringify(implementationOutcome({ evidence: ids.map(id => `CRITERION ${id} | delivered value=2 | ${id === 'SC3' ? 'tests/sample.test.mjs' : 'src/app.js'}`) })) };
    },
    // Drop the base reply's single scopeHash so each simulated record carries its own command's scope hash.
    verify: withCriterionEvidence(action => ({ results: base.verify(action).results.map(({ scopeHash, ...result }) => result) })),
    ...overrides,
  };
}
const verifies = trace => trace.filter(action => action.action === 'verify');
const handoffWalkthrough = done => fs.readFileSync(done.handoff.destinations.find(file => file.endsWith('-walkthrough.md')), 'utf8');

describe('ordinary driver verification gate tiers', () => {
  it('runs a [FINAL] command only at baseline and one final gate across a retry and an accepted fix round', () => {
    const fixture = tierFixture({ lint: true });
    let testsOnlyWrites = 0, production = false, codeWaves = 0, fixed = false;
    const policy = tierPolicy(fixture);
    const result = driveOrdinaryImplementation(fixture, { policy: {
      ...policy,
      delegateWrite(action) {
        production ||= action.fields.stage === 'production';
        // The first tests-only write claims RED without changing the test, forcing a retry.
        if (action.fields.stage === 'tests-only' && ++testsOnlyWrites === 1) return { raw: JSON.stringify(implementationOutcome({ stage: 'RED_READY', evidence: ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] })) };
        return policy.delegateWrite(action);
      },
      askUser(action) {
        if (action.question === 'failure-disposition') return { answer: { decision: 'retry', reason: 'The test was never changed.', context: 'Write the failing value=2 assertion.' } };
        return policy.askUser(action);
      },
      waveResults: () => allProviders(report(production && ++codeWaves === 1 ? [codeFinding({ defect: 'Missing trailing comment.' })] : [])),
      fix: () => ({ affectedPaths: ['src/app.js'], dependsOn: [], verification: [SAMPLE] }),
      applyFixes(action) {
        fs.appendFileSync(path.join(fixture.repo.dir, 'src/app.js'), '// fixed\n');
        fixed = true;
        return { clusters: action.clusters.map(cluster => ({ clusterId: cluster.clusterId, status: 'applied', paths: cluster.affectedPaths, note: 'edited' })) };
      },
    } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.ok(fixed, 'a code-review fix round was applied');
    const gates = verifies(result.trace), purposes = gates.map(action => action.purpose);
    assert.equal(purposes.includes('completion'), false, purposes.join(' → '));
    assert.equal(purposes.filter(purpose => purpose === 'final').length, 1, purposes.join(' → '));
    assert.equal(purposes.at(-1), 'final', 'the final gate is the last gate before handoff');
    assert.ok(purposes.filter(purpose => purpose === 'scoped').length >= 2, 'attempt and post-review gates are scoped');
    assert.deepEqual(gates.filter(action => action.commands.includes(FINAL_COMMAND)).map(action => action.purpose), ['baseline', 'final']);
    // The fix touched only src/app.js: the lint command, scoped to the test file, is skipped at the post-review gate.
    const postReview = gates.filter(action => action.purpose === 'scoped').at(-1);
    assert.ok(postReview.commands.includes(SAMPLE), JSON.stringify(postReview.commands));
    assert.equal(postReview.commands.includes(LINT), false, JSON.stringify(postReview.commands));
  });

  it('defers an all-[FINAL] criterion at scoped gates and renders its final evidence before handoff', () => {
    const fixture = tierFixture();
    const result = driveOrdinaryImplementation(fixture, { policy: tierPolicy(fixture) });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    const gates = verifies(result.trace);
    const scoped = gates.filter(action => action.purpose === 'scoped');
    assert.ok(scoped.length >= 1, gates.map(action => action.purpose).join(' → '));
    for (const action of scoped) {
      assert.equal(action.criteria.some(item => item.id === 'SC2'), false, 'SC2 is deferred to the final gate');
      assert.deepEqual(action.deferred, ['SC2'], 'scoped gates report the deferred criterion');
    }
    assert.equal(gates.find(action => action.purpose === 'final')?.deferred, undefined, 'the final gate defers nothing');
    const final = gates.find(action => action.purpose === 'final');
    assert.ok(final?.commands.includes(FINAL_COMMAND), JSON.stringify(final));
    const walkthrough = handoffWalkthrough(result.done);
    assert.match(walkthrough, /- \[SC2\] delivered value=2 — production path: `src\/app\.js`; evidence: verify;/);
    assert.doesNotMatch(walkthrough, /Pending — missing validated/);
  });

  it('does not defer a [FINAL] criterion whose covered command is carried by a scoped suite', () => {
    const fixture = tierFixture();
    const COVERED = 'node --test tests/other.test.mjs';
    fs.writeFileSync(path.join(fixture.repo.dir, 'tests/other.test.mjs'), "import { test } from 'node:test';\ntest('other', () => {});\n");
    fs.writeFileSync(path.join(fixture.repo.dir, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test tests/*.test.mjs' } }));
    fixture.repo.git('add', '.'); fixture.repo.git('commit', '--no-gpg-sign', '-qm', 'suite');
    const suiteCriterion = '- [SC3] Whole suite stays green.\n  - Changes: `tests/sample.test.mjs`\n  - Verify: `npm test`\n  - Evidence: verify\n  - Test rationale: The aggregate suite needs no dedicated pre-change failure.\n\n';
    fs.writeFileSync(fixture.plan, fs.readFileSync(fixture.plan, 'utf8').replace(`\`${FINAL_COMMAND}\` [FINAL]`, `\`${COVERED}\` [FINAL]`).replace('## Proposed Changes', `${suiteCriterion}## Proposed Changes`));
    const result = driveOrdinaryImplementation(fixture, { policy: tierPolicy(fixture) });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    const scoped = verifies(result.trace).filter(action => action.purpose === 'scoped');
    assert.ok(scoped.length >= 1);
    for (const action of scoped) {
      assert.ok(action.commands.includes('npm test'), JSON.stringify(action.commands));
      assert.ok(action.criteria.some(item => item.id === 'SC2'), 'the scoped suite carries SC2');
      assert.equal(action.deferred, undefined, 'a criterion carried by a gate command is not deferred');
    }
  });

  it('reaches the final gate and done with code review disabled', () => {
    const fixture = tierFixture({ codeReview: false });
    const result = driveOrdinaryImplementation(fixture, { policy: tierPolicy(fixture) });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    const purposes = verifies(result.trace).map(action => action.purpose);
    assert.equal(purposes.filter(purpose => purpose === 'final').length, 1, purposes.join(' → '));
    assert.equal(purposes.at(-1), 'final');
  });

  it('re-verify after a failed final gate reruns its commands', () => {
    const fixture = tierFixture();
    let finals = 0, disposition = null;
    const policy = tierPolicy(fixture);
    const result = driveOrdinaryImplementation(fixture, { policy: {
      ...policy,
      verify(action, ctx) {
        if (action.purpose === 'final' && ++finals === 1) return { results: action.commands.map(command => ({ command, exit: 1, evidence: 'pass 0 fail 1', identifiers: ['test:sample'], diagnostic: 'stale checkout' })) };
        return policy.verify(action, ctx);
      },
      askUser(action) {
        if (action.question !== 'failure-disposition') return policy.askUser(action);
        disposition = action.text;
        return { answer: { decision: 're-verify', reason: 'The host ran the command against a stale checkout.' } };
      },
    } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.match(disposition ?? '', /"re-verify"/);
    const finalGates = verifies(result.trace).filter(action => action.purpose === 'final');
    assert.equal(finalGates.length, 2);
    assert.deepEqual(finalGates[1].commands, finalGates[0].commands);
  });

  it('resumes after interruption at code review following only scoped gates and reaches the final gate', () => {
    const fixture = tierFixture(); let restarted = false;
    const result = driveOrdinaryImplementation(fixture, {
      policy: tierPolicy(fixture),
      onAction(action) {
        if (restarted || JSON.parse(fs.readFileSync(action.stateFile, 'utf8')).ordinary?.phase !== 'code-review') return;
        restarted = true;
        fs.rmSync(action.stateFile);
        const reply = runDispatch(fixture.fixture, ['--run', 'implement', '--phases', 'from:code-review', '--orchestrator', 'claude', '--', fixture.plan], { cwd: fixture.repo.dir });
        assert.equal(reply.status, 0, reply.stderr);
        const resumed = JSON.parse(reply.stdout);
        assert.notEqual(resumed.outcome, 'refused', JSON.stringify(resumed));
        Object.assign(action, resumed);
      },
    });
    assert.ok(restarted, 'the run was interrupted at code review');
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    const purposes = verifies(result.trace).map(action => action.purpose);
    assert.equal(purposes.filter(purpose => purpose === 'final').length, 1, purposes.join(' → '));
    assert.equal(purposes.at(-1), 'final');
  });

  it('hands off when a [GENERATED] path is rewritten at the final gate', () => {
    const fixture = tierFixture();
    fs.writeFileSync(path.join(fixture.repo.dir, 'gen.mjs'), "import fs from 'node:fs';\nfs.writeFileSync('gen.txt', String(Date.now()));\n");
    fixture.repo.git('add', 'gen.mjs'); fixture.repo.git('commit', '--no-gpg-sign', '-qm', 'generator');
    fs.writeFileSync(fixture.plan, fs.readFileSync(fixture.plan, 'utf8').replace('## Verification Plan', '#### [GENERATED] gen.txt\n\n- Command: `node gen.mjs`\n\n## Verification Plan'));
    const policy = tierPolicy(fixture);
    const result = driveOrdinaryImplementation(fixture, { policy: {
      ...policy,
      realVerify: true,
      delegateWrite(action) {
        if (action.fields.stage === 'tests-only') {
          fs.writeFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { value } from '../src/app.js';\ntest('sample', () => { assert.equal(value, 2); });\n");
          return { raw: JSON.stringify(implementationOutcome({ stage: 'RED_READY', evidence: ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] })) };
        }
        return policy.delegateWrite(action);
      },
      verify: withCriterionEvidence(() => undefined),
    } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    const gates = verifies(result.trace);
    assert.equal(gates.at(-1).purpose, 'final');
    assert.deepEqual(gates.at(-1).generators, ['node gen.mjs']);
    assert.ok(fs.existsSync(path.join(fixture.repo.dir, 'gen.txt')));
  });
});
