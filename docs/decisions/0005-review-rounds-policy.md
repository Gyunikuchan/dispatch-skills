# ADR 0005: Review rounds policy

- **Status**: Accepted principles; execution replaced by [ADR 0013](0013-toolkit-and-ledger.md)
- **Date**: 2026-09-29
- **Audience**: Maintainers

## Context

A round cap limits review cost, but cannot establish that a blocking defect is resolved. A rejected finding also needs an evidence-based resolution rather than disappearing because the orchestrator disagrees.

## Decision

Use one review policy across plan, design and code review. Bound routine quality rounds while allowing accepted MUST fixes and pending MUST rejections to continue past the cap. Preserve findings, rulings and actual review coverage so later edits cannot inherit coverage they did not receive.

Require explicit source-slot or configured substitute confirmation for rejected MUST findings. Escalate repeated disagreement or recurring failed fixes rather than running an unbounded dispute loop. Resolve intent claims against governing spec evidence; unsettled intent remains a user decision under [ADR 0010](0010-canonical-session-intent.md#readers-and-review).

## Consequences

A run can stop for a material decision instead of completing. Reviewer failure, missing confirmation and unreviewed fixes remain visible. Exact continuation, confirmation and escalation rules belong to the [review rules](../../skills/dispatch/references/review-rules.md), with tool behavior in the [toolkit contract](../../skills/dispatch/references/toolkit.md#review-run). The former SHOULD threshold, delta-only review scope and engine modes have been removed.
