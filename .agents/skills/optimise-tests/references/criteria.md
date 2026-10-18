# Writer Criteria

Rules for one unit writer optimising one packet. The packet lists files, line counts, durations, slow tests, and duplicate or merge candidates. Candidates are leads; inspect the tests before changing them.

The canonical behavioral test bar lives in the [code section of the quality bar](../../../../skills/dispatch/references/templates/quality-bar.md#code). Apply it to new, changed, and retained tests. Use `AGENTS.md` § Code Comments for comment and `// SECTION:` conventions.

## Scope

- Edit only packet files. In split units, create no files; propose any required move or split in the ledger.
- Report helper, fixture, and cross-unit requests to the lead in the completion response; do not add unsupported ledger record kinds.
- Preserve every baseline failure. Leave a failing test unchanged and report any proposed action on it as a blocker for lead review.

## Evidence records

Classify every baseline test with an action record or a positive retained-scenario record. Do not default an unlisted test to keep. Related tests may share one retained scenario when they exercise the same consumer behavior; name each reference and explain the scenario's distinct contribution. Give a separate record to another boundary or failure mode.

Append one JSON object per line to `<work>/ledger/<id>.jsonl`. The gate accepts only `action`, `retain`, `coverage`, and `savings` record kinds. Writers own action and retain records. The lead owns coverage dispositions and savings reports after the full after snapshot. Unknown kinds, unresolved escalation records, malformed JSON, and unsupported fields fail the gate.

Each test reference uses the repo-relative file path and exact reported test name. Add `line` only when that file/name occurs more than once in the named inventory; then use its inventory line. Normalize path separators. `before` references resolve in the before inventory, and `after` references resolve in the full after inventory. Use separate references because line numbers can change between snapshots.

An action record has this shape:

```jsonl
{"kind":"action","id":"A1","action":"rewrite","before":[{"file":"tests/unit/labels.test.ts","name":"rejects blank label"}],"after":[{"file":"tests/unit/labels.test.ts","name":"returns validation error for blank label"}],"reason":"Replace the self-derived assertion with the caller-visible error check."}
{"kind":"retain","contract":"A blank label returns the documented validation error.","plausibleDefect":"The guard accepts a whitespace-only label.","observableOutcome":"The caller receives the validation error and stored state is unchanged.","distinctContribution":"Covers the public whitespace boundary.","before":[{"file":"tests/unit/labels.test.ts","name":"rejects blank label"}],"after":[{"file":"tests/unit/labels.test.ts","name":"returns validation error for blank label"}]}
```

`action` is one of `delete`, `merge`, `add`, `rewrite`, `move`, or `split`. IDs are unique. Every record has `before`, `after`, and a nonblank `reason`; arrays may be empty only where the action allows it. `delete` and `merge` also require one `category` from this closed set: `redundant-behavior`, `implementation-coupled-assertion`, `self-derived-assertion`, or `synthetic/no-required-contract`. No other category is valid.

- `delete` needs at least one before reference. A `redundant-behavior` deletion also names one or more surviving tests in `after` and explains the same-defect coverage. A hollow deletion may have an empty `after`; its reason must name the missing required contract.
- `merge` needs before and surviving after references. Its `before` list contains only absorbed tests; exclude tests that survive unchanged. Explain why the survivors detect the same defect.
- `add` has no before references and at least one after reference. `rewrite`, `move`, and `split` map at least one before reference to at least one after reference.
- Every action's surviving after reference also needs a retained-scenario record. New after tests need an `add` or mapping action. A renamed or moved retained test needs an explicit mapping action.

A retained-scenario record has this shape:

```json
{"kind":"retain","contract":"A blank label returns the documented validation error.","plausibleDefect":"The guard accepts a whitespace-only label.","observableOutcome":"The caller receives the validation error and stored state is unchanged.","distinctContribution":"Covers the public whitespace boundary.","before":[{"file":"tests/unit/labels.test.ts","name":"rejects blank label"}],"after":[{"file":"tests/unit/labels.test.ts","name":"rejects blank label"}]}
```

All four explanations are required and nonblank. `after` must name at least one surviving test. Every baseline test must occur in an action or retained scenario, and every after test must occur in a retained scenario. A deleted or merged before test cannot also be retained. Keep each retained record positive by naming its contract, plausible defect, observable result, and distinct contribution.

Related tests may share one retained-scenario record only when they exercise the same consumer behavior. Record each test identity and explain its distinct contribution:

```json
{"kind":"retain","contract":"Missing and explicitly undefined values return the configured default.","plausibleDefect":"The lookup returns undefined instead of the default.","observableOutcome":"The caller receives the configured default.","distinctContribution":"The absent-key case checks lookup misses; the stored-undefined case checks fallback after a successful lookup.","before":[{"file":"tests/unit/config.test.ts","name":"uses default for absent key"},{"file":"tests/unit/config.test.ts","name":"uses default for stored undefined"}],"after":[{"file":"tests/unit/config.test.ts","name":"uses default for absent key"},{"file":"tests/unit/config.test.ts","name":"uses default for stored undefined"}]}
```

These two records show a hollow deletion without a replacement, followed by a duplicate deletion whose survivor is retained:

```jsonl
{"kind":"action","id":"A2","action":"delete","before":[{"file":"tests/unit/config.test.ts","name":"returns the config it just built"}],"after":[],"reason":"The assertion compares the result with the same constructed value and protects no required behavior.","category":"self-derived-assertion"}
{"kind":"action","id":"A3","action":"delete","before":[{"file":"tests/unit/labels.test.ts","name":"rejects empty label"}],"after":[{"file":"tests/unit/labels.test.ts","name":"rejects empty and whitespace labels"}],"reason":"The retained test detects the same invalid-label defect for both inputs.","category":"redundant-behavior"}
{"kind":"retain","contract":"Invalid labels return the public validation error.","plausibleDefect":"Empty or whitespace labels are accepted.","observableOutcome":"The caller receives the validation error.","distinctContribution":"Covers both empty and whitespace inputs at the caller boundary.","before":[{"file":"tests/unit/labels.test.ts","name":"rejects empty and whitespace labels"}],"after":[{"file":"tests/unit/labels.test.ts","name":"rejects empty and whitespace labels"}]}
```

The names in examples must resolve in the inventories for a real run. These records illustrate field use; the full ledger must classify every baseline and after test without contradictory outcomes. A `move` record proposes before and intended after references, but the lead applies the move and confirms its destination in the final inventory. If a required contract is uncertain, leave the test unchanged and report a blocker outside the ledger; resolve it before a successful gate run. Do not invent an `escalate` record.

## Coverage dispositions

The lead owns one `coverage` record for each observed production-file loss. Writers do not authorize file-level coverage losses. The lead first runs `compare.ts` against the complete after inventory, reviews the lost file and relevant action records, and selects only the delete or merge action IDs that contribute to that loss. The first pending report may list all delete/merge IDs as candidates; that default is not a finding that all of them caused the loss.

A disposition uses exactly these fields:

```json
{"kind":"coverage","target":"scripts/labels.ts","before":18,"after":12,"actionIds":["A3"],"review":"The removed test's label-validation path accounts for the six-line loss; the surviving test still checks the same invalid-label contract.","binding":"0000000000000000000000000000000000000000000000000000000000000000"}
```

This proposal uses a syntactically valid all-zero digest so comparison can resolve the selected action IDs and report their expected binding; it fails until that digest matches. `target`, `before`, and `after` must match the measured drop. `actionIds` must name the contributing delete or merge records. `review` must explain the full measured loss. Use the `expected binding` printed by `compare.ts` for the final action IDs and evidence; rerun after narrowing the IDs and copy the newly printed value. The proposal stays pending while `compare.md` lists it under “Coverage drops (pending disposition)”.

The binding is SHA-256 over UTF-8 canonical JSON recomputed from the measured inventories and validated actions. Its projection contains the normalized target and measured before/after counts; the sorted, unique before/after test references named by the selected actions; selected action records sorted by ID, including `id`, `action`, `before`, `after`, `reason`, and `category` when present; and `deletedBefore`, the sorted before references from delete and merge actions. Object keys are sorted lexically. Test references are sorted by normalized file, exact name, and line when the identity is ambiguous in that snapshot. The projection excludes approval, review text, timing, and unrelated inventory data. A change to any projected target, count, identity, or action value changes the digest. Never reuse a binding after its governing evidence changes.

Only a target with `after: 0` needs an individual user approval. After presenting the concrete file loss and its bound evidence, record the user's actual words as `"approval":{"by":"user","quote":"..."}`. A plan or policy decision is not approval for a file. If the governing evidence changes, renew the approval for the changed disposition. Two zero-loss files need two coverage records and two approvals. No blanket zero-coverage ban applies; the gate accepts a zero only when its exact binding and per-file approval are present. Nonzero drops need a complete disposition and lead review but no user approval.

## Proof and savings

Inspection is the default proof. Use targeted temporary fault injection only when it resolves uncertainty about whether a retained test distinguishes the intended defect.

The comparison report measures reported leaf-test counts and suite wall-clock duration. Ledger claims are separate: the optional single `savings` record may report `scenariosRemoved`, `casesRemoved`, `cosmeticTableMerges`, and `repeatedSetupCallsReduced`, with concrete `evidence`. Each count is a nonnegative integer. The report labels these values as ledger-reported, not inventory-measured; omitted values remain unmeasured. Count removed cases or reduced setup only when the evidence supports those changes. A table merge that retains every case is cosmetic and is not removed work.

## Timing rules

- Replace real sleeps and timeouts with injected clocks, resolved promises, or event waits.
- Build expensive setup once per `describe` block with `before`/`after` when tests only read it.
- Use in-process calls instead of subprocesses outside `tests/e2e/`; propose a `move` for tests that need real subprocesses or Git flows.
- Keep every non-e2e file under `FILE_BUDGET_MS` in `scripts/test-reporter.ts`; split a file that cannot meet it.

**Completion criterion:** Every baseline test in the packet has valid action or retain evidence; every after test has a retained-scenario record; mappings and deletion claims resolve against the correct snapshots; and the focused verification command passes over the packet files. Return unresolved intent or out-of-scope requests as blockers for the lead.
