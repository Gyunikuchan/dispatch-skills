import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lintDesign } from '../../../../skills/dispatch/scripts/design/lint.mjs';
import { requiredDesignSections } from '../../../helpers/design-document-fixture.mjs';

const base = [
  '# D',
  requiredDesignSections(['I01', 'I02']),
  '## Architecture & Boundaries',
  'x',
  '## Alternatives & Decisions',
  'x',
  '## Risks, Security & Operations',
  'x',
  '## Increment Dependency Graph',
  '| ID | Priority | Summary | Prerequisites | Paths |',
  '| --- | ---: | --- | --- | --- |',
  '| I01 | 1 | one | none | a |',
  '| I02 | 2 | two | I01 | b |',
].join('\n');

function hasDiagnostic(source, code) {
  return lintDesign(source).diagnostics.some(diagnostic => diagnostic.code === code);
}

describe('design lint', () => {
  // SECTION: Valid contracts

  it('accepts valid graphs regardless of row order and ignores status mirror rows', () => {
    const reordered = base.replace(
      '| I01 | 1 | one | none | a |\n| I02 | 2 | two | I01 | b |',
      '| I02 | 2 | two | I01 | b |\n| I01 | 1 | one | none | a |',
    );
    const mirrored = `${reordered}\n\n## Execution Status\n| ID | State | Next Action |\n| --- | --- | --- |\n| I01 | complete | - |\n| I02 | ready | implement I02 |\n`;
    assert.equal(lintDesign(mirrored).valid, true);
  });

  // SECTION: Diagnostics

  it('requires every increment detail field and required section', () => {
    const linted = lintDesign(base.replace('- Parallel safety: x\n### I02', '### I02'));
    assert.deepEqual(linted.diagnostics, [
      { code: 'missing-increment-field', id: 'I01', field: 'Parallel safety' },
    ]);
    assert.equal(hasDiagnostic(base.replace('## Final Integration', '## Other'), 'missing-section'), true);
  });

  it('rejects graph cycles, gaps, and missing graph rows', () => {
    assert.equal(hasDiagnostic(base.replace('I01 | 1 | one | none', 'I01 | 1 | one | I02'), 'cycle'), true);
    assert.equal(hasDiagnostic(base.replace('I02 | 2', 'I05 | 2'), 'invalid-id-sequence'), true);
    assert.equal(hasDiagnostic(base.replace(/^\| I\d{2}.*$/gm, ''), 'missing-increments'), true);
  });

  it('does not accept increment-shaped rows outside the graph section', () => {
    const stray = `${base.replace('## Increment Dependency Graph', '## Other Section')}\n| I03 | 3 | outside | none | c |`;
    assert.equal(hasDiagnostic(stray, 'missing-increments'), true);
  });
});
