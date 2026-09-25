# <Technical design>

## Context & Intent
Context, problem statement, and clarified user intent (ask about decision-changing ambiguities).

## Goals & Requirements
Goals, non-goals, requirements, and acceptance criteria.

## Architecture & Boundaries
Constraints, components, domain invariants, and shared interface or ownership boundaries.

## Alternatives & Decisions
Settled architectural choices (including brainstorming or grilling outcomes), each with trade-offs, rationale, and rejected alternatives, plus unresolved questions; reviews treat settled entries as final.

## Risks, Security & Operations
Failure modes, security, observability, and data, migration, compatibility, rollout, and rollback
treatment where applicable.

## Increment Dependency Graph
| ID | Priority | Summary | Prerequisites | Paths |
| --- | ---: | --- | --- | --- |
| I01 | 1 | <summary> | none | <paths> |

## Increment Details
<!-- One H3 per graph ID; high-level only, no file-by-file edits or task checklists. -->
### I01
- Outcome: <observable result>
- Scope: <what this increment changes>
- Non-scope: <intentionally excluded>
- Observable behavior: <what a user or caller can observe>
- Affected contracts: <interfaces, schemas, or none>
- Validation: <how completion is proven>
- Rollback boundary: <what reverting this increment restores>
- Parallel safety: <safe or unsafe to run beside which increments, and why>

## Final Integration
Cross-increment integration and verification requirements.

## Execution Status
<!-- machine-managed; excluded from governed content -->
Rows show every increment's state; exactly one explicit Next Action line is derived from the
ledger fold. States: completed, active (current), ready, blocked, invalidated.

| ID | State | Summary | Next Action |
| --- | --- | --- | --- |
| I01 | complete | <summary> | - |
| I02 | ready | <summary> | implement:I02 |

Next Action: <implement:I<nn> | resume-increment | resolve-reconciliation | resolve-amendment:<id> | resolve-ruling:<key> | final-integration | complete>

## Review Findings & Resolutions
<!-- machine-managed review history; excluded from governed content -->
