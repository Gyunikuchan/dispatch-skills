# Task write brief block

## purpose

Purpose: deliver one plan task in its private worktree; edit only the task paths, and only inside the worktree named under Task.

## kind-rules

- Work in order: inspect, write discriminating tests for RED criteria, record RED, implement to verified GREEN, inspect for refactoring, clean up when useful, rerun affected checks, then write the outcome.
- After task RED, implement in coherent behavioral slices. Run affected checks during iteration and after every later edit: the mapped commands for touched criteria plus tests of impacted consumers; broaden when impact is uncertain. Every required submission command still runs before the outcome. Per-slice RED ordering is not mechanically verified; do not claim it.
- After GREEN, inspect the task's changes for duplication, unclear naming, unnecessary branches, and abstractions the task introduced. Make behavior-preserving cleanup only within task paths and the governing outcome; proceed without edits when none is useful, and stop when no warranted in-scope simplification remains. Report adjacent improvements under concerns instead of making them.
- Record RED once the new tests fail for the intended reason and before any production edit: run `<Checkpoint Command>`. The driver replays that checkpoint at the task's input revision and rejects submitted tests that differ from it; if a test must change afterward, including during cleanup, rerun the command and justify the change under concerns. Production-only cleanup keeps the existing checkpoint.
- Name each test so its criterion's mapped command selects it. Name behavior, not plan-scoped criterion IDs.
- Implement the smallest complete behavior satisfying the governing outcome and task scope. Tests are evidence, not specification.
- Return NEEDS_CONTEXT or BLOCKED with the exact conflict when evidence omits, conflicts with, or exceeds the governing outcome or task scope.
- On a repeat attempt, repair the listed `admissionDefects` first.
- To request expansion, return `status: "SCOPE_REQUEST"` and `scopeRequest: { requestId, source: "task", task, baseArtifactHash, writerRationale, delta }`. `delta` must include arrays `paths`, `criteria`, `obligations`, `commands`, `phaseDuties`, and `increments` (empty when no design increment is proposed); it may include `finalCommands` and full `criterionDefinitions`. A new criterion id requires a matching definition with `id`, `title`, `changes`, `verify` entries (`command`, `final`), `evidence`, `preExisting`, `redException`, `testRationale`, `review`, and `enforcementInfeasibility`. Task requests cannot add design increments. Use the task id and governing plan hash from the brief. Submit before changing any path outside the task paths.
