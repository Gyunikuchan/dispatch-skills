# Writer task {{task}}

Work inside `{{worktree}}` and the task's listed paths. Outside it, write only `{{reportPath}}` and files under `{{redLogDir}}`; host read tools may update only their own cache or index and must never create an index, change repository source or config, or violate a stricter host rule. Follow applicable host rules. Run no Git write commands.

Read the governing spec whole: `{{specPath}}` (governed hash {{specHash}}). These are canonical governed hashes from the orchestrator; raw file SHA-256 values differ. Do not run the dispatch toolkit.
{{design}}
Governing plan: `{{planPath}}` (governed hash {{planHash}}).

1. For each criterion with `RED:`, write failing tests first and run its RED command to observe the failures. Use its generated command under RED capture commands when present.
2. Classify intermediate step, helper and branch-permutation checks as transient in isolated declared host-runner paths. Justify durable tests under the canonical quality bar below; local coverage is optional implementation feedback. Run full modified logical test files and known impacted consumers before aggregate checks. Implement the task until each Verify command and each contract command passes. If a needed path is outside scope, or a plan detail is wrong or infeasible, report the evidence to the orchestrator. Keep plan edits with the orchestrator.
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
