# ADR 0005: Review rounds policy

- **Status**: Accepted
- **Date**: 2026-09-29
- **Updated**: 2026-11-13
- **Audience**: Maintainers

## Context

A round cap limits review cost, but cannot establish that a blocking defect is resolved. A rejected finding also needs an evidence-based resolution rather than disappearing because the orchestrator disagrees. Later MUST rounds in prior runs mostly found regressions from the previous fix, so a user decision at a ceiling costs less than further regression-chasing.

Idle stops were the other measured review cost: 21 recorded stops each hit a delegate inside a step, and honest silence above 60 s appeared in 26 of 42 completed attempts, all inside a step with a maximum of 137 s. No honest gap was seen between steps.

## Decision

Use one review policy across plan, design and code review. Bound routine quality rounds while allowing accepted MUST fixes and pending MUST rejections to continue past the cap up to a ceiling, then escalate under the [review escalation Decision Frame](../../skills/dispatch/references/decision-frame.md#review-escalation). Preserve findings, rulings and actual review coverage so later edits cannot inherit coverage they did not receive.

Require explicit source-slot or configured substitute confirmation for rejected MUST findings. Escalate repeated disagreement or recurring failed fixes rather than running an unbounded dispute loop. Resolve intent claims against governing spec evidence; unsettled intent remains a user decision under [ADR 0010](0010-canonical-session-intent.md#readers-and-review).

The second opinion is required because the orchestrator that rejects a finding can repeat its own blind spot; unilateral closure would remove the only independent check on that ruling. A confirmation-only prompt can keep that check without paying for a redundant full re-review. Reviews use holistic whole-target voices across providers rather than diff-sliced micro-reviewers: each voice keeps cross-file architectural context, and slicing would multiply invocations across every provider without improving that context.

Later rounds receive the inter-round comparison and `### Settled in earlier rounds` alongside the whole target, so reviewers can inspect fixes and interactions first without re-reading unchanged history. In standard review prompts, accepted rows keep their defect line (clipped first line for non-MUST, full defect for accepted MUST) so voices can judge finding `origin` (`original`, `fix-induced`, `unknown`); duplicate rows point to the cited original finding ID without repeating the defect line; and an inline `(new)` marker on findings accepted since the previous reviewed round replaces the repeated ID-and-locus list in `### Since the previous round`. The compact confirmation-only prompt omits settled rows and keeps the accepted-since list. Before launching the next review round, whoever applied accepted fixes runs a fix-interaction self-check—re-reading changed sections or paths together with other consumers of each touched contract and resolving conflicts before the round—catching fix-induced regressions without launching a subagent or changing roster, cap or round rules. The comparison can include unrelated changes and fix attribution remains incomplete, while the tool-derived recurrence signal stays independent of prompt text. See the [review contract](../../skills/dispatch/references/toolkit.md#review-run) and [review rules](../../skills/dispatch/references/review-rules.md#rulings-and-fix-scope).

Streaming CLI delegates that emit step events stop after 60 s of silence between steps and 180 s inside a step; streaming providers without step events stop after 120 s, and Claude and Antigravity are never idle-stopped. A line that cannot be classified as a step boundary fails toward the longer limit, so a classifier gap delays a stop instead of causing a false one; the attempt deadline is unchanged. A stopped delegate resumes in the same session with the continue prompt within the existing resume limit. A rerun of the same round resumes an unfinished slot from its saved session state instead of repeating it. See [provider controls](../../skills/dispatch/references/providers.md#shared-provider-controls) and the [review contract](../../skills/dispatch/references/toolkit.md#review-run).

## Consequences

A run can stop for a material decision instead of completing. Reviewer failure, missing confirmation and unreviewed fixes remain visible. Exact continuation, confirmation and escalation rules belong to the [review rules](../../skills/dispatch/references/review-rules.md), with tool behavior in the [toolkit contract](../../skills/dispatch/references/toolkit.md#review-run). Phase-aware limits remove the measured false stops at a cost of at most 60 s of later detection for a true hang inside a step.
