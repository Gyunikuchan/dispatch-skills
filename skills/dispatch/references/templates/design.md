# Design template

Separate each box field with blank `>` lines so it renders as its own paragraph.

````markdown
# <Technical design>

> **Parent:** <`<spec path>` · sha256:<hex>>
>
> **Decide:** <reader decision, or none>
>
> **Risk:** <low|med|high> — <reason>
>
> **Increments:** <count>

## At a Glance
- **What:** <plain-language change and why it matters>
- **How it works:** <one-line explanation>

```mermaid
flowchart LR
  Caller --> Boundary --> Component
```

Text summary: The caller reaches the component through its owned boundary.

## Execution Status
| ID | State | Next Action |
| --- | --- | --- |
| I01 | complete | - |
| I02 | ready | implement:I02 |

Next Action: <implement:I<nn> | resume-increment | resolve-reconciliation | resolve-amendment:<id> | resolve-ruling:<key> | final-integration | complete>

## Approach
*Strategy: REQ → component/increment mapping; cite REQ IDs, do not restate them.*
- REQ-<n> → <component or increment>

## Alternatives & Decisions
*Architectural decisions AD-<n>, with trade-offs, rationale, and rejected alternatives. Intent-level and user decisions live in the governing spec DEC log.*

## Risks, Security & Operations
*Failure modes, security, observability, migration, rollout, rollback.*

## Architecture & Boundaries
*Constraints, components, invariants and ownership boundaries; add architecture or flow diagrams here when the visual-aid bar admits them.*

## Increment Dependency Graph
| ID | Priority | Summary | Prerequisites | Paths |
| --- | ---: | --- | --- | --- |
| I01 | 1 | <summary> | none | <paths> |

## Increment Details
### I01

- <Observable behaviour this increment implements and how it works.>

<details>

- Outcome: <observable result>
- Scope: <what this increment changes>
- Non-scope: <excluded>
- Observable behavior: <what callers observe>
- Affected contracts: <interfaces, schemas, or none>
- Validation: <completion proof>
- Rollback boundary: <what reverting restores>
- Parallel safety: <safe or unsafe beside which increments, and why>

</details>

## Final Integration
*Cross-increment verification.*

## Review Findings & Resolutions
*No reviews conducted yet.*
````

## Field notes

- Human layout: apply the [quality bar's authoring rules](quality-bar.md#spec). Place `> [!NOTE]` and `> [!IMPORTANT]` callouts inside sections; select their type under those rules.

- At a Glance: **What** is the design's only outcome summary; **How it works** gives the method in one line without repeating the outcome. Put orientation visuals here when the visual-aid bar admits them.

- Box: exact labels in order; `Increments` equals the graph row count; never live status.
- Increment Details: one high-level H3 per graph ID. Put observable behaviour bullets before `<details>`; the `increment-behaviour` warning reports missing bullets and bullets that contain only a file count or placeholder. Keep required fields in the block and wrapper tags on separate lines with blank lines after the opening tag and before the closing tag.
- Execution Status and Review Findings & Resolutions: machine-managed; excluded from governed content. The toolkit regenerates the findings section from the ledger after each review round and ruling.
- Execution Status: rows give each increment's state (completed, active, ready, blocked, invalidated) and next action. The single ledger-derived `Next Action` line below the table gives the overall operation.

- Judge design quality against the selected shared and design criteria in the [quality bar](quality-bar.md). Keep the template section order: At a Glance, then live status, approach, and decisions, then architecture and increment detail. A present section out of order is a `section-order` defect. Group each component under a meaningful heading in Architecture & Boundaries, with its outcome, interface and ownership detail beneath it. Place section visuals here; state shared constraints once and keep exceptions beside affected contracts.
- Retain required sections and increment fields; omit optional empty subsections. Use no fixed word limit or second manually maintained summary.
