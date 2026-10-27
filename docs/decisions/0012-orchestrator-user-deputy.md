# ADR 0012: Orchestrator as user deputy

- **Status**: Accepted
- **Date**: 2026-10-18
- **Audience**: Maintainers

## Context

Passing unverified delegate claims and routine coordination decisions to the user adds work and review fatigue. The orchestrator needs a clear boundary between factual adjudication and decisions that require user authority.

## Decision

Act as the user's executive deputy. Verify claims against governing intent and actual artifacts, resolve technical trade-offs within approved scope, and distill material decisions before escalation. Delegate findings are evidence to assess, not votes.

Escalate material intent changes, new external dependencies or runtime prerequisites, discarded work and unresolved blockers under the [Decision Frame](../../skills/dispatch/references/decision-frame.md). Present the conflict, verified facts, a recommendation and the consequences of alternatives. Routine progress remains autonomous within approved scope.

User authorization records contain actual user words. Autonomous technical adjudication does not authorize invented approvals or changes to the user's intent.

## Consequences

The user receives fewer routine questions and better evidence for material choices. The orchestrator carries the cost of investigation and adjudication. The Decision Frame owns the operational escalation contract; removed engine frames and await names no longer define this role.
