# Writer task {{task}}

Work inside `{{worktree}}` and the task's listed paths. Outside it, write only `{{reportPath}}` and files under `{{redLogDir}}`; host read tools may create or update only their own cache or index. An assigned review fix writes only in its absolute integration worktree and listed paths; reply inline with status `DONE`, `BLOCKED` or `NEEDS_CONTEXT`, changed paths and check results. Preserve the original `{{reportPath}}` and RED evidence.

Read the governing spec whole: `{{specPath}}` (governed hash {{specHash}}). These are canonical governed hashes from the orchestrator; raw file SHA-256 values differ. Do not run the dispatch toolkit. {{explorer}} A utility subagent under a writer is not a second writer.
{{design}}
Governing plan: `{{planPath}}` (governed hash {{planHash}}). Use the plan sections embedded below. Read the whole plan only when `Constraints:`, `Overlap:`, or `Invariants:` references another task or shared interface outside them.

For agent-consumed documents, read authoring references named in Shared plan context or Task scope (resolved from repo/worktree or plan base); report NEEDS_CONTEXT if missing or unreadable.

1. For each `RED:` criterion, write failing tests first; run its RED command (via the RED capture command when present) and observe the failures. The RED command runs as written in the platform's subprocess shell.
2. Treat plan `Constraints:`, `Overlap:`, `Invariants:` and stated exact algorithms as binding; decide routine implementation choices yourself. You own the changed outcome and its Changes; the orchestrator runs post-integration `Evidence: review` checks.
3. After tests pass GREEN, run one focused self-clean pass over your production diff (names, comments, safe DRY) against the quality bar, preserving scope, external contracts, `Shortcut:` records, and `Writer focus` (leave test pruning, merging, and tier downgrades to post-integration test cleanup).
4. Apply the quality bar below (local coverage is optional feedback). Run full modified test files and impacted consumers before aggregate checks; pass every Check and contract command. Report out-of-scope paths or wrong/infeasible plan details to the orchestrator; keep plan edits there.
5. For the ordinary task, reply only with status `DONE`, `BLOCKED` or `NEEDS_CONTEXT`; `{{reportPath}}`; a one-line summary; and `concerns: <n>`.

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

Report changed files, commands/results, observed RED failures and concerns only to `{{reportPath}}`. List each deliberate shortcut under concerns as `Shortcut: <what>; limit: <limit>; upgrade when: <trigger>`. A shortcut never crosses the simplicity floor. Add a code comment for a limit only when a reader at that locus needs it to avoid misuse. Include the exact heading ## Observed RED failures. Put criterion or test-path attribution and log paths on plain-text lines directly below the heading. Do not add # or ## headings inside that section.

## Quality

{{quality}}
