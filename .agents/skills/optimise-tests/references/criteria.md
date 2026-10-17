# Writer Criteria

Rules for one unit writer optimising one packet of tests. Your packet lists files, line counts, durations, slowest tests, and candidate duplicates or merge clusters (`candidates.duplicateTitles`, `candidates.sharedImports`, `candidates.mergeClusters`). Candidates are leads, not verdicts: inspect tests before acting.

The canonical test quality bar lives in `skills/dispatch/references/templates/quality-bar.md`; comment and `// SECTION:` conventions live in `AGENTS.md` § Code Comments. Apply them as the target shape.

## Scope

- Edit only the files listed in your packet. In split units, create no new files; record new-file splits as ledger `move` lines.
- Record changes needed outside your packet (helpers, fixtures, other units) in the ledger for the lead to apply.
- Preserve baseline failures unless pruning the failing low-signal test itself.

## Actions

Read your packet's `failures` first: those tests failed at baseline.

Classify every test in your files. Check `escalate` first: it overrides every other row, so an uncertain contract test is never pruned. Otherwise take the first matching row; unlisted tests are `keep`.

| Action | When | Ledger |
|---|---|---|
| `escalate` | The test may be the only evidence of a documented contract and you cannot verify whether it still holds. Leave the test and return a blocker naming it. | required; `reason` |
| `delete` | The test is low-signal (below), or a stronger test asserts the same behavior. | required; `coveredBy` or `reason` |
| `merge` | Multiple tests assert one behavior with different inputs; fold them into one table-driven test. | required; `coveredBy` (the merged test) or `reason` |
| `split` | One test asserts several unrelated behaviors; give each its own named test. | required; `reason` |
| `rename` | The name describes mechanics rather than the asserted behavior. | required; `reason` |
| `speed` | The test breaks a speed rule (below); rewrite it to preserve the assertion. | required; `reason` |
| `section` | A file mixes behaviors without grouping; add `// SECTION:` headers or `describe` blocks. | optional |
| `move` | The test belongs in another folder (e.g. a subprocess flow outside `tests/e2e/`). Propose only; leave the test in place. | required; `moveTo`, `reason` |
| `keep` | The test meets the quality bar and speed rules. | none |

## Low-signal tests

A test is low-signal when it violates the quality bar in `skills/dispatch/references/templates/quality-bar.md`.

Pruning low-signal tests may drop covered lines only when the production file retains active coverage (`after.covered > 0`) and the ledger justifies the drop:
1. `target: "<production/path>"` identifies the production file losing coverage;
2. `reason` uses a recognized prefix (`low-signal: <category>`), or `coveredBy: "<test>"` names the covering test.

Unjustified drops or drops reducing any production file to zero coverage fail the gate.

## Speed rules

- Replace real sleeps and timeouts with injected clocks, resolved promises, or event waits.
- Build expensive setup (temp repos, parsed fixtures) once per `describe` block with `before`/`after` when tests only read it.
- Use in-process calls instead of subprocesses outside `tests/e2e/`; propose a `move` for tests requiring real subprocesses or Git flows.
- Keep every non-e2e file under `FILE_BUDGET_MS` in `scripts/test-reporter.ts`; split a file that cannot meet it.

## Ledger

Append one JSON object per line to `<work>/ledger/<id>.jsonl`:

```json
{"action":"delete","file":"tests/unit/policy/x.test.ts","test":"reads default limit","reason":"low-signal: config-literal"}
{"action":"merge","file":"tests/unit/policy/x.test.ts","test":"rejects empty id","coveredBy":"rejects invalid ids"}
{"action":"delete","file":"tests/unit/policy/x.test.ts","test":"handles null config","target":"skills/dispatch/scripts/policy/x.ts","reason":"low-signal: defensive-boilerplate"}
{"action":"move","file":"tests/unit/core/run.test.ts","test":"spawns the driver","reason":"real subprocess","moveTo":"tests/e2e/run.test.ts"}
```

Fields:
- `action`: table action other than `keep`.
- `file`: test file path.
- `test`: exact test name, or `*` for file-level action.
- `target`: production file path losing coverage (required when justifying coverage drops).
- `reason`: justification text (`low-signal: <category>` required for coverage drops without `coveredBy`).
- `coveredBy`: covering test (`test` or `file > test`).
- `moveTo`: destination test file path (required for `move`).

**Completion criterion:** Every test in your packet is classified; every non-`keep` action has a valid ledger entry; and the focused verification command passes over your files.
