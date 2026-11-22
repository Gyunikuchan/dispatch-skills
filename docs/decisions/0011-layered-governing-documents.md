# ADR 0011: Layered governing documents

- **Status**: Accepted
- **Date**: 2026-10-16
- **Audience**: Maintainers

## Context

Repeating intent and decisions across layers creates copies that can drift. A single decision log would make architectural and tactical choices churn the governing spec hash.

## Decision

The hierarchy is Spec → Design (optional) → Plan → Implementation. The walkthrough records delivered behavior and verification evidence after execution.

| Layer | Owns | Upstream relationship |
| --- | --- | --- |
| Spec | Why/what, REQ acceptance, non-goals, constraints, intent-level and every user-made DEC, discussion and open questions | Canonical intent owner |
| Design (optional) | Strategy, REQ-to-component mapping, architecture/boundaries, architectural decisions, risk/operations and increment graph | Direct spec path and sha256 Parent; references REQ IDs |
| Plan | Code background, tactical decisions, Task Map, scoped changes, criteria, verification and rollback | Direct spec pin for standalone work; design-increment Parent for an increment plan, with transitive spec resolution |
| Implementation | Code and routine writer choices | Follows the plan's scope and criteria |

Each layer cites upstream IDs instead of copying its content. Every plan criterion traces to at least one `REQ-<n>`. Ordinary design/plan authoring never rewrites the spec. Intent changes follow [spec revision](../../skills/dispatch/references/spec-stage.md#revision-protocol), preserving user decision evidence and recovering stale downstream artifacts through their owner.

Isolated increment sessions lack the design discussion. An optional `Grounding leads:` field in the increment preserves tentative hints in the governed design. Increment planners verify these advisory leads during grounding and decide which to use. Architectural decisions stay in the design's decision records. The [design template](../../skills/dispatch/references/templates/design.md) defines the field.

The [bounded writers ADR](0008-task-based-plans-and-bounded-parallel-writers.md) explains file ownership and isolation. The [toolkit and ledger ADR](0013-toolkit-and-ledger.md) covers execution and acceptance mechanics.

## Alternatives and consequences

A single spec decision log would change upstream pins during ordinary authoring. Repeated intent in every layer makes a reviewer choose between conflicting copies. Combining artifact introduction and layering into ADR 0010 would mix lifecycle with structure. Separate records keep these decisions independently understandable.

Layering reduces duplicated authority but requires ID tracing and reauthoring when governing intent changes. Full-spec reads preserve the common objective despite bounded task-plan reading. Operational reading, pin and recovery rules remain in [spec operation](../../skills/dispatch/references/spec-stage.md); task execution remains in the [implementation reference](../../skills/dispatch/references/verbs/implement.md).
