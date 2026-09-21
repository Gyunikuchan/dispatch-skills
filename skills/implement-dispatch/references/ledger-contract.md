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

No ledger event may ever be appended between a prior `run-complete` and the next `run-start`;
the fold rejects any event after a terminal event that is not a new `run-start`.

Use the exact v1 event grammar enforced by `scripts/ledger-events.mjs`. Sequence numbers are
ledger-global. The writer holds one exclusive lock across tail read, sequence assignment, append,
and fsync. Repair uses the same lock. Append refuses malformed or unterminated tails.

Read-only inspection reports torn bytes without mutation. `repair-tail` reports those bytes before
truncating and fsyncing the valid prefix, then requires a resolved `reconciliation` ruling. A stale
lock is broken only through the explicit operation after proving its PID is dead; a live or
unverifiable holder requires user ruling.

## Phased (v2) events

Design-run segments use ledger version 2 with the widened `run-start` action grammar
`ordinary|design|increment|integration`. `action: "design"` keeps the exact design-foundation schema;
`increment` and `integration` actions additionally require `design:{path,revision}` (path equal
to `governingPath`, revision equal to `governingHash`) and, for `increment`,
`increment:{id,planPath,walkthroughPath,planHash}`. Increment segments derive their approval
from the design revision binding (no duplicate `approval` event; the immediate-approval rule
stays ordinary-only) and may contain `task-start`, `implementation-attempt`, `verification`, and
`task-complete` events; design and integration segments may not contain task events. Increment
segments open right after plan settlement and before the baseline; every invocation,
including a clean increment stop, ends its segment with `run-complete` (result `complete`).
`design-approved-stop` stays reserved for the approval durable stop; amendment-only design
segments also end with result `complete` and are excluded from approval-bearing design-segment
selection, which resolves to the latest design segment carrying an approved `approval` event.

The v2 grammar additionally enforces what the design foundation shipped; the four new v2 event types and their exact required data:

- `increment-state`: `incrementId` (`I<nn>`), `prior`, `next`, `cause`, `affectedDependents`
  (increment IDs); legal transitions `pending→ready→active→complete`, unfinished →
  `blocked|invalidated`, `complete→reopened`, `reopened→active`, `blocked→ready`, and
  `invalidated→pending` only after an `activated` amendment affecting that increment; a
  completed task cannot restart until its owning increment reopens.
- `amendment`: `amendmentId`, `state` (`proposed|reviewed|prepared|activated|rejected|aborted`),
  `affectedIncrements` always; `baseRevision`+`candidateHash` required on `prepared` (which also
  requires `targetPath`/`replacementPath`) and `activated`; rejected on `proposed`/`reviewed`/
  `rejected`/`aborted`; optional `reconciliationState`.
- `adjacent-fix`: `findingIds`, `clusterId` (`C-<12 hex>`), `attempts`, `result`
  (`complete|failed|aborted`); legal only after its cluster's task events.
- `integration`: `scopeId`, `verificationRefs`, `reviewRefs`, `result`
  (`pass|accepted-baseline-equivalent|regression`); only in integration segments after their
  verification/review evidence.

Ordering: an `amendment` is legal after the design binding exists and must follow the affected
increment's latest task event across the folded run when the increment has task history;
plan-authoring-time amendments run inside a dedicated design-action segment binding the design
path at the base revision. An amendment precedes the `increment-state` transitions it causes.
`foldDesignRun(events)` folds every valid segment for the matching design identity (normalized
design path + root slug) across revisions, merging increment states, amendments, adjacent-fixes,
integration results, and rulings; `nextDesignAction(fold)` derives exactly one of
`resolve-reconciliation`, `resolve-amendment:<id>`, `resume-increment`, `implement:I<nn>`,
`final-integration`, `complete` — in that precedence order, with final integration requiring
every folded increment to be `complete` and reopened increments remaining implementable. Phased
resume is authoritative over
the pre-5B `selectDesignSegment` path, which remains for design-review-only runs.

## Interruption and handoff

Interruption reports include the canonical resume command and exact ledger path. At ordinary
handoff print the same command and warn that OS temp, including Windows Storage Sense, may purge
the ledger. The ledger remains in its per-user temp namespace and is never relocated with scratch
artifacts.

Emit one `Rulings made` list combining latest keyed ledger rulings with review resolution-log
rulings. Review-log rulings are authoritative on a key collision. Preserve unresolved rulings and
reconciliation state in the handoff.
