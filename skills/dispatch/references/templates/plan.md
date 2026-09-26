# Plan template

External delegates read the plan file with no other context.

````markdown
# <Goal Description>

> **TL;DR:** <problem and outcome>
> **Decide:** <reader decision, or none>
> **Risk:** <low|med|high> — <reason>
> **Scope:** <paths or components>

## Key Decisions & Context
*Settled architectural choices with trade-offs, rationale, and rejected alternatives; reviews treat entries as settled.*

## User Review Required
*Breaking changes or trade-offs needing user attention (or "None").*

## Open Questions & Assumptions
*Questions, assumptions, or defaults (or "None").*

## Technical-Design Traceability
- Parent design: `.scratch/plan/<yyyy-mm-dd>-<design-slug>-design.md`
- Approved revision: `sha256:<64 hex>`
- Increment ID and inherited contract: I<nn> — <inherited outcome, invariants, rollback boundary>
- Prerequisite evidence: <prerequisite completion evidence>
- Acceptance mapping: <change / test → acceptance criterion>

## Success Criteria
- [SC1] <checkable outcome>
  - Changes: <relative-path>[, <relative-path>...]
  - Verify: `<command>`
  - Evidence: <red|verify|review>
  - Pre-existing: <yes|no>
  - RED exception: <behavior-preserving|already-satisfied>
  - Test rationale: <why the retained RED is discriminating, stable, and behavioral, or why a new test is low-signal>
  - Review: <artifact: path; scenario: bounded inspection; pass: observable condition>
  - Enforcement infeasibility: <why deterministic enforcement is infeasible>

## Proposed Changes

### <Component Name>
*Summary, then one H4 per file (relative forward-slash paths).*

#### [NEW] <relative-path>
- Purpose, public interface, and rationale.

#### [MODIFY] <relative-path>
- Changes: Concrete symbol/signature and behavior changes.
- Invariants: Preserved pre/post-conditions.

#### [DELETE] <relative-path>
- Deleted symbols and cleanup.

#### [GENERATED] <relative-path>
- Command: `<generator command>`

## Rollback & Blast Radius
*Caller impacts, migrations, and rollback paths (or "None").*

## Verification Plan
### Automated Tests
- `<one executable command>`
- None: <reason>
### Manual Verification
- Manual steps, edge cases, and failure scenarios.

## Review Findings & Resolutions
<!-- Populated during plan review cycles -->
<!-- Rounds use the source-map and entry format in dispatch references/review.md § Resolution log. -->
*No reviews conducted yet.*

## Out of Scope
*Non-goals and deferred follow-ups.*
````

## Field notes

- Technical-Design Traceability: increment plans only.
- Verify: only this criterion's tests (e.g. `--test-name-pattern` matching literal titles), failing on zero selected tests; red never runs the aggregate suite; `[FINAL]` marks a broad run for required gates only.
- Optional: Pre-existing `yes` admits a baseline red failure; RED exception (red only) permits a no-failing-state ruling; Review is required for review, Enforcement infeasibility for critical review.
- `[GENERATED]`: the driver reruns Command before completion verification.
