# Design template

````markdown
# <Technical design>

> **TL;DR:** <outcome>
> **Decide:** <reader decision, or none>
> **Risk:** <low|med|high> — <reason>
> **Increments:** <count>

## Context & Intent
*Problem, context, and clarified intent.*

## Goals & Requirements
*Goals, non-goals, requirements, acceptance criteria.*

## Architecture & Boundaries
*Constraints, components, invariants, ownership boundaries; optional Mermaid diagram.*

## Alternatives & Decisions
*Settled architectural choices with trade-offs, rationale, and rejected alternatives, plus open questions; reviews treat settled entries as final.*

## Risks, Security & Operations
*Failure modes, security, observability, migration, rollout, rollback.*

## Increment Dependency Graph
| ID | Priority | Summary | Prerequisites | Paths |
| --- | ---: | --- | --- | --- |
| I01 | 1 | <summary> | none | <paths> |

## Increment Details
### I01
- Outcome: <observable result>
- Scope: <what this increment changes>
- Non-scope: <excluded>
- Observable behavior: <what callers observe>
- Affected contracts: <interfaces, schemas, or none>
- Validation: <completion proof>
- Rollback boundary: <what reverting restores>
- Parallel safety: <safe or unsafe beside which increments, and why>

## Final Integration
*Cross-increment verification.*

## Execution Status
<!-- machine-managed; excluded from governed content -->
| ID | State | Summary | Next Action |
| --- | --- | --- | --- |
| I01 | complete | <summary> | - |
| I02 | ready | <summary> | implement:I02 |

Next Action: <implement:I<nn> | resume-increment | resolve-reconciliation | resolve-amendment:<id> | resolve-ruling:<key> | final-integration | complete>

## Review Findings & Resolutions
<!-- machine-managed review history; excluded from governed content -->
````

## Field notes

- Box: exact labels in order; `Increments` equals the graph row count; never live status.
- Increment Details: one high-level H3 per graph ID.
- Execution Status: every increment's state (completed, active, ready, blocked, invalidated) and one ledger-derived Next Action line.
