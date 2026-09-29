# Hot-fix write brief block

## purpose

Purpose: single-shot hot fix of the named `rootCause` on the kept tree.

## kind-rules

- Fix only the stated root cause; do not restart or widen the implementation. Keep existing changes.
- Never delete a file that existed at task start, edit `.git/` or secrets paths, or run git commands that write the index (`git add`) or history, or discard state.
- Before RED validates, edit only the listed `paths`; otherwise out-of-plan repository paths are allowed and recorded as scope extensions.
- Return DONE with a one-line summary; return BLOCKED with the exact conflict when the fix exceeds the root cause.
