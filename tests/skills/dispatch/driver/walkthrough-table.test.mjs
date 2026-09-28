import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { persistEvidence } from '../../../../skills/dispatch/scripts/driver/implement-state.mjs';
import { captureRepositoryState } from '../../../../skills/dispatch/scripts/verification/evidence.mjs';
import { lintWalkthrough } from '../../../../skills/dispatch/scripts/walkthrough/lint.mjs';
import { implementationOutcome, writeOutcomeReply } from '../../../helpers/driver-harness.mjs';
import {
  cleanupOrdinaryDriverFixtures,
  createOrdinaryDriverFixture,
  driveOrdinaryImplementation,
  ordinaryDriverPolicy,
} from '../../../helpers/ordinary-driver-fixture.mjs';

// SECTION: Helpers

const cleanup = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  cleanupOrdinaryDriverFixtures();
});

const HEADER = '| SC | Outcome | Evidence |';
const FINAL = 'node scripts/slow.mjs';

/** Splits a table row on unescaped pipes. */
const cells = row => row.split(/(?<!\\)\|/).slice(1, -1).map(value => value.trim());
const section = (text, heading) => new RegExp(`^## ${heading}\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |(?![\\s\\S]))`, 'm').exec(text)?.[1] ?? '';

function traceRows(text) {
  const lines = section(text, 'Verification').split(/\r?\n/).filter(line => line.startsWith('|'));
  return { header: lines[0], rows: lines.slice(2).map(cells) };
}

const statusLines = text => text.split(/\r?\n/).filter(line => line.startsWith('> **Status:**'));

function walkthrough({ box, verification, deviations = 'None.' }) {
  return [
    '# Parse piped input',
    '',
    box,
    '',
    '## Changes Made',
    '- **[MODIFY]** `src/app.js` — Adds the parser.',
    '',
    '## Verification',
    verification,
    '',
    '## Deviations & Follow-ups',
    deviations,
    '',
    '## Review Findings & Resolutions',
    '*No reviews conducted yet.*',
    '',
  ].join('\n');
}

const BOX = ['> **Delivered:** pending', '> **Parent:** `plan.md`', '> **Status:** 0/2 SC passing', '> **Deviations:** none'].join('\n');
const PENDING = [
  HEADER,
  '| --- | --- | --- |',
  '| SC1 | Parse `a \\| b` input | Pending |',
  '| SC2 | Aggregate proof | Pending |',
  '',
  'Final gate: pending',
].join('\n');

const CRITERIA = [
  { id: 'SC1', title: 'Parse `a | b` input', evidence: 'red', commands: ['node --test tests/sample.test.mjs'], paths: ['src/app.js'] },
  { id: 'SC2', title: 'Aggregate proof', evidence: 'verify', commands: [FINAL], paths: ['src/app.js'] },
];

function unitState(text, ordinary = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walkthrough-table-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const planPath = path.join(dir, 'plan.md');
  const walkthroughPath = path.join(dir, 'plan.walkthrough.md');
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
  it('renders pending Verification rows with escaped pipes and writes evidence to the sidecar', () => {
    const state = unitState(walkthrough({ box: BOX, verification: 'Final gate: pending' }));
    persistEvidence(state);
    persistEvidence(state);
    const text = read(state);
    const { header, rows } = traceRows(text);
    assert.equal(header, HEADER);
    assert.deepEqual(rows.map(row => row[0]), ['SC1', 'SC2']);
    assert.equal(rows[0].length, 3, 'escaped pipe keeps three cells');
    assert.match(rows[0][1], /a \\\| b/);
    for (const row of rows) assert.match(row[2], /^Pending\b/);
    assert.match(section(text, 'Verification'), /^Final gate: pending$/m);
    assert.deepEqual(statusLines(text), ['> **Status:** 0/2 SC passing']);
    assert.doesNotMatch(text, /Ordinary execution evidence|```json/);
    assert.ok(fs.existsSync(path.join(path.dirname(state.walkthroughPath), '.state', 'plan.evidence.json')));
  });

  it('rewrites only the Status line and keeps the table across repeated persists, deferring final-only rows', () => {
    const state = unitState(walkthrough({ box: BOX, verification: PENDING }), completed);
    persistEvidence(state);
    const first = read(state);
    persistEvidence(state);
    const second = read(state);
    assert.equal(second, first, 'persist is idempotent');
    const { header, rows } = traceRows(second);
    assert.equal(header, HEADER);
    assert.deepEqual(rows.map(row => row[0]), ['SC1', 'SC2']);
    assert.match(rows[0][1], /delivered a \\\| b parser/, 'outcome keeps its own pipe, escaped');
    assert.match(rows[0][2], /^red→green /);
    assert.match(rows[1][2], /^Deferred to final gate\b/);
    assert.deepEqual(statusLines(second), ['> **Status:** 1/2 SC passing']);
    assert.match(second, /^> \*\*Parent:\*\* `plan\.md`$/m);
    assert.match(second, /^> \*\*Deviations:\*\* none$/m);
  });

  it('updates Delivered from a COMPLETE envelope with no production paths and never repeats the H1', () => {
    const state = unitState(walkthrough({ box: BOX, verification: PENDING }));
    const git = (...args) => assert.equal(spawnSync('git', args, { cwd: state.repoRoot, encoding: 'utf8' }).status, 0, args.join(' '));
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base');
    fs.writeFileSync(path.join(state.repoRoot, 'pre.js'), 'a\n');
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'files');
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: state.repoRoot, encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(path.join(state.repoRoot, 'pre.js'), 'dirty before the run\n');
    Object.assign(state.ordinary, { baselineSnapshot: captureRepositoryState(state.repoRoot), write: { baselineHead: head }, envelope: { stage: 'COMPLETE', summary: 'Parse piped input.' } });
    persistEvidence(state);
    assert.match(read(state), /^> \*\*Delivered:\*\* Implemented: Parse piped input\.$/m);
    assert.match(read(state), /^- \*\*\[MODIFY\]\*\* `src\/app\.js` — Adds the parser\.$/m, 'Changes Made kept when no production path changed');
    assert.doesNotMatch(read(state), /pre\.js/, 'paths dirty before the run are not listed');
  });

  it('lists run edits to baseline-dirty files and host .state paths but never its own documents', () => {
    const state = unitState(walkthrough({ box: BOX, verification: PENDING }));
    const git = (...args) => assert.equal(spawnSync('git', args, { cwd: state.repoRoot, encoding: 'utf8' }).status, 0, args.join(' '));
    git('init', '-q');
    fs.writeFileSync(path.join(state.repoRoot, 'mod.js'), 'a\n');
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'files');
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: state.repoRoot, encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(path.join(state.repoRoot, 'mod.js'), 'user edit\n');
    const baselineSnapshot = captureRepositoryState(state.repoRoot);
    fs.writeFileSync(path.join(state.repoRoot, 'mod.js'), 'user edit\nrun edit\n');
    fs.mkdirSync(path.join(state.repoRoot, 'src', '.state'), { recursive: true });
    fs.writeFileSync(path.join(state.repoRoot, 'src', '.state', 'store.js'), 'x\n');
    Object.assign(state.ordinary, { baselineSnapshot, write: { baselineHead: head }, envelope: { stage: 'COMPLETE', summary: 'Parse piped input.', files: [{ path: 'mod.js', note: 'same' }] } });
    persistEvidence(state);
    const first = read(state);
    persistEvidence(state);
    assert.equal(read(state), first, 'Changes Made is stable across persists');
    const changes = /## Changes Made\n([\s\S]*?)\n## /.exec(first)?.[1] ?? '';
    assert.match(changes, /^- \*\*\[MODIFY\]\*\* `mod\.js` — \+\d+ −\d+$/m, 'baseline-dirty file edited by the run stays listed; filler writer note falls back');
    assert.match(changes, /`src\/\.state\/store\.js`/, 'host .state paths are production changes');
    assert.doesNotMatch(changes, /walkthrough\.md|plan\.md|evidence\.json/, 'own documents and sidecar are excluded');
  });

  it('fails closed on an absent or duplicated Status line', () => {
    const absent = unitState(walkthrough({ box: BOX.replace('\n> **Status:** 0/2 SC passing', ''), verification: PENDING }), completed);
    assert.throws(() => persistEvidence(absent), /Status/);
    const duplicated = unitState(walkthrough({ box: `${BOX}\n> **Status:** 0/2 SC passing`, verification: PENDING }), completed);
    assert.throws(() => persistEvidence(duplicated), /Status/);
  });

  it('round-trips Deviations against Deviation bullets', () => {
    const synced = unitState(walkthrough({ box: BOX.replace('> **Deviations:** none', '> **Deviations:** stale summary'), verification: PENDING }), completed);
    persistEvidence(synced);
    assert.match(read(synced), /^> \*\*Deviations:\*\* none$/m);

    const unsummarized = unitState(walkthrough({ box: BOX, verification: PENDING, deviations: '- Deviation: swapped the parser for a regex.' }), completed);
    assert.throws(() => persistEvidence(unsummarized), /Deviations summary required:/);

    const authored = unitState(walkthrough({
      box: BOX.replace('> **Deviations:** none', '> **Deviations:** parser swapped for a regex'),
      verification: PENDING,
      deviations: '- Deviation: swapped the parser for a regex.',
    }), completed);
    persistEvidence(authored);
    assert.match(read(authored), /^> \*\*Deviations:\*\* parser swapped for a regex$/m);
    assert.deepEqual(statusLines(read(authored)), ['> **Status:** 1/2 SC passing']);
  });
});

// SECTION: baseline scaffold and handoff

describe('driver walkthrough table baseline and handoff', () => {
  it('renders readable walkthrough from scaffold to handoff', () => {
    const fixture = createOrdinaryDriverFixture({ codeReview: false });
    const walkthroughPath = fixture.plan.replace(/\.plan\.md$/, '.walkthrough.md');
    const base = ordinaryDriverPolicy(fixture.repo);
    let scaffold = null;
    const result = driveOrdinaryImplementation(fixture, {
      policy: {
        delegateWrite(action) {
          if (action.fields.stage === 'tests-only') return base.delegateWrite(action);
          fs.writeFileSync(path.join(fixture.repo.dir, 'src/app.js'), 'export const value = 2;\n');
          return writeOutcomeReply(action, implementationOutcome({ summary: 'Sample value now reads 2.', evidence: ['CRITERION SC1 | src/app.js | delivered value=2'],
            files: [{ path: 'src/app.js', note: 'Exports value 2.' }] }));
        },
      },
      onAction(action) {
        if (!scaffold && action.action === 'ask-user' && action.question === 'approval') scaffold = fs.readFileSync(walkthroughPath, 'utf8');
      },
    });
    assert.equal(result.done.outcome, 'complete', JSON.stringify(result.done));
    assert.ok(scaffold, 'walkthrough exists at approval');
    assert.match(scaffold, /^# .+\n\n> \*\*Delivered:\*\* pending\n> \*\*Parent:\*\* `[^`]+\.plan\.md`\n> \*\*Status:\*\* 0\/1 SC passing\n> \*\*Deviations:\*\* none\n\n## Changes Made$/m);
    assert.match(traceRows(scaffold).rows[0][2], /^Pending\b/);

    const text = fs.readFileSync(walkthroughPath, 'utf8');
    assert.match(text, /^> \*\*Delivered:\*\* Sample value now reads 2\.$/m);
    const changes = section(text, 'Changes Made');
    assert.match(changes, /^- \*\*\[MODIFY\]\*\* `src\/app\.js` — Exports value 2\.$/m, 'envelope note wins');
    assert.match(changes, /^- \*\*\[MODIFY\]\*\* `tests\/sample\.test\.mjs` — Add regression\.$/m, 'plan note is the fallback');
    assert.doesNotMatch(text, /Approved implementation scope|Ordinary execution evidence/);
    const { header, rows } = traceRows(text);
    assert.equal(header, HEADER);
    assert.match(rows[0][2], /^red→green `tests\/sample\.test\.mjs` via `node --test tests\/sample\.test\.mjs`$/);
    assert.match(section(text, 'Verification'), /^Final gate: /m);
    assert.deepEqual(lintWalkthrough(text, { criteria: [{ id: 'SC1' }] }).defects, []);
  });

  it('refuses baseline when the walkthrough it would use fails lint', () => {
    const fixture = createOrdinaryDriverFixture({ codeReview: false });
    const walkthroughPath = fixture.plan.replace(/\.plan\.md$/, '.walkthrough.md');
    fs.writeFileSync(walkthroughPath, walkthrough({ box: '', verification: '- [SC1] Pending — evidence: red.' }).replace('\n\n\n', '\n\n'));
    const result = driveOrdinaryImplementation(fixture, { allowErrors: true });
    assert.equal(result.done.outcome, 'refused', JSON.stringify(result.done));
    assert.match(result.done.reason, /^Walkthrough scaffold failed lint:.*missing-summary-box/);
    assert.match(result.done.reason, /traceability-not-table/);
    assert.equal(result.trace.some(action => action.action === 'delegate-write'), false);
  });

  it('throws at handoff when the walkthrough fails lint', () => {
    const fixture = createOrdinaryDriverFixture({ codeReview: false });
    const walkthroughPath = fixture.plan.replace(/\.plan\.md$/, '.walkthrough.md');
    let production = false;
    let failure = '';
    try {
      const result = driveOrdinaryImplementation(fixture, {
        allowErrors: true,
        onAction(action) {
          if (action.action === 'delegate-write' && action.fields.stage === 'production') production = true;
          if (production && action.action === 'verify') {
            const text = fs.readFileSync(walkthroughPath, 'utf8');
            if (!text.includes('<relative-path>')) fs.writeFileSync(walkthroughPath, text.replace('## Deviations & Follow-ups\n', '## Deviations & Follow-ups\n- Follow-up: `<relative-path>` leftover.\n'));
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
