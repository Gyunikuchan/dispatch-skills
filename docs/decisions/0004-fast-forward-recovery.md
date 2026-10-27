# ADR 0004: Fast-forward recovery

- **Status**: Superseded by [ADR 0013](0013-toolkit-and-ledger.md)
- **Date**: 2026-09-29

This decision sought bounded repairs that preserve completed work and verify the repaired result. Its driver hot-fix modes, budgets, event protocol and verification cache have been removed.

Current repair and recovery follow the [implementation reference](../../skills/dispatch/references/verbs/implement.md). Discarding work remains a [user decision](../../skills/dispatch/references/decision-frame.md#user-gate-boundaries); tool refusals and failed checks remain visible until resolved.
