// SC5/SC6: scripted --fix review loops and their follow-ups, driven only through dispatch.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, afterEach, describe, it } from 'node:test';

import { PLAN_BODY, allProviders, assertOnlyDispatchArgv, codeFinding, drive, logEntries, planFinding, readLog, report, writePlan } from '../../../helpers/driver-harness.mjs';
import { cleanupScriptedRepos, disposeScriptedFixtures, DELEGATES, config, setup, actions, firstReview, walkthroughIn, assertSettledAndCheckpointed } from '../../../helpers/scripted-review-fixture.mjs';

afterEach(cleanupScriptedRepos);
after(disposeScriptedFixtures);

// SECTION: SC5/SC6 — --fix loops

const CODE_FIX = { affectedPaths: ['src/app.js'], dependsOn: [], verification: ['node --version'] };
const editApp = (repoDir) => (action) => {
  fs.appendFileSync(path.join(repoDir, 'src', 'app.js'), '// fixed\n');
  return { clusters: action.clusters.map((c) => ({ clusterId: c.clusterId, status: 'applied', paths: c.affectedPaths, note: 'edited' })) };
};

describe('scripted --fix reviews (SC5, SC6)', () => {
  it('code --fix: apply-fixes, verify with the union of cluster commands, then a re-review round', () => {
    const { fixture, repo } = setup(config({ rounds: 2 }), { dirty: true });
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--kind', 'code', '--fix', '--orchestrator', 'claude'],
      policy: {
        waveResults: firstReview(report([codeFinding(), codeFinding({ locus: 'src/app.js:L2', defect: 'Second defect.' })])),
        fix: () => CODE_FIX,
        applyFixes: editApp(repo.dir),
      },
    });
    assertOnlyDispatchArgv(run.argvLog);
    const seq = actions(run.trace);
    const iAdj = seq.indexOf('adjudicate');
    const iFix = seq.indexOf('apply-fixes');
    const iVerify = seq.indexOf('verify');
    assert.ok(iAdj < iFix && iFix < iVerify, seq.join(' → '));
    assert.deepEqual(run.trace[iVerify].commands, ['node --version'], 'union of cluster verification, deduplicated');
    const reReview = run.trace.slice(iVerify).find((a) => a.action === 'launch' && a.wave.type === 'review');
    assert.ok(reReview, 'green verify with changed files starts a re-review round');
    assert.equal(reReview.wave.round, 2);
    assertSettledAndCheckpointed(walkthroughIn(repo.dir), run.done, 'code');
  });

  it('plan --fix verifies with the in-process lint: no verify action and no host command', () => {
    const { fixture, repo } = setup(config({ rounds: 2 }));
    const plan = writePlan(repo.dir);
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--fix', '--orchestrator', 'claude', '--', plan],
      policy: {
        waveResults: firstReview(report([planFinding()])),
        fix: () => ({ affectedPaths: [path.relative(repo.dir, plan).split(path.sep).join('/')], dependsOn: [], verification: [] }),
        applyFixes: (action) => {
          fs.writeFileSync(plan, fs.readFileSync(plan, 'utf8').replace('- `node --test tests/sample.test.mjs`\n\n## Review', '- `node --test tests/sample.test.mjs`\n- Failure path: `node --test tests/fail.test.mjs`\n\n## Review'));
          return { clusters: action.clusters.map((c) => ({ clusterId: c.clusterId, status: 'applied', paths: c.affectedPaths, note: 'edited' })) };
        },
      },
    });
    assert.ok(actions(run.trace).includes('apply-fixes'));
    assert.ok(!actions(run.trace).includes('verify'));
    assert.ok(run.argvLog.every((argv) => argv[0] !== '<verify>'));
    assertSettledAndCheckpointed(plan, run.done, 'plan');
  });

  it('plan --fix routes lint defects to author (repair), then prepares again', () => {
    const { fixture, repo } = setup(config());
    const plan = writePlan(repo.dir, '2026-09-22-repair.md', '# Bad\n\nTODO later\n');
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--fix', '--orchestrator', 'claude', '--', plan],
      policy: {
        author: (action) => {
          assert.ok(action.defects.length > 0);
          assert.equal(path.resolve(repo.dir, action.path), plan);
          fs.writeFileSync(plan, PLAN_BODY);
          return { path: action.path };
        },
      },
    });
    assert.deepEqual(actions(run.trace).slice(0, 2), ['author', 'launch']);
    assert.equal(run.done.outcome, 'complete');
  });

  it('--fix routes needs-user rulings to ask-user', () => {
    const { fixture, repo } = setup(config({ rounds: 2 }), { dirty: true });
    let asked = null;
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--kind', 'code', '--fix', '--orchestrator', 'claude'],
      policy: {
        waveResults: firstReview(report([codeFinding()])),
        rule: () => ({ status: 'needs-user' }),
        fix: () => CODE_FIX,
        applyFixes: editApp(repo.dir),
        askUser: (action) => {
          if (action.question === 'inputs') return { answer: { summary: 's', verification: { command: 'node --version', result: 'ok' } } };
          asked = action;
          return { answer: Object.fromEntries(action.items.map((item) => [item.key, 'rejected'])) };
        },
      },
    });
    assert.ok(asked, 'needs-user ruling becomes ask-user');
    assert.equal(asked.question, 'rulings');
    assert.equal(asked.items.length, 1);
    assert.equal(run.done.outcome, 'complete');
  });

  it('--fix re-emits adjudicate when an accepted in-scope MUST has no fix.affectedPaths', () => {
    const { fixture, repo } = setup(config({ rounds: 2 }), { dirty: true });
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--kind', 'code', '--fix', '--orchestrator', 'claude'],
      policy: {
        waveResults: firstReview(report([codeFinding()])),
        fix: (finding, action) => (action.error ? CODE_FIX : null),
        applyFixes: editApp(repo.dir),
      },
    });
    const errored = run.trace.filter((a) => a.action === 'adjudicate' && a.error);
    assert.ok(errored.length >= 1, 'first reply without fix is rejected');
    assert.match(errored[0].error, /fix\.affectedPaths/);
    assert.equal(run.done.outcome, 'complete');
  });

  it('--fix defers a user-accepted needs-user finding that has no fix details, never drops it', () => {
    const { fixture, repo } = setup(config({ rounds: 2 }), { dirty: true });
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--kind', 'code', '--fix', '--orchestrator', 'claude'],
      policy: {
        waveResults: firstReview(report([codeFinding({ defect: 'needs-user defect.' })])),
        rule: () => ({ status: 'needs-user' }),
        fix: () => null,
        applyFixes: editApp(repo.dir),
        askUser: (action) => {
          if (action.question === 'inputs') return { answer: { summary: 's', verification: { command: 'node --version', result: 'ok' } } };
          return { answer: Object.fromEntries(action.items.map((item) => [item.key, 'accepted'])) };
        },
      },
    });
    const walkthrough = fs.readFileSync(walkthroughIn(repo.dir), 'utf8');
    assert.match(walkthrough, /"state":"unapplied"/);
    const followUps = walkthrough.split(/^## Follow-ups\s*$/m)[1] ?? '';
    assert.match(followUps, /needs-user defect/);
    assert.equal(run.done.outcome, 'complete');
  });

  it('adjacent opt-in: chosen items run a fresh fix loop, unchosen stay in Follow-ups', () => {
    const { fixture, repo } = setup(config({ rounds: 2 }), { dirty: true });
    let optIn = null;
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--kind', 'code', '--fix', '--orchestrator', 'claude'],
      policy: {
        waveResults: firstReview(report([
          codeFinding({ tag: 'adjacent', defect: 'adjacent-one defect.' }),
          codeFinding({ locus: 'src/app.js:L2', tag: 'adjacent', defect: 'adjacent-two defect.' }),
        ])),
        rule: () => ({ status: 'accepted', scope: 'adjacent' }),
        fix: () => CODE_FIX,
        applyFixes: editApp(repo.dir),
        askUser: (action) => {
          if (action.question === 'inputs') return { answer: { summary: 's', verification: { command: 'node --version', result: 'ok' } } };
          assert.equal(action.question, 'opt-in');
          optIn = action;
          const one = action.items.find((item) => /adjacent-one/.test(item.summary));
          return { answer: `include ${one.alias}` };
        },
      },
    });
    assert.ok(optIn);
    assert.equal(optIn.items.length, 2);
    const fixes = run.trace.filter((a) => a.action === 'apply-fixes');
    assert.equal(fixes.length, 1);
    assert.equal(fixes[0].clusters.flatMap((c) => c.findingIds).length, 1, 'only the chosen item is fixed');
    const iFix = run.trace.indexOf(fixes[0]);
    assert.ok(run.trace.slice(iFix).some((a) => a.action === 'verify'));
    assert.ok(run.trace.slice(iFix).some((a) => a.action === 'launch' && a.wave.type === 'review'), 'opt-in loop re-reviews');
    const walkthrough = fs.readFileSync(walkthroughIn(repo.dir), 'utf8');
    const followUps = walkthrough.split(/^## Follow-ups\s*$/m)[1] ?? '';
    assert.match(followUps, /adjacent-two/);
    assert.doesNotMatch(followUps, /adjacent-one/);
    assert.equal(run.done.outcome, 'complete');
  });

  it('two identical verify failures stop the cluster and defer it as unapplied', () => {
    const { fixture, repo } = setup(config({ rounds: 3 }), { dirty: true });
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--kind', 'code', '--fix', '--orchestrator', 'claude'],
      policy: {
        waveResults: firstReview(report([codeFinding()])),
        fix: () => CODE_FIX,
        applyFixes: editApp(repo.dir),
        verify: (action) => ({ results: action.commands.map((command) => ({ command, exit: 1, evidence: 'same failure: value mismatch' })) }),
      },
    });
    assert.equal(run.trace.filter((a) => a.action === 'verify').length, 2, 'stops after the second identical failure');
    const walkthroughPath = walkthroughIn(repo.dir);
    const deferred = logEntries(walkthroughPath).find((entry) => entry.application);
    assert.ok(deferred, 'an application record is written');
    assert.equal(deferred.application.state, 'unapplied');
    assert.match(deferred.application.reason, /same failure/);
    assert.match(fs.readFileSync(walkthroughPath, 'utf8'), /^## Follow-ups\s*$/m);
    assert.equal(run.done.outcome, 'complete');
  });
});

// SECTION: follow-ups (R1-F009, R3-F004)

describe('scripted follow-ups', () => {
  it('R1-F009: a delegate that exits 0 with an invalid non-prose report goes to native-fallback', () => {
    const { fixture, repo } = setup(config({}, { agy: DELEGATES.agy }));
    const plan = writePlan(repo.dir);
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--orchestrator', 'agy', '--', plan],
      policy: {
        // Parses as JSON with no restatable content: an `invalid-report`, not `prose-report`.
        waveResults: () => allProviders('{"status":"BOGUS"}'),
        nativeFallback: (action) => {
          fs.writeFileSync(action.outputPath, report([planFinding({ defect: 'fallback-after-invalid defect.' })]));
          return { slot: action.slot, captured: true, actual: {
            agentType: action.descriptor.agentType,
            model: action.descriptor.model,
            reasoningEffort: action.descriptor.reasoningEffort,
          } };
        },
      },
    });
    const fallback = run.trace.find((a) => a.action === 'native-fallback');
    assert.ok(fallback, 'the invalid report routes its slot to native-fallback');
    assert.match(fallback.slot, /^plan-review:R1:agy:0$/);
    const adjudicate = run.trace.find((a) => a.action === 'adjudicate');
    assert.ok(adjudicate.findings.every((f) => !f.restate), 'an invalid (non-prose) report is never restated');
    assert.ok(adjudicate.findings.some((f) => /fallback-after-invalid/.test(f.defect)));
    const [round] = readLog(plan).rounds;
    const entries = Object.entries(round.sourceMap).filter(([key]) => key === fallback.slot);
    assert.equal(entries.length, 1, 'one Sources entry for the slot');
    assert.equal(entries[0][1].status, 'fallback', 'the invalid delegate report is replaced by the fallback record');
    assert.ok(!Object.values(round.sourceMap).some((source) => source.status === 'target'), 'the invalid report is not recorded as a target source');
    assertSettledAndCheckpointed(plan, run.done, 'plan');
  });

  it('R3-F004: --run --fix resumes pending fixes after state loss between adjudicate and apply-fixes', () => {
    const { fixture, repo } = setup(config({ rounds: 2 }), { dirty: true });
    const runArgs = ['review', '--kind', 'code', '--fix', '--orchestrator', 'claude'];
    const STOP = new Error('stop before apply-fixes');
    let lost = null;
    try {
      drive(fixture, {
        cwd: repo.dir,
        runArgs,
        policy: { waveResults: firstReview(report([codeFinding()])), fix: () => CODE_FIX },
        onAction: (action) => {
          if (action.action === 'apply-fixes') { lost = action; throw STOP; }
        },
      });
    } catch (err) {
      if (err !== STOP) throw err;
    }
    assert.ok(lost, 'the first run reached apply-fixes');
    const walkthrough = walkthroughIn(repo.dir);
    const [settled] = logEntries(walkthrough);
    assert.equal(settled.status, 'accepted', 'adjudicate was settled into the log');
    assert.equal(settled.application?.state, 'unapplied', 'the queued fix is marked pending in the log');
    fs.rmSync(lost.stateFile);

    // The pending record carries the real fix metadata, so the resume applies exactly that fix.
    const resumed = drive(fixture, {
      cwd: repo.dir,
      runArgs,
      policy: { applyFixes: editApp(repo.dir) },
    });
    const seq = actions(resumed.trace);
    assert.equal(seq[0], 'apply-fixes', `resume emits apply-fixes before any wave: ${seq.join(' → ')}`);
    const [cluster] = resumed.trace[0].clusters;
    assert.equal(resumed.trace[0].clusters.length, 1);
    assert.equal(cluster.findingIds.length, 1);
    assert.deepEqual(cluster.affectedPaths, CODE_FIX.affectedPaths);
    assert.deepEqual(cluster.verification, CODE_FIX.verification);
    assert.match(fs.readFileSync(path.join(repo.dir, 'src', 'app.js'), 'utf8'), /\/\/ fixed/);
    assert.equal(resumed.done.outcome, 'complete');
    assert.equal(logEntries(walkthrough)[0].application?.state, 'applied');

    // A second --fix run never re-applies a finished fix.
    const again = drive(fixture, { cwd: repo.dir, runArgs, policy: { applyFixes: editApp(repo.dir) } });
    assert.notEqual(actions(again.trace)[0], 'apply-fixes', 'applied fixes are not re-derived');
  });

  it('R4: --fix over a report-only settled log starts a fresh review, never re-applies stale findings', () => {
    const { fixture, repo } = setup(config({ rounds: 2 }), { dirty: true });
    drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--kind', 'code', '--orchestrator', 'claude'],
      policy: { waveResults: firstReview(report([codeFinding()])) },
    });
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--kind', 'code', '--fix', '--orchestrator', 'claude'],
      policy: { fix: () => CODE_FIX, applyFixes: editApp(repo.dir) },
    });
    assert.equal(actions(run.trace)[0], 'launch', 'a report-only round has no pending records to resume');
  });

  it('R4: an adjacent-scope ruling with a non-adjacent tag is re-offered after state loss, never applied as in-scope', () => {
    const { fixture, repo } = setup(config({ rounds: 2 }), { dirty: true });
    const runArgs = ['review', '--kind', 'code', '--fix', '--orchestrator', 'claude'];
    const STOP = new Error('stop at opt-in');
    let lost = null;
    try {
      drive(fixture, {
        cwd: repo.dir,
        runArgs,
        policy: {
          waveResults: firstReview(report([codeFinding({ defect: 'scope-adjacent defect.' })])),
          rule: () => ({ status: 'accepted', scope: 'adjacent' }),
          fix: () => CODE_FIX,
        },
        onAction: (action) => {
          if (action.action === 'ask-user' && action.question === 'opt-in') { lost = action; throw STOP; }
        },
      });
    } catch (err) {
      if (err !== STOP) throw err;
    }
    assert.ok(lost, 'the first run reached the opt-in');
    fs.rmSync(lost.stateFile);
    let reoffered = null;
    const resumed = drive(fixture, {
      cwd: repo.dir,
      runArgs,
      policy: {
        applyFixes: editApp(repo.dir),
        askUser: (action) => { reoffered = action; return { answer: 'none' }; },
      },
    });
    assert.ok(!resumed.trace.some((a) => a.action === 'apply-fixes'), 'never applied as in-scope');
    assert.equal(reoffered?.question, 'opt-in', 'the adjacent item is re-offered');
    assert.equal(logEntries(walkthroughIn(repo.dir))[0].application?.reason, 'adjacent; declined in opt-in');
  });

  it('R5: a mixed pending + adjacent resume applies the in-scope fix, then re-offers the adjacent item', () => {
    const { fixture, repo } = setup(config({ rounds: 2 }), { dirty: true });
    const runArgs = ['review', '--kind', 'code', '--fix', '--orchestrator', 'claude'];
    const STOP = new Error('stop before apply-fixes');
    let lost = null;
    try {
      drive(fixture, {
        cwd: repo.dir,
        runArgs,
        policy: {
          waveResults: firstReview(report([
            codeFinding({ defect: 'in-scope defect.' }),
            codeFinding({ locus: 'src/app.js:L2', defect: 'scope-adjacent defect.' }),
          ])),
          rule: (finding) => ({ status: 'accepted', scope: /scope-adjacent/.test(JSON.stringify(finding)) ? 'adjacent' : 'in-scope' }),
          fix: () => CODE_FIX,
        },
        onAction: (action) => {
          if (action.action === 'apply-fixes') { lost = action; throw STOP; }
        },
      });
    } catch (err) {
      if (err !== STOP) throw err;
    }
    assert.ok(lost, 'the first run reached apply-fixes');
    fs.rmSync(lost.stateFile);
    let reoffered = null;
    const resumed = drive(fixture, {
      cwd: repo.dir,
      runArgs,
      policy: {
        applyFixes: editApp(repo.dir),
        askUser: (action) => { reoffered = action; return { answer: 'none' }; },
      },
    });
    const entries = logEntries(walkthroughIn(repo.dir));
    const inScope = entries.find((e) => /in-scope defect/.test(e.originalLine));
    const adjacent = entries.find((e) => /scope-adjacent defect/.test(e.originalLine));
    const appliedIds = resumed.trace.filter((a) => a.action === 'apply-fixes').flatMap((a) => a.clusters.flatMap((c) => c.findingIds));
    assert.equal(actions(resumed.trace)[0], 'apply-fixes');
    assert.deepEqual(appliedIds, [inScope.id], 'only the in-scope fix is applied');
    assert.equal(reoffered?.question, 'opt-in', 'the adjacent item is re-offered');
    assert.equal(inScope.application?.state, 'applied');
    assert.equal(adjacent.application?.reason, 'adjacent; declined in opt-in');
  });
});
