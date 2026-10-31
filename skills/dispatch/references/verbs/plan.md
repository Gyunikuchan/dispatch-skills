# Plan

No current spec: run the [spec stage](../spec-stage.md) (ground, refine, author, confirm) first.

Resolve and read the whole [governing spec](../spec-stage.md), plus the governing design when present. Use the [plan template](../templates/plan.md). A standalone Parent pins the spec; an increment Parent pins its design increment. For an increment plan, ground it first under [design increments](../grounding.md#design-increments). Criteria trace to REQs.

Define task outcomes, a prerequisite graph, file ownership, criterion assignments and exact verification commands. Check producer/consumer interfaces before claiming independence. Put fast affected-file checks in Automated Tests and broad or slow gates in criterion Verify commands. Choose existing public test seams; use `Seams: none` when none applies. When a context map exists, carry its verified items: existing test seams and helpers into `Seams:`; unchanged consumers and callers into `Rollback & Blast Radius`; parallel implementations of each changed predicate or contract into the owning task's `Invariants:`. Copy an item only after confirming it at source.

Run lint and resolve parse-critical defects, then set the level under [run level](../spec-stage.md#run-level) before plan review. Review the plan against the governing spec, including semantic gaps when lint reports only warnings. Settle the approval tuple before medium-or-higher implementation.

Plan is a living document. Edit it in place and append a ledger `edit` record with `before` and `after` hashes, `class`, `diffRef` and `rationale`. The [ledger contract](../toolkit.md#edit) owns fields and hashing. Re-approval is required only for intent, dependency or discard changes under the [user gate](../decision-frame.md#user-gate-boundaries). Include edits as walkthrough deviations. Notify affected writers under [implementation](implement.md).

When findings in one requirement or area recur after an accepted fix, verify feasibility and present the [review escalation](../decision-frame.md#review-escalation), with prior fixes and concrete alternatives.
