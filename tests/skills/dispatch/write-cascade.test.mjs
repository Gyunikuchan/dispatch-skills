// SC3 (v0.5.0 native-fallback model cascade): write cascade advances on `rejected` and on the new
// `failed:{kind,reason}` reply form, never incrementing `attempt` on a transport hop, carries a
// `continuation` note naming the failed model and kind, emits `restore` only when the partial diff
// leaves the approved set, treats terminal kinds (e.g. `sandbox-unsupported`) as immediately
// terminal, and ends exhaustion listing every model tried with its failure kind.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { validateReply } from '../../../skills/dispatch/scripts/driver/actions.mjs';
import { buildStubDispatchFixture } from './stub-dispatch-fixture.mjs';
import { drive, makeGitRepo, parseAction, PLAN_BODY, runDispatch, writePlan } from './driver-harness.mjs';

const levels = { low: 1, medium: 1, high: 1, xhigh: 1, max: 1 };
const CONFIG = {
  'read-delegates': { agy: { model: 'gemini-3.7-flash', effort: 'medium' } },
  'write-subagents': { claude: { model: ['first-model', 'second-model'], effort: 'low' } },
  phases: Object.fromEntries(['plan-review', 'code-review'].map((key) => [
    key, { rounds: levels, targets: levels, consensus: Object.fromEntries(Object.keys(levels).map((level) => [level, false])) },
  ])),
};

const cleanup = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

function setup() {
  const fixture = buildStubDispatchFixture(CONFIG);
  const repo = makeGitRepo();
  cleanup.push(fixture.cleanup, repo.cleanup);
  fs.mkdirSync(path.join(repo.dir, 'tests'));
  fs.writeFileSync(path.join(repo.dir, 'tests/sample.test.mjs'), "import assert from 'node:assert/strict';\nimport { value } from '../src/app.js';\nassert.equal(value, 1);\n");
  repo.git('add', 'tests');
  repo.git('commit', '--no-gpg-sign', '-qm', 'baseline tests');
  const plan = writePlan(repo.dir, undefined, PLAN_BODY
    .replace('Changes: `src/app.js`', 'Changes: `src/app.js`, `tests/sample.test.mjs`')
    .replace('#### [MODIFY] src/app.js', '#### [MODIFY] tests/sample.test.mjs\n\n- Add regression.\n\n#### [MODIFY] src/app.js'));
  return { fixture, repo, plan };
}

class Stop extends Error {
  constructor(action) { super('stop-before-write-reply'); this.action = action; }
}

/** Drives the fixture to the first `delegate-write` action (tests-only stage) and returns it unanswered. */
function driveToFirstWrite({ fixture, repo, plan }) {
  try {
    drive(fixture, {
      cwd: repo.dir,
      runArgs: ['implement', '--orchestrator', 'claude', '--', plan],
      policy: {
        askUser(action) {
          if (action.question === 'approval') return { answer: { decision: 'approved', governingHash: action.items[0].governingHash, testPaths: ['tests/sample.test.mjs'], reason: 'Approved fixture plan.' } };
          throw new Error(`Unexpected question ${action.question} before first write`);
        },
        delegateWrite(action) { throw new Stop(action); },
      },
    });
    throw new Error('expected to stop before any delegate-write reply');
  } catch (err) {
    if (err instanceof Stop) return err.action;
    throw err;
  }
}

function next(fixture, repo, stateFile, input) {
  const file = path.join(fixture.dir, `reply-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(input));
  const res = runDispatch(fixture, ['--next', '--state', stateFile, '--input', `@${file}`], { cwd: repo.dir });
  assert.equal(res.status, 0, res.stderr);
  return parseAction(res.stdout);
}

describe('delegate-write reply schema admits `failed` (SC3)', () => {
  it('accepts exactly one of envelope, raw, rejected, or failed:{kind,reason}', () => {
    const result = validateReply('delegate-write', { failed: { kind: 'quota', reason: 'transient failure' } });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it('rejects a failed form missing kind or reason', () => {
    assert.equal(validateReply('delegate-write', { failed: { reason: 'x' } }).ok, false);
    assert.equal(validateReply('delegate-write', { failed: { kind: 'quota' } }).ok, false);
  });

  it('still rejects ambiguous combinations including failed alongside another form', () => {
    assert.equal(validateReply('delegate-write', { failed: { kind: 'quota', reason: 'x' }, rejected: true }).ok, false);
  });
});

describe('write cascade advances on failed without consuming attempt (SC3)', () => {
  it('cascades to the next configured model on a transient failed reply, holding attempt and naming the continuation', () => {
    const fixture = setup();
    const first = driveToFirstWrite(fixture);
    assert.equal(first.fields.model, 'first-model');
    assert.equal(first.fields.cascadePosition, 0);
    assert.deepEqual(first.fields.modelCascade, ['first-model', 'second-model']);

    const second = next(fixture.fixture, fixture.repo, first.stateFile, { failed: { kind: 'quota', reason: 'Transient provider failure.' } });

    assert.equal(second.action, 'delegate-write', second.error);
    assert.equal(second.error, undefined, second.error);
    assert.equal(second.fields.model, 'second-model');
    assert.equal(second.fields.cascadePosition, 1);
    assert.equal(second.fields.attempt, first.fields.attempt, 'a transport hop must not consume an implementation attempt');
    assert.ok(second.fields.continuation, 'the next write must carry a continuation note');
    assert.equal(second.fields.continuation.kind, 'cascade');
    assert.equal(second.fields.continuation.failedModel, 'first-model');
    assert.equal(second.fields.continuation.failureKind, 'quota');
  });

  it('emits restore only when the partial diff from the failed hop leaves the approved write scope', () => {
    const fixture = setup();
    const first = driveToFirstWrite(fixture);
    // Simulate the failed subagent's partial diff touching a path outside its approved scope.
    fs.writeFileSync(path.join(fixture.repo.dir, 'src/rogue.js'), 'export const rogue = true;\n');

    const second = next(fixture.fixture, fixture.repo, first.stateFile, { failed: { kind: 'quota', reason: 'Transient provider failure.' } });

    assert.equal(second.action, 'delegate-write', second.error);
    assert.ok(second.fields.restore, 'restore must be present when the partial diff leaves the approved paths');
    assert.ok(JSON.stringify(second.fields.restore).includes('src/rogue.js'));
  });

  it('treats sandbox-unsupported as terminal, never cascading to a further configured model', () => {
    const fixture = setup();
    const first = driveToFirstWrite(fixture);
    const result = next(fixture.fixture, fixture.repo, first.stateFile, { failed: { kind: 'sandbox-unsupported', reason: 'Sandbox is not supported here.' } });
    assert.equal(result.action, 'done', JSON.stringify(result));
    assert.match(JSON.stringify(result), /sandbox-unsupported/);
    assert.match(JSON.stringify(result), /first-model/);
  });

  it('ends done listing every model tried with its failure kind on cascade exhaustion', () => {
    const fixture = setup();
    const first = driveToFirstWrite(fixture);
    const second = next(fixture.fixture, fixture.repo, first.stateFile, { failed: { kind: 'quota', reason: 'Transient provider failure 1.' } });
    assert.equal(second.action, 'delegate-write', second.error);
    const third = next(fixture.fixture, fixture.repo, second.stateFile, { failed: { kind: 'quota', reason: 'Transient provider failure 2.' } });
    assert.equal(third.action, 'done', JSON.stringify(third));
    const text = JSON.stringify(third);
    assert.match(text, /first-model/);
    assert.match(text, /second-model/);
    assert.match(text, /quota/);
  });
});
