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

import { createStubDispatchFixture } from '../../../helpers/stub-dispatch-fixture.mjs';
import path from 'node:path';

import { makeGitRepo, runDispatch, parseAction, DESIGN_BODY, drive, designFinding, report } from '../../../helpers/driver-harness.mjs';
import { firstReview } from '../../../helpers/scripted-review-fixture.mjs';
import { governingHash } from '../../../../skills/dispatch/scripts/ledger/ledger.mjs';

const config = { 'read-delegates': { agy: { targets: [{ low: { model: 'gemini-3.7-flash', effort: 'medium' } }] } }, phases: { 'plan-review': { rounds: { medium: 1 }, targets: { medium: 1 }, consensus: { medium: false } } } };

function withFixture(test) {
  const fixture = createStubDispatchFixture(config);
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

  it('accepts design-review fixes scoped to the design itself', () => withFixture((fixture, repo) => {
    let designRel = null;
    const stop = new Error('reached apply-fixes');
    assert.throws(() => drive(fixture, {
      cwd: repo.dir,
      runArgs: ['design', '--orchestrator', 'claude', '--', 'build a thing'],
      policy: {
        author: (action) => {
          fs.writeFileSync(action.path, DESIGN_BODY);
          designRel = path.relative(repo.dir, action.path).split(path.sep).join('/');
          return { path: action.path };
        },
        waveResults: firstReview(report([designFinding()])),
        fix: () => ({ affectedPaths: [designRel], dependsOn: [], verification: ['node --version'] }),
      },
      onAction: (action) => { if (action.action === 'apply-fixes') throw stop; },
    }), (err) => err === stop);
  }));

  it('asks approval for the post-review design revision, not the authored one', () => withFixture((fixture, repo) => {
    let designPath = null;
    let approval = null;
    const stop = new Error('reached approval');
    assert.throws(() => drive(fixture, {
      cwd: repo.dir,
      runArgs: ['design', '--orchestrator', 'claude', '--', 'build a thing'],
      policy: {
        author: (action) => { designPath = action.path; fs.writeFileSync(designPath, DESIGN_BODY); return { path: designPath }; },
        waveResults: firstReview(report([designFinding()])),
        fix: () => ({ affectedPaths: [path.relative(repo.dir, designPath).split(path.sep).join('/')], dependsOn: [], verification: ['node --version'] }),
        applyFixes: (action) => {
          fs.writeFileSync(designPath, fs.readFileSync(designPath, 'utf8').replace('## Final Integration\n', '## Final Integration\nReview-applied change.\n'));
          return { clusters: action.clusters.map((cluster) => ({ clusterId: cluster.clusterId, status: 'applied', paths: cluster.affectedPaths, note: 'edited' })) };
        },
      },
      onAction: (action) => { if (action.action === 'ask-user' && action.question === 'approval') { approval = action; throw stop; } },
    }), (err) => err === stop);
    assert.equal(approval.items[0].governingHash, governingHash(fs.readFileSync(designPath, 'utf8'), { kind: 'design' }).hash);
  }));
});
