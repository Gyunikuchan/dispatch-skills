# Implement

Use `start implement --session-dir <dir> --orchestrator <platform> -- <objective-or-plan-or-design-path>`. The driver reuses settled plan evidence when available, verifies baseline, records production approval, then emits bounded writer briefs and verification summaries. For design delivery it reuses matching unfinished same-chat journals and binds derived approvals to the governed revision.

At `write`, launch the configured native writer for each task slot marked `launch`, using its worktree and verified brief hash. Retain each handle and report launch/completion through [the contract](../..). Apply the configured cap and available native capacity; capability failures require a named failure rather than shared-checkout execution.

On model fallback, the driver can retain the brief while advancing the launch attempt. Pass the replacement writer the current task entry's `task`, `attempt`, `signature`, and `model`, plus the frame's stage-level `effort`; use these for launch and receipts. Use that entry's `briefPath`, `briefHash`, `envelopePath`, and `checkpointPath` for the retained brief. Its embedded attempt identifies brief creation; the current frame governs the launch.

Before the first production write, assess the complete settled implementation scope once: after plan, baseline, and applicable authorization are concrete. This applies to ordinary tasks, inline baseline hotfixes, and the first child of a design. A classified run uses the assessment; an explicit level remains unless the assessment recommends higher and the user adopts it. Retries, later phases, amendments, and later design increments inherit that settled level.

Each task uses one continuous writer invocation from inspection through envelope submission; the [task brief](../templates/write-brief-task.md) owns the development sequence, including the RED checkpoint before production edits; full-plan access grants context while task paths govern writes. The driver independently admits scope and submitted GREEN, plus checkpoint/test identity and behavioral RED for unwaived RED criteria, then integrates only the candidate delta and checks the accumulated result. Acceptance releases prerequisites; submission alone does not. Amended criteria, commands, and paths become enforceable plan content.

## Decision and receipt contract

For changed observed inputs, verification mutation or a delivery collision, follow [change handling](../change-handling.md). Resolve the recorded notice as the orchestrator, refresh affected evidence, and retain approved write scope and attempt identities.

Send each decision through `DECISION` with its exact `kind` and an `answer` matching the pending frame:

- `DECISION kind=run-stop`: `{ by: "user", quote }` at a level or scope gate.
- `DECISION kind=level-classification`: `{ evaluatedLevel, rationale, gateScope }`; echo the complete gate snapshot.
- `DECISION kind=level-recommendation`: `{ choice: "adopt" | "retain", quote }`.
- `DECISION kind=integration-conflict`: `{ by: "orchestrator", action: "resolve" | "discard", rationale, amendment? }`.
- `DECISION kind=request`: `{ by: "orchestrator", action: "approve" | "decline" | "escalate", rationale }`.
- `DECISION kind=request-user`: `{ by: "user", requestId, choice: "accept" | "decline", quote }`; only after `escalate`.

### Writer receipts

Report each writer through `WRITE_RECEIPT` with `status`:

- `launched`: `task`, `attempt`, `signature`, host-assigned `handle`, attested `model`/`effort`, and `substitution` when they differ.
- `submitted`: identity, `envelopePath`, and `briefHash` of the brief the writer finished under.
- `failed`: identity and `detail`. `cancelled`: identity, after the writer confirms it stopped.

Taskless hotfix receipts carry only `submitted` or `failed` and omit identity.

### Writer requests

When a live writer needs work outside its task scope, reply `REQUEST` with `{ task, attempt, need, paths, rationale }`; the writer keeps running. At the `request` decision, weigh the need against task intent and invariants:

- `approve` after an `AMEND` brings the paths in scope; the driver then resumes scheduling.
- `decline`, then tell the writer to continue within its scope.
- `escalate` when you disagree with the writer or the need changes intent; the user answers with `request-user`.

The driver raises the same decision when an amendment narrowed a task after its brief and the submitted candidate touches the dropped paths; `approve` admits the candidate.

### Amendments

`AMEND` `{ delta, notify, rationale, by? }` changes the plan live at a write, request, conflict, or failure frame; it replaces `REVISE` in implement runs. `delta` lists exact-text `modify`, `remove`, or `add` edits. Writers not named keep running. Name in `notify` each running writer whose paths or criteria change, with a notice; the driver regenerates its brief and the write frame relays the notice with the new brief path and hash. Relay both to the writer; when the host cannot message a live writer, deliver them at its next request or receipt. A `submitted` receipt with a stale `briefHash` is accepted only when the amendment left that task's paths and criteria unchanged.

Minor deltas need no user. Attach `by: { by: "user", quote }` when the delta changes intent, adds an external dependency, or discards work (removes an accepted task or a running task's attempt). Reconciliation:

- Pending tasks re-pend with the new signature.
- A submitted candidate is admitted against the new scope.
- An accepted task with changed paths or criteria keeps its integration and re-verifies its criteria on the integration head.
- A removed accepted task rewinds integration; a removed running task needs its `cancelled` receipt.
- A new prerequisite parks a running task's submission until that prerequisite is accepted. An accepted task cannot gain an unaccepted prerequisite.

### Integration conflicts

When a candidate conflicts with accepted work, the driver keeps the conflict in the integration worktree. Resolve the conflict markers there within the involved tasks' paths, against both tasks' intent and criteria, then reply `integration-conflict` `resolve`; the driver commits the resolution and verifies affected criteria, and a refused or failing attempt returns the frame with evidence. To drop the candidate instead, first send a user-gated `AMEND` that records the discarded work, then reply `discard` naming that amendment. An open conflict blocks amendments that rewind or re-verify accepted work.

Independent branches continue after task failure; descendants remain blocked. Keep running handles and completed receipts across status/resume. At a consolidated failure decision, verify each failed task's `amendment` against plan intent, invariants, and code, treating `unresolvedTargets` as unverified; then retry with clarified context, send `AMEND` citing the amendment, or stop with artifacts retained. Preservation does not claim repair or retry.

After all tasks are accepted, the current runtime checks caller drift, transfers the integrated delta, and removes private worktrees. Concerns, final code review/fixes, generated-artifact regeneration, aggregate gates, and final evidence then run in the caller checkout. This order differs from pre-delivery review in private integration: review or final-gate failure can leave delivered edits for repair. After the final review and fixes, the driver trims test files owned only by `Retain: transient` criteria, keeps their evidence as `verified at <revision>`, drops their Verify commands, and then runs the final gate. Other final criterion passes must postdate mutation. Retain caller changes and report completion only with every criterion evidenced.
