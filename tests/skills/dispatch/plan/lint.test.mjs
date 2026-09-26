import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lintPlan } from '../../../../skills/dispatch/scripts/plan/lint.mjs';

// SECTION: Canonical fixture and diagnostic helpers

const VALID_PLAN = [
  '# Plan',
  '',
  '> **TL;DR:** Change and test the feature.',
  '> **Decide:** none',
  '> **Risk:** low — one module and its test',
  '> **Scope:** src/a.js, tests/a.test.js',
  '',
  '## Success Criteria',
  '- [SC1] Change and test the feature.',
  '  - Changes: `src/a.js`, tests/a.test.js',
  '  - Verify: `node --test tests/a.test.js`',
  '  - Evidence: red',
  '  - Test rationale: Behavioral failure isolates the feature and protects a plausible regression.',
  '## Proposed Changes',
  '#### [MODIFY] src/a.js',
  '#### [NEW] tests/a.test.js',
  '## Verification Plan',
  '### Automated Tests',
  '- `node --test tests/a.test.js`',
].join('\n');

const rules = result => result.defects.map(({ rule }) => rule);

describe('deterministic plan lint', () => {
  it('requires a generator command for each [GENERATED] path', () => {
    const generated = VALID_PLAN.replace('## Verification Plan', '#### [GENERATED] dist/a.js\n- Command: `node build.mjs`\n## Verification Plan');
    assert.ok(!rules(lintPlan(generated)).includes('generated-command'));
    assert.ok(rules(lintPlan(generated.replace('- Command: `node build.mjs`', '- Built output.'))).includes('generated-command'));
  });
  it('accepts a canonical executable plan', () => {
    assert.deepEqual(lintPlan(VALID_PLAN), { defects: [], warnings: [] });
  });

  it('accepts required section and H3 headings with trailing whitespace', () => {
    const padded = VALID_PLAN
      .replace('## Success Criteria', '## Success Criteria   ')
      .replace('## Proposed Changes', '## Proposed Changes\t')
      .replace('## Verification Plan', '## Verification Plan  ')
      .replace('### Automated Tests', '### Automated Tests\t');
    assert.deepEqual(lintPlan(padded), { defects: [], warnings: [] });
  });

  it('requires one Proposed Changes section with an action heading', () => {
    assert.ok(rules(lintPlan(VALID_PLAN.replace('## Proposed Changes', '## Changes'))).includes('proposed-changes'));
    assert.ok(rules(lintPlan(`${VALID_PLAN}\n## Proposed Changes\n#### [NEW] other.js`)).includes('proposed-changes'));
    assert.ok(rules(lintPlan(VALID_PLAN.replace('#### [MODIFY] src/a.js\n#### [NEW] tests/a.test.js', '- prose'))).includes('change-heading'));
  });

  it('rejects duplicate/conflicting and unsafe change paths after normalization', () => {
    const duplicate = VALID_PLAN.replace('#### [NEW] tests/a.test.js', [
      '#### [NEW] ./src/a.js',
      '#### [DELETE] src/a.js',
      '#### [NEW] ../escape.js',
      '#### [NEW] /absolute.js',
      '#### [NEW] src\\\\windows.js',
    ].join('\n'));
    const found = rules(lintPlan(duplicate));
    assert.ok(found.includes('duplicate-change-path'));
    assert.ok(found.includes('invalid-change-path'));
  });

  it('requires one owned Automated Tests section and a syntactic command', () => {
    assert.ok(rules(lintPlan(VALID_PLAN.replace('## Verification Plan', '## Checks'))).includes('verification-plan'));
    assert.ok(rules(lintPlan(VALID_PLAN.replace('### Automated Tests', '### Manual Tests'))).includes('automated-tests'));
    assert.ok(rules(lintPlan(`${VALID_PLAN}\n### Automated Tests\n- \`npm test\``)).includes('automated-tests'));
    assert.ok(rules(lintPlan(VALID_PLAN.replace('## Success Criteria', '### Automated Tests\n- `npm test`\n## Success Criteria'))).includes('automated-tests-owner'));
    assert.ok(rules(lintPlan(VALID_PLAN.replace('- `node --test tests/a.test.js`', 'Some prose with `npm test`.'))).includes('automated-command'));
  });

  it('extracts commands only from direct single-span bullets or non-comment fenced lines', () => {
    const ambiguous = lintPlan(VALID_PLAN.replace(
      '- `node --test tests/a.test.js`',
      '- `npm test` and `npm run lint`\n- `npm test` then `npm run check`',
    )).warnings.filter(({ rule }) => rule === 'ambiguous-command');
    assert.deepEqual(ambiguous.map(({ locus }) => locus), ['line 19', 'line 20']);
    assert.ok(rules(lintPlan(VALID_PLAN.replace(
      '- `node --test tests/a.test.js`',
      '```sh\n# explanation\n\n```',
    ))).includes('automated-command'));
    assert.deepEqual(lintPlan(VALID_PLAN.replace(
      '- `node --test tests/a.test.js`',
      '```sh\n# explanation\nnpm test\n```',
    )).defects, []);
    for (const hidden of [
      '<!-- - `npm test` -->',
      '> - `npm test`',
    ]) {
      assert.ok(rules(lintPlan(VALID_PLAN.replace('- `node --test tests/a.test.js`', hidden))).includes('automated-command'));
    }
  });

  it('treats a direct None item as warning-only and requires a reason', () => {
    const unavailable = lintPlan(VALID_PLAN.replace('- `node --test tests/a.test.js`', '- None: runner unavailable'));
    assert.deepEqual(unavailable.defects, []);
    assert.ok(unavailable.warnings.some(({ rule }) => rule === 'automated-tests-unavailable'));
    assert.deepEqual(lintPlan(VALID_PLAN.replace('- `node --test tests/a.test.js`', '- None: x')).defects, []);
    assert.ok(rules(lintPlan(VALID_PLAN.replace('- `node --test tests/a.test.js`', '- None:'))).includes('automated-command'));
    assert.ok(rules(lintPlan(VALID_PLAN.replace(
      '- `node --test tests/a.test.js`',
      '<!-- - None: runner unavailable -->',
    ))).includes('automated-command'));
  });

  it('validates criterion identity, direct list structure, mappings, and references', () => {
    assert.ok(rules(lintPlan(VALID_PLAN.replace('[SC1]', 'criterion'))).includes('criterion-id'));
    assert.ok(rules(lintPlan(`${VALID_PLAN.replace('## Proposed Changes', '- [SC1] Duplicate\n  - Verify: `npm test`\n## Proposed Changes')}`)).includes('criterion-id'));
    assert.ok(rules(lintPlan(VALID_PLAN.replace(
      '  - Changes: `src/a.js`, tests/a.test.js\n  - Verify: `node --test tests/a.test.js`',
      '  - Notes: later',
    ))).includes('criterion-mapping'));
    assert.ok(rules(lintPlan(VALID_PLAN.replace('`src/a.js`, tests/a.test.js', '`src/missing.js`'))).includes('criterion-change-path'));
    const scratch = lintPlan(VALID_PLAN.replace('`src/a.js`, tests/a.test.js', '`.scratch/plan/x.md`').replace('#### [MODIFY] src/a.js', '#### [MODIFY] .scratch/plan/x.md'));
    assert.equal(rules(scratch).filter(rule => rule === 'change-path-excluded').length, 2);
    assert.ok(!rules(scratch).includes('criterion-change-path'));
    assert.ok(rules(lintPlan(VALID_PLAN.replace('#### [MODIFY] src/a.js', '#### [MODIFY] .git/config'))).includes('change-path-excluded'));
    assert.ok(rules(lintPlan(VALID_PLAN.replace('  - Verify: `node --test tests/a.test.js`', '  - Verify: `npm test` and `npm run lint`'))).includes('criterion-verify'));
  });

  it('accepts a [FINAL] suffix after the Verify command', () => {
    const final = lintPlan(VALID_PLAN.replace('  - Verify: `node --test tests/a.test.js`', '  - Verify: `node --test tests/a.test.js` [FINAL]'));
    assert.ok(!rules(final).includes('criterion-verify'), JSON.stringify(final.defects));
    assert.ok(rules(lintPlan(VALID_PLAN.replace('  - Verify: `node --test tests/a.test.js`', '  - Verify: `node --test tests/a.test.js` [SLOW]'))).includes('criterion-verify'));
  });

  it('validates evidence classes, rationales, review scenarios, and critical review enforcement', () => {
    assert.ok(rules(lintPlan(VALID_PLAN.replace('  - Evidence: red\n', ''))).includes('criterion-evidence'));
    assert.ok(rules(lintPlan(VALID_PLAN.replace('Evidence: red', 'Evidence: maybe'))).includes('criterion-evidence'));
    assert.ok(rules(lintPlan(VALID_PLAN.replace('  - Test rationale: Behavioral failure isolates the feature and protects a plausible regression.\n', ''))).includes('criterion-test-rationale'));
    const review = VALID_PLAN.replace('Evidence: red', 'Evidence: review').replace('| red |', '| review |');
    assert.ok(rules(lintPlan(review)).includes('criterion-review'));
    assert.deepEqual(lintPlan(review.replace('  - Test rationale:', '  - Review: artifact: src/a.js; scenario: inspect behavior; pass: observable outcome\n  - Test rationale:')).defects, []);
    const critical = review.replaceAll('Change and test the feature.', 'Protect recovery safety.').replace('  - Test rationale:', '  - Review: artifact: src/a.js; scenario: inspect recovery; pass: safe restoration\n  - Test rationale:');
    assert.ok(rules(lintPlan(critical)).includes('criterion-critical-review'));
    assert.deepEqual(lintPlan(critical.replace('  - Test rationale:', '  - Enforcement infeasibility: External human judgment has no deterministic oracle.\n  - Test rationale:')).defects, []);
  });

  it('matches backticked criterion paths containing spaces', () => {
    const spaced = VALID_PLAN
      .replace('`src/a.js`, tests/a.test.js', '`src/file with spaces.js`, tests/a.test.js')
      .replace('#### [MODIFY] src/a.js', '#### [MODIFY] `src/file with spaces.js`');
    assert.deepEqual(lintPlan(spaced), { defects: [], warnings: [] });
  });

  it('does not mistake Changes bullets in action blocks for success criteria', () => {
    const noCriteria = VALID_PLAN
      .replace(/## Success Criteria[\s\S]*?(?=## Proposed Changes)/, '')
      .replace('#### [MODIFY] src/a.js', '#### [MODIFY] src/a.js\n- Changes: missing.js');
    const result = lintPlan(noCriteria);
    assert.deepEqual(result.defects, []);
    assert.ok(result.warnings.some(({ rule }) => rule === 'missing-success-criteria'));
  });

  it('matches placeholder phrases only on word boundaries', () => {
    const result = lintPlan(`${VALID_PLAN}
We reimplement latership and refill in bulk.`);
    assert.equal(result.warnings.filter(({ rule }) => rule === 'placeholder').length, 0);
  });

  it('excludes examples and reports prose placeholders with exact line loci', () => {
    const source = `${VALID_PLAN}\n<!-- TODO hidden -->\n> TBD quoted\n\`implement later\`\nProse says fill in this detail.`;
    const result = lintPlan(source);
    assert.equal(result.warnings.filter(({ rule }) => rule === 'placeholder').length, 1);
    assert.match(result.warnings.find(({ rule }) => rule === 'placeholder').locus, /line 23/i);
  });
});

// SECTION: RED exception field (SC5)

describe('plan lint: RED exception field', () => {
  const withException = (value, evidence = 'red') => VALID_PLAN
    .replace('  - Evidence: red', `  - Evidence: ${evidence}\n  - RED exception: ${value}`);

  it('accepts a declared RED exception class on a red criterion', () => {
    assert.deepEqual(lintPlan(withException('behavior-preserving')), { defects: [], warnings: [] });
    assert.deepEqual(lintPlan(withException('already-satisfied')), { defects: [], warnings: [] });
  });

  it('rejects an unknown RED exception class', () => {
    assert.ok(rules(lintPlan(withException('flaky'))).includes('criterion-red-exception'));
  });

  it('rejects a RED exception on a non-red criterion', () => {
    assert.ok(rules(lintPlan(withException('behavior-preserving', 'verify'))).includes('criterion-red-exception'));
  });

  it('warns on a red criterion whose Changes line names no test path unless it declares an exception', () => {
    const warned = plan => lintPlan(plan).warnings.map(({ rule }) => rule).includes('criterion-red-test-path');
    const noTest = VALID_PLAN.replace('  - Changes: `src/a.js`, tests/a.test.js', '  - Changes: `src/a.js`');
    assert.ok(warned(noTest));
    assert.deepEqual(lintPlan(noTest).defects, []);
    assert.ok(!warned(VALID_PLAN));
    assert.ok(!warned(noTest.replace('  - Evidence: red', '  - Evidence: red\n  - RED exception: already-satisfied')));
    assert.ok(!warned(noTest.replace('  - Evidence: red', '  - Evidence: verify')));
  });
});

// SECTION: Summary box, detailed criteria, and template placeholders

const BOX = [
  '> **TL;DR:** Change and test the feature.',
  '> **Decide:** none',
  '> **Risk:** low — one module and its test',
  '> **Scope:** src/a.js, tests/a.test.js',
].join('\n');
const withBox = box => VALID_PLAN.replace(BOX, box);
const boxRules = result => rules(result).filter(rule => rule === 'missing-summary-box' || rule === 'summary-label');

describe('plan summary box', () => {
  it('plan summary box accepts the ordered TL;DR, Decide, Risk, Scope box', () => {
    assert.deepEqual(boxRules(lintPlan(VALID_PLAN)), []);
    assert.deepEqual(boxRules(lintPlan(withBox(BOX.replace('> **Decide:** none', '> **Decide:** approve the rename')))), []);
  });

  it('plan summary box rejects a missing box', () => {
    assert.ok(rules(lintPlan(VALID_PLAN.replace(`${BOX}\n\n`, ''))).includes('missing-summary-box'));
  });

  it('plan summary box rejects misordered, extra, duplicate, and empty labels', () => {
    const lines = BOX.split('\n');
    const cases = {
      misordered: [lines[1], lines[0], lines[2], lines[3]].join('\n'),
      extra: `${BOX}\n> **Status:** 0/1 SC passing`,
      duplicate: `${BOX}\n> **Scope:** again`,
      missingLabel: [lines[0], lines[1], lines[3]].join('\n'),
      empty: BOX.replace('> **Scope:** src/a.js, tests/a.test.js', '> **Scope:**'),
      lowercaseLabel: BOX.replace('**TL;DR:**', '**tl;dr:**'),
    };
    for (const [name, box] of Object.entries(cases)) {
      assert.ok(rules(lintPlan(withBox(box))).includes('summary-label'), name);
    }
  });

  it('plan summary box requires Risk as low|med|high — reason', () => {
    for (const risk of ['medium — broad', 'Low — casing', 'low - hyphen', 'low —', 'high']) {
      assert.ok(rules(lintPlan(withBox(BOX.replace('low — one module and its test', risk)))).includes('summary-label'), risk);
    }
    for (const risk of ['med — two modules', 'high — breaking contract']) {
      assert.deepEqual(boxRules(lintPlan(withBox(BOX.replace('low — one module and its test', risk)))), [], risk);
    }
  });
});

const TWO_CRITERIA = VALID_PLAN.replace(
  '## Proposed Changes',
  [
    '- [SC2] Document the feature.',
    '  - Changes: `src/a.js`',
    '  - Verify: `npm run hashes`',
    '  - Verify: `npm test` [FINAL]',
    '  - Evidence: verify',
    '  - Test rationale: Documentation churn is proven by the existing suite.',
    '## Proposed Changes',
  ].join('\n'),
);

describe('plan detailed criteria', () => {
  it('accepts multiple detailed entries, including multi-Verify and [FINAL] commands', () => {
    assert.deepEqual(lintPlan(VALID_PLAN).defects, []);
    assert.deepEqual(lintPlan(TWO_CRITERIA).defects, []);
  });

  it('accepts a review criterion without Verify', () => {
    const review = VALID_PLAN
      .replace('  - Verify: `node --test tests/a.test.js`\n', '')
      .replace('  - Evidence: red', '  - Evidence: review\n  - Review: artifact: src/a.js; scenario: inspect behavior; pass: observable outcome');
    assert.deepEqual(lintPlan(review).defects, []);
  });

  it('requires detailed entries and rejects table syntax', () => {
    const empty = VALID_PLAN.replace(/- \[SC1\][\s\S]*?(?=## Proposed Changes)/, '');
    assert.ok(rules(lintPlan(empty)).includes('success-criteria'));
    const withTable = VALID_PLAN.replace('## Success Criteria', '## Success Criteria\n| SC | Outcome |\n| --- | --- |\n| SC1 | Change |');
    assert.ok(rules(lintPlan(withTable)).includes('criterion-format'));
  });
});

describe('plan template placeholder', () => {
  it('plan template placeholder rejects leftover template tokens in prose and inline code', () => {
    for (const leftover of ['Touch <relative-path> next.', 'Run `<test command>` now.', 'Slug `<yyyy-mm-dd>`.']) {
      const result = lintPlan(`${VALID_PLAN}\n## Out of Scope\n${leftover}`);
      assert.ok(rules(result).includes('leftover-placeholder'), leftover);
    }
  });

  it('plan template placeholder ignores fenced blocks, non-template tokens, and machine-managed comments', () => {
    const clean = `${VALID_PLAN}\n## Out of Scope\n\`\`\`md\n<relative-path>\n\`\`\`\nGeneric <T> stays. Increment plans use \`-i<nn>-\` and \`<nn>\` numbering; \`\`<nn>\`\` too.\n<!-- Populated during plan review cycles -->`;
    assert.ok(!rules(lintPlan(clean)).includes('leftover-placeholder'));
  });
});
