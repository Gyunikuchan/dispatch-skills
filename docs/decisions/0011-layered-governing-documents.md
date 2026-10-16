# ADR 0011: Layered governing documents

- **Status**: Accepted
- **Date**: 2026-10-16
- **Audience**: Maintainers
- **Supersedes**: Document-format ownership in [ADR 0008](0008-task-based-plans-and-bounded-parallel-writers.md#2-human-readable-plans-with-precise-ownership)

## Context

Spec, design and plan previously repeated intent and decisions. Copies drifted, while a single decision log would make every architectural or tactical choice churn the governing spec hash. The user chose strategy in design, tactics in plan, and durable intent in the spec. Spec DEC-11 authorized this ADR set and a separate layering record; DEC-1 through DEC-10 underpin [ADR 0010](0010-canonical-session-intent.md).

## Decision

| Layer | Owns | Upstream relationship |
| --- | --- | --- |
| Spec | Why/what, REQ acceptance, non-goals, constraints, intent-level and every user-made DEC, discussion and open questions | Canonical intent owner |
| Design | Strategy, REQ-to-component mapping, architecture/boundaries, architectural decisions, risk/operations and increment graph | Direct spec path and sha256 Parent; references REQ IDs |
| Plan | Code background, tactical decisions, Task Map, scoped changes, criteria, verification and rollback | Direct spec pin for standalone work; design-increment Parent for an increment plan, with transitive spec resolution |

Each layer cites upstream IDs instead of copying its content. Every plan criterion traces to at least one `REQ-<n>`. Ordinary design/plan authoring never rewrites the spec. Intent changes follow [spec revision](../../skills/dispatch/references/spec-stage.md#revision-protocol), preserving user decision evidence and recovering stale downstream artifacts through their owner.

The [design template](../../skills/dispatch/references/templates/design.md) replaces duplicated Context & Intent and Goals & Requirements with strategy and mapping. The [plan template](../../skills/dispatch/references/templates/plan.md) keeps tactical context rather than duplicating intent, non-local exclusions or user questions. The spec owns those questions. Templates and lint own the exact current format; this ADR explains ownership, not an alternate authoring contract.

Task scheduling, file ownership and bounded native writers remain in ADR 0008. Its former plan-format description is superseded here; its isolation and independent-acceptance rationale remains applicable.

## Alternatives and consequences

A single spec decision log would change upstream pins during ordinary authoring. Repeated intent in every layer makes a reviewer choose between conflicting copies. Combining artifact introduction and layering into ADR 0010 would mix lifecycle with structure. Separate records keep these decisions independently understandable.

Layering reduces duplicated authority but requires ID tracing and reauthoring when governing intent changes. Full-spec reads preserve the common objective despite bounded task-plan reading. Operational reading, pin and recovery rules remain in [spec operation](../../skills/dispatch/references/spec-stage.md); task execution remains in the [implementation reference](../../skills/dispatch/references/verbs/implement.md).
