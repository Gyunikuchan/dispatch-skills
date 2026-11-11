# Design

No current spec: run the [spec authoring sequence](../spec-authoring.md#resolve-and-author) (ground, refine, author, confirm) first.

Follow the [scope round](../grounding.md#scope-round) rule.

Apply the [shared](../templates/quality-bar.md#shared), [spec](../templates/quality-bar.md#spec) and [design](../templates/quality-bar.md#design) quality criteria when authoring. Resolve and read the whole [governing spec](../spec-stage.md). Author the strategy with the [design template](../templates/design.md): map REQs to components and ordered increments; record architecture choices as AD entries. When a context map exists, take items from the spec-phase map and scope delta; when either is absent, use the current design-phase map. Apply [map checks](../grounding.md#check-and-recover) to these sources. Carry unchanged consumers and parallel implementations into `Architecture & Boundaries` and each increment's `Affected contracts`. Keep user intent in the spec's DEC log.

[Lint](../toolkit.md#lint-run) the design. Before design review, append a [bind](../toolkit.md#bind) record for the spec and design and set the level under [run level](../spec-stage.md#run-level). Use design review under [review rules](../review-rules.md) and [review adjudication](review.md) and resolve findings against the spec. Present the strategy, increment sequence and risks for user approval; record that decision with the first implemented plan's approval tuple, including the design hash. Design-only delivery ends with the reviewed artifact and unresolved concerns.

Revise the design in place under [revision protocol](../spec-stage.md#revision-protocol) and the [edit contract](../toolkit.md#edit). Notify affected writers under [implementation](implement.md).

## Implement an approved design

Deliver every increment in dependency order, finishing only when each reaches its caller-commit phase. The parent owns design and user records, decisions, plan approval and caller commits. Carry earlier outcomes only through their walkthroughs. Reconcile session records and retained handles before repeating any step; retain work on refusal or interruption.

1. For each ready increment, create or reuse its isolated session with [session init](../toolkit.md#session-commands) `--session-id`, derived from the design session ID and increment ID. Seed the spec/design binding and inherited level, and copy the original user-confirmation hash and actual quote into a user `confirm` record. Link the increment session in the design session before launch.
2. On a verified host, hand-fill the [increment orchestrator brief](../templates/increment-orchestrator-brief.md) and launch under [child orchestrators](../providers.md#child-orchestrators). The first reply is capability-ready or capability-missing; on capability-missing chain the increment in its session. Unverified hosts chain directly. A capable child waits for continuation before planning. After continuation the child, or the parent when chaining, grounds one coherent plan under [design increments](../grounding.md#design-increments). Use the same checkpoints in both paths; keep the handle for continuation.
3. At the plan checkpoint read outcome, changes, criteria, lint warnings and settled review. Adjudicate deviations from lint, review or child against settled intent and decisions. Before accepting or declining a deviation, obtain a user decision for any change of intent or settled decision, any disagreement or uncertainty about intent or trade-offs, or another [user gate](../decision-frame.md#user-gate-boundaries). Wait for that decision before ruling on or implementing the affected change. Accept non-intent design edits within settled intent, record them in both sessions and tell the user. Decline only when the increment can be met without the deviation, and give an in-scope route. Apply current approval tuple and edit-chain rules after amendments. With the recorded all-increments opt-in quote, approve an in-scope plan using that actual quote; otherwise obtain user approval at medium and above; at low follow [spec stage](../spec-stage.md#approval). Continue the same child after any gate clears.
4. After uncommitted delivery, report and cleanup, read the result and walkthrough. With the opt-in, run [worktree deliver](../toolkit.md#worktree-deliver) `--commit` using the proposed message file. Without it, ask the user to commit, including an empty commit for a no-op; verify HEAD moved past the delivery base, then use the record-only path. Report post-commit differences without stopping. Preserve recoverable state on refusal. Link the walkthrough and caller commit in the design session; wait for `committed` before opening the next integration.

At a deviation-request or gate-request, reply with the ruling, rationale, bounds, changed references and next action, or take the gate to the user and record their actual quote. On blocked, recover the same session or escalate under existing gates.

## Step reads

| Step | Reads |
| --- | --- |
| Run the spec authoring sequence when no current spec exists | [spec authoring](../spec-authoring.md#resolve-and-author) |
| Ground the scope round | [scope round](../grounding.md#scope-round) |
| Author the strategy | [design template](../templates/design.md) |
| Apply design quality criteria | [design criteria](../templates/quality-bar.md#design) |
| Lint, set the level, review, and record approval | [review rules](../review-rules.md) |
