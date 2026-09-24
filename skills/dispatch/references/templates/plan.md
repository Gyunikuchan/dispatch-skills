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

## Technical-Design Traceability
<!-- Optional; present on phased implementation plans for exactly one approved increment. -->
- Parent design: `.scratch/plan/<yyyy-mm-dd>-<design-slug>-design.md`
- Approved revision: `sha256:<64 hex>`
- Increment ID and inherited contract: I<nn> — <outcome, invariants, and rollback boundary inherited from the design>
- Prerequisite evidence: <ledger/verification evidence that prerequisite increments completed>
- Acceptance mapping: <proposed change / test → increment acceptance criterion>

## Success Criteria
- [SC#] Checkable outcome.
  - Changes: <relative-path>[, <relative-path>...]
  - Verify: `<command>` <!-- narrowest feedback command (red: never the aggregate suite); append [FINAL] to a broad or slow proof run only at required gates -->
  - Evidence: <red|verify|review>
  - Pre-existing: <yes|no> <!-- optional; yes admits a red criterion whose failure already exists at baseline -->
  - Test rationale: <why retained RED is discriminating, stable, regression-bearing, proportionate, and behavioral; or why a new retained test is low-signal>
  - Review: <artifact: path; scenario: bounded inspection; pass: observable condition> <!-- required only for review -->
  - Enforcement infeasibility: <why deterministic enforcement is infeasible> <!-- required for critical review criteria -->

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

#### [GENERATED] <relative-path>
- Command: `<generator command>` <!-- regenerates this path; the driver reruns it before completion verification -->

## Rollback & Blast Radius
Downstream caller impacts, data/schema migrations, and fallback/rollback paths (or "None").

## Verification Plan
### Automated Tests
- `<one executable command>`
- None: <reason>
### Manual Verification
- Concrete manual verification steps, edge cases, and failure scenarios.

## Review Findings & Resolutions
<!-- Populated during plan review cycles -->
<!-- Rounds use the source-map and entry format in dispatch references/review.md § Resolution log. -->
*No reviews conducted yet.*

## Out of Scope
Explicitly unhandled features, non-goals, or deferred follow-ups.
````
