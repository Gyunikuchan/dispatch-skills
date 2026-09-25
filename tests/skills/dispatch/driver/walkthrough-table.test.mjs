import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { persistEvidence } from '../../../../skills/dispatch/scripts/driver/implement-state.mjs';
import {
  cleanupOrdinaryDriverFixtures,
  createOrdinaryDriverFixture,
  driveOrdinaryImplementation,
} from '../../../helpers/ordinary-driver-fixture.mjs';

// SECTION: Helpers

const cleanup = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  cleanupOrdinaryDriverFixtures();
});

const HEADER = '| SC | Behavior | Production path | Evidence |';
const FINAL = 'node scripts/slow.mjs';

/** Splits a table row on unescaped pipes. */
const cells = row => row.split(/(?<!\\)\|/).slice(1, -1).map(value => value.trim());

function traceRows(text) {
  const section = /## Outcome Traceability\r?\n([\s\S]*?)\r?\n## Key Deviations/.exec(text)?.[1] ?? '';
  const lines = section.split(/\r?\n/).filter(line => line.startsWith('|'));
  return { header: lines[0], rows: lines.slice(2).map(cells) };
}

const statusLines = text => text.split(/\r?\n/).filter(line => line.startsWith('> **Status:**'));

function walkthrough({ box, traceability, deviations = 'None.' }) {
  return [
    '# Implementation walkthrough',
    '',
    box,
    '',
    '## Changes Made',
    '- **[MODIFY]** `src/app.js` — Approved implementation scope.',
    '',
    '## Verification & Validation',
    'Host verification is recorded in Ordinary execution evidence.',
    '',
    '## Outcome Traceability',
    traceability,
    '',
    '## Key Deviations',
    deviations,
    '',
    '## Review Findings & Resolutions',
    '*No reviews conducted yet.*',
    '',
    '## Follow-ups',
    'None.',
    '',
  ].join('\n');
}

const BOX = ['> **TL;DR:** Plan', '> **Status:** 0/2 SC passing', '> **Deviations:** none'].join('\n');
const PENDING_TABLE = [
  HEADER,
  '| --- | --- | --- | --- |',
  '| SC1 | Parse `a \\| b` input | pending implementation | Pending |',
  '| SC2 | Aggregate proof | pending implementation | Pending |',
].join('\n');
const BULLETS = [
  '- [SC1] Pending — evidence: red; production path: pending implementation.',
  '- [SC2] Pending — evidence: verify; production path: pending implementation.',
].join('\n');

const CRITERIA = [
  { id: 'SC1', title: 'Parse `a | b` input', evidence: 'red', commands: ['node --test tests/sample.test.mjs'], paths: ['src/app.js'] },
  { id: 'SC2', title: 'Aggregate proof', evidence: 'verify', commands: [FINAL], paths: ['src/app.js'] },
];

function unitState(text, ordinary = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walkthrough-table-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const planPath = path.join(dir, 'plan.md');
  const walkthroughPath = path.join(dir, 'plan-walkthrough.md');
  fs.writeFileSync(planPath, '# Plan\n');
  fs.writeFileSync(walkthroughPath, text);
  return {
    repoRoot: dir, planPath, walkthroughPath, governingHash: 'sha256:x',
    ordinary: { criteria: CRITERIA, mutationEpoch: 0, ...ordinary },
  };
}

const completed = {
  implementationComplete: { scopeHash: 'x' },
  completionResults: [],
  finalOnly: [FINAL],
  envelope: { evidence: ['CRITERION SC1 | src/app.js | delivered a | b parser', 'CRITERION SC2 | src/app.js | aggregate proof'] },
};

const read = state => fs.readFileSync(state.walkthroughPath, 'utf8');

// SECTION: implement-state persistence

describe('driver walkthrough table persistence', () => {
  it('renders pending traceability as a table with escaped pipes on every persist', () => {
    const state = unitState(walkthrough({ box: BOX, traceability: BULLETS }));
    persistEvidence(state);
    persistEvidence(state);
    const text = read(state);
    assert.doesNotMatch(text, /^- \[SC\d\]/m);
    const { header, rows } = traceRows(text);
    assert.equal(header, HEADER);
    assert.deepEqual(rows.map(row => row[0]), ['SC1', 'SC2']);
    assert.equal(rows[0].length, 4, 'escaped pipe keeps four cells');
    assert.match(rows[0][1], /a \\\| b/);
    for (const row of rows) assert.match(row[3], /^Pending\b/);
    assert.deepEqual(statusLines(text), ['> **Status:** 0/2 SC passing']);
  });

  it('rewrites only the Status line and keeps the table across repeated persists, deferring final-only rows', () => {
    const state = unitState(walkthrough({ box: BOX, traceability: PENDING_TABLE }), completed);
    persistEvidence(state);
    const first = read(state);
    persistEvidence(state);
    const second = read(state);
    assert.equal(second, first, 'persist is idempotent');
    const { header, rows } = traceRows(second);
    assert.equal(header, HEADER);
    assert.deepEqual(rows.map(row => row[0]), ['SC1', 'SC2']);
    assert.match(rows[0][1], /delivered a \\\| b parser/, 'behavior keeps its own pipe, escaped');
    assert.match(rows[0][2], /src\/app\.js/);
    assert.doesNotMatch(rows[0][3], /^Pending\b|^Deferred to final gate\b|missing validated/i);
    assert.match(rows[1][3], /^Deferred to final gate\b/);
    assert.deepEqual(statusLines(second), ['> **Status:** 1/2 SC passing']);
    assert.match(second, /^> \*\*TL;DR:\*\* Plan$/m);
    assert.match(second, /^> \*\*Deviations:\*\* none$/m);
  });

  it('fails closed on an absent or duplicated Status line', () => {
    const absent = unitState(walkthrough({ box: BOX.replace('\n> **Status:** 0/2 SC passing', ''), traceability: PENDING_TABLE }), completed);
    assert.throws(() => persistEvidence(absent), /Status/);
    const duplicated = unitState(walkthrough({ box: `${BOX}\n> **Status:** 0/2 SC passing`, traceability: PENDING_TABLE }), completed);
    assert.throws(() => persistEvidence(duplicated), /Status/);
  });

  it('round-trips Deviations against Key Deviations', () => {
    const synced = unitState(walkthrough({ box: BOX.replace('> **Deviations:** none', '> **Deviations:** stale summary'), traceability: PENDING_TABLE }), completed);
    persistEvidence(synced);
    assert.match(read(synced), /^> \*\*Deviations:\*\* none$/m);

    const unsummarized = unitState(walkthrough({ box: BOX, traceability: PENDING_TABLE, deviations: 'Swapped the parser for a regex.' }), completed);
    assert.throws(() => persistEvidence(unsummarized), /Deviations summary required:/);

    const authored = unitState(walkthrough({
      box: BOX.replace('> **Deviations:** none', '> **Deviations:** parser swapped for a regex'),
      traceability: PENDING_TABLE,
      deviations: 'Swapped the parser for a regex.',
    }), completed);
    persistEvidence(authored);
    assert.match(read(authored), /^> \*\*Deviations:\*\* parser swapped for a regex$/m);
    assert.deepEqual(statusLines(read(authored)), ['> **Status:** 1/2 SC passing']);
  });
});

// SECTION: baseline scaffold and handoff

describe('driver walkthrough table baseline and handoff', () => {
  it('scaffolds the summary box and a Pending table at baseline, then hands off through the table', () => {
    const fixture = createOrdinaryDriverFixture({ codeReview: false });
    const walkthroughPath = fixture.plan.replace(/\.md$/, '-walkthrough.md');
    let scaffold = null;
    const result = driveOrdinaryImplementation(fixture, {
      onAction(action) {
        if (!scaffold && action.action === 'ask-user' && action.question === 'approval') scaffold = fs.readFileSync(walkthroughPath, 'utf8');
      },
    });
    assert.ok(scaffold, 'walkthrough exists at approval');
    assert.match(scaffold, /^# .+\n\n> \*\*TL;DR:\*\* Plan\n> \*\*Status:\*\* 0\/1 SC passing\n> \*\*Deviations:\*\* none\n\n## Changes Made$/m);
    const { header, rows } = traceRows(scaffold);
    assert.equal(header, HEADER);
    assert.deepEqual(rows.map(row => row[0]), ['SC1']);
    assert.match(rows[0][3], /^Pending\b/);
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
  });

  it('refuses baseline when the walkthrough it would use fails lint', () => {
    const fixture = createOrdinaryDriverFixture({ codeReview: false });
    const walkthroughPath = fixture.plan.replace(/\.md$/, '-walkthrough.md');
    fs.writeFileSync(walkthroughPath, walkthrough({ box: '', traceability: '- [SC1] Pending — evidence: red.' }).replace('\n\n\n', '\n\n'));
    const result = driveOrdinaryImplementation(fixture, { allowErrors: true });
    assert.equal(result.done.outcome, 'refused', JSON.stringify(result.done));
    assert.match(result.done.reason, /^Walkthrough scaffold failed lint:.*missing-summary-box/);
    assert.match(result.done.reason, /traceability-not-table/);
    assert.equal(result.trace.some(action => action.action === 'delegate-write'), false);
  });

  it('throws at handoff when the walkthrough fails lint', () => {
    const fixture = createOrdinaryDriverFixture({ codeReview: false });
    const walkthroughPath = fixture.plan.replace(/\.md$/, '-walkthrough.md');
    let production = false;
    let failure = '';
    try {
      const result = driveOrdinaryImplementation(fixture, {
        allowErrors: true,
        onAction(action) {
          if (action.action === 'delegate-write' && action.fields.stage === 'production') production = true;
          if (production && action.action === 'verify') {
            const text = fs.readFileSync(walkthroughPath, 'utf8');
            if (!text.includes('<relative-path>')) fs.writeFileSync(walkthroughPath, text.replace('## Changes Made\n', '## Changes Made\n- **[MODIFY]** `<relative-path>` — leftover.\n'));
          }
          if (action.error) failure += ` ${JSON.stringify(action.error)}`;
        },
      });
      failure += ` ${JSON.stringify(result.done)}`;
    } catch (error) {
      failure += ` ${error.message}`;
    }
    assert.ok(production, 'reached production');
    assert.match(failure, /handoff requires a lint-clean walkthrough:.*leftover-placeholder/);
  });
});
