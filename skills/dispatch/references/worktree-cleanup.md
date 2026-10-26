# Worktree cleanup

After successful `report complete`, run `worktree cleanup`. Inspect its result: `removed` lists completed cleanup; `kept` gives paths and reasons. Resolve owned retained paths before a successful handoff, or report an explicit user retention decision. Preserve the session, result files and required evidence.

Tools track owned writer and integration paths in the ledger under `.state/worktrees/`. Cleanup checks physical containment, ownership, terminal state and preserved snapshots. It compares integration history with the recorded delivery source (legacy to), which the caller never receives as a commit. It retains unpreserved worktree or index edits and ignored files. Incomplete or unpreserved delivery keeps the integration branch. Successful preservation-safe cleanup removes the branch but always keeps the delivered-source ref; later caller commits do not invalidate recorded delivery. See [delivery recovery](toolkit.md#worktree-deliver). Preserve unrelated, pre-existing and shared worktrees.

Before cleanup, confirm that agents using the paths have stopped. For host-managed worktrees created outside the toolkit, record ownership and use the host lifecycle to archive them after preserving work. Verify removal with host artifacts or Git's worktree list.

After stop, failure or interruption, inspect status and retain paths needed for recovery. Report each retained owned path and reason. Retry safe cleanup when the blocker clears; cleanup never implies that failed verification passed.
