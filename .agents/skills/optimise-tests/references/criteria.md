# Writer Criteria

Rules for one unit writer optimising one packet. The packet lists files, line counts, durations, slow tests, and duplicate or merge candidates. Candidates are leads; inspect the tests before changing them.

The canonical behavioral test bar lives in the [code section of the quality bar](../../../../skills/dispatch/references/templates/quality-bar.md#code). Apply it to new, changed, and retained tests. Use `AGENTS.md` § Code Comments for comment and `// SECTION:` conventions.

## Scope

- Edit only packet files. In split units, create no files; propose any required move or split in the ledger.
- Report helper, fixture, and cross-unit requests to the lead in the completion response; do not add unsupported ledger record kinds.
- Preserve every baseline failure. Leave a failing test unchanged and report any proposed action on it as a blocker for lead review.

## Evidence records

Classify every baseline test with an action record or a positive retained-scenario record. Do not default an unlisted test to keep. Related tests may share one retained scenario when they exercise the same consumer behavior; name each reference and explain the scenario's distinct contribution. Give a separate record to another boundary or failure mode.

Append one JSON object per line to `<work>/ledger/<id>.jsonl`. The gate accepts only `action`, `retain`, and `savings` record kinds. Writers own action and retain records. The lead owns optional savings reports after the full after snapshot. Unknown kinds, unresolved escalation records, malformed JSON, and unsupported fields fail the gate.

Each test reference uses the repo-relative file path and exact reported test name. Add `line` only when that file/name occurs more than once in the named inventory; then use its inventory line. Normalize path separators. `before` references resolve in the before inventory, and `after` references resolve in the full after inventory. Use separate references because line numbers can change between snapshots.

An action record has this shape:

```jsonl
{"kind":"action","id":"A1","action":"rewrite","before":[{"file":"tests/unit/transfer.test.ts","name":"rejects a duplicate transfer"}],"after":[{"file":"tests/unit/transfer.test.ts","name":"rejects replay without changing the balance"}],"reason":"Replace the self-derived assertion with the replay error and unchanged balance checks."}
{"kind":"retain","contract":"The transfer consumer rejects a repeated transaction without debiting the balance twice.","plausibleDefect":"A replay debits the account twice and corrupts its balance.","observableOutcome":"The caller receives the replay error and the account balance stays unchanged.","distinctContribution":"Covers durable replay protection after commit; static types cannot guarantee runtime transaction uniqueness.","before":[{"file":"tests/unit/transfer.test.ts","name":"rejects a duplicate transfer"}],"after":[{"file":"tests/unit/transfer.test.ts","name":"rejects replay without changing the balance"}]}
```

`action` is one of `delete`, `merge`, `add`, `rewrite`, `move`, or `split`. IDs are unique. Every record has `before`, `after`, and a nonblank `reason`; arrays may be empty only where the action allows it. `delete` and `merge` also require one `category` from this closed set: `redundant-behavior`, `implementation-coupled-assertion`, `self-derived-assertion`, `synthetic/no-required-contract`, `trivial-spec`, `coverage-padding`, or `transient-leak`. No other category is valid.

- `delete` needs at least one before reference. A `redundant-behavior` deletion also names one or more surviving tests in `after` and explains the same-defect coverage. A hollow deletion may have an empty `after`; its reason must name the missing required contract.
- `merge` needs before and surviving after references. Its `before` list contains only absorbed tests; exclude tests that survive unchanged. Explain why the survivors detect the same defect.
- `add` has no before references and at least one after reference. `rewrite`, `move`, and `split` map at least one before reference to at least one after reference.
- Every action's surviving after reference also needs a retained-scenario record. New after tests need an `add` or mapping action. A renamed or moved retained test needs an explicit mapping action.

A retained-scenario record has this shape:

```json
{"kind":"retain","contract":"The transfer consumer rejects a repeated transaction without debiting the balance twice.","plausibleDefect":"A replay debits the account twice and corrupts its balance.","observableOutcome":"The caller receives the replay error and the account balance stays unchanged.","distinctContribution":"Covers durable replay protection after commit; static types cannot guarantee runtime transaction uniqueness.","before":[{"file":"tests/unit/transfer.test.ts","name":"rejects a duplicate transfer"}],"after":[{"file":"tests/unit/transfer.test.ts","name":"rejects a duplicate transfer"}]}
```

All four explanations are required and nonblank. `after` must name at least one surviving test. Every baseline test must occur in an action or retained scenario, and every after test must occur in a retained scenario. A deleted or merged before test cannot also be retained. Keep each retained record positive: name the consumer contract, plausible severe failure, observable result, distinct contribution and why static checks do not already guarantee it. The lead judges these explanations; the gate validates their presence and mappings.

Related tests may share one retained-scenario record only when they exercise the same consumer behavior. Name every identity and explain each contribution. For example, a transfer replay after restart checks persisted deduplication; a concurrent replay checks atomicity. Both protect account balances, but each detects a distinct state-corruption defect that static types do not guarantee against.

These two records show a hollow deletion without a replacement, followed by a duplicate deletion whose survivor is retained:

```jsonl
{"kind":"action","id":"A2","action":"delete","before":[{"file":"tests/unit/config.test.ts","name":"returns the config it just built"}],"after":[],"reason":"The assertion compares the result with the same constructed value and protects no required behavior.","category":"self-derived-assertion"}
{"kind":"action","id":"A3","action":"delete","before":[{"file":"tests/unit/transfer.test.ts","name":"rejects replay before restart"}],"after":[{"file":"tests/unit/transfer.test.ts","name":"rejects transfer replay"}],"reason":"The survivor detects the same double-debit defect before and after restart.","category":"redundant-behavior"}
{"kind":"retain","contract":"The transfer consumer rejects replay without a second debit.","plausibleDefect":"A replay corrupts the balance with a second debit.","observableOutcome":"The caller receives the replay error and the balance stays unchanged.","distinctContribution":"Checks persisted deduplication across restart, which static types do not guarantee.","before":[{"file":"tests/unit/transfer.test.ts","name":"rejects transfer replay"}],"after":[{"file":"tests/unit/transfer.test.ts","name":"rejects transfer replay"}]}
```

The names in examples must resolve in the inventories for a real run. These records illustrate field use; the full ledger must classify every baseline and after test without contradictory outcomes. A `move` record proposes before and intended after references, but the lead applies the move and confirms its destination in the final inventory. If a required contract is uncertain, leave the test unchanged and report a blocker outside the ledger; resolve it before a successful gate run. Do not invent an `escalate` record.

## Deletion and retention judgment

Use `trivial-spec` for mechanical contracts without plausible severe failure, `coverage-padding` for checks whose purpose is line or branch execution, and `transient-leak` for intermediate scaffolding left in the delivered suite. Coverage percentages never justify durable retention or gate deletion. Review the actual consumer behavior before using these categories.

## Proof and savings

Inspection is the default proof. Use targeted temporary fault injection only when it resolves uncertainty about whether a retained test distinguishes the intended defect.

The comparison report measures reported leaf-test counts and suite wall-clock duration. Ledger claims are separate: the optional single `savings` record may report `scenariosRemoved`, `casesRemoved`, `cosmeticTableMerges`, and `repeatedSetupCallsReduced`, with concrete `evidence`. Each count is a nonnegative integer. The report labels these values as ledger-reported, not inventory-measured; omitted values remain unmeasured. Count removed cases or reduced setup only when the evidence supports those changes. A table merge that retains every case is cosmetic and is not removed work.

## Timing rules

- Replace real sleeps and timeouts with injected clocks, resolved promises, or event waits.
- Build expensive setup once per `describe` block with `before`/`after` when tests only read it.
- Use in-process calls instead of subprocesses outside `tests/e2e/`; propose a `move` for tests that need real subprocesses or Git flows.
- Keep every non-e2e file under `FILE_BUDGET_MS` in `scripts/test-reporter.ts`; split a file that cannot meet it.

**Completion criterion:** Every baseline test in the packet has valid action or retain evidence; every after test has a retained-scenario record; mappings and deletion claims resolve against the correct snapshots; and the focused verification command passes over the packet files. Return unresolved intent or out-of-scope requests as blockers for the lead.
