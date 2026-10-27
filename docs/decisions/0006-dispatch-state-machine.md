# ADR 0006: Dispatch as typed state machines over an event journal

- **Status**: Superseded by [ADR 0013](0013-toolkit-and-ledger.md)
- **Date**: 2026-09-30
- **Audience**: Maintainers

## Context

This decision used typed workflow machines and a durable event journal to make delegation, verification and recovery explicit. The toolkit replaced that engine with deterministic operations and orchestrator-owned sequencing.

## Retained decision references

These original IDs remain for references from other records. They identify rationale, not a second operational contract.

| Original ID | Decision and current disposition |
| --- | --- |
| D1–D4 | Native TypeScript, erasable syntax and a minimal runtime surface. Current runtime and compiler settings are owned by package metadata and configuration. |
| D5–D6 | Pure workflow reducers and composed machines. Replaced by the toolkit and ledger in ADR 0013. |
| D28 | Strict provider sandboxing: an unsupported sandbox must not silently become an unsandboxed launch. Current support and fallback behavior belongs to the [provider contract](../../skills/dispatch/references/providers.md). |
| D31 | Route rejection confirmation to the finding's source slot or its configured substitute. Current MUST confirmation and escalation rules belong to the [review rules](../../skills/dispatch/references/review-rules.md#rulings-and-fix-scope). Intent adjudication follows [ADR 0010](0010-canonical-session-intent.md#readers-and-review). |

## Consequences

The former machine layers, events, frames, admission gates, replay protocol and test-tier limits no longer define Dispatch. Current CLI behavior and durable evidence belong to the [toolkit contract](../../skills/dispatch/references/toolkit.md); governing intent follows [spec operation](../../skills/dispatch/references/spec-stage.md). Git history retains the original implementation decisions.
