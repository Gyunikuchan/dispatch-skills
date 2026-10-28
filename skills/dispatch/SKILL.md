---
name: dispatch
description: Multi-agent planning, review, implementation. Use only when explicitly invoked.
---

# Dispatch

## Invocation

Parse `[level] [(pins)] [verb:] argument`; default `ask`. Verbs are `ask`, `design`, `plan`, `implement`, `review`. Use design for ordered increments, plan for one unit, implement for delivery. An empty code-review argument means `worktree`; `.plan.md` and `.design.md` infer review kind.

Pick and report the level. Preserve explicit levels; `xhigh` and `max` require user selection. Levels select roster, rounds and approval need. Use configured models and efforts exactly; provider configuration owns roster selection.

Initialize with `node <skills-dir>/dispatch/scripts/dispatch.ts session init --objective "<objective>"`. Retain the returned session path and follow any returned `instructions`. Reuse with `session reactivate --session-dir <session>`; `session quota-reprobe` refreshes one quota key. See [CLI contract](references/toolkit.md) for session options and outputs.

## Tool loop

Invoke tools with `node <skills-dir>/dispatch/scripts/dispatch.ts <tool> <action> … --session <session>`. Stdout contains `ok`, a summary of at most 1024 UTF-8 bytes, and a result `path`. Read that file for details. Exit codes: 0 operation returned (inspect `ok`), 1 usage or invalid input, 2 fault, 3 lock held, 4 gate or pending native work.

1. Read host rules and the [quality bar](references/templates/quality-bar.md). Resolve the [governing spec](references/spec-stage.md).
2. Author and lint the required design or plan; resolve parse errors. Review against the spec, adjudicate findings and apply accepted fixes under [review rules](references/review-rules.md).
3. Obtain the applicable approval tuple under the [Decision Frame](references/decision-frame.md).
4. Implement scoped tasks with native writers, then verify the integrated tree. Inspect failed checks and repair within scope. Resolve code findings, commit fixes and verify. Review the exact HEAD under [review rules](references/review-rules.md#review-provenance-and-applicability), which allow only recorded, verified fixes of accepted SHOULD findings from a final completed round at or above the cap to settle without another review. For transient plans, run `worktree prune`, then `verify run` with final selection under the [lifecycle](references/verbs/implement.md). Deliver only after successful final checks.
5. Run `report complete`; after success run `worktree cleanup` per [cleanup](references/worktree-cleanup.md). Report behavior, evidence, concerns and artifact paths.

For `native-pending`, read each `promptPath`, launch the configured native slot, write its output to `replyPath`, and rerun the same tool call. Preserve running handles; wait on completion or material blockers. [Providers](references/providers.md) owns slot and fallback rules.

## Invariants and recovery

User-only records (approval, waiver, manual completion and selection of xhigh/max) require actual user quotes. Never invent decisions. At medium and above, writer briefs and integration require the approved current artifact tuple or its recorded non-intent edit chain. Intent, external dependency/runtime prerequisite and discarded-work changes need new approval.

Provider delegates stay read-only. Native writers edit only assigned paths and run no Git write commands. Preserve unrelated dirty and ignored files. Tools own ledger and result files; append records through the CLI.

After interruption, use `status show`, inspect its result and retained worktrees, then resume the next unfinished operation. Keep uncertain effects and handles until completion is established.

Read the phase you execute: [ask](references/verbs/ask.md), [design](references/verbs/design.md), [plan](references/verbs/plan.md), [implement](references/verbs/implement.md), [review](references/verbs/review.md). For changes to Dispatch itself, use [self-build](references/self-build.md).
