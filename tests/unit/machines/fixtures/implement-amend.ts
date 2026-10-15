import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parsePlan } from '../../../../skills/dispatch/scripts/domain/plan.ts';
import type { ParsedPlan } from '../../../../skills/dispatch/scripts/domain/types.ts';

// SECTION: Parseable plan — AMEND edits governed text, so amendment fixtures need a plan that round-trips through parsePlan.

const criterion = (n: number, files: string) => `- [SC${n}] Part ${n} works
  - Changes: ${files}
  - Verify: \`node --test tests/part-${n}.test.ts\`
  - Evidence: verify
  - Test rationale: pins part ${n}.
${/tests\//.test(files) ? '  - Retain: durable\n' : ''}`;

/** Three independent tasks: T1 owns src/a.ts and its test, T2 src/b.ts, T3 src/c.ts. */
export const AMEND_TEXT = `# Parts

> **TL;DR:** deliver three parts.
> **Parent:** user request
> **Decide:** none
> **Risk:** low — isolated
> **Scope:** src

## Key Decisions & Context
- Three parts (user)

## Task Map
| ID | Title | Outcome | Prerequisites | Criteria |
| --- | --- | --- | --- | --- |
| T1 | Part one | Deliver part one. | none | SC1 |
| T2 | Part two | Deliver part two. | none | SC2 |
| T3 | Part three | Deliver part three. | none | SC3 |

## Proposed Changes
### T1 — Part one
- Constraints: Preserve the stable API.

#### [MODIFY] src/a.ts
- Changes: part one.
#### [NEW] tests/part-1.test.ts
- Purpose: pins part one.

### T2 — Part two
#### [MODIFY] src/b.ts
- Changes: part two.

### T3 — Part three
#### [MODIFY] src/c.ts
- Changes: part three.

## Success Criteria
${criterion(1, 'src/a.ts, tests/part-1.test.ts')}${criterion(2, 'src/b.ts')}${criterion(3, 'src/c.ts')}
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

// SECTION: Replacement plans — a REPLACE_PLAN file is the amended text, parsed with its governed hash.

export const governedHash = (plan: ParsedPlan): string => `sha256:${createHash('sha256').update(plan.governedText).digest('hex')}`;

/** Applies exact `[current, proposed]` text swaps to AMEND_TEXT and parses the result. */
export function replacementText(...swaps: readonly (readonly [string, string])[]): { text: string; plan: ParsedPlan; hash: string } {
  let text = AMEND_TEXT;
  for (const [current, proposed] of swaps) {
    assert.equal(text.split(current).length, 2, `swap source must occur once: ${current}`);
    text = text.replace(current, proposed);
  }
  const plan = parsed(text);
  return { text, plan, hash: governedHash(plan) };
}

export const T2_SECTION = '### T2 — Part two\n#### [MODIFY] src/b.ts\n- Changes: part two.\n\n';
export const SC2_SECTION = '- [SC2] Part 2 works\n  - Changes: src/b.ts\n  - Verify: `node --test tests/part-2.test.ts`\n  - Evidence: verify\n  - Test rationale: pins part 2.\n';
