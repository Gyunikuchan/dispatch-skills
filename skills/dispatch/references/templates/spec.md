# Spec template

Separate summary fields with blank `>` lines so each field renders as its own paragraph.

````markdown
# <Spec title>

> **Status:** <draft | approved by user — "<quote>" (<date>)>
>
> **Level:** <low|medium|high> — <reason>

## Intent & Problem
*The problem, who has it, and the intended outcome.*

## Background
*Current state and the facts that constrain the solution.*

## Requirements
### REQ-<n> — <title>
*What must be true.*
- Acceptance: <observable check>

## Non-goals
- <excluded outcome>

## Constraints
- <limit the solution must respect>

## Decisions
### DEC-<n> — <title>
- Context: <why a choice was needed>
- Options: <considered options>
- Choice: <chosen option; tag user-made choices `(user)`>
- Rationale: <why>
- Rejected: <rejected options and why>

## Discussion Record
- <dated exchange that settled intent>

## Open Questions
- <question, or none>
````

## Field notes

- Location and identity: the spec lives at `<session>/<slug>.spec.md`, one per session. Its hash is `sha256` of the raw file bytes; Parent pins use that hash.
- Required sections by run level: `low` requires Intent & Problem, Requirements, Non-goals, and Constraints. `medium` and above also require Background, Decisions, Discussion Record, and Open Questions. Present sections follow the template order; an out-of-order section is a `section-order` defect.
- IDs: headings under Requirements are `### REQ-<n> — <title>`; under Decisions, `### DEC-<n> — <title>`. Numbering starts at 1 with no gaps or duplicates. Plan, criterion, increment, and finding IDs (`T<n>`, `SC<n>`, `I<nn>`, `R<n>`, `R<n>-F<n>`) are forbidden as headings there; prose may cite them.
- Each REQ has at least one `- Acceptance:` bullet.
- Summarizing drops no decision or constraint: keep every settled decision and constraint when you shorten the spec.
