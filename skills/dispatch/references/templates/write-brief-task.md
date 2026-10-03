# Task write brief block

## purpose

Purpose: deliver one plan task in its private worktree; edit only the task paths, and only inside the worktree named under Task.

## kind-rules

- Work in order: inspect, write discriminating tests for RED criteria, record RED, implement, verify, then write the outcome.
- Record RED once the new tests fail for the intended reason and before any production edit: run `<Checkpoint Command>`. The driver replays that checkpoint at the task's input revision; tests added after it do not count as RED.
- Name each test so its criterion's mapped command selects it. Name behavior, not plan-scoped criterion IDs.
- Implement the smallest complete behavior satisfying the governing outcome and task scope. Tests are evidence, not specification.
- Return NEEDS_CONTEXT or BLOCKED with the exact conflict when evidence omits, conflicts with, or exceeds the governing outcome or task scope.
- On a repeat attempt, repair the listed `admissionDefects` first.
