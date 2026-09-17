import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  materializeFixture,
  aggregate,
  parseBenchmarkReport,
  parseStructuredReport,
  parseStructuredRebuttal,
  parseMarkdownReport,
  renderFixturePrompt,
  scoreFindings,
  scoreRebuttals,
  validateCorpus,
} from '../../scripts/benchmark-review-prompts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const corpus = path.join(root, 'tests', 'fixtures', 'review-corpus');

describe('review prompt benchmark', () => {
  it('validates and covers every plan/code full/re-review/rebuttal combination', () => {
    const manifest = validateCorpus(corpus);
    assert.equal(manifest.fixtures.length, 10);
    assert.deepEqual(
      new Set(manifest.fixtures.map((fixture) => `${fixture.kind}:${fixture.mode}`)),
      new Set([
        'plan:full', 'plan:re-review', 'plan:rebuttal',
        'code:full', 'code:re-review', 'code:rebuttal',
      ]),
    );
  });

  it('renders the shipped review templates rather than a synthetic substitute', () => {
    const manifest = validateCorpus(corpus);
    const planPrompt = renderFixturePrompt(manifest.fixtures.find((fixture) => fixture.kind === 'plan'));
    const codePrompt = renderFixturePrompt(manifest.fixtures.find((fixture) => fixture.kind === 'code'));
    assert.match(planPrompt, /Review the plan/);
    assert.match(codePrompt, /Review the changes/);
    const rebuttalPrompt = renderFixturePrompt(
      manifest.fixtures.find((fixture) => fixture.mode === 'rebuttal'),
      corpus,
    );
    assert.match(rebuttalPrompt, /Review only the supplied unsettled/);
    assert.match(rebuttalPrompt, /R1-F001/);
  });

  it('keeps unavailable runs out of recall denominators', () => {
    const totals = aggregate([{
      status: 'skipped',
      score: {
        mustFound: 0,
        mustTotal: 2,
        shouldFound: 0,
        shouldTotal: 1,
        forbiddenFound: 0,
        unexpected: 0,
        cleanFalsePositive: false,
      },
      input: { characters: 10 },
      output: { characters: 0 },
    }]);
    assert.equal(totals.skipped, 1);
    assert.equal(totals.failed, 0);
    assert.equal(totals.mustTotal, 0);
    assert.equal(totals.shouldTotal, 0);
    assert.equal(totals.inputChars, 10);
  });

  it('tracks failed runs separately from unavailable runs', () => {
    const score = {
      mustFound: 0,
      mustTotal: 1,
      shouldFound: 0,
      shouldTotal: 0,
      forbiddenFound: 0,
      unexpected: 0,
      cleanFalsePositive: false,
    };
    const totals = aggregate([
      { status: 'failed', score, input: { characters: 4 }, output: { characters: 0 } },
      { status: 'skipped', score, input: { characters: 0 }, output: { characters: 0 } },
    ]);
    assert.equal(totals.failed, 1);
    assert.equal(totals.skipped, 1);
    assert.equal(totals.invalidReports, 0);
    assert.equal(totals.mustTotal, 0);
  });

  it('counts invalid reports separately', () => {
    const totals = aggregate([{
      status: 'failed',
      failureKind: 'invalid-report',
      score: {
        mustFound: 0,
        mustTotal: 1,
        shouldFound: 0,
        shouldTotal: 0,
        forbiddenFound: 0,
        unexpected: 0,
        cleanFalsePositive: false,
      },
      input: { characters: 4 },
      output: { characters: 4 },
    }]);
    assert.equal(totals.failed, 1);
    assert.equal(totals.invalidReports, 1);
  });

  it('materializes a fixture as an isolated Git repository', () => {
    const fixture = validateCorpus(corpus).fixtures[0];
    const repo = materializeFixture(corpus, fixture);
    try {
      assert.ok(fs.existsSync(path.join(repo, '.git')));
      assert.ok(fs.existsSync(path.join(repo, fixture.files[0])));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('adapts Markdown and schema-constrained reports to the same finding shape', () => {
    const markdown = parseMarkdownReport(
      '## MUST-FIX\n- § Verification Plan — verification: absent → add it\n' +
      '- `src/value.mjs:L2` — `correctness`: broken → fix it\n',
    );
    const structured = parseStructuredReport(JSON.stringify({
      status: 'FINDINGS',
      findings: [{
        severity: 'MUST',
        tag: 'verification',
        locus: '§ Verification Plan',
        defect: 'absent',
        requiredChange: 'add it',
      }],
    }), 'plan');
    assert.deepEqual(markdown[0], structured[0]);
    assert.deepEqual(markdown[1], {
      kind: 'MUST',
      locus: 'src/value.mjs:L2',
      tag: 'correctness',
    });
  });

  it('fails closed on malformed structured reports', () => {
    assert.throws(() => parseStructuredReport('{broken', 'plan'), /Invalid delegate report/);
  });

  it('counts an empty successful response as an invalid report', () => {
    assert.deepEqual(parseBenchmarkReport('', 'plan', 'json', 0), {
      findings: [],
      parseFailure: true,
    });
    assert.deepEqual(parseBenchmarkReport('', 'plan', 'json', 1), {
      findings: [],
      parseFailure: false,
    });
    assert.deepEqual(parseBenchmarkReport('', 'plan', 'json', 1, {
      mode: 'rebuttal',
      expectedKeys: ['R1-F001'],
    }), {
      findings: [],
      parseFailure: false,
    });
  });

  it('scores required, forbidden, and clean false-positive findings', () => {
    const score = scoreFindings({
      must: [{ kind: 'MUST', tag: 'verification', locus: '§ Verification Plan' }],
      should: [],
      optional: [],
      forbidden: [{ kind: 'MUST', tag: 'security', locus: '§ Proposed Changes' }],
    }, [
      { kind: 'MUST', tag: 'verification', locus: '§ Verification Plan' },
      { kind: 'MUST', tag: 'security', locus: '§ Proposed Changes' },
    ]);
    assert.equal(score.mustFound, 1);
    assert.equal(score.forbiddenFound, 1);
  });

  it('parses and scores rebuttal convergence and escalation', () => {
    const report = JSON.stringify({
      responses: [
        { type: 'rebuttal', key: 'R1-F001', verdict: 'CONFIRM', evidence: '§ A settles it.' },
        { type: 'rebuttal', key: 'R1-F002', verdict: 'INTENT-DISPUTE', evidence: '§ Scope leaves intent absent.' },
      ],
    });
    const parsed = parseStructuredRebuttal(report, 'plan', ['R1-F001', 'R1-F002']);
    const score = scoreRebuttals({
      responses: [
        { key: 'R1-F001', verdict: 'CONFIRM' },
        { key: 'R1-F002', verdict: 'INTENT-DISPUTE' },
      ],
    }, parsed.responses);
    assert.deepEqual(score, {
      expected: 2,
      matched: 2,
      settled: 1,
      unresolved: 1,
      userEscalations: 1,
      acceptedFalsePositives: 0,
    });
  });

  it('aggregates rebuttal input/output, convergence, substitutions, rounds, and escalations', () => {
    const totals = aggregate([{
      status: 'ok',
      mode: 'rebuttal',
      score: {
        mustFound: 0,
        mustTotal: 0,
        shouldFound: 0,
        shouldTotal: 0,
        forbiddenFound: 0,
        unexpected: 0,
        cleanFalsePositive: false,
      },
      rebuttal: {
        expected: 2,
        matched: 2,
        settled: 1,
        unresolved: 1,
        userEscalations: 1,
        acceptedFalsePositives: 0,
      },
      substitutions: 1,
      rounds: 1,
      input: { characters: 100 },
      output: { characters: 40 },
    }]);
    assert.equal(totals.rebuttalInputChars, 100);
    assert.equal(totals.rebuttalOutputChars, 40);
    assert.equal(totals.converged, 1);
    assert.equal(totals.unresolved, 1);
    assert.equal(totals.substitutions, 1);
    assert.equal(totals.rounds, 1);
    assert.equal(totals.userEscalations, 1);
  });

  it('counts failed rebuttal traffic and keeps provider retries separate from substitutions', () => {
    const totals = aggregate([{
      status: 'failed',
      mode: 'rebuttal',
      failureKind: 'quota',
      score: {
        mustFound: 0,
        mustTotal: 0,
        shouldFound: 0,
        shouldTotal: 0,
        forbiddenFound: 0,
        unexpected: 0,
        cleanFalsePositive: false,
      },
      rebuttal: null,
      substitutions: 0,
      rounds: 1,
      input: { characters: 70 },
      output: { characters: 20 },
    }]);
    assert.equal(totals.failed, 1);
    assert.equal(totals.rebuttalInputChars, 70);
    assert.equal(totals.rebuttalOutputChars, 20);
    assert.equal(totals.substitutions, 0);
    assert.equal(totals.rounds, 1);
  });
});
