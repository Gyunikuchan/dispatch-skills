# Walkthrough template

Strict rendering of the shared
[minimum walkthrough contract](../review.md#minimum-walkthrough-contract). External
delegates read attached files as their primary task context.

````markdown
# Walkthrough — <Goal Description>

Summary of changes made, context, and what was accomplished.

## Changes Made

### <Component Name>
- **[NEW]** `<relative-path>` — Purpose and new interface/behavior.
- **[MODIFY]** `<relative-path>` — Concrete changes and invariants preserved.
- **[DELETE]** `<relative-path>` — Removed symbols and cleanup.

## Verification & Validation
### Automated Tests
- Command: `<test command>` — exit <status>; output/results (e.g. `X tests passed`).
### Manual Verification
- For each `verify`/`review` criterion: evidence class, inspected revision, scenario/result, and limitations.

## Outcome Traceability
- [SC#] <delivered observable behavior> — production path: `<relative-path>`; evidence: <fresh record>.

## Key Deviations
Deviations from original plan or design intent, with rationale (or "None").

## Review Findings & Resolutions
<!-- Populated during code review cycles -->
<!-- Rounds use the source-map and entry format in dispatch references/review.md § Resolution log. -->
*No reviews conducted yet.*

## Follow-ups
Accepted SHOULD-FIX / CONSIDER items not applied in this pass, each with a one-line reason (or "None").
````
