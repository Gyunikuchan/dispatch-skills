// SC6: driver-verified RED rulings at the RED-gate failure disposition: rejections.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { readLedger } from '../../../../skills/dispatch/scripts/ledger/ledger.mjs';

import { implementationOutcome } from '../../../helpers/driver-harness.mjs';
import { cleanupOrdinaryDriverFixtures, createOrdinaryDriverFixture, driveOrdinaryImplementation, ordinaryDriverPolicy } from '../../../helpers/ordinary-driver-fixture.mjs';
import { RED_ROW, assertRejected, carryOver, interruptedRun, noFailingState, resumedRun } from '../../../helpers/red-ruling-fixture.mjs';

afterEach(cleanupOrdinaryDriverFixtures);

describe('ordinary driver: RED rulings rejected (SC6)', () => {
  it('rejects a carry-over ruling naming a wrong runId and keeps the question open', () => {
    const { fixture } = interruptedRun();
    const wrong = '00000000-0000-4000-8000-000000000000';
    const result = resumedRun(fixture, [carryOver(wrong), 'keep-for-repair']);
    assertRejected(result, new RegExp(wrong));
  });

  it('rejects a no-failing-state ruling when the plan declares no RED exception class', () => {
    const { fixture } = interruptedRun();
    const result = resumedRun(fixture, [noFailingState(), 'keep-for-repair']);
    assertRejected(result, /RED exception/i);
  });

  it('rejects carry-over entries citing two different runIds', () => {
    const { fixture, priorRunId } = interruptedRun();
    const other = '11111111-1111-4111-8111-111111111111';
    const result = resumedRun(fixture, [carryOver(priorRunId, [{ criterionId: 'SC1', kind: 'carry-over', runId: other }]), 'keep-for-repair']);
    assertRejected(result, /runId/);
  });

  it('does not offer red-ruling at a tests-only admission failure after a load-failure retry', () => {
    const fixture = createOrdinaryDriverFixture(); let calls = 0; const offered = [];
    const base = ordinaryDriverPolicy(fixture.repo);
    driveOrdinaryImplementation(fixture, { allowErrors: true, policy: {
      delegateWrite(action) {
        if (action.fields.stage === 'production') return base.delegateWrite(action);
        if (++calls > 1) return { raw: '{"status":"DONE"}' };
        fs.writeFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), "import assert from 'node:assert/strict';\nimport { missing } from '../src/app.js';\nassert.equal(missing, 2);\n");
        return { raw: JSON.stringify(implementationOutcome({ stage: 'RED_READY', evidence: [RED_ROW] })) };
      },
      verify(action) {
        const reply = base.verify(action);
        if (fs.readFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), 'utf8').includes('missing')) for (const item of reply.results) item.identifiers = ['error:load tests/sample.test.mjs'];
        return reply;
      },
      askUser(action) {
        if (action.question === 'implementation-recovery') return { answer: { raw: '{"status":"DONE"}' } };
        if (action.question === 'failure-disposition') { offered.push(/red-ruling/.test(action.text)); return { answer: { decision: 'inspect-first', reason: 'Inspect admission failure.' } }; }
        return base.askUser(action);
      },
    } });
    assert.ok(calls >= 2, 'the load failure relaunched tests-only');
    assert.deepEqual(offered, [false]);
  });

  // NOTE: the unrelated RED-gate defect is stale RED evidence: the test file changes after the RED run.
  it('rejects a valid ruling when another RED-gate defect remains, naming it and keeping the question open', () => {
    const { fixture, priorRunId } = interruptedRun();
    const result = resumedRun(fixture, [carryOver(priorRunId), 'keep-for-repair'], {
      beforeRuling: f => fs.appendFileSync(path.join(f.repo.dir, 'tests/sample.test.mjs'), '// mutated after the RED run\n'),
    });
    assertRejected(result, /RED host evidence is stale or changed the repository/);
    const events = readLedger(result.done.ledgerPath).events;
    assert.equal(events.some(event => event.type === 'ruling' && event.data.key === 'red-exception'), false, 'red-ruling did not validate');
  });
});
