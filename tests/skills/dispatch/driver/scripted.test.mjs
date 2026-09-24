// SC4–SC6: scripted-agent replays of standalone reviews driven only through dispatch.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, afterEach, describe, it } from 'node:test';

import { evaluateConsensus } from '../../../../skills/dispatch/scripts/review/consensus.mjs';
import { planSnapshot } from '../../../../skills/dispatch/scripts/review/prepare.mjs';
import { splitDispatchFrontmatter } from '../../../../skills/dispatch/scripts/review/resolution-log.mjs';
import { createStubDispatchFixture } from '../../../helpers/stub-dispatch-fixture.mjs';
import {
  PLAN_BODY,
  allProviders,
  assertOnlyDispatchArgv,
  codeFinding,
  designFinding,
  drive,
  logEntries,
  makeGitRepo,
  parseAction,
  planFinding,
  readBatchFile,
  readLog,
  rebuttal,
  report,
  runDispatch,
  runLaunch,
  writeDesign,
  writePlan,
} from '../../../helpers/driver-harness.mjs';

const ALL = (value) => ({ low: value, medium: value, high: value, xhigh: value, max: value });
const phase = ({ rounds = 1, targets = 1, consensus = false } = {}) => ({ rounds: ALL(rounds), targets: ALL(targets), consensus: ALL(consensus) });
const DELEGATES = {
  agy: { targets: [{ low: { model: 'gemini-3.7-flash', effort: 'medium' } }] },
  opencode: { targets: [{ low: { model: 'opencode-go/glm-5.3-flash', effort: 'max' } }] },
};
const config = (phaseOpts = {}, delegates = DELEGATES) => ({
  'read-delegates': delegates,
  phases: { 'plan-review': phase(phaseOpts), 'code-review': phase(phaseOpts) },
});

const cleanups = [];
const fixtures = new Map();
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });
after(() => { for (const fixture of fixtures.values()) fixture.cleanup(); });

function setup(cfg, repoOpts) {
  const key = JSON.stringify(cfg);
  let fixture = fixtures.get(key);
  if (!fixture) {
    fixture = createStubDispatchFixture(cfg);
    fixtures.set(key, fixture);
  }
  const repo = makeGitRepo(repoOpts);
  cleanups.push(repo.cleanup);
  return { fixture, repo };
}

const actions = (trace) => trace.map((a) => a.action);
const launches = (trace, type) => trace.filter((a) => a.action === 'launch' && (!type || a.wave.type === type));
const firstReview = (waveReport) => (action) =>
  action.wave.type === 'review' && action.wave.round === 1 ? allProviders(waveReport) : allProviders(report());

function walkthroughIn(repoDir) {
  const dir = path.join(repoDir, '.scratch', 'plan');
  const found = fs.readdirSync(dir).filter((name) => name.endsWith('-walkthrough.md'));
  assert.equal(found.length, 1, `one walkthrough expected, found ${found.join(', ')}`);
  return path.join(dir, found[0]);
}

/** Asserts the resolution log carries a round with a Sources line, consensus exits 0, and metadata is checkpointed. */
function assertSettledAndCheckpointed(artifact, done, kind) {
  assert.equal(done.outcome, 'complete', JSON.stringify(done));
  assert.equal(done.checkpointed, true);
  const markdown = fs.readFileSync(artifact, 'utf8');
  assert.match(markdown, /### Round 1\b/);
  assert.match(markdown, /\*\*Sources:\*\* \{/);
  assert.equal(evaluateConsensus(markdown).exit, 0);
  if (kind !== 'code') {
    const { metadata } = splitDispatchFrontmatter(markdown);
    assert.equal(metadata?.kind, kind);
    assert.match(metadata.contentHash, /^sha256:/);
  }
}

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
