# Plan template

External delegates read the plan file with no other context.

The driver keeps each chat's deliverables at the root of `.scratch/dispatch-skills/<folder>/` and generated run files under that folder's `.state/runs/NNN-<kind>/`, retaining the session in the workspace.

Separate summary fields with blank `>` lines so each field renders as its own paragraph.

````markdown
# <Goal Description>

> **TL;DR:** <problem and outcome>
>
> **Parent:** <`<design path>` · I<nn> | `<spec path>` · sha256:<hex>>
>
> **Decide:** <reader decision, or none>
>
> **Risk:** <low|med|high> — <reason>
>
> **Scope:** <paths or components>

## Background
*Optional: current behaviour a fresh reader needs, with `file:line` pointers.*

## Key Decisions & Context
*Tactical decisions with rationale; cite spec DEC-<n> and design AD-<n> by ID.*

## Open Questions & Assumptions
*Tactical assumptions and defaults. Open user questions belong in the governing spec Open Questions.*

## Out of Scope
*Plan-local exclusions and deferred follow-ups.*

## Task Map

| ID | Title | Outcome | Prerequisites | Criteria |
| --- | --- | --- | --- | --- |
| T<n> | <Task title> | <Plain-language outcome> | none | SC<n>[, SC<n>...] |

## Technical-Design Traceability
- Approved revision: `sha256:<64 hex>`
- Increment ID and inherited contract: I<nn> — <inherited outcome, invariants, rollback boundary>
- Prerequisite evidence: <prerequisite completion evidence>
- Acceptance mapping: <change / test → acceptance criterion>

## Proposed Changes

### T<n> — <Task title>
- Constraints: <optional task-specific constraints, including why each non-obvious prerequisite is needed>
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
  - Satisfies: REQ-<n>[, REQ-<n>...]
  - Changes: <relative-path>[, <relative-path>...]
  - Tests: <relative-path>[, <relative-path>...]
  - Verify: `<command>` [FINAL]
  - RED: `<focused command>`
  - Evidence: <red|verify|review>
  - Retain: <transient|durable>
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
- Put task ID, title, outcome, prerequisites, and criteria in the authored Task Map. Join rows to Proposed Changes by ID; titles must match the task headings. Put task-specific Constraints and Overlap under the matching task. Put mandatory file constraints and exceptions under Invariants:; these labels and their continuation bullets enter owned writer briefs. Other notes remain in full-plan context.
- Review history: follow [review rules](../review-rules.md); the driver keeps complete findings and exact rulings in the sibling review log and a compact table in this plan.
- Shared range: every task writer reads the plan from its start through `## Task Map`, then only its own task, criteria and Verification Plan rows. The authored map is part of the governed plan hash and shared writer context. Put context that all tasks need in the shared range and task-specific detail under the task.

- Technical-Design Traceability: increment plans only.
- Verify: only this criterion's tests, selected by literal behavior titles with the project runner's filter (e.g. `npx jest tests/a.test.ts -t "<title>"`, `pytest tests/test_a.py -k "<name>"`), failing on zero selected tests; red never runs the aggregate suite; `[FINAL]` (optional, after the closing backtick, never inside it) marks a broad run for required gates only. Selectors match behavior-named tests; a Verify command or test file name that contains a criterion or finding ID is a `plan-id-in-test-name` defect.
- Task Map: author one table with columns ID, Title, Outcome, Prerequisites, Criteria. Use `none` when a task has no prerequisites. Separate multiple task or criterion IDs with commas. Escape literal pipes as `\|`, including inside inline code. Rows join task sections by ID, not position. Keep Paths and Overlap in task details; keep Constraints under the task because they apply only to that task. The driver reads the table as authored and never rewrites it. Map edits change the governed plan hash; only Review Findings & Resolutions are excluded.
- Review Findings & Resolutions: driver-rendered and machine-managed.
- Tests: the criterion's runnable test files plus every support file (helper, fixture, mock) its RED stage changes or needs, each also in its Changes. Only declared Tests drive the RED checkpoint, trim, and RED_READY envelope checks; a RED stage that changes an undeclared path is rejected. Trim deletes a transient criterion's Tests paths; a file that a durable criterion also lists in Tests or Changes is never trimmed, so declare shared support files under the durable criterion too. Support files (paths under `fixtures/`, `helpers/`, or `mocks/`) need no `[NEW]` action or `transient` name. A red criterion without Tests (and without RED exception) is a `criterion-red-test-path` warning: its red evidence downgrades to verify and the run records a concern; a Tests path outside Changes is a `criterion-tests-path` defect; a test-like Changes path in no criterion's Tests is an `undeclared-test-path` warning (paths under `fixtures/`, `helpers/`, or `mocks/` are exempt).
- RED: the focused command that fails before the change, for any test tool (e.g. `npx jest {files} -t "<title>"`, `pytest {files} -k "<name>"`); `{files}` expands to the RED-MATRIX test paths, and a command without `{files}` runs unchanged. A missing or malformed code span is a `criterion-red-command` defect. A red criterion with neither RED nor RED exception is a `red-downgraded` warning: its red evidence downgrades to verify and the run records a concern.
- Optional: Pre-existing `yes` admits a baseline red failure without a baseline-collision concern; RED exception (red only) permits a no-failing-state ruling; Review is required for review, Enforcement infeasibility for critical review.
- Tasks: every H4 belongs to one task; a task is a meaningful outcome with independently checkable criteria. Combine same-file or tightly coupled changes; serialize shared-resource use (ports, caches, outputs) with a prerequisite and rationale.
- Overlap: a write path repeated by tasks with no transitive Prerequisites path is an `overlap` warning (case variants count as one path; references never count). Order the tasks, or justify each shared path with `Overlap:` on the task. A repeat inside one task is a `duplicate-change-path` defect.
- Seams: existing public test entry points that criteria verify through; the orchestrator chooses them from current tests and checks each criterion's Verify against them.
- Retain: required on every criterion whose Changes names a test path declared in Tests; prefer `transient`. A `durable` test follows the canonical behavioral policy in [quality-bar.md](quality-bar.md#code). Its `Test rationale:` names the lasting contract, plausible defect, and distinct contribution; related tests may share one scenario rationale when it names their membership and distinct boundaries. `transient` tests prove one step and are trimmed after final review; their test files are `[NEW]` paths that no durable criterion lists, named with `transient` under the runner's convention (`x.transient.test.ts`, `x_transient_test.go`, `tests/test_x_transient.py`). Inline-only test forms (Rust `#[cfg(test)]`, doctests) must be durable or move to a separate test file. Transient criteria require `Covered by:` naming a durable criterion or `FINAL` that keeps the behavior covered. Only test files listed solely by transient criteria are trimmed; production paths are never trimmed.
- Criteria mapping: each criterion is listed by exactly one task, whose paths cover its Changes, or carries Integration (with Verify) when it spans tasks.
- `[DELETE]`: may group comma-separated paths under one heading with one shared reason (`#### [DELETE] a.ts, b.ts`); `[NEW]`, `[MODIFY]` and `[GENERATED]` use one heading per path.
- Reuse: on `[NEW]` entries and on `[MODIFY]` entries that add an exported or shared symbol, helper, module, or type, record the names searched and why none was reused, or write `none found`, per the [quality bar](quality-bar.md#shared). Writer briefs omit `Reuse:`; put a reuse decision that binds the writer in `Changes:` or `Purpose:`.
- `[GENERATED]`: the driver reruns Command before completion verification; a task producing an Input must be a (transitive) prerequisite.

- Satisfies: required on every criterion; name the governing spec REQ IDs.
