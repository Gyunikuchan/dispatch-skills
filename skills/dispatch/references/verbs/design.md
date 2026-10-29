# Design

No current spec: run the [spec stage](../spec-stage.md) (ground, refine, author, confirm) first.

Resolve and read the whole [governing spec](../spec-stage.md). Author the strategy with the [design template](../templates/design.md): map REQs to components and ordered increments; record architecture choices as AD entries. Keep user intent in the spec's DEC log.

Lint the design, then set the level under [run level](../spec-stage.md#run-level) before design review. Use design review under [review rules](../review-rules.md) and resolve findings against the spec. Present the strategy, increment sequence and risks for user approval; record that decision with the first implemented plan's approval tuple, including the design hash. Design-only delivery ends with the reviewed artifact and unresolved concerns.

Design is a living document. Bind the spec and design before recording revisions; when a plan exists, bind the complete spec/plan/design set. Edit the design in place and append a ledger `edit` record with `before` and `after` hashes, `class`, `diffRef` and `rationale`. The [ledger contract](../toolkit.md#edit) owns fields and hashing. Re-approval is required only for intent, dependency or discard changes under the [user gate](../decision-frame.md#user-gate-boundaries). Include changes as walkthrough deviations. Continue unaffected work; notify affected writers under [implementation](implement.md).

A later implement invocation delivers increments in prerequisite order. Author one coherent increment plan at a time.
