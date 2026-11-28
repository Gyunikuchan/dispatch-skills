# Implement

## Session entry

- If the user gives multiple retained session directories without selecting one, ask which to use before any session command. Reactivate a single explicit user selection with `session reactivate --session-dir <session> --host <platform>`. The explicit choice takes precedence over a remembered directory.
- Otherwise reactivate a remembered session directory for this implementation. With only the same host identity, use `session init` to reuse its session. When the user asks to resume and neither the directory nor the retained host identity is available, ask for the retained session directory before continuing. For new work, use normal initialization.
- On an ambiguous init fault, ask the user to select a retained session. Resolve a selected candidate folder name under the canonical repository's `.scratch/dispatch-skills` and reactivate that directory. If the list omits the intended session, ask for its retained directory. A bound plan alone cannot identify an implementation session.

Use the returned session path for the implementation. On re-entry, follow the interruption recovery procedure below.

## Procedure

Resolve the [governing spec](../spec-stage.md#readers-and-document-layers) and plan, following Parent pins through a design when present. For an objective, author the [spec](../spec-stage.md) and [plan](plan.md) first. When authoring a design, follow the [design guide](design.md); for a supplied design, follow the [ordered increment loop](design.md#implement-an-approved-design) before this single-plan procedure. An assigned child targets its pinned increment plan in its seeded session, not the design route; at each checkpoint or gate return to the parent and wait for continuation. After approval, use this procedure and return the result after uncommitted delivery, report and cleanup. The [toolkit contract](../toolkit.md) owns tool arguments and result shapes.

1. Follow the [scope round](../grounding.md#scope-round) rule. For a design increment whose plan this invocation authors, ground it first under [design increments](../grounding.md#design-increments). Lint the artifacts. Resolve outstanding plan findings and escalations; failed plan-review slots follow [failed-slot coverage](../review-coverage.md#failed-slot-coverage). If this invocation authors the plan, propose its level after lint; record it under [run level](../spec-stage.md#run-level) before the first review. A review or implementation may raise it under the same rule. Run a new plan review only when no completed plan review in the session covers the current spec and plan hashes, or when the user asks; a settled plan from `plan` is not re-reviewed. Bind spec, plan and optional design in the ledger with the applicable user approval tuple.
2. Run baseline checks and retain failures. Choose bounded repairs or reported limitations against governing intent.
3. [Create](../toolkit.md#worktree-create) each ready task worktree, [render its brief](../toolkit.md#brief-render) and launch a native writer there on the `brief render` result. Retain the actual result path keyed by task ID and launch number. `worktree create` refuses a task until its prerequisites have integrated; verify an integrated prerequisite before creating its dependents. Keep active task writers within `doctor run` `writeConcurrency`. A brief names the governing spec path under [readers](../spec-stage.md#readers-and-document-layers) and carries shared plan context, task scope, criteria and checks.
4. Supervise each writer through the [writer brief](../templates/writer-brief.md) sequence and reply contract. Read `reportPath` when status is not `DONE`, concerns exceed 0, or integration or verification fails. Missing RED is a review finding. Shortcut-only concerns need recording, not repair or escalation.
5. Inspect the actual delta and evidence. [Land](../toolkit.md#worktree-land) the task: one call submits, integrates and checks it. Recover a conflict with `worktree continue`, a failed check with a `check run --task <task>` rerun.
6. Once all tasks are integrated, run [checks](../toolkit.md#check-run) (`check run`) across all criteria and the contract row before the verifier launches; route any failure to repair under [routing](../../SKILL.md#routing) and rerun. Run [verification stage](verify.md) on integration before cleanup. Apply [brief verifier](../toolkit.md#brief-verifier) to `checks passed`. Commit verifier-added tests and fixes with `worktree commit`. Before test cleanup, classify paths changed since last all-criteria run: when no path changed, run no check; when any changed path matches no criterion's declared `Changes:` or `Tests:` paths (equal or under a declared directory), run all-criteria `check run`; otherwise run `check run --criteria` for automated criteria whose declared paths match (review-only criteria keep their user-evidence path). Any failure routes to repair and re-verification on a new HEAD before cleanup. Any verifier-added test launches cleanup, so `<base>..HEAD` includes it.
   - Pass `--reuse` only under its [precondition](../toolkit.md#check-run).
7. Apply [shared](../templates/quality-bar.md#shared) and [testing](../templates/quality-bar.md#testing) when scoping and adjudicating cleanup; its retention gates match code review's [testing](../templates/quality-bar.md#testing) bar.
   - Run the test cleanup after step 6 passes and before code review, at every run level.
   - Launch test cleanup when `git diff --name-only --no-renames <base>..HEAD` in the integration worktree touches any plan `Tests:` path, test/fixture/helper path, source-code path, or contract/spec path; skip only on purely non-code/non-contract doc-only diffs, then pipe `{head}` to `ledger append - --cleanup skip` with the judged HEAD.
   - To launch, render the [test-cleanup brief](../templates/test-cleanup-brief.md) with the [`brief test-cleanup`](../toolkit.md#brief-test-cleanup) action from a values file holding `base` and `integrationPath`; the action derives `planPath` from the bind record and refuses when no plan is bound.
   - Launch one utility subagent ([routing](../../SKILL.md#routing)) on the `brief test-cleanup` result.
   - When it reports, check that the report ends with its JSON block, every `removed` ID is a plan criterion and the counts are non-negative integers. Match the reply to the live cleanup launch.
   - Commit with [worktree commit](../toolkit.md#worktree-commit) and `--test-cleanup-json <json>` (or `--test-cleanup <file|->`) whenever `removed` is non-empty or `deleted` or `merged` is non-zero.
   - Use plain `worktree commit` only for `removed: []`, `deleted: 0` and `merged: 0` with rewrite changes; commit nothing when nothing changed. Pipe `{head,report}` from that live result to `ledger append - --cleanup zero` after any rewrite commit, with the resulting HEAD. Use the retained file as evidence only.
   - When cleanup flags test-only production helpers or uncovered/`Check:`-pinned tier downgrades under concerns, resolve them before code review: route `Check:`-pinned plan edits through the living-plan procedure below, and remove verified test-only helpers via a writer or orchestrator edit committed with plain `worktree commit` before the post-cleanup `check run` and review.
   - After cleanup commits or skips, start all-criteria and contract [checks](../toolkit.md#check-run) (`check run`) as a background call, retain its handle, and start code review on the same integration HEAD together; wait for both before repairs.
   - A removed criterion keeps its recorded evidence-tree evidence and is not rerun.
   - If checks fail, repair, commit and rerun checks and review. If the repair commits after runtime verification and changes proved behaviour, run the targeted re-check in step 9 and hold delivery until it settles.
8. Review code using the [shared](../templates/quality-bar.md#shared), [code](../templates/quality-bar.md#code) and [testing](../templates/quality-bar.md#testing) criteria, enforcing the identical testing bar across surviving tests and cleanup deletions or tier downgrades.
   - A green suite cannot detect missing protection; a deletion that removes required protection is a MUST finding whose accepted fix restores or rewrites the test, while low-signal, over-tiered, or stale surviving tests are findings and bar-compliant pruning or downgrades are never reversed.
   - Resolve findings, rejection confirmations and duplicates under [rulings and fix scope](../review-rules.md#rulings-and-fix-scope), and follow [review fixes](../review-fixes.md) when accepted fixes run.
   - Require a completed review with settled [failed-slot coverage](../review-coverage.md#failed-slot-coverage), no open escalations and no unresolved accepted fixes.
   - Route a `coverage-decision` refusal or `user` decision to the user through the [Decision Frame](../decision-frame.md#review-escalation) with a recommendation.
   - Normally it must cover the exact integration HEAD; recorded, verified accepted SHOULD fixes from a final completed round at or above the saved round-1 cap may use the exception in [review provenance](../review-rules.md#review-provenance-and-applicability); record and verify them per [worktree commit](../toolkit.md#worktree-commit) and [edit record](../toolkit.md#edit).
   - The exception requires current checks.
   - The no-fix path reuses the exact completed review.
9. When all review rounds settle, if check-failure repairs or accepted review fixes changed proved behaviour, append a `partial` record with `open: ["<cycle>:V0"]` before launching one fresh targeted re-check covering those fixes together. Never re-check between rounds or add tests in a re-check; report a test gap as a limit. Route issues through [verify](verify.md). A re-check fix needs checks and another code review round; repeat this step when review settles again.
10. After code review and before delivery, inspect every criterion marked `Evidence: review`. Check each declared scenario and status, gather criterion-specific evidence, then present all required user manual-complete decisions with their evidence in one user request. Record each user's decision in the existing user-only [manual record](../toolkit.md#manual-complete) after they respond; keep delivery pending while any required decision is absent. Route missing or failed automated evidence through existing verification and escalation. If no manual decision is pending, continue without a user request.
11. Deliver the exact verified source as unstaged caller changes (no caller commit). Apply [spec layout](../templates/quality-bar.md#spec) to the walkthrough. Report behaviour, evidence and concerns through the walkthrough and artifact links. Complete the [report](../toolkit.md#report-complete) after delivery and clean owned worktrees under [worktree cleanup](../worktree-cleanup.md). Follow [delivery preconditions and recovery](../toolkit.md#worktree-deliver) for a dirty caller, failure or interruption, and retain the records and work.

Treat scope overrun, concerns, conflicts and red baselines as information with options. Verify each claim, then repair, clarify the plan, retry, retain for recovery or escalate a material user decision. Tool refusals identify an operation prerequisite; inspect the result rather than inventing success or bypassing it.

Edit living plans and designs in place under [revision protocol](../spec-stage.md#revision-protocol). Notify only writers whose paths or criteria change, with current scope, rationale, changed criteria, evidence and next action; keep their handles and completed work. Continue independent writers. Intent edits follow [spec operation](../spec-stage.md#revision-protocol).

For conflicts, follow [continue](../toolkit.md#worktree-continue) or [abort](../toolkit.md#worktree-abort) as applicable. For a stopped writer use [abandon](../toolkit.md#worktree-abandon); to end retained integration use [close](../toolkit.md#worktree-close). Inspect both tasks' intent and resolve within their paths in the integration worktree, then continue integration. Discarding work follows the [user gate](../decision-frame.md#user-gate-boundaries). Record unresolved conflicts and retained candidates.

## Interruption recovery

On re-entry, call `status show --resume` before starting implementation steps, reconcile live handles, read only indicated session-relative evidence, and run `action` at its procedure step:

| Reason | Handling |
| --- | --- |
| `baseline-pending`, `candidate-ready`, `worktree-missing`, `task-ready`, `integration-abandoned`, `verification-pending`, `review-pending`, `delivery-pending`, `delivered`, `closed` | Run `action` at its procedure step. |
| `plan-pending`, `approval-pending` | Step 1 (`plan` or `approval`). |
| `writer-open` | Reconcile host handle; never land an active writer. |
| `integration-conflict` | Resolve within both tasks' paths in integration, run `action`, then rerun `worktree land <task>`. |
| `task-check-pending` | Repair failed check, then rerun `action`. |
| `checks-pending` | Run `action`; if `cleanup` is `checkpoint`, start it in the background and `review run` on the same HEAD together (step 7). |
| `cleanup-pending` | Launch cleanup, or record doc-only skip (`ledger append - --cleanup skip`, step 7); before review, recover a matched live cleanup result or rerun cleanup if completion cannot be established. |
| `state-unreadable`, `gate-blocked` | Use detailed status and existing refusal/escalation procedure. |
| `native-pending` | Read `evidence` for `slot`, `state`, `attempt`, `replyPath`; reconcile host handle or saved reply before consume/failure handling. |
| `arguments-unavailable` | Recover legacy invocation from host context or ask user to confirm arguments. |
| `findings-pending` | Read `evidence` and apply ruling/fix rules. |
| `review-settled` | Continue at step 9; refresh current checks if required. |
| `round-pending`, `target-moved`, `review-required` | Run integration code review with saved arguments. |

For review and native continuation, read `round` for the recorded level and pins. Pass pins text as one `--pins` argument, omit the flag for null, and follow the legacy arguments procedure when the field is absent. Pass any status `resumeRef` as `--resume-ref` on the resumed review call. Review and delivery enforce their own gates. Cleanup proof is independent of review progress and current checks.

Inspect recorded launches and integration state and reconcile live handles before relaunching. A relaunch acknowledges the old writer as stopped; the [two-writer rule](../../SKILL.md#launch-and-continue) applies. Verification must follow the last relevant edit. Report completion only when criterion evidence is current, required reviews are resolved, and delivery and cleanup are accounted for.

Before report completion, when plan Risk is `med` or `high`, record 3–5 `focus` bullets with evidence; Risk `low` does not require a record. When writers report shortcuts, record them as focus bullets at any Risk, with the session-relative writer report path as evidence; when bullets would exceed five, group shortcuts in one bullet that keeps each limit and trigger.

## Step reads

| Step | Reads |
| --- | --- |
| Settle scope, lint, reviews, level, and bind (load coverage only on a slot failure) | [failed-slot coverage](../review-coverage.md#failed-slot-coverage) |
| Load the repository-change procedure only on a repository change | [repository changes](../review-coverage.md#repository-changes-from-native-voices) |
| Run baseline checks | [check run](../toolkit.md#check-run) |
| Create worktrees and render briefs | [worktree create](../toolkit.md#worktree-create) |
| Supervise writers through RED, GREEN, and verification | [writer brief](../templates/writer-brief.md) |
| Submit, integrate, and verify criteria | [worktree land](../toolkit.md#worktree-land) |
| Run runtime verification | [verify](verify.md) |
| Run test cleanup through the brief action | [brief test-cleanup](../toolkit.md#brief-test-cleanup) |
| Review code and settle coverage | [review provenance](../review-rules.md#review-provenance-and-applicability) |
| Run accepted review fixes (load only when accepted fixes run) | [review fixes](../review-fixes.md) |
| Complete manual decisions | [manual record](../toolkit.md#manual-complete) |
| Deliver, complete the report, and clean up | [worktree deliver](../toolkit.md#worktree-deliver) |
