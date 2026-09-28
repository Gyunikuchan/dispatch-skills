// SC1, SC2 (native-fallback model cascade): the driver owns a per-model native cascade for a
// failed read target's own candidate `model` array, and the launch step names a one-shot `--slots`
// check instead of a host timer.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, describe, it } from 'node:test';

import { loadSchema, validateReply } from '../../../../skills/dispatch/scripts/driver/actions.mjs';
import { createStubDispatchFixture } from '../../../helpers/stub-dispatch-fixture.mjs';
import { allProviders, drive, makeGitRepo, parseAction, planFinding, report, runDispatch, writePlan } from '../../../helpers/driver-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const DISPATCH_SCRIPT = path.join(ROOT, 'skills', 'dispatch', 'scripts', 'dispatch.mjs');

// The read-delegates entry pairs a same-platform candidate with a two-model cascade; a sibling
// platform is configured but excluded from this phase via `only`, so it can never substitute in.
const CONFIG = {
  'read-delegates': {
    agy: { targets: [{ low: { model: ['native-fallback-a', 'native-fallback-b'], effort: 'low' } }] },
    opencode: { targets: [{ low: { model: 'native-fallback-c', effort: 'low' } }] },
  },
  phases: {
    'plan-review': { rounds: { medium: 1 }, targets: { medium: 1 }, consensus: { medium: false }, only: ['agy'] },
  },
};

const cleanup = [];
const fixtures = new Map();
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
after(() => { for (const fixture of fixtures.values()) fixture.cleanup(); });

function fixtureFor(config) {
  const key = JSON.stringify(config);
  let fixture = fixtures.get(key);
  if (!fixture) {
    fixture = createStubDispatchFixture(config);
    fixtures.set(key, fixture);
  }
  return fixture;
}

function setup() {
  const fixture = fixtureFor(CONFIG);
  const repo = makeGitRepo();
  cleanup.push(repo.cleanup);
  const plan = writePlan(repo.dir);
  return { fixture, repo, plan };
}

describe('native-fallback schema carries cascade identity and admits `failed` (SC1)', () => {
  it('descriptor requires cascadePosition and modelCascade', () => {
    const required = loadSchema('native-fallback').properties.descriptor.required;
    assert.ok(required.includes('cascadePosition'), JSON.stringify(required));
    assert.ok(required.includes('modelCascade'), JSON.stringify(required));
  });

  it('reply accepts {slot, failed:{kind,reason}} as an alternative to a capture', () => {
    const result = validateReply('native-fallback', { slot: 'plan-review:R1:agy:0', failed: { kind: 'quota', reason: 'Transient provider failure.' } });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });
});

describe('driver-owned per-model native cascade for a failed read target (SC1)', () => {
  it('hops A then B in candidate order on a failed reply, then records the slot failed, never emitting sibling candidate C', () => {
    const scenario = setup();
    const seen = [];
    const run = drive(scenario.fixture, {
      cwd: scenario.repo.dir,
      runArgs: ['review', '--orchestrator', 'agy', '--', scenario.plan],
      policy: {
        waveResults: () => allProviders('', { exit: 1, failureKind: 'quota' }),
        nativeFallback(action) {
          seen.push(action.descriptor);
          return { slot: action.slot, failed: { kind: 'quota', reason: `Transient failure on ${action.descriptor.model}.` } };
        },
      },
    });
    assert.deepEqual(seen.map((descriptor) => descriptor.model), ['native-fallback-a', 'native-fallback-b'],
      'the cascade must hop A then B, in candidate order, and go no further');
    assert.match(JSON.stringify(run.done), /failed/i, 'the slot ends recorded failed once its own model cascade is exhausted');
    assert.ok(!seen.some((descriptor) => descriptor.model === 'native-fallback-c'), 'sibling candidate C must never be part of this slot\'s cascade');
  });
});

describe('review-phase post-wave native fallback stays same-platform (SC3)', () => {
  it('never emits native-fallback for a cross-platform failed target under the post-wave queue, and records it failed', () => {
    const fixture = fixtureFor({
      'read-delegates': {
        claude: { targets: [{ low: { model: 'claude-opus-5', effort: 'medium' } }] },
        opencode: { targets: [{ low: { model: 'opencode-model', effort: 'medium' } }] },
      },
      phases: {
        'plan-review': { rounds: { medium: 1 }, targets: { medium: 2 }, consensus: { medium: false }, only: ['claude', 'opencode'] },
      },
    });
    const repo = makeGitRepo();
    cleanup.push(repo.cleanup);
    const plan = writePlan(repo.dir);
    const seenNativeFallback = [];
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--orchestrator', 'claude', '--', plan],
      onAction: (action) => { if (action.action === 'native-fallback') seenNativeFallback.push(action); },
      policy: {
        // The claude-platform slot (matches the orchestrator) is clean; the opencode slot fails and is
        // cross-platform relative to the claude orchestrator, so it must never spawn a native fallback.
        waveResults: () => ({
          claude: { stdout: report() },
          opencode: { exit: 1, failureKind: 'quota' },
        }),
      },
    });
    assert.deepEqual(seenNativeFallback, [], 'a cross-platform failed target must never reach native-fallback');
    assert.ok(run.done.failed?.some((item) => /:opencode:/.test(item.sourceKey) && item.kind === 'quota'), `the cross-platform failure must be recorded in done.failed: ${JSON.stringify(run.done)}`);
  });
});

describe('same-platform early fallback and the one-shot --slots step (SC2)', () => {
  it('launch guidance names the one-shot --slots step and carries slotsPath instead of a host timer', () => {
    const fixture = fixtureFor({
      'read-delegates': { claude: { targets: [{ low: { model: 'claude-opus-5', effort: 'medium' } }] } },
      phases: { 'plan-review': { rounds: { medium: 1 }, targets: { medium: 1 }, consensus: { medium: false } } },
    });
    const repo = makeGitRepo();
    cleanup.push(repo.cleanup);
    const plan = writePlan(repo.dir);
    const res = runDispatch(fixture, ['--run', 'review', '--kind', 'plan', '--orchestrator', 'claude', '--', plan], { cwd: repo.dir });
    assert.equal(res.status, 0, res.stderr);
    const launch = parseAction(res.stdout);
    assert.equal(launch.action, 'launch');
    assert.ok(Array.isArray(launch.earlyFallbacks) && launch.earlyFallbacks.length > 0, 'a same-platform target produces a non-empty early-fallback descriptor list');
    assert.equal(typeof launch.slotsPath, 'string', 'the launch action names the one-shot --slots file');
    assert.ok((launch.slotsPath ?? '').length > 0);
    assert.ok(!launch.guidance.some((line) => /exactly 5 seconds/i.test(line)), 'the host-timer instruction is retired');
    assert.ok(launch.guidance.some((line) => /--slots/.test(line)), 'guidance names the one-shot --slots step');
  });

  it('`node dispatch.mjs --slots <file>` prints the failed slots recorded so far as JSON', () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dispatch-slots-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const slotsFile = path.join(dir, 'slots.jsonl');
    const lines = [
      { slot: 'plan-review:R1:agy:0', platform: 'agy', status: 'ok', exit: 0, session: 's1', output: null },
      { slot: 'plan-review:R1:opencode:0', platform: 'opencode', status: 'fail', exit: 1, session: null, output: null },
    ];
    fs.writeFileSync(slotsFile, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    const res = spawnSync(process.execPath, [DISPATCH_SCRIPT, '--slots', slotsFile], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.ok(Array.isArray(parsed));
    assert.deepEqual(parsed.map((entry) => entry.slot), ['plan-review:R1:opencode:0']);
  });
});

describe('early fallback outcome on a multi-model cascade (A-1)', () => {
  function earlyReply(write) {
    return (action) => {
      const [fallback] = action.earlyFallbacks;
      if (write) fs.writeFileSync(fallback.outputPath, write);
      return { earlyFallbacks: [{ slot: fallback.slot, outputPath: fallback.outputPath, captured: true, actual: {
        agentType: fallback.descriptor.agentType, model: fallback.descriptor.model, reasoningEffort: fallback.descriptor.reasoningEffort,
      } }] };
    };
  }

  it('early fallback success on a two-model cascade is final', () => {
    const scenario = setup();
    const seen = [];
    const run = drive(scenario.fixture, {
      cwd: scenario.repo.dir,
      runArgs: ['review', '--orchestrator', 'agy', '--', scenario.plan],
      onAction: (action) => { if (action.action === 'native-fallback') seen.push(action.descriptor); },
      policy: {
        waveResults: () => allProviders('', { exit: 1, failureKind: 'quota' }),
        launchReply: earlyReply(report([planFinding({ defect: 'early-success defect.' })])),
      },
    });
    assert.deepEqual(seen, [], 'a successful early fallback must not be requeued for another native hop');
    const adjudicate = run.trace.find((action) => action.action === 'adjudicate');
    assert.equal(adjudicate?.findings.filter((finding) => /early-success/.test(finding.defect)).length, 1,
      'the early report is collected exactly once');
  });

  it('empty early fallback retries once before advancing to the next model', () => {
    const scenario = setup();
    const seen = [];
    const run = drive(scenario.fixture, {
      cwd: scenario.repo.dir,
      runArgs: ['review', '--orchestrator', 'agy', '--', scenario.plan],
      onAction: (action) => { if (action.action === 'native-fallback') seen.push(action.descriptor); },
      policy: {
        waveResults: () => allProviders('', { exit: 1, failureKind: 'quota' }),
        launchReply: earlyReply(null),
        nativeFallback(action) {
          if (action.descriptor.cascadePosition === 0) {
            fs.writeFileSync(action.outputPath, '  ');
          } else {
            fs.writeFileSync(action.outputPath, report());
          }
          return { slot: action.slot, captured: true, actual: { agentType: action.descriptor.agentType,
            model: action.descriptor.model, reasoningEffort: action.descriptor.reasoningEffort } };
        },
      },
    });
    assert.deepEqual(seen.map((descriptor) => [descriptor.model, descriptor.cascadePosition]),
      [['native-fallback-a', 0], ['native-fallback-b', 1]],
      'one post-wave empty retry consumes the first hop before trying the next model');
    assert.equal(run.done.failed?.length ?? 0, 0);
  });
});

describe('nativeSubagentsOnly review waves', () => {
  const NATIVE = {
    'read-delegates': {
      agy: { nativeSubagentsOnly: true, targets: [{ low: { model: 'native-only-a', effort: 'low' } }] },
      opencode: { targets: [{ low: { model: 'cli-c', effort: 'low' } }] },
    },
    phases: { 'plan-review': { rounds: { medium: 1 }, targets: { medium: 2 }, consensus: { medium: false } } },
  };
  const ALL_NATIVE = {
    ...NATIVE,
    phases: { 'plan-review': { rounds: { medium: 1 }, targets: { medium: 1 }, consensus: { medium: false }, only: ['agy'] } },
  };

  function nativeScenario(config) {
    const fixture = fixtureFor(config);
    const repo = makeGitRepo();
    cleanup.push(repo.cleanup);
    return { fixture, repo, plan: writePlan(repo.dir) };
  }

  function capture(write) {
    return (action) => ({ earlyFallbacks: (action.nativeLaunches ?? []).flatMap((launch) => {
      if (!write) return [];
      fs.writeFileSync(launch.outputPath, write);
      return [{ slot: launch.slot, outputPath: launch.outputPath, captured: true, actual: {
        agentType: launch.descriptor.agentType, model: launch.descriptor.model, reasoningEffort: launch.descriptor.reasoningEffort,
      } }];
    }) });
  }

  it('nativeSubagentsOnly mixed wave excludes the slot from argv and emits it as an immediate native launch', () => {
    const scenario = nativeScenario(NATIVE);
    const res = runDispatch(scenario.fixture, ['--run', 'review', '--kind', 'plan', '--orchestrator', 'agy', '--', scenario.plan], { cwd: scenario.repo.dir });
    assert.equal(res.status, 0, res.stderr);
    const launch = parseAction(res.stdout);
    assert.equal(launch.action, 'launch');
    assert.deepEqual(launch.selectedTargets.map((target) => target.platform), ['opencode']);
    const batch = JSON.parse(fs.readFileSync(launch.argv[launch.argv.indexOf('--batch-file') + 1], 'utf8'));
    assert.deepEqual([...batch.targets, ...batch.reserves].map((entry) => entry.platform), ['opencode']);
    assert.deepEqual(launch.nativeLaunches.map((item) => [item.slot, item.descriptor.model]), [['plan-review:R1:agy:0', 'native-only-a']]);
    assert.ok(launch.guidance.some((line) => /same tool-call round as argv/.test(line)), launch.guidance.join('\n'));
  });

  it('nativeSubagentsOnly capture is collected as a report without a CLI failure record', () => {
    const scenario = nativeScenario(NATIVE);
    const seen = [];
    const run = drive(scenario.fixture, {
      cwd: scenario.repo.dir,
      runArgs: ['review', '--orchestrator', 'agy', '--', scenario.plan],
      onAction: (action) => { if (action.action === 'native-fallback') seen.push(action.slot); },
      policy: { launchReply: capture(report([planFinding({ defect: 'native-only defect.' })])) },
    });
    assert.deepEqual(seen, []);
    const adjudicate = run.trace.find((action) => action.action === 'adjudicate');
    assert.equal(adjudicate?.findings.filter((finding) => /native-only defect/.test(finding.defect)).length, 1);
  });

  it('nativeSubagentsOnly slot omitted from the reply takes the ordinary native fallback', () => {
    const scenario = nativeScenario(NATIVE);
    const seen = [];
    drive(scenario.fixture, {
      cwd: scenario.repo.dir,
      runArgs: ['review', '--orchestrator', 'agy', '--', scenario.plan],
      onAction: (action) => { if (action.action === 'native-fallback') seen.push(action.slot); },
      policy: {
        launchReply: capture(null),
        nativeFallback: (action) => ({ slot: action.slot, failed: { kind: 'quota', reason: 'Transient.' } }),
      },
    });
    assert.deepEqual(seen, ['plan-review:R1:agy:0']);
  });

  it('nativeSubagentsOnly all-native wave emits a launch with no argv', () => {
    const scenario = nativeScenario(ALL_NATIVE);
    const res = runDispatch(scenario.fixture, ['--run', 'review', '--kind', 'plan', '--orchestrator', 'agy', '--', scenario.plan], { cwd: scenario.repo.dir });
    assert.equal(res.status, 0, res.stderr);
    const launch = parseAction(res.stdout);
    assert.equal(launch.action, 'launch');
    assert.equal(launch.argv, undefined);
    assert.deepEqual(launch.selectedTargets, []);
    assert.deepEqual(launch.nativeLaunches.map((item) => item.slot), ['plan-review:R1:agy:0']);
    assert.ok(!launch.guidance.some((line) => /argv/.test(line)), launch.guidance.join('\n'));
    const run = drive(scenario.fixture, {
      cwd: scenario.repo.dir,
      runArgs: ['review', '--orchestrator', 'agy', '--', scenario.plan],
      policy: { launchReply: capture(report([planFinding({ defect: 'all-native defect.' })])) },
    });
    assert.equal(run.trace.find((action) => action.action === 'adjudicate')?.findings.filter((finding) => /all-native defect/.test(finding.defect)).length, 1);
  });

  it('nativeSubagentsOnly mismatched orchestrator skips the platform', () => {
    const scenario = nativeScenario(NATIVE);
    const res = runDispatch(scenario.fixture, ['--run', 'review', '--kind', 'plan', '--orchestrator', 'claude', '--', scenario.plan], { cwd: scenario.repo.dir });
    assert.equal(res.status, 0, res.stderr);
    const launch = parseAction(res.stdout);
    assert.deepEqual(launch.selectedTargets.map((target) => target.platform), ['opencode']);
    assert.equal(launch.nativeLaunches, undefined);
  });
});
