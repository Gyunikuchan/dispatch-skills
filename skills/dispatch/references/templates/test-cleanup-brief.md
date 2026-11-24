# Test cleanup brief

Work only in `{{integrationPath}}`. Edit only test files (tests, fixtures, helpers). Change no production code, docs or plan artifacts. Run no dispatch toolkit.

## Objective

Prune low-value, over-tiered, and stale tests under the retention gates below.

## Scope

1. Run `git diff <base>..HEAD` and `git diff --name-only <base>..HEAD` in `{{integrationPath}}` with base `{{base}}`.
2. Sweep diff-touched test files, overlapping pre-existing tests in them, and untouched test files covering changed symbols or modified spec requirements to delete or update stale tests; leave unrelated tests untouched.
3. Read the bound plan `{{planPath}}` whole. Map each deleted, merged, or downgraded test to criterion IDs through `Tests:` and `Check:`.

## Rules

- Apply the embedded quality bar below (executing `- Prune:` and ignoring `- Writer focus`) to each in-scope test.
- Downgrade an over-tiered test to a cheaper layer only when every retained criterion's `Check:` still runs at least one test after edits and every replacement test path is already executed by an existing non-removed automated criterion `Check:` or deduplicated `contract` command; otherwise (including any `Check:`-pinned downgrade leaving a `Check:` running none) keep the existing test intact and flag the proposed downgrade under concerns.
- A merge or rename keeps every name a retained criterion `Check` selects.
- After edits, run only the test files you edited. Fix a test you broke; revert an unjustified deletion.
- Keep production code read-only; flag any needed production change or test-only production helper under concerns.

## Quality

{{quality}}

## Report

Report status `DONE`, `BLOCKED` or `NEEDS_CONTEXT`; one-line summary; changed files; swept symbols and requirements; commands run with results; concerns.

End the report with one fenced `json` block and nothing after it:

```json
{"removed": ["SC1"], "deleted": 0, "merged": 0}
```

- `removed`: criterion IDs whose Check commands no longer run any test after edits, excluding any criterion whose test was replaced by a cheaper test. Use `[]` when none.
- `deleted`: count of tests you deleted. `merged`: count of tests you merged into another test. Use non-negative integers.
