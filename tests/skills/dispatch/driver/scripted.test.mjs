// SC4–SC6: scripted-agent replays of standalone reviews driven only through dispatch.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, afterEach, describe, it } from 'node:test';

import { planSnapshot } from '../../../../skills/dispatch/scripts/review/prepare.mjs';
import { splitDispatchFrontmatter } from '../../../../skills/dispatch/scripts/review/resolution-log.mjs';
import { allProviders, assertOnlyDispatchArgv, codeFinding, designFinding, drive, logEntries, parseAction, planFinding, readBatchFile, readLog, rebuttal, report, runDispatch, runLaunch, writeDesign, writePlan } from '../../../helpers/driver-harness.mjs';
import { cleanupScriptedRepos, disposeScriptedFixtures, DELEGATES, config, setup, actions, launches, firstReview, walkthroughIn, assertSettledAndCheckpointed } from '../../../helpers/scripted-review-fixture.mjs';

afterEach(cleanupScriptedRepos);
after(disposeScriptedFixtures);

// SECTION: SC4 — the three kinds, report-only

describe('scripted standalone reviews, report-only (SC4, SC6)', () => {
  it('review plan completes with only dispatch.mjs invocations', () => {
    const { fixture, repo } = setup(config());
    const plan = writePlan(repo.dir);
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--orchestrator', 'claude', '--', plan],
      policy: { waveResults: firstReview(report([planFinding()])) },
    });
    assertOnlyDispatchArgv(run.argvLog);
    assert.ok(run.argvLog.every((argv) => argv[0] !== '<verify>'), 'report-only plan review runs no host command');
    assertSettledAndCheckpointed(plan, run.done, 'plan');
    const entries = logEntries(plan);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, 'accepted');
    assert.ok(!actions(run.trace).includes('apply-fixes'));
    assert.ok(!actions(run.trace).includes('author'));
    const adjudicate = run.trace.find((a) => a.action === 'adjudicate');
    assert.ok(adjudicate.guidance.some((line) => /verify/i.test(line)), 'adjudicate guidance carries the verify-then-rule hint');
  });

  it('review design completes with only dispatch.mjs invocations', () => {
    const { fixture, repo } = setup(config());
    const design = writeDesign(repo.dir);
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--orchestrator', 'claude', '--', design],
      policy: { waveResults: firstReview(report([designFinding()])) },
    });
    assertOnlyDispatchArgv(run.argvLog);
    assertSettledAndCheckpointed(design, run.done, 'design');
    assert.ok(!actions(run.trace).some((a) => a === 'apply-fixes' || a === 'author'));
  });

  it('review code (no argument) asks for walkthrough inputs, then completes report-only', () => {
    const { fixture, repo } = setup(config(), { dirty: true });
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--orchestrator', 'claude'],
      policy: { waveResults: firstReview(report([codeFinding()])) },
    });
    assertOnlyDispatchArgv(run.argvLog);
    const inputs = run.trace.find((a) => a.action === 'ask-user');
    assert.equal(inputs.question, 'inputs');
    assert.ok(inputs.missing.includes('summary'));
    assert.equal(run.trace[run.trace.indexOf(inputs) + 1].action, 'launch', 're-prepares then launches');
    const walkthrough = walkthroughIn(repo.dir);
    assertSettledAndCheckpointed(walkthrough, run.done, 'code');
    assert.ok(!actions(run.trace).some((a) => a === 'apply-fixes' || a === 'author'));
    assert.equal(fs.readFileSync(path.join(repo.dir, 'src', 'app.js'), 'utf8'), 'export const value = 2;\n', 'report-only never edits');
  });

  it('report-only lint failure ends in done with the defects and never emits author', () => {
    const { fixture, repo } = setup(config());
    const plan = writePlan(repo.dir, '2026-09-22-bad.md', '# Bad\n\nTODO later\n');
    const run = drive(fixture, { cwd: repo.dir, runArgs: ['review', '--orchestrator', 'claude', '--', plan] });
    assert.deepEqual(actions(run.trace), ['done']);
    assert.equal(run.done.outcome, 'lint-defects');
    assert.ok(run.done.defects.some(({ rule }) => rule === 'proposed-changes'));
  });
});

// SECTION: SC5 — paths

describe('scripted review paths (SC5)', () => {
  it('rebuttal wave: CONFIRM settles, REBUT stays live, INTENT-DISPUTE becomes disputed; cap asks then runs one final wave', () => {
    const { fixture, repo } = setup(config({ consensus: true, rounds: 1 }));
    const plan = writePlan(repo.dir);
    const findings = [
      planFinding({ locus: '§ Success Criteria', defect: 'alpha-confirm defect.' }),
      planFinding({ locus: '§ Proposed Changes', tag: 'spec-gap', defect: 'beta-rebut defect.' }),
      planFinding({ locus: '§ Verification Plan', defect: 'gamma-dispute defect.' }),
    ];
    const verdictFor = (line) => (line.includes('alpha') ? 'CONFIRM' : line.includes('beta') ? 'REBUT' : 'INTENT-DISPUTE');
    let snapshotAtCap = null;
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--orchestrator', 'claude', '--', plan],
      policy: {
        rule: () => ({ status: 'rejected' }),
        waveResults: (action) => {
          if (action.wave.type === 'rebuttal') {
            const byKey = new Map(logEntries(plan).map((entry) => [entry.key, entry]));
            assert.ok(action.keys.length === 3, 'rebuttal wave lists the three pending keys');
            return allProviders(rebuttal(action.keys.map((key) => [key, verdictFor(byKey.get(key).originalLine)])));
          }
          return firstReview(report(findings))(action);
        },
        askUser: (action) => {
          assert.equal(action.question, 'rulings');
          snapshotAtCap = { items: action.items, entries: logEntries(plan) };
          return { answer: Object.fromEntries(action.items.map((item) => [item.key, 'accepted'])) };
        },
      },
    });
    assertOnlyDispatchArgv(run.argvLog);
    const rebuttalWave = launches(run.trace, 'rebuttal')[0];
    assert.ok(rebuttalWave, 'a rebuttal wave ran');
    assert.ok(rebuttalWave.guidance.some((line) => /CONFIRM/.test(line) && /REBUT/.test(line) && /INTENT-DISPUTE/.test(line)));

    assert.ok(snapshotAtCap, 'the round cap sends live items to ask-user');
    const status = (word) => snapshotAtCap.entries.find((entry) => entry.originalLine.includes(word)).status;
    assert.equal(status('alpha'), 'rejected', 'CONFIRM settles the rejection');
    assert.equal(status('beta'), 'pendingConfirmation', 'REBUT stays live');
    assert.equal(status('gamma'), 'disputed', 'INTENT-DISPUTE becomes disputed');
    const liveKeys = snapshotAtCap.items.map((item) => item.key).sort();
    const expected = snapshotAtCap.entries.filter((e) => !e.originalLine.includes('alpha')).map((e) => e.key).sort();
    assert.deepEqual(liveKeys, expected);

    const askIndex = run.trace.findIndex((a) => a.action === 'ask-user');
    const finals = launches(run.trace, 'final');
    assert.equal(finals.length, 1, 'exactly one final verification wave');
    assert.ok(run.trace.indexOf(finals[0]) > askIndex);
    assertSettledAndCheckpointed(plan, run.done, 'plan');
  });

  it('rejects extend on a non-cap ask-user without advancing state', () => {
    const { fixture, repo } = setup(config(), { dirty: true });
    const first = runDispatch(fixture, ['--run', 'review', '--orchestrator', 'claude'], { cwd: repo.dir });
    assert.equal(first.status, 0);
    const pending = parseAction(first.stdout);
    assert.equal(pending.question, 'inputs');
    const invalid = runDispatch(fixture, ['--next', '--state', pending.stateFile, '--input', '{"extend":true}'], { cwd: repo.dir });
    assert.equal(invalid.status, 0);
    const repeated = parseAction(invalid.stdout);
    assert.equal(repeated.action, 'ask-user');
    assert.equal(repeated.question, 'inputs');
    assert.match(repeated.error, /extend is only available at the round cap/);
    assert.equal(JSON.parse(fs.readFileSync(pending.stateFile, 'utf8')).pending.question, 'inputs');
  });

  it('report-only accepted MUST reaches the cap and requires a stop or extension decision', () => {
    const { fixture, repo } = setup(config({ rounds: 1 }));
    const plan = writePlan(repo.dir);
    const run = drive(fixture, {
      cwd: repo.dir, runArgs: ['review', '--orchestrator', 'claude', '--', plan],
      policy: {
        waveResults: firstReview(report([planFinding()])),
        askUser: (action) => {
          assert.deepEqual(action.items, []);
          return { stop: true };
        },
      },
    });
    assert.deepEqual(launches(run.trace, 'review').map((action) => action.wave.round), [1]);
    assert.equal(run.trace.filter((action) => action.action === 'ask-user').length, 1);
    assert.equal(launches(run.trace, 'final').length, 1);
    assertSettledAndCheckpointed(plan, run.done, 'plan');
  });

  it('continues SHOULD inside the initial cap, then settles on a clean round', () => {
    const { fixture, repo } = setup(config({ rounds: 3 }));
    const plan = writePlan(repo.dir);
    const run = drive(fixture, {
      cwd: repo.dir, runArgs: ['review', '--orchestrator', 'claude', '--', plan],
      policy: { waveResults: (action) => allProviders(report(action.wave.round === 1 ? [planFinding({ severity: 'SHOULD' })] : [])) },
    });
    assert.deepEqual(launches(run.trace, 'review').map((action) => action.wave.round), [1, 2]);
    assert.ok(!run.trace.some((action) => action.action === 'ask-user'));
    assertSettledAndCheckpointed(plan, run.done, 'plan');
  });

  it('CONSIDER alone ends at any count without prompting', () => {
    const { fixture, repo } = setup(config({ rounds: 3 }));
    const plan = writePlan(repo.dir);
    const run = drive(fixture, {
      cwd: repo.dir, runArgs: ['review', '--orchestrator', 'claude', '--', plan],
      policy: { waveResults: () => allProviders(report([planFinding({ severity: 'CONSIDER' })])) },
    });
    assert.deepEqual(launches(run.trace, 'review').map((action) => action.wave.round), [1]);
    assert.ok(!run.trace.some((action) => action.action === 'ask-user'));
    assertSettledAndCheckpointed(plan, run.done, 'plan');
  });

  it('extends twice at cap-sized increments; SHOULD in extension ends without prompting', () => {
    const { fixture, repo } = setup(config({ rounds: 3 }));
    const plan = writePlan(repo.dir);
    const prompts = [];
    const run = drive(fixture, {
      cwd: repo.dir, runArgs: ['review', '--orchestrator', 'claude', '--', plan], maxSteps: 140,
      policy: {
        waveResults: (action) => allProviders(report(action.wave.round <= 6
          ? [planFinding({ defect: `Must at round ${action.wave.round}.` }), planFinding({ severity: 'SHOULD', defect: 'Also should.' }), planFinding({ severity: 'CONSIDER', defect: 'Also consider.' })]
          : [planFinding({ severity: 'SHOULD', defect: 'Should after extension.' })])),
        askUser: (action) => {
          prompts.push(action);
          assert.equal(action.question, 'rulings');
          assert.deepEqual(action.options, ['extend', 'stop']);
          assert.deepEqual(action.counts, { MUST: 1, SHOULD: 1, CONSIDER: 1 });
          return { extend: true };
        },
      },
    });
    assert.equal(prompts.length, 2);
    assert.deepEqual(launches(run.trace, 'review').map((action) => action.wave.round), [1, 2, 3, 4, 5, 6, 7]);
    assertSettledAndCheckpointed(plan, run.done, 'plan');
  });

  it('requires rulings for disputed SHOULD without an extension prompt', () => {
    const { fixture, repo } = setup(config({ consensus: true, rounds: 1 }));
    const plan = writePlan(repo.dir);
    const run = drive(fixture, {
      cwd: repo.dir, runArgs: ['review', '--orchestrator', 'claude', '--', plan],
      policy: {
        rule: () => ({ status: 'rejected' }),
        waveResults: (action) => action.wave.type === 'rebuttal'
          ? allProviders(rebuttal(action.keys.map((key) => [key, 'INTENT-DISPUTE'])))
          : allProviders(report(action.wave.type === 'review' ? [planFinding({ severity: 'SHOULD' })] : [])),
        askUser: (action) => {
          assert.deepEqual(action.counts, { MUST: 0, SHOULD: 1, CONSIDER: 0 });
          assert.ok(!action.options?.includes('extend'));
          return { answer: Object.fromEntries(action.items.map((item) => [item.key, 'accepted'])) };
        },
      },
    });
    assert.equal(run.trace.filter((action) => action.action === 'ask-user').length, 1);
    assertSettledAndCheckpointed(plan, run.done, 'plan');
  });

  it('stop option leads to required rulings for unresolved MUST', () => {
    const { fixture, repo } = setup(config({ consensus: true, rounds: 1 }));
    const plan = writePlan(repo.dir);
    const run = drive(fixture, {
      cwd: repo.dir, runArgs: ['review', '--orchestrator', 'claude', '--', plan],
      policy: {
        rule: () => ({ status: 'rejected' }),
        waveResults: (action) => action.wave.type === 'rebuttal'
          ? allProviders(rebuttal(action.keys.map((key) => [key, 'REBUT'])))
          : allProviders(report(action.wave.type === 'review' ? [planFinding()] : [])),
        askUser: (action) => action.options?.includes('stop')
          ? { stop: true }
          : { answer: Object.fromEntries(action.items.map((item) => [item.key, 'rejected'])) },
      },
    });
    assert.equal(run.trace.filter((action) => action.action === 'ask-user').length, 2);
    assert.equal(launches(run.trace, 'final').length, 1);
    assertSettledAndCheckpointed(plan, run.done, 'plan');
  });

  it('reports open severity counts for mixed pending cap findings', () => {
    const { fixture, repo } = setup(config({ consensus: true, rounds: 1 }));
    const plan = writePlan(repo.dir);
    const run = drive(fixture, {
      cwd: repo.dir, runArgs: ['review', '--orchestrator', 'claude', '--', plan],
      policy: {
        rule: () => ({ status: 'rejected' }),
        waveResults: (action) => action.wave.type === 'rebuttal'
          ? allProviders(rebuttal(action.keys.map((key) => [key, 'REBUT'])))
          : allProviders(report(action.wave.type === 'review' ? [planFinding(), planFinding({ severity: 'SHOULD', defect: 'Should remain pending.' })] : [])),
        askUser: (action) => {
          assert.deepEqual(action.counts, { MUST: 1, SHOULD: 1, CONSIDER: 0 });
          assert.match(action.text, /1 MUST \/ 1 SHOULD \/ 0 CONSIDER/);
          return { answer: Object.fromEntries(action.items.map((item) => [item.key, 'rejected'])) };
        },
      },
    });
    assertSettledAndCheckpointed(plan, run.done, 'plan');
  });

  it('stop under --fix records user-accepted unresolved finding as unapplied', () => {
    const { fixture, repo } = setup(config({ consensus: true, rounds: 1 }));
    const plan = writePlan(repo.dir);
    const run = drive(fixture, {
      cwd: repo.dir, runArgs: ['review', '--kind', 'plan', '--fix', '--orchestrator', 'claude', '--', plan],
      policy: {
        rule: () => ({ status: 'rejected' }),
        waveResults: (action) => action.wave.type === 'rebuttal'
          ? allProviders(rebuttal(action.keys.map((key) => [key, 'REBUT'])))
          : allProviders(report(action.wave.type === 'review' ? [planFinding()] : [])),
        askUser: (action) => ({ answer: Object.fromEntries(action.items.map((item) => [item.key, 'accepted'])) }),
      },
    });
    assertSettledAndCheckpointed(plan, run.done, 'plan');
    const entry = logEntries(plan)[0];
    assert.equal(entry.status, 'accepted');
    assert.equal(entry.application?.state, 'unapplied');
    assert.match(entry.application?.reason ?? '', /accepted at round cap/);
  });

  it('stop at cap rules live findings then executes exactly one final wave', () => {
    const { fixture, repo } = setup(config({ consensus: true, rounds: 1 }));
    const plan = writePlan(repo.dir);
    const run = drive(fixture, {
      cwd: repo.dir, runArgs: ['review', '--orchestrator', 'claude', '--', plan],
      policy: {
        rule: () => ({ status: 'rejected' }),
        waveResults: (action) => action.wave.type === 'rebuttal'
          ? allProviders(rebuttal(action.keys.map((key) => [key, 'REBUT'])))
          : allProviders(report(action.wave.type === 'review' ? [planFinding()] : [])),
        askUser: (action) => ({ answer: Object.fromEntries(action.items.map((item) => [item.key, 'accepted'])) }),
      },
    });
    assert.equal(run.trace.filter((action) => action.action === 'ask-user').length, 1);
    assert.equal(launches(run.trace, 'final').length, 1);
    assertSettledAndCheckpointed(plan, run.done, 'plan');
  });

  it('persists the extended limit in state before the next wave', () => {
    const { fixture, repo } = setup(config({ rounds: 3 }));
    const plan = writePlan(repo.dir);
    let savedLimit;
    const run = drive(fixture, {
      cwd: repo.dir, runArgs: ['review', '--orchestrator', 'claude', '--', plan], maxSteps: 120,
      onAction: (action) => {
        if (action.action === 'launch' && action.wave.round === 4) {
          savedLimit = JSON.parse(fs.readFileSync(action.stateFile, 'utf8')).roundLimit;
        }
      },
      policy: {
        waveResults: (action) => allProviders(report(action.wave.round <= 3 ? [planFinding()] : [])),
        askUser: () => ({ extend: true }),
      },
    });
    assert.equal(savedLimit, 6);
    assert.deepEqual(launches(run.trace, 'review').map((action) => action.wave.round), [1, 2, 3, 4]);
    assertSettledAndCheckpointed(plan, run.done, 'plan');
  });

  it('captures a same-platform fallback started during the wave without requesting it again', () => {
    const { fixture, repo } = setup(config({}, { claude: { targets: [{ low: { model: 'claude-opus-5', effort: 'medium' } }] } }));
    const plan = writePlan(repo.dir);
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--orchestrator', 'claude', '--', plan],
      policy: {
        waveResults: () => allProviders('', { exit: 1, failureKind: 'quota' }),
        launchReply: (action) => {
          assert.equal(action.earlyFallbacks.length, 1);
          assert.ok(action.guidance.some((line) => /--slots/i.test(line)));
          assert.ok(action.guidance.some((line) => /do not poll again/i.test(line)));
          const [fallback] = action.earlyFallbacks;
          fs.writeFileSync(fallback.outputPath, report([planFinding({ defect: 'early-fallback defect.' })]));
          return { earlyFallbacks: [{
            slot: fallback.slot,
            outputPath: fallback.outputPath,
            captured: true,
            actual: {
              agentType: fallback.descriptor.agentType,
              model: fallback.descriptor.model,
              reasoningEffort: fallback.descriptor.reasoningEffort,
            },
          }] };
        },
      },
    });
    assert.equal(run.trace.some((action) => action.action === 'native-fallback'), false);
    assert.ok(run.trace.find((action) => action.action === 'adjudicate').findings.some((finding) => /early-fallback/.test(finding.defect)));
    assert.ok(Object.values(readLog(plan).rounds[0].sourceMap).some((source) => source.status === 'fallback'));
    assertSettledAndCheckpointed(plan, run.done, 'plan');
  });

  it('re-requests only corrected early fallback metadata without relaunching the wave', () => {
    const { fixture, repo } = setup(config({}, { claude: { targets: [{ low: { model: 'claude-opus-5', effort: 'medium' } }] } }));
    const plan = writePlan(repo.dir);
    let replies = 0;
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--orchestrator', 'claude', '--', plan],
      policy: {
        waveResults: () => allProviders('', { exit: 1, failureKind: 'quota' }),
        launchReply: (action) => {
          const [fallback] = action.earlyFallbacks;
          fs.writeFileSync(fallback.outputPath, report());
          replies++;
          return { earlyFallbacks: [{ slot: fallback.slot, outputPath: fallback.outputPath, captured: true, actual: {
            agentType: fallback.descriptor.agentType,
            model: fallback.descriptor.model,
            reasoningEffort: replies === 1 ? 'wrong' : fallback.descriptor.reasoningEffort,
          } }] };
        },
      },
    });
    assert.equal(launches(run.trace).length, 2);
    assert.match(launches(run.trace)[1].guidance[0], /do not rerun argv/i);
    assert.equal(run.argvLog.filter((argv) => argv.includes('--batch-file')).length, 1);
  });

  it('queues an empty early capture for ordinary post-wave fallback', () => {
    const { fixture, repo } = setup(config({}, { claude: { targets: [{ low: { model: 'claude-opus-5', effort: 'medium' } }] } }));
    const plan = writePlan(repo.dir);
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--orchestrator', 'claude', '--', plan],
      policy: {
        waveResults: () => allProviders('', { exit: 1, failureKind: 'quota' }),
        launchReply: (action) => {
          const [fallback] = action.earlyFallbacks;
          return { earlyFallbacks: [{ slot: fallback.slot, outputPath: fallback.outputPath, captured: true, actual: {
            agentType: fallback.descriptor.agentType, model: fallback.descriptor.model, reasoningEffort: fallback.descriptor.reasoningEffort,
          } }] };
        },
      },
    });
    assert.ok(run.trace.some((action) => action.action === 'native-fallback'));
    assert.equal(run.done.outcome, 'complete');
  });

  it('rejects an early fallback claimed for a successful slot', () => {
    const { fixture, repo } = setup(config({}, { claude: { targets: [{ low: { model: 'claude-opus-5', effort: 'medium' } }] } }));
    const plan = writePlan(repo.dir);
    let replies = 0;
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--orchestrator', 'claude', '--', plan],
      policy: {
        launchReply: (action) => {
          replies++;
          if (replies > 1) return { earlyFallbacks: [] };
          const [fallback] = action.earlyFallbacks;
          fs.writeFileSync(fallback.outputPath, report());
          return { earlyFallbacks: [{ slot: fallback.slot, outputPath: fallback.outputPath, captured: true, actual: {
            agentType: fallback.descriptor.agentType, model: fallback.descriptor.model, reasoningEffort: fallback.descriptor.reasoningEffort,
          } }] };
        },
      },
    });
    assert.match(launches(run.trace)[1].error, /failed-slot identity/);
    assert.equal(run.argvLog.filter((argv) => argv.includes('--batch-file')).length, 1);
    assert.equal(run.done.outcome, 'complete');
  });

  it('native fallback: an unresolved slot with no reserve goes to native-fallback and is re-read', () => {
    const { fixture, repo } = setup(config({}, { agy: DELEGATES.agy }));
    const plan = writePlan(repo.dir);
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--orchestrator', 'agy', '--', plan],
      policy: {
        waveResults: () => allProviders('', { exit: 1, failureKind: 'quota' }),
        nativeFallback: (action) => {
          assert.ok(fs.existsSync(action.promptPath), 'fallback names the slot prompt');
          assert.ok(action.guidance.some((line) => /read promptPath in full and follow it as the authoritative instructions/i.test(line)));
          assert.deepEqual(action.descriptor, {
            sourceKey: action.slot,
            agentType: 'research',
            model: 'gemini-3.7-flash',
            reasoningEffort: 'medium',
            substitutesFor: null,
            cascadePosition: 0,
            modelCascade: ['gemini-3.7-flash'],
          });
          fs.writeFileSync(action.outputPath, report([planFinding({ defect: 'fallback-found defect.' })]));
          return { slot: action.slot, captured: true, actual: {
            agentType: action.descriptor.agentType,
            model: action.descriptor.model,
            reasoningEffort: action.descriptor.reasoningEffort,
          } };
        },
      },
    });
    const fallback = run.trace.find((a) => a.action === 'native-fallback');
    assert.ok(fallback);
    assert.match(fallback.slot, /^plan-review:R1:agy:0$/);
    const adjudicate = run.trace.find((a) => a.action === 'adjudicate');
    assert.ok(adjudicate.findings.some((f) => /fallback-found/.test(f.defect)));
    const [round] = readLog(plan).rounds;
    assert.ok(Object.values(round.sourceMap).some((source) => source.status === 'fallback'));
    assertSettledAndCheckpointed(plan, run.done, 'plan');
  });

  it('native fallback rejects actual model or effort drift and re-emits the same action', () => {
    const { fixture, repo } = setup(config({}, { agy: DELEGATES.agy }));
    const plan = writePlan(repo.dir);
    let attempts = 0;
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--orchestrator', 'agy', '--', plan],
      policy: {
        waveResults: () => allProviders('', { exit: 1, failureKind: 'quota' }),
        nativeFallback: (action) => {
          fs.writeFileSync(action.outputPath, report());
          attempts++;
          return { slot: action.slot, captured: true, actual: {
            agentType: action.descriptor.agentType,
            model: action.descriptor.model,
            reasoningEffort: attempts === 1 ? 'wrong-effort' : action.descriptor.reasoningEffort,
          } };
        },
      },
    });
    const fallbacks = run.trace.filter((action) => action.action === 'native-fallback');
    assert.equal(fallbacks.length, 2);
    assert.match(fallbacks[1].error, /must match the descriptor exactly/);
    assert.equal(run.done.outcome, 'complete');
  });

  it('native fallback preserves two distinct configured model and effort descriptors', () => {
    const delegates = {
      agy: { targets: [{ low: { model: 'gemini-3.7-flash', effort: 'medium' } }, { low: { model: 'gemini-3.7-pro', effort: 'high' } }] },
    };
    const { fixture, repo } = setup(config({ targets: 2 }, delegates));
    const plan = writePlan(repo.dir);
    const seen = [];
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--orchestrator', 'agy', '--', plan],
      policy: {
        waveResults: () => allProviders('', { exit: 1, failureKind: 'quota' }),
        nativeFallback: (action) => {
          seen.push(action.descriptor);
          fs.writeFileSync(action.outputPath, report());
          return { slot: action.slot, captured: true, actual: {
            agentType: action.descriptor.agentType,
            model: action.descriptor.model,
            reasoningEffort: action.descriptor.reasoningEffort,
          } };
        },
      },
    });
    assert.deepEqual(seen.map(({ agentType, model, reasoningEffort }) => ({ agentType, model, reasoningEffort })), [
      { agentType: 'research', model: 'gemini-3.7-flash', reasoningEffort: 'medium' },
      { agentType: 'research', model: 'gemini-3.7-pro', reasoningEffort: 'high' },
    ]);
    assert.equal(run.done.outcome, 'complete');
  });

  it('reserve replacement: a failed target is replaced by the next reserve in the same wave', () => {
    const { fixture, repo } = setup(config());
    const plan = writePlan(repo.dir);
    let failed = null;
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--orchestrator', 'claude', '--', plan],
      onAction: (action) => {
        if (action.action === 'launch' && !failed) {
          const batch = readBatchFile(action.argv);
          assert.equal(batch.targets.length, 1);
          assert.ok(batch.reserves.length >= 1, 'the wave carries ordered reserves');
          failed = batch.targets[0].platform;
        }
      },
      policy: {
        waveResults: (action) => ({
          ...firstReview(report([planFinding()]))(action),
          ...(action.wave.round === 1 && action.wave.type === 'review' ? { [failed]: { exit: 1, failureKind: 'quota' } } : {}),
        }),
      },
    });
    assert.ok(!run.trace.some((a) => a.action === 'native-fallback'), 'a reserve, not native fallback, covers the slot');
    const [round] = readLog(plan).rounds;
    const substitute = Object.values(round.sourceMap).find((source) => source.substitutesFor);
    assert.ok(substitute, 'the Sources line records the replacement');
    assert.notEqual(substitute.provider, failed);
    assertSettledAndCheckpointed(plan, run.done, 'plan');
  });

  it('checkpoint drift restarts preparation and never forces a stale checkpoint', () => {
    const { fixture, repo } = setup(config());
    const plan = writePlan(repo.dir);
    let edited = false;
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--orchestrator', 'claude', '--', plan],
      policy: {
        waveResults: firstReview(report([planFinding()])),
        rule: () => {
          if (!edited) {
            edited = true;
            const source = fs.readFileSync(plan, 'utf8').replace('- First.', '- First, edited mid-review.');
            fs.writeFileSync(plan, source);
          }
          return { status: 'accepted' };
        },
      },
    });
    assert.ok(edited);
    assert.ok(!JSON.stringify(run.trace).includes('"force"'), 'no action forces a checkpoint');
    assert.ok(!run.argvLog.flat().includes('--force'));
    const markdown = fs.readFileSync(plan, 'utf8');
    assert.match(markdown, /edited mid-review/);
    assertSettledAndCheckpointed(plan, run.done, 'plan');
    const { metadata } = splitDispatchFrontmatter(markdown);
    assert.equal(metadata.contentHash, planSnapshot(markdown).contentHash, 'checkpoint reflects the drifted content');
  });

  it('state-cache loss: --next names the --run command, and --run resumes from the unsettled log', () => {
    const { fixture, repo } = setup(config({ consensus: true, rounds: 2 }));
    const plan = writePlan(repo.dir);
    const runArgs = ['--run', 'review', '--kind', 'plan', '--orchestrator', 'claude', '--', plan];
    const call = (args) => {
      const res = runDispatch(fixture, args, { cwd: repo.dir });
      assert.equal(res.status, 0, res.stderr);
      return parseAction(res.stdout);
    };
    const launch = call(runArgs);
    runLaunch(fixture, launch.argv, { cwd: repo.dir, results: allProviders(report([planFinding()])) });
    const adjudicate = call(['--next', '--state', launch.stateFile]);
    assert.equal(adjudicate.action, 'adjudicate');
    const [finding] = adjudicate.findings;
    const inputFile = path.join(fixture.dir, 'rulings.json');
    fs.writeFileSync(inputFile, JSON.stringify({ rulings: [{
      key: finding.key, status: 'rejected', severity: finding.severity, scope: 'in-scope',
      locus: finding.locus, tag: finding.tag, defect: finding.defect, resolution: 'Already covered.',
    }] }));
    const rebuttalLaunch = call(['--next', '--state', launch.stateFile, '--input', `@${inputFile}`]);
    assert.equal(rebuttalLaunch.action, 'launch');
    assert.equal(rebuttalLaunch.wave.type, 'rebuttal');

    fs.rmSync(rebuttalLaunch.stateFile);
    const lost = runDispatch(fixture, ['--next', '--state', rebuttalLaunch.stateFile], { cwd: repo.dir });
    assert.equal(lost.status, 2);
    assert.match(lost.stderr, /--run review/);

    const resumed = call(runArgs);
    assert.equal(resumed.action, 'launch');
    assert.equal(resumed.wave.type, 'rebuttal', 'resumes the pending rebuttal from the log');
    assert.deepEqual(resumed.keys, rebuttalLaunch.keys);
    assert.equal(logEntries(plan).length, 1, 'no second review round was started');
  });

  it('missing wave envelope: re-emits launch once with an error, then ends failed naming the --run command', () => {
    const { fixture, repo } = setup(config());
    const plan = writePlan(repo.dir);
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--orchestrator', 'claude', '--', plan],
      policy: { skipLaunch: () => true },
    });
    assert.deepEqual(actions(run.trace), ['launch', 'launch', 'done']);
    assert.equal(run.trace[0].error, undefined);
    assert.equal(typeof run.trace[1].error, 'string');
    assert.deepEqual(run.trace[1].argv, run.trace[0].argv, 'the same wave is relaunched');
    assert.equal(run.done.outcome, 'failed');
    assert.match(run.done.command, /--run review/);
  });

  it('prose report: the agent restates it and the driver writes the restated finding', () => {
    const { fixture, repo } = setup(config());
    const plan = writePlan(repo.dir);
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--orchestrator', 'claude', '--', plan],
      policy: {
        waveResults: firstReview('The plan never names how a failure is tested; add one.'),
        restate: () => ({
          status: 'accepted', severity: 'SHOULD', scope: 'in-scope', locus: '§ Verification Plan', tag: 'testability',
          defect: 'restated: no failure-path test.', resolution: 'Named one.',
        }),
      },
    });
    const adjudicate = run.trace.find((a) => a.action === 'adjudicate');
    assert.ok(adjudicate.findings.some((f) => f.restate === true && f.reportPath));
    assert.match(fs.readFileSync(plan, 'utf8'), /restated: no failure-path test/);
    assert.doesNotMatch(fs.readFileSync(plan, 'utf8'), /never names how a failure/);
    assertSettledAndCheckpointed(plan, run.done, 'plan');
  });

  it('prose report with no findings: an empty restate ruling closes the entry', () => {
    const { fixture, repo } = setup(config());
    const plan = writePlan(repo.dir);
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--orchestrator', 'claude-code', '--', plan],
      policy: { waveResults: firstReview('No issues found.'), restate: () => ({ empty: true }) },
    });
    assert.ok(run.trace.find((a) => a.action === 'adjudicate').findings.some((f) => f.restate === true));
    assert.doesNotMatch(fs.readFileSync(plan, 'utf8'), /\[R1-F\d+\]/);
    assertSettledAndCheckpointed(plan, run.done, 'plan');
  });

  it('authoring-required ends in done refusing and naming the producing phase', () => {
    const { fixture, repo } = setup(config());
    const missing = path.join(repo.dir, '.scratch', 'plan', '2026-09-22-missing.md');
    const run = drive(fixture, { cwd: repo.dir, runArgs: ['review', '--kind', 'plan', '--orchestrator', 'claude', '--', missing] });
    assert.deepEqual(actions(run.trace), ['done']);
    assert.equal(run.done.outcome, 'refused');
    assert.match(run.done.summary, /\bplan\b/);
    assert.ok(!fs.existsSync(missing), 'standalone review never authors a missing artifact');
  });

  it('no-reviewable-changes ends in done with that message', () => {
    const { fixture, repo } = setup(config());
    const run = drive(fixture, { cwd: repo.dir, runArgs: ['review', '--kind', 'code', '--orchestrator', 'claude'] });
    assert.deepEqual(actions(run.trace), ['done']);
    assert.equal(run.done.outcome, 'no-reviewable-changes');
    assert.ok(run.done.summary.length > 0);
  });

  it('phase not configured: one fallback target, one round, host-final rulings', () => {
    const { fixture, repo } = setup({ 'read-delegates': DELEGATES });
    const plan = writePlan(repo.dir);
    const batches = [];
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--orchestrator', 'claude', '--', plan],
      onAction: (action) => { if (action.action === 'launch') batches.push(readBatchFile(action.argv)); },
      policy: { waveResults: firstReview(report([planFinding()])), rule: () => ({ status: 'rejected' }) },
    });
    assert.equal(batches.length, 1, 'one round, no rebuttal wave');
    assert.equal(batches[0].targets.length, 1);
    assert.notEqual(batches[0].targets[0].platform, 'claude', 'orchestrator demoted');
    assert.equal(logEntries(plan)[0].status, 'rejected', 'host ruling is final');
    assertSettledAndCheckpointed(plan, run.done, 'plan');
  });

  it('consensus: false keeps host rulings final (no rebuttal wave)', () => {
    const { fixture, repo } = setup(config({ consensus: false, rounds: 3 }));
    const plan = writePlan(repo.dir);
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--orchestrator', 'claude', '--', plan],
      policy: { waveResults: firstReview(report([planFinding()])), rule: () => ({ status: 'rejected' }) },
    });
    assert.equal(launches(run.trace, 'rebuttal').length, 0);
    assertSettledAndCheckpointed(plan, run.done, 'plan');
  });
});
