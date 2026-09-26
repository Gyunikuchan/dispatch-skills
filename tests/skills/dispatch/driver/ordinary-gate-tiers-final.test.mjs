import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { implementationOutcome, writeOutcomeReply } from '../../../helpers/driver-harness.mjs';
import { cleanupOrdinaryDriverFixtures, driveOrdinaryImplementation, tierFixture, tierPolicy, withCriterionEvidence } from '../../../helpers/ordinary-driver-fixture.mjs';

afterEach(cleanupOrdinaryDriverFixtures);

const verifies = trace => trace.filter(action => action.action === 'verify');

describe('ordinary driver verification gate tiers: generated paths', () => {
  it('hands off when a [GENERATED] path is rewritten at the final gate', () => {
    const fixture = tierFixture();
    fs.writeFileSync(path.join(fixture.repo.dir, 'gen.mjs'), "import fs from 'node:fs';\nfs.writeFileSync('gen.txt', String(Date.now()));\n");
    fixture.repo.git('add', 'gen.mjs'); fixture.repo.git('commit', '--no-gpg-sign', '-qm', 'generator');
    fs.writeFileSync(fixture.plan, fs.readFileSync(fixture.plan, 'utf8').replace('## Verification Plan', '#### [GENERATED] gen.txt\n\n- Command: `node gen.mjs`\n\n## Verification Plan'));
    const policy = tierPolicy(fixture);
    const result = driveOrdinaryImplementation(fixture, { policy: {
      ...policy,
      realVerify: true,
      delegateWrite(action) {
        if (action.fields.stage === 'tests-only') {
          fs.writeFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { value } from '../src/app.js';\ntest('sample', () => { assert.equal(value, 2); });\n");
          return writeOutcomeReply(action, implementationOutcome({ stage: 'RED_READY', evidence: ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] }));
        }
        return policy.delegateWrite(action);
      },
      verify: withCriterionEvidence(() => undefined),
    } });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    const gates = verifies(result.trace);
    assert.equal(gates.at(-1).purpose, 'final');
    assert.deepEqual(gates.at(-1).generators, ['node gen.mjs']);
    assert.ok(fs.existsSync(path.join(fixture.repo.dir, 'gen.txt')));
  });

});
