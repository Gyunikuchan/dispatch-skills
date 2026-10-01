# Plan template

External delegates read the plan file with no other context.

The driver keeps each chat's deliverables at the root of `.scratch/dispatch-skills/<folder>/` and generated run files under that folder's `.state/runs/NNN-<kind>/`. At terminal handoff, it moves the whole folder under `<realpath(os.tmpdir())>/dispatch-skills/<folder>/` when possible and names the authoritative root.

````markdown
# <Goal Description>

> **TL;DR:** <problem and outcome>
> **Parent:** <`<design path>` · I<nn> | `<spec path>` · sha256:<hex> | user request>
> **Decide:** <reader decision, or none>
> **Risk:** <low|med|high> — <reason>
> **Scope:** <paths or components>

## Background
*Optional: current behaviour a fresh reader needs, with `file:line` pointers.*

## Key Decisions & Context
*Settled architectural choices with trade-offs, rationale, and rejected alternatives; tag user-made choices `(user)`. Reviews treat entries as settled.*

## User Review Required
*Breaking changes or trade-offs needing user attention (or "None").*

## Open Questions & Assumptions
*Questions, assumptions, or defaults (or "None").*

## Technical-Design Traceability
- Approved revision: `sha256:<64 hex>`
- Increment ID and inherited contract: I<nn> — <inherited outcome, invariants, rollback boundary>
- Prerequisite evidence: <prerequisite completion evidence>
- Acceptance mapping: <change / test → acceptance criterion>

## Success Criteria
- [SC1] <checkable outcome>
  - Changes: <relative-path>[, <relative-path>...]
  - Verify: `<command>` [FINAL]
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
*No reviews conducted yet.*

## Out of Scope
*Non-goals and deferred follow-ups.*
````

## Field notes

- Technical-Design Traceability: increment plans only.
- Verify: only this criterion's tests (e.g. `--test-name-pattern` matching literal titles), failing on zero selected tests; red never runs the aggregate suite; `[FINAL]` (optional, after the closing backtick, never inside it) marks a broad run for required gates only.
- Review Findings & Resolutions: driver-rendered and machine-managed.
- Optional: Pre-existing `yes` admits a baseline red failure; RED exception (red only) permits a no-failing-state ruling; Review is required for review, Enforcement infeasibility for critical review.
- `[GENERATED]`: the driver reruns Command before completion verification.
