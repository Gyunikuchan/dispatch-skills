import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { cleanupOrdinaryDriverFixtures, createOrdinaryDriverFixture, driveOrdinaryImplementation, ordinaryDriverPolicy, tierPolicy } from '../helpers/ordinary-driver-fixture.mjs';
import { KINDS } from '../../skills/dispatch/scripts/lib/session-paths.mjs';

afterEach(cleanupOrdinaryDriverFixtures);

const kinds = [...KINDS].join('|');
const RUN_FILE = new RegExp(String.raw`^(?:[rs]\d+(?:-[a-z0-9]+)*\.)?(?:${kinds})\.(?:md|json|jsonl|log)$`);
const RUN = String.raw`\.state/runs/\d{3}-(?:ask|plan|design|implement|plan-review|code-review|design-review)`;
// Every path a session may hold; anything else is a stray or legacy writer.
const ALLOWED = [
  /^manifest\.json$/,
  /^[a-z0-9]+(?:-[a-z0-9]+)*\.(?:spec|design|plan|walkthrough|report)\.md$/,
  /^\.state\/[a-z0-9]+(?:-[a-z0-9]+)*\.ledger\.md$/,
  /^\.state\/[a-z0-9]+(?:-[a-z0-9]+)*\.evidence\.json$/,
  /^\.state\/telemetry\.jsonl$/,
  /^\.state\/cache\/(?:baseline\.json|[0-9a-f]{8}\.lock)$/,
  /^\.state\/cache\/tree-\d+\/.+$/,
  new RegExp(String.raw`^${RUN}/scratch/.+$`),
  new RegExp(String.raw`^${RUN}/(?<file>[^/]+)$`),
];

function tree(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? tree(root, rel) : [rel];
  });
}

function stray(rel) {
  for (const pattern of ALLOWED) {
    const match = pattern.exec(rel);
    if (match) return match.groups?.file !== undefined && !RUN_FILE.test(match.groups.file);
  }
  return true;
}

describe('session layout', () => {
  it('produces only root deliverables and grammar-named .state paths across plan review, verify, and code review', () => {
    const fixture = createOrdinaryDriverFixture();
    // A verify-only criterion makes the host reply with criterion evidence at its named path.
    fs.writeFileSync(fixture.plan, fs.readFileSync(fixture.plan, 'utf8')
      .replace('Evidence: red', 'Evidence: verify')
      .replace('Behavioral failure isolates the sample outcome and protects its regression.', 'A retained pre-change test would add no signal beyond the mapped deterministic check.'));
    const base = ordinaryDriverPolicy(fixture.repo);
    const tier = tierPolicy(fixture);
    const result = driveOrdinaryImplementation(fixture, {
      policy: tierPolicy(fixture, {
        delegateWrite(action) {
          fs.writeFileSync(path.join(fixture.repo.dir, 'tests/sample.test.mjs'), "import assert from 'node:assert/strict';\nimport { value } from '../src/app.js';\nassert.equal(value, 2);\n");
          return tier.delegateWrite(action);
        },
        askUser(action) {
          if (action.question === 'approval') return { answer: { decision: 'approved', governingHash: action.items[0].governingHash, testPaths: [], reason: 'Approve verify-only fixture.' } };
          return base.askUser(action);
        },
      }),
      onAction(action) {
        // Act as the host: write each reply file where the guidance names it.
        for (const line of action.guidance ?? []) {
          const reply = /Write the reply JSON to (.+?) and pass --input @/.exec(line)?.[1];
          if (reply) fs.writeFileSync(reply, '{}\n');
        }
      },
    });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    const root = result.done.handoff.destinations[0];
    const files = tree(root).sort();
    assert.deepEqual(files.filter(stray), [], `unexpected session paths:\n${files.join('\n')}`);
    assert.deepEqual(files.filter((file) => !file.startsWith('.state/')), ['manifest.json', 'sample.plan.md', 'sample.walkthrough.md']);
    const runs = [...new Set(files.filter((file) => file.startsWith('.state/runs/')).map((file) => file.split('/')[2]))];
    assert.deepEqual(runs, ['001-implement', '002-plan-review', '003-code-review'], 'one chronological folder per run kind');
    // The host-judged verify step shares s<N> across its results, the write it checks, and the host's evidence reply.
    const run = '.state/runs/001-implement';
    const step = files.map((file) => new RegExp(String.raw`^${run}/(s\d+)\.evidence\.json$`).exec(file)?.[1]).find(Boolean);
    assert.ok(step, 'a verify step received host evidence at its named path');
    const stepFiles = files.filter((file) => file.startsWith(`${run}/${step}`)).map((file) => file.slice(run.length + 1));
    assert.deepEqual(stepFiles, [`${step}.brief.json`, `${step}.evidence.json`, `${step}.outcome.json`, `${step}.verify.json`]);
  });
});
