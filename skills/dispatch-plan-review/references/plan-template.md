# Plan template

Structure for authoring a plan. External delegates read the plan file with no other context.

````markdown
# <Goal Description>

Brief problem description, background context, and what the change accomplishes.

## Key Decisions & Context
Settled architectural choices, trade-offs, and rationale (e.g. from prior grilling or alignment sessions).

## User Review Required
Breaking changes, critical design decisions, or trade-offs requiring user attention (or "None").

## Open Questions & Assumptions
Clarifying questions, settling assumptions, or explicit defaults (or "None").

## Proposed Changes

### <Component Name>
Summary of component changes, separated by files (use relative paths with forward slashes):

#### [NEW] <relative-path>
- Purpose, public interface, and rationale.

#### [MODIFY] <relative-path>
- Changes: Concrete symbol/signature changes and behavior updates.
- Invariants: Pre/post-conditions or boundary validations preserved.

#### [DELETE] <relative-path>
- Deleted symbols and migration/cleanup steps.

## Rollback & Blast Radius
Downstream caller impacts, data/schema migrations, and fallback/rollback paths (or "None").

## Verification Plan
### Automated Tests
- Concrete test commands (`npm test`, targeted test files/suites).
### Manual Verification
- Concrete manual verification steps, edge cases, and failure scenarios.

## Review Findings & Resolutions
<!-- Populated during plan review cycles -->
*No reviews conducted yet.*

## Out of Scope
Explicitly unhandled features, non-goals, or deferred follow-ups.
````
