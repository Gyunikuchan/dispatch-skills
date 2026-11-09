# Plan

No current spec: run the [spec authoring sequence](../spec-authoring.md#resolve-and-author) (ground, refine, author, confirm) first.

Follow the [scope round](../grounding.md#scope-round) rule. Increment plans keep their [design increment round](../grounding.md#design-increments).

Apply the [shared](../templates/quality-bar.md#shared), [spec](../templates/quality-bar.md#spec), [plan](../templates/quality-bar.md#plan), [testing](../templates/quality-bar.md#testing) quality criteria when authoring. Resolve and read the whole [governing spec](../spec-stage.md), plus the governing design when present. Use the [plan template](../templates/plan.md). When lint reports a code, read its [field note](../templates/plan-field-notes.md). A standalone Parent pins the spec; an increment Parent pins its design increment. For an increment plan, ground it first under [design increments](../grounding.md#design-increments). Criteria trace to REQs. Bind decisions per the plan standard and leave routine choices to writers; keep external-format and absence claims within the shared evidence rule.

Define task outcomes, a prerequisite graph, file ownership, criterion assignments and exact verification commands. Check producer/consumer interfaces before claiming independence. Put fast affected-file checks in Automated Tests and broad or slow gates in criterion Verify commands. Choose existing public test seams; use `Seams: none` when none applies. When the phase context map exists, take items from the spec-phase map and scope delta; for an increment plan, also take increment-local items from its increment map. When the baseline or delta is absent, use the current phase map. Apply [map checks](../grounding.md#check-and-recover) to these sources. Carry verified items: existing test seams and helpers into `Seams:`; unchanged consumers and callers into `Rollback & Blast Radius`; parallel implementations of each changed predicate or contract into the owning task's `Invariants:`. Copy an item only after confirming it at source.

Run [lint](../toolkit.md#lint-run) and resolve parse-critical defects, then set the level under [run level](../spec-stage.md#run-level) before plan review. Review the plan against the governing spec under [review adjudication](review.md), including semantic gaps when lint reports only warnings. Settle the approval tuple before medium-or-higher implementation.

Revise the plan in place under [revision protocol](../spec-stage.md#revision-protocol) and the [edit contract](../toolkit.md#edit). Notify affected writers under [implementation](implement.md).

When findings in one requirement or area recur after an accepted fix, verify feasibility and present the [review escalation](../decision-frame.md#review-escalation), with prior fixes and concrete alternatives.

## Step reads

| Step | Reads |
| --- | --- |
| Run the spec authoring sequence when no current spec exists | [spec authoring](../spec-authoring.md#resolve-and-author) |
| Ground the scope round | [scope round](../grounding.md#scope-round) |
| Author against the plan template | [plan template](../templates/plan.md) |
| Apply plan quality criteria while authoring | [plan criteria](../templates/quality-bar.md#plan) |
| Read the field note when lint reports a code | [field notes](../templates/plan-field-notes.md) |
| Lint, set the level, review, and revise | [review rules](../review-rules.md) |
