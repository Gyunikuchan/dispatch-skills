import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { incrementGraphSection, parseIncrementGraph } from '../../../skills/dispatch/scripts/design-graph.mjs';
import { lintDesign } from '../../../skills/dispatch/scripts/design-lint.mjs';
import { designExtras } from '../../helpers/design-sections.mjs';

const base = [
  '# D',
  '',
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

describe('increment dependency graph parser', () => {
  it('parses rows into id, priority, summary, prerequisites, and paths', () => {
    const parsed = parseIncrementGraph(base);
    assert.equal(parsed.valid, true);
    assert.deepEqual(parsed.diagnostics, []);
    assert.equal(parsed.increments.length, 2);
    assert.deepEqual(parsed.increments[0], {
      id: 'I01', priority: 1, summary: 'one', prerequisites: [], paths: ['a'],
    });
    assert.deepEqual(parsed.increments[1], {
      id: 'I02', priority: 2, summary: 'two', prerequisites: ['I01'], paths: ['b'],
    });
  });

  it('tolerates a missing Paths column as an empty path set', () => {
    const withoutPaths = base.replace(' | a |', '').replace(' | b |', '');
    const parsed = parseIncrementGraph(withoutPaths);
    assert.equal(parsed.valid, true);
    assert.deepEqual(parsed.increments.map(row => row.paths), [[], []]);
  });

  it('scopes row matching to the Increment Dependency Graph section', () => {
    const withMirrorRows = `${base}\n\n## Execution Status\n<!-- machine-managed -->\n\n| ID | State | Next Action |\n| --- | --- | --- |\n| I01 | complete | - |\n| I02 | ready | implement I02 |\n`;
    const parsed = parseIncrementGraph(withMirrorRows);
    assert.equal(parsed.valid, true);
    assert.deepEqual(parsed.increments.map(row => row.id), ['I01', 'I02']);
  });

  it('ignores increment-shaped rows outside the graph section', () => {
    const withStrayRow = `# D\n\n| I09 | 9 | stray | none | x |\n\n${base}`;
    const parsed = parseIncrementGraph(withStrayRow);
    assert.equal(parsed.valid, true);
    assert.deepEqual(parsed.increments.map(row => row.id), ['I01', 'I02']);
  });

  it('reports duplicate ids', () => {
    const duplicated = base.replace('| I02 | 2 | two | I01 | b |', '| I01 | 2 | two | I01 | b |');
    const parsed = parseIncrementGraph(duplicated);
    assert.equal(parsed.valid, false);
    assert.ok(parsed.diagnostics.some(d => d.code === 'duplicate-id'));
  });

  it('reports non-sequential ids and priority order problems', () => {
    const gap = base.replace('| I02 | 2 | two | I01 | b |', '| I05 | 2 | two | I01 | b |');
    assert.ok(parseIncrementGraph(gap).diagnostics.some(d => d.code === 'invalid-id-sequence'));
    const priority = base.replace('| I01 | 1 | one | none | a |', '| I01 | 3 | one | none | a |');
    assert.ok(parseIncrementGraph(priority).diagnostics.some(d => d.code === 'invalid-priority-order'));
    const collision = base.replace('| I02 | 2 | two | I01 | b |', '| I02 | 1 | two | I01 | b |');
    assert.ok(parseIncrementGraph(collision).diagnostics.some(d => d.code === 'invalid-priority-order'));
  });

  it('rejects cycles and missing prerequisites', () => {
    const cycle = base.replace('I01 | 1 | one | none', 'I01 | 1 | one | I02');
    const parsed = parseIncrementGraph(cycle);
    assert.ok(parsed.diagnostics.some(d => d.code === 'cycle'));
    const missing = base.replace('| I02 | 2 | two | I01 | b |', '| I02 | 2 | two | I09 | b |');
    assert.ok(parseIncrementGraph(missing).diagnostics.some(d => d.code === 'missing-prerequisite'));
  });

  it('reports missing increments for a section without rows', () => {
    const parsed = parseIncrementGraph(base.replace(/^\| I\d{2}.*$/gm, ''));
    assert.ok(parsed.diagnostics.some(d => d.code === 'missing-increments'));
  });

  it('stays aligned with the design lint over the same document', () => {
    const populatedMirror = `${base}\n${designExtras(['I01', 'I02'])}\n## Execution Status\n| I01 | complete | - |\n| I02 | ready | implement I02 |\n`;
    assert.equal(lintDesign(populatedMirror).valid, true);
    assert.ok(lintDesign(populatedMirror.replace('| I02 | 2 | two | I01 | b |', '| I05 | 2 | two | I01 | b |'))
      .diagnostics.some(d => d.code === 'invalid-id-sequence'));
  });
});

describe('incrementGraphSection fences', () => {
  it('ignores fenced headings at both boundaries', () => {
    const source = '```\n## Increment Dependency Graph\n```\n## Increment Dependency Graph\nrow\n```\n## Example\n```\nrow2\n## Next\ntail';
    assert.deepEqual(incrementGraphSection(source), ['row', '```', '## Example', '```', 'row2']);
  });
});
