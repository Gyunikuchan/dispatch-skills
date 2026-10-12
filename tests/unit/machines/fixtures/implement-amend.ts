import assert from 'node:assert/strict';
import { parsePlan } from '../../../../skills/dispatch/scripts/domain/plan.ts';
import type { ParsedPlan } from '../../../../skills/dispatch/scripts/domain/types.ts';

// SECTION: Parseable plan — AMEND edits governed text, so amendment fixtures need a plan that round-trips through parsePlan.

const criterion = (n: number, files: string) => `- [SC${n}] Part ${n} works
  - Changes: ${files}
  - Verify: \`node --test tests/sc${n}.test.ts\`
  - Evidence: verify
  - Test rationale: pins part ${n}.
`;

/** Three independent tasks: T1 owns src/a.ts and its test, T2 src/b.ts, T3 src/c.ts. */
export const AMEND_TEXT = `# Parts

> **TL;DR:** deliver three parts.
> **Parent:** user request
> **Decide:** none
> **Risk:** low — isolated
> **Scope:** src

## Key Decisions & Context
- Three parts (user)

## Success Criteria
${criterion(1, 'src/a.ts, tests/sc1.test.ts')}${criterion(2, 'src/b.ts')}${criterion(3, 'src/c.ts')}
## Proposed Changes
### T1 — Part one
Deliver part one.
- Prerequisites: none
- Criteria: SC1

#### [MODIFY] src/a.ts
- Changes: part one.
#### [NEW] tests/sc1.test.ts
- Purpose: pins part one.

### T2 — Part two
Deliver part two.
- Prerequisites: none
- Criteria: SC2

#### [MODIFY] src/b.ts
- Changes: part two.

### T3 — Part three
Deliver part three.
- Prerequisites: none
- Criteria: SC3

#### [MODIFY] src/c.ts
- Changes: part three.

## Verification Plan
### Automated Tests
- None: criterion commands cover the change.
### Manual Verification
- None.

## Review Findings & Resolutions
*No reviews conducted yet.*
`;

export function parsed(text: string): ParsedPlan {
  const result = parsePlan(text);
  assert.ok(result.ok, JSON.stringify(result));
  return result.plan;
}

export const AMEND_PLAN = parsed(AMEND_TEXT);
