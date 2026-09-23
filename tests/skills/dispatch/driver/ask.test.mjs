// SC4 (v0.5.0 native-fallback model cascade): `ask` routes through the driver's own verb —
// `--run ask` emits `launch`, a wave failure hops to native-fallback, and completion emits `done`
// carrying the collected claims. The direct runner path is retired from the SKILL.md contract.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import { buildStubDispatchFixture } from '../../../helpers/stub-dispatch.mjs';
import { allProviders, drive, makeGitRepo, parseAction, readBatchFile, runDispatch } from '../../../helpers/driver-harness.mjs';

const CONFIG = {
  'read-delegates': { agy: { model: 'gemini-3.7-flash', effort: 'medium' } },
};

const cleanup = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

function setup() {
  const fixture = buildStubDispatchFixture(CONFIG);
  const repo = makeGitRepo();
  cleanup.push(fixture.cleanup, repo.cleanup);
  return { fixture, repo };
}

describe('`--run ask` (SC4)', () => {
  it('emits launch, hops to native-fallback on a wave failure, then done with the collected claims', () => {
    const { fixture, repo } = setup();
    const seenActions = [];
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['ask', '--orchestrator', 'agy', '--', 'What does the dispatch config schema require?'],
      policy: {
        waveResults: () => allProviders('', { exit: 1, failureKind: 'quota' }),
        nativeFallback(action) {
          seenActions.push(action.action);
          fs.writeFileSync(action.outputPath, 'The schema requires schemaVersion and read-delegates.\n');
          return { slot: action.slot, captured: true, actual: {
            agentType: action.descriptor.agentType, model: action.descriptor.model, reasoningEffort: action.descriptor.reasoningEffort,
          } };
        },
      },
      onAction(action) { seenActions.push(action.action); },
    });
    assert.ok(seenActions.includes('launch'), `expected a launch action, saw: ${seenActions.join(', ')}`);
    assert.ok(seenActions.includes('native-fallback'), `expected a native-fallback hop after the wave failure, saw: ${seenActions.join(', ')}`);
    assert.equal(run.done.action, 'done');
    assert.ok(Array.isArray(run.done.claims) && run.done.claims.length > 0, 'done carries the collected claims');
  });
  it('never requests a native fallback for a failed target on another platform', () => {
    const { fixture, repo } = setup();
    const seenActions = [];
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['ask', '--orchestrator', 'claude', '--', 'What does the dispatch config schema require?'],
      policy: { waveResults: () => allProviders('', { exit: 1, failureKind: 'quota' }) },
      onAction(action) { seenActions.push(action.action); },
    });
    assert.ok(!seenActions.includes('native-fallback'), `cross-platform failure must not hop natively, saw: ${seenActions.join(', ')}`);
    assert.equal(run.done.outcome, 'failed');
    assert.equal(run.done.failed.length, 1);
  });
});

// SECTION: A-3 ask breadth and pins (SC4)

const MULTI = { 'read-delegates': {
  agy: { model: 'gemini-3.7-flash', effort: 'medium' },
  opencode: { model: 'opencode-model', effort: 'medium' },
  copilot: { model: 'copilot-model', effort: 'medium' },
} };
const platformOf = (target) => target.candidateId.split(':')[1];
const QUESTION = ['--', 'What does the dispatch config schema require?'];

function setupWith(config) {
  const fixture = buildStubDispatchFixture(config);
  const repo = makeGitRepo();
  cleanup.push(fixture.cleanup, repo.cleanup);
  return { fixture, repo };
}

/** Drives ask and returns the first launch batch (read while the batch file still exists). */
function askBatch(config, extraArgs = []) {
  const { fixture, repo } = setupWith(config);
  let batch = null;
  const run = drive(fixture, {
    cwd: repo.dir,
    runArgs: ['ask', '--orchestrator', 'claude', ...extraArgs, ...QUESTION],
    policy: { waveResults: () => allProviders('Answer.') },
    onAction(action) { if (action.action === 'launch' && !batch) batch = readBatchFile(action.argv); },
  });
  assert.ok(batch, 'ask emitted a launch');
  return { batch, run };
}

describe('`--run ask` breadth and pins (SC4)', () => {
  it('ask honors provider pin', () => {
    const { batch } = askBatch(MULTI, ['--pins', 'opencode']);
    assert.deepEqual(batch.targets.map((target) => target.candidateId), ['ask:opencode:0']);
    assert.deepEqual(batch.reserves, []);
  });

  it('ask honors count pin', () => {
    const { batch } = askBatch(MULTI, ['--pins', '2']);
    assert.equal(batch.targets.length, 2, JSON.stringify(batch));
    assert.equal(batch.reserves.length, 1, JSON.stringify(batch));
    for (const target of [...batch.targets, ...batch.reserves]) assert.match(target.candidateId, /^ask:(agy|opencode|copilot):\d+$/);
    assert.deepEqual(batch.targets.map(platformOf), ['agy', 'opencode'], 'targets follow read-delegates order');
    assert.deepEqual(batch.reserves.map(platformOf), ['copilot'], 'surplus candidate is the reserve');
  });

  it('unpinned ask launches the default breadth', () => {
    const { batch } = askBatch(MULTI);
    assert.equal(batch.targets.length, 1, JSON.stringify(batch));
    assert.deepEqual(batch.targets.map(platformOf), ['agy'], 'default breadth targets the first read-delegate');
    assert.deepEqual(batch.reserves.map(platformOf), ['opencode', 'copilot'], 'remaining read-delegates are reserves');
    for (const target of [...batch.targets, ...batch.reserves]) assert.match(target.candidateId, /^ask:(agy|opencode|copilot):\d+$/);
  });

  it('ask places surplus candidates in reserves', () => {
    const { batch } = askBatch({ ...MULTI, phases: { 'code-review': { targets: { medium: 2 }, rounds: { medium: 1 }, consensus: { medium: true } } } });
    assert.equal(batch.targets.length, 2, JSON.stringify(batch));
    assert.equal(batch.reserves.length, 1, JSON.stringify(batch));
  });

  it('ask ignores a disabled code-review phase', () => {
    const { batch, run } = askBatch({ ...MULTI, phases: { 'code-review': { rounds: { medium: 0 }, targets: { medium: 2 }, consensus: { medium: true }, only: ['agy'] } } });
    assert.equal(batch.targets.length, 2, JSON.stringify(batch));
    assert.equal(batch.targets.length + batch.reserves.length, 3, 'the phase only filter does not narrow ask candidates');
    assert.equal(run.done.outcome, 'complete');
  });

  it('ask rejects a pin naming an unconfigured platform', () => {
    const { fixture, repo } = setupWith(MULTI);
    const res = runDispatch(fixture, ['--run', 'ask', '--orchestrator', 'claude', '--pins', 'claude', ...QUESTION], { cwd: repo.dir });
    const text = `${res.stdout}\n${res.stderr}`;
    assert.match(text, /not in read-delegates/, text);
    if (res.status === 0) assert.notEqual(parseAction(res.stdout).action, 'launch');
  });

  it('a provider pin keeps its platform cascade as ordered reserves', () => {
    const config = { 'read-delegates': { ...MULTI['read-delegates'],
      opencode: [{ model: 'opencode-a', effort: 'medium' }, { model: 'opencode-b', effort: 'medium' }] } };
    const { batch } = askBatch(config, ['--pins', 'opencode']);
    assert.deepEqual(batch.targets.map((target) => target.candidateId), ['ask:opencode:0']);
    assert.deepEqual(batch.reserves.map((target) => target.candidateId), ['ask:opencode:1']);
  });

  it('ask --pins all launches every read-delegate with no reserves', () => {
    const { batch } = askBatch(MULTI, ['--pins', 'all']);
    assert.deepEqual(batch.targets.map(platformOf), ['agy', 'opencode', 'copilot']);
    assert.deepEqual(batch.reserves, []);
  });

  it('ask honors comma-separated provider pins', () => {
    const { batch } = askBatch(MULTI, ['--pins', 'agy,copilot']);
    assert.deepEqual(batch.targets.map((target) => target.candidateId), ['ask:agy:0', 'ask:copilot:0']);
    assert.deepEqual(batch.reserves, []);
  });

  it('a zero code-review targets scalar still yields one ask target', () => {
    const { batch } = askBatch({ ...MULTI, phases: { 'code-review': { rounds: { medium: 0 }, targets: { medium: 0 }, consensus: { medium: true } } } });
    assert.deepEqual(batch.targets.map(platformOf), ['agy']);
    assert.deepEqual(batch.reserves.map(platformOf), ['opencode', 'copilot']);
  });

  it('launch claims keep trimmed multi-line markdown', () => {
    const body = '## Answer\n\n```js\nconst a = 1;\n```\n\n- item';
    const { fixture, repo } = setupWith(CONFIG);
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['ask', '--orchestrator', 'claude', ...QUESTION],
      policy: { waveResults: () => allProviders(`\n\n${body}  \n\n`) },
    });
    assert.equal(run.done.claims[0]?.text, body);
  });
});

// SECTION: A-7 ask native fallback (SC5)

const CASCADE = { 'read-delegates': { agy: [{ model: ['ask-model-a', 'ask-model-b'], effort: 'low' }] } };
const actualOf = (action) => ({
  agentType: action.descriptor.agentType, model: action.descriptor.model, reasoningEffort: action.descriptor.reasoningEffort,
});

function driveFallback(nativeFallback, onAction) {
  const { fixture, repo } = setupWith(CASCADE);
  return drive(fixture, {
    cwd: repo.dir,
    runArgs: ['ask', '--orchestrator', 'agy', ...QUESTION],
    policy: { waveResults: () => allProviders('', { exit: 1, failureKind: 'quota' }), nativeFallback },
    onAction,
  });
}

describe('`--run ask` native fallback (SC5)', () => {
  it('empty fallback output advances the model cascade', () => {
    const models = [];
    const run = driveFallback((action) => {
      models.push(action.descriptor.model);
      if (action.descriptor.cascadePosition === 1) fs.writeFileSync(action.outputPath, 'Answer from model b.\n');
      return { slot: action.slot, captured: true, actual: actualOf(action) };
    });
    assert.deepEqual(models, ['ask-model-a', 'ask-model-b']);
    assert.deepEqual(run.done.claims.map((claim) => claim.text), ['Answer from model b.']);
  });

  it('exhausted empty fallback records an empty-output failure', () => {
    const run = driveFallback((action) => ({ slot: action.slot, captured: true, actual: actualOf(action) }));
    assert.deepEqual(run.done.claims ?? [], []);
    assert.ok(run.done.failed?.some((entry) => entry.kind === 'empty-output'), JSON.stringify(run.done));
  });

  it('fallback claims keep trimmed multi-line markdown', () => {
    const body = '## Answer\n\n```js\nconst a = 1;\n```\n\n- item';
    const run = driveFallback((action) => {
      fs.writeFileSync(action.outputPath, `\n\n${body}  \n\n`);
      return { slot: action.slot, captured: true, actual: actualOf(action) };
    });
    assert.equal(run.done.claims[0]?.text, body);
  });

  it('ask removes its temp files on done', () => {
    const paths = [];
    driveFallback((action) => {
      paths.push(action.outputPath);
      fs.writeFileSync(action.outputPath, 'Answer.\n');
      return { slot: action.slot, captured: true, actual: actualOf(action) };
    }, (action) => {
      if (action.action !== 'launch') return;
      for (const flag of ['--batch-file', '--prompt-file', '--output-file']) paths.push(action.argv[action.argv.indexOf(flag) + 1]);
    });
    assert.ok(paths.length >= 4, JSON.stringify(paths));
    const left = paths.filter((file) => fs.existsSync(file));
    assert.deepEqual(left, [], 'every ask temp file is removed on done');
  });

  it('metadata mismatch re-emits native-fallback without changing pending', () => {
    let calls = 0;
    let pendingBefore = null;
    let reemitted = null;
    let pendingAfter = null;
    driveFallback((action) => {
      calls += 1;
      if (calls === 1) {
        pendingBefore = JSON.parse(fs.readFileSync(action.stateFile, 'utf8')).pending;
        return { slot: action.slot, captured: true, actual: { ...actualOf(action), model: 'wrong-model' } };
      }
      fs.writeFileSync(action.outputPath, 'Answer.\n');
      return { slot: action.slot, captured: true, actual: actualOf(action) };
    }, (action) => {
      if (action.action === 'native-fallback' && action.error && !reemitted) {
        reemitted = action;
        pendingAfter = JSON.parse(fs.readFileSync(action.stateFile, 'utf8')).pending;
      }
    });
    assert.ok(reemitted, 'the mismatch re-emits native-fallback with an error');
    assert.equal(reemitted.slot, pendingBefore.slot);
    assert.deepEqual(pendingAfter, pendingBefore, 'the state file pending action is unchanged by a re-emit');
  });
});

// SECTION: A-15 ask terminal branches

describe('`--run ask` terminal branches', () => {
  it('ask with no configured read delegate finishes failed without launching', () => {
    const { fixture, repo } = setupWith({ 'read-delegates': {} });
    const res = runDispatch(fixture, ['--run', 'ask', '--orchestrator', 'claude', ...QUESTION], { cwd: repo.dir });
    assert.equal(res.status, 0, res.stderr);
    const action = parseAction(res.stdout);
    assert.equal(action.action, 'done');
    assert.equal(action.outcome, 'failed');
    assert.match(action.summary, /No read delegate/);
  });

  it('a missing wave envelope finishes failed', () => {
    const { fixture, repo } = setupWith(CONFIG);
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['ask', '--orchestrator', 'claude', ...QUESTION],
      policy: { skipLaunch: () => true },
    });
    assert.equal(run.done.outcome, 'failed');
    assert.match(run.done.summary, /envelope is missing/);
  });

  it('a same-platform failure with no resolvable model records unresolved-model', () => {
    const { fixture, repo } = setupWith({ 'read-delegates': { agy: { effort: 'low' } } });
    const seen = [];
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['ask', '--orchestrator', 'agy', ...QUESTION],
      policy: { waveResults: () => allProviders('', { exit: 1, failureKind: 'quota' }) },
      onAction(action) { seen.push(action.action); },
    });
    assert.ok(!seen.includes('native-fallback'), seen.join(', '));
    assert.deepEqual(run.done.failed.map((entry) => entry.kind), ['unresolved-model']);
  });

  it('a slot mismatch re-emits native-fallback with an error', () => {
    let calls = 0;
    let reemitted = null;
    const run = driveFallback((action) => {
      calls += 1;
      if (calls === 1) return { slot: 'not-the-slot', captured: true, actual: actualOf(action) };
      fs.writeFileSync(action.outputPath, 'Answer.\n');
      return { slot: action.slot, captured: true, actual: actualOf(action) };
    }, (action) => {
      if (action.action === 'native-fallback' && action.error && !reemitted) reemitted = action;
    });
    assert.ok(reemitted, 'the mismatch re-emits native-fallback');
    assert.match(reemitted.error, /slot must be/);
    assert.equal(reemitted.descriptor.cascadePosition, 0, 'a mismatch does not advance the cascade');
    assert.equal(run.done.outcome, 'complete');
  });
});
