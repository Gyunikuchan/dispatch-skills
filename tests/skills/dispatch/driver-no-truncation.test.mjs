// SC7 / AC4: adjudicate and apply-fixes payloads list every finding and cluster in full.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildStubDispatchFixture } from './stub-dispatch-fixture.mjs';
import { allProviders, codeFinding, drive, makeGitRepo, report } from './driver-harness.mjs';

const ALL = (value) => ({ low: value, medium: value, high: value, xhigh: value, max: value });
const FINDING_COUNT = 60;
// Every finding touches the same file, so independence clustering keeps each one separate.
const LONG_TAIL = ' Detail that must survive verbatim.'.repeat(8);
const findings = Array.from({ length: FINDING_COUNT }, (_, index) => codeFinding({
  locus: `src/app.js:L${index + 1}`,
  defect: `Defect number ${String(index + 1).padStart(3, '0')}.${LONG_TAIL}`,
}));

let fixture;
let repo;
before(() => {
  fixture = buildStubDispatchFixture({
    'read-delegates': { agy: { model: 'gemini-3.7-flash', effort: 'medium' } },
    phases: { 'code-review': { rounds: ALL(2), targets: ALL(1), consensus: ALL(false) } },
  });
  repo = makeGitRepo({ dirty: true });
});
after(() => {
  fixture?.cleanup();
  repo?.cleanup();
});

describe('driver payloads are never truncated (AC4)', () => {
  it(`lists all ${FINDING_COUNT} findings in adjudicate and all clusters in apply-fixes`, () => {
    const run = drive(fixture, {
      cwd: repo.dir,
      runArgs: ['review', '--kind', 'code', '--fix', '--orchestrator', 'claude'],
      maxSteps: 40,
      policy: {
        waveResults: (action) => allProviders(action.wave.type === 'review' && action.wave.round === 1 ? report(findings) : report()),
        fix: () => ({ affectedPaths: ['src/app.js'], dependsOn: [], verification: ['node --version'] }),
        applyFixes: (action) => {
          fs.appendFileSync(path.join(repo.dir, 'src', 'app.js'), '// fixed\n');
          return { clusters: action.clusters.map((c) => ({ clusterId: c.clusterId, status: 'applied', paths: c.affectedPaths, note: 'edited' })) };
        },
      },
    });

    const adjudicate = run.trace.find((a) => a.action === 'adjudicate');
    assert.equal(adjudicate.findings.length, FINDING_COUNT);
    assert.equal(new Set(adjudicate.findings.map((f) => f.key)).size, FINDING_COUNT);
    for (const finding of findings) {
      assert.ok(adjudicate.findings.some((f) => f.defect === finding.defect), `verbatim: ${finding.defect.slice(0, 18)}`);
    }

    const applyFixes = run.trace.find((a) => a.action === 'apply-fixes');
    assert.ok(applyFixes.clusters.length > 20, `expected > 20 clusters, got ${applyFixes.clusters.length}`);
    const clustered = applyFixes.clusters.flatMap((c) => c.findingIds);
    assert.equal(clustered.length, FINDING_COUNT);
    assert.equal(new Set(clustered).size, FINDING_COUNT);

    for (const action of [adjudicate, applyFixes]) {
      const text = JSON.stringify(action);
      assert.doesNotMatch(text, /"(omitted|truncated|more)"\s*:/, 'no elision markers');
    }
    assert.equal(run.done.outcome, 'complete');
  });
});
