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

Initialize with `node <skills-dir>/dispatch/scripts/dispatch.ts session init --objective "<objective>"`. Keep its session path and follow returned `instructions`. Reuse or refresh quota under [session commands](references/toolkit.md#session-commands).

## Tool loop

Invoke tools with `node <skills-dir>/dispatch/scripts/dispatch.ts <tool> <action> ... --session <session>`. Read the result `path`; stdout gives `ok` and a bounded summary. Exits: 0 returned (check `ok`), 1 invalid input, 2 fault, 3 lock held, 4 gate or native work pending.

For each call read its action section in the [toolkit contract](references/toolkit.md); for ledger calls also read the matching record-kind section. Follow [native-slot replies](references/toolkit.md#native-slot-replies). Read host rules, then follow the selected branch. At each step read only its linked quality-bar and toolkit sections:

- `ask`: follow the question, answer and synthesis path in its guide. Ask needs no spec, plan or approval.
- `review`: resolve the [governing spec](references/spec-stage.md) and target; adjudicate under [review rules](references/review-rules.md). Standalone review adds no approval gate. Apply accepted fixes and verify.
- `design` or `plan`: resolve the spec; author, lint and review the artifact. Resolve errors and findings; report the reviewed artifact and concerns; use the [Decision Frame](references/decision-frame.md) for applicable approval.
- `implement`: resolve spec and plan; lint, review and obtain the approval tuple. Implement with native writers; verify integration, repair within scope and run [test cleanup](references/verbs/implement.md). Review exact HEAD under [review provenance](references/review-rules.md#review-provenance-and-applicability). Deliver after review and checks pass. After success, run `report complete`, then `worktree cleanup` per [cleanup](references/worktree-cleanup.md). Report behavior, evidence, concerns and artifacts.

Before every subagent launch, follow [Providers' Subagent context](references/providers.md). For `native-pending`, launch each configured slot per [native slots](references/providers.md#native-slots) and rerun the call. Preserve handles; wait for completion or blockers.

## Invariants and recovery

Dispatch native [explorers](references/grounding.md#follow-up-explorers) anytime in parallel to read many files, logs, runs or web and keep context lean: map grounding writes maps; follow-ups return inline findings. Verify claims at cited ranges. Run ask only on user request.

Quote actual user words for approval, waiver, manual completion and xhigh/max selection. Never invent decisions. At medium and above, briefs and integration require the current approval tuple or recorded non-intent edit chain. Intent, external dependency/runtime prerequisite and discarded-work changes need new approval.

Present no solution, scope or option list for plan, design, a new spec or an `ask` recommending a change until grounding completes; before then, report only verified facts and what grounding will check. Standalone review is exempt. Provider delegates stay read-only. Native writers edit only assigned paths and run no Git write commands. Preserve unrelated dirty and ignored files. Tools own ledger and result files; append records through the CLI.

After interruption, inspect [status show](references/toolkit.md#status-show) and retained worktrees; resume unfinished work. Retain uncertain effects and handles until completion.

For Dispatch changes, use [self-build](references/self-build.md).
