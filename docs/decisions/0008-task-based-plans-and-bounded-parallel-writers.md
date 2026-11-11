# ADR 0008: Task-based plans and bounded parallel writers

- **Status**: Accepted
- **Date**: 2026-10-02
- **Updated**: 2026-11-12
- **Audience**: Maintainers

## Context

People need to understand task outcomes and dependencies. Writers need bounded authority, relevant context and checkable completion. Parallelism helps only when task boundaries justify the cost of orientation, verification and integration.

The orchestrator applying every review fix made it both adjudicator and author, with expensive-model edits for large fixes and no separation between ruling and repair.

## Decision

### 1. Meaningful task boundaries

Group tightly coupled changes under one owner. Separate substantial independent outcomes when interfaces are settled and completion can be checked separately. Express semantic dependencies even when tasks edit different files. One task is valid; parallelism is an opportunity rather than a decomposition quota.

### 2. Isolated writers and verified integration

Give concurrent writers separate task worktrees for attribution and isolation. Writer submissions remain claims: independently inspect changes and evidence and verify interactions.

### 3. Recoverable delivery

Preserve unrelated caller work and recovery evidence. Reconcile writer state before retrying, and obtain user consent before discarding work.

### 4. Review fix routing

Plan and design fixes stay with the orchestrator. In implementation integration, a mechanical correction confirmed by a deterministic check goes to the utility subagent first. A remaining fix goes to the responsible task writer when it changes multiple files, an executable production statement, a production configuration or schema directive that changes runtime behaviour, or a test assertion; the orchestrator handles remaining small fixes. A content-preserving rename counts as one file when its diff holds only that rename. Standalone review uses direct orchestrator fixes.

A writer fix runs in the integration worktree, not a new worktree: the brief names the worktree's absolute path as the only write root with the fix's explicit paths, and the writer runs no Git writes and no toolkit. Fix sets run serially with no other agent editing that worktree until the delta commits. The orchestrator checks the delta against the assignment for path containment and non-emptiness, then commits through the existing review-fix path with the same verification and review as any fix. A retained task writer is reused; when its handle is gone, a new writer launches for the same task at the same routed model and effort with the same brief. A cross-ownership fix goes to the task owning the defective behaviour. See [fix scope](../../skills/dispatch/references/review-rules.md#rulings-and-fix-scope) and the [implementation reference](../../skills/dispatch/references/verbs/implement.md).

## Consequences and trade-offs

Meaningful tasks and focused briefs reduce unrelated context. Separate worktrees and serial integration add cost but make ownership and interactions inspectable. Conservative dependencies can limit concurrency. No percentage improvement in speed or token use is established by this record.

Writer-routed fixes keep code context with the task owner at the cost of one launch per fix set; small fixes stay cheap with the orchestrator. The [implementation reference](../../skills/dispatch/references/verbs/implement.md) owns sequencing and writer handoffs. The [toolkit contract](../../skills/dispatch/references/toolkit.md) owns worktree operations, evidence, delivery preconditions and recovery.
