# Design template

````markdown
# <Technical design>

> **TL;DR:** <outcome>  
> **Parent:** <`<spec path>` · sha256:<hex> | user request>  
> **Decide:** <reader decision, or none>  
> **Risk:** <low|med|high> — <reason>  
> **Increments:** <count>  

## Context & Intent
*Problem, context, and clarified intent.*

## Alternatives & Decisions
*Settled architectural choices with trade-offs, rationale, and rejected alternatives, plus open questions; tag user-made choices `(user)`. Reviews treat settled entries as final.*

## Goals & Requirements
*Goals, non-goals, requirements, acceptance criteria.*

## Architecture & Boundaries
*Constraints, components, invariants, ownership boundaries; optional Mermaid diagram.*

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
| ID | State | Summary | Next Action |
| --- | --- | --- | --- |
| I01 | complete | <summary> | - |
| I02 | ready | <summary> | implement:I02 |

Next Action: <implement:I<nn> | resume-increment | resolve-reconciliation | resolve-amendment:<id> | resolve-ruling:<key> | final-integration | complete>

## Review Findings & Resolutions
*No reviews conducted yet.*
````

## Field notes

- Box: exact labels in order; `Increments` equals the graph row count; never live status.
- Increment Details: one high-level H3 per graph ID.
- Execution Status and Review Findings & Resolutions: machine-managed; excluded from governed content.
- Execution Status: every increment's state (completed, active, ready, blocked, invalidated) and one ledger-derived Next Action line.

- Put intent and reader decisions first. Group each component under a meaningful heading in Architecture & Boundaries, with its outcome, interface and ownership detail beneath it. State shared constraints once; keep exceptions beside affected contracts.
- Retain required sections and increment fields; omit optional empty subsections. Use no fixed word limit or second manually maintained summary.
- Review history: follow [review rules](../review-rules.md) for complete inline findings and exact rulings.
