# ADR 0020: Result-embedded step hints

- **Status**: Accepted
- **Date**: 2026-11-19
- **Audience**: Maintainers

## Context

[ADR 0013](0013-toolkit-and-ledger.md) gives the orchestrator ownership of sequencing. B1 eligibility requires at least two distinct observations collected from the new runs. Each must identify a missed or misordered step and explain how one result hint could have prevented it.

I07 compared one baseline and one replay for each of planning and implementation. Both qualifying observations came from the planning replay. The implementation replay supplied none. The I07 comparison and walkthrough retain the evidence.

## Decision

Eligible for a separate plan. B2 remains deferred.

DEC-8 requires that any B1 hint be advisory only (exit 0, never blocks, overridable without a record). It occupies one line (step, help heading, command) and derives from the existing ledger fold with no new state. Return null when the orchestrator decides. Add no duplicate transition table and use unit tests over the fold only.
