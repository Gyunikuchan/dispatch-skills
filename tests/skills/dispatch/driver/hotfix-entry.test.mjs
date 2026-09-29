// Hot-fix entry points (SC4): blocked, missing-context, and baseline-red stalls offer a hot fix.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { readLedger } from '../../../../skills/dispatch/scripts/ledger/ledger.mjs';
import { implementationOutcome, writeOutcomeReply } from '../../../helpers/driver-harness.mjs';
import { cleanupOrdinaryDriverFixtures, createOrdinaryDriverFixture, driveOrdinaryImplementation, ordinaryDriverPolicy } from '../../../helpers/ordinary-driver-fixture.mjs';

afterEach(cleanupOrdinaryDriverFixtures);

const HOTFIX = { decision: 'hotfix', mode: 'host', rootCause: 'value constant is wrong', reason: 'Locus is known.' };
const setValue = (fixture, value) => fs.writeFileSync(path.join(fixture.repo.dir, 'src/app.js'), `export const value = ${value};\n`);

describe('hot-fix entry', () => {
  it('hotfix entry: a blocked writer is offered a hot fix, then continues from the fixed tree', () => {
    const fixture = createOrdinaryDriverFixture();
    const base = ordinaryDriverPolicy(fixture.repo);
    let blocked = null, productionWrites = 0;
    const result = driveOrdinaryImplementation(fixture, { policy: {
      delegateWrite(action) {
        if (action.fields.stage === 'production' && ++productionWrites === 1) return writeOutcomeReply(action, implementationOutcome({ status: 'BLOCKED', blockers: ['app.js export is unreadable'] }));
        if (productionWrites === 2) assert.match(action.fields.context, /Hot fix applied \(value constant is wrong\)/);
        return base.delegateWrite(action);
      },
      askUser(action) {
        if (action.question === 'implementation-blocked') { blocked = action.text; return { answer: HOTFIX }; }
        if (action.question === 'hotfix-edit') { setValue(fixture, 2); return { answer: { done: true } }; }
        return base.askUser(action);
      },
    } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.match(blocked, /\{decision:"hotfix", mode:"host"\|"writer"/);
    const events = readLedger(result.done.ledgerPath).events;
    assert.equal(events.find(event => event.type === 'hotfix').data.evidenceRef, 'writer-continuation');
    assert.ok(events.some(event => event.type === 'ruling' && event.data.key === 'blocking-condition' && event.data.decision === 'hotfix'));
  });

  it('hotfix entry: an unchanged blocker after a hot fix withdraws hot fix', () => {
    const fixture = createOrdinaryDriverFixture();
    const base = ordinaryDriverPolicy(fixture.repo);
    const blocked = [];
    const result = driveOrdinaryImplementation(fixture, { allowErrors: true, policy: {
      delegateWrite(action) {
        if (action.fields.stage === 'production') return writeOutcomeReply(action, implementationOutcome({ status: 'BLOCKED', blockers: ['app.js export is unreadable'] }));
        return base.delegateWrite(action);
      },
      askUser(action) {
        if (action.question === 'implementation-blocked') { blocked.push(action.text); return { answer: blocked.length === 1 ? HOTFIX : { decision: 'stop', reason: 'Stop here.' } }; }
        if (action.question === 'hotfix-edit') { setValue(fixture, 2); return { answer: { done: true } }; }
        return base.askUser(action);
      },
    } });
    assert.ok(result.done, 'run ends');
    assert.equal(blocked.length, 2, blocked.join('\n'));
    assert.match(blocked[1], /Hot fix withdrawn/);
  });

  it('hotfix entry: a missing-context stall offers a hot fix', () => {
    const fixture = createOrdinaryDriverFixture();
    const base = ordinaryDriverPolicy(fixture.repo);
    let context = null;
    const result = driveOrdinaryImplementation(fixture, { policy: {
      delegateWrite(action) {
        if (action.fields.stage === 'production') return writeOutcomeReply(action, implementationOutcome({ status: 'NEEDS_CONTEXT', missingContext: ['Which value is expected?'] }));
        return base.delegateWrite(action);
      },
      askUser(action) {
        if (action.question === 'implementation-context') { context = action.text; return { answer: { decision: 'stop', reason: 'Stop here.' } }; }
        return base.askUser(action);
      },
    } });
    assert.match(context, /\{decision:"hotfix"/);
    assert.equal(result.done.outcome, 'stable-failure');
  });

  it('hotfix entry: a baseline-red hot fix is host-only, re-captures the baseline, and is listed at approval', () => {
    const fixture = createOrdinaryDriverFixture();
    setValue(fixture, 5);
    const base = ordinaryDriverPolicy(fixture.repo);
    let offer = null, approval = null, writerRefused = null;
    const result = driveOrdinaryImplementation(fixture, { allowErrors: true, policy: {
      askUser(action) {
        if (action.question === 'baseline-red') {
          offer ??= action.text;
          if (!action.error) return { answer: { ...HOTFIX, mode: 'writer' } };
          writerRefused ??= action.error.message;
          return { answer: HOTFIX };
        }
        if (action.question === 'hotfix-edit') { setValue(fixture, 1); return { answer: { done: true } }; }
        if (action.question === 'approval') approval ??= action;
        return base.askUser(action);
      },
    } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.match(offer, /mode:"host",/);
    assert.match(writerRefused, /baseline hot fix is host-only/);
    assert.deepEqual(approval.items[0].hotfixes.map(fix => [fix.paths, fix.rootCause]), [[['src/app.js'], HOTFIX.rootCause]]);
    const baselines = result.trace.filter(action => action.action === 'verify' && action.purpose === 'baseline');
    assert.equal(baselines.length, 2, 'the touched baseline command re-runs');
    const events = readLedger(result.done.ledgerPath).events;
    const approvalAt = events.findIndex(event => event.type === 'approval'), hotfixAt = events.findIndex(event => event.type === 'hotfix');
    assert.ok(approvalAt >= 0 && hotfixAt > approvalAt, 'the baseline hot fix is recorded after approval opens the segment');
  });
});
