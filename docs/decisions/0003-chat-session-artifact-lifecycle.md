# ADR 0003: Chat session artifact governance

- **Status**: Accepted; recovery architecture replaced by [ADR 0013](0013-toolkit-and-ledger.md)
- **Date**: 2026-09-28
- **Audience**: Maintainers

## Context

Dispatch produces human deliverables and machine evidence. Keeping them in one authoritative session makes handoff and recovery possible without copying chat context or scattering temporary files through the host repository.

## Decision

Keep session deliverables and supporting evidence together. The session manifest establishes identity; recorded paths make artifacts reachable across invocations. Production source and platform-managed files remain with their owners. The handoff identifies the authoritative session folder.

Retain completed sessions in the workspace until deliberate cleanup. Automatic movement to OS temp would make recovery depend on a second location and OS retention policy. Copying a session at each handoff would create competing authorities.

Canonical spec ownership follows [ADR 0010](0010-canonical-session-intent.md); document layers follow [ADR 0011](0011-layered-governing-documents.md). An existing resolved spec retains its path rather than acquiring a second session-local copy.

## Consequences

Deliverables and evidence remain available together, at the cost of explicit cleanup. The old per-run journal layout and replay recovery have been replaced by the toolkit and ledger. Current initialization, reactivation and artifact paths belong to the [toolkit contract](../../skills/dispatch/references/toolkit.md) and [Dispatch recovery rules](../../skills/dispatch/SKILL.md#invariants-and-recovery).
