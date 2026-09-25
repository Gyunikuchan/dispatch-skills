// SC6: driver-verified RED rulings at the RED-gate failure disposition.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { persistEvidence } from '../../../../skills/dispatch/scripts/driver/implement-state.mjs';

import { cleanupOrdinaryDriverFixtures } from '../../../helpers/ordinary-driver-fixture.mjs';
import { assertAccepted, carryOver, interruptedRun, noFailingState, resumedRun, walkthroughText } from '../../../helpers/red-ruling-fixture.mjs';

afterEach(cleanupOrdinaryDriverFixtures);

describe('ordinary driver: RED rulings accepted (SC6)', () => {
  it('accepts a carry-over ruling citing the interrupted segment and renders it in the RED matrix', () => {
    const { fixture, priorRunId } = interruptedRun();
    const result = resumedRun(fixture, [carryOver(priorRunId)]);
    assertAccepted(result);
    const walkthrough = walkthroughText(result);
    assert.match(walkthrough, /### RED matrix/);
    assert.match(walkthrough, new RegExp(`SC1 \\| carried over from ${priorRunId}: tests/sample\\.test\\.mjs`));
  });

  it('accepts a carry-over ruling when the tests-only writer leaves the retained tests untouched', () => {
    const { fixture, priorRunId } = interruptedRun();
    const result = resumedRun(fixture, [carryOver(priorRunId)], { untouched: true });
    assert.match(JSON.stringify(result.questions[0].items), /Tests-only mutation must change only/);
    assertAccepted(result);
  });

  it('accepts a carry-over ruling for a criterion mapped to two commands', () => {
    const { fixture, priorRunId } = interruptedRun({ multiCommand: true });
    assert.match(fs.readFileSync(fixture.plan, 'utf8'), /--test-reporter=spec/);
    const result = resumedRun(fixture, [carryOver(priorRunId)]);
    assertAccepted(result);
    assert.match(walkthroughText(result), new RegExp(`SC1 \\| carried over from ${priorRunId}: tests/sample\\.test\\.mjs`));
  });

  it('renders a missed exception join as an evidence-missing row instead of throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-red-join-'));
    try {
      const walkthroughPath = path.join(dir, 'walkthrough.md');
      fs.writeFileSync(walkthroughPath, '# Walkthrough\n\n> **TL;DR:** Pending.\n> **Status:** 0/0 SC passing\n> **Deviations:** none\n\n## Verification & Validation\n- pending\n\n## Outcome Traceability\n- pending\n\n## Key Deviations\nNone.\n');
      const state = { repoRoot: dir, planPath: path.join(dir, 'plan.md'), walkthroughPath, governingHash: 'sha256:x', ordinary: {
        criteria: [], redValidated: { scopeHash: 'x', evidence: [], exceptions: [{ criterionId: 'SC1', kind: 'carry-over', runId: 'gone' }] } } };
      assert.doesNotThrow(() => persistEvidence(state));
      assert.match(fs.readFileSync(walkthroughPath, 'utf8'), /SC1 \| exception evidence missing \| —/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a no-failing-state ruling against a declared class and an existing locus', () => {
    const { fixture } = interruptedRun({ redException: 'already-satisfied' });
    const result = resumedRun(fixture, [noFailingState()]);
    assertAccepted(result);
    assert.match(walkthroughText(result), /SC1 \| N\/A — src\/app\.js:1 \| exception \(already-satisfied\): src\/app\.js already exports value=2\./);
  });

  it('resumes into production after an interruption that follows an accepted ruling', () => {
    const { fixture, priorRunId } = interruptedRun();
    let restarted = false;
    const result = resumedRun(fixture, [carryOver(priorRunId)], {
      restartWhen: action => !restarted && action.action === 'delegate-write' && action.fields.stage === 'production' && (restarted = true),
    });
    assert.equal(result.restarts, 1);
    assert.equal(result.questions.length, 1, 'the resolved failure is not reopened on resume');
    const afterRestart = result.trace.slice(result.trace.findIndex(action => action.action === 'delegate-write' && action.fields.stage === 'production') + 1);
    assert.equal(afterRestart[0].action, 'ask-user', JSON.stringify(afterRestart[0]));
    assert.equal(afterRestart[0].question, 'implementation-recovery', 'the restored production write is recovered, not relaunched');
    assert.equal(afterRestart.some(action => action.action === 'delegate-write'), false);
    assertAccepted(result);
  });
});
