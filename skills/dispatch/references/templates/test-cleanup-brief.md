# Test cleanup brief

Work only in `{{integrationPath}}`. Edit only test files (tests, fixtures, helpers). Change no production code, docs or plan artifacts. Run no Git write commands (add, stash, commit, checkout, reset, restore); run no dispatch toolkit. Follow applicable host rules; a stricter one wins.

For any delegation already permitted by the assignment, use available host controls to request fresh context without parent conversation history. If unsupported or unverifiable, continue and report the limitation through existing reporting channels. Give each new child a self-contained brief with this launch instruction; preserve required reply schemas.

## Objective

Reduce test growth from this run. Delete, merge or rewrite lower-value tests so the suite keeps only protection that the [retained-test bar](quality-bar.md#code) requires.

## Scope

1. Run `git diff <base>..HEAD` and `git diff --name-only <base>..HEAD` in `{{integrationPath}}` with base `{{base}}`. Read-only Git only.
2. Scope the cleanup to tests this run added or changed, plus pre-existing tests in the same files that overlap them. Leave other tests untouched.
3. Read the bound plan `{{planPath}}` whole. Map each test you delete or merge to criterion IDs through the `Tests:` and `Verify:` fields of the plan criteria.

## Rules

- Judge each in-scope test against the retained-test tier of the [quality bar](quality-bar.md#code). Keep a test that is the executable spec of a current consumer contract that is severe if broken or non-obvious. Delete or merge implementation-tier tests, duplicates and tests of removed contracts. Rewrite a weak test that guards a retained contract.
- When uncertain whether a test protects a required contract, keep it.
- After edits, run only the test files you edited. Fix a test you broke; revert a deletion that you cannot justify.
- Report a needed production change as a concern; do not make it.

## Report

Write a short report: status `DONE`, `BLOCKED` or `NEEDS_CONTEXT`; one-line summary; changed files; commands run with results; concerns.

End the report with one fenced `json` block and nothing after it:

```json
{"removed": ["SC1"], "deleted": 0, "merged": 0}
```

- `removed`: criterion IDs whose Verify commands no longer run any test after your edits. Use `[]` when none.
- `deleted`: count of tests you deleted. `merged`: count of tests you merged into another test. Use non-negative integers.
