# Plan

Resolve and read the whole [governing spec](../spec-stage.md), plus the governing design when present. Use the [plan template](../templates/plan.md). A standalone Parent pins the spec; an increment Parent pins its design increment. Criteria trace to REQs.

Define task outcomes, a prerequisite graph, file ownership, criterion assignments and exact verification commands. Check producer/consumer interfaces before claiming independence. Put fast affected-file checks in Automated Tests and broad or slow gates in Final Gate. Choose existing public test seams; use `Seams: none` when none applies.

Run lint and resolve parse-critical defects, then set the level under [run level](../spec-stage.md#run-level) before plan review. Review the plan against the governing spec, including semantic gaps when lint reports only warnings. Settle the approval tuple before medium-or-higher implementation.

Plan is a living document. Edit it in place and append a ledger `edit` record with `before` and `after` hashes, `class`, `diffRef` and `rationale`. The [ledger contract](../toolkit.md#edit) owns fields and hashing. Re-approval is required only for intent, dependency or discard changes under the [user gate](../decision-frame.md#user-gate-boundaries). Include edits as walkthrough deviations. Notify affected writers under [implementation](implement.md).

When findings in one requirement or area recur after an accepted fix, verify feasibility and present the [review escalation](../decision-frame.md#review-escalation), with prior fixes and concrete alternatives.
