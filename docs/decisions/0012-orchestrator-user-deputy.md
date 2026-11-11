# ADR 0012: Orchestrator as user deputy

- **Status**: Accepted
- **Date**: 2026-10-18
- **Updated**: 2026-11-12
- **Audience**: Maintainers

## Context

Passing unverified delegate claims and routine coordination decisions to the user adds work and review fatigue. The orchestrator needs a clear boundary between factual adjudication and decisions that require user authority.

One design invocation now delivers every increment through parent and child orchestrators, so per-increment plan approvals would stop the run at each increment, and deviation requests from a child need a ruling that is not a fault.

## Decision

Act as the user's executive deputy. Verify claims against governing intent and actual artifacts, resolve technical trade-offs within approved scope, and distill material decisions before escalation. Delegate findings are evidence to assess, not votes.

Escalate material intent changes, new external dependencies or runtime prerequisites, discarded work and unresolved blockers under the [Decision Frame](../../skills/dispatch/references/decision-frame.md). Present the conflict, verified facts, a recommendation and the consequences of alternatives. Routine progress remains autonomous within approved scope.

User authorization records contain actual user words. Autonomous technical adjudication does not authorize invented approvals or changes to the user's intent.

At design approval the user may approve all increments at once, recorded as one user-quoted `note` in the design session. With that opt-in the parent appends each increment plan's approval tuple with the opt-in quote after reading the plan against its design increment; without it each plan at medium and above still needs its own user tuple. See [approval](../../skills/dispatch/references/spec-stage.md#approval).

The parent adjudicates every deviation from the design increment, whether raised by the child, found in the parent's plan read or accepted in review. A deviation request is not a fault. The parent accepts a deviation that keeps user intent and settled decisions, records it as a design edit in both sessions and reports it without blocking; declines with an in-scope route when the increment can be met without it; and takes to the user, before ruling or implementing, any change of intent or settled decision, any disagreement or uncertainty about intent or trade-offs, or any other [user gate](../../skills/dispatch/references/decision-frame.md#user-gate-boundaries). A deviation the parent and every reviewer miss is implemented; the toolkit checks paths, not behaviour. See [the design loop](../../skills/dispatch/references/verbs/design.md#implement-an-approved-design).

No toolkit or parent check can stop a child from recording a user decision or committing, since parent and child share one file system. The instruction is the control, as it is for the single orchestrator today: the child never asks the user, never appends a `by: "user"` or approval record and never commits the caller branch. A child that ignores this is visible in the final report and the Git log, with one local unpushed commit as the worst case.

Scripts are a spine, not a cage: add a check only when it prevents a likely, costly fault that instructions and review cannot; prefer trusting an instructed agent over guarding against it. A check warns and lets the agent decide, blocking only to protect a user gate or prevent loss of work. The plan path rule warns `outside-increment` without failing lint, and a post-commit difference from a hook warns without stopping the run.

## Consequences

The user receives fewer routine questions and better evidence for material choices. The orchestrator carries the cost of investigation and adjudication. The Decision Frame owns the operational escalation contract; removed engine frames and await names no longer define this role. The opt-in trades per-increment gates for parent adjudication with unblocked reporting of accepted deviations.
