# Plan template

External delegates read the plan file with no other context.

The driver keeps each chat's deliverables at the root of `.scratch/dispatch-skills/<folder>/` and generated run files under that folder's `.state/runs/NNN-<kind>/`, retaining the session in the workspace.

Separate summary fields with blank `>` lines so each field renders as its own paragraph.

````markdown
# <Goal Description>

> **TL;DR:** <problem and outcome>
>
> **Parent:** <`<design path>` · I<nn> | `<spec path>` · sha256:<hex> | user request>
>
> **Decide:** <reader decision, or none>
>
> **Risk:** <low|med|high> — <reason>
>
> **Scope:** <paths or components>

## User Review Required
*Breaking changes or trade-offs needing user attention (or "None").*

## Background
*Optional: current behaviour a fresh reader needs, with `file:line` pointers.*

## Key Decisions & Context
*Settled architectural choices with trade-offs, rationale, and rejected alternatives; tag user-made choices `(user)`. Reviews treat entries as settled.*

## Open Questions & Assumptions
*Questions, assumptions, or defaults (or "None").*

## Out of Scope
*Non-goals and deferred follow-ups.*

## Task Map
*Driver-generated from Proposed Changes after the plan parses; the driver replaces edits here.*

## Technical-Design Traceability
- Approved revision: `sha256:<64 hex>`
- Increment ID and inherited contract: I<nn> — <inherited outcome, invariants, rollback boundary>
- Prerequisite evidence: <prerequisite completion evidence>
- Acceptance mapping: <change / test → acceptance criterion>

## Proposed Changes

### T<n> — <Task outcome>
- Outcome: <Plain-language outcome and rationale; why each non-obvious prerequisite is needed.>
- Constraints: <optional shared task constraints>
- Prerequisites: <none | T<n>[, T<n>...]>
- Criteria: <SC#[, SC#...]>
- Overlap: <path> — <why this unordered task also writes the path>

- #### [NEW] <relative-path>
  - Purpose: Public interface and rationale.
  - Reuse: <existing equivalents searched and why not reused, or none found>

- #### [MODIFY] <relative-path>
  - Changes: Concrete symbol/signature and behavior changes.
  - Invariants: Preserved pre/post-conditions; exception: <file-specific exception>.

- #### [DELETE] <relative-path>
  - Changes: Deleted symbols and cleanup.

- #### [GENERATED] <relative-path>
  - Command: `<generator command>`
  - Inputs: <relative-path>[, <relative-path>...]

## Success Criteria
- [SC1] <checkable outcome>
  - Changes: <relative-path>[, <relative-path>...]
  - Verify: `<command>` [FINAL]
  - Evidence: <red|verify|review>
  - Retain: <durable|transient>
  - Covered by: <SC#|FINAL>
  - Pre-existing: <yes|no>
  - RED exception: <behavior-preserving|already-satisfied>
  - Test rationale: <why the retained RED is discriminating, stable, and behavioral, or why a new test is low-signal>
  - Review: <artifact: path; scenario: bounded inspection; pass: observable condition>
  - Enforcement infeasibility: <why deterministic enforcement is infeasible>
  - Integration: <why this criterion spans tasks>

## Verification Plan
- Seams: <test entry point>[, <test entry point>...]
### Automated Tests
- `<one executable command>`
- None: <reason>
### Manual Verification
- Manual steps, edge cases, and failure scenarios.

## Rollback & Blast Radius
*Caller impacts, migrations, and rollback paths; omit when empty.*

## Review Findings & Resolutions
*No reviews conducted yet.*

````

## Field notes

- Omit optional empty prose sections. Retain required machine sections and conditional fields when applicable.
- Keep the template section order: human decisions and current context first, then task outcomes and execution detail. A present section out of order is a `section-order` defect; absent optional sections are ignored. Keep interfaces, ownership, prerequisites, failure behavior, compatibility, exact commands and criterion-to-check traceability. Use no fixed word limit or second human plan.
- State shared constraints once at plan or task level. Put all mandatory file constraints and exceptions under Invariants:; these labels and their continuation bullets enter owned writer briefs. Other notes remain in full-plan context.
- Review history: follow [review rules](../review-rules.md); the driver keeps complete findings and exact rulings in the sibling review log and a compact table in this plan.
- Shared range: every task writer reads the plan from its start through `## Task Map`, then only its own task, criteria and Verification Plan rows. Put context that all tasks need in the shared range and task-specific detail under the task.

- Technical-Design Traceability: increment plans only.
- Verify: only this criterion's tests (e.g. `--test-name-pattern` matching literal titles), failing on zero selected tests; red never runs the aggregate suite; `[FINAL]` (optional, after the closing backtick, never inside it) marks a broad run for required gates only.
- Task Map: driver-rendered from parsed tasks (ID, Outcome, Prerequisites, Criteria, Paths, Overlap) and excluded from the plan hash; keep the placeholder.
- Review Findings & Resolutions: driver-rendered and machine-managed.
- Optional: Pre-existing `yes` admits a baseline red failure; RED exception (red only) permits a no-failing-state ruling; Review is required for review, Enforcement infeasibility for critical review.
- Tasks: every H4 belongs to one task; a task is a meaningful outcome with independently checkable criteria. Combine same-file or tightly coupled changes; serialize shared-resource use (ports, caches, outputs) with a prerequisite and rationale.
- Overlap: a write path repeated by tasks with no transitive Prerequisites path is an `overlap` warning (case variants count as one path; references never count). Order the tasks, or justify each shared path with `Overlap:` on the task. A repeat inside one task is a `duplicate-change-path` defect.
- Seams: existing public test entry points that criteria verify through; the orchestrator chooses them from current tests and checks each criterion's Verify against them.
- Retain: `durable` (default) keeps the test. `transient` tests prove one step and are trimmed after final review; they require `Covered by:` naming a durable criterion or `FINAL` that keeps the behavior covered. Only test files listed solely by transient criteria are trimmed; production paths are never trimmed.
- Criteria mapping: each criterion is listed by exactly one task, whose paths cover its Changes, or carries Integration (with Verify) when it spans tasks.
- `[DELETE]`: may group comma-separated paths under one heading with one shared reason (`#### [DELETE] a.ts, b.ts`); `[NEW]`, `[MODIFY]` and `[GENERATED]` use one heading per path.
- Reuse: on `[NEW]` entries and on `[MODIFY]` entries that add a helper, module, or type; name the equivalents searched by name and behaviour, or `none found`. Writer briefs omit `Reuse:`; put a reuse decision that binds the writer in `Changes:` or `Purpose:`.
- `[GENERATED]`: the driver reruns Command before completion verification; a task producing an Input must be a (transitive) prerequisite.
