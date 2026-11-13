# Review fixes

Load this procedure only when accepted review findings require fixes in implementation integration. Route accepted fixes and apply the fix-interaction self-check before the next review round under [rulings and fix scope](review-rules.md#rulings-and-fix-scope).

## Assignment and scope

Start each new fix set in a clean integration worktree with recorded HEAD; keep assignments serial and other agents out until the delta commits. For a writer or utility subagent, give a self-contained brief with accepted findings, required outcome, absolute integration worktree, explicit write paths, affected checks, and the [Git-write boundary](templates/quality-bar.md#shared); reserve toolkit actions for the orchestrator. Require the assignee to perform the fix-interaction self-check in [rulings and fix scope](review-rules.md#rulings-and-fix-scope) before returning.

For a cross-ownership fix, assign all approved paths to the task owning the defective behaviour; resolve unclear ownership from the plan and integration evidence before writes.

For the final-round SHOULD exception, before launch check assigned paths against the union of accepted findings' validated correction paths; use the single-file locus fallback only when a finding has no `fix` field. If scope is unresolved or exceeded, review the new HEAD under current rules and escalate if review cannot run.

## Handle recovery

Use the retained task writer when available. If its handle is lost, recover the actual launch result from the retained reference or `.state/results/` by task and launch, and use its model candidates, effort and platform options only when the original route is established; keep an ambiguous route or unsupported host launch open for recovery.

For a dropped writer or utility handle, reconcile it, check HEAD and inspect its retained delta against the assignment before relaunch; give retained in-scope partial edits to the replacement. If inspection fails, preserve work and pause commit and relaunch; return an in-scope correction to the assignee with the same brief. Follow the [user gate](decision-frame.md#user-gate-boundaries) before discarding work.

## Reply and commit

The assignee replies inline with status `DONE`, `BLOCKED` or `NEEDS_CONTEXT`, changed paths and check results; it does not create, submit or integrate a task worktree.

Check HEAD and the actual nonempty delta, including staged, unstaged and untracked paths, against the assignment; inspect the diff and evidence before committing. Keep a failed delta for correction or decision. Commit with [`worktree commit --review-fix`](toolkit.md#worktree-commit) and existing finding and baseline metadata; rerun checks.
