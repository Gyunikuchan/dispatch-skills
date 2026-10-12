# Hot-fix write brief block

## purpose

Purpose: single-shot hot fix of the named `rootCause` on the kept tree.

## kind-rules

- Fix only the stated root cause; do not restart or widen the implementation. Keep existing changes.
- Never delete a file that existed at task start, edit `.git/` or secrets paths, or run git commands that write the index (`git add`) or history, or discard state.
- Edit only the listed `paths`; RED validation does not authorize other paths. Return DONE with a one-line summary, or BLOCKED with the exact conflict.
- If required work exceeds the listed paths or root cause, stop before that work and return BLOCKED with the paths and reason. The orchestrator reports the outcome as a taskless `WRITE_RECEIPT` (`status: "submitted"` or `"failed"`) without task, attempt, signature, or handle.
