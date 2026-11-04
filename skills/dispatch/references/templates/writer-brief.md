# Writer task {{task}}

Work inside `{{worktree}}` and the task's listed paths. Outside it, write only `{{reportPath}}` and files under `{{redLogDir}}`; host read tools may create or update only their own cache or index. Follow applicable host rules; a stricter one wins. Run no Git write commands.

Read the governing spec whole: `{{specPath}}` (governed hash {{specHash}}). These are canonical governed hashes from the orchestrator; raw file SHA-256 values differ. Do not run the dispatch toolkit.
Explorer subagent for this host: {{explorer}}. For heavy reading outside your task paths, you may launch it with a self-contained brief and fresh context when the host allows. Require it to stay read-only: no edits, no Git write commands and no toolkit. Read the files you edit yourself and treat its reply as claims. If none resolves or the host cannot nest a launch, read directly.
{{design}}
Governing plan: `{{planPath}}` (governed hash {{planHash}}). Use the Shared plan context, Task scope, Criteria, Contract commands, and RED capture commands embedded below. Read the whole plan only when `Constraints:`, `Overlap:`, or `Invariants:` references another task or a shared producer/consumer interface outside these sections.

For agent-consumed documents, read authoring references named in Shared plan context or Task scope. Resolve paths from the stated repository/worktree or governing-plan-relative base; report NEEDS_CONTEXT if required guidance is missing or unreadable.

1. For each `RED:` criterion, write failing tests first. Run its RED command; use the generated RED capture command when present. Observe the failures. The RED command runs as written in the platform's subprocess shell.
2. Treat plan `Constraints:`, `Overlap:`, `Invariants:` and stated exact algorithms as binding; decide routine implementation choices yourself. You own the changed outcome and its Changes; the orchestrator runs post-integration `Evidence: review` checks.
3. Apply the quality bar below; local coverage is optional feedback. Run full modified logical test files and known impacted consumers before aggregate checks; pass every Verify and contract command. Report evidence of out-of-scope paths or wrong/infeasible plan details to the orchestrator. Keep plan edits with the orchestrator.
4. Reply only with status `DONE`, `BLOCKED` or `NEEDS_CONTEXT`; `{{reportPath}}`; a one-line summary; and `concerns: <n>`.

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

Report changed files, commands/results, observed RED failures and concerns only to `{{reportPath}}`. Include the exact heading ## Observed RED failures. Put criterion or test-path attribution and log paths on plain-text lines directly below the heading. Do not add # or ## headings inside that section.

## Quality

{{quality}}
