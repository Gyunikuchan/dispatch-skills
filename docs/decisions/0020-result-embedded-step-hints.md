# ADR 0020: Result-embedded step hints

- **Status**: Accepted
- **Date**: 2026-11-19
- **Updated**: 2026-11-21
- **Audience**: Maintainers

## Context

[ADR 0013](0013-toolkit-and-ledger.md) gives the orchestrator ownership of sequencing. B1 eligibility requires at least two distinct observations collected from the new runs. Each must identify a missed or misordered step and explain how one result hint could have prevented it.

I07 compared one baseline and one replay for each of planning and implementation. Both qualifying observations came from the planning replay. The implementation replay supplied none. The I07 comparison and walkthrough retain the evidence.

## Decision

B1 advisory step hints are implemented; B2 remains deferred.

Every `ok: true` toolkit envelope (excluding `native-pending`) may include an optional single-line advisory `hint` (`<= 240` UTF-8 bytes, `<step> — help <heading> — <command>`). `stepHint` derives the hint from post-write `Fold` (`HandlerResult.postFold` or fallback `foldLedger`) plus `currentHashes` via shared `gate`, `levelGate`, `confirmGate`, `latest`, `launches`, `pending`, `candidate`, and `integrationRecord` predicates with zero new persisted state and no duplicate transition table.

Hint calculation in `cli.ts` runs inside a fail-open `try/catch`: hints are strictly advisory (`exit 0`, never block, overridable without a record) and are omitted on errors, `ok: false`, `native-pending`, or orchestrator-decision boundaries. Unit tests verify the 15-row first-match table directly over `foldLedger` states and router envelopes.
