# Task write brief block

## purpose

Purpose: deliver one plan task in its private worktree; edit only the task paths, and only inside the worktree named under Task.

## kind-rules

- This brief carries the shared plan context, task, criteria, and sibling tasks. Read other plan sections only for a gap you name, and only the section that covers it.
- Work in order: inspect, write discriminating tests for RED criteria (tests for `Retain: transient` criteria only in their transient files), record RED, implement to verified GREEN, inspect for refactoring, clean up when useful, rerun affected checks, then write the outcome.
- After task RED, implement in coherent behavioral slices. Run affected checks during iteration and after every later edit: the mapped commands for touched criteria plus tests of impacted consumers; broaden when impact is uncertain. Every required submission command still runs before the outcome. Per-slice RED ordering is not mechanically verified; do not claim it.
- After GREEN, inspect the task's changes against the injected quality bar. Make behavior-preserving cleanup only within task paths and the governing outcome; proceed without edits when none is useful, and stop when no warranted in-scope simplification remains. Report adjacent improvements under concerns instead of making them. For a durable test you wrote that fails the bar's test criteria, report a demotion or deletion proposal under concerns; never change `Retain:`.
- Record RED once the new tests fail for the intended reason and before any production edit: run `<Checkpoint Command>`. The driver replays that checkpoint at the task's input revision and rejects submitted tests that differ from it; if a test must change afterward, including during cleanup, rerun the command and justify the change under concerns. Production-only cleanup keeps the existing checkpoint.
- Report RED with exactly one `RED-MATRIX` evidence row per RED criterion: name one leaf test as `<test-path>:<leaf test>`, then list every failure the criterion's `RED:` command printed as `test:<exact failing test name>`, joined with `; `. The driver replays that command on the checkpoint and checks that it exits non-zero and that each name appears verbatim in its log.
- Name each test so its criterion's `RED:` command and mapped commands select it, within the quality bar's naming rule. The driver rejects defined IDs in `RED-MATRIX` names.
- Implement the smallest complete behavior satisfying the governing outcome and task scope. Tests are evidence, not specification.
- Return NEEDS_CONTEXT or BLOCKED with the exact conflict when evidence omits, conflicts with, or exceeds the governing outcome or task scope.
- When a planned task, criterion, Verify command, or change is wrong or infeasible, stop and return `BLOCKED` with an `amendment` stating the finding, evidence, and each proposed `modify`, `remove`, or `add` with its target and rationale. Never edit the plan or work around it; the orchestrator decides whether to amend. Request purely additive scope with a writer request.
- On a repeat attempt, repair the listed `admissionDefects` first.
- When required work needs paths or criteria outside the task scope, send the orchestrator a writer request before that edit: `need` (what the work requires), `paths` (each path outside the task paths), and `rationale`. Stay live and keep working within the task paths. The orchestrator answers with an amendment notice, a plain notice, or a decline; edit the requested paths only after a notice confirms them in scope.
- Retain drafts and prior brief provenance across notices; current task scope governs submission. A new verification obligation does not restart this writer. Follow [plan reconciliation](../verbs/implement.md#amendments) for retirement and replacement.
- Apply each notice the orchestrator relays as soon as it arrives: an amendment notice names a delta path, or a regenerated brief path for a relaunch; read it and continue under it. A delta binds this brief and replaces only the sections it re-sends, including the current scope and criteria. If you lost this brief, report `LOST_CONTEXT` instead; the orchestrator relays the full brief. Never treat an out-of-scope edit as a request; the driver rejects candidate paths outside the task scope.
- In the chat return, include the hash of the last brief or delta you read and finished under so the orchestrator echoes it as `briefHash` in the submitted receipt.
