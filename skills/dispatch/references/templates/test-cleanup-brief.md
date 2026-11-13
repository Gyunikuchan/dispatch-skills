# Test cleanup brief

Work only in `{{integrationPath}}`. Edit only test files (tests, fixtures, helpers). Change no production code, docs or plan artifacts. Run no dispatch toolkit. Follow applicable host rules; a stricter one wins.

## Objective

Reduce test growth from this run. Delete, merge or rewrite lower-value tests so the suite keeps only protection that the retention gates below require.

## Scope

1. Run `git diff <base>..HEAD` and `git diff --name-only <base>..HEAD` in `{{integrationPath}}` with base `{{base}}`. Read-only Git only.
2. Clean up tests this run added or changed and overlapping pre-existing tests in those files; leave other tests untouched.
3. Read the bound plan `{{planPath}}` whole. Map each test you delete or merge to criterion IDs through the `Tests:` and `Check:` fields of the plan criteria.

## Rules

- Apply the embedded quality bar below (executing `- Prune:` and ignoring `- Writer focus`) to each in-scope test.
- A merge or rename keeps every name a criterion `Check` selects.
- After edits, run only the test files you edited. Fix a test you broke; revert a deletion that you cannot justify.
- Report a needed production change as a concern; do not make it.

## Quality

{{quality}}

## Report

Report status `DONE`, `BLOCKED` or `NEEDS_CONTEXT`; one-line summary; changed files; commands run with results; concerns.

End the report with one fenced `json` block and nothing after it:

```json
{"removed": ["SC1"], "deleted": 0, "merged": 0}
```

- `removed`: criterion IDs whose Check commands no longer run any test after your edits. Use `[]` when none.
- `deleted`: count of tests you deleted. `merged`: count of tests you merged into another test. Use non-negative integers.
