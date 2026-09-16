import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  materializeFixture,
  aggregate,
  parseJsonlReport,
  parseMarkdownReport,
  renderFixturePrompt,
  scoreFindings,
  validateCorpus,
} from '../../scripts/benchmark-review-prompts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const corpus = path.join(root, 'tests', 'fixtures', 'review-corpus');

describe('review prompt benchmark', () => {
  it('validates and covers every plan/code full/re-review combination', () => {
    const manifest = validateCorpus(corpus);
    assert.equal(manifest.fixtures.length, 8);
    assert.deepEqual(
      new Set(manifest.fixtures.map((fixture) => `${fixture.kind}:${fixture.mode}`)),
      new Set(['plan:full', 'plan:re-review', 'code:full', 'code:re-review']),
    );
  });

  it('renders the shipped review templates rather than a synthetic substitute', () => {
    const manifest = validateCorpus(corpus);
    const planPrompt = renderFixturePrompt(manifest.fixtures.find((fixture) => fixture.kind === 'plan'));
    const codePrompt = renderFixturePrompt(manifest.fixtures.find((fixture) => fixture.kind === 'code'));
    assert.match(planPrompt, /Review an implementation plan across seven axes/);
    assert.match(codePrompt, /Evaluate recent session changes across six axes/);
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
    assert.equal(totals.mustTotal, 0);
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

  it('adapts Markdown and JSONL reports to the same finding shape', () => {
    const markdown = parseMarkdownReport('## MUST-FIX\n§ Verification Plan — verification: absent → add it\n');
    const jsonl = parseJsonlReport('chrome\n{"type":"finding","severity":"MUST","tag":"verification","locus":"§ Verification Plan"}\n');
    assert.deepEqual(markdown, jsonl);
  });

  it('fails closed on malformed JSON-looking report lines', () => {
    assert.throws(() => parseJsonlReport('{broken'), /Malformed JSON-looking/);
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
});
