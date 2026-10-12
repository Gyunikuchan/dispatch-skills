import assert from 'node:assert/strict';
import { test } from 'node:test';

import { asParsedDesign, designScopeGrew, governedDesignText, parseDesign } from '../../../skills/dispatch/scripts/domain/design.ts';

import { design } from '../machines/fixtures/design.ts';

const detail = (id: string) => `### ${id} Step
- Outcome: ${id} outcome delivered
- Scope: src/${id}.ts
- Non-scope: other modules
- Observable behavior: ${id} observable
- Affected contracts: ${id} contract
- Validation: node --test ${id}
- Rollback boundary: revert ${id}
- Parallel safety: unsafe beside others
`;

const DESIGN = `# Importer design

> **TL;DR:** stage the importer.
> **Parent:** user request
> **Decide:** none
> **Risk:** med — touches ingestion
> **Increments:** 2

## Context & Intent
Why.

## Goals & Requirements
What.

## Architecture & Boundaries
How.

## Alternatives & Decisions
Chosen.

## Risks, Security & Operations
Risks.

## Increment Dependency Graph
| ID | Priority | Summary | Prerequisites | Paths |
| --- | --- | --- | --- | --- |
| I01 | 1 | Parser | none | src/parse.ts |
| I02 | 2 | Loader | I01 | src/load.ts, src/db.ts |

## Increment Details
${detail('I01')}
${detail('I02')}
## Final Integration
Run everything.

## Execution Status
| ID | State | Summary | Next Action |
| --- | --- | --- | --- |
| I01 | completed | done | - |
| I02 | ready | next | implement:I02 |

Next Action: implement:I02

## Review Findings & Resolutions
*No reviews conducted yet.*
`;

const codes = (source: string) => {
  const result = parseDesign(source);
  return result.ok ? [] : result.defects.map((item) => item.code);
};

test('design: parses graph, details, and Execution Status', () => {
  const result = parseDesign(DESIGN);
  assert.ok(result.ok, JSON.stringify(result));
  const { design } = result;
  assert.deepEqual(design.increments.map((row) => [row.id, row.priority, row.prerequisites]), [['I01', 1, []], ['I02', 2, ['I01']]]);
  assert.deepEqual(design.increments[1]?.paths, ['src/load.ts', 'src/db.ts']);
  assert.equal(design.details['I02']?.['Outcome'], 'I02 outcome delivered');
  assert.deepEqual(design.executionStatus?.rows.map((row) => [row.id, row.state]), [['I01', 'complete'], ['I02', 'ready']]);
  assert.equal(design.executionStatus?.nextAction, 'implement:I02');
});

test('design: graph cycles are rejected', () => {
  assert.ok(codes(DESIGN.replace('| I01 | 1 | Parser | none |', '| I01 | 1 | Parser | I02 |')).includes('cycle'));
});

test('design: unknown increment prerequisites are rejected', () => {
  assert.ok(codes(DESIGN.replace('| I02 | 2 | Loader | I01 |', '| I02 | 2 | Loader | I07 |')).includes('missing-prerequisite'));
});

test('design: summary increment count must match the graph', () => {
  assert.ok(codes(DESIGN.replace('> **Increments:** 2', '> **Increments:** 3')).includes('summary-label'));
});

test('design: increment details require a rollback boundary', () => {
  assert.ok(codes(DESIGN.replace('- Rollback boundary: revert I02\n', '')).includes('missing-increment-field'));
});

test('design: unknown execution states are rejected', () => {
  assert.ok(codes(DESIGN.replace('| I02 | ready |', '| I02 | pending |')).includes('execution-status'));
});

test('design: final integration section is required', () => {
  assert.ok(codes(DESIGN.replace('## Final Integration\n', '## Finale\n')).includes('missing-section'));
});

test('design: governed text excludes Execution Status and the resolution section', () => {
  const governed = governedDesignText(DESIGN);
  assert.ok(!governed.includes('## Execution Status'));
  assert.ok(!governed.includes('implement:I02'));
  assert.ok(!governed.includes('## Review Findings & Resolutions'));
  assert.ok(governed.includes('## Final Integration'));
});

test('design: Execution Status requires a Next Action', () => {
  assert.ok(codes(DESIGN.replace('Next Action: implement:I02\n', '')).includes('execution-status'));
});

test('design: Execution Status rejects duplicate increment rows', () => {
  assert.ok(codes(DESIGN.replace('| I02 | ready | next | implement:I02 |', '| I02 | ready | next | implement:I02 |\n| I02 | ready | again | implement:I02 |')).includes('execution-status'));
});

test('journal design admission rejects malformed objectives and dependency graphs', () => {
  assert.ok(asParsedDesign(design));
  const rows = design.increments;
  const invalid = [
    { ...design, box: {} }, { ...design, box: { 'TL;DR': ' ' } },
    { ...design, increments: [{ ...rows[0]!, paths: [] }, rows[1]!] },
    { ...design, increments: [rows[0]!, { ...rows[1]!, id: 'I01' }] },
    { ...design, increments: [rows[0]!, { ...rows[1]!, priority: 1 }] },
    { ...design, increments: [{ ...rows[0]!, prerequisites: ['I99'] }, rows[1]!] },
    { ...design, increments: [{ ...rows[0]!, prerequisites: ['I02'] }, rows[1]!] },
    { ...design, increments: [rows[1]!] },
  ];
  for (const payload of invalid) assert.equal(asParsedDesign(payload), null);
});

test('designScopeGrew compares validation case-insensitively', () => {
  const before = {
    ...design,
    details: {
      I01: { Outcome: 'First behavior', validation: 'npm test -- a' },
      I02: { Outcome: 'Second behavior' },
    },
  };
  const sameCased = {
    ...design,
    details: {
      I01: { Outcome: 'First behavior', Validation: 'npm test -- a' },
      I02: { Outcome: 'Second behavior' },
    },
  };
  const changedVal = {
    ...design,
    details: {
      I01: { Outcome: 'First behavior', Validation: 'npm test -- a and b' },
      I02: { Outcome: 'Second behavior' },
    },
  };
  assert.equal(designScopeGrew(before, sameCased), false);
  assert.equal(designScopeGrew(before, changedVal), true);
});
