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
  '> **Delivered:** The parser splits on escaped pipes.',
  '> **Parent:** `docs/feature.plan.md`',
  '> **Status:** 1/2 SC passing',
  '> **Deviations:** none',
].join('\n');

const TABLE = [
  '| SC | Outcome | Evidence |',
  '| --- | --- | --- |',
  '| SC1 | Splits `a \\| b` on escaped pipes | red→green `npm test` exit 0 |',
  '| SC2 | Documents the parser | Pending |',
].join('\n');

const VALID = [
  '# Feature',
  '',
  BOX,
  '',
  '## Changes Made',
  '- **[MODIFY]** `src/a.js` — Escaped-pipe splitting.',
  '- **[NEW]** `tests/a.test.js` — Covers escaped pipes.',
  '',
  '## Verification',
  TABLE,
  '',
  'Final gate: `npm test` exit 0',
  '',
  '## Deviations & Follow-ups',
  'None.',
  '',
  '## Review Findings & Resolutions',
  '*No reviews conducted yet.*',
].join('\n');

const CRITERIA = [
  { id: 'SC1', title: 'Splits escaped pipes.' },
  { id: 'SC2', title: 'Documents the parser.' },
];

const rules = result => result.defects.map(({ rule }) => rule);
const withBox = box => VALID.replace(BOX, box);
const withTable = table => VALID.replace(TABLE, table);
const PLANLESS = VALID
  .replace('> **Parent:** `docs/feature.plan.md`', '> **Parent:** user request')
  .replace('1/2 SC passing', 'n/a')
  .replace('## Changes Made', '## Context\n- Ask: Make the parser pipe-safe.\n\n## Changes Made')
  .replace(`${TABLE}\n\n`, '');

// SECTION: Accepted shapes

describe('walkthrough lint accepted shapes', () => {
  it('returns { defects, warnings } and accepts a canonical walkthrough with and without criteria', () => {
    const result = lintWalkthrough(VALID);
    assert.deepEqual(Object.keys(result).sort(), ['defects', 'warnings']);
    assert.deepEqual(result.defects, []);
    assert.deepEqual(lintWalkthrough(VALID, { criteria: CRITERIA }).defects, []);
  });

  it('accepts the plan-less form with Context, a final-gate line, and Status n/a', () => {
    assert.deepEqual(lintWalkthrough(PLANLESS).defects, []);
  });

  it('accepts optional JSON frontmatter before the H1', () => {
    const framed = `---\n{"dispatch":{"schemaVersion":1,"kind":"code","slug":"feature"}}\n---\n${VALID}`;
    assert.deepEqual(lintWalkthrough(framed).defects, []);
  });
});

// SECTION: Readable contract rules

describe('readable walkthrough contract', () => {
  it('dedupes cross-source notes by normalized form and exempts fixes suffixes on generated notes', async () => {
    const { changeEntries } = await import('../../../../skills/dispatch/scripts/walkthrough/traceability.mjs');
    const { isFillerNote, withFixes } = await import('../../../../skills/dispatch/scripts/lib/filler.mjs');
    const stats = new Map([['a.mjs', { tag: 'MODIFY', added: 1, removed: 0 }], ['b.mjs', { tag: 'MODIFY', added: 2, removed: 0 }]]);
    const entries = changeEntries({ paths: ['a.mjs', 'b.mjs'], stats, files: [{ path: 'a.mjs', note: 'Adds the parser.' }], planNotes: new Map([['b.mjs', { tag: 'MODIFY', note: 'adds the parser' }]]) });
    assert.deepEqual(entries.map(item => item.note), ['Adds the parser.', '+2 −0']);
    assert.equal(isFillerNote('+2 −2; fixes R1-F017', ['+2 −2; fixes R1-F017']), false);
    assert.equal(isFillerNote('Adds x; fixes R1-F001', ['Adds x']), true, 'base notes still compare');
    assert.equal(withFixes('Adds x; fixes R1-F002', ['R10-F1000', 'R2-F001', 'R1-F001']), 'Adds x; fixes R1-F001, R1-F002, R2-F001, R10-F1000');
    assert.equal(isFillerNote('Adds  the\nparser', ['adds the parser']), true, 'whitespace variants compare as rendered');
    const { renderChangesMade } = await import('../../../../skills/dispatch/scripts/walkthrough/traceability.mjs');
    assert.equal(renderChangesMade([{ tag: 'MODIFY', path: 'a.mjs', note: 'Parses a | b' }]), '- **[MODIFY]** `a.mjs` — Parses a | b', 'bullets keep pipes unescaped');
    const { withFixNotes } = await import('../../../../skills/dispatch/scripts/driver/review-phase.mjs');
    const doc = '# T\n\n## Changes Made\n- **[MODIFY]** `src/a.mjs` — Adds x.\n\n## Verification\nFinal gate: ok\n';
    const fixed = withFixNotes(doc, [{ id: 'R1-F001', fix: { affectedPaths: ['src/a.mjs', '.scratch/s/x.walkthrough.md'] } }]);
    assert.match(fixed, /^- \*\*\[MODIFY\]\*\* `src\/a\.mjs` — Adds x\.; fixes R1-F001$/m);
    assert.doesNotMatch(fixed, /\.scratch/, 'session artifacts are not listed');
  });

  it('requires a non-empty Final gate for table walkthroughs and at most one Context', () => {
    assert.ok(rules(lintWalkthrough(PLANLESS.replace(/Final gate: .*/, 'Final gate:'))).includes('traceability-not-table'), 'plan-less too');
    assert.ok(rules(lintWalkthrough(VALID.replace('\nFinal gate: `npm test` exit 0\n', '\n'))).includes('traceability-not-table'));
    assert.ok(rules(lintWalkthrough(VALID.replace('Final gate: `npm test` exit 0', 'Final gate:'))).includes('traceability-not-table'));
    assert.ok(rules(lintWalkthrough(PLANLESS.replace('## Changes Made', '## Context\n- Ask: again\n\n## Changes Made'))).includes('section-order'));
  });

  const cases = {
    'context-required': [PLANLESS.replace(/## Context\n- Ask: .*\n\n/, ''), {}],
    'context-forbidden': [VALID.replace('## Changes Made', '## Context\n- Ask: x\n\n## Changes Made'), {}],
    'title-repeats-delivered': [VALID.replace('# Feature', '# The parser splits on escaped pipes'), {}],
    'filler-note': [VALID.replace('Covers escaped pipes.', 'Approved implementation scope.'), {}],
    'deviations-mismatch': [VALID.replace('## Deviations & Follow-ups\nNone.', '## Deviations & Follow-ups\n- Deviation: swapped the parser for a regex.'), {}],
    'traceability-not-table': [withTable(TABLE.replace('| SC | Outcome | Evidence |', '| SC | Behavior | Production path | Evidence |')), {}],
    'traceability-rows': [PLANLESS, { criteria: CRITERIA }],
    'section-order': [VALID.replace('## Review Findings & Resolutions', '## Follow-ups'), {}],
  };
  for (const [rule, [source, options]] of Object.entries(cases)) {
    it(`readable walkthrough contract: ${rule}`, () => {
      assert.ok(rules(lintWalkthrough(source, options)).includes(rule), rules(lintWalkthrough(source, options)).join(', '));
    });
  }

  it('readable walkthrough contract: a Deviation bullet with a summary box passes; Follow-up bullets alone keep none', () => {
    const deviation = VALID.replace('## Deviations & Follow-ups\nNone.', '## Deviations & Follow-ups\n- Deviation: swapped the parser.').replace('> **Deviations:** none', '> **Deviations:** parser swapped');
    assert.deepEqual(lintWalkthrough(deviation).defects, []);
    const followUp = VALID.replace('## Deviations & Follow-ups\nNone.', '## Deviations & Follow-ups\n- Follow-up: [R1-F002] cache the split.');
    assert.deepEqual(lintWalkthrough(followUp).defects, []);
  });

  it('readable walkthrough contract: legitimate repeated fix notes are not filler', () => {
    const fixes = VALID.replace('Escaped-pipe splitting.', 'fixes R1-F001').replace('Covers escaped pipes.', 'fixes R1-F001');
    assert.ok(!rules(lintWalkthrough(fixes)).includes('filler-note'));
  });

  it('readable walkthrough contract: the final-gate line must trail the table', () => {
    const early = withTable(`Final gate: pending\n${TABLE}`);
    assert.ok(rules(lintWalkthrough(early)).includes('traceability-not-table'));
  });
});

// SECTION: Diagnostics

describe('walkthrough lint diagnostics', () => {
  it('missing-summary-box when the box is absent', () => {
    assert.ok(rules(lintWalkthrough(VALID.replace(`${BOX}\n\n`, ''))).includes('missing-summary-box'));
  });

  it('summary-label for misordered, extra, duplicate, missing, empty, or malformed labels', () => {
    const [delivered, parent, status, deviations] = BOX.split('\n');
    const cases = {
      misordered: [parent, delivered, status, deviations].join('\n'),
      extra: `${BOX}\n> **Risk:** low — extra`,
      duplicate: `${BOX}\n> **Status:** 1/2 SC passing`,
      missing: [delivered, parent, status].join('\n'),
      empty: BOX.replace('> **Deviations:** none', '> **Deviations:**'),
      status: BOX.replace('1/2 SC passing', '1 of 2 passing'),
      casing: BOX.replace('**Delivered:**', '**delivered:**'),
    };
    for (const [name, box] of Object.entries(cases)) {
      assert.ok(rules(lintWalkthrough(withBox(box))).includes('summary-label'), name);
    }
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
      missingValidated: [withTable(TABLE.replace('red→green `npm test` exit 0', 'missing validated evidence')), { criteria: CRITERIA }],
    };
    for (const [name, [source, options]] of Object.entries(cases)) {
      assert.ok(rules(lintWalkthrough(source, options)).includes('status-mismatch'), name);
    }
  });

  it('counts only the Evidence cell, so Outcome text mentioning Pending still passes', () => {
    const behavior = withTable(TABLE.replace('Splits `a \\| b` on escaped pipes', 'Clears the Pending queue'));
    assert.deepEqual(lintWalkthrough(behavior, { criteria: CRITERIA }).defects, []);
  });

  it('section-order when minimum-contract sections are out of order or missing', () => {
    const swapped = VALID.replace(/(## Verification\n[\s\S]*?\n)(## Deviations & Follow-ups\nNone\.\n\n)/, '$2$1');
    assert.ok(swapped.indexOf('## Deviations & Follow-ups') < swapped.indexOf('## Verification'));
    assert.ok(rules(lintWalkthrough(swapped)).includes('section-order'));
  });

  it('leftover-placeholder for template tokens in prose and inline code, not in fences', () => {
    const line = '- **[MODIFY]** `src/a.js` — Escaped-pipe splitting.';
    for (const leftover of ['- **[MODIFY]** `<relative-path>` — Escaped-pipe splitting.', '- **[MODIFY]** `src/a.js` — <what changed in this file>']) {
      assert.ok(rules(lintWalkthrough(VALID.replace(line, leftover))).includes('leftover-placeholder'), leftover);
    }
    const fenced = VALID.replace('None.\n', 'None.\n```md\n<relative-path>\n```\n');
    assert.ok(!rules(lintWalkthrough(fenced)).includes('leftover-placeholder'));
  });
});
