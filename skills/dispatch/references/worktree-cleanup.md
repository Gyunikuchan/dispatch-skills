# Worktree cleanup

Record every invocation worktree (including native-agent and manual-flow worktrees outside the driver) in `.state/runs/NNN-<kind>/scratch/worktrees.json` with its path, owner, host/lifecycle identity, and status (`active`, `removed`, `archived`, or `retained`). Update this durable record on cleanup; read it after interruption or compaction. Before final handoff for any verb, confirm that agents using each recorded worktree have stopped and account for every owned worktree. The driver removes its private worktrees after delivery; verify that cleanup rather than repeat it.

Record pre-run and cross-run worktrees in `.state/scratch/worktrees.json`; recovery must read it and every run's `.state/runs/NNN-<kind>/scratch/worktrees.json`.

Preserve results and required evidence in the caller checkout or handoff folder before removing completed worktrees. Archive host-managed worktrees through the host's worktree lifecycle tool; remove ordinary Git worktrees with `git worktree remove <path>` from a surviving checkout. Verify removal through the host's artifact list or `git worktree list --porcelain`. Preserve pre-existing, shared, and unrelated worktrees. Never force removal of unpreserved work.

On stopped or failed runs, retain worktrees needed for recovery or untransferred work. Report each retained path and reason, including live agents or cleanup failures; retry safe cleanup after the blocker clears. A successful handoff requires every owned worktree removed or archived, unless the user explicitly requested retention. Preserve the handoff folder.
