# <Technical design>

High-level problem, goals, constraints, and non-goals.

## Architecture & Boundaries
Components, ownership, interfaces, and data flow.

## Alternatives & Decisions
Governed choices and rejected alternatives.

## Risks, Security & Operations
Failure modes, observability, security, migration, and rollback.

## Increment Dependency Graph
| ID | Priority | Summary | Prerequisites | Paths |
| --- | ---: | --- | --- | --- |
| I01 | 1 | <summary> | none | <paths> |

## Execution Status
<!-- machine-managed; excluded from governed content -->
Rows show every increment's state; exactly one explicit Next Action line is derived from the
ledger fold. States: completed, active (current), ready, blocked, invalidated.

| ID | State | Summary | Next Action |
| --- | --- | --- | --- |
| I01 | complete | <summary> | - |
| I02 | ready | <summary> | implement I02 |

Next Action: <implement:I<nn> | resume-increment | resolve-reconciliation | resolve-amendment:<id> | final-integration | complete>

## Review Findings & Resolutions
<!-- machine-managed review history; excluded from governed content -->
