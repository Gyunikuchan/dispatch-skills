# ADR 0008: Task-based plans and bounded parallel writers

- **Status**: Accepted
- **Date**: 2026-10-02
- **Audience**: Maintainers

## Context

People need to understand task outcomes and dependencies. Writers need bounded authority, relevant context and checkable completion. Parallelism helps only when task boundaries justify the cost of orientation, verification and integration.

## Decision

### 1. Meaningful task boundaries

Group tightly coupled changes under one owner. Separate substantial independent outcomes when interfaces are settled and completion can be checked separately. Express semantic dependencies even when tasks edit different files. One task is valid; parallelism is an opportunity rather than a decomposition quota.

### 2. Isolated writers and verified integration

Give concurrent writers separate task worktrees for attribution and isolation. Writer submissions remain claims: independently inspect changes and evidence and verify interactions.

### 3. Recoverable delivery

Preserve unrelated caller work and recovery evidence. Reconcile writer state before retrying, and obtain user consent before discarding work.

## Consequences and trade-offs

Meaningful tasks and focused briefs reduce unrelated context. Separate worktrees and serial integration add cost but make ownership and interactions inspectable. Conservative dependencies can limit concurrency. No percentage improvement in speed or token use is established by this record.

The [implementation reference](../../skills/dispatch/references/verbs/implement.md) owns sequencing and writer handoffs. The [toolkit contract](../../skills/dispatch/references/toolkit.md) owns worktree operations, evidence, delivery preconditions and recovery.
