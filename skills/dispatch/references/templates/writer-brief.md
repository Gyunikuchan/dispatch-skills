# Writer task {{task}}

Work inside `{{worktree}}` and the task's listed paths. Outside it, write only `{{reportPath}}` and files under `{{redLogDir}}`. Follow applicable host rules. Run no Git write commands.

Read the governing spec whole: `{{specPath}}` ({{specHash}}).
{{design}}
Governing plan: `{{planPath}}` ({{planHash}}).

1. For each criterion with `RED:`, write failing tests first and run its RED command to observe the failures. Use its generated command under RED capture commands when present.
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

## RED capture commands

{{redCapture}}

## Writer report

Write the report to `{{reportPath}}`. Include the exact heading ## Observed RED failures. Put criterion or test-path attribution and log paths on plain-text lines directly below the heading. Do not add # or ## headings inside that section.

## Quality

{{quality}}
