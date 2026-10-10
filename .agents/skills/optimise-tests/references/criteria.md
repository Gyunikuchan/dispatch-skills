# Writer Criteria

Rules for one unit writer optimising one packet. The packet lists your files, their line counts and durations, the slowest tests, and candidate duplicates (`candidates.duplicateTitles`, `candidates.sharedImports`). Candidates are leads, not verdicts: read both tests before acting.

Repository test conventions (one behavior per test named for it, test each layer through its public entrypoint, real Git/subprocess flows only in `tests/e2e/`) live in `.claude/CLAUDE.md` § Verification Details; comment and `// SECTION:` conventions live in § Code Comments. Apply them as the target shape of every file you touch.

## Scope

- Edit only the files listed in your packet; add new test files in the unit folder only when your brief allows it (single-packet units); in a split unit, create no files and record each new-file split as a ledger `move` line.
- Record a change you need elsewhere (another folder, `tests/helpers/`, any fixture folder) as a ledger line; the lead applies it.
- Keep failing baseline tests unchanged unless the ledger shows the failure is the low-signal behavior you remove.

## Actions

Read your packet's `failures` first: those tests failed at baseline (see Scope).

Classify every test in your files. Check `escalate` first: it overrides every other row, so an uncertain contract test is never pruned. Otherwise take the first row that matches; a test with no match is `keep`.

| Action | When | Ledger |
|---|---|---|
| `escalate` | The test may be the only evidence of a documented contract and you cannot tell whether that contract still holds. Leave it and return a blocker naming it. | required; `reason` |
| `delete` | The test is low-signal (below), or a stronger test asserts the same behavior. | required; `coveredBy` or `reason` |
| `merge` | Several tests assert one behavior with different inputs; fold them into one table-driven test. | required; `coveredBy` (the merged test) or `reason` |
| `split` | One test asserts several unrelated behaviors; give each its own named test. | required |
| `rename` | The name describes mechanics, not the behavior asserted. | required |
| `speed` | The test breaks a speed rule (below); rewrite it to the same assertion. | required |
| `section` | A file mixes behaviors without grouping; add `// SECTION:` headers or `describe` blocks. | optional |
| `move` | The test belongs in another folder (a subprocess flow outside `tests/e2e/`, a test of another layer). Propose only; leave the test in place. | required; `moveTo` |
| `keep` | None of the above. | none |

## Low-signal tests

A test is low-signal when it:

- asserts implementation detail: private helpers, call order, internal state, or exact log wording that no contract fixes;
- duplicates a stronger test: another test asserts the same behavior through the same or a higher entrypoint;
- tests a constant or the framework: it re-reads a literal, a config default, or Node/`node:test` behavior;
- is a tautological mock: it asserts that a stub returns what the test told it to return.

A test that is the only coverage of a production line is never low-signal by duplication; the lead's coverage gate fails on the drop.

## Speed rules

- Replace real sleeps and timeouts with injected clocks, resolved promises or event waits.
- Build expensive setup (temp repos, parsed fixtures) once per `describe` with `before`/`after`, when the tests only read it.
- Use in-process calls instead of subprocesses outside `tests/e2e/`; propose a `move` for a test that needs a real subprocess or Git flow.
- Keep every non-e2e file under the per-file budget `FILE_BUDGET_MS` in `scripts/test-reporter.ts`; split a file that cannot meet it.

## Ledger

Append one JSON object per line to the ledger path in your brief:

```json
{"action":"delete","file":"tests/unit/policy/x.test.ts","test":"reads the default limit","reason":"asserts a config literal"}
{"action":"merge","file":"tests/unit/policy/x.test.ts","test":"rejects empty id","coveredBy":"rejects invalid ids"}
{"action":"move","file":"tests/unit/core/run.test.ts","test":"spawns the driver","reason":"real subprocess","moveTo":"tests/e2e/run.test.ts"}
```

Fields: `action` (a table action other than `keep`), `file`, `test` (the exact test name, or `*` for a file-level action), `reason`, `coveredBy?` (the test name, or `file > test` when in another file), `moveTo?` (required for `move`). A `delete` or `merge` line without `coveredBy` or `reason` is rejected and its change reverted.

**Done when:** every test in your packet is classified, every non-`keep` action has its ledger line, and the focused verify command from your brief passes over your files.
