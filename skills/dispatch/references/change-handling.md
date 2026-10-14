# Change handling

## Observe and preserve

Observe Git-tracked files and non-ignored untracked files. Git decides ignore membership, including nested rules, negation, global excludes and `.git/info/exclude`. Tracked files remain observed when an ignore pattern matches. Record membership and rule changes separately from deletion. Ignored dependencies and secrets are outside automatic observation; required verification still runs.

At acceptance boundaries, the driver attaches advisory `observations` to normal frames. Each observation identifies the before/after revisions, changed paths, suggested affected evidence and immutable raw delta. Inspect the delta when the summary omits paths. Unchanged observations coalesce. An observation adds no await and needs no acknowledgement for progress; the original receipt is consumed once.

Path overlap, incomplete dependencies and HEAD/index/ignore-rule changes are evidence for host judgment. They do not revoke evidence, reset tasks or grant write scope. Optional criterion `dependencies:{inputs:[<repository-relative paths>],complete:true,rationale:<coverage evidence>}` records coverage, including transitive test, tool and configuration inputs; derive it from inspected inputs rather than `Changes` alone.

## Select obligations on a normal reply

The orchestrator can attach `changeDispositions` to its normal host event. Bind each row to the current observation's `observationId` and `afterHash`, give a nonblank `rationale`, and name criterion IDs in `retain` or `refresh`. Stale supplied bindings fail validation; omitted dispositions do not block progress.

```json
{"type":"EVIDENCE","criteria":{"SC1":{"outcome":"pass","evidence":"Checked the retained candidate."}},"changeDispositions":[{"observationId":"change-1","afterHash":"current-revision","rationale":"The edit affects only the report title.","retain":["SC1"]}]}
```

Retaining evidence preserves its actual revision and recorded coverage. Refresh marks named verification obligations pending and preserves drafts, candidates, integration commits, acceptance history, attempts and handles. Recheck retained work; select a concrete repair before launching more production writes. Failed required checks remain unresolved, and mandatory final gates still run against the selected delivery candidate. At completion, account for observations that could affect required criteria.

For changed requirements, use [plan reconciliation](verbs/implement.md#amendments). Escalate actual changed intent, new external dependencies/runtime prerequisites or work disposal under the existing user gate. Review coverage uses the separate [review applicability contract](review-rules.md#review-provenance-and-applicability).

## Concrete write boundaries

Receipt identity, scoped write admission, path containment, executable/configuration integrity and immutable reference validation remain mandatory. A disposition never authorizes unspecified edits. Valid applied artifact fixes name their plan/design target; failed or invalid receipts admit none.

Delivery and restore inspect every destination, including ignored files, symlinks, modes and ancestors. Complete all-path preflight before mutation. A concrete collision preserves caller bytes and the candidate and can still return a `DECISION kind=drift` for that collision. Rebuild/reconcile the candidate before retry, then run live preflight again. Ordinary observations have no drift decision. No disposition permits overwriting newer caller content.

Delivery refresh archives the accepted integration and binds the active candidate to the new caller baseline. A replay conflict retains completed picks and the active conflicted pick; continue through the [resolve-only replay flow](verbs/implement.md#integration-conflicts). Every later collision requires a new baseline and live preflight.

## Checkpoints and runtime continuation

The operational journal commits immutable checkpoints containing full private machine state, exact FIFO effect descriptors, attempts/open membership, counters, execution configuration, runtime/schema identity, repository binding and saved diagnostic phase history. Projected frames are not recovery state. Publish checkpoint bytes durably before the journal reference; an orphan checkpoint is ignored. Verify the committed prefix and every reachable reference before hydration. Fold only its uncheckpointed tail; retain accepted transitions when a later operation faults.

Preserve the entire session: checkpoints, `recovery-manifests/<sha256>.json`, `recovery-contents/<sha256>`, sealed effect results and the journal. Schema, digest, byte length, containment or repository failures stop mutation and preserve artifacts. Current protocol and state versions are declared in the runtime; historical journal migration, garbage collection and arbitrary old-run repair are unsupported.

After interruption, inspect `status --run <dir>`. A compatible runtime uses eventless `send` to admit proved completion, reattach a proved live handle or repeat a declared deterministic read. An uncertain side effect returns `data.kind: effect-recovery` and `data.recoveryReply`; it cannot relaunch merely because its terminal journal record is absent. Use that exact descriptor/attempt/hash to record `EFFECT_RECOVERY` with `action: retry|stop` and a rationale. A host assertion cannot fabricate a successful terminal result.

After a local driver fix changes runtime identity, run:

```text
node <skills-dir>/dispatch/scripts/dispatch.ts rebind --run <dir> --reason "Parser fixed with compatible private state"
node <skills-dir>/dispatch/scripts/dispatch.ts send --run <dir>
```

Rebind validates compatible checkpoint/state, immutable bindings and repository ownership, then records old/new runtime identities and a continuation epoch. It launches no handler, replays no accepted decisions and retains work and execution configuration. Optional `--event @<reply-path>` validates input only; send that event afterward to apply it once. Completion is proved only by sealed actual output or handler-specific receipts/commit trailers/live claims. If a crash occurred before sealing and no handler proof exists, explicit retry/stop remains necessary. See [provider recovery](providers.md) and [human upgrade guidance](readme/troubleshooting.md#continue-after-a-local-driver-fix).

Review scope, target and fix-candidate manifests carry saved byte references. Hydration and each consuming effect verify path containment, SHA-256 and byte length. Missing or changed manifests fail before admission or mutation.

Explicit rebind can add those references to a compatible older checkpoint only when the authenticated journal already records the original canonical manifest identity. A prepared scope must equal the exact scope projection of that authenticated binding. Rebind never treats the current digest as proof of original content. Missing identity, changed content or unresolved old effect descriptors without saved references remain incompatible; preserve the run. This metadata migration launches no effect and records `migration: review-manifest-v1` in the continuation epoch.
