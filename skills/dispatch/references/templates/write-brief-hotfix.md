# Hot-fix write brief block

## purpose

Purpose: single-shot hot fix of the named `rootCause` on the kept tree.

## kind-rules

- Fix only the stated root cause; do not restart or widen the implementation. Keep existing changes.
- Never delete a file that existed at task start, edit `.git/` or secrets paths, or run git commands that write the index (`git add`) or history, or discard state.
- Edit only the listed `paths`; RED validation does not authorize other paths. Return DONE with a one-line summary, or BLOCKED with the exact conflict.
- If required work exceeds the listed paths or root cause, pause before that work and return `status: "SCOPE_REQUEST"` with `scopeRequest: { requestId, source: "hotfix", baseArtifactHash, writerRationale, delta }`. `delta` must include arrays `paths`, `criteria`, `obligations`, `commands`, `phaseDuties`, and `increments` (empty for hotfixes); it may include `finalCommands` and full `criterionDefinitions`. A new criterion id requires a matching definition with `id`, `title`, `changes`, `verify` entries (`command`, `final`), `evidence`, `preExisting`, `redException`, `testRationale`, `review`, and `enforcementInfeasibility`. Hotfix requests cannot add design increments. Use the governing hash from the brief; submit before making the out-of-envelope change.
