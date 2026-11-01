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

Invoke tools with `node <skills-dir>/dispatch/scripts/dispatch.ts <tool> <action> ... --session <session>`. Inspect `ok` and read the result `path`; the [toolkit contract](references/toolkit.md) owns exit and result semantics.

For each call read its action section in the [toolkit contract](references/toolkit.md); for ledger calls also read the matching record-kind section. Follow [native-slot replies](references/toolkit.md#native-slot-replies). Read host rules, then follow the selected branch. At each step read only its linked quality-bar and toolkit sections:

- `ask`: follow the question, answer and synthesis path in its guide. Ask needs no spec, plan or approval.
- `review`: resolve the [governing spec](references/spec-stage.md) and target; adjudicate under [review rules](references/review-rules.md). Standalone review adds no approval gate. Apply accepted fixes and verify.
- `design` or `plan`: resolve the spec; author, lint and review the artifact. Resolve errors and findings; report the reviewed artifact and concerns; use the [Decision Frame](references/decision-frame.md) for applicable approval.
- `implement`: resolve spec and plan; lint, review and obtain the approval tuple. Implement with native writers; verify integration, repair within scope and run [test cleanup](references/verbs/implement.md). Review exact HEAD under [review provenance](references/review-rules.md#review-provenance-and-applicability). Deliver after review and checks pass. After success, run `report complete`, then `worktree cleanup` per [cleanup](references/worktree-cleanup.md). Report behavior, evidence, concerns and artifacts.

Before every subagent launch, follow [Subagent context](references/providers.md). Handle `native-pending` under [native slots](references/providers.md#native-slots); retain handles until completion or blockers.

## Invariants and recovery

Use native [follow-up explorers](references/grounding.md#follow-up-explorers) for parallel research; follow their output and source-verification rules. Run ask only on user request.

Never invent decisions. Follow [user gates](references/decision-frame.md#user-gate-boundaries) and [approval provenance](references/spec-stage.md#approval), including actual user quotes and current approval tuples or recorded non-intent edit chains for medium-or-higher briefs and integration.

Present no solution, scope or option list for plan, design, a new spec or an `ask` recommending a change until grounding completes; before then, report only verified facts and what grounding will check. Standalone review is exempt. Provider delegates stay read-only. Native writers edit only assigned paths and run no Git write commands. Preserve unrelated dirty and ignored files. Tools own ledger and result files; append records through the CLI.

After interruption, inspect [status show](references/toolkit.md#status-show) and retained worktrees; resume unfinished work. Retain uncertain effects and handles until completion.

For Dispatch changes, use [self-build](references/self-build.md).
