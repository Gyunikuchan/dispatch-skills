import assert from 'node:assert/strict';
import { test } from 'node:test';

import { governedDesignText, parseDesign } from '../../../skills/dispatch/scripts/domain/design.ts';

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

test('design: graph lint catches cycles, unknown prerequisites, and a wrong Increments count', () => {
  assert.ok(codes(DESIGN.replace('| I01 | 1 | Parser | none |', '| I01 | 1 | Parser | I02 |')).includes('cycle'));
  assert.ok(codes(DESIGN.replace('| I02 | 2 | Loader | I01 |', '| I02 | 2 | Loader | I07 |')).includes('missing-prerequisite'));
  assert.ok(codes(DESIGN.replace('> **Increments:** 2', '> **Increments:** 3')).includes('summary-label'));
});

test('design: details and Execution Status lint', () => {
  assert.ok(codes(DESIGN.replace('- Rollback boundary: revert I02\n', '')).includes('missing-increment-field'));
  assert.ok(codes(DESIGN.replace('| I02 | ready |', '| I02 | pending |')).includes('execution-status'));
  assert.ok(codes(DESIGN.replace('## Final Integration\n', '## Finale\n')).includes('missing-section'));
});

test('design: governed text excludes Execution Status and the resolution section', () => {
  const governed = governedDesignText(DESIGN);
  assert.ok(!governed.includes('## Execution Status'));
  assert.ok(!governed.includes('implement:I02'));
  assert.ok(!governed.includes('## Review Findings & Resolutions'));
  assert.ok(governed.includes('## Final Integration'));
});

test('design: Execution Status needs a Next Action and unique rows', () => {
  assert.ok(codes(DESIGN.replace('Next Action: implement:I02\n', '')).includes('execution-status'));
  assert.ok(codes(DESIGN.replace('| I02 | ready | next | implement:I02 |', '| I02 | ready | next | implement:I02 |\n| I02 | ready | again | implement:I02 |')).includes('execution-status'));
});
