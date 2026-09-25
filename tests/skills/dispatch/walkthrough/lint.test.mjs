import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// NOTE: guarded import so a missing module fails each test on its assertion instead of crashing the file load.
const walkthroughLint = await import('../../../../skills/dispatch/scripts/walkthrough/lint.mjs').catch(() => ({}));

/** @param {string} source @param {{ criteria?: object[] }} [options] */
function lintWalkthrough(source, options) {
  assert.equal(typeof walkthroughLint.lintWalkthrough, 'function', 'walkthrough/lint.mjs must export lintWalkthrough');
  return walkthroughLint.lintWalkthrough(source, options);
}

// SECTION: Canonical fixtures and helpers

const BOX = [
  '> **TL;DR:** Feature shipped with pipe-safe parsing.',
  '> **Status:** 1/2 SC passing',
  '> **Deviations:** none',
].join('\n');

const TABLE = [
  '| SC | Behavior | Production path | Evidence |',
  '| --- | --- | --- | --- |',
  '| SC1 | Splits `a \\| b` on escaped pipes | `src/a.js` | exit 0 — 2 tests passed |',
  '| SC2 | Documents the parser | `src/b.js` | Pending |',
].join('\n');

const VALID = [
  '# Walkthrough — Feature',
  '',
  BOX,
  '',
  '## Changes Made',
  '### Core',
  '- **[MODIFY]** `src/a.js` — Escaped-pipe splitting.',
  '',
  '## Verification & Validation',
  '### Automated Tests',
  '- Command: `npm test` — exit 0; 2 tests passed.',
  '### Manual Verification',
  '- None.',
  '',
  '## Outcome Traceability',
  TABLE,
  '',
  '## Key Deviations',
  'None.',
  '',
  '## Review Findings & Resolutions',
  '*No reviews conducted yet.*',
  '',
  '## Follow-ups',
  'None.',
].join('\n');

const CRITERIA = [
  { id: 'SC1', title: 'Splits escaped pipes.' },
  { id: 'SC2', title: 'Documents the parser.' },
];

const rules = result => result.defects.map(({ rule }) => rule);
const withBox = box => VALID.replace(BOX, box);
const withTable = table => VALID.replace(TABLE, table);
const PLANLESS = withTable('None — no governing plan.').replace('1/2 SC passing', 'n/a');

// SECTION: Accepted shapes

describe('walkthrough lint accepted shapes', () => {
  it('returns { defects, warnings } and accepts a canonical walkthrough with and without criteria', () => {
    const result = lintWalkthrough(VALID);
    assert.deepEqual(Object.keys(result).sort(), ['defects', 'warnings']);
    assert.deepEqual(result.defects, []);
    assert.deepEqual(lintWalkthrough(VALID, { criteria: CRITERIA }).defects, []);
  });

  it('accepts the plan-less form with Status n/a', () => {
    assert.deepEqual(lintWalkthrough(PLANLESS).defects, []);
  });

  it('accepts at most one intro line before the table', () => {
    const intro = withTable(`*One row per plan criterion.*\n${TABLE}`);
    assert.deepEqual(lintWalkthrough(intro, { criteria: CRITERIA }).defects, []);
    const twoIntros = withTable(`*One row per plan criterion.*\nA second intro line.\n${TABLE}`);
    assert.ok(rules(lintWalkthrough(twoIntros)).includes('traceability-not-table'));
  });

  it('accepts optional JSON frontmatter before the H1', () => {
    const framed = `---\n{"dispatch":{"schemaVersion":1,"kind":"code","slug":"feature"}}\n---\n${VALID}`;
    assert.deepEqual(lintWalkthrough(framed).defects, []);
  });
});

// SECTION: Diagnostics

describe('walkthrough lint diagnostics', () => {
  it('missing-summary-box when the box is absent', () => {
    assert.ok(rules(lintWalkthrough(VALID.replace(`${BOX}\n\n`, ''))).includes('missing-summary-box'));
  });

  it('summary-label for misordered, extra, duplicate, missing, empty, or malformed labels', () => {
    const [tldr, status, deviations] = BOX.split('\n');
    const cases = {
      misordered: [status, tldr, deviations].join('\n'),
      extra: `${BOX}\n> **Risk:** low — extra`,
      duplicate: `${BOX}\n> **Status:** 1/2 SC passing`,
      missing: [tldr, status].join('\n'),
      empty: BOX.replace('> **Deviations:** none', '> **Deviations:**'),
      status: BOX.replace('1/2 SC passing', '1 of 2 passing'),
      casing: BOX.replace('**TL;DR:**', '**TLDR:**'),
    };
    for (const [name, box] of Object.entries(cases)) {
      assert.ok(rules(lintWalkthrough(withBox(box))).includes('summary-label'), name);
    }
  });

  it('traceability-not-table for bullet traceability', () => {
    const bullets = withTable('- [SC1] Splits escaped pipes — production path: `src/a.js`; evidence: exit 0.\n- [SC2] Documents the parser — evidence: Pending.');
    assert.ok(rules(lintWalkthrough(bullets)).includes('traceability-not-table'));
  });

  it('rejects rows with an unescaped extra pipe or rows that differ from criteria', () => {
    const extraCell = withTable(TABLE.replace('`a \\| b`', '`a | b`'));
    assert.notDeepEqual(lintWalkthrough(extraCell).defects, []);
    const reordered = withTable(TABLE.replace(/(\| SC1 .*)\n(\| SC2 .*)/, '$2\n$1'));
    assert.notDeepEqual(lintWalkthrough(reordered, { criteria: CRITERIA }).defects, []);
    const missingRow = withTable(TABLE.replace(/\n\| SC2 .*/, '')).replace('1/2 SC passing', '1/1 SC passing');
    assert.notDeepEqual(lintWalkthrough(missingRow, { criteria: CRITERIA }).defects, []);
  });

  it('status-mismatch when N/M disagrees with passing rows or criteria count', () => {
    const cases = {
      overcount: [withBox(BOX.replace('1/2', '2/2')), { criteria: CRITERIA }],
      undercount: [withBox(BOX.replace('1/2', '0/2')), { criteria: CRITERIA }],
      criteriaCount: [withBox(BOX.replace('1/2', '1/3')), {}],
      naWithTable: [withBox(BOX.replace('1/2 SC passing', 'n/a')), { criteria: CRITERIA }],
      countPlanless: [PLANLESS.replace('> **Status:** n/a', '> **Status:** 0/0 SC passing'), {}],
      deferred: [withTable(TABLE.replace('| Pending |', '| Deferred to final gate |')).replace('1/2', '2/2'), { criteria: CRITERIA }],
      missingValidated: [withTable(TABLE.replace('exit 0 — 2 tests passed', 'missing validated evidence')), { criteria: CRITERIA }],
    };
    for (const [name, [source, options]] of Object.entries(cases)) {
      assert.ok(rules(lintWalkthrough(source, options)).includes('status-mismatch'), name);
    }
  });

  it('counts only the Evidence cell, so Behavior text mentioning Pending still passes', () => {
    const behavior = withTable(TABLE.replace('Splits `a \\| b` on escaped pipes', 'Clears the Pending queue'));
    assert.deepEqual(lintWalkthrough(behavior, { criteria: CRITERIA }).defects, []);
  });

  it('deviations-mismatch when Deviations none-ness disagrees with Key Deviations', () => {
    const authored = VALID.replace('## Key Deviations\nNone.', '## Key Deviations\nSwapped parser for a regex.');
    assert.ok(rules(lintWalkthrough(authored)).includes('deviations-mismatch'));
    const summarized = withBox(BOX.replace('> **Deviations:** none', '> **Deviations:** parser swapped'));
    assert.ok(rules(lintWalkthrough(summarized)).includes('deviations-mismatch'));
    const consistent = authored.replace('> **Deviations:** none', '> **Deviations:** parser swapped');
    assert.ok(!rules(lintWalkthrough(consistent)).includes('deviations-mismatch'));
  });

  it('section-order when minimum-contract sections are out of order or missing', () => {
    const swapped = VALID.replace(
      /(## Outcome Traceability\n[\s\S]*?\n)(## Key Deviations\nNone\.\n\n)/,
      '$2$1',
    );
    assert.ok(swapped.indexOf('## Key Deviations') < swapped.indexOf('## Outcome Traceability'));
    assert.ok(rules(lintWalkthrough(swapped)).includes('section-order'));
    const missing = VALID.replace('## Follow-ups\nNone.', '');
    assert.ok(rules(lintWalkthrough(missing)).includes('section-order'));
  });

  it('leftover-placeholder for template tokens in prose and inline code, not in fences', () => {
    const line = '- **[MODIFY]** `src/a.js` — Escaped-pipe splitting.';
    for (const leftover of ['- **[MODIFY]** `<relative-path>` — Escaped-pipe splitting.', '- **[MODIFY]** `src/a.js` — for <Component Name>.']) {
      assert.ok(rules(lintWalkthrough(VALID.replace(line, leftover))).includes('leftover-placeholder'), leftover);
    }
    const fenced = VALID.replace('- None.\n', '- None.\n```md\n<relative-path>\n```\n');
    assert.ok(!rules(lintWalkthrough(fenced)).includes('leftover-placeholder'));
  });
});
