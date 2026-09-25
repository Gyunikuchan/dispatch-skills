// Gate rulings rewrite stale resolution text: setEntryResolution unit behavior and driver-level gate rulings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, afterEach, describe, it } from 'node:test';

import * as reviewArtifact from '../../../../skills/dispatch/scripts/driver/review-artifact.mjs';
import { allProviders, drive, planFinding, rebuttal, report, writePlan } from '../../../helpers/driver-harness.mjs';
import { cleanupScriptedRepos, config, disposeScriptedFixtures, setup } from '../../../helpers/scripted-review-fixture.mjs';

afterEach(cleanupScriptedRepos);
after(disposeScriptedFixtures);

// SECTION: setEntryResolution

const entry = (id, status, resolution) =>
  `- **[${status}]** [${id}] [MUST] [sources=plan-review:R1:agy:0] § Verification Plan — testability: No failure-path test is named. → ${resolution}`;

/** @returns {(markdown: string, id: string, text: string) => string} */
function setEntryResolution() {
  const fn = /** @type {any} */ (reviewArtifact).setEntryResolution;
  assert.equal(typeof fn, 'function', 'review-artifact.mjs exports setEntryResolution');
  return fn;
}

describe('setEntryResolution', () => {
  const log = ['## Review Findings & Resolutions', '', '### Round 1 — 2026-09-25',
    entry('R1-F001', 'Accepted', 'Old accepted text.'), entry('R1-F002', 'Rejected / Downgraded', 'Rejected: not a defect.'), ''].join('\n');

  it('setEntryResolution replaces only the text after the arrow on the matching entry', () => {
    const next = setEntryResolution()(log, 'R1-F002', 'Fixed at gate.');
    const lines = next.split('\n');
    assert.equal(lines[4], entry('R1-F002', 'Rejected / Downgraded', 'Fixed at gate.'));
    assert.equal(lines[3], entry('R1-F001', 'Accepted', 'Old accepted text.'), 'other entries stay untouched');
    assert.equal(next.replace('Fixed at gate.', 'Rejected: not a defect.'), log, 'nothing else changes');
  });

  it('setEntryResolution sanitizes the new text to one clean line', () => {
    const next = setEntryResolution()(log, 'R1-F001', 'Use `fixture` path\n```\nrm -rf /\n```\nthen → done');
    const line = next.split('\n')[3];
    assert.ok(line.endsWith(' → Use fixture path then -> done'), line);
    assert.equal(next.split('\n').length, log.split('\n').length, 'no line is added');
  });

  it('setEntryResolution keeps the existing text when the new text sanitizes to nothing', () => {
    const next = setEntryResolution()(log, 'R1-F001', '```\nonly code\n```');
    assert.equal(next, log);
  });

  it('setEntryResolution preserves CRLF line endings', () => {
    const crlf = log.replace(/\n/g, '\r\n');
    const next = setEntryResolution()(crlf, 'R1-F001', 'New text.');
    assert.ok(next.includes(`${entry('R1-F001', 'Accepted', 'New text.')}\r\n`));
    assert.ok(!/[^\r]\n/.test(next), 'every newline stays CRLF');
  });

  it('setEntryResolution leaves the markdown unchanged for an unknown id', () => {
    assert.equal(setEntryResolution()(log, 'R9-F009', 'Anything.'), log);
  });
});

// SECTION: gate rulings through the driver

const lineFor = (plan, key) => fs.readFileSync(plan, 'utf8').split(/\r?\n/).find((line) => line.includes(`[${key}]`)) ?? '';

/** Round-cap run: host rejects, the delegate REBUTs, and the cap asks for rulings answered by `answerFor`. */
function roundCapRun(answerFor) {
  const { fixture, repo } = setup(config({ consensus: true, rounds: 1 }));
  const plan = writePlan(repo.dir);
  const asked = [];
  const run = drive(fixture, {
    cwd: repo.dir, runArgs: ['review', '--orchestrator', 'claude', '--', plan],
    policy: {
      rule: () => ({ status: 'rejected', resolution: 'Rejected: the plan already names it.' }),
      waveResults: (action) => action.wave.type === 'rebuttal'
        ? allProviders(rebuttal(action.keys.map((key) => [key, 'REBUT'])))
        : allProviders(report(action.wave.type === 'review' ? [planFinding()] : [])),
      askUser: (action) => {
        assert.ok(!action.error, `gate ruling answer was refused: ${action.error}`);
        asked.push(action);
        return { answer: Object.fromEntries(action.items.map((item) => [item.key, answerFor(item.key)])) };
      },
    },
  });
  assert.equal(run.done.outcome, 'complete', JSON.stringify(run.done));
  assert.equal(asked.length, 1);
  return { plan, key: asked[0].items[0].key };
}

/** needs-user run: the host defers a SHOULD finding to the user, who answers with `answerFor`. */
function needsUserRun(answerFor) {
  const { fixture, repo } = setup(config({ rounds: 1 }));
  const plan = writePlan(repo.dir);
  let ruled = null;
  const run = drive(fixture, {
    cwd: repo.dir, runArgs: ['review', '--orchestrator', 'claude', '--', plan],
    policy: {
      rule: () => ({ status: 'needs-user', resolution: 'Host could not decide.' }),
      waveResults: (action) => allProviders(report(action.wave.type === 'review' && action.wave.round === 1 ? [planFinding({ severity: 'SHOULD' })] : [])),
      askUser: (action) => {
        assert.ok(!action.error, `gate ruling answer was refused: ${action.error}`);
        if (action.options?.includes('stop')) return { stop: true };
        ruled = action.items[0].key;
        return { answer: { [ruled]: answerFor } };
      },
    },
  });
  assert.equal(run.done.outcome, 'complete', JSON.stringify(run.done));
  assert.ok(ruled, 'needs-user ruling was asked');
  const lines = fs.readFileSync(plan, 'utf8').split(/\r?\n/).filter((line) => /^- \*\*\[/.test(line));
  assert.equal(lines.length, 1);
  return lines[0];
}

describe('gate ruling resolution text', () => {
  it('gate ruling at the round cap with an object answer replaces the stale resolution text', () => {
    const { plan, key } = roundCapRun(() => ({ verdict: 'accepted', resolution: 'Accepted at gate: add the failure-path test.' }));
    const line = lineFor(plan, key);
    assert.match(line, /^- \*\*\[Accepted\]\*\*/);
    assert.ok(line.endsWith(' → Accepted at gate: add the failure-path test.'), line);
    assert.doesNotMatch(line, /Rejected: the plan already names it/);
  });

  it('gate ruling at the round cap that flips with a plain string appends the overruled suffix', () => {
    const { plan, key } = roundCapRun(() => 'accepted');
    const line = lineFor(plan, key);
    assert.match(line, /^- \*\*\[Accepted\]\*\*/);
    assert.ok(line.endsWith(' → Rejected: the plan already names it. (overruled at gate: accepted)'), line);
  });

  it('gate ruling at the round cap without a flip leaves a plain string ruling unchanged', () => {
    const { plan, key } = roundCapRun(() => 'rejected');
    const line = lineFor(plan, key);
    assert.match(line, /^- \*\*\[Rejected \/ Downgraded\]\*\*/);
    assert.ok(line.endsWith(' → Rejected: the plan already names it.'), line);
  });

  it('gate ruling on a needs-user finding with an object answer writes the supplied resolution', () => {
    const line = needsUserRun({ verdict: 'accepted', resolution: 'User accepted: name the failure test.' });
    assert.match(line, /^- \*\*\[Accepted\]\*\*/);
    assert.ok(line.endsWith(' → User accepted: name the failure test.'), line);
  });

  it('gate ruling on a needs-user finding with a plain string keeps the host resolution without suffix', () => {
    const line = needsUserRun('rejected');
    assert.match(line, /^- \*\*\[Rejected \/ Downgraded\]\*\*/);
    assert.ok(line.endsWith(' → Host could not decide.'), line);
  });
});
