# Walkthrough template

Structure for authoring a walkthrough. External delegates read attached files as their primary task context.

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
- Command: `<test command>` — Output/results (e.g. `X tests passed`).
### Manual Verification
- Concrete manual verification performed and observed results.

## Key Deviations
Deviations from original plan or design intent, with rationale (or "None").

## Review Findings & Resolutions
<!-- Populated during code review cycles -->
<!-- New rounds start with a structured source map and enriched [ID] [severity] [sources=...] entries. -->
*No reviews conducted yet.*

## Follow-ups
Accepted SHOULD-FIX / CONSIDER items not applied in this pass, each with a one-line reason (or "None").
````
