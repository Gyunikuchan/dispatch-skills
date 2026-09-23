/**
 * Regression for the `--run design` state-persistence defect: `next()` in driver/index.mjs used to
 * return `advanceDesign(state, checked.value)` without persisting the new pending action via
 * `save()`, so a design run's state file never advanced past the initial `author` pending action.
 * The following `--next` reply (e.g. the emitted `launch`) was then rejected because the driver
 * re-validated it against the stale `author` schema ("$ must be object").
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';

import { buildStubDispatchFixture } from './stub-dispatch-fixture.mjs';
import { makeGitRepo, runDispatch, parseAction, DESIGN_BODY } from './driver-harness.mjs';

const config = { 'read-delegates': { agy: { model: 'gemini-3.7-flash', effort: 'medium' } }, phases: { 'design-review': { rounds: { medium: 1 }, targets: { medium: 1 }, consensus: { medium: false } } } };

function withFixture(test) {
  const fixture = buildStubDispatchFixture(config);
  const repo = makeGitRepo();
  try { return test(fixture, repo); } finally { fixture.cleanup(); repo.cleanup(); }
}

describe('driver design state persistence', () => {
  it('persists pending action after design authoring so the launch reply is accepted', () => withFixture((fixture, repo) => {
    const start = runDispatch(fixture, ['--run', 'design', '--orchestrator', 'claude', '--', 'build a thing'], { cwd: repo.dir });
    assert.equal(start.status, 0, `design run must start: ${start.stderr}`);
    const authorAction = parseAction(start.stdout);
    assert.equal(authorAction.action, 'author');

    // Reply to author with a valid canonical design at the exact path the driver requested; the
    // state file must then hold the newly emitted pending action (a review `launch`), not the
    // stale `author` action.
    fs.writeFileSync(authorAction.path, DESIGN_BODY);
    const designPath = authorAction.path;
    const inputFile = fixture.dir + '/design-author-input.json';
    fs.writeFileSync(inputFile, JSON.stringify({ path: designPath }));
    const next = runDispatch(fixture, ['--next', '--state', authorAction.stateFile, '--input', `@${inputFile}`], { cwd: repo.dir });
    assert.equal(next.status, 0, `author reply must be accepted: ${next.stderr}`);
    const launchAction = parseAction(next.stdout);
    assert.notEqual(launchAction.action, 'author', 'driver must advance past the author step');

    // Confirm the persisted state file's pending action matches what was just emitted — proving
    // `save()` ran — rather than still recording the original `author` action.
    const persisted = JSON.parse(fs.readFileSync(authorAction.stateFile, 'utf8'));
    assert.equal(persisted.pending.action, launchAction.action);
    assert.notEqual(persisted.pending.action, 'author');
  }));
});
