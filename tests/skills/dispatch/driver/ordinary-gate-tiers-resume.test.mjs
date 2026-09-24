import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { runDispatch } from '../../../helpers/driver-harness.mjs';
import { cleanupOrdinaryDriverFixtures, driveOrdinaryImplementation, tierFixture, tierPolicy } from '../../../helpers/ordinary-driver-fixture.mjs';

afterEach(cleanupOrdinaryDriverFixtures);

const verifies = trace => trace.filter(action => action.action === 'verify');

describe('ordinary driver verification gate tiers: resume', () => {
  it('resumes after interruption at code review following only scoped gates and reaches the final gate', () => {
    const fixture = tierFixture(); let restarted = false;
    const result = driveOrdinaryImplementation(fixture, {
      policy: tierPolicy(fixture),
      onAction(action) {
        if (restarted || JSON.parse(fs.readFileSync(action.stateFile, 'utf8')).ordinary?.phase !== 'code-review') return;
        restarted = true;
        fs.rmSync(action.stateFile);
        const reply = runDispatch(fixture.fixture, ['--run', 'implement', '--phases', 'from:code-review', '--orchestrator', 'claude', '--', fixture.plan], { cwd: fixture.repo.dir });
        assert.equal(reply.status, 0, reply.stderr);
        const resumed = JSON.parse(reply.stdout);
        assert.notEqual(resumed.outcome, 'refused', JSON.stringify(resumed));
        Object.assign(action, resumed);
      },
    });
    assert.ok(restarted, 'the run was interrupted at code review');
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    const purposes = verifies(result.trace).map(action => action.purpose);
    assert.equal(purposes.filter(purpose => purpose === 'final').length, 1, purposes.join(' → '));
    assert.equal(purposes.at(-1), 'final');
  });

});
