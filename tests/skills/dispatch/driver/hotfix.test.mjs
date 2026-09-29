// Hot-fix recovery (SC1, SC2, SC8): a stall is repaired on the kept tree, then the stalled check re-runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { implementationOutcome, readFixtureState, readHandoffWalkthrough, writeOutcomeReply } from '../../../helpers/driver-harness.mjs';
import { cleanupOrdinaryDriverFixtures, createOrdinaryDriverFixture } from '../../../helpers/ordinary-driver-fixture.mjs';
import { HOTFIX, buggyRun, events, write } from '../../../helpers/hotfix-fixture.mjs';

afterEach(cleanupOrdinaryDriverFixtures);

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

  it('hotfix progress: clears the no-progress marker when no writer attempt remains to continue', () => {
    const fixture = createOrdinaryDriverFixture();
    let reopened = null;
    const result = buggyRun(fixture, {
      // A blocked tests-only writer stalls before RED validates, where a hot fix has no writer to continue.
      delegateWrite: (action) => (action.fields.stage === 'tests-only' ? writeOutcomeReply(action, implementationOutcome({ status: 'BLOCKED', blockers: ['fixture needs a helper'] })) : null),
      onDisposition: (action) => {
        if (!action.text.startsWith('Hot fix applied')) return { answer: HOTFIX };
        reopened = { action, ordinary: readFixtureState(action.stateFile).ordinary };
        return { answer: { decision: 'keep-for-repair', reason: 'Stop.' } };
      },
      // Before RED validates only tests-only paths are editable.
      onEdit: () => { write(fixture, 'tests/sample.test.mjs', "import assert from 'node:assert/strict';\nimport { value } from '../src/app.js';\nassert.equal(value, 2);\n"); return { answer: { done: true } }; },
    });
    assert.ok(reopened, JSON.stringify(result.asked.map(action => action.text?.slice(0, 80))));
    assert.match(reopened.action.text, /no writer attempt remains to continue from it/);
    assert.equal(reopened.ordinary.hotfixTarget, undefined, 'the stalled check never re-ran, so no-progress stays unjudged');
    assert.equal(reopened.ordinary.hotfixWithdrawn, undefined);
    assert.match(reopened.action.text, /First choice when evidence points/);
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
