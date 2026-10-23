# Writer task {{task}}

Work only inside `{{worktree}}` and the task's listed paths. Follow applicable host rules. Run no Git write commands.

Read the governing spec whole: `{{specPath}}` ({{specHash}}).
{{design}}
Governing plan: `{{planPath}}` ({{planHash}}).

1. For each criterion with `RED:`, write failing tests first and run its RED command to observe the failures.
2. Implement the task until each Verify command and each contract command passes. If a needed path is outside scope, or a plan detail is wrong or infeasible, report the evidence to the orchestrator. Keep plan edits with the orchestrator.
3. Return a short report: status `DONE`, `BLOCKED` or `NEEDS_CONTEXT`; one-line summary; changed files; commands run with results; observed RED failures; concerns.

## Shared plan context

{{shared}}

## Task scope

{{section}}

## Criteria

{{criteria}}

## Contract commands

{{contracts}}

## Quality

{{quality}}
