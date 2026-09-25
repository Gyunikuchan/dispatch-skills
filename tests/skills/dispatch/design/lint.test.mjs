import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lintDesign } from '../../../../skills/dispatch/scripts/design/lint.mjs';
import { requiredDesignSections } from '../../../helpers/design-document-fixture.mjs';

const BOX = [
  '> **TL;DR:** Two increments deliver the demo.',
  '> **Decide:** none',
  '> **Risk:** med — two dependent increments',
  '> **Increments:** 2',
].join('\n');

const base = [
  '# D',
  '',
  BOX,
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

// SECTION: Summary box and template placeholders

const codes = source => lintDesign(source).diagnostics.map(({ code }) => code);
const withBox = box => base.replace(BOX, box);

describe('design summary box', () => {
  it('design summary box accepts the ordered TL;DR, Decide, Risk, Increments box', () => {
    const linted = lintDesign(base);
    assert.deepEqual(linted.diagnostics, []);
    assert.equal(linted.valid, true);
  });

  it('design summary box rejects a missing box', () => {
    assert.ok(codes(base.replace(`${BOX}\n`, '')).includes('missing-summary-box'));
  });

  it('design summary box rejects misordered, extra, empty, and malformed labels', () => {
    const lines = BOX.split('\n');
    const cases = {
      misordered: [lines[0], lines[2], lines[1], lines[3]].join('\n'),
      extra: `${BOX}\n> **Scope:** a, b`,
      missingLabel: [lines[0], lines[1], lines[2]].join('\n'),
      empty: BOX.replace('> **Decide:** none', '> **Decide:**'),
      risk: BOX.replace('med — two dependent increments', 'medium - two'),
      increments: BOX.replace('> **Increments:** 2', '> **Increments:** two'),
    };
    for (const [name, box] of Object.entries(cases)) {
      assert.ok(codes(withBox(box)).includes('summary-label'), name);
    }
  });

  it('design summary box requires Increments to equal the graph increment count', () => {
    assert.ok(codes(withBox(BOX.replace('> **Increments:** 2', '> **Increments:** 3'))).includes('summary-label'));
  });
});

describe('design template placeholder', () => {
  it('design template placeholder rejects leftover design.md tokens', () => {
    for (const leftover of ['Touches <what this increment changes>.', 'Paths `<paths>`.']) {
      const source = base.replace('## Architecture & Boundaries\nx', `## Architecture & Boundaries\n${leftover}`);
      assert.ok(codes(source).includes('leftover-placeholder'), leftover);
    }
  });

  it('design template placeholder ignores fenced examples', () => {
    const fenced = base.replace('## Architecture & Boundaries\nx', '## Architecture & Boundaries\n```md\n<paths>\n```');
    assert.ok(!codes(fenced).includes('leftover-placeholder'));
  });
});
