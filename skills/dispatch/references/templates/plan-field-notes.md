# Plan field notes

Notes that explain a lint code. Read when that lint code is reported.

- At a Glance: a table repeating Task Map IDs triggers `glance-restates-task-map`; link `## Task Map` instead.

- Keep the template section order: At a Glance first, then shared context and decisions, then task outcomes and execution detail. A present section out of order is a `section-order` warning; absent optional sections are ignored. Keep interfaces, ownership, prerequisites, failure behavior, compatibility, exact commands and criterion-to-check traceability. Use no fixed word limit or second human plan.

- Task behaviour: put one or more observable bullets after `Constraints:` and `Overlap:` and before `<details>`. The `task-behaviour` warning reports missing bullets and bullets containing only a file count or placeholder; place useful section visuals after the bullets under the visual-aid bar.

- Verify: list only this criterion's tests. Select by literal behavior title with the project runner's filter (e.g. `npx jest tests/a.test.ts -t "<title>"`, `pytest tests/test_a.py -k "<name>"`) and fail on zero selected tests; red never runs the aggregate suite. A broad or slow required gate belongs in a criterion Verify command. A Verify command or test file name that contains a criterion or finding ID is a `plan-id-in-test-name` warning.

- Tests: the criterion's runnable test files plus every support file (helper, fixture, mock) its RED stage changes or needs, each also in its Changes. Support files (paths under `fixtures/`, `helpers/`, or `mocks/`) need no `[NEW]` action. A red criterion without Tests (and without RED exception) is a `criterion-red-test-path` warning; a Tests path outside Changes is a `criterion-tests-path` warning; a test-like Changes path in no criterion's Tests is an `undeclared-test-path` warning (support paths are exempt).

- RED: the focused executable command that fails before the change, for any test tool (e.g. `npx jest tests/parser.test.ts -t "<title>"`, `pytest tests/test_parser.py -k "<name>"`). Generated capture commands expand `{files}` only from the criterion's Tests, quoted for the subprocess shell. The command runs as written through the platform's default subprocess shell and is never rewritten, so write quoting that shell parses. When Tests includes non-runnable support files, name runnable paths explicitly in RED. Record observed failures in the writer report. Missing RED evidence becomes a review finding. A missing or malformed code span is a `criterion-red-command` warning; a red criterion with neither RED nor RED exception is a `red-downgraded` warning.

- Overlap: a write path repeated by tasks with no transitive prerequisite path is an `overlap` warning (case variants count as one path; references never count). Order the tasks, or justify each shared path with `Overlap:` on the task. A repeat inside one task is a `duplicate-change-path` defect.

- Criteria mapping: each criterion is listed by exactly one task, whose paths cover its Changes, or carries Integration (with Verify) when it spans tasks. A task-owned criterion needs Changes naming the task paths it proves; a task-owned criterion with Verify alone is a `criterion-task-changes` defect. Ownership names who changes the outcome, not who runs the evidence: the orchestrator can execute a criterion's post-integration `Review:` check, while the task keeps its Changes and a review-only criterion still completes by user manual-complete.
