---
name: dispatch
description: Multi-agent planning, review, implementation. Use only when explicitly invoked.
---

# Dispatch

## Invocation

Parse `[level] [(pins)] [verb:] argument`; default `ask`. An empty code-review argument means `worktree`; `.plan.md` and `.design.md` infer review kind.

Recommend `plan` or `design` after intent refinement under [spec stage](references/spec-stage.md). Keep `ask`, `review` and `implement` on their requested verb.

Read the selected phase first: [ask](references/verbs/ask.md), [design](references/verbs/design.md), [plan](references/verbs/plan.md), [implement](references/verbs/implement.md), [review](references/verbs/review.md).

Report the level once set under [run level](references/spec-stage.md#run-level). Preserve configured models and efforts.

Initialize with `node <skills-dir>/dispatch/scripts/dispatch.ts session init --objective "<objective>"`. Keep its session path and follow returned `instructions`. Reuse with `session reactivate --session-dir <session>`; `session quota-reprobe` refreshes one quota key. See [CLI contract](references/toolkit.md) for session options and outputs.

## Tool loop

Invoke tools with `node <skills-dir>/dispatch/scripts/dispatch.ts <tool> <action> … --session <session>`. Read the result `path`; stdout gives `ok` and a bounded summary. Exits: 0 returned (check `ok`), 1 invalid input, 2 fault, 3 lock held, 4 gate or native work pending.

Read host rules and the [quality bar](references/templates/quality-bar.md), then follow the selected branch:

- `ask`: follow the question, answer and synthesis path in its guide. Ask needs no spec, plan or approval.
- `review`: resolve the [governing spec](references/spec-stage.md) and target; adjudicate under [review rules](references/review-rules.md). Standalone review adds no approval gate. Apply accepted fixes and verify.
- `design` or `plan`: resolve the spec; author, lint and review the artifact. Resolve errors and findings. End with the reviewed artifact and concerns; use the [Decision Frame](references/decision-frame.md) for applicable approval.
- `implement`: resolve the spec and required design or plan; lint, review and obtain the approval tuple. Implement with native writers; verify the integrated tree and repair within scope. Resolve code findings, commit fixes and verify. Review exact HEAD under [review provenance](references/review-rules.md#review-provenance-and-applicability). For transient plans, run `worktree prune`, then final `verify run` under the [lifecycle](references/verbs/implement.md). Deliver after successful final checks. Run `report complete`, then `worktree cleanup` per [cleanup](references/worktree-cleanup.md) after success. Report behavior, evidence, concerns and artifacts.

Before every subagent launch, follow [Providers' Subagent context](references/providers.md). For `native-pending`, read each `promptPath`, launch its configured slot, write its output to `replyPath`, then rerun the same tool call. Preserve handles; wait for completion or blockers.

## Invariants and recovery

Quote actual user words for approval, waiver, manual completion and xhigh/max selection. Never invent decisions. At medium and above, briefs and integration require the current approval tuple or recorded non-intent edit chain. Intent, external dependency/runtime prerequisite and discarded-work changes need new approval.

Present no solution, scope or option list for plan, design, a new spec or an `ask` recommending a change until grounding completes; before then, report only verified facts and what grounding will check. Standalone review is exempt. Provider delegates stay read-only. Native writers edit only assigned paths and run no Git write commands. Preserve unrelated dirty and ignored files. Tools own ledger and result files; append records through the CLI.

After interruption, use `status show`, inspect its result and retained worktrees, then resume unfinished work. Retain uncertain effects and handles until completion.

For Dispatch changes, use [self-build](references/self-build.md).
