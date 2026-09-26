// SC3 (native-fallback model cascade): write cascade advances on `rejected` and on the new
// `failed:{kind,reason}` reply form, never incrementing `attempt` on a transport hop, carries a
// `continuation` note naming the failed model and kind, emits `restore` only when the partial diff
// leaves the approved set, treats terminal kinds (e.g. `sandbox-unsupported`) as immediately
// terminal, and ends exhaustion listing every model tried with its failure kind.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { validateReply } from '../../../../skills/dispatch/scripts/driver/actions.mjs';
import { inspectEnvelope } from '../../../../skills/dispatch/scripts/driver/write.mjs';
import { createStubDispatchFixture } from '../../../helpers/stub-dispatch-fixture.mjs';
import { drive, implementationOutcome, makeGitRepo, parseAction, PLAN_BODY, runDispatch, writePlan } from '../../../helpers/driver-harness.mjs';

const levels = { low: 1, medium: 1, high: 1, xhigh: 1, max: 1 };
const CONFIG = {
  'read-delegates': { agy: { targets: [{ low: { model: 'gemini-3.7-flash', effort: 'medium' } }] } },
  'write-subagents': { claude: { low: { model: ['first-model', 'second-model'], effort: 'low' } } },
  phases: Object.fromEntries(['plan-review', 'code-review'].map((key) => [
    key, { rounds: levels, targets: levels, consensus: Object.fromEntries(Object.keys(levels).map((level) => [level, false])) },
  ])),
};

const cleanup = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

function setup() {
  const fixture = createStubDispatchFixture(CONFIG);
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
  it('accepts exactly one of envelopePath, rejected, or failed:{kind,reason}', () => {
    assert.equal(validateReply('delegate-write', { envelopePath: 'C:/session/run-write-id.json' }).ok, true);
    const result = validateReply('delegate-write', { failed: { kind: 'quota', reason: 'transient failure' } });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(validateReply('delegate-write', { raw: '{"schemaVersion":1}' }).ok, false);
    assert.equal(validateReply('delegate-write', { envelope: {} }).ok, false);
  });

  it('rejects a failed form missing kind or reason', () => {
    assert.equal(validateReply('delegate-write', { failed: { reason: 'x' } }).ok, false);
    assert.equal(validateReply('delegate-write', { failed: { kind: 'quota' } }).ok, false);
  });

  it('still rejects ambiguous combinations including failed alongside another form', () => {
    assert.equal(validateReply('delegate-write', { failed: { kind: 'quota', reason: 'x' }, rejected: true }).ok, false);
  });
});

describe('delegate-write envelope path', () => {
  const outcome = () => implementationOutcome({ stage: 'RED_READY', summary: 'test outcome checked', evidence: ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'], concerns: ['The fixture records a concern.'] });
  const save = (file, envelope = outcome()) => fs.writeFileSync(file, JSON.stringify(envelope));

  it('accepts the exact pending path after process resume and echoes concise status, summary, and concerns', () => {
    const fx = setup();
    const first = driveToFirstWrite(fx);
    const expected = first.fields.expectedEnvelopePath;
    assert.equal(JSON.parse(fs.readFileSync(first.stateFile, 'utf8')).pending.fields.expectedEnvelopePath, expected);
    save(expected, { ...outcome(), status: 'DONE_WITH_CONCERNS' });
    const selfCheck = runDispatch(fx.fixture, ['--check-envelope', expected, '--state', first.stateFile], { cwd: fx.repo.dir });
    assert.equal(selfCheck.status, 0, selfCheck.stderr);
    assert.deepEqual(JSON.parse(selfCheck.stdout), { ok: true });
    const nextAction = next(fx.fixture, fx.repo, first.stateFile, { envelopePath: expected });
    assert.equal(nextAction.action, 'ask-user');
    assert.equal(nextAction.question, 'implementation-concerns');
    assert.match(nextAction.guidance.join(' '), /Previous write outcome: DONE_WITH_CONCERNS; summary: test outcome checked; concerns: The fixture records a concern/);
  });

  it('refuses a missing file at the exact path with repair guidance', () => {
    const fx = setup();
    const first = driveToFirstWrite(fx);
    const retried = next(fx.fixture, fx.repo, first.stateFile, { envelopePath: first.fields.expectedEnvelopePath });
    assert.equal(retried.action, 'delegate-write');
    assert.match(retried.error, /Expected envelope file is missing/);
    assert.match(retried.error, /Repair the envelope at/);
  });

  it('refuses malformed JSON at the exact path', () => {
    const fx = setup();
    const first = driveToFirstWrite(fx);
    fs.writeFileSync(first.fields.expectedEnvelopePath, '{broken');
    const retried = next(fx.fixture, fx.repo, first.stateFile, { envelopePath: first.fields.expectedEnvelopePath });
    assert.equal(retried.action, 'delegate-write');
    assert.match(retried.error, /Expected envelope file is invalid/);
  });

  it('routes a structurally valid RED envelope with missing admission evidence to repair', () => {
    const fx = setup();
    const first = driveToFirstWrite(fx);
    save(first.fields.expectedEnvelopePath, { ...outcome(), status: 'DONE_WITH_CONCERNS', evidence: ['RED evidence without a matrix row'] });
    const selfCheck = runDispatch(fx.fixture, ['--check-envelope', first.fields.expectedEnvelopePath, '--state', first.stateFile], { cwd: fx.repo.dir });
    assert.equal(selfCheck.status, 1, selfCheck.stderr);
    assert.equal(JSON.parse(selfCheck.stdout).ok, false);
    const repaired = next(fx.fixture, fx.repo, first.stateFile, { envelopePath: first.fields.expectedEnvelopePath });
    assert.equal(repaired.action, 'delegate-write', repaired.error);
    assert.ok(JSON.parse(fs.readFileSync(repaired.stateFile, 'utf8')).ordinary.testsOnlyRepair, repaired.error);
    assert.match(repaired.guidance.join(' '), /Previous write outcome/);
  });

  it('self-checks a tests-only BLOCKED envelope without requiring RED admission evidence', () => {
    const fx = setup();
    const first = driveToFirstWrite(fx);
    save(first.fields.expectedEnvelopePath, implementationOutcome({
      status: 'BLOCKED', stage: 'COMPLETE', evidence: [], blockers: ['The requested API is unavailable.'],
    }));
    const selfCheck = runDispatch(fx.fixture, ['--check-envelope', first.fields.expectedEnvelopePath, '--state', first.stateFile], { cwd: fx.repo.dir });
    assert.equal(selfCheck.status, 0, selfCheck.stderr);
    assert.deepEqual(JSON.parse(selfCheck.stdout), { ok: true });
  });

  it('refuses production DONE stage and trace defects at the same delegate-write path', () => {
    const fx = setup();
    const first = driveToFirstWrite(fx);
    const state = JSON.parse(fs.readFileSync(first.stateFile, 'utf8'));
    state.ordinary.launch = 'full';
    const expected = first.fields.expectedEnvelopePath;
    save(expected, implementationOutcome({ stage: 'RED_READY', evidence: ['CRITERION SC1 | src/app.js | delivered value=2'] }));
    assert.match(inspectEnvelope(state, expected).errors.join(' '), /must report stage COMPLETE \(got RED_READY\)/);
    save(expected, implementationOutcome({ stage: 'COMPLETE', evidence: ['An observation without a criterion row'] }));
    assert.match(inspectEnvelope(state, expected).errors.join(' '), /Evidence needs a row "CRITERION SC1/);
  });

  it('reissues a legacy pending write on resume without a reply', () => {
    const fx = setup();
    const first = driveToFirstWrite(fx);
    const state = JSON.parse(fs.readFileSync(first.stateFile, 'utf8'));
    delete state.pending.fields.expectedEnvelopePath;
    delete state.ordinary.expectedEnvelopePath;
    fs.writeFileSync(first.stateFile, JSON.stringify(state));
    const result = runDispatch(fx.fixture, ['--next', '--state', first.stateFile], { cwd: fx.repo.dir });
    assert.equal(result.status, 0, result.stderr);
    const reissued = parseAction(result.stdout);
    assert.equal(reissued.action, 'delegate-write', reissued.error);
    assert.ok(reissued.fields.expectedEnvelopePath);
    assert.match(reissued.guidance.join(' '), /Legacy pending write/);
  });

  it('rejects a path from a prior write action as stale', () => {
    const fx = setup();
    const first = driveToFirstWrite(fx);
    const second = next(fx.fixture, fx.repo, first.stateFile, { failed: { kind: 'quota', reason: 'retry the write' } });
    assert.equal(second.action, 'delegate-write');
    assert.notEqual(second.fields.expectedEnvelopePath, first.fields.expectedEnvelopePath);
    save(first.fields.expectedEnvelopePath);
    const retried = next(fx.fixture, fx.repo, second.stateFile, { envelopePath: first.fields.expectedEnvelopePath });
    assert.equal(retried.action, 'delegate-write');
    assert.match(retried.error, /stale envelope path/);
  });

  it('rejects a foreign path even when it names a valid file in the session', () => {
    const fx = setup();
    const first = driveToFirstWrite(fx);
    const foreign = path.join(path.dirname(first.fields.expectedEnvelopePath), 'other-write.json');
    save(foreign);
    const retried = next(fx.fixture, fx.repo, first.stateFile, { envelopePath: foreign });
    assert.equal(retried.action, 'delegate-write');
    assert.match(retried.error, /foreign envelope path/);
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
