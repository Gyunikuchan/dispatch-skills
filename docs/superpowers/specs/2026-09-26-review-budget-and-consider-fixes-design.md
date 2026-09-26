# Review budget and accepted CONSIDER fixes

## Purpose and confirmed decisions

This design fixes two related review-state defects:

- An accepted in-scope `CONSIDER` finding is automatically fixed when the host can describe a safe, bounded fix. When the host is uncertain whether the advice should be applied, it records `needs-user` and the driver defers that question until no more review waves can run. Accepted adjacent findings continue through the existing opt-in gate.
- A review phase has one cumulative review-wave budget. `reviewWaves` starts once for the logical phase and only increases. Applying a fix, resuming a child review state, opting into an adjacent fix, or recovering from checkpoint drift never creates a fresh counter.

Accepted findings from the round that reaches the cap are still applied and verified. They do not trigger another review wave. Only a live, unresolved `MUST` can justify an explicit cap extension; the extension increases the cap without resetting the consumed count.

Plan/design review and code review retain separate logical budgets. The rule applies across internal restarts of one logical phase; it does not merge the plan and code-review policies.

This document is the source of truth for the CONSIDER and review-budget behavior below. The existing evidence-based adjudication, consensus, rebuttal, and adjacent-scope rules remain in force.

## Current defects

The driver currently excludes accepted in-scope `CONSIDER` findings from the fix queue in `review-phase.mjs`. Its adjudication path also exempts them from the normal accepted-fix path requirement.

The review counter is local to a temporary child review state. `startReview()` initializes `reviewWaves` to zero, `beginReview()` creates a new child after accepted fixes, and artifact recovery counts only rounds after the most recent settled prefix. Opt-in handling explicitly resets the counter, and checkpoint-drift recovery lowers it to manufacture room for another wave. These paths allow one implementation phase to exceed its configured cap without an approved extension.

## Design

### 1. Adjudication and fix queue

The host remains responsible for the finding disposition:

- `accepted`: verified and agreeable; queue an automatic fix under `--fix`.
- `rejected` or `downgraded`: record the ruling; do not fix.
- `needs-user`: for MUST/SHOULD, retain the existing user-ruling path. For CONSIDER, record a deferred decision and continue the review rounds; ask the user only after the phase has no further review wave available. A user acceptance then follows the same fix-queue path.
- adjacent scope: retain the finding for opt-in, regardless of severity.

Under `--fix`, an accepted in-scope finding of any severity, including `CONSIDER`, must provide `fix.affectedPaths`, `dependsOn`, and `verification` with the same validation used for accepted MUST/SHOULD findings. `needs-user` represents uncertainty about whether to apply an otherwise bounded candidate fix; it must not be used to defer an unbounded or unidentified change. If no safe bounded fix can be described, retain the finding as rejected or as a follow-up rather than inventing a path after user acceptance.

`writeRound()` queues accepted in-scope MUST, SHOULD, and CONSIDER findings. It records uncertain in-scope CONSIDER findings with a distinct `Pending User Decision` status instead of treating them as rejected or emitting an immediate user question. That status remains unresolved for finalization, but does not trigger another review wave or a consensus rebuttal. Once the review phase has no further review wave available, emit one user question for the deferred CONSIDER findings; accepted answers enter the fix queue, rejected answers are recorded without a fix, and neither answer starts another review wave. It continues to place adjacent findings in the opt-in list. The existing opt-in behavior remains: selected adjacent findings are applied after the main review settles, declined findings become follow-ups, and the review budget is preserved.

### 2. One durable budget per logical review phase

The active implementation state owns the budget for its current review identity. Use a durable structure equivalent to:

```json
{
  "schemaVersion": 1,
  "phase": "code-review",
  "budgetId": "<logical implementation or review run id>",
  "reviewWaves": 3,
  "roundLimit": 3
}
```

The same budget is carried into every temporary child review state. When a child completes, its current values are copied back before the child state is discarded. A new child for the same logical phase must inherit the prior values instead of initializing from zero and the configured default.

The resolution log under `## Review Findings & Resolutions` is the recovery mirror for this budget. Append a parser-owned structured marker for each budget change, for example:

```text
<!-- dispatch-review-budget {"schemaVersion":1,"phase":"code-review","budgetId":"<id>","reviewWaves":3,"roundLimit":3} -->
```

The marker is scoped by `budgetId` and phase. The latest marker for that budget is used during artifact-only recovery. A marker is written when a review wave is allocated and when an approved extension changes the cap. This preserves an auditable history without treating a settled resolution segment as a new budget.

For an active run, parent state and the matching artifact marker must be reconciled conservatively: a lower value must never overwrite a higher consumed count or cap. For a legacy artifact without a marker, use the highest recorded round for a conservative initial count and write the marker on the next state mutation.

`reviewWaves` is initialized only when a new logical phase budget is created. Thereafter it may only increment once for each real `type: 'review'` wave. Rebuttal and final verification waves do not increment it. `roundLimit` is initialized once and may only increase through an approved extension.

### 3. Continuation and cap ordering

The continuation decision must preserve this order:

1. Apply pending accepted fixes, including fixes accepted in the cap-reaching round, and run their verification.
2. Compute whether the phase is at its cumulative cap.
3. If below the cap, a fix-induced change or live MUST may start another review wave.
4. At the cap, accepted fixes do not start a review wave. A live unresolved MUST may produce the existing `extend`/`stop` decision.
5. `extend: true` adds one policy-sized increment to `roundLimit`; the next review wave consumes the next monotonic `reviewWaves` value.
6. With no live MUST, ask for any deferred CONSIDER decisions, then apply and verify accepted answers before settling. Those post-review CONSIDER fixes never start another review wave. Run final verification/checkpoint as required by the surrounding implementation flow.

This makes the cap apply to review waves, not fix application. A cap-reaching round can therefore contain accepted MUST, SHOULD, and CONSIDER findings that are all fixed and verified without a follow-up review.

Checkpoint drift must use a separate retry flag, not a second counter. If recovery launches a genuine new review wave, it consumes the next `reviewWaves` value and obeys the cap. If it only retries checkpoint preparation, it must not allocate a review wave. It must never decrement the counter.

### 4. Phase and invocation boundaries

Plan review, design review, and code review keep distinct budget identities. A new standalone review invocation receives a new budget identity; resuming or reconstructing the same implementation phase preserves its existing identity. The design does not change target selection, provider fallback, consensus, rebuttal semantics, or the final checkpoint contract.

## Verification

Add focused coverage for:

- accepted in-scope CONSIDER with a bounded fix: the fix is queued, applied, and verified;
- uncertain CONSIDER during an active review: no immediate user question; the decision is deferred until no more review waves can run;
- deferred CONSIDER uses a distinct pending-user status and does not enter rebuttal or review-wave continuation;
- deferred CONSIDER accepted after the final review wave: the fix is applied and verified without another review;
- CONSIDER with no safe bounded fix: no invented path is accepted, and the finding remains rejected or a follow-up;
- rejected/downgraded CONSIDER: no fix is queued;
- adjacent CONSIDER: opt-in remains required and the phase budget is unchanged;
- accepted MUST, SHOULD, and CONSIDER findings in the cap-reaching round: all are applied and verified, with no additional review wave;
- a live MUST at the cap: extension increases `roundLimit`, preserves `reviewWaves`, and permits the next wave;
- fix-induced child review restart: the counter continues from the parent budget;
- opt-in recovery, checkpoint drift, state loss, and artifact reconstruction: the counter never decreases or resets;
- plan/design and code-review budgets remain separate.

Update the shared review contract, walkthrough/plan guidance, resolution-log parser, driver state tests, and generated hashes as needed. Run focused tests followed by `npm test` and the hash check.

## Scope and rollback

Expected implementation areas are the review driver, review state recovery, resolution-log parsing, review contract/templates, and focused driver tests. No new dependency or provider integration is required. Existing resolution entries remain parseable; artifacts without budget markers use the conservative legacy recovery rule and acquire a marker on the next mutation.

Rollback removes the budget marker handling and restores the prior CONSIDER queue and counter behavior. The change should not alter plan/code policy values, target selection, or adjacent opt-in boundaries.
