# Durable execution ledger

Use the ledger independently of walkthrough freshness. Resolve `ledgerPath` before dispatch and
fold it before trusting any completion claim.

## Identity and resume

An ordinary run uses one canonical `.scratch/plan/<date>-<slug>.md`. If branch resolution produces
a different slug, persist the filename slug explicitly before approval. Native artifacts and
non-canonical plan paths cannot use plan-path resume; stop with the resolver diagnostic and create
an explicit canonical scratch plan.

`/implement-dispatch <plan-path>` recomputes the plan's semantic `governingHash`, resolves its
ledger, and selects only the latest matching unterminated ordinary segment. A level-less resume
re-resolves flow, states the exact delta, and always obtains user confirmation before dispatch.
Completed or hash-mismatched segments never resume implicitly.

Before dispatch, compare each authoritative completed task's `resultState` with the current
materialized path state. Later overlapping ownership supersedes the earlier task for shared paths.
Drift, malformed/unknown events, unsupported path bytes, or strict plan-normalization failure enter
`needs-reconciliation`; they never authorize redispatch. A missing ledger is recoverable only by
explicit best-effort reconstruction from the governing artifact and working tree.

## Append points

Immediately after approval, append `run-start`, then `approval`, then any pre-approval `ruling` and
`review` records. Before each task or cluster dispatch append `task-start`. Append every
`implementation-attempt` and its host `verification`; append `task-complete` only after a
non-regression verification transitions to `complete`. Append later rulings and reviews as they
settle (settled § 4 review fixes are checkpointed with the review record). Append `run-complete`
last for complete, stable-failure, or aborted outcomes.

Use the exact v1 event grammar enforced by `scripts/ledger-events.mjs`. Sequence numbers are
ledger-global. The writer holds one exclusive lock across tail read, sequence assignment, append,
and fsync. Repair uses the same lock. Append refuses malformed or unterminated tails.

Read-only inspection reports torn bytes without mutation. `repair-tail` reports those bytes before
truncating and fsyncing the valid prefix, then requires a resolved `reconciliation` ruling. A stale
lock is broken only through the explicit operation after proving its PID is dead; a live or
unverifiable holder requires user ruling.

## Interruption and handoff

Interruption reports include the canonical resume command and exact ledger path. At ordinary
handoff print the same command and warn that OS temp, including Windows Storage Sense, may purge
the ledger. The ledger remains in its per-user temp namespace and is never relocated with scratch
artifacts.

Emit one `Rulings made` list combining latest keyed ledger rulings with review resolution-log
rulings. Review-log rulings are authoritative on a key collision. Preserve unresolved rulings and
reconciliation state in the handoff.
