# Test cleanup brief

Work only in `{{integrationPath}}`. Edit only test files (tests, fixtures, helpers); leave production code (zero temporary production mutations), docs, and plan artifacts read-only. Run no dispatch toolkit.

## Objective

Prune stale, redundant, and over-tiered tests under the rules below.

## Scope

1. Run `git diff <base>..HEAD` and `git diff --name-only <base>..HEAD` in `{{integrationPath}}` (base `{{base}}`).
2. Sweep diff-touched test files, overlapping tests, and untouched test files for changed symbols or modified spec requirements to delete or update stale tests; keep unrelated tests untouched.
3. Read `{{planPath}}` whole; map deleted, merged, or downgraded tests to criteria via `Tests:` and `Check:`.

## Rules

- Apply `## Quality` below (executing `- Prune:` and ignoring `- Writer focus`) to in-scope tests.
- Before a coverage-preserving deletion or downgrade, cite the exact surviving test path and contract oracle (cite the prune reason instead only for `- Prune:` `the past`/`nothing` prunes with no surviving coverage); downgrade an over-tiered test only when every retained criterion's `Check:` still runs at least one test and every replacement test path is already executed by an existing non-removed `Check:` or `contract` command. Keep uncited or uncertain tests intact and flag them (including `Check:`-pinned downgrades leaving a `Check:` empty) under concerns.
- Merges/renames keep every name a retained criterion `Check` selects.
- Run only edited test files after edits; fix tests you broke and revert unjustified deletions.
- Flag needed production fixes, test-only production helpers, or apparent pre-existing defects under concerns without silently altering production or expected test behavior.

## Quality

{{quality}}

## Report

Report status `DONE`, `BLOCKED` or `NEEDS_CONTEXT`; one-line summary; changed files (cite coverage-preserving edits as `<removed/downgraded test> -> <surviving test path>: <contract oracle>`, and no-coverage `the past`/`nothing` prunes as `<removed test> -> <prune reason>`); swept symbols and requirements; commands and results; concerns.

End with one fenced `json` block and nothing after:

```json
{"removed": ["SC1"], "deleted": 0, "merged": 0}
```

- `removed`: criterion IDs whose Check runs no test after edits, excluding tests replaced by a cheaper test (`[]` if none).
- `deleted`/`merged`: non-negative integer counts.
