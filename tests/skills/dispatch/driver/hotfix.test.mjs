// Hot-fix recovery (SC1–SC3, SC8): a stall is repaired on the kept tree, then the stalled check re-runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { readLedger } from '../../../../skills/dispatch/scripts/ledger/ledger.mjs';
import { implementationOutcome, readFixtureState, readHandoffWalkthrough, writeOutcomeReply } from '../../../helpers/driver-harness.mjs';
import { cleanupOrdinaryDriverFixtures, createOrdinaryDriverFixture, driveOrdinaryImplementation, ordinaryDriverPolicy } from '../../../helpers/ordinary-driver-fixture.mjs';

afterEach(cleanupOrdinaryDriverFixtures);

const HOTFIX = { decision: 'hotfix', mode: 'host', rootCause: 'value constant is off by one', reason: 'Scoped test names the locus.' };
const write = (fixture, file, content) => { fs.mkdirSync(path.dirname(path.join(fixture.repo.dir, file)), { recursive: true }); fs.writeFileSync(path.join(fixture.repo.dir, file), content); };
const events = done => readLedger(done.ledgerPath).events;

/** Production writes a wrong value, so the scoped gate fails and failure disposition opens. */
function buggyRun(fixture, { onDisposition, onEdit, onAsk, delegateWrite, onAction } = {}) {
  const base = ordinaryDriverPolicy(fixture.repo);
  const asked = [];
  let focus = null;
  const result = driveOrdinaryImplementation(fixture, { allowErrors: true, onAction(action) {
    if (action.action === 'launch' && !focus) focus = readFixtureState(action.stateFile).ordinary?.finalFocus ?? null;
    onAction?.(action);
  }, policy: {
    delegateWrite(action) {
      if (delegateWrite) { const reply = delegateWrite(action); if (reply) return reply; }
      if (action.fields.stage === 'tests-only') return base.delegateWrite(action);
      write(fixture, 'src/app.js', 'export const value = 3;\n');
      return writeOutcomeReply(action, implementationOutcome({ evidence: ['CRITERION SC1 | src/app.js | delivered value'] }));
    },
    askUser(action) {
      asked.push(action);
      if (onAsk) { const reply = onAsk(action, asked); if (reply) return reply; }
      if (action.question === 'failure-disposition') return onDisposition?.(action, asked) ?? { answer: { decision: 'keep-for-repair', reason: 'Stop here.' } };
      if (action.question === 'hotfix-edit') return onEdit(action, asked);
      return base.askUser(action);
    },
  } });
  return { ...result, asked, focus: () => focus };
}

describe('hot-fix recovery', () => {
  it('hotfix host: offers hotfix first, fixes on the kept tree, re-verifies, and records it', () => {
    const fixture = createOrdinaryDriverFixture();
    const result = buggyRun(fixture, {
      onDisposition: () => ({ answer: HOTFIX }),
      onEdit: () => { write(fixture, 'src/app.js', 'export const value = 2;\n'); return { answer: { done: true } }; },
    });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    const text = result.asked.find(action => action.question === 'failure-disposition').text;
    const order = ['"hotfix"', '"keep-for-repair"', '"retry"', '"inspect-first"', '"manual-complete"', '"revert-attributable"'].map(token => text.indexOf(token));
    assert.ok(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])), text);
    assert.match(text, /Last resort; requires the user's explicit approval in chat/);
    const types = events(result.done).map(event => event.type);
    assert.ok(types.indexOf('hotfix-start') < types.indexOf('hotfix'), types.join(','));
    const fix = events(result.done).find(event => event.type === 'hotfix').data;
    assert.deepEqual(fix.paths, ['src/app.js']);
    assert.equal(fix.evidenceRef, 'verify:scoped');
    assert.deepEqual(result.focus(), [{ path: 'src/app.js', reason: `hot fix: ${HOTFIX.rootCause}` }]);
  });

  it('hotfix host: over budget offers the writer with the tree unchanged; external paths are excluded and need a reason', () => {
    const fixture = createOrdinaryDriverFixture();
    let edits = 0, budget = null, refused = null;
    const result = buggyRun(fixture, {
      onDisposition: (action) => {
        if (!refused && !action.error) return { answer: { ...HOTFIX, external: [{ path: 'vendor/a.js' }] } };
        refused ??= action.error;
        if (action.text.startsWith('Over-budget')) return { answer: { decision: 'keep-for-repair', reason: 'Over budget.' } };
        return { answer: { ...HOTFIX, external: [{ path: 'vendor/a.js', reason: 'vendored copy' }] } };
      },
      onEdit: () => {
        edits++;
        for (let i = 0; i < 11; i++) write(fixture, `docs/extra-${i}.md`, `extra ${i}\n`);
        write(fixture, 'vendor/a.js', 'x\n'.repeat(400));
        return { answer: { done: true } };
      },
      onAsk: (action) => {
        if (action.question !== 'hotfix-budget') return null;
        budget = action;
        return { answer: { decision: 'disposition', reason: 'Too large for inline.' } };
      },
    });
    assert.match(refused?.message ?? '', /external entry needs \{path, reason\}/);
    assert.equal(edits, 1);
    assert.deepEqual(budget.items[0].paths.includes('vendor/a.js'), false);
    assert.equal(budget.items[0].files, 11);
    assert.match(budget.text, /nothing was reverted/);
    assert.equal(result.done.outcome, 'stable-failure', JSON.stringify(result.done));
    assert.equal(fs.existsSync(path.join(fixture.repo.dir, 'docs/extra-10.md')), true);
  });

  it('hotfix limit: refuses secrets, deletions, and git writes, keeping the tree', () => {
    const fixture = createOrdinaryDriverFixture();
    const errors = [];
    let round = 0;
    const result = buggyRun(fixture, {
      onDisposition: () => ({ answer: HOTFIX }),
      onEdit: (action) => {
        if (action.error) errors.push(action.error.message);
        round++;
        if (round === 1) { write(fixture, '.env', 'SECRET=1\n'); fs.rmSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs')); }
        if (round === 2) {
          fs.rmSync(path.join(fixture.repo.dir, '.env'));
          fixture.repo.git('checkout', '--', 'tests/sample.test.mjs');
          write(fixture, 'tests/sample.test.mjs', "import assert from 'node:assert/strict';\nimport { value } from '../src/app.js';\nassert.equal(value, 2);\n");
          fixture.repo.git('add', 'tests/sample.test.mjs');
        }
        if (round === 3) { fixture.repo.git('reset', '-q'); write(fixture, 'src/app.js', 'export const value = 2;\n'); }
        return { answer: { done: true } };
      },
    });
    assert.match(errors[0], /\.env: secrets path/);
    assert.match(errors[0], /tests\/sample\.test\.mjs: deleted a file that existed at task start/);
    assert.match(errors[1], /index changed/);
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
  });

  it('hotfix limit: refuses an edit to an ignored secrets path that git status omits', () => {
    const fixture = createOrdinaryDriverFixture();
    fs.appendFileSync(path.join(fixture.repo.dir, '.git/info/exclude'), '.env\n');
    write(fixture, '.env', 'SECRET=1\n');
    const envPath = path.join(fixture.repo.dir, '.env');
    const errors = [];
    const result = buggyRun(fixture, {
      onDisposition: () => ({ answer: HOTFIX }),
      onEdit: (action) => {
        if (action.error) { errors.push(action.error.message); fs.writeFileSync(envPath, 'SECRET=1\n'); }
        else write(fixture, '.env', 'SECRET=22\n');
        write(fixture, 'src/app.js', 'export const value = 2;\n');
        return { answer: { done: true } };
      },
    });
    assert.match(errors[0] ?? '', /\.env: secrets path \(ignored\)/);
    assert.ok(result.asked.filter(action => action.question === 'hotfix-edit').length >= 2);
  });

  it('hotfix limit: refuses a secrets file created inside an ignored directory', () => {
    const fixture = createOrdinaryDriverFixture();
    fs.appendFileSync(path.join(fixture.repo.dir, '.git/info/exclude'), 'tmp/\n');
    write(fixture, 'tmp/notes.txt', 'scratch\n');
    const errors = [];
    const result = buggyRun(fixture, {
      onDisposition: () => ({ answer: HOTFIX }),
      onEdit: (action) => {
        if (action.error) { errors.push(action.error.message); fs.rmSync(path.join(fixture.repo.dir, 'tmp/.env')); }
        else write(fixture, 'tmp/.env', 'SECRET=1\n');
        write(fixture, 'src/app.js', 'export const value = 2;\n');
        return { answer: { done: true } };
      },
    });
    assert.match(errors[0] ?? '', /tmp\/\.env: created an ignored secrets path/);
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
  });

  it('hotfix host: a binary change counts as over the line budget', () => {
    const fixture = createOrdinaryDriverFixture();
    let budget = null;
    buggyRun(fixture, {
      onDisposition: (action) => (action.text.startsWith('Over-budget') ? { answer: { decision: 'keep-for-repair', reason: 'Over budget.' } } : { answer: HOTFIX }),
      onEdit: () => { fs.writeFileSync(path.join(fixture.repo.dir, 'src/logo.bin'), Buffer.from([0, 1, 2, 0, 255])); return { answer: { done: true } }; },
      onAsk: (action) => {
        if (action.question !== 'hotfix-budget') return null;
        budget = action;
        return { answer: { decision: 'disposition', reason: 'Binary edit.' } };
      },
    });
    assert.ok(budget, 'hotfix-budget asked');
    assert.equal(budget.items[0].files, 1);
    assert.ok(budget.items[0].lines > 150, JSON.stringify(budget.items[0]));
  });

  it('hotfix limit: refuses production paths before RED validates', () => {
    const fixture = createOrdinaryDriverFixture();
    const errors = [];
    const base = ordinaryDriverPolicy(fixture.repo);
    const result = buggyRun(fixture, {
      // The tests-only writer leaves the test unchanged, so the RED gate passes where it must fail.
      delegateWrite: (action) => (action.fields.stage === 'tests-only' ? writeOutcomeReply(action, implementationOutcome({ stage: 'RED_READY', evidence: ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] })) : base.delegateWrite(action)),
      onDisposition: (action, asked) => (asked.filter(item => item.question === 'failure-disposition').length === 1 ? { answer: HOTFIX } : { answer: { decision: 'keep-for-repair', reason: 'Stop.' } }),
      onEdit: (action) => {
        if (action.error) {
          errors.push(action.error.message);
          write(fixture, 'src/app.js', 'export const value = 1;\n');
          fs.rmSync(path.join(fixture.repo.dir, 'src/app.js'));
          fixture.repo.git('checkout', '--', 'src/app.js');
          write(fixture, 'tests/sample.test.mjs', "import assert from 'node:assert/strict';\nimport { value } from '../src/app.js';\nassert.equal(value, 2);\n");
        } else {
          assert.match(action.text, /Before RED validates, edit only tests-only paths/);
          write(fixture, 'src/app.js', 'export const value = 2;\n');
        }
        return { answer: { done: true } };
      },
    });
    assert.match(errors[0], /src\/app\.js: production path before RED validates/);
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
  });

  it('hotfix progress: withdraws hot fix when the target failure survives it', () => {
    const fixture = createOrdinaryDriverFixture();
    const result = buggyRun(fixture, {
      onDisposition: (action, asked) => (asked.filter(item => item.question === 'failure-disposition').length === 1 ? { answer: HOTFIX } : { answer: { decision: 'keep-for-repair', reason: 'Stop.' } }),
      onEdit: () => { write(fixture, 'src/app.js', 'export const value = 3; // touched\n'); return { answer: { done: true } }; },
    });
    const second = result.asked.filter(action => action.question === 'failure-disposition')[1];
    assert.match(second.text, /Hot fix withdrawn: the last hot fix left its target failure unchanged/);
    assert.doesNotMatch(second.text, /First choice when evidence points/);
    assert.equal(result.done.outcome, 'stable-failure');
  });

  it('hotfix progress: writer mode launches one compact single-shot write without a RED gate', () => {
    const fixture = createOrdinaryDriverFixture();
    const writes = [];
    const result = buggyRun(fixture, {
      onDisposition: () => ({ answer: { ...HOTFIX, mode: 'writer' } }),
      delegateWrite: (action) => {
        writes.push(action);
        if (action.fields.launch !== 'hotfix') return null;
        const brief = JSON.parse(fs.readFileSync(action.fields.promptPath, 'utf8'));
        assert.equal(brief.purpose, 'hotfix');
        assert.equal(brief.rootCause, HOTFIX.rootCause);
        write(fixture, 'src/app.js', 'export const value = 2;\n');
        return writeOutcomeReply(action, implementationOutcome({ evidence: ['fixed value'] }));
      },
    });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.equal(writes.filter(action => action.fields.launch === 'hotfix').length, 1);
    const after = result.trace.slice(result.trace.findIndex(action => action.fields?.launch === 'hotfix') + 1);
    assert.equal(after.find(action => action.action === 'verify')?.purpose, 'scoped');
    assert.equal(events(result.done).find(event => event.type === 'hotfix').data.mode, 'writer');
  });

  for (const [label, reply] of [['an unavailable', () => ({ rejected: true, reason: 'model unavailable' })], ['a blocked', action => writeOutcomeReply(action, implementationOutcome({ status: 'BLOCKED', blockers: ['stuck'] }))]]) {
    it(`hotfix limit: ${label} writer's partial edits are judged before the stall reopens`, () => {
      const fixture = createOrdinaryDriverFixture();
      const edits = [];
      const result = buggyRun(fixture, {
        onDisposition: (action, asked) => (asked.filter(item => item.question === 'failure-disposition').length === 1 ? { answer: { ...HOTFIX, mode: 'writer' } } : { answer: { decision: 'keep-for-repair', reason: 'Stop here.' } }),
        delegateWrite: (action) => {
          if (action.fields.launch !== 'hotfix') return null;
          write(fixture, '.env', 'SECRET=1\n');
          return reply(action);
        },
        onEdit: (action) => { edits.push(action.text); fs.rmSync(path.join(fixture.repo.dir, '.env')); write(fixture, 'src/app.js', 'export const value = 2;\n'); return { answer: { done: true } }; },
      });
      assert.match(edits[0] ?? '', /\.env: secrets path/);
      assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    });
  }

  it('hotfix limit: refuses a .git/ config change that leaves HEAD, index, and stash alone', () => {
    const fixture = createOrdinaryDriverFixture();
    const errors = [];
    const result = buggyRun(fixture, {
      onDisposition: () => ({ answer: HOTFIX }),
      onEdit: (action) => {
        if (action.error) { errors.push(action.error.message); fixture.repo.git('config', '--unset', 'hotfix.probe'); }
        else fixture.repo.git('config', 'hotfix.probe', '1');
        write(fixture, 'src/app.js', 'export const value = 2;\n');
        return { answer: { done: true } };
      },
    });
    assert.match(errors[0] ?? '', /\.git\/ config, hooks, or info changed/);
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
  });

  it('hotfix walkthrough: lists hot fixes and scope extensions under Deviations & Follow-ups', () => {
    const fixture = createOrdinaryDriverFixture();
    const result = buggyRun(fixture, {
      onDisposition: () => ({ answer: HOTFIX }),
      onEdit: () => { write(fixture, 'src/app.js', 'export const value = 2;\n'); write(fixture, 'docs/fix-note.md', 'note\n'); return { answer: { done: true } }; },
    });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    const walkthrough = readHandoffWalkthrough(result.done);
    assert.match(walkthrough, /^- Deviation: Hot fix \(host\) — value constant is off by one; paths docs\/fix-note\.md, src\/app\.js; scope extensions: docs\/fix-note\.md \(hot fix: value constant is off by one\)\.$/m);
    assert.match(walkthrough, /^> \*\*Deviations:\*\* (?!none)/m);
  });
});
