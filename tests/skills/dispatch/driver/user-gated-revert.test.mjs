// User-gated revert (SC5): discards need the user's chat approval, and a patch is saved before the tree changes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { readLedger } from '../../../../skills/dispatch/scripts/ledger/ledger.mjs';
import { implementationOutcome, writeOutcomeReply } from '../../../helpers/driver-harness.mjs';
import { cleanupOrdinaryDriverFixtures, createOrdinaryDriverFixture, driveOrdinaryImplementation, ordinaryDriverPolicy } from '../../../helpers/ordinary-driver-fixture.mjs';

afterEach(cleanupOrdinaryDriverFixtures);

const APPROVED = { by: 'user', quote: 'Yes, revert it.' };

describe('user-gated revert', () => {
  it('user-gated revert: revert-attributable is listed last, refused without approval, and saves a patch first', () => {
    const fixture = createOrdinaryDriverFixture();
    const base = ordinaryDriverPolicy(fixture.repo);
    const errors = [];
    let text = null;
    const result = driveOrdinaryImplementation(fixture, { allowErrors: true, policy: {
      delegateWrite(action) {
        if (action.fields.stage === 'tests-only') return base.delegateWrite(action);
        fs.writeFileSync(path.join(fixture.repo.dir, 'src/app.js'), 'export const value = 3;\n');
        return writeOutcomeReply(action, implementationOutcome({ evidence: ['CRITERION SC1 | src/app.js | delivered value'] }));
      },
      askUser(action) {
        if (action.question !== 'failure-disposition') return base.askUser(action);
        text ??= action.text;
        if (action.error) errors.push(action.error.message);
        return { answer: { decision: 'revert-attributable', reason: 'Discard the broken attempt.', ...(errors.length ? { userApproved: APPROVED } : {}) } };
      },
    } });
    assert.equal(result.done.outcome, 'stable-failure', JSON.stringify(result.done));
    assert.match(errors[0], /revert-attributable revert requires userApproved: \{by, quote\}/);
    assert.ok(text.lastIndexOf('"revert-attributable"') > text.indexOf('"manual-complete"'), text);
    assert.equal(fs.readFileSync(path.join(fixture.repo.dir, 'src/app.js'), 'utf8'), 'export const value = 1;\n');
    const retained = result.done.handoff.retained.find(item => item.path.endsWith('.patch'));
    assert.match(retained.path, /reverts\/[^/]+-1\.patch$/);
    assert.match(retained.reason, /approved by user/);
    const patchFile = path.isAbsolute(retained.path) ? retained.path : path.join(fixture.repo.dir, retained.path);
    assert.match(fs.readFileSync(patchFile, 'utf8'), /\+export const value = 3;/);
    const ruling = readLedger(result.done.ledgerPath).events.find(event => event.type === 'ruling' && event.data.decision === 'revert-attributable');
    assert.ok(ruling.data.reason.includes(retained.path), ruling.data.reason);
  });

  it('user-gated revert: write-scope revert is refused without approval', () => {
    const fixture = createOrdinaryDriverFixture();
    const base = ordinaryDriverPolicy(fixture.repo);
    const errors = [];
    const result = driveOrdinaryImplementation(fixture, { allowErrors: true, policy: {
      askUser(action) {
        if (action.question !== 'write-scope') return base.askUser(action);
        assert.match(action.text, /Last resort; requires the user's explicit approval in chat/);
        if (action.error) errors.push(action.error.message);
        return { answer: { revert: ['docs/stray.md'], reason: 'Out of scope.', ...(errors.length ? { userApproved: APPROVED } : {}) } };
      },
      delegateWrite(action) {
        if (action.fields.stage === 'production') { fs.mkdirSync(path.join(fixture.repo.dir, 'docs'), { recursive: true }); fs.writeFileSync(path.join(fixture.repo.dir, 'docs/stray.md'), 'stray\n'); }
        return base.delegateWrite(action);
      },
    } });
    assert.match(errors[0], /write-scope revert requires userApproved/);
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.equal(fs.existsSync(path.join(fixture.repo.dir, 'docs/stray.md')), false);
  });
});
