# Design

No current spec: run the [spec stage](../spec-stage.md) (ground, refine, author, confirm) first.

Follow the [scope round](../grounding.md#scope-round) rule.

Apply the [shared](../templates/quality-bar.md#shared), [spec](../templates/quality-bar.md#spec) and [design](../templates/quality-bar.md#design) quality criteria when authoring. Resolve and read the whole [governing spec](../spec-stage.md). Author the strategy with the [design template](../templates/design.md): map REQs to components and ordered increments; record architecture choices as AD entries. When a context map exists, take items from the spec-phase map and scope delta; when either is absent, use the current design-phase map. Apply [map checks](../grounding.md#check-and-recover) to these sources. Carry unchanged consumers and parallel implementations into `Architecture & Boundaries` and each increment's `Affected contracts`. Keep user intent in the spec's DEC log.

[Lint](../toolkit.md#lint-run) the design, then set the level under [run level](../spec-stage.md#run-level) before design review. Use design review under [review rules](../review-rules.md) and [review adjudication](review.md) and resolve findings against the spec. Present the strategy, increment sequence and risks for user approval; record that decision with the first implemented plan's approval tuple, including the design hash. Design-only delivery ends with the reviewed artifact and unresolved concerns.

Revise the design in place under [revision protocol](../spec-stage.md#revision-protocol) and the [edit contract](../toolkit.md#edit). Notify affected writers under [implementation](implement.md).

A later implement invocation delivers increments in prerequisite order. Author one coherent increment plan at a time, grounding each increment first under [design increments](../grounding.md#design-increments).
