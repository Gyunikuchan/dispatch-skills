import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lintPlan } from '../../../skills/dispatch/scripts/plan-lint.mjs';

const clean = [
  '# Plan',
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
    const generated = clean.replace('## Verification Plan', '#### [GENERATED] dist/a.js\n- Command: `node build.mjs`\n## Verification Plan');
    assert.ok(!rules(lintPlan(generated)).includes('generated-command'));
    assert.ok(rules(lintPlan(generated.replace('- Command: `node build.mjs`', '- Built output.'))).includes('generated-command'));
  });
  it('accepts a canonical executable plan', () => {
    assert.deepEqual(lintPlan(clean), { defects: [], warnings: [] });
  });

  it('accepts required section and H3 headings with trailing whitespace', () => {
    const padded = clean
      .replace('## Success Criteria', '## Success Criteria   ')
      .replace('## Proposed Changes', '## Proposed Changes\t')
      .replace('## Verification Plan', '## Verification Plan  ')
      .replace('### Automated Tests', '### Automated Tests\t');
    assert.deepEqual(lintPlan(padded), { defects: [], warnings: [] });
  });

  it('requires one Proposed Changes section with an action heading', () => {
    assert.ok(rules(lintPlan(clean.replace('## Proposed Changes', '## Changes'))).includes('proposed-changes'));
    assert.ok(rules(lintPlan(`${clean}\n## Proposed Changes\n#### [NEW] other.js`)).includes('proposed-changes'));
    assert.ok(rules(lintPlan(clean.replace('#### [MODIFY] src/a.js\n#### [NEW] tests/a.test.js', '- prose'))).includes('change-heading'));
  });

  it('rejects duplicate/conflicting and unsafe change paths after normalization', () => {
    const duplicate = clean.replace('#### [NEW] tests/a.test.js', [
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
    assert.ok(rules(lintPlan(clean.replace('## Verification Plan', '## Checks'))).includes('verification-plan'));
    assert.ok(rules(lintPlan(clean.replace('### Automated Tests', '### Manual Tests'))).includes('automated-tests'));
    assert.ok(rules(lintPlan(`${clean}\n### Automated Tests\n- \`npm test\``)).includes('automated-tests'));
    assert.ok(rules(lintPlan(clean.replace('## Success Criteria', '### Automated Tests\n- `npm test`\n## Success Criteria'))).includes('automated-tests-owner'));
    assert.ok(rules(lintPlan(clean.replace('- `node --test tests/a.test.js`', 'Some prose with `npm test`.'))).includes('automated-command'));
  });

  it('extracts commands only from direct single-span bullets or non-comment fenced lines', () => {
    const ambiguous = lintPlan(clean.replace(
      '- `node --test tests/a.test.js`',
      '- `npm test` and `npm run lint`\n- `npm test` then `npm run check`',
    )).warnings.filter(({ rule }) => rule === 'ambiguous-command');
    assert.deepEqual(ambiguous.map(({ locus }) => locus), ['line 13', 'line 14']);
    assert.ok(rules(lintPlan(clean.replace(
      '- `node --test tests/a.test.js`',
      '```sh\n# explanation\n\n```',
    ))).includes('automated-command'));
    assert.deepEqual(lintPlan(clean.replace(
      '- `node --test tests/a.test.js`',
      '```sh\n# explanation\nnpm test\n```',
    )).defects, []);
    for (const hidden of [
      '<!-- - `npm test` -->',
      '> - `npm test`',
    ]) {
      assert.ok(rules(lintPlan(clean.replace('- `node --test tests/a.test.js`', hidden))).includes('automated-command'));
    }
  });

  it('treats a direct None item as warning-only and requires a reason', () => {
    const unavailable = lintPlan(clean.replace('- `node --test tests/a.test.js`', '- None: runner unavailable'));
    assert.deepEqual(unavailable.defects, []);
    assert.ok(unavailable.warnings.some(({ rule }) => rule === 'automated-tests-unavailable'));
    assert.deepEqual(lintPlan(clean.replace('- `node --test tests/a.test.js`', '- None: x')).defects, []);
    assert.ok(rules(lintPlan(clean.replace('- `node --test tests/a.test.js`', '- None:'))).includes('automated-command'));
    assert.ok(rules(lintPlan(clean.replace(
      '- `node --test tests/a.test.js`',
      '<!-- - None: runner unavailable -->',
    ))).includes('automated-command'));
  });

  it('validates criterion identity, direct list structure, mappings, and references', () => {
    assert.ok(rules(lintPlan(clean.replace('[SC1]', 'criterion'))).includes('criterion-id'));
    assert.ok(rules(lintPlan(`${clean.replace('## Proposed Changes', '- [SC1] Duplicate\n  - Verify: `npm test`\n## Proposed Changes')}`)).includes('criterion-id'));
    assert.ok(rules(lintPlan(clean.replace(
      '  - Changes: `src/a.js`, tests/a.test.js\n  - Verify: `node --test tests/a.test.js`',
      '  - Notes: later',
    ))).includes('criterion-mapping'));
    assert.ok(rules(lintPlan(clean.replace('`src/a.js`, tests/a.test.js', '`src/missing.js`'))).includes('criterion-change-path'));
    const scratch = lintPlan(clean.replace('`src/a.js`, tests/a.test.js', '`.scratch/plan/x.md`').replace('#### [MODIFY] src/a.js', '#### [MODIFY] .scratch/plan/x.md'));
    assert.equal(rules(scratch).filter(rule => rule === 'change-path-excluded').length, 2);
    assert.ok(!rules(scratch).includes('criterion-change-path'));
    assert.ok(rules(lintPlan(clean.replace('#### [MODIFY] src/a.js', '#### [MODIFY] .git/config'))).includes('change-path-excluded'));
    assert.ok(rules(lintPlan(clean.replace('  - Verify: `node --test tests/a.test.js`', '  - Verify: `npm test` and `npm run lint`'))).includes('criterion-verify'));
  });

  it('validates evidence classes, rationales, review scenarios, and critical review enforcement', () => {
    assert.ok(rules(lintPlan(clean.replace('  - Evidence: red\n', ''))).includes('criterion-evidence'));
    assert.ok(rules(lintPlan(clean.replace('Evidence: red', 'Evidence: maybe'))).includes('criterion-evidence'));
    assert.ok(rules(lintPlan(clean.replace('  - Test rationale: Behavioral failure isolates the feature and protects a plausible regression.\n', ''))).includes('criterion-test-rationale'));
    const review = clean.replace('Evidence: red', 'Evidence: review');
    assert.ok(rules(lintPlan(review)).includes('criterion-review'));
    assert.deepEqual(lintPlan(review.replace('  - Test rationale:', '  - Review: artifact: src/a.js; scenario: inspect behavior; pass: observable outcome\n  - Test rationale:')).defects, []);
    const critical = review.replace('Change and test the feature.', 'Protect recovery safety.').replace('  - Test rationale:', '  - Review: artifact: src/a.js; scenario: inspect recovery; pass: safe restoration\n  - Test rationale:');
    assert.ok(rules(lintPlan(critical)).includes('criterion-critical-review'));
    assert.deepEqual(lintPlan(critical.replace('  - Test rationale:', '  - Enforcement infeasibility: External human judgment has no deterministic oracle.\n  - Test rationale:')).defects, []);
  });

  it('matches backticked criterion paths containing spaces', () => {
    const spaced = clean
      .replace('`src/a.js`, tests/a.test.js', '`src/file with spaces.js`, tests/a.test.js')
      .replace('#### [MODIFY] src/a.js', '#### [MODIFY] `src/file with spaces.js`');
    assert.deepEqual(lintPlan(spaced), { defects: [], warnings: [] });
  });

  it('does not mistake Changes bullets in action blocks for success criteria', () => {
    const legacy = clean
      .replace(/## Success Criteria[\s\S]*?(?=## Proposed Changes)/, '')
      .replace('#### [MODIFY] src/a.js', '#### [MODIFY] src/a.js\n- Changes: missing.js');
    const result = lintPlan(legacy);
    assert.deepEqual(result.defects, []);
    assert.ok(result.warnings.some(({ rule }) => rule === 'missing-success-criteria'));
  });

  it('matches placeholder phrases only on word boundaries', () => {
    const result = lintPlan(`${clean}
We reimplement latership and refill in bulk.`);
    assert.equal(result.warnings.filter(({ rule }) => rule === 'placeholder').length, 0);
  });

  it('excludes examples and reports prose placeholders with exact line loci', () => {
    const source = `${clean}\n<!-- TODO hidden -->\n> TBD quoted\n\`implement later\`\nProse says fill in this detail.`;
    const result = lintPlan(source);
    assert.equal(result.warnings.filter(({ rule }) => rule === 'placeholder').length, 1);
    assert.match(result.warnings.find(({ rule }) => rule === 'placeholder').locus, /line 17/i);
  });
});
