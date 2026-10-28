# Spec template

The spec is the governing requirements and intent document. Put selected architecture in the design and execution detail in the plan, as described in [document layers](../spec-stage.md#readers-and-document-layers).

````markdown
# <Spec title>

> **Status:** <draft | approved by user — "<quote>" (<date>)>

## At a Glance
- **What:** <plain-language change and why it matters>
- **How it works:** <one-line explanation>

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
- Options:
  - <option and trade-off>
  - <option and trade-off>
- Choice: <chosen option; tag user-made choices `(user)`>
- User quote: <verbatim quote when the user made the decision>
- Rationale: <why>
- Rejected: <rejected options and why>

## Discussion Record
- <dated exchange that settled intent without a DEC, or None.>

## Open Questions
- <question, or none>
````

## Field notes

- Human layout: apply the [quality bar's authoring rules](quality-bar.md#spec). Place `> [!NOTE]` and `> [!IMPORTANT]` callouts inside sections; select their type under those rules.

- Location and identity: the spec lives at `<session>/<slug>.spec.md`, one per session. Its hash is the canonical hash that `lint run` reports; it ignores formatting-only differences, and Parent pins use that hash.
- Required sections: every spec includes all headings below in this order. A missing section is reported as `missing-section`; an out-of-order section is a `section-order` defect.
- IDs: headings under Requirements are `### REQ-<n> — <title>`; under Decisions, `### DEC-<n> — <title>`. Numbering starts at 1 with no gaps or duplicates. Plan, criterion, increment, and finding IDs (`T<n>`, `SC<n>`, `I<nn>`, `R<n>`, `R<n>-F<n>`) are forbidden as headings there; prose may cite them.
- Each REQ has at least one `- Acceptance:` bullet.
- Summarizing drops no decision or constraint: keep every settled decision and constraint when you shorten the spec.
- Discussion Record: include only dated, intent-settling exchanges that produced no DEC. Use `None.` when no qualifying exchange exists.
- Decisions: present options as bullets or one table, never both. Keep a verbatim user quote in the DEC beside the choice.
- Before `AUTHORED`, assess behavior, interfaces and data, failure and recovery, quality requirements, assumptions, and dependencies. Include only applicable content in existing sections; do not add headings or applicability tables.
- Record spec-level assumptions under Constraints with the `(assumption)` tag. List a material unconfirmed assumption under Open Questions.
- Acceptance bullets may use EARS form (`WHEN <trigger>, the system SHALL <response>`) where it improves verifiability. EARS is optional and unlinted.
- Judge the draft with the [quality bar's spec section](quality-bar.md#spec).
