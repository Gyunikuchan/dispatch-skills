// Hot-fix limit and budget routing (SC3): a host violation is refused in place, a writer's hands the tree
// to the host, and an over-budget host edit asks before continuing. Each limit is unit-tested in hotfix-limits.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { implementationOutcome, writeOutcomeReply } from '../../../helpers/driver-harness.mjs';
import { cleanupOrdinaryDriverFixtures, createOrdinaryDriverFixture, ordinaryDriverPolicy } from '../../../helpers/ordinary-driver-fixture.mjs';
import { HOTFIX, buggyRun, write } from '../../../helpers/hotfix-fixture.mjs';

afterEach(cleanupOrdinaryDriverFixtures);

describe('hot-fix routing', () => {
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

});
