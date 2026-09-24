// SC3/SC4: scripted skill-integrity diagnostics and owned-hash regeneration.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { generateSkillHashes } from '../../../../skills/dispatch/scripts/lib/integrity.mjs';

import { createStubDispatchFixture } from '../../../helpers/stub-dispatch-fixture.mjs';
import { codeFinding, drive, makeGitRepo, report, writePlan } from '../../../helpers/driver-harness.mjs';
import { cleanupScriptedRepos, disposeScriptedFixtures, config, cleanups, actions, firstReview } from '../../../helpers/scripted-review-fixture.mjs';

afterEach(cleanupScriptedRepos);
after(disposeScriptedFixtures);

// SECTION: Skill integrity diagnostics and owned-hash regeneration (SC3, SC4)

const manifestText = (skillDir) => `${JSON.stringify(generateSkillHashes(skillDir), null, 2)}\n`;

describe('scripted driver: skill integrity (SC3, SC4)', () => {
  it('SC3: a missing envelope with failed skill integrity ends failed naming each file and npm run hashes, without relaunch', () => {
    const fixture = createStubDispatchFixture(config());
    cleanups.push(fixture.cleanup);
    const repo = makeGitRepo();
    cleanups.push(repo.cleanup);
    const manifest = generateSkillHashes(fixture.skillDir);
    manifest['SKILL.md'] = '0'.repeat(64);
    manifest['scripts/dispatch.mjs'] = 'f'.repeat(64);
    fs.writeFileSync(path.join(fixture.skillDir, 'skill-hashes.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const plan = writePlan(repo.dir);
    const run = drive(fixture, { cwd: repo.dir, runArgs: ['review', '--orchestrator', 'claude', '--', plan] });
    assert.equal(run.done.outcome, 'failed', JSON.stringify(run.done));
    assert.match(run.done.summary, /SKILL\.md/);
    assert.match(run.done.summary, /scripts\/dispatch\.mjs/);
    assert.match(run.done.summary, /npm run hashes/);
    assert.deepEqual(actions(run.trace), ['launch', 'done'], 'no relaunch after an integrity failure');
  });

  /** A stub fixture whose root is a Git repository containing the skill directory, with a fresh manifest. */
  function skillRepo() {
    const fixture = createStubDispatchFixture(config({ rounds: 2 }));
    cleanups.push(fixture.cleanup);
    const git = (...args) => execFileSync('git', args, { cwd: fixture.dir, stdio: 'pipe' });
    git('init', '-q', '-b', `skill-${path.basename(fixture.dir).slice(-6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`);
    fs.appendFileSync(path.join(fixture.dir, '.git', 'config'), '[user]\n\temail = test@example.com\n\tname = Test\n[core]\n\tautocrlf = false\n');
    fs.mkdirSync(path.join(fixture.dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(fixture.dir, '.scratch', 'plan'), { recursive: true });
    fs.writeFileSync(path.join(fixture.dir, 'src', 'app.js'), 'export const value = 1;\n');
    fs.writeFileSync(path.join(fixture.skillDir, 'skill-hashes.json'), manifestText(fixture.skillDir));
    git('add', '-A');
    git('commit', '--no-gpg-sign', '-qm', 'initial');
    fs.writeFileSync(path.join(fixture.dir, 'src', 'app.js'), 'export const value = 2;\n');
    return fixture;
  }

  const SKILL_FIX = { affectedPaths: ['dispatch/SKILL.md'], dependsOn: [], verification: ['node --version'] };
  const editSkill = (fixture, extra = []) => (action) => {
    fs.appendFileSync(path.join(fixture.skillDir, 'SKILL.md'), '\n<!-- fixed -->\n');
    for (const file of extra) fs.appendFileSync(path.join(fixture.skillDir, file), '\n<!-- foreign -->\n');
    return { clusters: action.clusters.map((c) => ({ clusterId: c.clusterId, status: 'applied', paths: c.affectedPaths, note: 'edited' })) };
  };

  it('SC4: apply-fixes regenerates skill-hashes.json when every violation is an applied affected path', () => {
    const fixture = skillRepo();
    const run = drive(fixture, {
      cwd: fixture.dir,
      runArgs: ['review', '--kind', 'code', '--fix', '--orchestrator', 'claude'],
      policy: {
        waveResults: firstReview(report([codeFinding({ locus: 'dispatch/SKILL.md:L1' })])),
        fix: () => SKILL_FIX,
        applyFixes: editSkill(fixture),
      },
    });
    assert.ok(actions(run.trace).includes('apply-fixes'));
    const written = fs.readFileSync(path.join(fixture.skillDir, 'skill-hashes.json'), 'utf8');
    assert.equal(JSON.parse(written)['SKILL.md'], generateSkillHashes(fixture.skillDir)['SKILL.md'], 'manifest regenerated for the owned edit');
    assert.equal(written, manifestText(fixture.skillDir));
    assert.equal(run.done.outcome, 'complete', JSON.stringify(run.done));
  });

  it('SC4: apply-fixes leaves skill-hashes.json untouched and fails when a violation is outside the applied paths', () => {
    const fixture = skillRepo();
    const manifestPath = path.join(fixture.skillDir, 'skill-hashes.json');
    const before = fs.readFileSync(manifestPath, 'utf8');
    const run = drive(fixture, {
      cwd: fixture.dir,
      runArgs: ['review', '--kind', 'code', '--fix', '--orchestrator', 'claude'],
      policy: {
        waveResults: firstReview(report([codeFinding({ locus: 'dispatch/SKILL.md:L1' })])),
        fix: () => SKILL_FIX,
        applyFixes: editSkill(fixture, ['references/review.md']),
      },
    });
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), before);
    assert.equal(run.done.outcome, 'failed', JSON.stringify(run.done));
    assert.match(run.done.summary, /references\/review\.md/);
    assert.match(run.done.summary, /npm run hashes/);
    const seq = actions(run.trace);
    assert.equal(seq.slice(seq.indexOf('apply-fixes') + 1).includes('verify'), false, seq.join(' → '));
  });

  // NOTE: a manifest stale before launch stops the review delegate, so staleness appears during apply-fixes
  // outside every applied affected path; the driver must still check the skill dir inside the repo.
  it('SC4: apply-fixes catches a stale manifest even when no applied affected path is in the skill directory', () => {
    const fixture = skillRepo();
    const manifestPath = path.join(fixture.skillDir, 'skill-hashes.json');
    const before = fs.readFileSync(manifestPath, 'utf8');
    const run = drive(fixture, {
      cwd: fixture.dir,
      runArgs: ['review', '--kind', 'code', '--fix', '--orchestrator', 'claude'],
      policy: {
        waveResults: firstReview(report([codeFinding({ locus: 'src/app.js:L1' })])),
        fix: () => ({ affectedPaths: ['src/app.js'], dependsOn: [], verification: ['node --version'] }),
        applyFixes: (action) => {
          fs.appendFileSync(path.join(fixture.dir, 'src', 'app.js'), '// fixed\n');
          fs.appendFileSync(path.join(fixture.skillDir, 'references', 'review.md'), '\n<!-- stale -->\n');
          return { clusters: action.clusters.map((c) => ({ clusterId: c.clusterId, status: 'applied', paths: c.affectedPaths, note: 'edited' })) };
        },
      },
    });
    assert.ok(actions(run.trace).includes('apply-fixes'));
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), before);
    assert.equal(run.done.outcome, 'failed', JSON.stringify(run.done));
    assert.match(run.done.summary, /references\/review\.md/);
    assert.match(run.done.summary, /npm run hashes/);
  });
});
