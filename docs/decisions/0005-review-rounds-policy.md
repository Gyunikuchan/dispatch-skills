# ADR 0005: Review rounds policy

- **Status**: Accepted
- **Date**: 2026-09-29
- **Audience**: Maintainers

## Context

A round cap limits review cost, but cannot establish that a blocking defect is resolved. A rejected finding also needs an evidence-based resolution rather than disappearing because the orchestrator disagrees. Later MUST rounds in prior runs mostly found regressions from the previous fix, so a user decision at a ceiling costs less than further regression-chasing.

## Decision

Use one review policy across plan, design and code review. Bound routine quality rounds while allowing accepted MUST fixes and pending MUST rejections to continue past the cap up to a ceiling, then escalate under the [review escalation Decision Frame](../../skills/dispatch/references/decision-frame.md#review-escalation). Preserve findings, rulings and actual review coverage so later edits cannot inherit coverage they did not receive.

Require explicit source-slot or configured substitute confirmation for rejected MUST findings. Escalate repeated disagreement or recurring failed fixes rather than running an unbounded dispute loop. Resolve intent claims against governing spec evidence; unsettled intent remains a user decision under [ADR 0010](0010-canonical-session-intent.md#readers-and-review).

The second opinion is required because the orchestrator that rejects a finding can repeat its own blind spot; unilateral closure would remove the only independent check on that ruling. A confirmation-only prompt can keep that check without paying for a redundant full re-review. Reviews use holistic whole-target voices across providers rather than diff-sliced micro-reviewers: each voice keeps cross-file architectural context, and slicing would multiply invocations across every provider without improving that context.

Later rounds receive the inter-round comparison and accepted finding loci alongside the whole target, so reviewers can inspect fixes and interactions first. The comparison can include unrelated changes; fix attribution is incomplete. An optional finding origin identifies original or fix-induced defects, while the tool-derived recurrence signal remains independent. See the [review contract](../../skills/dispatch/references/toolkit.md#review-run).

## Consequences

A run can stop for a material decision instead of completing. Reviewer failure, missing confirmation and unreviewed fixes remain visible. Exact continuation, confirmation and escalation rules belong to the [review rules](../../skills/dispatch/references/review-rules.md), with tool behavior in the [toolkit contract](../../skills/dispatch/references/toolkit.md#review-run).
