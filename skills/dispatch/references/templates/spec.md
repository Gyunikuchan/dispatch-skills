# Spec template

The spec is the governing requirements and intent document. Put selected architecture in the design and execution detail in the plan, as described in [document layers](../spec-stage.md#readers-and-document-layers).

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

- Location and identity: the spec lives at `<session>/<slug>.spec.md`, one per session. Its hash is the canonical hash that `lint run` reports; it ignores formatting-only differences, and Parent pins use that hash.
- Required sections by run level: `low` requires Intent & Problem, Requirements, Non-goals, and Constraints. `medium` and above also require Background, Decisions, Discussion Record, and Open Questions. Present sections follow the template order; an out-of-order section is a `section-order` defect.
- IDs: headings under Requirements are `### REQ-<n> — <title>`; under Decisions, `### DEC-<n> — <title>`. Numbering starts at 1 with no gaps or duplicates. Plan, criterion, increment, and finding IDs (`T<n>`, `SC<n>`, `I<nn>`, `R<n>`, `R<n>-F<n>`) are forbidden as headings there; prose may cite them.
- Each REQ has at least one `- Acceptance:` bullet.
- Summarizing drops no decision or constraint: keep every settled decision and constraint when you shorten the spec.
- Before `AUTHORED`, assess behavior, interfaces and data, failure and recovery, quality requirements, assumptions, and dependencies. Include only applicable content in existing sections; do not add headings or applicability tables.
- Record spec-level assumptions under Constraints with the `(assumption)` tag. List a material unconfirmed assumption under Open Questions.
- Acceptance bullets may use EARS form (`WHEN <trigger>, the system SHALL <response>`) where it improves verifiability. EARS is optional and unlinted.
- Judge the draft with the [quality bar's spec section](quality-bar.md#spec).
