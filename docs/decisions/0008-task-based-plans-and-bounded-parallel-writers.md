# ADR 0008: Task-based plans and bounded parallel writers

- **Status**: Accepted task-isolation principles; document layering replaced by [ADR 0011](0011-layered-governing-documents.md), execution by [ADR 0013](0013-toolkit-and-ledger.md)
- **Date**: 2026-10-02
- **Audience**: Maintainers

## Context

People need to understand task outcomes and dependencies. Writers need bounded authority, relevant context and checkable completion. Parallelism helps only when task boundaries justify the cost of orientation, verification and integration.

## Decision

### 1. Meaningful task boundaries

Group tightly coupled changes under one owner. Separate substantial independent outcomes when interfaces are settled and completion can be checked separately. Express semantic dependencies even when tasks edit different files. One task is valid; parallelism is an opportunity rather than a decomposition quota.

### 2. Human-readable plans with precise ownership

The Task Map and detailed task sections explain outcomes, prerequisites, writable paths and requirement-linked criteria. [ADR 0011](0011-layered-governing-documents.md) owns document layering; the [plan template](../../skills/dispatch/references/templates/plan.md) owns exact format. Briefs derive from these owners rather than a second maintained scope list.

### 3. Isolated writers and verified integration

Give concurrent writers separate task worktrees with recorded inputs. A focused brief supplies the whole governing spec, shared plan context, task scope, criteria and checks. Worktrees provide attribution and isolation; they do not replace write boundaries or independent inspection.

The orchestrator respects dependencies and configured native capacity. Writer submission remains a claim: inspect the actual delta and reported evidence, integrate the scoped result, then verify interactions before releasing dependent tasks. Preserve independent work and unresolved concerns across failures.

Writers follow tests-first development and report observed RED evidence. Host inspection and integrated verification establish acceptance; independent RED replay and immutable test-only checkpoints are no longer required.

### 4. Recoverable delivery

Deliver the verified integrated result while preserving unrelated caller work. The current toolkit requires an empty caller index and restores delivered paths as unstaged changes. Retain source identity and recovery evidence so an interrupted transfer cannot become a false completion.

Reconcile live writer handles and recorded state before relaunching. Continue unaffected work during artifact revision and notify affected writers with the changed scope and obligations. Preserve completed work and evidence; discarded work remains a user decision.

## Consequences and trade-offs

Meaningful tasks and focused briefs reduce unrelated context. Separate worktrees and serial integration add cost but make ownership and interactions inspectable. Conservative dependencies can limit concurrency. No percentage improvement in speed or token use is established by this record.

The [implementation reference](../../skills/dispatch/references/verbs/implement.md) owns sequencing and writer handoffs. The [toolkit contract](../../skills/dispatch/references/toolkit.md) owns worktree operations, evidence, delivery preconditions and recovery. The former scheduler, receipt protocol and journal authority have been replaced.
